#!/usr/bin/env node
/**
 * Daily Picks Backtest Framework
 *
 * Analyzes historical DailyPick trade outcomes to validate the trading edge.
 * Reads completed trade data from MongoDB and computes performance metrics.
 *
 * Usage:
 *   node backtestDailyPicks.js                      # Last 30 days
 *   node backtestDailyPicks.js --days 60             # Last 60 days
 *   node backtestDailyPicks.js --from 2026-01-01     # From specific date
 *   node backtestDailyPicks.js --scan compression_bullish  # Filter by scan type
 *   node backtestDailyPicks.js --direction LONG      # Filter by direction
 *
 * Metrics computed:
 *   - Win rate, avg return, total P&L
 *   - Max drawdown (consecutive losses)
 *   - By scan type, direction, regime
 *   - Slippage analysis (planned vs actual entry)
 *   - Time-of-exit distribution
 *   - R:R achievement ratio
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env from project root
dotenv.config({ path: resolve(__dirname, '../../.env') });

// ═══════════════════════════════════════════════════════════════════════════════
// PARSE CLI ARGS
// ═══════════════════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 30, from: null, scan: null, direction: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[i + 1]);
    if (args[i] === '--from' && args[i + 1]) opts.from = args[i + 1];
    if (args[i] === '--scan' && args[i + 1]) opts.scan = args[i + 1];
    if (args[i] === '--direction' && args[i + 1]) opts.direction = args[i + 1].toUpperCase();
  }

  return opts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const opts = parseArgs();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  DAILY PICKS BACKTEST FRAMEWORK');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Period: ${opts.from || `last ${opts.days} days`}`);
  if (opts.scan) console.log(`  Scan filter: ${opts.scan}`);
  if (opts.direction) console.log(`  Direction filter: ${opts.direction}`);
  console.log('');

  // Connect to MongoDB
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }

  // Import model AFTER connection
  const DailyPick = (await import('../../src/models/dailyPick.js')).default;

  // Build query
  const cutoff = opts.from
    ? new Date(opts.from)
    : new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);

  const docs = await DailyPick.find({
    trading_date: { $gte: cutoff }
  }).sort({ trading_date: 1 }).lean();

  console.log(`Found ${docs.length} trading days\n`);

  if (docs.length === 0) {
    console.log('No data to analyze.');
    process.exit(0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COLLECT ALL TRADES
  // ═══════════════════════════════════════════════════════════════════════════

  const trades = [];
  const TERMINAL_STATUSES = ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT'];

  for (const doc of docs) {
    const date = doc.trading_date?.toISOString().split('T')[0];
    const regime = doc.market_context?.regime || 'UNKNOWN';

    for (const pick of doc.picks || []) {
      if (!TERMINAL_STATUSES.includes(pick.trade?.status)) continue;

      // Apply filters
      if (opts.scan && pick.scan_type !== opts.scan) continue;
      if (opts.direction && pick.direction !== opts.direction) continue;

      trades.push({
        date,
        symbol: pick.symbol,
        scanType: pick.scan_type,
        direction: pick.direction,
        regime,
        score: pick.rank_score || 0,
        // Levels
        plannedEntry: pick.levels?.entry || 0,
        actualEntry: pick.trade.entry_price || 0,
        stop: pick.levels?.stop || 0,
        target: pick.levels?.target || 0,
        riskReward: pick.levels?.risk_reward || 0,
        // Outcome
        status: pick.trade.status,
        exitPrice: pick.trade.exit_price || 0,
        exitReason: pick.trade.exit_reason || '',
        pnl: pick.trade.pnl || 0,
        returnPct: pick.trade.return_pct || 0,
        qty: pick.trade.qty || 0,
        // Timing
        entryTime: pick.trade.entry_time,
        exitTime: pick.trade.exit_time,
        // Partial
        partialExitQty: pick.trade.partial_exit_qty || 0,
        partialExitPrice: pick.trade.partial_exit_price || 0,
        // Trailing
        trailingHistory: pick.trailing_history || [],
        // ORB
        orbPass: pick.orb?.orb_pass || 0,
        // Weekly trend
        weeklyTrendBonus: pick.weekly_trend_bonus || 0,
        weeklyTrendPenalty: pick.weekly_trend_penalty || 0,
        // Regime
        regimeBonus: pick.regime_bonus || 0,
        regimeWarning: pick.regime_warning || null
      });
    }
  }

  console.log(`Total completed trades: ${trades.length}\n`);

  if (trades.length === 0) {
    console.log('No completed trades to analyze.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OVERALL METRICS
  // ═══════════════════════════════════════════════════════════════════════════

  const winners = trades.filter(t => t.pnl > 0);
  const losers = trades.filter(t => t.pnl < 0);
  const breakeven = trades.filter(t => t.pnl === 0);

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgReturn = trades.reduce((s, t) => s + t.returnPct, 0) / trades.length;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.returnPct, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.returnPct, 0) / losers.length : 0;
  const winRate = (winners.length / trades.length) * 100;
  const profitFactor = losers.length > 0
    ? Math.abs(winners.reduce((s, t) => s + t.pnl, 0)) / Math.abs(losers.reduce((s, t) => s + t.pnl, 0))
    : Infinity;

  // Expectancy = (WinRate × AvgWin) + (LossRate × AvgLoss)
  const expectancy = (winRate / 100 * avgWin) + ((100 - winRate) / 100 * avgLoss);

  // Max consecutive losses (drawdown streaks)
  let maxConsecLosses = 0;
  let currentConsecLosses = 0;
  let maxDrawdownPnl = 0;
  let currentDrawdown = 0;
  let peakPnl = 0;
  let runningPnl = 0;

  for (const t of trades) {
    runningPnl += t.pnl;
    if (runningPnl > peakPnl) peakPnl = runningPnl;
    const dd = peakPnl - runningPnl;
    if (dd > maxDrawdownPnl) maxDrawdownPnl = dd;

    if (t.pnl < 0) {
      currentConsecLosses++;
      if (currentConsecLosses > maxConsecLosses) maxConsecLosses = currentConsecLosses;
    } else {
      currentConsecLosses = 0;
    }
  }

  console.log('───────────────────────────────────────────────────────────────');
  console.log('  OVERALL PERFORMANCE');
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`  Total trades:      ${trades.length} (${winners.length}W / ${losers.length}L / ${breakeven.length}BE)`);
  console.log(`  Win rate:          ${r2(winRate)}%`);
  console.log(`  Total P&L:         ₹${r2(totalPnl)}`);
  console.log(`  Avg return:        ${r2(avgReturn)}%`);
  console.log(`  Avg win:           +${r2(avgWin)}%`);
  console.log(`  Avg loss:          ${r2(avgLoss)}%`);
  console.log(`  Profit factor:     ${r2(profitFactor)}`);
  console.log(`  Expectancy:        ${r2(expectancy)}% per trade`);
  console.log(`  Max consec losses: ${maxConsecLosses}`);
  console.log(`  Max drawdown:      ₹${r2(maxDrawdownPnl)}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // BY SCAN TYPE
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('───────────────────────────────────────────────────────────────');
  console.log('  BY SCAN TYPE');
  console.log('───────────────────────────────────────────────────────────────');

  const byScan = groupBy(trades, 'scanType');
  const scanRows = [];
  for (const [scan, scanTrades] of Object.entries(byScan)) {
    const w = scanTrades.filter(t => t.pnl > 0).length;
    const wr = (w / scanTrades.length) * 100;
    const avgRet = scanTrades.reduce((s, t) => s + t.returnPct, 0) / scanTrades.length;
    const pnl = scanTrades.reduce((s, t) => s + t.pnl, 0);
    scanRows.push({ scan, trades: scanTrades.length, winRate: r2(wr), avgReturn: r2(avgRet), pnl: r2(pnl) });
  }
  scanRows.sort((a, b) => parseFloat(b.avgReturn) - parseFloat(a.avgReturn));
  console.log(`  ${'Scan Type'.padEnd(25)} ${'Trades'.padStart(6)} ${'WinRate'.padStart(8)} ${'AvgRet'.padStart(8)} ${'P&L'.padStart(10)}`);
  for (const row of scanRows) {
    console.log(`  ${row.scan.padEnd(25)} ${String(row.trades).padStart(6)} ${(row.winRate + '%').padStart(8)} ${(row.avgReturn + '%').padStart(8)} ${('₹' + row.pnl).padStart(10)}`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // BY DIRECTION
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('───────────────────────────────────────────────────────────────');
  console.log('  BY DIRECTION');
  console.log('───────────────────────────────────────────────────────────────');

  for (const dir of ['LONG', 'SHORT']) {
    const dirTrades = trades.filter(t => t.direction === dir);
    if (dirTrades.length === 0) continue;
    const w = dirTrades.filter(t => t.pnl > 0).length;
    const wr = (w / dirTrades.length) * 100;
    const avgRet = dirTrades.reduce((s, t) => s + t.returnPct, 0) / dirTrades.length;
    const pnl = dirTrades.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${dir}: ${dirTrades.length} trades, ${r2(wr)}% win rate, ${r2(avgRet)}% avg return, ₹${r2(pnl)} P&L`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // BY REGIME
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('───────────────────────────────────────────────────────────────');
  console.log('  BY MARKET REGIME');
  console.log('───────────────────────────────────────────────────────────────');

  const byRegime = groupBy(trades, 'regime');
  for (const [regime, regTrades] of Object.entries(byRegime)) {
    const w = regTrades.filter(t => t.pnl > 0).length;
    const wr = (w / regTrades.length) * 100;
    const avgRet = regTrades.reduce((s, t) => s + t.returnPct, 0) / regTrades.length;
    console.log(`  ${regime.padEnd(18)} ${String(regTrades.length).padStart(4)} trades, ${(r2(wr) + '%').padStart(7)} win rate, ${(r2(avgRet) + '%').padStart(7)} avg`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // EXIT REASON DISTRIBUTION
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('───────────────────────────────────────────────────────────────');
  console.log('  EXIT REASON DISTRIBUTION');
  console.log('───────────────────────────────────────────────────────────────');

  const byStatus = groupBy(trades, 'status');
  for (const [status, statusTrades] of Object.entries(byStatus)) {
    const avgRet = statusTrades.reduce((s, t) => s + t.returnPct, 0) / statusTrades.length;
    console.log(`  ${status.padEnd(15)} ${String(statusTrades.length).padStart(4)} trades, ${(r2(avgRet) + '%').padStart(8)} avg return`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // SLIPPAGE ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  const tradesWithSlippage = trades.filter(t => t.plannedEntry > 0 && t.actualEntry > 0);
  if (tradesWithSlippage.length > 0) {
    console.log('───────────────────────────────────────────────────────────────');
    console.log('  SLIPPAGE ANALYSIS (Planned vs Actual Entry)');
    console.log('───────────────────────────────────────────────────────────────');

    const slippages = tradesWithSlippage.map(t => {
      const slip = t.direction === 'LONG'
        ? ((t.actualEntry - t.plannedEntry) / t.plannedEntry) * 100
        : ((t.plannedEntry - t.actualEntry) / t.plannedEntry) * 100;
      return { ...t, slippagePct: slip };
    });

    const avgSlippage = slippages.reduce((s, t) => s + t.slippagePct, 0) / slippages.length;
    const maxSlippage = Math.max(...slippages.map(t => t.slippagePct));
    const positiveSlippage = slippages.filter(t => t.slippagePct > 0); // Got worse price
    const negativeSlippage = slippages.filter(t => t.slippagePct <= 0); // Got better/equal price

    console.log(`  Avg slippage:    ${r2(avgSlippage)}%`);
    console.log(`  Max slippage:    ${r2(maxSlippage)}%`);
    console.log(`  Worse price:     ${positiveSlippage.length}/${tradesWithSlippage.length} trades`);
    console.log(`  Better/equal:    ${negativeSlippage.length}/${tradesWithSlippage.length} trades`);

    // By scan type slippage
    const slipByScan = groupBy(slippages, 'scanType');
    console.log('');
    console.log(`  ${'Scan Type'.padEnd(25)} ${'AvgSlip'.padStart(8)}`);
    for (const [scan, scanSlips] of Object.entries(slipByScan)) {
      const avg = scanSlips.reduce((s, t) => s + t.slippagePct, 0) / scanSlips.length;
      console.log(`  ${scan.padEnd(25)} ${(r2(avg) + '%').padStart(8)}`);
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // R:R ACHIEVEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  const tradesWithRR = trades.filter(t => t.riskReward > 0 && t.actualEntry > 0);
  if (tradesWithRR.length > 0) {
    console.log('───────────────────────────────────────────────────────────────');
    console.log('  R:R ACHIEVEMENT');
    console.log('───────────────────────────────────────────────────────────────');

    const avgPlannedRR = tradesWithRR.reduce((s, t) => s + t.riskReward, 0) / tradesWithRR.length;
    const hitsTarget = tradesWithRR.filter(t => t.status === 'TARGET_HIT');
    const hitsPct = (hitsTarget.length / tradesWithRR.length) * 100;

    console.log(`  Avg planned R:R:  ${r2(avgPlannedRR)}`);
    console.log(`  Target hit rate:  ${r2(hitsPct)}% (${hitsTarget.length}/${tradesWithRR.length})`);
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WEEKLY TREND IMPACT (if data available)
  // ═══════════════════════════════════════════════════════════════════════════

  const weeklyAligned = trades.filter(t => t.weeklyTrendBonus > 0);
  const weeklyContra = trades.filter(t => t.weeklyTrendPenalty < 0);

  if (weeklyAligned.length > 0 || weeklyContra.length > 0) {
    console.log('───────────────────────────────────────────────────────────────');
    console.log('  WEEKLY TREND IMPACT');
    console.log('───────────────────────────────────────────────────────────────');

    if (weeklyAligned.length > 0) {
      const w = weeklyAligned.filter(t => t.pnl > 0).length;
      const wr = (w / weeklyAligned.length) * 100;
      const avgRet = weeklyAligned.reduce((s, t) => s + t.returnPct, 0) / weeklyAligned.length;
      console.log(`  Weekly-aligned:  ${weeklyAligned.length} trades, ${r2(wr)}% win rate, ${r2(avgRet)}% avg return`);
    }
    if (weeklyContra.length > 0) {
      const w = weeklyContra.filter(t => t.pnl > 0).length;
      const wr = (w / weeklyContra.length) * 100;
      const avgRet = weeklyContra.reduce((s, t) => s + t.returnPct, 0) / weeklyContra.length;
      console.log(`  Weekly-contra:   ${weeklyContra.length} trades, ${r2(wr)}% win rate, ${r2(avgRet)}% avg return`);
    }
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DAILY P&L TIMELINE
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('───────────────────────────────────────────────────────────────');
  console.log('  DAILY P&L TIMELINE');
  console.log('───────────────────────────────────────────────────────────────');

  const byDate = groupBy(trades, 'date');
  let cumPnl = 0;
  const dailyPnls = [];

  for (const [date, dayTrades] of Object.entries(byDate).sort()) {
    const dayPnl = dayTrades.reduce((s, t) => s + t.pnl, 0);
    cumPnl += dayPnl;
    const w = dayTrades.filter(t => t.pnl > 0).length;
    const symbol = `${dayPnl >= 0 ? '+' : ''}₹${r2(dayPnl)}`;
    dailyPnls.push(dayPnl);
    console.log(`  ${date}  ${symbol.padStart(10)}  cum: ₹${String(r2(cumPnl)).padStart(8)}  ${w}W/${dayTrades.length - w}L  ${dayTrades.map(t => t.symbol).join(', ')}`);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY VERDICT
  // ═══════════════════════════════════════════════════════════════════════════

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  VERDICT');
  console.log('═══════════════════════════════════════════════════════════════');

  const edgeScore = [];
  if (winRate > 50) edgeScore.push(`✅ Win rate ${r2(winRate)}% > 50%`);
  else edgeScore.push(`❌ Win rate ${r2(winRate)}% < 50%`);

  if (profitFactor > 1.5) edgeScore.push(`✅ Profit factor ${r2(profitFactor)} > 1.5`);
  else if (profitFactor > 1.0) edgeScore.push(`⚠️ Profit factor ${r2(profitFactor)} (marginal)`);
  else edgeScore.push(`❌ Profit factor ${r2(profitFactor)} < 1.0 (losing system)`);

  if (expectancy > 0.5) edgeScore.push(`✅ Expectancy +${r2(expectancy)}% per trade`);
  else if (expectancy > 0) edgeScore.push(`⚠️ Expectancy +${r2(expectancy)}% (marginal edge)`);
  else edgeScore.push(`❌ Expectancy ${r2(expectancy)}% (negative edge)`);

  if (maxConsecLosses <= 4) edgeScore.push(`✅ Max consec losses: ${maxConsecLosses}`);
  else edgeScore.push(`⚠️ Max consec losses: ${maxConsecLosses} (watch position sizing)`);

  for (const line of edgeScore) console.log(`  ${line}`);
  console.log('═══════════════════════════════════════════════════════════════');

  await mongoose.disconnect();
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function r2(n) { return Math.round(n * 100) / 100; }

function groupBy(arr, key) {
  const groups = {};
  for (const item of arr) {
    const k = item[key] || 'UNKNOWN';
    if (!groups[k]) groups[k] = [];
    groups[k].push(item);
  }
  return groups;
}

// Run
main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
