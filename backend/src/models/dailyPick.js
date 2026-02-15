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
  rank_score: { type: Number, min: 0, max: 100 },

  // Levels
  levels: {
    entry: Number,                // Yesterday's close (market buy at open estimate)
    stop: Number,                 // Previous day's low (bullish) or high (bearish)
    target: Number,               // Entry * 1.02 (recalculated from actual fill)
    risk_pct: Number,             // Distance to stop %
    reward_pct: Number,           // Always 2%
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
      enum: ['PENDING', 'COLLECTING_ORB', 'VALIDATED', 'ORDER_PLACED', 'ENTERED', 'TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT', 'SKIPPED', 'FAILED'],
      default: 'PENDING'
    },
    entry_price: Number,          // Actual fill price from Kite
    entry_time: Date,
    exit_price: Number,
    exit_time: Date,
    exit_reason: String,          // target_hit, stop_hit, time_exit_3pm, manual
    exit_price_source: {
      type: String,
      enum: ['order_fill', 'ltp_approximate']
    },
    qty: Number,
    pnl: Number,
    return_pct: Number
  },

  // Kite order tracking
  kite: {
    entry_order_id: String,       // LIMIT BUY order ID
    stop_order_id: String,        // SL-M SELL order ID
    target_order_id: String,      // LIMIT SELL order ID (+2% target)
    kite_status: {
      type: String,
      enum: ['pending', 'collecting_orb', 'validated', 'order_placed', 'entered', 'sl_target_placed', 'completed', 'failed', 'skipped'],
      default: 'pending'
    }
  },

  // ORB (Opening Range Breakout) data — collected 9:15-9:30 AM
  orb: {
    high: Number,
    low: Number,
    opening_price: Number,
    gap_percent: Number,
    orb_direction: { type: String, enum: ['UP', 'DOWN', 'NEUTRAL'] },
    nifty_orb_direction: { type: String, enum: ['UP', 'DOWN', 'NEUTRAL'] }
  },

  // Validation gate — checked at 9:30 AM before placing entry
  validation: {
    passed: Boolean,
    checks: {
      gap_check: { passed: Boolean, value: Number },
      orb_alignment: { passed: Boolean, scan_bias: String, orb_dir: String },
      nifty_alignment: { passed: Boolean, nifty_dir: String },
      entry_still_valid: { passed: Boolean, distance_percent: Number },
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
  ai_generated: { type: Boolean, default: false }
}, { _id: true });

const dailyPickSchema = new mongoose.Schema({
  // When
  trading_date: { type: Date, required: true, index: true },   // The day trades happen (today)
  scan_date: { type: Date },                                    // Candle date used for scanning (yesterday)

  // Market context at decision time
  market_context: {
    regime: { type: String, enum: ['BULLISH', 'BEARISH', 'NEUTRAL', 'UNKNOWN'] },
    gift_nifty_pct: Number,
    gift_nifty_status: { type: String, enum: ['POSITIVE', 'NEGATIVE', 'FLAT'] },
    nifty_prev_close: Number,
    decided_at: Date
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
  }
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
