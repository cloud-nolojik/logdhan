import mongoose from 'mongoose';

const upstoxUserSchema = new mongoose.Schema({
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true
    },
    upstox_user_id: {
        type: String,
        required: false, // Only required after successful OAuth
        index: true
    },
    email: {
        type: String,
        required: false // Only required after successful OAuth
    },
    user_name: {
        type: String,
        required: false // Only required after successful OAuth
    },
    broker: {
        type: String,
        default: 'UPSTOX'
    },
    exchanges: [{
        type: String,
        enum: ['NSE', 'NFO', 'BSE', 'CDS', 'BFO', 'BCD']
    }],
    products: [{
        type: String,
        enum: ['D', 'CO', 'I', 'MTF', 'OCO']
    }],
    order_types: [{
        type: String,
        enum: ['MARKET', 'LIMIT', 'SL', 'SL-M']
    }],
    user_type: {
        type: String,
        default: 'individual'
    },
    poa: {
        type: Boolean,
        default: false
    },
    is_active: {
        type: Boolean,
        default: true
    },
    // Encrypted access token (expires daily at 3:30 AM)
    access_token: {
        type: String,
        required: false // Will be null until user connects
    },
    // Encrypted extended token (for read-only access)
    extended_token: {
        type: String,
        required: false
    },
    token_expires_at: {
        type: Date,
        required: false
    },
    // Auth state for security validation
    auth_state: {
        type: String,
        required: false
    },
    // Connection status
    connection_status: {
        type: String,
        enum: ['pending', 'connected', 'disconnected', 'expired'],
        default: 'pending'
    },
    connected_at: {
        type: Date,
        required: false
    },
    last_order_at: {
        type: Date,
        required: false
    },
    // Order statistics
    total_orders: {
        type: Number,
        default: 0
    },
    successful_orders: {
        type: Number,
        default: 0
    },
    failed_orders: {
        type: Number,
        default: 0
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

// Update the updated_at field on save
upstoxUserSchema.pre('save', function(next) {
    this.updated_at = new Date();
    
    // Validate required fields for connected users
    if (this.connection_status === 'connected') {
        if (!this.upstox_user_id || !this.email || !this.user_name) {
            const error = new Error('upstox_user_id, email, and user_name are required for connected users');
            error.name = 'ValidationError';
            return next(error);
        }
    }
    
    next();
});

// Static methods
upstoxUserSchema.statics.findByUserId = function(userId) {
    return this.findOne({ user_id: userId });
};

upstoxUserSchema.statics.findByUpstoxUserId = function(upstoxUserId) {
    return this.findOne({ upstox_user_id: upstoxUserId });
};

upstoxUserSchema.statics.findConnectedUsers = function() {
    return this.find({ 
        connection_status: 'connected',
        token_expires_at: { $gt: new Date() }
    });
};

// Instance methods
upstoxUserSchema.methods.isTokenValid = function() {
    return this.access_token && 
           this.token_expires_at && 
           this.token_expires_at > new Date() &&
           this.connection_status === 'connected';
};

upstoxUserSchema.methods.updateOrderStats = function(success = true) {
    this.total_orders += 1;
    if (success) {
        this.successful_orders += 1;
    } else {
        this.failed_orders += 1;
    }
    this.last_order_at = new Date();
    return this.save();
};

upstoxUserSchema.methods.disconnect = function() {
    this.connection_status = 'disconnected';
    this.access_token = null;
    this.extended_token = null;
    this.token_expires_at = null;
    this.auth_state = null;
    return this.save();
};

const UpstoxUser = mongoose.model('UpstoxUser', upstoxUserSchema);

export default UpstoxUser;