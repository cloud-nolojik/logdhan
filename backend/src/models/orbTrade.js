/**
 * OrbTrade — MongoDB model for Opening Range Breakout (ORB) intraday trades.
 *
 * One document per trading day.
 * Candidates flow through states:
 *   WATCHING → RANGE_SET → ENTERED → STOPPED_OUT | TARGET_HIT | TIME_EXIT
 *   WATCHING → RANGE_SET → SKIPPED  (breakout window closed, no entry)
 *   WATCHING → SKIPPED              (no OR candle data)
 */

import mongoose from 'mongoose';

const orbCandidateSchema = new mongoose.Schema({
  // Identity
  symbol:       { type: String, required: true },

  // Pre-open phase (9:08 AM)
  preOpenPct:   Number,   // IEP % change from prev close
  iep:          Number,   // Indicative Equilibrium Price
  prevClose:    Number,

  // Opening Range (set at 9:30 AM from first 15-min candle)
  orHigh:  Number,
  orLow:   Number,
  orRange: Number,        // orHigh - orLow

  // Status
  status: {
    type: String,
    enum: ['WATCHING', 'RANGE_SET', 'ENTERED', 'STOPPED_OUT', 'TARGET_HIT', 'TIME_EXIT', 'SKIPPED'],
    default: 'WATCHING',
  },

  // Trade execution
  direction:   { type: String, default: 'LONG' },
  qty:         Number,
  entryPrice:  Number,
  entryTime:   Date,
  stopPrice:   Number,
  targetPrice: Number,

  // Kite order IDs
  entryOrderId:  String,
  stopOrderId:   String,
  targetOrderId: String,

  // Exit
  exitPrice:  Number,
  exitTime:   Date,
  exitReason: String,
  pnl:        Number,
  returnPct:  Number,
}, { _id: false });

const orbTradeSchema = new mongoose.Schema({
  date:        { type: Date, required: true, index: true },
  candidates:  [orbCandidateSchema],

  // Day summary (updated on exits)
  entriesCount: { type: Number, default: 0 },
  totalPnl:     { type: Number, default: 0 },
}, { timestamps: true });

/**
 * Find today's ORB document (IST day boundary).
 */
orbTradeSchema.statics.findToday = function () {
  const now       = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow    = new Date(now.getTime() + istOffset);
  const startIST  = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());
  const utcStart  = new Date(startIST.getTime() - istOffset);
  const utcEnd    = new Date(utcStart.getTime() + 86400000);
  return this.findOne({ date: { $gte: utcStart, $lt: utcEnd } });
};

export default mongoose.model('OrbTrade', orbTradeSchema, 'orb_trades');
