import mongoose from 'mongoose';

/**
 * Daily India VIX snapshot. Used by Regime v2 for volatility input.
 * Populated by services/jobs/vixSnapshotJob.js at 21:00 IST.
 */
const IndiaVixDailySchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true, index: true }, // "YYYY-MM-DD" IST
  open: Number,
  high: Number,
  low: Number,
  close: { type: Number, required: true },
  prev_close: Number,
  change_pct: Number,
  source: { type: String, default: 'NSE_ALLINDICES' },
  fetched_at: { type: Date, default: Date.now },
}, { collection: 'india_vix_daily' });

export default mongoose.models.IndiaVixDaily
  || mongoose.model('IndiaVixDaily', IndiaVixDailySchema);
