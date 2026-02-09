/**
 * Daily Pullback Scan Job
 *
 * Runs ChartInk pullback scan daily to catch mid-week pullback setups
 * that weren't present during Saturday's weekend screening.
 *
 * Schedule: Monday-Friday at 3:45 PM IST
 *   - After 3:35 PM price prefetch
 *   - Before 4:00 PM daily tracking
 *
 * Only adds NEW stocks (skips stocks already in the current week's watchlist).
 * Runs AI analysis inline for top 4 new stocks.
 */

import Agenda from 'agenda';
import weekendScreeningJob from './weekendScreeningJob.js';

class DailyPullbackScanJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = {
      runsCompleted: 0,
      newStocksFound: 0,
      duplicatesSkipped: 0,
      aiAnalysesGenerated: 0,
      errors: 0,
      lastRunAt: null,
      lastResult: null
    };
  }

  /**
   * Initialize the job scheduler
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('[DAILY-PULLBACK] Already initialized');
      return;
    }

    try {
      console.log('[DAILY-PULLBACK] Initializing daily pullback scan job...');

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'daily_pullback_scan_jobs',
          options: {
            useUnifiedTopology: true
          }
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
      console.log('[DAILY-PULLBACK] Initialization complete');

    } catch (error) {
      console.error('[DAILY-PULLBACK] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // Main daily pullback scan job
    this.agenda.define('daily-pullback-scan', async (job) => {
      if (this.isRunning) {
        console.log('[DAILY-PULLBACK] Already running, skipping');
        return;
      }

      this.isRunning = true;
      console.log('[DAILY-PULLBACK] Starting daily pullback scan...');

      try {
        const result = await weekendScreeningJob.runWeekendScreening({
          scanTypes: ['pullback'],
          skipArchive: true,
          skipExisting: true,
          dailyMode: true,
          maxStocksPerUser: 10
        });

        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        this.stats.newStocksFound += result.totalStocksAdded || 0;
        this.stats.duplicatesSkipped += result.duplicatesSkipped || 0;
        this.stats.aiAnalysesGenerated += result.aiAnalysisGenerated || 0;

        console.log(`[DAILY-PULLBACK] Completed: ${result.totalStocksAdded || 0} new, ${result.duplicatesSkipped || 0} skipped`);

        return result;

      } catch (error) {
        console.error('[DAILY-PULLBACK] Daily pullback scan failed:', error);
        this.stats.errors++;
        throw error;
      } finally {
        this.isRunning = false;
      }
    });

    // Manual trigger for testing
    this.agenda.define('manual-daily-pullback-scan', async (job) => {
      if (this.isRunning) {
        console.log('[DAILY-PULLBACK] Already running, skipping manual trigger');
        return;
      }

      this.isRunning = true;
      console.log('[DAILY-PULLBACK] Manual daily pullback scan requested');

      try {
        const opts = job.attrs.data || {};
        // Only allow safe overrides — safety flags (dailyMode, skipArchive, skipExisting) are NOT overridable
        const result = await weekendScreeningJob.runWeekendScreening({
          filterSymbols: opts.filterSymbols || null,
          referenceDate: opts.referenceDate || null,
          scanTypes: ['pullback'],
          skipArchive: true,
          skipExisting: true,
          dailyMode: true,
          maxStocksPerUser: 10
        });

        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;
        this.stats.newStocksFound += result.totalStocksAdded || 0;
        this.stats.duplicatesSkipped += result.duplicatesSkipped || 0;
        this.stats.aiAnalysesGenerated += result.aiAnalysisGenerated || 0;

        return result;

      } catch (error) {
        console.error('[DAILY-PULLBACK] Manual daily pullback scan failed:', error);
        this.stats.errors++;
        throw error;
      } finally {
        this.isRunning = false;
      }
    });
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {
      console.log('[DAILY-PULLBACK] Agenda ready');
    });

    this.agenda.on('start', (job) => {
      console.log(`[DAILY-PULLBACK] Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`[DAILY-PULLBACK] Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`[DAILY-PULLBACK] Job failed: ${job.attrs.name}`, err);
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel existing jobs to avoid duplicates
      await this.agenda.cancel({
        name: 'daily-pullback-scan'
      });

      // Monday-Friday at 3:45 PM IST
      // Cron: 45 15 * * 1-5 = 3:45 PM, Mon-Fri
      await this.agenda.every('45 15 * * 1-5', 'daily-pullback-scan', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[DAILY-PULLBACK] Recurring job scheduled: 3:45 PM IST, Mon-Fri');

    } catch (error) {
      console.error('[DAILY-PULLBACK] Failed to schedule jobs:', error);
      throw error;
    }
  }

  /**
   * Manually trigger daily pullback scan
   */
  async triggerNow(opts = {}) {
    if (!this.isInitialized) {
      throw new Error('Daily pullback scan job not initialized');
    }

    console.log('[DAILY-PULLBACK] Manual trigger requested');

    const job = await this.agenda.now('manual-daily-pullback-scan', opts);

    return {
      success: true,
      jobId: job.attrs._id,
      scheduledAt: job.attrs.nextRunAt
    };
  }

  /**
   * Get job stats
   */
  getStats() {
    return {
      ...this.stats,
      isInitialized: this.isInitialized,
      isRunning: this.isRunning
    };
  }

  /**
   * Get next scheduled run
   */
  async getNextRun() {
    if (!this.agenda) return null;

    const jobs = await this.agenda.jobs({
      name: 'daily-pullback-scan',
      nextRunAt: { $exists: true }
    });

    if (jobs.length > 0) {
      return jobs[0].attrs.nextRunAt;
    }

    return null;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log('[DAILY-PULLBACK] Shutdown complete');
    }
  }
}

// Export singleton instance
const dailyPullbackScanJob = new DailyPullbackScanJob();

export default dailyPullbackScanJob;
export { DailyPullbackScanJob };
