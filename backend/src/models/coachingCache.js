/**
 * Coaching Cache Model
 *
 * Stores AI coaching results (Trail Protection, Trade Check) for 1 hour
 * to reduce OpenAI API costs.
 *
 * Cache key: position_id + type + hour
 * TTL: 1 hour (auto-expires via MongoDB TTL index)
 */

import mongoose from 'mongoose';

const coachingCacheSchema = new mongoose.Schema({
  // Cache key components
  position_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserPosition',
    required: true,
    index: true
  },
  cache_type: {
    type: String,
    enum: ['trail_check', 'exit_coach'],
    required: true
  },
  cache_hour: {
    type: String,  // Format: "YYYY-MM-DD-HH" (e.g., "2025-12-28-14")
    required: true
  },

  // Cached response data
  response_data: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },

  // Market context at cache time (for reference)
  market_context: {
    current_price: Number,
    rsi: Number,
    ema20: Number,
    atr: Number
  },

  // Metadata
  created_at: {
    type: Date,
    default: Date.now,
    expires: 3600  // TTL: 1 hour (3600 seconds) - MongoDB auto-deletes
  },
  hit_count: {
    type: Number,
    default: 0
  }
});

// Compound index for fast lookup
coachingCacheSchema.index({ position_id: 1, cache_type: 1, cache_hour: 1 }, { unique: true });

// TTL index for auto-expiration
coachingCacheSchema.index({ created_at: 1 }, { expireAfterSeconds: 3600 });

/**
 * Get current cache hour string
 * Format: YYYY-MM-DD-HH in IST
 */
coachingCacheSchema.statics.getCurrentHour = function() {
  const now = new Date();
  // Convert to IST (UTC+5:30)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset);

  const year = istDate.getUTCFullYear();
  const month = String(istDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(istDate.getUTCDate()).padStart(2, '0');
  const hour = String(istDate.getUTCHours()).padStart(2, '0');

  return `${year}-${month}-${day}-${hour}`;
};

/**
 * Get cached coaching result
 * @param {String} positionId - Position ID
 * @param {String} cacheType - 'trail_check' or 'exit_coach'
 * @returns {Object|null} Cached response or null
 */
coachingCacheSchema.statics.getCached = async function(positionId, cacheType) {
  const cacheHour = this.getCurrentHour();

  const cached = await this.findOneAndUpdate(
    {
      position_id: positionId,
      cache_type: cacheType,
      cache_hour: cacheHour
    },
    { $inc: { hit_count: 1 } },
    { new: true }
  );

  if (cached) {
    console.log(`[CACHE HIT] ${cacheType} for position ${positionId} (hits: ${cached.hit_count})`);
    return cached.response_data;
  }

  console.log(`[CACHE MISS] ${cacheType} for position ${positionId}`);
  return null;
};

/**
 * Store coaching result in cache
 * @param {String} positionId - Position ID
 * @param {String} cacheType - 'trail_check' or 'exit_coach'
 * @param {Object} responseData - The AI response to cache
 * @param {Object} marketContext - Current market data for reference
 */
coachingCacheSchema.statics.setCache = async function(positionId, cacheType, responseData, marketContext = {}) {
  const cacheHour = this.getCurrentHour();

  try {
    await this.findOneAndUpdate(
      {
        position_id: positionId,
        cache_type: cacheType,
        cache_hour: cacheHour
      },
      {
        response_data: responseData,
        market_context: marketContext,
        created_at: new Date(),
        hit_count: 0
      },
      { upsert: true, new: true }
    );

    console.log(`[CACHE SET] ${cacheType} for position ${positionId} (hour: ${cacheHour})`);
  } catch (error) {
    // Ignore duplicate key errors (race condition)
    if (error.code !== 11000) {
      console.error(`[CACHE ERROR] Failed to cache ${cacheType}:`, error.message);
    }
  }
};

/**
 * Clear cache for a position (e.g., when SL is updated)
 */
coachingCacheSchema.statics.clearForPosition = async function(positionId) {
  const result = await this.deleteMany({ position_id: positionId });
  console.log(`[CACHE CLEAR] Cleared ${result.deletedCount} entries for position ${positionId}`);
};

/**
 * Get cache stats
 */
coachingCacheSchema.statics.getStats = async function() {
  const total = await this.countDocuments();
  const byType = await this.aggregate([
    { $group: { _id: '$cache_type', count: { $sum: 1 }, totalHits: { $sum: '$hit_count' } } }
  ]);

  return {
    total_cached: total,
    by_type: byType
  };
};

const CoachingCache = mongoose.model('CoachingCache', coachingCacheSchema);

export default CoachingCache;
