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
    // Job 1: ORB collection (DISABLED — scanner.py path bypasses ORB)
    // startOrbCollection() is no longer called; scanner picks have pre-computed
    // structural levels (entry/stop/target from scanner.py pivots). Orders are
    // placed as MARKET at 09:30 via validateAndPlaceEntries.
    //
    // this.agenda.define('daily-picks-orb-collect', async (job) => {
    //   ...startOrbCollection()...
    // });

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

    // Job 6b: 14:45 HARD FLAT — exit all MIS positions 15 min before broker
    // force-close at 15:20. Gives us clean fills on liquid names and avoids
    // the end-of-day slippage spike. Reuses the same runDailyExit() path; the
    // 15:00 job below becomes a safety net for anything this 14:45 job missed.
    this.agenda.define('daily-picks-hard-flat', async () => {
      if (this.runningJobs.has('hard-flat')) {
        console.log(`${LOG} Hard flat already running, skipping`);
        return;
      }
      this.runningJobs.add('hard-flat');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping 14:45 hard flat`);
          return { skipped: true, reason: 'not_trading_day' };
        }
        console.log(`${LOG} [HARD-FLAT] ▶ Executing 14:45 hard-flat exit (15 min before broker auto-close)`);
        const result = await runDailyExit({ reason: 'hard_flat_14_45' });
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [HARD-FLAT] ✅ Completed: ${result.exited} exited, ${result.cancelledUnfilled || 0} unfilled cancelled`);
        return result;
      } catch (error) {
        console.error(`${LOG} Hard flat failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('hard-flat');
      }
    });

    // Job 7: Force-exit all open positions at 3:00 PM (safety net)
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

        // Write daily performance summary (non-fatal on failure)
        try {
          const { recordDailyMetrics } = await import('../dailyPicks/metricsService.js');
          const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
          const dateStr = nowIst.toISOString().slice(0, 10);
          const row = await recordDailyMetrics(dateStr);
          if (row) console.log(`${LOG} [EXIT] DailyPerformance written for ${dateStr}`);
        } catch (metricsErr) {
          console.error(`${LOG} [EXIT] DailyPerformance write failed (non-fatal):`, metricsErr.message);
        }
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
            'daily-picks-validate-entry',
            'daily-picks-validate-entry-pass2',
            'daily-picks-validate-entry-pass3',
            'daily-picks-cancel-expired', // legacy — clean up
            'daily-picks-gap-protection', // removed — no AMO gap protection
            'daily-picks-fill-fallback',
            'daily-picks-monitor',
            'daily-picks-tighten',
            'daily-picks-hard-flat',
            'daily-picks-exit',
            // Legacy v1 job names — clean up on first deploy
            'daily-picks-entry',
            'daily-picks-fill-check'
          ]
        }
      });

      // ORB validate entry passes (9:30 / 9:46 / 10:01) — by default owned by
      // tradingDaySequenceJob. Set DISABLE_INDIVIDUAL_CRONS=false to restore
      // the per-pass cron schedule here.
      const sequenceOwnsOrb = String(process.env.DISABLE_INDIVIDUAL_CRONS ?? 'true').toLowerCase() !== 'false';
      if (sequenceOwnsOrb) {
        console.log(`${LOG} Skipping ORB validate-entry cron schedule — owned by tradingDaySequenceJob`);
      } else {
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
      }

      // Every 2 min, 9:30-10:29 AM IST — Fill fallback (DISABLED: AMO placed at 8:30, no polling needed)
      // await this.agenda.every('*/2 9-10 * * 1-5', 'daily-picks-fill-fallback', {}, {
      //   timezone: 'Asia/Kolkata'
      // });

      // Every 3 min, 10:00 AM - 2:59 PM IST — Monitor/trailing/partial booking (DISABLED)
      // await this.agenda.every('*/3 10-14 * * 1-5', 'daily-picks-monitor', {}, {
      //   timezone: 'Asia/Kolkata'
      // });

      // 2:00 PM IST — Tighten stops (DISABLED)
      // await this.agenda.every('0 14 * * 1-5', 'daily-picks-tighten', {}, {
      //   timezone: 'Asia/Kolkata'
      // });

      // 2:45 PM IST — HARD FLAT (DISABLED)
      // await this.agenda.every('45 14 * * 1-5', 'daily-picks-hard-flat', {}, {
      //   timezone: 'Asia/Kolkata'
      // });

      // 3:00 PM IST — Force-exit all MIS positions
      await this.agenda.every('0 15 * * 1-5', 'daily-picks-exit', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log(`${LOG} ═══════════════════════════════════════`);
      console.log(`${LOG} SCHEDULED JOBS (Mon-Fri IST) — SCANNER/AMO PATH:`);
      console.log(`${LOG}   08:30 — daily-pick-scan → scanner.py + AMO MARKET orders placed immediately`);
      console.log(`${LOG}   [fill-fallback / monitor / tighten / hard-flat DISABLED]`);
      console.log(`${LOG}   15:00 — Force-exit all MIS positions`);
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
