import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Cashfree order details
  orderId: {
    type: String,
    required: true,
    unique: true
  },
  paymentSessionId: {
    type: String,
    required: true,
    unique: true
  },
  // Payment details
  amount: {
    type: Number,
    required: true,
    min: 1
  },
  currency: {
    type: String,
    default: 'INR'
  },
  // Credits to be added
  credits: {
    type: Number,
    required: true,
    min: 1
  },
  // Payment status
  status: {
    type: String,
    enum: ['PENDING', 'SUCCESS', 'FAILED', 'EXPIRED', 'CANCELLED'],
    default: 'PENDING'
  },
  // Payment method used
  paymentMethod: {
    type: String,
    enum: ['UPI', 'CARD', 'NETBANKING', 'WALLET', 'PAYLATER'],
    required: false
  },
  // Cashfree response data
  cashfreeData: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Error details if payment failed
  errorDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Timestamps
  orderCreatedAt: {
    type: Date,
    required: true
  },
  paymentCompletedAt: {
    type: Date,
    required: false
  }
}, {
  timestamps: true
});

// Indexes for better query performance
paymentSchema.index({ user: 1, createdAt: -1 });
paymentSchema.index({ status: 1 });

// Static methods
paymentSchema.statics.findByOrderId = function(orderId) {
  return this.findOne({ orderId });
};

paymentSchema.statics.findBySessionId = function(sessionId) {
  return this.findOne({ paymentSessionId: sessionId });
};

paymentSchema.statics.getUserPayments = function(userId, limit = 20, skip = 0) {
  return this.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip);
};

// Instance methods
paymentSchema.methods.markAsSuccess = function(paymentData) {
  this.status = 'SUCCESS';
  this.paymentMethod = paymentData.paymentMethod;
  this.paymentCompletedAt = new Date();
  this.cashfreeData = paymentData;
  return this.save();
};

paymentSchema.methods.markAsFailed = function(errorData) {
  this.status = 'FAILED';
  this.errorDetails = errorData;
  this.paymentCompletedAt = new Date();
  return this.save();
};

paymentSchema.methods.markAsExpired = function() {
  this.status = 'EXPIRED';
  this.paymentCompletedAt = new Date();
  return this.save();
};

export const Payment = mongoose.model('Payment', paymentSchema); 