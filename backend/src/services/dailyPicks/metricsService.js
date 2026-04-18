/**
 * Metrics Service
 *
 * Condenses a day's DailyPick document into one DailyPerformance row for
 * fast historical aggregation. Call recordDailyMetrics(date) after the 15:00
 * exit has closed all positions.
 *
 * Keep this service narrow: it READS DailyPick + ShortlistWatchlist, WRITES
 * DailyPerformance. No side effects, no external calls.
 */

import DailyPick from '../../models/dailyPick.js';
import DailyPerformance from '../../models/dailyPerformance.js';
import ShortlistWatchlist from '../../models/shortlistWatchlist.js';
import { isPaperTradeMode } from '../kiteTradeIntegration.service.js';
import { round2 } from './dailyPicksHelpers.js';

const LOG = '[METRICS]';

const CLOSED_STATUSES = ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT', 'FAILED'];

/**
 * Compute and upsert a DailyPerformance row for the given IST date.
 * @param {string} date  YYYY-MM-DD IST
 */
export async function recordDailyMetrics(date) {
  console.log(`${LOG} recordDailyMetrics(${date}) starting`);

  // 1. Pull today's DailyPick
  const [dayStart, dayEnd] = [
    new Date(`${date}T00:00:00.000Z`),
    new Date(`${date}T23:59:59.999Z`),
  ];
  const dailyPick = await DailyPick.findOne({
    trading_date: { $gte: dayStart, $lt: dayEnd }
  }).lean();

  if (!dailyPick) {
    console.log(`${LOG} No DailyPick for ${date} — skipping`);
    return null;
  }

  // 2. Pull watchlist for funnel counts (optional; metrics still work without)
  const wl = await ShortlistWatchlist.findOne({ date }).lean();

  const mc = dailyPick.market_context || {};
  const picks = dailyPick.picks || [];
  const closed = picks.filter(p => CLOSED_STATUSES.includes(p?.trade?.status));
  const entered = picks.filter(p => p?.trade?.entry_price);

  const wins = closed.filter(p => (p.trade.pnl || 0) > 0).length;
  const losses = closed.filter(p => (p.trade.pnl || 0) < 0).length;
  const winRate = closed.length > 0 ? (wins / closed.length) * 100 : null;

  const totalPnl = closed.reduce((s, p) => s + (p.trade.pnl || 0), 0);
  const deployed = closed.reduce((s, p) => {
    const cap = (p.trade.entry_price || 0) * (p.trade.qty || 0);
    return s + cap;
  }, 0);
  const pnlPct = deployed > 0 ? (totalPnl / deployed) * 100 : null;

  const plannedRRs  = closed.map(p => p.trade.planned_rr).filter(x => typeof x === 'number');
  const realizedRRs = closed.map(p => p.trade.realized_rr).filter(x => typeof x === 'number');
  const avgPlannedRR  = plannedRRs.length  ? plannedRRs.reduce((a,b)=>a+b,0)  / plannedRRs.length  : null;
  const avgRealizedRR = realizedRRs.length ? realizedRRs.reduce((a,b)=>a+b,0) / realizedRRs.length : null;

  const pnls = closed.map(p => p.trade.pnl || 0);
  const maxLoss = pnls.length ? Math.min(...pnls) : null;
  const maxWin  = pnls.length ? Math.max(...pnls) : null;

  const halted       = !!dailyPick.circuit_breaker_tripped || (mc.regime === 'HALT');
  const haltReason   = dailyPick.circuit_breaker_reason || mc.halt_reason || null;

  const doc = {
    date,
    regime:           mc.regime || null,
    regime_score:     mc.regime_score ?? null,
    playbook:         mc.playbook || null,
    max_trades:       mc.max_trades ?? null,
    size_multiplier:  mc.size_multiplier ?? null,

    shortlist_size:   wl?.stats?.output_count ?? null,
    gate_survivors:   wl?.post_filter_summary
                       ? (wl.post_filter_summary.selected + wl.post_filter_summary.not_selected)
                       : null,
    picks_selected:   picks.filter(p => !p.promoted).length || picks.length,
    picks_promoted:   picks.filter(p => p.promoted).length,
    picks_entered:    entered.length,
    picks_closed:     closed.length,

    wins, losses,
    win_rate:        winRate  == null ? null : round2(winRate),
    total_pnl:       round2(totalPnl),
    pnl_pct:         pnlPct   == null ? null : round2(pnlPct),
    avg_planned_rr:  avgPlannedRR  == null ? null : round2(avgPlannedRR),
    avg_realized_rr: avgRealizedRR == null ? null : round2(avgRealizedRR),
    rr_drift:        (avgRealizedRR != null && avgPlannedRR != null)
                       ? round2(avgRealizedRR - avgPlannedRR) : null,
    max_loss_trade:  maxLoss == null ? null : round2(maxLoss),
    max_win_trade:   maxWin  == null ? null : round2(maxWin),

    halted,
    halt_reason:     haltReason,
    paper_trade:     isPaperTradeMode(),
    regime_version:  (process.env.REGIME_VERSION || 'v2').toLowerCase(),
    recorded_at:     new Date(),
  };

  await DailyPerformance.findOneAndUpdate({ date }, { $set: doc }, { upsert: true, new: true });
  console.log(`${LOG} ✅ recorded: closed=${closed.length} win_rate=${doc.win_rate}% pnl=₹${doc.total_pnl} (${doc.pnl_pct}%) realized_rr=${doc.avg_realized_rr} rr_drift=${doc.rr_drift}`);
  return doc;
}

/**
 * Rolling window summary — window in trading days.
 * Returns aggregate win-rate, avg P&L, Sharpe proxy, R:R drift, and alerts.
 */
export async function rollingSummary(windowDays = 20) {
  const rows = await DailyPerformance.find({
    paper_trade: isPaperTradeMode()
  }).sort({ date: -1 }).limit(windowDays).lean();

  if (rows.length === 0) return null;

  const wins  = rows.reduce((s, r) => s + (r.wins || 0), 0);
  const total = rows.reduce((s, r) => s + (r.wins || 0) + (r.losses || 0), 0);
  const pnls  = rows.map(r => r.total_pnl || 0);
  const avgPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const stdPnl = Math.sqrt(pnls.reduce((s, p) => s + (p - avgPnl) ** 2, 0) / pnls.length) || 1;
  const sharpeProxy = avgPnl / stdPnl;    // daily, not annualized — relative scale only

  const rrDrifts = rows.map(r => r.rr_drift).filter(x => typeof x === 'number');
  const avgRRDrift = rrDrifts.length ? rrDrifts.reduce((a, b) => a + b, 0) / rrDrifts.length : null;

  return {
    window_days:     windowDays,
    days_recorded:   rows.length,
    trades_closed:   total,
    win_rate:        total > 0 ? round2((wins / total) * 100) : null,
    avg_daily_pnl:   round2(avgPnl),
    daily_pnl_std:   round2(stdPnl),
    daily_sharpe:    round2(sharpeProxy),
    avg_rr_drift:    avgRRDrift == null ? null : round2(avgRRDrift),
    alerts: [
      ...(avgRRDrift != null && avgRRDrift < -0.3 ? ['rr_drift_warning'] : []),
      ...(total > 0 && wins / total < 0.35 ? ['win_rate_below_35pct'] : []),
    ],
  };
}

export default { recordDailyMetrics, rollingSummary };
