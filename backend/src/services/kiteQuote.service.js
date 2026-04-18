/**
 * Kite Quote Service
 *
 * Thin wrapper around kiteAutoLoginService.getQuote() for batched full-quote
 * fetches. Batches into chunks of 500 (Kite's max per /quote call), merges the
 * responses into a single keyed map.
 *
 * Used by preopenDepthJob at 09:12:30 IST to snapshot pre-open depth for the
 * day's shortlist candidates.
 */

import kiteAutoLoginService from './kiteAutoLogin.service.js';

const LOG = '[KITE-QUOTE]';
const MAX_PER_CALL = 500;

/**
 * Fetch full quotes (depth + buy/sell qty + OHLC) for the given instruments.
 *
 * @param {string[]} instruments — array of 'NSE:SYMBOL' strings
 * @returns {Promise<Object>}     — { 'NSE:INFY': { depth, buy_quantity, ... }, ... }
 *                                  Missing symbols are simply absent from the result.
 */
export async function fetchQuotes(instruments) {
  if (!Array.isArray(instruments) || instruments.length === 0) {
    return {};
  }

  const unique = [...new Set(instruments)];
  const batches = [];
  for (let i = 0; i < unique.length; i += MAX_PER_CALL) {
    batches.push(unique.slice(i, i + MAX_PER_CALL));
  }

  console.log(`${LOG} fetchQuotes: ${unique.length} instruments in ${batches.length} batch(es)`);
  const merged = {};
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    try {
      const resp = await kiteAutoLoginService.getQuote(batch);
      if (resp?.status === 'success' && resp.data) {
        Object.assign(merged, resp.data);
      } else {
        console.warn(`${LOG} batch ${i + 1}/${batches.length} returned non-success: ${resp?.status}`);
      }
    } catch (err) {
      console.error(`${LOG} batch ${i + 1}/${batches.length} failed: ${err.message}`);
      // Continue with remaining batches — partial result is better than none.
    }
  }

  const returnedKeys = Object.keys(merged).length;
  console.log(`${LOG} fetchQuotes done: ${returnedKeys}/${unique.length} resolved`);
  return merged;
}

/**
 * Convenience: given trading symbols (without exchange prefix), build Kite keys
 * and fetch. Defaults to NSE exchange.
 *
 * @param {string[]} symbols    — e.g. ['INFY', 'ICICIBANK']
 * @param {string} exchange     — default 'NSE'
 */
export async function fetchQuotesForSymbols(symbols, exchange = 'NSE') {
  const instruments = symbols.filter(Boolean).map(s => `${exchange}:${s}`);
  return fetchQuotes(instruments);
}

export default { fetchQuotes, fetchQuotesForSymbols };
