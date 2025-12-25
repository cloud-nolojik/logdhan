import mongoose from "mongoose";

const slTrailHistorySchema = new mongoose.Schema({
  old_sl: { type: Number, required: true },
  new_sl: { type: Number, required: true },
  reason: { type: String, required: true },
  method: {
    type: String,
    enum: ["ATR_TRAIL", "SWING_LOW", "EMA_TRAIL", "BREAKEVEN", "MANUAL", "LOCK_PROFIT"],
    required: true
  },
  changed_at: { type: Date, default: Date.now }
}, { _id: false });

const originalAnalysisSchema = new mongoose.Schema({
  analysis_id: { type: mongoose.Schema.Types.ObjectId, ref: "StockAnalysis" },
  recommended_entry: { type: Number, required: true },
  recommended_target: { type: Number, required: true },
  recommended_sl: { type: Number, required: true },
  archetype: { type: String },  // "breakout", "pullback", etc.
  confidence: { type: Number },
  riskReward: { type: Number },
  generated_at: { type: Date }
}, { _id: false });

const userPositionSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  instrument_key: { type: String, required: true },
  symbol: { type: String, required: true },
  stock_name: { type: String },  // Human-readable name e.g. "Tata Motors Ltd"

  // Original recommendation (FROZEN at entry, never modified)
  original_analysis: { type: originalAnalysisSchema, required: true },

  // Actual trade details
  actual_entry: { type: Number, required: true },
  qty: { type: Number, required: true },
  entered_at: { type: Date, default: Date.now },

  // Current management state (CAN be updated)
  current_sl: { type: Number, required: true },
  current_target: { type: Number, required: true },

  // Audit trail for stop loss changes
  sl_trail_history: [slTrailHistorySchema],

  // Linked orders from Upstox
  linked_orders: {
    main_order_id: String,
    sl_order_id: String,
    target_order_id: String
  },

  // Position status
  status: {
    type: String,
    enum: ["OPEN", "PARTIAL", "CLOSED"],
    default: "OPEN"
  },

  // Closure details (filled when closed)
  closed_at: Date,
  close_reason: {
    type: String,
    enum: ["TARGET_HIT", "SL_HIT", "MANUAL", "TRAILED_OUT", "EXPIRED", null],
    default: null
  },
  exit_price: Number,
  realized_pnl: Number,
  realized_pnl_pct: Number

}, { timestamps: true });

// Indexes
userPositionSchema.index({ user_id: 1, instrument_key: 1, status: 1 });
userPositionSchema.index({ user_id: 1, status: 1 });
userPositionSchema.index({ status: 1, entered_at: -1 });

// Static: Find open position for a stock
userPositionSchema.statics.findOpenPosition = function(user_id, instrument_key) {
  return this.findOne({
    user_id,
    instrument_key,
    status: "OPEN"
  });
};

// Static: Find all open positions for user
userPositionSchema.statics.findAllOpenPositions = function(user_id) {
  return this.find({
    user_id,
    status: "OPEN"
  }).sort({ entered_at: -1 });
};

// Static: Create position from analysis
userPositionSchema.statics.createFromAnalysis = async function(
  user_id,
  stockAnalysis,
  actual_entry,
  qty,
  linked_orders = {},
  options = {}
) {
  const strategy = stockAnalysis.analysis_data?.strategies?.[0];
  if (!strategy) throw new Error("No strategy found in analysis");

  // Check if position already exists
  const existingPosition = await this.findOpenPosition(user_id, stockAnalysis.instrument_key);
  if (existingPosition) {
    throw new Error(`Open position already exists for ${stockAnalysis.stock_symbol}`);
  }

  const position = await this.create({
    user_id,
    instrument_key: stockAnalysis.instrument_key,
    symbol: stockAnalysis.stock_symbol,
    stock_name: stockAnalysis.stock_name || options.stock_name || stockAnalysis.stock_symbol,
    original_analysis: {
      analysis_id: stockAnalysis._id,
      recommended_entry: strategy.entry,
      recommended_target: strategy.target,
      recommended_sl: strategy.stopLoss,
      archetype: strategy.archetype,
      confidence: strategy.confidence,
      riskReward: strategy.riskReward,
      generated_at: stockAnalysis.analysis_data?.generated_at_ist
    },
    actual_entry,
    qty,
    current_sl: strategy.stopLoss,
    current_target: strategy.target,
    linked_orders,
    status: "OPEN"
  });

  // Create journal entry for the new position
  if (options.createJournal !== false) {
    try {
      const TradeJournal = mongoose.model("TradeJournal");
      await TradeJournal.createFromPosition(position);
      console.log(`[POSITION] Created journal entry for ${position.symbol}`);
    } catch (journalError) {
      console.error("Failed to create trade journal:", journalError.message);
      // Don't throw - position is created successfully even if journal fails
    }
  }

  return position;
};

// Method: Trail stop loss (validates SL only moves UP)
userPositionSchema.methods.trailStopLoss = async function(new_sl, reason, method = "MANUAL") {
  if (new_sl <= this.current_sl) {
    throw new Error(`Cannot trail stop loss DOWN. Current: ₹${this.current_sl}, Attempted: ₹${new_sl}`);
  }

  if (new_sl >= this.current_target) {
    throw new Error(`Stop loss cannot be at or above target. Target: ₹${this.current_target}, Attempted: ₹${new_sl}`);
  }

  this.sl_trail_history.push({
    old_sl: this.current_sl,
    new_sl,
    reason,
    method,
    changed_at: new Date()
  });

  this.current_sl = new_sl;
  return this.save();
};

// Method: Close position
userPositionSchema.methods.closePosition = async function(reason, exit_price, options = {}) {
  if (this.status === "CLOSED") {
    throw new Error("Position is already closed");
  }

  this.status = "CLOSED";
  this.closed_at = new Date();
  this.close_reason = reason;
  this.exit_price = exit_price;

  // Calculate P&L
  this.realized_pnl = Math.round((exit_price - this.actual_entry) * this.qty * 100) / 100;
  this.realized_pnl_pct = Math.round(((exit_price - this.actual_entry) / this.actual_entry) * 100 * 100) / 100;

  await this.save();

  // Create or update journal entry
  if (options.updateJournal !== false) {
    try {
      const TradeJournal = mongoose.model("TradeJournal");

      // Map close reason to exit type
      const exitTypeMap = {
        "TARGET_HIT": "TARGET",
        "SL_HIT": "STOP_LOSS",
        "MANUAL": "MANUAL",
        "TRAILED_OUT": "TRAILING_STOP",
        "EXPIRED": "TIME_BASED"
      };

      // Find existing journal entry or create new
      let journal = await TradeJournal.findOne({
        position_id: this._id,
        user_id: this.user_id
      });

      if (journal) {
        // Update existing journal with exit
        await journal.recordExit({
          date: this.closed_at,
          price: exit_price,
          quantity: this.qty,
          exit_type: exitTypeMap[reason] || "MANUAL",
          exit_trigger: options.exit_trigger || reason,
          notes: options.notes
        });
      } else {
        // Create new journal entry with exit
        await TradeJournal.createFromPosition(this, {
          date: this.closed_at,
          price: exit_price,
          quantity: this.qty,
          exit_type: exitTypeMap[reason] || "MANUAL",
          exit_trigger: options.exit_trigger || reason,
          notes: options.notes
        });
      }
    } catch (journalError) {
      console.error("Failed to update trade journal:", journalError.message);
      // Don't throw - position is closed successfully even if journal fails
    }
  }

  return this;
};

// Method: Calculate unrealized P&L (needs current price passed in)
userPositionSchema.methods.calculateUnrealizedPnl = function(current_price) {
  const pnl = (current_price - this.actual_entry) * this.qty;
  const pnl_pct = ((current_price - this.actual_entry) / this.actual_entry) * 100;
  return {
    unrealized_pnl: Math.round(pnl * 100) / 100,
    unrealized_pnl_pct: Math.round(pnl_pct * 100) / 100
  };
};

// Method: Calculate risk metrics
userPositionSchema.methods.calculateRiskMetrics = function(current_price) {
  const distance_to_sl = current_price - this.current_sl;
  const distance_to_target = this.current_target - current_price;

  return {
    distance_to_sl: Math.round(distance_to_sl * 100) / 100,
    distance_to_sl_pct: Math.round((distance_to_sl / current_price) * 100 * 100) / 100,
    distance_to_target: Math.round(distance_to_target * 100) / 100,
    distance_to_target_pct: Math.round((distance_to_target / current_price) * 100 * 100) / 100,
    current_rr: distance_to_sl > 0 ? Math.round((distance_to_target / distance_to_sl) * 100) / 100 : 0
  };
};

// Virtual: Days in trade
userPositionSchema.virtual("days_in_trade").get(function() {
  const now = this.closed_at || new Date();
  const diffMs = now - this.entered_at;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
});

// Ensure virtuals are included in JSON
userPositionSchema.set('toJSON', { virtuals: true });
userPositionSchema.set('toObject', { virtuals: true });

const UserPosition = mongoose.model("UserPosition", userPositionSchema);

export default UserPosition;
