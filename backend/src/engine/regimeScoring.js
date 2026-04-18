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
 *   regime_score, playbook, score_floor_override, inputs, raw_data
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
  if (o == null) return null;
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
  if (f == null) return null;
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
