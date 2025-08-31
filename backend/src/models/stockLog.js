import mongoose from 'mongoose';

const stockLogSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  stock: {
    instrument_key: {
      type: String,
      required: true
    },
    trading_symbol: {
      type: String,
      required: true
    },
    name: {
      type: String,
      required: true
    },
    exchange: {
      type: String,
      required: true,
      enum: ['NSE', 'BSE']
    }
  },
  direction: {
    type: String,
    enum: ['BUY', 'SELL'],
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 0
  },
  entryPrice: {
    type: Number,
    required: true,
    min: 0
  },
  targetPrice: {
    type: Number,
    min: 0
  },
  stopLoss: {
    type: Number,
    min: 0
  },
  executed: {
    type: Boolean,
    default: true
  },
  executedAt: {
    type: Date,
    default: Date.now
  },
  // New fields for AI review functionality
  needsReview: {
    type: Boolean,
    default: false
  },
  isRead: {
    type: Boolean,
    default: false
  },
  term:{
    type: String,
    enum: ['intraday','short','medium'],
    required: true
  },
  reasoning: {
    type: String,
    trim: true,
    maxlength: 2000 // Limit reasoning to 2000 characters
  },
  reviewStatus: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'error', 'rejected']
  },
  reviewResult: mongoose.Schema.Types.Mixed, // Flexible field for storing AI review results
  reviewRequestedAt: Date,
  reviewCompletedAt: Date,
  reviewError: mongoose.Schema.Types.Mixed, // Store error details
  // Track if this review was triggered by rewarded ad (bonus) or regular/paid
  isFromRewardedAd: {
    type: Boolean,
    default: false
  },
  // Track the credit type used for model selection
  creditType: {
    type: String,
    enum: ['regular', 'bonus', 'paid'],
    default: 'regular'
  },
  // Comprehensive review metadata
  reviewMetadata: {
    totalCost: Number,
    costBreakdown: mongoose.Schema.Types.Mixed,
    modelsUsed: [String],
    userExperience: mongoose.Schema.Types.Mixed,
    tokenUsage: mongoose.Schema.Types.Mixed,
    reviewProcessedAt: Date,
    modelBreakdown: mongoose.Schema.Types.Mixed
  },
  // Debug fields for troubleshooting
  debugInfo: {
    payload: mongoose.Schema.Types.Mixed, // Store the full payload sent to AI
    prompt: mongoose.Schema.Types.Mixed,  // Store the AI prompt used
    candleData: mongoose.Schema.Types.Mixed, // Store raw candle data summary
    savedAt: { type: Date, default: Date.now }
  },
  apiCosts: mongoose.Schema.Types.Mixed,
  // Token usage tracking for AI review
  tokenUsage: {
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheCreationInputTokens: { type: Number, default: 0 },
    cacheReadInputTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    estimatedCost: { type: Number, default: 0 },
    model: String,
    timestamp: Date
  }
}, {
  timestamps: true
});

// Add compound index for faster queries
stockLogSchema.index({ user: 1, 'stock.instrument_key': 1, createdAt: -1 });
stockLogSchema.index({ user: 1, needsReview: 1, reviewStatus: 1 }); // Index for finding reviews

const StockLog = mongoose.model('StockLog', stockLogSchema);

export default StockLog; 