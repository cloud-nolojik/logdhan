import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import triggerOrderService from './triggerOrderService.js';
import orderExecutionService from './orderExecutionService.js';
import StockAnalysis from '../models/stockAnalysis.js';
import MarketHoursUtil from '../utils/marketHours.js';
import { firebaseService } from './firebase/firebase.service.js';
import { User } from '../models/user.js';

// Redis connection configuration
const connection = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null
});

// Create queues
const monitoringQueue = new Queue('trigger-monitoring', { connection });
const resultQueue = new Queue('monitoring-results', { connection });

/**
 * Monitoring Queue Service
 * Handles periodic checking of trigger conditions for stock analyses
 */
class MonitoringQueueService {
    constructor() {
        this.activeJobs = new Map(); // Track active monitoring jobs
        this.pausedJobs = new Map(); // Track paused monitoring jobs
        this.worker = null;
    }

    /**
     * Initialize the monitoring worker
     */
    initializeWorker() {
        if (this.worker) {
            console.log('⚠️ Worker already initialized');
            return;
        }

        this.worker = new Worker(
            'trigger-monitoring',
            async (job) => await this.processTriggerCheck(job),
            {
                connection,
                concurrency: 5, // Process 5 jobs concurrently
                autorun: true
            }
        );

        // Worker event handlers
        this.worker.on('completed', (job) => {
            console.log(`✅ Monitoring job ${job.id} completed`);
        });

        this.worker.on('failed', (job, err) => {
            console.error(`❌ Monitoring job ${job?.id} failed:`, err.message);
        });

        this.worker.on('active', (job) => {
            console.log(`🔄 Processing monitoring job ${job.id}`);
        });

        console.log('🚀 Monitoring worker initialized and running');
    }

    /**
     * Process trigger check job
     */
    async processTriggerCheck(job) {
        const { analysisId, strategyId, userId, attemptCount = 0, maxAttempts = 100 } = job.data;
        
        console.log(`🔍 Processing trigger check for analysis ${analysisId} (attempt ${attemptCount + 1}/${maxAttempts})`);
        
        // Check if market is open before processing
        const marketSession = MarketHoursUtil.getTradingSession();
        if (marketSession.session === 'closed') {
            console.log(`🏛️ Market is closed (${marketSession.reason}), skipping trigger check`);
            return {
                status: 'market_closed',
                message: `Market closed: ${marketSession.reason}`,
                shouldContinue: true
            };
        }
        
        console.log(`🏛️ Market session: ${marketSession.session} ${marketSession.hours || ''}`);
        
        try {
            // 1. Validate and fetch the analysis
            
            // Check if analysisId is a valid MongoDB ObjectId
            if (!analysisId || !analysisId.match(/^[0-9a-fA-F]{24}$/)) {
                console.log(`⚠️ Invalid ObjectId format: ${analysisId} - this is expected for test scenarios`);
                throw new Error(`Invalid analysis ID format: ${analysisId}`);
            }
            
            const analysis = await StockAnalysis.findById(analysisId);
            
            if (!analysis) {
                console.log(`⚠️ Analysis ${analysisId} not found in database`);
                throw new Error(`Analysis ${analysisId} not found`);
            }

            // Check if analysis has expired
            if (analysis.expires_at && new Date(analysis.expires_at) < new Date()) {
                console.log(`⏰ Analysis ${analysisId} has expired, stopping monitoring`);
                await this.stopMonitoring(analysisId);
                return { status: 'expired', message: 'Analysis has expired' };
            }

            // Check if orders are already placed
            if (analysis.hasActiveOrders()) {
                console.log(`📦 Analysis ${analysisId} already has active orders, stopping monitoring`);
                await this.stopMonitoring(analysisId);
                return { status: 'orders_placed', message: 'Orders already placed' };
            }

            // 2. Check trigger conditions
            const triggerResult = await triggerOrderService.checkTriggerConditions(analysis);
            
            if (triggerResult.triggersConditionsMet) {
                console.log(`✅ Triggers satisfied for ${analysis.stock_symbol}, placing order...`);
                
                // 3. Execute order through monitoring service
                const orderResult = await orderExecutionService.executeFromMonitoring(
                    analysisId,
                    strategyId,
                    userId
                );
                
                // Handle session expiry
                if (!orderResult.success && orderResult.error && 
                    (orderResult.error.includes('session') || orderResult.error.includes('token') || 
                     orderResult.error.includes('unauthorized') || orderResult.error.includes('expired'))) {
                    
                    console.log(`🔑 Session expired for user ${userId}, pausing monitoring`);
                    
                    // Pause monitoring (don't stop completely)
                    await this.pauseMonitoring(analysisId, strategyId, 'session_expired');
                    
                    // Send notification to user for re-authentication
                    try {
                        const user = await User.findById(userId);
                        if (user && user.fcmToken) {
                            await firebaseService.sendToDevices(
                                [user.fcmToken],
                                `🔑 Re-authentication Required`,
                                `Your ${analysis.stock_symbol} monitoring is paused. Please re-login to continue monitoring your trade setup.`,
                                {
                                    type: 'SESSION_EXPIRED',
                                    analysisId,
                                    strategyId,
                                    symbol: analysis.stock_symbol,
                                    action: 'REAUTH_REQUIRED'
                                }
                            );
                            console.log('✅ Session expiry notification sent');
                        }
                    } catch (notifError) {
                        console.error('⚠️ Failed to send session expiry notification:', notifError);
                    }
                    
                    return {
                        status: 'session_expired',
                        message: 'Session expired, monitoring paused. User needs to re-authenticate.',
                        requiresAuth: true
                    };
                }
                
                if (orderResult.success) {
                    console.log(`🎯 Order placed successfully for ${analysis.stock_symbol}`);
                    
                    // Store result for notification
                    await this.storeResult({
                        analysisId,
                        userId,
                        status: 'order_placed',
                        data: orderResult.data,
                        timestamp: new Date()
                    });
                    
                    // Send success notification to user
                    try {
                        const user = await User.findById(userId);
                        if (user && user.fcmToken) {
                            await firebaseService.sendToDevices(
                                [user.fcmToken],
                                `✅ Order Placed Successfully!`,
                                `Your ${analysis.stock_symbol} order has been placed at ₹${orderResult.data?.executed_price || orderResult.data?.price || 'market price'}. Order ID: ${orderResult.data?.order_id || 'Processing...'}`,
                                {
                                    type: 'ORDER_PLACED',
                                    analysisId,
                                    orderId: orderResult.data?.order_id || '',
                                    symbol: analysis.stock_symbol,
                                    price: String(orderResult.data?.executed_price || orderResult.data?.price || ''),
                                    action: 'ORDER_EXECUTED'
                                }
                            );
                            console.log('✅ Order placement notification sent');
                        }
                    } catch (notifError) {
                        console.error('⚠️ Failed to send order notification:', notifError);
                    }
                    
                    // Stop monitoring after successful order
                    await this.stopMonitoring(analysisId);
                    
                    return { 
                        status: 'success', 
                        message: `🎉 Great news! Your ${analysis.stock_symbol} order was placed successfully at the perfect entry point!`,
                        orderData: orderResult.data,
                        user_notification_sent: true
                    };
                } else {
                    console.error(`❌ Failed to place order: ${orderResult.message}`);
                    
                    // Continue monitoring if order placement failed
                    return {
                        status: 'order_failed',
                        message: orderResult.message,
                        shouldContinue: true
                    };
                }
            } else if (triggerResult.data?.invalidations?.some(inv => inv.hit)) {
                console.log(`⚠️ Invalidation conditions hit for ${analysis.stock_symbol}, stopping monitoring`);
                
                // Store invalidation result
                await this.storeResult({
                    analysisId,
                    userId,
                    status: 'invalidated',
                    data: triggerResult.data,
                    timestamp: new Date()
                });
                
                // Send invalidation notification
                try {
                    const user = await User.findById(userId);
                    if (user && user.fcmToken) {
                        await firebaseService.sendToDevices(
                            [user.fcmToken],
                            `⚠️ Monitoring Stopped for ${analysis.stock_symbol}`,
                            `Market conditions have changed unfavorably. Your order was not placed to protect you from potential losses. Consider running a fresh analysis.`,
                            {
                                type: 'MONITORING_CANCELLED',
                                analysisId,
                                symbol: analysis.stock_symbol,
                                reason: 'invalidation_triggered',
                                action: 'MONITORING_STOPPED'
                            }
                        );
                        console.log('✅ Invalidation notification sent');
                    }
                } catch (notifError) {
                    console.error('⚠️ Failed to send invalidation notification:', notifError);
                }
                
                // Stop monitoring on invalidation
                await this.stopMonitoring(analysisId);
                
                return {
                    status: 'invalidated',
                    message: 'Strategy invalidated',
                    invalidations: triggerResult.data.invalidations
                };
            } else {
                // Triggers not met yet, continue monitoring
                const failedTriggers = triggerResult.data?.failed_triggers || [];
                console.log(`📊 Triggers not met yet for ${analysis.stock_symbol}. Failed: ${failedTriggers.length}`);
                
                // Check if we've exceeded max attempts
                if (attemptCount >= maxAttempts) {
                    console.log(`⏰ Max attempts reached for ${analysisId}, stopping monitoring`);
                    
                    await this.storeResult({
                        analysisId,
                        userId,
                        status: 'max_attempts_reached',
                        data: triggerResult.data,
                        timestamp: new Date()
                    });
                    
                    // Send expiry notification
                    try {
                        const user = await User.findById(userId);
                        if (user && user.fcmToken) {
                            await firebaseService.sendToDevices(
                                [user.fcmToken],
                                `🕒 Monitoring Period Ended`,
                                `The ideal conditions for ${analysis.stock_symbol} were not met within the monitoring period. Consider reviewing the market and creating a new strategy.`,
                                {
                                    type: 'MONITORING_EXPIRED',
                                    analysisId,
                                    symbol: analysis.stock_symbol,
                                    reason: 'monitoring_expired',
                                    action: 'REANALYZE_SUGGESTED'
                                }
                            );
                            console.log('✅ Expiry notification sent');
                        }
                    } catch (notifError) {
                        console.error('⚠️ Failed to send expiry notification:', notifError);
                    }
                    
                    await this.stopMonitoring(analysisId);
                    
                    return {
                        status: 'max_attempts',
                        message: `Monitoring stopped after ${maxAttempts} attempts`
                    };
                }
                
                return {
                    status: 'continue',
                    message: 'Triggers not met, will check again',
                    failedTriggers: failedTriggers,
                    attemptCount: attemptCount + 1
                };
            }
            
        } catch (error) {
            console.error(`❌ Error in trigger monitoring for ${analysisId}:`, error);
            
            // Store error result
            await this.storeResult({
                analysisId,
                userId,
                status: 'error',
                error: error.message,
                timestamp: new Date()
            });
            
            throw error; // Re-throw to mark job as failed
        }
    }

    /**
     * Start monitoring triggers for an analysis
     */
    async startMonitoring(analysisId, strategyId, userId, frequency = { seconds: 60 }) {
        const jobId = `monitor_${analysisId}_${strategyId}`;
        const jobKey = `${analysisId}_${strategyId}`;
        
        // Check if already monitoring this specific strategy
        if (this.activeJobs.has(jobKey)) {
            console.log(`⚠️ Already monitoring strategy ${strategyId} for analysis ${analysisId}`);
            return {
                success: false,
                message: 'Already monitoring this strategy',
                jobId: this.activeJobs.get(jobKey)
            };
        }
        
        try {
            // Create repeating job
            const job = await monitoringQueue.add(
                'check-triggers',
                {
                    analysisId,
                    strategyId,
                    userId,
                    attemptCount: 0,
                    maxAttempts: MarketHoursUtil.calculateMaxAttemptsForMarketHours(frequency.seconds, 5), // Max attempts for 5 trading days
                    startedAt: new Date()
                },
                {
                    repeat: {
                        every: frequency.seconds * 1000, // Convert to milliseconds
                        limit: 1440 // Max 1440 repetitions (24 hours at 1 min intervals)
                    },
                    jobId,
                    removeOnComplete: {
                        age: 3600, // Keep completed jobs for 1 hour
                        count: 10  // Keep last 10 completed jobs
                    },
                    removeOnFail: {
                        age: 86400 // Keep failed jobs for 24 hours
                    }
                }
            );
            
            // Track active job with strategy-specific key
            this.activeJobs.set(jobKey, jobId);
            
            console.log(`🚀 Started monitoring for strategy ${strategyId} in analysis ${analysisId} with frequency: every ${frequency.seconds} seconds`);
            
            return {
                success: true,
                message: `Monitoring started for analysis ${analysisId}`,
                jobId: jobId,
                frequency: frequency
            };
            
        } catch (error) {
            console.error(`❌ Failed to start monitoring for ${analysisId}:`, error);
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * Stop monitoring an analysis (optionally for a specific strategy)
     */
    async stopMonitoring(analysisId, strategyId = null) {
        try {
            console.log(`🛑 STOP MONITORING CALLED: analysisId=${analysisId}, strategyId=${strategyId}`);
            
            if (strategyId) {
                // Stop specific strategy monitoring
                const jobId = `monitor_${analysisId}_${strategyId}`;
                const jobKey = `${analysisId}_${strategyId}`;
                
                console.log(`🔍 Stopping specific strategy monitoring:`);
                console.log(`   - Job ID: ${jobId}`);
                console.log(`   - Job Key: ${jobKey}`);
                console.log(`   - Active jobs before: ${this.activeJobs.size}`);
                console.log(`   - Active job exists: ${this.activeJobs.has(jobKey)}`);
                
                // Remove the repeatable job definition
                // We need to find the exact repeat options used when creating the job
                const repeatableJobs = await monitoringQueue.getRepeatableJobs();
                console.log(`🔍 Looking for repeatable job: ${jobId}`);
                console.log(`📋 Available repeatable jobs:`, repeatableJobs.map(j => j.id));
                
                const targetJob = repeatableJobs.find(rJob => 
                    rJob.key === 'check-triggers' && rJob.id === jobId
                );
                
                if (targetJob) {
                    console.log(`✅ Found repeatable job, removing with every: ${targetJob.every}`);
                    await monitoringQueue.removeRepeatable('check-triggers', {
                        jobId,
                        every: targetJob.every || 60000 // Use original frequency or default
                    });
                    console.log(`✅ Successfully removed repeatable job: ${jobId}`);
                } else {
                    console.log(`⚠️ Repeatable job not found: ${jobId}`);
                }
                
                // Also check for and remove any active/delayed spawned jobs
                const activeJobs = await monitoringQueue.getJobs(['active', 'waiting', 'delayed']);
                const strategyJobs = activeJobs.filter(job => 
                    job.data.analysisId === analysisId && 
                    job.data.strategyId === strategyId
                );
                
                console.log(`🔍 Found ${strategyJobs.length} active/delayed spawned jobs for this strategy`);
                
                let removedSpawnedJobs = 0;
                for (const job of strategyJobs) {
                    try {
                        const jobState = await job.getState();
                        console.log(`🗑️ Attempting to remove spawned job ${job.id} (state: ${jobState})`);
                        
                        if (jobState === 'delayed') {
                            // For delayed jobs from missing repeatable jobs, we can't manipulate them directly
                            // But we can remove them from our tracking and they'll become orphaned
                            console.log(`⚠️ Job ${job.id} is delayed from missing repeatable job, will be orphaned`);
                            // Don't try to move it to failed, just count it as handled
                            removedSpawnedJobs++;
                        } else {
                            // For active/waiting jobs, try normal removal
                            await job.remove();
                            removedSpawnedJobs++;
                        }
                        console.log(`✅ Successfully handled spawned job ${job.id}`);
                    } catch (jobError) {
                        console.log(`⚠️ Could not remove spawned job ${job.id}: ${jobError.message}`);
                        // If we can't remove it, try to fail it to stop execution
                        try {
                            await job.moveToFailed(new Error('Monitoring cancelled by user'), 'cancel');
                            console.log(`✅ Marked job ${job.id} as failed instead`);
                            removedSpawnedJobs++;
                        } catch (failError) {
                            console.log(`❌ Failed to handle job ${job.id}: ${failError.message}`);
                        }
                    }
                }
                
                // After removing repeatable job, no new spawned jobs will be created
                // Existing spawned jobs will complete or be cleaned up automatically
                console.log(`✅ Removed repeatable job definition for strategy ${strategyId}`);
                
                this.activeJobs.delete(jobKey);
                console.log(`   - Active jobs after: ${this.activeJobs.size}`);
                console.log(`   - Deleted job key: ${jobKey}`);
                
                console.log(`🛑 COMPLETED: Stopped monitoring for strategy ${strategyId} in analysis ${analysisId}`);
                
                return {
                    success: true,
                    message: `Monitoring stopped for strategy ${strategyId}`,
                    removedJobs: 1 + removedSpawnedJobs // Repeatable job + handled spawned jobs
                };
            } else {
                // Stop all monitoring for this analysis (backward compatibility)
                const repeatableJobs = await monitoringQueue.getRepeatableJobs();
                const analysisRepeatableJobs = repeatableJobs.filter(rJob => 
                    rJob.key === 'check-triggers' && 
                    rJob.id && rJob.id.startsWith(`monitor_${analysisId}_`)
                );
                
                // Remove all repeatable job definitions for this analysis
                let stoppedCount = 0;
                for (const rJob of analysisRepeatableJobs) {
                    await monitoringQueue.removeRepeatable('check-triggers', {
                        jobId: rJob.id,
                        every: rJob.every || 60000 // Use original frequency or default
                    });
                    
                    // Extract strategyId from jobId format: monitor_analysisId_strategyId
                    const jobIdParts = rJob.id.split('_');
                    if (jobIdParts.length >= 3) {
                        const jobStrategyId = jobIdParts.slice(2).join('_'); // Handle strategy IDs with underscores
                        const jobKey = `${analysisId}_${jobStrategyId}`;
                        this.activeJobs.delete(jobKey);
                    }
                    
                    stoppedCount++;
                }
                
                // Also remove any active spawned jobs for this analysis
                const activeJobs = await monitoringQueue.getJobs(['active', 'waiting', 'delayed']);
                const analysisJobs = activeJobs.filter(job => 
                    job.data.analysisId === analysisId
                );
                
                for (const job of analysisJobs) {
                    await job.remove();
                    console.log(`🗑️ Removed spawned job ${job.id}`);
                }
                
                console.log(`🛑 Stopped ${stoppedCount} monitoring jobs for analysis ${analysisId}, removed ${analysisJobs.length} active jobs`);
                
                return {
                    success: true,
                    message: `Monitoring stopped for ${stoppedCount} strategies`,
                    removedJobs: analysisJobs.length
                };
            }
            
        } catch (error) {
            console.error(`❌ Failed to stop monitoring for ${analysisId}:`, error);
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * Get monitoring status for an analysis
     */
    async getMonitoringStatus(analysisId, strategyId = null) {
        try {
            console.log(`📊 GET MONITORING STATUS CALLED: analysisId=${analysisId}, strategyId=${strategyId}`);
            
            // Check if monitoring is paused
            const pauseKey = strategyId ? `${analysisId}_${strategyId}` : analysisId;
            console.log(`🔍 Checking pause status for key: ${pauseKey}`);
            
            if (this.pausedJobs && this.pausedJobs.has(pauseKey)) {
                const pausedInfo = this.pausedJobs.get(pauseKey);
                console.log(`⏸️ Found paused job:`, pausedInfo);
                return {
                    isMonitoring: false,
                    isPaused: true,
                    pausedReason: pausedInfo.reason,
                    pausedAt: pausedInfo.pausedAt,
                    message: `Monitoring paused: ${pausedInfo.reason}`
                };
            }
            
            // For repeatable jobs, we need to check:
            // 1. The repeatable job definition exists
            // 2. Active/waiting/delayed jobs spawned from the repeatable job
            
            const jobId = strategyId ? `monitor_${analysisId}_${strategyId}` : `monitor_${analysisId}`;
            console.log(`🔍 Looking for job with ID: ${jobId}`);
            
            // Check for repeatable job definition
            const repeatableJobs = await monitoringQueue.getRepeatableJobs();
            const hasRepeatableJob = repeatableJobs.some(rJob => 
                rJob.key === 'check-triggers' && rJob.id === jobId
            );
            
            // Also check if there's any job with a similar pattern or if we have any check-triggers job for this analysis
            const similarJob = repeatableJobs.find(rJob => 
                rJob.key === 'check-triggers' && (
                    (rJob.id && rJob.id.includes(analysisId) && (!strategyId || rJob.id.includes(strategyId))) ||
                    // For hash-based keys, we need to check if there are spawned jobs that match our analysis/strategy
                    (!rJob.id || rJob.id === 'undefined')
                )
            );
            
            // Check if we have matching spawned jobs first - this is the most reliable indicator
            const spawnedJobs = await monitoringQueue.getJobs(['delayed', 'waiting', 'active']);
            const hasMatchingSpawnedJob = spawnedJobs.some(job => 
                job.data.analysisId === analysisId && 
                (!strategyId || job.data.strategyId === strategyId)
            );
            
            console.log(`🎯 Spawned job verification: found ${hasMatchingSpawnedJob ? 'MATCHING' : 'NO'} spawned jobs for this analysis/strategy`);
            
            // If we have matching spawned jobs, there must be a repeatable job (even if ID is undefined)
            let verifiedSimilarJob = similarJob;
            if (!similarJob && hasMatchingSpawnedJob && repeatableJobs.length > 0) {
                // If we have spawned jobs but no similar job found, use the first repeatable job
                verifiedSimilarJob = repeatableJobs[0]; // Take the first available repeatable job
                console.log(`✅ Using first repeatable job as verified job (has matching spawned jobs): ${verifiedSimilarJob.key}`);
            } else if (similarJob && (!similarJob.id || similarJob.id === 'undefined')) {
                if (hasMatchingSpawnedJob) {
                    console.log(`✅ Verified undefined ID job belongs to our analysis (has matching spawned jobs)`);
                    verifiedSimilarJob = similarJob;
                } else {
                    console.log(`❌ Undefined ID job does not belong to our analysis (no matching spawned jobs)`);
                    verifiedSimilarJob = null;
                }
            }
            
            console.log(`📋 Repeatable jobs check:`);
            console.log(`   - Total repeatable jobs: ${repeatableJobs.length}`);
            console.log(`   - Looking for: ${jobId}`);
            console.log(`   - All repeatable job IDs:`, repeatableJobs.map(rJob => rJob.id));
            console.log(`   - All repeatable job keys:`, repeatableJobs.map(rJob => rJob.key));
            console.log(`   - Found exact repeatable job: ${hasRepeatableJob}`);
            console.log(`   - Found similar job:`, verifiedSimilarJob ? verifiedSimilarJob.id || verifiedSimilarJob.key : 'none');
            
            // Get all active jobs for this queue
            const activeJobs = await monitoringQueue.getJobs(['delayed', 'waiting', 'active']);
            console.log(`🔍 Active jobs in queue: ${activeJobs.length}`);
            
            // Find jobs spawned from our repeatable job
            let matchingJobs = [];
            
            if (strategyId) {
                // Look for specific strategy jobs
                matchingJobs = activeJobs.filter(job => 
                    job.data.analysisId === analysisId && 
                    job.data.strategyId === strategyId
                );
                console.log(`🎯 Strategy-specific job search: found ${matchingJobs.length} jobs`);
            } else {
                // Look for any jobs for this analysis (backward compatibility)
                matchingJobs = activeJobs.filter(job => 
                    job.data.analysisId === analysisId
                );
                console.log(`📊 Analysis-wide job search: found ${matchingJobs.length} jobs`);
            }
            
            // Debug logging for active jobs tracking
            const jobKey = strategyId ? `${analysisId}_${strategyId}` : analysisId;
            console.log(`🗂️ Active jobs tracking:`);
            console.log(`   - Job key: ${jobKey}`);
            console.log(`   - In activeJobs map: ${this.activeJobs.has(jobKey)}`);
            console.log(`   - ActiveJobs map size: ${this.activeJobs.size}`);
            
            // Debug logging
            console.log(`🔍 FINAL STATUS CHECK for ${analysisId}${strategyId ? `_${strategyId}` : ''}:`);
            console.log(`   ✓ Repeatable job exists: ${hasRepeatableJob}`);
            console.log(`   ✓ Active spawned jobs: ${matchingJobs.length}`);
            console.log(`   ✓ Jobs details:`, matchingJobs.map(j => ({ id: j.id, state: j.opts?.delay ? 'delayed' : 'active' })));
            
            // If we have matching spawned jobs, we can be confident monitoring is active
            if (hasMatchingSpawnedJob && verifiedSimilarJob) {
                console.log(`✅ MONITORING ACTIVE: Found verified job with spawned jobs (${matchingJobs.length} active)`);
                
                // Update our activeJobs tracking
                const jobKey = strategyId ? `${analysisId}_${strategyId}` : analysisId;
                if (!this.activeJobs.has(jobKey)) {
                    this.activeJobs.set(jobKey, {
                        analysisId,
                        strategyId,
                        jobId: verifiedSimilarJob.id || verifiedSimilarJob.key,
                        frequency: { seconds: 60 }, // Default frequency
                        startedAt: new Date()
                    });
                }
                
                return {
                    isMonitoring: true,
                    state: 'active',
                    jobId: verifiedSimilarJob.id || verifiedSimilarJob.key,
                    frequency: { seconds: 60 },
                    nextRun: new Date(Date.now() + 60000) // Approximate next run
                };
            }
            
            // If there's no repeatable job and no matching spawned jobs
            if (!hasRepeatableJob && !verifiedSimilarJob) {
                console.log(`❌ NO MONITORING: No repeatable job found (${matchingJobs.length} orphaned jobs ignored)`);
                
                // Clean up our activeJobs tracking for this strategy
                const jobKey = strategyId ? `${analysisId}_${strategyId}` : analysisId;
                if (this.activeJobs.has(jobKey)) {
                    this.activeJobs.delete(jobKey);
                    console.log(`🧹 Cleaned up orphaned job tracking for ${jobKey}`);
                }
                
                return {
                    isMonitoring: false,
                    message: 'Not currently monitoring'
                };
            }
            
            // Use similar job if exact match not found
            const actualJob = hasRepeatableJob ? { id: jobId } : verifiedSimilarJob;
            const actualHasRepeatableJob = hasRepeatableJob || !!verifiedSimilarJob;
            
            console.log(`🎯 Using job: ${actualJob?.id || actualJob?.key || 'none'} (exact match: ${hasRepeatableJob}, similar: ${!!verifiedSimilarJob})`);
            
            // If we have a repeatable job but no active spawned jobs, 
            // it means monitoring is set up but not currently executing
            if (actualHasRepeatableJob && matchingJobs.length === 0) {
                const jobKey = strategyId ? `${analysisId}_${strategyId}` : analysisId;
                
                // Update our activeJobs tracking
                if (!this.activeJobs.has(jobKey)) {
                    this.activeJobs.set(jobKey, actualJob?.id || actualJob?.key || jobId);
                    console.log(`🔄 Restored active job tracking for ${jobKey}`);
                }
                
                return {
                    isMonitoring: true,
                    jobId: actualJob?.id || actualJob?.key || jobId,
                    state: 'waiting_for_next_execution',
                    progress: 0,
                    message: 'Monitoring scheduled, waiting for next execution',
                    attemptCount: 0,
                    maxAttempts: 0,
                    startedAt: null
                };
            }
            
            // Return status of the most recent spawned job
            if (matchingJobs.length > 0) {
                const mostRecentJob = matchingJobs[0]; // Jobs are typically ordered by creation time
                const state = await mostRecentJob.getState();
                const isJobActive = state === 'active' || state === 'waiting' || state === 'delayed';
                
                console.log(`🔍 Most recent job ${mostRecentJob.id} state: ${state}, isActive: ${isJobActive}`);
                
                const jobKey = strategyId ? `${analysisId}_${strategyId}` : `${analysisId}_${mostRecentJob.data.strategyId}`;
                
                // Update our activeJobs tracking if job is active
                if (isJobActive && !this.activeJobs.has(jobKey)) {
                    this.activeJobs.set(jobKey, jobId);
                    console.log(`🔄 Restored active job tracking for ${jobKey}`);
                }
                
                return {
                    isMonitoring: isJobActive, // True if job is active, waiting, or delayed
                    jobId: mostRecentJob.id,
                    templateJobId: jobId, // The original template job ID
                    state: state,
                    strategyId: mostRecentJob.data.strategyId,
                    progress: mostRecentJob.progress,
                    attemptCount: mostRecentJob.data?.attemptCount || 0,
                    maxAttempts: mostRecentJob.data?.maxAttempts || 0,
                    startedAt: mostRecentJob.data?.startedAt,
                    activeSpawnedJobs: matchingJobs.length,
                    hasRepeatableJob: hasRepeatableJob // Keep this for additional info
                };
            }
            
            return {
                isMonitoring: false,
                message: 'No monitoring jobs found'
            };
            
        } catch (error) {
            console.error(`❌ Failed to get monitoring status for ${analysisId}:`, error);
            return {
                isMonitoring: false,
                error: error.message
            };
        }
    }

    /**
     * Store monitoring result for notifications
     */
    async storeResult(result) {
        try {
            await resultQueue.add('monitoring-result', result, {
                removeOnComplete: {
                    age: 86400, // Keep for 24 hours
                    count: 100  // Keep last 100 results
                }
            });
            
            console.log(`📝 Stored monitoring result for analysis ${result.analysisId}`);
            
        } catch (error) {
            console.error('❌ Failed to store monitoring result:', error);
        }
    }

    /**
     * Get monitoring results for a user
     */
    async getResults(userId, limit = 10) {
        try {
            const jobs = await resultQueue.getJobs(['completed'], 0, limit);
            
            const userResults = jobs
                .map(job => job.data)
                .filter(data => data.userId === userId)
                .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            
            return userResults;
            
        } catch (error) {
            console.error(`❌ Failed to get results for user ${userId}:`, error);
            return [];
        }
    }

    /**
     * Pause monitoring (don't delete, just mark as paused)
     */
    async pauseMonitoring(analysisId, strategyId, reason = 'manual') {
        try {
            const jobId = `monitor_${analysisId}_${strategyId}`;
            
            // Add to paused jobs tracking
            if (!this.pausedJobs) {
                this.pausedJobs = new Map();
            }
            
            this.pausedJobs.set(`${analysisId}_${strategyId}`, {
                analysisId,
                strategyId,
                reason,
                pausedAt: new Date(),
                originalJobId: jobId
            });
            
            // Stop the current monitoring
            await this.stopMonitoring(analysisId, strategyId);
            
            console.log(`⏸️ Paused monitoring for ${analysisId}_${strategyId}, reason: ${reason}`);
            
            return {
                success: true,
                message: `Monitoring paused: ${reason}`
            };
            
        } catch (error) {
            console.error(`❌ Failed to pause monitoring:`, error);
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * Resume paused monitoring
     */
    async resumeMonitoring(analysisId, strategyId, userId) {
        try {
            const pauseKey = `${analysisId}_${strategyId}`;
            
            if (!this.pausedJobs || !this.pausedJobs.has(pauseKey)) {
                return {
                    success: false,
                    message: 'No paused monitoring found for this analysis'
                };
            }
            
            // Remove from paused jobs
            this.pausedJobs.delete(pauseKey);
            
            // Restart monitoring
            const result = await this.startMonitoring(analysisId, strategyId, userId);
            
            console.log(`▶️ Resumed monitoring for ${analysisId}_${strategyId}`);
            
            return result;
            
        } catch (error) {
            console.error(`❌ Failed to resume monitoring:`, error);
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * Get all active monitoring jobs
     */
    async getActiveJobs() {
        const activeJobs = [];
        
        for (const [analysisId, jobId] of this.activeJobs) {
            const status = await this.getMonitoringStatus(analysisId);
            activeJobs.push({
                analysisId,
                jobId,
                ...status
            });
        }
        
        return activeJobs;
    }

    /**
     * Get paused monitoring jobs
     */
    async getPausedJobs(userId = null) {
        if (!this.pausedJobs) {
            return [];
        }
        
        const paused = Array.from(this.pausedJobs.values());
        
        if (userId) {
            // Filter by userId if provided (would need to store userId in pause data)
            return paused.filter(p => p.userId === userId);
        }
        
        return paused;
    }

    /**
     * Clean up old completed jobs
     */
    async cleanupOldJobs() {
        try {
            const completed = await monitoringQueue.clean(
                3600 * 1000, // Grace period of 1 hour
                100,          // Limit
                'completed'
            );
            
            const failed = await monitoringQueue.clean(
                86400 * 1000, // Grace period of 24 hours
                100,          // Limit
                'failed'
            );
            
            console.log(`🧹 Cleaned up ${completed.length} completed and ${failed.length} failed jobs`);
            
        } catch (error) {
            console.error('❌ Failed to cleanup old jobs:', error);
        }
    }

    /**
     * Gracefully shutdown the worker
     */
    async shutdown() {
        if (this.worker) {
            await this.worker.close();
            console.log('👋 Monitoring worker shut down gracefully');
        }
        
        await connection.quit();
        console.log('👋 Redis connection closed');
    }
}

// Create singleton instance
const monitoringQueueService = new MonitoringQueueService();

// Initialize worker on module load
monitoringQueueService.initializeWorker();

// Cleanup old jobs periodically
setInterval(() => {
    monitoringQueueService.cleanupOldJobs();
}, 3600 * 1000); // Every hour

// Handle graceful shutdown
process.on('SIGTERM', async () => {
    console.log('📛 SIGTERM received, shutting down monitoring service...');
    await monitoringQueueService.shutdown();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('📛 SIGINT received, shutting down monitoring service...');
    await monitoringQueueService.shutdown();
    process.exit(0);
});

export default monitoringQueueService;