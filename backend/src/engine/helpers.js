/**
 * Shared Utility Functions for Calculation Engine
 *
 * Single source of truth for common helpers used across all engine modules.
 */

/**
 * Round to 2 decimal places
 * @param {number} x - Value to round
 * @returns {number} Rounded value or original if not a valid number
 */
export function round2(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  return Math.round(x * 100) / 100;
}

/**
 * Check if value is a valid number
 * @param {*} x - Value to check
 * @returns {boolean}
 */
export function isNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Clamp a value between min and max
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum bound
 * @param {number} max - Maximum bound
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (!isNum(value)) return value;
  return Math.max(min, Math.min(max, value));
}

/**
 * Safe get nested property from object
 * @param {Object} obj - Object to get property from
 * @param {string} path - Dot-separated path (e.g., "a.b.c")
 * @param {*} defaultValue - Default value if not found
 * @returns {*}
 */
export function get(obj, path, defaultValue = undefined) {
  if (!obj || typeof path !== 'string') return defaultValue;
  const keys = path.split('.');
  let result = obj;
  for (const key of keys) {
    if (result === null || result === undefined) return defaultValue;
    result = result[key];
  }
  return result !== undefined ? result : defaultValue;
}

/**
 * Normalize candles to standard object format
 * Supports both array format [timestamp, open, high, low, close, volume]
 * and object format { timestamp, open, high, low, close, volume }
 *
 * @param {Array} candles - Array of candles in any format
 * @returns {Array<Object>} Normalized candles sorted oldest-first
 */
export function normalizeCandles(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return [];
  }

  const normalized = candles.map(candle => {
    if (Array.isArray(candle)) {
      // Array format: [timestamp, open, high, low, close, volume]
      return {
        timestamp: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5] || 0
      };
    } else if (typeof candle === 'object' && candle !== null) {
      // Object format - normalize keys
      return {
        timestamp: candle.timestamp || candle.time || candle.date,
        open: candle.open || candle.o,
        high: candle.high || candle.h,
        low: candle.low || candle.l,
        close: candle.close || candle.c,
        volume: candle.volume || candle.vol || candle.v || 0
      };
    }
    return null;
  }).filter(c => c !== null);

  // Sort oldest first (ascending by timestamp)
  return normalized.sort((a, b) => {
    const timeA = new Date(a.timestamp).getTime();
    const timeB = new Date(b.timestamp).getTime();
    return timeA - timeB;
  });
}

/**
 * Extract OHLCV arrays from normalized candles
 * @param {Array<Object>} candles - Normalized candles
 * @returns {Object} { opens, highs, lows, closes, volumes }
 */
export function extractOHLCV(candles) {
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];

  for (const candle of candles) {
    opens.push(candle.open);
    highs.push(candle.high);
    lows.push(candle.low);
    closes.push(candle.close);
    volumes.push(candle.volume);
  }

  return { opens, highs, lows, closes, volumes };
}

/**
 * Calculate percentage change
 * @param {number} current - Current value
 * @param {number} previous - Previous value
 * @returns {number} Percentage change
 */
export function percentChange(current, previous) {
  if (!isNum(current) || !isNum(previous) || previous === 0) {
    return 0;
  }
  return round2(((current - previous) / previous) * 100);
}

/**
 * Calculate percentage distance between two values
 * @param {number} value - Current value
 * @param {number} reference - Reference value
 * @returns {number} Percentage distance
 */
export function percentDistance(value, reference) {
  if (!isNum(value) || !isNum(reference) || reference === 0) {
    return 0;
  }
  return round2(((value - reference) / reference) * 100);
}

/**
 * Get the last N elements from an array
 * @param {Array} arr - Array
 * @param {number} n - Number of elements
 * @returns {Array}
 */
export function lastN(arr, n) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(-n);
}

/**
 * Get the last element from an array
 * @param {Array} arr - Array
 * @returns {*}
 */
export function last(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  return arr[arr.length - 1];
}

/**
 * Find maximum value in array
 * @param {Array<number>} arr - Array of numbers
 * @returns {number}
 */
export function max(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  return Math.max(...arr.filter(isNum));
}

/**
 * Find minimum value in array
 * @param {Array<number>} arr - Array of numbers
 * @returns {number}
 */
export function min(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  return Math.min(...arr.filter(isNum));
}

/**
 * Calculate average of array
 * @param {Array<number>} arr - Array of numbers
 * @returns {number}
 */
export function average(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const valid = arr.filter(isNum);
  if (valid.length === 0) return 0;
  return round2(valid.reduce((sum, v) => sum + v, 0) / valid.length);
}

export default {
  round2,
  isNum,
  clamp,
  get,
  normalizeCandles,
  extractOHLCV,
  percentChange,
  percentDistance,
  lastN,
  last,
  max,
  min,
  average
};
