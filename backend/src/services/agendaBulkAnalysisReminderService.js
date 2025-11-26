import Agenda from 'agenda';
import { User } from '../models/user.js';
import Notification from '../models/notification.js';
import { firebaseService } from './firebase/firebase.service.js';
import MarketHoursUtil from '../utils/marketHours.js';
import moment from 'moment-timezone';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/logdhan';
const TIMEZONE = 'Asia/Kolkata';

/**
 * Agenda service for sending bulk analysis expiry reminders
 * 🚫 Disabled: we no longer send these notifications.
 */
class AgendaBulkAnalysisReminderService {
  constructor() {
    this.agenda = null;
    this.initialized = false;
  }

  /**
   * Initialize the agenda service
   */
  async initialize() {
    // Reminders are disabled

    this.initialized = true;
    return;

    try {
      // Create agenda instance
      this.agenda = new Agenda({
        db: { address: MONGODB_URI, collection: 'bulk_analysis_reminder_jobs' },
        processEvery: '1 minute',
        maxConcurrency: 10
      });

      // Define job to send bulk analysis expiry reminders
      this.agenda.define('send-bulk-analysis-reminder', async (job) => {
        await this.sendBulkAnalysisReminder(job);
      });

      // Start the agenda
      await this.agenda.start();
      this.initialized = true;

      // Schedule the job to run every day at 8:00 AM IST
      await this.scheduleDaily8AMReminder();

    } catch (error) {
      console.error('❌ [BULK ANALYSIS REMINDER] Failed to initialize agenda service:', error);
      throw error;
    }
  }

  /**
   * Schedule daily 8:00 AM reminder job
   */
  async scheduleDaily8AMReminder() {
    try {
      // Cancel existing jobs first
      await this.agenda.cancel({ name: 'send-bulk-analysis-reminder' });

      // Schedule job to run every day at 8:00 AM IST
      await this.agenda.every('0 8 * * *', 'send-bulk-analysis-reminder', {}, {
        timezone: TIMEZONE,
        skipImmediate: true
      });

    } catch (error) {
      console.error('❌ [BULK ANALYSIS REMINDER] Failed to schedule daily job:', error);
      throw error;
    }
  }

  /**
   * Send bulk analysis expiry reminders to all users
   * Only runs on trading days
   */
  async sendBulkAnalysisReminder(job) {

    return;

    const jobStartTime = Date.now();

    try {
      // Check if today is a trading day
      const today = new Date();
      const isTradingDay = await MarketHoursUtil.isTradingDay(today);

      if (!isTradingDay) {

        // Store skip reason in job data
        job.attrs.data = {
          ...job.attrs.data,
          lastRun: new Date(),
          skipped: true,
          reason: 'non_trading_day',
          message: 'Reminder skipped - today is a holiday or weekend'
        };
        await job.save();
        return;
      }

      // Get all active users
      const users = await User.find({
        isActive: { $ne: false } // Only send to active users
      }).select('_id name email fcmTokens');

      let successCount = 0;
      let failureCount = 0;
      const errors = [];

      // Send reminders in batches to avoid rate limiting
      const BATCH_SIZE = 10;
      const BATCH_DELAY = 2000; // 2 seconds between batches

      for (let i = 0; i < users.length; i += BATCH_SIZE) {
        const batch = users.slice(i, i + BATCH_SIZE);

        // Send reminders in parallel for this batch
        const batchPromises = batch.map(async (user) => {
          try {
            const userName = user.name || user.email?.split('@')[0] || 'User';

            // Create in-app notification
            await Notification.createNotification({
              userId: user._id,
              title: 'Bulk Analysis Expiring Soon',
              message: `Hello ${userName}! Your bulk analysis from yesterday will expire soon. View it now before it's gone!`,
              type: 'alert',
              metadata: {
                reminderType: 'bulk_analysis_expiry',
                expiryWarning: true,
                date: new Date().toISOString()
              }
            });

            // Send Firebase push notification if user has FCM tokens
            if (user.fcmTokens && user.fcmTokens.length > 0) {
              await firebaseService.sendToUser(
                user._id,
                'Bulk Analysis Expiring Soon',
                `Hello ${userName}! Your bulk analysis will expire soon. View it now!`,
                {
                  type: 'BULK_ANALYSIS_EXPIRY_REMINDER',
                  route: '/bulk-analysis',
                  timestamp: new Date().toISOString()
                }
              );
            }

            successCount++;

          } catch (error) {
            failureCount++;
            errors.push({
              userId: user._id,
              email: user.email,
              error: error.message
            });
            console.error(`❌ [BULK ANALYSIS REMINDER] Failed to send to ${user.email}:`, error.message);
          }
        });

        await Promise.all(batchPromises);

        // Wait between batches to avoid rate limiting
        if (i + BATCH_SIZE < users.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
        }
      }

      const duration = Date.now() - jobStartTime;

      if (errors.length > 0) {
        console.error(`❌ [BULK ANALYSIS REMINDER] Errors encountered:`, JSON.stringify(errors, null, 2));
      }

      // Store job results in job data
      job.attrs.data = {
        ...job.attrs.data,
        lastRun: new Date(),
        skipped: false,
        success: successCount,
        failed: failureCount,
        total: users.length,
        errors: errors.length > 0 ? errors : undefined
      };
      await job.save();

    } catch (error) {
      console.error('❌ [BULK ANALYSIS REMINDER] Job failed:', error);
      throw error;
    }
  }

  /**
   * Manually trigger bulk analysis reminder (for testing)
   */
  async triggerManualReminder() {
    if (!this.initialized) {
      throw new Error('Agenda service not initialized');
    }

    try {

      await this.agenda.now('send-bulk-analysis-reminder');

    } catch (error) {
      console.error('❌ [BULK ANALYSIS REMINDER] Failed to trigger manual reminder:', error);
      throw error;
    }
  }

  /**
   * Get job status
   */
  async getJobStatus() {
    if (!this.initialized) {
      return { error: 'Service not initialized' };
    }

    try {
      const jobs = await this.agenda.jobs({ name: 'send-bulk-analysis-reminder' });

      if (jobs.length === 0) {
        return { status: 'no_jobs_scheduled' };
      }

      const job = jobs[0];
      return {
        status: 'scheduled',
        nextRunAt: job.attrs.nextRunAt,
        lastRunAt: job.attrs.lastRunAt,
        lastFinishedAt: job.attrs.lastFinishedAt,
        failedAt: job.attrs.failedAt,
        data: job.attrs.data
      };
    } catch (error) {
      console.error('❌ [BULK ANALYSIS REMINDER] Failed to get job status:', error);
      return { error: error.message };
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();

    }
  }
}

// Create singleton instance
const agendaBulkAnalysisReminderService = new AgendaBulkAnalysisReminderService();

export default agendaBulkAnalysisReminderService;