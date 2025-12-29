/**
 * Trading Zones Module
 *
 * Single source of truth for Entry Zone, Target Zone, and Stop Loss Zone calculations.
 *
 * CRITICAL: This fixes the inconsistency between card (DMA20) and analysis (EMA20).
 * Now BOTH use the same sophisticated logic: Max(EMA20, Pivot) ± 0.2 ATR
 */

import { round2, isNum } from './helpers.js';

/**
 * Calculate Entry Zone
 *
 * UNIFIED LOGIC - Used by BOTH card display AND analysis page.
 * Uses the more sophisticated Stage 2 logic: Max(EMA20, Pivot) as base.
 *
 * @param {Object} params
 * @param {number} params.ema20 - 20-day EMA
 * @param {number} params.pivot - Pivot point
 * @param {number} params.atr - 14-day ATR
 * @param {number} [params.currentPrice] - Current price (for validation)
 * @returns {Object|null} Entry zone { low, high, center, based_on, spread }
 */
export function calculateEntryZone({ ema20, pivot, atr, currentPrice }) {
  // Validate required inputs
  if (!isNum(atr) || atr <= 0) {
    return null;
  }

  // Need at least one of EMA20 or Pivot
  if (!isNum(ema20) && !isNum(pivot)) {
    return null;
  }

  // Use the HIGHER of EMA20 or Pivot as base (more conservative entry)
  let base;
  let basedOn;

  if (isNum(ema20) && isNum(pivot)) {
    base = Math.max(ema20, pivot);
    basedOn = ema20 >= pivot ? 'ema20' : 'pivot';
  } else if (isNum(ema20)) {
    base = ema20;
    basedOn = 'ema20';
  } else {
    base = pivot;
    basedOn = 'pivot';
  }

  // Spread: ±0.3 ATR (widened for Indian market volatility at open)
  // Previously 0.2 ATR - changed per specialist review for volatile pre-open sessions
  const spread = 0.3 * atr;

  return {
    center: round2(base),
    low: round2(base - spread),
    high: round2(base + spread),
    based_on: basedOn,
    spread: round2(spread)
  };
}

/**
 * Calculate Stop Loss Zone for a BUY trade
 *
 * @param {Object} params
 * @param {number} params.entry - Entry price
 * @param {number} params.atr - 14-day ATR
 * @param {number} [params.s1] - Support 1 pivot level
 * @param {number} [params.swing_low] - Recent swing low
 * @returns {Object|null} Stop loss zone
 */
export function calculateStopLossZone({ entry, atr, s1, swing_low }) {
  if (!isNum(entry) || !isNum(atr)) {
    return null;
  }

  // Primary method: Use S1 if available and reasonable
  let base;
  let basedOn;

  if (isNum(s1) && s1 < entry) {
    base = s1;
    basedOn = 's1';
  } else if (isNum(swing_low) && swing_low < entry) {
    base = swing_low;
    basedOn = 'swing_low';
  } else {
    // Fallback: Entry - 0.8 ATR
    base = entry - (0.8 * atr);
    basedOn = 'atr';
  }

  // Small buffer below the level
  const buffer = 0.1 * atr;
  const stopLevel = base - buffer;

  return {
    level: round2(stopLevel),
    based_on: basedOn,
    buffer: round2(buffer),
    risk_per_share: round2(entry - stopLevel)
  };
}

/**
 * Calculate Target Zone for a BUY trade
 *
 * @param {Object} params
 * @param {number} params.entry - Entry price
 * @param {number} params.atr - 14-day ATR
 * @param {number} [params.r1] - Resistance 1 pivot level
 * @param {number} [params.high_20d] - 20-day high
 * @param {number} [params.stopLoss] - Stop loss level (for R:R calculation)
 * @returns {Object|null} Target zone
 */
export function calculateTargetZone({ entry, atr, r1, high_20d, stopLoss }) {
  if (!isNum(entry) || !isNum(atr)) {
    return null;
  }

  // Primary method: Use recent swing high or R1
  let base;
  let basedOn;

  if (isNum(high_20d) && high_20d > entry) {
    base = high_20d;
    basedOn = 'high_20d';
  } else if (isNum(r1) && r1 > entry) {
    base = r1;
    basedOn = 'r1';
  } else {
    // Fallback: Entry + 1.0 ATR
    base = entry + atr;
    basedOn = 'atr';
  }

  // Calculate reward
  const reward_per_share = base - entry;

  // Calculate R:R if stop loss provided
  let riskReward = null;
  if (isNum(stopLoss)) {
    const risk = entry - stopLoss;
    if (risk > 0) {
      riskReward = round2(reward_per_share / risk);
    }
  }

  return {
    level: round2(base),
    based_on: basedOn,
    reward_per_share: round2(reward_per_share),
    risk_reward: riskReward
  };
}

/**
 * Calculate complete trade zones (Entry, SL, Target)
 *
 * @param {Object} indicators - From indicators.js
 * @param {Object} levels - From levels.js
 * @returns {Object} Complete zone analysis
 */
export function calculate(indicators, levels) {
  const { ema20, atr, high_20d, low_20d, last } = indicators;
  const pivot = levels?.pivot;
  const s1 = levels?.s1;
  const r1 = levels?.r1;

  // Calculate entry zone
  const entryZone = calculateEntryZone({
    ema20,
    pivot,
    atr,
    currentPrice: last
  });

  if (!entryZone) {
    return { error: 'Insufficient data for zone calculation' };
  }

  // Calculate stop loss zone
  const stopLossZone = calculateStopLossZone({
    entry: entryZone.center,
    atr,
    s1,
    swing_low: low_20d
  });

  // Calculate target zone
  const targetZone = calculateTargetZone({
    entry: entryZone.center,
    atr,
    r1,
    high_20d,
    stopLoss: stopLossZone?.level
  });

  return {
    entry: entryZone,
    stopLoss: stopLossZone,
    target: targetZone,
    // Summary for quick access
    summary: {
      entry_center: entryZone.center,
      entry_range: `${entryZone.low} - ${entryZone.high}`,
      stop_loss: stopLossZone?.level,
      target: targetZone?.level,
      risk_reward: targetZone?.risk_reward
    }
  };
}

/**
 * Check if current price is in entry zone
 *
 * @param {number} currentPrice - Current price
 * @param {Object} entryZone - Entry zone from calculateEntryZone
 * @returns {Object} Zone status
 */
export function checkEntryZoneStatus(currentPrice, entryZone) {
  if (!isNum(currentPrice) || !entryZone || !isNum(entryZone.low) || !isNum(entryZone.high)) {
    return { error: 'Invalid inputs' };
  }

  const { low, high, center } = entryZone;

  // In zone
  if (currentPrice >= low && currentPrice <= high) {
    return {
      status: 'IN_ZONE',
      inZone: true,
      approaching: false,
      distance_pct: 0,
      direction: 'in_zone',
      message: `Price is in entry zone (${low} - ${high})`
    };
  }

  // Calculate distance
  let distance_pct;
  let direction;

  if (currentPrice > high) {
    // Price is above zone
    distance_pct = round2(((currentPrice - high) / currentPrice) * 100);
    direction = 'above';
  } else {
    // Price is below zone
    distance_pct = round2(((low - currentPrice) / currentPrice) * 100);
    direction = 'below';
  }

  // Approaching if within 2%
  const approaching = distance_pct <= 2;

  let status;
  let message;

  if (approaching) {
    status = 'APPROACHING';
    message = `Price is ${distance_pct}% ${direction} entry zone, approaching`;
  } else if (direction === 'above') {
    status = 'ABOVE_ZONE';
    message = `Price is ${distance_pct}% above entry zone - wait for pullback`;
  } else {
    status = 'BELOW_ZONE';
    message = `Price is ${distance_pct}% below entry zone`;
  }

  return {
    status,
    inZone: false,
    approaching,
    distance_pct,
    direction,
    message
  };
}

/**
 * Generate entry verdict based on zone status and market conditions
 *
 * @param {number} currentPrice - Current price
 * @param {Object} zones - Complete zones from calculate()
 * @returns {Object} Entry verdict
 */
export function generateEntryVerdict(currentPrice, zones) {
  if (!zones || zones.error) {
    return { verdict: 'SKIP', reason: 'Insufficient data for analysis' };
  }

  const zoneStatus = checkEntryZoneStatus(currentPrice, zones.entry);

  if (zoneStatus.error) {
    return { verdict: 'SKIP', reason: zoneStatus.error };
  }

  const { status, distance_pct, direction } = zoneStatus;

  // Generate verdict
  if (status === 'IN_ZONE') {
    return {
      verdict: 'READY',
      simple_verdict: `READY at ₹${zones.entry.center}`,
      reason: 'Price is in optimal entry zone',
      entry: zones.entry.center,
      stopLoss: zones.stopLoss?.level,
      target: zones.target?.level,
      riskReward: zones.target?.risk_reward
    };
  }

  if (status === 'APPROACHING') {
    return {
      verdict: 'WAIT',
      simple_verdict: `WAIT for ₹${zones.entry.center}`,
      reason: `Price approaching entry zone (${distance_pct}% ${direction})`,
      entry: zones.entry.center,
      stopLoss: zones.stopLoss?.level,
      target: zones.target?.level,
      riskReward: zones.target?.risk_reward
    };
  }

  if (status === 'ABOVE_ZONE') {
    return {
      verdict: 'WAIT',
      simple_verdict: `WAIT for ₹${zones.entry.center}`,
      reason: `Price is ${distance_pct}% above entry zone - wait for pullback`,
      entry: zones.entry.center,
      stopLoss: zones.stopLoss?.level,
      target: zones.target?.level,
      riskReward: zones.target?.risk_reward
    };
  }

  // Below zone
  return {
    verdict: 'CAUTION',
    simple_verdict: `CAUTION - below ₹${zones.entry.low}`,
    reason: `Price is ${distance_pct}% below entry zone - structure may be weakening`,
    entry: zones.entry.center,
    stopLoss: zones.stopLoss?.level,
    target: zones.target?.level,
    riskReward: zones.target?.risk_reward
  };
}

/**
 * Check gap condition at market open
 *
 * Helps user decide whether to proceed with a trade when price gaps
 * past the entry zone. Fits "validation partner" philosophy - surfaces
 * the situation clearly for manual decision.
 *
 * @param {Object} params
 * @param {number} params.previousClose - Previous day's close
 * @param {number} params.openPrice - Today's open price
 * @param {Object} params.entryZone - Entry zone from calculateEntryZone
 * @param {number} params.stopLoss - Stop loss level
 * @param {number} params.atr - 14-day ATR
 * @returns {Object} Gap analysis with verdict
 */
export function checkGapCondition({ previousClose, openPrice, entryZone, stopLoss, atr }) {
  if (!isNum(previousClose) || !isNum(openPrice) || !entryZone) {
    return { type: 'INVALID_DATA', verdict: 'SKIP', message: 'Insufficient data for gap analysis' };
  }

  const gapPct = round2(((openPrice - previousClose) / previousClose) * 100);
  const gapAbs = round2(openPrice - previousClose);

  // Gap up past entry zone high
  if (openPrice > entryZone.high) {
    const distanceAbovePct = round2(((openPrice - entryZone.high) / entryZone.high) * 100);

    if (distanceAbovePct > 2) {
      return {
        type: 'GAP_UP_PAST_ZONE',
        gapPct,
        gapAbs,
        distanceFromZonePct: distanceAbovePct,
        verdict: 'SKIP',
        message: 'Gapped too far above entry zone - wait for pullback or next setup',
        suggestion: 'Do not chase. If stock pulls back to entry zone later, reassess.'
      };
    } else {
      return {
        type: 'GAP_UP_SLIGHT',
        gapPct,
        gapAbs,
        distanceFromZonePct: distanceAbovePct,
        verdict: 'REASSESS',
        message: `Gapped ${distanceAbovePct}% above zone - watch first 15 mins for retest`,
        suggestion: 'Wait for first 15-min candle. If it retests entry zone, consider entry.'
      };
    }
  }

  // Gap down below stop loss - setup invalidated
  if (isNum(stopLoss) && openPrice < stopLoss) {
    return {
      type: 'GAP_DOWN_PAST_SL',
      gapPct,
      gapAbs,
      verdict: 'SKIP',
      message: 'Gapped below stop loss level - setup invalidated',
      suggestion: 'Structure broken. Remove from watchlist or wait for new setup.'
    };
  }

  // Gap down into entry zone (potentially good opportunity)
  if (openPrice < entryZone.low && (!isNum(stopLoss) || openPrice > stopLoss)) {
    return {
      type: 'GAP_DOWN_INTO_ZONE',
      gapPct,
      gapAbs,
      verdict: 'OPPORTUNITY',
      message: 'Gapped down into entry zone - validate with first candle',
      suggestion: 'Wait for first 15-min candle to close green before entering.'
    };
  }

  // Gap down but still in zone
  if (openPrice >= entryZone.low && openPrice <= entryZone.high) {
    return {
      type: 'OPEN_IN_ZONE',
      gapPct,
      gapAbs,
      verdict: 'READY',
      message: 'Opened within entry zone - good entry opportunity',
      suggestion: 'Consider entry on first 15-min candle confirmation.'
    };
  }

  // No significant gap (opened above zone but not by much, or normal open)
  if (Math.abs(gapPct) < 1) {
    return {
      type: 'NO_SIGNIFICANT_GAP',
      gapPct,
      gapAbs,
      verdict: 'PROCEED',
      message: 'Normal open - proceed with planned strategy',
      suggestion: null
    };
  }

  // Default: minor gap, proceed with caution
  return {
    type: 'MINOR_GAP',
    gapPct,
    gapAbs,
    verdict: 'PROCEED',
    message: `${gapPct > 0 ? 'Gap up' : 'Gap down'} of ${Math.abs(gapPct)}% - monitor closely`,
    suggestion: 'Watch price action in first 15 minutes before committing.'
  };
}

export default {
  calculateEntryZone,
  calculateStopLossZone,
  calculateTargetZone,
  calculate,
  checkEntryZoneStatus,
  generateEntryVerdict,
  checkGapCondition
};
