/**
 * Daily Picks Job — 8:45 AM IST
 *
 * Runs ChartInk scans, enriches, scores, saves, and notifies.
 * Schedule: Monday-Friday at 8:45 AM IST (30 min before market open).
 */

import Agenda from 'agenda';
import { runDailyPicks } from '../dailyPicks/dailyPicksService.js';
import MarketHoursUtil from '../../utils/marketHours.js';

const LOG = '[DAILY-PICKS-JOB]';

class DailyPicksJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = {
      runsCompleted: 0,
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
          collection: 'daily_picks_jobs',
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
    this.agenda.define('daily-picks-scan', async (job) => {
      if (this.isRunning) {
        console.log(`${LOG} Already running, skipping`);
        return;
      }

      this.isRunning = true;
      try {
        // Pre-flight: trading day check
        const isTradingDay = await MarketHoursUtil.isTradingDay();
        if (!isTradingDay) {
          console.log(`${LOG} Not a trading day — skipping`);
          return { skipped: true, reason: 'not_trading_day' };
        }

        const result = await runDailyPicks();

        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;

        console.log(`${LOG} Completed: ${result.picks} picks`);
        return result;
      } catch (error) {
        console.error(`${LOG} Scan failed:`, error);
        this.stats.errors++;
        throw error;
      } finally {
        this.isRunning = false;
      }
    });

    // Manual trigger
    this.agenda.define('manual-daily-picks-scan', async (job) => {
      if (this.isRunning) {
        console.log(`${LOG} Already running, skipping manual trigger`);
        return;
      }

      this.isRunning = true;
      try {
        const opts = job.attrs.data || {};
        const result = await runDailyPicks(opts);

        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        return result;
      } catch (error) {
        console.error(`${LOG} Manual scan failed:`, error);
        throw error;
      } finally {
        this.isRunning = false;
      }
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
      await this.agenda.cancel({ name: 'daily-picks-scan' });

      // 8:45 AM IST, Monday-Friday
      await this.agenda.every('45 8 * * 1-5', 'daily-picks-scan', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log(`${LOG} Scheduled: 8:45 AM IST, Mon-Fri`);
    } catch (error) {
      console.error(`${LOG} Failed to schedule:`, error);
      throw error;
    }
  }

  async triggerNow(opts = {}) {
    if (!this.isInitialized) throw new Error('Daily picks job not initialized');

    console.log(`${LOG} Manual trigger requested`);
    const job = await this.agenda.now('manual-daily-picks-scan', opts);

    return {
      success: true,
      jobId: job.attrs._id,
      scheduledAt: job.attrs.nextRunAt
    };
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

const dailyPicksJob = new DailyPicksJob();

export default dailyPicksJob;
export { DailyPicksJob };
