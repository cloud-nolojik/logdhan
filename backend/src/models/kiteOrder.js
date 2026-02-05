import mongoose from 'mongoose';

/**
 * KiteOrder Model
 * Tracks all orders placed via the Kite Connect API.
 */
const kiteOrderSchema = new mongoose.Schema({
  // Reference to MongoDB user (admin only)
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Reference to weekly watchlist stock
  stock_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WeeklyWatchlist',
    required: false,
    index: true
  },

  // Reference to trade simulation
  simulation_id: {
    type: String,
    required: false,
    index: true
  },

  // Kite order/GTT identifiers
  order_id: {
    type: String,
    required: false,
    index: true
  },
  gtt_id: {
    type: Number,
    required: false,
    index: true
  },

  // Order classification
  order_type: {
    type: String,
    enum: ['ENTRY', 'STOP_LOSS', 'TARGET1', 'TARGET2', 'TARGET3', 'TRAILING_STOP', 'MANUAL'],
    required: true
  },

  // Stock details
  trading_symbol: {
    type: String,
    required: true,
    index: true
  },
  exchange: {
    type: String,
    enum: ['NSE', 'BSE', 'NFO', 'CDS', 'BFO', 'MCX'],
    default: 'NSE'
  },

  // Transaction details
  transaction_type: {
    type: String,
    enum: ['BUY', 'SELL'],
    required: true
  },
  quantity: {
    type: Number,
    required: true
  },
  price: {
    type: Number,
    required: true
  },
  trigger_price: {
    type: Number,
    required: false
  },
  product: {
    type: String,
    enum: ['CNC', 'MIS', 'NRML'],
    default: 'CNC'
  },
  kite_order_type: {
    type: String,
    enum: ['MARKET', 'LIMIT', 'SL', 'SL-M'],
    default: 'LIMIT'
  },

  // Order status
  status: {
    type: String,
    enum: ['PENDING', 'PLACED', 'OPEN', 'COMPLETE', 'CANCELLED', 'REJECTED', 'TRIGGER_PENDING'],
    default: 'PENDING',
    index: true
  },

  // Execution details
  filled_quantity: {
    type: Number,
    default: 0
  },
  pending_quantity: {
    type: Number,
    default: 0
  },
  average_price: {
    type: Number,
    required: false
  },

  // Financial tracking
  order_value: {
    type: Number,
    required: false
  },
  executed_value: {
    type: Number,
    required: false
  },

  // GTT specific fields
  is_gtt: {
    type: Boolean,
    default: false
  },
  gtt_type: {
    type: String,
    enum: ['single', 'two-leg'],
    required: false
  },
  gtt_status: {
    type: String,
    enum: ['active', 'triggered', 'cancelled', 'rejected', 'expired'],
    required: false
  },
  gtt_condition: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  },

  // Related orders (for tracking SL/Target pairs)
  parent_order_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'KiteOrder',
    required: false
  },
  related_orders: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'KiteOrder'
  }],

  // Timestamps
  placed_at: {
    type: Date,
    required: false
  },
  executed_at: {
    type: Date,
    required: false
  },
  cancelled_at: {
    type: Date,
    required: false
  },

  // Error tracking
  error_message: {
    type: String,
    required: false
  },
  rejection_reason: {
    type: String,
    required: false
  },

  // Raw Kite API response (for debugging)
  kite_response: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  },

  // Metadata
  notes: {
    type: String,
    required: false
  },

  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
});

// Indexes for common queries
kiteOrderSchema.index({ trading_symbol: 1, status: 1 });
kiteOrderSchema.index({ created_at: -1 });
kiteOrderSchema.index({ order_type: 1, status: 1 });

// Update the updated_at field on save
kiteOrderSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

// Static methods
kiteOrderSchema.statics.findByOrderId = function(orderId) {
  return this.findOne({ order_id: orderId });
};

kiteOrderSchema.statics.findByGttId = function(gttId) {
  return this.findOne({ gtt_id: gttId });
};

kiteOrderSchema.statics.findBySimulation = function(simulationId) {
  return this.find({ simulation_id: simulationId }).sort({ created_at: 1 });
};

kiteOrderSchema.statics.findActiveOrders = function(userId) {
  return this.find({
    user_id: userId,
    status: { $in: ['PLACED', 'OPEN', 'TRIGGER_PENDING'] }
  }).sort({ created_at: -1 });
};

kiteOrderSchema.statics.findActiveGTTs = function(userId) {
  return this.find({
    user_id: userId,
    is_gtt: true,
    gtt_status: 'active'
  }).sort({ created_at: -1 });
};

kiteOrderSchema.statics.getTodayOrders = function(userId) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return this.find({
    user_id: userId,
    created_at: { $gte: today }
  }).sort({ created_at: -1 });
};

// Instance methods
kiteOrderSchema.methods.markAsPlaced = function(response) {
  this.status = 'PLACED';
  this.placed_at = new Date();
  this.order_id = response.order_id;
  this.kite_response = response;
  return this.save();
};

kiteOrderSchema.methods.markAsExecuted = function(executionData) {
  this.status = 'COMPLETE';
  this.executed_at = new Date();
  this.filled_quantity = executionData.filled_quantity || this.quantity;
  this.average_price = executionData.average_price || this.price;
  this.executed_value = this.filled_quantity * this.average_price;
  return this.save();
};

kiteOrderSchema.methods.markAsCancelled = function(reason) {
  this.status = 'CANCELLED';
  this.cancelled_at = new Date();
  this.notes = reason;
  return this.save();
};

kiteOrderSchema.methods.markAsRejected = function(reason) {
  this.status = 'REJECTED';
  this.rejection_reason = reason;
  this.error_message = reason;
  return this.save();
};

const KiteOrder = mongoose.model('KiteOrder', kiteOrderSchema);

export default KiteOrder;
