import mongoose from "mongoose";

/**
 * ApiUsage schema
 * Tracks API usage (OpenAI, etc.) for cost monitoring
 */
const apiUsageSchema = new mongoose.Schema({
  // API provider
  provider: {
    type: String,
    enum: ['OPENAI', 'ANTHROPIC', 'GOOGLE', 'OTHER'],
    required: true,
    default: 'OPENAI'
  },

  // Model used
  model: {
    type: String,
    required: true
  },

  // Feature/service that made the call
  feature: {
    type: String,
    enum: ['DAILY_NEWS_STOCKS', 'MARKET_SENTIMENT', 'HEADLINE_SENTIMENT', 'AI_ANALYSIS', 'OTHER'],
    required: true
  },

  // Token usage
  tokens: {
    input: { type: Number, default: 0 },
    output: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
  },

  // Cost calculation (in USD)
  cost: {
    input_cost: { type: Number, default: 0 },
    output_cost: { type: Number, default: 0 },
    total_cost: { type: Number, default: 0 }
  },

  // Request metadata
  request_id: { type: String },          // Unique request ID
  scrape_run_id: { type: String },       // Link to scrape run (if applicable)

  // Response metadata
  response_time_ms: { type: Number },    // How long the request took
  success: { type: Boolean, default: true },
  error_message: { type: String },

  // Timestamp (IST date as UTC midnight for daily aggregation)
  usage_date: { type: Date, required: true, index: true },

  // Additional context
  context: {
    symbol: String,                      // Stock symbol if applicable
    headlines_count: Number,             // Number of headlines processed
    description: String                  // Brief description of what was done
  }

}, { timestamps: true });

// Indexes for efficient querying
apiUsageSchema.index({ provider: 1, usage_date: -1 });
apiUsageSchema.index({ feature: 1, usage_date: -1 });
apiUsageSchema.index({ scrape_run_id: 1 });
apiUsageSchema.index({ createdAt: -1 });

/**
 * Get IST date as UTC midnight
 */
apiUsageSchema.statics.getISTDateAsUTC = function(date = new Date()) {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffset);
  const year = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth();
  const day = istDate.getUTCDate();
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
};

/**
 * GPT-4o pricing (as of Jan 2025)
 * Input: $2.50 / 1M tokens
 * Output: $10.00 / 1M tokens
 */
const PRICING = {
  'gpt-4o': {
    input: 2.50 / 1000000,   // $2.50 per 1M tokens
    output: 10.00 / 1000000  // $10.00 per 1M tokens
  },
  'gpt-4o-mini': {
    input: 0.15 / 1000000,   // $0.15 per 1M tokens
    output: 0.60 / 1000000   // $0.60 per 1M tokens
  },
  'gpt-4-turbo': {
    input: 10.00 / 1000000,
    output: 30.00 / 1000000
  },
  'default': {
    input: 5.00 / 1000000,
    output: 15.00 / 1000000
  }
};

/**
 * Calculate cost based on model and tokens
 */
apiUsageSchema.statics.calculateCost = function(model, inputTokens, outputTokens) {
  const pricing = PRICING[model] || PRICING['default'];
  const inputCost = inputTokens * pricing.input;
  const outputCost = outputTokens * pricing.output;
  return {
    input_cost: parseFloat(inputCost.toFixed(6)),
    output_cost: parseFloat(outputCost.toFixed(6)),
    total_cost: parseFloat((inputCost + outputCost).toFixed(6))
  };
};

/**
 * Log API usage
 */
apiUsageSchema.statics.logUsage = async function(data) {
  const usageDate = this.getISTDateAsUTC();

  // Calculate cost if tokens provided
  let cost = { input_cost: 0, output_cost: 0, total_cost: 0 };
  if (data.tokens) {
    cost = this.calculateCost(
      data.model,
      data.tokens.input || 0,
      data.tokens.output || 0
    );
  }

  const usage = new this({
    provider: data.provider || 'OPENAI',
    model: data.model,
    feature: data.feature,
    tokens: {
      input: data.tokens?.input || 0,
      output: data.tokens?.output || 0,
      total: (data.tokens?.input || 0) + (data.tokens?.output || 0)
    },
    cost,
    request_id: data.request_id,
    scrape_run_id: data.scrape_run_id,
    response_time_ms: data.response_time_ms,
    success: data.success !== false,
    error_message: data.error_message,
    usage_date: usageDate,
    context: data.context || {}
  });

  await usage.save();
  return usage;
};

/**
 * Get today's usage summary
 */
apiUsageSchema.statics.getTodaySummary = async function() {
  const today = this.getISTDateAsUTC();

  const result = await this.aggregate([
    { $match: { usage_date: today } },
    {
      $group: {
        _id: { feature: '$feature', model: '$model' },
        total_requests: { $sum: 1 },
        total_input_tokens: { $sum: '$tokens.input' },
        total_output_tokens: { $sum: '$tokens.output' },
        total_tokens: { $sum: '$tokens.total' },
        total_cost: { $sum: '$cost.total_cost' },
        avg_response_time: { $avg: '$response_time_ms' },
        success_count: { $sum: { $cond: ['$success', 1, 0] } },
        error_count: { $sum: { $cond: ['$success', 0, 1] } }
      }
    },
    { $sort: { total_cost: -1 } }
  ]);

  // Calculate totals
  const totals = result.reduce((acc, item) => {
    acc.total_requests += item.total_requests;
    acc.total_tokens += item.total_tokens;
    acc.total_cost += item.total_cost;
    return acc;
  }, { total_requests: 0, total_tokens: 0, total_cost: 0 });

  return {
    date: today,
    by_feature: result,
    totals
  };
};

/**
 * Get usage summary for date range
 */
apiUsageSchema.statics.getUsageSummary = async function(startDate, endDate) {
  const result = await this.aggregate([
    {
      $match: {
        usage_date: {
          $gte: startDate,
          $lte: endDate
        }
      }
    },
    {
      $group: {
        _id: { date: '$usage_date', feature: '$feature' },
        total_requests: { $sum: 1 },
        total_tokens: { $sum: '$tokens.total' },
        total_cost: { $sum: '$cost.total_cost' }
      }
    },
    { $sort: { '_id.date': -1, total_cost: -1 } }
  ]);

  return result;
};

/**
 * Get monthly cost summary
 */
apiUsageSchema.statics.getMonthlySummary = async function(year, month) {
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  const result = await this.aggregate([
    {
      $match: {
        usage_date: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: '$feature',
        total_requests: { $sum: 1 },
        total_input_tokens: { $sum: '$tokens.input' },
        total_output_tokens: { $sum: '$tokens.output' },
        total_tokens: { $sum: '$tokens.total' },
        total_cost: { $sum: '$cost.total_cost' }
      }
    },
    { $sort: { total_cost: -1 } }
  ]);

  const totals = result.reduce((acc, item) => {
    acc.total_requests += item.total_requests;
    acc.total_tokens += item.total_tokens;
    acc.total_cost += item.total_cost;
    return acc;
  }, { total_requests: 0, total_tokens: 0, total_cost: 0 });

  return {
    year,
    month,
    by_feature: result,
    totals
  };
};

const ApiUsage = mongoose.model("ApiUsage", apiUsageSchema);

export default ApiUsage;
