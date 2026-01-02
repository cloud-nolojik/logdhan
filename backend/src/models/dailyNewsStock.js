import mongoose from "mongoose";
import crypto from "crypto";

/**
 * News item schema for individual headlines
 */
const newsItemSchema = new mongoose.Schema({
  headline: { type: String, required: true },
  headline_hash: { type: String, required: true },  // SHA256 for deduplication & caching
  category: {
    type: String,
    enum: ['PRE_MARKET_NEWS', 'STOCKS_TO_WATCH'],
    required: true
  },
  sentiment: {
    type: String,
    enum: ['BULLISH', 'NEUTRAL', 'BEARISH'],
    default: null
  },
  impact: {
    type: String,
    enum: ['HIGH', 'MEDIUM', 'LOW'],
    default: null
  },
  sentiment_reason: { type: String }
}, { _id: true });

/**
 * DailyNewsStock schema
 * Stores stocks mentioned in daily news with AI-analyzed sentiment
 */
const dailyNewsStockSchema = new mongoose.Schema({
  // Stock identification
  instrument_key: { type: String, default: null },  // Upstox key (null if unmapped)
  symbol: { type: String, required: true },
  company_name: { type: String },

  // Source info (TOP-LEVEL, not repeated in each item)
  source: {
    name: { type: String, default: 'StreetGains' },
    url: { type: String },
    scraped_at: { type: Date, default: Date.now }
  },

  // Scraper metadata (for debugging layout changes)
  scrape_run_id: { type: String, required: true },  // UUID for this scrape run
  scrape_version: { type: String, default: 'v1-dom-parser' },

  // News headlines for this stock (merged from all categories)
  news_items: [newsItemSchema],

  // Aggregate sentiment (dominant across all headlines)
  aggregate_sentiment: {
    type: String,
    enum: ['BULLISH', 'NEUTRAL', 'BEARISH'],
    default: null
  },
  aggregate_impact: {
    type: String,
    enum: ['HIGH', 'MEDIUM', 'LOW'],
    default: null
  },

  // Confidence score (0-1)
  confidence_score: { type: Number, min: 0, max: 1, default: null },

  // Date of scrape (IST date as UTC midnight)
  scrape_date: { type: Date, required: true, index: true },

  // Reference to intraday analysis (if generated)
  intraday_analysis_id: { type: mongoose.Schema.Types.ObjectId, ref: 'StockAnalysis' }

}, { timestamps: true });

// Compound index: unique per stock per day
dailyNewsStockSchema.index({ scrape_date: -1, symbol: 1 }, { unique: true });
dailyNewsStockSchema.index({ scrape_run_id: 1 });
dailyNewsStockSchema.index({ instrument_key: 1, scrape_date: -1 });

/**
 * Generate SHA256 hash for headline (for deduplication & caching)
 */
dailyNewsStockSchema.statics.generateHeadlineHash = function(headline) {
  const normalized = headline.trim().toLowerCase().replace(/\s+/g, ' ');
  return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 16);
};

/**
 * Get IST date as UTC midnight (for consistent date queries)
 * @param {Date} date - Optional date, defaults to now
 * @returns {Date} - Midnight UTC representing IST date
 */
dailyNewsStockSchema.statics.getISTDateAsUTC = function(date = new Date()) {
  // IST is UTC+5:30
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffset);

  // Get just the date part in IST
  const year = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth();
  const day = istDate.getUTCDate();

  // Return as UTC midnight
  return new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
};

/**
 * Get today's news stocks
 */
dailyNewsStockSchema.statics.getTodayStocks = async function() {
  const today = this.getISTDateAsUTC();
  return this.find({ scrape_date: today }).sort({ confidence_score: -1 });
};

/**
 * Get latest scrape data (fallback for weekends/holidays)
 */
dailyNewsStockSchema.statics.getLatestScrapeData = async function() {
  // Find most recent scrape date
  const latest = await this.findOne({}).sort({ scrape_date: -1 });
  if (!latest) return [];

  return this.find({ scrape_date: latest.scrape_date }).sort({ confidence_score: -1 });
};

/**
 * Get or get latest stocks (today's or fallback)
 */
dailyNewsStockSchema.statics.getTodayOrLatest = async function() {
  const todayStocks = await this.getTodayStocks();
  if (todayStocks.length > 0) {
    return { stocks: todayStocks, is_today: true };
  }

  const latestStocks = await this.getLatestScrapeData();
  return { stocks: latestStocks, is_today: false };
};

/**
 * Upsert stock for today (add or update)
 */
dailyNewsStockSchema.statics.upsertTodayStock = async function(stockData) {
  const today = this.getISTDateAsUTC();

  return this.findOneAndUpdate(
    {
      scrape_date: today,
      symbol: stockData.symbol
    },
    {
      $set: {
        ...stockData,
        scrape_date: today
      }
    },
    { upsert: true, new: true }
  );
};

/**
 * Calculate confidence score from headlines
 */
dailyNewsStockSchema.statics.calculateConfidenceScore = function(headlines) {
  if (!headlines || headlines.length === 0) return 0.5;

  let score = 0.5; // Base score

  // Impact boost
  const highImpactCount = headlines.filter(h => h.impact === 'HIGH').length;
  score += highImpactCount * 0.15; // +0.15 per HIGH impact headline

  // Consistency boost (all headlines same sentiment)
  const sentiments = headlines.map(h => h.sentiment).filter(Boolean);
  if (sentiments.length > 0) {
    const allSame = sentiments.every(s => s === sentiments[0]);
    if (allSame && headlines.length > 1) {
      score += 0.2; // +0.2 for consistent sentiment across multiple headlines
    }

    // Mixed sentiment penalty
    const hasBullish = sentiments.includes('BULLISH');
    const hasBearish = sentiments.includes('BEARISH');
    if (hasBullish && hasBearish) {
      score -= 0.3; // -0.3 for conflicting signals
    }
  }

  // Clamp to 0-1
  return Math.max(0, Math.min(1, score));
};

/**
 * Calculate aggregate sentiment from headlines
 */
dailyNewsStockSchema.statics.calculateAggregateSentiment = function(headlines) {
  if (!headlines || headlines.length === 0) return { sentiment: null, impact: null };

  const sentiments = headlines.map(h => h.sentiment).filter(Boolean);
  const impacts = headlines.map(h => h.impact).filter(Boolean);

  if (sentiments.length === 0) return { sentiment: null, impact: null };

  // Count sentiments
  const counts = { BULLISH: 0, NEUTRAL: 0, BEARISH: 0 };
  sentiments.forEach(s => counts[s]++);

  // Get dominant sentiment
  let dominant = 'NEUTRAL';
  if (counts.BULLISH > counts.BEARISH && counts.BULLISH >= counts.NEUTRAL) {
    dominant = 'BULLISH';
  } else if (counts.BEARISH > counts.BULLISH && counts.BEARISH >= counts.NEUTRAL) {
    dominant = 'BEARISH';
  }

  // Get highest impact
  let highestImpact = 'LOW';
  if (impacts.includes('HIGH')) highestImpact = 'HIGH';
  else if (impacts.includes('MEDIUM')) highestImpact = 'MEDIUM';

  return { sentiment: dominant, impact: highestImpact };
};

/**
 * Link intraday analysis to stock
 */
dailyNewsStockSchema.statics.linkAnalysis = async function(symbol, scrapeDate, analysisId) {
  return this.findOneAndUpdate(
    { symbol, scrape_date: scrapeDate },
    { $set: { intraday_analysis_id: analysisId } },
    { new: true }
  );
};

const DailyNewsStock = mongoose.model("DailyNewsStock", dailyNewsStockSchema);

export default DailyNewsStock;
