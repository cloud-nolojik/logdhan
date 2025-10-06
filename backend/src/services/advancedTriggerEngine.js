/**
 * Advanced Trigger Engine
 * Handles complex trigger conditions, invalidations, warnings, and session management
 */

import MarketHoursUtil from '../utils/marketHours.js';

class AdvancedTriggerEngine {
    constructor() {
        this.sessionCounters = new Map(); // Track sessions per analysis
        this.barCounters = new Map(); // Track bars per trigger per analysis
        this.triggerHistory = new Map(); // Track trigger states for consecutive checking
    }

    /**
     * Initialize monitoring session for an analysis
     */
    initializeSession(analysisId, strategy) {
        const sessionKey = `${analysisId}_${strategy.id}`;
        
        if (!this.sessionCounters.has(sessionKey)) {
            this.sessionCounters.set(sessionKey, {
                analysisId,
                strategyId: strategy.id,
                startedAt: new Date(),
                currentSession: 1,
                maxSessions: this.getMaxSessions(strategy),
                lastSessionDate: this.getCurrentTradingDate(),
                isActive: true
            });
        }

        // Initialize bar counters for each trigger
        if (strategy.triggers) {
            strategy.triggers.forEach(trigger => {
                const triggerKey = `${sessionKey}_${trigger.id}`;
                if (!this.barCounters.has(triggerKey)) {
                    this.barCounters.set(triggerKey, {
                        triggerId: trigger.id,
                        barsChecked: 0,
                        maxBars: trigger.expiry_bars || 20,
                        isExpired: false,
                        lastBarTime: null
                    });
                }
            });
        }

        console.log(`🎯 Initialized session for ${sessionKey}: Max ${this.sessionCounters.get(sessionKey).maxSessions} sessions`);
    }

    /**
     * Check if monitoring session is still valid
     */
    isSessionValid(analysisId, strategyId) {
        const sessionKey = `${analysisId}_${strategyId}`;
        const session = this.sessionCounters.get(sessionKey);
        
        if (!session || !session.isActive) {
            return { valid: false, reason: 'Session not found or inactive' };
        }

        // Check session limit
        if (session.currentSession > session.maxSessions) {
            this.expireSession(sessionKey, 'Session limit exceeded');
            return { valid: false, reason: `Session limit exceeded (${session.maxSessions} sessions)` };
        }

        // Check if new trading day started
        const currentDate = this.getCurrentTradingDate();
        if (currentDate !== session.lastSessionDate) {
            session.currentSession++;
            session.lastSessionDate = currentDate;
            console.log(`📅 New trading session ${session.currentSession}/${session.maxSessions} for ${sessionKey}`);
            
            if (session.currentSession > session.maxSessions) {
                this.expireSession(sessionKey, 'Session limit exceeded on new day');
                return { valid: false, reason: `Session limit exceeded (${session.maxSessions} sessions)` };
            }
        }

        return { valid: true, session };
    }

    /**
     * Check trigger conditions with advanced logic
     */
    async checkTriggers(analysisId, strategy, marketData) {
        const sessionKey = `${analysisId}_${strategy.id}`;
        
        // Validate session
        const sessionCheck = this.isSessionValid(analysisId, strategy.id);
        if (!sessionCheck.valid) {
            return {
                success: false,
                reason: sessionCheck.reason,
                action: 'cancel_monitoring'
            };
        }

        // Check invalidations first (can cancel monitoring)
        const invalidationResult = await this.checkInvalidations(strategy, marketData, sessionKey);
        if (invalidationResult.action === 'cancel_entry' || invalidationResult.action === 'close_position') {
            return invalidationResult;
        }

        // Check warnings
        const warnings = await this.checkWarnings(strategy, marketData);

        // Check individual triggers
        const triggerResults = [];
        let allTriggersValid = true;

        for (const trigger of strategy.triggers || []) {
            const result = await this.evaluateTrigger(trigger, marketData, sessionKey);
            triggerResults.push(result);
            
            if (!result.satisfied) {
                allTriggersValid = false;
            }
            
            // Check if trigger has expired
            if (result.expired) {
                this.expireSession(sessionKey, `Trigger ${trigger.id} expired`);
                return {
                    success: false,
                    reason: `Trigger ${trigger.id} expired after ${trigger.expiry_bars} bars`,
                    action: 'cancel_monitoring',
                    expired_trigger: trigger.id
                };
            }
        }

        return {
            success: allTriggersValid,
            triggers: triggerResults,
            warnings: warnings,
            session: sessionCheck.session,
            action: allTriggersValid ? 'execute_order' : 'continue_monitoring'
        };
    }

    /**
     * Evaluate individual trigger with bar counting and consecutive logic
     */
    async evaluateTrigger(trigger, marketData, sessionKey) {
        const triggerKey = `${sessionKey}_${trigger.id}`;
        const barCounter = this.barCounters.get(triggerKey);
        
        if (!barCounter) {
            console.error(`❌ Bar counter not found for ${triggerKey}`);
            return { satisfied: false, expired: false, error: 'Bar counter not initialized' };
        }

        if (barCounter.isExpired) {
            return { satisfied: false, expired: true, barsChecked: barCounter.barsChecked };
        }

        // Get market data for the trigger's timeframe
        const timeframeData = marketData[trigger.timeframe];
        if (!timeframeData) {
            console.error(`❌ No market data for timeframe ${trigger.timeframe}`);
            return { satisfied: false, expired: false, error: `No data for ${trigger.timeframe}` };
        }

        // Check if this is a new bar
        const currentBarTime = timeframeData.timestamp;
        const isNewBar = barCounter.lastBarTime !== currentBarTime;

        if (isNewBar) {
            barCounter.barsChecked++;
            barCounter.lastBarTime = currentBarTime;
            console.log(`📊 ${trigger.id}: Bar ${barCounter.barsChecked}/${barCounter.maxBars} (${trigger.timeframe})`);
        }

        // Check expiry
        if (barCounter.barsChecked >= barCounter.maxBars) {
            barCounter.isExpired = true;
            console.log(`⏰ ${trigger.id}: EXPIRED after ${barCounter.barsChecked} bars`);
            return { satisfied: false, expired: true, barsChecked: barCounter.barsChecked };
        }

        // Evaluate trigger condition
        const conditionMet = this.evaluateCondition(trigger, timeframeData);
        
        // Handle consecutive occurrences
        const historyKey = `${triggerKey}_history`;
        if (!this.triggerHistory.has(historyKey)) {
            this.triggerHistory.set(historyKey, []);
        }
        
        const history = this.triggerHistory.get(historyKey);
        
        // Add current result to history
        if (isNewBar) {
            history.push({
                timestamp: currentBarTime,
                satisfied: conditionMet,
                barNumber: barCounter.barsChecked
            });
            
            // Keep only relevant history
            const maxHistory = trigger.occurrences?.count || 1;
            if (history.length > maxHistory) {
                history.shift();
            }
        }

        // Check occurrences requirement
        const occurrencesSatisfied = this.checkOccurrences(trigger, history);

        console.log(`🎯 ${trigger.id}: Condition=${conditionMet}, Occurrences=${occurrencesSatisfied}, Bar=${barCounter.barsChecked}/${barCounter.maxBars}`);

        return {
            satisfied: conditionMet && occurrencesSatisfied,
            expired: false,
            barsChecked: barCounter.barsChecked,
            maxBars: barCounter.maxBars,
            conditionMet,
            occurrencesSatisfied,
            history: history.slice(-3) // Last 3 for debugging
        };
    }

    /**
     * Check invalidation conditions
     */
    async checkInvalidations(strategy, marketData, sessionKey) {
        if (!strategy.invalidations) {
            return { action: 'continue' };
        }

        for (const invalidation of strategy.invalidations) {
            const timeframeData = marketData[invalidation.timeframe];
            if (!timeframeData) continue;

            const conditionMet = this.evaluateCondition(invalidation, timeframeData);
            
            if (conditionMet) {
                console.log(`🚨 INVALIDATION TRIGGERED: ${invalidation.action} - ${invalidation.scope}`);
                
                return {
                    success: false,
                    action: invalidation.action,
                    reason: `Invalidation condition met: ${invalidation.scope}`,
                    invalidation: {
                        scope: invalidation.scope,
                        condition: `${invalidation.left.ref} ${invalidation.op} ${invalidation.right.value || invalidation.right.ref}`,
                        timeframe: invalidation.timeframe
                    }
                };
            }
        }

        return { action: 'continue' };
    }

    /**
     * Check warning conditions
     */
    async checkWarnings(strategy, marketData) {
        const activeWarnings = [];
        
        if (!strategy.warnings) {
            return activeWarnings;
        }

        for (const warning of strategy.warnings) {
            if (!warning.applies_when) continue;

            let warningApplies = true;
            
            for (const condition of warning.applies_when) {
                const timeframeData = marketData[condition.timeframe];
                if (!timeframeData) {
                    warningApplies = false;
                    break;
                }

                const conditionMet = this.evaluateCondition(condition, timeframeData);
                if (!conditionMet) {
                    warningApplies = false;
                    break;
                }
            }

            if (warningApplies) {
                console.log(`⚠️ WARNING: ${warning.code} - ${warning.text}`);
                activeWarnings.push({
                    code: warning.code,
                    severity: warning.severity,
                    text: warning.text,
                    mitigation: warning.mitigation
                });
            }
        }

        return activeWarnings;
    }

    /**
     * Evaluate a single condition
     */
    evaluateCondition(condition, timeframeData) {
        const leftValue = this.getValue(condition.left, timeframeData);
        const rightValue = this.getValue(condition.right, timeframeData);

        if (leftValue === null || rightValue === null) {
            console.error(`❌ Could not evaluate condition: left=${leftValue}, right=${rightValue}`);
            console.log(`📊 Available indicators in timeframe data:`, Object.keys(timeframeData));
            return false; // Treat as condition not met rather than error
        }

        switch (condition.op) {
            case '>=': return leftValue >= rightValue;
            case '>': return leftValue > rightValue;
            case '<=': return leftValue <= rightValue;
            case '<': return leftValue < rightValue;
            case '==': return leftValue === rightValue;
            case '!=': return leftValue !== rightValue;
            default:
                console.error(`❌ Unknown operator: ${condition.op}`);
                return false;
        }
    }

    /**
     * Get value from reference
     */
    getValue(reference, timeframeData) {
        if (reference.ref === 'value') {
            return reference.value;
        }

        // Handle special references
        if (reference.ref === 'entry' || reference.ref === 'stopLoss' || reference.ref === 'target') {
            return reference.value; // These should be provided in the reference
        }

        // Get from market data
        let value = timeframeData[reference.ref];
        
        // Handle common indicator aliases and fallbacks
        if (value === undefined) {
            // Try common fallbacks for missing indicators
            const fallbacks = {
                'rsi14_1h': 'rsi',
                'rsi14_15m': 'rsi', 
                'rsi14_1m': 'rsi',
                'ema20_1h': 'ema20',
                'ema20_15m': 'ema20',
                'ema20_1m': 'ema20',
                'ema50_1h': 'ema50',
                'ema50_15m': 'ema50',
                'ema50_1m': 'ema50'
            };
            
            const fallbackRef = fallbacks[reference.ref];
            if (fallbackRef && timeframeData[fallbackRef] !== undefined) {
                console.log(`📊 Using fallback ${fallbackRef} for missing ${reference.ref}`);
                value = timeframeData[fallbackRef];
            } else {
                console.error(`❌ Reference ${reference.ref} not found in market data (no fallback available)`);
                return null;
            }
        }

        // Apply offset if specified
        const offset = reference.offset || 0;
        return value + offset;
    }

    /**
     * Check occurrences requirement
     */
    checkOccurrences(trigger, history) {
        const requirement = trigger.occurrences || { count: 1, consecutive: true };
        
        if (history.length < requirement.count) {
            return false;
        }

        if (requirement.consecutive) {
            // Check last N entries are all satisfied
            const lastN = history.slice(-requirement.count);
            return lastN.every(entry => entry.satisfied);
        } else {
            // Check if at least N entries are satisfied
            const satisfiedCount = history.filter(entry => entry.satisfied).length;
            return satisfiedCount >= requirement.count;
        }
    }

    /**
     * Expire a monitoring session
     */
    expireSession(sessionKey, reason) {
        const session = this.sessionCounters.get(sessionKey);
        if (session) {
            session.isActive = false;
            console.log(`⏰ Session expired: ${sessionKey} - ${reason}`);
        }

        // Expire all trigger bar counters
        for (const [key, counter] of this.barCounters.entries()) {
            if (key.startsWith(sessionKey)) {
                counter.isExpired = true;
            }
        }
    }

    /**
     * Get maximum sessions from strategy
     */
    getMaxSessions(strategy) {
        if (!strategy.triggers || strategy.triggers.length === 0) {
            return 5; // Default
        }

        // Use the minimum within_sessions from all triggers
        return Math.min(...strategy.triggers.map(t => t.within_sessions || 5));
    }

    /**
     * Get current trading date (YYYY-MM-DD)
     */
    getCurrentTradingDate() {
        const now = MarketHoursUtil.toIST(new Date());
        return now.toISOString().split('T')[0];
    }

    /**
     * Clean up expired sessions and old data
     */
    cleanup() {
        const cutoffTime = Date.now() - (7 * 24 * 60 * 60 * 1000); // 7 days

        for (const [key, session] of this.sessionCounters.entries()) {
            if (!session.isActive && session.startedAt.getTime() < cutoffTime) {
                this.sessionCounters.delete(key);
                
                // Clean up related bar counters and history
                for (const counterKey of this.barCounters.keys()) {
                    if (counterKey.startsWith(key)) {
                        this.barCounters.delete(counterKey);
                    }
                }
                
                for (const historyKey of this.triggerHistory.keys()) {
                    if (historyKey.startsWith(key)) {
                        this.triggerHistory.delete(historyKey);
                    }
                }
                
                console.log(`🧹 Cleaned up expired session: ${key}`);
            }
        }
    }

    /**
     * Get session status for monitoring API
     */
    getSessionStatus(analysisId, strategyId) {
        const sessionKey = `${analysisId}_${strategyId}`;
        const session = this.sessionCounters.get(sessionKey);
        
        if (!session) {
            return { initialized: false };
        }

        const triggerStatuses = [];
        for (const [key, counter] of this.barCounters.entries()) {
            if (key.startsWith(sessionKey)) {
                triggerStatuses.push({
                    triggerId: counter.triggerId,
                    barsChecked: counter.barsChecked,
                    maxBars: counter.maxBars,
                    isExpired: counter.isExpired,
                    progress: (counter.barsChecked / counter.maxBars * 100).toFixed(1) + '%'
                });
            }
        }

        return {
            initialized: true,
            session: {
                currentSession: session.currentSession,
                maxSessions: session.maxSessions,
                startedAt: session.startedAt,
                isActive: session.isActive,
                lastSessionDate: session.lastSessionDate
            },
            triggers: triggerStatuses
        };
    }
}

export default new AdvancedTriggerEngine();