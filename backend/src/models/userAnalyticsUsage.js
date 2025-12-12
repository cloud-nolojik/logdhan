import mongoose from 'mongoose';

/**
 * UserAnalyticsUsage Model
 * Tracks AI analysis token usage and costs per user
 * Persists even after StockAnalysis documents are deleted
 * Used for:
 * - Cost tracking per user
 * - Usage analytics (who uses the most)
 * - Billing decisions (free tier limits, premium pricing)
 * - Performance monitoring (cache hit rates)
 */
const userAnalyticsUsageSchema = new mongoose.Schema({
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    analysis_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StockAnalysis',
        required: false,  // Optional since analysis may be deleted
        index: true
    },
    stock_symbol: {
        type: String,
        required: true,
        index: true
    },
    analysis_type: {
        type: String,
        enum: ['swing', 'intraday', 'positional', 'scalping'],
        required: true,
        index: true
    },
    // Token usage breakdown (now with separate sentiment model tracking)
    token_usage: {
        // Sentiment Analysis (uses sentiment model - e.g., gpt-5-mini)
        sentiment: {
            input_tokens: { type: Number, default: 0 },
            output_tokens: { type: Number, default: 0 },
            cached_tokens: { type: Number, default: 0 },
            total_tokens: { type: Number, default: 0 }
        },
        // Stage 3: Final Assembly (uses analysis model - e.g., gpt-5.2)
        stage3: {
            input_tokens: { type: Number, default: 0 },
            output_tokens: { type: Number, default: 0 },
            cached_tokens: { type: Number, default: 0 },
            total_tokens: { type: Number, default: 0 }
        },
        // Total across all LLM calls (sentiment + stage3)
        total: {
            input_tokens: { type: Number, default: 0 },
            output_tokens: { type: Number, default: 0 },
            cached_tokens: { type: Number, default: 0 },
            total_tokens: { type: Number, default: 0 }
        }
    },
    // Cost calculation with separate tracking per model
    cost_breakdown: {
        // Sentiment model costs
        sentiment_input_cost: { type: Number, default: 0 },
        sentiment_output_cost: { type: Number, default: 0 },
        sentiment_cached_cost: { type: Number, default: 0 },
        sentiment_total_cost_usd: { type: Number, default: 0 },
        // Analysis model costs
        analysis_input_cost: { type: Number, default: 0 },
        analysis_output_cost: { type: Number, default: 0 },
        analysis_cached_cost: { type: Number, default: 0 },
        analysis_total_cost_usd: { type: Number, default: 0 },
        // Combined totals
        total_cost_usd: { type: Number, default: 0 },
        total_cost_inr: { type: Number, default: 0 }
    },
    // Pricing models used (now tracks both sentiment and analysis models)
    pricing_model: {
        // Sentiment model (e.g., gpt-5-mini for news analysis)
        sentiment_model: { type: String, default: 'gpt-5-mini' },
        sentiment_input_price_per_1k: { type: Number, default: 0.00025 },   // $0.25 per 1M
        sentiment_output_price_per_1k: { type: Number, default: 0.002 },    // $2.00 per 1M
        sentiment_cached_price_per_1k: { type: Number, default: 0.000025 }, // $0.025 per 1M
        // Analysis model (e.g., gpt-5.2 for main analysis)
        analysis_model: { type: String, default: 'gpt-5.2' },
        analysis_input_price_per_1k: { type: Number, default: 0.00175 },    // $1.75 per 1M
        analysis_output_price_per_1k: { type: Number, default: 0.014 },     // $14.00 per 1M
        analysis_cached_price_per_1k: { type: Number, default: 0.000175 },  // $0.175 per 1M
        // Exchange rate
        usd_to_inr_rate: { type: Number, default: 83.0 }
    },
    // Performance metrics
    performance: {
        total_duration_ms: { type: Number, default: 0 },  // Total analysis time
        stage1_duration_ms: { type: Number, default: 0 },
        stage2_duration_ms: { type: Number, default: 0 },
        stage3_duration_ms: { type: Number, default: 0 },
        cache_hit_rate: { type: Number, default: 0 }      // Percentage of cached tokens
    },
    // Result metadata
    result: {
        insufficient_data: { type: Boolean, default: false },
        strategy_type: { type: String },  // BUY, SELL, NO_TRADE
        confidence: { type: Number },
        risk_reward: { type: Number }
    },
    // Billing context
    billing_context: {
        is_free_tier: { type: Boolean, default: true },
        is_trial: { type: Boolean, default: false },
        subscription_plan: { type: String, default: 'free' },  // free, basic, premium
        charge_user: { type: Boolean, default: false }  // Did we charge the user for this?
    },
    // Flag to indicate if this is a duplicated record from existing analysis
    is_cached_analysis: {
        type: Boolean,
        default: false,  // false = freshly generated, true = reused existing analysis
        index: true
    }
}, {
    timestamps: true  // Adds createdAt and updatedAt
});

// Indexes for efficient queries
userAnalyticsUsageSchema.index({ user_id: 1, createdAt: -1 });
userAnalyticsUsageSchema.index({ user_id: 1, analysis_type: 1 });
userAnalyticsUsageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 }); // Keep for 1 year

// Static methods

/**
 * Get total usage and cost for a user
 */
userAnalyticsUsageSchema.statics.getUserTotalUsage = async function(userId) {
    const result = await this.aggregate([
        {
            $match: { user_id: mongoose.Types.ObjectId(userId) }
        },
        {
            $group: {
                _id: '$user_id',
                total_analyses: { $sum: 1 },
                total_tokens: { $sum: '$token_usage.total.total_tokens' },
                total_input_tokens: { $sum: '$token_usage.total.input_tokens' },
                total_output_tokens: { $sum: '$token_usage.total.output_tokens' },
                total_cached_tokens: { $sum: '$token_usage.total.cached_tokens' },
                total_cost_usd: { $sum: '$cost_breakdown.total_cost_usd' },
                total_cost_inr: { $sum: '$cost_breakdown.total_cost_inr' },
                avg_tokens_per_analysis: { $avg: '$token_usage.total.total_tokens' },
                avg_cost_per_analysis_usd: { $avg: '$cost_breakdown.total_cost_usd' },
                avg_cache_hit_rate: { $avg: '$performance.cache_hit_rate' },
                first_analysis: { $min: '$createdAt' },
                last_analysis: { $max: '$createdAt' }
            }
        }
    ]);

    return result.length > 0 ? result[0] : null;
};

/**
 * Get usage breakdown by analysis type for a user
 */
userAnalyticsUsageSchema.statics.getUserUsageByType = async function(userId) {
    return this.aggregate([
        {
            $match: { user_id: mongoose.Types.ObjectId(userId) }
        },
        {
            $group: {
                _id: '$analysis_type',
                count: { $sum: 1 },
                total_tokens: { $sum: '$token_usage.total.total_tokens' },
                total_cost_usd: { $sum: '$cost_breakdown.total_cost_usd' },
                avg_tokens: { $avg: '$token_usage.total.total_tokens' },
                avg_cost_usd: { $avg: '$cost_breakdown.total_cost_usd' }
            }
        },
        {
            $sort: { count: -1 }
        }
    ]);
};

/**
 * Get top N users by cost (for identifying power users)
 */
userAnalyticsUsageSchema.statics.getTopUsersByCost = async function(limit = 100, daysBack = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    return this.aggregate([
        {
            $match: {
                createdAt: { $gte: startDate }
            }
        },
        {
            $group: {
                _id: '$user_id',
                total_analyses: { $sum: 1 },
                total_cost_usd: { $sum: '$cost_breakdown.total_cost_usd' },
                total_cost_inr: { $sum: '$cost_breakdown.total_cost_inr' },
                total_tokens: { $sum: '$token_usage.total.total_tokens' },
                avg_cost_per_analysis: { $avg: '$cost_breakdown.total_cost_usd' },
                last_analysis: { $max: '$createdAt' }
            }
        },
        {
            $sort: { total_cost_usd: -1 }
        },
        {
            $limit: limit
        },
        {
            $lookup: {
                from: 'users',
                localField: '_id',
                foreignField: '_id',
                as: 'user'
            }
        },
        {
            $unwind: '$user'
        },
        {
            $project: {
                user_id: '$_id',
                user_email: '$user.email',
                user_name: '$user.name',
                total_analyses: 1,
                total_cost_usd: 1,
                total_cost_inr: 1,
                total_tokens: 1,
                avg_cost_per_analysis: 1,
                last_analysis: 1
            }
        }
    ]);
};

/**
 * Get daily usage stats (for monitoring API costs)
 */
userAnalyticsUsageSchema.statics.getDailyUsageStats = async function(daysBack = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    return this.aggregate([
        {
            $match: {
                createdAt: { $gte: startDate }
            }
        },
        {
            $group: {
                _id: {
                    $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
                },
                total_analyses: { $sum: 1 },
                unique_users: { $addToSet: '$user_id' },
                total_tokens: { $sum: '$token_usage.total.total_tokens' },
                total_cost_usd: { $sum: '$cost_breakdown.total_cost_usd' },
                total_cost_inr: { $sum: '$cost_breakdown.total_cost_inr' },
                avg_cache_hit_rate: { $avg: '$performance.cache_hit_rate' }
            }
        },
        {
            $addFields: {
                unique_users_count: { $size: '$unique_users' }
            }
        },
        {
            $project: {
                date: '$_id',
                total_analyses: 1,
                unique_users_count: 1,
                total_tokens: 1,
                total_cost_usd: 1,
                total_cost_inr: 1,
                avg_cache_hit_rate: 1,
                avg_cost_per_analysis: { $divide: ['$total_cost_usd', '$total_analyses'] }
            }
        },
        {
            $sort: { date: 1 }
        }
    ]);
};

/**
 * Get usage for a specific date range
 */
userAnalyticsUsageSchema.statics.getUserUsageInDateRange = async function(userId, startDate, endDate) {
    return this.find({
        user_id: userId,
        createdAt: {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
        }
    })
    .select('stock_symbol analysis_type token_usage cost_breakdown performance result createdAt')
    .sort({ createdAt: -1 })
    .lean();
};

// Instance methods

/**
 * Calculate cost based on token usage and pricing model (supports two-model pricing)
 */
userAnalyticsUsageSchema.methods.calculateCost = function(usdToInrRate = 83.0) {
    const { sentiment, stage3 } = this.token_usage;
    const pricing = this.pricing_model;

    // Calculate sentiment model costs
    const sentimentInputCost = (sentiment.input_tokens / 1000) * pricing.sentiment_input_price_per_1k;
    const sentimentOutputCost = (sentiment.output_tokens / 1000) * pricing.sentiment_output_price_per_1k;
    const sentimentCachedCost = (sentiment.cached_tokens / 1000) * pricing.sentiment_cached_price_per_1k;
    const sentimentTotalCost = sentimentInputCost + sentimentOutputCost + sentimentCachedCost;

    // Calculate analysis model costs
    const analysisInputCost = (stage3.input_tokens / 1000) * pricing.analysis_input_price_per_1k;
    const analysisOutputCost = (stage3.output_tokens / 1000) * pricing.analysis_output_price_per_1k;
    const analysisCachedCost = (stage3.cached_tokens / 1000) * pricing.analysis_cached_price_per_1k;
    const analysisTotalCost = analysisInputCost + analysisOutputCost + analysisCachedCost;

    // Combined totals
    const totalCostUsd = sentimentTotalCost + analysisTotalCost;
    const totalCostInr = totalCostUsd * usdToInrRate;

    // Update cost breakdown
    this.cost_breakdown = {
        sentiment_input_cost: sentimentInputCost,
        sentiment_output_cost: sentimentOutputCost,
        sentiment_cached_cost: sentimentCachedCost,
        sentiment_total_cost_usd: sentimentTotalCost,
        analysis_input_cost: analysisInputCost,
        analysis_output_cost: analysisOutputCost,
        analysis_cached_cost: analysisCachedCost,
        analysis_total_cost_usd: analysisTotalCost,
        total_cost_usd: totalCostUsd,
        total_cost_inr: totalCostInr
    };

    // Update pricing model with current rate
    this.pricing_model.usd_to_inr_rate = usdToInrRate;

    return this.cost_breakdown;
};

const UserAnalyticsUsage = mongoose.model('UserAnalyticsUsage', userAnalyticsUsageSchema);

export default UserAnalyticsUsage;
