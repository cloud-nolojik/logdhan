import mongoose from 'mongoose';

const MarketTimingSchema = new mongoose.Schema({
    date: {
        type: String, // YYYY-MM-DD format
        required: true,
        unique: true,
        index: true
    },
    exchange: {
        type: String,
        required: true,
        default: 'NSE'
    },
    isHoliday: {
        type: Boolean,
        required: true,
        default: false
    },
    isMarketOpen: {
        type: Boolean,
        required: true
    },
    startTime: {
        type: Date,
        required: false // null for holidays
    },
    endTime: {
        type: Date,
        required: false // null for holidays
    },
    reason: {
        type: String,
        required: false // "Holiday", "Weekend", "Special closure", etc.
    },
    upstoxData: {
        type: mongoose.Schema.Types.Mixed, // Store original Upstox response
        required: false
    },
    fetchedAt: {
        type: Date,
        default: Date.now,
        required: true
    },
    validUntil: {
        type: Date,
        required: true
        // Index removed - using explicit schema.index() below with TTL
    }
}, {
    timestamps: true
});

// Compound index for efficient queries
MarketTimingSchema.index({ date: 1, exchange: 1 });

// TTL index to automatically clean up old records (keep for 1 year)
MarketTimingSchema.index({ validUntil: 1 }, { expireAfterSeconds: 0 });

const MarketTiming = mongoose.model('MarketTiming', MarketTimingSchema);

export default MarketTiming;