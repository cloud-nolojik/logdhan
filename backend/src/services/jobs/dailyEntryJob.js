/**
 * Daily Entry Job — 9:15 AM / 9:45 AM / 
//  * Three scheduled runs:
//  * 1. 9:15 AM  — Place MIS LIMIT BUY orders at market open
//  * 2. 9:45 AM  — Check fills → place SL-M + LIMIT SELL → cancel unfilled
//  * 3. Every 15 min, 10:00 AM - 2:59 PM — Monitor stop/target fills, cancel if needed
//  *
//  * Manual triggers available for each step via API:
//  */

import Agenda from 'agenda';
import {
  placeEntryOrders,
  checkFillsAndPlaceProtection,
  monitorDailyPickOrders
} from '../dailyPicks/dailyPicksService.js';
import MarketHoursUtil from '../../utils/marketHours.js';

const LOG = '[DAILY-ENTRY-JOB]';

class DailyEntryJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.runningJobs = new Set();
    this.stats = {
      entriesPlaced: 0,
      fillsChecked: 0,
      monitorRuns: 0,
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
      console.log(`${LOG} Initializing...`);

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
    // Job 1: Place entry orders at 9:15 AM
    this.agenda.define('daily-picks-entry', async (job) => {
      if (this.runningJobs.has('entry')) {
        console.log(`${LOG} Entry job already running, skipping`);
        return;
      }

      this.runningJobs.add('entry');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping entry`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const result = await placeEntryOrders();
        this.stats.entriesPlaced += result.orders || 0;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        return result;
      } catch (error) {
        console.error(`${LOG} Entry placement failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('entry');
      }
    });

    // Job 2: Check fills at 9:45 AM
    this.agenda.define('daily-picks-fill-check', async (job) => {
      if (this.runningJobs.has('fill-check')) {
        console.log(`${LOG} Fill check already running, skipping`);
        return;
      }

      this.runningJobs.add('fill-check');
      try {
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping fill check`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const result = await checkFillsAndPlaceProtection();
        this.stats.fillsChecked++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        return result;
      } catch (error) {
        console.error(`${LOG} Fill check failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.runningJobs.delete('fill-check');
      }
    });

    // Job 3: Monitor orders every 15 min
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

    // Manual triggers
    this.agenda.define('manual-daily-picks-entry', async (job) => {
      const opts = job.attrs.data || {};
      return placeEntryOrders(opts);
    });

    this.agenda.define('manual-daily-picks-fill-check', async (job) => {
      const opts = job.attrs.data || {};
      return checkFillsAndPlaceProtection(opts);
    });

    this.agenda.define('manual-daily-picks-monitor', async (job) => {
      const opts = job.attrs.data || {};
      return monitorDailyPickOrders(opts);
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
      await this.agenda.cancel({ name: { $in: ['daily-picks-entry', 'daily-picks-fill-check', 'daily-picks-monitor'] } });

      // 9:15 AM IST — Place entry orders
      await this.agenda.every('15 9 * * 1-5', 'daily-picks-entry', {}, {
        timezone: 'Asia/Kolkata'
      });

      // 9:45 AM IST — Check fills + place protection
      await this.agenda.every('45 9 * * 1-5', 'daily-picks-fill-check', {}, {
        timezone: 'Asia/Kolkata'
      });

      // Every 15 min, 10:00 AM - 2:59 PM IST — Monitor stop/target fills
      await this.agenda.every('*/15 10-14 * * 1-5', 'daily-picks-monitor', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log(`${LOG} Scheduled: entry 9:15, fill-check 9:45, monitor */15 10-14 (Mon-Fri IST)`);
    } catch (error) {
      console.error(`${LOG} Failed to schedule:`, error);
      throw error;
    }
  }

  async triggerEntry(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual entry trigger`);
    const job = await this.agenda.now('manual-daily-picks-entry', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerFillCheck(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual fill-check trigger`);
    const job = await this.agenda.now('manual-daily-picks-fill-check', opts);
    return { success: true, jobId: job.attrs._id };
  }

  async triggerMonitor(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily entry job not initialized');
    console.log(`${LOG} Manual monitor trigger`);
    const job = await this.agenda.now('manual-daily-picks-monitor', opts);
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
