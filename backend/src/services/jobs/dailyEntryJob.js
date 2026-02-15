/**
 * Daily Entry Job — v2: ORB Validation + Instant Protection + Trailing
 *
 * Five scheduled runs (Mon-Fri IST):
 * 1. 9:15 AM  — Start ORB collection (poll LTP for 15 min)
 * 2. 9:30 AM  — Validate picks against ORB, place entries for validated picks
 * 3. 10:30 AM — Cancel unfilled entry orders (setup expired)
 * 4. */3 10-14 — Monitor stop/target fills + trailing stops (every 3 min)
 * 5. 14:00     — Tighten stops to breakeven for profitable positions
 *
 * Polling fallback for fill detection:
 * - */2 9-10 — Check fills for ORDER_PLACED picks (postback handles most, this is backup)
 *
 * Manual triggers available for each step via API.
 */

import Agenda from 'agenda';
import {
  startOrbCollection,
  validateAndPlaceEntries,
  cancelExpiredEntries,
  checkFillsFallback,
  monitorDailyPickOrders,
  tightenStops
} from '../dailyPicks/dailyPicksService.js';
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

        const result = await startOrbCollection();
        this.stats.orbCollections++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        return result;
      } catch (error) {
        console.error(`${LOG} ORB collection failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('orb-collect');
      }
    });

    // Job 2: Validate picks + place entries at 9:30 AM
    this.agenda.define('daily-picks-validate-entry', async (job) => {
      if (this.runningJobs.has('validate-entry')) {
        console.log(`${LOG} Validate+entry already running, skipping`);
        return;
      }

      this.runningJobs.add('validate-entry');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping validate+entry`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const result = await validateAndPlaceEntries();
        this.stats.entriesValidated++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        return result;
      } catch (error) {
        console.error(`${LOG} Validate+entry failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('validate-entry');
      }
    });

    // Job 3: Cancel expired entries at 10:30 AM
    this.agenda.define('daily-picks-cancel-expired', async (job) => {
      if (this.runningJobs.has('cancel-expired')) {
        console.log(`${LOG} Cancel-expired already running, skipping`);
        return;
      }

      this.runningJobs.add('cancel-expired');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping cancel-expired`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const result = await cancelExpiredEntries();
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        return result;
      } catch (error) {
        console.error(`${LOG} Cancel-expired failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('cancel-expired');
      }
    });

    // Job 4: Polling fallback for fill detection (*/2 9-10)
    this.agenda.define('daily-picks-fill-fallback', async (job) => {
      if (this.runningJobs.has('fill-fallback')) {
        console.log(`${LOG} Fill fallback already running, skipping`);
        return;
      }

      this.runningJobs.add('fill-fallback');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) return { skipped: true, reason: 'not_trading_day' };

        const result = await checkFillsFallback();
        this.stats.fillsChecked++;
        this.stats.lastRunAt = new Date();
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

        const result = await monitorDailyPickOrders();
        this.stats.monitorRuns++;
        this.stats.lastRunAt = new Date();
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

        const result = await tightenStops();
        this.stats.tightenRuns++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        return result;
      } catch (error) {
        console.error(`${LOG} Tighten failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('tighten');
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
            'daily-picks-cancel-expired',
            'daily-picks-fill-fallback',
            'daily-picks-monitor',
            'daily-picks-tighten',
            // Legacy v1 job names — clean up on first deploy
            'daily-picks-entry',
            'daily-picks-fill-check'
          ]
        }
      });

      // 9:15 AM IST — Start ORB collection (polls LTP for 15 min)
      await this.agenda.every('15 9 * * 1-5', 'daily-picks-orb-collect', {}, {
        timezone: 'Asia/Kolkata'
      });

      // 9:30 AM IST — Validate picks against ORB + place entries
      await this.agenda.every('30 9 * * 1-5', 'daily-picks-validate-entry', {}, {
        timezone: 'Asia/Kolkata'
      });

      // 10:30 AM IST — Cancel unfilled entry orders
      await this.agenda.every('30 10 * * 1-5', 'daily-picks-cancel-expired', {}, {
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

      console.log(`${LOG} Scheduled v2: ORB 9:15, validate+entry 9:30, cancel-expired 10:30, fill-fallback */2 9-10, monitor */3 10-14, tighten 14:00 (Mon-Fri IST)`);
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
