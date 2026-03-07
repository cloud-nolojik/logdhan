/**
 * Daily Entry Job — v2: Multi-Pass ORB Validation + Instant Protection + Trailing
 *
 * Scheduled runs (Mon-Fri IST):
 * 1. 9:30 AM    — ORB Pass 1 (15-min range): validate picks + place entries
 * 2. 9:46 AM    — ORB Pass 2 (30-min range): retry failed picks with wider range
 * 3. 10:01 AM   — ORB Pass 3 (45-min range, FINAL): last chance, then SKIPPED
 * 4. Every 2 min (9-10) — Polling fallback for fill detection
 * 5. Every 3 min (10-14) — Monitor stop/target fills + trailing stops
 * 6. 14:00      — Tighten stops to breakeven for profitable positions
 * 7. 15:00      — Force-exit open positions + cancel unfilled orders
 *
 * Manual triggers available for each step via API.
 */

import Agenda from 'agenda';
import {
  startOrbCollection,
  validateAndPlaceEntries,
  checkFillsFallback,
  monitorDailyPickOrders,
  tightenStops,
  gapProtectionCheck
} from '../dailyPicks/dailyPicksService.js';
import { runDailyExit } from '../dailyPicks/dailyPicksExitService.js';
import { reconcilePositionsOnStartup } from '../dailyPicks/dailyPicksRiskService.js';
import MarketHoursUtil from '../../utils/marketHours.js';

const LOG = '[DAILY-ENTRY-JOB]';

class DailyEntryJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.runningJobs = new Set();
    this.stats = {
      orbCollections: 0,
      entriesValidated: 0,
      fillsChecked: 0,
      monitorRuns: 0,
      tightenRuns: 0,
      errors: 0,
      lastRunAt: null,
      lastResult: null
    };
  }

  async initialize() {
    if (this.isInitialized) {
      console.log(`${LOG} Already initialized`);
      return;
    }

    try {
      console.log(`${LOG} Initializing (v2 — ORB + trailing)...`);

      this.agenda = new Agenda({
        db: {
          address: process.env.MONGODB_URI,
          collection: 'daily_entry_jobs',
          options: { useUnifiedTopology: true }
        },
        processEvery: '1 minute',
        maxConcurrency: 1,
        defaultConcurrency: 1
      });

      this.defineJobs();
      this.setupEventHandlers();
      await this.agenda.start();
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log(`${LOG} Initialization complete`);

      // Run startup recovery — reconcile open positions in case of mid-day restart
      try {
        const recoveryResult = await reconcilePositionsOnStartup();
        console.log(`${LOG} Startup recovery: ${JSON.stringify(recoveryResult)}`);
      } catch (recoveryErr) {
        console.error(`${LOG} Startup recovery failed (non-fatal):`, recoveryErr.message);
      }
    } catch (error) {
      console.error(`${LOG} Failed to initialize:`, error);
      throw error;
    }
  }

  defineJobs() {
    // Job 1: Start ORB collection at 9:15 AM
    this.agenda.define('daily-picks-orb-collect', async (job) => {
      if (this.runningJobs.has('orb-collect')) {
        console.log(`${LOG} ORB collection already running, skipping`);
        return;
      }

      this.runningJobs.add('orb-collect');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping ORB collection`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const t0 = Date.now();
        console.log(`${LOG} [ORB-COLLECT] Calling startOrbCollection()...`);
        const result = await startOrbCollection();
        this.stats.orbCollections++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [ORB-COLLECT] Completed in ${Date.now() - t0}ms:`, JSON.stringify(result));
        return result;
      } catch (error) {
        console.error(`${LOG} ORB collection failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('orb-collect');
      }
    });

    // Job 2: Multi-pass ORB validate+entry — shared handler, 3 distinct job names
    // Pass 1 (9:30) = 15-min ORB, Pass 2 (9:46) = 30-min, Pass 3 (10:01) = 45-min FINAL
    // Note: agenda.every() enforces "single" per job name, so we define 3 separate names.
    const orbValidateHandler = async (job, orbPass) => {
      const jobKey = `validate-entry-pass${orbPass}`;

      if (this.runningJobs.has(jobKey)) {
        console.log(`${LOG} ${jobKey} already running, skipping`);
        return;
      }

      this.runningJobs.add(jobKey);
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping pass ${orbPass}`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const t0 = Date.now();
        console.log(`${LOG} [VALIDATE-ENTRY] Pass ${orbPass}: Fetching ORB OHLC...`);
        const orbResult = await startOrbCollection({ orbPass });
        const orbMs = Date.now() - t0;
        console.log(`${LOG} [VALIDATE-ENTRY] ORB fetch done in ${orbMs}ms:`, JSON.stringify(orbResult));

        if (!orbResult.success) {
          console.error(`${LOG} [VALIDATE-ENTRY] ORB fetch failed — skipping pass ${orbPass}`);
          return { ...orbResult, orders: 0 };
        }

        console.log(`${LOG} [VALIDATE-ENTRY] Pass ${orbPass}: Validating and placing entries...`);
        const result = await validateAndPlaceEntries({ orbPass });
        this.stats.entriesValidated++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        const totalMs = Date.now() - t0;
        console.log(`${LOG} [VALIDATE-ENTRY] Pass ${orbPass} done in ${totalMs}ms: validated=${result.validated} skipped=${result.skipped} retrying=${result.retrying || 0} orders=${result.orders}`);
        return result;
      } catch (error) {
        console.error(`${LOG} Validate+entry pass ${orbPass} failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete(jobKey);
      }
    };

    this.agenda.define('daily-picks-validate-entry', async (job) => orbValidateHandler(job, 1));
    this.agenda.define('daily-picks-validate-entry-pass2', async (job) => orbValidateHandler(job, 2));
    this.agenda.define('daily-picks-validate-entry-pass3', async (job) => orbValidateHandler(job, 3));

    // Job 2.5: Gap protection — cancel AMO entries if stock gaps >2% at open
    this.agenda.define('daily-picks-gap-protection', async (job) => {
      if (this.runningJobs.has('gap-protection')) {
        console.log(`${LOG} Gap protection already running, skipping`);
        return;
      }

      this.runningJobs.add('gap-protection');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) return { skipped: true, reason: 'not_trading_day' };

        console.log(`${LOG} [GAP-PROTECT] Checking for excessive gaps at open...`);
        const result = await gapProtectionCheck();
        console.log(`${LOG} [GAP-PROTECT] Completed: cancelled=${result.cancelled ?? result.message}`);
        return result;
      } catch (error) {
        console.error(`${LOG} Gap protection failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('gap-protection');
      }
    });

    // Job 3: Polling fallback for fill detection (*/2 9-10)
    this.agenda.define('daily-picks-fill-fallback', async (job) => {
      if (this.runningJobs.has('fill-fallback')) {
        console.log(`${LOG} Fill fallback already running, skipping`);
        return;
      }

      this.runningJobs.add('fill-fallback');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) return { skipped: true, reason: 'not_trading_day' };

        console.log(`${LOG} [FILL-FALLBACK] Calling checkFillsFallback()...`);
        const result = await checkFillsFallback();
        this.stats.fillsChecked++;
        this.stats.lastRunAt = new Date();
        console.log(`${LOG} [FILL-FALLBACK] Completed: filled=${result.filled ?? result.message}`);
        return result;
      } catch (error) {
        console.error(`${LOG} Fill fallback failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('fill-fallback');
      }
    });

    // Job 5: Monitor orders every 3 min (10:00-14:59)
    this.agenda.define('daily-picks-monitor', async (job) => {
      if (this.runningJobs.has('monitor')) {
        console.log(`${LOG} Monitor already running, skipping`);
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
        console.log(`${LOG} [MONITOR] Calling monitorDailyPickOrders()...`);
        const result = await monitorDailyPickOrders();
        this.stats.monitorRuns++;
        this.stats.lastRunAt = new Date();
        console.log(`${LOG} [MONITOR] Completed in ${Date.now() - t0}ms: active=${result.active ?? result.message}`);
        return result;
      } catch (error) {
        console.error(`${LOG} Monitor failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('monitor');
      }
    });

    // Job 6: Tighten stops at 2:00 PM
    this.agenda.define('daily-picks-tighten', async (job) => {
      if (this.runningJobs.has('tighten')) {
        console.log(`${LOG} Tighten already running, skipping`);
        return;
      }

      this.runningJobs.add('tighten');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping tighten`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        console.log(`${LOG} [TIGHTEN] Calling tightenStops()...`);
        const result = await tightenStops();
        this.stats.tightenRuns++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [TIGHTEN] Completed: tightened=${result.tightened ?? result.message}`);
        return result;
      } catch (error) {
        console.error(`${LOG} Tighten failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('tighten');
      }
    });

    // Job 7: Force-exit all open positions at 3:00 PM
    this.agenda.define('daily-picks-exit', async (job) => {
      if (this.runningJobs.has('exit')) {
        console.log(`${LOG} Exit already running, skipping`);
        return;
      }

      this.runningJobs.add('exit');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping 3:00 PM exit`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        console.log(`${LOG} [EXIT] ▶ Executing 3:00 PM force-exit...`);
        const result = await runDailyExit();
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [EXIT] ✅ Completed: ${result.exited} positions exited, ${result.cancelledUnfilled || 0} unfilled cancelled`);
        return result;
      } catch (error) {
        console.error(`${LOG} Exit failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('exit');
      }
    });

    // Manual triggers
    this.agenda.define('manual-daily-picks-orb-collect', async (job) => {
      const opts = job.attrs.data || {};
      return startOrbCollection(opts);
    });

    this.agenda.define('manual-daily-picks-validate-entry', async (job) => {
      const opts = job.attrs.data || {};
      return validateAndPlaceEntries(opts);
    });

    this.agenda.define('manual-daily-picks-monitor', async (job) => {
      const opts = job.attrs.data || {};
      return monitorDailyPickOrders(opts);
    });

    this.agenda.define('manual-daily-picks-tighten', async (job) => {
      const opts = job.attrs.data || {};
      return tightenStops(opts);
    });

    this.agenda.define('manual-daily-picks-exit', async (job) => {
      const opts = job.attrs.data || {};
      return runDailyExit(opts);
    });
  }

  setupEventHandlers() {
    this.agenda.on('ready', () => console.log(`${LOG} Agenda ready`));
    this.agenda.on('start', (job) => console.log(`${LOG} Job starting: ${job.attrs.name}`));
    this.agenda.on('complete', (job) => console.log(`${LOG} Job completed: ${job.attrs.name}`));
    this.agenda.on('fail', (err, job) => console.error(`${LOG} Job failed: ${job.attrs.name}`, err));
  }

  async scheduleRecurringJobs() {
    try {
      // Cancel existing to avoid duplicates
      await this.agenda.cancel({
        name: {
          $in: [
            'daily-picks-orb-collect',
            'daily-picks-gap-protection',
            'daily-picks-validate-entry',
            'daily-picks-validate-entry-pass2',
            'daily-picks-validate-entry-pass3',
            'daily-picks-cancel-expired', // legacy — clean up
            'daily-picks-fill-fallback',
            'daily-picks-monitor',
            'daily-picks-tighten',
            'daily-picks-exit',
            // Legacy v1 job names — clean up on first deploy
            'daily-picks-entry',
            'daily-picks-fill-check'
          ]
        }
      });

      // 9:16 AM IST — Gap protection: cancel AMO entries with excessive gap at open
      await this.agenda.every('16 9 * * 1-5', 'daily-picks-gap-protection', {}, {
        timezone: 'Asia/Kolkata'
      });

      // Multi-pass ORB validation: 3 passes with widening time windows
      // Pass 1: 9:30 AM IST — 15-min ORB
      await this.agenda.every('30 9 * * 1-5', 'daily-picks-validate-entry', {}, {
        timezone: 'Asia/Kolkata'
      });

      // Pass 2: 9:46 AM IST — 30-min ORB (1 min buffer after 9:45 candle close)
      await this.agenda.every('46 9 * * 1-5', 'daily-picks-validate-entry-pass2', {}, {
        timezone: 'Asia/Kolkata'
      });

      // Pass 3: 10:01 AM IST — 45-min ORB (FINAL, 1 min buffer after 10:00 candle close)
      await this.agenda.every('1 10 * * 1-5', 'daily-picks-validate-entry-pass3', {}, {
        timezone: 'Asia/Kolkata'
      });

      // Every 2 min, 9:30-10:29 AM IST — Polling fallback for fill detection
      await this.agenda.every('*/2 9-10 * * 1-5', 'daily-picks-fill-fallback', {}, {
        timezone: 'Asia/Kolkata'
      });

      // Every 3 min, 10:00 AM - 2:59 PM IST — Monitor stop/target + trailing
      await this.agenda.every('*/3 10-14 * * 1-5', 'daily-picks-monitor', {}, {
        timezone: 'Asia/Kolkata'
      });

      // 2:00 PM IST — Tighten stops to breakeven for profitable positions
      await this.agenda.every('0 14 * * 1-5', 'daily-picks-tighten', {}, {
        timezone: 'Asia/Kolkata'
      });

      // 3:00 PM IST — Force-exit all open positions + cancel unfilled orders
      await this.agenda.every('0 15 * * 1-5', 'daily-picks-exit', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log(`${LOG} ═══════════════════════════════════════`);
      console.log(`${LOG} SCHEDULED JOBS (Mon-Fri IST):`);
      console.log(`${LOG}   09:16 — Gap protection (cancel AMO if gap > 2%)`);
      console.log(`${LOG}   09:30 — ORB Pass 1 (15-min range) → validate + SL-M entry`);
      console.log(`${LOG}   09:46 — ORB Pass 2 (30-min range) → retry failed picks`);
      console.log(`${LOG}   10:01 — ORB Pass 3 (45-min FINAL) → last chance entry`);
      console.log(`${LOG}   */2 9-10 — Fill detection fallback (polling)`);
      console.log(`${LOG}   */3 10-14 — Monitor: trailing, partial booking, sideways exit`);
      console.log(`${LOG}   14:00 — Tighten stops to breakeven`);
      console.log(`${LOG}   15:00 — Force-exit all positions`);
      console.log(`${LOG} ═══════════════════════════════════════`);
    } catch (error) {
      console.error(`${LOG} Failed to schedule:`, error);
      throw error;
    }
  }

  async triggerNow(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual trigger — running validate+entry now`);
    const job = await this.agenda.now('manual-daily-picks-validate-entry', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerOrbCollection(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual ORB collection trigger`);
    const job = await this.agenda.now('manual-daily-picks-orb-collect', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerMonitor(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual monitor trigger`);
    const job = await this.agenda.now('manual-daily-picks-monitor', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerTighten(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual tighten trigger`);
    const job = await this.agenda.now('manual-daily-picks-tighten', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerExit(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual exit trigger`);
    const job = await this.agenda.now('manual-daily-picks-exit', opts);
    return { success: true, jobId: job.attrs._id };
  }

  getStats() {
    return { ...this.stats, isInitialized: this.isInitialized, runningJobs: [...this.runningJobs] };
  }

  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log(`${LOG} Shutdown complete`);
    }
  }
}

const dailyEntryJob = new DailyEntryJob();

export default dailyEntryJob;
export { DailyEntryJob };
