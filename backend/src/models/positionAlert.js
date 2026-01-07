import mongoose from "mongoose";

/**
 * Position Alert Model
 *
 * Stores rule-based scan results from the 4 PM scheduled job.
 * Zero AI cost - uses engine functions (calculateTrailingStop, checkExitConditions).
 * On-demand AI coaching happens when user clicks (exit-coach endpoint).
 */

const trailRecommendationSchema = new mongoose.Schema({
  should_trail: { type: Boolean, default: false },
  new_sl: Number,
  method: {
    type: String,
    enum: ["ATR_TRAIL", "SWING_LOW", "EMA_TRAIL", "BREAKEVEN", "PROFIT_LOCK", null]
  },
  reason: String
}, { _id: false });

const exitAlertSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["SL_BREACH", "TARGET_HIT", "NEAR_TARGET", "NEAR_SL", "TIME_DECAY"]
  },
  details: String
}, { _id: false });

const positionAlertSchema = new mongoose.Schema({
  position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "UserPosition",
    required: true
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  instrument_key: { type: String, required: true },
  symbol: { type: String, required: true },

  // Alert status
  alert_status: {
    type: String,
    enum: ["GOOD", "WATCH", "ACTION_NEEDED"],
    default: "GOOD"
  },
  alert_reason: { type: String, default: "Position on track" },

  // Snapshot at scan time
  price_at_scan: { type: Number, required: true },
  sl_at_scan: { type: Number, required: true },
  target_at_scan: { type: Number, required: true },
  pnl_pct_at_scan: Number,
  days_in_trade: Number,

  // Rule-based recommendations (no AI)
  trail_recommendation: trailRecommendationSchema,

  // Exit condition flags
  exit_alerts: [exitAlertSchema],

  // Technical indicators at scan time (for reference)
  indicators_at_scan: {
    atr: Number,
    ema20: Number,
    rsi: Number
  },

  // Scan metadata
  scanned_at: { type: Date, default: Date.now },
  scan_job_id: String,

  // User interaction
  user_viewed: { type: Boolean, default: false },
  user_viewed_at: Date,

  // Override flag (e.g., overnight gap detection on app open)
  was_overridden: { type: Boolean, default: false },
  override_reason: String

}, { timestamps: true });

// Indexes for quick lookup
positionAlertSchema.index({ user_id: 1, scanned_at: -1 });
positionAlertSchema.index({ position_id: 1, scanned_at: -1 });
positionAlertSchema.index({ alert_status: 1, scanned_at: -1 });

/**
 * Static: Get latest alert for a position
 */
positionAlertSchema.statics.getLatestForPosition = function(position_id) {
  return this.findOne({ position_id })
    .sort({ scanned_at: -1 })
    .lean();
};

/**
 * Static: Get all alerts for user from last 24 hours
 */
positionAlertSchema.statics.getRecentForUser = function(user_id, hoursAgo = 24) {
  const since = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  return this.find({
    user_id,
    scanned_at: { $gte: since }
  })
    .sort({ scanned_at: -1 })
    .lean();
};

/**
 * Static: Get summary counts for user
 */
positionAlertSchema.statics.getSummaryForUser = async function(user_id, hoursAgo = 24) {
  const since = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

  const alerts = await this.find({
    user_id,
    scanned_at: { $gte: since }
  }).lean();

  // Get unique positions (latest alert per position)
  const latestByPosition = new Map();
  for (const alert of alerts) {
    const posId = alert.position_id.toString();
    if (!latestByPosition.has(posId) ||
        alert.scanned_at > latestByPosition.get(posId).scanned_at) {
      latestByPosition.set(posId, alert);
    }
  }

  const uniqueAlerts = Array.from(latestByPosition.values());

  return {
    total: uniqueAlerts.length,
    action_needed: uniqueAlerts.filter(a => a.alert_status === "ACTION_NEEDED").length,
    watching: uniqueAlerts.filter(a => a.alert_status === "WATCH").length,
    on_track: uniqueAlerts.filter(a => a.alert_status === "GOOD").length
  };
};

/**
 * Static: Mark alert as viewed
 */
positionAlertSchema.statics.markViewed = async function(alert_id, user_id) {
  return this.findOneAndUpdate(
    { _id: alert_id, user_id },
    {
      user_viewed: true,
      user_viewed_at: new Date()
    },
    { new: true }
  );
};

/**
 * Static: Create or update alert for a position (upsert by position + scan date)
 */
positionAlertSchema.statics.upsertAlert = async function(alertData) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return this.findOneAndUpdate(
    {
      position_id: alertData.position_id,
      scanned_at: { $gte: today }
    },
    { $set: alertData },
    { upsert: true, new: true }
  );
};

const PositionAlert = mongoose.model("PositionAlert", positionAlertSchema);

export default PositionAlert;
