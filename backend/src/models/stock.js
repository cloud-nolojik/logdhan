import mongoose from 'mongoose';

const stockSchema = new mongoose.Schema({
  // Core fields
  segment: {
    type: String,
    required: true,
    enum: ['NSE_EQ', 'BSE_EQ'],
    index: true
  },
  name: {
    type: String,
    required: true,
    index: true
  },
  exchange: {
    type: String,
    required: true,
    enum: ['NSE', 'BSE'],
    index: true
  },
  isin: {
    type: String,
    sparse: true,
    index: true
  },
  instrument_type: {
    type: String,
    required: true
  },
  instrument_key: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  lot_size: {
    type: Number,
    default: 1
  },
  freeze_quantity: {
    type: Number
  },
  exchange_token: {
    type: String,
    required: true
  },
  tick_size: {
    type: Number,
    default: 0.05
  },
  trading_symbol: {
    type: String,
    required: true,
    index: true
  },
  short_name: {
    type: String,
    sparse: true
  },
  qty_multiplier: {
    type: Number,
    default: 1
  },
  
  // Search optimization fields
  search_keywords: {
    type: String,
    index: 'text'
  },
  
  // Metadata
  is_active: {
    type: Boolean,
    default: true,
    index: true
  },
  last_updated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  collection: 'stocks'
});

// Compound indexes for optimized queries
stockSchema.index({ exchange: 1, trading_symbol: 1 });
stockSchema.index({ segment: 1, is_active: 1 });
stockSchema.index({ name: 1, trading_symbol: 1 });

// Text search index for fuzzy searching
stockSchema.index({
  name: 'text',
  trading_symbol: 'text',
  short_name: 'text'
});

// Pre-save hook to generate search keywords
stockSchema.pre('save', function(next) {
  if (this.isModified('name') || this.isModified('trading_symbol') || this.isModified('short_name')) {
    // Create search keywords from name, trading symbol and short name
    const keywords = [
      this.name,
      this.trading_symbol,
      this.short_name
    ].filter(Boolean).join(' ').toLowerCase();
    
    this.search_keywords = keywords;
  }
  next();
});

// Static method for searching stocks
stockSchema.statics.searchStocks = async function(query, limit = 50) {
  const searchRegex = new RegExp(query, 'i');
  
  // Try exact match first
  let results = await this.find({
    is_active: true,
    $or: [
      { trading_symbol: searchRegex },
      { name: searchRegex },
      { short_name: searchRegex }
    ]
  })
  .limit(limit)
  .select('segment name exchange trading_symbol instrument_key short_name')
  .lean();
  
  // If no exact matches, try text search
  if (results.length === 0) {
    results = await this.find({
      is_active: true,
      $text: { $search: query }
    })
    .limit(limit)
    .select('segment name exchange trading_symbol instrument_key short_name')
    .lean();
  }
  
  return results;
};

// Static method to get stock by instrument key
stockSchema.statics.getByInstrumentKey = async function(instrumentKey) {
  return await this.findOne({
    instrument_key: instrumentKey,
    is_active: true
  }).lean();
};

// Static method for bulk upsert
stockSchema.statics.bulkUpsert = async function(stocks) {
  const bulkOps = stocks.map(stock => ({
    updateOne: {
      filter: { instrument_key: stock.instrument_key },
      update: {
        $set: {
          ...stock,
          last_updated: new Date()
        }
      },
      upsert: true
    }
  }));
  
  return await this.bulkWrite(bulkOps);
};

const Stock = mongoose.model('Stock', stockSchema);

export default Stock;