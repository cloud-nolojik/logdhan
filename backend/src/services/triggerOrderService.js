import axios from 'axios';
import * as upstoxService from './upstox.service.js';
import { decrypt } from '../utils/encryption.js';

/**
 * Service to check trigger conditions and place orders when conditions are met
 */

class TriggerOrderService {
    /**
     * Check if trigger conditions are met (ONLY CHECK, DON'T PLACE ORDER)
     * @param {Object} analysis - The stock analysis document
     * @param {string} accessToken - Upstox access token
     * @returns {Object} - Result of trigger check only
     */
    async checkTriggerConditions(analysis, accessToken) {
        try {
            console.log(`🔍 Checking triggers for ${analysis.stock_symbol} (${analysis._id})`);
            
            // 1. Get current market data
            const currentMarketData = await this.getCurrentMarketData(analysis.instrument_key, accessToken);
            
            // 2. Evaluate trigger conditions
            const triggerResult = await this.evaluateTriggers(analysis, currentMarketData);
            
            // 3. Check for invalidation conditions
            const invalidationResult = await this.checkInvalidations(analysis, currentMarketData);
            
            if (invalidationResult.hasInvalidations) {
                return {
                    success: false,
                    triggersConditionsMet: false,
                    reason: 'invalidations_hit',
                    message: 'Pre-entry invalidation conditions triggered',
                    data: {
                        analysis_id: analysis._id,
                        current_price: currentMarketData.current_price,
                        all_triggers_passed: triggerResult.allTriggersTrue,
                        triggers: triggerResult.triggers,
                        invalidations: invalidationResult.invalidations,
                        should_monitor: false // Don't monitor if invalidated
                    }
                };
            }
            
            if (!triggerResult.allTriggersTrue) {
                // Triggers not met - need monitoring
                return {
                    success: false,
                    triggersConditionsMet: false,
                    reason: 'triggers_not_met',
                    message: 'Entry conditions not yet satisfied',
                    data: {
                        analysis_id: analysis._id,
                        current_price: currentMarketData.current_price,
                        all_triggers_passed: false,
                        triggers: triggerResult.triggers,
                        failed_triggers: triggerResult.triggers.filter(t => !t.passed),
                        should_monitor: true, // Start monitoring
                        monitoring_frequency: this.getMonitoringFrequency(analysis)
                    }
                };
            }
            
            // 4. All conditions met - ready to place order
            console.log(`✅ All trigger conditions satisfied for ${analysis.stock_symbol}`);
            
            return {
                success: true,
                triggersConditionsMet: true,
                reason: 'conditions_met',
                message: 'All trigger conditions satisfied - ready to place order',
                data: {
                    analysis_id: analysis._id,
                    current_price: currentMarketData.current_price,
                    all_triggers_passed: true,
                    triggers: triggerResult.triggers,
                    should_monitor: false // No monitoring needed
                }
            };
            
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
     * Get current market data from Upstox
     */
    async getCurrentMarketData(instrumentKey, accessToken) {
        try {
            const response = await axios.get(
                `https://api.upstox.com/v2/market-quote/ltp?instrument_key=${instrumentKey}`,
                {
                    headers: {
                        'Api-Version': '2.0',
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept': 'application/json'
                    }
                }
            );
            
            const data = response.data.data[instrumentKey];
            return {
                current_price: data.last_price,
                timestamp: new Date().toISOString(),
                instrument_key: instrumentKey
            };
        } catch (error) {
            console.error('❌ Error fetching market data:', error);
            throw new Error('Failed to fetch current market data');
        }
    }
    
    /**
     * Evaluate all trigger conditions
     */
    async evaluateTriggers(analysis, marketData) {
        const strategy = analysis.analysis_data.strategies[0];
        const triggers = strategy.triggers || [];
        const currentPrice = marketData.current_price;
        
        const evaluatedTriggers = triggers.map(trigger => {
            let passed = false;
            let leftValue = null;
            let rightValue = null;
            
            // Get left side value
            if (trigger.left.ref === 'price') {
                leftValue = currentPrice;
            }
            // Add more left side references as needed (close, high, low, etc.)
            
            // Get right side value
            if (trigger.right.ref === 'entry') {
                rightValue = strategy.entry;
            } else if (trigger.right.ref === 'value') {
                rightValue = trigger.right.value;
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
                timeframe: trigger.timeframe,
                condition: `${trigger.left.ref} ${trigger.op} ${trigger.right.ref}`,
                left_value: leftValue,
                right_value: rightValue,
                passed: passed,
                evaluable: leftValue !== null && rightValue !== null
            };
        });
        
        const allTriggersTrue = evaluatedTriggers.every(t => t.passed);
        
        console.log(`📊 Trigger evaluation for ${analysis.stock_symbol}:`);
        console.log(`   Current price: ₹${currentPrice}`);
        console.log(`   All triggers passed: ${allTriggersTrue}`);
        evaluatedTriggers.forEach(t => {
            console.log(`   ${t.id}: ${t.condition} = ${t.left_value} ${t.op || '?'} ${t.right_value} → ${t.passed ? '✅' : '❌'}`);
        });
        
        return {
            allTriggersTrue,
            triggers: evaluatedTriggers,
            current_price: currentPrice
        };
    }
    
    /**
     * Check for invalidation conditions
     */
    async checkInvalidations(analysis, marketData) {
        const strategy = analysis.analysis_data.strategies[0];
        const invalidations = strategy.invalidations?.filter(inv => inv.scope === 'pre_entry') || [];
        const currentPrice = marketData.current_price;
        
        const checkedInvalidations = invalidations.map(inv => {
            let hit = false;
            let leftValue = null;
            let rightValue = null;
            
            // Get values (similar to triggers)
            if (inv.left.ref === 'close' || inv.left.ref === 'price') {
                leftValue = currentPrice;
            }
            
            if (inv.right.ref === 'value') {
                rightValue = inv.right.value;
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
     * Get monitoring frequency based on trigger timeframes
     */
    getMonitoringFrequency(analysis) {
        const strategy = analysis.analysis_data.strategies[0];
        const triggers = strategy.triggers || [];
        
        // Find the shortest timeframe for most frequent checks
        let shortestTimeframe = '15m'; // Default
        
        triggers.forEach(trigger => {
            if (trigger.timeframe === '1m') shortestTimeframe = '1m';
            else if (trigger.timeframe === '5m' && shortestTimeframe !== '1m') shortestTimeframe = '5m';
            else if (trigger.timeframe === '15m' && !['1m', '5m'].includes(shortestTimeframe)) shortestTimeframe = '15m';
        });
        
        const frequencyMap = {
            '1m': { interval_seconds: 60, description: 'every 1 minute' },
            '5m': { interval_seconds: 300, description: 'every 5 minutes' }, 
            '15m': { interval_seconds: 900, description: 'every 15 minutes' },
            '1h': { interval_seconds: 3600, description: 'every hour' }
        };
        
        return frequencyMap[shortestTimeframe] || frequencyMap['15m'];
    }
}

export default new TriggerOrderService();