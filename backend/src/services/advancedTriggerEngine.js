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

        console.log(`\n${'◆'.repeat(80)}`);
        console.log(`🎯 [ADVANCED ENGINE] checkTriggers() - START`);
        console.log(`${'◆'.repeat(80)}`);
        console.log(`📋 Engine Details:`);
        console.log(`   ├─ Session Key: ${sessionKey}`);
        console.log(`   ├─ Strategy ID: ${strategy.id}`);
        console.log(`   ├─ Triggers Count: ${strategy.triggers?.length || 0}`);
        console.log(`   └─ Market Data Timeframes: ${Object.keys(marketData).join(', ')}\n`);

        // Validate session
        console.log(`🔍 [ENGINE STEP 1] Validating monitoring session...`);
        const sessionCheck = this.isSessionValid(analysisId, strategy.id);

        if (!sessionCheck.valid) {
            console.log(`❌ [ENGINE STEP 1] Session INVALID`);
            console.log(`   ├─ Reason: ${sessionCheck.reason}`);
            console.log(`   └─ Action: cancel_monitoring\n`);
            console.log(`${'◆'.repeat(80)}\n`);
            return {
                success: false,
                reason: sessionCheck.reason,
                action: 'cancel_monitoring'
            };
        }

        console.log(`✅ [ENGINE STEP 1] Session valid`);
        console.log(`   ├─ Current Session: ${sessionCheck.session.currentSession}/${sessionCheck.session.maxSessions}`);
        console.log(`   ├─ Started At: ${sessionCheck.session.startedAt}`);
        console.log(`   └─ Status: ${sessionCheck.session.isActive ? 'ACTIVE' : 'INACTIVE'}\n`);

        // Check invalidations first (can cancel monitoring)
        console.log(`🔍 [ENGINE STEP 2] Checking invalidation conditions...`);
        const invalidationResult = await this.checkInvalidations(strategy, marketData, sessionKey);

        if (invalidationResult.action === 'cancel_entry' || invalidationResult.action === 'close_position') {
            console.log(`❌ [ENGINE STEP 2] Invalidation triggered!`);
            console.log(`   ├─ Action: ${invalidationResult.action}`);
            console.log(`   └─ Reason: ${invalidationResult.reason}\n`);
            console.log(`${'◆'.repeat(80)}\n`);
            return invalidationResult;
        }

        console.log(`✅ [ENGINE STEP 2] No invalidations triggered\n`);

        // Check warnings
        console.log(`🔍 [ENGINE STEP 3] Checking warning conditions...`);
        const warnings = await this.checkWarnings(strategy, marketData);
        console.log(`✅ [ENGINE STEP 3] Warnings checked: ${warnings.length} active warnings\n`);

        if (warnings.length > 0) {
            warnings.forEach((w, idx) => {
                console.log(`   ⚠️  Warning ${idx + 1}: [${w.severity}] ${w.code} - ${w.text}`);
            });
            console.log(``);
        }

        // Check individual triggers
        console.log(`🔍 [ENGINE STEP 4] Evaluating individual triggers...`);
        console.log(`   └─ Total Triggers to Evaluate: ${strategy.triggers?.length || 0}\n`);

        const triggerResults = [];
        let allTriggersValid = true;

        for (const [index, trigger] of (strategy.triggers || []).entries()) {
            console.log(`   🔹 Trigger ${index + 1}/${strategy.triggers.length}: ${trigger.id}`);
            const result = await this.evaluateTrigger(trigger, marketData, sessionKey);
            triggerResults.push(result);

            console.log(`      ├─ Satisfied: ${result.satisfied ? 'YES ✅' : 'NO ❌'}`);
            console.log(`      ├─ Condition Met: ${result.conditionMet ? 'YES' : 'NO'}`);
            console.log(`      ├─ Occurrences OK: ${result.occurrencesSatisfied ? 'YES' : 'NO'}`);
            console.log(`      ├─ Bars Checked: ${result.barsChecked}/${result.maxBars}`);
            console.log(`      └─ Expired: ${result.expired ? 'YES ❌' : 'NO ✅'}\n`);

            if (!result.satisfied) {
                allTriggersValid = false;
            }

            // Check if trigger has expired
            if (result.expired) {
                console.log(`❌ [ENGINE STEP 4] Trigger ${trigger.id} EXPIRED!`);
                console.log(`   ├─ Bars Checked: ${result.barsChecked}`);
                console.log(`   ├─ Max Bars: ${trigger.expiry_bars}`);
                console.log(`   └─ Action: cancel_monitoring\n`);
                console.log(`${'◆'.repeat(80)}\n`);

                this.expireSession(sessionKey, `Trigger ${trigger.id} expired`);
                return {
                    success: false,
                    reason: `Trigger ${trigger.id} expired after ${trigger.expiry_bars} bars`,
                    action: 'cancel_monitoring',
                    expired_trigger: trigger.id
                };
            }
        }

        console.log(`✅ [ENGINE STEP 4] All triggers evaluated`);
        console.log(`   ├─ Total Triggers: ${triggerResults.length}`);
        console.log(`   ├─ Satisfied: ${triggerResults.filter(t => t.satisfied).length}`);
        console.log(`   ├─ Failed: ${triggerResults.filter(t => !t.satisfied).length}`);
        console.log(`   └─ All Valid: ${allTriggersValid ? 'YES ✅' : 'NO ❌'}\n`);

        const finalAction = allTriggersValid ? 'execute_order' : 'continue_monitoring';
        console.log(`📊 [ENGINE FINAL] Returning result`);
        console.log(`   ├─ Success: ${allTriggersValid ? 'YES ✅' : 'NO ❌'}`);
        console.log(`   ├─ Action: ${finalAction}`);
        console.log(`   ├─ Triggers: ${triggerResults.length}`);
        console.log(`   └─ Warnings: ${warnings.length}\n`);
        console.log(`${'◆'.repeat(80)}\n`);

        return {
            success: allTriggersValid,
            triggers: triggerResults,
            warnings: warnings,
            session: sessionCheck.session,
            action: finalAction
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

        // CRITICAL FIX #3: Validate candle freshness (timeframe-aware)
        // Only check for stale data during market hours on trading days
        const now = Date.now();
        const nowIST = MarketHoursUtil.toIST(new Date(now));
        const isMarketOpen = MarketHoursUtil.isMarketOpen(nowIST);
        const isTradingDay = MarketHoursUtil.isTradingDay(nowIST);

        // Only validate data freshness if market is open
        if (isMarketOpen && isTradingDay) {
            const candleTimestamp = new Date(timeframeData.timestamp).getTime();
            const dataAgeMs = now - candleTimestamp;
            const dataAgeMinutes = dataAgeMs / (1000 * 60);

            // Calculate stale threshold based on timeframe
            // Rule: Data is stale if older than 2x the timeframe duration
            const timeframeMinutes = this.parseTimeframeToMinutes(trigger.timeframe);
            const staleThresholdMinutes = timeframeMinutes * 2;

            // Skip evaluation if data is stale (only during market hours)
            if (dataAgeMinutes > staleThresholdMinutes) {
                console.warn(`⚠️ ${trigger.id}: Stale market data (${dataAgeMinutes.toFixed(1)} min old, threshold: ${staleThresholdMinutes} min for ${trigger.timeframe}) - skipping evaluation`);
                return {
                    satisfied: false,
                    expired: false,
                    error: `Stale data: ${dataAgeMinutes.toFixed(1)} minutes old (threshold: ${staleThresholdMinutes} min)`,
                    dataAge: dataAgeMinutes,
                    staleThreshold: staleThresholdMinutes,
                    skipped: true
                };
            }
        } else {
            // Outside market hours - data age is expected to be old, so skip freshness check
            console.log(`📅 ${trigger.id}: Market closed - skipping freshness check`);
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

        // Get previous value for cross detection (CRITICAL for crosses_above/crosses_below)
        // Store current value for next iteration
        const valueHistoryKey = `${triggerKey}_values`;
        if (!this.triggerHistory.has(valueHistoryKey)) {
            this.triggerHistory.set(valueHistoryKey, []);
        }

        const valueHistory = this.triggerHistory.get(valueHistoryKey);
        const currentValue = this.getValue(trigger.left, timeframeData);
        const previousValue = valueHistory.length > 0 ? valueHistory[valueHistory.length - 1] : null;

        // Store current value for next iteration (on new bars only)
        if (isNewBar && currentValue !== null) {
            valueHistory.push(currentValue);
            // Keep only last 2 values (current and previous)
            if (valueHistory.length > 2) {
                valueHistory.shift();
            }
        }

        // Evaluate trigger condition (with previous value for cross detection)
        const conditionMet = this.evaluateCondition(trigger, timeframeData, previousValue);

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
                barNumber: barCounter.barsChecked,
                value: currentValue // Store value in history for debugging
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
    evaluateCondition(condition, timeframeData, previousValue = null) {
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
            case 'crosses_above':
                return this.evaluateCross(leftValue, rightValue, previousValue, 'above');
            case 'crosses_below':
                return this.evaluateCross(leftValue, rightValue, previousValue, 'below');
            default:
                console.error(`❌ Unknown operator: ${condition.op}`);
                return false;
        }
    }

    /**
     * Evaluate cross conditions (crosses_above, crosses_below)
     * CRITICAL: This is the most important operator for breakout trading
     *
     * crosses_above: (prevValue <= threshold) AND (currentValue > threshold)
     * crosses_below: (prevValue >= threshold) AND (currentValue < threshold)
     */
    evaluateCross(currentValue, threshold, previousValue, direction) {
        // Need previous value to detect cross
        if (previousValue === null || previousValue === undefined) {
            console.log(`⚠️ No previous value for cross detection, treating as false`);
            return false;
        }

        if (direction === 'above') {
            // Price must cross FROM below TO above threshold
            const wasBelowOrAt = previousValue <= threshold;
            const nowAbove = currentValue > threshold;
            const crossed = wasBelowOrAt && nowAbove;

            console.log(`🔍 Cross Above Check: prev=${previousValue}, curr=${currentValue}, threshold=${threshold} → ${crossed ? 'CROSSED ✅' : 'not crossed'}`);
            return crossed;

        } else if (direction === 'below') {
            // Price must cross FROM above TO below threshold
            const wasAboveOrAt = previousValue >= threshold;
            const nowBelow = currentValue < threshold;
            const crossed = wasAboveOrAt && nowBelow;

            console.log(`🔍 Cross Below Check: prev=${previousValue}, curr=${currentValue}, threshold=${threshold} → ${crossed ? 'CROSSED ✅' : 'not crossed'}`);
            return crossed;
        }

        return false;
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
                'ema50_1m': 'ema50',
                'price': 'close'
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
     * CRITICAL: Clean up all state when monitoring stops
     * Without this, if user starts same analysis next day → wrong bar counts
     */
    cleanupSession(analysisId, strategyId) {
        const sessionKey = strategyId ? `${analysisId}_${strategyId}` : analysisId;

        console.log(`🧹 Cleaning up session state for: ${sessionKey}`);

        // 1. Remove session counter
        this.sessionCounters.delete(sessionKey);

        // 2. Remove all bar counters for this session
        const barCounterKeysToDelete = [];
        for (const [key] of this.barCounters.entries()) {
            if (key.startsWith(sessionKey)) {
                barCounterKeysToDelete.push(key);
            }
        }
        barCounterKeysToDelete.forEach(key => this.barCounters.delete(key));

        // 3. Remove all trigger history for this session
        const historyKeysToDelete = [];
        for (const [key] of this.triggerHistory.entries()) {
            if (key.startsWith(sessionKey)) {
                historyKeysToDelete.push(key);
            }
        }
        historyKeysToDelete.forEach(key => this.triggerHistory.delete(key));

        console.log(`✅ Cleaned up: ${barCounterKeysToDelete.length} bar counters, ${historyKeysToDelete.length} history entries`);
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
     * Parse timeframe string to minutes
     * Examples: "1m" → 1, "5m" → 5, "15m" → 15, "1h" → 60, "1d" → 1440
     */
    parseTimeframeToMinutes(timeframe) {
        const match = timeframe.match(/^(\d+)([mhd])$/);
        if (!match) {
            console.warn(`⚠️ Unknown timeframe format: ${timeframe}, defaulting to 1 minute`);
            return 1;
        }

        const value = parseInt(match[1]);
        const unit = match[2];

        switch (unit) {
            case 'm': return value;
            case 'h': return value * 60;
            case 'd': return value * 1440;
            default: return 1;
        }
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