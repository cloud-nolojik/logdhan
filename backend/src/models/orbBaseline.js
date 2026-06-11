/**
 * OrbBaseline — nightly-computed RVOL baseline cache, one doc per symbol.
 *
 * WHY (2026-06-11): building the 20-day time-matched volume profiles at 09:08
 * meant ~215 per-symbol historical calls in one burst — running at Kite's 429
 * ceiling with retries as the only safety net, and (post paper-cutover) the
 * whole trading day depends on those baselines existing. The data only needs
 * candles THROUGH the previous session, so the `orb-baseline-prefetch` job now
 * computes everything at 16:15 IST (zero API contention) and 09:08 becomes a
 * Mongo read. Live fetch survives as a per-symbol fallback for cache misses
 * (new F&O entrants, prefetch failure).
 *
 * Staleness: consumers accept computedAt within BASELINE_MAX_AGE_DAYS (5) so
 * weekends/holidays don't invalidate Friday's cache.
 */

import mongoose from 'mongoose';

const orbBaselineSchema = new mongoose.Schema({
  symbol:         { type: String, required: true, unique: true },

  // { 'HH:MM': avgVol } per 15-min slot, averaged over ~20 trading days.
  // rvol5 (09:21 snapshot) uses the '09:15' slot; full profile kept for the
  // scan-time RVOL and observability.
  volumeProfile:  { type: mongoose.Schema.Types.Mixed, default: undefined },
  avgDailyVolume: Number,

  // ADR% computed against the last 15-min bar close of the window (the morning
  // path used the pre-open IEP as refPrice — close-vs-IEP differs by the
  // overnight gap; adrPct is observability-only so the difference is accepted).
  adrPct:         Number,
  lastClose:      Number,

  computedAt:     { type: Date, required: true, index: true },
}, { timestamps: true });

export default mongoose.model('OrbBaseline', orbBaselineSchema, 'orb_baselines');
