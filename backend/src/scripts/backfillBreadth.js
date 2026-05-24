/**
 * Backfill breadth — walks N trading days back, computing % Nifty 500
 * above 50-DMA for each day using existing Upstox historical candles.
 *
 * Heavy: ~500 stocks × N days of candle queries. Use with care.
 *
 * Usage: node src/scripts/backfillBreadth.js 400
 */

import '../loadEnv.js';
import mongoose from 'mongoose';
import BreadthDaily from '../models/breadthDaily.js';
import candleFetcherService from '../services/candleFetcher.service.js';
import { BREADTH_DMA_WINDOW } from '../constants/regimeConstants.js';

async function main() {
  const daysBack = Number(process.argv[2] || 400);
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error('[backfill breadth] MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  const Stock = (await import('../models/stock.js')).default;
  // Primary universe: Nifty 500. If the `indices` field isn't populated
  // (as is the case in this Mongo as of May 2026), fall back to the F&O
  // universe — any stock that has at least one daily candle in
  // `prefetcheddatas` qualifies. That gives ~400 stocks, which is enough
  // for breadth to be meaningful (% above 50-DMA of liquid F&O names).
  let universe = await Stock.find({ indices: 'NIFTY500' }).lean();
  let universeSource = 'NIFTY500 (stocks.indices)';
  if (universe.length === 0) {
    console.warn(`[backfill breadth] NIFTY500 membership not in stocks collection — falling back to F&O universe via prefetcheddatas`);
    const fnoSymbols = await mongoose.connection.collection('prefetcheddatas')
      .distinct('instrument_key', { timeframe: '1d' });
    universe = await Stock.find({ instrument_key: { $in: fnoSymbols } }).lean();
    universeSource = `F&O fallback (${fnoSymbols.length} symbols with 1d data)`;
  }
  console.log(`[backfill breadth] universe=${universe.length} (${universeSource})`);
  if (universe.length === 0) {
    console.error('[backfill breadth] ABORT: no universe — neither NIFTY500 membership nor 1d candles in DB');
    await mongoose.disconnect();
    process.exit(1);
  }

  // For each stock, pull daily candles. Prefer reading directly from
  // `prefetcheddatas` (DB-only, no API calls) since the F&O universe is
  // already populated by prefetchAllStockData.js. Falls back to
  // candleFetcherService if a stock isn't in prefetcheddatas yet.
  const prefetchedColl = mongoose.connection.collection('prefetcheddatas');
  const seriesBySymbol = {};
  let loaded = 0;
  for (const s of universe) {
    try {
      // Try DB cache first
      const pre = await prefetchedColl.findOne({
        instrument_key: s.instrument_key,
        timeframe: '1d',
      });
      let candles = pre?.candle_data || [];
      // Fallback to live fetch only if DB cache is too thin
      if (candles.length < BREADTH_DMA_WINDOW + 5) {
        try {
          const result = await candleFetcherService.getCandleDataForAnalysis(
            s.instrument_key, 'swing', true /* skipIntraday */
          );
          candles = result?.success ? (result.data?.['1d'] || []) : candles;
        } catch (_) { /* swallow, use whatever we have */ }
      }
      if (candles.length >= BREADTH_DMA_WINDOW + 5) {
        seriesBySymbol[s.trading_symbol || s.symbol] = candles.map(c => ({
          date: (Array.isArray(c) ? c[0] : (c.timestamp || c.date)).slice(0, 10),
          close: Array.isArray(c) ? c[4] : c.close,
        }));
      }
    } catch (err) {
      // skip
    }
    loaded++;
    if (loaded % 50 === 0) console.log(`[backfill breadth] loaded ${loaded}/${universe.length} (series_built=${Object.keys(seriesBySymbol).length})`);
  }
  console.log(`[backfill breadth] series built for ${Object.keys(seriesBySymbol).length} stocks`);

  // Collect all trading dates from any symbol; sort.
  const allDates = new Set();
  for (const arr of Object.values(seriesBySymbol)) {
    for (const p of arr) allDates.add(p.date);
  }
  const sortedDates = [...allDates].sort();
  const recentDates = sortedDates.slice(-daysBack);

  for (const date of recentDates) {
    let evaluated = 0, above = 0;
    for (const [, series] of Object.entries(seriesBySymbol)) {
      const idx = series.findIndex(p => p.date === date);
      if (idx < BREADTH_DMA_WINDOW - 1) continue;
      const window = series.slice(idx - BREADTH_DMA_WINDOW + 1, idx + 1);
      const dma = window.reduce((a, p) => a + p.close, 0) / BREADTH_DMA_WINDOW;
      evaluated++;
      if (series[idx].close > dma) above++;
    }
    if (evaluated < 50) continue;
    const pct = (above / evaluated) * 100;
    await BreadthDaily.findOneAndUpdate(
      { date },
      {
        date, universe: 'NIFTY500',
        total_stocks: universe.length,
        above_50dma_count: above,
        pct_above_50dma: Math.round(pct * 100) / 100,
        computed_at: new Date(),
      },
      { upsert: true },
    );
  }

  console.log(`[backfill breadth] done`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
