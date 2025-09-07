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
    reasoning: [{
        because: String
    }],
    warnings: [String],
    triggers: [String],
    invalidations: [String],
    beginner_summary: String,
    why_in_plain_words: [String],
    what_could_go_wrong: String,
    money_example: {
        qty: Number,
        max_loss: Number,
        potential_profit: Number
    },
    suggested_qty: Number,
    risk_meter: {
        type: String,
        enum: ['Low', 'Medium', 'High'],
        default: 'Medium'
    },
    actionability: String,
    glossary: {
        entry: String,
        target: String,
        stopLoss: String
    },
    score: Number,
    score_band: {
        type: String,
        enum: ['High', 'Medium', 'Low']
    },
    score_components: mongoose.Schema.Types.Mixed,
    isTopPick: {
        type: Boolean,
        default: false
    }
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
            default: '1.3'
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
        strategies: [strategySchema],
        disclaimer: {
            type: String,
            default: 'AI-generated educational analysis. Not investment advice.'
        },
        meta: {
            data_as_of_ist: String,
            stalePrice: Boolean,
            generated_at_ist: String
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
        required: true,
        index: true
    },
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
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

// Compound index for efficient queries
stockAnalysisSchema.index({ 
    instrument_key: 1, 
    analysis_type: 1, 
    user_id: 1,
    expires_at: 1 
});

// Auto-delete expired analyses
stockAnalysisSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

// Static methods
stockAnalysisSchema.statics.findActiveForUser = function(userId, limit = 10) {
    return this.find({
        user_id: userId,
        status: 'completed',
        expires_at: { $gt: new Date() }
    })
    .sort({ created_at: -1 })
    .limit(limit);
};

stockAnalysisSchema.statics.findByInstrumentAndUser = function(instrumentKey, analysisType, userId) {
    return this.findOne({
        instrument_key: instrumentKey,
        analysis_type: analysisType,
        user_id: userId,
        status: { $in: ['completed', 'in_progress'] },
        expires_at: { $gt: new Date() }
    })
    .sort({ created_at: -1 });
};

stockAnalysisSchema.statics.findInProgressAnalysis = function(instrumentKey, analysisType, userId) {
    return this.findOne({
        instrument_key: instrumentKey,
        analysis_type: analysisType,
        user_id: userId,
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

stockAnalysisSchema.statics.getExpiryTime = function() {
    const now = new Date();
    const istTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
    
    // If market is open, expire at market close (3:30 PM)
    // If market is closed, expire at next market open (9:15 AM next trading day)
    if (this.isMarketOpen()) {
        const today = new Date(istTime);
        today.setHours(15, 30, 0, 0); // 3:30 PM today
        return today;
    } else {
        // Set expiry to next trading day 9:15 AM
        const nextDay = new Date(istTime);
        nextDay.setDate(nextDay.getDate() + 1);
        nextDay.setHours(9, 15, 0, 0); // 9:15 AM
        
        // Skip weekends
        while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
            nextDay.setDate(nextDay.getDate() + 1);
        }
        return nextDay;
    }
};

stockAnalysisSchema.statics.getAnalysisStats = function(userId) {
    return this.aggregate([
        { $match: { user_id: mongoose.Types.ObjectId(userId) } },
        {
            $group: {
                _id: '$analysis_type',
                count: { $sum: 1 },
                latest: { $max: '$created_at' }
            }
        }
    ]);
};

const StockAnalysis = mongoose.model('StockAnalysis', stockAnalysisSchema);

export default StockAnalysis;