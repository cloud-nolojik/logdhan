/**
 * Regime Redesign v2 — Constants
 *
 * Every tunable number for the continuous regime score lives here.
 * Paired with engine/regimeScoring.js.
 *
 * ⚠️  LIVE MONEY: Changes here affect position sizing and max trades per day.
 *     Always re-run pipelineBacktest.js after changes.
 *
 * See docs/regime-redesign-v2.md for design rationale.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT NORMALIZATION BANDS
// Each input is mapped to [-1, +1] by dividing by its band.
// ═══════════════════════════════════════════════════════════════════════════════

/** ±3% distance from EMA50 maps to ±1 (wider than old 0.3% deadband) */
export const STRUCTURE_POSITION_BAND = 0.03;
/** ±2% distance from EMA20 maps to ±1 */
export const STRUCTURE_FAST_BAND = 0.02;
/** ±1% EMA50 slope over 5 trading days maps to ±1 */
export const STRUCTURE_SLOPE_BAND = 0.01;

/** Breadth: 50% above-50DMA = neutral */
export const BREADTH_CENTER_PCT = 50;
/** Breadth: ±25% from center = ±1 (i.e. 75% = +1, 25% = -1) */
export const BREADTH_BAND_PCT = 25;

/** Volatility: median percentile rank = neutral */
export const VOL_CENTER_PERCENTILE = 50;
/** Volatility: ±25 percentile = ±1 (25th = +1 calm, 75th = -1 stressed) */
export const VOL_BAND_PERCENTILE = 25;

/** Overnight equity indices: ±0.75% change maps to ±1 */
export const OVERNIGHT_EQUITY_BAND_PCT = 0.75;
/** Overnight DXY: ±0.50% change maps to ±1 (sign is inverted at compute time) */
export const OVERNIGHT_DXY_BAND_PCT = 0.50;

/** Prev-day FII net cash flow: ±3000 crore maps to ±1 */
export const FLOW_BAND_CRORES = 3000;

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOSITE WEIGHTS
// Directional weights sum to 0.85. Volatility contributes 0.15 as magnitude modifier.
// ═══════════════════════════════════════════════════════════════════════════════

export const WEIGHT_STRUCTURE = 0.30;
export const WEIGHT_BREADTH   = 0.25;
export const WEIGHT_OVERNIGHT = 0.15;
export const WEIGHT_FLOW      = 0.15;

/** Volatility magnitude modifier range: vol_factor ∈ [1 - 0.30, 1 + 0.30] */
export const VOL_MULTIPLIER_RANGE = 0.30;

// ═══════════════════════════════════════════════════════════════════════════════
// STRUCTURE SUB-WEIGHTS (inside the structure computation)
// ═══════════════════════════════════════════════════════════════════════════════

export const STRUCTURE_WEIGHT_POSITION = 0.40;
export const STRUCTURE_WEIGHT_FAST     = 0.35;
export const STRUCTURE_WEIGHT_SLOPE    = 0.25;

// ═══════════════════════════════════════════════════════════════════════════════
// OVERNIGHT SUB-WEIGHTS
// ═══════════════════════════════════════════════════════════════════════════════

export const OVERNIGHT_WEIGHT_GIFT = 0.50;
export const OVERNIGHT_WEIGHT_ASIA = 0.30;
export const OVERNIGHT_WEIGHT_DXY  = 0.20;

// ═══════════════════════════════════════════════════════════════════════════════
// LABEL THRESHOLDS (mapped from regime_score magnitude)
// ═══════════════════════════════════════════════════════════════════════════════

export const LABEL_STRONG_THRESHOLD = 0.60;
export const LABEL_WEAK_THRESHOLD   = 0.25;

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE SIZING MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

export const MAX_TRADES_STRONG = 3;
export const MAX_TRADES_WEAK   = 2;
export const MAX_TRADES_MIN    = 1;
/** Below this absolute score, no trades */
export const MIN_ABS_SCORE_TO_TRADE = 0.10;
/** size_multiplier = clamp(abs_score * SIZE_SLOPE, 0, 1) */
export const SIZE_SLOPE = 1.2;

// ═══════════════════════════════════════════════════════════════════════════════
// HARD HALT RULES
// ═══════════════════════════════════════════════════════════════════════════════

/** VIX percentile above this = extreme volatility day, halt */
export const HALT_VIX_PERCENTILE = 90;

// ═══════════════════════════════════════════════════════════════════════════════
// GAP-FADE PLAYBOOK
// Triggered when structure and overnight disagree strongly (replaces old CONFLICT halt).
// ═══════════════════════════════════════════════════════════════════════════════

/** Both |structure| and |overnight| must exceed this for gap-fade to activate */
export const GAP_FADE_STRUCTURE_THRESHOLD = 0.30;
export const GAP_FADE_OVERNIGHT_THRESHOLD = 0.30;

/**
 * Max trades when playbook is gap_fade.
 * V1 ROLLOUT SAFETY: Set to 0 to preserve old CONFLICT-halt behavior.
 * Once you've validated gap-fade performance with 1 quarter of shadow data,
 * bump to 1.
 */
export const GAP_FADE_MAX_TRADES = 0;
export const GAP_FADE_SIZE_MULT  = 0.40;
export const GAP_FADE_MIN_SCORE  = 75;

// ═══════════════════════════════════════════════════════════════════════════════
// BREADTH COMPUTATION
// ═══════════════════════════════════════════════════════════════════════════════

/** 50-DMA window for per-stock breadth check */
export const BREADTH_DMA_WINDOW = 50;
/** Reference universe size. Fallback used if primary coverage < 90% */
export const BREADTH_UNIVERSE_PRIMARY = 'NIFTY500';
export const BREADTH_UNIVERSE_FALLBACK = 'NIFTY200';

// ═══════════════════════════════════════════════════════════════════════════════
// VIX PERCENTILE WINDOW
// ═══════════════════════════════════════════════════════════════════════════════

/** Trailing days for VIX percentile rank computation (252 = 1 year) */
export const VIX_PERCENTILE_WINDOW_DAYS = 252;

// ═══════════════════════════════════════════════════════════════════════════════
// FLOW INTERPRETATION
// ═══════════════════════════════════════════════════════════════════════════════

/** When DII contradicts FII, dampen flow signal by this factor */
export const FLOW_DII_DISAGREEMENT_FACTOR = 0.5;
