/**
 * Instrument Key Sync Service
 *
 * Downloads the latest instrument master from Upstox and updates the Stock collection.
 * Ensures instrument_key values stay current when Upstox changes them
 * (corporate actions, ISIN changes, etc.)
 *
 * URLs:
 *   NSE: https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz
 *   BSE: https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz
 */

import axios from 'axios';
import zlib from 'zlib';
import { promisify } from 'util';
import Stock from '../models/stock.js';

const gunzip = promisify(zlib.gunzip);

const LOG = '[INSTRUMENT-SYNC]';
const BASE_URL = 'https://assets.upstox.com/market-quote/instruments/exchange';
const BATCH_SIZE = 1000;

/**
 * Download and parse gzipped JSON instrument file from Upstox
 * @param {string} exchange - 'NSE' or 'BSE'
 * @returns {Array} Parsed instrument array (equity only)
 */
async function downloadAndParse(exchange) {
  const url = `${BASE_URL}/${exchange}.json.gz`;
  console.log(`${LOG} Downloading ${url}...`);

  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60000
  });

  const decompressed = await gunzip(response.data);
  const instruments = JSON.parse(decompressed.toString());

  // Filter equity segment only
  const segmentFilter = `${exchange}_EQ`;
  const equityStocks = instruments.filter(i => i.segment === segmentFilter);

  console.log(`${LOG} ${exchange}: ${instruments.length} total → ${equityStocks.length} equity`);
  return equityStocks;
}

/**
 * Format instrument data for Stock DB (matches migrateStocksToDb.js field mapping)
 */
function formatStock(stock, exchange) {
  return {
    segment: stock.segment,
    name: stock.name || '',
    exchange: stock.exchange || exchange,
    isin: stock.isin || null,
    instrument_type: stock.instrument_type || '',
    instrument_key: stock.instrument_key,
    lot_size: stock.lot_size || 1,
    freeze_quantity: stock.freeze_quantity || null,
    exchange_token: stock.exchange_token || '',
    tick_size: stock.tick_size || 0.05,
    trading_symbol: stock.trading_symbol || '',
    short_name: stock.short_name || null,
    qty_multiplier: stock.qty_multiplier || 1,
    is_active: true
  };
}

/**
 * Sync instruments for a single exchange
 * @param {string} exchange - 'NSE' or 'BSE'
 * @returns {Object} { updated, deactivated }
 */
async function syncExchange(exchange) {
  const instruments = await downloadAndParse(exchange);

  if (instruments.length === 0) {
    console.warn(`${LOG} ${exchange}: No instruments returned — skipping to avoid data loss`);
    return { updated: 0, deactivated: 0 };
  }

  // Batch upsert
  const formatted = instruments.map(i => formatStock(i, exchange));
  let totalUpdated = 0;

  for (let i = 0; i < formatted.length; i += BATCH_SIZE) {
    const batch = formatted.slice(i, i + BATCH_SIZE);
    const result = await Stock.bulkUpsert(batch);
    totalUpdated += (result.modifiedCount || 0) + (result.upsertedCount || 0);
  }

  // Deactivate stocks that are no longer in the instrument file
  const activeKeys = new Set(instruments.map(i => i.instrument_key));
  const segment = `${exchange}_EQ`;
  const dbStocks = await Stock.find({ segment, is_active: true }).select('instrument_key').lean();

  const keysToDeactivate = dbStocks
    .filter(s => !activeKeys.has(s.instrument_key))
    .map(s => s.instrument_key);

  let deactivated = 0;
  if (keysToDeactivate.length > 0) {
    const result = await Stock.updateMany(
      { instrument_key: { $in: keysToDeactivate } },
      { $set: { is_active: false, last_updated: new Date() } }
    );
    deactivated = result.modifiedCount || 0;
    console.log(`${LOG} ${exchange}: Deactivated ${deactivated} stocks no longer in instrument file`);
  }

  console.log(`${LOG} ${exchange}: Updated/added ${totalUpdated}, deactivated ${deactivated}`);
  return { updated: totalUpdated, deactivated };
}

/**
 * Run full instrument sync for NSE and BSE
 * @returns {Object} Summary stats
 */
async function runSync() {
  const startTime = Date.now();
  console.log(`${LOG} Starting instrument key sync...`);

  try {
    const nse = await syncExchange('NSE');
    const bse = await syncExchange('BSE');

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`${LOG} Sync complete in ${elapsed}s — NSE: ${nse.updated} updated/${nse.deactivated} deactivated, BSE: ${bse.updated} updated/${bse.deactivated} deactivated`);

    return { nse, bse, elapsed };
  } catch (error) {
    console.error(`${LOG} Sync failed:`, error.message);
    throw error;
  }
}

export { runSync, syncExchange, downloadAndParse };
export default { runSync, syncExchange, downloadAndParse };
