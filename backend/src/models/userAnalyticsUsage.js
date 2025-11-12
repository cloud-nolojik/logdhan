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
    // Token usage breakdown
    token_usage: {
        // Stage 1: Preflight & Market Summary
        stage1: {
            input_tokens: { type: Number, default: 0 },
            output_tokens: { type: Number, default: 0 },
            cached_tokens: { type: Number, default: 0 },
            total_tokens: { type: Number, default: 0 }
        },
        // Stage 2: Strategy Skeleton
        stage2: {
            input_tokens: { type: Number, default: 0 },
            output_tokens: { type: Number, default: 0 },
            cached_tokens: { type: Number, default: 0 },
            total_tokens: { type: Number, default: 0 }
        },
        // Stage 3: Final Assembly
        stage3: {
            input_tokens: { type: Number, default: 0 },
            output_tokens: { type: Number, default: 0 },
            cached_tokens: { type: Number, default: 0 },
            total_tokens: { type: Number, default: 0 }
        },
        // Total across all stages
        total: {
            input_tokens: { type: Number, default: 0 },
            output_tokens: { type: Number, default: 0 },
            cached_tokens: { type: Number, default: 0 },
            total_tokens: { type: Number, default: 0 }
        }
    },
    // Cost calculation (OpenAI pricing as of 2025)
    // These can be updated based on current pricing
    cost_breakdown: {
        input_cost: { type: Number, default: 0 },      // Input tokens cost in USD
        output_cost: { type: Number, default: 0 },     // Output tokens cost in USD
        cached_cost: { type: Number, default: 0 },     // Cached tokens cost in USD (usually 50% discount)
        total_cost_usd: { type: Number, default: 0 },  // Total cost in USD
        total_cost_inr: { type: Number, default: 0 }   // Total cost in INR (for local currency tracking)
    },
    // Pricing model used for this analysis
    pricing_model: {
        model_name: { type: String, default: 'gpt-4o' },  // e.g., 'gpt-4o', 'gpt-4o-mini'
        input_price_per_1k: { type: Number, default: 0.0025 },   // USD per 1K input tokens
        output_price_per_1k: { type: Number, default: 0.010 },   // USD per 1K output tokens
        cached_price_per_1k: { type: Number, default: 0.00125 }, // USD per 1K cached tokens
        usd_to_inr_rate: { type: Number, default: 83.0 }         // Exchange rate used
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
 * Calculate cost based on token usage and pricing model
 */
userAnalyticsUsageSchema.methods.calculateCost = function(usdToInrRate = 83.0) {
    const { total } = this.token_usage;
    const pricing = this.pricing_model;

    // Calculate costs
    const inputCost = (total.input_tokens / 1000) * pricing.input_price_per_1k;
    const outputCost = (total.output_tokens / 1000) * pricing.output_price_per_1k;
    const cachedCost = (total.cached_tokens / 1000) * pricing.cached_price_per_1k;

    const totalCostUsd = inputCost + outputCost + cachedCost;
    const totalCostInr = totalCostUsd * usdToInrRate;

    // Update cost breakdown
    this.cost_breakdown = {
        input_cost: inputCost,
        output_cost: outputCost,
        cached_cost: cachedCost,
        total_cost_usd: totalCostUsd,
        total_cost_inr: totalCostInr
    };

    // Update pricing model with current rate
    this.pricing_model.usd_to_inr_rate = usdToInrRate;

    return this.cost_breakdown;
};

const UserAnalyticsUsage = mongoose.model('UserAnalyticsUsage', userAnalyticsUsageSchema);

export default UserAnalyticsUsage;
