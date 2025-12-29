/**
 * Trade Candidates Module
 *
 * Generates the 4 deterministic trade candidate strategies (C1-C4).
 * This is the code-first Stage 2 logic extracted from swingPrompts.js.
 */

import { round2, isNum } from './helpers.js';

/**
 * Scan type to candidate mapping
 */
const SCAN_TYPE_TO_CANDIDATES = {
  BREAKOUT: ['C1'],
  PULLBACK: ['C2'],
  MOMENTUM: ['C1', 'C2'],
  CONSOLIDATION: ['C2', 'C3'],
  MEAN_REVERSION: ['C3'],
  RANGE: ['C3', 'C4']
};

/**
 * Scan type bonus for matching candidates
 */
const SCAN_TYPE_BONUS = 0.25;

/**
 * Calculate Risk:Reward for BUY trade
 */
export function rrBuy(entry, target, stopLoss) {
  if (!isNum(entry) || !isNum(target) || !isNum(stopLoss)) return 0;
  const risk = entry - stopLoss;
  const reward = target - entry;
  if (risk <= 0) return 0;
  return round2(reward / risk);
}

/**
 * Calculate Risk:Reward for SELL trade
 */
export function rrSell(entry, target, stopLoss) {
  if (!isNum(entry) || !isNum(target) || !isNum(stopLoss)) return 0;
  const risk = stopLoss - entry;
  const reward = entry - target;
  if (risk <= 0) return 0;
  return round2(reward / risk);
}

/**
 * Check if candidate matches scan type
 */
function candidateMatchesScanType(candidateId, scanType) {
  if (!scanType) return false;
  const preferred = SCAN_TYPE_TO_CANDIDATES[scanType] || SCAN_TYPE_TO_CANDIDATES[scanType.toUpperCase()];
  return preferred ? preferred.includes(candidateId) : false;
}

/**
 * Build trigger object for candidate
 */
function buildTrigger({ id, timeframe, left_ref, op, right_ref, right_value }) {
  return {
    id,
    timeframe,
    condition: {
      left: { ref: left_ref },
      op,
      right: { ref: right_ref, value: right_value }
    }
  };
}

/**
 * Build invalidation object for candidate
 */
function buildInvalidation(entryPrice, atr) {
  const invalidationLevel = round2(entryPrice - (atr ? atr * 1.5 : entryPrice * 0.03));
  return {
    timeframe: '1h',
    left: { ref: 'close' },
    op: '<',
    right: { ref: 'value', value: invalidationLevel },
    occurrences: { count: 2, consecutive: true },
    action: 'cancel_entry'
  };
}

/**
 * Generate C1: Breakout Candidate
 *
 * Entry: Break above resistance (R1 or 20-day high) + 0.2 ATR confirmation buffer
 * Target: R2 or Entry + 1.2 ATR
 * Stop: Below pivot or EMA20
 *
 * Note: 0.2 ATR buffer added per specialist review to avoid false breakout triggers
 */
function generateC1({ last, ema20, pivots, high_20d, atr, trend, scanType }) {
  const breakoutLevel = Math.max(pivots?.r1 || 0, high_20d || 0);
  if (!breakoutLevel || breakoutLevel <= 0) return null;

  // Add 0.2 ATR confirmation buffer above resistance
  const entry = round2(breakoutLevel + (0.2 * atr));

  const stop = round2(Math.max(pivots?.pivot || 0, ema20 || 0));
  const target = round2(
    (pivots?.r2 && pivots.r2 > entry) ? pivots.r2 : (entry + 1.2 * atr)
  );

  const rr = rrBuy(entry, target, stop);
  if (rr <= 0) return null;

  return {
    id: 'C1',
    name: 'breakout',
    matches_scan_type: candidateMatchesScanType('C1', scanType),
    score: {
      rr,
      trend_align: trend === 'BULLISH' ? 1 : 0.3,
      distance_pct: round2((Math.abs(last - entry) / last) * 100),
      scan_type_bonus: candidateMatchesScanType('C1', scanType) ? SCAN_TYPE_BONUS : 0
    },
    skeleton: {
      type: 'BUY',
      archetype: 'breakout',
      alignment: trend === 'BULLISH' ? 'with_trend' : 'neutral',
      entryType: 'stop',
      entry,
      entryRange: null,
      target,
      stopLoss: stop,
      riskReward: rr,
      triggers: [
        buildTrigger({
          id: 'T1',
          timeframe: '1h',
          left_ref: 'close',
          op: 'crosses_above',
          right_ref: 'entry',
          right_value: entry
        })
      ],
      invalidations_pre_entry: [buildInvalidation(entry, atr)]
    }
  };
}

/**
 * Generate C2: Pullback Candidate
 *
 * Entry: Pullback to EMA20 or Pivot (whichever higher)
 * Target: Recent swing high or Entry + 1.0 ATR
 * Stop: S1 or Entry - 0.8 ATR
 */
function generateC2({ last, ema20, pivots, high_20d, atr, trend, scanType }) {
  if (!isNum(ema20) && !isNum(pivots?.pivot)) return null;

  const entry = round2(Math.max(ema20 || 0, pivots?.pivot || 0));
  if (!entry || entry <= 0) return null;

  const stop = round2(
    (pivots?.s1 && pivots.s1 < entry) ? pivots.s1 : (entry - 0.8 * atr)
  );
  const target = round2(
    (high_20d && high_20d > entry) ? high_20d : (entry + 1.0 * atr)
  );

  const rr = rrBuy(entry, target, stop);
  if (rr <= 0) return null;

  // Entry spread: 0.3 ATR (matches zones.js for consistency)
  const entrySpread = 0.3 * atr;

  return {
    id: 'C2',
    name: 'pullback',
    matches_scan_type: candidateMatchesScanType('C2', scanType),
    score: {
      rr,
      trend_align: trend === 'BULLISH' ? 1 : 0.4,
      distance_pct: round2((Math.abs(last - entry) / last) * 100),
      scan_type_bonus: candidateMatchesScanType('C2', scanType) ? SCAN_TYPE_BONUS : 0
    },
    skeleton: {
      type: 'BUY',
      archetype: 'pullback',
      alignment: trend === 'BULLISH' ? 'with_trend' : 'neutral',
      entryType: 'limit',
      entry,
      entryRange: [round2(entry - entrySpread), round2(entry + entrySpread)],
      target,
      stopLoss: stop,
      riskReward: rr,
      triggers: [
        buildTrigger({
          id: 'T1',
          timeframe: '1h',
          left_ref: 'price',
          op: '>=',
          right_ref: 'value',
          right_value: round2(entry - entrySpread)
        })
      ],
      invalidations_pre_entry: [buildInvalidation(entry, atr)]
    }
  };
}

/**
 * Generate C3: Mean-Reversion Candidate
 *
 * Entry: Bounce from S1 support
 * Target: Return to Pivot
 * Stop: S2 or Entry - 0.8 ATR
 */
function generateC3({ last, pivots, atr, trend, rsi, scanType }) {
  if (!isNum(pivots?.s1)) return null;

  const entry = round2(pivots.s1);
  const stop = round2(
    pivots?.s2 ? pivots.s2 : (entry - 0.8 * atr)
  );
  const target = round2(pivots?.pivot || (entry + 0.8 * atr));

  const rr = rrBuy(entry, target, stop);
  if (rr <= 0) return null;

  // Entry spread: 0.3 ATR (matches zones.js for consistency)
  const entrySpread = 0.3 * atr;

  // RSI fit - mean reversion works better with lower RSI
  const rsiFit = isNum(rsi) ? (rsi < 45 ? 1 : 0.3) : 0.4;

  return {
    id: 'C3',
    name: 'mean_reversion',
    matches_scan_type: candidateMatchesScanType('C3', scanType),
    score: {
      rr,
      trend_align: trend === 'NEUTRAL' ? 1 : 0.5,
      rsi_fit: rsiFit,
      distance_pct: round2((Math.abs(last - entry) / last) * 100),
      scan_type_bonus: candidateMatchesScanType('C3', scanType) ? SCAN_TYPE_BONUS : 0
    },
    skeleton: {
      type: 'BUY',
      archetype: 'mean-reversion',
      alignment: 'neutral',
      entryType: 'limit',
      entry,
      entryRange: [round2(entry - entrySpread), round2(entry + entrySpread)],
      target,
      stopLoss: stop,
      riskReward: rr,
      triggers: [
        buildTrigger({
          id: 'T1',
          timeframe: '1h',
          left_ref: 'price',
          op: '<=',
          right_ref: 'entry',
          right_value: entry
        })
      ],
      invalidations_pre_entry: [buildInvalidation(entry, atr)]
    }
  };
}

/**
 * Generate C4: Range-Fade Candidate (SELL)
 *
 * Entry: Short from R1 resistance
 * Target: Fall to Pivot
 * Stop: R2 or Entry + 0.8 ATR
 */
function generateC4({ last, pivots, atr, trend, scanType }) {
  if (!isNum(pivots?.r1)) return null;

  const entry = round2(pivots.r1);
  const stop = round2(
    pivots?.r2 ? pivots.r2 : (entry + 0.8 * atr)
  );
  const target = round2(pivots?.pivot || (entry - 0.8 * atr));

  const rr = rrSell(entry, target, stop);
  if (rr <= 0) return null;

  return {
    id: 'C4',
    name: 'range_fade',
    matches_scan_type: candidateMatchesScanType('C4', scanType),
    score: {
      rr,
      trend_align: trend === 'NEUTRAL' ? 1 : 0.4,
      distance_pct: round2((Math.abs(last - entry) / last) * 100),
      scan_type_bonus: candidateMatchesScanType('C4', scanType) ? SCAN_TYPE_BONUS : 0
    },
    skeleton: {
      type: 'SELL',
      archetype: 'range-fade',
      alignment: trend === 'BEARISH' ? 'with_trend' : 'counter_trend',
      entryType: 'stop-limit',
      entry,
      entryRange: null,
      target,
      stopLoss: stop,
      riskReward: rr,
      triggers: [
        buildTrigger({
          id: 'T1',
          timeframe: '1h',
          left_ref: 'close',
          op: 'crosses_below',
          right_ref: 'entry',
          right_value: entry
        })
      ],
      invalidations_pre_entry: [{
        timeframe: '1h',
        left: { ref: 'close' },
        op: '>',
        right: { ref: 'value', value: stop },
        occurrences: { count: 1, consecutive: false },
        action: 'cancel_entry'
      }]
    }
  };
}

/**
 * Generate all trade candidates
 *
 * @param {Object} indicators - From indicators.js
 * @param {Object} levels - From levels.js
 * @param {Object} options - { scanType, trend }
 * @returns {Object} { candidates, insufficientData, notes }
 */
export function generate(indicators, levels, options = {}) {
  const { last, ema20, atr, high_20d, rsi } = indicators;
  const pivots = levels;
  const { scanType, trend = 'NEUTRAL' } = options;

  // Validate minimum required data
  if (!isNum(last) || !isNum(atr)) {
    return {
      candidates: [],
      insufficientData: true,
      notes: ['Missing required data: current price or ATR']
    };
  }

  if (!pivots?.pivot) {
    return {
      candidates: [],
      insufficientData: true,
      notes: ['Missing pivot points - need previous session data']
    };
  }

  const params = {
    last,
    ema20,
    pivots,
    high_20d,
    atr,
    trend,
    rsi,
    scanType
  };

  const notes = [];
  const rawCandidates = [];

  // Generate all candidates
  const c1 = generateC1(params);
  if (c1) rawCandidates.push(c1);
  else notes.push('C1 (breakout) not viable - invalid geometry');

  const c2 = generateC2(params);
  if (c2) rawCandidates.push(c2);
  else notes.push('C2 (pullback) not viable - missing EMA20/Pivot');

  const c3 = generateC3(params);
  if (c3) rawCandidates.push(c3);
  else notes.push('C3 (mean-reversion) not viable - missing S1');

  const c4 = generateC4(params);
  if (c4) rawCandidates.push(c4);
  else notes.push('C4 (range-fade) not viable - missing R1');

  // Filter valid candidates (RR > 0)
  const validCandidates = rawCandidates.filter(c => c.skeleton.riskReward > 0);

  // Mark candidates with good R:R (>= 1.5)
  validCandidates.forEach(c => {
    c.ok = c.skeleton.riskReward >= 1.5;
  });

  return {
    candidates: validCandidates,
    insufficientData: validCandidates.length === 0,
    notes
  };
}

/**
 * Shrink candidate for token-efficient prompting
 */
export function shrinkForPrompt(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    name: candidate.name,
    score: candidate.score,
    skeleton: candidate.skeleton
  };
}

export default {
  generate,
  rrBuy,
  rrSell,
  shrinkForPrompt,
  SCAN_TYPE_TO_CANDIDATES
};
