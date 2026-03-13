import mongoose from "mongoose";

/**
 * Daily Pick Backtest — Stores pipeline backtest results in a separate collection.
 *
 * Same structure as DailyPick but for backtest simulation results.
 * One document per backtested trading day. Contains:
 * - Original candidates from DailyPick.candidates_review
 * - Fresh global market intel fetched for that date via Claude web search
 * - Re-scored and re-selected picks using real pipeline functions
 * - Simulated trade results (ORB validation + tick-by-tick P&L)
 * - Comparison with what the real system picked that day
 */

const backtestPickSchema = new mongoose.Schema({
  // Identity
  symbol: { type: String, required: true },
  instrument_key: { type: String },
  stock_name: { type: String },
  scan_type: { type: String, required: true },
  direction: {
    type: String,
    enum: ['LONG', 'SHORT'],
    required: true
  },

  // Scoring
  scan_scores: {
    close_in_range_pct: Number,
    volume_ratio: Number,
    rsi: Number,
    atr_pct: Number,
    candle_pattern: String
  },
  rank_score: { type: Number, min: 0, max: 115 },
  confluence_score: { type: Number, default: 0 },
  confluence_detail: { type: String, default: null },
  regime_bonus: { type: Number, default: 0 },

  // Levels
  levels: {
    entry: Number,
    stop: Number,
    target: Number,
    risk_pct: Number,
    reward_pct: Number,
    risk_reward: Number,
    mode: String,
    reason: String,
    entry_type: String,
    target1: Number,
    target3: Number
  },

  // Simulated trade execution
  trade: {
    status: {
      type: String,
      enum: ['PENDING', 'COLLECTING_ORB', 'GAP_FADE_WATCH', 'GAP_FADE_EXPIRED', 'VALIDATED', 'ORDER_PLACED', 'ENTERED', 'TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT', 'SKIPPED', 'FAILED', 'NO_FILL', 'NO_DATA'],
      default: 'PENDING'
    },
    entry_price: Number,
    entry_time: Date,
    exit_price: Number,
    exit_time: Date,
    exit_reason: String,
    qty: Number,
    pnl: Number,
    return_pct: Number,
    partial_exit_qty: Number,
    partial_exit_price: Number
  },

  // ORB data from simulation
  orb: {
    high: Number,
    low: Number,
    opening_price: Number,
    gap_percent: Number,
    orb_direction: { type: String, enum: ['UP', 'DOWN', 'NEUTRAL'] },
    nifty_orb_direction: { type: String, enum: ['UP', 'DOWN', 'NEUTRAL'] },
    nifty_change_pct: Number,
    orb_pass: { type: Number, default: 1 },
    result: { type: String, enum: ['PASSED', 'FAILED'] }
  },

  // Validation result
  validation: {
    passed: Boolean,
    skip_reason: String
  },

  // Trailing stop history
  trailing_history: [{
    timestamp: String,
    old_stop: Number,
    new_stop: Number,
    price_at_trail: Number
  }],

  // News sentiment
  news_sentiment: {
    type: String,
    enum: ['BULLISH', 'NEUTRAL', 'BEARISH', null],
    default: null
  },
  news_adjustment: { type: Number, default: 0 }
}, { _id: true });

const dailyPickBacktestSchema = new mongoose.Schema({
  // When
  trading_date: { type: Date, required: true, index: true },
  scan_date: { type: Date },

  // Market context — from fresh Claude web search for that date
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

  // Global intel fetched via Claude web search for this date
  global_intel: {
    market_mood: String,
    risk_level: String,
    risk_reason: String,
    trading_recommendation: String,
    sgx_nifty: mongoose.Schema.Types.Mixed,
    global_cues: mongoose.Schema.Types.Mixed,
    institutional: mongoose.Schema.Types.Mixed,
    sectors: mongoose.Schema.Types.Mixed,
    major_events: [mongoose.Schema.Types.Mixed],
    stock_specific: mongoose.Schema.Types.Mixed,
    fetched_at: String,
    source: String
  },

  // Selected picks from backtest pipeline (max 3)
  picks: [backtestPickSchema],

  // Scan summary
  summary: {
    total_candidates: { type: Number, default: 0 },
    viable_candidates: { type: Number, default: 0 },
    bullish_count: { type: Number, default: 0 },
    bearish_count: { type: Number, default: 0 },
    selected_count: { type: Number, default: 0 }
  },

  // Simulated end-of-day results
  results: {
    winners: { type: Number, default: 0 },
    losers: { type: Number, default: 0 },
    avg_return_pct: Number,
    total_pnl: Number,
    best_pick: String,
    worst_pick: String
  },

  // Comparison with real system picks from that day
  comparison: {
    real_picks: [{ symbol: String, direction: String, rank_score: Number }],
    backtest_picks: [{ symbol: String, direction: String, rank_score: Number }],
    overlap_symbols: [String],
    real_only_symbols: [String],
    backtest_only_symbols: [String],
    real_pnl: Number,
    backtest_pnl: Number,
    verdict: String
  },

  // Candidate review table — all scored candidates with decisions
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
  }],

  // Backtest metadata
  backtest_config: {
    capital: Number,
    max_picks: Number,
    ran_at: { type: Date, default: Date.now }
  }
}, { timestamps: true });

// Indexes
dailyPickBacktestSchema.index({ trading_date: 1 }, { unique: true });
dailyPickBacktestSchema.index({ 'picks.symbol': 1, trading_date: -1 });

const DailyPickBacktest = mongoose.model('DailyPickBacktest', dailyPickBacktestSchema, 'daily_picks_backtest');

export default DailyPickBacktest;
