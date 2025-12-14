import mongoose from 'mongoose';
import MarketHoursUtil from '../utils/marketHours.js';

const indicatorSignalSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      enum: ['ema20_1D', 'ema50_1D', 'sma200_1D', 'rsi14_1h', 'atr14_1D'],
      required: true
    },
    value: {
      type: Number,
      default: null
    },
    signal: {
      type: String,
      enum: ['BUY', 'SELL', 'NEUTRAL'],
      required: true
    }
  },
  { _id: false, strict: 'throw' }
);

const strategyV14Schema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: { type: String, enum: ['BUY', 'SELL', 'NO_TRADE'], required: true },
    archetype: {
      type: String,
      enum: ['breakout', 'pullback', 'trend-follow', 'mean-reversion', 'range-fade'],
      required: true
    },
    alignment: { type: String, enum: ['with_trend', 'counter_trend', 'neutral'], required: true },

    title: { type: String, required: true },
    confidence: { type: Number, required: true, min: 0, max: 1 },

    why_best: { type: String, required: true },

    entryType: { type: String, enum: ['limit', 'market', 'range', 'stop', 'stop-limit'], required: true },
    entry: { type: Number, default: null },
    entryRange: { type: [Number], default: null },
    target: { type: Number, default: null },
    stopLoss: { type: Number, default: null },

    riskReward: {
      type: Number,
      required: true,
      set: (v) => (v == null ? v : Number(v))
    },

    timeframe: { type: String, enum: ['3-7 days'], required: true },

    indicators: { type: [indicatorSignalSchema], default: [] },

    reasoning: { type: [{ because: String }], default: [] },

    warnings: {
      type: [
        {
          code: { type: String, enum: ['GAP_RISK', 'HIGH_VOLATILITY', 'LOW_VOLUME', 'NEWS_EVENT', 'SECTOR_WEAKNESS'] },
          severity: { type: String, enum: ['low', 'medium', 'high'] },
          text: String,
          applies_when: { type: [mongoose.Schema.Types.Mixed], default: [] },
          mitigation: { type: [String], default: [] }
        }
      ],
      default: []
    },

    triggers: { type: [mongoose.Schema.Types.Mixed], default: [] },

    confirmation: {
      require: { type: String, enum: ['ALL', 'ANY', 'NONE'], required: true },
      window_bars: { type: Number, required: true },
      conditions: { type: [mongoose.Schema.Types.Mixed], default: [] }
    },

    invalidations: { type: [mongoose.Schema.Types.Mixed], default: [] },

    validity: {
      entry: {
        type: {
          type: String,
          enum: ['GTD'],
          required: true
        },
        bars_limit: { type: Number, required: true },
        trading_sessions_soft: { type: Number, required: true },
        trading_sessions_hard: { type: Number, required: true },
        expire_calendar_cap_days: { type: Number, required: true }
      },
      position: {
        time_stop_sessions: { type: Number, required: true },
        gap_policy: { type: String, enum: ['exit_at_open_with_slippage'], required: true }
      },
      non_trading_policy: { type: String, enum: ['pause_clock'], required: true }
    },

    beginner_summary: mongoose.Schema.Types.Mixed,
    why_in_plain_words: { type: [mongoose.Schema.Types.Mixed], default: [] },
    what_could_go_wrong: { type: [mongoose.Schema.Types.Mixed], default: [] },
    ui_friendly: mongoose.Schema.Types.Mixed,

    money_example: mongoose.Schema.Types.Mixed,
    suggested_qty: mongoose.Schema.Types.Mixed,
    risk_meter: mongoose.Schema.Types.Mixed,
    actionability: mongoose.Schema.Types.Mixed,
    glossary: mongoose.Schema.Types.Mixed
  },
  { _id: false, strict: 'throw' }
);

const analysisDataV14Schema = new mongoose.Schema(
  {
    schema_version: {
      type: String,
      default: '1.4'
    },
    symbol: String,
    analysis_type: {
      type: String,
      enum: ['swing', 'intraday']
    },
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
    sentiment_analysis: {
      confidence: Number,
      strength: { type: String, enum: ['high', 'medium', 'low'] },
      reasoning: String,
      key_factors: [String],
      sector_specific: Boolean,
      market_alignment: { type: String, enum: ['aligned', 'contrary', 'neutral'] },
      trading_bias: { type: String, enum: ['bullish', 'bearish', 'neutral'] },
      risk_level: { type: String, enum: ['low', 'medium', 'high'] },
      position_sizing: { type: String, enum: ['increased', 'standard', 'reduced'] },
      entry_strategy: { type: String, enum: ['aggressive', 'moderate', 'cautious'] },
      news_count: Number,
      recent_news_count: Number,
      sector_news_weight: { type: Number, min: 0, max: 1 }
    },
    runtime: {
      triggers_evaluated: { type: [mongoose.Schema.Types.Mixed], default: [] },
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
    confidence_breakdown: {
      base_score: Number,
      adjustments: [{
        code: String,
        reason: String,
        delta: Number
      }],
      final: Number
    },
    strategies: { type: [strategyV14Schema], default: [] },
    performance_hints: {
      confidence_drivers: [String],
      uncertainty_factors: [String],
      data_quality_score: { type: Number, min: 0, max: 1 }
    },
    disclaimer: {
      type: String,
      default: 'AI-generated educational interpretation of price behaviour. Not investment advice or a recommendation to buy or sell any security.'
    }
  },
  { _id: false, strict: 'throw' }
);

const timeframeInfoSchema = new mongoose.Schema(
  {
    timeframe: String,
    key: String,
    bars_count: Number,
    last_candle_time: String
  },
  { _id: false, strict: false }
);

const candleInfoSchema = new mongoose.Schema(
  {
    timeframes_used: { type: [timeframeInfoSchema], default: [] },
    primary_timeframe: String,
    last_candle_time: String,
    data_quality: mongoose.Schema.Types.Mixed
  },
  { _id: false, strict: false }
);

const analysisMetaSchema = new mongoose.Schema(
  {
    data_as_of_ist: String,
    stalePrice: Boolean,
    generated_at_ist: String,
    candle_info: candleInfoSchema,
    debug: mongoose.Schema.Types.Mixed
  },
  { _id: false, strict: false }
);

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
    required: function () {
      return this.status !== 'failed';
    },
    validate: {
      validator: function (value) {
        // If status is 'failed', current_price can be null/undefined
        if (this.status === 'failed') {
          return true;
        }
        // Otherwise, must be a positive number
        return value && !isNaN(value) && value > 0;
      },
      message: 'current_price must be a positive number for non-failed analyses'
    }
  },
  analysis_data: { type: analysisDataV14Schema, default: {} },
  analysis_meta: { type: analysisMetaSchema, default: {} },
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
  // Release time for scheduled analyses (only visible after this time)
  scheduled_release_time: {
    type: Date,
    default: null,
    index: true
  },
  // Valid until next market close - strategy should be revalidated after this time
  valid_until: {
    type: Date,
    default: null,
    index: true
  },
  // Track when strategy was last validated by AI
  last_validated_at: {
    type: Date,
    default: null
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
      main_order_id: String, // Entry order ID
      stop_loss_order_id: String, // Stop loss order ID  
      target_order_id: String, // Target order ID
      all_order_ids: [String] // Array of all order IDs for easy lookup
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

stockAnalysisSchema.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  }
});

stockAnalysisSchema.set('toObject', { virtuals: true });

// Compound index for efficient queries - shared across all users
stockAnalysisSchema.index({
  instrument_key: 1,
  analysis_type: 1,
  created_at: 1
});

// TTL index removed - strategies no longer auto-expire
// Validation and cleanup handled by bulk analysis service

// Static methods
stockAnalysisSchema.statics.findActive = function (limit = 10) {
  return this.find({
    status: 'completed'
  }).
  sort({ created_at: -1 }).
  limit(limit);
};

stockAnalysisSchema.statics.findByInstrument = function (instrumentKey, analysisType) {
  const now = new Date();
  return this.findOne({
    instrument_key: instrumentKey,
    analysis_type: analysisType,
    status: { $in: ['completed', 'in_progress'] },
    // Only show if scheduled_release_time is null OR has passed
    $or: [
    { scheduled_release_time: null },
    { scheduled_release_time: { $lte: now } }]

  }).
  sort({ created_at: -1 });
};

stockAnalysisSchema.statics.findInProgressAnalysis = function (instrumentKey, analysisType) {
  return this.findOne({
    instrument_key: instrumentKey,
    analysis_type: analysisType,
    status: 'in_progress'
  }).
  sort({ created_at: -1 });
};

// Instance methods for progress tracking
stockAnalysisSchema.methods.updateProgress = function (step, percentage, estimatedTimeRemaining = null) {
  this.progress.current_step = step;
  this.progress.percentage = Math.min(100, Math.max(0, percentage));
  this.progress.steps_completed = Math.floor(percentage / 100 * this.progress.total_steps);
  if (estimatedTimeRemaining !== null) {
    this.progress.estimated_time_remaining = estimatedTimeRemaining;
  }
  this.progress.last_updated = new Date();
  this.status = percentage >= 100 ? 'completed' : 'in_progress';
  return this.save();
};

stockAnalysisSchema.methods.markCompleted = async function () {
  this.status = 'completed';
  this.progress.percentage = 100;
  this.progress.current_step = 'Analysis completed';
  this.progress.estimated_time_remaining = 0;
  this.progress.last_updated = new Date();

  // Set valid_until to next market close (3:59:59 PM IST)
  const MarketHoursUtil = (await import('../utils/marketHours.js')).default;
  this.valid_until = await MarketHoursUtil.getValidUntilTime();

  return this.save();
};

stockAnalysisSchema.methods.markFailed = function (error = 'Analysis failed') {
  this.status = 'failed';
  this.progress.current_step = `Failed: ${error}`;
  this.progress.last_updated = new Date();

  // Ensure analysis_data has minimum required fields to pass validation
  const fallbackStrategy = {
    id: 'failed-analysis',
    type: 'NO_TRADE',
    archetype: 'mean-reversion',
    alignment: 'neutral',
    title: 'Analysis Failed',
    confidence: 0,
    why_best: error,
    entryType: 'limit',
    entry: null,
    entryRange: null,
    target: null,
    stopLoss: null,
    riskReward: 0,
    timeframe: '3-7 days',
    indicators: [],
    reasoning: [{ because: error }],
    warnings: [],
    triggers: [],
    confirmation: { require: 'NONE', window_bars: 0, conditions: [] },
    invalidations: [],
    validity: {
      entry: { type: 'GTD', bars_limit: 0, trading_sessions_soft: 0, trading_sessions_hard: 0, expire_calendar_cap_days: 0 },
      position: { time_stop_sessions: 0, gap_policy: 'exit_at_open_with_slippage' },
      non_trading_policy: 'pause_clock'
    },
    beginner_summary: {},
    why_in_plain_words: [],
    what_could_go_wrong: [],
    ui_friendly: {},
    money_example: {},
    suggested_qty: {},
    risk_meter: {},
    actionability: { label: 'No structure', status: 'monitor_only', next_check_in: 'daily', checklist: [] },
    glossary: {}
  };

  this.analysis_data = {
    schema_version: '1.4',
    symbol: this.stock_symbol,
    analysis_type: this.analysis_type,
    generated_at_ist: this.analysis_data?.generated_at_ist || new Date().toISOString(),
    insufficientData: true,
    market_summary: {
      last: this.current_price || 0,
      trend: 'NEUTRAL',
      volatility: 'MEDIUM',
      volume: 'UNKNOWN'
    },
    overall_sentiment: 'NEUTRAL',
    sentiment_analysis: {
      confidence: 0,
      strength: 'low',
      reasoning: error,
      key_factors: [],
      sector_specific: false,
      market_alignment: 'neutral',
      trading_bias: 'neutral',
      risk_level: 'high',
      position_sizing: 'reduced',
      entry_strategy: 'cautious',
      news_count: 0,
      recent_news_count: 0,
      sector_news_weight: 0
    },
    runtime: {
      triggers_evaluated: [],
      pre_entry_invalidations_hit: true
    },
    order_gate: {
      all_triggers_true: false,
      no_pre_entry_invalidations: false,
      actionability_status: 'monitor_only',
      entry_type_sane: false,
      can_place_order: false
    },
    strategies: [fallbackStrategy],
    performance_hints: {
      confidence_drivers: [],
      uncertainty_factors: [error],
      data_quality_score: 0
    },
    disclaimer: 'AI-generated educational interpretation of price behaviour. Not investment advice or a recommendation to buy or sell any security.'
  };

  return this.save();
};

// Order tracking methods
stockAnalysisSchema.methods.hasActiveOrders = function () {
  return this.placed_orders && this.placed_orders.some((order) =>
  order.status === 'ACTIVE' || order.status === 'PARTIALLY_FILLED'
  );
};

stockAnalysisSchema.methods.addPlacedOrders = function (orderData) {
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

  }

  this.orders_placed_count = this.placed_orders.length;
  this.last_order_placed_at = new Date();
  return this.save();
};

stockAnalysisSchema.methods.getOrderTypeFromCorrelationId = function (correlationId) {
  if (correlationId.includes('_M')) return 'MAIN';
  if (correlationId.includes('_S')) return 'STOP_LOSS';
  if (correlationId.includes('_T')) return 'TARGET';
  return 'SINGLE';
};

stockAnalysisSchema.methods.getPlacedOrderIds = function () {
  if (!this.placed_orders) return [];

  // Flatten all order IDs from all bracket orders
  return this.placed_orders.reduce((allIds, bracketOrder) => {
    return allIds.concat(bracketOrder.order_ids.all_order_ids || []);
  }, []);
};

stockAnalysisSchema.methods.updateOrderStatus = function (tag, newStatus) {
  if (this.placed_orders) {
    const bracketOrder = this.placed_orders.find((order) => order.tag === tag);
    if (bracketOrder) {
      bracketOrder.status = newStatus;
      return this.save();
    }
  }
  return Promise.resolve(this);
};

// New methods for condition validation
stockAnalysisSchema.methods.canPlaceOrder = function () {
  // Check if order_gate allows order placement
  if (!this.analysis_data?.order_gate) {

    return false;
  }

  const orderGate = this.analysis_data.order_gate;

  // All conditions must be true
  const canPlace = orderGate.can_place_order === true &&
  orderGate.all_triggers_true === true &&
  orderGate.no_pre_entry_invalidations === true &&
  orderGate.entry_type_sane === true &&
  orderGate.actionability_status === 'actionable_now';

  return canPlace;
};

stockAnalysisSchema.methods.getConditionValidationDetails = function () {
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
  const triggerDetails = runtime.triggers_evaluated?.map((trigger) => ({
    id: trigger.id,
    description: `${trigger.left_ref} ${trigger.op} ${trigger.right_ref}`,
    passed: trigger.passed,
    evaluable: trigger.evaluable,
    left_value: trigger.left_value,
    right_value: trigger.right_value
  })) || [];

  const failedTriggers = triggerDetails.filter((t) => !t.passed || !t.evaluable);

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

stockAnalysisSchema.methods._getValidationFailureReason = function (orderGate, failedTriggers) {
  if (!orderGate.can_place_order) {
    if (failedTriggers.length > 0) {
      return `Entry conditions not met: ${failedTriggers.map((t) => t.description).join(', ')}`;
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
stockAnalysisSchema.statics.isMarketOpen = function () {
  const now = new Date();
  const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day = istTime.getDay(); // 0 = Sunday, 6 = Saturday
  const hours = istTime.getHours();
  const minutes = istTime.getMinutes();
  const currentTime = hours * 60 + minutes; // Convert to minutes

  // Market closed on weekends
  if (day === 0 || day === 6) return false;

  // Market hours: 9:15 AM to 3:30 PM IST
  const marketOpen = 9 * 60 + 15; // 9:15 AM
  const marketClose = 15 * 60 + 30; // 3:30 PM

  return currentTime >= marketOpen && currentTime <= marketClose;
};

// Method to check if analysis is allowed (4 PM - 9 AM, except 3-4 PM on trading days)
stockAnalysisSchema.statics.isAnalysisAllowed = function () {
  const now = new Date();
  const istTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const currentDay = istTime.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const currentTime = istTime.getHours() * 60 + istTime.getMinutes(); // Total minutes

  // Never allow analysis on Saturday evening (after 4 PM) or Sunday
  if (currentDay === 6 && currentTime >= 16 * 60) {
    return { allowed: false, reason: "weekend_restriction", nextAllowed: "Monday 5.00 PM" };
  }
  if (currentDay === 0) {
    return { allowed: false, reason: "weekend_restriction", nextAllowed: "Monday 5.00 PM" };
  }

  // Trading days (Monday-Friday)
  if (currentDay >= 1 && currentDay <= 5) {
    // Allow: 4 PM - 11:59 PM OR 12 AM - 9 AM
    const eveningStart = 16 * 60; // 5.00 PM
    const morningEnd = 9 * 60; // 9:00 AM
    const marketPreClose = 15 * 60; // 3:00 PM
    const marketClose = 15 * 60 + 30; // 3:30 PM

    // Special window: 3:00 PM - 5.00 PM (allowed on trading days only)
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

  return { allowed: false, reason: "general_restriction", nextAllowed: "Today 5.00 PM" };
};

// Method to check if bulk analysis is allowed (4 PM to next trading day 8.59 AM)
// Now uses MarketHoursUtil for consistent timezone handling and trading day checks
stockAnalysisSchema.statics.isBulkAnalysisAllowed = async function () {
  return await MarketHoursUtil.isBulkAnalysisAllowed();
};

/**
 * Calculate expiry time using common utility
 * ALL analyses expire at 3:59 PM IST on NEXT trading day
 * Stored in DB as UTC (10:29:59 AM UTC)
 */
stockAnalysisSchema.statics.getExpiryTime = async function () {
  return await MarketHoursUtil.getValidUntilTime();
};

// Removed old canRunBulkAnalysis - now using upstoxMarketTimingService.canRunBulkAnalysis()

stockAnalysisSchema.statics.getAnalysisStats = function () {
  return this.aggregate([
  { $match: { status: 'completed' } },
  {
    $group: {
      _id: '$analysis_type',
      count: { $sum: 1 },
      latest: { $max: '$created_at' }
    }
  }]
  );
};

// Static method to clean up stale order processing locks
stockAnalysisSchema.statics.cleanupStaleOrderProcessingLocks = async function () {
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

    }

    return result;
  } catch (error) {
    console.error('❌ Error cleaning up stale order processing locks:', error);
    return null;
  }
};

const StockAnalysis = mongoose.model('StockAnalysis', stockAnalysisSchema);

export default StockAnalysis;
