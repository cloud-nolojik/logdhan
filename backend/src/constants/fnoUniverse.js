/**
 * F&O Universe — NSE equities with listed derivatives.
 *
 * Derived dynamically from two authoritative sources:
 *   1. src/data/NSE.json   — Upstox instrument master (has all NSE_FO segment rows
 *                            with their underlying_symbol → gives us F&O eligibility)
 *   2. stocks collection   — Mongoose Stock model (has all active cash equities
 *                            with their instrument_key, name, etc. → gives us
 *                            tradeable metadata)
 *
 * We join the two: "which cash equities (NSE_EQ) have a corresponding NSE_FO entry
 * as underlying_symbol." That's the F&O universe, sourced from what's actually in
 * the system rather than a hand-maintained list.
 *
 * Cached in-memory after first load. The instrument master is static per-session;
 * NSE.json only changes when the Upstox instrument sync runs (typically daily).
 *
 * This is the entry pool for the 8:30 AM shortlist-heavy scan.
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const NSE_INSTRUMENT_MASTER = path.resolve(__dirname, '../data/NSE.json');

// In-memory cache — keyed by a timestamp so we can invalidate if needed
let _fnoSymbolsCache = null;
let _fnoSymbolsCacheAt = 0;
const FNO_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours (plenty — list changes at most daily)

/**
 * Read NSE.json and extract the set of equity symbols that have F&O derivatives.
 *
 * Filters:
 *   - segment === 'NSE_FO'
 *   - underlying_type === 'EQUITY' (or asset_type === 'EQUITY' as fallback)
 *   - exclude NSE test symbols (pattern: /NSETEST$/)
 */
async function loadFnoSymbolsFromInstrumentMaster() {
  if (_fnoSymbolsCache && Date.now() - _fnoSymbolsCacheAt < FNO_CACHE_TTL_MS) {
    return _fnoSymbolsCache;
  }

  const raw = await readFile(NSE_INSTRUMENT_MASTER, 'utf8');
  const data = JSON.parse(raw);

  const set = new Set();
  for (const r of data) {
    if (r.segment !== 'NSE_FO') continue;
    if (r.underlying_type !== 'EQUITY' && r.asset_type !== 'EQUITY') continue;
    const sym = r.underlying_symbol;
    if (!sym) continue;
    if (/NSETEST$/i.test(sym)) continue; // filter NSE test rows
    set.add(sym.toUpperCase());
  }

  _fnoSymbolsCache = set;
  _fnoSymbolsCacheAt = Date.now();
  console.log(`[fnoUniverse] loaded ${set.size} F&O underlyings from instrument master`);
  return set;
}

/**
 * Return the set of F&O-eligible trading symbols.
 * Exported for callers that only need the symbol list (e.g. tests, filters).
 */
export async function getFnoSymbols() {
  const set = await loadFnoSymbolsFromInstrumentMaster();
  return Array.from(set);
}

/**
 * Join F&O eligibility against the Stock collection to return full tradeable rows.
 *
 * @param {import('mongoose').Model} Stock - Mongoose Stock model (pass in to keep this module DB-agnostic)
 * @returns {Promise<Array<{trading_symbol, name, instrument_key, segment}>>}
 */
export async function getFnoUniverse(Stock) {
  const fnoSet = await loadFnoSymbolsFromInstrumentMaster();
  const symbols = Array.from(fnoSet);

  const stocks = await Stock.find({
    trading_symbol: { $in: symbols },
    is_active: true,
    segment: 'NSE_EQ'
  })
    .select('trading_symbol name instrument_key segment')
    .lean();

  // Sanity check: warn if instrument master has F&O symbols not present in Stock collection.
  // This usually means the Stock collection needs a refresh from the instrument master.
  if (stocks.length < fnoSet.size * 0.8) {
    const found = new Set(stocks.map(s => s.trading_symbol.toUpperCase()));
    const missing = symbols.filter(s => !found.has(s)).slice(0, 10);
    console.warn(
      `[fnoUniverse] only ${stocks.length}/${fnoSet.size} F&O symbols found in Stock collection. ` +
      `Sample missing: ${missing.join(',')}. Consider re-running the instrument sync.`
    );
  }

  return stocks;
}

/**
 * Invalidate the cache (call after re-running the Upstox instrument sync).
 */
export function invalidateFnoCache() {
  _fnoSymbolsCache = null;
  _fnoSymbolsCacheAt = 0;
}

export default { getFnoSymbols, getFnoUniverse, invalidateFnoCache };
