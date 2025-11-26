import mongoose from 'mongoose';

const pendingBracketOrderSchema = new mongoose.Schema({
  order_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  analysis_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StockAnalysis',
    required: true
  },
  strategy_id: {
    type: String,
    required: true
  },
  // Bracket order details
  stop_loss: {
    type: Number,
    required: true
  },
  target: {
    type: Number,
    required: true
  },
  // Order context
  instrument_token: {
    type: String,
    required: true
  },
  analysis_type: {
    type: String,
    required: true,
    enum: ['swing', 'intraday']
  },
  stock_symbol: {
    type: String,
    required: true
  },
  // Encrypted access token for placing bracket orders
  encrypted_access_token: {
    type: String,
    required: true
  },
  // Status tracking
  status: {
    type: String,
    enum: ['pending', 'processed', 'failed', 'expired'],
    default: 'pending',
    index: true
  },
  // Processing attempts
  processing_attempts: {
    type: Number,
    default: 0
  },
  last_processing_attempt: {
    type: Date
  },
  // Error tracking
  error_message: {
    type: String
  },
  error_details: {
    type: mongoose.Schema.Types.Mixed
  },
  // Bracket order results
  stop_loss_order_id: {
    type: String
  },
  target_order_id: {
    type: String
  },
  // Audit fields
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  },
  updated_at: {
    type: Date,
    default: Date.now
  },
  expires_at: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from creation
    index: true
  }
});

// Indexes for efficient queries
pendingBracketOrderSchema.index({ order_id: 1 });
pendingBracketOrderSchema.index({ user_id: 1, status: 1 });
pendingBracketOrderSchema.index({ status: 1, expires_at: 1 });
pendingBracketOrderSchema.index({ created_at: 1 });

// TTL index to automatically clean up expired records
pendingBracketOrderSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

// Update timestamp on save
pendingBracketOrderSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

// Static methods
pendingBracketOrderSchema.statics = {
  /**
   * Create a new pending bracket order
   */
  async createPendingOrder(orderData) {
    try {
      const pendingOrder = new this(orderData);
      await pendingOrder.save();

      return pendingOrder;
    } catch (error) {
      console.error('❌ Error creating pending bracket order:', error);
      throw error;
    }
  },

  /**
   * Find and mark pending order as being processed
   */
  async findAndMarkProcessing(orderId) {
    try {
      const pendingOrder = await this.findOneAndUpdate(
        {
          order_id: orderId,
          status: 'pending'
        },
        {
          $inc: { processing_attempts: 1 },
          $set: {
            last_processing_attempt: new Date(),
            status: 'processing'
          }
        },
        { new: true }
      );

      if (pendingOrder) {

      }

      return pendingOrder;
    } catch (error) {
      console.error(`❌ Error finding pending bracket order for ${orderId}:`, error);
      return null;
    }
  },

  /**
   * Mark order as successfully processed
   */
  async markProcessed(orderId, bracketOrderIds) {
    try {
      const result = await this.findOneAndUpdate(
        { order_id: orderId },
        {
          $set: {
            status: 'processed',
            stop_loss_order_id: bracketOrderIds.stopLoss,
            target_order_id: bracketOrderIds.target,
            updated_at: new Date()
          }
        },
        { new: true }
      );

      if (result) {

      }

      return result;
    } catch (error) {
      console.error(`❌ Error marking bracket order ${orderId} as processed:`, error);
      return null;
    }
  },

  /**
   * Mark order as failed
   */
  async markFailed(orderId, errorMessage, errorDetails = null) {
    try {
      const result = await this.findOneAndUpdate(
        { order_id: orderId },
        {
          $set: {
            status: 'failed',
            error_message: errorMessage,
            error_details: errorDetails,
            updated_at: new Date()
          }
        },
        { new: true }
      );

      if (result) {

      }

      return result;
    } catch (error) {
      console.error(`❌ Error marking bracket order ${orderId} as failed:`, error);
      return null;
    }
  },

  /**
   * Clean up old expired records manually (in case TTL doesn't work)
   */
  async cleanupExpired() {
    try {
      const result = await this.deleteMany({
        $or: [
        { expires_at: { $lt: new Date() } },
        { status: 'processed', created_at: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }, // 7 days old processed orders
        { status: 'failed', created_at: { $lt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } } // 3 days old failed orders
        ]
      });

      if (result.deletedCount > 0) {

      }

      return result;
    } catch (error) {
      console.error('❌ Error cleaning up expired pending bracket orders:', error);
      return null;
    }
  },

  /**
   * Get statistics for monitoring
   */
  async getStats() {
    try {
      const stats = await this.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }]
      );

      const result = {
        pending: 0,
        processing: 0,
        processed: 0,
        failed: 0,
        expired: 0
      };

      stats.forEach((stat) => {
        result[stat._id] = stat.count;
      });

      return result;
    } catch (error) {
      console.error('❌ Error getting pending bracket order stats:', error);
      return null;
    }
  }
};

const PendingBracketOrder = mongoose.model('PendingBracketOrder', pendingBracketOrderSchema);

export default PendingBracketOrder;