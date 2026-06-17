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

  // In-play snapshot (2026-06-11) — set by the 09:21 orb-rvol-snapshot job.
  // rvol5 = day-cumulative volume at ~09:21 (≈ first 6 min) vs the time-matched
  // 09:15-slot baseline (scaled). inPlay=true → eligible for 09:24 entry arming;
  // inPlay=false → spectator (kept for observability). undefined = snapshot never
  // ran — NOTE (post paper-cutover): the system is then FAIL-CLOSED, not fail-open:
  // placeOrbEntryOrders retries the snapshot once and otherwise refuses to arm,
  // so a missing snapshot = a no-trade day, never "trade the whole universe".
  rvol5:  Number,
  inPlay: Boolean,

  // Status. 'ARMED' (2026-06-11, paper mode) = resting SL-M entry order placed at
  // the 5-min OR edge, waiting for the exchange to trigger it. ARMED → ENTERED on
  // fill, ARMED → SKIPPED on reject/cancel/15:00 unfilled cutoff.
  status: {
    type: String,
    enum: ['WATCHING', 'RANGE_SET', 'ARMED', 'ENTERED', 'STOPPED_OUT', 'TARGET_HIT', 'TIME_EXIT', 'SKIPPED', 'REARM_WATCH', 'AWAIT_ENTRY'],
    default: 'WATCHING',
  },

  // 2026-06-11 paper mode (Zarattini/Barbon/Aziz spec) — per-stock fields:
  //   firstCandleOpen/Close — the 09:15–09:20 5-min candle that sets direction
  //   (close>open → LONG only, close<open → SHORT only, equal → doji, skip)
  //   atr14d        — daily ATR(14), stop sizing basis
  //   stopDistance  — 0.10 × atr14d (tick-snapped); protective SL goes at
  //                   fill price ∓ stopDistance once the entry triggers
  firstCandleOpen:  Number,
  firstCandleClose: Number,
  atr14d:           Number,
  stopDistance:     Number,

  // Audit: why a candidate was SKIPPED (was already written by enterTrade but
  // silently dropped by strict mode — now persisted).
  skipReason: String,

  // Trade execution
  direction:   { type: String, default: 'LONG' },
  qty:         Number,
  entryPrice:  Number,
  entryTime:   Date,
  stopPrice:   Number,
  reentryCount: { type: Number, default: 0 },   // #4 re-entry: times re-armed after a stop this day
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

  // 2026-06-11: BE-at-+1R re-enabled. PERSISTED (the old code used a transient
  // `_beTrailed` that reset every 5-min monitor cycle → would have re-placed the
  // same SL endlessly). true = the one-time move to cushioned breakeven was done;
  // never trails again after this.
  beTrailed: { type: Boolean, default: false },

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

  // 2026-06-11: 09:21 in-play RVOL snapshot audit. rvolSnapshotAt=null means the
  // job never ran (or failed open) — Phase 2 then treats ALL candidates as eligible.
  // rvol5Fallback=true means fewer than the minimum names cleared the RVOL floor,
  // so the top-N-by-rvol5 fallback selection was used (logged loudly).
  rvolSnapshotAt: { type: Date, default: null },
  rvol5Fallback:  { type: Boolean, default: false },

  // 2026-06-11 paper mode: when the 09:24 orb-place-entries job armed the day's
  // resting entry orders. Idempotency guard — the job refuses to run twice.
  paperEntriesPlacedAt: { type: Date, default: null },

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
