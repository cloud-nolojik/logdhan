import mongoose from 'mongoose';

/**
 * WeeklyReview — one rollup doc per ISO week.
 *
 * Written by weeklyReviewJob at 10:00 IST every Saturday after the week's
 * trading closes. Aggregates DailyPerformance rows for Mon–Fri into breakdowns
 * by scan_type, sector, direction + top winners/losers + regime distribution.
 *
 * Purpose: the post-trade review loop that keeps strategies honest. If a scan
 * type lost 3 consecutive weeks, the weights need tuning. Without this doc,
 * strategy decay is invisible until P&L bleeds.
 */

const breakdownItemSchema = new mongoose.Schema({
  key:           { type: String, required: true },   // e.g. 'shortlist_gap_long' or 'ENERGY'
  trades:        { type: Number, default: 0 },
  wins:          { type: Number, default: 0 },
  losses:        { type: Number, default: 0 },
  win_rate:      { type: Number, default: null },
  total_pnl:     { type: Number, default: 0 },
  avg_planned_rr:  { type: Number, default: null },
  avg_realized_rr: { type: Number, default: null },
  rr_drift:      { type: Number, default: null },
}, { _id: false });

const weeklyReviewSchema = new mongoose.Schema({
  // ISO week: 'YYYY-Www' e.g. '2026-W17'
  iso_week: { type: String, required: true, unique: true, index: true },
  from_date: { type: String, required: true },  // Mon YYYY-MM-DD
  to_date:   { type: String, required: true },  // Fri YYYY-MM-DD

  days_recorded:   { type: Number, default: 0 },
  days_played:     { type: Number, default: 0 },
  days_halted:     { type: Number, default: 0 },
  days_zero_picks: { type: Number, default: 0 },

  // Aggregate metrics
  total_trades:     { type: Number, default: 0 },
  wins:             { type: Number, default: 0 },
  losses:           { type: Number, default: 0 },
  win_rate:         { type: Number, default: null },
  total_pnl:        { type: Number, default: 0 },
  avg_daily_pnl:    { type: Number, default: 0 },
  daily_pnl_std:    { type: Number, default: 0 },
  sharpe_daily:     { type: Number, default: null },
  sharpe_annualized:{ type: Number, default: null },
  max_drawdown_pct: { type: Number, default: 0 },

  avg_planned_rr:   { type: Number, default: null },
  avg_realized_rr:  { type: Number, default: null },
  rr_drift:         { type: Number, default: null },

  // Breakdowns — for strategy health dashboards
  by_scan_type: { type: [breakdownItemSchema], default: [] },
  by_sector:    { type: [breakdownItemSchema], default: [] },
  by_direction: { type: [breakdownItemSchema], default: [] },
  by_regime:    { type: [breakdownItemSchema], default: [] },

  // Best/worst single days
  best_day:  { date: String, pnl: Number, trades: Number },
  worst_day: { date: String, pnl: Number, trades: Number },

  // Alerts surfaced from the review
  alerts: { type: [String], default: [] },

  // Meta
  paper_trade:    { type: Boolean, default: false },
  regime_version: { type: String, default: 'v2' },
  generated_at:   { type: Date, default: Date.now },
}, { collection: 'weekly_reviews' });

weeklyReviewSchema.index({ iso_week: -1 });

export default mongoose.models.WeeklyReview
  || mongoose.model('WeeklyReview', weeklyReviewSchema);
