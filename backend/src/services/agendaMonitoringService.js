import Agenda from 'agenda';
import mongoose from 'mongoose';
import triggerOrderService from './triggerOrderService.js';
import upstoxMarketTimingService from './upstoxMarketTiming.service.js';
import UpstoxUser from '../models/upstoxUser.js';
import StockAnalysis from '../models/stockAnalysis.js';
import MonitoringHistory from '../models/monitoringHistory.js';
import { decrypt } from '../utils/encryption.js';

class AgendaMonitoringService {
    constructor() {
        this.agenda = null;
        this.isInitialized = false;
        this.activeJobs = new Map(); // Track active monitoring jobs
    }

    async initialize() {
        if (this.isInitialized) return;

        try {
            // Use existing MongoDB connection
            const mongoUrl = process.env.MONGODB_URI;
            this.agenda = new Agenda({ 
                db: { 
                    address: mongoUrl,
                    collection: 'monitoring_jobs',
                    options: {
                        useUnifiedTopology: true
                    }
                },
                processEvery: '30 seconds',
                maxConcurrency: 20,
                defaultConcurrency: 5
            });

            // Define the monitoring job
            this.agenda.define('check-triggers', async (job) => {
                const { analysisId, strategyId, userId } = job.attrs.data;
                await this.executeMonitoringCheck(analysisId, strategyId, userId);
            });

            // Handle job events
            this.agenda.on('ready', () => {
                console.log('🎯 Agenda monitoring service ready');
            });

            this.agenda.on('start', (job) => {
                console.log(`🔄 Monitoring job started: ${job.attrs.name} for ${job.attrs.data.analysisId}_${job.attrs.data.strategyId}`);
            });

            this.agenda.on('success', (job) => {
                console.log(`✅ Monitoring job completed: ${job.attrs.name} for ${job.attrs.data.analysisId}_${job.attrs.data.strategyId}`);
            });

            this.agenda.on('fail', (err, job) => {
                console.error(`❌ Monitoring job failed: ${job.attrs.name} for ${job.attrs.data.analysisId}_${job.attrs.data.strategyId}:`, err);
            });

            // Start agenda
            await this.agenda.start();
            
            // Migrate existing jobs to use Upstox API for market timing
            await this.migrateToUpstoxMarketTiming();
            
            this.isInitialized = true;
            console.log('🚀 Agenda monitoring service initialized successfully');

            // Clean up completed jobs older than 24 hours
            setInterval(async () => {
                try {
                    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
                    await this.agenda.cancel({
                        lastFinishedAt: { $lt: oneDayAgo },
                        $or: [
                            { nextRunAt: { $exists: false } },
                            { nextRunAt: null }
                        ]
                    });
                } catch (error) {
                    console.warn('⚠️ Error cleaning up old monitoring jobs:', error);
                }
            }, 60 * 60 * 1000); // Run every hour

        } catch (error) {
            console.error('❌ Failed to initialize Agenda monitoring service:', error);
            throw error;
        }
    }

    async executeMonitoringCheck(analysisId, strategyId, userId) {
        const startTime = Date.now();
        let historyEntry = null;
        
        try {
            console.log(`🔍 Executing monitoring check for analysis ${analysisId}, strategy ${strategyId}`);

            // Get analysis
            const analysis = await StockAnalysis.findById(analysisId);
            if (!analysis) {
                console.log(`❌ Analysis ${analysisId} not found, stopping monitoring`);
                
                // Create history entry for stopped monitoring
                await MonitoringHistory.create({
                    analysis_id: analysisId,
                    strategy_id: strategyId,
                    user_id: userId,
                    stock_symbol: 'Unknown',
                    status: 'stopped',
                    reason: 'Analysis not found',
                    details: { error_message: 'Analysis document not found in database' },
                    monitoring_duration_ms: Date.now() - startTime
                });
                
                await this.stopMonitoring(analysisId, strategyId);
                return;
            }
            
            // Initialize history entry
            historyEntry = new MonitoringHistory({
                analysis_id: analysisId,
                strategy_id: strategyId,
                user_id: userId,
                stock_symbol: analysis.stock_symbol,
                status: 'checking',
                reason: 'Starting monitoring check',
                details: {},
                monitoring_duration_ms: 0
            });

            // Check if analysis has expired
            if (analysis.expires_at && new Date(analysis.expires_at) < new Date()) {
                console.log(`⏰ Analysis ${analysisId} has expired, stopping monitoring`);
                
                historyEntry.status = 'stopped';
                historyEntry.reason = 'Analysis expired';
                historyEntry.details.error_message = 'Analysis validity period ended';
                historyEntry.monitoring_duration_ms = Date.now() - startTime;
                await historyEntry.save();
                
                await this.stopMonitoring(analysisId, strategyId);
                return;
            }

            // Check if orders are already placed
            if (analysis.hasActiveOrders()) {
                console.log(`📋 Orders already placed for analysis ${analysisId}, stopping monitoring`);
                
                historyEntry.status = 'stopped';
                historyEntry.reason = 'Orders already placed';
                historyEntry.details.order_result = { message: 'Orders were already placed for this analysis' };
                historyEntry.monitoring_duration_ms = Date.now() - startTime;
                await historyEntry.save();
                
                await this.stopMonitoring(analysisId, strategyId);
                return;
            }

            // Get user's Upstox credentials
            const upstoxUser = await UpstoxUser.findByUserId(userId);
            if (!upstoxUser || !upstoxUser.isTokenValid()) {
                console.log(`🔑 Upstox token invalid for user ${userId}, pausing monitoring`);
                
                historyEntry.status = 'error';
                historyEntry.reason = 'Upstox token invalid';
                historyEntry.details.error_message = 'User needs to re-authenticate with Upstox';
                historyEntry.monitoring_duration_ms = Date.now() - startTime;
                await historyEntry.save();
                
                await this.pauseMonitoring(analysisId, strategyId, 'upstox_token_invalid');
                return;
            }

            const accessToken = decrypt(upstoxUser.access_token);
            const today = new Date().toISOString().split('T')[0];

            // Check if market is open (optimized - uses database cache first)
            const marketStatus = await upstoxMarketTimingService.getMarketStatusOptimized(today, accessToken);
            if (!marketStatus.isOpen) {
                const optimizedMsg = marketStatus.optimized ? ' (cached)' : ' (API)';
                console.log(`🏪 Market is closed${optimizedMsg}, skipping monitoring check for ${analysisId}_${strategyId}`);
                console.log(`📅 Reason: ${marketStatus.reason}, Next market session: ${marketStatus.nextOpen || 'Unknown'}`);
                
                // Save market closed status to history
                historyEntry.status = 'market_closed';
                historyEntry.reason = marketStatus.reason;
                historyEntry.addMarketStatus({
                    is_open: false,
                    reason: marketStatus.reason,
                    next_open: marketStatus.nextOpen
                });
                historyEntry.monitoring_duration_ms = Date.now() - startTime;
                await historyEntry.save();
                
                return; // Don't check triggers when market is closed
            }
            
            const optimizedMsg = marketStatus.optimized ? ' (cached)' : ' (API)';
            console.log(`📈 Market is open${optimizedMsg}, proceeding with monitoring check for ${analysisId}_${strategyId}`);

            // Smart trigger checking - only evaluate relevant triggers based on current time
            const currentTime = new Date();
            const triggerResult = await triggerOrderService.checkTriggerConditionsWithTiming(
                analysis, 
                currentTime
            );
            
            // Add market status to history entry
            historyEntry.addMarketStatus({
                is_open: true,
                reason: 'Market is open',
                next_open: null
            });
            
            if (triggerResult.triggersConditionsMet) {
                console.log(`🎯 Triggers met for analysis ${analysisId}, strategy ${strategyId}! Placing order...`);
                
                historyEntry.status = 'conditions_met';
                historyEntry.reason = 'All trigger conditions satisfied';
                if (triggerResult.data) {
                    historyEntry.addTriggerDetails(
                        triggerResult.data.triggers || [],
                        triggerResult.data.current_price
                    );
                }
                
                // Import order service dynamically to avoid circular dependency
                const { default: orderService } = await import('./orderService.js');
                
                try {
                    const orderResult = await orderService.placeOrderFromTrigger(
                        analysisId, 
                        strategyId, 
                        userId, 
                        accessToken
                    );
                    
                    if (orderResult.success) {
                        console.log(`✅ Order placed successfully for ${analysisId}_${strategyId}, stopping monitoring`);
                        
                        historyEntry.status = 'order_placed';
                        historyEntry.reason = 'Order placed successfully';
                        historyEntry.addOrderResult(orderResult);
                        historyEntry.monitoring_duration_ms = Date.now() - startTime;
                        await historyEntry.save();
                        
                        await this.stopMonitoring(analysisId, strategyId);
                    } else {
                        console.log(`❌ Order placement failed for ${analysisId}_${strategyId}: ${orderResult.message}`);
                        
                        historyEntry.status = 'error';
                        historyEntry.reason = 'Order placement failed';
                        historyEntry.details.error_message = orderResult.message;
                        historyEntry.addOrderResult(orderResult);
                        historyEntry.monitoring_duration_ms = Date.now() - startTime;
                        await historyEntry.save();
                    }
                } catch (orderError) {
                    console.error(`❌ Error placing order for ${analysisId}_${strategyId}:`, orderError);
                    
                    historyEntry.status = 'error';
                    historyEntry.reason = 'Order placement error';
                    historyEntry.details.error_message = orderError.message;
                    historyEntry.monitoring_duration_ms = Date.now() - startTime;
                    await historyEntry.save();
                }
            } else {
                console.log(`⏳ Triggers not yet met for ${analysisId}_${strategyId}, continuing monitoring`);
                
                historyEntry.status = 'triggers_not_met';
                historyEntry.reason = triggerResult.message || 'Entry conditions not satisfied';
                if (triggerResult.data) {
                    historyEntry.addTriggerDetails(
                        triggerResult.data.triggers || [],
                        triggerResult.data.current_price
                    );
                }
                historyEntry.monitoring_duration_ms = Date.now() - startTime;
                await historyEntry.save();
            }

        } catch (error) {
            console.error(`❌ Error in monitoring check for ${analysisId}_${strategyId}:`, error);
            
            // Save error to history if we have an entry
            if (historyEntry) {
                historyEntry.status = 'error';
                historyEntry.reason = 'Monitoring check failed';
                historyEntry.details.error_message = error.message;
                historyEntry.monitoring_duration_ms = Date.now() - startTime;
                await historyEntry.save();
            } else {
                // Create error entry if we don't have one yet
                try {
                    await MonitoringHistory.create({
                        analysis_id: analysisId,
                        strategy_id: strategyId,
                        user_id: userId,
                        stock_symbol: 'Unknown',
                        status: 'error',
                        reason: 'Monitoring check failed',
                        details: { error_message: error.message },
                        monitoring_duration_ms: Date.now() - startTime
                    });
                } catch (historyError) {
                    console.error('Failed to save error to monitoring history:', historyError);
                }
            }
        }
    }

    async startMonitoring(analysisId, strategyId, userId, frequency = { seconds: 60 }) {
        try {
            if (!this.isInitialized) {
                await this.initialize();
            }

            const jobId = `monitor_${analysisId}_${strategyId}`;
            
            console.log(`🚀 Starting monitoring for ${jobId} with ${frequency.seconds}s frequency`);

            // Cancel any existing job first
            await this.agenda.cancel({ name: 'check-triggers', 'data.analysisId': analysisId, 'data.strategyId': strategyId });

            // Create cron expression based on frequency - rely on Upstox API for market timing
            let cronExpression;
            if (frequency.seconds === 60) {
                cronExpression = '*/1 * * * *'; // Every minute
            } else if (frequency.seconds === 300) {
                cronExpression = '*/5 * * * *'; // Every 5 minutes
            } else if (frequency.seconds === 900) {
                cronExpression = '*/15 * * * *'; // Every 15 minutes
            } else if (frequency.seconds === 3600) {
                cronExpression = '0 * * * *'; // Every hour
            } else {
                // For custom intervals, use every minute as base
                cronExpression = '*/1 * * * *';
            }
            
            console.log(`📅 Using cron: ${cronExpression} (${frequency.seconds}s frequency) - market timing handled by Upstox API`);

            // Schedule the recurring job
            const job = await this.agenda.every(cronExpression, 'check-triggers', {
                analysisId,
                strategyId,
                userId,
                frequency
            }, {
                _id: jobId,
                timezone: 'Asia/Kolkata'
            });

            // Track in our local map
            this.activeJobs.set(`${analysisId}_${strategyId}`, {
                jobId,
                analysisId,
                strategyId,
                userId,
                frequency,
                startedAt: new Date(),
                status: 'active'
            });

            console.log(`✅ Monitoring started successfully for ${jobId}`);

            return {
                success: true,
                jobId,
                frequency,
                message: `Monitoring started for strategy ${strategyId}`
            };

        } catch (error) {
            console.error(`❌ Error starting monitoring for ${analysisId}_${strategyId}:`, error);
            return {
                success: false,
                message: `Failed to start monitoring: ${error.message}`
            };
        }
    }

    async stopMonitoring(analysisId, strategyId = null) {
        try {
            console.log(`🛑 Stopping monitoring for analysis ${analysisId}${strategyId ? `, strategy ${strategyId}` : ' (all strategies)'}`);

            let cancelQuery = { name: 'check-triggers', 'data.analysisId': analysisId };
            
            if (strategyId) {
                cancelQuery['data.strategyId'] = strategyId;
            }

            // Cancel jobs in Agenda
            const cancelledJobs = await this.agenda.cancel(cancelQuery);
            
            // Remove from local tracking
            if (strategyId) {
                this.activeJobs.delete(`${analysisId}_${strategyId}`);
            } else {
                // Remove all jobs for this analysis
                for (const [key, job] of this.activeJobs.entries()) {
                    if (job.analysisId === analysisId) {
                        this.activeJobs.delete(key);
                    }
                }
            }

            console.log(`✅ Stopped ${cancelledJobs} monitoring job(s) for ${analysisId}${strategyId ? `_${strategyId}` : ''}`);

            return {
                success: true,
                message: strategyId 
                    ? `Monitoring stopped for strategy ${strategyId}` 
                    : `Monitoring stopped for all strategies in analysis ${analysisId}`,
                removedJobs: cancelledJobs
            };

        } catch (error) {
            console.error(`❌ Error stopping monitoring for ${analysisId}_${strategyId}:`, error);
            return {
                success: false,
                message: `Failed to stop monitoring: ${error.message}`
            };
        }
    }

    async getMonitoringStatus(analysisId, strategyId = null) {
        try {
            console.log(`📊 Getting monitoring status for analysis ${analysisId}${strategyId ? `, strategy ${strategyId}` : ''}`);

            const jobKey = strategyId ? `${analysisId}_${strategyId}` : analysisId;
            
            if (strategyId) {
                // Always check MongoDB first (source of truth)
                const agendaJobs = await this.agenda.jobs({
                    name: 'check-triggers',
                    'data.analysisId': analysisId,
                    'data.strategyId': strategyId
                });

                const jobKey = `${analysisId}_${strategyId}`;

                if (agendaJobs.length > 0) {
                    const job = agendaJobs[0];
                    
                    // Update local cache if it exists
                    if (this.activeJobs.has(jobKey)) {
                        const localJob = this.activeJobs.get(jobKey);
                        localJob.jobId = job.attrs._id;
                        localJob.frequency = job.attrs.data.frequency;
                    }
                    
                    return {
                        isMonitoring: true,
                        state: 'active',
                        jobId: job.attrs._id,
                        frequency: job.attrs.data.frequency,
                        nextRun: job.attrs.nextRunAt
                    };
                } else {
                    // No job in MongoDB - clean up local cache if it exists
                    if (this.activeJobs.has(jobKey)) {
                        console.log(`🧹 Cleaning up stale local cache for ${jobKey}`);
                        this.activeJobs.delete(jobKey);
                    }
                    
                    return {
                        isMonitoring: false,
                        state: 'inactive',
                        message: 'Not currently monitoring'
                    };
                }

            } else {
                // Check analysis-level (any strategy)
                const analysisJobs = await this.agenda.jobs({
                    name: 'check-triggers',
                    'data.analysisId': analysisId
                });

                return {
                    isMonitoring: analysisJobs.length > 0,
                    state: analysisJobs.length > 0 ? 'active' : 'inactive',
                    activeStrategies: analysisJobs.length,
                    jobs: analysisJobs.map(job => ({
                        jobId: job.attrs._id,
                        strategyId: job.attrs.data.strategyId,
                        nextRun: job.attrs.nextRunAt
                    }))
                };
            }

        } catch (error) {
            console.error(`❌ Error getting monitoring status for ${analysisId}_${strategyId}:`, error);
            return {
                isMonitoring: false,
                state: 'error',
                message: `Error checking status: ${error.message}`
            };
        }
    }

    async pauseMonitoring(analysisId, strategyId, reason = 'manual') {
        try {
            console.log(`⏸️ Pausing monitoring for ${analysisId}_${strategyId}, reason: ${reason}`);

            // Find and disable the job without deleting it
            const jobs = await this.agenda.jobs({
                name: 'check-triggers',
                'data.analysisId': analysisId,
                'data.strategyId': strategyId
            });

            if (jobs.length > 0) {
                const job = jobs[0];
                job.disable();
                await job.save();

                // Update local tracking
                const localJob = this.activeJobs.get(`${analysisId}_${strategyId}`);
                if (localJob) {
                    localJob.status = 'paused';
                    localJob.pausedAt = new Date();
                    localJob.pauseReason = reason;
                }

                return {
                    success: true,
                    message: `Monitoring paused for strategy ${strategyId}`,
                    reason
                };
            }

            return {
                success: false,
                message: 'No active monitoring found to pause'
            };

        } catch (error) {
            console.error(`❌ Error pausing monitoring for ${analysisId}_${strategyId}:`, error);
            return {
                success: false,
                message: `Failed to pause monitoring: ${error.message}`
            };
        }
    }

    async resumeMonitoring(analysisId, strategyId, userId) {
        try {
            console.log(`▶️ Resuming monitoring for ${analysisId}_${strategyId}`);

            // Find paused job
            const jobs = await this.agenda.jobs({
                name: 'check-triggers',
                'data.analysisId': analysisId,
                'data.strategyId': strategyId
            });

            if (jobs.length > 0) {
                const job = jobs[0];
                job.enable();
                await job.save();

                // Update local tracking
                const localJob = this.activeJobs.get(`${analysisId}_${strategyId}`);
                if (localJob) {
                    localJob.status = 'active';
                    localJob.resumedAt = new Date();
                    delete localJob.pausedAt;
                    delete localJob.pauseReason;
                }

                return {
                    success: true,
                    jobId: job.attrs._id,
                    message: `Monitoring resumed for strategy ${strategyId}`
                };
            }

            // If no paused job found, start fresh monitoring
            return await this.startMonitoring(analysisId, strategyId, userId);

        } catch (error) {
            console.error(`❌ Error resuming monitoring for ${analysisId}_${strategyId}:`, error);
            return {
                success: false,
                message: `Failed to resume monitoring: ${error.message}`
            };
        }
    }

    async getActiveJobs() {
        try {
            const jobs = await this.agenda.jobs({ name: 'check-triggers' });
            return jobs.map(job => ({
                jobId: job.attrs._id,
                analysisId: job.attrs.data.analysisId,
                strategyId: job.attrs.data.strategyId,
                userId: job.attrs.data.userId,
                frequency: job.attrs.data.frequency,
                nextRun: job.attrs.nextRunAt,
                lastRun: job.attrs.lastRunAt
            }));
        } catch (error) {
            console.error('❌ Error getting active jobs:', error);
            return [];
        }
    }

    /**
     * Migrate existing jobs to use Upstox API for market timing
     */
    async migrateToUpstoxMarketTiming() {
        try {
            console.log('🔄 Migrating existing jobs to use Upstox API for market timing...');

            // Get all existing monitoring jobs
            const existingJobs = await this.agenda.jobs({ name: 'check-triggers' });
            let migratedCount = 0;

            for (const job of existingJobs) {
                const { analysisId, strategyId, userId, frequency } = job.attrs.data;
                
                // Check if job is using old cron-restricted scheduling
                const currentInterval = job.attrs.repeatInterval;
                if (currentInterval && currentInterval.includes('1-5')) { // Has cron restrictions
                    console.log(`🔄 Migrating job ${analysisId}_${strategyId} from ${currentInterval} to rely on Upstox API`);
                    
                    // Cancel old job
                    await job.remove();
                    
                    // Create new job that relies on Upstox API for market timing
                    await this.startMonitoring(analysisId, strategyId, userId, frequency || { seconds: 900 });
                    migratedCount++;
                }
            }

            console.log(`✅ Migrated ${migratedCount} jobs to use Upstox API for market timing`);
            return { success: true, migratedCount };

        } catch (error) {
            console.error('❌ Error migrating to Upstox API market timing:', error);
            return { success: false, error: error.message };
        }
    }

    async shutdown() {
        if (this.agenda) {
            console.log('🛑 Shutting down Agenda monitoring service...');
            await this.agenda.stop();
            this.isInitialized = false;
            this.activeJobs.clear();
            console.log('✅ Agenda monitoring service shutdown complete');
        }
    }
}

export default new AgendaMonitoringService();