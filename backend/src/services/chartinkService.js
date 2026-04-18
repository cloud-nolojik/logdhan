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

// Create axios instance with cookie jar support.
// 12-second per-request timeout — ChartInk responds in 1–3s normally; anything
// over 10s is a hang. Without this, a hung request blocks for the OS TCP
// timeout (~60–120s) and poisons Step 0 of the daily pipeline.
const jar = new CookieJar();
const client = wrapper(axios.create({
  jar,
  timeout: 12000,
}));

const CHARTINK_BASE_URL = 'https://chartink.com';
const SCAN_URL = `${CHARTINK_BASE_URL}/screener/process`;

// Network-level error codes we treat as transient and retry with backoff.
const RETRIABLE_NET_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);
const MAX_NET_RETRIES = 2;    // up to 3 attempts total (1 + 2 retries)
const BACKOFF_BASE_MS = 500;  // 500ms, 1500ms

const CHARTINK_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

/**
 * Get CSRF token from ChartInk.
 * Tries two known regex patterns — ChartInk has historically used both.
 *
 * @param {boolean} forceFresh - clear cookie jar + retry fresh
 * @returns {Promise<string>} CSRF token
 */
async function getChartinkSession(forceFresh = false) {
  if (forceFresh) {
    try { await jar.removeAllCookies(); } catch (_) { /* ignore */ }
  }
  const response = await client.get(`${CHARTINK_BASE_URL}/screener`, { headers: CHARTINK_HEADERS });
  const html = response.data || '';

  // Pattern 1: <meta name="csrf-token" content="...">
  // Pattern 2: <meta content="..." name="csrf-token"> (attributes reversed)
  const patterns = [
    /name="csrf-token"\s+content="([^"]+)"/,
    /content="([^"]+)"\s+name="csrf-token"/,
    /"csrf[_-]?token"\s*:\s*"([^"]+)"/i,  // JSON-embedded fallback
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  throw new Error(`Could not extract CSRF token from ChartInk (html length=${html.length}, first 120 chars: "${html.slice(0, 120).replace(/\s+/g, ' ')}")`);
}

/**
 * Run a scan query on ChartInk.
 *
 * Retry behavior:
 *   - HTTP 419 (Page Expired / session expired) → clear cookie jar, re-handshake, retry once.
 *   - HTTP 429 (rate-limited) → surface the error; caller should back off.
 *   - Other errors → thrown as-is.
 *
 * @param {string} scanQuery
 * @returns {Promise<Array<{ nsecode, bsecode, name, per_change, close, volume }>>}
 */
export async function runChartinkScan(scanQuery) {
  return _runChartinkScanWithRetry(scanQuery, /* netAttempt */ 0, /* sessionRefreshed */ false);
}

async function _runChartinkScanWithRetry(scanQuery, netAttempt, sessionRefreshed) {
  try {
    const csrfToken = await getChartinkSession(sessionRefreshed);
    const response = await client.post(SCAN_URL,
      `scan_clause=${encodeURIComponent(scanQuery)}`,
      {
        headers: {
          ...CHARTINK_HEADERS,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-CSRF-Token': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Referer': `${CHARTINK_BASE_URL}/screener`,
        },
      }
    );

    if (response.data && response.data.data) {
      return response.data.data.map(stock => ({
        nsecode: stock.nsecode || stock[0],
        bsecode: stock.bsecode || stock[1],
        name: stock.name || stock[2],
        per_change: parseFloat(stock.per_chg || stock[3]) || 0,
        close: parseFloat(stock.close || stock[4]) || 0,
        volume: parseInt(stock.volume || stock[5]) || 0,
      }));
    }
    console.log('[CHARTINK] No data in response');
    return [];

  } catch (error) {
    const status = error?.response?.status;
    const code = error?.code;

    // 419 = session expired. Clear cookie jar, re-handshake, retry once.
    if (status === 419 && !sessionRefreshed) {
      console.warn('[CHARTINK] 419 Page Expired — clearing session cookies + retrying once');
      return _runChartinkScanWithRetry(scanQuery, netAttempt, /* sessionRefreshed */ true);
    }

    // Transient network errors (ETIMEDOUT, ECONNRESET, etc.) — retry with exponential backoff.
    if (RETRIABLE_NET_CODES.has(code) && netAttempt < MAX_NET_RETRIES) {
      const delay = BACKOFF_BASE_MS * Math.pow(2, netAttempt); // 500ms, 1000ms
      console.warn(`[CHARTINK] Network error (${code}), attempt ${netAttempt + 1}/${MAX_NET_RETRIES + 1} — retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return _runChartinkScanWithRetry(scanQuery, netAttempt + 1, sessionRefreshed);
    }

    if (status) {
      console.error(`[CHARTINK] Error running scan (HTTP ${status}): ${error.message}`);
    } else {
      console.error(`[CHARTINK] Error running scan: ${error.message}`);
    }
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
