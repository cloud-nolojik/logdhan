import Agenda from 'agenda';
import { User } from '../models/user.js';
import Notification from '../models/notification.js';
import { firebaseService } from './firebase/firebase.service.js';
import MarketHoursUtil from '../utils/marketHours.js';
import moment from 'moment-timezone';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/logdhan';
const TIMEZONE = 'Asia/Kolkata';

/**
 * Agenda service for sending bulk analysis availability notifications
 * Creates in-app notifications and sends Firebase push notifications when bulk analysis becomes available
 */
class AgendaBulkAnalysisNotificationService {
    constructor() {
        this.agenda = null;
        this.initialized = false;
    }

    /**
     * Initialize the agenda service
     */
    async initialize() {
        try {
            // Create agenda instance
            this.agenda = new Agenda({
                db: { address: MONGODB_URI, collection: 'bulk_analysis_notification_jobs' },
                processEvery: '1 minute',
                maxConcurrency: 10
            });

            // Define job to send bulk analysis availability notifications
            this.agenda.define('send-bulk-analysis-available-notification', async (job) => {
                await this.sendBulkAnalysisAvailableNotifications(job);
            });

            // Start the agenda
            await this.agenda.start();
            this.initialized = true;

            // Schedule the job to run every day at 5:00 PM IST
            await this.scheduleDaily5PMNotification();

            console.log('✅ [BULK ANALYSIS NOTIFICATION] Agenda service initialized successfully');
        } catch (error) {
            console.error('❌ [BULK ANALYSIS NOTIFICATION] Failed to initialize agenda service:', error);
            throw error;
        }
    }

    /**
     * Schedule daily 5 PM notification job
     */
    async scheduleDaily5PMNotification() {
        try {
            // Cancel existing jobs first
            await this.agenda.cancel({ name: 'send-bulk-analysis-available-notification' });

            // Schedule job to run every day at 5:00 PM IST
            await this.agenda.every('0 17 * * *', 'send-bulk-analysis-available-notification', {}, {
                timezone: TIMEZONE,
                skipImmediate: true
            });

            console.log('✅ [BULK ANALYSIS NOTIFICATION] Scheduled daily 5 PM notification job');
        } catch (error) {
            console.error('❌ [BULK ANALYSIS NOTIFICATION] Failed to schedule daily job:', error);
            throw error;
        }
    }

    /**
     * Send bulk analysis available notifications to all users
     */
    async sendBulkAnalysisAvailableNotifications(job) {
        const jobStartTime = Date.now();
        console.log('📱 [BULK ANALYSIS NOTIFICATION] Starting to send notifications to all users');

        try {
            // Check if today is a trading day
            const today = new Date();
            const isTradingDay = await MarketHoursUtil.isTradingDay(today);

            if (!isTradingDay) {
                console.log(`⏭️  [BULK ANALYSIS NOTIFICATION] Skipping notification - today is not a trading day (holiday/weekend)`);

                // Store skip reason in job data
                job.attrs.data = {
                    ...job.attrs.data,
                    lastRun: new Date(),
                    skipped: true,
                    reason: 'non_trading_day',
                    message: 'Notification skipped - today is a holiday or weekend'
                };
                await job.save();
                return;
            }

            console.log(`✅ [BULK ANALYSIS NOTIFICATION] Today is a trading day - proceeding with notifications`);

            // Get all active users
            const users = await User.find({
                isActive: { $ne: false } // Only send to active users
            }).select('_id name email fcmTokens');

            console.log(`📱 [BULK ANALYSIS NOTIFICATION] Found ${users.length} active users`);

            let successCount = 0;
            let failureCount = 0;
            const errors = [];

            // Send notifications in batches to avoid rate limiting
            const BATCH_SIZE = 10;
            const BATCH_DELAY = 2000; // 2 seconds between batches

            for (let i = 0; i < users.length; i += BATCH_SIZE) {
                const batch = users.slice(i, i + BATCH_SIZE);

                console.log(`📱 [BULK ANALYSIS NOTIFICATION] Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} users)`);

                // Send notifications in parallel for this batch
                const batchPromises = batch.map(async (user) => {
                    try {
                        const userName = user.name || user.email?.split('@')[0] || 'User';

                        // Create in-app notification
                        await Notification.createNotification({
                            userId: user._id,
                            title: 'Bulk Analysis Available',
                            message: `Hello ${userName}! Your daily bulk stock analysis is now ready and available in the LogDhan app. View comprehensive AI analysis for multiple stocks with entry/exit triggers and risk-reward ratios.`,
                            type: 'alert',
                            metadata: {
                                availableAt: '5:00 PM',
                                date: new Date().toISOString()
                            }
                        });

                        // Send Firebase push notification if user has FCM tokens
                        if (user.fcmTokens && user.fcmTokens.length > 0) {
                            await firebaseService.sendToUser(
                                user._id,
                                'Bulk Analysis Available',
                                `Hello ${userName}! Your daily bulk stock analysis is now ready at 5:00 PM.`,
                                {
                                    type: 'BULK_ANALYSIS',
                                    route: '/bulk-analysis',
                                    timestamp: new Date().toISOString()
                                }
                            );
                        }

                        successCount++;
                        console.log(`✅ [BULK ANALYSIS NOTIFICATION] Sent to ${user.email} (${userName})`);
                    } catch (error) {
                        failureCount++;
                        errors.push({
                            userId: user._id,
                            email: user.email,
                            error: error.message
                        });
                        console.error(`❌ [BULK ANALYSIS NOTIFICATION] Failed to send to ${user.email}:`, error.message);
                    }
                });

                await Promise.all(batchPromises);

                // Wait between batches to avoid rate limiting
                if (i + BATCH_SIZE < users.length) {
                    await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
                }
            }

            const duration = Date.now() - jobStartTime;
            console.log(`✅ [BULK ANALYSIS NOTIFICATION] Job completed in ${duration}ms`);
            console.log(`📊 [BULK ANALYSIS NOTIFICATION] Success: ${successCount}, Failed: ${failureCount}, Total: ${users.length}`);

            if (errors.length > 0) {
                console.error(`❌ [BULK ANALYSIS NOTIFICATION] Errors encountered:`, JSON.stringify(errors, null, 2));
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
            console.error('❌ [BULK ANALYSIS NOTIFICATION] Job failed:', error);
            throw error;
        }
    }

    /**
     * Manually trigger bulk analysis notification (for testing or manual trigger)
     */
    async triggerManualNotification() {
        if (!this.initialized) {
            throw new Error('Agenda service not initialized');
        }

        try {
            console.log('🚀 [BULK ANALYSIS NOTIFICATION] Manually triggering notification job');
            await this.agenda.now('send-bulk-analysis-available-notification');
            console.log('✅ [BULK ANALYSIS NOTIFICATION] Manual notification job triggered');
        } catch (error) {
            console.error('❌ [BULK ANALYSIS NOTIFICATION] Failed to trigger manual notification:', error);
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
            const jobs = await this.agenda.jobs({ name: 'send-bulk-analysis-available-notification' });

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
            console.error('❌ [BULK ANALYSIS NOTIFICATION] Failed to get job status:', error);
            return { error: error.message };
        }
    }

    /**
     * Graceful shutdown
     */
    async shutdown() {
        if (this.agenda) {
            await this.agenda.stop();
            console.log('✅ [BULK ANALYSIS NOTIFICATION] Agenda service shut down gracefully');
        }
    }
}

// Create singleton instance
const agendaBulkAnalysisNotificationService = new AgendaBulkAnalysisNotificationService();

export default agendaBulkAnalysisNotificationService;
