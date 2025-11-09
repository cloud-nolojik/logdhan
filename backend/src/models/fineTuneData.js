import mongoose from 'mongoose';

/**
 * Fine-tune training data collection
 * Stores prompt-response pairs for model fine-tuning
 */
const fineTuneDataSchema = new mongoose.Schema({
    // Stock identification
    instrument_key: {
        type: String,
        required: true,
        index: true
    },
    stock_symbol: {
        type: String,
        required: true
    },
    stock_name: {
        type: String,
        required: true
    },

    // Analysis metadata
    analysis_type: {
        type: String,
        enum: ['swing', 'intraday'],
        required: true
    },
    current_price: {
        type: Number,
        required: true
    },

    // Which stage this data is for
    stage: {
        type: String,
        enum: ['stage1', 'stage2', 'stage3'],
        required: true,
        index: true
    },

    // The actual training data
    prompt: {
        type: String,
        required: true
    },
    response: {
        type: String,
        required: true
    },

    // Model info
    model_used: {
        type: String,
        required: true
    },

    // Token usage for this interaction
    token_usage: {
        input_tokens: Number,
        output_tokens: Number,
        cached_tokens: Number,
        total_tokens: Number
    },

    // Quality indicators
    analysis_status: {
        type: String,
        enum: ['completed', 'failed', 'insufficient_data'],
        required: true
    },

    // If the analysis was successful, store its ID for reference
    analysis_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StockAnalysis'
    },

    // Market conditions at time of analysis
    market_context: {
        trend: String,
        volatility: String,
        volume: String,
        sentiment: String
    },

    // User feedback (if available later)
    user_feedback: {
        helpful: Boolean,
        rating: Number,
        comments: String
    },

    // For filtering and quality control
    include_in_training: {
        type: Boolean,
        default: true
    },

    // Timestamps
    created_at: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    timestamps: true
});

// Compound indexes for efficient queries
fineTuneDataSchema.index({ stage: 1, analysis_status: 1, created_at: -1 });
fineTuneDataSchema.index({ stock_symbol: 1, stage: 1 });
fineTuneDataSchema.index({ include_in_training: 1, analysis_status: 1 });

// Static method to get training dataset
fineTuneDataSchema.statics.getTrainingDataset = async function(filters = {}) {
    const query = {
        include_in_training: true,
        analysis_status: 'completed',
        ...filters
    };

    return this.find(query)
        .select('stage prompt response token_usage market_context')
        .lean();
};

// Static method to export in OpenAI fine-tune format
fineTuneDataSchema.statics.exportForOpenAI = async function(filters = {}) {
    const data = await this.getTrainingDataset(filters);

    // Convert to OpenAI JSONL format
    return data.map(item => ({
        messages: [
            {
                role: "system",
                content: "You are a stock market analysis AI that helps traders make informed decisions."
            },
            {
                role: "user",
                content: item.prompt
            },
            {
                role: "assistant",
                content: item.response
            }
        ]
    }));
};

// Static method to get statistics
fineTuneDataSchema.statics.getStats = async function() {
    return this.aggregate([
        {
            $group: {
                _id: {
                    stage: '$stage',
                    status: '$analysis_status'
                },
                count: { $sum: 1 },
                avg_input_tokens: { $avg: '$token_usage.input_tokens' },
                avg_output_tokens: { $avg: '$token_usage.output_tokens' },
                total_tokens: { $sum: '$token_usage.total_tokens' }
            }
        },
        {
            $sort: { '_id.stage': 1, '_id.status': 1 }
        }
    ]);
};

const FineTuneData = mongoose.model('FineTuneData', fineTuneDataSchema);

export default FineTuneData;
