"""
logdhan pre-open / EOD scanner.

For each symbol in WATCHLIST, score yesterday's daily bar against the
"HDFCLIFE-style recovery breakout" pattern. Optionally POST the top
ranked symbols to a logdhan webhook.

Pattern features (all computed from EOD OHLCV):
  F1. Volume spike       — yesterday's volume / 20-day avg volume
  F2. Wide-range close   — close in top quartile of day's range
  F3. Resistance reclaim — close > max close of prior 30 sessions
  F4. RSI cross          — RSI(14) crossed above its 9-EMA from below 50
  F5. Recovery context   — close >= 5% above the lowest low of last 45 sessions

A symbol's composite score is a weighted sum of the features.
Optional cross-check: TradingView Technicals "RECOMMENDATION" field via
tradingview_ta. Used as a tiebreaker / sanity layer, not a hard gate.

Usage:
    python scanner.py                       # print ranked table
    python scanner.py --webhook URL         # also POST top-N to webhook
    python scanner.py --top 5               # change top-N
    python scanner.py --watchlist FILE.txt  # one symbol per line
"""

from __future__ import annotations
import argparse
import json
import math
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Optional
import urllib.request


def _sanitize_for_json(obj):
    # NaN/Inf are valid floats but invalid JSON — Node's JSON.parse rejects them.
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_for_json(v) for v in obj]
    return obj

import numpy as np
import pandas as pd
import yfinance as yf

try:
    from tradingview_ta import TA_Handler, Interval
    TV_TA_AVAILABLE = True
except ImportError:
    TV_TA_AVAILABLE = False


# -------- hard filters --------
# Exclude stocks that already made a large move the prior session.
# A +8%+ day means momentum players are already positioned and will book profits
# the next morning — the easy move is done before we even enter.
# Also catches F&O-ban candidates (stocks near MWPL breach after a big day).
MAX_PREV_DAY_MOVE_PCT = 8.0

# -------- default watchlist (Nifty 50) --------
DEFAULT_WATCHLIST = [
    "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "BHARTIARTL", "SBIN",
    "ITC", "LT", "HINDUNILVR", "AXISBANK", "KOTAKBANK", "BAJFINANCE", "M&M",
    "MARUTI", "ASIANPAINT", "HCLTECH", "WIPRO", "ULTRACEMCO", "TITAN",
    "SUNPHARMA", "NTPC", "POWERGRID", "TATAMOTORS", "TATASTEEL", "ONGC",
    "ADANIENT", "ADANIPORTS", "JSWSTEEL", "COALINDIA", "BAJAJ-AUTO",
    "BAJAJFINSV", "GRASIM", "INDUSINDBK", "EICHERMOT", "TECHM", "DRREDDY",
    "CIPLA", "DIVISLAB", "BRITANNIA", "NESTLEIND", "HEROMOTOCO", "HDFCLIFE",
    "SBILIFE", "APOLLOHOSP", "TRENT", "SHRIRAMFIN", "BPCL", "HINDALCO",
    "TATACONSUM",
]


# -------- indicators --------

def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)
    # Wilder's smoothing
    avg_gain = gain.ewm(alpha=1/period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


# -------- resistance / target detection --------

def swing_highs(df: pd.DataFrame, window: int = 5) -> list[float]:
    """Return prices of local-maxima highs (a bar whose high > N before & after)."""
    highs = df["High"].values
    out = []
    for i in range(window, len(highs) - window):
        if highs[i] == max(highs[i - window:i + window + 1]):
            out.append(float(highs[i]))
    # also include the most recent bar's high if it's a developing high
    return out


def classical_pivots(prev_high: float, prev_low: float, prev_close: float) -> dict:
    """Classical pivot levels from prior period's HLC. Period-agnostic:
    pass yesterday's HLC for daily, last week's for weekly, last month's for monthly."""
    p = (prev_high + prev_low + prev_close) / 3
    rng = prev_high - prev_low
    return {
        "P":  p,
        "R1": 2 * p - prev_low,
        "R2": p + rng,
        "R3": prev_high + 2 * (p - prev_low),
        "S1": 2 * p - prev_high,
        "S2": p - rng,
        "S3": prev_low - 2 * (prev_high - p),
    }


def monthly_pivots(df: pd.DataFrame) -> dict:
    """Pivot levels from the PREVIOUS calendar month's H/L/C.
    This matches TradingView's 'Pivots Traditional Auto' on a daily chart."""
    if "Date" not in df.columns:
        df = df.reset_index().rename(columns={df.index.name or "index": "Date"})
    df = df.copy()
    df["Date"] = pd.to_datetime(df["Date"])
    df["month"] = df["Date"].dt.to_period("M")
    months = df["month"].unique()
    if len(months) < 2:
        return {}
    prev_month = months[-2]  # the month BEFORE the latest
    prev = df[df["month"] == prev_month]
    return classical_pivots(
        float(prev["High"].max()),
        float(prev["Low"].min()),
        float(prev["Close"].iloc[-1]),
    )


def weekly_pivots(df: pd.DataFrame) -> dict:
    """Pivot levels from the PREVIOUS calendar week's H/L/C."""
    if "Date" not in df.columns:
        df = df.reset_index().rename(columns={df.index.name or "index": "Date"})
    df = df.copy()
    df["Date"] = pd.to_datetime(df["Date"])
    df["week"] = df["Date"].dt.to_period("W")
    weeks = df["week"].unique()
    if len(weeks) < 2:
        return {}
    prev_week = weeks[-2]
    prev = df[df["week"] == prev_week]
    return classical_pivots(
        float(prev["High"].max()),
        float(prev["Low"].min()),
        float(prev["Close"].iloc[-1]),
    )


def yearly_pivots(df: pd.DataFrame) -> dict:
    """Pivot levels from the PREVIOUS calendar year's H/L/C.
    Matches TradingView's 'Pivots Traditional Auto' on weekly/monthly charts.
    Note: yfinance may differ slightly from TV's data feed for prior-year close."""
    if "Date" not in df.columns:
        df = df.reset_index().rename(columns={df.index.name or "index": "Date"})
    df = df.copy()
    df["Date"] = pd.to_datetime(df["Date"])
    df["year"] = df["Date"].dt.year
    years = sorted(df["year"].unique())
    if len(years) < 2:
        return {}
    prev_year = years[-2]
    prev = df[df["year"] == prev_year]
    return classical_pivots(
        float(prev["High"].max()),
        float(prev["Low"].min()),
        float(prev["Close"].iloc[-1]),
    )


def compute_targets(df: pd.DataFrame) -> dict:
    """
    Return entry, three resistance-based targets, stop-loss, and R:R for T1.

    T1 — nearest resistance from: pivot R1, recent 30d swing high, or +3% projection
    T2 — medium resistance: pivot R2, 90d swing-high cluster, or +6%
    T3 — major resistance: 52w high, pivot R3, or +10%
    SL — recent 10-day swing low * 0.99 (1% buffer)
    """
    last = df.iloc[-1]
    prev = df.iloc[-2]
    entry = float(last["Close"])

    daily_p   = classical_pivots(float(prev["High"]), float(prev["Low"]), float(prev["Close"]))
    weekly_p  = weekly_pivots(df)
    monthly_p = monthly_pivots(df)
    yearly_p  = yearly_pivots(df)

    # candidate resistances above entry — each carries a priority rank
    # (lower number = higher priority; real levels beat projections in dedup)
    candidates = []  # (price, label, priority)

    # YEARLY pivots — long-term levels, match TV's auto-pivots on weekly/monthly chart (P=1)
    for label in ("R1", "R2", "R3"):
        lvl = yearly_p.get(label)
        if lvl and lvl > entry:
            candidates.append((lvl, f"Y-{label}", 1))

    # MONTHLY pivots — match TV's 'Pivots Traditional Auto' on daily chart (P=1)
    for label in ("R1", "R2", "R3"):
        lvl = monthly_p.get(label)
        if lvl and lvl > entry:
            candidates.append((lvl, f"M-{label}", 1))

    # 52-week high (P=2)
    yhigh = float(df["High"].tail(252).max())
    if yhigh > entry:
        candidates.append((yhigh, "52w-high", 2))

    # swing highs (P=3)
    sh_30 = [h for h in swing_highs(df.tail(30)) if h > entry]
    sh_90 = [h for h in swing_highs(df.tail(90)) if h > entry]
    if sh_30:
        candidates.append((min(sh_30), "swing-30d", 3))
    if sh_90:
        candidates.append((min(sh_90), "swing-90d", 3))

    # WEEKLY pivots (P=4)
    for label in ("R1", "R2", "R3"):
        lvl = weekly_p.get(label)
        if lvl and lvl > entry:
            candidates.append((lvl, f"W-{label}", 4))

    # DAILY pivots (P=5)
    for label in ("R1", "R2", "R3"):
        lvl = daily_p.get(label)
        if lvl and lvl > entry:
            candidates.append((lvl, f"D-{label}", 5))

    # PROJECTIONS — last resort, only used if nothing real exists in a band (P=9)
    candidates.extend([
        (entry * 1.03, "+3%-proj", 9),
        (entry * 1.06, "+6%-proj", 9),
        (entry * 1.10, "+10%-proj", 9),
    ])

    # Dedup within 0.7% bands keeping the HIGHEST priority (lowest number)
    # Sort by price, then prio so duplicates within a band keep the better one
    candidates.sort(key=lambda x: (x[0], x[2]))
    deduped = []
    for price, label, prio in candidates:
        if not deduped:
            deduped.append((price, label, prio))
            continue
        # within band? compare to last-kept and replace if this is higher prio
        last_price, last_label, last_prio = deduped[-1]
        if price / last_price - 1 <= 0.007:
            if prio < last_prio:
                deduped[-1] = (price, label, prio)
            # else skip (lower priority within same band)
        else:
            deduped.append((price, label, prio))
    # strip priority for downstream
    deduped = [(p, l) for (p, l, _) in deduped]

    # pick T1, T2, T3 spaced by at least ~2% apart
    targets = []
    for price, label in deduped:
        if not targets or (price / targets[-1][0] - 1) > 0.02:
            targets.append((price, label))
        if len(targets) == 3:
            break
    while len(targets) < 3:
        targets.append((entry * (1 + 0.03 * (len(targets) + 1)), "fallback"))

    # ----- stop loss — structural: below the level the stock just broke -----
    # The trade is invalidated when price re-enters the range it broke out of.
    # That level = highest CLOSE in the 30 sessions before the breakout bar.
    # If there's no clean breakout (close not above prior max), fall back to
    # the recent 3-bar low. Always ATR-floor (don't be tighter than 1×ATR)
    # and 5%-cap (don't be looser than 5% from entry).
    prior_30 = df["Close"].iloc[-32:-2]
    breakout_level = float(prior_30.max()) if len(prior_30) > 0 else entry

    # ATR(14) for volatility-aware floor
    high = df["High"]
    low = df["Low"]
    prev_close = df["Close"].shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    atr = float(tr.ewm(alpha=1/14, min_periods=14, adjust=False).mean().iloc[-1])

    recent_low = float(df["Low"].tail(3).min())

    # Structural candidate
    if entry > breakout_level:
        sl_structural = breakout_level * 0.99
        sl_source = "breakout-1%"
    else:
        # No clean breakout — use 3-bar low (trend-continuation stop)
        sl_structural = recent_low * 0.99
        sl_source = "3bar-low"

    # ATR floor — SL shouldn't be tighter than 1.0×ATR (stops getting whipsawed)
    sl_atr_floor = entry - atr * 1.0
    if sl_structural > sl_atr_floor:
        sl_structural = sl_atr_floor
        sl_source = "ATR-floor"

    # 5% cap — SL shouldn't be looser than 5% from entry
    sl_max_dist = entry * 0.95
    if sl_structural < sl_max_dist:
        sl_structural = sl_max_dist
        sl_source = "5%-cap"

    sl = sl_structural
    sl_trigger = "close-below"  # exit only on daily close beneath SL, not intraday wick

    # risk/reward to each target
    risk = entry - sl
    rr_t1 = (targets[0][0] - entry) / risk if risk > 0 else None
    rr_t2 = (targets[1][0] - entry) / risk if risk > 0 else None
    rr_t3 = (targets[2][0] - entry) / risk if risk > 0 else None

    return {
        "entry": entry,
        "T1": {"price": targets[0][0], "src": targets[0][1], "pct": (targets[0][0]/entry - 1) * 100},
        "T2": {"price": targets[1][0], "src": targets[1][1], "pct": (targets[1][0]/entry - 1) * 100},
        "T3": {"price": targets[2][0], "src": targets[2][1], "pct": (targets[2][0]/entry - 1) * 100},
        "SL": {"price": sl, "pct": (sl/entry - 1) * 100, "src": sl_source, "trigger": sl_trigger,
               "atr": atr, "breakout_level": breakout_level},
        "RR_T1": rr_t1, "RR_T2": rr_t2, "RR_T3": rr_t3,
        "pivots_daily": daily_p,
        "pivots_weekly": weekly_p,
        "pivots_monthly": monthly_p,
        "pivots_yearly": yearly_p,
    }


# -------- SHORT-side target/SL computation --------

def swing_lows(df: pd.DataFrame, window: int = 5) -> list[float]:
    """Mirror of swing_highs — local-minima lows."""
    lows = df["Low"].values
    out = []
    for i in range(window, len(lows) - window):
        if lows[i] == min(lows[i - window:i + window + 1]):
            out.append(float(lows[i]))
    return out


def compute_targets_short(df: pd.DataFrame) -> dict:
    """
    Mirror of compute_targets() for SHORT setups.
    T1/T2/T3 are SUPPORT levels BELOW entry; SL is ABOVE entry.
    """
    last = df.iloc[-1]
    prev = df.iloc[-2]
    entry = float(last["Close"])

    daily_p   = classical_pivots(float(prev["High"]), float(prev["Low"]), float(prev["Close"]))
    weekly_p  = weekly_pivots(df)
    monthly_p = monthly_pivots(df)
    yearly_p  = yearly_pivots(df)

    candidates = []  # (price, label, priority)

    # YEARLY S1/S2/S3 (P=1)
    for label in ("S1", "S2", "S3"):
        lvl = yearly_p.get(label)
        if lvl and lvl < entry:
            candidates.append((lvl, f"Y-{label}", 1))

    # MONTHLY S1/S2/S3 (P=1)
    for label in ("S1", "S2", "S3"):
        lvl = monthly_p.get(label)
        if lvl and lvl < entry:
            candidates.append((lvl, f"M-{label}", 1))

    # 52-week low (P=2)
    ylow = float(df["Low"].tail(252).min())
    if ylow < entry:
        candidates.append((ylow, "52w-low", 2))

    # Swing lows (P=3)
    sl_30 = [l for l in swing_lows(df.tail(30)) if l < entry]
    sl_90 = [l for l in swing_lows(df.tail(90)) if l < entry]
    if sl_30:
        candidates.append((max(sl_30), "swing-30d", 3))
    if sl_90:
        candidates.append((max(sl_90), "swing-90d", 3))

    # WEEKLY pivots (P=4)
    for label in ("S1", "S2", "S3"):
        lvl = weekly_p.get(label)
        if lvl and lvl < entry:
            candidates.append((lvl, f"W-{label}", 4))

    # DAILY pivots (P=5)
    for label in ("S1", "S2", "S3"):
        lvl = daily_p.get(label)
        if lvl and lvl < entry:
            candidates.append((lvl, f"D-{label}", 5))

    # PROJECTIONS (P=9)
    candidates.extend([
        (entry * 0.97, "-3%-proj", 9),
        (entry * 0.94, "-6%-proj", 9),
        (entry * 0.90, "-10%-proj", 9),
    ])

    # Sort DESC by price (deepest=last), then by priority for dedup
    candidates.sort(key=lambda x: (-x[0], x[2]))
    deduped = []
    for price, label, prio in candidates:
        if not deduped:
            deduped.append((price, label, prio))
            continue
        last_price, last_label, last_prio = deduped[-1]
        if 1 - price / last_price <= 0.007:
            if prio < last_prio:
                deduped[-1] = (price, label, prio)
        else:
            deduped.append((price, label, prio))
    deduped = [(p, l) for (p, l, _) in deduped]

    # Pick T1/T2/T3 spaced by at least ~2% (in DOWN direction)
    targets = []
    for price, label in deduped:
        if not targets or (1 - price / targets[-1][0]) > 0.02:
            targets.append((price, label))
        if len(targets) == 3:
            break
    while len(targets) < 3:
        targets.append((entry * (1 - 0.03 * (len(targets) + 1)), "fallback"))

    # ----- stop loss (above entry for SHORT) -----
    # The trade is invalidated when price closes back above the breakdown level —
    # i.e. the LOWEST close of the prior 30 sessions before the breakdown bar.
    prior_30 = df["Close"].iloc[-32:-2]
    breakdown_level = float(prior_30.min()) if len(prior_30) > 0 else entry

    high = df["High"]
    low = df["Low"]
    prev_close = df["Close"].shift(1)
    tr = pd.concat([high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    atr = float(tr.ewm(alpha=1/14, min_periods=14, adjust=False).mean().iloc[-1])
    recent_high = float(df["High"].tail(3).max())

    # Structural candidate above entry
    if entry < breakdown_level:
        sl_structural = breakdown_level * 1.01
        sl_source = "breakdown+1%"
    else:
        sl_structural = recent_high * 1.01
        sl_source = "3bar-high"

    # ATR floor — for SHORT, SL shouldn't be tighter than 1.0×ATR above entry
    sl_atr_floor = entry + atr * 1.0
    if sl_structural < sl_atr_floor:
        sl_structural = sl_atr_floor
        sl_source = "ATR-floor"

    # 5% cap — SL shouldn't be looser than 5% above entry
    sl_max_dist = entry * 1.05
    if sl_structural > sl_max_dist:
        sl_structural = sl_max_dist
        sl_source = "5%-cap"

    sl = sl_structural
    sl_trigger = "close-above"  # exit only on daily close above SL, not intraday wick

    risk = sl - entry
    rr_t1 = (entry - targets[0][0]) / risk if risk > 0 else None
    rr_t2 = (entry - targets[1][0]) / risk if risk > 0 else None
    rr_t3 = (entry - targets[2][0]) / risk if risk > 0 else None

    return {
        "entry": entry,
        "T1": {"price": targets[0][0], "src": targets[0][1], "pct": (targets[0][0]/entry - 1) * 100},
        "T2": {"price": targets[1][0], "src": targets[1][1], "pct": (targets[1][0]/entry - 1) * 100},
        "T3": {"price": targets[2][0], "src": targets[2][1], "pct": (targets[2][0]/entry - 1) * 100},
        "SL": {"price": sl, "pct": (sl/entry - 1) * 100, "src": sl_source, "trigger": sl_trigger,
               "atr": atr, "breakout_level": breakdown_level},
        "RR_T1": rr_t1, "RR_T2": rr_t2, "RR_T3": rr_t3,
        "pivots_daily": daily_p, "pivots_weekly": weekly_p,
        "pivots_monthly": monthly_p, "pivots_yearly": yearly_p,
    }


# -------- feature scoring --------

@dataclass
class Score:
    symbol: str
    close: float
    pct_change: float          # yesterday vs prior close
    volume_spike: float        # vol / 20d avg
    range_pos: float           # 0..1, where close sits in day's range
    breakout_strength: float   # close / 30d-prior high - 1
    rsi: float
    rsi_signal: float          # RSI 9-EMA
    rsi_cross_up: bool
    recovery_pct: float        # (close - 45d-low) / 45d-low
    f1_vol_spike: float
    f2_wide_range: float
    f3_resistance: float
    f4_rsi_cross: float
    f5_recovery: float
    composite: float
    # mode / direction
    mode: str = "recovery_breakout"     # which scoring mode produced this Score
    direction: str = "LONG"             # LONG or SHORT
    # scan_meta — free-form per-mode telemetry written into the DailyPick doc.
    # Used for post-trade analytics where the headline (mode, direction) doesn't
    # capture nuance. For nr7_compression specifically: notes that the pick
    # is LONG-by-default (we don't know the actual break direction pre-open),
    # so backtest/analytics can group nr7 picks that broke UP versus DOWN.
    scan_meta: Optional[dict] = None
    # target/stop fields
    t1: float = 0.0
    t1_src: str = ""
    t1_pct: float = 0.0
    t2: float = 0.0
    t2_src: str = ""
    t2_pct: float = 0.0
    t3: float = 0.0
    t3_src: str = ""
    t3_pct: float = 0.0
    sl: float = 0.0
    sl_pct: float = 0.0
    sl_src: str = ""
    sl_trigger: str = "close-below"
    atr: float = 0.0
    breakout_level: float = 0.0
    rr_t1: Optional[float] = None
    rr_t2: Optional[float] = None
    rr_t3: Optional[float] = None
    tv_verdict: Optional[str] = None
    tv_buy_count: Optional[int] = None
    error: Optional[str] = None


def score_symbol(symbol: str, df: pd.DataFrame) -> Score:
    """Score the LAST CLOSED bar of df."""
    if len(df) < 50:
        return Score(symbol, *([0.0]*13), False, *([0.0]*6), error="insufficient history")

    df = df.copy()
    df["RSI"] = rsi(df["Close"])
    df["RSI_SIG"] = df["RSI"].ewm(span=9, adjust=False).mean()
    df["VOL_AVG20"] = df["Volume"].rolling(20).mean()

    last = df.iloc[-1]
    prev_close = df["Close"].iloc[-2]

    # Hard gate: skip stocks that already moved > MAX_PREV_DAY_MOVE_PCT the prior session.
    # A large prior-day move means: (a) momentum crowd is already positioned and will
    # book profits at open, (b) stock is likely near or in F&O ban, (c) the entry price
    # is chasing an exhausted move. Composite is zeroed so it never makes the top-N cut.
    _pct_change_now = (float(last["Close"]) / float(prev_close) - 1) * 100
    if _pct_change_now > MAX_PREV_DAY_MOVE_PCT:
        return Score(symbol, *([0.0]*13), False, *([0.0]*6),
                     error=f"prior-day move {_pct_change_now:.1f}% > {MAX_PREV_DAY_MOVE_PCT}% gate")

    close = float(last["Close"])
    high = float(last["High"])
    low = float(last["Low"])
    vol = float(last["Volume"])

    # F1 — volume spike (cap at 5x to avoid microcap blowouts dominating)
    vol_spike = vol / (last["VOL_AVG20"] or vol)
    f1 = min(vol_spike / 3.0, 1.66)  # 3x = 1.0, capped at 1.66 (5x)

    # F2 — close in top quartile of day's range
    rng = high - low
    range_pos = (close - low) / rng if rng > 0 else 0.5
    f2 = max(0.0, (range_pos - 0.5) * 2)  # only credit upper half, 1.0 at top

    # F3 — resistance reclaim: close > 30 prior sessions' max close
    prior_highs = df["Close"].iloc[-32:-2]   # 30 bars ending 2 bars ago
    prior_max = prior_highs.max() if len(prior_highs) > 0 else close
    breakout_strength = (close / prior_max) - 1
    f3 = 1.0 if close > prior_max else max(0.0, 1 + breakout_strength * 20)  # partial credit if close

    # F4 — RSI cross above signal from below 50
    rsi_now = float(last["RSI"])
    rsi_sig_now = float(last["RSI_SIG"])
    rsi_prev = float(df["RSI"].iloc[-2])
    rsi_sig_prev = float(df["RSI_SIG"].iloc[-2])
    crossed = rsi_prev <= rsi_sig_prev and rsi_now > rsi_sig_now
    rising_from_low = rsi_prev < 55
    f4 = 1.0 if (crossed and rising_from_low) else (0.4 if rsi_now > rsi_sig_now and rsi_now < 65 else 0.0)

    # F5 — recovery from recent swing low
    low_45 = df["Low"].iloc[-45:].min()
    recovery_pct = (close - low_45) / low_45 if low_45 > 0 else 0
    # sweet spot: 5–25% off the low (recovering, not yet exhausted)
    if 0.05 <= recovery_pct <= 0.25:
        f5 = 1.0
    elif 0.025 <= recovery_pct < 0.05:
        f5 = 0.5
    elif 0.25 < recovery_pct <= 0.40:
        f5 = 0.7
    else:
        f5 = 0.2

    # Composite — weights tuned to favour the volume + breakout combo
    composite = (
        0.30 * f1 +    # volume confirmation is king
        0.20 * f2 +    # close in top of range
        0.25 * f3 +    # resistance reclaim
        0.15 * f4 +    # RSI cross
        0.10 * f5      # recovery context
    )

    tgt = compute_targets(df)

    return Score(
        symbol=symbol,
        close=close,
        pct_change=(close / prev_close - 1) * 100,
        volume_spike=vol_spike,
        range_pos=range_pos,
        breakout_strength=breakout_strength * 100,
        rsi=rsi_now,
        rsi_signal=rsi_sig_now,
        rsi_cross_up=crossed,
        recovery_pct=recovery_pct * 100,
        f1_vol_spike=f1,
        f2_wide_range=f2,
        f3_resistance=f3,
        f4_rsi_cross=f4,
        f5_recovery=f5,
        composite=composite,
        mode="recovery_breakout",
        direction="LONG",
        t1=tgt["T1"]["price"], t1_src=tgt["T1"]["src"], t1_pct=tgt["T1"]["pct"],
        t2=tgt["T2"]["price"], t2_src=tgt["T2"]["src"], t2_pct=tgt["T2"]["pct"],
        t3=tgt["T3"]["price"], t3_src=tgt["T3"]["src"], t3_pct=tgt["T3"]["pct"],
        sl=tgt["SL"]["price"], sl_pct=tgt["SL"]["pct"],
        sl_src=tgt["SL"]["src"], sl_trigger=tgt["SL"]["trigger"],
        atr=tgt["SL"]["atr"], breakout_level=tgt["SL"]["breakout_level"],
        rr_t1=tgt["RR_T1"], rr_t2=tgt["RR_T2"], rr_t3=tgt["RR_T3"],
    )


# -------- Mode 2: MOMENTUM LEADER (STRONG_BULL, LONG) --------
# Stocks within 5% of their 52-week high, trending up, with healthy momentum.
# These are the "leaders" — already proven uptrend, riding strength.
def score_momentum_leader(symbol: str, df: pd.DataFrame) -> Score:
    if len(df) < 250:
        return Score(symbol, *([0.0]*13), False, *([0.0]*6),
                     mode="momentum_leader", direction="LONG",
                     error="insufficient history (need 250 daily bars)")

    df = df.copy()
    df["RSI"] = rsi(df["Close"])
    df["VOL_AVG20"] = df["Volume"].rolling(20).mean()
    df["SMA20"] = df["Close"].rolling(20).mean()
    df["SMA50"] = df["Close"].rolling(50).mean()

    last = df.iloc[-1]
    prev_close = df["Close"].iloc[-2]
    close = float(last["Close"])
    high_52w = float(df["High"].tail(252).max())
    sma20 = float(last["SMA20"]) if pd.notna(last["SMA20"]) else close
    sma50 = float(last["SMA50"]) if pd.notna(last["SMA50"]) else close
    vol = float(last["Volume"])
    vol_avg = float(last["VOL_AVG20"]) if pd.notna(last["VOL_AVG20"]) else vol
    rsi_now = float(last["RSI"]) if pd.notna(last["RSI"]) else 50.0

    # Hard gate: prev-day exhaustion
    pct_change_now = (close / float(prev_close) - 1) * 100
    if pct_change_now > MAX_PREV_DAY_MOVE_PCT:
        return Score(symbol, *([0.0]*13), False, *([0.0]*6),
                     mode="momentum_leader", direction="LONG",
                     error=f"prior-day move {pct_change_now:.1f}% > {MAX_PREV_DAY_MOVE_PCT}% gate")

    # Hard gate: must be in clean uptrend (close > 20-SMA > 50-SMA)
    if not (close > sma20 > sma50):
        return Score(symbol, *([0.0]*13), False, *([0.0]*6),
                     mode="momentum_leader", direction="LONG",
                     error="stack failed: need close > sma20 > sma50")

    # F1 — Distance from 52w high. Sweet spot: 0–5% off the high.
    dist_pct = (high_52w / close - 1) * 100  # how far above us the high sits, in %
    if dist_pct <= 2:
        f1 = 1.0       # right at or above 52w high
    elif dist_pct <= 5:
        f1 = 0.8
    elif dist_pct <= 10:
        f1 = 0.4
    else:
        f1 = 0.0       # too far from highs to be a leader

    # F2 — Recent breakout: close > max of last 20 closes
    prior_20 = df["Close"].iloc[-22:-2]
    prior_max = float(prior_20.max()) if len(prior_20) > 0 else close
    breakout_strength = (close / prior_max) - 1
    f2 = 1.0 if close > prior_max else max(0.0, 1 + breakout_strength * 25)

    # F3 — Volume confirmation. >=1.5× = strong; >=1.0× = ok; <0.8 = no conviction
    vol_spike = vol / vol_avg if vol_avg > 0 else 1.0
    if vol_spike >= 1.5:
        f3 = 1.0
    elif vol_spike >= 1.0:
        f3 = 0.6
    elif vol_spike >= 0.8:
        f3 = 0.3
    else:
        f3 = 0.0

    # F4 — RSI in the bullish zone (55–80). Above 80 = overbought / late entry.
    if 60 <= rsi_now <= 75:
        f4 = 1.0
    elif 55 <= rsi_now < 60 or 75 < rsi_now <= 80:
        f4 = 0.7
    elif 50 <= rsi_now < 55:
        f4 = 0.4
    else:
        f4 = 0.0       # <50 (weak) or >80 (chasing)

    # F5 — Persistence: how many of the last 10 closes were above SMA20?
    last_10 = df.tail(10)
    above_sma20 = (last_10["Close"] > last_10["SMA20"]).sum() if "SMA20" in last_10 else 0
    f5 = above_sma20 / 10.0

    composite = (
        0.30 * f1 +    # close-to-52w-high is the headline feature
        0.20 * f2 +    # 20-day breakout
        0.20 * f3 +    # volume
        0.15 * f4 +    # RSI bullish zone
        0.15 * f5      # persistence above sma20
    )

    tgt = compute_targets(df)
    range_pos_calc = (close - float(last["Low"])) / (float(last["High"]) - float(last["Low"])) \
                     if float(last["High"]) > float(last["Low"]) else 0.5

    return Score(
        symbol=symbol, close=close,
        pct_change=pct_change_now, volume_spike=vol_spike,
        range_pos=range_pos_calc, breakout_strength=breakout_strength * 100,
        rsi=rsi_now, rsi_signal=rsi_now, rsi_cross_up=False,
        recovery_pct=-dist_pct,
        f1_vol_spike=f1, f2_wide_range=f2, f3_resistance=f3, f4_rsi_cross=f4, f5_recovery=f5,
        composite=composite, mode="momentum_leader", direction="LONG",
        t1=tgt["T1"]["price"], t1_src=tgt["T1"]["src"], t1_pct=tgt["T1"]["pct"],
        t2=tgt["T2"]["price"], t2_src=tgt["T2"]["src"], t2_pct=tgt["T2"]["pct"],
        t3=tgt["T3"]["price"], t3_src=tgt["T3"]["src"], t3_pct=tgt["T3"]["pct"],
        sl=tgt["SL"]["price"], sl_pct=tgt["SL"]["pct"],
        sl_src=tgt["SL"]["src"], sl_trigger=tgt["SL"]["trigger"],
        atr=tgt["SL"]["atr"], breakout_level=tgt["SL"]["breakout_level"],
        rr_t1=tgt["RR_T1"], rr_t2=tgt["RR_T2"], rr_t3=tgt["RR_T3"],
    )


# -------- Mode 3: NR7 / INSIDE-DAY COMPRESSION (NEUTRAL, LONG bias) --------
# Today's range is the narrowest of the last 7 (NR7), or today is an inside-day
# (today H <= prev H AND today L >= prev L). Volume drying up confirms.
# RSI near 50. Direction defaults to LONG with breakout level set above day's
# high; if regime later turns bearish at execution, runDailyPicks can flip
# direction via the bear-shorts path. We tag LONG here because pre-open we
# don't yet know the break direction.
def score_nr7_compression(symbol: str, df: pd.DataFrame) -> Score:
    if len(df) < 50:
        return Score(symbol, *([0.0]*13), False, *([0.0]*6),
                     mode="nr7_compression", direction="LONG",
                     error="insufficient history")

    df = df.copy()
    df["RSI"] = rsi(df["Close"])
    df["VOL_AVG20"] = df["Volume"].rolling(20).mean()
    df["RANGE"] = df["High"] - df["Low"]

    last = df.iloc[-1]
    prev_close = df["Close"].iloc[-2]
    close = float(last["Close"])
    high = float(last["High"])
    low = float(last["Low"])
    rng = high - low
    rsi_now = float(last["RSI"]) if pd.notna(last["RSI"]) else 50.0
    vol = float(last["Volume"])
    vol_avg = float(last["VOL_AVG20"]) if pd.notna(last["VOL_AVG20"]) else vol

    pct_change_now = (close / float(prev_close) - 1) * 100
    if abs(pct_change_now) > MAX_PREV_DAY_MOVE_PCT:
        return Score(symbol, *([0.0]*13), False, *([0.0]*6),
                     mode="nr7_compression", direction="LONG",
                     error=f"prior-day |move| {abs(pct_change_now):.1f}% > gate")

    # F1 — NR7: today's range is the narrowest of last 7 sessions
    last_7_ranges = df["RANGE"].tail(7)
    is_nr7 = rng <= last_7_ranges.min()
    # F2 — Inside-day: today H <= prev H AND today L >= prev L
    prev_high = float(df["High"].iloc[-2])
    prev_low = float(df["Low"].iloc[-2])
    is_inside = (high <= prev_high) and (low >= prev_low)

    f1 = 1.0 if is_nr7 else 0.0
    f2 = 1.0 if is_inside else 0.0

    # F3 — Volume drying up (lower vol = better compression)
    vol_ratio = vol / vol_avg if vol_avg > 0 else 1.0
    if vol_ratio <= 0.6:
        f3 = 1.0
    elif vol_ratio <= 0.8:
        f3 = 0.7
    elif vol_ratio <= 1.0:
        f3 = 0.3
    else:
        f3 = 0.0       # rising volume = not compressing

    # F4 — RSI near 50 (truly directionless)
    rsi_dist = abs(rsi_now - 50)
    if rsi_dist <= 5:
        f4 = 1.0
    elif rsi_dist <= 10:
        f4 = 0.6
    elif rsi_dist <= 15:
        f4 = 0.3
    else:
        f4 = 0.0

    # F5 — Setting up near 20-day high or low (breakout coiling)
    high_20 = float(df["High"].tail(20).max())
    low_20 = float(df["Low"].tail(20).min())
    dist_high = (high_20 / close - 1) * 100
    dist_low = (close / low_20 - 1) * 100
    near_extreme = min(dist_high, dist_low) <= 3   # within 3% of either
    f5 = 1.0 if near_extreme else (0.5 if min(dist_high, dist_low) <= 5 else 0.2)

    composite = (
        0.25 * f1 +   # NR7
        0.25 * f2 +   # inside-day
        0.20 * f3 +   # volume dry-up
        0.15 * f4 +   # RSI near 50
        0.15 * f5     # near 20d extreme
    )

    # For NR7/compression, default to LONG bias with entry above day's high.
    # We use the LONG target/SL ladder. The scan_meta below records that
    # this is a "direction-unknown-yet" pick so post-trade analytics can
    # separate NR7-broke-up (validated) from NR7-broke-down (wrong way).
    tgt = compute_targets(df)
    range_pos_calc = (close - low) / rng if rng > 0 else 0.5

    nr7_meta = {
        "expected_direction": "UNKNOWN",      # we don't know pre-open
        "default_bias": "LONG",                # what we tagged it as
        "is_nr7":   bool(is_nr7),
        "is_inside_day": bool(is_inside),
        "rsi_at_setup":  round(rsi_now, 2),
        "note": "NR7/compression default LONG — true break direction known only after 9:15 open",
    }

    return Score(
        symbol=symbol, close=close,
        pct_change=pct_change_now, volume_spike=vol_ratio,
        range_pos=range_pos_calc, breakout_strength=0.0,
        rsi=rsi_now, rsi_signal=rsi_now, rsi_cross_up=False,
        recovery_pct=0.0,
        f1_vol_spike=f1, f2_wide_range=f2, f3_resistance=f3, f4_rsi_cross=f4, f5_recovery=f5,
        composite=composite, mode="nr7_compression", direction="LONG", scan_meta=nr7_meta,
        t1=tgt["T1"]["price"], t1_src=tgt["T1"]["src"], t1_pct=tgt["T1"]["pct"],
        t2=tgt["T2"]["price"], t2_src=tgt["T2"]["src"], t2_pct=tgt["T2"]["pct"],
        t3=tgt["T3"]["price"], t3_src=tgt["T3"]["src"], t3_pct=tgt["T3"]["pct"],
        sl=tgt["SL"]["price"], sl_pct=tgt["SL"]["pct"],
        sl_src=tgt["SL"]["src"], sl_trigger=tgt["SL"]["trigger"],
        atr=tgt["SL"]["atr"], breakout_level=tgt["SL"]["breakout_level"],
        rr_t1=tgt["RR_T1"], rr_t2=tgt["RR_T2"], rr_t3=tgt["RR_T3"],
    )


# -------- Mode 4: FAILED BOUNCE (WEAK_BEAR, SHORT) --------
# Stock rallied INTO resistance and the rally failed: lower-high vs prior swing,
# close in lower half of day, RSI rolling over from above 50. The "dead-cat
# bounce" that gets shorted by trend-followers.
def score_failed_bounce(symbol: str, df: pd.DataFrame) -> Score:
    if len(df) < 50:
        return Score(symbol, *([0.0]*13), False, *([0.0]*6),
                     mode="failed_bounce", direction="SHORT",
                     error="insufficient history")

    df = df.copy()
    df["RSI"] = rsi(df["Close"])
    df["VOL_AVG20"] = df["Volume"].rolling(20).mean()
    df["SMA20"] = df["Close"].rolling(20).mean()

    last = df.iloc[-1]
    prev_close = df["Close"].iloc[-2]
    close = float(last["Close"])
    high = float(last["High"])
    low = float(last["Low"])
    rng = high - low
    rsi_now = float(last["RSI"]) if pd.notna(last["RSI"]) else 50.0
    rsi_prev = float(df["RSI"].iloc[-2]) if pd.notna(df["RSI"].iloc[-2]) else 50.0
    vol = float(last["Volume"])
    vol_avg = float(last["VOL_AVG20"]) if pd.notna(last["VOL_AVG20"]) else vol
    sma20 = float(last["SMA20"]) if pd.notna(last["SMA20"]) else close

    pct_change_now = (close / float(prev_close) - 1) * 100
    if pct_change_now < -MAX_PREV_DAY_MOVE_PCT:
        return Score(symbol, *([0.0]*13), False, *([0.0]*6),
                     mode="failed_bounce", direction="SHORT",
                     error=f"prior-day move {pct_change_now:.1f}% < -{MAX_PREV_DAY_MOVE_PCT}% gate (gap-down exhausted)")

    # F1 — Lower-high vs prior 20-day swing high
    swing_h = swing_highs(df.tail(30))
    prior_swing_high = max(swing_h) if swing_h else high
    f1 = 1.0 if high < prior_swing_high * 0.999 else 0.0

    # F2 — Closed in lower half of today's range (reversal candle)
    range_pos = (close - low) / rng if rng > 0 else 0.5
    f2 = max(0.0, (0.5 - range_pos) * 2)  # 1.0 at low, 0 at midpoint

    # F3 — Volume spike on the failure bar (selling pressure)
    vol_spike = vol / vol_avg if vol_avg > 0 else 1.0
    if vol_spike >= 1.5:
        f3 = 1.0
    elif vol_spike >= 1.0:
        f3 = 0.5
    else:
        f3 = 0.0

    # F4 — RSI rolling over from above 50 (was bullish, now turning bearish)
    rolled_over = rsi_prev > 50 and rsi_now < rsi_prev and rsi_now < 50
    weakly_bearish = 40 <= rsi_now < 50
    f4 = 1.0 if rolled_over else (0.5 if weakly_bearish else 0.0)

    # F5 — Below 20-day SMA (trend already broken)
    f5 = 1.0 if close < sma20 else max(0.0, 1 - (close - sma20) / (sma20 * 0.02))

    composite = (
        0.25 * f1 +   # lower-high vs prior swing
        0.20 * f2 +   # closed in bottom of range
        0.20 * f3 +   # volume on the failure
        0.20 * f4 +   # RSI rollover
        0.15 * f5     # below sma20
    )

    tgt = compute_targets_short(df)

    return Score(
        symbol=symbol, close=close,
        pct_change=pct_change_now, volume_spike=vol_spike,
        range_pos=range_pos, breakout_strength=0.0,
        rsi=rsi_now, rsi_signal=rsi_now, rsi_cross_up=False,
        recovery_pct=0.0,
        f1_vol_spike=f1, f2_wide_range=f2, f3_resistance=f3, f4_rsi_cross=f4, f5_recovery=f5,
        composite=composite, mode="failed_bounce", direction="SHORT",
        t1=tgt["T1"]["price"], t1_src=tgt["T1"]["src"], t1_pct=tgt["T1"]["pct"],
        t2=tgt["T2"]["price"], t2_src=tgt["T2"]["src"], t2_pct=tgt["T2"]["pct"],
        t3=tgt["T3"]["price"], t3_src=tgt["T3"]["src"], t3_pct=tgt["T3"]["pct"],
        sl=tgt["SL"]["price"], sl_pct=tgt["SL"]["pct"],
        sl_src=tgt["SL"]["src"], sl_trigger=tgt["SL"]["trigger"],
        atr=tgt["SL"]["atr"], breakout_level=tgt["SL"]["breakout_level"],
        rr_t1=tgt["RR_T1"], rr_t2=tgt["RR_T2"], rr_t3=tgt["RR_T3"],
    )


# -------- Mode 5: BREAKDOWN (STRONG_BEAR, SHORT) --------
# Stocks within 5% of their 52-week low, in a clear downtrend, with selling
# volume confirming. Mirror of momentum_leader for the short side.
def score_breakdown(symbol: str, df: pd.DataFrame) -> Score:
    if len(df) < 250:
        return Score(symbol, *([0.0]*13), False, *([0.0]*6),
                     mode="breakdown", direction="SHORT",
                     error="insufficient history (need 250 daily bars)")

    df = df.copy()
    df["RSI"] = rsi(df["Close"])
    df["VOL_AVG20"] = df["Volume"].rolling(20).mean()
    df["SMA20"] = df["Close"].rolling(20).mean()
    df["SMA50"] = df["Close"].rolling(50).mean()

    last = df.iloc[-1]
    prev_close = df["Close"].iloc[-2]
    close = float(last["Close"])
    low_52w = float(df["Low"].tail(252).min())
    sma20 = float(last["SMA20"]) if pd.notna(last["SMA20"]) else close
    sma50 = float(last["SMA50"]) if pd.notna(last["SMA50"]) else close
    vol = float(last["Volume"])
    vol_avg = float(last["VOL_AVG20"]) if pd.notna(last["VOL_AVG20"]) else vol
    rsi_now = float(last["RSI"]) if pd.notna(last["RSI"]) else 50.0

    pct_change_now = (close / float(prev_close) - 1) * 100
    if pct_change_now < -MAX_PREV_DAY_MOVE_PCT:
        return Score(symbol, *([0.0]*13), False, *([0.0]*6),
                     mode="breakdown", direction="SHORT",
                     error=f"prior-day move {pct_change_now:.1f}% < -{MAX_PREV_DAY_MOVE_PCT}% gate")

    # Hard gate: must be in clean downtrend (close < 20-SMA < 50-SMA)
    if not (close < sma20 < sma50):
        return Score(symbol, *([0.0]*13), False, *([0.0]*6),
                     mode="breakdown", direction="SHORT",
                     error="stack failed: need close < sma20 < sma50")

    # F1 — Distance from 52w low. Sweet spot: 0–5% above the low.
    dist_pct = (close / low_52w - 1) * 100  # how far above the low we sit
    if dist_pct <= 2:
        f1 = 1.0
    elif dist_pct <= 5:
        f1 = 0.8
    elif dist_pct <= 10:
        f1 = 0.4
    else:
        f1 = 0.0

    # F2 — Breakdown: close < min of last 20 closes
    prior_20 = df["Close"].iloc[-22:-2]
    prior_min = float(prior_20.min()) if len(prior_20) > 0 else close
    breakdown_strength = (prior_min / close) - 1
    f2 = 1.0 if close < prior_min else max(0.0, 1 + breakdown_strength * 25)

    # F3 — Volume on breakdown (sellers pressing)
    vol_spike = vol / vol_avg if vol_avg > 0 else 1.0
    if vol_spike >= 1.5:
        f3 = 1.0
    elif vol_spike >= 1.0:
        f3 = 0.6
    elif vol_spike >= 0.8:
        f3 = 0.3
    else:
        f3 = 0.0

    # F4 — RSI bearish zone (<45)
    if 25 <= rsi_now <= 40:
        f4 = 1.0
    elif 40 < rsi_now <= 45 or 20 <= rsi_now < 25:
        f4 = 0.7
    elif 45 < rsi_now <= 50:
        f4 = 0.4
    else:
        f4 = 0.0       # >50 (not weak enough) or <20 (oversold bounce risk)

    # F5 — Persistence: how many of last 10 closes were BELOW sma20
    last_10 = df.tail(10)
    below_sma20 = (last_10["Close"] < last_10["SMA20"]).sum() if "SMA20" in last_10 else 0
    f5 = below_sma20 / 10.0

    composite = (
        0.30 * f1 +
        0.20 * f2 +
        0.20 * f3 +
        0.15 * f4 +
        0.15 * f5
    )

    tgt = compute_targets_short(df)
    range_pos_calc = (close - float(last["Low"])) / (float(last["High"]) - float(last["Low"])) \
                     if float(last["High"]) > float(last["Low"]) else 0.5

    return Score(
        symbol=symbol, close=close,
        pct_change=pct_change_now, volume_spike=vol_spike,
        range_pos=range_pos_calc, breakout_strength=-breakdown_strength * 100,
        rsi=rsi_now, rsi_signal=rsi_now, rsi_cross_up=False,
        recovery_pct=dist_pct,
        f1_vol_spike=f1, f2_wide_range=f2, f3_resistance=f3, f4_rsi_cross=f4, f5_recovery=f5,
        composite=composite, mode="breakdown", direction="SHORT",
        t1=tgt["T1"]["price"], t1_src=tgt["T1"]["src"], t1_pct=tgt["T1"]["pct"],
        t2=tgt["T2"]["price"], t2_src=tgt["T2"]["src"], t2_pct=tgt["T2"]["pct"],
        t3=tgt["T3"]["price"], t3_src=tgt["T3"]["src"], t3_pct=tgt["T3"]["pct"],
        sl=tgt["SL"]["price"], sl_pct=tgt["SL"]["pct"],
        sl_src=tgt["SL"]["src"], sl_trigger=tgt["SL"]["trigger"],
        atr=tgt["SL"]["atr"], breakout_level=tgt["SL"]["breakout_level"],
        rr_t1=tgt["RR_T1"], rr_t2=tgt["RR_T2"], rr_t3=tgt["RR_T3"],
    )


# -------- Mode dispatch --------

MODE_SCORERS = {
    "recovery_breakout": score_symbol,
    "momentum_leader":   score_momentum_leader,
    "nr7_compression":   score_nr7_compression,
    "failed_bounce":     score_failed_bounce,
    "breakdown":         score_breakdown,
}


# -------- TradingView technicals overlay --------

def add_tv_verdict(score: Score) -> Score:
    if not TV_TA_AVAILABLE:
        return score
    try:
        h = TA_Handler(symbol=score.symbol, screener="india",
                       exchange="NSE", interval=Interval.INTERVAL_1_DAY)
        a = h.get_analysis()
        score.tv_verdict = a.summary["RECOMMENDATION"]
        score.tv_buy_count = a.summary["BUY"]
    except Exception as e:
        score.error = f"tv_ta: {type(e).__name__}"
    return score


# -------- data fetch --------

def fetch_history(symbols: list[str], period: str = "6mo") -> dict[str, pd.DataFrame]:
    """Batch download via yfinance with .NS suffix for NSE."""
    tickers = [f"{s}.NS" for s in symbols]
    data = yf.download(
        tickers, period=period, interval="1d",
        group_by="ticker", auto_adjust=True, progress=False, threads=True,
    )
    out = {}
    for s in symbols:
        t = f"{s}.NS"
        try:
            # Drop rows where Close is missing — yfinance sometimes appends an
            # empty placeholder row for "today" before the daily bar closes,
            # which would otherwise become df.iloc[-1] and contaminate scoring.
            df = data[t].dropna(subset=["Close"])
            if not df.empty:
                out[s] = df
        except (KeyError, AttributeError):
            pass
    return out


# -------- output --------

def render_table(scores: list[Score], top: int) -> str:
    scores = sorted(scores, key=lambda s: -s.composite)
    lines = []
    # signal table
    lines.append("=== Signals ===")
    lines.append(f"{'Sym':<12} {'Score':>6} {'%Chg':>6} {'VolX':>5} {'RngPos':>6} {'BrkOut%':>7} {'RSI':>5} {'TV':>10}")
    lines.append("-" * 70)
    for s in scores[:top]:
        tv = (s.tv_verdict or "—")[:10]
        lines.append(
            f"{s.symbol:<12} {s.composite:>6.3f} {s.pct_change:>6.2f} "
            f"{s.volume_spike:>5.1f} {s.range_pos:>6.2f} {s.breakout_strength:>+6.2f}  "
            f"{s.rsi:>5.1f} {tv:>10}"
        )

    # targets table
    lines.append("")
    lines.append("=== Targets & Stop (daily-timeframe resistance) ===")
    lines.append(f"{'Sym':<12} {'Entry':>8} {'T1':>8} {'(src)':<12} {'T2':>8} {'(src)':<12} {'T3':>8} {'(src)':<12} {'SL':>8} {'(src)':<14}")
    lines.append("-" * 120)
    for s in scores[:top]:
        lines.append(
            f"{s.symbol:<12} {s.close:>8.2f} "
            f"{s.t1:>8.2f} ({s.t1_src:<10}) "
            f"{s.t2:>8.2f} ({s.t2_src:<10}) "
            f"{s.t3:>8.2f} ({s.t3_src:<10}) "
            f"{s.sl:>8.2f} ({s.sl_src:<12})"
        )
    # pct moves + R:R for each target
    lines.append("")
    lines.append(f"{'Sym':<12} {'T1%':>6} {'T2%':>6} {'T3%':>6} {'SL%':>6}    {'RR-T1':>5} {'RR-T2':>5} {'RR-T3':>5}")
    lines.append("-" * 70)
    for s in scores[:top]:
        rr1 = f"{s.rr_t1:.2f}" if s.rr_t1 else "—"
        rr2 = f"{s.rr_t2:.2f}" if s.rr_t2 else "—"
        rr3 = f"{s.rr_t3:.2f}" if s.rr_t3 else "—"
        lines.append(
            f"{s.symbol:<12} {s.t1_pct:>+6.2f} {s.t2_pct:>+6.2f} {s.t3_pct:>+6.2f} {s.sl_pct:>+6.2f}    "
            f"{rr1:>5} {rr2:>5} {rr3:>5}"
        )
    return "\n".join(lines)


def post_webhook(url: str, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        print(f"[webhook] {resp.status} {resp.reason}")


# -------- main --------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--watchlist", help="one symbol per line; falls back to Nifty 50")
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--webhook", help="POST top-N as JSON to this URL")
    ap.add_argument("--no-tv", action="store_true", help="skip tradingview_ta cross-check")
    ap.add_argument("--min-score", type=float, default=0.5,
                    help="only webhook symbols above this composite score")
    ap.add_argument("--json", action="store_true",
                    help="print top-N picks as JSON array to stdout (for Node integration)")
    ap.add_argument("--mode", choices=list(MODE_SCORERS.keys()),
                    default="recovery_breakout",
                    help="scoring mode — one of: recovery_breakout (WEAK_BULL default), "
                         "momentum_leader (STRONG_BULL), nr7_compression (NEUTRAL), "
                         "failed_bounce (WEAK_BEAR, SHORT), breakdown (STRONG_BEAR, SHORT)")
    ap.add_argument("--asof", default=None,
                    help="historical replay: only use data up to and including this date "
                         "(YYYY-MM-DD). The scoring functions then evaluate as if today were "
                         "this date — i.e. last bar = the candle for --asof. Required for backtest.")
    ap.add_argument("--period", default="6mo",
                    help="yfinance history window (default 6mo). Bump to 1y or 2y when backtesting "
                         "older dates so the dataframe has enough history before the --asof cutoff.")
    args = ap.parse_args()

    scorer = MODE_SCORERS.get(args.mode, score_symbol)
    asof_ts = None
    if args.asof:
        try:
            asof_ts = pd.Timestamp(args.asof)
        except Exception as e:
            print(f"[scanner] FATAL: invalid --asof '{args.asof}' (expected YYYY-MM-DD): {e}", file=sys.stderr)
            sys.exit(2)
    print(f"[scanner] ═══════════════════════════════════════", file=sys.stderr)
    print(f"[scanner] mode={args.mode} top={args.top} min-score={args.min_score} no-tv={args.no_tv}", file=sys.stderr)
    print(f"[scanner] scorer function={scorer.__name__}", file=sys.stderr)
    if asof_ts is not None:
        print(f"[scanner] HISTORICAL REPLAY MODE: asof={asof_ts.date()} period={args.period}", file=sys.stderr)
    print(f"[scanner] ═══════════════════════════════════════", file=sys.stderr)

    if args.watchlist:
        with open(args.watchlist) as f:
            symbols = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    else:
        symbols = DEFAULT_WATCHLIST

    fetch_period = args.period if asof_ts is None else max(args.period, "1y")
    print(f"[scanner] {len(symbols)} symbols, fetching {fetch_period} history...")
    t0 = time.time()
    history = fetch_history(symbols, period=fetch_period)
    print(f"[scanner] fetched {len(history)}/{len(symbols)} in {time.time()-t0:.1f}s")

    # Historical replay: truncate every per-symbol dataframe to end at --asof.
    # The scoring functions read df.iloc[-1] (today's bar) and df.iloc[-2]
    # (yesterday's bar), so the cutoff must be inclusive of the as-of date.
    if asof_ts is not None:
        cutoff = asof_ts.normalize() + pd.Timedelta(days=1) - pd.Timedelta(microseconds=1)
        truncated = {}
        dropped_no_data = 0
        for sym, df in history.items():
            # Coerce index to tz-naive Timestamp for comparison
            try:
                df_idx = df.index
                if hasattr(df_idx, 'tz') and df_idx.tz is not None:
                    df_idx = df_idx.tz_localize(None)
                sliced = df.loc[df_idx <= cutoff]
            except Exception:
                sliced = df[df.index <= cutoff]
            if len(sliced) < 50:
                dropped_no_data += 1
                continue
            truncated[sym] = sliced
        history = truncated
        print(f"[scanner] asof-truncated to ≤ {asof_ts.date()}: {len(history)} symbols with ≥50 bars, dropped {dropped_no_data} with insufficient history", file=sys.stderr)

    scores = []
    skipped_no_data = 0
    skipped_with_error = []
    for sym in symbols:
        if sym not in history:
            skipped_no_data += 1
            continue
        s = scorer(sym, history[sym])
        if s.error:
            skipped_with_error.append((sym, s.error))
        if not args.no_tv:
            s = add_tv_verdict(s)
        scores.append(s)
    # Debug visibility — what happened across the universe
    print(f"[scanner] scored {len(scores)} symbols, skipped {skipped_no_data} for no-data", file=sys.stderr)
    if skipped_with_error:
        # Show up to first 5 error reasons so we can see why most got zeroed
        from collections import Counter
        error_counts = Counter(e for _, e in skipped_with_error)
        print(f"[scanner] {len(skipped_with_error)} symbols hit a hard-gate / error:", file=sys.stderr)
        for reason, count in error_counts.most_common(5):
            print(f"[scanner]   {count:>4}x — {reason[:120]}", file=sys.stderr)
    # Show top-10 composite scores so we can see the distribution
    top_scored = sorted([s for s in scores if not s.error], key=lambda x: -x.composite)[:10]
    if top_scored:
        print(f"[scanner] top-10 by composite (threshold {args.min_score}):", file=sys.stderr)
        for s in top_scored:
            mark = "✓" if s.composite >= args.min_score else "·"
            print(f"[scanner]   {mark} {s.symbol:<12} composite={s.composite:.3f} close={s.close:.2f} dir={s.direction}", file=sys.stderr)
    else:
        print(f"[scanner] no scored symbols (all errored or missing data)", file=sys.stderr)

    if not args.json:
        print()
        print(render_table(scores, args.top))

    if args.json:
        # Reject picks with bad price data — null/NaN close means we can't size
        # an order, and downstream broker calls fail on Infinity quantity.
        def _has_valid_price(s: Score) -> bool:
            return (
                isinstance(s.close, (int, float))
                and math.isfinite(s.close)
                and s.close > 0
            )
        winners = [asdict(s) for s in sorted(scores, key=lambda s: -s.composite)
                   if s.composite >= args.min_score and _has_valid_price(s)][: args.top]
        print(json.dumps(_sanitize_for_json(winners), allow_nan=False), file=sys.stdout, flush=True)

    if args.webhook:
        winners = [asdict(s) for s in sorted(scores, key=lambda s: -s.composite)
                   if s.composite >= args.min_score][: args.top]
        if winners:
            post_webhook(args.webhook, {
                "ts": datetime.utcnow().isoformat() + "Z",
                "scanner": "logdhan-recovery-breakout-v1",
                "picks": winners,
            })
        else:
            print(f"[webhook] no symbols >= {args.min_score}, not firing")


if __name__ == "__main__":
    main()
