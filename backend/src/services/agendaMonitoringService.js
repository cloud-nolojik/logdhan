import Agenda from 'agenda';
import mongoose from 'mongoose';
import triggerOrderService from './triggerOrderService.js';
import StockAnalysis from '../models/stockAnalysis.js';
import MonitoringHistory from '../models/monitoringHistory.js';
import AnalysisSession from '../models/analysisSession.js';
import MonitoringSubscription from '../models/monitoringSubscription.js';
import { messagingService } from './messaging/messaging.service.js';
import { User } from '../models/user.js';
import batchManager from './batchManager.js';

class AgendaMonitoringService {
    constructor() {
        this.agenda = null;
        this.isInitialized = false;
        this.activeJobs = new Map(); // Track active monitoring jobs
        this.activeBatches = new Map(); // Track active batch jobs
        this.batchPerformanceMetrics = new Map(); // Track batch performance
        this.useBatchMode = true; // Enable hybrid batch architecture
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

            // Define the batch monitoring job (hybrid architecture)
            this.agenda.define('check-triggers-batch', async (job) => {
                const { batchId, analysisIds } = job.attrs.data;
                await this.executeBatchMonitoringCheck(batchId, analysisIds);
            });
            
            // Define cleanup job for stale order processing locks
            this.agenda.define('cleanup-stale-locks', async (job) => {
                await this.cleanupStaleOrderProcessingLocks();
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
            
            // Schedule periodic cleanup of stale order processing locks (every 5 minutes)
            await this.agenda.every('5 minutes', 'cleanup-stale-locks', {}, {
                _id: 'stale-lock-cleanup',
                timezone: 'Asia/Kolkata'
            });

            this.isInitialized = true;
            console.log('🚀 Agenda monitoring service initialized successfully');

            // Initialize batch monitoring architecture
            if (this.useBatchMode) {
                // Schedule batch initialization after a short delay to ensure database is ready
                setTimeout(async () => {
                    try {
                        await this.initializeBatchMonitoring();
                    } catch (batchError) {
                        console.error('❌ Error initializing batch monitoring during startup:', batchError);
                    }
                }, 3000);
            }

            // Note: Job cleanup is now handled by MongoDB TTL indexes and Agenda's built-in cleanup mechanisms

        } catch (error) {
            console.error('❌ Failed to initialize Agenda monitoring service:', error);
            throw error;
        }
    }

    async executeMonitoringCheck(analysisId, strategyId) {
        const startTime = Date.now();
        let historyEntry = null;

        try {
            console.log(`\n${'='.repeat(100)}`);
            console.log(`🔍 [MONITORING CHECK] Starting execution`);
            console.log(`${'='.repeat(100)}`);
            console.log(`📋 Check Details:`);
            console.log(`   ├─ Analysis ID: ${analysisId}`);
            console.log(`   ├─ Strategy ID: ${strategyId}`);
            console.log(`   └─ Timestamp: ${new Date().toISOString()}`);
            console.log(`${'='.repeat(100)}\n`);

            // Get subscription to fetch all subscribed users
            console.log(`📂 [STEP 0/6] Fetching monitoring subscription...`);
            const subscription = await MonitoringSubscription.findOne({
                analysis_id: analysisId,
                strategy_id: strategyId
            });

            if (!subscription) {
                console.log(`❌ [STEP 0/6] FAILED - Subscription not found for ${analysisId}_${strategyId}`);
                await this.stopMonitoring(analysisId, strategyId);
                return;
            }

            const subscribedUserIds = subscription.subscribed_users.map(sub => sub.user_id);
            console.log(`✅ [STEP 0/6] Subscription loaded: ${subscribedUserIds.length} users subscribed`);
            console.log(`   └─ User IDs: ${subscribedUserIds.join(', ')}\n`);

            // Get analysis
            console.log(`📂 [STEP 1/6] Fetching analysis document from database...`);
            const analysis = await StockAnalysis.findById(analysisId);

            if (!analysis) {
                console.log(`❌ [STEP 1/6] FAILED - Analysis ${analysisId} not found in database`);

                // Create history entries for all subscribed users
                for (const userId of subscribedUserIds) {
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

                    // Send WhatsApp notification to each user
                    await this.sendMonitoringFailureNotification(
                        userId,
                        analysisId,
                        'Unknown',
                        'Analysis not found',
                        { error_message: 'Analysis document not found in database' }
                    );
                }

                // Update subscription status
                await subscription.stopMonitoring('invalidation');

                await this.stopMonitoring(analysisId, strategyId);
                return;
            }

            console.log(`✅ [STEP 1/6] Analysis loaded successfully`);
            console.log(`   ├─ Stock Symbol: ${analysis.stock_symbol}`);
            console.log(`   ├─ Instrument Key: ${analysis.instrument_key}`);
            console.log(`   ├─ Has Active Orders: ${analysis.hasActiveOrders ? analysis.hasActiveOrders() : 'N/A'}`);
            console.log(`   └─ Order Processing: ${analysis.order_processing ? 'TRUE' : 'FALSE'}\n`);

            // Initialize history entry for first user (we'll create one per user when conditions met)
            historyEntry = new MonitoringHistory({
                analysis_id: analysisId,
                strategy_id: strategyId,
                user_id: subscribedUserIds[0], // Use first user for initial history tracking
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

                // Send WhatsApp notification
                await this.sendMonitoringFailureNotification(
                    userId,
                    analysisId,
                    analysis.stock_symbol,
                    'Analysis expired',
                    { expires_at: analysis.expires_at }
                );

                await this.stopMonitoring(analysisId, strategyId);
                return;
            }

            // Check if orders are already placed or being processed
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
            
            // Check if another process is currently placing orders (race condition protection)
            if (analysis.order_processing) {
                const processingStarted = analysis.order_processing_started_at || new Date();
                const timeSinceStart = Date.now() - processingStarted.getTime();
                
                // If processing has been running for more than 5 minutes, consider it stale
                if (timeSinceStart > 5 * 60 * 1000) {
                    console.log(`⚠️ Stale order processing lock detected for ${analysisId}, clearing lock`);
                    
                    // Clear stale lock
                    const StockAnalysis = (await import('../models/stockAnalysis.js')).default;
                    await StockAnalysis.findByIdAndUpdate(analysisId, {
                        $unset: { 
                            order_processing: 1,
                            order_processing_started_at: 1
                        }
                    });
                } else {
                    console.log(`🔒 Order processing in progress for ${analysisId}, skipping this monitoring cycle`);
                    
                    historyEntry.status = 'order_processing';
                    historyEntry.reason = 'Another process is placing orders';
                    historyEntry.details.processing_info = {
                        started_at: processingStarted,
                        time_since_start_ms: timeSinceStart
                    };
                    historyEntry.monitoring_duration_ms = Date.now() - startTime;
                    await historyEntry.save();
                    
                    return; // Skip this monitoring cycle
                }
            }

            // Check if market is open using simple time-based logic
            console.log(`📈 [STEP 2/6] Checking market status...`);
            const now = new Date();
            const istTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
            const currentHours = istTime.getHours();
            const currentMinutes = istTime.getMinutes();
            const currentTimeInMinutes = currentHours * 60 + currentMinutes;
            const marketOpen = 9 * 60 + 15;  // 9:15 AM
            const marketClose = 15 * 60 + 30; // 3:30 PM
            const dayOfWeek = istTime.getDay(); // 0 = Sunday, 6 = Saturday

            const isMarketOpen = dayOfWeek >= 1 && dayOfWeek <= 5 &&
                                currentTimeInMinutes >= marketOpen &&
                                currentTimeInMinutes <= marketClose;

            console.log(`   ├─ Market Open: ${isMarketOpen ? 'YES ✅' : 'NO ❌'}`);
            console.log(`   ├─ Current Time (IST): ${istTime.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}`);
            console.log(`   ├─ Day of Week: ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dayOfWeek]}`);
            console.log(`   └─ Time: ${String(currentHours).padStart(2, '0')}:${String(currentMinutes).padStart(2, '0')}\n`);

            if (!isMarketOpen) {
                console.log(`⏸️ [STEP 2/6] SKIPPING - Market is closed, no trigger check needed`);
                console.log(`   └─ Will resume checking when market opens\n`);

                // Save market closed status to history
                historyEntry.status = 'market_closed';
                historyEntry.reason = 'Market is closed';
                historyEntry.addMarketStatus({
                    is_open: false,
                    reason: 'Market is closed',
                    next_open: null
                });
                historyEntry.monitoring_duration_ms = Date.now() - startTime;
                await historyEntry.save();

                return; // Don't check triggers when market is closed
            }

            console.log(`✅ [STEP 2/6] Market is OPEN - Proceeding with trigger check`);
            console.log(`${'='.repeat(100)}\n`);

            // Smart trigger checking - only evaluate relevant triggers based on current time
            console.log(`🎯 [STEP 3/6] Checking trigger conditions...`);
            const currentTime = new Date();
            console.log(`   ├─ Current Time (IST): ${currentTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
            console.log(`   ├─ Analysis ID: ${analysisId}`);
            console.log(`   └─ Strategy ID: ${strategyId}\n`);

            console.log(`⏳ Calling triggerOrderService.checkTriggerConditionsWithTiming()...\n`);
            const triggerResult = await triggerOrderService.checkTriggerConditionsWithTiming(
                analysis,
                currentTime
            );

            console.log(`📊 [STEP 3/6] Trigger check completed`);
            console.log(`   ├─ Conditions Met: ${triggerResult.triggersConditionsMet ? 'YES ✅' : 'NO ❌'}`);
            console.log(`   ├─ Reason: ${triggerResult.reason || 'N/A'}`);
            console.log(`   ├─ Current Price: ₹${triggerResult.data?.current_price || 'N/A'}`);
            console.log(`   ├─ Should Monitor: ${triggerResult.data?.should_monitor !== false ? 'YES' : 'NO'}`);
            console.log(`   └─ All Triggers Passed: ${triggerResult.data?.all_triggers_passed ? 'YES' : 'NO'}\n`);
            
            // Add market status to history entry
            historyEntry.addMarketStatus({
                is_open: true,
                reason: 'Market is open',
                next_open: null
            });
            
            if (triggerResult.triggersConditionsMet) {
                console.log(`${'='.repeat(100)}`);
                console.log(`🎯 [STEP 4/6] ✅✅✅ TRIGGERS MET! ✅✅✅`);
                console.log(`${'='.repeat(100)}`);
                console.log(`📋 Trigger Details:`);
                if (triggerResult.data?.triggers) {
                    triggerResult.data.triggers.forEach((t, idx) => {
                        console.log(`   ${idx + 1}. ${t.condition || t.id}: ${t.satisfied ? '✅ PASSED' : '❌ FAILED'}`);
                    });
                }
                console.log(`\n💰 Current Price: ₹${triggerResult.data?.current_price}`);
                console.log(`📱 Sending WhatsApp notification to user...`);
                console.log(`${'='.repeat(100)}\n`);
                
                historyEntry.status = 'conditions_met';
                historyEntry.reason = 'All trigger conditions satisfied';
                if (triggerResult.data) {
                    historyEntry.addTriggerDetails(
                        triggerResult.data.triggers || [],
                        triggerResult.data.current_price
                    );
                }
                
                // 🎯 NEW LOGIC: Save trigger snapshot and notify ALL subscribed users
                try {
                    // 1. Build trigger snapshot for audit trail
                    const triggerSnapshot = {
                        price: triggerResult.data?.current_price,
                        timestamp: new Date(),
                        timeframe_data: triggerResult.data?.timeframe_data || {},
                        evaluated_triggers: (triggerResult.data?.triggers || []).map(t => ({
                            trigger_type: t.type || t.id,
                            condition: t.condition || t.name,
                            met: t.satisfied || false,
                            actual_value: t.actual,
                            expected_value: t.expected
                        })),
                        market_conditions: {
                            trend: triggerResult.data?.trend || 'unknown',
                            volatility: triggerResult.data?.volatility || 'unknown',
                            volume_profile: triggerResult.data?.volume_profile || 'unknown'
                        }
                    };

                    // 2. Save trigger snapshot to subscription
                    await subscription.markConditionsMet(triggerSnapshot);
                    console.log(`📸 Trigger snapshot saved to subscription`);

                    // 3. Send WhatsApp notifications to ALL subscribed users
                    let successfulNotifications = 0;
                    let failedNotifications = 0;

                    for (const userSubscription of subscription.subscribed_users) {
                        try {
                            const userId = userSubscription.user_id;
                            const user = await User.findById(userId);

                            if (!user || !user.mobile_number) {
                                console.log(`⚠️ User ${userId} not found or missing mobile number - skipping notification`);
                                failedNotifications++;

                                // Create history entry
                                await MonitoringHistory.create({
                                    analysis_id: analysisId,
                                    strategy_id: strategyId,
                                    user_id: userId,
                                    stock_symbol: analysis.stock_symbol,
                                    status: 'error',
                                    reason: 'User mobile number not found',
                                    details: { error_message: 'Cannot send WhatsApp notification - user mobile number missing' },
                                    monitoring_duration_ms: Date.now() - startTime
                                });
                                continue;
                            }

                            // Check if user wants WhatsApp notifications
                            if (!userSubscription.notification_preferences?.whatsapp) {
                                console.log(`🔕 User ${userId} has disabled WhatsApp notifications - skipping`);
                                continue;
                            }

                            // Prepare monitoring conditions met alert data
                            const alertData = {
                                userName: user.name || user.email?.split('@')[0] || 'logdhanuser',
                                stockSymbol: analysis.stock_symbol || analysis.stock_name,
                                instrumentKey: analysis.instrument_key || analysis.stock_symbol || ''
                            };

                            // Send WhatsApp monitoring alert
                            const whatsappResult = await messagingService.sendMonitoringConditionsMet(
                                user.mobile_number,
                                alertData
                            );

                            console.log(`📱 Notification sent to user ${userId} (${user.name})`);
                            successfulNotifications++;

                            // Create success history entry for this user
                            await MonitoringHistory.create({
                                analysis_id: analysisId,
                                strategy_id: strategyId,
                                user_id: userId,
                                stock_symbol: analysis.stock_symbol,
                                status: 'conditions_met',
                                reason: 'Monitoring conditions met alert sent successfully',
                                details: {
                                    whatsapp_result: whatsappResult,
                                    alert_data: alertData,
                                    current_price: triggerResult.data?.current_price,
                                    triggers_satisfied: triggerResult.data?.triggers?.map(t => t.condition || t.name)
                                },
                                monitoring_duration_ms: Date.now() - startTime
                            });

                        } catch (userNotificationError) {
                            console.error(`❌ Failed to notify user ${userSubscription.user_id}:`, userNotificationError);
                            failedNotifications++;

                            // Create error history entry
                            await MonitoringHistory.create({
                                analysis_id: analysisId,
                                strategy_id: strategyId,
                                user_id: userSubscription.user_id,
                                stock_symbol: analysis.stock_symbol,
                                status: 'error',
                                reason: 'Notification failed',
                                details: { error_message: userNotificationError.message },
                                monitoring_duration_ms: Date.now() - startTime
                            });
                        }
                    }

                    // 4. Mark notification as sent in subscription
                    await subscription.markNotificationSent();

                    console.log(`\n${'='.repeat(100)}`);
                    console.log(`📊 Notification Summary:`);
                    console.log(`   ├─ Total Subscribed Users: ${subscription.subscribed_users.length}`);
                    console.log(`   ├─ Successful Notifications: ${successfulNotifications}`);
                    console.log(`   ├─ Failed Notifications: ${failedNotifications}`);
                    console.log(`   └─ Timestamp: ${new Date().toISOString()}`);
                    console.log(`${'='.repeat(100)}\n`);

                    // 5. 🛑 STOP JOB IMMEDIATELY - Conditions met, no need to continue monitoring
                    console.log(`🛑 Stopping monitoring job ${analysisId}_${strategyId} - conditions met`);
                    await subscription.stopMonitoring('conditions_met');
                    await this.stopMonitoring(analysisId, strategyId);

                    console.log(`✅ Monitoring stopped successfully after notifying all users`);
                    return; // Exit immediately

                } catch (whatsappError) {
                    console.error(`❌ Error in multi-user notification process for ${analysisId}_${strategyId}:`, whatsappError);

                    // Create error history for first user
                    historyEntry.status = 'error';
                    historyEntry.reason = 'Multi-user notification failed';
                    historyEntry.details.error_message = whatsappError.message;
                    historyEntry.monitoring_duration_ms = Date.now() - startTime;
                    await historyEntry.save();
                }
            } else {
                // Check for specific failure reasons that require stopping monitoring
                console.log(`${'='.repeat(100)}`);
                console.log(`⏳ [STEP 4/6] ❌ TRIGGERS NOT MET ❌`);
                console.log(`${'='.repeat(100)}`);
                console.log(`📋 Failure Analysis:`);
                console.log(`   ├─ Reason: ${triggerResult.reason || 'Conditions not satisfied'}`);
                console.log(`   ├─ Message: ${triggerResult.message || 'N/A'}`);
                console.log(`   ├─ Current Price: ₹${triggerResult.data?.current_price || 'N/A'}`);
                console.log(`   └─ Should Continue Monitoring: ${triggerResult.data?.should_monitor !== false ? 'YES ✅' : 'NO ❌'}\n`);

                if (triggerResult.data?.failed_triggers && triggerResult.data.failed_triggers.length > 0) {
                    console.log(`📊 Failed Triggers:`);
                    triggerResult.data.failed_triggers.forEach((t, idx) => {
                        console.log(`   ${idx + 1}. ${t.condition || t.id}`);
                        console.log(`      ├─ Expected: ${t.expected || 'N/A'}`);
                        console.log(`      ├─ Actual: ${t.actual || 'N/A'}`);
                        console.log(`      └─ Status: ${t.satisfied ? '✅' : '❌'}`);
                    });
                    console.log(``);
                }

                if (triggerResult.data?.triggers) {
                    console.log(`📋 All Trigger States:`);
                    triggerResult.data.triggers.forEach((t, idx) => {
                        console.log(`   ${idx + 1}. ${t.condition || t.id}: ${t.satisfied ? '✅ PASSED' : '❌ FAILED'}`);
                        if (t.left_value !== undefined && t.right_value !== undefined) {
                            console.log(`      └─ ${t.left_value} vs ${t.right_value}`);
                        }
                    });
                    console.log(``);
                }

                const shouldStopMonitoring = triggerResult.data?.should_monitor === false;
                console.log(`🔍 Should Stop Monitoring: ${shouldStopMonitoring ? 'YES (stopping)' : 'NO (continuing)'}\n`);
                console.log(`${'='.repeat(100)}\n`);

                if (shouldStopMonitoring) {
                    // Handle different failure types
                    if (triggerResult.reason === 'invalidation_triggered' || triggerResult.reason === 'position_closure_required') {
                        console.log(`❌ [CRITICAL] Invalidation triggered - STOPPING MONITORING`);
                        console.log(`   ├─ Reason: ${triggerResult.reason}`);
                        console.log(`   ├─ Message: ${triggerResult.message}`);
                        console.log(`   └─ Invalidation: ${JSON.stringify(triggerResult.data?.invalidation || {})}\n`);

                        historyEntry.status = 'stopped';
                        historyEntry.reason = 'Invalidation triggered';
                        historyEntry.details.invalidation_details = triggerResult.data?.invalidation || {};
                        historyEntry.monitoring_duration_ms = Date.now() - startTime;
                        await historyEntry.save();

                        // Send WhatsApp notification
                        await this.sendMonitoringFailureNotification(
                            userId,
                            analysisId,
                            analysis.stock_symbol,
                            'Pre-entry invalidation triggered',
                            {
                                invalidation_details: triggerResult.message || 'Price moved against the setup',
                                current_price: triggerResult.data?.current_price
                            }
                        );

                        await this.stopMonitoring(analysisId, strategyId);
                        return;

                    } else if (triggerResult.data?.expired_trigger) {
                        console.log(`⏳ [CRITICAL] Trigger EXPIRED - STOPPING MONITORING`);
                        console.log(`   ├─ Expired Trigger: ${triggerResult.data.expired_trigger}`);
                        console.log(`   ├─ Bars Checked: ${triggerResult.data.session?.total_bars || 'N/A'}`);
                        console.log(`   └─ Reason: Entry conditions did not occur within timeframe\n`);

                        historyEntry.status = 'stopped';
                        historyEntry.reason = 'Trigger expired';
                        historyEntry.details.expired_trigger = triggerResult.data.expired_trigger;
                        historyEntry.monitoring_duration_ms = Date.now() - startTime;
                        await historyEntry.save();

                        // Send WhatsApp notification
                        await this.sendMonitoringFailureNotification(
                            userId,
                            analysisId,
                            analysis.stock_symbol,
                            'Entry trigger expired',
                            {
                                bars_checked: triggerResult.data.session?.total_bars || 'N/A',
                                trigger_details: triggerResult.data.expired_trigger
                            }
                        );

                        await this.stopMonitoring(analysisId, strategyId);
                        return;
                    }
                }

                // Normal case: triggers not yet met, continue monitoring
                console.log(`✅ [STEP 5/6] Continuing monitoring - conditions not yet satisfied`);
                console.log(`   ├─ Status: Monitoring will continue`);
                console.log(`   ├─ Next Check: As per schedule`);
                console.log(`   └─ Action: Waiting for trigger conditions\n`);

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

    /**
     * NEW HYBRID BATCH ARCHITECTURE
     * Execute monitoring check for multiple analyses in parallel
     * Each analysis processes ALL strategies (S1, S2, S3, S4...)
     */
    async executeBatchMonitoringCheck(batchId, analysisIds) {
        const batchStartTime = Date.now();
        
        try {
            console.log(`\n${'='.repeat(120)}`);
            console.log(`🚀 [BATCH MONITORING] Starting batch execution - ${batchId}`);
            console.log(`${'='.repeat(120)}`);
            console.log(`📋 Batch Details:`);
            console.log(`   ├─ Batch ID: ${batchId}`);
            console.log(`   ├─ Analyses Count: ${analysisIds.length}`);
            console.log(`   ├─ Started At: ${new Date().toISOString()}`);
            console.log(`   └─ Analyses: ${analysisIds.map(id => id.slice(-8)).join(', ')}`);
            console.log(`${'='.repeat(120)}\n`);

            // Track batch performance
            const batchMetrics = {
                batchId,
                analysisIds,
                startTime: batchStartTime,
                successCount: 0,
                errorCount: 0,
                totalStrategiesProcessed: 0,
                errors: []
            };

            // Process all analyses in parallel with Promise.allSettled for fault isolation
            const analysisPromises = analysisIds.map(async (analysisId) => {
                try {
                    const result = await this.processAnalysisAllStrategies(analysisId, batchId);
                    batchMetrics.successCount++;
                    batchMetrics.totalStrategiesProcessed += result.strategiesProcessed;
                    return { analysisId, success: true, result };
                } catch (error) {
                    batchMetrics.errorCount++;
                    batchMetrics.errors.push({ analysisId, error: error.message });
                    console.error(`❌ [BATCH ${batchId}] Error processing analysis ${analysisId}:`, error.message);
                    return { analysisId, success: false, error: error.message };
                }
            });

            const results = await Promise.allSettled(analysisPromises);
            
            // Calculate batch performance metrics
            const processingTime = Date.now() - batchStartTime;
            const successRate = (batchMetrics.successCount / analysisIds.length) * 100;
            
            console.log(`\n${'='.repeat(120)}`);
            console.log(`✅ [BATCH MONITORING] Batch ${batchId} completed`);
            console.log(`${'='.repeat(120)}`);
            console.log(`📊 Batch Results:`);
            console.log(`   ├─ Processing Time: ${(processingTime / 1000).toFixed(2)}s`);
            console.log(`   ├─ Analyses Processed: ${analysisIds.length}`);
            console.log(`   ├─ Success Count: ${batchMetrics.successCount}`);
            console.log(`   ├─ Error Count: ${batchMetrics.errorCount}`);
            console.log(`   ├─ Success Rate: ${successRate.toFixed(1)}%`);
            console.log(`   ├─ Total Strategies: ${batchMetrics.totalStrategiesProcessed}`);
            console.log(`   └─ Avg Time per Analysis: ${(processingTime / analysisIds.length).toFixed(0)}ms`);
            
            if (batchMetrics.errors.length > 0) {
                console.log(`\n⚠️ [BATCH ${batchId}] Errors encountered:`);
                batchMetrics.errors.forEach((err, idx) => {
                    console.log(`   ${idx + 1}. Analysis ${err.analysisId.slice(-8)}: ${err.error}`);
                });
            }
            console.log(`${'='.repeat(120)}\n`);

            // Store batch performance metrics for optimization
            this.batchPerformanceMetrics.set(batchId, {
                ...batchMetrics,
                processingTime,
                successRate,
                completedAt: new Date()
            });

            // Update batch manager configuration based on performance
            const avgProcessingTime = processingTime;
            const errorRate = batchMetrics.errorCount / analysisIds.length;
            batchManager.updateBatchConfiguration({
                avgProcessingTime,
                errorRate,
                memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024 // MB
            });

            return {
                success: true,
                batchId,
                processingTime,
                analysesProcessed: analysisIds.length,
                successCount: batchMetrics.successCount,
                errorCount: batchMetrics.errorCount,
                strategiesProcessed: batchMetrics.totalStrategiesProcessed
            };

        } catch (error) {
            console.error(`❌ [BATCH ${batchId}] Critical batch error:`, error);
            return {
                success: false,
                batchId,
                error: error.message,
                processingTime: Date.now() - batchStartTime
            };
        }
    }

    /**
     * Process a single analysis with ALL its strategies in parallel
     * This ensures we handle S1, S2, S3, S4... not just S1
     */
    async processAnalysisAllStrategies(analysisId, batchId = 'unknown') {
        const analysisStartTime = Date.now();
        
        try {
            console.log(`🔍 [BATCH ${batchId}] Processing analysis ${analysisId.slice(-8)} with ALL strategies...`);

            // Get analysis with all strategies
            const analysis = await StockAnalysis.findById(analysisId);
            if (!analysis) {
                console.log(`❌ [BATCH ${batchId}] Analysis ${analysisId.slice(-8)} not found - skipping`);
                return { strategiesProcessed: 0 };
            }

            const strategies = analysis.analysis_data?.strategies || [];
            if (strategies.length === 0) {
                console.log(`⚠️ [BATCH ${batchId}] Analysis ${analysisId.slice(-8)} (${analysis.stock_symbol}) has no strategies - skipping`);
                return { strategiesProcessed: 0 };
            }

            console.log(`📈 [BATCH ${batchId}] ${analysis.stock_symbol} (${analysisId.slice(-8)}): Processing ${strategies.length} strategies...`);

            // Process ALL strategies in parallel (not just S1!)
            const strategyPromises = strategies.map(async (strategy) => {
                try {
                    // Check if this strategy has active monitoring subscriptions
                    const subscription = await MonitoringSubscription.findOne({
                        analysis_id: analysisId,
                        strategy_id: strategy.id,
                        monitoring_status: 'active',
                        expires_at: { $gt: new Date() }
                    });

                    if (!subscription) {
                        console.log(`🔕 [BATCH ${batchId}] No active subscription for ${analysis.stock_symbol} strategy ${strategy.id} - skipping`);
                        return { strategy: strategy.id, skipped: true };
                    }

                    // console.log(`🎯 [BATCH ${batchId}] Checking ${analysis.stock_symbol} strategy ${strategy.id} (${subscription.subscribed_users.length} users subscribed)`);
                    
                    // Execute the actual monitoring check
                    await this.executeMonitoringCheck(analysisId, strategy.id);
                    
                    return { strategy: strategy.id, success: true };
                } catch (strategyError) {
                    console.error(`❌ [BATCH ${batchId}] Error processing ${analysis.stock_symbol} strategy ${strategy.id}:`, strategyError.message);
                    return { strategy: strategy.id, success: false, error: strategyError.message };
                }
            });

            const strategyResults = await Promise.allSettled(strategyPromises);
            
            const processedResults = strategyResults.map(result => 
                result.status === 'fulfilled' ? result.value : { success: false, error: result.reason }
            );

            const successfulStrategies = processedResults.filter(r => r.success).length;
            const skippedStrategies = processedResults.filter(r => r.skipped).length;
            const failedStrategies = processedResults.filter(r => !r.success && !r.skipped).length;

            const processingTime = Date.now() - analysisStartTime;
            console.log(`✅ [BATCH ${batchId}] ${analysis.stock_symbol} completed: ${successfulStrategies} successful, ${skippedStrategies} skipped, ${failedStrategies} failed (${processingTime}ms)`);

            return {
                analysisId,
                stock_symbol: analysis.stock_symbol,
                strategiesProcessed: strategies.length,
                successfulStrategies,
                skippedStrategies,
                failedStrategies,
                processingTime
            };

        } catch (error) {
            console.error(`❌ [BATCH ${batchId}] Error processing analysis ${analysisId}:`, error);
            throw error;
        }
    }

    /**
     * Initialize and manage batch monitoring jobs
     * Creates optimal batches and schedules them with Agenda
     */
    async initializeBatchMonitoring() {
        try {
            if (!this.useBatchMode) {
                console.log('📝 [BATCH MONITORING] Batch mode disabled - using individual jobs');
                return;
            }

            console.log('🚀 [BATCH MONITORING] Initializing hybrid batch architecture...');

            // Get optimal batches from BatchManager
            const batches = await batchManager.createOptimalBatches();
            
            if (batches.length === 0) {
                console.log('📭 [BATCH MONITORING] No active subscriptions - no batches to create');
                return;
            }

            // Cancel any existing batch jobs
            await this.agenda.cancel({ name: 'check-triggers-batch' });
            console.log('🧹 [BATCH MONITORING] Cancelled existing batch jobs');

            // Create new batch jobs
            let createdJobs = 0;
            for (const batch of batches) {
                try {
                    // Determine cron expression based on fastest frequency needed
                    // DEFAULT: Every 15 minutes for production monitoring
                    let cronExpression;
                    if (batch.max_frequency_seconds <= 60) {
                        cronExpression = '*/15 * * * *'; // Every 15 minutes (changed from 1 minute)
                    } else if (batch.max_frequency_seconds <= 300) {
                        cronExpression = '*/15 * * * *'; // Every 15 minutes 
                    } else if (batch.max_frequency_seconds <= 900) {
                        cronExpression = '*/15 * * * *'; // Every 15 minutes
                    } else {
                        cronExpression = '*/30 * * * *'; // Every 30 minutes for slower frequencies
                    }

                    console.log(`📅 [BATCH MONITORING] Creating batch job ${batch.batchId}: ${batch.analysisIds.length} analyses, ${cronExpression}`);

                    // Schedule the batch job
                    await this.agenda.every(cronExpression, 'check-triggers-batch', {
                        batchId: batch.batchId,
                        analysisIds: batch.analysisIds,
                        createdAt: new Date()
                    }, {
                        _id: `batch-job-${batch.batchId}`,
                        timezone: 'Asia/Kolkata'
                    });

                    // Track in local map
                    this.activeBatches.set(batch.batchId, {
                        ...batch,
                        jobId: `batch-job-${batch.batchId}`,
                        status: 'active',
                        createdAt: new Date()
                    });

                    createdJobs++;
                } catch (jobError) {
                    console.error(`❌ [BATCH MONITORING] Error creating batch job ${batch.batchId}:`, jobError);
                }
            }

            console.log(`✅ [BATCH MONITORING] Successfully created ${createdJobs} batch jobs`);
            console.log(`📊 [BATCH MONITORING] Total analyses covered: ${batches.reduce((sum, b) => sum + b.analysisIds.length, 0)}`);
            console.log(`📊 [BATCH MONITORING] Estimated strategies: ${batches.reduce((sum, b) => sum + b.estimated_total_strategies, 0)}`);
            
            return {
                success: true,
                batchesCreated: createdJobs,
                totalAnalysesCovered: batches.reduce((sum, b) => sum + b.analysisIds.length, 0)
            };

        } catch (error) {
            console.error('❌ [BATCH MONITORING] Error initializing batch monitoring:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Refresh batch configuration - call this when monitoring subscriptions change
     */
    async refreshBatchConfiguration() {
        console.log('🔄 [BATCH MONITORING] Refreshing batch configuration...');
        return await this.initializeBatchMonitoring();
    }

    /**
     * Get batch monitoring statistics and performance metrics
     */
    async getBatchMonitoringStats() {
        try {
            const batchStats = await batchManager.getBatchStatistics();
            const performanceMetrics = Array.from(this.batchPerformanceMetrics.values());
            
            return {
                batch_mode_enabled: this.useBatchMode,
                batch_statistics: batchStats,
                active_batches: this.activeBatches.size,
                performance_metrics: performanceMetrics.slice(-10), // Last 10 batch executions
                performance_summary: {
                    avg_processing_time: performanceMetrics.length > 0 ? 
                        Math.round(performanceMetrics.reduce((sum, m) => sum + m.processingTime, 0) / performanceMetrics.length) : 0,
                    avg_success_rate: performanceMetrics.length > 0 ? 
                        Math.round(performanceMetrics.reduce((sum, m) => sum + m.successRate, 0) / performanceMetrics.length) : 0,
                    total_batches_executed: performanceMetrics.length
                }
            };
        } catch (error) {
            console.error('❌ [BATCH MONITORING] Error getting batch stats:', error);
            return {
                batch_mode_enabled: this.useBatchMode,
                error: error.message
            };
        }
    }

    /**
     * Switch between batch mode and individual job mode
     */
    async setBatchMode(enabled) {
        try {
            console.log(`🔄 [BATCH MONITORING] Switching batch mode: ${enabled ? 'ON' : 'OFF'}`);
            
            if (enabled && !this.useBatchMode) {
                // Switching to batch mode
                this.useBatchMode = true;
                
                // Cancel existing individual jobs
                await this.agenda.cancel({ name: 'check-triggers' });
                console.log('🧹 [BATCH MONITORING] Cancelled individual monitoring jobs');
                
                // Initialize batch monitoring
                await this.initializeBatchMonitoring();
                
            } else if (!enabled && this.useBatchMode) {
                // Switching to individual mode
                this.useBatchMode = false;
                
                // Cancel batch jobs
                await this.agenda.cancel({ name: 'check-triggers-batch' });
                console.log('🧹 [BATCH MONITORING] Cancelled batch monitoring jobs');
                
                this.activeBatches.clear();
                
                // Note: Individual jobs will be recreated when users start new monitoring
            }
            
            return {
                success: true,
                batch_mode_enabled: this.useBatchMode,
                message: `Batch mode ${enabled ? 'enabled' : 'disabled'} successfully`
            };
            
        } catch (error) {
            console.error(`❌ [BATCH MONITORING] Error switching batch mode:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async startMonitoring(analysisId, strategyId, userId, frequency = { seconds: 900 }, stockSymbol = null, instrumentKey = null) {
        try {
            if (!this.isInitialized) {
                await this.initialize();
            }

            // Force batch mode - no more individual jobs
            if (!this.useBatchMode) {
                console.log(`🔄 [MONITORING] Enabling batch mode for optimal performance`);
                this.useBatchMode = true;
            }

            const jobId = `monitor_${analysisId}_${strategyId}`;

            console.log(`🚀 [BATCH MODE] Starting monitoring for ${jobId} - will be processed in optimal batches every 15 minutes`);
            console.log(`📅 OPTIMAL: Start monitoring after 4:30 PM when fresh analysis with EOD data is available`);

            // Check if user can start monitoring (not already met conditions recently)
            const canStart = await MonitoringSubscription.canUserStartMonitoring(analysisId, strategyId);
            if (!canStart.can_start) {
                console.log(`❌ Cannot start monitoring: ${canStart.reason}`);
                return {
                    success: false,
                    message: canStart.reason,
                    conditions_met_at: canStart.conditions_met_at
                };
            }

            // Fetch analysis to get stock details if not provided
            if (!stockSymbol || !instrumentKey) {
                const analysis = await StockAnalysis.findById(analysisId);
                if (!analysis) {
                    return {
                        success: false,
                        message: 'Analysis not found'
                    };
                }
                stockSymbol = analysis.stock_symbol;
                instrumentKey = analysis.instrument_key;
            }

            // Find or create subscription
            let subscription = await MonitoringSubscription.findOrCreateSubscription(
                analysisId,
                strategyId,
                userId,
                stockSymbol,
                instrumentKey,
                jobId,
                {
                    frequency_seconds: frequency.seconds,
                    notification_preferences: {
                        whatsapp: true,
                        email: false
                    }
                }
            );

            console.log(`✅ Subscription ${subscription._id} ${subscription.subscribed_users.length === 1 ? 'created' : 'updated'}`);
            console.log(`   ├─ Subscribed Users: ${subscription.subscribed_users.length}`);
            console.log(`   └─ Expires At: ${subscription.expires_at.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}`);

            // 🆕 BATCH ARCHITECTURE: No individual jobs - everything goes through batch processing
            console.log(`📦 [BATCH MODE] Subscription created - monitoring will be handled by batch jobs every 15 minutes`);

            // 🆕 BATCH ARCHITECTURE: Trigger batch refresh when new monitoring starts
            if (this.useBatchMode) {
                // Schedule batch refresh in background (non-blocking)
                setTimeout(async () => {
                    try {
                        console.log(`🔄 [BATCH] Refreshing batches due to new monitoring: ${jobId}`);
                        await this.refreshBatchConfiguration();
                    } catch (batchError) {
                        console.error('❌ [BATCH] Error refreshing batch configuration:', batchError);
                    }
                }, 5000); // 5-second delay to allow subscription to settle
            }

            return {
                success: true,
                jobId: `batch-processing-${analysisId}_${strategyId}`,
                frequency: { seconds: 900 }, // 15 minutes
                message: `🎯 Smart batch monitoring activated for strategy ${strategyId}! We'll check every 15 minutes for optimal performance.`,
                subscription_id: subscription._id,
                subscribed_users_count: subscription.subscribed_users.length,
                batch_mode: true,
                monitoring_frequency: '15 minutes'
            };

        } catch (error) {
            console.error(`❌ Error starting monitoring for ${analysisId}_${strategyId}:`, error);
            return {
                success: false,
                message: `Failed to start monitoring: ${error.message}`
            };
        }
    }

    async stopMonitoring(analysisId, strategyId = null, userId = null) {
        try {
            console.log(`🛑 Stopping monitoring for analysis ${analysisId}${strategyId ? `, strategy ${strategyId}` : ' (all strategies)'}${userId ? `, user ${userId}` : ''}`);

            let cancelQuery = { name: 'check-triggers', 'data.analysisId': analysisId };

            if (strategyId) {
                cancelQuery['data.strategyId'] = strategyId;
            }

            // CRITICAL: Update MonitoringSubscription status FIRST (source of truth)
            if (strategyId) {
                const subscription = await MonitoringSubscription.findOne({
                    analysis_id: analysisId,
                    strategy_id: strategyId
                });

                if (subscription) {
                    if (userId) {
                        // Remove specific user from subscription
                        const result = await subscription.removeUser(userId);
                        if (result === null) {
                            console.log(`🗑️ No users left - subscription document deleted for ${analysisId}_${strategyId}`);
                        } else {
                            console.log(`✅ Removed user ${userId} from subscription ${subscription._id}`);
                        }
                    } else {
                        // Stop monitoring for all users - delete the subscription entirely
                        console.log(`🗑️ Deleting subscription document ${subscription._id} for all users`);
                        await subscription.deleteOne();
                        console.log(`✅ Subscription document deleted for ${analysisId}_${strategyId}`);
                    }
                }
            } else {
                // Stop all strategies for this analysis
                const subscriptions = await MonitoringSubscription.find({
                    analysis_id: analysisId
                });

                for (const subscription of subscriptions) {
                    if (userId) {
                        const result = await subscription.removeUser(userId);
                        if (result === null) {
                            console.log(`🗑️ No users left - subscription document deleted for ${subscription._id}`);
                        }
                    } else {
                        console.log(`🗑️ Deleting subscription document ${subscription._id} for all users`);
                        await subscription.deleteOne();
                    }
                }

                console.log(`✅ Processed ${subscriptions.length} subscription(s) - removed/deleted as appropriate`);
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

            // CRITICAL FIX #2: Clean up trigger engine state (bar counters, history, etc.)
            // Without this, restarting monitoring will have wrong bar counts
            const advancedTriggerEngine = (await import('./advancedTriggerEngine.js')).default;
            advancedTriggerEngine.cleanupSession(analysisId, strategyId);

            // CRITICAL FIX #3: Clean up orphaned analysis_session records in database
            // Get userId from job data to clean up sessions
            const jobs = await this.agenda.jobs(cancelQuery);
            if (jobs.length > 0 && jobs[0].attrs.data.userId) {
                const userIdFromJob = jobs[0].attrs.data.userId;
                await this.cleanupAnalysisSessionRecords(analysisId, userIdFromJob);
            }

            console.log(`✅ Stopped ${cancelledJobs} monitoring job(s) for ${analysisId}${strategyId ? `_${strategyId}` : ''}`);

            return {
                success: true,
                message: strategyId
                    ? `Monitoring stopped for strategy ${strategyId}`
                    : `Monitoring stopped for all strategies in analysis ${analysisId}`,
                cancelledJobs
            };

        } catch (error) {
            console.error(`❌ Error stopping monitoring for ${analysisId}_${strategyId}:`, error);
            return {
                success: false,
                message: `Failed to stop monitoring: ${error.message}`
            };
        }
    }

    /**
     * Map MonitoringSubscription status to Android app state
     * Backend status → App state mapping:
     * - 'active' → 'active' (AI is watching, monitoring ongoing)
     * - 'conditions_met' → 'finished' (Alert sent, entry conditions met)
     * - 'expired' → 'finished' (Monitoring expired at 3:30 PM without conditions being met)
     * - 'invalidated' → 'finished' (Setup invalidated)
     * - 'cancelled' → 'finished' (User stopped monitoring)
     */
    mapSubscriptionStateToAppState(subscriptionStatus, isExpired = false) {
        const stateMap = {
            'active': 'active',
            'conditions_met': 'finished',  // Conditions were met, alert sent
            'expired': 'finished',         // Time expired without meeting conditions
            'invalidated': 'finished',     // Setup invalidated
            'cancelled': 'finished'        // User cancelled
        };

        return stateMap[subscriptionStatus] || 'finished';
    }

    async getMonitoringStatus(analysisId, strategyId = null, userId = null) {
        try {
            console.log(`📊 Getting monitoring status for analysis ${analysisId}${strategyId ? `, strategy ${strategyId}` : ''}, user ${userId}`);

            if (strategyId) {
                // Check MonitoringSubscription (source of truth for multi-user monitoring)
                const subscription = await MonitoringSubscription.findOne({
                    analysis_id: analysisId,
                    strategy_id: strategyId
                });

                if (!subscription) {
                    return {
                        isMonitoring: false,
                        state: 'inactive',
                        message: 'No monitoring subscription found',
                        jobId: null,
                        startedAt: null,
                        isPaused: false,
                        pausedReason: null
                    };
                }

                // Check if user is subscribed (if userId provided)
                let isUserSubscribed = true;
                let userSubscriptionData = null;
                if (userId) {
                    userSubscriptionData = subscription.subscribed_users.find(
                        sub => sub.user_id.toString() === userId.toString()
                    );
                    isUserSubscribed = !!userSubscriptionData;
                }

                // Check if subscription is actively monitoring
                const isExpired = subscription.expires_at <= new Date();
                const isActive = subscription.monitoring_status === 'active' && !isExpired;

                // Check if Agenda job is paused
                let isPaused = false;
                let pausedReason = null;
                if (isActive) {
                    try {
                        const jobs = await this.agenda.jobs({
                            name: 'check-triggers',
                            'data.analysisId': analysisId,
                            'data.strategyId': strategyId
                        });
                        if (jobs.length > 0) {
                            const job = jobs[0];
                            isPaused = job.attrs.disabled === true;
                            if (isPaused) {
                                // Check local tracking for pause reason
                                const localJob = this.activeJobs.get(`${analysisId}_${strategyId}`);
                                pausedReason = localJob?.pauseReason || 'manual';
                            }
                        }
                    } catch (jobError) {
                        console.error('Error checking job pause status:', jobError);
                    }
                }

                // Map backend status to app state
                const appState = this.mapSubscriptionStateToAppState(
                    subscription.monitoring_status,
                    isExpired
                );

                // Build appropriate message based on state
                let message = '';
                if (subscription.monitoring_status === 'conditions_met') {
                    message = '✅ Entry conditions met! Alert sent.';
                } else if (subscription.monitoring_status === 'expired' || isExpired) {
                    message = '⏰ Monitoring expired at 3:30 PM';
                } else if (subscription.monitoring_status === 'cancelled') {
                    message = 'Monitoring stopped by user';
                } else if (subscription.monitoring_status === 'invalidated') {
                    message = 'Setup invalidated';
                } else if (isPaused) {
                    message = `⏸️ Monitoring paused (${pausedReason})`;
                } else if (isActive && isUserSubscribed) {
                    message = '👁️ AI is watching the market';
                } else if (isActive && !isUserSubscribed) {
                    message = 'User is not subscribed to this monitoring';
                } else {
                    message = `Monitoring is ${subscription.monitoring_status}`;
                }

                return {
                    isMonitoring: isActive && isUserSubscribed && !isPaused,
                    state: appState,
                    subscription_id: subscription._id,
                    subscribed_users_count: subscription.subscribed_users.length,
                    is_user_subscribed: isUserSubscribed,
                    conditions_met_at: subscription.conditions_met_at,
                    notification_sent_at: subscription.notification_sent_at,
                    expires_at: subscription.expires_at,
                    jobId: subscription.job_id,
                    startedAt: userSubscriptionData?.subscribed_at || subscription.createdAt,
                    isPaused: isPaused,
                    pausedReason: pausedReason,
                    message
                };

            } else {
                // Check analysis-level (all strategies)
                const subscriptions = await MonitoringSubscription.find({
                    analysis_id: analysisId
                });

                if (!subscriptions || subscriptions.length === 0) {
                    return {
                        isMonitoring: false,
                        state: 'inactive',
                        activeStrategies: 0,
                        message: 'No monitoring subscriptions found'
                    };
                }

                // Filter active subscriptions
                const now = new Date();
                const activeSubscriptions = subscriptions.filter(
                    sub => sub.monitoring_status === 'active' && sub.expires_at > now
                );

                // Check user subscription if userId provided
                let userActiveCount = 0;
                if (userId) {
                    userActiveCount = activeSubscriptions.filter(sub =>
                        sub.subscribed_users.some(u => u.user_id.toString() === userId.toString())
                    ).length;
                }

                return {
                    isMonitoring: activeSubscriptions.length > 0,
                    state: activeSubscriptions.length > 0 ? 'active' : 'inactive',
                    activeStrategies: activeSubscriptions.length,
                    user_active_subscriptions: userId ? userActiveCount : null,
                    subscriptions: subscriptions.map(sub => {
                        const isExpired = sub.expires_at <= now;
                        const isActive = sub.monitoring_status === 'active' && !isExpired;

                        return {
                            subscription_id: sub._id,
                            strategy_id: sub.strategy_id,
                            status: sub.monitoring_status,
                            state: this.mapSubscriptionStateToAppState(sub.monitoring_status, isExpired),
                            isMonitoring: isActive,
                            subscribed_users_count: sub.subscribed_users.length,
                            conditions_met_at: sub.conditions_met_at,
                            expires_at: sub.expires_at,
                            jobId: sub.job_id
                        };
                    })
                };
            }

        } catch (error) {
            console.error(`❌ Error getting monitoring status for ${analysisId}_${strategyId}:`, error);
            return {
                isMonitoring: false,
                state: 'error',
                message: `Error checking status: ${error.message}`,
                jobId: null,
                startedAt: null,
                isPaused: false,
                pausedReason: null
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
     * Clean up stale order processing locks
     */
    async cleanupStaleOrderProcessingLocks() {
        try {
            console.log('🧹 Running cleanup of stale order processing locks...');
            
            const StockAnalysis = (await import('../models/stockAnalysis.js')).default;
            const result = await StockAnalysis.cleanupStaleOrderProcessingLocks();
            
            if (result && result.modifiedCount > 0) {
                console.log(`✅ Cleaned up ${result.modifiedCount} stale order processing locks`);
            }
            
            return result;
        } catch (error) {
            console.error('❌ Error in stale lock cleanup job:', error);
            return null;
        }
    }

    /**
     * Clean up orphaned analysis_session records when analysis expires/deletes
     */
    async cleanupAnalysisSessionRecords(analysisId, userId) {
        try {
            console.log(`🧹 [SESSION CLEANUP] Cleaning up analysis_session records for analysis ${analysisId}`);

            // Find all sessions related to this analysis that are still active
            const activeSessions = await AnalysisSession.find({
                user_id: userId,
                status: { $in: ['pending', 'running', 'paused'] }
            });

            if (activeSessions.length === 0) {
                console.log(`✅ [SESSION CLEANUP] No active analysis_session records to clean up`);
                return { cleaned: 0 };
            }

            // Mark them as cancelled since the analysis/monitoring has stopped
            const result = await AnalysisSession.updateMany(
                {
                    user_id: userId,
                    status: { $in: ['pending', 'running', 'paused'] }
                },
                {
                    $set: {
                        status: 'cancelled',
                        cancelled_at: new Date(),
                        completed_at: new Date(),
                        error_message: `Associated analysis ${analysisId} monitoring stopped or expired`
                    }
                }
            );

            console.log(`✅ [SESSION CLEANUP] Cleaned up ${result.modifiedCount} orphaned analysis_session records`);
            return { cleaned: result.modifiedCount };

        } catch (error) {
            console.error(`❌ [SESSION CLEANUP] Error cleaning up analysis_session records:`, error);
            return { cleaned: 0, error: error.message };
        }
    }

    /**
     * Send WhatsApp notification when monitoring fails or stops
     */
    async sendMonitoringFailureNotification(userId, analysisId, stockSymbol, reason, details = {}) {
        try {
            const user = await User.findById(userId);
            if (!user || !user.mobile_number) {
                console.log(`⚠️ No mobile number for user ${userId}, skipping WhatsApp notification`);
                return;
            }

            let message = `🛑 *MONITORING STOPPED* 🛑\n\n`;
            message += `*Stock:* ${stockSymbol || 'Unknown'}\n`;
            message += `*Reason:* ${reason}\n\n`;

            // Add specific details based on reason
            if (reason.includes('expired')) {
                message += `⏰ The analysis validity period has ended. Please generate a new analysis to continue monitoring.\n\n`;
            } else if (reason.includes('trigger') && reason.includes('expired')) {
                message += `⏳ Entry conditions did not occur within the expected timeframe (${details.bars_checked || 'N/A'} bars checked).\n\n`;
                message += `*Suggestion:* Market conditions may have changed. Consider running a fresh analysis.\n\n`;
            } else if (reason.includes('invalidation')) {
                message += `❌ A cancel condition was triggered:\n`;
                message += `${details.invalidation_details || 'Price moved against the setup'}\n\n`;
                message += `*This is good risk management* - the setup is no longer valid.\n\n`;
            } else if (reason.includes('not found')) {
                message += `📋 Analysis data was not found. This may have been deleted or expired.\n\n`;
            }

            message += `Analysis ID: ${analysisId}\n`;
            message += `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\n`;
            message += `ℹ️ You can start a new monitoring session anytime from the app.`;

            await messagingService.sendWhatsAppMessage(user.mobile_number, message);
            console.log(`📱 Monitoring failure notification sent to ${user.mobile_number}`);

        } catch (error) {
            console.error(`❌ Error sending monitoring failure notification:`, error);
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