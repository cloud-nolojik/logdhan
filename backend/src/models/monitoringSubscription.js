import mongoose from 'mongoose';
import MarketHoursUtil from '../utils/marketHours.js';

/**
 * MonitoringSubscription Model
 * Tracks multi-user subscriptions to stock monitoring jobs
 * Enables shared monitoring where multiple users monitor same stock without duplicate jobs
 */
const monitoringSubscriptionSchema = new mongoose.Schema({
    analysis_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StockAnalysis',
        required: true,
        index: true
    },
    strategy_id: {
        type: String,
        required: true,
        index: true
    },
    stock_symbol: {
        type: String,
        required: true,
        index: true
    },
    instrument_key: {
        type: String,
        required: true,
        index: true
    },

    // Array of users subscribed to this monitoring job
    subscribed_users: [{
        user_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        subscribed_at: {
            type: Date,
            default: Date.now
        },
        // Tracks when user acknowledged/viewed the notification
        acknowledged_at: {
            type: Date,
            default: null
        },
        notification_preferences: {
            whatsapp: {
                type: Boolean,
                default: true
            },
            email: {
                type: Boolean,
                default: false
            }
        }
    }],

    // Reference to the Agenda job ID
    job_id: {
        type: String,
        required: true,
        unique: true
    },

    // Monitoring status
    monitoring_status: {
        type: String,
        enum: ['active', 'conditions_met', 'expired', 'invalidated', 'cancelled'],
        default: 'active',
        required: true,
        index: true
    },

    // Snapshot of exact market data when conditions were met
    // This preserves proof context for disputes and audit trails
    last_trigger_snapshot: {
        price: Number,
        timestamp: Date,
        // Exact timeframe data used for trigger evaluation
        timeframe_data: {
            '1min': mongoose.Schema.Types.Mixed,
            '5min': mongoose.Schema.Types.Mixed,
            '15min': mongoose.Schema.Types.Mixed,
            'daily': mongoose.Schema.Types.Mixed
        },
        // All triggers that were evaluated
        evaluated_triggers: [{
            trigger_type: String,
            condition: String,
            met: Boolean,
            actual_value: mongoose.Schema.Types.Mixed,
            expected_value: mongoose.Schema.Types.Mixed
        }],
        // Additional context
        market_conditions: {
            trend: String,
            volatility: String,
            volume_profile: String
        },
        snapshot_timestamp: Date
    },

    // Timestamp when trigger conditions were met
    conditions_met_at: {
        type: Date,
        default: null
    },

    // Timestamp when notifications were sent to users
    notification_sent_at: {
        type: Date,
        default: null
    },

    // Timestamp when monitoring was stopped
    stopped_at: {
        type: Date,
        default: null
    },

    // Reason for stopping
    stop_reason: {
        type: String,
        enum: ['conditions_met', 'market_closed', 'user_cancelled', 'invalidation', 'expired', null],
        default: null
    },

    // Expiry time - SAME day 3:30 PM IST (not next day)
    expires_at: {
        type: Date,
        required: true,
        index: true
    },

    // Monitoring configuration
    monitoring_config: {
        frequency_seconds: {
            type: Number,
            default: 60
        },
        timeframes: {
            type: [String],
            default: ['1min', '5min', '15min', 'daily']
        }
    }
}, {
    timestamps: true, // Adds createdAt and updatedAt
    collection: 'monitoring_subscriptions'
});

// Compound Indexes

// Unique constraint: One subscription per analysis+strategy combination
monitoringSubscriptionSchema.index({
    analysis_id: 1,
    strategy_id: 1
}, {
    unique: true
});

// Find all subscriptions for a specific user
monitoringSubscriptionSchema.index({
    'subscribed_users.user_id': 1,
    monitoring_status: 1
});

// Find active subscriptions
monitoringSubscriptionSchema.index({
    monitoring_status: 1,
    expires_at: 1
});

// TTL index - Auto-delete expired subscriptions
monitoringSubscriptionSchema.index({
    expires_at: 1
}, {
    expireAfterSeconds: 0
});

// Query by stock symbol
monitoringSubscriptionSchema.index({
    stock_symbol: 1,
    monitoring_status: 1
});

// Static Methods

/**
 * Calculate expiry time using common utility
 * ALL subscriptions expire at 3:14:59 PM IST on NEXT trading day
 * Stored in DB as UTC (09:44:59 AM UTC)
 */
monitoringSubscriptionSchema.statics.getExpiryTime = async function() {
    return await MarketHoursUtil.getMonitoringExpiryTime();
};

/**
 * Find or create subscription for analysis+strategy
 * Returns existing subscription if found, creates new one if not
 */
monitoringSubscriptionSchema.statics.findOrCreateSubscription = async function(
    analysisId,
    strategyId,
    userId,
    stockSymbol,
    instrumentKey,
    jobId,
    monitoringConfig = {}
) {
    try {
        console.log(`🔍 [SUBSCRIPTION] Looking for existing subscription: analysis=${analysisId}, strategy=${strategyId}`);

        // Check if subscription already exists
        let subscription = await this.findOne({
            analysis_id: analysisId,
            strategy_id: strategyId
        });

        if (subscription) {
            console.log(`✅ [SUBSCRIPTION] Found existing subscription: ${subscription._id}`);

            // Check if conditions were already met
            if (subscription.monitoring_status === 'conditions_met') {
                const timeSinceConditionsMet = Date.now() - subscription.conditions_met_at.getTime();
                const minutesSince = Math.floor(timeSinceConditionsMet / 60000);

                // Block if conditions met more than 45 minutes ago
                if (minutesSince > 45) {
                    throw new Error(`Entry conditions were met ${minutesSince} minutes ago. Market setup may have changed. Please generate fresh analysis after 4:30 PM.`);
                }
            }

            // Check if user is already subscribed
            const isUserSubscribed = subscription.subscribed_users.some(
                sub => sub.user_id.toString() === userId.toString()
            );

            if (isUserSubscribed) {
                console.log(`ℹ️ [SUBSCRIPTION] User ${userId} already subscribed`);
                return subscription;
            }

            // Add user to existing subscription
            subscription.subscribed_users.push({
                user_id: userId,
                subscribed_at: new Date(),
                notification_preferences: monitoringConfig.notification_preferences || {
                    whatsapp: true,
                    email: false
                }
            });

            await subscription.save();
            console.log(`✅ [SUBSCRIPTION] Added user ${userId} to existing subscription`);

            return subscription;
        }

        // Create new subscription
        console.log(`🆕 [SUBSCRIPTION] Creating new subscription for analysis=${analysisId}, strategy=${strategyId}`);

        const expiryTime = await this.getExpiryTime();

        subscription = await this.create({
            analysis_id: analysisId,
            strategy_id: strategyId,
            stock_symbol: stockSymbol,
            instrument_key: instrumentKey,
            job_id: jobId,
            subscribed_users: [{
                user_id: userId,
                subscribed_at: new Date(),
                notification_preferences: monitoringConfig.notification_preferences || {
                    whatsapp: true,
                    email: false
                }
            }],
            expires_at: expiryTime,
            monitoring_config: {
                frequency_seconds: monitoringConfig.frequency_seconds || 60,
                timeframes: monitoringConfig.timeframes || ['1min', '5min', '15min', 'daily']
            }
        });

        console.log(`✅ [SUBSCRIPTION] Created new subscription: ${subscription._id}`);
        return subscription;

    } catch (error) {
        console.error('❌ [SUBSCRIPTION] Error in findOrCreateSubscription:', error);
        throw error;
    }
};

/**
 * Get active subscription for analysis+strategy
 */
monitoringSubscriptionSchema.statics.getActiveSubscription = async function(analysisId, strategyId) {
    return await this.findOne({
        analysis_id: analysisId,
        strategy_id: strategyId,
        monitoring_status: 'active',
        expires_at: { $gt: new Date() }
    });
};

/**
 * Get all subscriptions for a user
 */
monitoringSubscriptionSchema.statics.getUserSubscriptions = async function(userId, status = null) {
    const query = {
        'subscribed_users.user_id': userId
    };

    if (status) {
        query.monitoring_status = status;
    }

    return await this.find(query)
        .sort({ createdAt: -1 })
        .populate('analysis_id', 'stock_symbol analysis_type generated_at_ist')
        .lean();
};

/**
 * Check if user can start monitoring (not already met conditions recently)
 */
monitoringSubscriptionSchema.statics.canUserStartMonitoring = async function(analysisId, strategyId) {
    const subscription = await this.findOne({
        analysis_id: analysisId,
        strategy_id: strategyId
    });

    if (!subscription) {
        return {
            can_start: true,
            reason: null
        };
    }

    if (subscription.monitoring_status === 'conditions_met') {
        const timeSinceConditionsMet = Date.now() - subscription.conditions_met_at.getTime();
        const minutesSince = Math.floor(timeSinceConditionsMet / 60000);

        if (minutesSince > 45) {
            return {
                can_start: false,
                reason: `Entry conditions were met ${minutesSince} minutes ago. Market setup may have changed. Please generate fresh analysis after 4:30 PM.`,
                conditions_met_at: subscription.conditions_met_at
            };
        }
    }

    return {
        can_start: true,
        reason: null,
        existing_subscription: subscription
    };
};

// Instance Methods

/**
 * Add user to subscription
 */
monitoringSubscriptionSchema.methods.addUser = async function(userId, notificationPreferences = {}) {
    const isUserSubscribed = this.subscribed_users.some(
        sub => sub.user_id.toString() === userId.toString()
    );

    if (isUserSubscribed) {
        console.log(`ℹ️ [SUBSCRIPTION] User ${userId} already subscribed to ${this._id}`);
        return this;
    }

    this.subscribed_users.push({
        user_id: userId,
        subscribed_at: new Date(),
        notification_preferences: {
            whatsapp: notificationPreferences.whatsapp !== undefined ? notificationPreferences.whatsapp : true,
            email: notificationPreferences.email !== undefined ? notificationPreferences.email : false
        }
    });

    return await this.save();
};

/**
 * Remove user from subscription
 */
monitoringSubscriptionSchema.methods.removeUser = async function(userId) {
    this.subscribed_users = this.subscribed_users.filter(
        sub => sub.user_id.toString() !== userId.toString()
    );

    // If no users left, remove the entire subscription document
    if (this.subscribed_users.length === 0) {
        console.log(`🗑️ [SUBSCRIPTION] No users left - removing subscription document ${this._id}`);
        await this.deleteOne();
        return null; // Document deleted
    }

    return await this.save();
};

/**
 * Mark conditions as met and save trigger snapshot
 */
monitoringSubscriptionSchema.methods.markConditionsMet = async function(triggerSnapshot) {
    this.monitoring_status = 'conditions_met';
    this.conditions_met_at = new Date();
    this.last_trigger_snapshot = {
        ...triggerSnapshot,
        snapshot_timestamp: new Date()
    };

    return await this.save();
};

/**
 * Mark notification as sent
 */
monitoringSubscriptionSchema.methods.markNotificationSent = async function() {
    this.notification_sent_at = new Date();
    return await this.save();
};

/**
 * Mark monitoring as stopped
 */
monitoringSubscriptionSchema.methods.stopMonitoring = async function(reason = 'conditions_met') {
    this.stopped_at = new Date();
    this.stop_reason = reason;

    if (this.monitoring_status === 'active') {
        this.monitoring_status = reason === 'conditions_met' ? 'conditions_met' : 'cancelled';
    }

    return await this.save();
};

/**
 * Mark user acknowledgement
 */
monitoringSubscriptionSchema.methods.markUserAcknowledged = async function(userId) {
    const user = this.subscribed_users.find(
        sub => sub.user_id.toString() === userId.toString()
    );

    if (user && !user.acknowledged_at) {
        user.acknowledged_at = new Date();
        return await this.save();
    }

    return this;
};

/**
 * Get unacknowledged users (for follow-up nudges)
 */
monitoringSubscriptionSchema.methods.getUnacknowledgedUsers = function() {
    return this.subscribed_users.filter(sub => !sub.acknowledged_at);
};

const MonitoringSubscription = mongoose.model('MonitoringSubscription', monitoringSubscriptionSchema);

export default MonitoringSubscription;
