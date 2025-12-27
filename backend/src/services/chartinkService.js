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
 * 1. BREAKOUT         Near 20-day HIGH + Volume 1.5x + RSI 55-70        │
│                                                                         │
│  2. PULLBACK         Near EMA 20 + RSI 40-55 (cooled off)              │
│                                                                         │
│  3. MOMENTUM         3-10% above EMA 20 + RSI 55-68                    │
│                                                                         │
│  4. CONSOLIDATION    Near 20-day HIGH + Tight range <2.5% + RSI 50-65  │
│                                                                         │
│  ALL SHARE:                                                             │
│  ├── EMA 20 > EMA 50 > SMA 200 (strong uptrend)                        │
│  ├── Avg Volume > 3 lakh (liquid)                                       │
│  └── Market Cap > 10,000 Cr (quality)              
 * 
 * 
 */
export const SCAN_QUERIES = {
  // Breakout Candidates - Near 20-day high with volume surge
  // EMA20 > EMA50 > SMA200, RSI 55-70, Volume 1.5x avg
breakout: `( {cash} (
    latest ema( close, 20 ) > latest ema( close, 50 )
    and latest ema( close, 50 ) > latest sma( close, 200 )
    and latest close > latest ema( close, 20 )
    and latest close >= max( 20, latest high ) * 0.97
    and latest close <= max( 20, latest high ) * 1.03
    and latest volume > 1.5 * latest sma( volume, 20 )
    and latest rsi( 14 ) > 55
    and latest rsi( 14 ) < 70
    and latest sma( volume, 20 ) > 300000
    and market cap > 10000
) )`,

  // Pullback to EMA20 - Price pulling back to support
  // Close within 3% of EMA20, RSI 40-55 (cooled off)
  pullback: `( {cash} (
    latest ema( close, 20 ) > latest ema( close, 50 )
    and latest ema( close, 50 ) > latest sma( close, 200 )
    and latest close >= latest ema( close, 20 ) * 0.97
    and latest close <= latest ema( close, 20 ) * 1.03
    and latest rsi( 14 ) >= 40
    and latest rsi( 14 ) <= 55
    and latest sma( volume, 20 ) > 300000
    and market cap > 10000
  ) )`,

  // Momentum with Volume - 3-10% above EMA20
  // Strong momentum stocks with RSI 55-68
  momentum: `( {cash} (
    latest ema( close, 20 ) > latest ema( close, 50 )
    and latest ema( close, 50 ) > latest sma( close, 200 )
    and latest close > latest ema( close, 20 ) * 1.03
    and latest close < latest ema( close, 20 ) * 1.10
    and latest rsi( 14 ) >= 55
    and latest rsi( 14 ) <= 68
    and latest sma( volume, 20 ) > 300000
    and market cap > 10000
  ) )`,

  // Consolidation Breakout - Near 20-day high with tight range
  // Range < 2.5%, RSI 50-65
  consolidation_breakout: `( {cash} (
    latest ema( close, 20 ) > latest ema( close, 50 )
    and latest ema( close, 50 ) > latest sma( close, 200 )
    and latest close > latest ema( close, 20 )
    and latest close >= max( 20, latest high ) * 0.97
    and latest close <= max( 20, latest high ) * 1.03
    and ( latest high - latest low ) < latest close * 0.025
    and latest rsi( 14 ) >= 50
    and latest rsi( 14 ) <= 65
    and latest sma( volume, 20 ) > 300000
    and market cap > 10000
) )`
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
 * Run breakout scan
 * @returns {Promise<Array>}
 */
export async function runBreakoutScan() {
  return runChartinkScan(SCAN_QUERIES.breakout);
}

/**
 * Run pullback scan
 * @returns {Promise<Array>}
 */
export async function runPullbackScan() {
  return runChartinkScan(SCAN_QUERIES.pullback);
}

/**
 * Run momentum scan
 * @returns {Promise<Array>}
 */
export async function runMomentumScan() {
  return runChartinkScan(SCAN_QUERIES.momentum);
}

/**
 * Run consolidation breakout scan
 * @returns {Promise<Array>}
 */
export async function runConsolidationScan() {
  return runChartinkScan(SCAN_QUERIES.consolidation_breakout);
}

/**
 * Run combined scan (breakout + pullback)
 * @returns {Promise<{ breakout: Array, pullback: Array, combined: Array }>}
 */
export async function runCombinedScan() {
  try {
    // Run scans sequentially to avoid rate limiting
    const breakoutResults = await runBreakoutScan();

    // Small delay between scans
    await new Promise(resolve => setTimeout(resolve, 1000));

    const pullbackResults = await runPullbackScan();

    // Combine and dedupe by nsecode
    const seen = new Set();
    const combined = [];

    // Add breakout results first (higher priority)
    for (const stock of breakoutResults) {
      if (!seen.has(stock.nsecode)) {
        seen.add(stock.nsecode);
        combined.push({ ...stock, scan_type: 'breakout' });
      }
    }

    // Add pullback results
    for (const stock of pullbackResults) {
      if (!seen.has(stock.nsecode)) {
        seen.add(stock.nsecode);
        combined.push({ ...stock, scan_type: 'pullback' });
      }
    }

    return {
      breakout: breakoutResults,
      pullback: pullbackResults,
      combined
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
  runBreakoutScan,
  runPullbackScan,
  runMomentumScan,
  runConsolidationScan,
  runCombinedScan,
  runCustomScan
};
