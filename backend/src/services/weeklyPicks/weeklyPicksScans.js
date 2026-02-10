/**
 * Weekly Picks Scan Definitions
 *
 * ChartInk scan queries and convenience functions for weekly swing picks.
 * Only 2 active scans: A+ Momentum (52W breakout) and Pullback (EMA20 retest).
 */

import { runChartinkScan } from '../chartinkService.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SCAN QUERIES
// ═══════════════════════════════════════════════════════════════════════════════

export const WEEKLY_SCAN_QUERIES = {
  // A+ Momentum - 52-week high breakout stocks with volume surge
  // Matches ChartInk scan: 52w high + Volume 1.5x (50-day) + RSI 55-75 + EMA20>EMA50 + 2% weekly gain
  a_plus_momentum: `( {cash} ( latest close > 1 day ago max( 252, high ) and latest volume > latest sma( volume, 50 ) * 1.5 and latest close > latest sma( close, 200 ) and latest rsi( 14 ) > 55 and latest rsi( 14 ) < 75 and latest ema( close, 20 ) > latest ema( close, 50 ) and market cap > 1000 and latest close > 100 and latest close > 1 week ago close * 1.02 ) )`,

  // Pullback to EMA20 - Price retesting EMA20 support with low volume
  // Within 2% of EMA20, EMA20>EMA50>SMA200, RSI 40-58, volume below 50-day avg
  pullback: `( {cash} ( 1 day ago max( 60, high ) / latest close < 1.08 and latest low <= latest ema( close, 20 ) * 1.02 and latest low >= latest ema( close, 20 ) * 0.98 and latest close >= latest ema( close, 20 ) and latest close > latest sma( close, 200 ) and latest ema( close, 20 ) > latest ema( close, 50 ) and latest ema( close, 50 ) > latest sma( close, 200 ) and latest rsi( 14 ) > 40 and latest rsi( 14 ) < 58 and latest volume < latest sma( volume, 50 ) * 0.9 and latest close > 1 week ago close * 0.99 and latest close > latest open and latest close >= latest high * 0.98 and market cap > 1000 and latest close > 50 ) )`,
};

// ═══════════════════════════════════════════════════════════════════════════════
// SCAN LABELS & ARCHETYPE MAPPING
// ═══════════════════════════════════════════════════════════════════════════════

export const WEEKLY_SCAN_LABELS = {
  a_plus_momentum: 'A+ Momentum (52W Breakout)',
  pullback: 'Pullback to EMA20',
};

export const WEEKLY_SCAN_ARCHETYPE = {
  a_plus_momentum: '52w_breakout',
  pullback: 'pullback',
};

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE SCAN FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run A+ Momentum scan (52-week high breakout)
 * @returns {Promise<Array>}
 */
export async function runAPlusNextWeekScan() {
  return runChartinkScan(WEEKLY_SCAN_QUERIES.a_plus_momentum);
}

/**
 * Run pullback scan (EMA20 retest)
 * @returns {Promise<Array>}
 */
export async function runPullbackScan() {
  return runChartinkScan(WEEKLY_SCAN_QUERIES.pullback);
}

/**
 * Run combined scan - runs A+ Momentum
 * @returns {Promise<{ a_plus_momentum: Array, combined: Array }>}
 */
export async function runCombinedScan() {
  try {
    const results = await runAPlusNextWeekScan();

    return {
      a_plus_momentum: results,
      combined: results.map(stock => ({ ...stock, scan_type: 'a_plus_momentum' }))
    };
  } catch (error) {
    console.error('Error running combined scan:', error.message);
    throw error;
  }
}

export default {
  WEEKLY_SCAN_QUERIES,
  WEEKLY_SCAN_LABELS,
  WEEKLY_SCAN_ARCHETYPE,
  runAPlusNextWeekScan,
  runPullbackScan,
  runCombinedScan,
};
