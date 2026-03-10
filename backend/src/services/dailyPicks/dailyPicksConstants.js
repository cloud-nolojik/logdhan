/**
 * Daily Picks Trading Constants — SINGLE SOURCE OF TRUTH
 *
 * All trading parameters used by both the live pipeline (dailyPicksService.js)
 * and the backtest simulation (backtestUtils.js) are defined here.
 *
 * ⚠️  LIVE MONEY: Changing any value here affects BOTH real trades and backtests.
 *     Always run a backtest after changing constants to validate impact.
 *
 * Previously these were duplicated in backtestUtils.js SIM object and scattered
 * across dailyPicksService.js as inline constants. Now imported from one place.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// GAP PROTECTION
// ═══════════════════════════════════════════════════════════════════════════════

/** Cancel AMO entry if stock gaps >2% past entry trigger (prevents slippage disasters) */
export const GAP_PROTECTION_MAX_PCT = 2.0;

// ═══════════════════════════════════════════════════════════════════════════════
// ORB (Opening Range Breakout) — matches orbValidationService.js
// ═══════════════════════════════════════════════════════════════════════════════

/** 0.1% above ORB high (longs) / below ORB low (shorts) */
export const ORB_BUFFER_PCT = 0.001;
/** Tiered min R:R by regime — demand better R:R when conviction is lower */
export const MIN_ORB_RR_BY_REGIME = {
  STRONG_BULL: 1.5,
  STRONG_BEAR: 1.5,
  WEAK_BULL: 1.8,
  WEAK_BEAR: 1.8,
  NEUTRAL: 2.0,
};
/** ORB range > 3% of stock price = too volatile, skip */
export const MAX_ORB_RANGE_PCT = 3.0;
/** >0.3% opposing NIFTY move blocks trade */
export const NIFTY_THRESHOLD_PCT = 0.3;

// ═══════════════════════════════════════════════════════════════════════════════
// SLIPPAGE
// ═══════════════════════════════════════════════════════════════════════════════

/** 0.15% buffer beyond entry to account for SL-M market fill slippage */
export const SLIPPAGE_BUFFER_PCT = 0.0015;

// ═══════════════════════════════════════════════════════════════════════════════
// PARTIAL PROFIT BOOKING
// ═══════════════════════════════════════════════════════════════════════════════

/** Book partial when price reaches 60% of target distance */
export const PARTIAL_BOOK_PCT = 0.60;
/** Sell half the position at partial booking level */
export const PARTIAL_BOOK_QTY_RATIO = 0.50;

// ═══════════════════════════════════════════════════════════════════════════════
// TRAILING STOPS — Dynamic Chandelier-based trailing
//
// OLD approach: fixed 40% lock ratio from entry (too tight, gets whipsawed)
// NEW approach: Chandelier Exit — trail from HIGHEST HIGH using ATR multiplier
//   Phase 1 (0–2% profit): highestHigh - 2.5×ATR  (loose, let it breathe)
//   Phase 2 (2–4% profit): highestHigh - 2.0×ATR  (moderate, trend confirmed)
//   Phase 3 (4%+ profit):  highestHigh - 1.5×ATR  (tight, protect big gains)
//   After 2 PM:            multiplier reduced by 0.5 (time running out)
// ═══════════════════════════════════════════════════════════════════════════════

/** Start trailing after 1.0% profit */
export const TRAIL_MIN_PROFIT_PCT = 1.0;
/** LEGACY: Lock 40% of profit as new stop (kept as fallback when ATR unavailable) */
export const TRAIL_LOCK_RATIO = 0.40;
/** Start trailing 60 min after entry */
export const TRAIL_MIN_MINUTES = 60;
/** Earliest trailing hour (10 AM IST) */
export const TRAIL_START_HOUR = 10;

// ── Dynamic Chandelier Exit Parameters ──
/** Phase 1: 0–2% profit, ATR multiplier (loose) */
export const TRAIL_ATR_MULT_PHASE1 = 2.5;
/** Phase 2: 2–4% profit, ATR multiplier (moderate) */
export const TRAIL_ATR_MULT_PHASE2 = 2.0;
/** Phase 3: 4%+ profit, ATR multiplier (tight) */
export const TRAIL_ATR_MULT_PHASE3 = 1.5;
/** Profit % threshold for Phase 2 */
export const TRAIL_PHASE2_PCT = 2.0;
/** Profit % threshold for Phase 3 */
export const TRAIL_PHASE3_PCT = 4.0;
/** After 2 PM, reduce ATR multiplier by this amount (tighten for EOD) */
export const TRAIL_EOD_TIGHTEN = 0.5;
/** Number of recent candles to compute intraday ATR from (backtest) */
export const TRAIL_ATR_LOOKBACK = 14;

// ═══════════════════════════════════════════════════════════════════════════════
// SIDEWAYS EXIT
// ═══════════════════════════════════════════════════════════════════════════════

/** Exit after 2 hours of sideways movement */
export const SIDEWAYS_EXIT_MINUTES = 120;
/** Consider sideways if price within 0.3% of entry */
export const SIDEWAYS_THRESHOLD_PCT = 0.3;

// ═══════════════════════════════════════════════════════════════════════════════
// TIME-BASED EXITS
// ═══════════════════════════════════════════════════════════════════════════════

/** Tighten stops at 2 PM IST */
export const TIGHTEN_HOUR = 14;
/** Force exit at 3 PM IST */
export const EXIT_HOUR = 15;

// ═══════════════════════════════════════════════════════════════════════════════
// CAPITAL ALLOCATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Daily picks use 40% of total capital (intraday pool) */
export const INTRADAY_CAPITAL_PCT = 0.40;
/** Maximum daily picks */
export const MAX_PICKS = 3;

// ═══════════════════════════════════════════════════════════════════════════════
// ATR-BASED POSITION SIZING (inverse volatility weighting)
// ═══════════════════════════════════════════════════════════════════════════════

/** "Normal" volatility — stocks at 2% ATR get 1.0x multiplier */
export const BASELINE_ATR_PCT = 2.0;
/** Minimum multiplier (caps position for very volatile stocks) */
export const MIN_ATR_MULT = 0.4;
/** Maximum multiplier (caps bonus for low-vol stocks) */
export const MAX_ATR_MULT = 1.5;

// ═══════════════════════════════════════════════════════════════════════════════
// INTEL SCORE ADJUSTMENTS — How global intel modifies pick rank_scores
// ═══════════════════════════════════════════════════════════════════════════════

/** Penalty when trading_recommendation opposes pick direction (AVOID_SHORTS / AVOID_LONGS) */
export const INTEL_DIRECTION_PENALTY = -20;
/** Stock-specific news aligned + HIGH impact boost */
export const INTEL_STOCK_NEWS_ALIGNED_HIGH = 8;
/** Stock-specific news opposing + HIGH impact penalty */
export const INTEL_STOCK_NEWS_OPPOSING_HIGH = -12;
/** Stock-specific news aligned + lower impact boost */
export const INTEL_STOCK_NEWS_ALIGNED_LOW = 4;
/** Stock-specific news opposing + lower impact penalty */
export const INTEL_STOCK_NEWS_OPPOSING_LOW = -6;
/** Sector sentiment aligned with pick direction boost */
export const INTEL_SECTOR_ALIGNED = 5;
/** Sector sentiment opposing pick direction penalty */
export const INTEL_SECTOR_OPPOSING = -5;
