import mongoose from 'mongoose';

// Cache completed AI analyses to avoid duplicate work
const aiAnalysisCacheSchema = new mongoose.Schema({
    cache_key: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    instrument_key: {
        type: String,
        required: true,
        index: true
    },
    stock_symbol: {
        type: String,
        required: true
    },
    analysis_type: {
        type: String,
        required: true,
        enum: ['swing', 'intraday'],
        default: 'swing'
    },
    trading_date: {
        type: Date,
        required: true,
        index: true
    },
    analysis_result: {
        type: mongoose.Schema.Types.Mixed, // Full AI analysis response
        required: true
    },
    ai_request_payload: {
        type: mongoose.Schema.Types.Mixed, // What we sent to AI for debugging
        required: true
    },
    market_data_used: {
        type: mongoose.Schema.Types.Mixed, // Market data snapshot used
        required: true
    },
    current_price: {
        type: Number,
        required: true
    },
    generated_at: {
        type: Date,
        default: Date.now,
        index: true
    },
    expires_at: {
        type: Date,
        required: true,
        index: true
    },
    usage_count: {
        type: Number,
        default: 0
    },
    last_accessed: {
        type: Date,
        default: Date.now
    },
    users_served: [{
        user_id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        accessed_at: {
            type: Date,
            default: Date.now
        }
    }],
    cache_stats: {
        generation_time_ms: Number,
        ai_model_used: String,
        data_sources: [String], // ['prefetched', 'live', 'mixed']
        cache_hit_rate: Number
    }
});

// Compound indexes for efficient queries
aiAnalysisCacheSchema.index({ 
    instrument_key: 1, 
    analysis_type: 1, 
    trading_date: 1 
});

aiAnalysisCacheSchema.index({ expires_at: 1 });

// TTL index to auto-delete expired analyses
aiAnalysisCacheSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

// Static methods
aiAnalysisCacheSchema.statics.generateCacheKey = function(instrumentKey, analysisType, tradingDate) {
    const dateStr = tradingDate.toISOString().split('T')[0];
    return `${instrumentKey}_${analysisType}_${dateStr}`;
};

aiAnalysisCacheSchema.statics.getCachedAnalysis = async function(instrumentKey, analysisType, tradingDate, userId) {
    const cacheKey = this.generateCacheKey(instrumentKey, analysisType, tradingDate);
    
    const cached = await this.findOne({
        cache_key: cacheKey,
        expires_at: { $gt: new Date() }
    });
    
    if (cached) {
        // Update usage stats
        cached.usage_count += 1;
        cached.last_accessed = new Date();
        
        // Track user access
        const existingUser = cached.users_served.find(u => u.user_id.toString() === userId.toString());
        if (!existingUser) {
            cached.users_served.push({
                user_id: userId,
                accessed_at: new Date()
            });
        }
        
        await cached.save();
        
        console.log(`📦 [CACHE HIT] Served cached analysis for ${instrumentKey}, usage count: ${cached.usage_count}`);
        return cached;
    }
    
    console.log(`❌ [CACHE MISS] No valid cache for ${instrumentKey}_${analysisType}_${tradingDate.toDateString()}`);
    return null;
};

aiAnalysisCacheSchema.statics.storeAnalysis = async function(
    instrumentKey, 
    stockSymbol,
    analysisType, 
    tradingDate, 
    analysisResult, 
    aiRequestPayload, 
    marketDataUsed, 
    currentPrice,
    expiresAt,
    generationTimeMs = null,
    aiModel = null
) {
    const cacheKey = this.generateCacheKey(instrumentKey, analysisType, tradingDate);
    
    try {
        const cacheEntry = new this({
            cache_key: cacheKey,
            instrument_key: instrumentKey,
            stock_symbol: stockSymbol,
            analysis_type: analysisType,
            trading_date: tradingDate,
            analysis_result: analysisResult,
            ai_request_payload: aiRequestPayload,
            market_data_used: marketDataUsed,
            current_price: currentPrice,
            expires_at: expiresAt,
            cache_stats: {
                generation_time_ms: generationTimeMs,
                ai_model_used: aiModel,
                data_sources: marketDataUsed.sources || ['unknown']
            }
        });
        
        await cacheEntry.save();
        console.log(`💾 [CACHE STORE] Stored analysis for ${instrumentKey}, expires: ${expiresAt.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'})}`);
        
        return cacheEntry;
    } catch (error) {
        if (error.code === 11000) { // Duplicate key
            console.log(`⚠️ [CACHE] Analysis already cached for ${cacheKey}`);
            return null;
        }
        throw error;
    }
};

aiAnalysisCacheSchema.statics.getCacheStats = function(tradingDate) {
    return this.aggregate([
        { $match: { trading_date: tradingDate } },
        {
            $group: {
                _id: '$analysis_type',
                total_cached: { $sum: 1 },
                total_usage: { $sum: '$usage_count' },
                unique_users: { $sum: { $size: '$users_served' } },
                avg_generation_time: { $avg: '$cache_stats.generation_time_ms' }
            }
        }
    ]);
};

aiAnalysisCacheSchema.statics.cleanupExpired = function() {
    return this.deleteMany({ expires_at: { $lt: new Date() } });
};

const AIAnalysisCache = mongoose.model('AIAnalysisCache', aiAnalysisCacheSchema);

export default AIAnalysisCache;