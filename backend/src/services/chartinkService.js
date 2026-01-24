/**
 * ChartInk Service
 *
 * Fetches scan results from ChartInk programmatically.
 * Uses their web interface with CSRF token handling.
 */

import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

// Create axios instance with cookie jar support
const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

const CHARTINK_BASE_URL = 'https://chartink.com';
const SCAN_URL = `${CHARTINK_BASE_URL}/screener/process`;

/**
 * Pre-defined scan queries for swing trading
 *
 * ACTIVE SCAN:
 * - A+ Momentum: Uptrend + 3% weekly gain + near 20d high + RSI 55-75
 *
 * COMMENTED OUT (legacy scans):
 * - BREAKOUT: Near 20-day HIGH + Volume 1.5x + RSI 55-70
 * - PULLBACK: Near EMA 20 + RSI 40-55 (cooled off)
 * - MOMENTUM: 3-10% above EMA 20 + RSI 55-68
 * - CONSOLIDATION: Near 20-day HIGH + Tight range <2.5% + RSI 50-65
 */
export const SCAN_QUERIES = {
  // A+ Momentum - 52-week high breakout stocks with volume surge
  // Matches ChartInk scan: 52w high + Volume 1.5x (50-day) + RSI 55-75 + EMA20>EMA50 + 2% weekly gain
  a_plus_momentum: `( {cash} ( latest close > max( 252, high ) and latest volume > latest sma( volume, 50 ) * 1.5 and latest close > latest sma( close, 200 ) and latest rsi( 14 ) > 55 and latest rsi( 14 ) < 75 and latest ema( close, 20 ) > latest ema( close, 50 ) and market cap > 1000 and latest close > 100 and latest close > 1 week ago close * 1.02 ) )`,

//   a_plus_nextweek: `( {cash} (
//   /* Trend filter */
//   latest ema( close, 20 ) > latest ema( close, 50 )
//   and latest ema( close, 50 ) > latest sma( close, 200 )
//   and latest close > latest ema( close, 20 )

//   /* True compression: NR7 */
//   and latest range < min( 7, range )

//   /* Tight 10-day base (optional but powerful) */
//   and ( max( 10, high ) - min( 10, low ) ) < latest close * 0.06

//   /* Strong close near the top of the day */
//   and latest close >= latest high * 0.98
//   and latest close > latest open

//   /* Volume confirmation (not crazy spike, but demand present) */
//   and latest volume > 1.2 * latest sma( volume, 20 )

//   /* Momentum not overheated */
//   and latest rsi( 14 ) >= 52
//   and latest rsi( 14 ) <= 66

//   /* Tradability */
//   and latest sma( volume, 20 ) > 500000
//   and market cap > 10000
// ) )`
  

//   a_plus_momentum: `( {cash} (
//   /* Trend filter */
//   latest ema( close, 20 ) > latest ema( close, 50 )
//   and latest ema( close, 50 ) > latest sma( close, 200 )
//   and latest close > latest ema( close, 20 )

//   /* True compression: NR7 */
//   and latest range < min( 7, range )

//   /* Tight 10-day base (optional but powerful) */
//   and ( max( 10, high ) - min( 10, low ) ) < latest close * 0.06

//   /* Strong close near the top of the day */
//   and latest close >= latest high * 0.98
//   and latest close > latest open

//   /* Volume confirmation (not crazy spike, but demand present) */
//   and latest volume > 1.2 * latest sma( volume, 20 )

//   /* Momentum not overheated */
//   and latest rsi( 14 ) >= 52
//   and latest rsi( 14 ) <= 66

//   /* Tradability */
//   and latest sma( volume, 20 ) > 500000
//   and market cap > 10000
// ) )`

  // // Breakout Candidates - Near 20-day high with volume surge
  // // EMA20 > EMA50 > SMA200, RSI 55-70, Volume 1.5x avg
  // breakout: `( {cash} (
  //     latest ema( close, 20 ) > latest ema( close, 50 )
  //     and latest ema( close, 50 ) > latest sma( close, 200 )
  //     and latest close > latest ema( close, 20 )
  //     and latest close >= max( 20, latest high ) * 0.97
  //     and latest close <= max( 20, latest high ) * 1.03
  //     and latest volume > 1.5 * latest sma( volume, 20 )
  //     and latest rsi( 14 ) > 55
  //     and latest rsi( 14 ) < 70
  //     and latest sma( volume, 20 ) > 300000
  //     and market cap > 10000
  // ) )`,

  // // Pullback to EMA20 - Price pulling back to support
  // // Close within 3% of EMA20, RSI 40-55 (cooled off)
  // pullback: `( {cash} (
  //   latest ema( close, 20 ) > latest ema( close, 50 )
  //   and latest ema( close, 50 ) > latest sma( close, 200 )
  //   and latest close >= latest ema( close, 20 ) * 0.97
  //   and latest close <= latest ema( close, 20 ) * 1.03
  //   and latest rsi( 14 ) >= 40
  //   and latest rsi( 14 ) <= 55
  //   and latest sma( volume, 20 ) > 300000
  //   and market cap > 10000
  // ) )`,

  // // Momentum with Volume - 3-10% above EMA20
  // // Strong momentum stocks with RSI 55-68
  // momentum: `( {cash} (
  //   latest ema( close, 20 ) > latest ema( close, 50 )
  //   and latest ema( close, 50 ) > latest sma( close, 200 )
  //   and latest close > latest ema( close, 20 ) * 1.03
  //   and latest close < latest ema( close, 20 ) * 1.10
  //   and latest rsi( 14 ) >= 55
  //   and latest rsi( 14 ) <= 68
  //   and latest sma( volume, 20 ) > 300000
  //   and market cap > 10000
  // ) )`,

  // // Consolidation Breakout - Near 20-day high with tight range
  // // Range < 2.5%, RSI 50-65
  // consolidation_breakout: `( {cash} (
  //   latest ema( close, 20 ) > latest ema( close, 50 )
  //   and latest ema( close, 50 ) > latest sma( close, 200 )
  //   and latest close > latest ema( close, 20 )
  //   and latest close >= max( 20, latest high ) * 0.97
  //   and latest close <= max( 20, latest high ) * 1.03
  //   and ( latest high - latest low ) < latest close * 0.025
  //   and latest rsi( 14 ) >= 50
  //   and latest rsi( 14 ) <= 65
  //   and latest sma( volume, 20 ) > 300000
  //   and market cap > 10000
  // ) )`
};

/**
 * Get CSRF token from ChartInk
 * @returns {Promise<string>} CSRF token
 */
async function getChartinkSession() {
  try {
    const response = await client.get(`${CHARTINK_BASE_URL}/screener`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });

    // Extract CSRF token from the HTML
    const csrfMatch = response.data.match(/name="csrf-token"\s+content="([^"]+)"/);
    if (!csrfMatch) {
      throw new Error('Could not extract CSRF token from ChartInk');
    }

    return csrfMatch[1];
  } catch (error) {
    console.error('Error getting ChartInk session:', error.message);
    throw new Error(`ChartInk session error: ${error.message}`);
  }
}

/**
 * Run a scan query on ChartInk
 * @param {string} scanQuery - The ChartInk scan query
 * @returns {Promise<Array<{ nsecode: string, bsecode: string, name: string, per_change: number, close: number, volume: number }>>}
 */
export async function runChartinkScan(scanQuery) {
  try {
    const csrfToken = await getChartinkSession();

    const response = await client.post(SCAN_URL,
      `scan_clause=${encodeURIComponent(scanQuery)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-CSRF-Token': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Referer': `${CHARTINK_BASE_URL}/screener`
        }
      }
    );

    if (response.data && response.data.data) {
      return response.data.data.map(stock => ({
        nsecode: stock.nsecode || stock[0],
        bsecode: stock.bsecode || stock[1],
        name: stock.name || stock[2],
        per_change: parseFloat(stock.per_chg || stock[3]) || 0,
        close: parseFloat(stock.close || stock[4]) || 0,
        volume: parseInt(stock.volume || stock[5]) || 0
      }));
    }

    return [];
  } catch (error) {
    console.error('Error running ChartInk scan:', error.message);
    throw new Error(`ChartInk scan error: ${error.message}`);
  }
}

/**
 * Run A+ Next Week scan (primary scan)
 * @returns {Promise<Array>}
 */
export async function runAPlusNextWeekScan() {
  return runChartinkScan(SCAN_QUERIES.a_plus_momentum);
}

// Legacy scan functions - commented out
// /**
//  * Run breakout scan
//  * @returns {Promise<Array>}
//  */
// export async function runBreakoutScan() {
//   return runChartinkScan(SCAN_QUERIES.breakout);
// }

// /**
//  * Run pullback scan
//  * @returns {Promise<Array>}
//  */
// export async function runPullbackScan() {
//   return runChartinkScan(SCAN_QUERIES.pullback);
// }

// /**
//  * Run momentum scan
//  * @returns {Promise<Array>}
//  */
// export async function runMomentumScan() {
//   return runChartinkScan(SCAN_QUERIES.momentum);
// }

// /**
//  * Run consolidation breakout scan
//  * @returns {Promise<Array>}
//  */
// export async function runConsolidationScan() {
//   return runChartinkScan(SCAN_QUERIES.consolidation_breakout);
// }

/**
 * Run combined scan - now just runs A+ Next Week
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

/**
 * Run a custom scan query
 * @param {string} query - Custom ChartInk query
 * @param {string} [name='custom'] - Name for the scan
 * @returns {Promise<Array>}
 */
export async function runCustomScan(query, name = 'custom') {
  const results = await runChartinkScan(query);
  return results.map(stock => ({ ...stock, scan_type: name }));
}

export default {
  SCAN_QUERIES,
  runChartinkScan,
  runAPlusNextWeekScan,
  runCombinedScan,
  runCustomScan
  // Legacy exports - commented out
  // runBreakoutScan,
  // runPullbackScan,
  // runMomentumScan,
  // runConsolidationScan,
};
