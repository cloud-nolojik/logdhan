import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200
  },
  message: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000
  },
  type: {
    type: String,
    required: true,
    enum: ['trade_log', 'ai_review', 'credit', 'system', 'alert', 'subscription'],
    default: 'system'
  },
  isRead: {
    type: Boolean,
    default: false,
    index: true
  },
  // Reference to related entities
  relatedTradeLog: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'StockLog',
    required: false
  },
  relatedStock: {
    trading_symbol: String,
    instrument_key: String
  },
  // Additional data for the notification
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Notification expires after 7 days
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from creation
    index: { expires: 0 } // MongoDB TTL index for automatic deletion
  }
}, {
  timestamps: true
});

// Compound index for efficient queries
notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, isRead: 1 });
notificationSchema.index({ user: 1, type: 1 });

// Static method to create notification
notificationSchema.statics.createNotification = async function(data) {
  return await this.create({
    user: data.userId,
    title: data.title,
    message: data.message,
    type: data.type || 'system',
    relatedTradeLog: data.relatedTradeLog,
    relatedStock: data.relatedStock,
    metadata: data.metadata || {}
  });
};

// Static method to mark notification as read
notificationSchema.statics.markAsRead = async function(notificationId, userId) {
  return await this.findOneAndUpdate(
    { _id: notificationId, user: userId },
    { isRead: true },
    { new: true }
  );
};

// Static method to mark all notifications as read for a user
notificationSchema.statics.markAllAsRead = async function(userId) {
  return await this.updateMany(
    { user: userId, isRead: false },
    { isRead: true }
  );
};

// Static method to get user notifications with pagination
notificationSchema.statics.getUserNotifications = async function(userId, options = {}) {
  const {
    page = 1,
    limit = 20,
    unreadOnly = false,
    type = null
  } = options;

  const query = { user: userId };
  
  if (unreadOnly) {
    query.isRead = false;
  }
  
  if (type) {
    query.type = type;
  }

  const skip = (page - 1) * limit;

  const notifications = await this.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('relatedTradeLog', 'stock direction quantity entryPrice')
    .lean();

  const total = await this.countDocuments(query);
  const unreadCount = await this.countDocuments({ user: userId, isRead: false });

  return {
    notifications,
    pagination: {
      total,
      page,
      pages: Math.ceil(total / limit),
      hasNext: page < Math.ceil(total / limit),
      hasPrev: page > 1
    },
    unreadCount
  };
};

// Instance method to format notification for API response
notificationSchema.methods.toAPIResponse = function() {
  return {
    id: this._id,
    title: this.title,
    message: this.message,
    type: this.type,
    isRead: this.isRead,
    relatedTradeLog: this.relatedTradeLog,
    relatedStock: this.relatedStock,
    metadata: this.metadata,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

const Notification = mongoose.model('Notification', notificationSchema);
export default Notification;