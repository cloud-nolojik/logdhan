import mongoose from 'mongoose';
import MarketHoursUtil from '../utils/marketHours.js';

const analysisSessionSchema = new mongoose.Schema({
    session_id: {
        type: String,
        required: true,
        unique: true
        // Index removed - using explicit schema.index() below
    },
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
        // Index removed - using explicit schema.index() below
    },
    analysis_type: {
        type: String,
        enum: ['swing', 'intraday', 'long_term'],
        default: 'swing',
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'running', 'paused', 'completed', 'cancelled', 'failed'],
        default: 'pending',
        required: true
    },
    total_stocks: {
        type: Number,
        required: true
    },
    processed_stocks: {
        type: Number,
        default: 0
    },
    successful_stocks: {
        type: Number,
        default: 0
    },
    failed_stocks: {
        type: Number,
        default: 0
    },
    current_stock_index: {
        type: Number,
        default: 0
    },
    current_stock_key: {
        type: String,
        default: null
    },
    started_at: {
        type: Date,
        default: null
    },
    last_updated: {
        type: Date,
        default: Date.now
    },
    completed_at: {
        type: Date,
        default: null
    },
    cancelled_at: {
        type: Date,
        default: null
    },
    timeout_threshold: {
        type: Number,
        default: 10 * 60 * 1000 // 10 minutes in milliseconds
    },
    session_timeout: {
        type: Number,
        default: 15 * 60 * 1000 // 15 minutes in milliseconds
    },
    error_message: {
        type: String,
        default: null
    },
    metadata: {
        watchlist_stocks: [{
            instrument_key: String,
            stock_name: String,
            trading_symbol: String,
            processed: { type: Boolean, default: false },
            processing_started_at: { type: Date, default: null },
            processing_completed_at: { type: Date, default: null },
            error_reason: { type: String, default: null }
        }],
        batch_size: { type: Number, default: 3 },
        estimated_completion_time: Date,
        actual_start_time: Date
    },
    expires_at: {
        type: Date,
        required: true
        // Index with TTL will be added below
    }
}, {
    timestamps: true,
    collection: 'analysis_sessions'
});

// Index for efficient querying
analysisSessionSchema.index({ user_id: 1, status: 1 });
// session_id index not needed - unique constraint already creates one
analysisSessionSchema.index({ last_updated: 1 });

// Auto-delete expired analysis sessions
analysisSessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

// Virtual for progress percentage
analysisSessionSchema.virtual('progress_percentage').get(function() {
    if (this.total_stocks === 0) return 0;
    return Math.round((this.processed_stocks / this.total_stocks) * 100);
});

// Method to check if session is timed out
analysisSessionSchema.methods.isTimedOut = function() {
    if (!this.last_updated) return false;
    const timeSinceUpdate = Date.now() - this.last_updated.getTime();
    return timeSinceUpdate > this.session_timeout;
};

// Method to check if current stock processing is timed out
analysisSessionSchema.methods.isCurrentStockTimedOut = function() {
    if (!this.current_stock_key || this.status !== 'running') return false;
    const currentStock = this.metadata.watchlist_stocks.find(
        stock => stock.instrument_key === this.current_stock_key
    );
    if (!currentStock?.processing_started_at) return false;
    
    const timeSinceStart = Date.now() - currentStock.processing_started_at.getTime();
    return timeSinceStart > this.timeout_threshold;
};

// Method to update session heartbeat with retry logic
analysisSessionSchema.methods.updateHeartbeat = async function(retryCount = 0) {
    const maxRetries = 3;
    
    try {
        // For heartbeat, we can use a simpler update without fetching the full document
        const result = await this.constructor.updateOne(
            { _id: this._id },
            { last_updated: new Date() }
        );
        
        if (result.matchedCount === 0) {
            throw new Error('Session document not found for heartbeat update');
        }
        
        // Update local copy
        this.last_updated = new Date();
        return result;
        
    } catch (error) {
        if (error.name === 'VersionError' && retryCount < maxRetries) {
            //console.log((`🔄 Retrying heartbeat update (attempt ${retryCount + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, 50 * (retryCount + 1)));
            return this.updateHeartbeat(retryCount + 1);
        } else {
            console.error(`❌ Failed to update heartbeat after ${retryCount + 1} attempts:`, error.message);
            throw error;
        }
    }
};

// Method to mark current stock as timed out and move to next
analysisSessionSchema.methods.timeoutCurrentStock = function() {
    if (!this.current_stock_key) return Promise.resolve(this);
    
    const currentStock = this.metadata.watchlist_stocks.find(
        stock => stock.instrument_key === this.current_stock_key
    );
    
    if (currentStock) {
        currentStock.processed = true;
        currentStock.processing_completed_at = new Date();
        currentStock.error_reason = 'Timeout after 2 minutes';
        
        this.failed_stocks += 1;
        this.processed_stocks += 1;
        this.current_stock_index += 1;
        
        // Move to next unprocessed stock
        const nextStock = this.metadata.watchlist_stocks.find(
            stock => !stock.processed && stock.instrument_key !== this.current_stock_key
        );
        
        this.current_stock_key = nextStock?.instrument_key || null;
        this.last_updated = new Date();
    }
    
    return this.save();
};

/**
 * Calculate expiry time using common utility
 * ALL sessions expire at 3:59 PM IST on NEXT trading day
 * Stored in DB as UTC (10:25 AM UTC)
 */
analysisSessionSchema.statics.getExpiryTime = async function() {
    return await MarketHoursUtil.getExpiryTime();
};

// Static method to create new session
analysisSessionSchema.statics.createSession = async function(userId, watchlistStocks, analysisType = 'swing') {
    const sessionId = `session_${userId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Calculate expiry time using the same logic as stock analysis
    const expiryTime = await this.getExpiryTime();
    
    const session = new this({
        session_id: sessionId,
        user_id: userId,
        analysis_type: analysisType,
        total_stocks: watchlistStocks.length,
        expires_at: expiryTime,
        metadata: {
            watchlist_stocks: watchlistStocks.map(stock => ({
                instrument_key: stock.instrument_key,
                stock_name: stock.name,
                trading_symbol: stock.trading_symbol,
                processed: false
            })),
            estimated_completion_time: new Date(Date.now() + (watchlistStocks.length * 1.5 * 60 * 1000)) // 1.5 min per stock
        }
    });
    
    return await session.save();
};

// Static method to find active session for user
analysisSessionSchema.statics.findActiveSession = async function(userId, analysisType = 'swing') {
    console.log(`🔍 [SESSION QUERY] Looking for active session: userId=${userId}, analysisType=${analysisType}`);
    
    try {
        // Convert userId to ObjectId if it's a valid ObjectId string
        let userObjectId;
        if (mongoose.Types.ObjectId.isValid(userId)) {
            userObjectId = mongoose.Types.ObjectId.createFromHexString(userId);
        } else {
            userObjectId = userId; // Use as-is if not a valid ObjectId
        }
        
        const query = {
            user_id: userObjectId,
            analysis_type: analysisType,
            status: { $in: ['pending', 'running', 'paused'] },
            expires_at: { $gt: new Date() }
        };
        
        console.log(`🔍 [SESSION QUERY] Query:`, JSON.stringify(query, null, 2));
        
        const result = await this.findOne(query).sort({ createdAt: -1 });
        
        console.log(`🔍 [SESSION QUERY] Query result: ${result ? `FOUND session ${result.session_id} with status ${result.status}` : 'NO SESSIONS FOUND'}`);
        
        return result;
    } catch (error) {
        console.error(`❌ [SESSION QUERY] Error in findActiveSession:`, error.message);
        return null;
    }
};

// Static method to find resumable session for user (including failed/cancelled with partial progress)
analysisSessionSchema.statics.findResumableSession = async function(userId, analysisType = 'swing') {
    console.log(`🔍 [SESSION QUERY] Looking for resumable session: userId=${userId}, analysisType=${analysisType}`);
    
    try {
        // Convert userId to ObjectId if it's a valid ObjectId string
        let userObjectId;
        if (mongoose.Types.ObjectId.isValid(userId)) {
            userObjectId = mongoose.Types.ObjectId.createFromHexString(userId);
        } else {
            userObjectId = userId; // Use as-is if not a valid ObjectId
        }
        
        const result = await this.findOne({
            user_id: userObjectId,
            analysis_type: analysisType,
            status: { $in: ['pending', 'running', 'paused', 'failed', 'cancelled'] },
            processed_stocks: { $gt: 0 }, // Must have some progress
            expires_at: { $gt: new Date() }, // Not expired
            $expr: { $lt: ['$processed_stocks', '$total_stocks'] } // Not fully completed
        }).sort({ createdAt: -1 });
        
        return result;
    } catch (error) {
        console.error(`❌ [SESSION QUERY] Error in findResumableSession:`, error.message);
        return null;
    }
    // //console.log((`🔍 [SESSION QUERY] Resumable result:`, result ? { 
    //     id: result.session_id, 
    //     status: result.status, 
    //     processed: result.processed_stocks, 
    //     total: result.total_stocks 
    // } : 'null');
    
    return result;
};

// Static method to cleanup timed out sessions
analysisSessionSchema.statics.cleanupTimedOutSessions = async function() {
    const cutoffTime = new Date(Date.now() - (15 * 60 * 1000)); // 15 minutes ago
    
    const result = await this.updateMany(
        {
            status: { $in: ['running', 'paused'] },
            last_updated: { $lt: cutoffTime },
            expires_at: { $gt: new Date() } // Only cleanup non-expired sessions
        },
        {
            status: 'failed',
            error_message: 'Session timed out due to inactivity',
            completed_at: new Date()
        }
    );
    
    return result;
};

const AnalysisSession = mongoose.model('AnalysisSession', analysisSessionSchema);

export default AnalysisSession;