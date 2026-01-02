import mongoose from "mongoose";

/**
 * SentimentCache schema
 * Caches AI-analyzed sentiment for headlines to avoid re-analyzing
 * TTL: 30 days auto-delete
 */
const sentimentCacheSchema = new mongoose.Schema({
  // SHA256 hash of normalized headline (first 16 chars)
  headline_hash: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Original headline (for debugging)
  headline: { type: String },

  // AI-analyzed sentiment
  sentiment: {
    type: String,
    enum: ['BULLISH', 'NEUTRAL', 'BEARISH'],
    required: true
  },

  // Impact level
  impact: {
    type: String,
    enum: ['HIGH', 'MEDIUM', 'LOW'],
    required: true
  },

  // AI-generated reason
  reason: { type: String },

  // Metadata
  analyzed_at: { type: Date, default: Date.now },
  model_used: { type: String, default: 'gpt-4o-mini' }

}, { timestamps: true });

// TTL Index - auto-delete after 30 days
sentimentCacheSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 2592000 }  // 30 days in seconds
);

/**
 * Get cached sentiment by headline hash
 */
sentimentCacheSchema.statics.getByHash = async function(hash) {
  return this.findOne({ headline_hash: hash });
};

/**
 * Get multiple cached sentiments by hashes
 */
sentimentCacheSchema.statics.getByHashes = async function(hashes) {
  const results = await this.find({ headline_hash: { $in: hashes } });

  // Return as map for easy lookup
  const cacheMap = {};
  results.forEach(r => {
    cacheMap[r.headline_hash] = {
      sentiment: r.sentiment,
      impact: r.impact,
      reason: r.reason
    };
  });

  return cacheMap;
};

/**
 * Cache a sentiment result
 */
sentimentCacheSchema.statics.cacheSentiment = async function(hash, headline, sentiment, impact, reason, model = 'gpt-4o-mini') {
  return this.findOneAndUpdate(
    { headline_hash: hash },
    {
      $set: {
        headline,
        sentiment,
        impact,
        reason,
        model_used: model,
        analyzed_at: new Date()
      }
    },
    { upsert: true, new: true }
  );
};

/**
 * Bulk cache sentiment results
 */
sentimentCacheSchema.statics.bulkCacheSentiments = async function(items) {
  const operations = items.map(item => ({
    updateOne: {
      filter: { headline_hash: item.hash },
      update: {
        $set: {
          headline: item.headline,
          sentiment: item.sentiment,
          impact: item.impact,
          reason: item.reason,
          model_used: item.model || 'gpt-4o-mini',
          analyzed_at: new Date()
        }
      },
      upsert: true
    }
  }));

  return this.bulkWrite(operations);
};

const SentimentCache = mongoose.model("SentimentCache", sentimentCacheSchema);

export default SentimentCache;
