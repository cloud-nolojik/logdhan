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

  // Suggested entry zone (from screening)
  entry_zone: {
    low: Number,
    high: Number
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
 * Get week boundaries (Monday to Friday IST)
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
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() + daysUntilMonday);
    weekStart.setHours(0, 0, 0, 0);

    // Get Friday of that week
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 4);
    weekEnd.setHours(23, 59, 59, 999);

    // Week label
    const options = { month: 'short', day: 'numeric' };
    const startStr = weekStart.toLocaleDateString('en-IN', options);
    const endStr = weekEnd.toLocaleDateString('en-IN', { ...options, year: 'numeric' });
    const weekLabel = `${startStr} - ${endStr}`;

    return { weekStart, weekEnd, weekLabel };
  }

  // Get Monday of current week
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const weekStart = new Date(d.setDate(diff));
  weekStart.setHours(0, 0, 0, 0);

  // Get Friday
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 4);
  weekEnd.setHours(23, 59, 59, 999);

  // Week label
  const options = { month: 'short', day: 'numeric' };
  const startStr = weekStart.toLocaleDateString('en-IN', options);
  const endStr = weekEnd.toLocaleDateString('en-IN', { ...options, year: 'numeric' });
  const weekLabel = `${startStr} - ${endStr}`;

  return { weekStart, weekEnd, weekLabel };
}

// Static: Get current week's watchlist (global - no user_id)
// On weekdays: returns the current week
// On weekends: returns NEXT week's watchlist (for screening prep)
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

  // On weekends (Sat/Sun), get NEXT week's watchlist for screening prep
  const { weekStart, weekEnd } = getWeekBoundaries(now, true);
  return this.findOne({
    week_start: weekStart,
    status: "ACTIVE"
  });
};

// Static: Get or create current week (global)
// On weekends, creates NEXT week's watchlist for screening prep
weeklyWatchlistSchema.statics.getOrCreateCurrentWeek = async function() {
  let watchlist = await this.getCurrentWeek();

  if (!watchlist) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    // On weekends, create next week's watchlist
    const { weekStart, weekEnd, weekLabel } = getWeekBoundaries(now, isWeekend);

    watchlist = await this.create({
      week_start: weekStart,
      week_end: weekEnd,
      week_label: weekLabel,
      stocks: [],
      status: "ACTIVE"
    });

    console.log(`[WeeklyWatchlist] Created new watchlist: ${weekLabel} (isWeekend: ${isWeekend})`);
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

// Static: Add multiple stocks at once
weeklyWatchlistSchema.statics.addStocks = async function(stocksData) {
  const watchlist = await this.getOrCreateCurrentWeek();

  const existingKeys = new Set(watchlist.stocks.map(s => s.instrument_key));
  const newStocks = stocksData.filter(s => !existingKeys.has(s.instrument_key));

  if (newStocks.length > 0) {
    watchlist.stocks.push(...newStocks);
    await watchlist.save();
  }

  return {
    added: newStocks.length,
    skipped: stocksData.length - newStocks.length,
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
