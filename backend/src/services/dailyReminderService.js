import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import cron from 'node-cron';
import { firebaseService } from './firebase/firebase.service.js';
import { User } from '../models/user.js';
import UpstoxUser from '../models/upstoxUser.js';
import monitoringQueueService from './monitoringQueue.js';
import StockAnalysis from '../models/stockAnalysis.js';

// Redis connection configuration
const connection = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null
});

// Create daily reminder queue
const dailyReminderQueue = new Queue('daily-reminders', { connection });

/**
 * Daily Reminder Service
 * Handles daily re-authentication reminders and session expiry notifications
 */
class DailyReminderService {
    constructor() {
        this.worker = null;
        this.cronJobs = new Map();
    }

    /**
     * Initialize the daily reminder service
     */
    initialize() {
        this.initializeWorker();
        this.setupDailyReminders();
        console.log('🔔 Daily reminder service initialized');
    }

    /**
     * Initialize the reminder worker
     */
    initializeWorker() {
        if (this.worker) {
            console.log('⚠️ Daily reminder worker already initialized');
            return;
        }

        this.worker = new Worker(
            'daily-reminders',
            async (job) => await this.processReminder(job),
            {
                connection,
                concurrency: 3,
                autorun: true
            }
        );

        // Worker event handlers
        this.worker.on('completed', (job) => {
            console.log(`✅ Daily reminder job ${job.id} completed`);
        });

        this.worker.on('failed', (job, err) => {
            console.error(`❌ Daily reminder job ${job?.id} failed:`, err.message);
        });

        console.log('🚀 Daily reminder worker initialized');
    }

    /**
     * Setup daily reminder cron jobs
     */
    setupDailyReminders() {
        // Daily reminder at 9:00 AM IST for users with active monitoring
        const morningReminderJob = cron.schedule('0 9 * * *', async () => {
            console.log('⏰ Running daily morning re-auth reminder');
            await this.sendDailyReauthReminders();
        }, {
            scheduled: true,
            timezone: "Asia/Kolkata"
        });

        // Session expiry check at 2:45 AM IST (15 minutes after Upstox reset)
        const sessionCheckJob = cron.schedule('45 2 * * *', async () => {
            console.log('🔑 Running daily session expiry check');
            await this.checkExpiredSessions();
        }, {
            scheduled: true,
            timezone: "Asia/Kolkata"
        });

        this.cronJobs.set('morning_reminder', morningReminderJob);
        this.cronJobs.set('session_check', sessionCheckJob);

        console.log('⏰ Daily reminder cron jobs scheduled');
    }

    /**
     * Send daily re-authentication reminders to users with active monitoring
     */
    async sendDailyReauthReminders() {
        try {
            // Get all users with active monitoring jobs
            const activeJobs = await monitoringQueueService.getActiveJobs();
            const userIds = [...new Set(activeJobs.map(job => job.userId))].filter(Boolean);

            console.log(`📧 Sending daily reminders to ${userIds.length} users with active monitoring`);

            for (const userId of userIds) {
                await dailyReminderQueue.add(
                    'daily-reauth-reminder',
                    { userId, type: 'morning_reminder' },
                    {
                        removeOnComplete: 5,
                        removeOnFail: 5
                    }
                );
            }

        } catch (error) {
            console.error('❌ Failed to send daily re-auth reminders:', error);
        }
    }

    /**
     * Check for expired sessions and pause monitoring
     */
    async checkExpiredSessions() {
        try {
            // Get all users with Upstox connections
            const upstoxUsers = await UpstoxUser.find({ access_token: { $exists: true } });
            
            console.log(`🔍 Checking ${upstoxUsers.length} Upstox sessions for expiry`);

            for (const upstoxUser of upstoxUsers) {
                if (!upstoxUser.isTokenValid()) {
                    await dailyReminderQueue.add(
                        'session-expired-notification',
                        { 
                            userId: upstoxUser.user_id, 
                            type: 'session_expired',
                            reason: 'daily_token_reset'
                        },
                        {
                            removeOnComplete: 5,
                            removeOnFail: 5
                        }
                    );
                }
            }

        } catch (error) {
            console.error('❌ Failed to check expired sessions:', error);
        }
    }

    /**
     * Process reminder job
     */
    async processReminder(job) {
        const { userId, type, reason } = job.data;

        try {
            const user = await User.findById(userId);
            if (!user || !user.fcmToken) {
                console.log(`⚠️ User ${userId} not found or no FCM token`);
                return { status: 'skipped', reason: 'no_user_or_token' };
            }

            switch (type) {
                case 'morning_reminder':
                    return await this.sendMorningReminder(user);
                
                case 'session_expired':
                    return await this.sendSessionExpiredNotification(user, reason);
                
                default:
                    console.log(`⚠️ Unknown reminder type: ${type}`);
                    return { status: 'skipped', reason: 'unknown_type' };
            }

        } catch (error) {
            console.error(`❌ Failed to process reminder for user ${userId}:`, error);
            throw error;
        }
    }

    /**
     * Send morning re-authentication reminder
     */
    async sendMorningReminder(user) {
        try {
            // Check if user has active monitoring
            const activeJobs = await monitoringQueueService.getActiveJobs();
            const userActiveJobs = [];
            
            for (const job of activeJobs) {
                const analysis = await StockAnalysis.findById(job.analysisId);
                if (analysis && analysis.user_id.toString() === user._id.toString()) {
                    userActiveJobs.push({
                        ...job,
                        stock_symbol: analysis.stock_symbol
                    });
                }
            }

            if (userActiveJobs.length === 0) {
                return { status: 'skipped', reason: 'no_active_monitoring' };
            }

            // Check if user's Upstox session is still valid
            const upstoxUser = await UpstoxUser.findByUserId(user._id);
            if (upstoxUser && upstoxUser.isTokenValid()) {
                return { status: 'skipped', reason: 'session_still_valid' };
            }

            const stockSymbols = userActiveJobs.map(job => job.stock_symbol).join(', ');
            
            await firebaseService.sendToDevices(
                [user.fcmToken],
                '🌅 Good Morning! Login to Continue Monitoring',
                `Your ${userActiveJobs.length} active trade${userActiveJobs.length > 1 ? 's' : ''} (${stockSymbols}) need fresh authentication to continue monitoring today.`,
                {
                    type: 'DAILY_REAUTH_REMINDER',
                    activeMonitoring: userActiveJobs.length,
                    stocks: stockSymbols,
                    action: 'LOGIN_REQUIRED',
                    priority: 'high'
                }
            );

            console.log(`✅ Morning reminder sent to user ${user._id} for ${userActiveJobs.length} active monitoring jobs`);

            return {
                status: 'sent',
                activeJobs: userActiveJobs.length,
                stocks: stockSymbols
            };

        } catch (error) {
            console.error(`❌ Failed to send morning reminder to user ${user._id}:`, error);
            throw error;
        }
    }

    /**
     * Send session expired notification and pause monitoring
     */
    async sendSessionExpiredNotification(user, reason = 'session_expired') {
        try {
            // Find all active monitoring for this user
            const activeJobs = await monitoringQueueService.getActiveJobs();
            const userActiveJobs = [];
            
            for (const job of activeJobs) {
                const analysis = await StockAnalysis.findById(job.analysisId);
                if (analysis && analysis.user_id.toString() === user._id.toString()) {
                    userActiveJobs.push({
                        ...job,
                        analysis,
                        stock_symbol: analysis.stock_symbol
                    });
                }
            }

            if (userActiveJobs.length === 0) {
                return { status: 'skipped', reason: 'no_active_monitoring' };
            }

            // Pause all active monitoring for this user
            let pausedCount = 0;
            for (const job of userActiveJobs) {
                const pauseResult = await monitoringQueueService.pauseMonitoring(
                    job.analysisId, 
                    job.strategyId, 
                    reason
                );
                if (pauseResult.success) {
                    pausedCount++;
                }
            }

            const stockSymbols = userActiveJobs.map(job => job.stock_symbol).join(', ');
            
            await firebaseService.sendToDevices(
                [user.fcmToken],
                '🔑 Session Expired - Monitoring Paused',
                `Your Upstox session has expired. ${pausedCount} monitoring job${pausedCount > 1 ? 's' : ''} (${stockSymbols}) have been paused. Please login to resume.`,
                {
                    type: 'SESSION_EXPIRED_BATCH',
                    pausedJobs: pausedCount,
                    stocks: stockSymbols,
                    reason: reason,
                    action: 'REAUTH_REQUIRED',
                    priority: 'high'
                }
            );

            console.log(`🔑 Session expired notification sent to user ${user._id}, paused ${pausedCount} monitoring jobs`);

            return {
                status: 'sent',
                pausedJobs: pausedCount,
                stocks: stockSymbols
            };

        } catch (error) {
            console.error(`❌ Failed to send session expired notification to user ${user._id}:`, error);
            throw error;
        }
    }

    /**
     * Send manual reminder to specific user
     */
    async sendManualReminder(userId, type = 'reauth_required') {
        try {
            await dailyReminderQueue.add(
                'manual-reminder',
                { userId, type, manual: true },
                {
                    removeOnComplete: 5,
                    removeOnFail: 5
                }
            );

            return {
                success: true,
                message: 'Manual reminder queued'
            };

        } catch (error) {
            console.error(`❌ Failed to queue manual reminder for user ${userId}:`, error);
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * Get reminder statistics
     */
    async getReminderStats() {
        try {
            const waiting = await dailyReminderQueue.getWaiting();
            const completed = await dailyReminderQueue.getCompleted();
            const failed = await dailyReminderQueue.getFailed();

            return {
                waiting: waiting.length,
                completed: completed.length,
                failed: failed.length,
                cronJobs: Array.from(this.cronJobs.keys())
            };

        } catch (error) {
            console.error('❌ Failed to get reminder stats:', error);
            return {
                waiting: 0,
                completed: 0,
                failed: 0,
                cronJobs: [],
                error: error.message
            };
        }
    }

    /**
     * Gracefully shutdown the service
     */
    async shutdown() {
        // Stop all cron jobs
        for (const [name, job] of this.cronJobs) {
            job.destroy();
            console.log(`🛑 Stopped cron job: ${name}`);
        }

        // Close worker
        if (this.worker) {
            await this.worker.close();
            console.log('👋 Daily reminder worker shut down gracefully');
        }

        // Close Redis connection
        await connection.quit();
        console.log('👋 Daily reminder Redis connection closed');
    }
}

// Create singleton instance
const dailyReminderService = new DailyReminderService();

// Handle graceful shutdown
process.on('SIGTERM', async () => {
    console.log('📛 SIGTERM received, shutting down daily reminder service...');
    await dailyReminderService.shutdown();
});

process.on('SIGINT', async () => {
    console.log('📛 SIGINT received, shutting down daily reminder service...');
    await dailyReminderService.shutdown();
});

export default dailyReminderService;