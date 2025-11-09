import axios from 'axios';
// COMMENTED OUT: Upstox service import - using WhatsApp notifications instead
// import * as upstoxService from './upstox.service.js';
import { decrypt } from '../utils/encryption.js';
import { getCurrentPrice } from '../utils/stockDb.js';
// UPDATED: Using candleFetcher.service.js for better DB+API merge strategy
import candleFetcherService from './candleFetcher.service.js';
import advancedTriggerEngine from './advancedTriggerEngine.js';

/**
 * Service to check trigger conditions and place orders when conditions are met
 */

class TriggerOrderService {
    /**
     * Check if trigger conditions are met with smart timing
     * @param {Object} analysis - The stock analysis document
     * @param {Date} currentTime - Current time for smart trigger filtering
     * @returns {Object} - Result of trigger check only
     */
    async checkTriggerConditionsWithTiming(analysis, currentTime = new Date()) {
        return this.checkTriggerConditions(analysis, currentTime);
    }

    /**
     * Check if trigger conditions are met (ONLY CHECK, DON'T PLACE ORDER)
     * @param {Object} analysis - The stock analysis document
     * @param {Date} currentTime - Current time for smart trigger filtering (optional)
     * @returns {Object} - Result of trigger check only
     */
    async checkTriggerConditions(analysis, currentTime = null) {
        try {
            console.log(`\n${'▼'.repeat(80)}`);
            console.log(`🔍 [TRIGGER SERVICE] checkTriggerConditions() - START`);
            console.log(`${'▼'.repeat(80)}`);
            console.log(`📊 Analysis Details:`);
            console.log(`   ├─ Stock: ${analysis.stock_symbol}`);
            console.log(`   ├─ Analysis ID: ${analysis._id}`);
            console.log(`   └─ Current Time: ${currentTime ? currentTime.toISOString() : 'Not specified'}\n`);
            
            // Extract strategy with all conditions
            console.log(`🔍 [STEP 1] Extracting strategy from analysis...`);
            const strategy = analysis.analysis_data.strategies[0];

            if (!strategy) {
                console.log(`❌ [STEP 1] FAILED - No strategy found`);
                console.log(`   └─ User Action: Run AI analysis to generate strategy\n`);
                console.log(`${'▲'.repeat(80)}\n`);
                return {
                    success: false,
                    triggersConditionsMet: false,
                    reason: 'no_strategy',
                    message: 'No trading strategy found. Please run AI analysis to generate a strategy.',
                    data: {
                        analysis_id: analysis._id,
                        stock_symbol: analysis.stock_symbol,
                        should_monitor: false,
                        user_action_required: 'Run AI analysis to generate trading strategy'
                    }
                };
            }

            console.log(`✅ [STEP 1] Strategy found`);
            console.log(`   ├─ Strategy ID: ${strategy.id}`);
            console.log(`   ├─ Type: ${strategy.type || 'N/A'}`);
            console.log(`   ├─ Entry: ₹${strategy.entry}`);
            console.log(`   ├─ Stop Loss: ₹${strategy.stopLoss}`);
            console.log(`   ├─ Target: ₹${strategy.target}`);
            console.log(`   └─ Triggers: ${strategy.triggers?.length || 0}\n`);
            
            // Check if triggers exist and are properly configured
            console.log(`🔍 [STEP 2] Validating triggers configuration...`);

            if (!strategy.triggers || strategy.triggers.length === 0) {
                console.log(`❌ [STEP 2] FAILED - No triggers configured`);
                console.log(`   └─ User Action: Rerun analysis with proper entry conditions\n`);
                console.log(`${'▲'.repeat(80)}\n`);
                return {
                    success: false,
                    triggersConditionsMet: false,
                    reason: 'no_triggers',
                    message: 'No entry conditions (triggers) defined. The strategy needs specific conditions like price levels or indicators to know when to enter the trade.',
                    data: {
                        analysis_id: analysis._id,
                        stock_symbol: analysis.stock_symbol,
                        strategy_id: strategy.id,
                        should_monitor: false,
                        user_action_required: 'Rerun analysis with proper entry conditions or add triggers manually',
                        example_triggers: [
                            'Price crosses above moving average',
                            'RSI reaches oversold level',
                            'Price breaks resistance level'
                        ]
                    }
                };
            }
            
            // Validate trigger structure
            const invalidTriggers = [];
            for (const trigger of strategy.triggers) {
                const issues = [];
                
                if (!trigger.left || !trigger.left.ref) {
                    issues.push('Missing left side reference (what to compare)');
                }
                if (!trigger.op) {
                    issues.push('Missing operator (how to compare: >, <, >=, <=, ==)');
                }
                if (!trigger.right || (!trigger.right.ref && trigger.right.value === undefined)) {
                    issues.push('Missing right side value or reference (what to compare against)');
                }
                if (!trigger.timeframe) {
                    issues.push('Missing timeframe (15m, 1h, 1d)');
                }
                
                if (issues.length > 0) {
                    invalidTriggers.push({
                        trigger_id: trigger.id || 'unknown',
                        issues: issues
                    });
                }
            }
            
            if (invalidTriggers.length > 0) {
                console.log(`❌ [STEP 2] FAILED - Invalid trigger configuration detected`);
                console.log(`   └─ Invalid Triggers: ${invalidTriggers.length}\n`);
                invalidTriggers.forEach((inv, idx) => {
                    console.log(`   ${idx + 1}. Trigger ${inv.trigger_id}:`);
                    inv.issues.forEach(issue => console.log(`      - ${issue}`));
                });
                console.log(`${'▲'.repeat(80)}\n`);
                return {
                    success: false,
                    triggersConditionsMet: false,
                    reason: 'invalid_triggers',
                    message: 'Some entry conditions are not properly configured. Each condition needs: what to check (like price/RSI), how to compare (>/</=), and what value to compare against.',
                    data: {
                        analysis_id: analysis._id,
                        stock_symbol: analysis.stock_symbol,
                        strategy_id: strategy.id,
                        invalid_triggers: invalidTriggers,
                        should_monitor: false,
                        user_action_required: 'Fix trigger configuration or regenerate strategy',
                        help_text: 'Example: "When price > 3500" needs: left=price, op=>, right=3500, timeframe=1d'
                    }
                };
            }

            // Check if critical strategy parameters exist
            if (!strategy.entry || strategy.entry <= 0) {
                return {
                    success: false,
                    triggersConditionsMet: false,
                    reason: 'missing_entry_price',
                    message: 'Entry price not defined. The strategy needs to know at what price to buy/sell.',
                    data: {
                        analysis_id: analysis._id,
                        stock_symbol: analysis.stock_symbol,
                        strategy_id: strategy.id,
                        should_monitor: false,
                        user_action_required: 'Set entry price in strategy or regenerate analysis'
                    }
                };
            }
            
            if (!strategy.stopLoss || strategy.stopLoss <= 0) {
                return {
                    success: false,
                    triggersConditionsMet: false,
                    reason: 'missing_stoploss',
                    message: 'Stop loss not defined. This is required for risk management to limit potential losses.',
                    data: {
                        analysis_id: analysis._id,
                        stock_symbol: analysis.stock_symbol,
                        strategy_id: strategy.id,
                        entry_price: strategy.entry,
                        should_monitor: false,
                        user_action_required: 'Set stop loss price in strategy',
                        risk_warning: 'Trading without stop loss is extremely risky'
                    }
                };
            }
            
            if (!strategy.target || strategy.target <= 0) {
                return {
                    success: false,
                    triggersConditionsMet: false,
                    reason: 'missing_target',
                    message: 'Target price not defined. The strategy needs to know when to book profits.',
                    data: {
                        analysis_id: analysis._id,
                        stock_symbol: analysis.stock_symbol,
                        strategy_id: strategy.id,
                        entry_price: strategy.entry,
                        stop_loss: strategy.stopLoss,
                        should_monitor: false,
                        user_action_required: 'Set target price in strategy'
                    }
                };
            }
            
            console.log(`✅ [STEP 2] All triggers are valid\n`);

            // Initialize session for advanced trigger engine
            console.log(`🔍 [STEP 3] Initializing advanced trigger engine session...`);
            advancedTriggerEngine.initializeSession(analysis._id.toString(), strategy);
            console.log(`✅ [STEP 3] Session initialized\n`);

            // Smart trigger filtering based on current time
            console.log(`🔍 [STEP 4] Smart trigger filtering based on timeframes...`);
            let triggersToCheck = strategy.triggers || [];
            console.log(`   └─ Total Triggers: ${triggersToCheck.length}\n`);
            
            if (currentTime) {
                const currentMinute = currentTime.getMinutes();
                const currentHour = currentTime.getHours();
                
                // Filter triggers based on timing relevance
                const relevantTriggers = triggersToCheck.filter(trigger => {
                    const timeframe = trigger.timeframe?.toLowerCase() || '15m';
                    return true; 
                    // switch(timeframe) {
                    //     case '1m':
                    //         return true; // Always check 1-minute triggers
                    //     case '5m':
                    //         return currentMinute % 5 === 0; // Check every 5 minutes
                    //     case '15m':
                    //         return currentMinute % 15 != 0; // Check every 15 minutes
                    //     case '30m':
                    //         return currentMinute % 30 === 0; // Check every 30 minutes
                    //     case '1h':
                    //     case '60m':
                    //         return currentMinute === 0; // Check only at hour boundaries
                    //     case '1d':
                    //     case 'day':
                    //         return currentMinute === 15 && currentHour === 9; // Check at market open (9:15 AM)
                    //     default:
                    //         return true; // Default: check all unknown timeframes
                    // }
                });
                
                console.log(`⏰ Trigger filtering: ${triggersToCheck.length} total, ${relevantTriggers.length} relevant at ${currentTime.toLocaleTimeString('en-US', {timeZone: 'Asia/Kolkata'})}`);
                console.log(`📋 Relevant triggers: ${relevantTriggers.map(t => `${t.timeframe || '15m'}`).join(', ')}`);
                
                // If no triggers are relevant at this time, return "continue monitoring"
                if (relevantTriggers.length === 0) {
                    return {
                        success: false,
                        triggersConditionsMet: false,
                        reason: 'no_relevant_triggers_at_this_time',
                        message: `No triggers need evaluation at ${currentTime.toLocaleTimeString('en-US', {timeZone: 'Asia/Kolkata'})}. Next check will evaluate relevant timeframes.`,
                        data: {
                            analysis_id: analysis._id,
                            current_time: currentTime.toISOString(),
                            total_triggers: triggersToCheck.length,
                            relevant_triggers: relevantTriggers.length,
                            should_monitor: true,
                            monitoring_frequency: this.getMonitoringFrequency(analysis),
                            smart_monitoring_enabled: true,
                            next_relevant_check: this.getNextRelevantCheckTime(triggersToCheck, currentTime)
                        }
                    };
                }
                
                triggersToCheck = relevantTriggers;
            }
            
            // Get market data for all required timeframes (even if not all triggers are being checked)
            console.log(`🔍 [STEP 5] Fetching market data for all timeframes...`);
            const allTriggers = strategy.triggers || [];
            console.log(`   ├─ Instrument Key: ${analysis.instrument_key}`);
            console.log(`   └─ Required Timeframes: ${[...new Set(allTriggers.map(t => t.timeframe || '15m'))].join(', ')}\n`);

            const marketData = await candleFetcherService.getMarketDataForTriggers(analysis.instrument_key, allTriggers);

            if (!marketData.current_price) {
                console.log(`❌ [STEP 5] FAILED - Unable to fetch market data`);
                console.log(`${'▲'.repeat(80)}\n`);
                throw new Error('Unable to fetch market data');
            }

            console.log(`✅ [STEP 5] Market data fetched successfully`);
            console.log(`   ├─ Current Price: ₹${marketData.current_price}`);
            console.log(`   └─ Timeframes Available: ${Object.keys(marketData.timeframes).join(', ')}\n`);
            
            // Create a temporary strategy with only the relevant triggers for evaluation
            const tempStrategy = {
                ...strategy.toObject(),
                triggers: triggersToCheck
            };
            
            // Use advanced trigger engine for comprehensive checking
            console.log(`🔍 [STEP 6] Evaluating triggers with advanced trigger engine...`);
            console.log(`   ├─ Analysis ID: ${analysis._id.toString()}`);
            console.log(`   ├─ Strategy ID: ${tempStrategy.id}`);
            console.log(`   ├─ Triggers to Check: ${triggersToCheck.length}`);
            console.log(`   └─ Calling advancedTriggerEngine.checkTriggers()...\n`);

            const engineResult = await advancedTriggerEngine.checkTriggers(
                analysis._id.toString(),
                tempStrategy,
                marketData.timeframes
            );

            console.log(`📊 [STEP 6] Advanced trigger engine result:`);
            console.log(`   ├─ Action: ${engineResult.action}`);
            console.log(`   ├─ Success: ${engineResult.success ? 'YES ✅' : 'NO ❌'}`);
            console.log(`   ├─ Reason: ${engineResult.reason || 'N/A'}`);
            console.log(`   └─ Triggers Checked: ${engineResult.triggers?.length || 0}\n`);

            // Handle different actions from the advanced engine
            console.log(`🔍 [STEP 7] Processing engine result - Action: ${engineResult.action}`);
            switch (engineResult.action) {
                case 'cancel_monitoring':
                    console.log(`❌ [STEP 7] Result: CANCEL MONITORING`);
                    console.log(`   ├─ Reason: ${engineResult.reason}`);
                    console.log(`   └─ Expired Trigger: ${engineResult.expired_trigger || 'N/A'}\n`);
                    console.log(`${'▲'.repeat(80)}\n`);
                    return {
                        success: false,
                        triggersConditionsMet: false,
                        reason: engineResult.reason,
                        message: engineResult.reason,
                        data: {
                            analysis_id: analysis._id,
                            current_price: marketData.current_price,
                            should_monitor: false,
                            expired_trigger: engineResult.expired_trigger,
                            session: engineResult.session
                        }
                    };

                case 'cancel_entry':
                    console.log(`❌ [STEP 7] Result: CANCEL ENTRY (Pre-entry invalidation)`);
                    console.log(`   ├─ Reason: ${engineResult.reason}`);
                    console.log(`   └─ Invalidation: ${JSON.stringify(engineResult.invalidation || {})}\n`);
                    console.log(`${'▲'.repeat(80)}\n`);
                    return {
                        success: false,
                        triggersConditionsMet: false,
                        reason: 'invalidation_triggered',
                        message: `Pre-entry invalidation: ${engineResult.reason}`,
                        data: {
                            analysis_id: analysis._id,
                            current_price: marketData.current_price,
                            should_monitor: false,
                            invalidation: engineResult.invalidation
                        }
                    };

                case 'close_position':
                    console.log(`❌ [STEP 7] Result: CLOSE POSITION (Post-entry invalidation)`);
                    console.log(`   ├─ Reason: ${engineResult.reason}`);
                    console.log(`   └─ Invalidation: ${JSON.stringify(engineResult.invalidation || {})}\n`);
                    console.log(`${'▲'.repeat(80)}\n`);
                    return {
                        success: false,
                        triggersConditionsMet: false,
                        reason: 'position_closure_required',
                        message: `Post-entry invalidation: ${engineResult.reason}`,
                        data: {
                            analysis_id: analysis._id,
                            current_price: marketData.current_price,
                            should_monitor: false,
                            invalidation: engineResult.invalidation
                        }
                    };

                case 'execute_order':
                    console.log(`✅✅✅ [STEP 7] Result: EXECUTE ORDER - ALL CONDITIONS MET! ✅✅✅`);
                    console.log(`   ├─ Stock: ${analysis.stock_symbol}`);
                    console.log(`   ├─ Current Price: ₹${marketData.current_price}`);
                    console.log(`   └─ All Triggers Passed: YES\n`);
                    if (engineResult.triggers) {
                        console.log(`📋 Trigger States:`);
                        engineResult.triggers.forEach((t, idx) => {
                            console.log(`   ${idx + 1}. ${t.condition || t.id}: ${t.satisfied ? '✅ PASSED' : '❌ FAILED'}`);
                        });
                        console.log(``);
                    }
                    console.log(`${'▲'.repeat(80)}\n`);
                    return {
                        success: true,
                        triggersConditionsMet: true,
                        reason: 'conditions_met',
                        message: 'All trigger conditions satisfied - ready to place order',
                        data: {
                            analysis_id: analysis._id,
                            current_price: marketData.current_price,
                            all_triggers_passed: true,
                            triggers: engineResult.triggers,
                            warnings: engineResult.warnings,
                            session: engineResult.session,
                            should_monitor: false
                        }
                    };

                case 'continue_monitoring':
                default:
                    console.log(`⏳ [STEP 7] Result: CONTINUE MONITORING - Conditions not yet met`);
                    console.log(`   ├─ Current Price: ₹${marketData.current_price}`);
                    console.log(`   ├─ Triggers Passed: ${engineResult.triggers?.filter(t => t.satisfied).length || 0}/${engineResult.triggers?.length || 0}`);
                    console.log(`   └─ Action: Continue monitoring\n`);

                    const failedTriggers = engineResult.triggers?.filter(t => !t.satisfied) || [];
                    if (failedTriggers.length > 0) {
                        console.log(`📊 Failed Triggers (${failedTriggers.length}):`);
                        failedTriggers.forEach((t, idx) => {
                            console.log(`   ${idx + 1}. ${t.condition || t.id}`);
                            console.log(`      ├─ Left Value: ${t.left_value || 'N/A'}`);
                            console.log(`      ├─ Operator: ${t.op || 'N/A'}`);
                            console.log(`      ├─ Right Value: ${t.right_value || 'N/A'}`);
                            console.log(`      └─ Status: ❌ NOT SATISFIED`);
                        });
                        console.log(``);
                    }

                    if (engineResult.warnings && engineResult.warnings.length > 0) {
                        console.log(`⚠️  Warnings (${engineResult.warnings.length}):`);
                        engineResult.warnings.forEach((w, idx) => {
                            console.log(`   ${idx + 1}. [${w.severity}] ${w.code}: ${w.text}`);
                        });
                        console.log(``);
                    }

                    console.log(`${'▲'.repeat(80)}\n`);

                    return {
                        success: false,
                        triggersConditionsMet: false,
                        reason: 'triggers_not_met',
                        message: 'Entry conditions not yet satisfied',
                        data: {
                            analysis_id: analysis._id,
                            current_price: marketData.current_price,
                            all_triggers_passed: false,
                            triggers: engineResult.triggers,
                            warnings: engineResult.warnings,
                            session: engineResult.session,
                            failed_triggers: failedTriggers,
                            should_monitor: true,
                            monitoring_frequency: this.getMonitoringFrequency(analysis)
                        }
                    };
            }
            
        } catch (error) {
            console.error(`❌ Error checking triggers for ${analysis.stock_symbol}:`, error);
            return {
                success: false,
                triggersConditionsMet: false,
                reason: 'error',
                message: error.message,
                data: {
                    analysis_id: analysis._id,
                    error: error.message,
                    should_monitor: false
                }
            };
        }
    }
    

    
    /**
     * Evaluate all trigger conditions with timeframe-specific data
     */
    async evaluateTriggers(analysis, marketData) {
        const strategy = analysis.analysis_data.strategies[0];
        const triggers = strategy.triggers || [];
        
        const evaluatedTriggers = triggers.map(trigger => {
            let passed = false;
            let leftValue = null;
            let rightValue = null;
            
            // Get the appropriate candle data for this trigger's timeframe
            const timeframe = trigger.timeframe || '1m';
            const normalizedTimeframe = timeframe.toLowerCase().replace('day', '1d');
            const candleData = marketData.timeframes[normalizedTimeframe];
            
            // Debug: Log available timeframes and data structure
            if (!candleData) {
                console.log(`⚠️ No candle data for timeframe ${timeframe} (normalized: ${normalizedTimeframe})`);
                console.log(`Available timeframes: ${Object.keys(marketData.timeframes).join(', ')}`);
            } else {
                console.log(`📊 Found ${timeframe} data with keys: ${Object.keys(candleData).join(', ')}`);
            }
            
            // Get left side value based on trigger reference
            const leftRef = trigger.left.ref?.toLowerCase() || '';
            
            // Basic OHLC values
            if (leftRef === 'price' || leftRef === 'close' || leftRef === 'current_price') {
                leftValue = candleData ? candleData.close : marketData.current_price;
            } else if (leftRef === 'high') {
                leftValue = candleData ? candleData.high : marketData.current_price;
            } else if (leftRef === 'low') {
                leftValue = candleData ? candleData.low : marketData.current_price;
            } else if (leftRef === 'open') {
                leftValue = candleData ? candleData.open : marketData.current_price;
            } else if (leftRef === 'volume') {
                leftValue = candleData ? candleData.volume : null;
            }
            // Technical indicators - now check if they're calculated
            else if (leftRef.startsWith('ema') || leftRef.includes('ema')) {
                // EMA indicators (e.g., ema20, ema_20, ema20_1d)
                // Try multiple variations of the indicator key
                const baseRef = trigger.left.ref.toLowerCase();
                const possibleKeys = [
                    baseRef,                                    // ema20_1d
                    baseRef.replace(/_/g, ''),                 // ema201d
                    baseRef.replace('_1d', ''),               // ema20
                    baseRef.replace('_' + timeframe, ''),     // remove timeframe suffix
                    'ema20',                                   // standard ema20
                    'ema50'                                    // standard ema50
                ];
                
                leftValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        leftValue = candleData[key];
                        console.log(`✅ Found EMA indicator ${key} = ${leftValue} for ${trigger.left.ref}`);
                        break;
                    }
                }
                
                if (leftValue === null || leftValue === undefined) {
                    console.log(`⚠️ EMA indicator ${trigger.left.ref} not found in ${timeframe} data`);
                    console.log(`   Tried keys: ${possibleKeys.join(', ')}`);
                    if (candleData) {
                        console.log(`   Available indicator keys: ${Object.keys(candleData).filter(k => k.includes('ema')).join(', ')}`);
                    }
                }
            } else if (leftRef.startsWith('sma') || leftRef.includes('sma')) {
                // SMA indicators - try multiple variations
                const baseRef = trigger.left.ref.toLowerCase();
                const possibleKeys = [
                    baseRef,                                    // sma20_1d
                    baseRef.replace(/_/g, ''),                 // sma201d
                    baseRef.replace('_1d', ''),               // sma20
                    baseRef.replace('_' + timeframe, ''),     // remove timeframe suffix
                    'sma20',                                   // standard sma20
                    'sma50'                                    // standard sma50
                ];
                
                leftValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        leftValue = candleData[key];
                        console.log(`✅ Found SMA indicator ${key} = ${leftValue} for ${trigger.left.ref}`);
                        break;
                    }
                }
                
                if (leftValue === null || leftValue === undefined) {
                    console.log(`⚠️ SMA indicator ${trigger.left.ref} not found in ${timeframe} data`);
                    console.log(`   Tried keys: ${possibleKeys.join(', ')}`);
                    if (candleData) {
                        console.log(`   Available SMA keys: ${Object.keys(candleData).filter(k => k.includes('sma')).join(', ')}`);
                    }
                }
            } else if (leftRef.startsWith('rsi') || leftRef.includes('rsi')) {
                // RSI indicator - try multiple variations
                const baseRef = trigger.left.ref.toLowerCase();
                const possibleKeys = [
                    baseRef,                                    // rsi_14, rsi14_1d
                    baseRef.replace(/_/g, ''),                 // rsi14
                    baseRef.replace('_1d', ''),               // rsi14
                    baseRef.replace('_' + timeframe, ''),     // remove timeframe suffix
                    'rsi',                                     // standard rsi
                    'rsi14'                                    // standard rsi14
                ];
                
                leftValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        leftValue = candleData[key];
                        console.log(`✅ Found RSI indicator ${key} = ${leftValue} for ${trigger.left.ref}`);
                        break;
                    }
                }
                
                if (leftValue === null || leftValue === undefined) {
                    console.log(`⚠️ RSI indicator ${trigger.left.ref} not found in ${timeframe} data`);
                    console.log(`   Tried keys: ${possibleKeys.join(', ')}`);
                    if (candleData) {
                        console.log(`   Available RSI keys: ${Object.keys(candleData).filter(k => k.includes('rsi')).join(', ')}`);
                    }
                }
            } else if (leftRef.startsWith('macd') || leftRef.includes('macd')) {
                // MACD indicator - determine which component
                const baseRef = trigger.left.ref.toLowerCase();
                let targetKeys = [];
                
                if (baseRef.includes('signal')) {
                    targetKeys = ['macd_signal', 'macdsignal', 'macd.signal'];
                } else if (baseRef.includes('histogram')) {
                    targetKeys = ['macd_histogram', 'macdhistogram', 'macd.histogram'];
                } else {
                    targetKeys = ['macd', 'macd_line', 'macdline'];
                }
                
                leftValue = null;
                for (const key of targetKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        leftValue = candleData[key];
                        console.log(`✅ Found MACD indicator ${key} = ${leftValue} for ${trigger.left.ref}`);
                        break;
                    }
                }
                
                if (leftValue === null || leftValue === undefined) {
                    console.log(`⚠️ MACD indicator ${trigger.left.ref} not found in ${timeframe} data`);
                    console.log(`   Tried keys: ${targetKeys.join(', ')}`);
                    if (candleData) {
                        console.log(`   Available MACD keys: ${Object.keys(candleData).filter(k => k.includes('macd')).join(', ')}`);
                    }
                }
            } else if (leftRef === 'vwap' || leftRef.includes('vwap')) {
                // VWAP indicator - try variations
                const possibleKeys = ['vwap', 'vwap_1d', 'vwap1d', trigger.left.ref.toLowerCase()];
                
                leftValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        leftValue = candleData[key];
                        console.log(`✅ Found VWAP indicator ${key} = ${leftValue} for ${trigger.left.ref}`);
                        break;
                    }
                }
                
                if (leftValue === null || leftValue === undefined) {
                    console.log(`⚠️ VWAP indicator ${trigger.left.ref} not found in ${timeframe} data`);
                    console.log(`   Tried keys: ${possibleKeys.join(', ')}`);
                    if (candleData) {
                        console.log(`   Available VWAP keys: ${Object.keys(candleData).filter(k => k.includes('vwap')).join(', ')}`);
                    }
                }
            } else if (leftRef.includes('bollinger') || leftRef.includes('bb')) {
                // Bollinger Bands - determine which band
                const baseRef = trigger.left.ref.toLowerCase();
                let targetKeys = [];
                
                if (baseRef.includes('upper')) {
                    targetKeys = ['bb_upper', 'bollinger_upper', 'bbup', 'bb.upper'];
                } else if (baseRef.includes('lower')) {
                    targetKeys = ['bb_lower', 'bollinger_lower', 'bblow', 'bb.lower'];
                } else if (baseRef.includes('middle') || baseRef.includes('mid')) {
                    targetKeys = ['bb_middle', 'bollinger_middle', 'bbmid', 'bb.middle'];
                } else {
                    // Default to middle band
                    targetKeys = ['bb_middle', 'bollinger_middle', 'bbmid'];
                }
                
                leftValue = null;
                for (const key of targetKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        leftValue = candleData[key];
                        console.log(`✅ Found Bollinger Band ${key} = ${leftValue} for ${trigger.left.ref}`);
                        break;
                    }
                }
                
                if (leftValue === null || leftValue === undefined) {
                    console.log(`⚠️ Bollinger Band ${trigger.left.ref} not found in ${timeframe} data`);
                    console.log(`   Tried keys: ${targetKeys.join(', ')}`);
                    if (candleData) {
                        console.log(`   Available BB keys: ${Object.keys(candleData).filter(k => k.includes('bb') || k.includes('bollinger')).join(', ')}`);
                    }
                }
            } else if (leftRef.includes('stoch') || leftRef.includes('stochastic')) {
                // Stochastic oscillator - determine K or D
                const baseRef = trigger.left.ref.toLowerCase();
                let targetKeys = [];
                
                if (baseRef.includes('_k') || baseRef.includes('k')) {
                    targetKeys = ['stochastic_k', 'stoch_k', 'stochk', 'stoch.k'];
                } else if (baseRef.includes('_d') || baseRef.includes('d')) {
                    targetKeys = ['stochastic_d', 'stoch_d', 'stochd', 'stoch.d'];
                } else {
                    // Default to K
                    targetKeys = ['stochastic_k', 'stoch_k', 'stochk'];
                }
                
                leftValue = null;
                for (const key of targetKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        leftValue = candleData[key];
                        console.log(`✅ Found Stochastic ${key} = ${leftValue} for ${trigger.left.ref}`);
                        break;
                    }
                }
                
                if (leftValue === null || leftValue === undefined) {
                    console.log(`⚠️ Stochastic indicator ${trigger.left.ref} not found in ${timeframe} data`);
                    console.log(`   Tried keys: ${targetKeys.join(', ')}`);
                    if (candleData) {
                        console.log(`   Available Stoch keys: ${Object.keys(candleData).filter(k => k.includes('stoch')).join(', ')}`);
                    }
                }
            } else if (leftRef === 'atr' || leftRef.includes('atr')) {
                // Average True Range - try variations
                const possibleKeys = ['atr', 'atr14', 'atr_14', trigger.left.ref.toLowerCase()];
                
                leftValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        leftValue = candleData[key];
                        console.log(`✅ Found ATR indicator ${key} = ${leftValue} for ${trigger.left.ref}`);
                        break;
                    }
                }
                
                if (leftValue === null || leftValue === undefined) {
                    console.log(`⚠️ ATR indicator ${trigger.left.ref} not found in ${timeframe} data`);
                    console.log(`   Tried keys: ${possibleKeys.join(', ')}`);
                    if (candleData) {
                        console.log(`   Available ATR keys: ${Object.keys(candleData).filter(k => k.includes('atr')).join(', ')}`);
                    }
                }
            } else if (leftRef === 'adx' || leftRef.includes('adx')) {
                // Average Directional Index - try variations
                const possibleKeys = ['adx', 'adx14', 'adx_14', trigger.left.ref.toLowerCase()];
                
                leftValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        leftValue = candleData[key];
                        console.log(`✅ Found ADX indicator ${key} = ${leftValue} for ${trigger.left.ref}`);
                        break;
                    }
                }
                
                if (leftValue === null || leftValue === undefined) {
                    console.log(`⚠️ ADX indicator ${trigger.left.ref} not found in ${timeframe} data`);
                    console.log(`   Tried keys: ${possibleKeys.join(', ')}`);
                    if (candleData) {
                        console.log(`   Available ADX keys: ${Object.keys(candleData).filter(k => k.includes('adx')).join(', ')}`);
                    }
                }
            } else if (trigger.left.ref) {
                // Unknown reference type
                console.log(`⚠️ Unknown trigger reference: ${trigger.left.ref}`);
                leftValue = null;
            }
            
            // Get right side value
            const rightRef = trigger.right.ref?.toLowerCase() || '';
            
            if (rightRef === 'entry' || rightRef === 'entry_price') {
                rightValue = strategy.entry;
            } else if (rightRef === 'value' || rightRef === 'constant') {
                rightValue = trigger.right.value;
            } else if (rightRef === 'stoploss' || rightRef === 'sl') {
                rightValue = strategy.stopLoss;
            } else if (rightRef === 'target' || rightRef === 'tp') {
                rightValue = strategy.target;
            }
            // Handle same indicator types as left side
            else if (rightRef === 'price' || rightRef === 'close' || rightRef === 'current_price') {
                rightValue = candleData ? candleData.close : marketData.current_price;
            } else if (rightRef === 'high') {
                rightValue = candleData ? candleData.high : marketData.current_price;
            } else if (rightRef === 'low') {
                rightValue = candleData ? candleData.low : marketData.current_price;
            } else if (rightRef === 'open') {
                rightValue = candleData ? candleData.open : marketData.current_price;
            } else if (rightRef === 'volume') {
                rightValue = candleData ? candleData.volume : null;
            }
            // Technical indicators on right side - now check if they're calculated
            else if (rightRef.startsWith('ema') || rightRef.includes('ema')) {
                // EMA indicators - try multiple variations
                const baseRef = trigger.right.ref.toLowerCase();
                const possibleKeys = [
                    baseRef,                                    // ema50_1d
                    baseRef.replace(/_/g, ''),                 // ema501d
                    baseRef.replace('_1d', ''),               // ema50
                    baseRef.replace('_' + timeframe, ''),     // remove timeframe suffix
                    'ema20',                                   // standard ema20
                    'ema50'                                    // standard ema50
                ];
                
                rightValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        rightValue = candleData[key];
                        console.log(`✅ Found EMA indicator ${key} = ${rightValue} for ${trigger.right.ref}`);
                        break;
                    }
                }
                
                if (rightValue === null || rightValue === undefined) {
                    console.log(`⚠️ EMA indicator ${trigger.right.ref} not found in ${timeframe} data`);
                    console.log(`   Tried keys: ${possibleKeys.join(', ')}`);
                    if (candleData) {
                        console.log(`   Available indicator keys: ${Object.keys(candleData).filter(k => k.includes('ema')).join(', ')}`);
                    }
                }
            } else if (rightRef.startsWith('sma') || rightRef.includes('sma')) {
                // SMA indicators - try multiple variations (same as left side)
                const baseRef = trigger.right.ref.toLowerCase();
                const possibleKeys = [
                    baseRef, baseRef.replace(/_/g, ''), baseRef.replace('_1d', ''),
                    baseRef.replace('_' + timeframe, ''), 'sma20', 'sma50'
                ];
                
                rightValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        rightValue = candleData[key];
                        console.log(`✅ Found SMA indicator ${key} = ${rightValue} for ${trigger.right.ref}`);
                        break;
                    }
                }
                
                if (rightValue === null || rightValue === undefined) {
                    console.log(`⚠️ SMA indicator ${trigger.right.ref} not found in ${timeframe} data`);
                }
            // Apply same robust lookup for all other right-side indicators
            } else if (rightRef.startsWith('rsi') || rightRef.includes('rsi')) {
                const possibleKeys = ['rsi', 'rsi14', 'rsi_14', trigger.right.ref.toLowerCase()];
                rightValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        rightValue = candleData[key];
                        break;
                    }
                }
            } else if (rightRef.startsWith('macd') || rightRef.includes('macd')) {
                const baseRef = trigger.right.ref.toLowerCase();
                let targetKeys = [];
                if (baseRef.includes('signal')) targetKeys = ['macd_signal', 'macdsignal'];
                else if (baseRef.includes('histogram')) targetKeys = ['macd_histogram', 'macdhistogram'];
                else targetKeys = ['macd', 'macd_line'];
                
                rightValue = null;
                for (const key of targetKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        rightValue = candleData[key];
                        break;
                    }
                }
            } else if (rightRef === 'vwap' || rightRef.includes('vwap')) {
                const possibleKeys = ['vwap', 'vwap_1d', 'vwap1d'];
                rightValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        rightValue = candleData[key];
                        break;
                    }
                }
            } else if (rightRef.includes('bollinger') || rightRef.includes('bb')) {
                const baseRef = trigger.right.ref.toLowerCase();
                let targetKeys = [];
                if (baseRef.includes('upper')) targetKeys = ['bb_upper', 'bollinger_upper'];
                else if (baseRef.includes('lower')) targetKeys = ['bb_lower', 'bollinger_lower'];
                else targetKeys = ['bb_middle', 'bollinger_middle'];
                
                rightValue = null;
                for (const key of targetKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        rightValue = candleData[key];
                        break;
                    }
                }
            } else if (rightRef.includes('stoch') || rightRef.includes('stochastic')) {
                const baseRef = trigger.right.ref.toLowerCase();
                let targetKeys = [];
                if (baseRef.includes('_k') || baseRef.includes('k')) targetKeys = ['stochastic_k', 'stoch_k'];
                else targetKeys = ['stochastic_d', 'stoch_d'];
                
                rightValue = null;
                for (const key of targetKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        rightValue = candleData[key];
                        break;
                    }
                }
            } else if (rightRef === 'atr' || rightRef.includes('atr')) {
                const possibleKeys = ['atr', 'atr14', 'atr_14'];
                rightValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        rightValue = candleData[key];
                        break;
                    }
                }
            } else if (rightRef === 'adx' || rightRef.includes('adx')) {
                const possibleKeys = ['adx', 'adx14', 'adx_14'];
                rightValue = null;
                for (const key of possibleKeys) {
                    if (candleData && candleData[key] !== undefined) {
                        rightValue = candleData[key];
                        break;
                    }
                }
            } else if (trigger.right.ref) {
                console.log(`⚠️ Unknown trigger reference: ${trigger.right.ref}`);
                rightValue = null;
            }
            
            // Evaluate the condition
            if (leftValue !== null && rightValue !== null) {
                switch (trigger.op) {
                    case '>=':
                        passed = leftValue >= rightValue;
                        break;
                    case '>':
                        passed = leftValue > rightValue;
                        break;
                    case '<=':
                        passed = leftValue <= rightValue;
                        break;
                    case '<':
                        passed = leftValue < rightValue;
                        break;
                    case '==':
                    case '=':
                        passed = Math.abs(leftValue - rightValue) < 0.01; // Allow small tolerance
                        break;
                    default:
                        passed = false;
                }
            }
            
            return {
                id: trigger.id,
                timeframe: trigger.timeframe || '1m',
                condition: `${trigger.left.ref} ${trigger.op} ${trigger.right.ref}`,
                left_value: leftValue,
                right_value: rightValue,
                passed: passed,
                evaluable: leftValue !== null && rightValue !== null,
                candle_used: timeframe
            };
        });
        
        const allTriggersTrue = evaluatedTriggers.every(t => t.passed);
        
        console.log(`📊 Trigger evaluation for ${analysis.stock_symbol}:`);
        console.log(`   Current price: ₹${marketData.current_price}`);
        console.log(`   All triggers passed: ${allTriggersTrue}`);
        evaluatedTriggers.forEach(t => {
            const candleInfo = t.candle_used !== '1m' ? ` (${t.candle_used} candle)` : '';
            console.log(`   ${t.id}: ${t.condition}${candleInfo} = ${t.left_value} vs ${t.right_value} → ${t.passed ? '✅' : '❌'}`);
        });
        
        return {
            allTriggersTrue,
            triggers: evaluatedTriggers,
            current_price: marketData.current_price
        };
    }
    
    /**
     * Check for invalidation conditions
     */
    async checkInvalidations(analysis, marketData) {
        const strategy = analysis.analysis_data.strategies[0];
        const invalidations = strategy.invalidations?.filter(inv => inv.scope === 'pre_entry') || [];
        
        const checkedInvalidations = invalidations.map(inv => {
            let hit = false;
            let leftValue = null;
            let rightValue = null;
            
            // Get the appropriate candle data for this invalidation's timeframe
            const timeframe = inv.timeframe || '1m';
            const candleData = marketData.timeframes[timeframe.toLowerCase()] || marketData.timeframes['1m'];
            
            // Get values based on timeframe-specific candle data
            if (inv.left.ref === 'close' || inv.left.ref === 'price') {
                leftValue = candleData ? candleData.close : marketData.current_price;
            } else if (inv.left.ref === 'high') {
                leftValue = candleData ? candleData.high : marketData.current_price;
            } else if (inv.left.ref === 'low') {
                leftValue = candleData ? candleData.low : marketData.current_price;
            } else if (inv.left.ref && inv.left.ref.startsWith('ema')) {
                // Handle EMA indicators for invalidations
                console.log(`⚠️ Indicator ${inv.left.ref} not yet calculated for invalidation check`);
                leftValue = null;
            }
            
            if (inv.right.ref === 'value') {
                rightValue = inv.right.value;
            } else if (inv.right.ref && inv.right.ref.startsWith('ema')) {
                // Handle EMA indicators on right side
                console.log(`⚠️ Indicator ${inv.right.ref} not yet calculated for invalidation check`);
                rightValue = null;
            }
            
            // Evaluate invalidation
            if (leftValue !== null && rightValue !== null) {
                switch (inv.op) {
                    case '<=':
                        hit = leftValue <= rightValue;
                        break;
                    case '<':
                        hit = leftValue < rightValue;
                        break;
                    case '>=':
                        hit = leftValue >= rightValue;
                        break;
                    case '>':
                        hit = leftValue > rightValue;
                        break;
                }
            }
            
            return {
                scope: inv.scope,
                condition: `${inv.left.ref} ${inv.op} ${inv.right.ref}`,
                left_value: leftValue,
                right_value: rightValue,
                hit: hit,
                action: inv.action
            };
        });
        
        const hasInvalidations = checkedInvalidations.some(inv => inv.hit);
        
        return {
            hasInvalidations,
            invalidations: checkedInvalidations
        };
    }
    
    /**
     * Get monitoring frequency based on trigger timeframes (SMART VERSION)
     */
    getMonitoringFrequency(analysis) {
        const strategy = analysis.analysis_data.strategies[0];
        const triggers = strategy.triggers || [];
        
        // Find the GCD (Greatest Common Divisor) of all timeframe intervals
        // This ensures we check at optimal intervals for all triggers
        const timeframeMinutes = [];
        
        triggers.forEach(trigger => {
            const timeframe = trigger.timeframe?.toLowerCase() || '15m';
            switch(timeframe) {
                case '1m': timeframeMinutes.push(1); break;
                case '5m': timeframeMinutes.push(5); break;
                case '15m': timeframeMinutes.push(15); break;
                case '30m': timeframeMinutes.push(30); break;
                case '1h':
                case '60m': timeframeMinutes.push(60); break;
                case '1d':
                case 'day': timeframeMinutes.push(1440); break; // 24 hours = 1440 minutes
                default: timeframeMinutes.push(15); // Default to 15 minutes
            }
        });
        
        // Find GCD of all timeframes, but cap at reasonable limits
        let gcdMinutes = timeframeMinutes.length > 0 ? 
            timeframeMinutes.reduce((a, b) => this.gcd(a, b)) : 15;
            
        // Practical limits: minimum 1 minute, maximum 15 minutes for monitoring frequency
        gcdMinutes = Math.max(1, Math.min(gcdMinutes, 15));
        
        console.log(`📋 Trigger timeframes: ${triggers.map(t => t.timeframe || '15m').join(', ')}`);
        console.log(`🔢 Calculated GCD interval: ${gcdMinutes} minutes`);
        
        const frequencyMap = {
            1: { interval_seconds: 60, description: 'every 1 minute', timeframe: '1m' },
            5: { interval_seconds: 300, description: 'every 5 minutes', timeframe: '5m' },
            15: { interval_seconds: 900, description: 'every 15 minutes', timeframe: '15m' }
        };
        
        const selectedFrequency = frequencyMap[gcdMinutes] || {
            interval_seconds: gcdMinutes * 60,
            description: `every ${gcdMinutes} minutes`,
            timeframe: `${gcdMinutes}m`
        };
        
        // Add max attempts calculation
        const marketSecondsPerDay = 7 * 60 * 60; // 7 hours
        const totalMarketSeconds = marketSecondsPerDay * 5; // 5 trading days
        selectedFrequency.maxAttempts = Math.floor(totalMarketSeconds / selectedFrequency.interval_seconds);
        selectedFrequency.smart_monitoring = true; // Flag to indicate smart monitoring
        
        return selectedFrequency;
    }
    
    /**
     * Calculate Greatest Common Divisor (GCD) of two numbers
     */
    gcd(a, b) {
        return b === 0 ? a : this.gcd(b, a % b);
    }
    
    /**
     * Get next time when triggers will be relevant for checking
     * @param {Array} triggers - Array of trigger objects
     * @param {Date} currentTime - Current time
     * @returns {Object} - Next relevant check time info
     */
    getNextRelevantCheckTime(triggers, currentTime) {
        const now = new Date(currentTime);
        const nextChecks = [];
        
        triggers.forEach(trigger => {
            const timeframe = trigger.timeframe?.toLowerCase() || '15m';
            const nextCheck = new Date(now);
            
            switch(timeframe) {
                case '1m':
                    nextCheck.setMinutes(now.getMinutes() + 1, 0, 0);
                    break;
                case '5m':
                    const next5Min = Math.ceil(now.getMinutes() / 5) * 5;
                    nextCheck.setMinutes(next5Min, 0, 0);
                    if (nextCheck <= now) nextCheck.setMinutes(nextCheck.getMinutes() + 5);
                    break;
                case '15m':
                    const next15Min = Math.ceil(now.getMinutes() / 15) * 15;
                    nextCheck.setMinutes(next15Min, 0, 0);
                    if (nextCheck <= now) nextCheck.setMinutes(nextCheck.getMinutes() + 15);
                    break;
                case '30m':
                    const next30Min = Math.ceil(now.getMinutes() / 30) * 30;
                    nextCheck.setMinutes(next30Min, 0, 0);
                    if (nextCheck <= now) nextCheck.setMinutes(nextCheck.getMinutes() + 30);
                    break;
                case '1h':
                case '60m':
                    nextCheck.setHours(now.getHours() + 1, 0, 0, 0);
                    break;
                case '1d':
                case 'day':
                    nextCheck.setDate(now.getDate() + 1);
                    nextCheck.setHours(9, 15, 0, 0); // Next day market open
                    break;
                default:
                    nextCheck.setMinutes(now.getMinutes() + 15, 0, 0);
            }
            
            nextChecks.push({
                timeframe,
                nextCheck: nextCheck.toISOString(),
                minutesFromNow: Math.ceil((nextCheck - now) / (1000 * 60))
            });
        });
        
        // Return the earliest next check
        const earliest = nextChecks.reduce((min, check) => 
            new Date(check.nextCheck) < new Date(min.nextCheck) ? check : min
        );
        
        return {
            next_check_time: earliest.nextCheck,
            timeframe: earliest.timeframe,
            minutes_from_now: earliest.minutesFromNow,
            all_next_checks: nextChecks
        };
    }
}

export default new TriggerOrderService();