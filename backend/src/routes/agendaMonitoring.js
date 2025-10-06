import express from 'express';
import { auth as authenticateToken } from '../middleware/auth.js';
import agendaMonitoringService from '../services/agendaMonitoringService.js';
import agendaDailyReminderService from '../services/agendaDailyReminderService.js';
import StockAnalysis from '../models/stockAnalysis.js';
import triggerOrderService from '../services/triggerOrderService.js';
import upstoxMarketTimingService from '../services/upstoxMarketTiming.service.js';
import UpstoxUser from '../models/upstoxUser.js';
import { decrypt } from '../utils/encryption.js';

const router = express.Router();

/**
 * @route POST /api/monitoring/start
 * @desc Start monitoring triggers for an analysis using Agenda
 * @access Private
 */
router.post('/start', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, strategyId, frequencySeconds = 60 } = req.body;
        
        console.log(`🚀 [AGENDA] Start monitoring request from user ${userId}:`, {
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
        
        // Start monitoring with Agenda
        const result = await agendaMonitoringService.startMonitoring(
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
        console.error('❌ [AGENDA] Start monitoring error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_start_error',
            message: 'Failed to start monitoring'
        });
    }
});

/**
 * @route POST /api/monitoring/stop
 * @desc Stop monitoring triggers for an analysis using Agenda
 * @access Private
 */
router.post('/stop', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, strategyId } = req.body;
        
        console.log(`🛑 [AGENDA] STOP MONITORING API REQUEST:`);
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
        
        // Stop monitoring with Agenda
        console.log(`🔄 Calling agendaMonitoringService.stopMonitoring...`);
        const result = await agendaMonitoringService.stopMonitoring(analysisId, strategyId);
        console.log(`📤 Stop monitoring result:`, result);
        
        if (result.success) {
            console.log(`✅ [AGENDA] STOP MONITORING SUCCESS: ${result.message}`);
            res.json({
                success: true,
                message: result.message
            });
        } else {
            console.log(`❌ [AGENDA] STOP MONITORING FAILED: ${result.message}`);
            res.status(400).json({
                success: false,
                error: 'monitoring_stop_failed',
                message: result.message
            });
        }
        
    } catch (error) {
        console.error('❌ [AGENDA] Stop monitoring error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_stop_error',
            message: 'Failed to stop monitoring'
        });
    }
});

/**
 * @route GET /api/monitoring/status/:analysisId
 * @desc Get monitoring status for an analysis using Agenda
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
        
        console.log(`📊 [AGENDA] GET MONITORING STATUS API CALLED for analysis: ${analysisId}`);
        console.log(`📋 Analysis has ${analysis.analysis_data?.strategies?.length || 0} strategies`);
        
        // Get monitoring status for each strategy in the analysis
        const strategies = analysis.analysis_data?.strategies || [];
        const strategyStatuses = {};
        let hasAnyActiveMonitoring = false;
        
        console.log(`🔍 Checking status for each strategy:`);
        
        // Check monitoring status for each strategy
        for (const strategy of strategies) {
            console.log(`\n🎯 Getting status for strategy ${strategy.id}:`);
            const strategyStatus = await agendaMonitoringService.getMonitoringStatus(analysisId, strategy.id);
            strategyStatuses[strategy.id] = strategyStatus;
            
            console.log(`   ✓ Strategy ${strategy.id} monitoring: ${strategyStatus.isMonitoring}`);
            console.log(`   ✓ State: ${strategyStatus.state || 'none'}`);
            
            if (strategyStatus.isMonitoring) {
                hasAnyActiveMonitoring = true;
            }
        }
        
        // Also get analysis-level status for backward compatibility
        console.log(`\n📊 Getting analysis-level status for backward compatibility:`);
        const analysisStatus = await agendaMonitoringService.getMonitoringStatus(analysisId);
        
        console.log(`📤 [AGENDA] API RESPONSE SUMMARY:`);
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
                active_monitoring_count: Object.values(strategyStatuses).filter(s => s.isMonitoring).length,
                
                // Agenda-specific info
                monitoring_engine: 'agenda'
            }
        });
        
    } catch (error) {
        console.error('❌ [AGENDA] Get monitoring status error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_status_error',
            message: 'Failed to get monitoring status'
        });
    }
});

/**
 * @route GET /api/monitoring/active
 * @desc Get all active monitoring jobs for the current user using Agenda
 * @access Private
 */
router.get('/active', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        // Get all active jobs from Agenda
        const allJobs = await agendaMonitoringService.getActiveJobs();
        
        // Filter jobs for this user and enrich with analysis data
        const userJobs = [];
        for (const job of allJobs) {
            if (job.userId === userId) {
                const analysis = await StockAnalysis.findById(job.analysisId);
                if (analysis) {
                    userJobs.push({
                        ...job,
                        stock_symbol: analysis.stock_symbol,
                        analysis_type: analysis.analysis_type
                    });
                }
            }
        }
        
        res.json({
            success: true,
            data: userJobs,
            count: userJobs.length,
            monitoring_engine: 'agenda'
        });
        
    } catch (error) {
        console.error('❌ [AGENDA] Get active monitoring jobs error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_active_error',
            message: 'Failed to get active monitoring jobs'
        });
    }
});

/**
 * @route POST /api/monitoring/pause
 * @desc Pause monitoring for an analysis using Agenda
 * @access Private
 */
router.post('/pause', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, strategyId, reason = 'manual' } = req.body;
        
        console.log(`⏸️ [AGENDA] Pause monitoring request from user ${userId}:`, {
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
        const result = await agendaMonitoringService.pauseMonitoring(analysisId, strategyId, reason);
        
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
        console.error('❌ [AGENDA] Pause monitoring error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_pause_error',
            message: 'Failed to pause monitoring'
        });
    }
});

/**
 * @route POST /api/monitoring/resume
 * @desc Resume paused monitoring for an analysis using Agenda
 * @access Private
 */
router.post('/resume', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, strategyId } = req.body;
        
        console.log(`▶️ [AGENDA] Resume monitoring request from user ${userId}:`, {
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
        const result = await agendaMonitoringService.resumeMonitoring(analysisId, strategyId, userId);
        
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
        console.error('❌ [AGENDA] Resume monitoring error:', error);
        res.status(500).json({
            success: false,
            error: 'monitoring_resume_error',
            message: 'Failed to resume monitoring'
        });
    }
});

/**
 * @route POST /api/monitoring/send-reminder
 * @desc Send manual re-authentication reminder to user using Agenda
 * @access Private
 */
router.post('/send-reminder', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { type = 'reauth_required' } = req.body;
        
        console.log(`📧 [AGENDA] Manual reminder request from user ${userId}, type: ${type}`);
        
        const result = await agendaDailyReminderService.sendManualReminder(userId, type);
        
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
        console.error('❌ [AGENDA] Send manual reminder error:', error);
        res.status(500).json({
            success: false,
            error: 'reminder_error',
            message: 'Failed to send reminder'
        });
    }
});

/**
 * @route GET /api/monitoring/reminder-stats
 * @desc Get daily reminder service statistics using Agenda
 * @access Private (Admin only)
 */
router.get('/reminder-stats', authenticateToken, async (req, res) => {
    try {
        // Note: In production, add admin check here
        // if (!req.user.isAdmin) return res.status(403).json({...})
        
        const stats = await agendaDailyReminderService.getReminderStats();
        
        res.json({
            success: true,
            data: {
                ...stats,
                timestamp: new Date().toISOString(),
                service_status: 'running',
                reminder_engine: 'agenda'
            }
        });
        
    } catch (error) {
        console.error('❌ [AGENDA] Get reminder stats error:', error);
        res.status(500).json({
            success: false,
            error: 'reminder_stats_error',
            message: 'Failed to get reminder statistics'
        });
    }
});

/**
 * @route GET /api/monitoring/health
 * @desc Check monitoring service health for Agenda
 * @access Public
 */
router.get('/health', async (req, res) => {
    try {
        const activeJobs = await agendaMonitoringService.getActiveJobs();
        const reminderStats = await agendaDailyReminderService.getReminderStats();
        
        res.json({
            success: true,
            message: 'Agenda monitoring service is running',
            timestamp: new Date().toISOString(),
            active_jobs: activeJobs.length,
            monitoring_engine: 'agenda',
            reminder_engine: 'agenda',
            reminder_stats: reminderStats,
            mongodb_connected: true // If we got here, MongoDB is working
        });
    } catch (error) {
        res.status(503).json({
            success: false,
            message: 'Agenda monitoring service health check failed',
            error: error.message,
            monitoring_engine: 'agenda'
        });
    }
});

export default router;