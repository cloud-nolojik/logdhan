/**
 * Timeframe Mapping Constants
 *
 * Centralized mapping of internal timeframe notation (15m, 1h, 1d) to
 * Upstox API format (unit + interval).
 *
 * Usage:
 * - Use TIMEFRAME_TO_UPSTOX for building URLs (e.g., historical-candle/NSE_EQ|INE467B01029/minutes/15)
 * - Use TIMEFRAME_TO_UPSTOX_INTERVAL for incremental updates (e.g., '15minute', '60minute', 'day')
 */

/**
 * Map timeframes to Upstox API format { unit, interval }
 * Used for building API URLs
 */
export const TIMEFRAME_TO_UPSTOX = {
    '1m': { unit: 'minutes', interval: '1' },
    '15m': { unit: 'minutes', interval: '15' },
    '1h': { unit: 'hours', interval: '1' },
    '1d': { unit: 'days', interval: '1' }
};

/**
 * Map timeframes to Upstox interval strings
 * Used for incremental data fetching
 */
export const TIMEFRAME_TO_UPSTOX_INTERVAL = {
    '15m': '15minute',
    '1h': '60minute',
    '1d': 'day'
};

/**
 * Map Upstox interval strings back to standard timeframes
 * Used for converting API responses
 */
export const UPSTOX_INTERVAL_TO_TIMEFRAME = {
    '15minute': '15m',
    '60minute': '1h',
    'day': '1d'
};
