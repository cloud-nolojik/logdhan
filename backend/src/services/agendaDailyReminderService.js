import Agenda from 'agenda';
import { firebaseService } from './firebase/firebase.service.js';
import { User } from '../models/user.js';
import UpstoxUser from '../models/upstoxUser.js';
// Note: Import will be resolved at runtime to avoid circular dependency
// import agendaMonitoringService from './agendaMonitoringService.js';
import StockAnalysis from '../models/stockAnalysis.js';

/**
 * Agenda-based Daily Reminder Service
 * Handles daily re-authentication reminders and session expiry notifications
 * Uses MongoDB instead of Redis for job persistence
 */
class AgendaDailyReminderService {
    constructor() {
        this.agenda = null;
        this.isInitialized = false;
        this.stats = {
            totalReminders: 0,
            successfulReminders: 0,
            failedReminders: 0,
            sessionsChecked: 0,
            expiredSessions: 0
        };
    }

    async initialize() {
        if (this.isInitialized) return;

        try {
            // Use existing MongoDB connection
            const mongoUrl = process.env.MONGODB_URI;
            this.agenda = new Agenda({ 
                db: { 
                    address: mongoUrl,
                    collection: 'daily_reminder_jobs',
                    options: {
                        useUnifiedTopology: true
                    }
                },
                processEvery: '1 minute',
                maxConcurrency: 10,
                defaultConcurrency: 3
            });

            // Define job types
            this.defineJobs();

            // Handle job events
            this.agenda.on('ready', () => {
                console.log('📧 Agenda daily reminder service ready');
            });

            this.agenda.on('start', (job) => {
                console.log(`🔄 Daily reminder job started: ${job.attrs.name}`);
            });

            this.agenda.on('success', (job) => {
                console.log(`✅ Daily reminder job completed: ${job.attrs.name}`);
                this.stats.successfulReminders++;
            });

            this.agenda.on('fail', (err, job) => {
                console.error(`❌ Daily reminder job failed: ${job.attrs.name}:`, err);
                this.stats.failedReminders++;
            });

            // Start agenda
            await this.agenda.start();

            // Schedule recurring jobs
            await this.scheduleRecurringJobs();
            
            this.isInitialized = true;
            console.log('🚀 Agenda daily reminder service initialized successfully');

            // Note: Job cleanup is now handled by MongoDB TTL indexes and Agenda's built-in cleanup mechanisms

        } catch (error) {
            console.error('❌ Failed to initialize Agenda daily reminder service:', error);
            throw error;
        }
    }

    defineJobs() {
        // REMOVED: send-daily-reauth-reminders job (not required)
        // REMOVED: check-expired-sessions job (not required)
        // REMOVED: send-individual-reminder job (not required)
        // REMOVED: send-session-expired-notification job (not required)
    }

    async scheduleRecurringJobs() {
        try {
            // Cancel existing recurring jobs (cleanup)
            await this.agenda.cancel({ name: 'send-daily-reauth-reminders' });
            await this.agenda.cancel({ name: 'check-expired-sessions' });

            console.log('🧹 Cancelled all reminder jobs - no longer required');

        } catch (error) {
            console.error('❌ Error cancelling reminder jobs:', error);
        }
    }

    /**
     * Send daily re-authentication reminders to users with active monitoring
     */
    async sendDailyReauthReminders() {
        try {
            // Get all users with active monitoring jobs from Agenda (dynamic import to avoid circular dependency)
            const { default: agendaMonitoringService } = await import('./agendaMonitoringService.js');
            const activeJobs = await agendaMonitoringService.getActiveJobs();
            const userIds = [...new Set(activeJobs.map(job => job.userId))].filter(Boolean);

            console.log(`📧 Sending daily reminders to ${userIds.length} users with active monitoring`);

            for (const userId of userIds) {
                await this.agenda.now('send-individual-reminder', { 
                    userId, 
                    type: 'morning_reminder',
                    reason: 'daily_scheduled_reminder'
                });
            }

            this.stats.totalReminders += userIds.length;
            console.log(`✅ Queued ${userIds.length} daily reminder jobs`);

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
            this.stats.sessionsChecked += upstoxUsers.length;

            for (const upstoxUser of upstoxUsers) {
                if (!upstoxUser.isTokenValid()) {
                    console.log(`⏰ Found expired session for user ${upstoxUser.user_id}`);
                    
                    // Send notification
                    await this.agenda.now('send-session-expired-notification', { 
                        userId: upstoxUser.user_id,
                        reason: 'daily_token_reset'
                    });

                    // Pause all monitoring for this user
                    const { default: agendaMonitoringService } = await import('./agendaMonitoringService.js');
                    const userActiveJobs = await agendaMonitoringService.getActiveJobs();
                    const userJobs = userActiveJobs.filter(job => job.userId === upstoxUser.user_id);
                    
                    for (const job of userJobs) {
                        console.log(`⏸️ Pausing monitoring for expired session: ${job.analysisId}_${job.strategyId}`);
                        await agendaMonitoringService.pauseMonitoring(
                            job.analysisId, 
                            job.strategyId, 
                            'upstox_session_expired'
                        );
                    }

                    this.stats.expiredSessions++;
                }
            }

            console.log(`✅ Session expiry check complete: ${this.stats.expiredSessions} expired sessions found`);

        } catch (error) {
            console.error('❌ Failed to check expired sessions:', error);
        }
    }

    /**
     * Send individual reminder notification
     */
    async sendIndividualReminder(userId, type, reason = 'manual') {
        try {
            console.log(`📱 Sending individual reminder to user ${userId}, type: ${type}`);

            // Get user details
            const user = await User.findById(userId);
            if (!user) {
                console.log(`❌ User ${userId} not found for reminder`);
                return;
            }

            // Get user's active monitoring
            const { default: agendaMonitoringService } = await import('./agendaMonitoringService.js');
            const activeJobs = await agendaMonitoringService.getActiveJobs();
            const userJobs = activeJobs.filter(job => job.userId === userId);

            if (userJobs.length === 0) {
                console.log(`📭 No active monitoring for user ${userId}, skipping reminder`);
                return;
            }

            // Get analysis details for the reminder
            const analysisIds = [...new Set(userJobs.map(job => job.analysisId))];
            const analyses = await StockAnalysis.find({ _id: { $in: analysisIds } });

            let title, body;
            
            switch (type) {
                case 'morning_reminder':
                    title = '🌅 Good Morning! Your trades are being monitored';
                    body = `We're actively monitoring ${userJobs.length} strategies across ${analyses.length} stocks. Your Upstox session expires today - please re-authenticate to keep monitoring active.`;
                    break;
                    
                case 'evening_reminder':
                    title = '🌆 Evening Update: Trade Monitoring Status';
                    body = `Your ${userJobs.length} active strategies are being monitored. Don't forget to re-authenticate your Upstox account for tomorrow's trading.`;
                    break;
                    
                case 'reauth_required':
                    title = '🔑 Re-authentication Required';
                    body = `Your Upstox session will expire soon. Please log in again to continue monitoring your ${userJobs.length} active strategies.`;
                    break;
                    
                default:
                    title = '📊 Trade Monitoring Reminder';
                    body = `You have ${userJobs.length} active monitoring strategies. Please check your Upstox connection.`;
            }

            // Add stock symbols to the message
            if (analyses.length > 0) {
                const symbols = analyses.map(a => a.stock_symbol).join(', ');
                body += ` Stocks: ${symbols}`;
            }

            // Send Firebase notification
            if (user.fcmTokens && user.fcmTokens.length > 0) {
                await firebaseService.sendToUser(userId, title, body, {
                    type: 'daily_reminder',
                    reason,
                    active_strategies: userJobs.length.toString(),
                    stocks_count: analyses.length.toString()
                });

                console.log(`✅ Daily reminder sent to user ${userId} (${type})`);
            } else {
                console.log(`⚠️ No FCM tokens for user ${userId}, skipping notification`);
            }

        } catch (error) {
            console.error(`❌ Failed to send individual reminder to user ${userId}:`, error);
            throw error;
        }
    }

    /**
     * Send session expired notification
     */
    async sendSessionExpiredNotification(userId, reason = 'token_expired') {
        try {
            console.log(`🔐 Sending session expired notification to user ${userId}`);

            const user = await User.findById(userId);
            if (!user) {
                console.log(`❌ User ${userId} not found for session expiry notification`);
                return;
            }

            if (user.fcmTokens && user.fcmTokens.length > 0) {
                await firebaseService.sendToUser(userId, '🔐 Upstox Session Expired', 'Your Upstox session has expired. All monitoring has been paused. Please log in again to resume trade monitoring.', {
                    type: 'session_expired',
                    reason,
                    action_required: 'reauth_upstox'
                });

                console.log(`✅ Session expired notification sent to user ${userId}`);
            } else {
                console.log(`⚠️ No FCM tokens for user ${userId}, skipping session expiry notification`);
            }

        } catch (error) {
            console.error(`❌ Failed to send session expired notification to user ${userId}:`, error);
            throw error;
        }
    }

    /**
     * Send manual reminder
     */
    async sendManualReminder(userId, type = 'reauth_required') {
        try {
            console.log(`📧 Sending manual reminder to user ${userId}, type: ${type}`);

            await this.agenda.now('send-individual-reminder', {
                userId,
                type,
                reason: 'manual_trigger'
            });

            return {
                success: true,
                message: `Manual reminder queued for user ${userId}`
            };

        } catch (error) {
            console.error(`❌ Failed to send manual reminder to user ${userId}:`, error);
            return {
                success: false,
                message: `Failed to send reminder: ${error.message}`
            };
        }
    }

    /**
     * Get reminder service statistics
     */
    async getReminderStats() {
        try {
            const jobs = await this.agenda.jobs({});
            const completedJobs = jobs.filter(job => job.attrs.lastFinishedAt);
            const pendingJobs = jobs.filter(job => job.attrs.nextRunAt && job.attrs.nextRunAt > new Date());

            return {
                ...this.stats,
                total_jobs: jobs.length,
                completed_jobs: completedJobs.length,
                pending_jobs: pendingJobs.length,
                last_daily_reminder: completedJobs
                    .filter(job => job.attrs.name === 'send-daily-reauth-reminders')
                    .sort((a, b) => b.attrs.lastFinishedAt - a.attrs.lastFinishedAt)[0]?.attrs.lastFinishedAt,
                last_session_check: completedJobs
                    .filter(job => job.attrs.name === 'check-expired-sessions')
                    .sort((a, b) => b.attrs.lastFinishedAt - a.attrs.lastFinishedAt)[0]?.attrs.lastFinishedAt
            };

        } catch (error) {
            console.error('❌ Error getting reminder stats:', error);
            return this.stats;
        }
    }

    async shutdown() {
        if (this.agenda) {
            console.log('🛑 Shutting down Agenda daily reminder service...');
            await this.agenda.stop();
            this.isInitialized = false;
            console.log('✅ Agenda daily reminder service shutdown complete');
        }
    }
}

export default new AgendaDailyReminderService();