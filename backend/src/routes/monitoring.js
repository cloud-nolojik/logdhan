import express from 'express';
import { auth as authenticateToken } from '../middleware/auth.js';
import monitoringQueueService from '../services/monitoringQueue.js';
import dailyReminderService from '../services/dailyReminderService.js';
import StockAnalysis from '../models/stockAnalysis.js';
import MonitoringHistory from '../models/monitoringHistory.js';
import triggerOrderService from '../services/triggerOrderService.js';
import upstoxMarketTimingService from '../services/upstoxMarketTiming.service.js';
import UpstoxUser from '../models/upstoxUser.js';
import { decrypt } from '../utils/encryption.js';
import advancedTriggerEngine from '../services/advancedTriggerEngine.js';

const router = express.Router();

/**
 * @route POST /api/monitoring/start
 * @desc Start monitoring triggers for an analysis
 * @access Private
 */
router.post('/start', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, strategyId, frequencySeconds = 60 } = req.body;
        
        console.log(`🚀 Start monitoring request from user ${userId}:`, {
            analysisId,
            strategyId,
            frequencySeconds
        });
        
        // Validate input
        if (!analysisId || !strategyId) {
            return res.status(400).json({
                success: false,
                error: 'invalid_request',
                message: 'Analysis ID and Strategy ID are required'
            });
        }
        
        // Validate frequency (minimum 30 seconds, maximum 1 hour)
        if (frequencySeconds < 30 || frequencySeconds > 3600) {
            return res.status(400).json({
                success: false,
                error: 'invalid_frequency',
                message: 'Frequency must be between 30 seconds and 1 hour'
            });
        }
        
        // Verify analysis exists and belongs to user
        const analysis = await StockAnalysis.findById(analysisId);
        
        if (!analysis) {
            return res.status(404).json({
                success: false,
                error: 'analysis_not_found',
                message: 'Analysis not found'
            });
        }
        
        if (analysis.user_id.toString() !== userId) {
            return res.status(403).json({
                success: false,
                error: 'access_denied',
                message: 'You do not have access to this analysis'
            });
        }
        
        // Check if analysis has expired
        if (analysis.expires_at && new Date(analysis.expires_at) < new Date()) {
            return res.status(400).json({
                success: false,
                error: 'analysis_expired',
                message: 'This analysis has expired'
            });
        }
        
        // Check if orders are already placed
        if (analysis.hasActiveOrders()) {
            return res.status(400).json({
                success: false,
                error: 'orders_already_placed',
                message: 'Orders have already been placed for this analysis'
            });
        }
        
        // Verify strategy exists
        const strategy = analysis.analysis_data.strategies.find(s => s.id === strategyId);
        if (!strategy) {
            return res.status(404).json({
                success: false,
                error: 'strategy_not_found',
                message: 'Strategy not found in analysis. Please ensure the strategy ID matches one from your analysis.',
                data: {
                    provided_strategy_id: strategyId,
                    available_strategies: analysis.analysis_data.strategies.map(s => s.id),
                    user_action_required: 'Use a valid strategy ID from the analysis'
                }
            });
        }
        
        // Check if strategy has triggers
        if (!strategy.triggers || strategy.triggers.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'no_triggers_configured',
                message: 'Cannot start monitoring - No entry conditions configured. The system needs specific conditions (like price levels or indicators) to know when to place your order.',
                data: {
                    strategy_id: strategyId,
                    stock_symbol: analysis.stock_symbol,
                    user_action_required: 'Run a new AI analysis with proper entry conditions',
                    why_needed: 'Without triggers, the system cannot determine the right time to enter the trade',
                    example_conditions: [
                        'When price crosses above ₹' + (strategy.entry || 'entry_price'),
                        'When RSI drops below 30 (oversold)',
                        'When price breaks resistance level'
                    ]
                }
            });
        }
        
        // Validate critical strategy parameters
        const missingParams = [];
        if (!strategy.entry || strategy.entry <= 0) missingParams.push('entry price');
        if (!strategy.stopLoss || strategy.stopLoss <= 0) missingParams.push('stop loss');
        if (!strategy.target || strategy.target <= 0) missingParams.push('target price');
        
        if (missingParams.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'incomplete_strategy',
                message: `Cannot start monitoring - Missing ${missingParams.join(', ')}. These are essential for order placement.`,
                data: {
                    strategy_id: strategyId,
                    missing_parameters: missingParams,
                    current_values: {
                        entry: strategy.entry || 'not set',
                        stop_loss: strategy.stopLoss || 'not set',
                        target: strategy.target || 'not set'
                    },
                    user_action_required: 'Complete the strategy configuration or run a new analysis',
                    why_needed: {
                        entry: 'Determines the price at which to buy/sell',
                        stop_loss: 'Limits your maximum loss (risk management)',
                        target: 'Sets your profit booking level'
                    }
                }
            });
        }
        
        // Check current trigger status first
        const triggerCheck = await triggerOrderService.checkTriggerConditions(analysis);
        
        // If triggers are already met, suggest immediate order placement
        if (triggerCheck.triggersConditionsMet) {
            return res.status(200).json({
                success: true,
                message: 'Triggers are already satisfied. You can place the order immediately.',
                data: {
                    triggers_met: true,
                    current_price: triggerCheck.data.current_price,
                    triggers: triggerCheck.data.triggers,
                    suggestion: 'Use /api/upstox/place-order to place order immediately'
                }
            });
        }
        
        // Start monitoring
        const result = await monitoringQueueService.startMonitoring(
            analysisId,
            strategyId,
            userId,
            { seconds: frequencySeconds }
        );
        
        if (result.success) {
            const frequencyText = frequencySeconds === 60 ? 'every minute' : 
                                  frequencySeconds === 300 ? 'every 5 minutes' : 
                                  frequencySeconds === 900 ? 'every 15 minutes' : 
                                  frequencySeconds === 3600 ? 'every hour' : 
                                  `every ${frequencySeconds} seconds`;
            
            res.json({
                success: true,
                message: `🎯 Smart monitoring activated for ${analysis.stock_symbol}! We'll watch the market ${frequencyText} and place your order at the perfect moment.`,
                monitoring_status: 'ACTIVE',
                data: {
                    jobId: result.jobId,
                    frequency: result.frequency,
                    analysisId,
                    strategyId,
                    stock_symbol: analysis.stock_symbol,
                    failed_triggers: triggerCheck.data?.failed_triggers || [],
                    user_message: {
                        title: '🔵 Monitoring Active',
                        stock: analysis.stock_symbol,
                        status: 'Your order is being monitored',
                        what_we_monitor: [
                            `Current price vs. your entry point (₹${strategy.entry})`,
                            'Market momentum and trends',
                            'Technical indicators for optimal entry'
                        ],
                        frequency: frequencyText,
                        notification: 'You\'ll receive instant notification when order is placed',
                        can_cancel_anytime: true,
                        estimated_monitoring_duration: 'Up to 5 trading days',
                        reassurance: 'No manual intervention needed - we\'ve got this!'
                    }
                }
            });
        } else {
            res.status(400).json({
                success: false,
                error: 'monitoring_start_failed',
                message: result.message
            });
        }
        
    } catch (error) {
        console.error('❌ Start monitoring error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_start_error',
            message: 'Failed to start monitoring'
        });
    }
});

/**
 * @route POST /api/monitoring/stop
 * @desc Stop monitoring triggers for an analysis
 * @access Private
 */
router.post('/stop', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, strategyId } = req.body;
        
        console.log(`🛑 STOP MONITORING API REQUEST:`);
        console.log(`   ✓ User ID: ${userId}`);
        console.log(`   ✓ Analysis ID: ${analysisId}`);
        console.log(`   ✓ Strategy ID: ${strategyId || 'ALL STRATEGIES'}`);
        console.log(`   ✓ Request timestamp: ${new Date().toISOString()}`);
        
        if (!analysisId) {
            console.log(`❌ VALIDATION FAILED: Missing analysis ID`);
            return res.status(400).json({
                success: false,
                error: 'invalid_request',
                message: 'Analysis ID is required'
            });
        }
        
        // Verify analysis belongs to user
        const analysis = await StockAnalysis.findById(analysisId);
        
        if (!analysis || analysis.user_id.toString() !== userId) {
            return res.status(403).json({
                success: false,
                error: 'access_denied',
                message: 'You do not have access to this analysis'
            });
        }
        
        // Stop monitoring
        console.log(`🔄 Calling monitoringQueueService.stopMonitoring...`);
        const result = await monitoringQueueService.stopMonitoring(analysisId, strategyId);
        console.log(`📤 Stop monitoring result:`, result);
        
        if (result.success) {
            console.log(`✅ STOP MONITORING SUCCESS: ${result.message}`);
            res.json({
                success: true,
                message: result.message
            });
        } else {
            console.log(`❌ STOP MONITORING FAILED: ${result.message}`);
            res.status(400).json({
                success: false,
                error: 'monitoring_stop_failed',
                message: result.message
            });
        }
        
    } catch (error) {
        console.error('❌ Stop monitoring error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_stop_error',
            message: 'Failed to stop monitoring'
        });
    }
});

/**
 * @route GET /api/monitoring/status/:analysisId
 * @desc Get monitoring status for an analysis
 * @access Private
 */
router.get('/status/:analysisId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId } = req.params;
        
        // Verify analysis belongs to user
        const analysis = await StockAnalysis.findById(analysisId);
        
        if (!analysis || analysis.user_id.toString() !== userId) {
            return res.status(403).json({
                success: false,
                error: 'access_denied',
                message: 'You do not have access to this analysis'
            });
        }
        
        console.log(`📊 GET MONITORING STATUS API CALLED for analysis: ${analysisId}`);
        console.log(`📋 Analysis has ${analysis.analysis_data?.strategies?.length || 0} strategies`);
        
        // Get monitoring status for each strategy in the analysis
        const strategies = analysis.analysis_data?.strategies || [];
        const strategyStatuses = {};
        let hasAnyActiveMonitoring = false;
        
        console.log(`🔍 Checking status for each strategy:`);
        
        // Check monitoring status for each strategy
        for (const strategy of strategies) {
            console.log(`\n🎯 Getting status for strategy ${strategy.id}:`);
            const strategyStatus = await monitoringQueueService.getMonitoringStatus(analysisId, strategy.id);
            strategyStatuses[strategy.id] = strategyStatus;
            
            console.log(`   ✓ Strategy ${strategy.id} monitoring: ${strategyStatus.isMonitoring}`);
            console.log(`   ✓ State: ${strategyStatus.state || 'none'}`);
            
            if (strategyStatus.isMonitoring) {
                hasAnyActiveMonitoring = true;
            }
        }
        
        // Also get analysis-level status for backward compatibility
        console.log(`\n📊 Getting analysis-level status for backward compatibility:`);
        const analysisStatus = await monitoringQueueService.getMonitoringStatus(analysisId);
        
        console.log(`📤 API RESPONSE SUMMARY:`);
        console.log(`   ✓ Has any active monitoring: ${hasAnyActiveMonitoring}`);
        console.log(`   ✓ Strategy statuses:`, Object.entries(strategyStatuses).map(([id, status]) => 
            `${id}: ${status.isMonitoring ? 'ACTIVE' : 'INACTIVE'} (${status.state || 'none'})`
        ));
        
        res.json({
            success: true,
            data: {
                // Legacy analysis-level status (for backward compatibility)
                ...analysisStatus,
                isMonitoring: hasAnyActiveMonitoring, // True if any strategy is being monitored
                
                // New strategy-level statuses
                strategies: strategyStatuses,
                
                // Additional info
                stock_symbol: analysis.stock_symbol,
                analysis_type: analysis.analysis_type,
                total_strategies: strategies.length,
                active_monitoring_count: Object.values(strategyStatuses).filter(s => s.isMonitoring).length
            }
        });
        
    } catch (error) {
        console.error('❌ Get monitoring status error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_status_error',
            message: 'Failed to get monitoring status'
        });
    }
});

/**
 * @route GET /api/monitoring/results
 * @desc Get monitoring results for the current user
 * @access Private
 */
router.get('/results', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = parseInt(req.query.limit) || 10;
        
        // Get results
        const results = await monitoringQueueService.getResults(userId, limit);
        
        res.json({
            success: true,
            data: results,
            count: results.length
        });
        
    } catch (error) {
        console.error('❌ Get monitoring results error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_results_error',
            message: 'Failed to get monitoring results'
        });
    }
});

/**
 * @route GET /api/monitoring/active
 * @desc Get all active monitoring jobs for the current user
 * @access Private
 */
router.get('/active', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get all active jobs
        const allJobs = await monitoringQueueService.getActiveJobs();
        
        // Filter jobs for this user
        const userJobs = [];
        for (const job of allJobs) {
            const analysis = await StockAnalysis.findById(job.analysisId);
            if (analysis && analysis.user_id.toString() === userId) {
                userJobs.push({
                    ...job,
                    stock_symbol: analysis.stock_symbol,
                    analysis_type: analysis.analysis_type
                });
            }
        }
        
        res.json({
            success: true,
            data: userJobs,
            count: userJobs.length
        });
        
    } catch (error) {
        console.error('❌ Get active monitoring jobs error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_active_error',
            message: 'Failed to get active monitoring jobs'
        });
    }
});

/**
 * @route POST /api/monitoring/check-triggers
 * @desc Manually check trigger conditions for an analysis
 * @access Private
 */
router.post('/check-triggers', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId } = req.body;
        
        console.log(`🔍 Manual trigger check request from user ${userId} for analysis ${analysisId}`);
        
        if (!analysisId) {
            return res.status(400).json({
                success: false,
                error: 'invalid_request',
                message: 'Analysis ID is required'
            });
        }
        
        // Verify analysis belongs to user
        const analysis = await StockAnalysis.findById(analysisId);
        
        if (!analysis) {
            return res.status(404).json({
                success: false,
                error: 'analysis_not_found',
                message: 'Analysis not found'
            });
        }
        
        if (analysis.user_id.toString() !== userId) {
            return res.status(403).json({
                success: false,
                error: 'access_denied',
                message: 'You do not have access to this analysis'
            });
        }
        
        // Check triggers
        const triggerResult = await triggerOrderService.checkTriggerConditions(analysis);
        
        // Handle cases where triggers are missing or invalid
        if (!triggerResult.success && 
            ['no_triggers', 'invalid_triggers', 'no_strategy', 'missing_entry_price', 'missing_stoploss', 'missing_target'].includes(triggerResult.reason)) {
            return res.status(400).json({
                success: false,
                error: triggerResult.reason,
                message: triggerResult.message,
                data: {
                    ...triggerResult.data,
                    stock_symbol: analysis.stock_symbol,
                    analysis_id: analysisId,
                    help_message: 'Please fix these issues before monitoring can begin'
                }
            });
        }
        
        res.json({
            success: true,
            data: {
                triggers_met: triggerResult.triggersConditionsMet,
                reason: triggerResult.reason,
                message: triggerResult.message,
                current_price: triggerResult.data?.current_price,
                triggers: triggerResult.data?.triggers,
                failed_triggers: triggerResult.data?.failed_triggers,
                invalidations: triggerResult.data?.invalidations,
                should_monitor: triggerResult.data?.should_monitor,
                monitoring_frequency: triggerResult.data?.monitoring_frequency,
                stock_symbol: analysis.stock_symbol,
                user_action_required: triggerResult.data?.user_action_required
            }
        });
        
    } catch (error) {
        console.error('❌ Check triggers error:', error);
        res.status(500).json({
            success: false,
            error: 'trigger_check_error',
            message: 'Failed to check trigger conditions'
        });
    }
});

/**
 * @route GET /api/monitoring/health
 * @desc Check monitoring service health
 * @access Public
 */
router.get('/health', async (req, res) => {
    try {
        const activeJobs = await monitoringQueueService.getActiveJobs();
        
        res.json({
            success: true,
            message: 'Monitoring service is running',
            timestamp: new Date().toISOString(),
            active_jobs: activeJobs.length,
            redis_connected: true // If we got here, Redis is working
        });
    } catch (error) {
        res.status(503).json({
            success: false,
            message: 'Monitoring service health check failed',
            error: error.message
        });
    }
});

/**
 * @route GET /api/monitoring/schedule/:analysisId
 * @desc Get next monitoring schedule with market timing consideration
 * @access Private
 */
router.get('/schedule/:analysisId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId } = req.params;
        
        // Verify analysis belongs to user
        const analysis = await StockAnalysis.findById(analysisId);
        if (!analysis || analysis.user_id.toString() !== userId) {
            return res.status(404).json({
                success: false,
                error: 'analysis_not_found',
                message: 'Analysis not found'
            });
        }

        // Get Upstox access token
        const upstoxUser = await UpstoxUser.findByUserId(userId);
        if (!upstoxUser || !upstoxUser.isTokenValid()) {
            return res.status(401).json({
                success: false,
                error: 'upstox_not_connected',
                message: 'Upstox not connected or token expired'
            });
        }

        const accessToken = decrypt(upstoxUser.access_token);
        const today = new Date().toISOString().split('T')[0];
        
        // Get current market status
        const marketStatus = await upstoxMarketTimingService.isMarketOpen(today, accessToken);
        
        // Get next monitoring schedule
        const schedule = await upstoxMarketTimingService.getNextMonitoringSchedule(
            analysisId, 
            accessToken, 
            900 // 15 minutes
        );

        // Check current monitoring status
        const monitoringStatus = await monitoringQueueService.getMonitoringStatus(analysisId);

        res.json({
            success: true,
            data: {
                analysis_id: analysisId,
                stock_symbol: analysis.stock_symbol,
                analysis_type: analysis.analysis_type,
                current_time: new Date().toISOString(),
                market_status: {
                    is_open: marketStatus.isOpen,
                    reason: marketStatus.reason,
                    start_time: marketStatus.startTime,
                    end_time: marketStatus.endTime,
                    next_open: marketStatus.nextOpen
                },
                monitoring: {
                    is_active: monitoringStatus.isMonitoring,
                    frequency_seconds: 900,
                    next_check: schedule.nextCheck,
                    schedule_reason: schedule.reason
                },
                strategy_conditions: analysis.analysis_data?.strategies?.find(s => 
                    s.id.includes(analysis.stock_symbol)
                )?.conditions || null
            }
        });

    } catch (error) {
        console.error('❌ Get monitoring schedule error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_schedule_error',
            message: 'Failed to get monitoring schedule'
        });
    }
});

/**
 * @route GET /api/monitoring/paused
 * @desc Get all paused monitoring jobs for the current user
 * @access Private
 */
router.get('/paused', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get all paused jobs
        const pausedJobs = await monitoringQueueService.getPausedJobs();
        
        // Filter and enrich with analysis data for this user
        const userPausedJobs = [];
        for (const pausedJob of pausedJobs) {
            const analysis = await StockAnalysis.findById(pausedJob.analysisId);
            if (analysis && analysis.user_id.toString() === userId) {
                const strategy = analysis.analysis_data.strategies.find(s => s.id === pausedJob.strategyId);
                userPausedJobs.push({
                    ...pausedJob,
                    stock_symbol: analysis.stock_symbol,
                    analysis_type: analysis.analysis_type,
                    strategy_name: strategy?.name || 'Unknown Strategy',
                    entry_price: strategy?.entry || null,
                    stop_loss: strategy?.stopLoss || null,
                    target: strategy?.target || null
                });
            }
        }
        
        res.json({
            success: true,
            data: userPausedJobs,
            count: userPausedJobs.length
        });
        
    } catch (error) {
        console.error('❌ Get paused monitoring jobs error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_paused_error',
            message: 'Failed to get paused monitoring jobs'
        });
    }
});

/**
 * @route POST /api/monitoring/resume
 * @desc Resume paused monitoring for an analysis
 * @access Private
 */
router.post('/resume', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, strategyId } = req.body;
        
        console.log(`▶️ Resume monitoring request from user ${userId}:`, {
            analysisId,
            strategyId
        });
        
        // Validate input
        if (!analysisId || !strategyId) {
            return res.status(400).json({
                success: false,
                error: 'invalid_request',
                message: 'Analysis ID and Strategy ID are required'
            });
        }
        
        // Verify analysis exists and belongs to user
        const analysis = await StockAnalysis.findById(analysisId);
        
        if (!analysis) {
            return res.status(404).json({
                success: false,
                error: 'analysis_not_found',
                message: 'Analysis not found'
            });
        }
        
        if (analysis.user_id.toString() !== userId) {
            return res.status(403).json({
                success: false,
                error: 'access_denied',
                message: 'You do not have access to this analysis'
            });
        }
        
        // Check if analysis has expired
        if (analysis.expires_at && new Date(analysis.expires_at) < new Date()) {
            return res.status(400).json({
                success: false,
                error: 'analysis_expired',
                message: 'This analysis has expired'
            });
        }
        
        // Check if orders are already placed
        if (analysis.hasActiveOrders()) {
            return res.status(400).json({
                success: false,
                error: 'orders_already_placed',
                message: 'Orders have already been placed for this analysis'
            });
        }
        
        // Verify strategy exists
        const strategy = analysis.analysis_data.strategies.find(s => s.id === strategyId);
        if (!strategy) {
            return res.status(404).json({
                success: false,
                error: 'strategy_not_found',
                message: 'Strategy not found in analysis'
            });
        }
        
        // Check if user has valid Upstox session
        const upstoxUser = await UpstoxUser.findByUserId(userId);
        if (!upstoxUser || !upstoxUser.isTokenValid()) {
            return res.status(401).json({
                success: false,
                error: 'upstox_session_required',
                message: 'Please login to Upstox first to resume monitoring',
                data: {
                    action_required: 'Upstox re-authentication needed',
                    reason: 'Session expired or not found'
                }
            });
        }
        
        // Resume monitoring
        const result = await monitoringQueueService.resumeMonitoring(analysisId, strategyId, userId);
        
        if (result.success) {
            res.json({
                success: true,
                message: `🎯 Monitoring resumed for ${analysis.stock_symbol}! We're back to watching the market for your perfect entry.`,
                monitoring_status: 'ACTIVE',
                data: {
                    jobId: result.jobId,
                    analysisId,
                    strategyId,
                    stock_symbol: analysis.stock_symbol,
                    user_message: {
                        title: '▶️ Monitoring Resumed',
                        stock: analysis.stock_symbol,
                        status: 'Your order monitoring is active again',
                        what_happens_next: 'We\'ll continue watching for your trigger conditions',
                        notification: 'You\'ll receive instant notification when order is placed'
                    }
                }
            });
        } else {
            res.status(400).json({
                success: false,
                error: 'monitoring_resume_failed',
                message: result.message
            });
        }
        
    } catch (error) {
        console.error('❌ Resume monitoring error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_resume_error',
            message: 'Failed to resume monitoring'
        });
    }
});

/**
 * @route POST /api/monitoring/pause
 * @desc Manually pause monitoring for an analysis
 * @access Private
 */
router.post('/pause', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, strategyId, reason = 'manual' } = req.body;
        
        console.log(`⏸️ Pause monitoring request from user ${userId}:`, {
            analysisId,
            strategyId,
            reason
        });
        
        // Validate input
        if (!analysisId || !strategyId) {
            return res.status(400).json({
                success: false,
                error: 'invalid_request',
                message: 'Analysis ID and Strategy ID are required'
            });
        }
        
        // Verify analysis belongs to user
        const analysis = await StockAnalysis.findById(analysisId);
        
        if (!analysis || analysis.user_id.toString() !== userId) {
            return res.status(403).json({
                success: false,
                error: 'access_denied',
                message: 'You do not have access to this analysis'
            });
        }
        
        // Pause monitoring
        const result = await monitoringQueueService.pauseMonitoring(analysisId, strategyId, reason);
        
        if (result.success) {
            res.json({
                success: true,
                message: `⏸️ Monitoring paused for ${analysis.stock_symbol}`,
                monitoring_status: 'PAUSED',
                data: {
                    analysisId,
                    strategyId,
                    stock_symbol: analysis.stock_symbol,
                    reason,
                    paused_at: new Date()
                }
            });
        } else {
            res.status(400).json({
                success: false,
                error: 'monitoring_pause_failed',
                message: result.message
            });
        }
        
    } catch (error) {
        console.error('❌ Pause monitoring error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_pause_error',
            message: 'Failed to pause monitoring'
        });
    }
});

/**
 * @route POST /api/monitoring/send-reminder
 * @desc Send manual re-authentication reminder to user
 * @access Private
 */
router.post('/send-reminder', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { type = 'reauth_required' } = req.body;
        
        console.log(`📧 Manual reminder request from user ${userId}, type: ${type}`);
        
        const result = await dailyReminderService.sendManualReminder(userId, type);
        
        if (result.success) {
            res.json({
                success: true,
                message: 'Reminder will be sent shortly'
            });
        } else {
            res.status(400).json({
                success: false,
                error: 'reminder_failed',
                message: result.message
            });
        }
        
    } catch (error) {
        console.error('❌ Send manual reminder error:', error);
        res.status(500).json({
            success: false,
            error: 'reminder_error',
            message: 'Failed to send reminder'
        });
    }
});

/**
 * @route GET /api/monitoring/history/:analysisId/:strategyId
 * @desc Get monitoring history for a specific strategy
 * @access Private
 */
router.get('/history/:analysisId/:strategyId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, strategyId } = req.params;
        const limit = parseInt(req.query.limit) || 10;
        
        // Verify analysis belongs to user
        const analysis = await StockAnalysis.findById(analysisId);
        
        if (!analysis || analysis.user_id.toString() !== userId) {
            return res.status(403).json({
                success: false,
                error: 'access_denied',
                message: 'You do not have access to this analysis'
            });
        }
        
        // Get monitoring history
        const history = await MonitoringHistory.find({
            analysis_id: analysisId,
            strategy_id: strategyId
        })
        .sort({ check_timestamp: -1 })
        .limit(limit)
        .lean();
        
        // Get summary stats
        const summaryStats = await MonitoringHistory.getSummaryStats(analysisId, strategyId);
        
        res.json({
            success: true,
            data: {
                history,
                summary: summaryStats[0] || {
                    total_checks: 0,
                    status_breakdown: [],
                    last_check: null
                },
                stock_symbol: analysis.stock_symbol,
                analysis_type: analysis.analysis_type
            }
        });
        
    } catch (error) {
        console.error('❌ Get monitoring history error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_history_error',
            message: 'Failed to get monitoring history'
        });
    }
});

/**
 * @route GET /api/monitoring/latest-status/:analysisId/:strategyId
 * @desc Get last 3 monitoring status checks with failure reasons
 * @access Private
 */
router.get('/latest-status/:analysisId/:strategyId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, strategyId } = req.params;
        
        // Verify analysis belongs to user
        const analysis = await StockAnalysis.findById(analysisId);
        
        if (!analysis || analysis.user_id.toString() !== userId) {
            return res.status(403).json({
                success: false,
                error: 'access_denied',
                message: 'You do not have access to this analysis'
            });
        }
        
        // Get latest 3 monitoring checks
        const latestChecks = await MonitoringHistory.getLatestForStrategy(analysisId, strategyId, 3);
        
        // Format the response to highlight failure reasons
        const formattedChecks = latestChecks.map(check => ({
            timestamp: check.check_timestamp,
            status: check.status,
            reason: check.reason,
            current_price: check.details?.current_price,
            market_status: check.details?.market_status,
            failed_triggers: check.details?.failed_triggers?.map(trigger => ({
                condition: trigger.condition,
                reason: `Expected: ${trigger.right_value}, Got: ${trigger.left_value}`
            })) || [],
            error_message: check.details?.error_message,
            order_placed: check.status === 'order_placed',
            monitoring_duration_ms: check.monitoring_duration_ms
        }));
        
        // Determine overall monitoring status
        const currentStatus = latestChecks.length > 0 ? latestChecks[0].status : 'unknown';
        const isActivelyMonitoring = await monitoringQueueService.getMonitoringStatus(analysisId, strategyId);
        
        res.json({
            success: true,
            data: {
                stock_symbol: analysis.stock_symbol,
                analysis_type: analysis.analysis_type,
                current_monitoring_status: isActivelyMonitoring.isMonitoring ? 'active' : 'inactive',
                last_check_status: currentStatus,
                latest_checks: formattedChecks,
                summary: {
                    total_checks_shown: formattedChecks.length,
                    has_active_monitoring: isActivelyMonitoring.isMonitoring,
                    last_check_time: latestChecks.length > 0 ? latestChecks[0].check_timestamp : null,
                    common_failure_reasons: getCommonFailureReasons(formattedChecks)
                }
            }
        });
        
    } catch (error) {
        console.error('❌ Get latest monitoring status error:', error);
        res.status(500).json({
            success: false,
            error: 'latest_status_error',
            message: 'Failed to get latest monitoring status'
        });
    }
});

/**
 * @route GET /api/monitoring/failure-analysis/:analysisId/:strategyId
 * @desc Get detailed failure analysis for monitoring
 * @access Private
 */
router.get('/failure-analysis/:analysisId/:strategyId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, strategyId } = req.params;
        
        // Verify analysis belongs to user
        const analysis = await StockAnalysis.findById(analysisId);
        
        if (!analysis || analysis.user_id.toString() !== userId) {
            return res.status(403).json({
                success: false,
                error: 'access_denied',
                message: 'You do not have access to this analysis'
            });
        }
        
        // Get failure reasons from monitoring history
        const failureHistory = await MonitoringHistory.getFailureReasons(analysisId, strategyId, 10);
        
        // Analyze common failure patterns
        const failureAnalysis = analyzeFailurePatterns(failureHistory);
        
        // Get current trigger status for comparison
        const currentTriggerStatus = await triggerOrderService.checkTriggerConditions(analysis);
        
        res.json({
            success: true,
            data: {
                stock_symbol: analysis.stock_symbol,
                analysis_type: analysis.analysis_type,
                failure_analysis: failureAnalysis,
                current_trigger_status: {
                    conditions_met: currentTriggerStatus.triggersConditionsMet,
                    reason: currentTriggerStatus.reason,
                    message: currentTriggerStatus.message,
                    current_price: currentTriggerStatus.data?.current_price,
                    failed_triggers: currentTriggerStatus.data?.failed_triggers || []
                },
                recommendations: generateRecommendations(failureAnalysis, currentTriggerStatus)
            }
        });
        
    } catch (error) {
        console.error('❌ Get failure analysis error:', error);
        res.status(500).json({
            success: false,
            error: 'failure_analysis_error',
            message: 'Failed to get failure analysis'
        });
    }
});

/**
 * @route GET /api/monitoring/reminder-stats
 * @desc Get daily reminder service statistics
 * @access Private (Admin only)
 */
router.get('/reminder-stats', authenticateToken, async (req, res) => {
    try {
        // Note: In production, add admin check here
        // if (!req.user.isAdmin) return res.status(403).json({...})
        
        const stats = await dailyReminderService.getReminderStats();
        
        res.json({
            success: true,
            data: {
                ...stats,
                timestamp: new Date().toISOString(),
                service_status: 'running'
            }
        });
        
    } catch (error) {
        console.error('❌ Get reminder stats error:', error);
        res.status(500).json({
            success: false,
            error: 'reminder_stats_error',
            message: 'Failed to get reminder statistics'
        });
    }
});

// Helper functions for failure analysis
function getCommonFailureReasons(checks) {
    const reasonCounts = {};
    checks.forEach(check => {
        if (check.status !== 'order_placed' && check.status !== 'conditions_met') {
            const reason = check.reason || 'Unknown';
            reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
        }
    });
    
    return Object.entries(reasonCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3)
        .map(([reason, count]) => ({ reason, count }));
}

function analyzeFailurePatterns(failureHistory) {
    const patterns = {
        market_closed_count: 0,
        trigger_failures: {},
        error_count: 0,
        most_recent_failure: null,
        failure_trend: 'stable'
    };
    
    failureHistory.forEach(failure => {
        switch (failure.status) {
            case 'market_closed':
                patterns.market_closed_count++;
                break;
            case 'triggers_not_met':
                if (failure.details?.failed_triggers) {
                    failure.details.failed_triggers.forEach(trigger => {
                        const condition = trigger.condition || 'unknown';
                        patterns.trigger_failures[condition] = (patterns.trigger_failures[condition] || 0) + 1;
                    });
                }
                break;
            case 'error':
                patterns.error_count++;
                break;
        }
    });
    
    if (failureHistory.length > 0) {
        patterns.most_recent_failure = {
            status: failureHistory[0].status,
            reason: failureHistory[0].reason,
            timestamp: failureHistory[0].check_timestamp
        };
        
        // Simple trend analysis - are recent failures different from older ones?
        const recentFailures = failureHistory.slice(0, 3);
        const olderFailures = failureHistory.slice(3);
        const recentTypes = new Set(recentFailures.map(f => f.status));
        const olderTypes = new Set(olderFailures.map(f => f.status));
        
        patterns.failure_trend = recentTypes.size > olderTypes.size ? 'worsening' : 
                                recentTypes.size < olderTypes.size ? 'improving' : 'stable';
    }
    
    return patterns;
}

function generateRecommendations(failureAnalysis, currentStatus) {
    const recommendations = [];
    
    if (failureAnalysis.market_closed_count > 5) {
        recommendations.push({
            type: 'timing',
            priority: 'low',
            title: 'Market Timing',
            message: 'Most monitoring checks happen when market is closed. This is normal and expected.',
            action: null
        });
    }
    
    if (failureAnalysis.error_count > 2) {
        recommendations.push({
            type: 'technical',
            priority: 'high',
            title: 'Technical Issues',
            message: 'Multiple technical errors detected. Consider refreshing your Upstox connection.',
            action: 'Re-authenticate with Upstox'
        });
    }
    
    if (Object.keys(failureAnalysis.trigger_failures).length > 0) {
        const commonTrigger = Object.entries(failureAnalysis.trigger_failures)
            .sort(([,a], [,b]) => b - a)[0];
        
        recommendations.push({
            type: 'strategy',
            priority: 'medium',
            title: 'Trigger Conditions',
            message: `The condition "${commonTrigger[0]}" has failed ${commonTrigger[1]} times. Consider adjusting your entry conditions.`,
            action: 'Review and modify strategy parameters'
        });
    }
    
    if (!currentStatus.conditions_met && currentStatus.reason) {
        recommendations.push({
            type: 'current',
            priority: 'medium',
            title: 'Current Status',
            message: currentStatus.message || currentStatus.reason,
            action: currentStatus.reason.includes('expired') ? 'Generate new analysis' : 
                   currentStatus.reason.includes('token') ? 'Re-authenticate with Upstox' : 
                   'Continue monitoring'
        });
    }
    
    return recommendations;
}

export default router;