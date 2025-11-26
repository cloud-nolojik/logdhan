import mongoose from 'mongoose';

/**
 * LatestPrice Model
 *
 * Stores the most recent 5-minute candle price for each instrument
 * Updated every 2 minutes by the price cache service
 *
 * Purpose:
 * - Separate real-time price data from analysis data
 * - Persistent storage (survives server restarts)
 * - Fast lookups for displaying current prices in UI
 * - No mixing of price data with analysis metadata
 */
const latestPriceSchema = new mongoose.Schema({
  instrument_key: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  stock_symbol: {
    type: String,
    required: true,
    index: true
  },
  stock_name: {
    type: String
  },
  exchange: {
    type: String,
    enum: ['NSE', 'BSE', 'NSE_INDEX', 'BSE_INDEX', 'NSE_EQ', 'BSE_EQ', 'NSE_FO', 'BSE_FO', 'MCX_FO', 'BCD_FO'],
    required: true
  },

  // Latest price data (from 1-minute intraday candle)
  last_traded_price: {
    type: Number,
    required: true
  },
  open: {
    type: Number,
    required: true
  },
  high: {
    type: Number,
    required: true
  },
  low: {
    type: Number,
    required: true
  },
  close: {
    type: Number,
    required: true
  },
  volume: {
    type: Number,
    default: 0
  },

  // Change calculations
  change: {
    type: Number,
    default: 0
  },
  change_percent: {
    type: Number,
    default: 0
  },

  // Metadata
  candle_timestamp: {
    type: Date,
    required: true,
    index: true
  },
  updated_at: {
    type: Date,
    default: Date.now,
    index: true
  },
  data_source: {
    type: String,
    enum: ['intraday_api', 'historical_api', 'cache'],
    default: 'intraday_api'
  },

  // Optional: Store last 5 candles for mini-chart display
  recent_candles: [{
    timestamp: Date,
    open: Number,
    high: Number,
    low: Number,
    close: Number,
    volume: Number
  }]
}, {
  timestamps: true, // Adds createdAt and updatedAt automatically
  collection: 'latest_prices'
});

// Indexes for fast queries
latestPriceSchema.index({ exchange: 1, updated_at: -1 });
latestPriceSchema.index({ stock_symbol: 1 });

// TTL index - automatically delete prices older than 7 days (keeps DB clean)
latestPriceSchema.index({ updated_at: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

/**
 * Static method: Update or insert latest price
 */
latestPriceSchema.statics.upsertPrice = async function (priceData) {
  const {
    instrument_key,
    stock_symbol,
    stock_name,
    exchange,
    ltp,
    open,
    high,
    low,
    close,
    volume = 0,
    change = 0,
    change_percent = 0,
    candle_timestamp,
    data_source = 'intraday_api',
    recent_candles = []
  } = priceData;

  return this.findOneAndUpdate(
    { instrument_key },
    {
      $set: {
        stock_symbol,
        stock_name,
        exchange,
        last_traded_price: ltp,
        open,
        high,
        low,
        close,
        volume,
        change,
        change_percent,
        candle_timestamp: new Date(candle_timestamp),
        updated_at: new Date(),
        data_source,
        recent_candles
      }
    },
    {
      upsert: true,
      new: true,
      runValidators: true
    }
  );
};

/**
 * Static method: Get latest prices for multiple instruments
 */
latestPriceSchema.statics.getPricesForInstruments = async function (instrumentKeys) {
  return this.find({
    instrument_key: { $in: instrumentKeys }
  }).
  select('instrument_key stock_symbol last_traded_price change change_percent updated_at candle_timestamp').
  lean();
};

/**
 * Static method: Get all prices for an exchange
 */
latestPriceSchema.statics.getPricesByExchange = async function (exchange, limit = 100) {
  return this.find({ exchange }).
  sort({ updated_at: -1 }).
  limit(limit).
  select('instrument_key stock_symbol last_traded_price change change_percent updated_at').
  lean();
};

/**
 * Static method: Clean up stale prices (older than 1 day)
 */
latestPriceSchema.statics.cleanupStalePrices = async function () {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await this.deleteMany({
    updated_at: { $lt: oneDayAgo }
  });

  if (result.deletedCount > 0) {

  }

  return result;
};

const LatestPrice = mongoose.model('LatestPrice', latestPriceSchema);

export default LatestPrice;