import mongoose from "mongoose";

/**
 * MarketSentiment schema
 * Stores daily market outlook for indices (Nifty 50, Bank Nifty, etc.)
 */
const marketSentimentSchema = new mongoose.Schema({
  // Index identification
  index_name: {
    type: String,
    required: true,
    enum: ['NIFTY_50', 'BANK_NIFTY', 'NIFTY_IT', 'NIFTY_MIDCAP']
  },

  // Sentiment analysis
  sentiment: {
    type: String,
    enum: ['BULLISH', 'NEUTRAL', 'BEARISH'],
    required: true
  },

  // Confidence level (0-1)
  confidence: {
    type: Number,
    min: 0,
    max: 1,
    default: 0.5
  },

  // Key factors driving the sentiment
  key_factors: [{
    factor: String,
    impact: {
      type: String,
      enum: ['POSITIVE', 'NEGATIVE', 'NEUTRAL']
    }
  }],

  // Summary text (AI-generated)
  summary: { type: String },

  // Technical levels (optional)
  levels: {
    support_1: Number,
    support_2: Number,
    resistance_1: Number,
    resistance_2: Number,
    pivot: Number
  },

  // Global market cues
  global_cues: {
    us_markets: {
      type: String,
      enum: ['POSITIVE', 'NEGATIVE', 'MIXED', 'FLAT']
    },
    asian_markets: {
      type: String,
      enum: ['POSITIVE', 'NEGATIVE', 'MIXED', 'FLAT']
    },
    dollar_index: {
      type: String,
      enum: ['STRONG', 'WEAK', 'STABLE']
    },
    crude_oil: {
      type: String,
      enum: ['UP', 'DOWN', 'STABLE']
    }
  },

  // SGX/GIFT Nifty pre-market indication
  sgx_nifty: {
    indication: String, // e.g., "+0.5%", "-0.3%"
    status: {
      type: String,
      enum: ['POSITIVE', 'NEGATIVE', 'FLAT']
    },
    points: Number // optional, actual points difference
  },

  // Sector-wise sentiment
  sectors: {
    IT: {
      sentiment: { type: String, enum: ['BULLISH', 'NEUTRAL', 'BEARISH'] },
      reason: String
    },
    PHARMA: {
      sentiment: { type: String, enum: ['BULLISH', 'NEUTRAL', 'BEARISH'] },
      reason: String
    },
    AUTO: {
      sentiment: { type: String, enum: ['BULLISH', 'NEUTRAL', 'BEARISH'] },
      reason: String
    },
    METAL: {
      sentiment: { type: String, enum: ['BULLISH', 'NEUTRAL', 'BEARISH'] },
      reason: String
    },
    BANKING: {
      sentiment: { type: String, enum: ['BULLISH', 'NEUTRAL', 'BEARISH'] },
      reason: String
    },
    REALTY: {
      sentiment: { type: String, enum: ['BULLISH', 'NEUTRAL', 'BEARISH'] },
      reason: String
    }
  },

  // FII/DII data (if available)
  institutional_activity: {
    fii_trend: {
      type: String,
      enum: ['BUYING', 'SELLING', 'NEUTRAL']
    },
    dii_trend: {
      type: String,
      enum: ['BUYING', 'SELLING', 'NEUTRAL']
    },
    fii_value_cr: Number, // FII value in crores
    dii_value_cr: Number  // DII value in crores
  },

  // Source info
  source: {
    name: { type: String, default: 'Web Search' },
    scraped_at: { type: Date, default: Date.now }
  },

  // Scraper metadata
  scrape_run_id: { type: String, required: true },

  // Date of analysis (IST date as UTC midnight)
  analysis_date: { type: Date, required: true, index: true }

}, { timestamps: true });

// Compound index: unique per index per day
marketSentimentSchema.index({ analysis_date: -1, index_name: 1 }, { unique: true });

/**
 * Get IST date as UTC midnight (for consistent date queries)
 */
marketSentimentSchema.statics.getISTDateAsUTC = function(date = new Date()) {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffset);
  const year = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth();
  const day = istDate.getUTCDate();
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
};

/**
 * Get today's market sentiment for an index
 */
marketSentimentSchema.statics.getTodaySentiment = async function(indexName = 'NIFTY_50') {
  const today = this.getISTDateAsUTC();
  return this.findOne({ analysis_date: today, index_name: indexName });
};

/**
 * Get latest market sentiment (fallback)
 */
marketSentimentSchema.statics.getLatestSentiment = async function(indexName = 'NIFTY_50') {
  return this.findOne({ index_name: indexName }).sort({ analysis_date: -1 });
};

/**
 * Get today's or latest sentiment
 */
marketSentimentSchema.statics.getTodayOrLatest = async function(indexName = 'NIFTY_50') {
  const today = await this.getTodaySentiment(indexName);
  if (today) return { sentiment: today, is_today: true };

  const latest = await this.getLatestSentiment(indexName);
  return { sentiment: latest, is_today: false };
};

/**
 * Upsert sentiment for today
 */
marketSentimentSchema.statics.upsertTodaySentiment = async function(data) {
  const today = this.getISTDateAsUTC();

  return this.findOneAndUpdate(
    {
      analysis_date: today,
      index_name: data.index_name
    },
    {
      $set: {
        ...data,
        analysis_date: today
      }
    },
    { upsert: true, new: true }
  );
};

const MarketSentiment = mongoose.model("MarketSentiment", marketSentimentSchema);

export default MarketSentiment;
