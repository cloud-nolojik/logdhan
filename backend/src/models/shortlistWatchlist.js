import mongoose from 'mongoose';

/**
 * ShortlistWatchlist — the preliminary ~50-name intraday watchlist produced
 * by the 8:30 AM shortlist-heavy scan.
 *
 * One document per trading date. Each doc holds the full ranked list of
 * scored F&O candidates plus metadata about which signals ran and which
 * were degraded/missing. The 9:08 finalize pass reads this doc and narrows
 * it further with pre-open data.
 */

const signalScoreSchema = new mongoose.Schema({
  catalyst:     { type: Number, default: null },  // 0 or 1 (has news catalyst today)
  gap:          { type: Number, default: null },  // estimated gap %, can be negative
  rs_z:         { type: Number, default: null },  // 5-day relative-strength z-score vs Nifty
  sector_top3:  { type: Number, default: null },  // 0 or 1 (sector is in today's top 3)
  direction_fit:{ type: Number, default: null }   // -1, 0, or +1 vs marketContext
}, { _id: false });

const candidateSchema = new mongoose.Schema({
  trading_symbol:  { type: String, required: true, index: true },
  name:            { type: String },
  instrument_key:  { type: String },
  sector:          { type: String },
  direction:       { type: String, enum: ['LONG', 'SHORT', 'NEUTRAL'] },

  signals:         { type: signalScoreSchema, default: () => ({}) },
  composite_score: { type: Number, required: true, index: true },
  rank:            { type: Number, required: true },

  // Optional reason tags for debugging / display
  reasons:         { type: [String], default: [] },

  // Catalyst enrichment (if present)
  catalyst_meta:   { type: mongoose.Schema.Types.Mixed, default: null },

  // Filled in AFTER downstream Steps 2.5–6 run (stampPostFilter).
  // null = not yet stamped for this run.
  // Values:
  //   'selected'                 — made it into the final DailyPick picks[]
  //   'not_selected'             — passed all gates, not in top max_trades
  //   'dropped_neutral_direction'— adapter dropped in runShortlistScan (NEUTRAL only)
  //   'dropped_earnings'         — board meeting within 4 trading days
  //   'dropped_no_ohlcv'         — enrichment didn't return OHLCV (Step 3)
  //   'dropped_gate_liquidity'   — Step 4 G1 fail (turnover or volume_ratio)
  //   'dropped_gate_atr'         — Step 4 G2 fail (ATR envelope)
  //   'dropped_gate_chase'       — Step 4 G3 fail (>3% beyond EMA20 in direction)
  //   'dropped_gate_exhaustion'  — Step 4 G4 fail (3+ consec + EMA20 dist + RSI extreme)
  //   'dropped_gate_counter_regime' — Step 4 G5 fail (direction vs regime)
  post_filter_status: { type: String, default: null },

  // ─── Pre-open depth check (stamped at 09:12:30 by preopenDepthJob) ───────
  // Filled after the Kite /quote call at 09:12:30 IST — after the NSE pre-open
  // matching engine has settled opening prices for every stock.
  //
  // preopen_imbalance = total_buy_qty / total_ask_qty       (>1 LONG-biased)
  // preopen_mid_pct   = (weighted_mid - prev_close) / prev_close × 100
  // preopen_liquidity = total_buy_qty + total_sell_qty      (thin if < 1000)
  // preopen_spread_pct = (best_ask - best_bid) / best_bid × 100
  // preopen_score ∈ [-1, +1]  — combined signal from the above, direction-aware
  // preopen_status:
  //   'kept'                           — survived pre-open check (top 8–10)
  //   'dropped_preopen_thin'           — < liquidity floor
  //   'dropped_preopen_imbalance'      — wrong direction vs trade direction
  //   'dropped_preopen_wide_spread'    — spread too wide to trade cleanly
  //   'dropped_preopen_no_quote'       — Kite /quote returned no data
  preopen_imbalance:  { type: Number, default: null },
  preopen_mid_pct:    { type: Number, default: null },
  preopen_liquidity:  { type: Number, default: null },
  preopen_spread_pct: { type: Number, default: null },
  preopen_score:      { type: Number, default: null },
  preopen_status:     { type: String, default: null }
}, { _id: false });

const shortlistWatchlistSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true, index: true }, // YYYY-MM-DD IST

  // Copy of marketContext used to score this watchlist (for audit)
  market_context: { type: mongoose.Schema.Types.Mixed, default: null },

  // Top-N ranked candidates
  candidates: { type: [candidateSchema], default: [] },

  // Which signals executed successfully, which failed/degraded
  signal_status: {
    catalyst:     { type: String, enum: ['ok', 'degraded', 'failed'], default: 'ok' },
    gap:          { type: String, enum: ['ok', 'degraded', 'failed'], default: 'ok' },
    rs:           { type: String, enum: ['ok', 'degraded', 'failed'], default: 'ok' },
    sector:       { type: String, enum: ['ok', 'degraded', 'failed'], default: 'ok' },
    direction:    { type: String, enum: ['ok', 'degraded', 'failed'], default: 'ok' }
  },

  // Universe stats for debugging
  stats: {
    universe_size:    { type: Number },
    scored_count:     { type: Number },
    output_count:     { type: Number },
    duration_ms:      { type: Number }
  },

  // Warnings surfaced during scoring (e.g. "GIFT Nifty fetch failed, gap signal degraded")
  warnings: { type: [String], default: [] },

  decided_at: { type: Date, default: Date.now, index: true },

  // When stampPostFilter() ran — null until the DailyPicks pipeline calls it
  post_filter_stamped_at: { type: Date, default: null },
  // When stampPreopenFilter() ran — null until preopenDepthJob calls it at 09:12:30
  preopen_stamped_at: { type: Date, default: null },
  preopen_summary: {
    kept:                      { type: Number, default: 0 },
    dropped_preopen_thin:      { type: Number, default: 0 },
    dropped_preopen_imbalance: { type: Number, default: 0 },
    dropped_preopen_wide_spread:{ type: Number, default: 0 },
    dropped_preopen_no_quote:  { type: Number, default: 0 }
  },
  // Rollup counts for quick dashboard queries without scanning candidates[]
  post_filter_summary: {
    selected:                     { type: Number, default: 0 },
    not_selected:                 { type: Number, default: 0 },
    dropped_neutral_direction:    { type: Number, default: 0 },
    dropped_earnings:             { type: Number, default: 0 },
    dropped_no_ohlcv:             { type: Number, default: 0 },
    dropped_gate_liquidity:       { type: Number, default: 0 },
    dropped_gate_atr:             { type: Number, default: 0 },
    dropped_gate_chase:           { type: Number, default: 0 },
    dropped_gate_exhaustion:      { type: Number, default: 0 },
    dropped_gate_counter_regime:  { type: Number, default: 0 }
  }
}, { timestamps: true, collection: 'shortlist_watchlists' });

shortlistWatchlistSchema.index({ date: -1 });

/**
 * Upsert today's watchlist.
 */
shortlistWatchlistSchema.statics.upsertForDate = async function (date, doc) {
  return await this.findOneAndUpdate(
    { date },
    { $set: { ...doc, date } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
};

/**
 * Fetch today's watchlist.
 */
shortlistWatchlistSchema.statics.getForDate = async function (date) {
  return await this.findOne({ date }).lean();
};

/**
 * Stamp per-candidate post-filter status for a given trading date.
 * Called from the DailyPicks pipeline after Step 6 (selection) — after this
 * call, every candidate in the shortlist carries a verdict explaining what
 * happened to it downstream of Step 2.
 *
 * @param {string} date      — YYYY-MM-DD IST
 * @param {Map|Object} statusMap — { tradingSymbol → statusString }
 * @returns {Promise<{ matchedCount: number, modifiedCount: number }>}
 */
shortlistWatchlistSchema.statics.stampPostFilter = async function (date, statusMap) {
  const entries = statusMap instanceof Map ? [...statusMap.entries()] : Object.entries(statusMap);
  const doc = await this.findOne({ date });
  if (!doc) return { matchedCount: 0, modifiedCount: 0 };

  const statusBySymbol = new Map(entries);
  const summary = {
    selected: 0, not_selected: 0,
    dropped_neutral_direction: 0, dropped_earnings: 0, dropped_no_ohlcv: 0,
    dropped_gate_liquidity: 0, dropped_gate_atr: 0, dropped_gate_chase: 0,
    dropped_gate_exhaustion: 0, dropped_gate_counter_regime: 0
  };

  let modified = 0;
  for (const candidate of doc.candidates) {
    const status = statusBySymbol.get(candidate.trading_symbol) || null;
    if (status && candidate.post_filter_status !== status) {
      candidate.post_filter_status = status;
      modified++;
    }
    if (status && Object.prototype.hasOwnProperty.call(summary, status)) {
      summary[status]++;
    }
  }

  doc.post_filter_stamped_at = new Date();
  doc.post_filter_summary = summary;
  doc.markModified('candidates');
  await doc.save();
  return { matchedCount: doc.candidates.length, modifiedCount: modified };
};

/**
 * Stamp per-candidate pre-open depth signals on today's watchlist.
 * Called from preopenDepthJob at 09:12:30 IST after Kite /quote returns.
 *
 * @param {string} date  — YYYY-MM-DD IST
 * @param {Map|Object} resultMap — { tradingSymbol → { imbalance, mid_pct, liquidity, spread_pct, score, status } }
 */
shortlistWatchlistSchema.statics.stampPreopenFilter = async function (date, resultMap) {
  const entries = resultMap instanceof Map ? [...resultMap.entries()] : Object.entries(resultMap);
  const doc = await this.findOne({ date });
  if (!doc) return { matchedCount: 0, modifiedCount: 0 };

  const bySymbol = new Map(entries);
  const summary = {
    kept: 0, dropped_preopen_thin: 0, dropped_preopen_imbalance: 0,
    dropped_preopen_wide_spread: 0, dropped_preopen_no_quote: 0
  };

  let modified = 0;
  for (const c of doc.candidates) {
    const r = bySymbol.get(c.trading_symbol);
    if (!r) continue;
    c.preopen_imbalance  = r.imbalance  ?? null;
    c.preopen_mid_pct    = r.mid_pct    ?? null;
    c.preopen_liquidity  = r.liquidity  ?? null;
    c.preopen_spread_pct = r.spread_pct ?? null;
    c.preopen_score      = r.score      ?? null;
    c.preopen_status     = r.status     ?? null;
    modified++;
    if (r.status && Object.prototype.hasOwnProperty.call(summary, r.status)) summary[r.status]++;
  }

  doc.preopen_stamped_at = new Date();
  doc.preopen_summary = summary;
  doc.markModified('candidates');
  await doc.save();
  return { matchedCount: doc.candidates.length, modifiedCount: modified };
};

const ShortlistWatchlist = mongoose.model('ShortlistWatchlist', shortlistWatchlistSchema);

export default ShortlistWatchlist;
