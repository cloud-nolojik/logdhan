/**
 * AI Usage Log Model
 *
 * Tracks all OpenAI API calls for cost monitoring and analytics.
 * Stores tokens consumed, model used, endpoint, and estimated cost.
 */

import mongoose from 'mongoose';

const aiUsageLogSchema = new mongoose.Schema({
  // What triggered this AI call
  endpoint: {
    type: String,
    required: true,
    index: true
    // Examples: 'trail_check', 'exit_coach', 'stock_analysis', 'quick_verdict', etc.
  },

  // OpenAI model used
  model: {
    type: String,
    required: true,
    default: 'gpt-4o-mini'
    // gpt-4o-mini, gpt-4o, gpt-4-turbo, etc.
  },

  // Token usage from OpenAI response
  tokens: {
    prompt_tokens: { type: Number, default: 0 },
    completion_tokens: { type: Number, default: 0 },
    total_tokens: { type: Number, default: 0 }
  },

  // Estimated cost in USD (based on model pricing)
  estimated_cost_usd: {
    type: Number,
    default: 0
  },

  // Optional context for debugging
  context: {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    position_id: { type: mongoose.Schema.Types.ObjectId, ref: 'UserPosition' },
    analysis_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StockAnalysis' },
    symbol: String
  },

  // Was this a cache hit? (for tracking savings)
  was_cached: {
    type: Boolean,
    default: false
  },

  // Response time in milliseconds
  response_time_ms: {
    type: Number,
    default: 0
  },

  // Timestamp
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Index for daily aggregation
aiUsageLogSchema.index({ created_at: -1, endpoint: 1 });

// Model pricing (per 1K tokens) - Updated Dec 2024
const MODEL_PRICING = {
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },    // $0.15/1M input, $0.60/1M output
  'gpt-4o': { input: 0.0025, output: 0.01 },            // $2.50/1M input, $10/1M output
  'gpt-4-turbo': { input: 0.01, output: 0.03 },         // $10/1M input, $30/1M output
  'gpt-4': { input: 0.03, output: 0.06 },               // Legacy
  'gpt-3.5-turbo': { input: 0.0005, output: 0.0015 }    // Legacy
};

/**
 * Calculate estimated cost based on model and tokens
 */
function calculateCost(model, promptTokens, completionTokens) {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['gpt-4o-mini'];
  const inputCost = (promptTokens / 1000) * pricing.input;
  const outputCost = (completionTokens / 1000) * pricing.output;
  return Math.round((inputCost + outputCost) * 1000000) / 1000000; // Round to 6 decimals
}

/**
 * Log an AI API call
 */
aiUsageLogSchema.statics.logUsage = async function({
  endpoint,
  model = 'gpt-4o-mini',
  usage,  // OpenAI response.usage object
  context = {},
  was_cached = false,
  response_time_ms = 0
}) {
  const promptTokens = usage?.prompt_tokens || 0;
  const completionTokens = usage?.completion_tokens || 0;
  const totalTokens = usage?.total_tokens || promptTokens + completionTokens;

  const estimatedCost = calculateCost(model, promptTokens, completionTokens);

  try {
    await this.create({
      endpoint,
      model,
      tokens: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens
      },
      estimated_cost_usd: estimatedCost,
      context,
      was_cached,
      response_time_ms
    });

    console.log(`[AI USAGE] ${endpoint} | ${model} | ${totalTokens} tokens | $${estimatedCost.toFixed(6)} | ${response_time_ms}ms`);
  } catch (error) {
    console.error(`[AI USAGE ERROR] Failed to log:`, error.message);
  }
};

/**
 * Get usage stats for a time period
 */
aiUsageLogSchema.statics.getStats = async function(startDate, endDate) {
  const match = {};
  if (startDate || endDate) {
    match.created_at = {};
    if (startDate) match.created_at.$gte = new Date(startDate);
    if (endDate) match.created_at.$lte = new Date(endDate);
  }

  const stats = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$endpoint',
        total_calls: { $sum: 1 },
        cached_calls: { $sum: { $cond: ['$was_cached', 1, 0] } },
        total_tokens: { $sum: '$tokens.total_tokens' },
        prompt_tokens: { $sum: '$tokens.prompt_tokens' },
        completion_tokens: { $sum: '$tokens.completion_tokens' },
        total_cost_usd: { $sum: '$estimated_cost_usd' },
        avg_response_time_ms: { $avg: '$response_time_ms' }
      }
    },
    { $sort: { total_cost_usd: -1 } }
  ]);

  // Calculate totals
  const totals = stats.reduce((acc, s) => ({
    total_calls: acc.total_calls + s.total_calls,
    cached_calls: acc.cached_calls + s.cached_calls,
    total_tokens: acc.total_tokens + s.total_tokens,
    total_cost_usd: acc.total_cost_usd + s.total_cost_usd
  }), { total_calls: 0, cached_calls: 0, total_tokens: 0, total_cost_usd: 0 });

  return {
    by_endpoint: stats,
    totals: {
      ...totals,
      cache_hit_rate: totals.total_calls > 0
        ? Math.round((totals.cached_calls / totals.total_calls) * 100)
        : 0,
      estimated_savings_usd: totals.cached_calls * 0.0001  // Rough estimate
    }
  };
};

/**
 * Get daily usage for chart
 */
aiUsageLogSchema.statics.getDailyUsage = async function(days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  return this.aggregate([
    { $match: { created_at: { $gte: startDate } } },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } }
        },
        total_calls: { $sum: 1 },
        total_tokens: { $sum: '$tokens.total_tokens' },
        total_cost_usd: { $sum: '$estimated_cost_usd' }
      }
    },
    { $sort: { '_id.date': 1 } },
    {
      $project: {
        _id: 0,
        date: '$_id.date',
        total_calls: 1,
        total_tokens: 1,
        total_cost_usd: { $round: ['$total_cost_usd', 4] }
      }
    }
  ]);
};

const AIUsageLog = mongoose.model('AIUsageLog', aiUsageLogSchema);

export default AIUsageLog;
