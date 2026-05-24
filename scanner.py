"""
logdhan INTRADAY pre-open scanner (v3 — May 2026).

═══════════════════════════════════════════════════════════════════════════
USE CASE (LOCKED — DO NOT EXPAND)
═══════════════════════════════════════════════════════════════════════════
This scanner exists for ONE workflow:

    08:30 IST  →  cron runs the 8:30 job
                  → dailyPicksService spawns this script
                  → scanner picks top-3 candidates from F&O universe
    08:30-09:00 →  AMO (After-Market Order) MARKET MIS orders placed
    09:15 IST  →  market opens, AMO orders convert to live MIS positions
    09:15-15:15 →  position monitored intraday (≤ 6 hours)
    15:15 IST  →  HARD SQUARE-OFF (10 min before MIS auto-square at 15:25)

Every stop/target/gate in this file is calibrated for that 6-hour window.
This is NOT a swing scanner. It does NOT hold overnight. Multi-day setups
belong in scanner_swing.py.

Consequences for scoring:
  • SL is tight (0.7× ATR, capped at 1.5% of price) — intraday-sized risk
  • Targets are 1R / 2R / 3R sized to the tight SL, so even T3 is hittable
    in 6 hours for the top quartile of intraday moves
  • ATR% gates — sit out stocks that won't move 1R in 6h (ATR<0.8%) OR
    are too violent for intraday risk (ATR>5%)
  • Hard reject on stocks that already ran > 8% yesterday (exhausted move)

═══════════════════════════════════════════════════════════════════════════
ARCHITECTURE
═══════════════════════════════════════════════════════════════════════════
    Node (dailyPicksService.js) → spawns this script with --mode <X> →
    reads daily candles (yfinance OR Mongo) → scores each symbol against
    the mode → prints top-N JSON to stdout → Node parses and persists.

Same CLI, same JSON shape, same Score dataclass as scanner_swing.py — so
downstream parsing in dailyPicksService.js is identical.

═══════════════════════════════════════════════════════════════════════════
MODES (one per regime — selected by dailyPicksService.REGIME_TO_INTRADAY_MODE)
═══════════════════════════════════════════════════════════════════════════
  intraday_gap_long       STRONG_BULL  LONG   yesterday top-quartile + vol
                                              spike + 3d momo + near 20d
                                              high → AMO LONG, expect gap-up
                                              or open-range breakout
  intraday_breakout_long  WEAK_BULL    LONG   3-day coil + above rising
                                              20EMA + within 2% of 20d
                                              high → AMO LONG, expect
                                              expansion intraday
  intraday_range_fade     NEUTRAL      LONG   ADX<20 + RSI(2)<15 + bottom
                                              quartile of 10d range → AMO
                                              LONG mean-reversion
  intraday_failed_rally   WEAK_BEAR    SHORT  yesterday rallied >2% but
                                              closed red below open → AMO
                                              SHORT (proven 69% hit rate
                                              in swing analog)
  intraday_gap_short      STRONG_BEAR  SHORT  closed in bottom quartile +
                                              below 20/50EMA + near 20d
                                              low → AMO SHORT continuation

Usage:
    python scanner.py --mode intraday_gap_long --top 3 --json
    python scanner.py --mode intraday_failed_rally --asof 2026-05-21 --json
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

import numpy as np
import pandas as pd
import yfinance as yf

try:
    from tradingview_ta import TA_Handler, Interval
    TV_TA_AVAILABLE = True
except ImportError:
    TV_TA_AVAILABLE = False


def _sanitize_for_json(obj):
    # NaN/Inf are valid floats but invalid JSON — Node's JSON.parse rejects them.
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    # numpy scalar types (np.bool_, np.float64, np.int64) are NOT instances of
    # Python's bool/float/int and the stdlib json encoder cannot serialize them.
    # Coerce them to the matching Python primitive before recursion.
    if hasattr(obj, '__class__') and obj.__class__.__module__ == 'numpy':
        try:
            return _sanitize_for_json(obj.item())
        except (AttributeError, ValueError):
            return None
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_for_json(v) for v in obj]
    return obj


# ─── hard filters (all tuned for 8:30 AMO → 15:15 square-off) ───────────────
# 1. Stocks that already ran 8%+ yesterday are exhausted / near F&O-ban.
MAX_PREV_DAY_MOVE_PCT = 8.0

# 2. ATR% floor — below 0.8% daily ATR, the stock physically can't move
#    1R in 6 hours without paying us. Skip.
MIN_ATR_PCT_FOR_INTRADAY = 0.8

# 3. ATR% ceiling — above 5% daily ATR, the stop becomes too wide for
#    intraday risk (we'd be sized to 1R = 3.5%+ loss after 0.7× ATR scaling).
#    Most of these are illiquid microcaps or already in F&O ban.
MAX_ATR_PCT_FOR_INTRADAY = 5.0

# 4. SL sizing for intraday: 0.7× ATR is tight enough to survive normal
#    morning noise but loose enough not to be whipsawed by the first 5-min
#    candle. Capped at 1.5% absolute so a high-ATR stock can't blow our
#    per-trade risk budget, and FLOORED at 0.5% so prev-low/prev-high
#    snapping can't produce a sub-floor risk pick that the Node side will
#    accept (scanner picks bypass ORB-validator's MIN_RISK_PCT_PER_TRADE
#    gate — see dailyPicksService.js:2374; we self-enforce here).
SL_ATR_MULT_INTRADAY = 0.7
SL_MAX_PCT_INTRADAY = 1.5
SL_MIN_PCT_INTRADAY = 0.5   # MUST mirror MIN_RISK_PCT_PER_TRADE in dailyPicksConstants.js

# 5. Target sizing: 1R/2R/3R against the tight SL above. With SL ≈ 1% of
#    price, T3 (3R) ≈ 3% intraday move — hittable in 6h for the top
#    quartile of trending stocks.
TARGET_R_MULTIPLIERS = (1.0, 2.0, 3.0)


# -------- default watchlist (Nifty 50 — gets overridden by --watchlist) --------
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


# ─── indicators ─────────────────────────────────────────────────────────────

def rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def adx(df: pd.DataFrame, period: int = 14) -> pd.DataFrame:
    high, low, close = df["High"], df["Low"], df["Close"]
    plus_dm = high.diff().clip(lower=0)
    minus_dm = (-low.diff()).clip(lower=0)
    # If both move, the one with the larger move "wins"
    cond = plus_dm > minus_dm
    plus_dm = plus_dm.where(cond, 0.0)
    minus_dm = minus_dm.where(~cond, 0.0)

    tr = pd.concat([
        (high - low),
        (high - close.shift()).abs(),
        (low - close.shift()).abs(),
    ], axis=1).max(axis=1)
    atr_n = tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr_n
    minus_di = 100 * minus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr_n
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx_n = dx.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    return pd.DataFrame({"ADX": adx_n, "+DI": plus_di, "-DI": minus_di, "ATR": atr_n})


def classical_pivots(prev_high: float, prev_low: float, prev_close: float) -> dict:
    """
    Classical (Floor Trader) pivot points — computed from PRIOR day's H/L/C
    and valid for the NEXT trading session. Returns {P, R1, R2, R3, S1, S2, S3}.

    Standard floor-trader formulas:
        P  = (H + L + C) / 3
        R1 = 2P - L                 S1 = 2P - H
        R2 = P + (H - L)            S2 = P - (H - L)
        R3 = H + 2 × (P - L)        S3 = L - 2 × (H - P)

    These are emitted into scan_meta as informational reference levels — the
    JS-side morning briefing logs them alongside computed T1/T2/T3 so the user
    can see whether nearby resistance/support sits in the way of the planned
    targets. Pure observability — does not change entry/SL/target math.
    """
    if not (prev_high > 0 and prev_low > 0 and prev_close > 0):
        return {}
    p = (prev_high + prev_low + prev_close) / 3.0
    rng = prev_high - prev_low
    return {
        "P":  round(p, 2),
        "R1": round(2 * p - prev_low, 2),
        "R2": round(p + rng, 2),
        "R3": round(prev_high + 2 * (p - prev_low), 2),
        "S1": round(2 * p - prev_high, 2),
        "S2": round(p - rng, 2),
        "S3": round(prev_low - 2 * (prev_high - p), 2),
    }


def atr_series(df: pd.DataFrame, period: int = 14) -> pd.Series:
    high, low, close = df["High"], df["Low"], df["Close"]
    tr = pd.concat([
        (high - low),
        (high - close.shift()).abs(),
        (low - close.shift()).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


# ─── intraday target/stop computation ───────────────────────────────────────
# For intraday picks we don't reach for weekly/monthly pivots — the trade
# closes by 3:25pm. Stops and targets are ATR-based and proportional to risk.
# T1 = 1R, T2 = 2R, T3 = 3R. SL = 1× ATR away from entry.
# Entry is provisional (yesterday's close); the live ORB validator overrides
# entry/SL at the actual open.

def _intraday_sl_distance(close: float, atr_val: float) -> float:
    """
    Intraday SL distance — 0.7× ATR(14), capped at 1.5% of price AND
    floored at 0.5% of price. The floor exists because the Node-side
    `dailyPicksService.runScannerPy` path bypasses the ORB validator's
    MIN_RISK_PCT_PER_TRADE = 0.5% gate (it's a 'scanner' path, no ORB
    check). Without this floor, prev-low/prev-high snapping inside a
    small ATR could produce a 0.3–0.4% risk pick whose net edge is
    eaten by fees + slippage (~0.3% round-trip).

    Order matters: clamp to ceiling first (min with pct_cap), then to
    floor (max with pct_floor). If ceiling < floor (only happens for
    truly degenerate inputs), floor wins so we never undercut MIN risk.
    """
    atr_sl = atr_val * SL_ATR_MULT_INTRADAY
    pct_cap = close * (SL_MAX_PCT_INTRADAY / 100.0)
    pct_floor = close * (SL_MIN_PCT_INTRADAY / 100.0)
    return max(min(atr_sl, pct_cap), pct_floor)


def compute_intraday_targets_long(close: float, atr_val: float, prev_low: float) -> dict:
    """LONG intraday target/stop scaffold sized for 8:30 AMO → 15:15 exit.

    SL selection (in order):
      1. Start with 0.7× ATR distance (clamped to [0.5%, 1.5%] of close).
      2. If yesterday's low sits *inside* the ATR-based stop, snap to it
         (a real structural level beats a number).
      3. Floor-check: if the resulting risk is below the MIN_RISK_PCT
         floor (0.5%), revert to the floor — even when prev_low says
         tighter is possible. Scanner picks bypass the ORB validator's
         risk-floor check, so we enforce it here so fees + slippage
         (~0.3% round-trip) don't eat the edge.
    """
    if atr_val <= 0 or close <= 0:
        return _empty_target_block()

    risk_distance_floor = close * (SL_MIN_PCT_INTRADAY / 100.0)
    risk_distance = _intraday_sl_distance(close, atr_val)
    sl_atr_based = close - risk_distance
    sl = sl_atr_based
    sl_src = f"atr-{SL_ATR_MULT_INTRADAY}x"

    # Step 2 — prev_low snap if it's a tighter (closer-to-entry) stop
    if prev_low > 0 and prev_low > sl_atr_based:
        sl = prev_low
        sl_src = "prev-low"

    # Step 3 — floor enforcement: if any path produced sub-floor risk,
    # revert to the floor-based SL so MIN_RISK_PCT is always satisfied
    risk = close - sl
    if risk < risk_distance_floor:
        sl = close - risk_distance_floor
        sl_src = "min-risk-floor"
        risk = risk_distance_floor

    if risk <= 0:
        return _empty_target_block()

    m1, m2, m3 = TARGET_R_MULTIPLIERS
    t1 = close + risk * m1
    t2 = close + risk * m2
    t3 = close + risk * m3
    return {
        "T1": t1, "T1_src": f"intra-{m1}R", "T1_pct": (t1 / close - 1) * 100,
        "T2": t2, "T2_src": f"intra-{m2}R", "T2_pct": (t2 / close - 1) * 100,
        "T3": t3, "T3_src": f"intra-{m3}R", "T3_pct": (t3 / close - 1) * 100,
        "SL": sl, "SL_src": sl_src,         "SL_pct": (sl / close - 1) * 100,
        "ATR": atr_val,
        "BREAKOUT_LEVEL": close,
        "RR_T1": m1, "RR_T2": m2, "RR_T3": m3,
    }


def compute_intraday_targets_short(close: float, atr_val: float, prev_high: float) -> dict:
    """SHORT intraday target/stop scaffold sized for 8:30 AMO → 15:15 exit.

    Mirror of compute_intraday_targets_long — see that docstring for SL
    selection rules. Floor-check enforces MIN_RISK_PCT after prev_high
    snap so a tight high can't undercut the risk floor.
    """
    if atr_val <= 0 or close <= 0:
        return _empty_target_block()

    risk_distance_floor = close * (SL_MIN_PCT_INTRADAY / 100.0)
    risk_distance = _intraday_sl_distance(close, atr_val)
    sl_atr_based = close + risk_distance
    sl = sl_atr_based
    sl_src = f"atr-{SL_ATR_MULT_INTRADAY}x"

    if prev_high > 0 and prev_high < sl_atr_based:
        sl = prev_high
        sl_src = "prev-high"

    risk = sl - close
    if risk < risk_distance_floor:
        sl = close + risk_distance_floor
        sl_src = "min-risk-floor"
        risk = risk_distance_floor

    if risk <= 0:
        return _empty_target_block()

    m1, m2, m3 = TARGET_R_MULTIPLIERS
    t1 = close - risk * m1
    t2 = close - risk * m2
    t3 = close - risk * m3
    return {
        "T1": t1, "T1_src": f"intra-{m1}R", "T1_pct": (t1 / close - 1) * 100,
        "T2": t2, "T2_src": f"intra-{m2}R", "T2_pct": (t2 / close - 1) * 100,
        "T3": t3, "T3_src": f"intra-{m3}R", "T3_pct": (t3 / close - 1) * 100,
        "SL": sl, "SL_src": sl_src,         "SL_pct": (sl / close - 1) * 100,
        "ATR": atr_val,
        "BREAKOUT_LEVEL": close,
        "RR_T1": m1, "RR_T2": m2, "RR_T3": m3,
    }


def _empty_target_block() -> dict:
    return {
        "T1": 0.0, "T1_src": "",  "T1_pct": 0.0,
        "T2": 0.0, "T2_src": "",  "T2_pct": 0.0,
        "T3": 0.0, "T3_src": "",  "T3_pct": 0.0,
        "SL": 0.0, "SL_src": "",  "SL_pct": 0.0,
        "ATR": 0.0,
        "BREAKOUT_LEVEL": 0.0,
        "RR_T1": None, "RR_T2": None, "RR_T3": None,
    }


# ─── Score dataclass (kept identical to scanner_swing.py for compatibility) ──

@dataclass
class Score:
    symbol: str
    close: float
    pct_change: float
    volume_spike: float
    range_pos: float
    breakout_strength: float
    rsi: float
    rsi_signal: float
    rsi_cross_up: bool
    recovery_pct: float
    f1_vol_spike: float
    f2_wide_range: float
    f3_resistance: float
    f4_rsi_cross: float
    f5_recovery: float
    composite: float
    mode: str = "intraday_gap_long"
    direction: str = "LONG"
    scan_meta: Optional[dict] = None
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


def _empty_score(symbol: str, mode: str, direction: str, err: str) -> Score:
    return Score(symbol, *([0.0]*7), False, *([0.0]*7),
                 mode=mode, direction=direction, error=err)


def _prev_day_move_pct(df: pd.DataFrame) -> float:
    last = df.iloc[-1]
    prev_close = df["Close"].iloc[-2]
    if prev_close <= 0:
        return 0.0
    return (float(last["Close"]) / float(prev_close) - 1) * 100


def _intraday_atr_gate(close: float, atr_val: float) -> Optional[str]:
    """
    Returns None if ATR% is in the intraday-tradeable band, otherwise a
    string reason for skipping. Both bounds are exclusive.

    Floor (0.8%): below this, even a perfect 3R intraday move won't clear
    transaction costs + slippage meaningfully.
    Ceiling (5.0%): above this, the 0.7× ATR stop > 1.5% cap kicks in and
    R:R math becomes unreliable; usually these are illiquid microcaps.
    """
    if close <= 0 or atr_val <= 0:
        return "missing ATR/close"
    atr_pct = (atr_val / close) * 100
    if atr_pct < MIN_ATR_PCT_FOR_INTRADAY:
        return f"ATR%={atr_pct:.2f}% below intraday floor {MIN_ATR_PCT_FOR_INTRADAY}% (won't move 1R in 6h)"
    if atr_pct > MAX_ATR_PCT_FOR_INTRADAY:
        return f"ATR%={atr_pct:.2f}% above intraday ceiling {MAX_ATR_PCT_FOR_INTRADAY}% (too volatile for intraday risk)"
    return None


# ─── MODE 1: intraday_gap_long  (STRONG_BULL → LONG) ────────────────────────
# Pattern: stock closed in top quartile of yesterday's range on heavy volume,
# already in a 3-day uptrend, and within 3% of its 20-day high.
# Thesis: next morning likely gaps up and continues — buy the open-range
# breakout.

def score_intraday_gap_long(symbol: str, df: pd.DataFrame) -> Score:
    mode = "intraday_gap_long"
    direction = "LONG"
    if len(df) < 30:
        return _empty_score(symbol, mode, direction, "insufficient history")

    df = df.copy()
    df["VOL_AVG20"] = df["Volume"].rolling(20).mean()
    df["ATR14"] = atr_series(df, 14)

    pct_change = _prev_day_move_pct(df)
    if pct_change > MAX_PREV_DAY_MOVE_PCT:
        return _empty_score(symbol, mode, direction,
                            f"prior-day move {pct_change:.1f}% > {MAX_PREV_DAY_MOVE_PCT}% gate")

    last = df.iloc[-1]
    close = float(last["Close"])
    high = float(last["High"])
    low = float(last["Low"])
    vol = float(last["Volume"])
    atr_val = float(last["ATR14"]) if not pd.isna(last["ATR14"]) else 0.0
    vol_avg = float(last["VOL_AVG20"]) if not pd.isna(last["VOL_AVG20"]) else vol

    # Intraday-tradeable ATR? (0.8% floor / 5% ceiling)
    atr_skip = _intraday_atr_gate(close, atr_val)
    if atr_skip:
        return _empty_score(symbol, mode, direction, atr_skip)

    # F1 — range_pos: close in top quartile (buyers holding the close)
    rng = high - low
    range_pos = (close - low) / rng if rng > 0 else 0.5
    f1 = max(0.0, (range_pos - 0.5) * 2)   # 0 at midpoint, 1.0 at top

    # F2 — volume confirmation (>1.5× avg)
    vol_spike = vol / vol_avg if vol_avg > 0 else 1.0
    f2 = min(max(0.0, (vol_spike - 1.0) / 1.5), 1.0)   # 1.5× = 0.33, 2.5× = 1.0

    # F3 — 3-day momentum (cumulative > +2%)
    if len(df) >= 5:
        three_day_chg = (close / float(df["Close"].iloc[-4]) - 1) * 100
    else:
        three_day_chg = 0.0
    f3 = 1.0 if three_day_chg >= 2.0 else max(0.0, three_day_chg / 2.0)

    # F4 — proximity to 20-day high (within 3%)
    high_20 = df["High"].iloc[-21:-1].max() if len(df) >= 21 else high
    dist_to_high = (close / high_20 - 1) * 100
    if -3.0 <= dist_to_high <= 0.5:
        f4 = 1.0
    elif -5.0 < dist_to_high < -3.0:
        f4 = 0.5
    else:
        f4 = 0.0

    # F5 — ATR% in sweet spot (1.5–4.0% → enough range to move 1R)
    atr_pct = (atr_val / close) * 100 if close > 0 else 0.0
    if 1.5 <= atr_pct <= 4.0:
        f5 = 1.0
    elif 1.0 <= atr_pct < 1.5 or 4.0 < atr_pct <= 5.5:
        f5 = 0.5
    else:
        f5 = 0.1

    composite = 0.20*f1 + 0.25*f2 + 0.20*f3 + 0.20*f4 + 0.15*f5

    tgt = compute_intraday_targets_long(close, atr_val, low)
    return Score(
        symbol=symbol, close=close, pct_change=pct_change,
        volume_spike=vol_spike, range_pos=range_pos,
        breakout_strength=dist_to_high / 100.0,
        rsi=0.0, rsi_signal=0.0, rsi_cross_up=False,
        recovery_pct=three_day_chg / 100.0,
        f1_vol_spike=f1, f2_wide_range=f2, f3_resistance=f3,
        f4_rsi_cross=f4, f5_recovery=f5,
        composite=composite,
        mode=mode, direction=direction,
        scan_meta={
            "intraday": True, "hold_to": "15:15 IST", "max_hold_minutes": 360,
            "atr_pct": atr_pct, "three_day_chg": three_day_chg,
            "dist_to_high_pct": dist_to_high,
        },
        t1=tgt["T1"], t1_src=tgt["T1_src"], t1_pct=tgt["T1_pct"],
        t2=tgt["T2"], t2_src=tgt["T2_src"], t2_pct=tgt["T2_pct"],
        t3=tgt["T3"], t3_src=tgt["T3_src"], t3_pct=tgt["T3_pct"],
        sl=tgt["SL"], sl_src=tgt["SL_src"], sl_pct=tgt["SL_pct"],
        atr=atr_val, breakout_level=tgt["BREAKOUT_LEVEL"],
        rr_t1=tgt["RR_T1"], rr_t2=tgt["RR_T2"], rr_t3=tgt["RR_T3"],
    )


# ─── MODE 2: intraday_breakout_long (WEAK_BULL → LONG) ──────────────────────
# Pattern: stock has been ranging tightly the past 3 days, close > 20EMA
# (rising), within 2% of 20-day high, RSI 50-70, volume building.
# Thesis: tight coil + uptrend = imminent breakout intraday.

def score_intraday_breakout_long(symbol: str, df: pd.DataFrame) -> Score:
    mode = "intraday_breakout_long"
    direction = "LONG"
    if len(df) < 30:
        return _empty_score(symbol, mode, direction, "insufficient history")

    df = df.copy()
    df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()
    df["RSI"] = rsi(df["Close"])
    df["VOL_AVG20"] = df["Volume"].rolling(20).mean()
    df["ATR14"] = atr_series(df, 14)

    pct_change = _prev_day_move_pct(df)
    if pct_change > MAX_PREV_DAY_MOVE_PCT:
        return _empty_score(symbol, mode, direction,
                            f"prior-day move {pct_change:.1f}% > {MAX_PREV_DAY_MOVE_PCT}% gate")

    last = df.iloc[-1]
    close = float(last["Close"])
    high = float(last["High"])
    low = float(last["Low"])
    ema20 = float(last["EMA20"])
    rsi_now = float(last["RSI"]) if not pd.isna(last["RSI"]) else 50.0
    atr_val = float(last["ATR14"]) if not pd.isna(last["ATR14"]) else 0.0
    vol_avg = float(last["VOL_AVG20"]) if not pd.isna(last["VOL_AVG20"]) else float(last["Volume"])

    atr_skip = _intraday_atr_gate(close, atr_val)
    if atr_skip:
        return _empty_score(symbol, mode, direction, atr_skip)

    # F1 — tight 3-day range: (max-min)/min over last 3 closes < 3%
    if len(df) >= 4:
        c3 = df["Close"].iloc[-4:-1]
        tight = (c3.max() / c3.min() - 1) * 100
    else:
        tight = 99.0
    if tight <= 1.5:
        f1 = 1.0
    elif tight <= 3.0:
        f1 = 1.0 - (tight - 1.5) / 1.5 * 0.5    # 1.0→0.5 across the 1.5–3.0 band
    else:
        f1 = 0.0

    # F2 — close > 20EMA, EMA20 rising
    ema20_prev = float(df["EMA20"].iloc[-6])  # ema5 days ago
    ema_rising = ema20 > ema20_prev
    above_ema = close > ema20
    if above_ema and ema_rising:
        f2 = 1.0
    elif above_ema:
        f2 = 0.5
    else:
        f2 = 0.0

    # F3 — distance to 20-day high < 2%
    high_20 = df["High"].iloc[-21:-1].max() if len(df) >= 21 else high
    dist = (close / high_20 - 1) * 100
    if -2.0 <= dist <= 0.5:
        f3 = 1.0
    elif -4.0 < dist < -2.0:
        f3 = 0.5
    else:
        f3 = 0.0

    # F4 — 3-day volume building (vol[-1] > vol[-2] > vol[-3]) AND > avg
    vols = df["Volume"].iloc[-3:].tolist()
    building = (len(vols) == 3 and vols[2] >= vols[1] >= vols[0])
    above_avg = float(last["Volume"]) >= vol_avg
    if building and above_avg:
        f4 = 1.0
    elif above_avg:
        f4 = 0.5
    else:
        f4 = 0.0

    # F5 — RSI in 50-70 (uptrend, room to run)
    if 50 <= rsi_now <= 70:
        f5 = 1.0
    elif 45 <= rsi_now < 50 or 70 < rsi_now <= 75:
        f5 = 0.5
    else:
        f5 = 0.0

    composite = 0.20*f1 + 0.20*f2 + 0.25*f3 + 0.20*f4 + 0.15*f5

    tgt = compute_intraday_targets_long(close, atr_val, low)
    vol_spike = float(last["Volume"]) / vol_avg if vol_avg > 0 else 1.0
    rng = high - low
    range_pos = (close - low) / rng if rng > 0 else 0.5

    return Score(
        symbol=symbol, close=close, pct_change=pct_change,
        volume_spike=vol_spike, range_pos=range_pos,
        breakout_strength=dist / 100.0,
        rsi=rsi_now, rsi_signal=0.0, rsi_cross_up=False,
        recovery_pct=0.0,
        f1_vol_spike=f1, f2_wide_range=f2, f3_resistance=f3,
        f4_rsi_cross=f4, f5_recovery=f5,
        composite=composite,
        mode=mode, direction=direction,
        scan_meta={
            "intraday": True, "hold_to": "15:15 IST", "max_hold_minutes": 360,
            "atr_pct": (atr_val / close) * 100 if close > 0 else 0.0,
            "tight_pct": tight, "dist_to_high_pct": dist,
            "ema20_rising": bool(ema_rising),
        },
        t1=tgt["T1"], t1_src=tgt["T1_src"], t1_pct=tgt["T1_pct"],
        t2=tgt["T2"], t2_src=tgt["T2_src"], t2_pct=tgt["T2_pct"],
        t3=tgt["T3"], t3_src=tgt["T3_src"], t3_pct=tgt["T3_pct"],
        sl=tgt["SL"], sl_src=tgt["SL_src"], sl_pct=tgt["SL_pct"],
        atr=atr_val, breakout_level=tgt["BREAKOUT_LEVEL"],
        rr_t1=tgt["RR_T1"], rr_t2=tgt["RR_T2"], rr_t3=tgt["RR_T3"],
    )


# ─── MODE 3: intraday_range_fade (NEUTRAL → LONG mean-reversion) ────────────
# Pattern: ADX<20 (non-trending), RSI(2)<15 (Connors-oversold), close in
# bottom quartile of 10-day range, 1-4% below 20EMA, low ATR% (<2.5%).
# Thesis: in a sleepy, range-bound market, oversold names mechanically bounce
# back to the mid-range. Intraday mean-reversion long.

def score_intraday_range_fade(symbol: str, df: pd.DataFrame) -> Score:
    mode = "intraday_range_fade"
    direction = "LONG"
    if len(df) < 30:
        return _empty_score(symbol, mode, direction, "insufficient history")

    df = df.copy()
    df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()
    df["RSI2"] = rsi(df["Close"], period=2)
    df["ATR14"] = atr_series(df, 14)
    adx_df = adx(df, 14)
    df["ADX"] = adx_df["ADX"]

    pct_change = _prev_day_move_pct(df)
    # Mean-reversion: a stock that just crashed -5% in one day is more likely
    # to bounce than continue, so we *don't* hard-gate big down days here.
    # We only block big *up* days (already mean-reverted upward).
    if pct_change > 4.0:
        return _empty_score(symbol, mode, direction,
                            f"already bounced ({pct_change:.1f}%) — mean-reversion edge gone")

    last = df.iloc[-1]
    close = float(last["Close"])
    high = float(last["High"])
    low = float(last["Low"])
    ema20 = float(last["EMA20"])
    adx_now = float(last["ADX"]) if not pd.isna(last["ADX"]) else 30.0
    rsi2 = float(last["RSI2"]) if not pd.isna(last["RSI2"]) else 50.0
    atr_val = float(last["ATR14"]) if not pd.isna(last["ATR14"]) else 0.0
    atr_pct = (atr_val / close) * 100 if close > 0 else 0.0

    atr_skip = _intraday_atr_gate(close, atr_val)
    if atr_skip:
        return _empty_score(symbol, mode, direction, atr_skip)

    # F1 — ADX < 20 (non-trending)
    if adx_now < 15:
        f1 = 1.0
    elif adx_now < 20:
        f1 = 0.7
    elif adx_now < 25:
        f1 = 0.3
    else:
        f1 = 0.0

    # F2 — close in bottom quartile of 10-day range
    high_10 = df["High"].iloc[-10:].max()
    low_10 = df["Low"].iloc[-10:].min()
    rng10 = high_10 - low_10
    pos10 = (close - low_10) / rng10 if rng10 > 0 else 0.5
    if pos10 <= 0.25:
        f2 = 1.0
    elif pos10 <= 0.35:
        f2 = 0.6
    else:
        f2 = 0.0

    # F3 — RSI(2) < 15 (Connors threshold)
    if rsi2 < 10:
        f3 = 1.0
    elif rsi2 < 15:
        f3 = 0.8
    elif rsi2 < 25:
        f3 = 0.4
    else:
        f3 = 0.0

    # F4 — distance below 20EMA in 1–4% band (oversold but not broken)
    dist_below_ema = (ema20 / close - 1) * 100 if close > 0 else 0
    if 1.0 <= dist_below_ema <= 4.0:
        f4 = 1.0
    elif 0.5 <= dist_below_ema < 1.0 or 4.0 < dist_below_ema <= 6.0:
        f4 = 0.5
    else:
        f4 = 0.0

    # F5 — low ATR% (<2.5% → mechanical bounce, not high-vol catch-knife)
    if atr_pct < 1.5:
        f5 = 1.0
    elif atr_pct < 2.5:
        f5 = 0.6
    else:
        f5 = 0.0

    composite = 0.15*f1 + 0.20*f2 + 0.30*f3 + 0.20*f4 + 0.15*f5

    tgt = compute_intraday_targets_long(close, atr_val, low)
    rng = high - low
    range_pos = (close - low) / rng if rng > 0 else 0.5

    return Score(
        symbol=symbol, close=close, pct_change=pct_change,
        volume_spike=1.0, range_pos=range_pos,
        breakout_strength=0.0,
        rsi=rsi2, rsi_signal=0.0, rsi_cross_up=False,
        recovery_pct=0.0,
        f1_vol_spike=f1, f2_wide_range=f2, f3_resistance=f3,
        f4_rsi_cross=f4, f5_recovery=f5,
        composite=composite,
        mode=mode, direction=direction,
        scan_meta={
            "intraday": True, "hold_to": "15:15 IST", "max_hold_minutes": 360,
            "adx": adx_now, "rsi2": rsi2,
            "pos_in_10d_range": pos10, "atr_pct": atr_pct,
            "dist_below_ema20_pct": dist_below_ema,
        },
        t1=tgt["T1"], t1_src=tgt["T1_src"], t1_pct=tgt["T1_pct"],
        t2=tgt["T2"], t2_src=tgt["T2_src"], t2_pct=tgt["T2_pct"],
        t3=tgt["T3"], t3_src=tgt["T3_src"], t3_pct=tgt["T3_pct"],
        sl=tgt["SL"], sl_src=tgt["SL_src"], sl_pct=tgt["SL_pct"],
        atr=atr_val, breakout_level=tgt["BREAKOUT_LEVEL"],
        rr_t1=tgt["RR_T1"], rr_t2=tgt["RR_T2"], rr_t3=tgt["RR_T3"],
    )


# ─── MODE 4: intraday_failed_rally (WEAK_BEAR → SHORT) ──────────────────────
# Pattern: stock made a new 5-day high intraday but closed in lower half,
# below the open (intraday reversal). RSI rolling over from >60. Volume
# spike on the failed bar. Close < 20EMA or EMA flattening.
# Thesis: failed rally = exhausted bulls = short opportunity next morning.

def score_intraday_failed_rally(symbol: str, df: pd.DataFrame) -> Score:
    mode = "intraday_failed_rally"
    direction = "SHORT"
    if len(df) < 30:
        return _empty_score(symbol, mode, direction, "insufficient history")

    df = df.copy()
    df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()
    df["RSI"] = rsi(df["Close"])
    df["VOL_AVG20"] = df["Volume"].rolling(20).mean()
    df["ATR14"] = atr_series(df, 14)

    pct_change = _prev_day_move_pct(df)
    # For SHORTs we block stocks that already broke down hard (-5%) yesterday
    # — easy short is gone, we'd be selling into a possible bounce.
    if pct_change < -5.0:
        return _empty_score(symbol, mode, direction,
                            f"already broke down ({pct_change:.1f}%) — short edge gone")

    last = df.iloc[-1]
    open_ = float(last["Open"])
    close = float(last["Close"])
    high = float(last["High"])
    low = float(last["Low"])
    ema20 = float(last["EMA20"])
    rsi_now = float(last["RSI"]) if not pd.isna(last["RSI"]) else 50.0
    atr_val = float(last["ATR14"]) if not pd.isna(last["ATR14"]) else 0.0
    vol_avg = float(last["VOL_AVG20"]) if not pd.isna(last["VOL_AVG20"]) else float(last["Volume"])

    atr_skip = _intraday_atr_gate(close, atr_val)
    if atr_skip:
        return _empty_score(symbol, mode, direction, atr_skip)

    rng = high - low
    range_pos = (close - low) / rng if rng > 0 else 0.5

    # F1 — failed rally: intraday made >2% high but closed in lower half AND below open
    intraday_high_pct = (high / open_ - 1) * 100 if open_ > 0 else 0
    closed_red = close < open_
    closed_lower_half = range_pos < 0.5
    if intraday_high_pct >= 2.0 and closed_red and closed_lower_half:
        f1 = 1.0
    elif intraday_high_pct >= 1.0 and closed_red and range_pos < 0.6:
        f1 = 0.5
    else:
        f1 = 0.0

    # F2 — close < 20EMA OR EMA flattening
    ema20_prev = float(df["EMA20"].iloc[-6])
    below_ema = close < ema20
    ema_flat_or_down = ema20 <= ema20_prev * 1.001
    if below_ema and ema_flat_or_down:
        f2 = 1.0
    elif below_ema or ema_flat_or_down:
        f2 = 0.5
    else:
        f2 = 0.0

    # F3 — yesterday's high > 5-day prior high (exhaustion print)
    high_prev_5 = df["High"].iloc[-6:-1].max() if len(df) >= 6 else high
    new_5d_high = high > high_prev_5
    if new_5d_high and closed_red:
        f3 = 1.0
    elif new_5d_high:
        f3 = 0.4
    else:
        f3 = 0.0

    # F4 — RSI rolling over from >60 (peak momentum exhaustion)
    rsi_prev = float(df["RSI"].iloc[-2]) if not pd.isna(df["RSI"].iloc[-2]) else 50.0
    rolling_over = (rsi_prev >= 60 and rsi_now < rsi_prev)
    if rolling_over and rsi_now < 60:
        f4 = 1.0
    elif rolling_over:
        f4 = 0.6
    elif rsi_now >= 60 and rsi_now < rsi_prev:
        f4 = 0.4
    else:
        f4 = 0.0

    # F5 — volume spike on the failed bar (>1.5× avg)
    vol_spike = float(last["Volume"]) / vol_avg if vol_avg > 0 else 1.0
    if vol_spike >= 2.0:
        f5 = 1.0
    elif vol_spike >= 1.5:
        f5 = 0.7
    elif vol_spike >= 1.2:
        f5 = 0.3
    else:
        f5 = 0.0

    composite = 0.25*f1 + 0.20*f2 + 0.20*f3 + 0.15*f4 + 0.20*f5

    tgt = compute_intraday_targets_short(close, atr_val, high)
    return Score(
        symbol=symbol, close=close, pct_change=pct_change,
        volume_spike=vol_spike, range_pos=range_pos,
        breakout_strength=intraday_high_pct / 100.0,
        rsi=rsi_now, rsi_signal=rsi_prev, rsi_cross_up=False,
        recovery_pct=0.0,
        f1_vol_spike=f1, f2_wide_range=f2, f3_resistance=f3,
        f4_rsi_cross=f4, f5_recovery=f5,
        composite=composite,
        mode=mode, direction=direction,
        scan_meta={
            "intraday": True, "hold_to": "15:15 IST", "max_hold_minutes": 360,
            "atr_pct": (atr_val / close) * 100 if close > 0 else 0.0,
            "intraday_high_pct": intraday_high_pct,
            "closed_red": bool(closed_red), "new_5d_high": bool(new_5d_high),
            "rsi_rolling_over": bool(rolling_over),
        },
        t1=tgt["T1"], t1_src=tgt["T1_src"], t1_pct=tgt["T1_pct"],
        t2=tgt["T2"], t2_src=tgt["T2_src"], t2_pct=tgt["T2_pct"],
        t3=tgt["T3"], t3_src=tgt["T3_src"], t3_pct=tgt["T3_pct"],
        sl=tgt["SL"], sl_src=tgt["SL_src"], sl_pct=tgt["SL_pct"],
        atr=atr_val, breakout_level=tgt["BREAKOUT_LEVEL"],
        rr_t1=tgt["RR_T1"], rr_t2=tgt["RR_T2"], rr_t3=tgt["RR_T3"],
    )


# ─── MODE 5: intraday_gap_short (STRONG_BEAR → SHORT) ───────────────────────
# Pattern: closed in bottom quartile, below 20EMA AND 50EMA (descending),
# within 2% of 20-day low, 5-day momentum negative, volume on the down bar.
# Thesis: stocks closing weak in a strong bear regime tend to gap down or
# break key support intraday.

def score_intraday_gap_short(symbol: str, df: pd.DataFrame) -> Score:
    mode = "intraday_gap_short"
    direction = "SHORT"
    if len(df) < 60:
        return _empty_score(symbol, mode, direction, "insufficient history")

    df = df.copy()
    df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()
    df["EMA50"] = df["Close"].ewm(span=50, adjust=False).mean()
    df["VOL_AVG20"] = df["Volume"].rolling(20).mean()
    df["ATR14"] = atr_series(df, 14)

    pct_change = _prev_day_move_pct(df)
    if pct_change < -5.0:
        return _empty_score(symbol, mode, direction,
                            f"already broke down ({pct_change:.1f}%) — short edge gone")

    last = df.iloc[-1]
    close = float(last["Close"])
    high = float(last["High"])
    low = float(last["Low"])
    ema20 = float(last["EMA20"])
    ema50 = float(last["EMA50"])
    atr_val = float(last["ATR14"]) if not pd.isna(last["ATR14"]) else 0.0
    vol_avg = float(last["VOL_AVG20"]) if not pd.isna(last["VOL_AVG20"]) else float(last["Volume"])

    atr_skip = _intraday_atr_gate(close, atr_val)
    if atr_skip:
        return _empty_score(symbol, mode, direction, atr_skip)

    rng = high - low
    range_pos = (close - low) / rng if rng > 0 else 0.5

    # F1 — range_pos < 0.25 (closed near day's lows)
    if range_pos <= 0.15:
        f1 = 1.0
    elif range_pos <= 0.30:
        f1 = 1.0 - (range_pos - 0.15) / 0.15 * 0.5
    else:
        f1 = 0.0

    # F2 — 5-day momentum negative (close < close[-6] * 0.97)
    if len(df) >= 7:
        five_day_chg = (close / float(df["Close"].iloc[-6]) - 1) * 100
    else:
        five_day_chg = 0.0
    if five_day_chg <= -5.0:
        f2 = 1.0
    elif five_day_chg <= -3.0:
        f2 = 0.7
    elif five_day_chg < 0:
        f2 = 0.3
    else:
        f2 = 0.0

    # F3 — close < 20EMA < 50EMA (descending stack)
    ema20_prev = float(df["EMA20"].iloc[-6])
    ema_falling = ema20 < ema20_prev
    if close < ema20 < ema50 and ema_falling:
        f3 = 1.0
    elif close < ema20 and ema20 < ema50:
        f3 = 0.7
    elif close < ema20:
        f3 = 0.4
    else:
        f3 = 0.0

    # F4 — distance above 20-day low < 2% (about to break)
    low_20 = df["Low"].iloc[-21:-1].min() if len(df) >= 21 else low
    dist_to_low = (close / low_20 - 1) * 100   # positive = above low
    if 0 <= dist_to_low <= 2.0:
        f4 = 1.0
    elif dist_to_low <= 4.0:
        f4 = 0.5
    elif dist_to_low <= 6.0:
        f4 = 0.2
    else:
        f4 = 0.0

    # F5 — volume spike on the down bar (>1.5× avg)
    vol_spike = float(last["Volume"]) / vol_avg if vol_avg > 0 else 1.0
    is_down_bar = close < float(df["Close"].iloc[-2])
    if is_down_bar and vol_spike >= 2.0:
        f5 = 1.0
    elif is_down_bar and vol_spike >= 1.5:
        f5 = 0.7
    elif vol_spike >= 1.3:
        f5 = 0.3
    else:
        f5 = 0.0

    composite = 0.20*f1 + 0.20*f2 + 0.20*f3 + 0.25*f4 + 0.15*f5

    tgt = compute_intraday_targets_short(close, atr_val, high)
    return Score(
        symbol=symbol, close=close, pct_change=pct_change,
        volume_spike=vol_spike, range_pos=range_pos,
        breakout_strength=dist_to_low / 100.0,
        rsi=0.0, rsi_signal=0.0, rsi_cross_up=False,
        recovery_pct=five_day_chg / 100.0,
        f1_vol_spike=f1, f2_wide_range=f2, f3_resistance=f3,
        f4_rsi_cross=f4, f5_recovery=f5,
        composite=composite,
        mode=mode, direction=direction,
        scan_meta={
            "intraday": True, "hold_to": "15:15 IST", "max_hold_minutes": 360,
            "atr_pct": (atr_val / close) * 100 if close > 0 else 0.0,
            "five_day_chg_pct": five_day_chg,
            "dist_to_20d_low_pct": dist_to_low,
            "ema20_falling": bool(ema_falling),
            "below_ema20_and_50": bool(close < ema20 < ema50),
        },
        t1=tgt["T1"], t1_src=tgt["T1_src"], t1_pct=tgt["T1_pct"],
        t2=tgt["T2"], t2_src=tgt["T2_src"], t2_pct=tgt["T2_pct"],
        t3=tgt["T3"], t3_src=tgt["T3_src"], t3_pct=tgt["T3_pct"],
        sl=tgt["SL"], sl_src=tgt["SL_src"], sl_pct=tgt["SL_pct"],
        atr=atr_val, breakout_level=tgt["BREAKOUT_LEVEL"],
        rr_t1=tgt["RR_T1"], rr_t2=tgt["RR_T2"], rr_t3=tgt["RR_T3"],
    )


# ─── mode registry ──────────────────────────────────────────────────────────

MODE_SCORERS = {
    "intraday_gap_long":      score_intraday_gap_long,        # STRONG_BULL (LONG)
    "intraday_breakout_long": score_intraday_breakout_long,   # WEAK_BULL   (LONG)
    "intraday_range_fade":    score_intraday_range_fade,      # NEUTRAL     (LONG, mean-rev)
    "intraday_failed_rally":  score_intraday_failed_rally,    # WEAK_BEAR   (SHORT)
    "intraday_gap_short":     score_intraday_gap_short,       # STRONG_BEAR (SHORT)
}


# ─── TradingView overlay (shared with swing scanner) ────────────────────────

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


# ─── data fetch (identical to scanner_swing.py — keep behaviour-compatible) ─

def fetch_history(symbols: list[str], period: str = "6mo") -> dict[str, pd.DataFrame]:
    tickers = [f"{s}.NS" for s in symbols]
    data = yf.download(
        tickers, period=period, interval="1d",
        group_by="ticker", auto_adjust=True, progress=False, threads=True,
    )
    out = {}
    for s in symbols:
        t = f"{s}.NS"
        try:
            df = data[t].dropna(subset=["Close"])
            if not df.empty:
                out[s] = df
        except (KeyError, AttributeError):
            pass
    return out


def fetch_history_from_mongo(symbols: list[str], mongo_uri: str) -> dict[str, pd.DataFrame]:
    """Same schema as scanner_swing.py:fetch_history_from_mongo — reads
    `prefetcheddatas` collection (timeframe='1d') to avoid yfinance rate
    limits during backtest replay."""
    try:
        from pymongo import MongoClient
    except ImportError:
        print("[scanner] ERROR: --candles-from-mongo requires pymongo. Install with: pip install pymongo", file=sys.stderr)
        sys.exit(2)

    client = MongoClient(mongo_uri, serverSelectionTimeoutMS=10000)
    db_name = mongo_uri.split('/')[-1].split('?')[0] or 'logdhan'
    db = client[db_name]
    coll = db['prefetcheddatas']

    out = {}
    found = 0
    missing = 0
    for s in symbols:
        doc = coll.find_one({'stock_symbol': s, 'timeframe': '1d'})
        if not doc or not doc.get('candle_data'):
            missing += 1
            continue
        rows = []
        for c in doc['candle_data']:
            ts = c.get('timestamp') or c.get('date')
            if not ts:
                continue
            ts_clean = ts.replace('+05:30', '').replace('T', ' ')
            rows.append({
                'Date': pd.Timestamp(ts_clean),
                'Open':  float(c.get('open', 0)),
                'High':  float(c.get('high', 0)),
                'Low':   float(c.get('low', 0)),
                'Close': float(c.get('close', 0)),
                'Volume': float(c.get('volume', 0)),
            })
        if rows:
            df = pd.DataFrame(rows).set_index('Date').sort_index()
            df = df[df['Close'] > 0]
            if len(df) > 0:
                out[s] = df
                found += 1
            else:
                missing += 1
        else:
            missing += 1

    print(f"[scanner] mongo fetch: {found} symbols loaded, {missing} missing", file=sys.stderr)
    client.close()
    return out


# ─── pretty-print fallback (when --json is not set) ─────────────────────────

def render_table(scores: list[Score], top: int) -> str:
    scores = sorted(scores, key=lambda s: -s.composite)
    lines = []
    lines.append("=== Intraday Signals ===")
    lines.append(f"{'Sym':<12} {'Mode':<22} {'Dir':<5} {'Score':>6} {'%Chg':>6} {'Close':>8} {'ATR':>6}")
    lines.append("-" * 80)
    for s in scores[:top]:
        lines.append(
            f"{s.symbol:<12} {s.mode:<22} {s.direction:<5} {s.composite:>6.3f} "
            f"{s.pct_change:>+6.2f} {s.close:>8.2f} {s.atr:>6.2f}"
        )
    lines.append("")
    lines.append("=== Targets (ATR-based, 1R/2R/3R intraday) ===")
    lines.append(f"{'Sym':<12} {'Entry':>8} {'T1':>8} {'T2':>8} {'T3':>8} {'SL':>8}   {'T1%':>6} {'T2%':>6} {'T3%':>6} {'SL%':>6}")
    lines.append("-" * 90)
    for s in scores[:top]:
        lines.append(
            f"{s.symbol:<12} {s.close:>8.2f} {s.t1:>8.2f} {s.t2:>8.2f} {s.t3:>8.2f} {s.sl:>8.2f}   "
            f"{s.t1_pct:>+6.2f} {s.t2_pct:>+6.2f} {s.t3_pct:>+6.2f} {s.sl_pct:>+6.2f}"
        )
    return "\n".join(lines)


def post_webhook(url: str, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        print(f"[webhook] {resp.status} {resp.reason}")


# ─── main / CLI (identical surface to scanner_swing.py) ─────────────────────

def main():
    ap = argparse.ArgumentParser(description="logdhan intraday scanner (v3)")
    ap.add_argument("--watchlist", help="one symbol per line; falls back to Nifty 50")
    ap.add_argument("--top", type=int, default=3,
                    help="number of top candidates to emit (default 3)")
    ap.add_argument("--webhook", help="POST top-N as JSON to this URL")
    ap.add_argument("--no-tv", action="store_true", help="skip tradingview_ta cross-check")
    ap.add_argument("--min-score", type=float, default=0.3,
                    help="only emit picks above this composite score (default 0.3)")
    ap.add_argument("--json", action="store_true",
                    help="print top-N picks as JSON array to stdout (for Node integration)")
    ap.add_argument("--mode", choices=list(MODE_SCORERS.keys()),
                    default="intraday_gap_long",
                    help="intraday scoring mode (one per regime)")
    ap.add_argument("--asof", default=None,
                    help="historical replay cutoff (YYYY-MM-DD) — inclusive")
    ap.add_argument("--period", default="6mo",
                    help="yfinance history window (default 6mo)")
    ap.add_argument("--candles-from-mongo", default=None, metavar="MONGO_URI",
                    help="read daily candles from MongoDB prefetcheddatas instead of yfinance")
    args = ap.parse_args()

    scorer = MODE_SCORERS.get(args.mode)
    if scorer is None:
        print(f"[scanner] FATAL: unknown mode '{args.mode}'. "
              f"Valid: {list(MODE_SCORERS.keys())}", file=sys.stderr)
        sys.exit(2)

    asof_ts = None
    if args.asof:
        try:
            asof_ts = pd.Timestamp(args.asof)
        except Exception as e:
            print(f"[scanner] FATAL: invalid --asof '{args.asof}': {e}", file=sys.stderr)
            sys.exit(2)

    print(f"[scanner] ═══════════════════════════════════════", file=sys.stderr)
    print(f"[scanner] INTRADAY v3   mode={args.mode} top={args.top} min-score={args.min_score}", file=sys.stderr)
    print(f"[scanner] scorer function={scorer.__name__}", file=sys.stderr)
    if asof_ts is not None:
        print(f"[scanner] HISTORICAL REPLAY: asof={asof_ts.date()} period={args.period}", file=sys.stderr)
    print(f"[scanner] ═══════════════════════════════════════", file=sys.stderr)

    if args.watchlist:
        with open(args.watchlist) as f:
            symbols = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    else:
        symbols = DEFAULT_WATCHLIST

    t0 = time.time()
    if args.candles_from_mongo:
        print(f"[scanner] {len(symbols)} symbols, loading from MongoDB...")
        history = fetch_history_from_mongo(symbols, args.candles_from_mongo)
        print(f"[scanner] mongo loaded {len(history)}/{len(symbols)} in {time.time()-t0:.1f}s", file=sys.stderr)
    else:
        fetch_period = args.period if asof_ts is None else max(args.period, "1y")
        print(f"[scanner] {len(symbols)} symbols, fetching {fetch_period} from yfinance...")
        history = fetch_history(symbols, period=fetch_period)
        print(f"[scanner] yfinance fetched {len(history)}/{len(symbols)} in {time.time()-t0:.1f}s")

    if asof_ts is not None:
        cutoff = asof_ts.normalize() + pd.Timedelta(days=1) - pd.Timedelta(microseconds=1)
        truncated = {}
        dropped = 0
        for sym, df in history.items():
            try:
                df_idx = df.index
                if hasattr(df_idx, 'tz') and df_idx.tz is not None:
                    df_idx = df_idx.tz_localize(None)
                sliced = df.loc[df_idx <= cutoff]
            except Exception:
                sliced = df[df.index <= cutoff]
            if len(sliced) < 30:
                dropped += 1
                continue
            truncated[sym] = sliced
        history = truncated
        print(f"[scanner] asof-truncated ≤ {asof_ts.date()}: {len(history)} symbols, dropped {dropped}", file=sys.stderr)

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
        # ── Pivot points (observability, no behavior change) ──
        # Compute classical pivots from the symbol's LATEST daily bar — for
        # live scanning at 8:30 AM, that's yesterday's close; for --asof
        # replay, that's the asof-day's close. Either way these pivots are
        # valid for the next trading session (= the day we'll trade).
        try:
            last_bar = history[sym].iloc[-1]
            pivots = classical_pivots(
                prev_high=float(last_bar["High"]),
                prev_low=float(last_bar["Low"]),
                prev_close=float(last_bar["Close"]),
            )
            if pivots:
                s.scan_meta = dict(s.scan_meta or {})
                s.scan_meta["pivots"] = pivots
        except Exception:
            pass  # pivots are informational only — don't fail the score
        scores.append(s)

    print(f"[scanner] scored {len(scores)} symbols, skipped {skipped_no_data} no-data", file=sys.stderr)
    if skipped_with_error:
        from collections import Counter
        ec = Counter(e for _, e in skipped_with_error)
        print(f"[scanner] {len(skipped_with_error)} symbols hit a gate / error:", file=sys.stderr)
        for reason, count in ec.most_common(5):
            print(f"[scanner]   {count:>4}x — {reason[:120]}", file=sys.stderr)

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
                "scanner": "logdhan-intraday-v3",
                "mode": args.mode,
                "picks": winners,
            })
        else:
            print(f"[webhook] no symbols >= {args.min_score}, not firing")


if __name__ == "__main__":
    main()
