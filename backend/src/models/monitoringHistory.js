import mongoose from 'mongoose';

const monitoringHistorySchema = new mongoose.Schema({
    analysis_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StockAnalysis',
        required: true,
        index: true
    },
    strategy_id: {
        type: String,
        required: true
    },
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    stock_symbol: {
        type: String,
        required: true
    },
    check_timestamp: {
        type: Date,
        default: Date.now
        // Index removed - using explicit schema.index() below with TTL
    },
    status: {
        type: String,
        enum: ['checking', 'triggers_not_met', 'conditions_met', 'order_placed', 'market_closed', 'error', 'stopped', 'expired'],
        required: true
    },
    reason: {
        type: String,
        required: true
    },
    details: {
        current_price: Number,
        triggers: [{
            id: String,
            condition: String,
            left_value: mongoose.Schema.Types.Mixed,
            right_value: mongoose.Schema.Types.Mixed,
            passed: Boolean,
            evaluable: Boolean,
            timeframe: String,
            candle_used: {
                timestamp: String,
                open: Number,
                high: Number,
                low: Number,
                close: Number,
                volume: Number
            }
        }],
        failed_triggers: [{
            id: String,
            condition: String,
            left_value: mongoose.Schema.Types.Mixed,
            right_value: mongoose.Schema.Types.Mixed,
            reason: String,
            candle_used: {
                timestamp: String,
                open: Number,
                high: Number,
                low: Number,
                close: Number,
                volume: Number
            }
        }],
        invalidations: [{
            condition: String,
            hit: Boolean,
            action: String
        }],
        market_status: {
            is_open: Boolean,
            reason: String,
            next_open: Date
        },
        error_message: String,
        order_result: mongoose.Schema.Types.Mixed
    },
    // Performance metrics
    monitoring_duration_ms: Number,
    check_sequence: {
        type: Number,
        default: 1
    }
}, {
    timestamps: true
});

// Compound indexes for efficient queries
monitoringHistorySchema.index({ 
    analysis_id: 1, 
    strategy_id: 1, 
    check_timestamp: -1 
});

monitoringHistorySchema.index({ 
    user_id: 1, 
    check_timestamp: -1 
});

// Auto-delete old monitoring history after 30 days
monitoringHistorySchema.index({ 
    check_timestamp: 1 
}, { 
    expireAfterSeconds: 30 * 24 * 60 * 60 // 30 days
});

// Static methods
monitoringHistorySchema.statics.getLatestForStrategy = function(analysisId, strategyId, limit = 3) {
    return this.find({
        analysis_id: analysisId,
        strategy_id: strategyId
    })
    .sort({ check_timestamp: -1 })
    .limit(limit)
    .lean();
};

monitoringHistorySchema.statics.getLatestForUser = function(userId, limit = 10) {
    return this.find({
        user_id: userId
    })
    .sort({ check_timestamp: -1 })
    .limit(limit)
    .populate('analysis_id', 'stock_symbol analysis_type')
    .lean();
};

monitoringHistorySchema.statics.getFailureReasons = function(analysisId, strategyId, limit = 5) {
    return this.find({
        analysis_id: analysisId,
        strategy_id: strategyId,
        status: { $in: ['triggers_not_met', 'error', 'market_closed'] }
    })
    .sort({ check_timestamp: -1 })
    .limit(limit)
    .select('status reason details.failed_triggers details.error_message check_timestamp')
    .lean();
};

monitoringHistorySchema.statics.getSummaryStats = function(analysisId, strategyId) {
    return this.aggregate([
        {
            $match: {
                analysis_id: mongoose.Types.ObjectId(analysisId),
                strategy_id: strategyId
            }
        },
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 },
                latest_timestamp: { $max: '$check_timestamp' }
            }
        },
        {
            $group: {
                _id: null,
                total_checks: { $sum: '$count' },
                status_breakdown: {
                    $push: {
                        status: '$_id',
                        count: '$count',
                        latest: '$latest_timestamp'
                    }
                },
                last_check: { $max: '$latest_timestamp' }
            }
        }
    ]);
};

// Instance methods
monitoringHistorySchema.methods.addTriggerDetails = function(triggers, currentPrice) {
    this.details = this.details || {};
    this.details.current_price = currentPrice;

    // Map triggers with candle data
    this.details.triggers = triggers.map(t => ({
        id: t.id,
        condition: t.condition,
        left_value: t.left_value,
        right_value: t.right_value,
        passed: t.passed,
        evaluable: t.evaluable,
        timeframe: t.timeframe,
        candle_used: t.candle_used || null
    }));

    // Map failed triggers with candle data
    this.details.failed_triggers = triggers
        .filter(t => !t.passed || !t.evaluable)
        .map(t => ({
            id: t.id,
            condition: t.condition,
            left_value: t.left_value,
            right_value: t.right_value,
            reason: t.reason || (!t.evaluable ? 'Not evaluable' : 'Condition not met'),
            candle_used: t.candle_used || null
        }));

    return this;
};

monitoringHistorySchema.methods.addMarketStatus = function(marketStatus) {
    this.details = this.details || {};
    this.details.market_status = marketStatus;
    return this;
};

monitoringHistorySchema.methods.addOrderResult = function(orderResult) {
    this.details = this.details || {};
    this.details.order_result = orderResult;
    return this;
};

const MonitoringHistory = mongoose.model('MonitoringHistory', monitoringHistorySchema);

export default MonitoringHistory;
