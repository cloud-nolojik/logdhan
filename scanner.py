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
        t1=tgt["T1"]["price"], t1_src=tgt["T1"]["src"], t1_pct=tgt["T1"]["pct"],
        t2=tgt["T2"]["price"], t2_src=tgt["T2"]["src"], t2_pct=tgt["T2"]["pct"],
        t3=tgt["T3"]["price"], t3_src=tgt["T3"]["src"], t3_pct=tgt["T3"]["pct"],
        sl=tgt["SL"]["price"], sl_pct=tgt["SL"]["pct"],
        sl_src=tgt["SL"]["src"], sl_trigger=tgt["SL"]["trigger"],
        atr=tgt["SL"]["atr"], breakout_level=tgt["SL"]["breakout_level"],
        rr_t1=tgt["RR_T1"], rr_t2=tgt["RR_T2"], rr_t3=tgt["RR_T3"],
    )


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
    args = ap.parse_args()

    if args.watchlist:
        with open(args.watchlist) as f:
            symbols = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    else:
        symbols = DEFAULT_WATCHLIST

    print(f"[scanner] {len(symbols)} symbols, fetching 6mo history...")
    t0 = time.time()
    history = fetch_history(symbols)
    print(f"[scanner] fetched {len(history)}/{len(symbols)} in {time.time()-t0:.1f}s")

    scores = []
    for sym in symbols:
        if sym not in history:
            continue
        s = score_symbol(sym, history[sym])
        if not args.no_tv:
            s = add_tv_verdict(s)
        scores.append(s)

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
