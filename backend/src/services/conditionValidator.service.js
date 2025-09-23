import { getCurrentPrice } from '../utils/stock.js';
import * as upstoxService from './upstox.service.js';

class ConditionValidatorService {
    
    /**
     * Fetch real-time market data for condition validation
     */
    async fetchRealTimeMarketData(instrumentToken, accessToken) {
        try {
            console.log(`🔍 Fetching real-time data for ${instrumentToken}`);
            
            // Get current price
            const currentPrice = await getCurrentPrice(instrumentToken);
            
            // Get latest candle data from Upstox
            const candleData = await this.getLatestCandleData(instrumentToken, accessToken);
            
            // Get market depth (if needed for volume analysis)
            const marketDepth = await this.getMarketDepth(instrumentToken, accessToken);
            
            return {
                current_price: currentPrice,
                last: currentPrice,
                candles: candleData,
                market_depth: marketDepth,
                timestamp: new Date().toISOString()
            };
            
        } catch (error) {
            console.error('❌ Error fetching real-time market data:', error);
            throw error;
        }
    }
    
    /**
     * Get latest candle data for multiple timeframes
     */
    async getLatestCandleData(instrumentToken, accessToken) {
        try {
            const timeframes = ['1minute', '15minute', '1hour', '1day'];
            const candlePromises = timeframes.map(async (interval) => {
                try {
                    const candles = await upstoxService.getCandleData(
                        instrumentToken,
                        interval,
                        accessToken,
                        10 // Get last 10 candles for trend analysis
                    );
                    return {
                        timeframe: interval,
                        data: candles.data || [],
                        latest: candles.data?.[candles.data.length - 1] || null
                    };
                } catch (error) {
                    console.warn(`⚠️ Failed to get ${interval} candles:`, error.message);
                    return { timeframe: interval, data: [], latest: null };
                }
            });
            
            const results = await Promise.all(candlePromises);
            const candleData = {};
            
            results.forEach(result => {
                candleData[result.timeframe] = result;
            });
            
            return candleData;
            
        } catch (error) {
            console.error('❌ Error getting candle data:', error);
            return {};
        }
    }
    
    /**
     * Get market depth data
     */
    async getMarketDepth(instrumentToken, accessToken) {
        try {
            const depth = await upstoxService.getMarketDepth(instrumentToken, accessToken);
            return depth.data || null;
        } catch (error) {
            console.warn('⚠️ Failed to get market depth:', error.message);
            return null;
        }
    }
    
    /**
     * Validate entry conditions using real-time market data
     */
    async validateConditionsRealTime(analysis, accessToken) {
        try {
            console.log(`🔍 Validating conditions for ${analysis.instrument_key}`);
            
            // Get real-time market data
            const marketData = await this.fetchRealTimeMarketData(
                analysis.instrument_key,
                accessToken
            );
            
            const runtime = analysis.analysis_data?.runtime;
            if (!runtime?.triggers_evaluated) {
                return {
                    valid: false,
                    reason: 'No triggers to validate',
                    realtime_data: marketData
                };
            }
            
            // Evaluate each trigger with real-time data
            const evaluatedTriggers = [];
            let allTriggersPass = true;
            
            for (const trigger of runtime.triggers_evaluated) {
                const evaluation = await this.evaluateTriggerRealTime(trigger, marketData);
                evaluatedTriggers.push(evaluation);
                
                if (!evaluation.passed) {
                    allTriggersPass = false;
                }
            }
            
            // Check for pre-entry invalidations
            const invalidationCheck = await this.checkPreEntryInvalidations(
                analysis.analysis_data?.strategies?.[0]?.invalidations || [],
                marketData
            );
            
            const result = {
                valid: allTriggersPass && !invalidationCheck.hit,
                all_triggers_pass: allTriggersPass,
                invalidations_hit: invalidationCheck.hit,
                reason: this.getValidationReason(allTriggersPass, invalidationCheck),
                triggers: evaluatedTriggers,
                invalidations: invalidationCheck.details,
                realtime_data: {
                    current_price: marketData.current_price,
                    timestamp: marketData.timestamp,
                    latest_candles: this.extractLatestCandles(marketData.candles)
                },
                order_gate: {
                    can_place_order: allTriggersPass && !invalidationCheck.hit,
                    all_triggers_true: allTriggersPass,
                    no_pre_entry_invalidations: !invalidationCheck.hit,
                    actionability_status: allTriggersPass && !invalidationCheck.hit ? 'actionable_now' : 'actionable_on_trigger'
                }
            };
            
            console.log(`✅ Real-time validation result:`, {
                valid: result.valid,
                triggers_pass: allTriggersPass,
                invalidations_hit: invalidationCheck.hit
            });
            
            return result;
            
        } catch (error) {
            console.error('❌ Error validating conditions:', error);
            return {
                valid: false,
                reason: `Validation error: ${error.message}`,
                error: true
            };
        }
    }
    
    /**
     * Evaluate a single trigger against real-time data
     */
    async evaluateTriggerRealTime(trigger, marketData) {
        try {
            const leftValue = this.resolveDataReference(trigger.left_ref, marketData);
            const rightValue = this.resolveDataReference(trigger.right_ref, marketData, trigger.right_value);
            
            if (leftValue === null || rightValue === null) {
                return {
                    ...trigger,
                    passed: false,
                    evaluable: false,
                    current_left_value: leftValue,
                    current_right_value: rightValue,
                    reason: 'Missing required data'
                };
            }
            
            const passed = this.evaluateCondition(leftValue, trigger.op, rightValue);
            
            return {
                ...trigger,
                passed,
                evaluable: true,
                current_left_value: leftValue,
                current_right_value: rightValue,
                reason: `${leftValue} ${trigger.op} ${rightValue} = ${passed}`
            };
            
        } catch (error) {
            console.error(`❌ Error evaluating trigger ${trigger.id}:`, error);
            return {
                ...trigger,
                passed: false,
                evaluable: false,
                reason: error.message
            };
        }
    }
    
    /**
     * Resolve data references to actual values from market data
     */
    resolveDataReference(ref, marketData, fallbackValue = null) {
        try {
            // Handle different reference types
            switch (ref) {
                case 'close':
                case 'price':
                case 'last':
                    return marketData.current_price;
                    
                case 'high':
                    return marketData.candles?.['1minute']?.latest?.[2] || // High from 1min candle
                           marketData.current_price;
                           
                case 'low':
                    return marketData.candles?.['1minute']?.latest?.[3] || // Low from 1min candle
                           marketData.current_price;
                           
                case 'volume':
                    return marketData.candles?.['1minute']?.latest?.[5] || 0; // Volume from 1min candle
                    
                // Handle timeframe-specific references
                case 'close_15m':
                    return marketData.candles?.['15minute']?.latest?.[4]; // Close from 15min candle
                    
                case 'high_15m':
                    return marketData.candles?.['15minute']?.latest?.[2]; // High from 15min candle
                    
                case 'close_1h':
                    return marketData.candles?.['1hour']?.latest?.[4]; // Close from 1hour candle
                    
                case 'close_1D':
                    return marketData.candles?.['1day']?.latest?.[4]; // Close from daily candle
                    
                // Handle static values
                case 'value':
                    return fallbackValue;
                    
                // Handle technical indicators (would need to be calculated)
                case 'ema20_1D':
                case 'ema50_1D':
                case 'sma200_1D':
                case 'rsi14_1h':
                    console.warn(`⚠️ Technical indicator ${ref} not implemented yet`);
                    return null;
                    
                default:
                    console.warn(`⚠️ Unknown reference: ${ref}`);
                    return fallbackValue;
            }
        } catch (error) {
            console.error(`❌ Error resolving reference ${ref}:`, error);
            return null;
        }
    }
    
    /**
     * Evaluate condition based on operator
     */
    evaluateCondition(left, operator, right) {
        switch (operator) {
            case '>':
                return left > right;
            case '>=':
                return left >= right;
            case '<':
                return left < right;
            case '<=':
                return left <= right;
            case '==':
            case '=':
                return Math.abs(left - right) < 0.01; // Allow small floating point differences
            case '!=':
                return Math.abs(left - right) >= 0.01;
            case 'crosses_above':
                // This would need historical data to determine crossing
                console.warn('⚠️ crosses_above operator requires historical analysis');
                return left > right; // Fallback to simple comparison
            case 'crosses_below':
                console.warn('⚠️ crosses_below operator requires historical analysis');
                return left < right; // Fallback to simple comparison
            default:
                console.warn(`⚠️ Unknown operator: ${operator}`);
                return false;
        }
    }
    
    /**
     * Check pre-entry invalidation conditions
     */
    async checkPreEntryInvalidations(invalidations, marketData) {
        const hitInvalidations = [];
        
        for (const invalidation of invalidations) {
            if (invalidation.scope !== 'pre_entry') continue;
            
            try {
                const leftValue = this.resolveDataReference(invalidation.left?.ref, marketData);
                const rightValue = this.resolveDataReference(
                    invalidation.right?.ref, 
                    marketData, 
                    invalidation.right?.value
                );
                
                if (leftValue !== null && rightValue !== null) {
                    const conditionMet = this.evaluateCondition(leftValue, invalidation.op, rightValue);
                    
                    if (conditionMet) {
                        hitInvalidations.push({
                            ...invalidation,
                            current_left_value: leftValue,
                            current_right_value: rightValue
                        });
                    }
                }
            } catch (error) {
                console.error('❌ Error checking invalidation:', error);
            }
        }
        
        return {
            hit: hitInvalidations.length > 0,
            details: hitInvalidations
        };
    }
    
    /**
     * Get validation reason
     */
    getValidationReason(allTriggersPass, invalidationCheck) {
        if (invalidationCheck.hit) {
            return `Pre-entry invalidation hit: ${invalidationCheck.details.map(inv => inv.action).join(', ')}`;
        }
        if (!allTriggersPass) {
            return 'One or more entry triggers not satisfied';
        }
        return 'All conditions validated';
    }
    
    /**
     * Extract latest candle info for logging
     */
    extractLatestCandles(candles) {
        const latest = {};
        Object.keys(candles || {}).forEach(timeframe => {
            const candleData = candles[timeframe];
            if (candleData?.latest) {
                latest[timeframe] = {
                    timestamp: candleData.latest[0],
                    open: candleData.latest[1],
                    high: candleData.latest[2],
                    low: candleData.latest[3],
                    close: candleData.latest[4],
                    volume: candleData.latest[5]
                };
            }
        });
        return latest;
    }
}

export default new ConditionValidatorService();