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
    ema20: Number,                  // Entry/stop anchor
    ema50: Number,                  // Trend confirmation
    rsi: Number,
    weekly_rsi: Number,             // For dual-timeframe RSI gate (both daily + weekly < 72)
    atr: Number,
    atr_pct: Number,
    volume_vs_avg: Number,          // e.g., 1.3 = 30% above average
    distance_from_20dma_pct: Number,
    weekly_change_pct: Number,      // Scoring factor for A+ momentum
    high_52w: Number,               // 52-week high (for breakout context)
    ema_stack_bullish: Boolean,     // EMA20 > EMA50 > SMA200
    weekly_pivot: Number,           // Weekly pivot level
    weekly_r1: Number,              // Weekly R1 resistance
    weekly_r2: Number,              // Weekly R2 resistance
    weekly_s1: Number               // Weekly S1 support
  },

  // Suggested entry zone (from screening) - DEPRECATED: Use levels.entryRange instead
  entry_zone: {
    low: Number,
    high: Number
  },

  // Trading levels (from scanLevels - scan-type aware calculations)
  // STRUCTURAL LADDER: Weekly R1 → R2 → 52W High → REJECT
  levels: {
    entry: Number,           // Single entry price
    entryRange: [Number],    // [low, high] entry range
    stop: Number,            // Stop loss price
    target: Number,          // T1 (primary target from structural ladder)
    target2: Number,         // T2 extension target (trail only, null if not applicable)
    targetBasis: String,     // 'weekly_r1', 'weekly_r2', 'atr_extension_52w_breakout', etc.
    dailyR1Check: Number,    // Momentum confirmation checkpoint (not a target)
    riskReward: Number,      // Risk:Reward ratio (e.g., 2.0 = 1:2)
    riskPercent: Number,     // Risk as % of entry
    rewardPercent: Number,   // Reward as % of entry
    entryType: String,       // 'buy_above', 'buy_at', 'buy_below'
    mode: String,            // 'BREAKOUT', 'PULLBACK', 'A_PLUS_MOMENTUM', etc.
    archetype: String,       // '52w_breakout', 'pullback', 'trend-follow', 'breakout', etc.
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
  has_ai_analysis: { type: Boolean, default: false },  // True when Claude analysis generated
  ai_notes: String,

  // ═══════════════════════════════════════════════════════════════════════════
  // DAILY TRACKING (updated by 4 PM daily job)
  // ═══════════════════════════════════════════════════════════════════════════

  // Granular tracking status (more detailed than 'status' field)
  tracking_status: {
    type: String,
    enum: [
      'WATCHING',       // Default — waiting for entry
      'APPROACHING',    // Within 2% above entry
      'ENTRY_ZONE',     // Price in entry range
      'ABOVE_ENTRY',    // Triggered and running (above entry, below target)
      'RETEST_ZONE',    // 52W breakout retesting old high (between stop+2% and entry)
      'TARGET1_HIT',    // T1 reached
      'TARGET2_HIT',    // T2 reached
      'STOPPED_OUT'     // Stop loss hit
    ],
    default: 'WATCHING'
  },

  // Additive flags (can have multiple)
  tracking_flags: {
    type: [String],  // ['RSI_DANGER', 'RSI_EXIT', 'VOLUME_SPIKE', 'GAP_DOWN', 'APPROACHING_ENTRY']
    default: []
  },

  // Status change tracking
  status_changed_at: Date,
  previous_status: String,

  // Daily snapshots (one per trading day, up to 5 per week)
  daily_snapshots: [{
    date: { type: Date, required: true },
    open: Number,
    high: Number,
    low: Number,
    close: Number,
    volume: Number,
    volume_vs_avg: Number,          // 1.5 = 50% above 50-day average
    rsi: Number,                    // Daily RSI-14
    distance_from_entry_pct: Number,  // +2.3% = 2.3% above entry
    distance_from_stop_pct: Number,   // +8.1% = 8.1% above stop (positive = safe)
    distance_from_target_pct: Number, // -5.2% = 5.2% below target
    tracking_status: String,
    tracking_flags: [String],
    nifty_change_pct: Number,
    phase2_triggered: { type: Boolean, default: false },
    phase2_analysis_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StockAnalysis' }
  }],

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
  total_eliminated: Number,      // Stocks eliminated by RSI gate or structural ladder rejection
  grade_a_count: Number,
  grade_a_plus_count: Number,    // A+ grade count

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

  // Convert to IST to determine day of week (IST = UTC + 5:30)
  const istOffset = 5.5 * 60 * 60 * 1000; // 5 hours 30 minutes in ms
  const nowIST = new Date(now.getTime() + istOffset);
  const dayOfWeekIST = nowIST.getUTCDay(); // Use getUTCDay since we manually added IST offset

  console.log(`[getCurrentWeek] Called at UTC: ${now.toISOString()}`);
  console.log(`[getCurrentWeek] IST time: ${nowIST.toISOString().replace('Z', ' IST')}`);
  console.log(`[getCurrentWeek] Day of week (IST): ${dayOfWeekIST} (0=Sun, 1=Mon, 5=Fri, 6=Sat)`);

  // On weekdays (Mon-Fri) in IST, use strict week boundaries
  if (dayOfWeekIST >= 1 && dayOfWeekIST <= 5) {
    console.log(`[getCurrentWeek] Weekday (IST) - querying for week containing now`);
    const result = await this.findOne({
      week_start: { $lte: now },
      week_end: { $gte: now },
      status: "ACTIVE"
    });
    console.log(`[getCurrentWeek] Query result: ${result ? result.week_label : 'null'}`);
    if (result) {
      console.log(`[getCurrentWeek] Found: week_start=${result.week_start?.toISOString()}, week_end=${result.week_end?.toISOString()}`);
    }
    return result;
  }

  // On weekends (Sat/Sun) in IST:
  console.log(`[getCurrentWeek] Weekend (IST) - checking for next week's watchlist`);

  // Calculate next Monday in IST
  // If Saturday (6), next Monday is +2 days; if Sunday (0), next Monday is +1 day
  const daysUntilMonday = dayOfWeekIST === 0 ? 1 : (8 - dayOfWeekIST);

  // Create IST date for next Monday midnight
  const nextMondayIST = new Date(nowIST);
  nextMondayIST.setUTCDate(nowIST.getUTCDate() + daysUntilMonday);
  nextMondayIST.setUTCHours(0, 0, 0, 0);

  // Convert IST midnight to UTC (subtract 5:30)
  const nextWeekStart = new Date(nextMondayIST.getTime() - istOffset);

  console.log(`[getCurrentWeek] Days until Monday: ${daysUntilMonday}`);
  console.log(`[getCurrentWeek] Next Monday IST: ${nextMondayIST.toISOString()}`);
  console.log(`[getCurrentWeek] Next week start (UTC): ${nextWeekStart.toISOString()}`);

  const nextWeekWatchlist = await this.findOne({
    week_start: nextWeekStart,
    status: "ACTIVE"
  });

  // If screening completed (even with 0 stocks), show next week's watchlist
  if (nextWeekWatchlist && nextWeekWatchlist.screening_completed) {
    console.log(`[getCurrentWeek] Returning next week's watchlist: ${nextWeekWatchlist.week_label}`);
    return nextWeekWatchlist;
  }

  // 2. Otherwise (screening hasn't run yet for next week)
  //    Don't show expired watchlist - return null until new screening runs
  console.log(`[getCurrentWeek] No next week watchlist yet - returning null (week ended)`);
  return null;
};

// Static: Get or create current week (global)
// On weekends, creates NEXT week's watchlist for screening prep
weeklyWatchlistSchema.statics.getOrCreateCurrentWeek = async function() {
  const now = new Date();

  // Convert to IST to determine day of week (IST = UTC + 5:30)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(now.getTime() + istOffset);
  const dayOfWeekIST = nowIST.getUTCDay();
  const isWeekend = dayOfWeekIST === 0 || dayOfWeekIST === 6;

  console.log(`[getOrCreateCurrentWeek] Day of week (IST): ${dayOfWeekIST}, isWeekend: ${isWeekend}`);

  // On weekends, always check/create next week's watchlist
  if (isWeekend) {
    // Calculate next Monday in IST (same logic as getCurrentWeek)
    const daysUntilMonday = dayOfWeekIST === 0 ? 1 : (8 - dayOfWeekIST);
    const nextMondayIST = new Date(nowIST);
    nextMondayIST.setUTCDate(nowIST.getUTCDate() + daysUntilMonday);
    nextMondayIST.setUTCHours(0, 0, 0, 0);

    // Friday of next week (Monday + 4 days)
    const nextFridayIST = new Date(nextMondayIST);
    nextFridayIST.setUTCDate(nextMondayIST.getUTCDate() + 4);
    nextFridayIST.setUTCHours(23, 59, 59, 999);

    // Convert IST to UTC
    const weekStart = new Date(nextMondayIST.getTime() - istOffset);
    const weekEnd = new Date(nextFridayIST.getTime() - istOffset);

    // Week label
    const options = { month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' };
    const startStr = nextMondayIST.toLocaleDateString('en-IN', options);
    const endStr = nextFridayIST.toLocaleDateString('en-IN', { ...options, year: 'numeric' });
    const weekLabel = `${startStr} - ${endStr}`;

    console.log(`[getOrCreateCurrentWeek] Next week: ${weekLabel}, start: ${weekStart.toISOString()}`);

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

  // On weekdays (IST), use getCurrentWeek or create current week
  let watchlist = await this.getCurrentWeek();

  if (!watchlist) {
    // Calculate current week boundaries in IST
    // Get Monday of current week
    const daysFromMonday = dayOfWeekIST === 0 ? 6 : dayOfWeekIST - 1;
    const mondayIST = new Date(nowIST);
    mondayIST.setUTCDate(nowIST.getUTCDate() - daysFromMonday);
    mondayIST.setUTCHours(0, 0, 0, 0);

    const fridayIST = new Date(mondayIST);
    fridayIST.setUTCDate(mondayIST.getUTCDate() + 4);
    fridayIST.setUTCHours(23, 59, 59, 999);

    const weekStart = new Date(mondayIST.getTime() - istOffset);
    const weekEnd = new Date(fridayIST.getTime() - istOffset);

    const options = { month: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' };
    const startStr = mondayIST.toLocaleDateString('en-IN', options);
    const endStr = fridayIST.toLocaleDateString('en-IN', { ...options, year: 'numeric' });
    const weekLabel = `${startStr} - ${endStr}`;

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
