import mongoose from 'mongoose';

const indicatorSignalSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    value: {
        type: String,
        required: true
    },
    signal: {
        type: String,
        enum: ['STRONG_BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG_SELL'],
        required: true
    }
});

const strategySchema = new mongoose.Schema({
    id: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: ['BUY', 'SELL', 'HOLD', 'NO_TRADE'],
        required: true
    },
    alignment: {
        type: String,
        enum: ['with_trend', 'counter_trend', 'neutral'],
        default: 'neutral'
    },
    title: {
        type: String,
        required: true
    },
    confidence: {
        type: Number,
        required: true,
        min: 0,
        max: 1
    },
    entryType: {
        type: String,
        enum: ['market', 'limit', 'range', 'stop', 'stop-limit'],
        default: 'limit'
    },
    entry: {
        type: Number,
        required: true
    },
    entryRange: [{
        type: Number
    }],
    target: {
        type: Number,
        required: true
    },
    stopLoss: {
        type: Number,
        required: true
    },
    riskReward: {
        type: Number,
        required: true
    },
    timeframe: {
        type: String,
        required: true
    },
    indicators: [indicatorSignalSchema],
    reasoning: [mongoose.Schema.Types.Mixed], // Accept objects or strings
    warnings: [mongoose.Schema.Types.Mixed], // Accept objects or strings
    triggers: [mongoose.Schema.Types.Mixed], // Accept objects or strings
    invalidations: [mongoose.Schema.Types.Mixed], // Accept objects or strings
    beginner_summary: mongoose.Schema.Types.Mixed, // Accept object or string
    why_in_plain_words: [mongoose.Schema.Types.Mixed], // Accept objects or strings
    what_could_go_wrong: mongoose.Schema.Types.Mixed, // Accept array or string
    money_example: mongoose.Schema.Types.Mixed, // Accept any object structure
    suggested_qty: mongoose.Schema.Types.Mixed, // Accept object or number
    risk_meter: mongoose.Schema.Types.Mixed, // Accept object or string
    actionability: mongoose.Schema.Types.Mixed, // Accept object or string
    glossary: mongoose.Schema.Types.Mixed, // Accept any object structure
    score: Number,
    score_band: {
        type: String,
        enum: ['High', 'Medium', 'Low']
    },
    score_components: mongoose.Schema.Types.Mixed,
    isTopPick: {
        type: Boolean,
        default: false
    },
    archetype: {
        type: String,
        enum: ['breakout', 'pullback', 'trend-follow', 'mean-reversion', 'range-fade'],
        required: false
    },
    why_best: {
        type: String,
        required: false
    },
    confirmation: mongoose.Schema.Types.Mixed, // Accept object or string
    validity: mongoose.Schema.Types.Mixed // Accept any object structure
});

const stockAnalysisSchema = new mongoose.Schema({
    instrument_key: {
        type: String,
        required: true,
        index: true
    },
    stock_name: {
        type: String,
        required: true
    },
    stock_symbol: {
        type: String,
        required: true
    },
    analysis_type: {
        type: String,
        enum: ['swing', 'intraday'],
        required: true,
        default: 'swing'
    },
    current_price: {
        type: Number,
        required: true
    },
    analysis_data: {
        schema_version: {
            type: String,
            default: '1.4'
        },
        symbol: String,
        analysis_type: String,
        generated_at_ist: String,
        insufficientData: {
            type: Boolean,
            default: false
        },
        market_summary: {
            last: Number,
            trend: {
                type: String,
                enum: ['BULLISH', 'BEARISH', 'NEUTRAL']
            },
            volatility: {
                type: String,
                enum: ['HIGH', 'MEDIUM', 'LOW']
            },
            volume: {
                type: String,
                enum: ['ABOVE_AVERAGE', 'AVERAGE', 'BELOW_AVERAGE', 'UNKNOWN']
            }
        },
        overall_sentiment: {
            type: String,
            enum: ['BULLISH', 'BEARISH', 'NEUTRAL'],
            required: true
        },
        runtime: {
            triggers_evaluated: [{
                id: String,
                timeframe: String,
                left_ref: String,
                left_value: mongoose.Schema.Types.Mixed,
                op: String,
                right_ref: String,
                right_value: mongoose.Schema.Types.Mixed,
                passed: Boolean,
                evaluable: Boolean
            }],
            pre_entry_invalidations_hit: Boolean
        },
        order_gate: {
            all_triggers_true: Boolean,
            no_pre_entry_invalidations: Boolean,
            actionability_status: {
                type: String,
                enum: ['actionable_now', 'actionable_on_trigger', 'monitor_only']
            },
            entry_type_sane: Boolean,
            can_place_order: Boolean
        },
        strategies: [strategySchema],
        disclaimer: {
            type: String,
            default: 'AI-generated educational analysis. Not investment advice.'
        },
        meta: {
            data_as_of_ist: String,
            stalePrice: Boolean,
            generated_at_ist: String,
            debug: {
                ai_request: {
                    model: String,
                    formatted_messages: mongoose.Schema.Types.Mixed, // The formatted messages sent to AI
                    request_payload: mongoose.Schema.Types.Mixed,   // The full request payload built
                    prompt_hash: String // Hash of the prompt for quick identification
                },
                market_payload: mongoose.Schema.Types.Mixed, // The market data used for analysis
                processing_time: {
                    total_ms: Number,
                    steps: mongoose.Schema.Types.Mixed // Timing for each analysis step
                }
            }
        }
    },
    status: {
        type: String,
        enum: ['pending', 'in_progress', 'completed', 'failed'],
        default: 'pending'
    },
    progress: {
        percentage: {
            type: Number,
            default: 0,
            min: 0,
            max: 100
        },
        current_step: {
            type: String,
            default: 'Initializing analysis...'
        },
        steps_completed: {
            type: Number,
            default: 0
        },
        total_steps: {
            type: Number,
            default: 8 // Data fetch, indicators, patterns, sentiment, strategies, scoring, validation, finalization
        },
        estimated_time_remaining: {
            type: Number, // in seconds
            default: 90
        },
        last_updated: {
            type: Date,
            default: Date.now
        }
    },
    created_at: {
        type: Date,
        default: Date.now,
        index: true
    },
    expires_at: {
        type: Date,
        required: true
        // Index removed - using explicit schema.index() below with TTL
    },
    // Order tracking fields - consolidated bracket orders
    placed_orders: [{
        tag: {
            type: String,
            required: true // This is the unique identifier for the bracket order group
        },
        order_type: {
            type: String,
            enum: ['BRACKET', 'SINGLE'], // BRACKET for multi-order, SINGLE for individual
            default: 'BRACKET'
        },
        strategy_id: String,
        placed_at: {
            type: Date,
            default: Date.now
        },
        status: {
            type: String,
            enum: ['ACTIVE', 'PARTIALLY_FILLED', 'COMPLETED', 'CANCELLED', 'FAILED'],
            default: 'ACTIVE'
        },
        // All order IDs in this bracket
        order_ids: {
            main_order_id: String,      // Entry order ID
            stop_loss_order_id: String, // Stop loss order ID  
            target_order_id: String,    // Target order ID
            all_order_ids: [String]     // Array of all order IDs for easy lookup
        },
        order_details: {
            quantity: Number,
            entry_price: Number,
            stop_loss_price: Number,
            target_price: Number,
            transaction_type: String, // BUY or SELL for the main order
            product: String
        }
    }],
    orders_placed_count: {
        type: Number,
        default: 0
    },
    last_order_placed_at: Date
});

// Compound index for efficient queries - shared across all users
stockAnalysisSchema.index({ 
    instrument_key: 1, 
    analysis_type: 1, 
    expires_at: 1 
});

// Auto-delete expired analyses
stockAnalysisSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

// Static methods
stockAnalysisSchema.statics.findActive = function(limit = 10) {
    return this.find({
        status: 'completed',
        expires_at: { $gt: new Date() }
    })
    .sort({ created_at: -1 })
    .limit(limit);
};

stockAnalysisSchema.statics.findByInstrument = function(instrumentKey, analysisType) {
    return this.findOne({
        instrument_key: instrumentKey,
        analysis_type: analysisType,
        status: { $in: ['completed', 'in_progress'] },
        expires_at: { $gt: new Date() }
    })
    .sort({ created_at: -1 });
};

stockAnalysisSchema.statics.findInProgressAnalysis = function(instrumentKey, analysisType) {
    return this.findOne({
        instrument_key: instrumentKey,
        analysis_type: analysisType,
        status: 'in_progress',
        expires_at: { $gt: new Date() }
    })
    .sort({ created_at: -1 });
};

// Instance methods for progress tracking
stockAnalysisSchema.methods.updateProgress = function(step, percentage, estimatedTimeRemaining = null) {
    this.progress.current_step = step;
    this.progress.percentage = Math.min(100, Math.max(0, percentage));
    this.progress.steps_completed = Math.floor((percentage / 100) * this.progress.total_steps);
    if (estimatedTimeRemaining !== null) {
        this.progress.estimated_time_remaining = estimatedTimeRemaining;
    }
    this.progress.last_updated = new Date();
    this.status = percentage >= 100 ? 'completed' : 'in_progress';
    return this.save();
};

stockAnalysisSchema.methods.markCompleted = function() {
    this.status = 'completed';
    this.progress.percentage = 100;
    this.progress.current_step = 'Analysis completed';
    this.progress.estimated_time_remaining = 0;
    this.progress.last_updated = new Date();
    return this.save();
};

stockAnalysisSchema.methods.markFailed = function(error = 'Analysis failed') {
    this.status = 'failed';
    this.progress.current_step = error;
    this.progress.last_updated = new Date();
    return this.save();
};

// Order tracking methods
stockAnalysisSchema.methods.hasActiveOrders = function() {
    return this.placed_orders && this.placed_orders.some(order => 
        order.status === 'ACTIVE' || order.status === 'PARTIALLY_FILLED'
    );
};

stockAnalysisSchema.methods.addPlacedOrders = function(orderData) {
    if (!this.placed_orders) {
        this.placed_orders = [];
    }
    
    if (orderData.bracket_details) {
        // Handle Upstox Multi Order bracket response format - create one consolidated record
        const { main_order_id, stop_loss_order_id, target_order_id } = orderData.bracket_details;
        
        // Collect all order IDs
        const allOrderIds = [main_order_id, stop_loss_order_id, target_order_id].filter(Boolean);
        
        this.placed_orders.push({
            tag: orderData.tag, // Use tag as the unique identifier
            order_type: 'BRACKET',
            strategy_id: orderData.strategy_id,
            placed_at: new Date(),
            status: 'ACTIVE', // Start as ACTIVE
            order_ids: {
                main_order_id: main_order_id || null,
                stop_loss_order_id: stop_loss_order_id || null,
                target_order_id: target_order_id || null,
                all_order_ids: allOrderIds
            },
            order_details: {
                quantity: orderData.quantity,
                entry_price: orderData.price,
                stop_loss_price: orderData.stopLoss || null,
                target_price: orderData.target || null,
                transaction_type: orderData.transaction_type,
                product: orderData.product
            }
        });
        
        console.log(`✅ Stored consolidated bracket order with tag: ${orderData.tag}, orders: ${allOrderIds.length}`);
        
    } else if (orderData.order_id) {
        // Single order
        this.placed_orders.push({
            tag: orderData.tag || orderData.order_id, // Use tag or fallback to order_id
            order_type: 'SINGLE',
            strategy_id: orderData.strategy_id,
            placed_at: new Date(),
            status: 'ACTIVE',
            order_ids: {
                main_order_id: orderData.order_id,
                stop_loss_order_id: null,
                target_order_id: null,
                all_order_ids: [orderData.order_id]
            },
            order_details: {
                quantity: orderData.quantity,
                entry_price: orderData.price,
                stop_loss_price: null,
                target_price: null,
                transaction_type: orderData.transaction_type,
                product: orderData.product
            }
        });
        
        console.log(`✅ Stored single order with tag: ${orderData.tag || orderData.order_id}`);
    }
    
    this.orders_placed_count = this.placed_orders.length;
    this.last_order_placed_at = new Date();
    return this.save();
};

stockAnalysisSchema.methods.getOrderTypeFromCorrelationId = function(correlationId) {
    if (correlationId.includes('_M')) return 'MAIN';
    if (correlationId.includes('_S')) return 'STOP_LOSS';
    if (correlationId.includes('_T')) return 'TARGET';
    return 'SINGLE';
};

stockAnalysisSchema.methods.getPlacedOrderIds = function() {
    if (!this.placed_orders) return [];
    
    // Flatten all order IDs from all bracket orders
    return this.placed_orders.reduce((allIds, bracketOrder) => {
        return allIds.concat(bracketOrder.order_ids.all_order_ids || []);
    }, []);
};

stockAnalysisSchema.methods.updateOrderStatus = function(tag, newStatus) {
    if (this.placed_orders) {
        const bracketOrder = this.placed_orders.find(order => order.tag === tag);
        if (bracketOrder) {
            bracketOrder.status = newStatus;
            return this.save();
        }
    }
    return Promise.resolve(this);
};

// New methods for condition validation
stockAnalysisSchema.methods.canPlaceOrder = function() {
    // Check if order_gate allows order placement
    if (!this.analysis_data?.order_gate) {
        console.log('❌ No order_gate data found');
        return false;
    }
    
    const orderGate = this.analysis_data.order_gate;
    
    // All conditions must be true
    const canPlace = orderGate.can_place_order === true &&
                    orderGate.all_triggers_true === true &&
                    orderGate.no_pre_entry_invalidations === true &&
                    orderGate.entry_type_sane === true &&
                    orderGate.actionability_status === 'actionable_now';
    
    console.log(`📋 Order gate check: can_place=${canPlace}`, orderGate);
    return canPlace;
};

stockAnalysisSchema.methods.getConditionValidationDetails = function() {
    const analysis = this.analysis_data;
    
    if (!analysis?.runtime || !analysis?.order_gate) {
        return {
            valid: false,
            reason: 'No condition validation data available',
            details: {}
        };
    }
    
    const runtime = analysis.runtime;
    const orderGate = analysis.order_gate;
    
    // Check each trigger
    const triggerDetails = runtime.triggers_evaluated?.map(trigger => ({
        id: trigger.id,
        description: `${trigger.left_ref} ${trigger.op} ${trigger.right_ref}`,
        passed: trigger.passed,
        evaluable: trigger.evaluable,
        left_value: trigger.left_value,
        right_value: trigger.right_value
    })) || [];
    
    const failedTriggers = triggerDetails.filter(t => !t.passed || !t.evaluable);
    
    return {
        valid: orderGate.can_place_order === true,
        reason: this._getValidationFailureReason(orderGate, failedTriggers),
        details: {
            triggers: triggerDetails,
            failed_triggers: failedTriggers,
            actionability_status: orderGate.actionability_status,
            entry_type_sane: orderGate.entry_type_sane,
            pre_entry_invalidations_hit: runtime.pre_entry_invalidations_hit
        }
    };
};

stockAnalysisSchema.methods._getValidationFailureReason = function(orderGate, failedTriggers) {
    if (!orderGate.can_place_order) {
        if (failedTriggers.length > 0) {
            return `Entry conditions not met: ${failedTriggers.map(t => t.description).join(', ')}`;
        }
        if (orderGate.actionability_status !== 'actionable_now') {
            return `Strategy status: ${orderGate.actionability_status}`;
        }
        if (!orderGate.entry_type_sane) {
            return 'Entry type configuration issue';
        }
        if (!orderGate.no_pre_entry_invalidations) {
            return 'Pre-entry invalidation conditions hit';
        }
        return 'Conditions not suitable for order placement';
    }
    return 'All conditions validated';
};

// Market timing helpers
stockAnalysisSchema.statics.isMarketOpen = function() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    const day = istTime.getDay(); // 0 = Sunday, 6 = Saturday
    const hours = istTime.getHours();
    const minutes = istTime.getMinutes();
    const currentTime = hours * 60 + minutes; // Convert to minutes
    
    // Market closed on weekends
    if (day === 0 || day === 6) return false;
    
    // Market hours: 9:15 AM to 3:30 PM IST
    const marketOpen = 9 * 60 + 15;  // 9:15 AM
    const marketClose = 15 * 60 + 30; // 3:30 PM
    
    return currentTime >= marketOpen && currentTime <= marketClose;
};

// Method to check if analysis is allowed (4 PM - 9 AM, except 3-4 PM on trading days)
stockAnalysisSchema.statics.isAnalysisAllowed = function() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    const currentDay = istTime.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const currentTime = istTime.getHours() * 60 + istTime.getMinutes(); // Total minutes
    
    // Never allow analysis on Saturday evening (after 4 PM) or Sunday
    if (currentDay === 6 && currentTime >= 16 * 60) {
        return { allowed: false, reason: "weekend_restriction", nextAllowed: "Monday 4:00 PM" };
    }
    if (currentDay === 0) {
        return { allowed: false, reason: "weekend_restriction", nextAllowed: "Monday 4:00 PM" };
    }
    
    // Trading days (Monday-Friday)
    if (currentDay >= 1 && currentDay <= 5) {
        // Allow: 4 PM - 11:59 PM OR 12 AM - 9 AM
        const eveningStart = 16 * 60; // 4:00 PM
        const morningEnd = 9 * 60;    // 9:00 AM
        const marketPreClose = 15 * 60; // 3:00 PM
        const marketClose = 15 * 60 + 30; // 3:30 PM
        
        // Special window: 3:00 PM - 4:00 PM (allowed on trading days only)
        if (currentTime >= marketPreClose && currentTime < eveningStart) {
            return { allowed: true, reason: "pre_close_window" };
        }
        
        // Evening: 4 PM - 11:59 PM
        if (currentTime >= eveningStart) {
            return { allowed: true, reason: "evening_session" };
        }
        
        // Morning: 12 AM - 9 AM
        if (currentTime < morningEnd) {
            return { allowed: true, reason: "morning_session" };
        }
        
        // Market hours (9:15 AM - 3:00 PM): Not allowed
        const marketOpen = 9 * 60 + 15; // 9:15 AM
        if (currentTime >= marketOpen && currentTime < marketPreClose) {
            const nextTime = Math.floor(marketPreClose / 60) + ":" + String(marketPreClose % 60).padStart(2, '0');
            return { allowed: false, reason: "market_hours", nextAllowed: `Today ${nextTime} PM` };
        }
        
        // Gap between 9 AM - 9:15 AM: Not allowed (pre-market)
        if (currentTime >= morningEnd && currentTime < marketOpen) {
            return { allowed: false, reason: "pre_market", nextAllowed: "Today 3:00 PM" };
        }
    }
    
    // Saturday morning: allow until 9 AM only
    if (currentDay === 6 && currentTime < 9 * 60) {
        return { allowed: true, reason: "saturday_morning" };
    }
    
    return { allowed: false, reason: "general_restriction", nextAllowed: "Today 4:00 PM" };
};

// Method to check if bulk analysis is allowed (4 PM to next trading day 8:45 AM)
stockAnalysisSchema.statics.isBulkAnalysisAllowed = async function() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    const currentDay = istTime.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const currentTime = istTime.getHours() * 60 + istTime.getMinutes(); // Total minutes
    
    // Import MarketTiming for holiday checking
    const MarketTiming = (await import('./marketTiming.js')).default;
    
    // Helper function to check if a date is a trading day
    const isTradingDay = async (date) => {
        // Fix: Use IST date components to avoid timezone conversion issues
        const istDate = new Date(date.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
        const year = istDate.getFullYear();
        const month = String(istDate.getMonth() + 1).padStart(2, '0');
        const day = String(istDate.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`; // YYYY-MM-DD format
        const marketTiming = await MarketTiming.findOne({ date: dateStr });
        
        // If no record exists, assume it's a trading day if it's a weekday
        if (!marketTiming) {
            const dayOfWeek = istDate.getDay();
            return dayOfWeek >= 1 && dayOfWeek <= 5; // Monday to Friday
        }
        
        return marketTiming.isMarketOpen;
    };
    
    // Helper function to find next trading day
    const findNextTradingDay = async (fromDate) => {
        let checkDate = new Date(fromDate);
        checkDate.setDate(checkDate.getDate() + 1); // Start from next day
        
        let maxDays = 10; // Prevent infinite loop
        while (maxDays > 0) {
            if (await isTradingDay(checkDate)) {
                return checkDate;
            }
            checkDate.setDate(checkDate.getDate() + 1);
            maxDays--;
        }
        
        // Fallback: return next Monday if can't find trading day
        const nextMonday = new Date(fromDate);
        nextMonday.setDate(nextMonday.getDate() + ((1 + 7 - nextMonday.getDay()) % 7 || 7));
        return nextMonday;
    };
    
    // Check if current time is within allowed window
    const bulkStartTime = 16 * 60; // 4:00 PM
    const bulkEndTime = 8 * 60 + 45; // 8:45 AM
    
    // Current date for checking if it's a trading day
    const currentDate = new Date(istTime);
    currentDate.setHours(0, 0, 0, 0);
    
    // IMPORTANT: Handle early morning hours (12 AM - 8:45 AM) first
    // These are continuation of previous day's session
    if (currentTime < bulkEndTime) {
        // This is early morning - check if we're in continuation of yesterday's session
        const yesterdayDate = new Date(currentDate);
        yesterdayDate.setDate(yesterdayDate.getDate() - 1);
        
        const yesterdayWasTradingDay = await isTradingDay(yesterdayDate);
        
        // If yesterday was a trading day, then we're in the continuation session
        if (yesterdayWasTradingDay) {
            return { 
                allowed: true, 
                reason: "morning_session", 
                validUntil: `Today 8:45 AM`
            };
        }
        
        // If yesterday was not a trading day, check if today is a trading day
        const todayIsTradingDay = await isTradingDay(currentDate);
        if (todayIsTradingDay) {
            return { 
                allowed: true, 
                reason: "monday_morning", 
                validUntil: "Today 8:45 AM"
            };
        }
        
        // Neither yesterday nor today is trading day - weekend/holiday
        const nextTradingDay = await findNextTradingDay(currentDate);
        return { 
            allowed: false, 
            reason: "holiday", 
            nextAllowed: `${nextTradingDay.toLocaleDateString('en-IN', {timeZone: 'Asia/Kolkata'})} 4:00 PM`
        };
    }
    
    // Handle afternoon/evening hours (8:45 AM onwards)
    const currentDateIsTradingDay = await isTradingDay(currentDate);
    
    // Case 1: Friday afternoon/evening or Weekend
    if ((currentDay === 5 && currentTime >= bulkStartTime) || currentDay === 6 || currentDay === 0) {
        // Find next trading day after current date
        const nextTradingDay = await findNextTradingDay(currentDate);
        const nextTradingDayEnd = new Date(nextTradingDay);
        nextTradingDayEnd.setHours(8, 45, 0, 0);
        
        return { 
            allowed: true, 
            reason: "weekend_session", 
            validUntil: nextTradingDayEnd.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})
        };
    }
    
    // Case 2: Weekday afternoon/evening (Monday-Thursday)
    if (currentDay >= 1 && currentDay <= 5) {
        // If current day is a trading day
        if (currentDateIsTradingDay) {
            // Before 4 PM: Not allowed
            if (currentTime < bulkStartTime) {
                return { 
                    allowed: false, 
                    reason: "before_session", 
                    nextAllowed: "Today 4:00 PM"
                };
            }
            
            // After 4 PM: Allowed until next trading day 8:45 AM
            const nextTradingDay = await findNextTradingDay(currentDate);
            const nextTradingDayEnd = new Date(nextTradingDay);
            nextTradingDayEnd.setHours(8, 45, 0, 0);
            
            return { 
                allowed: true, 
                reason: "weekday_session", 
                validUntil: nextTradingDayEnd.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})
            };
        } else {
            // Current day is holiday
            const nextTradingDay = await findNextTradingDay(currentDate);
            return { 
                allowed: false, 
                reason: "holiday", 
                nextAllowed: `${nextTradingDay.toLocaleDateString('en-IN', {timeZone: 'Asia/Kolkata'})} 4:00 PM`
            };
        }
    }
    
    // Default: Not allowed
    return { 
        allowed: false, 
        reason: "outside_window", 
        nextAllowed: "Today 4:00 PM"
    };
};

// Removed old canRunBulkAnalysis - now using upstoxMarketTimingService.canRunBulkAnalysis()

stockAnalysisSchema.statics.getExpiryTime = async function() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    
    // Import MarketTiming for holiday checking
    const MarketTiming = (await import('./marketTiming.js')).default;
    
    // Helper function to check if a date is a trading day
    const isTradingDay = async (date) => {
        // Fix: Use IST date components to avoid timezone conversion issues
        const istDate = new Date(date.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
        const year = istDate.getFullYear();
        const month = String(istDate.getMonth() + 1).padStart(2, '0');
        const day = String(istDate.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`; // YYYY-MM-DD format
        const marketTiming = await MarketTiming.findOne({ date: dateStr });
        
        // If no record exists, assume it's a trading day if it's a weekday
        if (!marketTiming) {
            const dayOfWeek = istDate.getDay();
            return dayOfWeek >= 1 && dayOfWeek <= 5; // Monday to Friday
        }
        
        return marketTiming.isMarketOpen;
    };
    
    // Helper function to find next trading day
    const findNextTradingDay = async (fromDate) => {
        let checkDate = new Date(fromDate);
        checkDate.setDate(checkDate.getDate() + 1); // Start from next day
        
        let maxDays = 10; // Prevent infinite loop
        while (maxDays > 0) {
            if (await isTradingDay(checkDate)) {
                return checkDate;
            }
            checkDate.setDate(checkDate.getDate() + 1);
            maxDays--;
        }
        
        // Fallback: return next Monday if can't find trading day
        const nextMonday = new Date(fromDate);
        nextMonday.setDate(nextMonday.getDate() + ((1 + 7 - nextMonday.getDay()) % 7 || 7));
        return nextMonday;
    };
    
    // Current date for checking if it's a trading day
    const currentDate = new Date(istTime);
    currentDate.setHours(0, 0, 0, 0);
    
    // Find next trading day and set expiry to 8:45 AM
    const nextTradingDay = await findNextTradingDay(currentDate);
    const expiryTime = new Date(nextTradingDay);
    expiryTime.setHours(8, 45, 0, 0); // 8:45 AM next trading day
    
    console.log(`📅 [EXPIRY] Strategy expires at next trading day 8:45 AM: ${expiryTime.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}`);
    
    return expiryTime;
};

stockAnalysisSchema.statics.getAnalysisStats = function() {
    return this.aggregate([
        { $match: { status: 'completed', expires_at: { $gt: new Date() } } },
        {
            $group: {
                _id: '$analysis_type',
                count: { $sum: 1 },
                latest: { $max: '$created_at' }
            }
        }
    ]);
};

// Static method to clean up stale order processing locks
stockAnalysisSchema.statics.cleanupStaleOrderProcessingLocks = async function() {
    try {
        const staleThreshold = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
        
        const result = await this.updateMany(
            {
                order_processing: true,
                order_processing_started_at: { $lt: staleThreshold }
            },
            {
                $unset: { 
                    order_processing: 1,
                    order_processing_started_at: 1
                },
                $set: {
                    order_processing_completed_at: new Date(),
                    last_order_processing_result: 'timeout_cleanup'
                }
            }
        );
        
        if (result.modifiedCount > 0) {
            console.log(`🧹 Cleaned up ${result.modifiedCount} stale order processing locks`);
        }
        
        return result;
    } catch (error) {
        console.error('❌ Error cleaning up stale order processing locks:', error);
        return null;
    }
};

const StockAnalysis = mongoose.model('StockAnalysis', stockAnalysisSchema);

export default StockAnalysis;