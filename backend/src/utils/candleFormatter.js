/**
 * Candle Formatter Utility
 *
 * Pure functions to format candle data from various sources (Upstox API, database)
 * into a consistent internal format.
 *
 * Supports both array format [timestamp, open, high, low, close, volume]
 * and object format { time/timestamp, open, high, low, close, volume }
 */

/**
 * Format a single candle into standard object format
 * @param {Array|Object} c - Candle data (array or object)
 * @returns {Object} Formatted candle object
 */
export function formatCandle(c) {
    return {
        timestamp: Array.isArray(c) ? c[0] : c.time || c.timestamp,
        open: Array.isArray(c) ? c[1] : c.open,
        high: Array.isArray(c) ? c[2] : c.high,
        low: Array.isArray(c) ? c[3] : c.low,
        close: Array.isArray(c) ? c[4] : c.close,
        volume: Array.isArray(c) ? c[5] : c.volume
    };
}

/**
 * Format an array of candles into standard object format
 * @param {Array} arr - Array of candle data
 * @returns {Array} Array of formatted candle objects
 */
export function formatCandles(arr = []) {
    return arr.map(formatCandle);
}
