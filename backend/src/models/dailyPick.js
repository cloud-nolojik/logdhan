import mongoose from "mongoose";
import { getIstDayRange } from '../utils/tradingDay.js';

/**
 * Daily Pick — Standalone model for short-term (1-day) trade picks.
 *
 * One document per trading day. Contains market context, up to 3 ranked picks,
 * trade execution tracking, and end-of-day results.
 *
 * Completely separate from swing trading (WeeklyWatchlist / StockAnalysis).
 */

const pickSchema = new mongoose.Schema({
  // Identity
  symbol: { type: String, required: true },
  instrument_key: { type: String },
  stock_name: { type: String },
  scan_type: { type: String, required: true },    // momentum_continuation, pullback_bounce, etc.
  direction: {
    type: String,
    enum: ['LONG', 'SHORT'],
    required: true
  },

  // Scoring
  scan_scores: {
    close_in_range_pct: Number,   // (close - low) / (high - low) * 100
    volume_ratio: Number,         // today_vol / 50d_avg
    rsi: Number,
    atr_pct: Number,
    candle_pattern: String        // bullish_engulfing, bearish_engulfing, hammer, bullish_candle, bearish_candle
  },
  rank_score: { type: Number, min: 0, max: 115 },  // 100 base + 5 confluence + 5 regime = 110 max
  confluence_score: { type: Number, default: 0 },
  confluence_detail: { type: String, default: null },
  regime_bonus: { type: Number, default: 0 },

  // Levels
  levels: {
    entry: Number,                // Yesterday's close (market buy at open estimate)
    stop: Number,                 // Previous day's low (bullish) or high (bearish)
    target: Number,               // Structural target (Daily R1, 1H swing, etc.) from scanLevels engine
    risk_pct: Number,             // Distance to stop %
    reward_pct: Number,           // Distance to structural target %
    risk_reward: Number,          // reward / risk
    mode: String,                 // scanLevels mode (e.g. 'structural', 'atr_fallback')
    reason: String,               // scanLevels reason
    entry_type: String,           // 'buy_above', 'sell_below', or 'limit'
    target1: Number,              // Conservative target
    target3: Number               // Aggressive target
  },

  // Trade execution
  trade: {
    status: {
      type: String,
      enum: ['PENDING', 'COLLECTING_ORB', 'GAP_FADE_WATCH', 'GAP_FADE_EXPIRED', 'VALIDATED', 'ORDER_PLACED', 'ENTERED', 'TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT', 'SKIPPED', 'FAILED'],
      default: 'PENDING'
    },
    entry_price: Number,          // Actual fill price from Kite
    entry_time: Date,
    exit_price: Number,
    exit_time: Date,
    exit_reason: String,          // target_hit, stop_hit, time_exit_3pm, sideways, manual
    exit_price_source: {
      type: String,
      enum: ['order_fill', 'ltp_approximate']
    },
    qty: Number,
    pnl: Number,
    return_pct: Number,
    partial_exit_qty: Number,     // Qty sold via partial profit booking
    partial_exit_price: Number    // Price at partial profit booking
  },

  // Kite order tracking
  kite: {
    entry_order_id: String,       // LIMIT BUY order ID
    stop_order_id: String,        // SL-M SELL order ID
    target_order_id: String,      // LIMIT SELL order ID (structural target)
    kite_status: {
      type: String,
      enum: ['pending', 'collecting_orb', 'validated', 'order_placed', 'gtt_placed', 'amo_placed', 'entered', 'sl_target_placed', 'completed', 'cancelled', 'failed', 'skipped'],
      default: 'pending'
    }
  },

  // ORB (Opening Range Breakout) data — collected across passes (9:30, 9:46, 10:01)
  orb: {
    high: Number,
    low: Number,
    opening_price: Number,
    gap_percent: Number,
    orb_direction: { type: String, enum: ['UP', 'DOWN', 'NEUTRAL'] },
    nifty_orb_direction: { type: String, enum: ['UP', 'DOWN', 'NEUTRAL'] },
    nifty_change_pct: Number,
    orb_pass: { type: Number, default: 1 },
    orb_passes: [{
      pass: Number,
      timestamp: Date,
      orb_high: Number,
      orb_low: Number,
      result: { type: String, enum: ['PASSED', 'FAILED', 'PERMANENT_FAIL'] },
      reason: String
    }]
  },

  // Validation gate — checked at 9:30 AM before placing entry
  validation: {
    passed: Boolean,
    checks: {
      gap_check: { passed: Boolean, value: Number },
      gap_direction: { passed: Boolean, value: Number, direction: String },
      orb_alignment: { passed: Boolean, scan_bias: String, orb_dir: String, new_entry: Number, original_entry: Number, new_rr: Number, min_rr: Number, orb_high: Number, orb_low: Number },
      nifty_alignment: { passed: Boolean, nifty_dir: String, nifty_change_pct: Number, threshold: Number },
      entry_still_valid: { passed: Boolean, orb_range_pct: Number, max_allowed: Number },
      volume_check: { passed: Boolean, ratio: Number }
    },
    skip_reason: String,
    levels_recalculated: Boolean,
    original_levels: { entry: Number, stop: Number, target: Number }
  },

  // Trailing stop history — log of each SL modification
  trailing_history: [{
    timestamp: Date,
    old_stop: Number,
    new_stop: Number,
    price_at_trail: Number
  }],

  // AI insight (optional, generated for top 3 picks)
  ai_insight: { type: String, default: null },
  ai_generated: { type: Boolean, default: false },

  // News sentiment (from globalMarketIntel via newsSentimentFilter)
  news_sentiment: {
    type: String,
    enum: ['BULLISH', 'NEUTRAL', 'BEARISH', null],
    default: null
  },
  news_adjustment: { type: Number, default: 0 }
}, { _id: true });

const dailyPickSchema = new mongoose.Schema({
  // When
  trading_date: { type: Date, required: true, index: true },   // The day trades happen (today)
  scan_date: { type: Date },                                    // Candle date used for scanning (yesterday)

  // Market context at decision time
  market_context: {
    regime: { type: String, enum: ['STRONG_BULLISH', 'BULLISH', 'BEARISH', 'STRONG_BEARISH', 'NEUTRAL', 'UNKNOWN'] },
    nifty_prev_close: Number,
    distance_pct: Number,
    decided_at: Date,
    news_mood: { type: String, enum: ['BULLISH', 'BEARISH', 'MIXED', null], default: null },
    news_breadth: {
      bullish: Number,
      bearish: Number,
      neutral: Number,
      total: Number
    }
  },

  // Selected picks (max 3)
  picks: [pickSchema],

  // Scan summary
  summary: {
    total_candidates: { type: Number, default: 0 },
    bullish_count: { type: Number, default: 0 },
    bearish_count: { type: Number, default: 0 },
    selected_count: { type: Number, default: 0 },
    notification_sent: { type: Boolean, default: false },
    notification_body: String
  },

  // End-of-day results (filled by 3 PM exit job or monitor)
  results: {
    winners: { type: Number, default: 0 },
    losers: { type: Number, default: 0 },
    avg_return_pct: Number,
    total_pnl: Number,
    best_pick: String,
    worst_pick: String
  },

  // Full global market intelligence snapshot (from Claude web search)
  // Stored for audit trail, debugging, and backtest replay
  global_intel: {
    market_mood: { type: String, enum: ['BULLISH', 'BEARISH', 'CAUTIOUS', 'NEUTRAL'], default: 'NEUTRAL' },
    risk_level: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'], default: 'MEDIUM' },
    risk_reason: String,
    trading_recommendation: { type: String, enum: ['NORMAL', 'REDUCE_SIZE', 'AVOID_SHORTS', 'AVOID_LONGS', 'STAY_OUT'], default: 'NORMAL' },
    recommendation_reason: String,
    sgx_nifty: {
      indication: String,
      status: { type: String, enum: ['POSITIVE', 'NEGATIVE', 'FLAT'] },
      points: Number
    },
    global_cues: {
      us_markets: String,
      us_detail: String,
      indian_impact: String,
      asian_markets: String,
      asian_detail: String,
      dollar_index: String,
      rupee_impact: String,
      crude_oil: String,
      crude_price: Number,
      crude_indian_impact: String
    },
    institutional: {
      fii_trend: String,
      fii_value_cr: Number,
      dii_trend: String,
      dii_value_cr: Number
    },
    sectors: { type: mongoose.Schema.Types.Mixed, default: {} },
    major_events: [{ type: mongoose.Schema.Types.Mixed }],
    stock_specific: { type: mongoose.Schema.Types.Mixed, default: {} },
    fetched_at: Date,
    source: String
  },

  // Circuit breaker persistence (survives server restarts)
  circuit_breaker_tripped: { type: Boolean, default: false },
  circuit_breaker_reason: { type: String, default: null },
  circuit_breaker_at: { type: Date, default: null },

  // Candidate review table — all scored candidates with decisions (for admin review)
  candidates_review: [{
    symbol: String,
    scan_type: String,
    direction: String,
    rank_score: Number,
    candle: {
      open: Number,
      high: Number,
      low: Number,
      close: Number,
      prev_close: Number,
      volume: Number
    },
    indicators: {
      ema20: Number,
      atr: Number,
      rsi: Number
    },
    levels: {
      entry: Number,
      stop: Number,
      target: Number,
      risk_pct: Number,
      risk_reward: Number,
      target_basis: String,
      mode: String
    },
    status: String,
    rejection_reason: String
  }]
}, { timestamps: true });

// Compound indexes
dailyPickSchema.index({ 'picks.symbol': 1, trading_date: -1 });
dailyPickSchema.index({ 'picks.trade.status': 1 });

/**
 * Find today's daily pick document
 */
dailyPickSchema.statics.findToday = function () {
  const today = getIstDayRange().startUtc;
  return this.findOne({ trading_date: today });
};

/**
 * Find recent daily picks for history
 */
dailyPickSchema.statics.findRecent = function (days = 7) {
  const today = getIstDayRange().startUtc;
  const cutoff = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
  return this.find({ trading_date: { $gte: cutoff } }).sort({ trading_date: -1 });
};

const DailyPick = mongoose.model('DailyPick', dailyPickSchema);

export default DailyPick;
