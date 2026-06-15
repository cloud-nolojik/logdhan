/**
 * Backtest-data coverage check (READ ONLY).
 *
 * Reports how much replayable data you actually have before you build a backtest:
 *   • backtest_candles — per-interval: trading days present, symbol coverage,
 *     bar counts; flags weekdays in range with NO data (gaps or market holidays)
 *     and partial days (low symbol count or short bar counts).
 *   • orb_trades — days present, entries, PnL; cross-checks which traded days are
 *     missing their candle archive (and vice-versa).
 *
 * This script ONLY reads — it never writes, upserts, or deletes.
 *
 * Usage:
 *   node src/scripts/checkBacktestCoverage.js [interval]
 *   node src/scripts/checkBacktestCoverage.js              # defaults to 'minute'
 *   node src/scripts/checkBacktestCoverage.js minute
 */

import '../loadEnv.js';
import mongoose from 'mongoose';
import BacktestCandle from '../models/backtestCandle.js';
import OrbTrade from '../models/orbTrade.js';

// A full NSE session is 09:15–15:30 = 375 one-minute bars. Tune for other intervals.
const FULL_DAY_BARS = { minute: 375, '5minute': 75, '15minute': 25 };
const MIN_SYMBOLS_OK = 150;   // F&O universe is ~215; below this = partial archive
const PARTIAL_BAR_FRAC = 0.8; // avgBars below 80% of a full day = likely partial

const fmtIST = (d) => {
  const ist = new Date(new Date(d).getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
};

// Every weekday (Mon–Fri) between two YYYY-MM-DD strings, inclusive.
function weekdaysBetween(fromStr, toStr) {
  const out = [];
  const d = new Date(`${fromStr}T00:00:00Z`);
  const end = new Date(`${toStr}T00:00:00Z`);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function main() {
  const interval = process.argv[2] || 'minute';
  const fullDay = FULL_DAY_BARS[interval] || 375;

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error('[coverage] MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);
  console.log(`\n================  BACKTEST DATA COVERAGE  ================`);
  console.log(`DB: ${mongoose.connection.name}   interval: ${interval}   (read-only)\n`);

  // ── backtest_candles, grouped per trading day ────────────────────────────
  const byDay = await BacktestCandle.aggregate([
    { $match: { interval } },
    { $group: {
        _id: '$date',
        symbols:   { $sum: 1 },
        totalBars: { $sum: '$barCount' },
        minBars:   { $min: '$barCount' },
        maxBars:   { $max: '$barCount' },
        avgBars:   { $avg: '$barCount' },
        emptySyms: { $sum: { $cond: [{ $eq: ['$barCount', 0] }, 1, 0] } },
    }},
    { $sort: { _id: 1 } },
  ]);

  if (!byDay.length) {
    console.log(`backtest_candles: NO documents for interval='${interval}'.`);
    console.log(`→ The archive may not have run yet, or uses a different interval.\n`);
  } else {
    const dates = byDay.map(d => d._id);
    const first = dates[0], last = dates[dates.length - 1];
    const present = new Set(dates);
    const expected = weekdaysBetween(first, last);
    const missing = expected.filter(d => !present.has(d));
    const partial = byDay.filter(d => d.symbols < MIN_SYMBOLS_OK || d.avgBars < fullDay * PARTIAL_BAR_FRAC);

    console.log(`backtest_candles (${interval})`);
    console.log(`  Range:          ${first} → ${last}`);
    console.log(`  Trading days:   ${byDay.length} archived  (of ${expected.length} weekdays in range)`);
    console.log(`  Symbol/day:     min ${Math.min(...byDay.map(d => d.symbols))}, max ${Math.max(...byDay.map(d => d.symbols))}  (F&O universe ≈ 215)`);
    console.log(`  Full day ≈ ${fullDay} bars/symbol for '${interval}'`);

    console.log(`\n  Per-day detail:`);
    console.log(`  ${'date'.padEnd(12)} ${'symbols'.padStart(7)} ${'avgBars'.padStart(8)} ${'minBars'.padStart(7)} ${'maxBars'.padStart(7)} ${'empty'.padStart(6)}`);
    for (const d of byDay) {
      const flag = (d.symbols < MIN_SYMBOLS_OK || d.avgBars < fullDay * PARTIAL_BAR_FRAC) ? '  ⚠ partial' : '';
      console.log(`  ${d._id.padEnd(12)} ${String(d.symbols).padStart(7)} ${d.avgBars.toFixed(0).padStart(8)} ${String(d.minBars).padStart(7)} ${String(d.maxBars).padStart(7)} ${String(d.emptySyms).padStart(6)}${flag}`);
    }

    console.log(`\n  Weekdays in range with NO candle data: ${missing.length}`);
    if (missing.length) console.log(`    ${missing.join(', ')}`);
    console.log(`    (NSE holidays will show here too — cross-check against the trading calendar.)`);
    console.log(`  Partial days (symbols < ${MIN_SYMBOLS_OK} or avgBars < ${(fullDay * PARTIAL_BAR_FRAC).toFixed(0)}): ${partial.length}`);
    if (partial.length) console.log(`    ${partial.map(d => d._id).join(', ')}`);
  }

  // ── orb_trades coverage + cross-check ────────────────────────────────────
  const trades = await OrbTrade.find({}, { date: 1, candidates: 1, entriesCount: 1, totalPnl: 1 }).lean();
  const tradeDays = trades
    .map(t => ({
      date: fmtIST(t.date),
      candidates: (t.candidates || []).length,
      entries: t.entriesCount || 0,
      pnl: t.totalPnl || 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  console.log(`\n----------------------------------------------------------`);
  if (!tradeDays.length) {
    console.log(`orb_trades: no documents found.`);
  } else {
    const totEntries = tradeDays.reduce((s, t) => s + t.entries, 0);
    const totPnl = tradeDays.reduce((s, t) => s + t.pnl, 0);
    console.log(`orb_trades`);
    console.log(`  Range:        ${tradeDays[0].date} → ${tradeDays[tradeDays.length - 1].date}`);
    console.log(`  Days:         ${tradeDays.length}   total entries: ${totEntries}   total PnL: ₹${totPnl.toFixed(0)}`);

    if (byDay.length) {
      const candleDates = new Set(byDay.map(d => d._id));
      const tradeDateSet = new Set(tradeDays.map(t => t.date));
      const tradedNoCandles = [...tradeDateSet].filter(d => !candleDates.has(d)).sort();
      const candlesNoTrade  = [...candleDates].filter(d => !tradeDateSet.has(d)).sort();
      console.log(`\n  Traded days missing candle archive: ${tradedNoCandles.length}${tradedNoCandles.length ? ' → ' + tradedNoCandles.join(', ') : ''}`);
      console.log(`  Archived days with no orb_trades doc: ${candlesNoTrade.length}${candlesNoTrade.length ? ' → ' + candlesNoTrade.join(', ') : ''}`);
    }
  }

  console.log(`\n==========================================================\n`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
