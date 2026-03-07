#!/usr/bin/env node
/**
 * TRUE BACKTEST SIMULATION ENGINE v2
 *
 * Replays historical trading days using REAL 5-min candle data and the ACTUAL
 * internal functions from the trading system (not reimplemented copies).
 *
 * Imports from the real system:
 * - validatePicks() from orbValidationService.js (via backtestUtils)
 * - Constants from dailyPicksService.js (via backtestUtils)
 * - Helpers from dailyPicksHelpers.js (via backtestUtils)
 *
 * Only the tick-by-tick candle replay is custom (can't use live Kite API for historical data).
 *
 * Usage:
 *   node trueBacktest.js                    # Last 30 days
 *   node trueBacktest.js --days 60          # Last 60 days
 *   node trueBacktest.js --from 2026-01-01  # From specific date
 *   node trueBacktest.js --capital 200000   # Custom capital
 *   node trueBacktest.js --verbose          # Show full timeline per pick
 *
 * MUST run on server with MongoDB + Upstox API access.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../../.env') });

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT FROM SHARED BACKTEST UTILS — zero duplication
// ═══════════════════════════════════════════════════════════════════════════════

import { round2 } from '../services/dailyPicks/dailyPicksHelpers.js';
import {
  SIM,
  getAccessToken,
  fetch5minCandles,
  sleep,
  simulatePick,
  loadInstrumentMap,
  getNiftyKey
} from './backtestUtils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 30, from: null, capital: 100000, verbose: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[i + 1]);
    if (args[i] === '--from' && args[i + 1]) opts.from = args[i + 1];
    if (args[i] === '--capital' && args[i + 1]) opts.capital = parseFloat(args[i + 1]);
    if (args[i] === '--verbose') opts.verbose = true;
  }
  return opts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const opts = parseArgs();

  console.log(`\n[BACKTEST] ═══════════════════════════════════════════════`);
  console.log(`[BACKTEST] TRUE BACKTEST v2 — Uses real internal functions`);
  console.log(`[BACKTEST] Period: ${opts.from || `last ${opts.days} days`}  Capital: ₹${opts.capital}  Verbose: ${opts.verbose}`);
  console.log(`[BACKTEST] ═══════════════════════════════════════════════\n`);

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('[BACKTEST] MongoDB connected');
  } catch (err) {
    console.error('[BACKTEST] MongoDB failed:', err.message);
    process.exit(1);
  }

  try {
    await getAccessToken();
    console.log('[BACKTEST] Upstox token loaded');
  } catch (err) {
    console.error('[BACKTEST] Upstox token failed:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  }

  const DailyPick = (await import('../models/dailyPick.js')).default;

  const instrumentMap = await loadInstrumentMap();
  console.log(`[BACKTEST] ${Object.keys(instrumentMap).length} instrument keys loaded`);

  const niftyKey = getNiftyKey(instrumentMap);

  const cutoff = opts.from ? new Date(opts.from) : new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);
  const docs = await DailyPick.find({ trading_date: { $gte: cutoff } }).sort({ trading_date: 1 }).lean();
  console.log(`[BACKTEST] ${docs.length} trading days found\n`);

  if (docs.length === 0) {
    console.log('[BACKTEST] No data to simulate.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── DAY-BY-DAY SIMULATION ──
  let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0;
  let totalSkipped = 0, totalNoFill = 0, totalTargetHits = 0, totalStopOuts = 0, totalTimeExits = 0, totalPartialBooks = 0;
  let maxDrawdown = 0, peakPnl = 0;
  const dailySummary = [];

  for (let di = 0; di < docs.length; di++) {
    const doc = docs[di];
    const dateStr = doc.trading_date?.toISOString().split('T')[0];
    const regime = doc.market_context?.regime || 'UNKNOWN';
    const picks = doc.picks || [];

    console.log(`[BACKTEST] ── Day ${di + 1}/${docs.length}: ${dateStr} | Regime: ${regime} | Picks: ${picks.length} ──`);

    if (picks.length === 0) {
      console.log(`[BACKTEST] No picks — skipping day`);
      dailySummary.push({ date: dateStr, regime, dayPnl: 0, trades: 0 });
      continue;
    }

    const niftyCandles = await fetch5minCandles(niftyKey, dateStr);
    await sleep(200);

    let dayPnl = 0;
    let dayTrades = 0;

    for (let pi = 0; pi < picks.length; pi++) {
      const pick = picks[pi];
      const instKey = pick.instrument_key || instrumentMap[pick.symbol];
      if (!instKey) {
        console.log(`[BACKTEST]   ${pick.symbol}: No instrument key — SKIP`);
        totalSkipped++;
        continue;
      }

      const stockCandles = await fetch5minCandles(instKey, dateStr);
      await sleep(200);

      const sim = simulatePick(pick, stockCandles, niftyCandles, opts.capital);

      // Print timeline in verbose mode, summary otherwise
      if (opts.verbose) {
        for (const line of sim.timeline) console.log(`[BACKTEST]   ${line}`);
      } else {
        const statusIcon = { TARGET_HIT: '🎯', STOPPED_OUT: '🛑', TIME_EXIT: '⏰', SKIPPED: '⏭️', NO_FILL: '❌', NO_DATA: '❓' };
        const icon = statusIcon[sim.finalStatus] || '?';
        const pnlStr = sim.entered ? `₹${round2(sim.pnl)}` : '-';
        console.log(`[BACKTEST]   ${pick.symbol} ${pick.direction} | ${icon} ${sim.finalStatus} | Entry ₹${round2(sim.entryPrice || 0)} Exit ₹${round2(sim.exitPrice || 0)} | P&L ${pnlStr} | ${sim.exitReason || '-'}`);
      }

      // Aggregate stats
      if (sim.finalStatus === 'SKIPPED') totalSkipped++;
      else if (sim.finalStatus === 'NO_FILL' || sim.finalStatus === 'NO_DATA') totalNoFill++;
      else {
        totalTrades++; dayTrades++;
        dayPnl += sim.pnl;
        totalPnl += sim.pnl;
        if (sim.pnl > 0) totalWins++;
        else if (sim.pnl < 0) totalLosses++;
        if (sim.finalStatus === 'TARGET_HIT') totalTargetHits++;
        else if (sim.finalStatus === 'STOPPED_OUT') totalStopOuts++;
        else if (sim.finalStatus === 'TIME_EXIT') totalTimeExits++;
        if (sim.partialBooked) totalPartialBooks++;
        if (totalPnl > peakPnl) peakPnl = totalPnl;
        const dd = peakPnl - totalPnl;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    const dayIcon = dayPnl >= 0 ? '✅' : '❌';
    console.log(`[BACKTEST] ${dayIcon} Day P&L: ₹${round2(dayPnl)} | Cumulative: ₹${round2(totalPnl)} | Trades: ${dayTrades}\n`);
    dailySummary.push({ date: dateStr, regime, dayPnl: round2(dayPnl), trades: dayTrades });
  }

  // ── RESULTS SUMMARY ──
  const winRate = totalTrades > 0 ? round2((totalWins / totalTrades) * 100) : 0;
  const avgPnl = totalTrades > 0 ? round2(totalPnl / totalTrades) : 0;

  console.log(`\n[BACKTEST] ═══════════════════════════════════════════════`);
  console.log(`[BACKTEST] RESULTS SUMMARY`);
  console.log(`[BACKTEST] ═══════════════════════════════════════════════`);
  console.log(`[BACKTEST] Pipeline: ${docs.reduce((s, d) => s + (d.picks?.length || 0), 0)} picks → ${totalSkipped} skipped → ${totalNoFill} no-fill → ${totalTrades} executed`);
  console.log(`[BACKTEST] Total P&L: ₹${round2(totalPnl)} | Win rate: ${winRate}% (${totalWins}W/${totalLosses}L) | Avg: ₹${avgPnl}/trade`);
  console.log(`[BACKTEST] Exits: ${totalTargetHits} targets | ${totalStopOuts} stops | ${totalTimeExits} time | ${totalPartialBooks} partial books`);
  console.log(`[BACKTEST] Max drawdown: ₹${round2(maxDrawdown)}`);
  console.log(`[BACKTEST] ───────────────────────────────────────────────`);
  console.log(`[BACKTEST] Daily timeline:`);

  let cum = 0;
  for (const day of dailySummary) {
    cum += day.dayPnl;
    const icon = day.dayPnl >= 0 ? '+' : '';
    console.log(`[BACKTEST]   ${day.date} | ${day.regime.padEnd(15)} | ${icon}₹${String(day.dayPnl).padStart(8)} | cum ₹${String(round2(cum)).padStart(10)} | ${day.trades} trades`);
  }

  // Verdict
  console.log(`[BACKTEST] ───────────────────────────────────────────────`);
  if (totalTrades < 5) {
    console.log(`[BACKTEST] ⚠️ Only ${totalTrades} trades — not enough for statistical significance. Try --days 60`);
  } else {
    if (winRate > 55) console.log(`[BACKTEST] ✅ Win rate ${winRate}% — strong edge`);
    else if (winRate > 45) console.log(`[BACKTEST] ⚠️ Win rate ${winRate}% — marginal edge`);
    else console.log(`[BACKTEST] ❌ Win rate ${winRate}% — losing system`);

    if (totalPnl > 0) console.log(`[BACKTEST] ✅ Net profitable: ₹${round2(totalPnl)}`);
    else console.log(`[BACKTEST] ❌ Net negative: ₹${round2(totalPnl)}`);
  }
  console.log(`[BACKTEST] ═══════════════════════════════════════════════\n`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('[BACKTEST] Fatal:', err);
  process.exit(1);
});
