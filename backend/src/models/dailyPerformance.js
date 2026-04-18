import mongoose from 'mongoose';

/**
 * DailyPerformance — one summary row per trading day.
 *
 * Written by metricsService.recordDailyMetrics() after the 15:00 exit job completes.
 * Enables fast aggregations for win-rate, Sharpe, drawdown, R:R drift without
 * scanning the DailyPick collection.
 */
const dailyPerformanceSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true, index: true },  // YYYY-MM-DD IST

  regime:         { type: String },   // final regime label at 8:30
  regime_score:   { type: Number },
  playbook:       { type: String },
  max_trades:     { type: Number },
  size_multiplier:{ type: Number },

  // Pick counts through the funnel
  shortlist_size:     { type: Number },
  gate_survivors:     { type: Number },
  picks_selected:     { type: Number },
  picks_promoted:     { type: Number },
  picks_entered:      { type: Number },
  picks_closed:       { type: Number },

  // P&L + risk metrics
  wins:       { type: Number },
  losses:     { type: Number },
  win_rate:   { type: Number },               // % of closed trades that were wins
  total_pnl:  { type: Number },               // ₹
  pnl_pct:    { type: Number },               // % of capital deployed
  avg_planned_rr:  { type: Number },
  avg_realized_rr: { type: Number },
  rr_drift:        { type: Number },          // realized − planned (negative = decay)
  max_loss_trade:  { type: Number },          // worst trade ₹
  max_win_trade:   { type: Number },          // best trade ₹

  // Circuit-breaker / halt signal (true on days we sat out or tripped)
  halted:          { type: Boolean, default: false },
  halt_reason:     { type: String, default: null },

  // Metadata
  paper_trade:     { type: Boolean, default: false },
  regime_version:  { type: String, default: 'v2' },
  recorded_at:     { type: Date, default: Date.now },
}, { collection: 'daily_performance' });

dailyPerformanceSchema.index({ date: -1 });

export default mongoose.models.DailyPerformance
  || mongoose.model('DailyPerformance', dailyPerformanceSchema);
