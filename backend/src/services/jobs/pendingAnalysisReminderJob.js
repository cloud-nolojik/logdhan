/**
 * Pending Analysis Reminder Job
 *
 * Scheduled 4:00 PM IST job that notifies users when they have stocks with
 * pending full analysis (bullish setups added during market hours).
 *
 * When users manually add stocks during market hours:
 * - Stocks are classified as bullish setups (pure math, no AI)
 * - Full AI analysis is blocked until 4 PM (needs complete candle data)
 * - These are saved with pending_full_analysis: true
 *
 * This job finds users with such pending stocks and sends push notifications
 * reminding them that full analysis is now available.
 */

import Agenda from 'agenda';
import StockAnalysis from '../../models/stockAnalysis.js';
import { User } from '../../models/user.js';
import { firebaseService } from '../firebase/firebase.service.js';

class PendingAnalysisReminderJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.stats = {
      runsCompleted: 0,
      usersNotified: 0,
      errors: 0,
      lastRunAt: null
    };
  }

  /**
   * Initialize the job scheduler
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('[PENDING-REMINDER] Already initialized');
      return;
    }

    try {
      console.log('[PENDING-REMINDER] Initializing pending analysis reminder job...');

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'pending_analysis_reminder_jobs',
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
          console.log('[PENDING-REMINDER] Agenda MongoDB connection ready');
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
      console.log('[PENDING-REMINDER] ✅ Initialization complete');

    } catch (error) {
      console.error('[PENDING-REMINDER] ❌ Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // Main job - runs at 4:00 PM IST
    this.agenda.define('pending-analysis-reminder', async (job) => {
      console.log('[PENDING-REMINDER] Starting scheduled reminder job...');

      try {
        const result = await this.runReminder(job.attrs.data || {});
        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        console.log(`[PENDING-REMINDER] ✅ Completed: ${result.usersNotified} users notified`);
      } catch (error) {
        console.error('[PENDING-REMINDER] ❌ Reminder job failed:', error);
        this.stats.errors++;
        throw error;
      }
    });

    // Manual trigger for testing
    this.agenda.define('manual-pending-analysis-reminder', async (job) => {
      console.log('[PENDING-REMINDER] Manual trigger requested');
      try {
        return await this.runReminder(job.attrs.data || {});
      } catch (error) {
        console.error('[PENDING-REMINDER] ❌ Manual reminder failed:', error);
        throw error;
      }
    });
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {
      console.log('[PENDING-REMINDER] Agenda ready');
    });

    this.agenda.on('start', (job) => {
      console.log(`[PENDING-REMINDER] Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`[PENDING-REMINDER] Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`[PENDING-REMINDER] Job failed: ${job.attrs.name}`, err);
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel existing jobs to avoid duplicates
      await this.agenda.cancel({
        name: 'pending-analysis-reminder'
      });

      // 4:00 PM IST every weekday (Monday-Friday)
      // Runs at market close when full analysis becomes available
      await this.agenda.every('0 16 * * 1-5', 'pending-analysis-reminder', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[PENDING-REMINDER] Recurring job scheduled: 4:00 PM IST weekdays');

    } catch (error) {
      console.error('[PENDING-REMINDER] Failed to schedule jobs:', error);
      throw error;
    }
  }

  /**
   * Main reminder function
   */
  async runReminder(options = {}) {
    const runLabel = '[PENDING-REMINDER]';

    console.log(`\n${'='.repeat(60)}`);
    console.log(`${runLabel} PENDING ANALYSIS REMINDER STARTED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`${runLabel} Time: ${new Date().toISOString()}`);

    const result = {
      pendingStocksFound: 0,
      usersNotified: 0,
      errors: []
    };

    try {
      // Get today's start time for query
      const todayStart = this.getTodayStart();

      // Find all pending analyses from today
      const pendingAnalyses = await StockAnalysis.find({
        'analysis_data.pending_full_analysis': true,
        analysis_type: 'swing',
        created_at: { $gte: todayStart }
      }).lean();

      console.log(`${runLabel} Found ${pendingAnalyses.length} pending analyses from today`);

      if (pendingAnalyses.length === 0) {
        console.log(`${runLabel} No pending analyses - nothing to notify`);
        return result;
      }

      result.pendingStocksFound = pendingAnalyses.length;

      // Get instrument keys of pending stocks
      const pendingInstrumentKeys = pendingAnalyses.map(a => a.instrument_key);

      // Find users who have these stocks in their watchlist
      const usersWithPendingStocks = await User.aggregate([
        { $unwind: '$watchlist' },
        { $match: { 'watchlist.instrument_key': { $in: pendingInstrumentKeys } } },
        {
          $group: {
            _id: '$_id',
            fcmTokens: { $first: '$fcmTokens' },
            pendingCount: { $sum: 1 },
            stocks: { $push: '$watchlist.trading_symbol' }
          }
        },
        { $match: { fcmTokens: { $exists: true, $ne: [] } } }
      ]);

      console.log(`${runLabel} Found ${usersWithPendingStocks.length} users with pending stocks and FCM tokens`);

      // Send notification to each user
      for (const user of usersWithPendingStocks) {
        try {
          const stockList = user.stocks.slice(0, 3).join(', ');
          const moreCount = user.stocks.length > 3 ? ` +${user.stocks.length - 3} more` : '';

          await firebaseService.sendToUser(
            user._id,
            'Full Analysis Now Available',
            `${user.pendingCount} stock${user.pendingCount > 1 ? 's' : ''} ready for AI analysis: ${stockList}${moreCount}`,
            { type: 'pending_analysis_ready', route: '/watchlist' }
          );

          result.usersNotified++;
          console.log(`${runLabel} ✅ Notified user ${user._id} (${user.pendingCount} stocks)`);

        } catch (notifError) {
          console.error(`${runLabel} ❌ Failed to notify user ${user._id}:`, notifError.message);
          result.errors.push({ userId: user._id, error: notifError.message });
        }
      }

      this.stats.usersNotified += result.usersNotified;

      console.log(`\n${runLabel} ${'─'.repeat(40)}`);
      console.log(`${runLabel} REMINDER COMPLETE`);
      console.log(`${runLabel} Pending stocks: ${result.pendingStocksFound}`);
      console.log(`${runLabel} Users notified: ${result.usersNotified}`);
      console.log(`${runLabel} Errors: ${result.errors.length}`);
      console.log(`${'='.repeat(60)}\n`);

      return result;

    } catch (error) {
      console.error(`${runLabel} ❌ Reminder job failed:`, error);
      throw error;
    }
  }

  /**
   * Helper: Get today at midnight IST (returns UTC Date for MongoDB queries)
   */
  getTodayStart() {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const now = new Date();
    const istNow = new Date(now.getTime() + IST_OFFSET_MS);
    const istMidnight = new Date(istNow);
    istMidnight.setUTCHours(0, 0, 0, 0);
    return new Date(istMidnight.getTime() - IST_OFFSET_MS);
  }

  /**
   * Manually trigger reminder
   */
  async triggerNow(options = {}) {
    if (!this.isInitialized) {
      throw new Error('Pending analysis reminder job not initialized');
    }

    console.log('[PENDING-REMINDER] Manual trigger requested');

    const job = await this.agenda.now('manual-pending-analysis-reminder', options);

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
      isInitialized: this.isInitialized
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log('[PENDING-REMINDER] Shutdown complete');
    }
  }
}

// Export singleton instance
const pendingAnalysisReminderJob = new PendingAnalysisReminderJob();

export default pendingAnalysisReminderJob;
export { PendingAnalysisReminderJob };
