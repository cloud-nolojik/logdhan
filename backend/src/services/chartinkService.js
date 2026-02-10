/**
 * ChartInk Service
 *
 * Generic ChartInk API wrapper. Fetches scan results programmatically.
 * Uses their web interface with CSRF token handling.
 *
 * Weekly scan queries are in weeklyPicks/weeklyPicksScans.js
 * Daily scan queries are in dailyPicks/dailyPicksScans.js
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
    console.log('[CHARTINK] Running scan...');
    console.log('[CHARTINK] Query:', scanQuery.substring(0, 100) + '...');

    const csrfToken = await getChartinkSession();
    console.log('[CHARTINK] Got CSRF token');

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

    console.log('[CHARTINK] Response status:', response.status);
    console.log('[CHARTINK] Raw data count:', response.data?.data?.length || 0);

    if (response.data && response.data.data) {
      const results = response.data.data.map(stock => ({
        nsecode: stock.nsecode || stock[0],
        bsecode: stock.bsecode || stock[1],
        name: stock.name || stock[2],
        per_change: parseFloat(stock.per_chg || stock[3]) || 0,
        close: parseFloat(stock.close || stock[4]) || 0,
        volume: parseInt(stock.volume || stock[5]) || 0
      }));

      // Log each stock found
      console.log('[CHARTINK] Stocks found:');
      results.forEach((stock, i) => {
        console.log(`[CHARTINK]    ${i + 1}. ${stock.nsecode} (${stock.name}) - ${stock.close} | ${stock.per_change}%`);
      });

      return results;
    }

    console.log('[CHARTINK] No data in response');
    return [];
  } catch (error) {
    console.error('[CHARTINK] Error running scan:', error.message);
    throw new Error(`ChartInk scan error: ${error.message}`);
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
  runChartinkScan,
  runCustomScan,
};
