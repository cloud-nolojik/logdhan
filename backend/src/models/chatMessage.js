import mongoose from 'mongoose';

const chatMessageSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  stockSymbol: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  message: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['user', 'ai', 'system'],
    default: 'user'
  },
  metadata: {
    step: String,
    tradeData: {
      quantity: Number,
      price: Number,
      stopLoss: Number,
      target: Number,
      reason: String,
      wantsReview: Boolean
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Add indexes for faster queries
chatMessageSchema.index({ userId: 1, stockSymbol: 1, createdAt: -1 });
chatMessageSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model('ChatMessage', chatMessageSchema); 