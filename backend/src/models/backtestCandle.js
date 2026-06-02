/**
 * BacktestCandle — raw intraday OHLCV archive for backtesting (2026-06-02).
 *
 * Stores the *inputs* a strategy consumes (per-symbol intraday candles), NOT the
 * decisions a strategy made. That's the distinction that makes the data replayable:
 * once raw candles are stored, ANY future strategy variant (different confirm bars,
 * RVOL ranking, regime logic, VWAP exits) can be re-run against the exact same
 * market data and compared apples-to-apples.
 *
 * One document per { symbol, date (IST trading day), interval }. The canonical
 * archive is 1-minute ('minute'); 5-min / 15-min can be resampled from it, so we
 * never lose information. Nifty is stored under symbol 'NIFTY 50'.
 *
 * Volume note: index symbols (NIFTY 50) report volume 0 — expected; the index is
 * stored for OR/price, not VWAP. Stocks carry real volume for per-stock VWAP.
 */

import mongoose from 'mongoose';

// A single OHLCV bar. Short keys keep the per-day arrays compact (~375 bars/day
// per symbol at 1-min). `t` is the candle's start timestamp as returned by Kite
// (ISO string, IST offset preserved).
const barSchema = new mongoose.Schema({
  t: { type: String, required: true },   // candle timestamp (ISO, e.g. 2026-06-01T09:15:00+0530)
  o: Number,   // open
  h: Number,   // high
  l: Number,   // low
  c: Number,   // close
  v: Number,   // volume
}, { _id: false });

const backtestCandleSchema = new mongoose.Schema({
  symbol:   { type: String, required: true },
  date:     { type: String, required: true },             // IST trading day 'YYYY-MM-DD'
  interval: { type: String, required: true, default: 'minute' },
  exchange: { type: String, default: 'NSE' },
  bars:     { type: [barSchema], default: [] },
  barCount: { type: Number, default: 0 },                 // denormalised for quick sanity checks
  source:   { type: String, default: 'kite' },
}, { timestamps: true });

// One row per symbol/day/interval — upserts are idempotent (re-running a backfill
// for the same day overwrites rather than duplicates).
backtestCandleSchema.index({ symbol: 1, date: 1, interval: 1 }, { unique: true });
// Fast "give me every symbol's candles for day X" scans (the backtest replay loop).
backtestCandleSchema.index({ date: 1, interval: 1 });

export default mongoose.model('BacktestCandle', backtestCandleSchema, 'backtest_candles');
