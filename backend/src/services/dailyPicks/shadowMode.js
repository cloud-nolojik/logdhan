/**
 * Shadow Mode — tune thresholds without going live.
 *
 * Reads SHADOW_OVERRIDES from env — a JSON blob of threshold names → candidate
 * values. For every such override, both the live value and the candidate value
 * are run through the relevant decision function, and the resulting divergence
 * is logged to `shadow_log` per day. Nothing in the candidate path ever touches
 * trade placement.
 *
 * Canonical use case: you want to see what today's shortlist + gate + preopen
 * flow would have produced with ATR floor 1.0% instead of 1.2%, without
 * actually running the looser threshold live. Ship once you've got 20+ days
 * of shadow logs showing it's a net improvement.
 *
 * Usage (set in .env):
 *   SHADOW_OVERRIDES={"GATE_ATR_MIN_PCT": 1.0, "GATE_ATR_MAX_PCT": 4.5}
 *
 * Then call `shadow.runShadowGate(pick, liveVerdict, overrides)` from Step 4.
 * If overrides are set, this runs a second gate check with the candidate
 * thresholds and logs the delta per pick.
 */

import mongoose from 'mongoose';

const LOG = '[SHADOW]';

const shadowLogSchema = new mongoose.Schema({
  date:      { type: String, required: true, index: true },
  symbol:    { type: String, required: true },
  scope:     { type: String, required: true },  // e.g. 'step4_gate', 'regime_score'
  live_verdict:     { type: mongoose.Schema.Types.Mixed, default: null },
  shadow_verdict:   { type: mongoose.Schema.Types.Mixed, default: null },
  overrides_used:   { type: mongoose.Schema.Types.Mixed, default: null },
  divergence:       { type: Boolean, default: false },  // live vs shadow differ
  created_at:       { type: Date, default: Date.now },
}, { collection: 'shadow_log' });

const ShadowLog = mongoose.models.ShadowLog || mongoose.model('ShadowLog', shadowLogSchema);

/**
 * Parse SHADOW_OVERRIDES env once and cache.
 */
let cachedOverrides = null;
export function getOverrides() {
  if (cachedOverrides !== null) return cachedOverrides;
  try {
    const raw = process.env.SHADOW_OVERRIDES;
    cachedOverrides = raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn(`${LOG} SHADOW_OVERRIDES parse failed, disabling shadow mode:`, err.message);
    cachedOverrides = {};
  }
  return cachedOverrides;
}

export function isShadowEnabled() {
  return Object.keys(getOverrides()).length > 0;
}

/**
 * Log a shadow-vs-live divergence row.
 *
 * @param {Object} entry
 * @param {string} entry.date          — YYYY-MM-DD IST
 * @param {string} entry.symbol
 * @param {string} entry.scope         — categorization: 'step4_gate', 'preopen', 'regime_score'
 * @param {any}    entry.liveVerdict   — what live produced
 * @param {any}    entry.shadowVerdict — what candidate thresholds produced
 */
export async function logDivergence(entry) {
  if (!isShadowEnabled()) return;
  try {
    const live = JSON.stringify(entry.liveVerdict);
    const shadow = JSON.stringify(entry.shadowVerdict);
    await ShadowLog.create({
      date: entry.date,
      symbol: entry.symbol,
      scope: entry.scope,
      live_verdict: entry.liveVerdict,
      shadow_verdict: entry.shadowVerdict,
      overrides_used: getOverrides(),
      divergence: live !== shadow,
    });
  } catch (err) {
    // Swallow — shadow logging must never break the live path.
    console.warn(`${LOG} logDivergence failed for ${entry.symbol}:`, err.message);
  }
}

/**
 * Daily summary of where shadow differed from live.
 */
export async function dailySummary(date) {
  const rows = await ShadowLog.find({ date }).lean();
  const byScope = {};
  for (const r of rows) {
    byScope[r.scope] = byScope[r.scope] || { total: 0, diverged: 0 };
    byScope[r.scope].total++;
    if (r.divergence) byScope[r.scope].diverged++;
  }
  return { date, overrides: getOverrides(), byScope, rows: rows.length };
}

export default { getOverrides, isShadowEnabled, logDivergence, dailySummary };
