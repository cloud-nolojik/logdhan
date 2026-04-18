/**
 * Pre-open Depth Job — 09:12:30 IST
 *
 * Fires 2 min 30 s after NSE matching completes (09:08–09:12 matching window),
 * when every stock's opening price has settled. Does one Kite /quote call for
 * today's shortlist symbols and stamps each with bid/ask imbalance + depth
 * signals. Then prunes DailyPick.picks[] so only survivors carry forward to
 * the 09:15 ORB collection.
 *
 * Schedule: Mon–Fri, 09:12:30 IST. Pattern mirrors dailyPicksJob.js (Agenda +
 * MongoDB job store + manual-trigger variant + graceful shutdown).
 */

import Agenda from 'agenda';
import MarketHoursUtil from '../../utils/marketHours.js';
import ShortlistWatchlist from '../../models/shortlistWatchlist.js';
import DailyPick from '../../models/dailyPick.js';
import { fetchQuotesForSymbols } from '../kiteQuote.service.js';
import { analyzeAll } from '../dailyPicks/preopenDepthAnalyzer.js';
import { getIstDayRange } from '../../utils/tradingDay.js';

const LOG = '[PREOPEN-DEPTH-JOB]';

function todayIstDateStr() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  return new Date(istMs).toISOString().slice(0, 10);
}

/**
 * Core work for one run. Exported so the manual-trigger + scheduled variants
 * can share exactly the same body.
 */
export async function runPreopenDepthCheck() {
  const date = todayIstDateStr();
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} runPreopenDepthCheck(${date}) starting`);
  const t0 = Date.now();

  // 1. Load today's shortlist watchlist
  const watchlist = await ShortlistWatchlist.findOne({ date }).lean();
  if (!watchlist) {
    console.log(`${LOG} No ShortlistWatchlist for ${date} — nothing to check`);
    return { success: true, reason: 'no_watchlist' };
  }

  // Only check directional, Step-4-surviving rows. Anything already dropped by
  // earnings/gate is skipped.
  const eligible = (watchlist.candidates || []).filter(c =>
    c.direction !== 'NEUTRAL' &&
    (c.post_filter_status === 'selected' || c.post_filter_status === 'not_selected')
  );
  if (eligible.length === 0) {
    console.log(`${LOG} Watchlist has no Step-4 survivors (direction + post_filter_status)`);
    return { success: true, reason: 'no_eligible_candidates' };
  }
  console.log(`${LOG} Checking ${eligible.length} Step-4 survivors against Kite /quote`);

  // 2. Fetch full quotes from Kite (one call, up to 500 symbols per batch)
  const symbols = eligible.map(c => c.trading_symbol);
  const quoteMap = await fetchQuotesForSymbols(symbols, 'NSE');

  // 3. Analyze each candidate
  const resultMap = analyzeAll(eligible, quoteMap);

  // 4. Stamp ShortlistWatchlist with per-row preopen_*
  const stampRes = await ShortlistWatchlist.stampPreopenFilter(date, resultMap);
  console.log(`${LOG} Stamped ${stampRes.modifiedCount}/${stampRes.matchedCount} candidates on ShortlistWatchlist`);

  // Guard: if every candidate came back thin/no-quote AND we're outside the
  // 9:00–9:20 IST pre-open window, Kite has no real depth to offer (weekend /
  // non-market-hours run). Stamping ShortlistWatchlist is still useful, but
  // pruning DailyPick.picks[] on phantom "thin" results would destroy picks
  // that are valid for the next trading session.
  const allNoDepth = [...resultMap.values()].every(
    r => r.status === 'dropped_preopen_thin' || r.status === 'dropped_preopen_no_quote'
  );
  if (allNoDepth) {
    const istNow    = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const istHour   = istNow.getUTCHours();
    const istMin    = istNow.getUTCMinutes();
    const inWindow  = istHour === 9 && istMin <= 20; // 09:00–09:20 IST
    if (!inWindow) {
      console.log(`${LOG} ⚠️  All ${eligible.length} candidates returned no depth outside the 09:00–09:20 IST pre-open window.`);
      console.log(`${LOG} ⚠️  Skipping DailyPick prune — no real pre-open data available (likely weekend / off-hours test).`);
      const ms = Date.now() - t0;
      console.log(`${LOG} ✅ runPreopenDepthCheck done in ${ms}ms. Final picks=n/a (pruned=0, promoted=0, reason=no_depth_outside_window)`);
      console.log(`${LOG} ════════════════════════════════════════`);
      return { success: true, date, checked: eligible.length, preopenSummary: stampRes.modifiedCount,
               prunedFromDailyPick: 0, promotedIntoDailyPick: 0, duration_ms: ms, reason: 'no_depth_outside_window' };
    }
  }

  // 5. Prune DailyPick.picks[] — drop anything that didn't survive pre-open
  // Use IST-aware boundaries: trading_date is stored as IST midnight in UTC
  // (e.g., 2026-04-18 IST → 2026-04-17T18:30:00Z). A naive UTC date-string
  // query misses it entirely. getIstDayRange() returns the correct UTC window.
  const { startUtc, endUtc } = getIstDayRange();
  const dailyPick = await DailyPick.findOne({
    trading_date: { $gte: startUtc, $lt: endUtc }
  });

  let prunedCount = 0;
  let promotedCount = 0;
  const promotedSymbols = [];

  if (dailyPick && Array.isArray(dailyPick.picks)) {
    const droppedReasons = [];
    const survivingPicks = dailyPick.picks.filter(p => {
      const r = resultMap.get(p.symbol);
      if (!r || r.status !== 'kept') {
        droppedReasons.push(`${p.symbol}(${r?.status || 'unknown'})`);
        prunedCount++;
        return false;
      }
      // Attach the preopen signals so the 9:30 ORB ranker can see them
      p.preopen_score = r.score;
      p.preopen_imbalance = r.imbalance;
      p.preopen_mid_pct = r.mid_pct;
      return true;
    });

    if (prunedCount > 0) {
      console.log(`${LOG} Pruned ${prunedCount} pre-market picks: ${droppedReasons.join(', ')}`);
    } else {
      console.log(`${LOG} All ${dailyPick.picks.length} pre-market picks survived pre-open`);
    }

    // ─── Backup promotion — fill vacated slots ───────────────────────────
    // Target = max_trades from 8:30 regime compute. If preopen pruned someone
    // out and we have backups from Step 4 ranked #3/#4/…, promote them in.
    const maxTrades = Number(dailyPick.market_context?.max_trades) || 0;
    const slotsOpen = Math.max(0, maxTrades - survivingPicks.length);

    if (slotsOpen > 0) {
      const alreadyIn = new Set(survivingPicks.map(p => p.symbol));

      // Candidates are: shortlist rows that (a) were Step-4 survivors marked
      // not_selected at 8:30, and (b) passed pre-open (status==='kept'). Rank
      // by composite_score × 100 + preopen_score × 100 (both ~0-100 scale).
      const backups = (watchlist.candidates || [])
        .filter(c =>
          c.post_filter_status === 'not_selected' &&
          !alreadyIn.has(c.trading_symbol))
        .map(c => {
          const r = resultMap.get(c.trading_symbol);
          return { candidate: c, result: r };
        })
        .filter(x => x.result?.status === 'kept')
        .map(x => ({
          ...x,
          compositeScaled: (x.candidate.composite_score || 0) * 100,
          preopenScaled:   (x.result.score || 0) * 100,
          combinedRank: ((x.candidate.composite_score || 0) + (x.result.score || 0)) * 50,
        }))
        .sort((a, b) => b.combinedRank - a.combinedRank);

      const toPromote = backups.slice(0, slotsOpen);
      if (toPromote.length > 0) {
        console.log(`${LOG} Promoting ${toPromote.length} backup(s) to fill ${slotsOpen} open slot(s): ${toPromote.map(x => `${x.candidate.trading_symbol}(composite=${x.candidate.composite_score?.toFixed(2)}, preopen=${x.result.score?.toFixed(2)})`).join(', ')}`);

        for (const { candidate: c, result: r, combinedRank } of toPromote) {
          const pick = {
            symbol: c.trading_symbol,
            instrument_key: c.instrument_key,
            stock_name: c.name,
            scan_type: c.direction === 'SHORT' ? 'shortlist_promoted_short' : 'shortlist_promoted_long',
            direction: c.direction,
            rank_score: Math.round(combinedRank * 100) / 100,
            regime_bonus: 0,
            levels: null,  // pure-ORB: filled at 09:30
            trade: { status: 'PENDING' },
            kite: { kite_status: 'pending' },
            ai_insight: null,
            ai_generated: false,
            news_sentiment: null,
            news_adjustment: 0,
            news_context: null,
            promoted: true,
            preopen_score: r.score,
            preopen_imbalance: r.imbalance,
            preopen_mid_pct: r.mid_pct,
            shortlist_composite: c.composite_score,
          };
          survivingPicks.push(pick);
          promotedSymbols.push(c.trading_symbol);
          promotedCount++;
        }
      } else {
        console.log(`${LOG} ${slotsOpen} slot(s) open but no backups passed pre-open — trading lighter today`);
      }
    }

    // Persist the updated picks array (prunes + promotions)
    if (prunedCount > 0 || promotedCount > 0) {
      dailyPick.picks = survivingPicks;
      dailyPick.markModified('picks');
      await dailyPick.save();
      console.log(`${LOG} DailyPick.picks saved: ${survivingPicks.length} active (${survivingPicks.length - promotedCount} original, ${promotedCount} promoted)`);
    }
  }

  // 6. Update ShortlistWatchlist.post_filter_status for any promoted backups
  //    ('not_selected' → 'promoted'). One bulk update, idempotent.
  if (promotedSymbols.length > 0) {
    const wldoc = await ShortlistWatchlist.findOne({ date });
    if (wldoc) {
      let updated = 0;
      for (const c of wldoc.candidates) {
        if (promotedSymbols.includes(c.trading_symbol) && c.post_filter_status === 'not_selected') {
          c.post_filter_status = 'promoted';
          if (wldoc.post_filter_summary) {
            wldoc.post_filter_summary.not_selected = Math.max(0, (wldoc.post_filter_summary.not_selected || 0) - 1);
            // 'promoted' isn't in the rollup schema — keep summary numerically sane without breaking shape
          }
          updated++;
        }
      }
      if (updated > 0) {
        wldoc.markModified('candidates');
        await wldoc.save();
        console.log(`${LOG} ShortlistWatchlist post_filter_status: flipped ${updated} 'not_selected' → 'promoted'`);
      }
    }
  }

  const ms = Date.now() - t0;
  const finalCount = dailyPick?.picks?.length || 0;
  console.log(`${LOG} ✅ runPreopenDepthCheck done in ${ms}ms. Final picks=${finalCount} (pruned=${prunedCount}, promoted=${promotedCount})`);
  console.log(`${LOG} ════════════════════════════════════════`);
  return {
    success: true,
    date,
    checked: eligible.length,
    preopenSummary: stampRes.modifiedCount,
    prunedFromDailyPick: prunedCount,
    promotedIntoDailyPick: promotedCount,
    duration_ms: ms
  };
}

class PreopenDepthJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = { runsCompleted: 0, errors: 0, lastRunAt: null, lastResult: null };
  }

  async initialize() {
    if (this.isInitialized) {
      console.log(`${LOG} Already initialized`);
      return;
    }
    try {
      console.log(`${LOG} Initializing...`);
      this.agenda = new Agenda({
        db: {
          address: process.env.MONGODB_URI,
          collection: 'preopen_depth_jobs',
          options: { useUnifiedTopology: true }
        },
        processEvery: '30 seconds',   // sub-minute precision matters here
        maxConcurrency: 1,
        defaultConcurrency: 1
      });

      this.defineJobs();
      this.setupEventHandlers();
      await this.agenda.start();
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log(`${LOG} Initialization complete`);
    } catch (err) {
      console.error(`${LOG} Failed to initialize:`, err);
      throw err;
    }
  }

  defineJobs() {
    this.agenda.define('preopen-depth-check', async () => {
      if (this.isRunning) { console.log(`${LOG} Already running, skip`); return; }
      this.isRunning = true;
      try {
        const isTrading = await MarketHoursUtil.isTradingDay();
        if (!isTrading) {
          console.log(`${LOG} Not a trading day, skip`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        // Cron fires at 09:12:00 IST. Sleep until 09:12:30 IST so we're
        // safely past NSE's 09:08–09:12 matching window. Agenda cron only
        // supports minute-precision, hence this in-handler delay.
        const istNow = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
        const istSec = istNow.getUTCSeconds();
        const delayMs = istSec < 30 ? (30 - istSec) * 1000 : 0;
        if (delayMs > 0) {
          console.log(`${LOG} Waiting ${delayMs}ms to reach 09:12:30 IST for clean pre-open depth`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        const result = await runPreopenDepthCheck();
        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        return result;
      } catch (err) {
        this.stats.errors++;
        console.error(`${LOG} Run failed:`, err);
        throw err;
      } finally {
        this.isRunning = false;
      }
    });

    // Manual trigger variant (bypasses trading-day gate — for weekend backfills/testing)
    this.agenda.define('manual-preopen-depth-check', async () => {
      if (this.isRunning) { console.log(`${LOG} Already running, skip manual`); return; }
      this.isRunning = true;
      try {
        const result = await runPreopenDepthCheck();
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        return result;
      } finally {
        this.isRunning = false;
      }
    });
  }

  setupEventHandlers() {
    this.agenda.on('ready',    ()        => console.log(`${LOG} Agenda ready`));
    this.agenda.on('start',    (job)     => console.log(`${LOG} Job starting: ${job.attrs.name}`));
    this.agenda.on('complete', (job)     => console.log(`${LOG} Job completed: ${job.attrs.name}`));
    this.agenda.on('fail',     (err,job) => console.error(`${LOG} Job failed: ${job.attrs.name}`, err));
  }

  async scheduleRecurringJobs() {
    // Clear any existing schedule so cron changes on restart take effect
    await this.agenda.cancel({ name: 'preopen-depth-check' });

    // Skip self-scheduling when the tradingDaySequence orchestrator owns
    // the 09:08 step. Default: individual crons are disabled.
    const ownedBySequence = String(process.env.DISABLE_INDIVIDUAL_CRONS ?? 'true').toLowerCase() !== 'false';
    if (ownedBySequence) {
      console.log(`${LOG} Skipping self-schedule — owned by tradingDaySequenceJob (set DISABLE_INDIVIDUAL_CRONS=false to restore)`);
      return;
    }

    // 09:12:30 IST, Mon–Fri. Agenda's `every` accepts human intervals or cron,
    // but cron is seconds-precision-limited at 5 fields. For 09:12:30 we use
    // an ISO8601 RRULE via explicit .schedule() on a recurring job.
    //
    // Simplest reliable path: schedule at 09:12 IST via cron, then inside the
    // handler delay 30 seconds before the Kite call. Keeps dependencies simple.
    await this.agenda.every('12 9 * * 1-5', 'preopen-depth-check', {}, {
      timezone: 'Asia/Kolkata'
    });

    console.log(`${LOG} Scheduled: 09:12 IST (with in-job +30s delay → effective 09:12:30), Mon-Fri`);
  }

  async triggerNow() {
    if (!this.isInitialized) throw new Error('Preopen depth job not initialized');
    console.log(`${LOG} Manual trigger requested`);
    const job = await this.agenda.now('manual-preopen-depth-check', {});
    return { success: true, jobId: job.attrs._id, scheduledAt: job.attrs.nextRunAt };
  }

  getStats() {
    return { ...this.stats, isInitialized: this.isInitialized, isRunning: this.isRunning };
  }

  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log(`${LOG} Shutdown complete`);
    }
  }
}

const preopenDepthJob = new PreopenDepthJob();
export default preopenDepthJob;
export { PreopenDepthJob };
