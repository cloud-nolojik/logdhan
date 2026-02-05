/**
 * Kite Token Refresh Job
 *
 * Scheduled job that runs daily at 6:00 AM IST to refresh the Kite access token.
 * Token expires at 6 AM, so we refresh right at that time.
 *
 * Uses Agenda (MongoDB-backed) for consistency with other jobs in the project.
 */

import Agenda from 'agenda';
import kiteAutoLoginService from '../kiteAutoLogin.service.js';
import KiteAuditLog from '../../models/kiteAuditLog.js';
import kiteConfig from '../../config/kite.config.js';

class KiteTokenRefreshJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = {
      refreshCount: 0,
      successCount: 0,
      failCount: 0,
      lastRefreshAt: null,
      lastResult: null
    };
  }

  /**
   * Initialize the job scheduler
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('[KITE-TOKEN-JOB] Already initialized');
      return;
    }

    try {
      console.log('[KITE-TOKEN-JOB] Initializing Kite token refresh job...');

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'kite_token_jobs',
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
          console.log('[KITE-TOKEN-JOB] Agenda MongoDB connection ready');
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
      console.log('[KITE-TOKEN-JOB] Initialization complete');

    } catch (error) {
      console.error('[KITE-TOKEN-JOB] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // Main token refresh job - runs at 6:00 AM IST
    this.agenda.define('kite-token-refresh', async (job) => {
      if (this.isRunning) {
        console.log('[KITE-TOKEN-JOB] Already running, skipping duplicate trigger');
        return { skipped: true, reason: 'already_running' };
      }

      this.isRunning = true;
      console.log('[KITE-TOKEN-JOB] Starting scheduled token refresh...');

      try {
        const result = await this.performRefresh('SCHEDULED');

        this.stats.refreshCount++;
        this.stats.lastRefreshAt = new Date();
        this.stats.lastResult = result;

        if (result.success) {
          this.stats.successCount++;
          console.log(`[KITE-TOKEN-JOB] Token refreshed successfully`);
        } else {
          this.stats.failCount++;
          console.error(`[KITE-TOKEN-JOB] Token refresh failed: ${result.error}`);
        }

        return result;

      } catch (error) {
        console.error('[KITE-TOKEN-JOB] Token refresh failed:', error);
        this.stats.failCount++;
        throw error;
      } finally {
        this.isRunning = false;
      }
    });

    // Backup refresh job - runs at 6:05 AM IST
    this.agenda.define('kite-token-backup-refresh', async (job) => {
      console.log('[KITE-TOKEN-JOB] Backup refresh check triggered');

      try {
        // Check if token is valid
        const isValid = await kiteAutoLoginService.isSessionValid();

        if (!isValid) {
          console.log('[KITE-TOKEN-JOB] Token invalid, performing backup refresh...');
          const result = await this.performRefresh('BACKUP');
          return result;
        } else {
          console.log('[KITE-TOKEN-JOB] Token already valid, skipping backup refresh');
          return { skipped: true, reason: 'token_valid' };
        }

      } catch (error) {
        console.error('[KITE-TOKEN-JOB] Backup refresh check failed:', error);
        throw error;
      }
    });

    // Manual trigger for admin use
    this.agenda.define('kite-token-manual-refresh', async (job) => {
      if (this.isRunning) {
        console.log('[KITE-TOKEN-JOB] Already running, skipping manual trigger');
        return { skipped: true, reason: 'already_running' };
      }

      this.isRunning = true;
      console.log('[KITE-TOKEN-JOB] Manual token refresh requested');

      try {
        const result = await this.performRefresh('MANUAL');

        this.stats.lastRefreshAt = new Date();
        this.stats.lastResult = result;

        return result;

      } catch (error) {
        console.error('[KITE-TOKEN-JOB] Manual refresh failed:', error);
        throw error;
      } finally {
        this.isRunning = false;
      }
    });
  }

  /**
   * Perform token refresh with retry logic
   */
  async performRefresh(source = 'SCHEDULED', retryCount = 0) {
    const startTime = Date.now();

    try {
      console.log(`[KITE-TOKEN-JOB] Performing auto login (attempt ${retryCount + 1})...`);

      const session = await kiteAutoLoginService.performAutoLogin();

      const durationMs = Date.now() - startTime;
      console.log(`[KITE-TOKEN-JOB] Token refreshed in ${durationMs}ms`);
      console.log(`[KITE-TOKEN-JOB] User: ${session.user_name}, Expiry: ${session.token_expiry}`);

      // Log successful refresh
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.TOKEN_REFRESH, {
        kiteUserId: kiteConfig.USER_ID,
        status: 'SUCCESS',
        response: {
          user_name: session.user_name,
          token_expiry: session.token_expiry
        },
        durationMs,
        source
      });

      return {
        success: true,
        session: {
          user_name: session.user_name,
          email: session.email,
          token_expiry: session.token_expiry
        },
        durationMs
      };

    } catch (error) {
      const durationMs = Date.now() - startTime;
      console.error(`[KITE-TOKEN-JOB] Refresh failed (attempt ${retryCount + 1}):`, error.message);

      // Log failed refresh
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.TOKEN_REFRESH, {
        kiteUserId: kiteConfig.USER_ID,
        status: 'FAILED',
        error: error.message,
        durationMs,
        source,
        notes: `Attempt ${retryCount + 1}`
      });

      // Retry logic
      if (retryCount < kiteConfig.MAX_RETRIES) {
        console.log(`[KITE-TOKEN-JOB] Retrying in ${kiteConfig.RETRY_DELAY_MS}ms...`);
        await new Promise(resolve => setTimeout(resolve, kiteConfig.RETRY_DELAY_MS));
        return this.performRefresh(source, retryCount + 1);
      }

      // All retries failed
      console.error('[KITE-TOKEN-JOB] All retry attempts failed. Manual intervention required.');

      return {
        success: false,
        error: error.message,
        attempts: retryCount + 1
      };
    }
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {
      console.log('[KITE-TOKEN-JOB] Agenda ready');
    });

    this.agenda.on('start', (job) => {
      console.log(`[KITE-TOKEN-JOB] Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`[KITE-TOKEN-JOB] Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`[KITE-TOKEN-JOB] Job failed: ${job.attrs.name}`, err);
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel existing jobs to avoid duplicates
      await this.agenda.cancel({ name: 'kite-token-refresh' });
      await this.agenda.cancel({ name: 'kite-token-backup-refresh' });

      // 6:00 AM IST daily
      // Cron: minute hour day month weekday
      // 0 6 * * * = 6:00 AM every day
      await this.agenda.every('0 6 * * *', 'kite-token-refresh', {}, {
        timezone: 'Asia/Kolkata'
      });

      // 6:05 AM IST daily (backup in case 6:00 fails)
      await this.agenda.every('5 6 * * *', 'kite-token-backup-refresh', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[KITE-TOKEN-JOB] Recurring jobs scheduled: 6:00 AM & 6:05 AM IST daily');

    } catch (error) {
      console.error('[KITE-TOKEN-JOB] Failed to schedule jobs:', error);
      throw error;
    }
  }

  /**
   * Manually trigger token refresh
   */
  async triggerNow() {
    if (!this.isInitialized) {
      throw new Error('Kite token refresh job not initialized');
    }

    console.log('[KITE-TOKEN-JOB] Manual trigger requested');

    const job = await this.agenda.now('kite-token-manual-refresh', {});

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
      name: 'kite-token-refresh',
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
      console.log('[KITE-TOKEN-JOB] Shutdown complete');
    }
  }
}

// Export singleton instance
const kiteTokenRefreshJob = new KiteTokenRefreshJob();

// Export functions for backward compatibility with existing code
export function startKiteTokenRefreshJob() {
  return kiteTokenRefreshJob.initialize();
}

export async function manualRefresh() {
  if (!kiteTokenRefreshJob.isInitialized) {
    await kiteTokenRefreshJob.initialize();
  }
  // Directly perform refresh instead of scheduling a job
  return kiteTokenRefreshJob.performRefresh('MANUAL');
}

export function isRunning() {
  return kiteTokenRefreshJob.isRunning;
}

export default kiteTokenRefreshJob;
