/**
 * Daily Entry Job — v2: ORB Validation + Instant Protection + Trailing
 *
 * Six scheduled runs (Mon-Fri IST):
 * 1. 9:30 AM    — Fetch ORB OHLC + validate picks + place entries
 * 2. Every 3 min (10-14) — Monitor stop/target fills + trailing stops
 * 3. 14:00      — Tighten stops to breakeven for profitable positions
 * 4. 15:00      — Force-exit open positions + cancel unfilled orders
 *
 * Polling fallback for fill detection:
 * - Every 2 min (9-10) — Check fills for ORDER_PLACED picks (postback handles most, this is backup)
 *
 * Manual triggers available for each step via API.
 */

import Agenda from 'agenda';
import {
  startOrbCollection,
  validateAndPlaceEntries,
  checkFillsFallback,
  monitorDailyPickOrders,
  tightenStops
} from '../dailyPicks/dailyPicksService.js';
import { runDailyExit } from '../dailyPicks/dailyPicksExitService.js';
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

        console.log(`${LOG} [ORB-COLLECT] Calling startOrbCollection()...`);
        const result = await startOrbCollection();
        this.stats.orbCollections++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [ORB-COLLECT] Completed:`, JSON.stringify(result));
        return result;
      } catch (error) {
        console.error(`${LOG} ORB collection failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('orb-collect');
      }
    });

    // Job 2: Fetch ORB OHLC + Validate picks + place entries at 9:30 AM
    this.agenda.define('daily-picks-validate-entry', async (job) => {
      if (this.runningJobs.has('validate-entry')) {
        console.log(`${LOG} Validate+entry already running, skipping`);
        return;
      }

      this.runningJobs.add('validate-entry');
      try {
        // Feature flag: disable ORB validation when pre-market GTT/AMO flow is active (default)
        if (process.env.ENABLE_ORB_VALIDATION !== 'true') {
          console.log(`${LOG} ORB validation disabled (pre-market entry flow active) — skipping`);
          return { skipped: true, reason: 'orb_validation_disabled' };
        }

        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping validate+entry`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        // Step 1: Fetch ORB data (single OHLC call — instant)
        console.log(`${LOG} [VALIDATE-ENTRY] Step 1: Fetching ORB OHLC...`);
        const orbResult = await startOrbCollection();
        console.log(`${LOG} [VALIDATE-ENTRY] ORB result:`, JSON.stringify(orbResult));

        if (!orbResult.success) {
          console.error(`${LOG} [VALIDATE-ENTRY] ORB fetch failed — skipping entry placement`);
          return { ...orbResult, orders: 0 };
        }

        // Step 2: Validate + place entries
        console.log(`${LOG} [VALIDATE-ENTRY] Step 2: Validating and placing entries...`);
        const result = await validateAndPlaceEntries();
        this.stats.entriesValidated++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        console.log(`${LOG} [VALIDATE-ENTRY] Completed: validated=${result.validated} skipped=${result.skipped} orders=${result.orders}`);
        return result;
      } catch (error) {
        console.error(`${LOG} Validate+entry failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('validate-entry');
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

        console.log(`${LOG} [MONITOR] Calling monitorDailyPickOrders()...`);
        const result = await monitorDailyPickOrders();
        this.stats.monitorRuns++;
        this.stats.lastRunAt = new Date();
        console.log(`${LOG} [MONITOR] Completed: active=${result.active ?? result.message}`);
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
            'daily-picks-validate-entry',
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

      // 9:30 AM IST — Fetch ORB OHLC + validate picks + place entries (all in one job)
      await this.agenda.every('30 9 * * 1-5', 'daily-picks-validate-entry', {}, {
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

      console.log(`${LOG} Scheduled: ORB+validate+entry 9:30, fill-fallback */2 9-10, monitor */3 10-14, tighten 14:00, exit 15:00 (Mon-Fri IST)`);
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
