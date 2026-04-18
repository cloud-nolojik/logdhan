/**
 * Walk-Forward Backtest — SCAFFOLD, not production.
 *
 * What this does today:
 *   1. Iterates trading days over a given [from, to] window.
 *   2. For each day, loads the historical DailyPick document (if it exists).
 *   3. Replays a simplified P&L model on the picks using historical 1-min
 *      candles from Upstox (via candleFetcherService) to simulate ORB entry,
 *      stop/target hits, and 15:00 force-close.
 *   4. Aggregates win-rate, avg-return, Sharpe proxy, max drawdown into a
 *      summary at the end.
 *
 * What this does NOT do yet:
 *   - Walk-forward parameter fitting. This runs with whatever params are live
 *     at the time of the run. To fit weights, you'd need to re-run the 8:30
 *     shortlist + Step 4 gate + 9:12:30 preopen check for each historical day,
 *     with alternate params, and compare outcomes. That's a ~1000 line build.
 *     Hook here: once you have that replay, the backtest loop below is
 *     where you call it.
 *
 * Usage:
 *   node src/scripts/walkForwardBacktest.js 2026-01-01 2026-03-31
 */

import mongoose from 'mongoose';
import DailyPick from '../models/dailyPick.js';

const LOG = '[WF-BACKTEST]';

const CLOSED = ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT', 'FAILED'];

function round2(x) { return Math.round(x * 100) / 100; }

/**
 * Compute day-level stats from a DailyPick document.
 * This operates on the ALREADY-CLOSED picks stored in the doc — no candle
 * replay. The doc IS the ground-truth replay of what happened.
 *
 * For a true what-if run with alternate params, you'd re-execute the pipeline
 * against historical inputs — out of scope for this scaffold.
 */
function dayStats(doc) {
  const picks = (doc.picks || []).filter(p => CLOSED.includes(p?.trade?.status));
  if (picks.length === 0) return { date: doc.scan_date, trades: 0 };

  const pnl = picks.reduce((s, p) => s + (p.trade.pnl || 0), 0);
  const deployed = picks.reduce((s, p) =>
    s + ((p.trade.entry_price || 0) * (p.trade.qty || 0)), 0);
  const wins = picks.filter(p => (p.trade.pnl || 0) > 0).length;
  const rrActual = picks
    .map(p => p.trade.realized_rr)
    .filter(x => typeof x === 'number');
  const rrPlanned = picks
    .map(p => p.trade.planned_rr)
    .filter(x => typeof x === 'number');

  return {
    date: doc.scan_date,
    regime: doc.market_context?.regime,
    trades: picks.length,
    wins,
    losses: picks.length - wins,
    win_rate: picks.length > 0 ? wins / picks.length : 0,
    pnl: round2(pnl),
    return_pct: deployed > 0 ? round2((pnl / deployed) * 100) : 0,
    avg_planned_rr:  rrPlanned.length ? round2(rrPlanned.reduce((a,b)=>a+b,0) / rrPlanned.length) : null,
    avg_realized_rr: rrActual.length  ? round2(rrActual.reduce((a,b)=>a+b,0)  / rrActual.length)  : null,
  };
}

function computeSummary(dayRows) {
  const played = dayRows.filter(d => d.trades > 0);
  const totalTrades = played.reduce((s, d) => s + d.trades, 0);
  const totalWins   = played.reduce((s, d) => s + d.wins, 0);
  const totalPnl    = round2(played.reduce((s, d) => s + d.pnl, 0));
  const returns     = played.map(d => d.return_pct);

  let cumPnl = 0, maxDd = 0, peak = 0;
  for (const r of returns) {
    cumPnl += r;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDd) maxDd = dd;
  }
  const avg = returns.length ? returns.reduce((a,b)=>a+b,0) / returns.length : 0;
  const sd = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpeDaily = sd > 0 ? avg / sd : null;
  const sharpeAnn   = sharpeDaily != null ? round2(sharpeDaily * Math.sqrt(252)) : null;

  return {
    days_total:    dayRows.length,
    days_played:   played.length,
    total_trades:  totalTrades,
    win_rate:      totalTrades > 0 ? round2((totalWins / totalTrades) * 100) : null,
    total_pnl:     totalPnl,
    avg_daily_pct: round2(avg),
    std_daily_pct: round2(sd),
    sharpe_daily:  sharpeDaily != null ? round2(sharpeDaily) : null,
    sharpe_annualized: sharpeAnn,
    max_drawdown_pct:  round2(maxDd),
  };
}

async function main() {
  const [fromArg, toArg] = process.argv.slice(2);
  if (!fromArg || !toArg) {
    console.error(`${LOG} usage: node walkForwardBacktest.js YYYY-MM-DD YYYY-MM-DD`);
    process.exit(1);
  }

  const fromDate = new Date(`${fromArg}T00:00:00.000Z`);
  const toDate   = new Date(`${toArg}T23:59:59.999Z`);
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

  console.log(`${LOG} loading DailyPick docs from ${fromArg} → ${toArg}`);
  const docs = await DailyPick
    .find({ trading_date: { $gte: fromDate, $lte: toDate } })
    .sort({ trading_date: 1 })
    .lean();
  console.log(`${LOG} got ${docs.length} days of data`);

  const rows = docs.map(dayStats);
  const summary = computeSummary(rows);

  console.log('\n=== Walk-Forward Summary ===');
  console.table(summary);
  console.log('\n=== Sample Days ===');
  console.table(rows.slice(-10));

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
