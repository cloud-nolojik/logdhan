# Regime Redesign v2 — Reference Implementation

**Purpose:** Companion to `regime-redesign-v2.md`. Every file below is ready to copy into the target path. No placeholders, no `TODO` markers — if you see either, I missed something.

**How to use this doc:**

1. Create each file at its stated path.
2. Run the three backfill scripts (one-time).
3. Register the three nightly jobs with your job scheduler.
4. Apply the Step 1 and Step 4 diffs in `dailyPicksService.js`.
5. Set env var `REGIME_VERSION=v2` to turn the new system on. Default remains `v1` for safety.

Every path below is relative to `backend/src/`.

---

## File 1 — `constants/regimeConstants.js`

**Path:** `backend/src/constants/regimeConstants.js`

```js
/**
 * Regime Redesign v2 — Constants
 *
 * Every tunable number for the continuous regime score lives here.
 * Paired with engine/regimeScoring.js.
 *
 * ⚠️  LIVE MONEY: Changes here affect position sizing and max trades per day.
 *     Always re-run pipelineBacktest.js with REGIME_VERSION=v2 after changes.
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
// LABEL THRESHOLDS
// Mapped from regime_score magnitude.
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
/** Reference universe size: Nifty 500. Fallback: Nifty 200 */
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
```

---

## File 2 — `engine/regimeScoring.js`

**Path:** `backend/src/engine/regimeScoring.js`

```js
/**
 * Regime Scoring Engine — v2
 *
 * Continuous regime score ∈ [-1, +1] from five inputs:
 *   structure, breadth, volatility, overnight, flow
 *
 * Output shape preserves backward compat with Step 2+ of dailyPicksService.js:
 *   { regime, max_trades, size_multiplier, ... }
 *
 * New fields added (safe to ignore downstream):
 *   regime_score, playbook, score_floor_override, inputs
 *
 * See docs/regime-redesign-v2.md for design rationale.
 */

import {
  STRUCTURE_POSITION_BAND, STRUCTURE_FAST_BAND, STRUCTURE_SLOPE_BAND,
  STRUCTURE_WEIGHT_POSITION, STRUCTURE_WEIGHT_FAST, STRUCTURE_WEIGHT_SLOPE,
  BREADTH_CENTER_PCT, BREADTH_BAND_PCT,
  VOL_CENTER_PERCENTILE, VOL_BAND_PERCENTILE,
  OVERNIGHT_EQUITY_BAND_PCT, OVERNIGHT_DXY_BAND_PCT,
  OVERNIGHT_WEIGHT_GIFT, OVERNIGHT_WEIGHT_ASIA, OVERNIGHT_WEIGHT_DXY,
  FLOW_BAND_CRORES, FLOW_DII_DISAGREEMENT_FACTOR,
  WEIGHT_STRUCTURE, WEIGHT_BREADTH, WEIGHT_OVERNIGHT, WEIGHT_FLOW,
  VOL_MULTIPLIER_RANGE,
  LABEL_STRONG_THRESHOLD, LABEL_WEAK_THRESHOLD,
  MAX_TRADES_STRONG, MAX_TRADES_WEAK, MAX_TRADES_MIN, MIN_ABS_SCORE_TO_TRADE,
  SIZE_SLOPE,
  HALT_VIX_PERCENTILE,
  GAP_FADE_STRUCTURE_THRESHOLD, GAP_FADE_OVERNIGHT_THRESHOLD,
  GAP_FADE_MAX_TRADES, GAP_FADE_SIZE_MULT, GAP_FADE_MIN_SCORE,
} from '../constants/regimeConstants.js';

// ─── Small utilities ─────────────────────────────────────────────────────────

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function round3(x) { return Math.round(x * 1000) / 1000; }
function sign(x) { return x > 0 ? 1 : (x < 0 ? -1 : 0); }
function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

// ═══════════════════════════════════════════════════════════════════════════════
// INPUT COMPUTATION (each returns value ∈ [-1, +1], or null if data missing)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} nifty { close, ema20, ema50, ema50_prev5 }
 * @returns {number|null}
 */
export function computeStructure(nifty) {
  if (!nifty || !isNum(nifty.close) || !isNum(nifty.ema50) || !isNum(nifty.ema20) || !isNum(nifty.ema50_prev5)) {
    return null;
  }
  const position = clamp((nifty.close - nifty.ema50) / nifty.ema50 / STRUCTURE_POSITION_BAND, -1, 1);
  const fast     = clamp((nifty.close - nifty.ema20) / nifty.ema20 / STRUCTURE_FAST_BAND, -1, 1);
  const slope    = clamp((nifty.ema50 - nifty.ema50_prev5) / nifty.ema50_prev5 / STRUCTURE_SLOPE_BAND, -1, 1);
  const raw = STRUCTURE_WEIGHT_POSITION * position
            + STRUCTURE_WEIGHT_FAST * fast
            + STRUCTURE_WEIGHT_SLOPE * slope;
  return clamp(raw, -1, 1);
}

/**
 * @param {number|null} pctAbove50DMA - % of reference universe trading above 50-DMA (0..100)
 * @returns {number|null}
 */
export function computeBreadth(pctAbove50DMA) {
  if (!isNum(pctAbove50DMA)) return null;
  return clamp((pctAbove50DMA - BREADTH_CENTER_PCT) / BREADTH_BAND_PCT, -1, 1);
}

/**
 * @param {number|null} vixPercentileRank - 0..100
 * @returns {number|null}
 */
export function computeVolatility(vixPercentileRank) {
  if (!isNum(vixPercentileRank)) return null;
  return clamp((VOL_CENTER_PERCENTILE - vixPercentileRank) / VOL_BAND_PERCENTILE, -1, 1);
}

/**
 * @param {Object} o { giftPct, asiaCompositePct, dxyPct }
 * @returns {number|null}
 */
export function computeOvernight(o = {}) {
  const g = isNum(o.giftPct) ? clamp(o.giftPct / OVERNIGHT_EQUITY_BAND_PCT, -1, 1) : null;
  const a = isNum(o.asiaCompositePct) ? clamp(o.asiaCompositePct / OVERNIGHT_EQUITY_BAND_PCT, -1, 1) : null;
  const d = isNum(o.dxyPct) ? clamp(-o.dxyPct / OVERNIGHT_DXY_BAND_PCT, -1, 1) : null;
  if (g === null && a === null && d === null) return null;

  // Null-safe weighted average over whichever sub-inputs are available.
  let sumVal = 0, sumWt = 0;
  if (g !== null) { sumVal += OVERNIGHT_WEIGHT_GIFT * g; sumWt += OVERNIGHT_WEIGHT_GIFT; }
  if (a !== null) { sumVal += OVERNIGHT_WEIGHT_ASIA * a; sumWt += OVERNIGHT_WEIGHT_ASIA; }
  if (d !== null) { sumVal += OVERNIGHT_WEIGHT_DXY  * d; sumWt += OVERNIGHT_WEIGHT_DXY;  }
  return clamp(sumVal / sumWt, -1, 1);
}

/**
 * @param {Object} f { fiiCr, diiCr } - previous day net values in crores
 * @returns {number|null}
 */
export function computeFlow(f = {}) {
  if (!isNum(f.fiiCr)) return null;
  const fii = clamp(f.fiiCr / FLOW_BAND_CRORES, -1, 1);
  if (isNum(f.diiCr) && sign(f.diiCr) !== sign(f.fiiCr) && f.diiCr !== 0 && f.fiiCr !== 0) {
    return fii * FLOW_DII_DISAGREEMENT_FACTOR;
  }
  return fii;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOSITE SCORE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param {Object} inputs { structure, breadth, volatility, overnight, flow }
 * @returns {{ score: number|null, reason: string|null }}
 */
export function computeRegimeScore(inputs) {
  const directional = [
    { val: inputs.structure, w: WEIGHT_STRUCTURE },
    { val: inputs.breadth,   w: WEIGHT_BREADTH   },
    { val: inputs.overnight, w: WEIGHT_OVERNIGHT },
    { val: inputs.flow,      w: WEIGHT_FLOW      },
  ];

  let sumVal = 0, sumWt = 0;
  for (const { val, w } of directional) {
    if (isNum(val)) { sumVal += val * w; sumWt += w; }
  }
  if (sumWt === 0) return { score: null, reason: 'no_directional_data' };

  const directionalScore = sumVal / sumWt;

  const volFactor = isNum(inputs.volatility)
    ? 1.0 + VOL_MULTIPLIER_RANGE * inputs.volatility
    : 1.0;

  return { score: clamp(directionalScore * volFactor, -1, 1), reason: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORE → LABEL → SIZING → PLAYBOOK
// ═══════════════════════════════════════════════════════════════════════════════

export function scoreToLabel(score) {
  if (score >= LABEL_STRONG_THRESHOLD) return 'STRONG_BULL';
  if (score >= LABEL_WEAK_THRESHOLD)   return 'WEAK_BULL';
  if (score > -LABEL_WEAK_THRESHOLD)   return 'NEUTRAL';
  if (score > -LABEL_STRONG_THRESHOLD) return 'WEAK_BEAR';
  return 'STRONG_BEAR';
}

export function scoreToSizing(score) {
  const abs = Math.abs(score);
  let maxTrades;
  if (abs >= LABEL_STRONG_THRESHOLD)       maxTrades = MAX_TRADES_STRONG;
  else if (abs >= LABEL_WEAK_THRESHOLD)    maxTrades = MAX_TRADES_WEAK;
  else if (abs >= MIN_ABS_SCORE_TO_TRADE)  maxTrades = MAX_TRADES_MIN;
  else                                     maxTrades = 0;
  const sizeMultiplier = clamp(abs * SIZE_SLOPE, 0, 1);
  return { maxTrades, sizeMultiplier };
}

/**
 * Decides which playbook the pipeline runs today.
 * @returns {'standard' | 'gap_fade' | 'halt'}
 */
export function decidePlaybook({ structure, overnight, vixPctRank, haltReason }) {
  if (haltReason) return 'halt';
  if (isNum(vixPctRank) && vixPctRank > HALT_VIX_PERCENTILE) return 'halt';
  if (
    isNum(structure) && isNum(overnight)
    && sign(structure) !== sign(overnight)
    && Math.abs(structure) > GAP_FADE_STRUCTURE_THRESHOLD
    && Math.abs(overnight) > GAP_FADE_OVERNIGHT_THRESHOLD
  ) {
    return 'gap_fade';
  }
  return 'standard';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOP-LEVEL ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the full marketContext for v2 regime. Shape is a superset of v1 —
 * downstream code that only reads { regime, max_trades, size_multiplier } continues to work.
 *
 * @param {Object} data { niftyStructure, breadthPct, vixData, overnightData, flowData }
 *   All fields are nullable — this function handles missing data explicitly.
 * @returns {Object} marketContext
 */
export function buildMarketContext(data) {
  const { niftyStructure, breadthPct, vixData, overnightData, flowData } = data;

  const inputs = {
    structure:  computeStructure(niftyStructure),
    breadth:    computeBreadth(breadthPct),
    volatility: computeVolatility(vixData?.percentileRank),
    overnight:  computeOvernight(overnightData),
    flow:       computeFlow(flowData),
  };

  const { score, reason } = computeRegimeScore(inputs);

  // Hard halt: no directional inputs usable.
  if (score === null) {
    return {
      regime: 'HALT',
      regime_score: null,
      playbook: 'halt',
      halt_reason: reason,
      max_trades: 0,
      size_multiplier: 0,
      score_floor_override: null,
      inputs,
      decided_at: new Date().toISOString(),
    };
  }

  const playbook = decidePlaybook({
    structure: inputs.structure,
    overnight: inputs.overnight,
    vixPctRank: vixData?.percentileRank,
    haltReason: null,
  });

  const label = scoreToLabel(score);
  const { maxTrades, sizeMultiplier } = scoreToSizing(score);

  let finalMaxTrades = maxTrades;
  let finalSizeMult  = sizeMultiplier;
  let scoreFloorOverride = null;

  if (playbook === 'gap_fade') {
    finalMaxTrades    = Math.min(maxTrades, GAP_FADE_MAX_TRADES);
    finalSizeMult     = Math.min(sizeMultiplier, GAP_FADE_SIZE_MULT);
    scoreFloorOverride = GAP_FADE_MIN_SCORE;
  }
  if (playbook === 'halt') {
    finalMaxTrades = 0;
    finalSizeMult  = 0;
  }

  const ctx = {
    regime: label,
    regime_score: round3(score),
    playbook,
    max_trades: finalMaxTrades,
    size_multiplier: round3(finalSizeMult),
    score_floor_override: scoreFloorOverride,
    inputs: {
      structure:  isNum(inputs.structure)  ? round3(inputs.structure)  : null,
      breadth:    isNum(inputs.breadth)    ? round3(inputs.breadth)    : null,
      volatility: isNum(inputs.volatility) ? round3(inputs.volatility) : null,
      overnight:  isNum(inputs.overnight)  ? round3(inputs.overnight)  : null,
      flow:       isNum(inputs.flow)       ? round3(inputs.flow)       : null,
    },
    raw_data: {
      nifty_close: niftyStructure?.close ?? null,
      ema20: niftyStructure?.ema20 ?? null,
      ema50: niftyStructure?.ema50 ?? null,
      breadth_pct: breadthPct ?? null,
      vix_close: vixData?.close ?? null,
      vix_percentile: vixData?.percentileRank ?? null,
      gift_pct: overnightData?.giftPct ?? null,
      asia_pct: overnightData?.asiaCompositePct ?? null,
      dxy_pct: overnightData?.dxyPct ?? null,
      fii_cr: flowData?.fiiCr ?? null,
      dii_cr: flowData?.diiCr ?? null,
    },
    decided_at: new Date().toISOString(),
  };

  console.log(`[REGIME V2] ═══════════════════════════════════════`);
  console.log(`[REGIME V2] Score=${ctx.regime_score} Label=${ctx.regime} Playbook=${ctx.playbook}`);
  console.log(`[REGIME V2] Inputs: s=${ctx.inputs.structure} b=${ctx.inputs.breadth} v=${ctx.inputs.volatility} o=${ctx.inputs.overnight} f=${ctx.inputs.flow}`);
  console.log(`[REGIME V2] max_trades=${ctx.max_trades} size_mult=${ctx.size_multiplier}`);
  console.log(`[REGIME V2] ═══════════════════════════════════════`);

  return ctx;
}

export default {
  computeStructure,
  computeBreadth,
  computeVolatility,
  computeOvernight,
  computeFlow,
  computeRegimeScore,
  scoreToLabel,
  scoreToSizing,
  decidePlaybook,
  buildMarketContext,
};
```

---

## File 3 — `engine/regimeDataFetchers.js`

**Path:** `backend/src/engine/regimeDataFetchers.js`

This module is the IO boundary. It reads from existing services + the three new Mongo collections and returns clean inputs for `buildMarketContext`.

```js
/**
 * Regime Data Fetchers — v2
 *
 * Pulls the five input data bundles for buildMarketContext:
 *   - niftyStructure    (from existing technicalData.service)
 *   - breadthPct        (from breadth_daily collection, populated by nightly job)
 *   - vixData           (from india_vix_daily collection + rolling percentile calc)
 *   - overnightData     (scraped live at 8:40 AM — reuses existing SGX scraper)
 *   - flowData          (from institutional_flow_daily collection)
 *
 * Every function is fail-soft: returns null on failure. buildMarketContext
 * handles null inputs via null-safe weighted sum.
 */

import BreadthDaily from '../models/breadthDaily.js';
import IndiaVixDaily from '../models/indiaVixDaily.js';
import InstitutionalFlowDaily from '../models/institutionalFlowDaily.js';
import { VIX_PERCENTILE_WINDOW_DAYS } from '../constants/regimeConstants.js';

const NIFTY_50_INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';

// ─── Nifty structure ─────────────────────────────────────────────────────────

/**
 * Returns { close, ema20, ema50, ema50_prev5 } or null.
 * Leverages existing technicalData.service for candle data.
 */
export async function fetchNiftyStructure() {
  try {
    const { getCandleData } = await import('../services/technicalData.service.js');
    const candles = await getCandleData(NIFTY_50_INSTRUMENT_KEY, 'NIFTY50', '1d', { allowOutdated: false });
    if (!candles || candles.length < 55) return null;

    const closes = candles.map(c => Array.isArray(c) ? c[4] : c.close);
    const close = closes[closes.length - 1];
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    // ema50 5 trading days ago = ema over closes with last 5 dropped
    const ema50_prev5 = ema(closes.slice(0, -5), 50);

    if (![close, ema20, ema50, ema50_prev5].every(x => typeof x === 'number' && Number.isFinite(x))) {
      return null;
    }
    return { close, ema20, ema50, ema50_prev5 };
  } catch (err) {
    console.error('[REGIME V2] fetchNiftyStructure failed:', err.message);
    return null;
  }
}

function ema(data, period) {
  if (!data || data.length < period) return null;
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}

// ─── Breadth ─────────────────────────────────────────────────────────────────

/**
 * Returns % of Nifty 500 constituents trading above their own 50-DMA, or null.
 * Reads the most recent row from breadth_daily (populated nightly).
 */
export async function fetchBreadthPct() {
  try {
    const latest = await BreadthDaily.findOne().sort({ date: -1 }).lean();
    if (!latest || typeof latest.pct_above_50dma !== 'number') return null;
    return latest.pct_above_50dma;
  } catch (err) {
    console.error('[REGIME V2] fetchBreadthPct failed:', err.message);
    return null;
  }
}

// ─── VIX ─────────────────────────────────────────────────────────────────────

/**
 * Returns { close, percentileRank } or null.
 * Percentile is computed over the trailing VIX_PERCENTILE_WINDOW_DAYS.
 */
export async function fetchVixData() {
  try {
    const rows = await IndiaVixDaily
      .find()
      .sort({ date: -1 })
      .limit(VIX_PERCENTILE_WINDOW_DAYS + 1)
      .lean();
    if (!rows || rows.length === 0) return null;
    const latest = rows[0];
    if (typeof latest.close !== 'number') return null;

    const closes = rows.map(r => r.close).filter(x => typeof x === 'number');
    if (closes.length < 30) {
      // Not enough history; return close without percentile.
      return { close: latest.close, percentileRank: null };
    }

    // Percentile rank of latest within closes.
    const sorted = [...closes].sort((a, b) => a - b);
    const idx = sorted.findIndex(x => x >= latest.close);
    const pct = idx < 0 ? 100 : Math.round((idx / sorted.length) * 100);
    return { close: latest.close, percentileRank: pct };
  } catch (err) {
    console.error('[REGIME V2] fetchVixData failed:', err.message);
    return null;
  }
}

// ─── Overnight (GIFT + Asia + DXY) ───────────────────────────────────────────

/**
 * Returns { giftPct, asiaCompositePct, dxyPct } — every field nullable.
 * GIFT Nifty reuses your existing scraper. Asia & DXY fetched here.
 */
export async function fetchOvernightData() {
  const out = { giftPct: null, asiaCompositePct: null, dxyPct: null };

  // GIFT Nifty — reuse existing scraper
  try {
    const { scrapeGiftNifty } = await import('../services/dailyPicks/upstoxNewsScraper.js');
    // NOTE: if your existing scraper is named differently, swap the import.
    //       The expected shape is { changePct: number }.
    if (typeof scrapeGiftNifty === 'function') {
      const g = await scrapeGiftNifty();
      if (g && typeof g.changePct === 'number') out.giftPct = g.changePct;
    }
  } catch (err) {
    console.warn('[REGIME V2] GIFT Nifty fetch failed:', err.message);
  }

  // Asia composite = average of Nikkei 225 + Hang Seng change %
  try {
    const [nikkei, hangseng] = await Promise.all([
      fetchYahooQuoteChangePct('^N225'),
      fetchYahooQuoteChangePct('^HSI'),
    ]);
    const parts = [nikkei, hangseng].filter(x => typeof x === 'number');
    if (parts.length > 0) out.asiaCompositePct = parts.reduce((a, b) => a + b, 0) / parts.length;
  } catch (err) {
    console.warn('[REGIME V2] Asia composite fetch failed:', err.message);
  }

  // DXY
  try {
    const dxy = await fetchYahooQuoteChangePct('DX-Y.NYB');
    if (typeof dxy === 'number') out.dxyPct = dxy;
  } catch (err) {
    console.warn('[REGIME V2] DXY fetch failed:', err.message);
  }

  return out;
}

async function fetchYahooQuoteChangePct(symbol) {
  // Yahoo's free quote endpoint. If Yahoo flakiness becomes a problem,
  // swap to Upstox index instruments or a paid vendor.
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const q = json?.quoteResponse?.result?.[0];
  const pct = q?.regularMarketChangePercent;
  if (typeof pct !== 'number') throw new Error('Yahoo: missing changePercent');
  return pct;
}

// ─── Flow (prev-day FII/DII) ─────────────────────────────────────────────────

/**
 * Returns { fiiCr, diiCr } or null. Reads the most recent row (one-day-lag acceptable).
 */
export async function fetchPrevDayFlow() {
  try {
    const latest = await InstitutionalFlowDaily.findOne().sort({ date: -1 }).lean();
    if (!latest) return null;
    return {
      fiiCr: typeof latest.fii_net_cr === 'number' ? latest.fii_net_cr : null,
      diiCr: typeof latest.dii_net_cr === 'number' ? latest.dii_net_cr : null,
    };
  } catch (err) {
    console.error('[REGIME V2] fetchPrevDayFlow failed:', err.message);
    return null;
  }
}

// ─── Top-level orchestrator: fetch everything in parallel ────────────────────

export async function fetchAllRegimeInputs() {
  const [niftyStructure, breadthPct, vixData, overnightData, flowData] = await Promise.all([
    fetchNiftyStructure(),
    fetchBreadthPct(),
    fetchVixData(),
    fetchOvernightData(),
    fetchPrevDayFlow(),
  ]);
  return { niftyStructure, breadthPct, vixData, overnightData, flowData };
}

export default {
  fetchNiftyStructure,
  fetchBreadthPct,
  fetchVixData,
  fetchOvernightData,
  fetchPrevDayFlow,
  fetchAllRegimeInputs,
};
```

> **Integration note on GIFT Nifty scraper:** I kept `scrapeGiftNifty` as the import. Your current file is `upstoxNewsScraper.js` — if the actual export name differs, swap the import line. The rest of the module is agnostic.

---

## File 4 — `engine/regimeV2.js` (top-level entry)

**Path:** `backend/src/engine/regimeV2.js`

Thin wrapper so `dailyPicksService.js` has a single import to call.

```js
/**
 * Regime v2 entry point — wraps data fetchers + scoring into one call.
 */

import { fetchAllRegimeInputs } from './regimeDataFetchers.js';
import { buildMarketContext } from './regimeScoring.js';

export async function computeMarketContextV2() {
  const data = await fetchAllRegimeInputs();
  return buildMarketContext(data);
}

export default { computeMarketContextV2 };
```

---

## File 5 — `models/breadthDaily.js`

**Path:** `backend/src/models/breadthDaily.js`

```js
import mongoose from 'mongoose';

const BreadthDailySchema = new mongoose.Schema({
  // IST trading date, string "YYYY-MM-DD" for unambiguous indexing
  date: { type: String, required: true, unique: true, index: true },
  universe: { type: String, required: true, default: 'NIFTY500' },
  total_stocks: { type: Number, required: true },
  above_50dma_count: { type: Number, required: true },
  pct_above_50dma: { type: Number, required: true }, // 0..100
  computed_at: { type: Date, default: Date.now },
}, { collection: 'breadth_daily' });

export default mongoose.models.BreadthDaily
  || mongoose.model('BreadthDaily', BreadthDailySchema);
```

---

## File 6 — `models/indiaVixDaily.js`

**Path:** `backend/src/models/indiaVixDaily.js`

```js
import mongoose from 'mongoose';

const IndiaVixDailySchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true, index: true }, // "YYYY-MM-DD" IST
  open: Number,
  high: Number,
  low: Number,
  close: { type: Number, required: true },
  prev_close: Number,
  change_pct: Number,
  source: { type: String, default: 'NSE_ALLINDICES' },
  fetched_at: { type: Date, default: Date.now },
}, { collection: 'india_vix_daily' });

export default mongoose.models.IndiaVixDaily
  || mongoose.model('IndiaVixDaily', IndiaVixDailySchema);
```

---

## File 7 — `models/institutionalFlowDaily.js`

**Path:** `backend/src/models/institutionalFlowDaily.js`

```js
import mongoose from 'mongoose';

const InstitutionalFlowDailySchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true, index: true }, // "YYYY-MM-DD" IST
  // Cash segment net values in crores (positive = net buying)
  fii_net_cr: { type: Number, required: true },
  dii_net_cr: { type: Number },
  fii_gross_buy_cr: Number,
  fii_gross_sell_cr: Number,
  dii_gross_buy_cr: Number,
  dii_gross_sell_cr: Number,
  source: { type: String, default: 'NSE_FIIDII' },
  fetched_at: { type: Date, default: Date.now },
}, { collection: 'institutional_flow_daily' });

export default mongoose.models.InstitutionalFlowDaily
  || mongoose.model('InstitutionalFlowDaily', InstitutionalFlowDailySchema);
```

---

## File 8 — `services/jobs/breadthSnapshotJob.js`

**Path:** `backend/src/services/jobs/breadthSnapshotJob.js`

```js
/**
 * Breadth Snapshot Job
 *
 * Schedule: 21:00 IST daily (after NSE close + settlement)
 *
 * For each Nifty 500 constituent, compute whether the previous day's close
 * is above its own 50-DMA. Store the aggregate % in breadth_daily.
 *
 * If Nifty 500 coverage fails (<90% stocks with data), fall back to Nifty 200.
 */

import BreadthDaily from '../../models/breadthDaily.js';
import { getCandleData } from '../technicalData.service.js';
import {
  BREADTH_DMA_WINDOW, BREADTH_UNIVERSE_PRIMARY, BREADTH_UNIVERSE_FALLBACK,
} from '../../constants/regimeConstants.js';

/**
 * Returns the list of instrument keys + symbols for a universe.
 * Assumes you already maintain a universe list — wire this to however
 * you currently resolve Nifty 500 membership (likely instrumentSyncJob).
 */
async function getUniverseInstruments(universe) {
  // TODO-HOOK: swap this for however your app already resolves Nifty 500 membership.
  // The function must return: [{ symbol, instrumentKey }, ...]
  const { getInstrumentsForIndex } = await import('../../utils/sectorMapping.js').catch(() => ({}));
  if (typeof getInstrumentsForIndex === 'function') {
    return getInstrumentsForIndex(universe);
  }
  // Fallback: read from a Stock model tagged with index membership.
  const Stock = (await import('../../models/stock.js')).default;
  const stocks = await Stock.find({ indices: universe }).lean();
  return stocks.map(s => ({ symbol: s.symbol, instrumentKey: s.instrument_key }));
}

function sma(values, period) {
  if (!values || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

async function computeBreadthForUniverse(universe) {
  const instruments = await getUniverseInstruments(universe);
  if (!instruments || instruments.length === 0) {
    throw new Error(`No instruments for universe ${universe}`);
  }

  let evaluated = 0;
  let aboveDma = 0;
  const errors = [];

  // Bounded concurrency: 5 in flight at a time to avoid slamming Upstox
  const concurrency = 5;
  const queue = [...instruments];
  async function worker() {
    while (queue.length) {
      const { symbol, instrumentKey } = queue.shift();
      try {
        const candles = await getCandleData(instrumentKey, symbol, '1d', { allowOutdated: false });
        if (!candles || candles.length < BREADTH_DMA_WINDOW) continue;
        const closes = candles.map(c => Array.isArray(c) ? c[4] : c.close);
        const close = closes[closes.length - 1];
        const dma = sma(closes, BREADTH_DMA_WINDOW);
        if (typeof close !== 'number' || typeof dma !== 'number') continue;
        evaluated++;
        if (close > dma) aboveDma++;
      } catch (err) {
        errors.push({ symbol, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  const coverage = evaluated / instruments.length;
  return { total: instruments.length, evaluated, aboveDma, coverage, errors };
}

function todayIstDateStr() {
  // Cheap IST date: subtract/add the offset manually. Replace with luxon/date-fns-tz if you prefer.
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

export async function runBreadthSnapshotJob() {
  console.log('[JOB breadth] starting');
  const date = todayIstDateStr();

  let result;
  let universeUsed = BREADTH_UNIVERSE_PRIMARY;
  try {
    result = await computeBreadthForUniverse(BREADTH_UNIVERSE_PRIMARY);
    if (result.coverage < 0.90) {
      console.warn(`[JOB breadth] primary coverage ${(result.coverage*100).toFixed(1)}% < 90%, falling back`);
      throw new Error('low-coverage-fallback');
    }
  } catch (err) {
    console.warn('[JOB breadth] primary failed, trying fallback:', err.message);
    result = await computeBreadthForUniverse(BREADTH_UNIVERSE_FALLBACK);
    universeUsed = BREADTH_UNIVERSE_FALLBACK;
  }

  const pct = (result.aboveDma / Math.max(result.evaluated, 1)) * 100;

  await BreadthDaily.findOneAndUpdate(
    { date },
    {
      date,
      universe: universeUsed,
      total_stocks: result.total,
      above_50dma_count: result.aboveDma,
      pct_above_50dma: Math.round(pct * 100) / 100,
      computed_at: new Date(),
    },
    { upsert: true, new: true }
  );

  console.log(`[JOB breadth] date=${date} universe=${universeUsed} pct=${pct.toFixed(2)}% evaluated=${result.evaluated}/${result.total} errors=${result.errors.length}`);
  return { date, universeUsed, pct };
}

export default { runBreadthSnapshotJob };
```

---

## File 9 — `services/jobs/vixSnapshotJob.js`

**Path:** `backend/src/services/jobs/vixSnapshotJob.js`

```js
/**
 * India VIX Snapshot Job
 *
 * Schedule: 21:00 IST daily (after NSE close)
 *
 * Fetches India VIX close from NSE allIndices API and upserts into india_vix_daily.
 */

import IndiaVixDaily from '../../models/indiaVixDaily.js';

const NSE_ALL_INDICES_URL = 'https://www.nseindia.com/api/allIndices';

function todayIstDateStr() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/**
 * NSE blocks simple fetches — they require a session cookie dance.
 * If you already have an NSE scraper utility, use that instead.
 */
async function fetchNseVix() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.nseindia.com/',
  };

  // Step 1: get cookies by hitting the homepage
  await fetch('https://www.nseindia.com/', { headers, signal: AbortSignal.timeout(8000) });

  // Step 2: call the allIndices endpoint
  const res = await fetch(NSE_ALL_INDICES_URL, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`NSE allIndices HTTP ${res.status}`);
  const json = await res.json();

  const vix = (json?.data || []).find(i =>
    (i.index || '').toUpperCase().includes('INDIA VIX')
  );
  if (!vix) throw new Error('INDIA VIX not found in allIndices response');

  return {
    open: Number(vix.open) || null,
    high: Number(vix.high) || null,
    low: Number(vix.low) || null,
    close: Number(vix.last ?? vix.previousClose) || null,
    prev_close: Number(vix.previousClose) || null,
    change_pct: typeof vix.percentChange === 'number' ? vix.percentChange : Number(vix.percentChange) || null,
  };
}

export async function runVixSnapshotJob() {
  console.log('[JOB vix] starting');
  const date = todayIstDateStr();

  const vix = await fetchNseVix();
  if (!vix.close) throw new Error('VIX close missing from NSE payload');

  await IndiaVixDaily.findOneAndUpdate(
    { date },
    { date, ...vix, source: 'NSE_ALLINDICES', fetched_at: new Date() },
    { upsert: true, new: true }
  );

  console.log(`[JOB vix] date=${date} close=${vix.close} change=${vix.change_pct}%`);
  return { date, close: vix.close };
}

export default { runVixSnapshotJob };
```

---

## File 10 — `services/jobs/fiiFlowJob.js`

**Path:** `backend/src/services/jobs/fiiFlowJob.js`

```js
/**
 * FII/DII Flow Snapshot Job
 *
 * Schedule: 19:00 IST daily (NSE publishes around 18:30 IST)
 *
 * Fetches prev-day FII/DII cash segment net values from NSE.
 */

import InstitutionalFlowDaily from '../../models/institutionalFlowDaily.js';

const NSE_FIIDII_URL = 'https://www.nseindia.com/api/fiidiiTradeReact';

function todayIstDateStr() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function fetchNseFiiDii() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.nseindia.com/',
  };
  await fetch('https://www.nseindia.com/', { headers, signal: AbortSignal.timeout(8000) });
  const res = await fetch(NSE_FIIDII_URL, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`NSE fiidii HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('NSE fiidii: unexpected shape');

  const pickRow = (category) => arr.find(r =>
    (r.category || '').toUpperCase().includes(category.toUpperCase())
  );
  const fii = pickRow('FII') || pickRow('FPI');
  const dii = pickRow('DII');

  return {
    fii_net_cr: fii ? Number(fii.netValue) : null,
    dii_net_cr: dii ? Number(dii.netValue) : null,
    fii_gross_buy_cr: fii ? Number(fii.buyValue) : null,
    fii_gross_sell_cr: fii ? Number(fii.sellValue) : null,
    dii_gross_buy_cr: dii ? Number(dii.buyValue) : null,
    dii_gross_sell_cr: dii ? Number(dii.sellValue) : null,
  };
}

export async function runFiiFlowJob() {
  console.log('[JOB fiiflow] starting');
  const date = todayIstDateStr();
  const flow = await fetchNseFiiDii();
  if (typeof flow.fii_net_cr !== 'number') throw new Error('FII net missing');

  await InstitutionalFlowDaily.findOneAndUpdate(
    { date },
    { date, ...flow, source: 'NSE_FIIDII', fetched_at: new Date() },
    { upsert: true, new: true }
  );

  console.log(`[JOB fiiflow] date=${date} FII=${flow.fii_net_cr}cr DII=${flow.dii_net_cr}cr`);
  return { date, ...flow };
}

export default { runFiiFlowJob };
```

---

## File 11 — Job registration

Your existing scheduler lives in or near `backend/src/services/jobs/` and is wired up in `backend/src/index.js`. Add these registrations alongside your existing ones:

```js
// In your scheduler registration block (backend/src/index.js or equivalent)

import { runBreadthSnapshotJob } from './services/jobs/breadthSnapshotJob.js';
import { runVixSnapshotJob }     from './services/jobs/vixSnapshotJob.js';
import { runFiiFlowJob }         from './services/jobs/fiiFlowJob.js';

// Cron syntax: minute hour dayOfMonth month dayOfWeek
// 19:00 IST Mon-Fri = 13:30 UTC
scheduler.cron('30 13 * * 1-5', runFiiFlowJob);

// 21:00 IST Mon-Fri = 15:30 UTC
scheduler.cron('30 15 * * 1-5', runVixSnapshotJob);

// 21:05 IST Mon-Fri = 15:35 UTC (slight stagger after VIX job)
scheduler.cron('35 15 * * 1-5', runBreadthSnapshotJob);
```

> Adjust cron strings to match whatever scheduler library you use (agenda, node-cron, bullmq, etc.). If your scheduler is IST-aware, use `19:00`, `21:00`, `21:05` directly.

---

## File 12 — Backfill scripts

### `scripts/backfillIndiaVix.js`

**Path:** `backend/src/scripts/backfillIndiaVix.js`

```js
/**
 * Backfill India VIX — 24 months from historical CSV.
 *
 * NSE does not expose a long-history API easily. Download the historical
 * CSV from https://www.niftyindices.com/reports/historical-data
 * (choose INDIAVIX, 2 years), save it to this path, then run:
 *
 *   node src/scripts/backfillIndiaVix.js <path-to-csv>
 */

import fs from 'fs';
import path from 'path';
import IndiaVixDaily from '../models/indiaVixDaily.js';
import mongoose from 'mongoose';

function parseIstDate(s) {
  // NSE CSV typically uses "DD-MMM-YYYY" or "DD-MM-YYYY". Normalize to ISO.
  const tryIso = new Date(s);
  if (!isNaN(tryIso)) return tryIso.toISOString().slice(0, 10);
  const m = s.match(/^(\d{2})-(\w{3})-(\d{4})$/);
  if (m) {
    const months = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
    return `${m[3]}-${months[m[2]]}-${m[1]}`;
  }
  return null;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error('Usage: node src/scripts/backfillIndiaVix.js <csv-path>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const raw = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  const header = raw.shift().split(',').map(h => h.trim().toUpperCase());
  const idx = {
    date: header.findIndex(h => h.includes('DATE')),
    open: header.findIndex(h => h === 'OPEN'),
    high: header.findIndex(h => h === 'HIGH'),
    low:  header.findIndex(h => h === 'LOW'),
    close: header.findIndex(h => h === 'CLOSE'),
    prev:  header.findIndex(h => h.includes('PREV')),
  };

  let count = 0;
  for (const line of raw) {
    const cols = line.split(',').map(c => c.trim());
    const date = parseIstDate(cols[idx.date]);
    if (!date) continue;
    const doc = {
      date,
      open:  Number(cols[idx.open])  || null,
      high:  Number(cols[idx.high])  || null,
      low:   Number(cols[idx.low])   || null,
      close: Number(cols[idx.close]) || null,
      prev_close: idx.prev >= 0 ? (Number(cols[idx.prev]) || null) : null,
      source: 'BACKFILL_CSV',
    };
    if (doc.close) {
      await IndiaVixDaily.findOneAndUpdate({ date }, doc, { upsert: true });
      count++;
    }
  }
  console.log(`Backfilled ${count} VIX rows`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
```

### `scripts/backfillFiiFlow.js`

**Path:** `backend/src/scripts/backfillFiiFlow.js`

```js
/**
 * Backfill FII/DII — N trading days back using NSE historical endpoint.
 *
 * Usage: node src/scripts/backfillFiiFlow.js 500   (number of calendar days back)
 */

import InstitutionalFlowDaily from '../models/institutionalFlowDaily.js';
import mongoose from 'mongoose';

async function fetchDay(fromDate, toDate) {
  const url = `https://www.nseindia.com/api/historicalOR/foDIIFIITradeRect?from=${fromDate}&to=${toDate}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.nseindia.com/',
  };
  await fetch('https://www.nseindia.com/', { headers });
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`NSE historical HTTP ${res.status}`);
  return res.json();
}

function fmtDate(d) { return d.toISOString().slice(0, 10).split('-').reverse().join('-'); } // DD-MM-YYYY

async function main() {
  const daysBack = Number(process.argv[2] || 500);
  await mongoose.connect(process.env.MONGO_URI);

  const to = new Date();
  const from = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
  const payload = await fetchDay(fmtDate(from), fmtDate(to));

  const rows = Array.isArray(payload) ? payload : (payload?.data || []);
  let count = 0;
  for (const r of rows) {
    const date = (r.date || r.DATE || '').split('-').reverse().join('-'); // to YYYY-MM-DD
    if (!date) continue;
    const doc = {
      date,
      fii_net_cr: Number(r.fiiNetValue ?? r.fii_net ?? r.FII) || null,
      dii_net_cr: Number(r.diiNetValue ?? r.dii_net ?? r.DII) || null,
      source: 'BACKFILL_NSE',
    };
    if (typeof doc.fii_net_cr === 'number') {
      await InstitutionalFlowDaily.findOneAndUpdate({ date }, doc, { upsert: true });
      count++;
    }
  }
  console.log(`Backfilled ${count} FII/DII rows`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
```

### `scripts/backfillBreadth.js`

**Path:** `backend/src/scripts/backfillBreadth.js`

```js
/**
 * Backfill breadth — walks N trading days back, computing % Nifty 500
 * above 50-DMA for each day using existing Upstox historical candles.
 *
 * Heavy: ~500 stocks × N days of candle queries. Use with care.
 *
 * Usage: node src/scripts/backfillBreadth.js 400
 */

import mongoose from 'mongoose';
import BreadthDaily from '../models/breadthDaily.js';
import { getCandleData } from '../services/technicalData.service.js';
import { BREADTH_DMA_WINDOW } from '../constants/regimeConstants.js';

async function main() {
  const daysBack = Number(process.argv[2] || 400);
  await mongoose.connect(process.env.MONGO_URI);

  const Stock = (await import('../models/stock.js')).default;
  const universe = await Stock.find({ indices: 'NIFTY500' }).lean();
  console.log(`[backfill breadth] universe=${universe.length}`);

  // For each stock, pull all candles once.
  // Then for each date, check close vs SMA50.
  const seriesBySymbol = {};
  let loaded = 0;
  for (const s of universe) {
    try {
      const candles = await getCandleData(s.instrument_key, s.symbol, '1d', { allowOutdated: true });
      if (candles && candles.length >= BREADTH_DMA_WINDOW + 5) {
        seriesBySymbol[s.symbol] = candles.map(c => ({
          date: (Array.isArray(c) ? c[0] : c.date).slice(0, 10),
          close: Array.isArray(c) ? c[4] : c.close,
        }));
      }
    } catch (err) {
      // skip
    }
    loaded++;
    if (loaded % 50 === 0) console.log(`[backfill breadth] loaded ${loaded}/${universe.length}`);
  }

  // Collect all trading dates from any symbol; sort.
  const allDates = new Set();
  for (const arr of Object.values(seriesBySymbol)) {
    for (const p of arr) allDates.add(p.date);
  }
  const sortedDates = [...allDates].sort();
  const recentDates = sortedDates.slice(-daysBack);

  for (const date of recentDates) {
    let evaluated = 0, above = 0;
    for (const [, series] of Object.entries(seriesBySymbol)) {
      const idx = series.findIndex(p => p.date === date);
      if (idx < BREADTH_DMA_WINDOW - 1) continue;
      const window = series.slice(idx - BREADTH_DMA_WINDOW + 1, idx + 1);
      const dma = window.reduce((a, p) => a + p.close, 0) / BREADTH_DMA_WINDOW;
      evaluated++;
      if (series[idx].close > dma) above++;
    }
    if (evaluated < 50) continue;
    const pct = (above / evaluated) * 100;
    await BreadthDaily.findOneAndUpdate(
      { date },
      {
        date, universe: 'NIFTY500',
        total_stocks: universe.length,
        above_50dma_count: above,
        pct_above_50dma: Math.round(pct * 100) / 100,
        computed_at: new Date(),
      },
      { upsert: true },
    );
  }

  console.log(`[backfill breadth] done`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
```

---

## File 13 — Step 1 diff in `dailyPicksService.js`

Wire the v2 regime behind an env flag so you can roll back instantly.

**Find your current Step 1 block.** It looks roughly like:

```js
// ── Step 1: Market Context ──────────────────────────────────────────
const regimeResult = await fetchAndCheckRegime();
// ... combine with SGX, produce marketContext, handle CONFLICT halt ...
```

**Replace the entire Step 1 section with:**

```js
// ── Step 1: Market Context ──────────────────────────────────────────
// REGIME_VERSION env flag: 'v1' (default, legacy) | 'v2' (continuous score)
const regimeVersion = process.env.REGIME_VERSION === 'v2' ? 'v2' : 'v1';
let marketContext;

if (regimeVersion === 'v2') {
  const { computeMarketContextV2 } = await import('../../engine/regimeV2.js');
  marketContext = await computeMarketContextV2();

  if (marketContext.regime === 'HALT') {
    console.log(`[DP] V2 HALT: ${marketContext.halt_reason}`);
    await saveEmptyDailyPick({
      marketContext,
      reason: `halt:${marketContext.halt_reason || 'unknown'}`,
    });
    await sendNotification({
      title: 'Trading Halted',
      body: `Regime v2 halt: ${marketContext.halt_reason || 'unknown'}`,
    });
    return;
  }

  // Defensive: gap_fade with max_trades=0 (v1 rollout safety) acts as halt
  if (marketContext.playbook === 'gap_fade' && marketContext.max_trades === 0) {
    console.log(`[DP] V2 gap_fade halt (playbook not yet enabled for live trading)`);
    await saveEmptyDailyPick({
      marketContext,
      reason: 'gap_fade_playbook_disabled',
    });
    await sendNotification({
      title: 'Sitting Out — Gap Fade Day',
      body: 'Regime v2 detected gap-fade conditions; playbook not yet live.',
    });
    return;
  }
} else {
  // ── Legacy v1 path (current code unchanged) ──
  // KEEP your existing v1 code here exactly as it was.
  marketContext = await legacyBuildMarketContext();  // your existing function name
}
```

> **Note:** Substitute `saveEmptyDailyPick` and `sendNotification` with the exact function names you use in your current CONFLICT-halt branch. I didn't modify those — the v2 block just reuses whatever pattern you already have for "halt and save empty doc and notify."

---

## File 14 — Step 4 diff (score floor override)

**Find the line in Step 4 where `MIN_SCORE` is checked.** It looks like:

```js
if (candidate.rank_score < MIN_SCORE) {
  // reject candidate
}
```

**Replace with:**

```js
const effectiveMinScore = marketContext.score_floor_override ?? MIN_SCORE;
if (candidate.rank_score < effectiveMinScore) {
  // reject candidate — use effectiveMinScore in logs/rejection reasons
}
```

Everything else in Step 4 stays the same. The override is only non-null when v2 is active AND the playbook is `gap_fade`.

---

## File 15 — Unit tests

**Path:** `backend/src/tests/regime-v2-scoring.test.js`

```js
import { describe, it, expect } from 'vitest';
import {
  computeStructure, computeBreadth, computeVolatility, computeOvernight, computeFlow,
  computeRegimeScore, scoreToLabel, scoreToSizing, decidePlaybook, buildMarketContext,
} from '../engine/regimeScoring.js';

describe('regime v2 input computation', () => {
  it('structure: all inputs zero → 0', () => {
    expect(computeStructure({ close: 100, ema20: 100, ema50: 100, ema50_prev5: 100 })).toBe(0);
  });

  it('structure: 3% above EMA50 + 2% above EMA20 + 1% slope → +1', () => {
    const s = computeStructure({ close: 103, ema20: 100.98, ema50: 100, ema50_prev5: 99.01 });
    expect(s).toBeCloseTo(1.0, 1);
  });

  it('structure: missing data → null', () => {
    expect(computeStructure({ close: 100 })).toBeNull();
    expect(computeStructure(null)).toBeNull();
  });

  it('breadth: 50% → 0, 75% → +1, 25% → -1', () => {
    expect(computeBreadth(50)).toBe(0);
    expect(computeBreadth(75)).toBe(1);
    expect(computeBreadth(25)).toBe(-1);
    expect(computeBreadth(null)).toBeNull();
  });

  it('volatility inverts VIX: low pct → +1, high pct → -1', () => {
    expect(computeVolatility(25)).toBe(1);
    expect(computeVolatility(50)).toBe(0);
    expect(computeVolatility(75)).toBe(-1);
    expect(computeVolatility(null)).toBeNull();
  });

  it('overnight: pure GIFT when Asia/DXY null', () => {
    const o = computeOvernight({ giftPct: 0.75 });
    expect(o).toBeCloseTo(1.0, 1);
  });

  it('overnight: DXY sign flipped (strong dollar = negative)', () => {
    const o = computeOvernight({ dxyPct: 0.50 });
    expect(o).toBeCloseTo(-1.0, 1);
  });

  it('flow: disagreement dampens', () => {
    expect(computeFlow({ fiiCr:  3000, diiCr:  1000 })).toBeCloseTo(1.0);
    expect(computeFlow({ fiiCr:  3000, diiCr: -1000 })).toBeCloseTo(0.5);
  });
});

describe('regime score composition', () => {
  it('all-null directional → halt reason', () => {
    const { score, reason } = computeRegimeScore({
      structure: null, breadth: null, overnight: null, flow: null, volatility: null,
    });
    expect(score).toBeNull();
    expect(reason).toBe('no_directional_data');
  });

  it('low vol boosts magnitude, high vol shrinks it', () => {
    const base = { structure: 0.5, breadth: 0.5, overnight: 0.5, flow: 0.5 };
    const calm    = computeRegimeScore({ ...base, volatility:  1 }).score;
    const neutral = computeRegimeScore({ ...base, volatility:  0 }).score;
    const stressed= computeRegimeScore({ ...base, volatility: -1 }).score;
    expect(calm).toBeGreaterThan(neutral);
    expect(stressed).toBeLessThan(neutral);
  });
});

describe('label + sizing mapping', () => {
  it('label thresholds', () => {
    expect(scoreToLabel( 0.70)).toBe('STRONG_BULL');
    expect(scoreToLabel( 0.40)).toBe('WEAK_BULL');
    expect(scoreToLabel( 0.10)).toBe('NEUTRAL');
    expect(scoreToLabel(-0.40)).toBe('WEAK_BEAR');
    expect(scoreToLabel(-0.70)).toBe('STRONG_BEAR');
  });

  it('sizing: strong score → 3 trades', () => {
    const { maxTrades, sizeMultiplier } = scoreToSizing(0.80);
    expect(maxTrades).toBe(3);
    expect(sizeMultiplier).toBeGreaterThan(0.9);
  });

  it('sizing: below threshold → 0 trades', () => {
    const { maxTrades } = scoreToSizing(0.05);
    expect(maxTrades).toBe(0);
  });
});

describe('playbook decision', () => {
  it('structure + overnight disagree strongly → gap_fade', () => {
    const pb = decidePlaybook({ structure: 0.6, overnight: -0.5, vixPctRank: 50 });
    expect(pb).toBe('gap_fade');
  });
  it('extreme VIX → halt', () => {
    const pb = decidePlaybook({ structure: 0.5, overnight: 0.5, vixPctRank: 95 });
    expect(pb).toBe('halt');
  });
  it('normal alignment → standard', () => {
    const pb = decidePlaybook({ structure: 0.4, overnight: 0.4, vixPctRank: 50 });
    expect(pb).toBe('standard');
  });
});

describe('end-to-end buildMarketContext', () => {
  it('missing everything → HALT', () => {
    const ctx = buildMarketContext({
      niftyStructure: null, breadthPct: null, vixData: null, overnightData: null, flowData: null,
    });
    expect(ctx.regime).toBe('HALT');
    expect(ctx.max_trades).toBe(0);
  });

  it('strong bull day', () => {
    const ctx = buildMarketContext({
      niftyStructure: { close: 22500, ema20: 22050, ema50: 21800, ema50_prev5: 21600 },
      breadthPct: 68,
      vixData: { close: 12, percentileRank: 20 },
      overnightData: { giftPct: 0.5, asiaCompositePct: 0.6, dxyPct: -0.2 },
      flowData: { fiiCr: 2500, diiCr: 1000 },
    });
    expect(ctx.regime).toMatch(/BULL/);
    expect(ctx.max_trades).toBeGreaterThanOrEqual(2);
    expect(ctx.playbook).toBe('standard');
  });

  it('gap-fade day: structure bear, overnight bull', () => {
    const ctx = buildMarketContext({
      niftyStructure: { close: 21000, ema20: 21400, ema50: 21800, ema50_prev5: 21900 },
      breadthPct: 35,
      vixData: { close: 16, percentileRank: 60 },
      overnightData: { giftPct: 0.8, asiaCompositePct: 0.9, dxyPct: -0.3 },
      flowData: { fiiCr: -500, diiCr: 200 },
    });
    expect(ctx.playbook).toBe('gap_fade');
  });
});
```

Run with: `npx vitest run src/tests/regime-v2-scoring.test.js`

---

## Rollout Steps (copy-paste order)

1. **Add files 1–10** to the stated paths.
2. **Create Mongo collections** — they'll be created lazily on first upsert; no migration needed.
3. **Run backfill scripts** (one-time):
   ```bash
   node src/scripts/backfillIndiaVix.js /path/to/nse-vix-2yr.csv
   node src/scripts/backfillFiiFlow.js 500
   node src/scripts/backfillBreadth.js 400
   ```
4. **Register the three nightly jobs** (File 11).
5. **Apply the Step 1 diff** (File 13) — deploy with `REGIME_VERSION` unset so it stays on v1.
6. **Apply the Step 4 diff** (File 14) — safe regardless of version since override is null on v1.
7. **Run unit tests** (File 15): `npx vitest run src/tests/regime-v2-scoring.test.js`
8. **Shadow mode:** set `REGIME_VERSION=v2` in a non-production env and let it run for 2 weeks; compare daily output to v1.
9. **Historical replay:** wire `REGIME_VERSION` into `pipelineBacktest.js` (passes through to the same `computeMarketContextV2` function, fed from historical snapshots). Backtest 18–24 months. Compare P&L, trades, drawdown, Sharpe.
10. **Cut-over:** `REGIME_VERSION=v2` in production. Monitor daily for 30 days. Keep v1 path in code for 60 days total as rollback insurance.

---

## What You Still Need to Decide / Verify

1. **GIFT Nifty scraper export name.** File 3 imports `scrapeGiftNifty`. Verify this matches your actual export in `upstoxNewsScraper.js` (or wherever) and fix if not.
2. **Nifty 500 membership source.** File 8's `getUniverseInstruments` tries `sectorMapping.getInstrumentsForIndex`, then falls back to `Stock.find({ indices: 'NIFTY500' })`. Make sure at least one of those works in your repo; otherwise wire it to your actual source of truth.
3. **Scheduler library.** File 11 uses pseudo-cron syntax. Adapt to agenda/bullmq/node-cron as appropriate.
4. **`saveEmptyDailyPick` / `sendNotification` names.** File 13 uses placeholder names for your halt/notify functions. Use the real names from your current CONFLICT branch.
5. **`legacyBuildMarketContext` placeholder.** File 13 references this as the name of your current v1 Step-1-orchestrator function. Replace with your actual function name (likely the current inline v1 code block — just leave it as-is in the `else` branch).
6. **VIX CSV source.** File 12's `backfillIndiaVix.js` expects a manually-downloaded CSV from niftyindices.com. If you have a programmatic source, swap that in.
7. **NSE historical FII endpoint.** `foDIIFIITradeRect` path in `backfillFiiFlow.js` has changed URL shapes in the past. Verify current availability; otherwise use daily bhav archives.

---

*End of reference implementation.*
