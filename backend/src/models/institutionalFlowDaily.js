import mongoose from 'mongoose';

/**
 * Daily FII/DII cash segment net flows (crores).
 * Populated by services/jobs/fiiFlowJob.js at 19:00 IST.
 * Read by Regime v2 for the flow input.
 */
const InstitutionalFlowDailySchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true, index: true }, // "YYYY-MM-DD" IST
  // Cash segment net values in crores (positive = net buying)
  fii_net_cr: { type: Number, required: true },
  dii_net_cr: { type: Number },
  fii_gross_buy_cr: Number,
  fii_gross_sell_cr: Number,
  dii_gross_buy_cr: Number,
  dii_gross_sell_cr: Number,
  source: { type: String, default: 'NSE_FIIDII' },
  fetched_at: { type: Date, default: Date.now },
}, { collection: 'institutional_flow_daily' });

export default mongoose.models.InstitutionalFlowDaily
  || mongoose.model('InstitutionalFlowDaily', InstitutionalFlowDailySchema);
