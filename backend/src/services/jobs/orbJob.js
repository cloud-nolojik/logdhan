/**
 * ORB Job — Opening Range Breakout Scheduler
 *
 * Completely independent of the daily-picks pipeline.
 * Runs its own Agenda instance (collection: orb_jobs) so it never
 * interferes with daily-picks-* job names or lock state.
 *
 * Scheduled runs (Mon-Fri IST):
 * 1. 09:08 — orb-pre-open      : fetch NSE pre-open IEP, build universe, persist to DB
 * 2. 09:30 — orb-record-range  : read first 15-min candle OHLC, set OR high/low per candidate
 * 3. every-1min 9-10 — orb-check-breakout : check LTP vs OR high; enter if breakout (active 9:30–10:30)
 * 4. every-5min 9-14 — orb-monitor    : track SL-M / target hits, time-exit at 10:30 if still open
 * 5. 15:15 — orb-force-exit    : hard-flat any remaining ORB MIS positions
 *
 * Manual triggers via triggerXxx() methods (for API or dev console).
 */

import Agenda from 'agenda';
import {
  fetchPreOpenUniverse,
  recordOpeningRanges,
  checkBreakouts,
  monitorOrbPositions,
  forceExitOrb,
} from '../orb/orbService.js';
import MarketHoursUtil from '../../utils/marketHours.js';

const LOG = '[ORB-JOB]';

class OrbJob {
  constructor() {
    this.agenda        = null;
    this.isInitialized = false;
    this.runningJobs   = new Set();
    this.stats = {
      preOpenRuns:   0,
      rangeRecords:  0,
      breakoutChecks: 0,
      monitorRuns:   0,
      errors:        0,
      lastRunAt:     null,
      lastResult:    null,
    };
  }

  // ─── Initialization ──────────────────────────────────────────────────────────

  async initialize() {
    if (this.isInitialized) {
      console.log(`${LOG} Already initialized`);
      return;
    }

    try {
      console.log(`${LOG} Initializing ORB job scheduler...`);

      this.agenda = new Agenda({
        db: {
          address: process.env.MONGODB_URI,
          collection: 'orb_jobs',           // separate from daily_entry_jobs
          options: { useUnifiedTopology: true },
        },
        processEvery:    '30 seconds',       // breakout check runs every minute
        maxConcurrency:  1,
        defaultConcurrency: 1,
      });

      this.defineJobs();
      this.setupEventHandlers();
      await this.agenda.start();
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log(`${LOG} Initialization complete`);
    } catch (error) {
      console.error(`${LOG} Failed to initialize:`, error);
      throw error;
    }
  }

  // ─── Job Definitions ─────────────────────────────────────────────────────────

  defineJobs() {

    // ── 1. Pre-open universe (9:08 AM) ──────────────────────────────────────────
    this.agenda.define('orb-pre-open', async (job) => {
      if (this.runningJobs.has('pre-open')) {
        console.log(`${LOG} pre-open already running, skipping`);
        return;
      }
      this.runningJobs.add('pre-open');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping pre-open`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const t0 = Date.now();
        console.log(`${LOG} [PRE-OPEN] Fetching NSE pre-open universe...`);
        const result = await fetchPreOpenUniverse();
        this.stats.preOpenRuns++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [PRE-OPEN] Done in ${Date.now() - t0}ms — candidates=${result.count ?? 0}`);
        return result;
      } catch (err) {
        console.error(`${LOG} [PRE-OPEN] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('pre-open');
      }
    });

    // ── 2. Record opening ranges (9:30 AM) ──────────────────────────────────────
    this.agenda.define('orb-record-range', async (job) => {
      if (this.runningJobs.has('record-range')) {
        console.log(`${LOG} record-range already running, skipping`);
        return;
      }
      this.runningJobs.add('record-range');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping record-range`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const t0 = Date.now();
        console.log(`${LOG} [RECORD-RANGE] Reading first 15-min candle OHLC...`);
        const result = await recordOpeningRanges();
        this.stats.rangeRecords++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [RECORD-RANGE] Done in ${Date.now() - t0}ms — set=${result.set ?? 0}, skipped=${result.skipped ?? 0}`);
        return result;
      } catch (err) {
        console.error(`${LOG} [RECORD-RANGE] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('record-range');
      }
    });

    // ── 3. Check breakouts (every 1 min, 9:00–10:59 IST) ────────────────────────
    //    Internal guard in orbService.checkBreakouts() rejects calls before 9:30
    //    or after 10:30 to avoid unnecessary Kite LTP hits outside the entry window.
    this.agenda.define('orb-check-breakout', async (job) => {
      if (this.runningJobs.has('check-breakout')) {
        console.log(`${LOG} check-breakout already running, skipping`);
        return;
      }
      this.runningJobs.add('check-breakout');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) return { skipped: true, reason: 'not_trading_day' };

        const t0 = Date.now();
        const result = await checkBreakouts();
        this.stats.breakoutChecks++;
        this.stats.lastRunAt = new Date();
        if (result.entered > 0) {
          console.log(`${LOG} [BREAKOUT] ${result.entered} new entry(ies) in ${Date.now() - t0}ms`);
        }
        return result;
      } catch (err) {
        console.error(`${LOG} [BREAKOUT] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('check-breakout');
      }
    });

    // ── 4. Monitor open positions (every 5 min, 9:00–14:59 IST) ─────────────────
    this.agenda.define('orb-monitor', async (job) => {
      if (this.runningJobs.has('monitor')) {
        console.log(`${LOG} monitor already running, skipping`);
        return;
      }
      this.runningJobs.add('monitor');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping monitor`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const t0 = Date.now();
        console.log(`${LOG} [MONITOR] Checking ORB positions...`);
        const result = await monitorOrbPositions();
        this.stats.monitorRuns++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [MONITOR] Done in ${Date.now() - t0}ms — active=${result.active ?? 0}, exited=${result.exited ?? 0}`);
        return result;
      } catch (err) {
        console.error(`${LOG} [MONITOR] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('monitor');
      }
    });

    // ── 5. Force-exit (3:15 PM) — safety net for anything still open ────────────
    this.agenda.define('orb-force-exit', async (job) => {
      if (this.runningJobs.has('force-exit')) {
        console.log(`${LOG} force-exit already running, skipping`);
        return;
      }
      this.runningJobs.add('force-exit');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping force-exit`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        console.log(`${LOG} [FORCE-EXIT] ▶ Hard-flat all remaining ORB MIS positions`);
        const result = await forceExitOrb();
        this.stats.lastRunAt  = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [FORCE-EXIT] ✅ Exited=${result.exited ?? 0}`);
        return result;
      } catch (err) {
        console.error(`${LOG} [FORCE-EXIT] Failed:`, err);
        this.stats.errors++;
        throw err;
      } finally {
        this.runningJobs.delete('force-exit');
      }
    });

    // ── Manual triggers (one-shot, no concurrency guard needed) ─────────────────
    this.agenda.define('manual-orb-pre-open',    async (job) => fetchPreOpenUniverse(job.attrs.data || {}));
    this.agenda.define('manual-orb-record-range', async (job) => recordOpeningRanges(job.attrs.data || {}));
    this.agenda.define('manual-orb-check-breakout', async (job) => checkBreakouts(job.attrs.data || {}));
    this.agenda.define('manual-orb-monitor',     async (job) => monitorOrbPositions(job.attrs.data || {}));
    this.agenda.define('manual-orb-force-exit',  async (job) => forceExitOrb(job.attrs.data || {}));
  }

  // ─── Event Handlers ───────────────────────────────────────────────────────────

  setupEventHandlers() {
    this.agenda.on('ready',    ()          => console.log(`${LOG} Agenda ready`));
    this.agenda.on('start',    (job)       => console.log(`${LOG} Job starting: ${job.attrs.name}`));
    this.agenda.on('complete', (job)       => console.log(`${LOG} Job completed: ${job.attrs.name}`));
    this.agenda.on('fail',     (err, job)  => console.error(`${LOG} Job failed: ${job.attrs.name}`, err));
  }

  // ─── Schedule Crons ──────────────────────────────────────────────────────────

  async scheduleRecurringJobs() {
    try {
      // Cancel existing to avoid duplicates on restart
      await this.agenda.cancel({
        name: {
          $in: [
            'orb-pre-open',
            'orb-record-range',
            'orb-check-breakout',
            'orb-monitor',
            'orb-force-exit',
          ],
        },
      });

      // 9:08 AM IST — fetch NSE pre-open IEP universe
      // Pre-open auction window is 9:00–9:08; prices stabilise by ~9:07.
      // Running at :08 gives us the final IEP snapshot before the auction closes.
      await this.agenda.every('8 9 * * 1-5', 'orb-pre-open', {}, {
        timezone: 'Asia/Kolkata',
      });

      // 9:30 AM IST — read the completed first 15-min candle OHLC
      // Market opens at 9:15; the 15-min candle closes at 9:30. One minute
      // buffer (9:30 cron) gives the candle time to propagate through Kite.
      await this.agenda.every('30 9 * * 1-5', 'orb-record-range', {}, {
        timezone: 'Asia/Kolkata',
      });

      // Breakout check at every 15-min boundary + 1 sec (10:01, 10:16, ... 14:01).
      // N-bar 15-min confirmation (CONFIRM_BARS in orbService, =2): at each check
      // we look at the last CONFIRM_BARS completed 15-min candles; all must close
      // past OR in the same direction → enter.
      //
      // Model: OR = 09:15-09:30; the 09:30-09:45 candle breaks out; if the
      // 09:45-10:00 candle also closes past OR it confirms → order at ~10:01.
      // A name that falls back inside OR on the 2nd candle is dropped.
      //
      // Schedule: minutes 1, 16, 31, 46 of hours 10-14 (Mon-Fri IST). First
      // possible entry 10:01 (breakout + confirm candles both closed); last entry
      // 14:01 (74 min before 15:15 force-exit). Reversible via CONFIRM_BARS +
      // BREAKOUT_START in orbService.js (1-bar would need the window opened to 9-14).
      await this.agenda.every('1,16,31,46 10-14 * * 1-5', 'orb-check-breakout', {}, {
        timezone: 'Asia/Kolkata',
      });

      // Every 5 min, 9:00 AM – 2:59 PM IST — position monitor
      // No-op if no ENTERED candidates exist for today.
      await this.agenda.every('*/5 9-14 * * 1-5', 'orb-monitor', {}, {
        timezone: 'Asia/Kolkata',
      });

      // 3:15 PM IST — force-exit (5 min before Zerodha auto-square at 3:20)
      await this.agenda.every('15 15 * * 1-5', 'orb-force-exit', {}, {
        timezone: 'Asia/Kolkata',
      });

      console.log(`${LOG} ═══════════════════════════════════════`);
      console.log(`${LOG} SCHEDULED JOBS (Mon-Fri IST) — ORB PATH (TIER-1: no gap filter, post 2026-05-26 evening):`);
      console.log(`${LOG}   09:08       — pre-open universe: ALL F&O stocks saved (no gap pre-filter)`);
      console.log(`${LOG}   09:30       — record OR via /quote/ohlc for all (quality filter: 0.5% ≤ OR range ≤ 2.5%)`);
      console.log(`${LOG}   :01/:16/:31/:46 hourly 10-14 — 2-bar 15-min candle close confirmation scan`);
      console.log(`${LOG}                   BOTH last 15-min candles must close past OR in same direction`);
      console.log(`${LOG}                   first entry possible at 10:01 (Indian "10 AM rule")`);
      console.log(`${LOG}                   last entry at 14:01 (74min runway to 15:15 force-exit)`);
      console.log(`${LOG}                   ranked by distance% past OR, stale-gap skipped, up to 3 slots`);
      console.log(`${LOG}   09:00–14:59 — position monitor every 5 min:`);
      console.log(`${LOG}                   • check SL fill status`);
      console.log(`${LOG}                   • BE trail to entry at +1R profit`);
      console.log(`${LOG}                   • candle structure analysis (5m + 15m bars):`);
      console.log(`${LOG}                       - bullish/bearish engulfing, hammer, doji, inside`);
      console.log(`${LOG}                       - direction-aware (reversal patterns against the trade)`);
      console.log(`${LOG}                       - volume drying / expanding confirmation`);
      console.log(`${LOG}                       - 15m structure break = market exit`);
      console.log(`${LOG}                       - reversal candle + vol = tighten SL`);
      console.log(`${LOG}                   • sideways exit (40 min flat at ≤0.3% pnl)`);
      console.log(`${LOG}   15:15       — force-exit (5 min before Zerodha auto-square)`);
      console.log(`${LOG} ENTRY:  MARKET BUY/SELL on OR break  |  SL: OR_(High|Low) ∓ min(1%, OR range)  |  NO target`);
      console.log(`${LOG} SL TRAIL: cancel old SL-M + place new SL-M with updated trigger (avoids Kite "permissible range" reject on modify)`);
      console.log(`${LOG}   [disabled]  — 10:30 TIME EXIT      (set ORB_TIME_EXIT_ENABLED=true to re-enable)`);
      console.log(`${LOG}   [disabled]  — Fixed target LIMIT   (no target order — winners ride to 15:15)`);
      console.log(`${LOG} ═══════════════════════════════════════`);
    } catch (error) {
      console.error(`${LOG} Failed to schedule:`, error);
      throw error;
    }
  }

  // ─── Manual Trigger API ───────────────────────────────────────────────────────

  async triggerPreOpen(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual pre-open trigger`);
    const job = await this.agenda.now('manual-orb-pre-open', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerRecordRange(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual record-range trigger`);
    const job = await this.agenda.now('manual-orb-record-range', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerCheckBreakout(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual check-breakout trigger`);
    const job = await this.agenda.now('manual-orb-check-breakout', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerMonitor(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual monitor trigger`);
    const job = await this.agenda.now('manual-orb-monitor', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerForceExit(opts = {}) {
    if (!this.isInitialized) throw new Error('ORB job not initialized');
    console.log(`${LOG} Manual force-exit trigger`);
    const job = await this.agenda.now('manual-orb-force-exit', opts);
    return { success: true, jobId: job.attrs._id };
  }

  // ─── Introspection ───────────────────────────────────────────────────────────

  getStats() {
    return {
      ...this.stats,
      isInitialized: this.isInitialized,
      runningJobs:   [...this.runningJobs],
    };
  }

  // ─── Shutdown ────────────────────────────────────────────────────────────────

  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log(`${LOG} Shutdown complete`);
    }
  }
}

const orbJob = new OrbJob();

export default orbJob;
export { OrbJob };
