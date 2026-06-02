/**
 * Backfill raw intraday candles into MongoDB for backtesting.
 *
 * Archives 1-min OHLCV for the F&O universe + Nifty across a date range so the
 * trading system can be replayed against real history. Kite keeps 1-min data
 * ~3 years back (60 days/request); this loops one day at a time, well within that.
 *
 * Usage:
 *   node src/scripts/backfillCandles.js <from YYYY-MM-DD> <to YYYY-MM-DD> [interval]
 *   node src/scripts/backfillCandles.js 2026-03-01 2026-05-31
 *
 * NOTE: requires a valid Kite session. If this script can't authenticate Kite
 * standalone, run the same backfill in-process on the live (authed) server via:
 *   agenda.now('manual-archive-backfill', { from: '2026-03-01', to: '2026-05-31' })
 */

import '../loadEnv.js';
import mongoose from 'mongoose';
import { backfillRange } from '../services/backtest/candleArchive.service.js';

async function main() {
  const from     = process.argv[2];
  const to       = process.argv[3];
  const interval = process.argv[4] || 'minute';

  if (!from || !to) {
    console.error('Usage: node src/scripts/backfillCandles.js <from YYYY-MM-DD> <to YYYY-MM-DD> [interval]');
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error('[backfill candles] MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  console.log(`[backfill candles] ${from} → ${to} (${interval})`);
  const results = await backfillRange(from, to, { interval });
  const saved = results.reduce((s, r) => s + (r.saved || 0), 0);
  const errs  = results.filter(r => r.error).length;
  console.log(`[backfill candles] done — ${results.length} days, ${saved} symbol-days saved, ${errs} day(s) errored`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
