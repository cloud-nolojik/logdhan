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

  // Quality-ranking inputs/outputs (2026-06-02). avgDailyVolume is the 20-day
  // baseline fetched at pre-open (RVOL denominator); rvol/relStrength/rankScore
  // are computed at the breakout scan and stored for observability/backtest.
  avgDailyVolume: Number,
  adrPct:         Number,   // 20-day avg daily range as % of price — denominator for the OR-width filter
  volumeProfile:  { type: mongoose.Schema.Types.Mixed, default: undefined },  // { 'HH:MM': avgVol } time-matched RVOL baseline
  rvol:           Number,
  relStrength:    Number,
  rankScore:      Number,

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

  // VWAP reversal-exit state (2026-06-02) — per-stock cumulative VWAP, refreshed
  // each 5-min monitor cycle. vwapConsecutiveOpp counts consecutive closes on the
  // wrong side of VWAP; 2 in a row triggers an exit (institutional flow flipped).
  vwapLast:            { type: Number, default: null },
  vwapConsecutiveOpp:  { type: Number, default: 0 },
  vwapLastBarTime:     { type: String, default: null },  // dedup: last 5-min bar counted
}, { _id: false });

const orbTradeSchema = new mongoose.Schema({
  date:        { type: Date, required: true, index: true },
  candidates:  [orbCandidateSchema],

  // Day summary (updated on exits)
  entriesCount: { type: Number, default: 0 },
  totalPnl:     { type: Number, default: 0 },
  volBaselineRetried: { type: Boolean, default: false },  // lazy RVOL-baseline re-fetch attempted

  // DEPRECATED 2026-06-02: the breakout-breadth 70% direction lock was removed —
  // the live Nifty regime (marketRegime, below) is now the sole direction authority.
  // This field is no longer written or read by decideBreakoutActions; kept only so
  // historical docs don't error. Safe to drop in a future migration.
  dailyDirectionBias: { type: String, enum: ['LONG', 'SHORT', 'BOTH'], default: null },

  // 2026-06-02: Live Nifty market regime. Computed each breakout scan from the
  // NIFTY 50 index opening range (09:15–09:30) + current level. BULL gates to
  // LONG entries only, BEAR to SHORT only, NEUTRAL falls back to breakout breadth.
  // Unlike dailyDirectionBias this is recomputed live each scan so it adapts when
  // the index reverses intraday.
  marketRegime: { type: String, enum: ['BULL', 'BEAR', 'NEUTRAL', 'UNKNOWN'], default: 'UNKNOWN' },
  niftyOrHigh:  { type: Number, default: null },
  niftyOrLow:   { type: Number, default: null },

  // 2026-06-02: Live regime trail — one entry per scan/monitor cycle, so the
  // production direction decisions (and intraday flips) are queryable from the DB
  // instead of only living in logs. `src` = 'scan' (breakout check) | 'monitor'.
  // (Backtesting a *changed* strategy doesn't need this — it recomputes regime
  // from the raw Nifty candles in backtest_candles — this is for auditing what the
  // LIVE system actually decided.)
  regimeHistory: {
    type: [new mongoose.Schema({
      t:        { type: Date,   required: true },
      regime:   { type: String, default: 'UNKNOWN' },
      niftyLtp: { type: Number, default: null },
      src:      { type: String, default: 'scan' },
    }, { _id: false })],
    default: [],
  },
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
