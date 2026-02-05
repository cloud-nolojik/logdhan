import mongoose from 'mongoose';

const appFeedbackSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  user_name: {
    type: String,
    default: ''
  },
  user_mobile: {
    type: String,
    default: ''
  },
  feedback_type: {
    type: String,
    enum: ['feedback', 'feature_request', 'bug_report', 'other'],
    default: 'feedback'
  },
  rating: {
    type: Number,
    min: 1,
    max: 5,
    required: true
  },
  comment: {
    type: String,
    default: '',
    maxlength: 2000
  },
  app_version: {
    type: String,
    default: ''
  },
  device_info: {
    type: String,
    default: ''
  },
  // Admin tracking
  is_read: {
    type: Boolean,
    default: false
  },
  admin_notes: {
    type: String,
    default: ''
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Indexes for efficient queries
appFeedbackSchema.index({ created_at: -1 });
appFeedbackSchema.index({ rating: 1 });
appFeedbackSchema.index({ feedback_type: 1 });
appFeedbackSchema.index({ is_read: 1 });

const AppFeedback = mongoose.model('AppFeedback', appFeedbackSchema);

export default AppFeedback;
