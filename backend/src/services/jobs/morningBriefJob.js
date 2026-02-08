/**
 * Morning Brief Job
 *
 * Categorizes weekly watchlist stocks and places entry GTTs for pullback setups.
 * Schedule: Monday at 8:00 AM IST (75 min before market open)
 */

import Agenda from 'agenda';
import { runMorningBrief } from '../morningBriefService.js';

class MorningBriefJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = {
      runsCompleted: 0,
      pullbackGTTsPlaced: 0,
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
      console.log('[MORNING BRIEF JOB] Already initialized');
      return;
    }

    try {
      console.log('[MORNING BRIEF JOB] Initializing morning brief job...');

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'morning_brief_jobs',
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

      // Start agenda
      await this.agenda.start();

      // Schedule recurring jobs
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log('[MORNING BRIEF JOB] Initialization complete');

    } catch (error) {
      console.error('[MORNING BRIEF JOB] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // Main morning brief job
    this.agenda.define('morning-brief', async (job) => {
      if (this.isRunning) {
        console.log('[MORNING BRIEF JOB] Already running, skipping');
        return;
      }

      this.isRunning = true;
      console.log('[MORNING BRIEF JOB] Starting morning brief...');

      try {
        const result = await runMorningBrief();

        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;

        if (result.success) {
          this.stats.pullbackGTTsPlaced += result.gttResults?.placed || 0;
          console.log(`[MORNING BRIEF JOB] Completed: ${result.gttResults?.placed || 0} GTTs placed`);
        } else {
          this.stats.errors++;
          console.error(`[MORNING BRIEF JOB] Failed: ${result.error}`);
        }

        return result;

      } catch (error) {
        console.error('[MORNING BRIEF JOB] Morning brief failed:', error);
        this.stats.errors++;
        throw error;
      } finally {
        this.isRunning = false;
      }
    });

    // Manual trigger for testing
    this.agenda.define('manual-morning-brief', async (job) => {
      if (this.isRunning) {
        console.log('[MORNING BRIEF JOB] Already running, skipping manual trigger');
        return;
      }

      this.isRunning = true;
      console.log('[MORNING BRIEF JOB] Manual morning brief requested');

      try {
        const opts = job.attrs.data || {};
        const result = await runMorningBrief(opts);

        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;

        return result;

      } catch (error) {
        console.error('[MORNING BRIEF JOB] Manual morning brief failed:', error);
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
      console.log('[MORNING BRIEF JOB] Agenda ready');
    });

    this.agenda.on('start', (job) => {
      console.log(`[MORNING BRIEF JOB] Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`[MORNING BRIEF JOB] Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`[MORNING BRIEF JOB] Job failed: ${job.attrs.name}`, err);
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel existing jobs to avoid duplicates
      await this.agenda.cancel({
        name: 'morning-brief'
      });

      // Monday at 8:00 AM IST
      // Cron: minute hour day month weekday
      // 0 8 * * 1 = 8:00 AM, Monday only
      await this.agenda.every('0 8 * * 1', 'morning-brief', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[MORNING BRIEF JOB] Recurring job scheduled: 8:00 AM IST, Monday');

    } catch (error) {
      console.error('[MORNING BRIEF JOB] Failed to schedule jobs:', error);
      throw error;
    }
  }

  /**
   * Manually trigger morning brief
   */
  async triggerNow(opts = {}) {
    if (!this.isInitialized) {
      throw new Error('Morning brief job not initialized');
    }

    console.log('[MORNING BRIEF JOB] Manual trigger requested');

    const job = await this.agenda.now('manual-morning-brief', opts);

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
      name: 'morning-brief',
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
      console.log('[MORNING BRIEF JOB] Shutdown complete');
    }
  }
}

// Export singleton instance
const morningBriefJob = new MorningBriefJob();

export default morningBriefJob;
export { MorningBriefJob };
