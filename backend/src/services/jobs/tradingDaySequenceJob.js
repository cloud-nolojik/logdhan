/**
 * Trading Day Sequence — strict sequential orchestrator.
 *
 * One cron fires at 08:30 IST Mon–Fri. The handler runs every morning step
 * in strict sequence, waiting on wall-clock time between steps. Step N+1
 * starts only after Step N has completed (no cron races, no parallel runs).
 *
 *   08:30   runDailyPicks()           — shortlist, gate filter, save DailyPick
 *   09:08   runPreopenDepthCheck()    — Kite /quote, prune + promote
 *   09:30   ORB Pass 1 (15-min)        — startOrbCollection + validateAndPlaceEntries
 *   09:45   ORB Pass 2 (30-min)        — retry picks that failed Pass 1
 *   10:00   ORB Pass 3 (45-min)        — final retry
 *
 * Design notes
 *  - Agenda `lockLifetime` is set to 3 hours to cover the full sequence.
 *  - Each step failure is logged but does NOT abort subsequent steps (the
 *    9:30 ORB can still fire useful orders even if 9:08 pre-open scraping
 *    errored). If you want strict-stop-on-failure, flip STOP_ON_ERROR to true.
 *  - The individual crons that used to fire each of these steps are cancelled
 *    on init, so we never double-run.
 *
 *  Other jobs (fill-fallback, monitor, tighten, hard-flat at 14:45, exit at
 *  15:00) still run on their own cron schedule in dailyEntryJob — they are
 *  not part of the 8:30–10:00 entry sequence.
 */

import Agenda from 'agenda';
import MarketHoursUtil from '../../utils/marketHours.js';
import {
  runDailyPicks,
  validateAndPlaceEntries,
  startOrbCollection,
} from '../dailyPicks/dailyPicksService.js';
import { runPreopenDepthCheck } from './preopenDepthJob.js';

const LOG = '[TRADING-DAY-SEQ]';
const STOP_ON_ERROR = false;

// Crons replaced by this orchestrator. Cancelled at init so neither Agenda
// cron records fire the same work twice on the same day.
const REPLACED_CRONS = [
  'daily-pick-scan',                  // was 08:30 in dailyPicksJob
  'preopen-depth-check',              // was 09:12 in preopenDepthJob
  'daily-picks-validate-entry',       // was 09:30 in dailyEntryJob
  'daily-picks-validate-entry-pass2', // was 09:46
  'daily-picks-validate-entry-pass3', // was 10:01
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function istNow() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}

/**
 * Sleep until a specific IST hour/minute/second on today's date.
 * If the target time has already passed, resolves immediately.
 */
function waitUntilIst(hour, minute, second = 0) {
  const now = istNow();
  const target = new Date(now);
  target.setUTCHours(hour, minute, second, 0);
  const msUntil = target.getTime() - now.getTime();

  if (msUntil <= 0) {
    console.log(`${LOG} waitUntilIst(${hour}:${minute}:${second}) — target already passed, continuing immediately`);
    return Promise.resolve();
  }
  const mins = Math.round(msUntil / 60000 * 10) / 10;
  console.log(`${LOG} waitUntilIst(${hour.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')}:${second.toString().padStart(2,'0')}) — sleeping ${mins} min`);
  return new Promise((resolve) => setTimeout(resolve, msUntil));
}

/**
 * Run a single step with defensive error handling.
 * If STOP_ON_ERROR is true, re-throws on failure to abort the sequence.
 */
async function runStep(label, fn) {
  const t0 = Date.now();
  console.log(`${LOG} ▶ [${label}] starting at IST ${istNow().toISOString().slice(11,19)}`);
  try {
    const result = await fn();
    const ms = Date.now() - t0;
    console.log(`${LOG} ✅ [${label}] completed in ${ms}ms`);
    return { ok: true, result, ms };
  } catch (err) {
    const ms = Date.now() - t0;
    console.error(`${LOG} ❌ [${label}] failed in ${ms}ms: ${err.message}`);
    console.error(err.stack || err);
    if (STOP_ON_ERROR) throw err;
    return { ok: false, error: err.message, ms };
  }
}

// ─── Main sequence ─────────────────────────────────────────────────────────
/**
 * Runs the full 08:30 → 10:00 sequence. Each step blocks the next by wall clock.
 * Returns a summary object of what ran / what failed.
 */
export async function runTradingDaySequence({
  skipWait = false,
  allowOutdatedCandle = false,
} = {}) {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Sequence starting at IST ${istNow().toISOString().slice(0,19)} (skipWait=${skipWait}, allowOutdatedCandle=${allowOutdatedCandle})`);
  console.log(`${LOG} ════════════════════════════════════════`);
  const summary = { started_at: new Date().toISOString(), steps: [] };

  // Step 1 — 08:30 Daily Picks
  const s1 = await runStep('08:30 daily-pick-scan', () => runDailyPicks({ allowOutdatedCandle }));
  summary.steps.push({ name: '08:30 daily-pick-scan', ...s1 });

  // Step 2 — 09:08 Pre-open Depth (DISABLED: scanner.py path bypasses pre-open depth check)
  // if (!skipWait) await waitUntilIst(9, 8);
  // const s2 = await runStep('09:08 preopen-depth-check', () => runPreopenDepthCheck());
  // summary.steps.push({ name: '09:08 preopen-depth-check', ...s2 });

  // Step 3 — 09:30 validateAndPlaceEntries (DISABLED: AMO orders already placed at 8:30)
  // scanner.py picks are queued as AMO MARKET inside runDailyPicks Step 7.5.
  // By 9:30 all picks are ORDER_PLACED — no eligible picks remain, this is a no-op.
  // if (!skipWait) await waitUntilIst(9, 30);
  // const s3 = await runStep('09:30 scanner-entry', async () => {
  //   const validate = await validateAndPlaceEntries({ orbPass: 1 });
  //   return { validate };
  // });
  // summary.steps.push({ name: '09:30 scanner-entry', ...s3 });

  // Step 4 — 09:45 ORB Pass 2 (DISABLED: scanner picks placed in one pass at 09:30)
  // if (!skipWait) await waitUntilIst(9, 45);
  // const s4 = await runStep('09:45 orb-pass-2', async () => {
  //   const orb = await startOrbCollection({ orbPass: 2 });
  //   if (!orb?.success) return { orb, validate: { skipped: true, reason: 'orb_fetch_failed' } };
  //   const validate = await validateAndPlaceEntries({ orbPass: 2 });
  //   return { orb, validate };
  // });
  // summary.steps.push({ name: '09:45 orb-pass-2', ...s4 });

  // Step 5 — 10:00 ORB Pass 3 (DISABLED: scanner picks placed in one pass at 09:30)
  // if (!skipWait) await waitUntilIst(10, 0);
  // const s5 = await runStep('10:00 orb-pass-3', async () => {
  //   const orb = await startOrbCollection({ orbPass: 3 });
  //   if (!orb?.success) return { orb, validate: { skipped: true, reason: 'orb_fetch_failed' } };
  //   const validate = await validateAndPlaceEntries({ orbPass: 3 });
  //   return { orb, validate };
  // });
  // summary.steps.push({ name: '10:00 orb-pass-3', ...s5 });

  summary.completed_at = new Date().toISOString();

  // ─── Honest success reporting ────────────────────────────────────────────
  // "No step threw" isn't the same as "the pipeline produced something tradeable."
  // Inspect Step 1's result and flag outcomes:
  //   - picks_generated: did runDailyPicks save any picks?
  //   - halted:          was today an intentional sit-out (HALT / event blackout)?
  //   - step_errors:     any step returned ok=false?
  const step1 = summary.steps[0];
  const s1Result = step1?.result;
  const picksGenerated = Number(s1Result?.picks) || 0;
  const halted = !!s1Result?.halted;
  const allStepsOk = summary.steps.every(s => s.ok);

  summary.picks_generated = picksGenerated;
  summary.halted = halted;
  summary.halt_reason = s1Result?.reason || null;
  summary.steps_errored = summary.steps.filter(s => !s.ok).map(s => s.name);

  // all_ok means BOTH "no exceptions" AND ("picks produced" OR "intentionally halted")
  summary.all_ok = allStepsOk && (picksGenerated > 0 || halted);

  // Surface warnings separately — these don't fail all_ok but are worth seeing
  summary.warnings = [];
  if (allStepsOk && !halted && picksGenerated === 0) {
    summary.warnings.push('zero_picks_generated — step 1 completed but no candidates survived Step 4 gates');
  }
  if (!allStepsOk) {
    summary.warnings.push(`${summary.steps_errored.length} step(s) errored: ${summary.steps_errored.join(', ')}`);
  }

  console.log(`${LOG} ════════════════════════════════════════`);
  const headlineOk = summary.all_ok ? '✅' : '⚠️';
  console.log(`${LOG} ${headlineOk} Sequence finished at IST ${istNow().toISOString().slice(0,19)}`);
  console.log(`${LOG}    all_ok=${summary.all_ok}  picks=${picksGenerated}  halted=${halted}${summary.halt_reason ? ` (${summary.halt_reason})` : ''}`);
  summary.steps.forEach(s => {
    console.log(`${LOG}   ${s.ok ? '✓' : '✗'} ${s.name} (${s.ms}ms)${s.error ? ' — ' + s.error : ''}`);
  });
  if (summary.warnings.length) {
    console.log(`${LOG} ⚠️  Warnings:`);
    summary.warnings.forEach(w => console.log(`${LOG}      - ${w}`));
  }
  console.log(`${LOG} ════════════════════════════════════════`);
  return summary;
}

// ─── Agenda wrapper ────────────────────────────────────────────────────────

class TradingDaySequenceJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = { runs: 0, errors: 0, lastRunAt: null, lastResult: null };
  }

  async initialize() {
    if (this.isInitialized) return;
    console.log(`${LOG} Initializing...`);

    this.agenda = new Agenda({
      db: {
        address: process.env.MONGODB_URI,
        collection: 'trading_day_sequence_jobs',
        options: { useUnifiedTopology: true },
      },
      processEvery: '30 seconds',
      maxConcurrency: 1,
      defaultConcurrency: 1,
      defaultLockLifetime: 3 * 60 * 60 * 1000,  // 3 hours — covers full sequence
    });

    this.defineJobs();
    this.setupEventHandlers();
    await this.agenda.start();
    await this.cancelReplacedCrons();
    await this.scheduleRecurringJobs();

    this.isInitialized = true;
    console.log(`${LOG} Ready. Cron: 30 8 * * 1-5 IST.`);
  }

  defineJobs() {
    // Long-running scheduled job — needs a generous lockLifetime.
    this.agenda.define(
      'trading-day-sequence',
      { lockLifetime: 3 * 60 * 60 * 1000, concurrency: 1 },
      async () => {
        if (this.isRunning) {
          console.log(`${LOG} Sequence already running; skip`);
          return;
        }
        this.isRunning = true;
        try {
          const isTradingDay = await MarketHoursUtil.isTradingDay();
          if (!isTradingDay) {
            console.log(`${LOG} Not a trading day; skip`);
            return { skipped: true, reason: 'not_trading_day' };
          }
          const result = await runTradingDaySequence({ skipWait: false });
          this.stats.runs++;
          this.stats.lastRunAt = new Date();
          this.stats.lastResult = result;
          return result;
        } catch (err) {
          this.stats.errors++;
          console.error(`${LOG} Sequence failed:`, err);
          throw err;
        } finally {
          this.isRunning = false;
        }
      }
    );

    // Manual back-to-back run (no clock waits) — for weekend testing
    this.agenda.define(
      'manual-trading-day-sequence',
      { lockLifetime: 60 * 60 * 1000 },
      async () => {
        if (this.isRunning) return;
        this.isRunning = true;
        try {
          const result = await runTradingDaySequence({ skipWait: true });
          this.stats.lastRunAt = new Date();
          this.stats.lastResult = result;
          return result;
        } finally {
          this.isRunning = false;
        }
      }
    );
  }

  setupEventHandlers() {
    this.agenda.on('ready',    () => console.log(`${LOG} Agenda ready`));
    this.agenda.on('start',    (j) => console.log(`${LOG} Job starting: ${j.attrs.name}`));
    this.agenda.on('complete', (j) => console.log(`${LOG} Job completed: ${j.attrs.name}`));
    this.agenda.on('fail',     (e, j) => console.error(`${LOG} Job failed: ${j.attrs.name}`, e));
  }

  /**
   * Cancel the per-step crons that this orchestrator replaces.
   * Runs ACROSS ALL agenda collections because each of the old jobs had its
   * own collection — we target each one directly.
   */
  async cancelReplacedCrons() {
    const mongoose = (await import('mongoose')).default;
    const db = mongoose.connection.db;

    const collections = [
      'daily_picks_jobs',        // dailyPicksJob
      'preopen_depth_jobs',      // preopenDepthJob
      'daily_entry_jobs',        // dailyEntryJob
    ];

    let totalDeleted = 0;
    for (const collName of collections) {
      try {
        const coll = db.collection(collName);
        const res = await coll.deleteMany({ name: { $in: REPLACED_CRONS } });
        if (res.deletedCount > 0) {
          console.log(`${LOG} Cancelled ${res.deletedCount} replaced-cron records in ${collName}`);
          totalDeleted += res.deletedCount;
        }
      } catch (err) {
        console.warn(`${LOG} Could not clear ${collName}: ${err.message}`);
      }
    }
    if (totalDeleted === 0) console.log(`${LOG} No replaced-cron records to cancel (clean state)`);
  }

  async scheduleRecurringJobs() {
    await this.agenda.cancel({ name: 'trading-day-sequence' });
    await this.agenda.every('30 8 * * 1-5', 'trading-day-sequence', {}, {
      timezone: 'Asia/Kolkata',
    });
    console.log(`${LOG} Scheduled: 08:30 IST, Mon–Fri`);
  }

  async triggerNow(opts = { skipWait: true }) {
    if (!this.isInitialized) throw new Error('TradingDaySequenceJob not initialized');
    const job = await this.agenda.now('manual-trading-day-sequence', opts);
    return { success: true, jobId: job.attrs._id };
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

const tradingDaySequenceJob = new TradingDaySequenceJob();
export default tradingDaySequenceJob;
export { TradingDaySequenceJob };
