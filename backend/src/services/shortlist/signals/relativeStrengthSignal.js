/**
 * Relative strength signal — stock's 5-day return minus Nifty's 5-day return,
 * z-scored across the whole universe.
 *
 * Why: intraday winners almost always come from the top-quartile RS cohort.
 * Stocks that have been outperforming Nifty for a week carry momentum into the
 * session open. Z-scoring across the universe means the signal is always
 * comparable regardless of overall market volatility.
 */

import { getCandleData } from '../../technicalData.service.js';

const LOG = '[shortlist/rs]';

// Nifty 50 index for benchmark return
const NIFTY_INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const NIFTY_SYMBOL = 'NIFTY';

/**
 * Compute n-day return from a candles array.
 * Candles format (Upstox): [[timestamp, open, high, low, close, volume], ...]
 * Most recent candle is typically at index 0 OR last; we handle both.
 */
function nDayReturn(candles, n) {
  if (!Array.isArray(candles) || candles.length < n + 1) return null;

  // Detect ordering: if first timestamp > last timestamp, it's descending (newest first)
  const t0 = candles[0]?.[0];
  const tLast = candles[candles.length - 1]?.[0];
  const descending = t0 && tLast && new Date(t0).getTime() > new Date(tLast).getTime();

  const newest = descending ? candles[0] : candles[candles.length - 1];
  const nBack  = descending ? candles[n] : candles[candles.length - 1 - n];

  const newestClose = newest?.[4];
  const nBackClose  = nBack?.[4];
  if (!newestClose || !nBackClose) return null;

  return ((newestClose - nBackClose) / nBackClose) * 100;
}

/**
 * Fetch Nifty's 5-day return. Used as benchmark.
 */
export async function fetchNiftyReturn5d() {
  try {
    const candles = await getCandleData(NIFTY_INSTRUMENT_KEY, NIFTY_SYMBOL, '1d', { allowOutdated: true });
    const r = nDayReturn(candles, 5);
    if (r === null) {
      return { status: 'failed', niftyReturn5d: null, warning: 'Nifty candles insufficient' };
    }
    return { status: 'ok', niftyReturn5d: r };
  } catch (err) {
    console.warn(`${LOG} Nifty return fetch failed: ${err.message}`);
    return { status: 'failed', niftyReturn5d: null, warning: `Nifty candles error: ${err.message}` };
  }
}

/**
 * Compute 5-day return for one stock. Returns null if data unavailable.
 */
export async function fetchStockReturn5d(instrumentKey, symbol) {
  try {
    const candles = await getCandleData(instrumentKey, symbol, '1d', { allowOutdated: true });
    return nDayReturn(candles, 5);
  } catch (err) {
    // Don't crash on individual stock failures — return null, orchestrator handles
    return null;
  }
}

/**
 * Compute z-scores of (stock_return - nifty_return) across the universe.
 *
 * @param {Array<{symbol, stockReturn5d}>} rows
 * @param {number} niftyReturn5d
 * @returns {Map<symbol, zScore>}
 */
export function computeRsZScores(rows, niftyReturn5d) {
  const deltas = rows
    .filter(r => r.stockReturn5d !== null && r.stockReturn5d !== undefined)
    .map(r => ({ symbol: r.symbol, delta: r.stockReturn5d - niftyReturn5d }));

  if (deltas.length === 0) return new Map();

  const mean = deltas.reduce((s, r) => s + r.delta, 0) / deltas.length;
  const variance =
    deltas.reduce((s, r) => s + (r.delta - mean) ** 2, 0) / deltas.length;
  const std = Math.sqrt(variance) || 1; // avoid div-by-zero on pathological data

  const zMap = new Map();
  for (const r of deltas) {
    zMap.set(r.symbol, Number(((r.delta - mean) / std).toFixed(3)));
  }
  return zMap;
}

/**
 * Score one stock's RS z-score into a normalized [0, 1] contribution.
 *
 * z >= +1.5  → 1.0 (top ~7% of universe)
 * z >= +1.0  → 0.75
 * z >= +0.5  → 0.5
 * z >= 0     → 0.25
 * z <  0     → 0 (below average)
 *
 * Sign of z (not magnitude) indicates long-preference. For short candidates,
 * orchestrator flips the z sign before calling this.
 */
export function scoreRs(z) {
  if (z === null || z === undefined) return null;
  if (z >= 1.5) return 1.0;
  if (z >= 1.0) return 0.75;
  if (z >= 0.5) return 0.5;
  if (z >= 0)   return 0.25;
  return 0;
}

export default { fetchNiftyReturn5d, fetchStockReturn5d, computeRsZScores, scoreRs };
