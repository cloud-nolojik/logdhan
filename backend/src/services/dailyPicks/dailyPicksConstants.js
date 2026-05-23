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
/** Tiered min R:R by regime — demand better R:R when conviction is lower
 *  EXTREME regimes match STRONG (1.5x) — directional conviction is high,
 *  and the ORB-based stop already limits risk to the opening range.
 *  Exhaustion risk is handled by the exhaustion detection gate, not here. */
export const MIN_ORB_RR_BY_REGIME = {
  EXTREME_BULL: 1.5,
  STRONG_BULL: 1.5,
  WEAK_BULL: 1.8,
  NEUTRAL: 2.0,
  WEAK_BEAR: 1.8,
  STRONG_BEAR: 1.5,
  EXTREME_BEAR: 1.5,
};
/**
 * ORB range width gate — ATR-normalized (Check 5 in orbValidationService).
 *
 * Replaces the old flat MAX_ORB_RANGE_PCT = 3.0% threshold, which was
 * volatility-blind: a 3% ORB on a 1%-ATR stock (3× ATR) is genuinely too
 * wide; a 3% ORB on a 3%-ATR stock (1× ATR) is completely normal.
 *
 * The denominator uses gap-adjusted effective ATR:
 *   effectiveAtr = max(daily_atr_pct, abs(gap_pct))
 * This prevents rejecting legitimately wide opens on news-driven gap days
 * where the daily ATR hasn't caught up to the new price range yet.
 *
 * Expert calibration (April 2026):
 *   ≤ 1.0× ATR  — normal open, proceed
 *   1.0–1.25×   — active open, still tradeable
 *   > 1.25×     — stop distance too large relative to stock's own range → reject
 *
 * The absolute 5% backstop prevents edge-case acceptance on very high-ATR
 * low-priced midcaps where position sizing shrinks to near-trivial quantity.
 */
export const MAX_ORB_ATR_RATIO = 1.25;         // reject if ORB range > 1.25× effective ATR (normal VIX baseline)
export const MAX_ORB_RANGE_PCT_ABSOLUTE = 5.0; // absolute backstop regardless of ATR

// ── VIX-aware scaling of MAX_ORB_ATR_RATIO ─────────────────────────────────
// Problem (May 2026 audit): on high-VIX panic days the ORB range routinely
// exceeds 1.25× the (already inflated) effective ATR, so Check 5 rejects
// almost every candidate. The system effectively sits out the days where
// intraday breakout edge is highest. Solution: scale the ratio threshold by
// India VIX so high-vol environments use a looser gate. Position sizing
// (computePositionSize) already shrinks qty via inverse-ATR, so the
// risk-per-trade impact of the looser gate is bounded.
//
// Calibration: 1.25× baseline keeps current behavior in normal markets;
// 1.5× covers post-event days (election, budget) without exploding stops;
// 2.0× covers true panic regimes (India VIX > 25) where any opening range
// looks "wide" relative to ATR. Above 2.0× we'd be trading random noise.
// ───────────────────────────────────────────────────────────────────────────
export const VIX_NORMAL_MAX_THRESHOLD    = 16;   // ≤ this: use 1.25× baseline
export const VIX_ELEVATED_MAX_THRESHOLD  = 22;   // ≤ this: use 1.50×
export const VIX_EXTREME_SIT_OUT_THRESHOLD = 35; // > this: SIT OUT entirely (once-a-decade vol)
export const MAX_ORB_ATR_RATIO_NORMAL    = 1.25;
export const MAX_ORB_ATR_RATIO_ELEVATED  = 1.50;
export const MAX_ORB_ATR_RATIO_PANIC     = 2.00;

/**
 * Resolve the VIX-adjusted MAX_ORB_ATR_RATIO for the day. Pass the day's
 * India VIX close (or current value if available pre-open). If VIX is
 * missing/0, defaults to the normal baseline.
 *
 * Returns one of:
 *   number — the ratio to use
 *   'SIT_OUT' — VIX is above VIX_EXTREME_SIT_OUT_THRESHOLD (catastrophic).
 *               Caller should not trade at all today.
 */
export function resolveOrbAtrRatioForVix(indiaVix) {
  if (!indiaVix || indiaVix <= 0) return MAX_ORB_ATR_RATIO_NORMAL;
  if (indiaVix <= VIX_NORMAL_MAX_THRESHOLD)   return MAX_ORB_ATR_RATIO_NORMAL;
  if (indiaVix <= VIX_ELEVATED_MAX_THRESHOLD) return MAX_ORB_ATR_RATIO_ELEVATED;
  if (indiaVix <= VIX_EXTREME_SIT_OUT_THRESHOLD) return MAX_ORB_ATR_RATIO_PANIC;
  return 'SIT_OUT';   // VIX > 35 — historical 99th percentile, system should not trade
}

// ── Absolute risk floor (per-trade) ─────────────────────────────────────────
// Problem (May 2026 audit): on low-VIX days the planned stop sits 0.3–0.5%
// from entry, which is within typical SL-M slippage + Indian retail fees
// (~0.3% round-trip). Trades have near-zero net edge regardless of hit rate.
// Solution: require risk_pct ≥ MIN_RISK_PCT_PER_TRADE at the ORB check.
// Below that, the trade is rejected with reason "risk_too_small". The R:R
// gate remains separate and still applies.
// ───────────────────────────────────────────────────────────────────────────
export const MIN_RISK_PCT_PER_TRADE = 0.5;   // entry-relative %, e.g. 0.5%
/** >0.3% opposing NIFTY move blocks trade */
export const NIFTY_THRESHOLD_PCT = 0.3;
/** Gap direction threshold — gap opposing scan bias beyond this % fails Check 2 */
export const GAP_DIRECTION_THRESHOLD_PCT = 2.0;
/** Maximum pass number at which gap-fade entries can trigger */
export const GAP_FADE_MAX_PASS = 3;
/** Check 1: Max gap size for ADVERSE gaps (gap opposes trade direction) */
export const GAP_SIZE_ADVERSE_MAX_PCT = 1.5;
/** Check 1: Max gap size for ALIGNED gaps (gap supports trade direction — Crabel continuation) */
export const GAP_SIZE_ALIGNED_MAX_PCT = 3.0;

// ═══════════════════════════════════════════════════════════════════════════════
// SLIPPAGE
// ═══════════════════════════════════════════════════════════════════════════════

/** 0.15% buffer beyond entry to account for SL-M market fill slippage */
export const SLIPPAGE_BUFFER_PCT = 0.0015;

// ═══════════════════════════════════════════════════════════════════════════════
// PARTIAL PROFIT BOOKING
// ═══════════════════════════════════════════════════════════════════════════════

/** Book partial when price reaches 75% of target distance — i.e. 1.5R of a
 * 2R target. Tightened from 0.60 → 0.75 as part of Phase 3 tuning. The 1.5R
 * partial mark is the textbook intraday level: captures ~half the total
 * planned move (minus slippage) and leaves half the position to ride to 2R. */
export const PARTIAL_BOOK_PCT = 0.75;
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
// STRUCTURAL EXIT CUSHION (15-min candle_structure_exit override)
//
// Problem this addresses (May 2026 audit):
//   In 17 days of live trading, ZERO trades reached planned TARGET_HIT — every
//   exit was via stop_hit, time_exit, or analyzeIntradayStructure's 15-min
//   structural break. The structure break is too sensitive: a single 15-min
//   candle closing below the prior 15-min low fires an immediate market exit
//   regardless of whether the trade is up, flat, or down.
//
// On a planned 2R trade this means the structural exit consistently fires
// before the target is reached, capping realized_rr around 0.8–1.0 vs
// planned_rr ≈ 1.5–2.0.
//
// Fix: require a minimum unrealized profit cushion (in R-multiples) before
// the structural exit is allowed to override the planned target. Below the
// cushion the planned stop continues to apply normally; once the trade is
// in profit by at least this much, the structural break becomes a "lock in
// the win" rule rather than a "kill the marginal winner" rule.
//
// Conservative default: 0.5R. Tune higher to be more patient, lower to be
// more reactive. Set to 0 to disable the cushion (legacy behavior).
// ═══════════════════════════════════════════════════════════════════════════════

/** Minimum unrealized R multiple before 15-min structural break can trigger exit */
export const STRUCTURE_EXIT_MIN_R_CUSHION = 0.5;

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
// REGIME-AWARE SCANNERS (May 2026)
//
// Per-regime stock-selection strategies are owned by scanner.py (one --mode
// per regime). The Node side just routes regime → mode in
// dailyPicksService.selectScannerModeForRegime. There used to be JS-side
// constants here (STRONG_BULL_MIN_SCORE, RSI gates, lookback windows) that
// were added in anticipation of a JS scanner implementation. That work
// stayed in Python instead, so those constants were never consumed and
// were removed. If a future task moves any scanner logic back to JS,
// re-add the relevant tuning constants here.
//
// Active routing (see dailyPicksService.REGIME_TO_SCANNER_MODE):
//   STRONG_BULL  → momentum_leader   (LONG)
//   WEAK_BULL    → recovery_breakout (LONG, unchanged from legacy)
//   NEUTRAL      → nr7_compression   (LONG default, scan_meta flags break direction)
//   WEAK_BEAR    → failed_bounce     (SHORT)
//   STRONG_BEAR  → breakdown         (SHORT)
//   EXTREME_BEAR → sit out
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// EXHAUSTION DETECTION — Triple-gate: all 3 conditions required to penalize
// ═══════════════════════════════════════════════════════════════════════════════

/** Score penalty for exhaustion candidates (25 pts — usually drops below MIN_SCORE) */
export const EXHAUSTION_PENALTY = 25;
/** Minimum consecutive same-direction days to trigger */
export const EXHAUSTION_CONSECUTIVE_DAYS = 5;
/**
 * G4 distance threshold — ATR-normalized (expert-calibrated April 2026).
 *
 * Using a flat 8% was inconsistent with G3's ATR-normalized 3.0× threshold:
 *   WIPRO (1.5% ATR):    flat 8% = 5.3 ATRs  (G3 fires first at 3.0×)
 *   JINDALSTEL (4% ATR): flat 8% = 2.0 ATRs  (G4 fires before G3 — wrong order)
 *
 * New approach: OR condition — either ATR-normalized OR absolute floor.
 * G4 should be slightly more permissive on extension than G3 (because duration
 * + RSI do additional work), sitting at 2.5× vs G3's 3.0×.
 * The 6% absolute floor catches genuinely extended low-ATR stocks (e.g. WIPRO
 * at 1.5% ATR where 2.5× = 3.75% — too permissive absolutely).
 */
export const EXHAUSTION_EMA20_DIST_ATR = 2.5;       // ATR-normalized trigger
export const EXHAUSTION_EMA20_DIST_ABS_PCT = 6.0;   // absolute fallback floor

// ═══════════════════════════════════════════════════════════════════════════════
// G3 CHASE GUARD — ATR-normalized distance threshold
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reject if stock is more than this many ATRs beyond EMA20 in trade direction.
 * ATR-normalizing makes the threshold volatility-aware: a 3% move on a 1%-ATR
 * stock (3 ATRs extended) is treated the same as a 6% move on a 2%-ATR stock.
 * Raw % thresholds were too tight for high-ATR names and too loose for low-ATR
 * names. ~3 ATRs is empirically where NSE intraday edge flips negative (you're
 * providing exit liquidity to institutions that got in at 1–2 ATRs).
 */
export const CHASE_MAX_ATR_DIST = 3.0;

/**
 * Soft chase penalty — applied to rank_score at Step 4 (after enrichment).
 *
 * G3 is the hard gate (reject at 3 ATRs). This penalty pre-shapes rankings
 * in the 1.25–3.0× ATR band so that chasing stocks fall lower in selection
 * order even when they technically pass G3. A stock at 2.8 ATRs is not
 * rejected, but scores 15 points lower than an identical stock at 0.8 ATRs.
 *
 * Formula: penalty_points = CHASE_SOFT_PENALTY_MAX_PTS
 *                           × max(0, min(1, (atrDist - START) / (END - START)))
 * Linear, per direction (LONG: dist above EMA20; SHORT: dist below EMA20).
 */
export const CHASE_SOFT_PENALTY_START_ATR = 1.25;  // below this: no penalty
export const CHASE_SOFT_PENALTY_MAX_PTS   = 15;    // max rank_score deduction (on 0–100 scale)

// ═══════════════════════════════════════════════════════════════════════════════
// NR7 / INSIDE DAY SCORING BONUS
// ═══════════════════════════════════════════════════════════════════════════════

/** NR7/Inside Day bonus in non-NEUTRAL regimes */
export const NR7_BONUS = 8;
/** NR7/Inside Day bonus in NEUTRAL regime (higher — they're the best setups) */
export const NR7_NEUTRAL_BONUS = 12;

// ═══════════════════════════════════════════════════════════════════════════════
// VOLUME GATE (ORB Check 6) — Filters thin-volume news gaps
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// COUNTER-REGIME TRADES — Guardrails for RS LONGs in STRONG_BEAR
// ═══════════════════════════════════════════════════════════════════════════════

/** Maximum counter-regime picks per day (e.g., LONGs in STRONG_BEAR) */
export const MAX_COUNTER_REGIME_PICKS = 1;
/** Higher MIN_SCORE for counter-regime trades (vs 60 normal) */
export const COUNTER_REGIME_MIN_SCORE = 75;

// ═══════════════════════════════════════════════════════════════════════════════
// VOLUME GATE (ORB Check 6) — Filters thin-volume news gaps
// ═══════════════════════════════════════════════════════════════════════════════

/** Minimum ratio of actual 15m volume vs expected (avg_vol_50d / candles_per_day) */
export const MIN_ORB_VOLUME_RATIO = 0.8;
/** Trading candles per day (6.25 hrs / 15 min = 25) */
export const TRADING_CANDLES_PER_DAY = 25;
