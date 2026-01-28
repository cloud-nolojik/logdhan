import mongoose from 'mongoose';

const bulkAlertLogSchema = new mongoose.Schema({
  jobId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  alertType: {
    type: String,
    enum: ['weekly', 'daily'],
    required: true
  },
  totalUsers: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'partial'],
    default: 'pending'
  },
  results: {
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    failures: [{
      userId: mongoose.Schema.Types.ObjectId,
      mobileNumber: String,
      error: String
    }]
  },
  startedAt: Date,
  completedAt: Date
}, {
  timestamps: true
});

// Index for querying recent jobs
bulkAlertLogSchema.index({ createdAt: -1 });

export default mongoose.model('BulkAlertLog', bulkAlertLogSchema);
