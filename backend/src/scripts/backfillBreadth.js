/**
 * Backfill breadth — walks N trading days back, computing % Nifty 500
 * above 50-DMA for each day using existing Upstox historical candles.
 *
 * Heavy: ~500 stocks × N days of candle queries. Use with care.
 *
 * Usage: node src/scripts/backfillBreadth.js 400
 */

import mongoose from 'mongoose';
import BreadthDaily from '../models/breadthDaily.js';
import candleFetcherService from '../services/candleFetcher.service.js';
import { BREADTH_DMA_WINDOW } from '../constants/regimeConstants.js';

async function main() {
  const daysBack = Number(process.argv[2] || 400);
  await mongoose.connect(process.env.MONGO_URI);

  const Stock = (await import('../models/stock.js')).default;
  const universe = await Stock.find({ indices: 'NIFTY500' }).lean();
  console.log(`[backfill breadth] universe=${universe.length}`);

  // For each stock, pull all candles once via candleFetcherService
  // (DB-first cache + rate-limited Upstox fallback). Then for each date, check close vs SMA50.
  const seriesBySymbol = {};
  let loaded = 0;
  for (const s of universe) {
    try {
      const result = await candleFetcherService.getCandleDataForAnalysis(
        s.instrument_key,
        'swing',
        true // skipIntraday
      );
      const candles = result?.success ? (result.data?.['1d'] || []) : [];
      if (candles.length >= BREADTH_DMA_WINDOW + 5) {
        seriesBySymbol[s.symbol] = candles.map(c => ({
          date: (Array.isArray(c) ? c[0] : (c.timestamp || c.date)).slice(0, 10),
          close: Array.isArray(c) ? c[4] : c.close,
        }));
      }
    } catch (err) {
      // skip
    }
    loaded++;
    if (loaded % 50 === 0) console.log(`[backfill breadth] loaded ${loaded}/${universe.length}`);
  }

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
