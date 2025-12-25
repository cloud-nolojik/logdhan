import mongoose from "mongoose";

/**
 * Trade Journal Model
 *
 * Records every trade with:
 * - Entry/Exit details
 * - P&L calculations
 * - R-multiple tracking
 * - User notes and emotions
 * - Performance metrics
 */

const tradeJournalSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },

  // Link to position (if applicable)
  position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "UserPosition"
  },

  // Stock details
  instrument_key: { type: String, required: true },
  symbol: { type: String, required: true },
  stock_name: { type: String },

  // Trade type
  trade_type: {
    type: String,
    enum: ["SWING", "POSITIONAL", "INTRADAY", "BTST"],
    default: "SWING"
  },

  // Entry details
  entry: {
    date: { type: Date, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    total_value: { type: Number },  // price * quantity

    // Pre-trade planning
    planned_sl: { type: Number },
    planned_target: { type: Number },
    planned_risk_pct: { type: Number },  // % of capital at risk
    planned_rr_ratio: { type: Number },  // Risk:Reward ratio

    // Entry reason
    setup_type: { type: String },  // "Breakout", "Pullback", "Momentum", etc.
    entry_trigger: { type: String },  // What triggered the entry
    setup_score: { type: Number, min: 0, max: 100 },

    // Notes at entry
    notes: { type: String },
    confidence_level: {
      type: String,
      enum: ["HIGH", "MEDIUM", "LOW"],
      default: "MEDIUM"
    }
  },

  // Exit details
  exit: {
    date: { type: Date },
    price: { type: Number },
    quantity: { type: Number },  // Can be partial
    total_value: { type: Number },

    // Exit reason
    exit_type: {
      type: String,
      enum: [
        "STOP_LOSS",      // Hit stop loss
        "TARGET",         // Hit target
        "TRAILING_STOP",  // Trailing stop triggered
        "PARTIAL_PROFIT", // Partial booking
        "MANUAL",         // Manual decision
        "TIME_BASED",     // Time stop (held too long)
        "NEWS_BASED",     // News/event exit
        "TECHNICAL"       // Technical breakdown
      ]
    },
    exit_trigger: { type: String },  // What triggered the exit

    // Notes at exit
    notes: { type: String }
  },

  // Calculated P&L
  pnl: {
    gross_pnl: { type: Number },  // Without charges
    net_pnl: { type: Number },    // After charges
    pnl_pct: { type: Number },    // % return

    // Risk-adjusted metrics
    r_multiple: { type: Number },  // Profit in terms of initial risk
    mae: { type: Number },  // Maximum Adverse Excursion (biggest drawdown)
    mfe: { type: Number },  // Maximum Favorable Excursion (best profit)

    // Holding period
    days_held: { type: Number },

    // Charges
    brokerage: { type: Number, default: 0 },
    taxes: { type: Number, default: 0 },
    other_charges: { type: Number, default: 0 }
  },

  // Trade execution quality
  execution: {
    // Slippage analysis
    planned_entry: { type: Number },
    actual_entry: { type: Number },
    entry_slippage_pct: { type: Number },

    // Was plan followed?
    followed_plan: { type: Boolean },
    plan_deviation_notes: { type: String },

    // Rating (1-5)
    self_rating: {
      type: Number,
      min: 1,
      max: 5
    }
  },

  // Emotional tracking
  emotions: {
    pre_trade: {
      type: String,
      enum: ["CONFIDENT", "NEUTRAL", "ANXIOUS", "FOMO", "GREEDY"]
    },
    during_trade: {
      type: String,
      enum: ["CALM", "ANXIOUS", "HOPEFUL", "FEARFUL", "IMPATIENT"]
    },
    post_trade: {
      type: String,
      enum: ["SATISFIED", "NEUTRAL", "FRUSTRATED", "REGRETFUL", "RELIEVED"]
    },
    lessons_learned: { type: String }
  },

  // Tags for filtering
  tags: [{ type: String }],

  // Screenshots/charts
  charts: [{
    type: { type: String },  // "entry", "exit", "setup"
    url: { type: String },
    caption: { type: String }
  }],

  // Status
  status: {
    type: String,
    enum: ["OPEN", "PARTIAL", "CLOSED"],
    default: "OPEN"
  },

  // Week reference (for weekly review)
  trade_week: { type: String },  // e.g., "2024-W52"

}, { timestamps: true });

// Indexes
tradeJournalSchema.index({ user_id: 1, status: 1 });
tradeJournalSchema.index({ user_id: 1, "entry.date": -1 });
tradeJournalSchema.index({ user_id: 1, instrument_key: 1 });
tradeJournalSchema.index({ user_id: 1, trade_week: 1 });
tradeJournalSchema.index({ user_id: 1, tags: 1 });

/**
 * Calculate trade week string
 */
function getTradeWeek(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const oneJan = new Date(year, 0, 1);
  const weekNum = Math.ceil((((d - oneJan) / 86400000) + oneJan.getDay() + 1) / 7);
  return `${year}-W${weekNum.toString().padStart(2, '0')}`;
}

/**
 * Round to 2 decimal places
 */
function round2(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  return Math.round(x * 100) / 100;
}

// Pre-save: Calculate derived fields
tradeJournalSchema.pre('save', function(next) {
  // Set trade week
  if (this.entry?.date) {
    this.trade_week = getTradeWeek(this.entry.date);
  }

  // Calculate entry total value
  if (this.entry?.price && this.entry?.quantity) {
    this.entry.total_value = round2(this.entry.price * this.entry.quantity);
  }

  // Calculate planned R:R ratio
  if (this.entry?.price && this.entry?.planned_sl && this.entry?.planned_target) {
    const risk = this.entry.price - this.entry.planned_sl;
    const reward = this.entry.planned_target - this.entry.price;
    if (risk > 0) {
      this.entry.planned_rr_ratio = round2(reward / risk);
    }
  }

  // If exited, calculate P&L
  if (this.exit?.price && this.exit?.quantity) {
    this.exit.total_value = round2(this.exit.price * this.exit.quantity);

    // Calculate P&L
    const entryValue = this.entry.price * this.exit.quantity;
    const exitValue = this.exit.price * this.exit.quantity;
    this.pnl.gross_pnl = round2(exitValue - entryValue);

    // Net P&L (subtract charges)
    const totalCharges = (this.pnl.brokerage || 0) + (this.pnl.taxes || 0) + (this.pnl.other_charges || 0);
    this.pnl.net_pnl = round2(this.pnl.gross_pnl - totalCharges);

    // P&L percentage
    this.pnl.pnl_pct = round2((this.pnl.gross_pnl / entryValue) * 100);

    // R-multiple
    if (this.entry.planned_sl && this.entry.price) {
      const riskPerShare = this.entry.price - this.entry.planned_sl;
      if (riskPerShare > 0) {
        const pnlPerShare = this.exit.price - this.entry.price;
        this.pnl.r_multiple = round2(pnlPerShare / riskPerShare);
      }
    }

    // Days held
    if (this.entry.date && this.exit.date) {
      const msPerDay = 24 * 60 * 60 * 1000;
      this.pnl.days_held = Math.ceil((new Date(this.exit.date) - new Date(this.entry.date)) / msPerDay);
    }

    // Entry slippage
    if (this.execution?.planned_entry && this.entry?.price) {
      this.execution.entry_slippage_pct = round2(
        ((this.entry.price - this.execution.planned_entry) / this.execution.planned_entry) * 100
      );
    }

    // Update status based on quantity exited
    if (this.exit.quantity >= this.entry.quantity) {
      this.status = "CLOSED";
    } else {
      this.status = "PARTIAL";
    }
  }

  next();
});

// Static: Create journal entry from position
tradeJournalSchema.statics.createFromPosition = async function(position, exitData = {}) {
  const journalEntry = {
    user_id: position.user_id,
    position_id: position._id,
    instrument_key: position.instrument_key,
    symbol: position.symbol,
    stock_name: position.stock_name,
    trade_type: "SWING",

    entry: {
      date: position.entered_at,
      price: position.actual_entry,
      quantity: position.qty,
      planned_sl: position.original_analysis?.recommended_sl,
      planned_target: position.original_analysis?.recommended_target,
      setup_type: position.original_analysis?.archetype,
      setup_score: position.original_analysis?.confidence
    },

    execution: {
      planned_entry: position.original_analysis?.recommended_entry,
      actual_entry: position.actual_entry
    },

    status: "OPEN"
  };

  // If exit data provided
  if (exitData.price && exitData.quantity) {
    journalEntry.exit = {
      date: exitData.date || new Date(),
      price: exitData.price,
      quantity: exitData.quantity,
      exit_type: exitData.exit_type || "MANUAL",
      exit_trigger: exitData.exit_trigger,
      notes: exitData.notes
    };

    // MAE/MFE from position
    if (position.mae) journalEntry.pnl = { ...journalEntry.pnl, mae: position.mae };
    if (position.mfe) journalEntry.pnl = { ...journalEntry.pnl, mfe: position.mfe };
  }

  return this.create(journalEntry);
};

// Static: Get trades for a week
tradeJournalSchema.statics.getWeeklyTrades = async function(userId, weekString) {
  return this.find({
    user_id: userId,
    trade_week: weekString
  }).sort({ "entry.date": -1 });
};

// Static: Get performance stats
tradeJournalSchema.statics.getPerformanceStats = async function(userId, options = {}) {
  const { fromDate, toDate, tags } = options;

  const query = {
    user_id: userId,
    status: "CLOSED"
  };

  if (fromDate) {
    query["entry.date"] = { $gte: new Date(fromDate) };
  }
  if (toDate) {
    query["entry.date"] = { ...query["entry.date"], $lte: new Date(toDate) };
  }
  if (tags && tags.length > 0) {
    query.tags = { $in: tags };
  }

  const trades = await this.find(query).lean();

  if (trades.length === 0) {
    return {
      total_trades: 0,
      winners: 0,
      losers: 0,
      win_rate: 0,
      total_pnl: 0,
      avg_pnl: 0,
      avg_winner: 0,
      avg_loser: 0,
      profit_factor: 0,
      avg_r_multiple: 0,
      avg_holding_days: 0,
      best_trade: null,
      worst_trade: null
    };
  }

  const winners = trades.filter(t => t.pnl?.net_pnl > 0);
  const losers = trades.filter(t => t.pnl?.net_pnl <= 0);

  const totalGrossProfit = winners.reduce((sum, t) => sum + (t.pnl?.net_pnl || 0), 0);
  const totalGrossLoss = Math.abs(losers.reduce((sum, t) => sum + (t.pnl?.net_pnl || 0), 0));

  const rMultiples = trades.map(t => t.pnl?.r_multiple).filter(r => typeof r === 'number');
  const holdingDays = trades.map(t => t.pnl?.days_held).filter(d => typeof d === 'number');

  // Find best and worst trades
  const sortedByPnl = [...trades].sort((a, b) => (b.pnl?.net_pnl || 0) - (a.pnl?.net_pnl || 0));

  return {
    total_trades: trades.length,
    winners: winners.length,
    losers: losers.length,
    win_rate: round2((winners.length / trades.length) * 100),

    total_pnl: round2(trades.reduce((sum, t) => sum + (t.pnl?.net_pnl || 0), 0)),
    avg_pnl: round2(trades.reduce((sum, t) => sum + (t.pnl?.net_pnl || 0), 0) / trades.length),

    avg_winner: winners.length > 0
      ? round2(totalGrossProfit / winners.length)
      : 0,
    avg_loser: losers.length > 0
      ? round2(totalGrossLoss / losers.length) * -1
      : 0,

    profit_factor: totalGrossLoss > 0
      ? round2(totalGrossProfit / totalGrossLoss)
      : totalGrossProfit > 0 ? Infinity : 0,

    avg_r_multiple: rMultiples.length > 0
      ? round2(rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length)
      : null,

    avg_holding_days: holdingDays.length > 0
      ? round2(holdingDays.reduce((a, b) => a + b, 0) / holdingDays.length)
      : null,

    best_trade: sortedByPnl[0] ? {
      symbol: sortedByPnl[0].symbol,
      pnl: sortedByPnl[0].pnl?.net_pnl,
      r_multiple: sortedByPnl[0].pnl?.r_multiple
    } : null,

    worst_trade: sortedByPnl[sortedByPnl.length - 1] ? {
      symbol: sortedByPnl[sortedByPnl.length - 1].symbol,
      pnl: sortedByPnl[sortedByPnl.length - 1].pnl?.net_pnl,
      r_multiple: sortedByPnl[sortedByPnl.length - 1].pnl?.r_multiple
    } : null,

    by_setup_type: await this.getStatsBySetupType(trades),
    by_exit_type: await this.getStatsByExitType(trades)
  };
};

// Helper: Get stats by setup type
tradeJournalSchema.statics.getStatsBySetupType = async function(trades) {
  const bySetup = {};

  for (const trade of trades) {
    const setup = trade.entry?.setup_type || "Unknown";
    if (!bySetup[setup]) {
      bySetup[setup] = { trades: 0, wins: 0, total_pnl: 0 };
    }
    bySetup[setup].trades++;
    if (trade.pnl?.net_pnl > 0) bySetup[setup].wins++;
    bySetup[setup].total_pnl += trade.pnl?.net_pnl || 0;
  }

  // Calculate win rate for each
  for (const setup of Object.keys(bySetup)) {
    bySetup[setup].win_rate = round2((bySetup[setup].wins / bySetup[setup].trades) * 100);
    bySetup[setup].total_pnl = round2(bySetup[setup].total_pnl);
  }

  return bySetup;
};

// Helper: Get stats by exit type
tradeJournalSchema.statics.getStatsByExitType = async function(trades) {
  const byExit = {};

  for (const trade of trades) {
    const exitType = trade.exit?.exit_type || "Unknown";
    if (!byExit[exitType]) {
      byExit[exitType] = { count: 0, total_pnl: 0 };
    }
    byExit[exitType].count++;
    byExit[exitType].total_pnl += trade.pnl?.net_pnl || 0;
  }

  for (const exit of Object.keys(byExit)) {
    byExit[exit].total_pnl = round2(byExit[exit].total_pnl);
    byExit[exit].avg_pnl = round2(byExit[exit].total_pnl / byExit[exit].count);
  }

  return byExit;
};

// Method: Add exit to journal
tradeJournalSchema.methods.recordExit = async function(exitData) {
  this.exit = {
    date: exitData.date || new Date(),
    price: exitData.price,
    quantity: exitData.quantity || this.entry.quantity,
    exit_type: exitData.exit_type,
    exit_trigger: exitData.exit_trigger,
    notes: exitData.notes
  };

  // MAE/MFE
  if (exitData.mae) this.pnl.mae = exitData.mae;
  if (exitData.mfe) this.pnl.mfe = exitData.mfe;

  // Charges
  if (exitData.brokerage) this.pnl.brokerage = exitData.brokerage;
  if (exitData.taxes) this.pnl.taxes = exitData.taxes;

  // Self rating
  if (exitData.self_rating) this.execution.self_rating = exitData.self_rating;
  if (exitData.followed_plan !== undefined) this.execution.followed_plan = exitData.followed_plan;

  // Emotions
  if (exitData.post_emotion) this.emotions.post_trade = exitData.post_emotion;
  if (exitData.lessons) this.emotions.lessons_learned = exitData.lessons;

  await this.save();
  return this;
};

const TradeJournal = mongoose.model("TradeJournal", tradeJournalSchema);

export default TradeJournal;
