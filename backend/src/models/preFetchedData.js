import mongoose from 'mongoose';

// Store daily pre-fetched candle data for swing trading
const preFetchedDataSchema = new mongoose.Schema({
  instrument_key: {
    type: String,
    required: true,
    index: true
  },
  stock_symbol: {
    type: String,
    required: true
  },
  timeframe: {
    type: String,
    required: true,
    enum: ['15m', '1h', '1d', '1w'] // Standardized to lowercase only
  },
  trading_date: {
    type: Date,
    required: true
  },
  candle_data: [{
    timestamp: {
      type: String, // Store original IST timezone string: "2025-10-23T15:15:00+05:30"
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
      required: true
    }
  }],
  fetched_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  },
  bars_count: {
    type: Number,
    required: true
  },
  upstox_payload: {
    type: mongoose.Schema.Types.Mixed // Store original Upstox response for debugging
  },
  data_quality: {
    missing_bars: {
      type: Number,
      default: 0
    },
    has_gaps: {
      type: Boolean,
      default: false
    },
    last_bar_time: Date
  }
});

// Compound indexes for efficient queries
// Changed: Only one record per instrument_key + timeframe (supports incremental updates)
preFetchedDataSchema.index({
  instrument_key: 1,
  timeframe: 1
}, { unique: true });

preFetchedDataSchema.index({ trading_date: 1, fetched_at: 1 });
preFetchedDataSchema.index({ updated_at: -1 }); // For finding most recently updated records

// TTL index to auto-delete old data (keep for 30 days)
preFetchedDataSchema.index({ trading_date: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Static methods
preFetchedDataSchema.statics.getDataForAnalysis = function (instrumentKey, timeframes, tradingDate) {

  // First, let's check what data exists for this instrument_key

  return this.find({
    instrument_key: instrumentKey
  }).lean().then((allRecords) => {

    allRecords.forEach((record, index) => {

    });

    // Now run the optimized query

    return this.aggregate([
    {
      $match: {
        instrument_key: instrumentKey,
        timeframe: { $in: timeframes }
      }
    },
    {
      $sort: {
        timeframe: 1,
        trading_date: -1, // Most recent trading date first
        updated_at: -1 // Most recent update first
      }
    },
    {
      $group: {
        _id: '$timeframe',
        latest_record: { $first: '$$ROOT' }
      }
    },
    {
      $replaceRoot: { newRoot: '$latest_record' }
    },
    {
      $sort: { timeframe: 1 }
    }]
    ).then((result) => {

      result.forEach((record, index) => {

      });

      // Check which timeframes are missing
      const foundTimeframes = result.map((r) => r.timeframe);
      const missingTimeframes = timeframes.filter((tf) => !foundTimeframes.includes(tf));
      if (missingTimeframes.length > 0) {

        // For each missing timeframe, check if any data exists
        missingTimeframes.forEach((tf) => {
          const recordsForTimeframe = allRecords.filter((r) => r.timeframe === tf);

          if (recordsForTimeframe.length > 0) {
            recordsForTimeframe.forEach((record, i) => {

            });
          }
        });
      }

      return result;
    });
  });
};

preFetchedDataSchema.statics.getAvailableStocks = function (tradingDate) {
  return this.distinct('instrument_key', { trading_date: tradingDate });
};

preFetchedDataSchema.statics.getDataQualityReport = function (tradingDate) {
  return this.aggregate([
  { $match: { trading_date: tradingDate } },
  {
    $group: {
      _id: '$timeframe',
      total_stocks: { $sum: 1 },
      avg_bars: { $avg: '$bars_count' },
      stocks_with_gaps: { $sum: { $cond: ['$data_quality.has_gaps', 1, 0] } },
      total_missing_bars: { $sum: '$data_quality.missing_bars' }
    }
  }]
  );
};

const PreFetchedData = mongoose.model('PreFetchedData', preFetchedDataSchema);

export default PreFetchedData;