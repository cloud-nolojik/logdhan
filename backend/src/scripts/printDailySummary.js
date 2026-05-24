#!/usr/bin/env node
/**
 * printDailySummary.js — print the end-of-day summary for any past day, OR
 * a week-overview comparing the last N days.
 *
 * Usage:
 *   node src/scripts/printDailySummary.js                   # today
 *   node src/scripts/printDailySummary.js --date 2026-05-22 # specific day
 *   node src/scripts/printDailySummary.js --week            # last 5 trading days
 *   node src/scripts/printDailySummary.js --week --days 10  # last 10 days
 *
 * Connects to Mongo (reads daily_picks + daily_metrics). Does not touch
 * the broker. Safe to run anytime.
 */

import 'dotenv/config';
import mongoose from 'mongoose';

function parseArgs() {
  const args = { date: null, week: false, days: 5 };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === '--date') { args.date = next; i++; }
    else if (a === '--week') { args.week = true; }
    else if (a === '--days') { args.days = parseInt(next, 10); i++; }
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node printDailySummary.js [--date YYYY-MM-DD] [--week] [--days N]`);
      process.exit(0);
    }
  }
  return args;
}

const pad  = (s, n) => String(s ?? '').padEnd(n);
const padl = (s, n) => String(s ?? '').padStart(n);
const hr   = (ch = '─', n = 78) => ch.repeat(n);

async function main() {
  const args = parseArgs();

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI not set — aborting');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });

  // ── Single-day mode (default) ──────────────────────────────────────────
  if (!args.week) {
    const { logEndOfDaySummary } = await import('../services/dailyPicks/dailyPicksService.js');
    const result = await logEndOfDaySummary({ dateOverride: args.date });
    if (!result) console.log('No data for that date.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── Week-overview mode ─────────────────────────────────────────────────
  const DailyMetrics = mongoose.models.DailyMetrics || mongoose.model('DailyMetrics',
    new mongoose.Schema({}, { strict: false, collection: 'daily_metrics' })
  );
  const allMetrics = await DailyMetrics.find({})
    .sort({ trading_date: -1 })
    .limit(args.days)
    .lean();

  if (allMetrics.length === 0) {
    console.log('\nNo metrics in daily_metrics collection yet.');
    console.log('Run the system live for a day (or call logEndOfDaySummary manually) to populate.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // Print chronological (oldest → newest) for trend visibility
  const metrics = allMetrics.reverse();

  console.log(`\n${hr('═')}`);
  console.log(`  WEEK OVERVIEW — last ${metrics.length} trading day${metrics.length === 1 ? '' : 's'}`);
  console.log(`${hr('═')}\n`);

  // ── Daily summary table ──
  console.log(`  ${pad('date',10)} ${pad('regime',13)} ${padl('SL',5)} ${padl('sel',4)} ${padl('trig',5)} ${padl('W',3)} ${padl('L',3)} ${padl('hit%',6)} ${padl('P&L₹',9)} ${padl('R',7)} ${pad('exit_mix',24)}`);
  console.log(`  ${hr('-', 110)}`);

  let weekTotalPnl = 0;
  let weekTotalR   = 0;
  let weekTrig     = 0;
  let weekWins     = 0;
  let weekVwapExits = 0;
  let weekSLs      = 0;
  let weekTargets  = 0;

  for (const m of metrics) {
    const date = new Date(m.trading_date).toISOString().slice(5, 10);
    const exitMix = `T${m.exit_breakdown?.target_hits || 0}/SL${m.exit_breakdown?.hard_sl_hits || 0}/V${m.exit_breakdown?.vwap_exits || 0}/X${m.exit_breakdown?.time_exits || 0}`;
    console.log(`  ${pad(date, 10)} ${pad(m.regime, 13)} ${padl(m.shortlist_size, 5)} ${padl(m.selected_at_932, 4)} ${padl(m.entries_triggered, 5)} ${padl(m.winners, 3)} ${padl(m.losers, 3)} ${padl(m.hit_rate_pct != null ? m.hit_rate_pct.toFixed(0) + '%' : '-', 6)} ${padl((m.total_pnl_rupees || 0).toFixed(0), 9)} ${padl((m.total_r_multiples || 0).toFixed(2) + 'R', 7)} ${pad(exitMix, 24)}`);
    weekTotalPnl  += m.total_pnl_rupees || 0;
    weekTotalR    += m.total_r_multiples || 0;
    weekTrig      += m.entries_triggered || 0;
    weekWins      += m.winners || 0;
    weekVwapExits += m.exit_breakdown?.vwap_exits || 0;
    weekSLs       += m.exit_breakdown?.hard_sl_hits || 0;
    weekTargets   += m.exit_breakdown?.target_hits || 0;
  }

  console.log(`  ${hr('-', 110)}`);
  console.log(`  ${pad('TOTAL', 10)} ${pad('', 13)} ${padl('', 5)} ${padl('', 4)} ${padl(weekTrig, 5)} ${padl(weekWins, 3)} ${padl(weekTrig - weekWins, 3)} ${padl(weekTrig ? (weekWins / weekTrig * 100).toFixed(0) + '%' : '-', 6)} ${padl(weekTotalPnl.toFixed(0), 9)} ${padl(weekTotalR.toFixed(2) + 'R', 7)}`);

  console.log();
  console.log(`  EXIT TYPE BREAKDOWN (across week):`);
  console.log(`    target hits        ${weekTargets}`);
  console.log(`    hard SL hits       ${weekSLs}`);
  console.log(`    VWAP exits         ${weekVwapExits}`);
  console.log(`    (VWAP exits are the "saved from full SL" trades — non-zero = the new logic is earning its keep)`);
  console.log();
  console.log(`  WEEK P&L            ₹${weekTotalPnl.toFixed(0)}`);
  console.log(`  WEEK R-SUM          ${weekTotalR.toFixed(2)}R`);
  console.log(`  WEEK AVG R/TRADE    ${weekTrig ? (weekTotalR / weekTrig).toFixed(2) + 'R' : '-'}`);
  console.log(`  WEEK HIT RATE       ${weekTrig ? (weekWins / weekTrig * 100).toFixed(0) + '%' : '-'}`);
  console.log();
  console.log(`  ${hr('═')}`);
  console.log();
  console.log(`  Decision rules of thumb after a week:`);
  console.log(`   • If avg R/trade > +0.2R → system has edge → consider scaling capital`);
  console.log(`   • If avg R/trade in -0.1 to +0.1R → no edge yet → keep paper/small, investigate why`);
  console.log(`   • If avg R/trade < -0.2R → system losing money → halt + diagnose before tweaking`);
  console.log();

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
