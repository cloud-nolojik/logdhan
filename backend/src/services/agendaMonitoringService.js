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
import Notification from '../models/notification.js';
import { firebaseService } from './firebase/firebase.service.js';
import MarketHoursUtil from '../utils/marketHours.js';
import orderExecutionService from './orderExecutionService.js';
import upstoxService from './upstox.service.js';
import UpstoxUser from '../models/upstoxUser.js';
import { decrypt } from '../utils/encryption.js';

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

      // Define cleanup job for expired monitoring subscriptions
      this.agenda.define('cleanup-expired-subscriptions', async (job) => {
        await this.cleanupExpiredSubscriptions();
      });

      // Handle job failure events
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

      // Schedule cleanup of expired monitoring subscriptions at 3:35 PM IST on weekdays (after monitoring window closes at 3:30 PM)
      await this.agenda.every('35 15 * * 1-5', 'cleanup-expired-subscriptions', {}, {
        _id: 'expired-subscription-cleanup',
        timezone: 'Asia/Kolkata'
      });

      this.isInitialized = true;

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

      // Get subscription to fetch all subscribed users

      const subscription = await MonitoringSubscription.findOne({
        analysis_id: analysisId,
        strategy_id: strategyId
      });

      if (!subscription) {

        await this.stopMonitoring(analysisId, strategyId);
        return;
      }

      const subscribedUserIds = subscription.subscribed_users.map((sub) => sub.user_id);

      // Get analysis

      const analysis = await StockAnalysis.findById(analysisId);

      if (!analysis) {

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

        historyEntry.status = 'stopped';
        historyEntry.reason = 'Analysis expired';
        historyEntry.details.error_message = 'Analysis validity period ended';
        historyEntry.monitoring_duration_ms = Date.now() - startTime;
        await historyEntry.save();

        // Send notification to all subscribed users
        for (const subscribedUserId of subscribedUserIds) {
          await this.sendMonitoringFailureNotification(
            subscribedUserId,
            analysisId,
            analysis.stock_symbol,
            'Analysis expired',
            { expires_at: analysis.expires_at }
          );
        }

        await this.stopMonitoring(analysisId, strategyId);
        return;
      }

      // Check if orders are already placed or being processed
      if (analysis.hasActiveOrders()) {

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

          // Clear stale lock
          const StockAnalysis = (await import('../models/stockAnalysis.js')).default;
          await StockAnalysis.findByIdAndUpdate(analysisId, {
            $unset: {
              order_processing: 1,
              order_processing_started_at: 1
            }
          });
        } else {

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

      // Check if market is open using centralized utility (handles holidays/trading days)

      const now = new Date();
      // Keep UTC as source of truth; derive IST only for logging

      // Use MarketHoursUtil to handle trading days/holidays; pass UTC now
      let isMarketOpen = await MarketHoursUtil.isMarketOpen();

      if (!isMarketOpen) {

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

        if (triggerResult.data?.triggers) {
          triggerResult.data.triggers.forEach((t, idx) => {

          });
        }

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
            evaluated_triggers: (triggerResult.data?.triggers || []).map((t) => ({
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

          // 3. Send WhatsApp notifications to ALL subscribed users
          let successfulNotifications = 0;
          let failedNotifications = 0;

          // Get the strategy object from analysis
          const strategy = (analysis.analysis_data?.strategies || []).find((s) => s.id === strategyId);
          const strategyName = strategy?.name || strategy?.title || strategyId || 'Unnamed Strategy';

          for (const userSubscription of subscription.subscribed_users) {
            try {
              const userId = userSubscription.user_id;
              const user = await User.findById(userId);

              if (!user) {

                failedNotifications++;

                // Create history entry
                await MonitoringHistory.create({
                  analysis_id: analysisId,
                  strategy_id: strategyId,
                  user_id: userId,
                  stock_symbol: analysis.stock_symbol,
                  status: 'error',
                  reason: 'User not found',
                  details: { error_message: 'Cannot send notification - user not found' },
                  monitoring_duration_ms: Date.now() - startTime
                });
                continue;
              }

              // Check if user wants push notifications (optional - can be removed if all users should get alerts)
              if (userSubscription.notification_preferences?.push_disabled) {

                continue;
              }

              // Prepare notification data
              const userName = user.name || user.email?.split('@')[0] || 'User';
              const stockSymbol = analysis.stock_symbol || analysis.stock_name;

              // 🤖 AUTO-ORDER LOGIC: Place GTT order if autoOrder is enabled for this user
              let autoOrderResult = null;
              if (userSubscription.auto_order) {
                console.log(`[AUTO-ORDER] Placing GTT order for user ${userId} on ${stockSymbol}`);
                try {
                  // Get user's Upstox token
                  const upstoxUser = await UpstoxUser.findByUserId(userId);
                  if (!upstoxUser || !upstoxUser.isTokenValid()) {
                    throw new Error('Upstox not connected or token expired');
                  }

                  const accessToken = decrypt(upstoxUser.access_token);

                  // Get strategy from analysis
                  const strategy = analysis.analysis_data?.strategies?.find((s) => s.id === strategyId);
                  if (!strategy) {
                    throw new Error('Strategy not found in analysis');
                  }

                  // Get current price for trigger direction
                  const currentPrice = triggerResult.data?.current_price || null;

                  // Place GTT order using the new multi-leg function
                  autoOrderResult = await upstoxService.placeGTTOrderFromStrategy(
                    accessToken,
                    strategy,
                    analysis.instrument_key,
                    currentPrice
                  );

                  // Update subscription with auto-order result
                  const userIndex = subscription.subscribed_users.findIndex(
                    (sub) => sub.user_id.toString() === userId.toString()
                  );
                  if (userIndex !== -1) {
                    subscription.subscribed_users[userIndex].auto_order_executed_at = new Date();
                    subscription.subscribed_users[userIndex].auto_order_result = {
                      success: autoOrderResult.success,
                      order_id: autoOrderResult.data?.gtt_order_ids?.[0] || autoOrderResult.data?.order_id || null,
                      error: autoOrderResult.success ? null : autoOrderResult.error,
                      executed_at: new Date()
                    };
                    await subscription.save();
                  }

                  if (autoOrderResult.success) {
                    console.log(`[AUTO-ORDER] ✅ GTT order placed for ${userId} on ${stockSymbol}. GTT IDs: ${autoOrderResult.data?.gtt_order_ids?.join(', ') || 'N/A'}`);
                  } else {
                    console.error(`[AUTO-ORDER] ❌ GTT order failed for ${userId} on ${stockSymbol}:`, autoOrderResult.error);
                  }
                } catch (orderError) {
                  console.error(`[AUTO-ORDER] ❌ Exception placing GTT order for ${userId}:`, orderError);
                  autoOrderResult = { success: false, error: orderError.message };
                }
              }

              // Create in-app notification - different message based on auto-order result
              const notificationTitle = userSubscription.auto_order ?
                (autoOrderResult?.success ? '🤖 Auto-Order Placed!' : '⚠️ Auto-Order Failed') :
                'Monitoring Alert - Conditions Met!';

              const notificationMessage = userSubscription.auto_order ?
                (autoOrderResult?.success ?
                  `${stockSymbol} - ${strategyName}: GTT order placed! Entry + Target + StopLoss set. GTT ID: ${autoOrderResult.data?.gtt_order_ids?.[0] || autoOrderResult.data?.order_id || 'N/A'}` :
                  `${stockSymbol} - ${strategyName}: GTT order failed - ${autoOrderResult?.error || 'Unknown error'}. Please place order manually.`) :
                `${stockSymbol} - ${strategyName}: Entry conditions have been met! Check your app for details.`;

              await Notification.createNotification({
                userId: userId,
                title: notificationTitle,
                message: notificationMessage,
                type: 'alert', // Valid types: trade_log, ai_review, credit, system, alert, subscription
                relatedStock: {
                  trading_symbol: stockSymbol,
                  instrument_key: analysis.instrument_key
                },
                metadata: {
                  analysisId: analysisId,
                  strategyId: strategyId,
                  strategyName: strategyName,
                  currentPrice: triggerResult.data?.current_price,
                  triggersSatisfied: triggerResult.data?.triggers?.map((t) => t.condition || t.name),
                  auto_order: userSubscription.auto_order,
                  auto_order_result: autoOrderResult
                }
              });

              // Send Firebase push notification
              if (user.fcmTokens && user.fcmTokens.length > 0) {
                await firebaseService.sendToUser(
                  userId,
                  notificationTitle,
                  notificationMessage,
                  {
                    type: userSubscription.auto_order ?
                      (autoOrderResult?.success ? 'AUTO_ORDER_SUCCESS' : 'AUTO_ORDER_FAILED') :
                      'MONITORING_CONDITIONS_MET',
                    analysisId: analysisId,
                    strategyId: strategyId,
                    stockSymbol: stockSymbol,
                    autoOrder: userSubscription.auto_order ? 'true' : 'false',
                    orderId: autoOrderResult?.data?.order_id || '',
                    route: '/monitoring'
                  }
                );
              }

              // WhatsApp notification removed - using in-app + Firebase instead
              // Old code: await messagingService.sendMonitoringConditionsMet(user.mobile_number, alertData)

              successfulNotifications++;

              // Create success history entry for this user
              await MonitoringHistory.create({
                analysis_id: analysisId,
                strategy_id: strategyId,
                user_id: userId,
                stock_symbol: analysis.stock_symbol,
                status: 'conditions_met',
                reason: userSubscription.auto_order ?
                  (autoOrderResult?.success ?
                    'Auto-order executed successfully' :
                    `Auto-order failed: ${autoOrderResult?.error || 'Unknown error'}`) :
                  'Monitoring conditions met alert sent successfully (in-app + Firebase)',
                details: {
                  notification_type: 'in_app_firebase',
                  stock_symbol: stockSymbol,
                  strategy_name: strategyName,
                  current_price: triggerResult.data?.current_price,
                  triggers_satisfied: triggerResult.data?.triggers?.map((t) => t.condition || t.name),
                  auto_order_enabled: userSubscription.auto_order,
                  auto_order_result: autoOrderResult
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

          // 5. 🛑 STOP JOB IMMEDIATELY - Conditions met, no need to continue monitoring

          await subscription.stopMonitoring('conditions_met');
          await this.stopMonitoring(analysisId, strategyId);

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

        if (triggerResult.data?.failed_triggers && triggerResult.data.failed_triggers.length > 0) {

          triggerResult.data.failed_triggers.forEach((t, idx) => {

          });

        }

        if (triggerResult.data?.triggers) {

          triggerResult.data.triggers.forEach((t, idx) => {

            if (t.left_value !== undefined && t.right_value !== undefined) {

            }
          });

        }

        const shouldStopMonitoring = triggerResult.data?.should_monitor === false;

        if (shouldStopMonitoring) {
          // Handle different failure types
          if (triggerResult.reason === 'invalidation_triggered' || triggerResult.reason === 'position_closure_required') {

            historyEntry.status = 'stopped';
            historyEntry.reason = 'Invalidation triggered';
            historyEntry.details.invalidation_details = triggerResult.data?.invalidation || {};
            historyEntry.monitoring_duration_ms = Date.now() - startTime;
            await historyEntry.save();

            // Send WhatsApp notification to all subscribed users
            for (const subscribedUserId of subscribedUserIds) {
              await this.sendMonitoringFailureNotification(
                subscribedUserId,
                analysisId,
                analysis.stock_symbol,
                'Pre-entry invalidation triggered',
                {
                  invalidation_details: triggerResult.message || 'Price moved against the setup',
                  current_price: triggerResult.data?.current_price
                }
              );
            }

            await this.stopMonitoring(analysisId, strategyId);
            return;

          } else if (triggerResult.data?.expired_trigger) {

            historyEntry.status = 'stopped';
            historyEntry.reason = 'Trigger expired';
            historyEntry.details.expired_trigger = triggerResult.data.expired_trigger;
            historyEntry.monitoring_duration_ms = Date.now() - startTime;
            await historyEntry.save();

            // Send WhatsApp notification to all subscribed users
            for (const subscribedUserId of subscribedUserIds) {
              await this.sendMonitoringFailureNotification(
                subscribedUserId,
                analysisId,
                analysis.stock_symbol,
                'Entry trigger expired',
                {
                  bars_checked: triggerResult.data.session?.total_bars || 'N/A',
                  trigger_details: triggerResult.data.expired_trigger
                }
              );
            }

            await this.stopMonitoring(analysisId, strategyId);
            return;
          }
        }

        // Normal case: triggers not yet met, continue monitoring

        historyEntry.status = 'triggers_not_met';
        historyEntry.reason = triggerResult.message || 'Entry conditions not satisfied';
        if (triggerResult.data) {
          console.log(`📊 [CANDLE DEBUG] Mapping ${triggerResult.data.triggers?.length || 0} triggers for ${analysis.stock_symbol}`);

          // Get strategy object for trigger details
          const strategyObj = (analysis.analysis_data?.strategies || []).find((s) => s.id === strategyId);

          // Map advanced trigger engine format to MonitoringHistory format
          const mappedTriggers = (triggerResult.data.triggers || []).map((t, idx) => {
            const originalTrigger = strategyObj?.triggers?.[idx];

            // Log candle data from trigger result
            if (t.candle_used) {
              console.log(`   📍 Trigger ${idx}: ${originalTrigger?.condition || 'N/A'}`);
              console.log(`      Candle: ${t.candle_used.timestamp} | O:${t.candle_used.open} H:${t.candle_used.high} L:${t.candle_used.low} C:${t.candle_used.close} V:${t.candle_used.volume}`);
              console.log(`      Satisfied: ${t.satisfied}, Evaluable: ${!t.skipped && !t.market_closed}`);
            } else {
              console.log(`   ⚠️  Trigger ${idx}: No candle_used data found in trigger result`);
            }

            return {
              id: originalTrigger?.id || `trigger_${idx}`,
              condition: originalTrigger?.condition || originalTrigger?.description || '',
              left_value: this.getValue(originalTrigger?.left, t),
              right_value: this.getValue(originalTrigger?.right, t),
              passed: t.satisfied || false,
              evaluable: !t.skipped && !t.market_closed,
              timeframe: originalTrigger?.timeframe || '1d',
              candle_used: t.candle_used || null
            };
          });

          console.log(`💾 [CANDLE DEBUG] Saving ${mappedTriggers.length} triggers to MonitoringHistory`);
          console.log(`   Failed triggers count: ${mappedTriggers.filter(t => !t.passed || !t.evaluable).length}`);

          historyEntry.addTriggerDetails(
            mappedTriggers,
            triggerResult.data.current_price
          );
        }
        historyEntry.monitoring_duration_ms = Date.now() - startTime;
        await historyEntry.save();
        console.log(`✅ [CANDLE DEBUG] MonitoringHistory saved with ID: ${historyEntry._id}`);
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
      } else if (subscribedUserIds && subscribedUserIds.length > 0) {
        // Create error entry for first subscribed user if we don't have a history entry yet
        try {
          await MonitoringHistory.create({
            analysis_id: analysisId,
            strategy_id: strategyId,
            user_id: subscribedUserIds[0],
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
      const successRate = batchMetrics.successCount / analysisIds.length * 100;

      if (batchMetrics.errors.length > 0) {

        batchMetrics.errors.forEach((err, idx) => {

        });
      }

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

      // Get analysis with all strategies
      const analysis = await StockAnalysis.findById(analysisId);
      if (!analysis) {

        return { strategiesProcessed: 0 };
      }

      const strategies = analysis.analysis_data?.strategies || [];
      if (strategies.length === 0) {

        return { strategiesProcessed: 0 };
      }

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

      const processedResults = strategyResults.map((result) =>
      result.status === 'fulfilled' ? result.value : { success: false, error: result.reason }
      );

      const successfulStrategies = processedResults.filter((r) => r.success).length;
      const skippedStrategies = processedResults.filter((r) => r.skipped).length;
      const failedStrategies = processedResults.filter((r) => !r.success && !r.skipped).length;

      const processingTime = Date.now() - analysisStartTime;

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

        return;
      }

      // Cancel any existing batch jobs
      await this.agenda.cancel({ name: 'check-triggers-batch' });

      this.activeBatches.clear();

      // Get optimal batches from BatchManager
      const batches = await batchManager.createOptimalBatches();

      if (batches.length === 0) {

        return;
      }

      // Create new batch jobs
      let createdJobs = 0;
      for (const batch of batches) {
        try {
          // Determine cron expression based on fastest frequency needed
          // DEFAULT: Every 15 minutes for production monitoring
          let cronExpression = '*/15 * * * *'; // Every 15 minutes (changed from 1 minute);

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

      if (enabled && !this.useBatchMode) {
        // Switching to batch mode
        this.useBatchMode = true;

        // Cancel existing individual jobs
        await this.agenda.cancel({ name: 'check-triggers' });

        // Initialize batch monitoring
        await this.initializeBatchMonitoring();

      } else if (!enabled && this.useBatchMode) {
        // Switching to individual mode
        this.useBatchMode = false;

        // Cancel batch jobs
        await this.agenda.cancel({ name: 'check-triggers-batch' });

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

  async startMonitoring(analysisId, strategyId, userId, frequency = { seconds: 900 }, stockSymbol = null, instrumentKey = null, config = {}) {
    try {
      if (!this.isInitialized) {
        await this.initialize();
      }

      // Force batch mode - no more individual jobs
      if (!this.useBatchMode) {

        this.useBatchMode = true;
      }

      const jobId = `monitor_${analysisId}_${strategyId}`;
      const { autoOrder = false } = config;

      // Check if user can start monitoring (not already met conditions recently)
      const canStart = await MonitoringSubscription.canUserStartMonitoring(analysisId, strategyId);
      if (!canStart.can_start) {

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

      // Find or create subscription with autoOrder config
      let subscription = await MonitoringSubscription.findOrCreateSubscription(
        analysisId,
        strategyId,
        userId,
        stockSymbol,
        instrumentKey,
        jobId,
        {
          frequency_seconds: frequency.seconds,
          autoOrder: autoOrder, // Pass autoOrder flag
          notification_preferences: {
            whatsapp: true,
            email: false
          }
        }
      );

      console.log(`[MONITORING] Started for ${stockSymbol} - User: ${userId}, AutoOrder: ${autoOrder}`);

      // 🆕 BATCH ARCHITECTURE: No individual jobs - everything goes through batch processing

      // Immediate one-off check to catch already-satisfied triggers
      // Run asynchronously so the API response stays fast
      setTimeout(async () => {
        try {

          await this.executeMonitoringCheck(analysisId, strategyId);
        } catch (immediateErr) {
          console.error('❌ [MONITORING] Immediate trigger check failed:', immediateErr);
        }
      }, 0);

      // 🆕 BATCH ARCHITECTURE: Trigger batch refresh when new monitoring starts
      if (this.useBatchMode) {
        // Schedule batch refresh in background (non-blocking)
        setTimeout(async () => {
          try {

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

            } else {

            }
          } else {
            // Stop monitoring for all users - delete the subscription entirely

            await subscription.deleteOne();

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

            }
          } else {

            await subscription.deleteOne();
          }
        }

      }

      // Cancel jobs in Agenda (guard if agenda not initialized in test harness)
      let cancelledJobs = 0;
      if (this.agenda) {
        cancelledJobs = await this.agenda.cancel(cancelQuery);
      }

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
      if (this.agenda) {
        const jobs = await this.agenda.jobs(cancelQuery);
        if (jobs.length > 0 && jobs[0].attrs.data.userId) {
          const userIdFromJob = jobs[0].attrs.data.userId;
          await this.cleanupAnalysisSessionRecords(analysisId, userIdFromJob);
        }
      }

      // Refresh batch configuration so removed subscriptions are no longer scheduled
      if (this.useBatchMode) {
        try {
          await this.refreshBatchConfiguration();
        } catch (refreshError) {
          console.warn('⚠️ [BATCH MONITORING] Failed to refresh batch configuration after stop:', refreshError.message);
        }
      }

      return {
        success: true,
        message: strategyId ?
        `Monitoring stopped for strategy ${strategyId}` :
        `Monitoring stopped for all strategies in analysis ${analysisId}`,
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
      'conditions_met': 'finished', // Conditions were met, alert sent
      'expired': 'finished', // Time expired without meeting conditions
      'invalidated': 'finished', // Setup invalidated
      'cancelled': 'finished' // User cancelled
    };

    return stateMap[subscriptionStatus] || 'finished';
  }

  async getMonitoringStatus(analysisId, strategyId = null, userId = null) {
    try {

      // Convert UTC date to IST string - toIST() already converts, so use toLocaleString without timezone
      const toIstString = (date) => date ?
      new Date(date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) :
      null;

      const buildHistoryStatus = (history) => {
        let historyState = 'inactive';
        switch (history.status) {
          case 'conditions_met':
            historyState = 'finished';
            break;
          case 'expired':
            historyState = 'expired';
            break;
          case 'market_closed':
            historyState = 'paused';
            break;
          case 'stopped':
          case 'order_placed':
            historyState = 'finished';
            break;
          case 'error':
            historyState = 'error';
            break;
          default:
            historyState = 'inactive';
        }

        const historyMessage = history.status === 'conditions_met' ?
        `Entry conditions met at ${history.check_timestamp.toISOString()}` :
        `Last check status: ${history.status}`;

        return {
          isMonitoring: false,
          state: historyState,
          message: historyMessage,
          subscription_id: null,
          subscribed_users_count: 0,
          is_user_subscribed: !!userId,
          conditions_met_at: history.status === 'conditions_met' ? history.check_timestamp : null,
          conditions_met_at_ist: history.status === 'conditions_met' ?
          toIstString(history.check_timestamp) :
          null,
          history_status: history.status,
          notification_sent_at: null,
          expires_at: null,
          jobId: null,
          startedAt: null,
          isPaused: false,
          pausedReason: null,
          auto_order: history.details?.auto_order_enabled || false
        };
      };

      const buildSubscriptionStatus = (subscription, forUserId = null) => {
        // Find the user's subscription to get their auto_order setting
        let userAutoOrder = false;
        if (forUserId && subscription.subscribed_users) {
          const userSub = subscription.subscribed_users.find(
            (sub) => sub.user_id.toString() === forUserId.toString()
          );
          userAutoOrder = userSub?.auto_order || false;
        }

        return {
          isMonitoring: true,
          state: 'active',
          subscription_id: subscription._id,
          subscribed_users_count: subscription.subscribed_users.length,
          is_user_subscribed: true,
          conditions_met_at: null,
          conditions_met_at_ist: null,
          notification_sent_at: subscription.notification_sent_at,
          expires_at: subscription.expires_at,
          jobId: subscription.job_id,
          startedAt: subscription.createdAt,
          message: userAutoOrder ? '🤖 Auto-order enabled - watching market' : '👁️ AI is watching the market',
          auto_order: userAutoOrder
        };
      };

      if (strategyId) {
        // Check MonitoringSubscription (source of truth for multi-user monitoring)
        const subscriptionQuery = {
          analysis_id: analysisId,
          strategy_id: strategyId
        };
        if (userId) {
          subscriptionQuery['subscribed_users.user_id'] = userId;
        }

        const subscription = await MonitoringSubscription.findOne(subscriptionQuery);

        // Only consider active subscription; otherwise use history
        const isExpired = subscription ? subscription.expires_at <= new Date() : false;
        const isActiveSub = subscription && subscription.monitoring_status === 'active' && !isExpired;

        if (!isActiveSub) {
          // Fallback to latest monitoring history when no active subscription exists
          const historyQuery = {
            analysis_id: analysisId,
            strategy_id: strategyId
          };
          if (userId) {
            historyQuery.user_id = userId;
          }
          const latestHistory = await MonitoringHistory.findOne(historyQuery).
          sort({ check_timestamp: -1 }).
          lean();

          if (latestHistory) {
            return buildHistoryStatus(latestHistory);
          }

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

        return buildSubscriptionStatus(subscription, userId);

      } else {
        // Check analysis-level (all strategies)
        const subscriptions = await MonitoringSubscription.find({
          analysis_id: analysisId,
          ...(userId ? { 'subscribed_users.user_id': userId } : {})
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
          (sub) => sub.monitoring_status === 'active' && sub.expires_at > now
        );

        // Check user subscription if userId provided
        let userActiveCount = 0;
        if (userId) {
          userActiveCount = activeSubscriptions.filter((sub) =>
          sub.subscribed_users.some((u) => u.user_id.toString() === userId.toString())
          ).length;
        }

        return {
          isMonitoring: activeSubscriptions.length > 0,
          state: activeSubscriptions.length > 0 ? 'active' : 'inactive',
          activeStrategies: activeSubscriptions.length,
          user_active_subscriptions: userId ? userActiveCount : null,
          subscriptions: subscriptions.map((sub) => {
            const isExpired = sub.expires_at <= now;
            const isActive = sub.monitoring_status === 'active' && !isExpired;
            // Convert UTC to IST string - use toLocaleString with timezone (don't double convert)
            const conditionsMetAtIst = sub.conditions_met_at ?
            new Date(sub.conditions_met_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) :
            null;

            // Get auto_order for the specific user if userId provided
            let userAutoOrder = false;
            if (userId && sub.subscribed_users) {
              const userSub = sub.subscribed_users.find(
                (u) => u.user_id.toString() === userId.toString()
              );
              userAutoOrder = userSub?.auto_order || false;
            }

            return {
              subscription_id: sub._id,
              strategy_id: sub.strategy_id,
              status: sub.monitoring_status,
              state: this.mapSubscriptionStateToAppState(sub.monitoring_status, isExpired),
              isMonitoring: isActive,
              subscribed_users_count: sub.subscribed_users.length,
              conditions_met_at: sub.conditions_met_at,
              conditions_met_at_ist: conditionsMetAtIst,
              expires_at: sub.expires_at,
              jobId: sub.job_id,
              auto_order: userAutoOrder
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
      return jobs.map((job) => ({
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

      const StockAnalysis = (await import('../models/stockAnalysis.js')).default;
      const result = await StockAnalysis.cleanupStaleOrderProcessingLocks();

      if (result && result.modifiedCount > 0) {

      }

      return result;
    } catch (error) {
      console.error('❌ Error in stale lock cleanup job:', error);
      return null;
    }
  }

  /**
   * Clean up expired monitoring subscriptions
   * Updates status to 'expired' for subscriptions past their expiry time
   */
  async cleanupExpiredSubscriptions() {
    try {

      const now = new Date();

      // Skip on non-trading days
      const isTradingDay = await MarketHoursUtil.isTradingDay(now);
      if (!isTradingDay) {

        return { success: true, skipped: true, reason: 'non_trading_day' };
      }

      // Find active subscriptions that have expired
      const expiredSubs = await MonitoringSubscription.find({
        monitoring_status: 'active',
        expires_at: { $lte: now }
      }).lean();

      // Update expired subscriptions to 'expired' status
      const result = await MonitoringSubscription.updateMany(
        {
          monitoring_status: 'active',
          expires_at: { $lte: now }
        },
        {
          $set: {
            monitoring_status: 'expired',
            stopped_at: now,
            stop_reason: 'expired'
          }
        }
      );

      // Record history for expired subscriptions (per user)
      for (const sub of expiredSubs) {
        if (sub.subscribed_users && sub.subscribed_users.length > 0) {
          for (const u of sub.subscribed_users) {
            await MonitoringHistory.create({
              analysis_id: sub.analysis_id,
              strategy_id: sub.strategy_id,
              user_id: u.user_id,
              stock_symbol: sub.stock_symbol || '',
              status: 'expired',
              reason: 'Monitoring expired at validity cutoff',
              details: {},
              monitoring_duration_ms: 0,
              check_timestamp: now
            });
          }
        }
      }

      if (result && result.modifiedCount > 0) {

      } else {

      }

      return {
        success: true,
        expired_count: result.modifiedCount
      };
    } catch (error) {
      console.error('❌ [EXPIRY CLEANUP] Error in expired subscription cleanup job:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Clean up orphaned analysis_session records when analysis expires/deletes
   */
  async cleanupAnalysisSessionRecords(analysisId, userId) {
    try {

      // Find all sessions related to this analysis that are still active
      const activeSessions = await AnalysisSession.find({
        user_id: userId,
        status: { $in: ['pending', 'running', 'paused'] }
      });

      if (activeSessions.length === 0) {

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

      return { cleaned: result.modifiedCount };

    } catch (error) {
      console.error(`❌ [SESSION CLEANUP] Error cleaning up analysis_session records:`, error);
      return { cleaned: 0, error: error.message };
    }
  }

  /**
   * Send in-app notification + Firebase push when monitoring fails or stops
   */
  async sendMonitoringFailureNotification(userId, analysisId, stockSymbol, reason, details = {}) {
    try {
      const user = await User.findById(userId);
      if (!user) {

        return;
      }

      const userName = user.name || user.email?.split('@')[0] || 'User';
      let notificationTitle = 'Monitoring Stopped';
      let notificationMessage = `${stockSymbol}: Monitoring has stopped - ${reason}`;
      let detailedMessage = '';

      // Build detailed message based on reason
      if (reason.includes('expired')) {
        detailedMessage = `The analysis validity period has ended. Please generate a new analysis to continue monitoring.`;
        notificationMessage = `${stockSymbol}: Monitoring expired. Generate new analysis to continue.`;
      } else if (reason.includes('trigger') && reason.includes('expired')) {
        detailedMessage = `Entry conditions did not occur within the expected timeframe (${details.bars_checked || 'N/A'} bars checked). Market conditions may have changed. Consider running a fresh analysis.`;
        notificationMessage = `${stockSymbol}: Entry conditions not met within timeframe.`;
      } else if (reason.includes('invalidation')) {
        detailedMessage = `A cancel condition was triggered: ${details.invalidation_details || 'Price moved against the setup'}. This is good risk management - the setup is no longer valid.`;
        notificationMessage = `${stockSymbol}: Cancel condition triggered (risk management).`;
      } else if (reason.includes('not found')) {
        detailedMessage = `Analysis data was not found. This may have been deleted or expired.`;
        notificationMessage = `${stockSymbol}: Analysis not found.`;
      }

      // Create in-app notification
      await Notification.createNotification({
        userId: userId,
        title: notificationTitle,
        message: notificationMessage,
        type: 'system',
        relatedStock: {
          trading_symbol: stockSymbol,
          instrument_key: details.instrument_key || ''
        },
        metadata: {
          analysisId: analysisId,
          reason: reason,
          details: detailedMessage,
          barsChecked: details.bars_checked,
          timestamp: new Date().toISOString()
        }
      });

      // Send Firebase push notification
      if (user.fcmTokens && user.fcmTokens.length > 0) {
        await firebaseService.sendToUser(
          userId,
          notificationTitle,
          notificationMessage,
          {
            type: 'MONITORING_STOPPED',
            analysisId: analysisId,
            stockSymbol: stockSymbol,
            reason: reason,
            route: '/monitoring'
          }
        );
      }

      // WhatsApp notification removed - using in-app + Firebase instead

    } catch (error) {
      console.error(`❌ Error sending monitoring failure notification:`, error);
    }
  }

  /**
   * Helper to extract value from trigger reference for display
   */
  getValue(ref, triggerResult) {
    if (!ref) return null;

    // If ref has a value property, return it
    if (ref.value !== undefined) {
      return ref.value;
    }

    // If ref has a ref property (like {ref: 'close'}), extract from trigger result
    if (ref.ref) {
      const refKey = ref.ref.toLowerCase();

      // Check if value is in trigger result
      if (triggerResult && triggerResult.candle_used) {
        return triggerResult.candle_used[refKey] || null;
      }
    }

    return null;
  }

  async shutdown() {
    if (this.agenda) {

      await this.agenda.stop();
      this.isInitialized = false;
      this.activeJobs.clear();

    }
  }
}

export default new AgendaMonitoringService();