import mongoose from 'mongoose';

/**
 * Daily breadth snapshot: % of Nifty 500 (or fallback) above their own 50-DMA.
 * Populated by services/jobs/breadthSnapshotJob.js at 21:05 IST.
 * Read by engine/regimeDataFetchers.js for Regime v2 Step 1.
 */
const BreadthDailySchema = new mongoose.Schema({
  // IST trading date, string "YYYY-MM-DD" for unambiguous indexing
  date: { type: String, required: true, unique: true, index: true },
  universe: { type: String, required: true, default: 'NIFTY500' },
  total_stocks: { type: Number, required: true },
  above_50dma_count: { type: Number, required: true },
  pct_above_50dma: { type: Number, required: true }, // 0..100
  computed_at: { type: Date, default: Date.now },
}, { collection: 'breadth_daily' });

export default mongoose.models.BreadthDaily
  || mongoose.model('BreadthDaily', BreadthDailySchema);
