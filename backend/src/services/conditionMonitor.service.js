// Try to import Bull, but make it optional
let Bull = null;
try {
    const bullModule = await import('bull');
    Bull = bullModule.default;
} catch (error) {
    console.warn('⚠️ Bull package not installed, using fallback monitoring');
}

import conditionValidator from './conditionValidator.service.js';
import upstoxService from './upstox.service.js';
import UpstoxUser from '../models/upstoxUser.js';
import StockAnalysis from '../models/stockAnalysis.js';
import crypto from 'crypto';

// Encryption helpers (same as upstox.js)
const ENCRYPTION_KEY = process.env.UPSTOX_ENCRYPTION_KEY ? 
    crypto.createHash('sha256').update(process.env.UPSTOX_ENCRYPTION_KEY).digest() : 
    crypto.randomBytes(32);

function decrypt(text) {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = textParts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

class ConditionMonitorService {
    constructor() {
        this.queue = null;
        this.isInitialized = false;
        this.fallbackIntervals = new Map(); // Fallback for when Redis/Bull isn't available
    }

    /**
     * Initialize Bull queue with Redis connection
     */
    async initialize() {
        try {
            // Check if Redis is available
            const redisConfig = {
                host: process.env.REDIS_HOST || 'localhost',
                port: process.env.REDIS_PORT || 6379,
                password: process.env.REDIS_PASSWORD || undefined,
                db: process.env.REDIS_DB || 0
            };

            if (!Bull) {
                throw new Error('Bull package not installed');
            }
            
            console.log('🔄 Initializing Bull queue for condition monitoring...');
            
            // Create Bull queue
            this.queue = new Bull('condition-monitoring', {
                redis: redisConfig,
                defaultJobOptions: {
                    removeOnComplete: 50,
                    removeOnFail: 20,
                    attempts: 3,
                    backoff: {
                        type: 'exponential',
                        delay: 5000
                    }
                }
            });

            // Process jobs
            this.setupJobProcessors();

            // Test connection
            await this.queue.isReady();
            
            this.isInitialized = true;
            console.log('✅ Bull queue initialized successfully');

            return true;
        } catch (error) {
            console.warn('⚠️ Bull/Redis not available, using fallback monitoring:', error.message);
            this.initializeFallback();
            return false;
        }
    }

    /**
     * Setup job processors for different condition types
     */
    setupJobProcessors() {
        // Monitor entry conditions for pending orders
        this.queue.process('monitor-entry-conditions', 5, async (job) => {
            const { analysisId, userId } = job.data;
            return await this.processEntryConditionCheck(analysisId, userId);
        });

        // Monitor invalidation conditions for active orders
        this.queue.process('monitor-invalidations', 5, async (job) => {
            const { analysisId, userId } = job.data;
            return await this.processInvalidationCheck(analysisId, userId);
        });

        // Cleanup expired monitoring jobs
        this.queue.process('cleanup-expired', 1, async (job) => {
            return await this.cleanupExpiredJobs();
        });

        // Event listeners
        this.queue.on('completed', (job, result) => {
            console.log(`✅ Condition monitoring job ${job.id} completed:`, result);
        });

        this.queue.on('failed', (job, err) => {
            console.error(`❌ Condition monitoring job ${job.id} failed:`, err.message);
        });
    }

    /**
     * Start monitoring conditions for an analysis
     */
    async startMonitoring(analysisId, userId, strategy) {
        try {
            const jobData = { analysisId, userId, strategy };
            
            if (this.isInitialized && this.queue) {
                // Use Bull for robust monitoring
                await this.addBullJobs(jobData, strategy);
                console.log(`📋 Started Bull-based monitoring for analysis ${analysisId}`);
            } else {
                // Use fallback monitoring
                this.addFallbackMonitoring(jobData, strategy);
                console.log(`📋 Started fallback monitoring for analysis ${analysisId}`);
            }

            return true;
        } catch (error) {
            console.error('❌ Error starting monitoring:', error);
            return false;
        }
    }

    /**
     * Add Bull jobs based on strategy requirements
     */
    async addBullJobs(jobData, strategy) {
        const { analysisId } = jobData;

        // Determine monitoring frequency based on entry conditions
        const monitoringFrequency = this.getMonitoringFrequency(strategy);
        
        // Add entry condition monitoring job
        await this.queue.add('monitor-entry-conditions', jobData, {
            repeat: { 
                cron: monitoringFrequency.cron,
                endDate: new Date(Date.now() + 24 * 60 * 60 * 1000) // Stop after 24 hours
            },
            jobId: `entry-${analysisId}` // Unique ID to prevent duplicates
        });

        // Add invalidation monitoring (more frequent for active positions)
        await this.queue.add('monitor-invalidations', jobData, {
            repeat: { 
                cron: '*/2 * * * *', // Every 2 minutes for invalidations
                endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // Stop after 7 days
            },
            jobId: `invalidation-${analysisId}`
        });

        console.log(`🔄 Added Bull jobs with ${monitoringFrequency.description} frequency`);
    }

    /**
     * Determine monitoring frequency based on strategy timeframes
     */
    getMonitoringFrequency(strategy) {
        const triggers = strategy.triggers || [];
        
        // Check if any trigger uses 15min or higher timeframes
        const hasMinuteConditions = triggers.some(t => 
            t.timeframe === '1m' || t.timeframe === '5m'
        );
        const has15MinConditions = triggers.some(t => 
            t.timeframe === '15m' || t.left?.ref?.includes('15m') || t.right?.ref?.includes('15m')
        );
        const hasHourlyConditions = triggers.some(t => 
            t.timeframe === '1h' || t.left?.ref?.includes('1h') || t.right?.ref?.includes('1h')
        );

        if (hasMinuteConditions) {
            return { cron: '*/1 * * * *', description: 'every 1 minute' }; // Every minute
        } else if (has15MinConditions) {
            return { cron: '*/15 * * * *', description: 'every 15 minutes' }; // Every 15 minutes
        } else if (hasHourlyConditions) {
            return { cron: '0 * * * *', description: 'every hour' }; // Every hour
        } else {
            return { cron: '*/5 * * * *', description: 'every 5 minutes' }; // Default: every 5 minutes
        }
    }

    /**
     * Process entry condition checking
     */
    async processEntryConditionCheck(analysisId, userId) {
        try {
            console.log(`🔍 Checking entry conditions for analysis ${analysisId}`);

            // Get analysis and user data
            const analysis = await StockAnalysis.findById(analysisId);
            if (!analysis || analysis.user_id.toString() !== userId) {
                return { status: 'analysis_not_found' };
            }

            // Skip if orders already placed
            if (analysis.hasActiveOrders()) {
                return { status: 'orders_already_active' };
            }

            // Get user's Upstox credentials
            const upstoxUser = await UpstoxUser.findByUserId(userId);
            if (!upstoxUser || !upstoxUser.isTokenValid()) {
                return { status: 'upstox_token_invalid' };
            }

            const accessToken = decrypt(upstoxUser.access_token);

            // Validate conditions with real-time data
            const validation = await conditionValidator.validateConditionsRealTime(
                analysis,
                accessToken
            );

            if (validation.valid) {
                console.log(`✅ Conditions met for analysis ${analysisId}, placing order`);
                
                // Place order automatically
                const orderResult = await this.placeOrderFromAnalysis(analysis, upstoxUser, accessToken);
                
                if (orderResult.success) {
                    // Stop monitoring this analysis
                    await this.stopMonitoring(analysisId);
                    return { 
                        status: 'order_placed',
                        order_id: orderResult.order_id 
                    };
                } else {
                    return { 
                        status: 'order_failed',
                        error: orderResult.error 
                    };
                }
            } else {
                return { 
                    status: 'conditions_not_met',
                    reason: validation.reason,
                    failed_triggers: validation.triggers?.filter(t => !t.passed) || []
                };
            }

        } catch (error) {
            console.error(`❌ Error processing entry condition check:`, error);
            return { status: 'error', error: error.message };
        }
    }

    /**
     * Place order from analysis when conditions are met
     */
    async placeOrderFromAnalysis(analysis, upstoxUser, accessToken) {
        try {
            const strategy = analysis.analysis_data?.strategies?.[0];
            if (!strategy) {
                throw new Error('No strategy found in analysis');
            }

            // Convert AI strategy to order
            const orderData = await upstoxService.convertAIStrategyToOrder(
                strategy,
                analysis.instrument_key,
                analysis.analysis_type,
                accessToken
            );

            console.log(`📋 Auto-placing order for ${analysis.stock_symbol}:`, {
                type: strategy.type,
                entry: strategy.entry,
                quantity: orderData.quantity
            });

            // Place the order
            let orderResult;
            if (strategy.stopLoss && strategy.target) {
                // Use bracket order for strategies with SL/target
                orderResult = await upstoxService.placeMultiOrderBracket(accessToken, orderData);
            } else {
                // Use single order
                orderResult = await upstoxService.placeOrder(accessToken, orderData);
            }

            if (orderResult.success) {
                // Track the order in analysis
                await analysis.addPlacedOrders({
                    ...orderResult.data,
                    strategy_id: strategy.id,
                    quantity: orderData.quantity,
                    price: orderData.price,
                    transaction_type: orderData.transactionType,
                    product: orderData.product,
                    tag: orderData.tag,
                    stopLoss: orderData.stopLoss,
                    target: orderData.target,
                    auto_placed: true // Flag for auto-placed orders
                });

                // Update order statistics
                await upstoxUser.updateOrderStats(true);

                return {
                    success: true,
                    order_id: orderResult.data?.order_id || orderResult.data?.data?.order_id
                };
            } else {
                await upstoxUser.updateOrderStats(false);
                return {
                    success: false,
                    error: orderResult.message || 'Order placement failed'
                };
            }

        } catch (error) {
            console.error('❌ Error placing order from analysis:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Stop monitoring for a specific analysis
     */
    async stopMonitoring(analysisId) {
        try {
            if (this.isInitialized && this.queue) {
                // Remove Bull jobs
                await this.queue.removeRepeatable('monitor-entry-conditions', { jobId: `entry-${analysisId}` });
                await this.queue.removeRepeatable('monitor-invalidations', { jobId: `invalidation-${analysisId}` });
                console.log(`🛑 Stopped Bull monitoring for analysis ${analysisId}`);
            }

            // Clear fallback intervals
            if (this.fallbackIntervals.has(analysisId)) {
                clearInterval(this.fallbackIntervals.get(analysisId));
                this.fallbackIntervals.delete(analysisId);
                console.log(`🛑 Stopped fallback monitoring for analysis ${analysisId}`);
            }

            return true;
        } catch (error) {
            console.error('❌ Error stopping monitoring:', error);
            return false;
        }
    }

    /**
     * Fallback monitoring when Bull/Redis is not available
     */
    initializeFallback() {
        console.log('🔄 Initializing fallback condition monitoring...');
        
        // Check all pending analyses every 5 minutes
        const fallbackInterval = setInterval(async () => {
            try {
                await this.checkAllPendingAnalyses();
            } catch (error) {
                console.error('❌ Fallback monitoring error:', error);
            }
        }, 5 * 60 * 1000); // 5 minutes

        // Store global interval for cleanup
        this.fallbackIntervals.set('global', fallbackInterval);
        
        console.log('✅ Fallback monitoring initialized');
    }

    /**
     * Add fallback monitoring for specific analysis
     */
    addFallbackMonitoring(jobData, strategy) {
        const { analysisId } = jobData;
        const frequency = this.getMonitoringFrequency(strategy);
        
        // Convert cron to milliseconds (simplified)
        let intervalMs = 5 * 60 * 1000; // Default 5 minutes
        if (frequency.cron === '*/1 * * * *') intervalMs = 60 * 1000; // 1 minute
        if (frequency.cron === '*/15 * * * *') intervalMs = 15 * 60 * 1000; // 15 minutes
        
        const interval = setInterval(async () => {
            await this.processEntryConditionCheck(analysisId, jobData.userId);
        }, intervalMs);
        
        this.fallbackIntervals.set(analysisId, interval);
    }

    /**
     * Check all pending analyses (fallback mode)
     */
    async checkAllPendingAnalyses() {
        try {
            // Find analyses waiting for entry conditions
            const pendingAnalyses = await StockAnalysis.find({
                status: 'completed',
                expires_at: { $gt: new Date() },
                'analysis_data.order_gate.can_place_order': false,
                'placed_orders.0': { $exists: false } // No orders placed yet
            }).limit(20); // Limit to prevent overload

            console.log(`🔍 Checking ${pendingAnalyses.length} pending analyses`);

            for (const analysis of pendingAnalyses) {
                await this.processEntryConditionCheck(
                    analysis._id.toString(), 
                    analysis.user_id.toString()
                );
            }
        } catch (error) {
            console.error('❌ Error checking pending analyses:', error);
        }
    }

    /**
     * Process invalidation conditions for active orders
     */
    async processInvalidationCheck(analysisId, userId) {
        // TODO: Implement invalidation monitoring for active positions
        return { status: 'invalidation_check_completed' };
    }

    /**
     * Cleanup expired monitoring jobs
     */
    async cleanupExpiredJobs() {
        try {
            if (this.isInitialized && this.queue) {
                const jobs = await this.queue.getJobs(['completed', 'failed']);
                let cleaned = 0;
                
                for (const job of jobs) {
                    if (Date.now() - job.timestamp > 24 * 60 * 60 * 1000) { // Older than 24 hours
                        await job.remove();
                        cleaned++;
                    }
                }
                
                console.log(`🧹 Cleaned up ${cleaned} expired monitoring jobs`);
                return { cleaned };
            }
        } catch (error) {
            console.error('❌ Error cleaning up jobs:', error);
        }
    }

    /**
     * Get monitoring status
     */
    async getMonitoringStatus() {
        const status = {
            bull_available: this.isInitialized,
            fallback_active: this.fallbackIntervals.size > 0,
            monitored_analyses: this.fallbackIntervals.size
        };

        if (this.isInitialized && this.queue) {
            status.active_jobs = await this.queue.getJobCounts();
        }

        return status;
    }
}

export default new ConditionMonitorService();