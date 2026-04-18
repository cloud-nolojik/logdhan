/**
 * Weekly Review Job — Saturday 10:00 IST.
 *
 * Aggregates Mon–Fri DailyPerformance rows into one WeeklyReview doc with:
 *   - Overall P&L, Sharpe, drawdown
 *   - Breakdown by scan_type / sector / direction / regime label
 *   - Best/worst day
 *   - Auto-generated alerts (e.g. "shortlist_gap_long lost 60% of trades")
 *
 * This is the post-trade learning loop. Without it, strategy decay is
 * invisible.
 */

import Agenda from 'agenda';
import DailyPick from '../../models/dailyPick.js';
import DailyPerformance from '../../models/dailyPerformance.js';
import WeeklyReview from '../../models/weeklyReview.js';
import { isPaperTradeMode } from '../kiteTradeIntegration.service.js';
import kiteConfig from '../../config/kite.config.js';
import { firebaseService } from '../firebase/firebase.service.js';

const LOG = '[WEEKLY-REVIEW]';

const CLOSED_STATUSES = ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT', 'FAILED'];

function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }

/**
 * Compute ISO week tag + Monday/Friday YYYY-MM-DD for a given reference date.
 * Reference date must be within the target week.
 */
function isoWeekKey(refDate) {
  const d = new Date(refDate);
  // Local IST — shift to UTC of IST midnight
  const istMs = d.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const weekdayMon0 = (ist.getUTCDay() + 6) % 7;  // 0 = Mon
  const monday = new Date(ist);  monday.setUTCDate(ist.getUTCDate() - weekdayMon0);
  const friday = new Date(monday); friday.setUTCDate(monday.getUTCDate() + 4);

  // ISO week number (per standard)
  const target = new Date(monday); target.setUTCHours(0, 0, 0, 0);
  const jan1 = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((target - jan1) / (24 * 60 * 60 * 1000) + jan1.getUTCDay() + 1) / 7);

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (dt) => `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;

  return {
    iso_week: `${target.getUTCFullYear()}-W${pad(weekNum)}`,
    from_date: ymd(monday),
    to_date:   ymd(friday),
  };
}

/**
 * Build a breakdown item from an array of trade objects.
 */
function buildBreakdown(keyFn, trades) {
  const grouped = {};
  for (const t of trades) {
    const k = keyFn(t) || 'unknown';
    if (!grouped[k]) grouped[k] = { trades: 0, wins: 0, losses: 0, pnl: 0, planned: [], realized: [] };
    const g = grouped[k];
    g.trades++;
    if ((t.pnl || 0) > 0) g.wins++; else g.losses++;
    g.pnl += (t.pnl || 0);
    if (typeof t.planned_rr === 'number') g.planned.push(t.planned_rr);
    if (typeof t.realized_rr === 'number') g.realized.push(t.realized_rr);
  }
  return Object.entries(grouped)
    .map(([key, g]) => {
      const avgP = g.planned.length  ? g.planned.reduce((a, b) => a + b, 0)  / g.planned.length  : null;
      const avgR = g.realized.length ? g.realized.reduce((a, b) => a + b, 0) / g.realized.length : null;
      return {
        key, trades: g.trades, wins: g.wins, losses: g.losses,
        win_rate: g.trades > 0 ? round2((g.wins / g.trades) * 100) : null,
        total_pnl: round2(g.pnl),
        avg_planned_rr:  avgP == null ? null : round2(avgP),
        avg_realized_rr: avgR == null ? null : round2(avgR),
        rr_drift:        (avgP != null && avgR != null) ? round2(avgR - avgP) : null,
      };
    })
    .sort((a, b) => b.total_pnl - a.total_pnl);
}

/**
 * Run one weekly review for the week containing `refDate` (default: yesterday).
 */
export async function generateWeeklyReview(refDate = new Date(Date.now() - 24 * 3600 * 1000)) {
  const { iso_week, from_date, to_date } = isoWeekKey(refDate);
  console.log(`${LOG} Generating review for ${iso_week} (${from_date} → ${to_date})`);

  // 1. Pull this week's DailyPerformance rows
  const perfRows = await DailyPerformance.find({
    date: { $gte: from_date, $lte: to_date }
  }).lean();

  if (perfRows.length === 0) {
    console.log(`${LOG} No DailyPerformance rows for ${iso_week} — skipping`);
    return null;
  }

  // 2. Pull DailyPick docs to get per-trade breakdowns
  const docs = await DailyPick.find({
    scan_date: {
      $gte: new Date(`${from_date}T00:00:00.000Z`),
      $lte: new Date(`${to_date}T23:59:59.999Z`),
    }
  }).lean();

  // Flatten closed trades from all picks
  const trades = [];
  for (const doc of docs) {
    const regime = doc.market_context?.regime || 'UNKNOWN';
    for (const p of (doc.picks || [])) {
      if (!CLOSED_STATUSES.includes(p?.trade?.status)) continue;
      trades.push({
        symbol: p.symbol,
        scan_type: p.scan_type,
        sector: p.sector || 'OTHER',
        direction: p.direction,
        regime,
        pnl: p.trade.pnl || 0,
        planned_rr: p.trade.planned_rr,
        realized_rr: p.trade.realized_rr,
      });
    }
  }

  // 3. Aggregate top-level metrics
  const totalTrades = trades.length;
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

  const dailyPnls = perfRows.map(r => r.total_pnl || 0);
  const avgDaily = dailyPnls.length ? dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length : 0;
  const stdDaily = dailyPnls.length > 1
    ? Math.sqrt(dailyPnls.reduce((s, x) => s + (x - avgDaily) ** 2, 0) / (dailyPnls.length - 1))
    : 0;
  const sharpeDaily = stdDaily > 0 ? avgDaily / stdDaily : null;
  const sharpeAnn   = sharpeDaily != null ? sharpeDaily * Math.sqrt(252) : null;

  // Drawdown on cumulative % returns
  const returns = perfRows.map(r => r.pnl_pct || 0);
  let cum = 0, peak = 0, maxDd = 0;
  for (const r of returns) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  const planned  = trades.map(t => t.planned_rr).filter(x => typeof x === 'number');
  const realized = trades.map(t => t.realized_rr).filter(x => typeof x === 'number');
  const avgP = planned.length  ? planned.reduce((a, b) => a + b, 0)  / planned.length  : null;
  const avgR = realized.length ? realized.reduce((a, b) => a + b, 0) / realized.length : null;

  // Best / worst day
  let bestDay = null, worstDay = null;
  for (const r of perfRows) {
    if (!bestDay  || (r.total_pnl || 0) > (bestDay.pnl  ?? -Infinity)) bestDay  = { date: r.date, pnl: round2(r.total_pnl || 0), trades: (r.wins || 0) + (r.losses || 0) };
    if (!worstDay || (r.total_pnl || 0) < (worstDay.pnl ?? Infinity)) worstDay = { date: r.date, pnl: round2(r.total_pnl || 0), trades: (r.wins || 0) + (r.losses || 0) };
  }

  // 4. Alerts
  const alerts = [];
  const byScan = buildBreakdown(t => t.scan_type, trades);
  for (const s of byScan) {
    if (s.trades >= 3 && s.win_rate < 35) alerts.push(`${s.key}: win rate ${s.win_rate}% (${s.wins}/${s.trades}) — below 35% floor`);
    if (s.trades >= 3 && s.rr_drift != null && s.rr_drift < -0.3) alerts.push(`${s.key}: rr_drift ${s.rr_drift} — planned vs realized gap widening`);
  }
  if (avgR != null && avgP != null && (avgR - avgP) < -0.3) alerts.push(`overall rr_drift ${round2(avgR - avgP)} — strategy decay check`);
  if (sharpeDaily != null && sharpeDaily < 0.3) alerts.push(`low daily Sharpe ${round2(sharpeDaily)} — review weights`);
  if (maxDd > 5) alerts.push(`weekly drawdown ${round2(maxDd)}% — near -5% weekly stop`);

  // 5. Upsert the review
  const review = {
    iso_week, from_date, to_date,
    days_recorded: perfRows.length,
    days_played:   perfRows.filter(r => ((r.wins || 0) + (r.losses || 0)) > 0).length,
    days_halted:   perfRows.filter(r => r.halted).length,
    days_zero_picks: perfRows.filter(r => (r.picks_closed || 0) === 0 && !r.halted).length,

    total_trades: totalTrades,
    wins, losses,
    win_rate: totalTrades > 0 ? round2((wins / totalTrades) * 100) : null,
    total_pnl: round2(totalPnl),
    avg_daily_pnl: round2(avgDaily),
    daily_pnl_std: round2(stdDaily),
    sharpe_daily:    sharpeDaily != null ? round2(sharpeDaily) : null,
    sharpe_annualized: sharpeAnn != null ? round2(sharpeAnn) : null,
    max_drawdown_pct: round2(maxDd),

    avg_planned_rr:  avgP == null ? null : round2(avgP),
    avg_realized_rr: avgR == null ? null : round2(avgR),
    rr_drift:        (avgP != null && avgR != null) ? round2(avgR - avgP) : null,

    by_scan_type: byScan,
    by_sector:    buildBreakdown(t => t.sector, trades),
    by_direction: buildBreakdown(t => t.direction, trades),
    by_regime:    buildBreakdown(t => t.regime, trades),

    best_day: bestDay,
    worst_day: worstDay,
    alerts,

    paper_trade:    isPaperTradeMode(),
    regime_version: (process.env.REGIME_VERSION || 'v2').toLowerCase(),
    generated_at:   new Date(),
  };

  await WeeklyReview.findOneAndUpdate({ iso_week }, { $set: review }, { upsert: true, new: true });
  console.log(`${LOG} ✅ ${iso_week}: ${totalTrades} trades, win_rate=${review.win_rate}%, pnl=₹${review.total_pnl}, sharpe=${review.sharpe_daily}, alerts=${alerts.length}`);

  // 6. Notify admin with a short digest
  try {
    if (kiteConfig.ADMIN_USER_ID) {
      const title = `Weekly Review ${iso_week}`;
      const body = `${totalTrades} trades · win rate ${review.win_rate}% · P&L ₹${review.total_pnl} · Sharpe ${review.sharpe_daily ?? 'n/a'}${alerts.length ? ` · ${alerts.length} alert${alerts.length > 1 ? 's' : ''}` : ''}`;
      await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID, title, body, { type: 'WEEKLY_REVIEW', route: '/daily-picks' });
    }
  } catch (_) { /* ignore */ }

  return review;
}

class WeeklyReviewJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = { runs: 0, errors: 0, lastRunAt: null };
  }

  async initialize() {
    if (this.isInitialized) return;
    this.agenda = new Agenda({
      db: {
        address: process.env.MONGODB_URI,
        collection: 'weekly_review_jobs',
        options: { useUnifiedTopology: true },
      },
      processEvery: '1 minute',
      maxConcurrency: 1,
      defaultConcurrency: 1,
    });
    this.defineJobs();
    await this.agenda.start();
    await this.scheduleRecurringJobs();
    this.isInitialized = true;
    console.log(`${LOG} Ready. Cron: 0 10 * * 6 IST (Saturday 10:00).`);
  }

  defineJobs() {
    this.agenda.define('weekly-review', async () => {
      if (this.isRunning) return;
      this.isRunning = true;
      try {
        const result = await generateWeeklyReview();
        this.stats.runs++;
        this.stats.lastRunAt = new Date();
        return result;
      } catch (err) {
        this.stats.errors++;
        console.error(`${LOG} Run failed:`, err);
        throw err;
      } finally {
        this.isRunning = false;
      }
    });

    this.agenda.define('manual-weekly-review', async (job) => {
      if (this.isRunning) return;
      this.isRunning = true;
      try {
        const refDate = job.attrs.data?.refDate ? new Date(job.attrs.data.refDate) : undefined;
        return await generateWeeklyReview(refDate);
      } finally {
        this.isRunning = false;
      }
    });
  }

  async scheduleRecurringJobs() {
    await this.agenda.cancel({ name: 'weekly-review' });
    // Saturday 10:00 IST — trading week just closed.
    await this.agenda.every('0 10 * * 6', 'weekly-review', {}, { timezone: 'Asia/Kolkata' });
    console.log(`${LOG} Scheduled: 10:00 IST, Saturday`);
  }

  async triggerNow(refDate) {
    if (!this.isInitialized) throw new Error('WeeklyReviewJob not initialized');
    const job = await this.agenda.now('manual-weekly-review', refDate ? { refDate } : {});
    return { success: true, jobId: job.attrs._id };
  }

  getStats() {
    return { ...this.stats, isInitialized: this.isInitialized, isRunning: this.isRunning };
  }

  async shutdown() {
    if (this.agenda) { await this.agenda.stop(); console.log(`${LOG} Shutdown complete`); }
  }
}

const weeklyReviewJob = new WeeklyReviewJob();
export default weeklyReviewJob;
export { WeeklyReviewJob };
