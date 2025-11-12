import Agenda from 'agenda';
import MonitoringSubscription from '../models/monitoringSubscription.js';

/**
 * Agenda Service for Daily Monitoring Cleanup
 * Removes expired monitoring subscriptions
 * Runs daily at 4:00 AM IST (backup for MongoDB TTL index)
 */
class AgendaMonitoringCleanupService {
    constructor() {
        this.agenda = null;
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) {
            console.log('⚠️ [MONITORING CLEANUP] Service already initialized');
            return;
        }

        try {
            console.log('🔄 [MONITORING CLEANUP] Initializing cleanup service...');

            // Initialize Agenda with MongoDB connection
            this.agenda = new Agenda({
                db: {
                    address: process.env.MONGODB_URI,
                    collection: 'agenda_monitoring_cleanup_jobs'
                },
                processEvery: '1 minute',
                maxConcurrency: 1
            });

            // Define the cleanup job
            this.agenda.define('cleanup-expired-monitoring', async (job) => {
                await this.cleanupExpiredMonitoring();
            });

            // Handle agenda events
            this.agenda.on('ready', () => {
                console.log('✅ [MONITORING CLEANUP] Agenda is ready');
            });

            this.agenda.on('error', (error) => {
                console.error('❌ [MONITORING CLEANUP] Agenda error:', error);
            });

            // Start the agenda
            await this.agenda.start();

            // Schedule daily cleanup at 4:00 AM IST (10:30 PM UTC previous day)
            await this.agenda.every('0 22 * * *', 'cleanup-expired-monitoring', null, {
                timezone: 'UTC'
            });

            console.log('✅ [MONITORING CLEANUP] Service initialized - runs daily at 4:00 AM IST');
            this.isInitialized = true;

            // Run cleanup immediately on startup
            console.log('🔄 [MONITORING CLEANUP] Running initial cleanup...');
            await this.cleanupExpiredMonitoring();

        } catch (error) {
            console.error('❌ [MONITORING CLEANUP] Failed to initialize:', error);
            throw error;
        }
    }

    /**
     * Cleanup expired monitoring subscriptions
     */
    async cleanupExpiredMonitoring() {
        try {
            console.log('🔄 [MONITORING CLEANUP] Starting cleanup of expired subscriptions...');

            const now = new Date();
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

            // Find all expired subscriptions (expired more than 1 day ago to be safe)
            const expiredSubscriptions = await MonitoringSubscription.find({
                expires_at: { $lt: oneDayAgo }
            }).lean();

            if (expiredSubscriptions.length === 0) {
                console.log('✅ [MONITORING CLEANUP] No expired subscriptions to clean up');
                return {
                    success: true,
                    deletedCount: 0
                };
            }

            console.log(`📊 [MONITORING CLEANUP] Found ${expiredSubscriptions.length} expired subscriptions`);

            // Log summary
            const statusCounts = {};
            expiredSubscriptions.forEach(sub => {
                statusCounts[sub.monitoring_status] = (statusCounts[sub.monitoring_status] || 0) + 1;
            });

            console.log('📊 [MONITORING CLEANUP] Breakdown by status:');
            Object.entries(statusCounts).forEach(([status, count]) => {
                console.log(`   - ${status}: ${count}`);
            });

            // Delete all expired subscriptions
            const result = await MonitoringSubscription.deleteMany({
                expires_at: { $lt: oneDayAgo }
            });

            console.log(`✅ [MONITORING CLEANUP] Deleted ${result.deletedCount} expired monitoring subscriptions`);

            return {
                success: true,
                deletedCount: result.deletedCount,
                breakdown: statusCounts
            };

        } catch (error) {
            console.error('❌ [MONITORING CLEANUP] Error during cleanup:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Stop the agenda service
     */
    async stop() {
        if (this.agenda) {
            await this.agenda.stop();
            console.log('✅ [MONITORING CLEANUP] Service stopped');
        }
    }

    /**
     * Graceful shutdown
     */
    async shutdown() {
        console.log('🛑 [MONITORING CLEANUP] Shutting down...');
        await this.stop();
    }
}

// Export singleton instance
const agendaMonitoringCleanupService = new AgendaMonitoringCleanupService();
export default agendaMonitoringCleanupService;
