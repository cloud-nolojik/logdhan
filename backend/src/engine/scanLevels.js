/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SCAN-SPECIFIC LEVEL CALCULATOR
 * Entry/Target/StopLoss based on ChartInk scan type
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Core Principle: The entry strategy should match WHY the stock was found.
 *
 * ChartInk Scan Types:
 * - breakout: Stock coiled near 20D high with volume surge
 * - pullback: Stock pulled back to EMA20 support
 * - momentum: Stock already running (3-10% above EMA20)
 * - consolidation_breakout: Stock in tight range near highs
 */

import { round2, isNum } from './helpers.js';

/**
 * Round to nearest tick (0.05 for most Indian stocks)
 */
export function roundToTick(price, tick = 0.05) {
  if (!isNum(price)) return 0;
  return Math.round(price / tick) * tick;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAIN FUNCTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * @param {string} scanType - 'breakout' | 'pullback' | 'momentum' | 'consolidation_breakout'
 * @param {object} data - Required market data
 * @returns {object} Trading levels with validation
 */
export function calculateTradingLevels(scanType, data) {
  // ─────────────────────────────────────────────────────────────────────────
  // VALIDATE REQUIRED DATA
  // ─────────────────────────────────────────────────────────────────────────
  const validation = validateData(data);
  if (!validation.valid) {
    return validation;
  }

  const { atr } = data;

  let result;

  switch (scanType?.toLowerCase()) {
    case 'breakout':
      result = calculateBreakoutLevels(data);
      break;

    case 'pullback':
      result = calculatePullbackLevels(data);
      break;

    case 'momentum':
      result = calculateMomentumLevels(data);
      break;

    case 'consolidation_breakout':
      result = calculateConsolidationLevels(data);
      break;

    default:
      return {
        valid: false,
        reason: `Unknown scan type: ${scanType}`
      };
  }

  if (!result.valid) {
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // APPLY GUARDRAILS
  // ─────────────────────────────────────────────────────────────────────────
  const guarded = applyGuardrails(result.entry, result.stop, result.target, atr, scanType);

  if (!guarded.valid) {
    return {
      ...guarded,
      scanType,
      mode: result.mode,
      reason: guarded.reason,
      originalReason: result.reason
    };
  }

  return {
    valid: true,
    scanType,
    mode: result.mode,
    entry: roundToTick(guarded.entry),
    entryRange: result.entryRange ? [roundToTick(result.entryRange[0]), roundToTick(result.entryRange[1])] : null,
    stop: roundToTick(guarded.stop),
    target: roundToTick(guarded.target),
    entryType: result.entryType,
    archetype: result.archetype,
    reason: result.reason,
    riskReward: parseFloat(guarded.riskReward),
    riskPercent: parseFloat(guarded.riskPercent),
    rewardPercent: parseFloat(guarded.rewardPercent),
    adjustments: guarded.adjustments
  };
}

/**
 * Validate required data points
 */
function validateData(data) {
  if (!data) {
    return { valid: false, reason: 'No data provided' };
  }

  const { atr, ema20, fridayClose } = data;

  if (!isNum(atr) || atr <= 0) {
    return { valid: false, reason: 'ATR missing or invalid' };
  }

  if (!isNum(ema20) || ema20 <= 0) {
    return { valid: false, reason: 'EMA20 missing or invalid' };
  }

  if (!isNum(fridayClose) || fridayClose <= 0) {
    return { valid: false, reason: 'Friday close missing or invalid' };
  }

  return { valid: true };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BREAKOUT SCAN FORMULAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What ChartInk found:
 * - Stock coiled near 20-day high (97-103%)
 * - Volume surge (>1.5x average)
 * - RSI strong but not overbought (55-70)
 *
 * Strategy: Buy ABOVE resistance on breakout confirmation
 */
function calculateBreakoutLevels(data) {
  const { ema20, high20D, fridayHigh, fridayClose, atr } = data;

  // Use 20D high if available, otherwise Friday high
  const resistanceLevel = isNum(high20D) && high20D > 0 ? high20D : fridayHigh;

  if (!isNum(resistanceLevel) || resistanceLevel <= 0) {
    return { valid: false, reason: 'No resistance level available for breakout' };
  }

  // Entry: Above resistance with buffer for confirmation (0.2 ATR)
  const entry = resistanceLevel + (0.2 * atr);

  // Stop: Below breakout zone or EMA20, whichever is higher (tighter)
  // This protects against failed breakouts
  const breakoutZoneBottom = resistanceLevel * 0.97;
  const stopBase = Math.max(ema20, breakoutZoneBottom);
  const stop = stopBase - (0.1 * atr);

  // Calculate risk first
  const risk = entry - stop;

  // Target: Must be at least 1.5x the risk (minimum R:R of 1.5)
  // Use the larger of: 1.5x risk, or 2 ATR expansion
  const targetFromRisk = entry + (risk * 1.5);
  const targetFromATR = entry + (2.0 * atr);
  const target = Math.max(targetFromRisk, targetFromATR);

  // Entry range for slippage (0.3 ATR above entry)
  const entryRange = [roundToTick(entry), roundToTick(entry + 0.3 * atr)];

  return {
    valid: true,
    mode: 'BREAKOUT',
    archetype: 'breakout',
    entry,
    entryRange,
    stop,
    target,
    entryType: 'buy_above',
    reason: `Breakout setup: Price coiled near ${round2(resistanceLevel)} with volume. ` +
            `Entry triggers above resistance for confirmation.`
  };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PULLBACK SCAN FORMULAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What ChartInk found:
 * - Stock in uptrend (EMA20 > EMA50 > SMA200)
 * - Pulled back to EMA20 support (97-103%)
 * - RSI cooled off (40-55)
 *
 * Strategy: AUTOMATICALLY decides between:
 * - AGGRESSIVE (LIMIT at EMA20) - when pullback is healthy
 * - CONSERVATIVE (BUY_ABOVE) - when pullback needs confirmation
 */
function calculatePullbackLevels(data) {
  const {
    ema20,
    high20D,
    fridayHigh,
    fridayClose,
    fridayVolume,
    avgVolume20,
    atr,
    rsi
  } = data;

  // ─────────────────────────────────────────────────────────────────────────
  // DECISION LOGIC: Aggressive vs Conservative
  // ─────────────────────────────────────────────────────────────────────────

  // Rule 1: Distance from EMA20 (most important)
  // If price is within 0.4 ATR of EMA20, it's respecting support
  const distanceATR = Math.abs(fridayClose - ema20) / atr;

  // Rule 2: Volume behavior (if available)
  // Low volume pullback = controlled profit-taking (good)
  // High volume pullback = institutional selling (bad)
  const hasVolumeData = isNum(fridayVolume) && isNum(avgVolume20) && avgVolume20 > 0;
  const volumeRatio = hasVolumeData ? fridayVolume / avgVolume20 : 1.0;

  // Rule 3: Price position relative to EMA20
  // Close above EMA20 = buyers still in control
  const aboveEMA = fridayClose >= ema20;

  // Rule 4: RSI behavior (if available)
  // RSI 45-55 = controlled cooldown
  // RSI < 45 = momentum may have broken
  const hasRSI = isNum(rsi);
  const rsiHealthy = !hasRSI || rsi >= 45;

  // DECISION: All conditions must be met for aggressive mode
  const isHealthyPullback = (
    distanceATR <= 0.4 &&
    volumeRatio < 1.3 &&
    aboveEMA &&
    rsiHealthy
  );

  let entry, stop, target, entryType, entryRange, reason, mode;

  if (isHealthyPullback) {
    // ─────────────────────────────────────────────────────────────────────
    // AGGRESSIVE MODE: Buy the dip with limit order
    // ─────────────────────────────────────────────────────────────────────

    // Entry: At EMA20, but cap at 0.3% below (don't go too deep)
    const maxDip = ema20 * 0.003; // 0.3% of EMA20
    const dipAmount = Math.min(0.1 * atr, maxDip);
    entry = ema20 - dipAmount;

    // Entry range: Slightly above and below EMA20
    entryRange = [roundToTick(ema20 - 0.3 * atr), roundToTick(ema20 + 0.3 * atr)];

    // Stop: Below EMA20 support
    stop = ema20 - (0.6 * atr);

    // Target: Previous high or EMA20 + 1.2 ATR
    const targetFromHigh = isNum(high20D) && high20D > entry ? high20D : entry + (1.2 * atr);
    target = Math.max(targetFromHigh, ema20 + (1.2 * atr));

    entryType = 'limit';
    mode = 'PULLBACK_AGGRESSIVE';
    reason = 'Healthy pullback: Price respecting EMA20, RSI cooled, low volume. ' +
             'Safe to buy the dip with limit order.';
  } else {
    // ─────────────────────────────────────────────────────────────────────
    // CONSERVATIVE MODE: Wait for confirmation
    // ─────────────────────────────────────────────────────────────────────

    if (!isNum(fridayHigh) || fridayHigh <= 0) {
      return { valid: false, reason: 'Friday high required for conservative pullback entry' };
    }

    // Entry: Above Friday high = bounce confirmed
    entry = fridayHigh + (0.1 * atr);

    // Entry range for slippage
    entryRange = [roundToTick(entry), roundToTick(entry + 0.3 * atr)];

    // Stop: Below EMA20 support
    stop = ema20 - (0.6 * atr);

    // Target: Previous high or entry + 1.2 ATR
    const targetFromHigh = isNum(high20D) && high20D > entry ? high20D : entry + (1.2 * atr);
    target = Math.max(targetFromHigh, entry + (1.2 * atr));

    entryType = 'buy_above';
    mode = 'PULLBACK_CONSERVATIVE';
    reason = buildConservativeReason(distanceATR, rsi, fridayClose, ema20, volumeRatio);
  }

  return {
    valid: true,
    mode,
    archetype: 'pullback',
    entry,
    entryRange,
    stop,
    target,
    entryType,
    reason
  };
}

/**
 * Build explanation for why conservative mode was chosen
 */
function buildConservativeReason(distanceATR, rsi, close, ema20, volumeRatio) {
  const reasons = [];

  if (distanceATR > 0.4) {
    reasons.push(`Price ${round2(distanceATR)} ATR from EMA20 (not holding cleanly)`);
  }
  if (isNum(rsi) && rsi < 45) {
    reasons.push(`RSI ${round2(rsi)} shows weak momentum`);
  }
  if (close < ema20) {
    reasons.push('Closed below EMA20 support');
  }
  if (volumeRatio >= 1.3) {
    reasons.push(`High volume (${round2(volumeRatio)}x avg) selling pressure`);
  }

  if (reasons.length === 0) {
    reasons.push('Pullback needs confirmation');
  }

  return 'Conservative entry: ' + reasons.join('. ') + '. ' +
         'Entry triggers above Friday high for safety.';
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MOMENTUM SCAN FORMULAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What ChartInk found:
 * - Stock already running (3-10% above EMA20)
 * - Strong RSI (55-68)
 * - Has room to run
 *
 * Strategy: Continuation entry above recent high
 * NOTE: If already within 2% of 20D high, treat as BREAKOUT instead
 */
function calculateMomentumLevels(data) {
  const { ema20, high20D, fridayHigh, fridayClose, atr } = data;

  if (!isNum(fridayHigh) || fridayHigh <= 0) {
    return { valid: false, reason: 'Friday high required for momentum entry' };
  }

  // Edge case: If close is within 2% of 20D high, this is more breakout than momentum
  const nearBreakout = isNum(high20D) && fridayClose >= high20D * 0.98;

  if (nearBreakout) {
    // Redirect to breakout logic with modified reason
    const breakoutLevels = calculateBreakoutLevels(data);
    if (breakoutLevels.valid) {
      breakoutLevels.mode = 'MOMENTUM_NEAR_BREAKOUT';
      breakoutLevels.reason = 'Momentum stock near 20D high - treating as breakout. ' +
                              breakoutLevels.reason;
    }
    return breakoutLevels;
  }

  // Entry: Above Friday high for continuation (don't chase)
  const entry = fridayHigh + (0.15 * atr);

  // Entry range for slippage
  const entryRange = [roundToTick(entry), roundToTick(entry + 0.3 * atr)];

  // Stop: Back to EMA20 means momentum lost
  // But also cap at 1.2 ATR from entry (for high-ATR stocks)
  const ema20Stop = ema20 - (0.1 * atr);
  const atrStop = entry - (1.2 * atr);
  const stop = Math.max(ema20Stop, atrStop);

  // Calculate risk first
  const risk = entry - stop;

  // Target: Push toward new highs, but ensure minimum 1.5x risk
  const targetFromHigh = isNum(high20D) ? high20D * 1.05 : entry + (1.5 * atr);
  const targetFromATR = entry + (1.5 * atr);
  const targetFromRisk = entry + (risk * 1.5);  // Minimum 1.5 R:R
  const target = Math.max(targetFromHigh, targetFromATR, targetFromRisk);

  return {
    valid: true,
    mode: 'MOMENTUM',
    archetype: 'trend-follow',
    entry,
    entryRange,
    stop,
    target,
    entryType: 'buy_above',
    reason: `Momentum continuation: Stock running ${round2(((fridayClose - ema20) / ema20) * 100)}% above EMA20. ` +
            `Entry above Friday high (${round2(fridayHigh)}) confirms continued buying.`
  };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONSOLIDATION BREAKOUT SCAN FORMULAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What ChartInk found:
 * - Stock in tight range near highs (range < 2.5%)
 * - Coiled energy (low volatility = big move coming)
 * - RSI neutral (50-65)
 *
 * Strategy: Buy above consolidation range, target range expansion
 */
function calculateConsolidationLevels(data) {
  const { ema20, high10D, low10D, fridayHigh, fridayLow, atr } = data;

  if (!isNum(fridayHigh) || !isNum(fridayLow) || fridayHigh <= 0 || fridayLow <= 0) {
    return { valid: false, reason: 'Friday high/low required for consolidation entry' };
  }

  const fridayRange = fridayHigh - fridayLow;

  // Use 10-day range if available, otherwise use Friday range
  const has10DRange = isNum(high10D) && isNum(low10D) && high10D > low10D;
  const range10D = has10DRange ? (high10D - low10D) : fridayRange;

  // Entry: Just above the tight range (small buffer since range is already tight)
  const entry = fridayHigh + (0.1 * atr);

  // Entry range for slippage
  const entryRange = [roundToTick(entry), roundToTick(entry + 0.2 * atr)];

  // Stop: Below the consolidation range (pattern fails if broken)
  const consolidationLow = has10DRange ? Math.min(low10D, fridayLow) : fridayLow;
  const stop = consolidationLow - (0.1 * atr);

  // Target: Range expansion - tight ranges lead to big moves
  // Use largest of: 60% of 10D range, 2x Friday range, or 1.5 ATR
  const rangeExpansion = Math.max(
    range10D * 0.6,
    fridayRange * 2,
    1.5 * atr
  );
  const target = entry + rangeExpansion;

  return {
    valid: true,
    mode: 'CONSOLIDATION_BREAKOUT',
    archetype: 'breakout',
    entry,
    entryRange,
    stop,
    target,
    entryType: 'buy_above',
    reason: `Consolidation breakout: Tight range (${round2((fridayRange / fridayHigh) * 100)}%) near highs signals energy buildup. ` +
            `Expecting ${round2((rangeExpansion / entry) * 100)}% range expansion on breakout.`
  };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GUARDRAILS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These guards REJECT invalid trades rather than adjusting stops
 * (adjusting stops breaks structural logic)
 */
function applyGuardrails(entry, stop, target, atr, scanType) {
  const adjustments = [];

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD A: Sanity check - all values must be positive
  // ─────────────────────────────────────────────────────────────────────────
  if (!isNum(entry) || !isNum(stop) || !isNum(target)) {
    return {
      valid: false,
      reason: 'Invalid levels calculated (missing values)',
      debug: { entry, stop, target }
    };
  }

  if (entry <= 0 || stop <= 0 || target <= 0) {
    return {
      valid: false,
      reason: 'Invalid levels calculated (zero or negative values)',
      debug: { entry, stop, target }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD B: Stop MUST be below entry (for BUY setups)
  // ─────────────────────────────────────────────────────────────────────────
  if (stop >= entry) {
    return {
      valid: false,
      reason: `Stop (${round2(stop)}) must be below entry (${round2(entry)})`,
      debug: { entry, stop, target }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD C: Target MUST be above entry (for BUY setups)
  // ─────────────────────────────────────────────────────────────────────────
  if (target <= entry) {
    return {
      valid: false,
      reason: `Target (${round2(target)}) must be above entry (${round2(entry)})`,
      debug: { entry, stop, target }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD D: Maximum risk check (5%) - REJECT, don't adjust
  // ─────────────────────────────────────────────────────────────────────────
  const risk = entry - stop;
  const riskPercent = (risk / entry) * 100;
  const MAX_RISK_PERCENT = 5.0;

  if (riskPercent > MAX_RISK_PERCENT) {
    return {
      valid: false,
      reason: `Risk too high: ${round2(riskPercent)}% (max ${MAX_RISK_PERCENT}%). ` +
              `Either reduce position size or skip this setup.`,
      riskPercent: round2(riskPercent),
      suggestedAction: 'skip_or_reduce_size'
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD E: Minimum risk check (0.5%) - avoid noise stops
  // ─────────────────────────────────────────────────────────────────────────
  const MIN_RISK_PERCENT = 0.5;

  if (riskPercent < MIN_RISK_PERCENT) {
    return {
      valid: false,
      reason: `Risk too small: ${round2(riskPercent)}% (min ${MIN_RISK_PERCENT}%). ` +
              `Stop is too close to entry - likely to trigger on noise.`,
      riskPercent: round2(riskPercent),
      suggestedAction: 'widen_stop_or_skip'
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD F: Minimum target (2%) - worth the effort
  // ─────────────────────────────────────────────────────────────────────────
  const reward = target - entry;
  const rewardPercent = (reward / entry) * 100;
  const MIN_TARGET_PERCENT = 2.0;

  if (rewardPercent < MIN_TARGET_PERCENT) {
    return {
      valid: false,
      reason: `Target too close: ${round2(rewardPercent)}% (min ${MIN_TARGET_PERCENT}%). ` +
              `Not worth the swing trade effort.`,
      rewardPercent: round2(rewardPercent),
      suggestedAction: 'skip_this_setup'
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD G: Maximum target (15%) - realistic for 1-2 week swing
  // ─────────────────────────────────────────────────────────────────────────
  const MAX_TARGET_PERCENT = 15.0;
  let adjustedTarget = target;

  if (rewardPercent > MAX_TARGET_PERCENT) {
    adjustedTarget = entry * (1 + MAX_TARGET_PERCENT / 100);
    adjustments.push(`Target capped from ${round2(rewardPercent)}% to ${MAX_TARGET_PERCENT}% (realistic for swing)`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD H: Risk-Reward ratio check (minimum 1.2:1)
  // ─────────────────────────────────────────────────────────────────────────
  const adjustedReward = adjustedTarget - entry;
  const riskReward = adjustedReward / risk;
  const MIN_RR = 1.2;

  if (riskReward < MIN_RR) {
    const minimumViableTarget = entry + (risk * 1.5);
    return {
      valid: false,
      reason: `R:R too low: ${round2(riskReward)}:1 (min ${MIN_RR}:1). ` +
              `Risk ${round2(riskPercent)}% vs Reward ${round2((adjustedReward / entry) * 100)}%`,
      currentRR: round2(riskReward),
      suggestedTarget: roundToTick(minimumViableTarget),
      suggestedAction: `Need target >= ${round2(minimumViableTarget)} for viable trade`
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Calculate final metrics
  // ─────────────────────────────────────────────────────────────────────────
  const finalRewardPercent = ((adjustedTarget - entry) / entry) * 100;

  return {
    valid: true,
    entry,
    stop,
    target: adjustedTarget,
    riskReward: round2(riskReward),
    riskPercent: round2(riskPercent),
    rewardPercent: round2(finalRewardPercent),
    adjustments: adjustments.length > 0 ? adjustments : undefined
  };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPORTS
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default {
  calculateTradingLevels,
  calculateBreakoutLevels,
  calculatePullbackLevels,
  calculateMomentumLevels,
  calculateConsolidationLevels,
  applyGuardrails,
  roundToTick
};
