/**
 * Price Levels Module
 *
 * Single source of truth for pivot points, support, and resistance calculations.
 */

import { round2, isNum } from './helpers.js';

/**
 * Calculate Classic (Floor) Pivot Points
 *
 * Standard pivot point formula used by floor traders.
 * Reference: https://www.investopedia.com/articles/forex/05/fxpivots.asp
 *
 * @param {number} prevHigh - Previous session high
 * @param {number} prevLow - Previous session low
 * @param {number} prevClose - Previous session close
 * @returns {Object|null} Pivot levels or null if invalid inputs
 */
export function calcClassicPivots(prevHigh, prevLow, prevClose) {
  if (!isNum(prevHigh) || !isNum(prevLow) || !isNum(prevClose)) {
    return null;
  }

  const P = (prevHigh + prevLow + prevClose) / 3;

  return {
    pivot: round2(P),
    r1: round2((2 * P) - prevLow),
    r2: round2(P + (prevHigh - prevLow)),
    r3: round2(prevHigh + 2 * (P - prevLow)),
    s1: round2((2 * P) - prevHigh),
    s2: round2(P - (prevHigh - prevLow)),
    s3: round2(prevLow - 2 * (prevHigh - P))
  };
}

/**
 * Calculate Fibonacci Pivot Points
 *
 * Uses Fibonacci retracement levels for support/resistance.
 *
 * @param {number} prevHigh - Previous session high
 * @param {number} prevLow - Previous session low
 * @param {number} prevClose - Previous session close
 * @returns {Object|null} Fibonacci pivot levels
 */
export function calcFibonacciPivots(prevHigh, prevLow, prevClose) {
  if (!isNum(prevHigh) || !isNum(prevLow) || !isNum(prevClose)) {
    return null;
  }

  const P = (prevHigh + prevLow + prevClose) / 3;
  const range = prevHigh - prevLow;

  return {
    pivot: round2(P),
    r1: round2(P + (0.382 * range)),
    r2: round2(P + (0.618 * range)),
    r3: round2(P + range),
    s1: round2(P - (0.382 * range)),
    s2: round2(P - (0.618 * range)),
    s3: round2(P - range)
  };
}

/**
 * Calculate Camarilla Pivot Points
 *
 * Tighter support/resistance levels for intraday trading.
 *
 * @param {number} prevHigh - Previous session high
 * @param {number} prevLow - Previous session low
 * @param {number} prevClose - Previous session close
 * @returns {Object|null} Camarilla pivot levels
 */
export function calcCamarillaPivots(prevHigh, prevLow, prevClose) {
  if (!isNum(prevHigh) || !isNum(prevLow) || !isNum(prevClose)) {
    return null;
  }

  const range = prevHigh - prevLow;

  return {
    pivot: round2((prevHigh + prevLow + prevClose) / 3),
    r1: round2(prevClose + (range * 1.1 / 12)),
    r2: round2(prevClose + (range * 1.1 / 6)),
    r3: round2(prevClose + (range * 1.1 / 4)),
    r4: round2(prevClose + (range * 1.1 / 2)),
    s1: round2(prevClose - (range * 1.1 / 12)),
    s2: round2(prevClose - (range * 1.1 / 6)),
    s3: round2(prevClose - (range * 1.1 / 4)),
    s4: round2(prevClose - (range * 1.1 / 2))
  };
}

/**
 * Calculate all pivot types from indicators
 *
 * @param {Object} indicators - Calculated indicators with prev_high, prev_low, prev_close
 * @returns {Object} All pivot calculations
 */
export function calculate(indicators) {
  const { prev_high, prev_low, prev_close } = indicators;

  const classic = calcClassicPivots(prev_high, prev_low, prev_close);

  return {
    classic,
    // Use classic as default
    pivot: classic?.pivot,
    r1: classic?.r1,
    r2: classic?.r2,
    r3: classic?.r3,
    s1: classic?.s1,
    s2: classic?.s2,
    s3: classic?.s3
  };
}

/**
 * Identify key support levels from indicators and pivots
 *
 * @param {Object} indicators - Calculated indicators
 * @param {Object} pivots - Calculated pivots
 * @returns {Array<Object>} Sorted support levels (closest to price first)
 */
export function identifySupportLevels(indicators, pivots) {
  const { last, ema20, sma200, low_20d } = indicators;
  const supports = [];

  // Add pivot supports
  if (pivots) {
    if (isNum(pivots.s1) && pivots.s1 < last) {
      supports.push({ level: pivots.s1, type: 'pivot_s1', strength: 'medium' });
    }
    if (isNum(pivots.s2) && pivots.s2 < last) {
      supports.push({ level: pivots.s2, type: 'pivot_s2', strength: 'medium' });
    }
    if (isNum(pivots.pivot) && pivots.pivot < last) {
      supports.push({ level: pivots.pivot, type: 'pivot', strength: 'high' });
    }
  }

  // Add moving average supports
  if (isNum(ema20) && ema20 < last) {
    supports.push({ level: ema20, type: 'ema20', strength: 'high' });
  }
  if (isNum(sma200) && sma200 < last) {
    supports.push({ level: sma200, type: 'sma200', strength: 'very_high' });
  }

  // Add swing low
  if (isNum(low_20d) && low_20d < last) {
    supports.push({ level: low_20d, type: 'swing_low_20d', strength: 'medium' });
  }

  // Sort by distance from current price (closest first)
  return supports.sort((a, b) => b.level - a.level);
}

/**
 * Identify key resistance levels from indicators and pivots
 *
 * @param {Object} indicators - Calculated indicators
 * @param {Object} pivots - Calculated pivots
 * @returns {Array<Object>} Sorted resistance levels (closest to price first)
 */
export function identifyResistanceLevels(indicators, pivots) {
  const { last, high_20d } = indicators;
  const resistances = [];

  // Add pivot resistances
  if (pivots) {
    if (isNum(pivots.r1) && pivots.r1 > last) {
      resistances.push({ level: pivots.r1, type: 'pivot_r1', strength: 'medium' });
    }
    if (isNum(pivots.r2) && pivots.r2 > last) {
      resistances.push({ level: pivots.r2, type: 'pivot_r2', strength: 'medium' });
    }
  }

  // Add swing high
  if (isNum(high_20d) && high_20d > last) {
    resistances.push({ level: high_20d, type: 'swing_high_20d', strength: 'high' });
  }

  // Sort by distance from current price (closest first)
  return resistances.sort((a, b) => a.level - b.level);
}

/**
 * Find nearest support level
 *
 * @param {Object} indicators - Calculated indicators
 * @param {Object} pivots - Calculated pivots
 * @returns {Object|null} Nearest support level
 */
export function findNearestSupport(indicators, pivots) {
  const supports = identifySupportLevels(indicators, pivots);
  return supports.length > 0 ? supports[0] : null;
}

/**
 * Find nearest resistance level
 *
 * @param {Object} indicators - Calculated indicators
 * @param {Object} pivots - Calculated pivots
 * @returns {Object|null} Nearest resistance level
 */
export function findNearestResistance(indicators, pivots) {
  const resistances = identifyResistanceLevels(indicators, pivots);
  return resistances.length > 0 ? resistances[0] : null;
}

/**
 * Calculate price position relative to key levels
 *
 * @param {Object} indicators - Calculated indicators
 * @param {Object} pivots - Calculated pivots
 * @returns {Object} Position analysis
 */
export function analyzePricePosition(indicators, pivots) {
  const { last, ema20, sma200, high_20d, low_20d } = indicators;

  if (!isNum(last)) {
    return { error: 'No current price available' };
  }

  const position = {
    current_price: last,
    above_ema20: isNum(ema20) ? last > ema20 : null,
    above_sma200: isNum(sma200) ? last > sma200 : null,
    above_pivot: pivots?.pivot ? last > pivots.pivot : null,
    near_20d_high: isNum(high_20d) ? ((high_20d - last) / last * 100) <= 2 : null,
    near_20d_low: isNum(low_20d) ? ((last - low_20d) / last * 100) <= 2 : null
  };

  // Determine overall position
  if (position.above_ema20 && position.above_sma200 && position.above_pivot) {
    position.overall = 'STRONG_BULLISH';
  } else if (position.above_ema20 && position.above_pivot) {
    position.overall = 'BULLISH';
  } else if (!position.above_ema20 && !position.above_pivot) {
    position.overall = 'BEARISH';
  } else {
    position.overall = 'NEUTRAL';
  }

  return position;
}

export default {
  calcClassicPivots,
  calcFibonacciPivots,
  calcCamarillaPivots,
  calculate,
  identifySupportLevels,
  identifyResistanceLevels,
  findNearestSupport,
  findNearestResistance,
  analyzePricePosition
};
