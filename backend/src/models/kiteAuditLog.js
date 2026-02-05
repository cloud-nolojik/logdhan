import mongoose from 'mongoose';

/**
 * KiteAuditLog Model
 * Comprehensive audit trail for all Kite Connect operations.
 * Used for admin monitoring, debugging, and compliance.
 */
const kiteAuditLogSchema = new mongoose.Schema({
  // Action performed
  action: {
    type: String,
    enum: [
      'LOGIN',
      'LOGIN_FAILED',
      'TOKEN_REFRESH',
      'TOKEN_VALIDATED',
      'TOKEN_EXPIRED',
      'ORDER_PLACED',
      'ORDER_MODIFIED',
      'ORDER_CANCELLED',
      'ORDER_EXECUTED',
      'ORDER_REJECTED',
      'GTT_PLACED',
      'GTT_MODIFIED',
      'GTT_CANCELLED',
      'GTT_TRIGGERED',
      'BALANCE_CHECK',
      'HOLDINGS_FETCH',
      'POSITIONS_FETCH',
      'PROFILE_FETCH',
      'ERROR',
      'MANUAL_ACTION'
    ],
    required: true,
    index: true
  },

  // Order/GTT identifiers
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

  // Stock details
  stock_symbol: {
    type: String,
    required: false,
    index: true
  },
  exchange: {
    type: String,
    required: false
  },

  // Order classification
  order_type: {
    type: String,
    enum: ['ENTRY', 'STOP_LOSS', 'TARGET1', 'TARGET2', 'TARGET3', 'TRAILING_STOP', 'MANUAL', null],
    required: false
  },

  // Transaction details
  transaction_type: {
    type: String,
    enum: ['BUY', 'SELL', null],
    required: false
  },
  quantity: {
    type: Number,
    required: false
  },
  price: {
    type: Number,
    required: false
  },
  trigger_price: {
    type: Number,
    required: false
  },

  // Execution status
  status: {
    type: String,
    enum: ['SUCCESS', 'FAILED', 'PENDING', 'PARTIAL'],
    required: true,
    index: true
  },

  // Error tracking
  error_message: {
    type: String,
    required: false
  },
  error_code: {
    type: String,
    required: false
  },

  // Full Kite API response (for debugging)
  kite_response: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  },

  // Request details (for debugging)
  request_payload: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  },

  // Financial context
  balance_before: {
    type: Number,
    required: false
  },
  balance_after: {
    type: Number,
    required: false
  },
  order_value: {
    type: Number,
    required: false
  },

  // References
  simulation_id: {
    type: String,
    required: false,
    index: true
  },
  stock_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WeeklyWatchlist',
    required: false
  },
  kite_order_ref: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'KiteOrder',
    required: false
  },

  // Session info
  kite_user_id: {
    type: String,
    required: false
  },

  // Metadata
  source: {
    type: String,
    enum: ['AUTO', 'MANUAL', 'SCHEDULED', 'WEBHOOK'],
    default: 'AUTO'
  },
  notes: {
    type: String,
    required: false
  },

  // Request metadata (for admin panel)
  ip_address: {
    type: String,
    required: false
  },
  user_agent: {
    type: String,
    required: false
  },

  // Timing
  duration_ms: {
    type: Number,
    required: false
  },

  created_at: {
    type: Date,
    default: Date.now,
    index: true
  }
});

// Compound indexes for common queries
kiteAuditLogSchema.index({ action: 1, created_at: -1 });
kiteAuditLogSchema.index({ stock_symbol: 1, created_at: -1 });
kiteAuditLogSchema.index({ status: 1, created_at: -1 });
kiteAuditLogSchema.index({ simulation_id: 1, created_at: -1 });

// Static methods
kiteAuditLogSchema.statics.logAction = async function(action, details = {}) {
  return this.create({
    action,
    order_id: details.orderId,
    gtt_id: details.gttId,
    stock_symbol: details.symbol,
    exchange: details.exchange,
    order_type: details.orderType,
    transaction_type: details.transactionType,
    quantity: details.quantity,
    price: details.price,
    trigger_price: details.triggerPrice,
    status: details.status || 'SUCCESS',
    error_message: details.error,
    error_code: details.errorCode,
    kite_response: details.response,
    request_payload: details.request,
    balance_before: details.balanceBefore,
    balance_after: details.balanceAfter,
    order_value: details.orderValue,
    simulation_id: details.simulationId,
    stock_id: details.stockId,
    kite_order_ref: details.kiteOrderRef,
    kite_user_id: details.kiteUserId,
    source: details.source || 'AUTO',
    notes: details.notes,
    ip_address: details.ipAddress,
    user_agent: details.userAgent,
    duration_ms: details.durationMs,
    created_at: new Date()
  });
};

kiteAuditLogSchema.statics.getRecentLogs = function(limit = 100) {
  return this.find()
    .sort({ created_at: -1 })
    .limit(limit);
};

kiteAuditLogSchema.statics.getLogsByAction = function(action, options = {}) {
  const query = { action };

  if (options.startDate) {
    query.created_at = { $gte: options.startDate };
  }
  if (options.endDate) {
    query.created_at = { ...query.created_at, $lte: options.endDate };
  }

  return this.find(query)
    .sort({ created_at: -1 })
    .limit(options.limit || 100);
};

kiteAuditLogSchema.statics.getLogsBySymbol = function(symbol, options = {}) {
  const query = { stock_symbol: symbol };

  if (options.startDate) {
    query.created_at = { $gte: options.startDate };
  }

  return this.find(query)
    .sort({ created_at: -1 })
    .limit(options.limit || 100);
};

kiteAuditLogSchema.statics.getFailedLogs = function(options = {}) {
  const query = { status: 'FAILED' };

  if (options.startDate) {
    query.created_at = { $gte: options.startDate };
  }

  return this.find(query)
    .sort({ created_at: -1 })
    .limit(options.limit || 100);
};

kiteAuditLogSchema.statics.getLogsBySimulation = function(simulationId) {
  return this.find({ simulation_id: simulationId })
    .sort({ created_at: 1 });
};

kiteAuditLogSchema.statics.getStats = async function(startDate, endDate) {
  const match = {};
  if (startDate || endDate) {
    match.created_at = {};
    if (startDate) match.created_at.$gte = startDate;
    if (endDate) match.created_at.$lte = endDate;
  }

  const stats = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          action: '$action',
          status: '$status'
        },
        count: { $sum: 1 },
        totalValue: { $sum: '$order_value' }
      }
    },
    {
      $group: {
        _id: '$_id.action',
        statuses: {
          $push: {
            status: '$_id.status',
            count: '$count',
            totalValue: '$totalValue'
          }
        },
        totalCount: { $sum: '$count' }
      }
    },
    { $sort: { totalCount: -1 } }
  ]);

  return stats;
};

const KiteAuditLog = mongoose.model('KiteAuditLog', kiteAuditLogSchema);

export default KiteAuditLog;
