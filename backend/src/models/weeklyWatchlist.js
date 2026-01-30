import mongoose from "mongoose";

const watchlistStockSchema = new mongoose.Schema({
  instrument_key: { type: String, required: true },
  symbol: { type: String, required: true },
  stock_name: { type: String },

  // Why this stock was selected
  selection_reason: { type: String },  // "breakout scan", "pullback scan", etc.
  scan_type: { type: String },  // breakout, pullback, momentum, consolidation_breakout
  setup_score: { type: Number, min: 0, max: 100 },
  grade: { type: String },  // A, B, C, D, F

  // Screening data snapshot
  screening_data: {
    price_at_screening: Number,
    dma20: Number,
    dma50: Number,
    dma200: Number,
    rsi: Number,
    atr: Number,
    atr_pct: Number,
    volume_vs_avg: Number,  // e.g., 1.3 = 30% above average
    distance_from_20dma_pct: Number
  },

  // Suggested entry zone (from screening) - DEPRECATED: Use levels.entryRange instead
  entry_zone: {
    low: Number,
    high: Number
  },

  // Trading levels (from scanLevels - scan-type aware calculations)
  levels: {
    entry: Number,           // Single entry price
    entryRange: [Number],    // [low, high] entry range
    stop: Number,            // Stop loss price
    target: Number,          // Target price
    riskReward: Number,      // Risk:Reward ratio (e.g., 2.0 = 1:2)
    riskPercent: Number,     // Risk as % of entry
    rewardPercent: Number,   // Reward as % of entry
    entryType: String,       // 'buy_above', 'buy_at', 'buy_below'
    mode: String,            // 'BREAKOUT', 'PULLBACK', 'A_PLUS_MOMENTUM', etc.
    reason: String           // Human-readable explanation
  },

  // Status tracking (global status, not per-user)
  status: {
    type: String,
    enum: [
      "WATCHING",      // On radar, waiting for entry
      "APPROACHING",   // Price nearing entry zone
      "TRIGGERED",     // Entry conditions met
      "EXPIRED"        // Week ended
    ],
    default: "WATCHING"
  },

  // AI Analysis reference
  analysis_id: { type: mongoose.Schema.Types.ObjectId, ref: "StockAnalysis" },
  ai_notes: String,

  added_at: { type: Date, default: Date.now }
}, { _id: true });

const weeklyWatchlistSchema = new mongoose.Schema({
  // Week identifier (NO user_id - this is a global watchlist)
  week_start: { type: Date, required: true },  // Monday 00:00 IST
  week_end: { type: Date, required: true },    // Friday 23:59 IST
  week_label: { type: String },  // e.g., "Dec 23-27, 2024"

  // Stocks for this week
  stocks: [watchlistStockSchema],

  // Screening metadata
  screening_run_at: Date,
  screening_completed: { type: Boolean, default: false },  // True when screening ran (even with 0 results)
  scan_types_used: [String],  // ['breakout', 'pullback', 'momentum', 'consolidation_breakout']
  total_screener_results: Number,
  grade_a_count: Number,

  // Week summary (filled at week end)
  week_summary: {
    total_stocks: { type: Number, default: 0 },
    avg_setup_score: Number,
    scan_breakdown: mongoose.Schema.Types.Mixed  // { breakout: 2, pullback: 4 }
  },

  status: {
    type: String,
    enum: ["ACTIVE", "COMPLETED", "ARCHIVED"],
    default: "ACTIVE"
  }

}, { timestamps: true });

// Indexes (no user_id index needed)
weeklyWatchlistSchema.index({ week_start: -1 });
weeklyWatchlistSchema.index({ status: 1 });
weeklyWatchlistSchema.index({ "stocks.instrument_key": 1 });

/**
 * Convert IST time to UTC
 * IST is UTC+5:30, so we subtract 5 hours 30 minutes
 * @param {Date} istDate - Date with IST time set via setHours
 * @returns {Date} - UTC equivalent
 */
function istToUtc(istDate) {
  // IST is UTC+5:30, so subtract 5:30 to get UTC
  return new Date(istDate.getTime() - (5 * 60 + 30) * 60 * 1000);
}

/**
 * Get week boundaries (Monday to Friday IST, stored as UTC)
 * On weekends (Sat/Sun), returns NEXT week's boundaries for screening prep
 * @param {Date} date
 * @param {boolean} forScreening - If true, on weekends returns next week
 * @returns {{ weekStart: Date, weekEnd: Date, weekLabel: string }}
 */
function getWeekBoundaries(date, forScreening = false) {
  const d = new Date(date);
  const dayOfWeek = d.getDay(); // 0 = Sunday, 6 = Saturday

  // On weekends during screening, get NEXT week boundaries
  if (forScreening && (dayOfWeek === 0 || dayOfWeek === 6)) {
    // Calculate days until next Monday
    const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);
    const weekStartIST = new Date(d);
    weekStartIST.setDate(d.getDate() + daysUntilMonday);
    weekStartIST.setUTCHours(0, 0, 0, 0); // Set to midnight UTC first

    // Get Friday of that week
    const weekEndIST = new Date(weekStartIST);
    weekEndIST.setDate(weekStartIST.getDate() + 4);
    weekEndIST.setUTCHours(23, 59, 59, 999); // Set to end of day UTC first

    // Convert IST midnight/end-of-day to UTC
    // Monday 00:00:00 IST = Sunday 18:30:00 UTC (subtract 5:30)
    // Friday 23:59:59 IST = Friday 18:29:59 UTC (subtract 5:30)
    const weekStart = istToUtc(weekStartIST);
    const weekEnd = istToUtc(weekEndIST);

    // Week label (display in IST)
    const options = { month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' };
    const startStr = weekStartIST.toLocaleDateString('en-IN', options);
    const endStr = weekEndIST.toLocaleDateString('en-IN', { ...options, year: 'numeric' });
    const weekLabel = `${startStr} - ${endStr}`;

    return { weekStart, weekEnd, weekLabel };
  }

  // Get Monday of current week
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const weekStartIST = new Date(d.setDate(diff));
  weekStartIST.setUTCHours(0, 0, 0, 0); // Set to midnight UTC first

  // Get Friday
  const weekEndIST = new Date(weekStartIST);
  weekEndIST.setDate(weekStartIST.getDate() + 4);
  weekEndIST.setUTCHours(23, 59, 59, 999); // Set to end of day UTC first

  // Convert IST midnight/end-of-day to UTC
  const weekStart = istToUtc(weekStartIST);
  const weekEnd = istToUtc(weekEndIST);

  // Week label (display in IST)
  const options = { month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' };
  const startStr = weekStartIST.toLocaleDateString('en-IN', options);
  const endStr = weekEndIST.toLocaleDateString('en-IN', { ...options, year: 'numeric' });
  const weekLabel = `${startStr} - ${endStr}`;

  return { weekStart, weekEnd, weekLabel };
}

// Static: Get current week's watchlist (global - no user_id)
// On weekdays: returns the current week
// On weekends: returns the most recently completed week (so users can still see stocks)
//              OR returns next week if it has stocks (after weekend screening runs)
weeklyWatchlistSchema.statics.getCurrentWeek = async function() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday

  // On weekdays (Mon-Fri), use strict week boundaries
  if (dayOfWeek >= 1 && dayOfWeek <= 5) {
    return this.findOne({
      week_start: { $lte: now },
      week_end: { $gte: now },
      status: "ACTIVE"
    });
  }

  // On weekends (Sat/Sun):
  // 1. First check if next week's watchlist exists and screening has completed
  const { weekStart: nextWeekStart } = getWeekBoundaries(now, true);
  const nextWeekWatchlist = await this.findOne({
    week_start: nextWeekStart,
    status: "ACTIVE"
  });

  // If screening completed (even with 0 stocks), show next week's watchlist
  if (nextWeekWatchlist && nextWeekWatchlist.screening_completed) {
    return nextWeekWatchlist;
  }

  // 2. Otherwise (screening hasn't run yet), show the most recent watchlist
  //    This allows users to still see Friday's stocks on Saturday before screening runs
  return this.findOne({
    status: "ACTIVE"
  }).sort({ week_start: -1 });
};

// Static: Get or create current week (global)
// On weekends, creates NEXT week's watchlist for screening prep
weeklyWatchlistSchema.statics.getOrCreateCurrentWeek = async function() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  // On weekends, always check/create next week's watchlist
  if (isWeekend) {
    const { weekStart, weekEnd, weekLabel } = getWeekBoundaries(now, true);

    // Check if next week's watchlist already exists
    let nextWeekWatchlist = await this.findOne({ week_start: weekStart });

    if (!nextWeekWatchlist) {
      // Create next week's watchlist
      nextWeekWatchlist = await this.create({
        week_start: weekStart,
        week_end: weekEnd,
        week_label: weekLabel,
        stocks: [],
        status: "ACTIVE"
      });
      console.log(`[WeeklyWatchlist] Created new watchlist for next week: ${weekLabel}`);
    }

    return nextWeekWatchlist;
  }

  // On weekdays, use getCurrentWeek or create current week
  let watchlist = await this.getCurrentWeek();

  if (!watchlist) {
    const { weekStart, weekEnd, weekLabel } = getWeekBoundaries(now, false);

    watchlist = await this.create({
      week_start: weekStart,
      week_end: weekEnd,
      week_label: weekLabel,
      stocks: [],
      status: "ACTIVE"
    });

    console.log(`[WeeklyWatchlist] Created new watchlist: ${weekLabel}`);
  }

  return watchlist;
};

// Static: Add stock to current week
weeklyWatchlistSchema.statics.addStock = async function(stockData) {
  const watchlist = await this.getOrCreateCurrentWeek();

  // Check if already exists
  const exists = watchlist.stocks.find(s => s.instrument_key === stockData.instrument_key);
  if (exists) {
    return { added: false, reason: "Stock already in watchlist", watchlist };
  }

  watchlist.stocks.push(stockData);
  await watchlist.save();

  return { added: true, watchlist };
};

// Static: Add multiple stocks at once (upsert - update existing or insert new)
weeklyWatchlistSchema.statics.addStocks = async function(stocksData) {
  const watchlist = await this.getOrCreateCurrentWeek();

  const existingMap = new Map(watchlist.stocks.map(s => [s.instrument_key, s]));
  let added = 0;
  let updated = 0;

  for (const stockData of stocksData) {
    const existing = existingMap.get(stockData.instrument_key);

    if (existing) {
      // Update existing stock with fresh screening data
      existing.symbol = stockData.symbol;
      existing.stock_name = stockData.stock_name;
      existing.setup_score = stockData.setup_score;
      existing.grade = stockData.grade;
      existing.screening_data = stockData.screening_data;
      existing.scan_type = stockData.scan_type;
      existing.selection_reason = stockData.selection_reason;
      existing.entry_zone = stockData.entry_zone;
      existing.levels = stockData.levels;  // Update trading levels
      // Clear old analysis link - new analysis will be triggered
      existing.analysis_id = null;
      existing.ai_notes = null;
      // Keep the original added_at and status (user tracking state)
      updated++;
    } else {
      // Add new stock
      watchlist.stocks.push(stockData);
      added++;
    }
  }

  await watchlist.save();

  return {
    added,
    updated,
    skipped: 0,
    watchlist
  };
};

// Static: Update stock status
weeklyWatchlistSchema.statics.updateStockStatus = async function(instrument_key, newStatus) {
  return this.findOneAndUpdate(
    {
      status: "ACTIVE",
      "stocks.instrument_key": instrument_key
    },
    {
      $set: { "stocks.$.status": newStatus }
    },
    { new: true }
  );
};

// Static: Link analysis to stock
weeklyWatchlistSchema.statics.linkAnalysis = async function(instrument_key, analysis_id, ai_notes) {
  return this.findOneAndUpdate(
    {
      status: "ACTIVE",
      "stocks.instrument_key": instrument_key
    },
    {
      $set: {
        "stocks.$.analysis_id": analysis_id,
        "stocks.$.ai_notes": ai_notes
      }
    },
    { new: true }
  );
};

// Method: Complete week and calculate summary
weeklyWatchlistSchema.methods.completeWeek = async function() {
  this.status = "COMPLETED";

  // Calculate summary
  const stocks = this.stocks;

  // Scan breakdown
  const scanBreakdown = {};
  stocks.forEach(s => {
    const type = s.scan_type || 'unknown';
    scanBreakdown[type] = (scanBreakdown[type] || 0) + 1;
  });

  const scores = stocks.map(s => s.setup_score).filter(s => typeof s === "number");

  this.week_summary = {
    total_stocks: stocks.length,
    avg_setup_score: scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : null,
    scan_breakdown: scanBreakdown
  };

  // Mark remaining WATCHING stocks as EXPIRED
  stocks.forEach(s => {
    if (s.status === "WATCHING" || s.status === "APPROACHING") {
      s.status = "EXPIRED";
    }
  });

  await this.save();
  return this;
};

const WeeklyWatchlist = mongoose.model("WeeklyWatchlist", weeklyWatchlistSchema);

export default WeeklyWatchlist;
export { getWeekBoundaries };
