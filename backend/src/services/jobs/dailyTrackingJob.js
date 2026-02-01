/**
 * Daily Tracking Job
 *
 * Scheduled 4:00 PM IST job that runs two-phase tracking for WeeklyWatchlist stocks.
 *
 * PHASE 1: Status Update (every stock, NO AI, ~5-10 seconds)
 *   - Uses getDailyAnalysisData() for batch price/RSI/volume data
 *   - Compares against weekend levels (pure math)
 *   - Updates tracking_status and daily_snapshots in WeeklyWatchlist
 *   - Queues stocks with status changes for Phase 2
 *
 * PHASE 2: AI Analysis (only stocks with changes, ~40s each)
 *   - Claude with weekend context + trigger reason
 *   - Saves to StockAnalysis (analysis_type: 'daily_track')
 *
 * This REPLACES weeklyTrackAnalysisJob.js:
 * - Old job: AI for every stock, every day (expensive, slow)
 * - New job: AI only when status changes (73% cost reduction)
 */

import Agenda from 'agenda';
import { runDailyTracking } from '../dailyTrackingService.js';

class DailyTrackingJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = {
      runsCompleted: 0,
      phase1Stocks: 0,
      phase2Stocks: 0,
      phase2Success: 0,
      phase2Failed: 0,
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
      console.log('[DAILY-TRACK-JOB] Already initialized');
      return;
    }

    try {
      console.log('[DAILY-TRACK-JOB] Initializing daily tracking job...');

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'daily_tracking_jobs',
          options: {
            useUnifiedTopology: true
          }
        },
        processEvery: '1 minute',
        maxConcurrency: 1,
        defaultConcurrency: 1
      });

      // Define jobs
      this.defineJobs();

      // Setup event handlers
      this.setupEventHandlers();

      // Wait for Agenda to be ready
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Agenda MongoDB connection timeout after 30s'));
        }, 30000);

        this.agenda.on('ready', () => {
          clearTimeout(timeout);
          console.log('[DAILY-TRACK-JOB] Agenda MongoDB connection ready');
          resolve();
        });

        this.agenda.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Start agenda
      await this.agenda.start();

      // Schedule recurring jobs
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log('[DAILY-TRACK-JOB] Initialization complete');

    } catch (error) {
      console.error('[DAILY-TRACK-JOB] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // Main daily tracking job - runs at 4:00 PM IST
    this.agenda.define('daily-tracking', async (job) => {
      if (this.isRunning) {
        console.log('[DAILY-TRACK-JOB] Already running, skipping duplicate trigger');
        return { skipped: true, reason: 'already_running' };
      }

      this.isRunning = true;
      console.log('[DAILY-TRACK-JOB] Starting scheduled daily tracking...');

      try {
        const result = await runDailyTracking(job.attrs.data || {});

        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;

        if (result.success) {
          this.stats.phase1Stocks += result.phase1?.stocks_processed || 0;
          this.stats.phase2Stocks += result.phase2?.stocks_analyzed || 0;
          this.stats.phase2Success += result.phase2?.successful || 0;
          this.stats.phase2Failed += result.phase2?.failed || 0;

          console.log(`[DAILY-TRACK-JOB] Completed: P1=${result.phase1?.stocks_processed}, P2=${result.phase2?.successful}/${result.phase2?.stocks_analyzed}`);
        } else {
          this.stats.errors++;
          console.error(`[DAILY-TRACK-JOB] Failed: ${result.error}`);
        }

        return result;

      } catch (error) {
        console.error('[DAILY-TRACK-JOB] Daily tracking failed:', error);
        this.stats.errors++;
        throw error;
      } finally {
        this.isRunning = false;
      }
    });

    // Manual trigger for testing
    this.agenda.define('manual-daily-tracking', async (job) => {
      if (this.isRunning) {
        console.log('[DAILY-TRACK-JOB] Already running, skipping manual trigger');
        return { skipped: true, reason: 'already_running' };
      }

      this.isRunning = true;
      console.log('[DAILY-TRACK-JOB] Manual tracking requested');

      try {
        const result = await runDailyTracking(job.attrs.data || {});

        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;

        return result;

      } catch (error) {
        console.error('[DAILY-TRACK-JOB] Manual tracking failed:', error);
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
      console.log('[DAILY-TRACK-JOB] Agenda ready');
    });

    this.agenda.on('start', (job) => {
      console.log(`[DAILY-TRACK-JOB] Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`[DAILY-TRACK-JOB] Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`[DAILY-TRACK-JOB] Job failed: ${job.attrs.name}`, err);
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel existing jobs to avoid duplicates
      await this.agenda.cancel({
        name: 'daily-tracking'
      });

      // 4:00 PM IST every weekday (Monday-Friday)
      // Runs after market close (3:30 PM) to use complete day's data
      // Cron: minute hour day month weekday
      // 0 16 * * 1-5 = 4:00 PM, Monday through Friday
      await this.agenda.every('0 16 * * 1-5', 'daily-tracking', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[DAILY-TRACK-JOB] Recurring job scheduled: 4:00 PM IST weekdays');

    } catch (error) {
      console.error('[DAILY-TRACK-JOB] Failed to schedule jobs:', error);
      throw error;
    }
  }

  /**
   * Manually trigger tracking
   * @param {Object} options - { forceReanalyze: boolean }
   */
  async triggerNow(options = {}) {
    if (!this.isInitialized) {
      throw new Error('Daily tracking job not initialized');
    }

    console.log('[DAILY-TRACK-JOB] Manual trigger requested');

    const job = await this.agenda.now('manual-daily-tracking', options);

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
      name: 'daily-tracking',
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
      console.log('[DAILY-TRACK-JOB] Shutdown complete');
    }
  }
}

// Export singleton instance
const dailyTrackingJob = new DailyTrackingJob();

export default dailyTrackingJob;
export { DailyTrackingJob };
