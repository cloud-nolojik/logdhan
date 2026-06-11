/**
 * OrbPipelineLog — per-day stage trail for the ORB pipeline (2026-06-11).
 *
 * One row per stage event: prefetch / bootstrap / snapshot / arming / fills /
 * force-exit, each with ok + detail. Console logs tell the same story but get
 * rotated and interleaved; this gives ONE Mongo query that answers "what ran,
 * what failed, and why" for any trading day:
 *
 *   db.orb_pipeline_log.find({ dateKey: '2026-06-12' }).sort({ t: 1 })
 *
 * Lives OUTSIDE orb_trades on purpose — the trail must survive the failure
 * mode where the day doc itself never gets created (exactly the case you'd
 * be debugging). Writes are best-effort and never throw into the pipeline.
 */

import mongoose from 'mongoose';

const orbPipelineLogSchema = new mongoose.Schema({
  t:       { type: Date,   required: true },
  dateKey: { type: String, required: true, index: true },   // 'YYYY-MM-DD' IST
  stage:   { type: String, required: true },                // e.g. 'prefetch', 'bootstrap', 'snapshot', 'arming', 'fill', 'force-exit'
  ok:      { type: Boolean, required: true },
  detail:  { type: mongoose.Schema.Types.Mixed, default: undefined },
}, { timestamps: false });

export default mongoose.model('OrbPipelineLog', orbPipelineLogSchema, 'orb_pipeline_log');
