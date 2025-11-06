import express from 'express';
import { auth as authenticateToken } from '../middleware/auth.js';
import agendaMonitoringService from '../services/agendaMonitoringService.js';
import agendaDailyReminderService from '../services/agendaDailyReminderService.js';
import agendaDataPrefetchService from '../services/agendaDataPrefetchService.js';
import StockAnalysis from '../models/stockAnalysis.js';
import triggerOrderService from '../services/triggerOrderService.js';

const router = express.Router();

/**
 * @route POST /api/monitoring/start
 * @desc Start monitoring triggers for an analysis using Agenda
 * @access Private
 */
router.post('/start', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, frequencySeconds = 60 } = req.body;

        console.log(`\n${'='.repeat(80)}`);
        console.log(`🚀 [START MONITORING] Request received`);
        console.log(`${'='.repeat(80)}`);
        console.log(`📋 Request Details:`);
        console.log(`   ├─ User ID: ${userId}`);
        console.log(`   ├─ Analysis ID: ${analysisId}`);
        console.log(`   ├─ Frequency: ${frequencySeconds}s`);
        console.log(`   └─ Timestamp: ${new Date().toISOString()}`);
        console.log(`${'='.repeat(80)}\n`);

        // Validate input
        if (!analysisId) {
            return res.status(400).json({
                success: false,
                error: 'invalid_request',
                message: 'Analysis ID is required'
            });
        }
        
        // Validate frequency (minimum 30 seconds, maximum 1 hour)
        if (frequencySeconds < 30 || frequencySeconds > 3600) {
            console.log(`❌ [VALIDATION] Invalid frequency: ${frequencySeconds}s (must be 30-3600s)`);
            return res.status(400).json({
                success: false,
                error: 'invalid_frequency',
                message: 'Frequency must be between 30 seconds and 1 hour'
            });
        }

        // Verify analysis exists and belongs to user
        console.log(`🔍 [VALIDATION] Step 1: Fetching analysis document...`);
        const analysis = await StockAnalysis.findById(analysisId);

        if (!analysis) {
            console.log(`❌ [VALIDATION] Analysis ${analysisId} not found in database`);
            return res.status(404).json({
                success: false,
                error: 'analysis_not_found',
                message: 'Analysis not found'
            });
        }

        console.log(`✅ [VALIDATION] Analysis found: ${analysis.stock_symbol}`);
        console.log(`   ├─ Stock: ${analysis.stock_symbol}`);
        console.log(`   ├─ Instrument Key: ${analysis.instrument_key}`);
        console.log(`   ├─ Current Price: ₹${analysis.current_price || 'N/A'}`);
        console.log(`   └─ Expires At: ${analysis.expires_at || 'No expiry'}\n`);
        
        // Note: Analysis user validation removed - monitoring is user-linked, not analysis-linked
        
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
        
        // Get first strategy (top strategy) automatically
        console.log(`🔍 [VALIDATION] Step 2: Extracting trading strategy...`);
        const strategies = analysis.analysis_data?.strategies || [];

        if (strategies.length === 0) {
            console.log(`❌ [VALIDATION] No strategies found in analysis`);
            return res.status(400).json({
                success: false,
                error: 'no_strategies',
                message: 'No strategies found in analysis'
            });
        }

        const strategy = strategies[0]; // Always use first strategy
        const strategyId = strategy.id;

        console.log(`✅ [VALIDATION] Strategy found`);
        console.log(`   ├─ Strategy Type: ${strategy.type || 'N/A'}`);
        console.log(`   ├─ Strategy ID: ${strategyId}`);
        console.log(`   ├─ Entry Price: ₹${strategy.entry || 'N/A'}`);
        console.log(`   ├─ Stop Loss: ₹${strategy.stopLoss || 'N/A'}`);
        console.log(`   ├─ Target: ₹${strategy.target || 'N/A'}`);
        console.log(`   └─ Triggers Count: ${strategy.triggers?.length || 0}\n`);
        
        // Verify first strategy exists (redundant but safe)
        if (!strategy) {
            return res.status(404).json({
                success: false,
                error: 'strategy_not_found',
                message: 'No valid strategy found in analysis',
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
        
        // Check if we're in market hours
        const now = new Date();
        const istTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
        const currentHours = istTime.getHours();
        const currentMinutes = istTime.getMinutes();
        const currentTimeInMinutes = currentHours * 60 + currentMinutes;
        const marketOpen = 9 * 60 + 15;  // 9:15 AM
        const marketClose = 15 * 60 + 30; // 3:30 PM
        const dayOfWeek = istTime.getDay(); // 0 = Sunday, 6 = Saturday

        const isMarketHours = dayOfWeek >= 1 && dayOfWeek <= 5 &&
                             currentTimeInMinutes >= marketOpen &&
                             currentTimeInMinutes <= marketClose;

        // Check current trigger status first
        console.log(`🔍 [VALIDATION] Step 3: Checking initial trigger conditions...`);
        const triggerCheck = await triggerOrderService.checkTriggerConditions(analysis);

        console.log(`📊 [TRIGGER CHECK] Initial check complete`);
        console.log(`   ├─ Triggers Met: ${triggerCheck.triggersConditionsMet ? 'YES ✅' : 'NO ❌'}`);
        console.log(`   ├─ Reason: ${triggerCheck.reason || 'N/A'}`);
        console.log(`   ├─ Current Price: ₹${triggerCheck.data?.current_price || 'N/A'}`);
        console.log(`   └─ Should Monitor: ${triggerCheck.data?.should_monitor !== false ? 'YES' : 'NO'}\n`);

        // If triggers are already met, return error with user-friendly message
        if (triggerCheck.triggersConditionsMet) {
            // During market hours, this is more critical
            if (isMarketHours) {
                return res.status(200).json({
                    success: false,
                    error: 'conditions_already_met',
                    message: 'Entry conditions already met! Price has reached your trigger point.',
                    data: {
                        triggers_met: true,
                        current_price: triggerCheck.data.current_price,
                        triggers: triggerCheck.data.triggers,
                        market_status: 'open',
                        suggestion: 'Place order immediately or wait for price to come back',
                        conditions_met_at: new Date().toISOString(),
                        user_message: {
                            title: '🎯 Entry Point Reached!',
                            description: `Entry conditions were already met. Current price: ₹${triggerCheck.data.current_price}`,
                            action_button: 'Place Order Now',
                            skip_button: 'Wait for Next Opportunity'
                        }
                    }
                });
            } else {
                // Outside market hours - still return error since monitoring won't start
                return res.status(200).json({
                    success: false,
                    error: 'conditions_already_met',
                    message: 'Entry conditions already met. Order will be placed when market opens.',
                    data: {
                        triggers_met: true,
                        current_price: triggerCheck.data.current_price,
                        triggers: triggerCheck.data.triggers,
                        market_status: 'closed',
                        suggestion: 'Order will be placed automatically when market opens',
                        conditions_met_at: new Date().toISOString(),
                        user_message: {
                            title: '⚠️ Conditions Already Met',
                            description: 'Entry conditions were already satisfied. Order will be placed when market opens.',
                            action_button: 'Check Order Status',
                            skip_button: 'Generate Fresh Analysis'
                        }
                    }
                });
            }
        }

        // Additional validation for market hours - check if price moved too far
        if (isMarketHours) {
            const currentPrice = analysis.current_price;
            const entryPrice = strategy.entry;
            const priceDeviation = Math.abs((currentPrice - entryPrice) / entryPrice) * 100;

            // If price has moved more than 2% from entry, warn user
            if (priceDeviation > 2) {
                const direction = currentPrice > entryPrice ? 'above' : 'below';
                return res.status(400).json({
                    success: false,
                    error: 'price_moved_significantly',
                    message: `Price has moved ${priceDeviation.toFixed(1)}% ${direction} entry point during market hours`,
                    data: {
                        current_price: currentPrice,
                        entry_price: entryPrice,
                        deviation: priceDeviation.toFixed(2) + '%',
                        market_status: 'open',
                        suggestion: 'Consider getting fresh analysis with current market conditions'
                    },
                    user_message: {
                        title: '⚠️ Price Already Moved',
                        description: `Current price (₹${currentPrice}) is ${priceDeviation.toFixed(1)}% ${direction} your entry point (₹${entryPrice}). Market conditions may have changed.`,
                        action_button: 'Get Fresh Analysis',
                        skip_button: 'Start Monitoring Anyway'
                    }
                });
            }
        }
        
        // Start monitoring with Agenda
        console.log(`🚀 [START MONITORING] Step 4: Initializing Agenda monitoring service...`);
        console.log(`   ├─ Analysis ID: ${analysisId}`);
        console.log(`   ├─ Strategy ID: ${strategyId}`);
        console.log(`   ├─ User ID: ${userId}`);
        console.log(`   └─ Frequency: ${frequencySeconds}s\n`);

        const result = await agendaMonitoringService.startMonitoring(
            analysisId,
            strategyId,
            userId,
            { seconds: frequencySeconds },
            analysis.stock_symbol,
            analysis.instrument_key
        );

        if (result.success) {
            console.log(`✅ [START MONITORING] Monitoring successfully activated!`);
            console.log(`   ├─ Job ID: ${result.jobId}`);
            console.log(`   ├─ Stock: ${analysis.stock_symbol}`);
            console.log(`   └─ Monitoring Status: ACTIVE\n`);
            console.log(`${'='.repeat(80)}\n`);
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
                    // 🆕 NEW FIELDS for shared monitoring
                    subscription_id: result.subscription_id,
                    subscribed_users_count: result.subscribed_users_count,
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
            // 🆕 NEW: Handle blocking when conditions already met
            if (result.conditions_met_at) {
                return res.status(400).json({
                    success: false,
                    error: 'conditions_already_met',
                    message: result.message,
                    data: {
                        conditions_met_at: result.conditions_met_at,
                        user_message: {
                            title: '⚠️ Monitoring Not Available',
                            description: result.message,
                            action_button: 'Generate Fresh Analysis',
                            suggestion: 'Please wait until after 4:30 PM to generate fresh analysis with latest market data'
                        }
                    }
                });
            }

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
        
        if (!analysis) {
            return res.status(404).json({
                success: false,
                error: 'analysis_not_found',
                message: 'Analysis not found'
            });
        }
        
        // Note: Analysis user validation removed - monitoring is user-linked, not analysis-linked
        
        // Stop monitoring with Agenda (pass userId for subscription management)
        console.log(`🔄 Calling agendaMonitoringService.stopMonitoring...`);
        const result = await agendaMonitoringService.stopMonitoring(analysisId, strategyId, userId);
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
        
        if (!analysis) {
            return res.status(404).json({
                success: false,
                error: 'analysis_not_found',
                message: 'Analysis not found'
            });
        }
        
        
        
        // Get monitoring status for each strategy in the analysis
        const strategies = analysis.analysis_data?.strategies || [];
        const strategyStatuses = {};
        let hasAnyActiveMonitoring = false;
        
        
        // Check monitoring status for only the first strategy (top strategy)
        let conditionsMetCount = 0;
        if (strategies.length > 0) {
            const topStrategy = strategies[0]; // Consider only the first/top strategy
            const strategyStatus = await agendaMonitoringService.getMonitoringStatus(analysisId, topStrategy.id, userId);
            strategyStatuses[topStrategy.id] = strategyStatus;

            if (strategyStatus.isMonitoring) {
                hasAnyActiveMonitoring = true;
            }

            // Track conditions_met status
            if (strategyStatus.state === 'finished' && strategyStatus.conditions_met_at) {
                conditionsMetCount++;
            }
        }

        res.json({
            success: true,
            data: {

                isMonitoring: hasAnyActiveMonitoring, // True if any strategy is being monitored
                // New strategy-level statuses
                strategies: strategyStatuses,
                // Additional info
                stock_symbol: analysis.stock_symbol,
                analysis_type: analysis.analysis_type,
                total_strategies: strategies.length,
                active_monitoring_count: Object.values(strategyStatuses).filter(s => s.isMonitoring).length,
                conditions_met_count: conditionsMetCount, // Number of strategies where conditions were met

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
        
        if (!analysis) {
            return res.status(404).json({
                success: false,
                error: 'analysis_not_found',
                message: 'Analysis not found'
            });
        }
        
        // Note: Analysis user validation removed - monitoring is user-linked, not analysis-linked
        
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
        
        // Note: Analysis user validation removed - monitoring is user-linked, not analysis-linked
        
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

/**
 * @route POST /api/monitoring/data-prefetch/trigger
 * @desc Manually trigger data pre-fetch job
 * @access Private (Admin recommended)
 */
router.post('/data-prefetch/trigger', authenticateToken, async (req, res) => {
    try {
        const { targetDate, reason } = req.body;
        
        const result = await agendaDataPrefetchService.triggerJob('manual-data-prefetch', {
            targetDate,
            reason: reason || `Manual trigger by user ${req.user.id}`
        });
        
        res.json({
            success: true,
            message: 'Data pre-fetch job triggered successfully',
            data: result
        });
        
    } catch (error) {
        console.error('❌ Manual data pre-fetch trigger failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to trigger data pre-fetch job',
            message: error.message
        });
    }
});

/**
 * @route GET /api/monitoring/data-prefetch/stats
 * @desc Get data pre-fetch job statistics
 * @access Private (Admin recommended)
 */
router.get('/data-prefetch/stats', authenticateToken, async (req, res) => {
    try {
        const jobStats = await agendaDataPrefetchService.getJobStats();
        
        res.json({
            success: true,
            data: {
                job_statistics: jobStats,
                note: "System health monitoring removed - use manual monitoring tools"
            }
        });
        
    } catch (error) {
        console.error('❌ Data pre-fetch stats failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get data pre-fetch statistics',
            message: error.message
        });
    }
});

/**
 * @route POST /api/monitoring/data-prefetch/pause
 * @desc Pause all data pre-fetch recurring jobs
 * @access Private (Admin only)
 */
router.post('/data-prefetch/pause', authenticateToken, async (req, res) => {
    try {
        await agendaDataPrefetchService.pauseJobs();
        
        res.json({
            success: true,
            message: 'All data pre-fetch jobs paused successfully'
        });
        
    } catch (error) {
        console.error('❌ Pause data pre-fetch jobs failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to pause data pre-fetch jobs',
            message: error.message
        });
    }
});

/**
 * @route POST /api/monitoring/data-prefetch/resume
 * @desc Resume all data pre-fetch recurring jobs
 * @access Private (Admin only)
 */
router.post('/data-prefetch/resume', authenticateToken, async (req, res) => {
    try {
        await agendaDataPrefetchService.resumeJobs();
        
        res.json({
            success: true,
            message: 'All data pre-fetch jobs resumed successfully'
        });
        
    } catch (error) {
        console.error('❌ Resume data pre-fetch jobs failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to resume data pre-fetch jobs',
            message: error.message
        });
    }
});

/**
 * @route POST /api/monitoring/cleanup-stale-locks
 * @desc Manually trigger cleanup of stale order processing locks
 * @access Private (Admin recommended)
 */
router.post('/cleanup-stale-locks', authenticateToken, async (req, res) => {
    try {
        console.log(`🧹 Manual stale lock cleanup triggered by user ${req.user.id}`);
        
        const result = await agendaMonitoringService.cleanupStaleOrderProcessingLocks();
        
        res.json({
            success: true,
            message: `Stale lock cleanup completed`,
            data: {
                cleaned_count: result?.modifiedCount || 0,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (error) {
        console.error('❌ Manual stale lock cleanup failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to cleanup stale locks',
            message: error.message
        });
    }
});

/**
 * NEW BATCH MONITORING ENDPOINTS
 */

/**
 * @route GET /api/monitoring/batch-stats
 * @desc Get batch monitoring statistics and performance metrics
 * @access Private (Admin recommended)
 */
router.get('/batch-stats', authenticateToken, async (req, res) => {
    try {
        console.log(`📊 Batch monitoring stats requested by user ${req.user.id}`);
        
        const stats = await agendaMonitoringService.getBatchMonitoringStats();
        
        res.json({
            success: true,
            message: 'Batch monitoring statistics retrieved successfully',
            data: stats,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Failed to get batch monitoring stats:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get batch monitoring statistics',
            message: error.message
        });
    }
});

/**
 * @route POST /api/monitoring/batch-refresh
 * @desc Manually refresh batch configuration
 * @access Private (Admin recommended)
 */
router.post('/batch-refresh', authenticateToken, async (req, res) => {
    try {
        console.log(`🔄 Manual batch refresh triggered by user ${req.user.id}`);
        
        const result = await agendaMonitoringService.refreshBatchConfiguration();
        
        res.json({
            success: true,
            message: 'Batch configuration refreshed successfully',
            data: result,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Manual batch refresh failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to refresh batch configuration',
            message: error.message
        });
    }
});

/**
 * @route POST /api/monitoring/batch-mode
 * @desc Enable or disable batch monitoring mode
 * @access Private (Admin only)
 */
router.post('/batch-mode', authenticateToken, async (req, res) => {
    try {
        const { enabled } = req.body;
        
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({
                success: false,
                error: 'invalid_request',
                message: 'enabled parameter must be a boolean'
            });
        }
        
        console.log(`⚙️ Batch mode switch requested by user ${req.user.id}: ${enabled ? 'ENABLE' : 'DISABLE'}`);
        
        const result = await agendaMonitoringService.setBatchMode(enabled);
        
        if (result.success) {
            res.json({
                success: true,
                message: result.message,
                data: {
                    batch_mode_enabled: result.batch_mode_enabled,
                    timestamp: new Date().toISOString()
                }
            });
        } else {
            res.status(400).json({
                success: false,
                error: 'batch_mode_switch_failed',
                message: result.error
            });
        }
        
    } catch (error) {
        console.error('❌ Batch mode switch failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to switch batch mode',
            message: error.message
        });
    }
});

/**
 * @route GET /api/monitoring/architecture-info
 * @desc Get current monitoring architecture information
 * @access Private
 */
router.get('/architecture-info', authenticateToken, async (req, res) => {
    try {
        const stats = await agendaMonitoringService.getBatchMonitoringStats();
        const activeJobs = await agendaMonitoringService.getActiveJobs();
        
        // Get job distribution
        const individualJobs = activeJobs.filter(job => job.jobId && job.jobId.startsWith('monitor_'));
        const batchJobs = activeJobs.filter(job => job.jobId && job.jobId.startsWith('batch-job-'));
        
        res.json({
            success: true,
            data: {
                current_architecture: stats.batch_mode_enabled ? 'hybrid_batch' : 'individual_jobs',
                batch_mode_enabled: stats.batch_mode_enabled,
                individual_jobs_count: individualJobs.length,
                batch_jobs_count: batchJobs.length,
                total_active_batches: stats.active_batches || 0,
                performance_summary: stats.performance_summary,
                architecture_comparison: {
                    individual_jobs: {
                        description: 'One job per analysis+strategy',
                        pros: ['Simple management', 'Fine-grained control'],
                        cons: ['Job explosion with scale', 'Resource intensive']
                    },
                    hybrid_batch: {
                        description: 'Batched jobs processing multiple analyses with ALL strategies',
                        pros: ['Scalable to 1000+ stocks', 'Handles ALL strategies', 'Resource efficient'],
                        cons: ['More complex management', 'Batch-level fault isolation']
                    }
                },
                recommendation: stats.batch_mode_enabled ? 
                    '✅ Currently using optimal hybrid batch architecture' : 
                    '⚠️ Consider enabling batch mode for better scalability'
            },
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('❌ Failed to get architecture info:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get architecture information',
            message: error.message
        });
    }
});


export default router;