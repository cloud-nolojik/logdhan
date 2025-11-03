import mongoose from 'mongoose';

/**
 * AnalysisFeedback Model
 * Stores user feedback/ratings for AI-generated stock analysis
 * Allows users to rate the quality, accuracy, and usefulness of analysis
 */
const analysisFeedbackSchema = new mongoose.Schema({
    analysis_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'StockAnalysis',
        required: true,
        index: true
    },
    user_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    stock_symbol: {
        type: String,
        required: true,
        index: true
    },
    // Star rating (1-5)
    rating: {
        type: Number,
        required: true,
        min: 1,
        max: 5,
        validate: {
            validator: Number.isInteger,
            message: 'Rating must be an integer between 1 and 5'
        }
    },
    // Optional detailed ratings
    detailed_ratings: {
        accuracy: {
            type: Number,
            min: 1,
            max: 5,
            validate: {
                validator: function(v) {
                    return v === undefined || Number.isInteger(v);
                },
                message: 'Accuracy rating must be an integer between 1 and 5'
            }
        },
        usefulness: {
            type: Number,
            min: 1,
            max: 5,
            validate: {
                validator: function(v) {
                    return v === undefined || Number.isInteger(v);
                },
                message: 'Usefulness rating must be an integer between 1 and 5'
            }
        },
        clarity: {
            type: Number,
            min: 1,
            max: 5,
            validate: {
                validator: function(v) {
                    return v === undefined || Number.isInteger(v);
                },
                message: 'Clarity rating must be an integer between 1 and 5'
            }
        }
    },
    // Optional text feedback
    comment: {
        type: String,
        maxlength: 1000,
        trim: true
    },
    // Feedback category tags
    tags: [{
        type: String,
        enum: [
            'accurate',
            'helpful',
            'confusing',
            'wrong_prediction',
            'good_entry',
            'bad_entry',
            'good_stop_loss',
            'bad_stop_loss',
            'good_target',
            'bad_target',
            'too_risky',
            'too_conservative',
            'good_timing',
            'bad_timing',
            'clear_explanation',
            'unclear_explanation'
        ]
    }],
    // Outcome tracking (optional - user can report actual outcome)
    outcome: {
        // Did the user take the trade?
        trade_taken: {
            type: Boolean,
            default: null
        },
        // Actual profit/loss if trade was taken
        profit_loss: {
            type: Number,
            default: null
        },
        profit_loss_percentage: {
            type: Number,
            default: null
        },
        // Did the analysis prediction come true?
        prediction_accurate: {
            type: Boolean,
            default: null
        },
        // Exit reason if trade was taken
        exit_reason: {
            type: String,
            enum: ['target_hit', 'stop_loss_hit', 'manual_exit', 'time_stop', 'invalidation', null],
            default: null
        }
    },
    // Internal tracking
    is_deleted: {
        type: Boolean,
        default: false
    },
    edited_at: {
        type: Date,
        default: null
    }
}, {
    timestamps: true // Adds createdAt and updatedAt
});

// Compound indexes
analysisFeedbackSchema.index({
    analysis_id: 1,
    user_id: 1
}, {
    unique: true // One feedback per user per analysis
});

analysisFeedbackSchema.index({
    user_id: 1,
    createdAt: -1
});

analysisFeedbackSchema.index({
    stock_symbol: 1,
    rating: -1
});

// Auto-delete old feedback after 180 days (6 months)
analysisFeedbackSchema.index({
    createdAt: 1
}, {
    expireAfterSeconds: 180 * 24 * 60 * 60
});

// Static methods

/**
 * Get average rating for a specific analysis
 */
analysisFeedbackSchema.statics.getAverageRatingForAnalysis = function(analysisId) {
    return this.aggregate([
        {
            $match: {
                analysis_id: mongoose.Types.ObjectId(analysisId),
                is_deleted: false
            }
        },
        {
            $group: {
                _id: '$analysis_id',
                average_rating: { $avg: '$rating' },
                total_feedbacks: { $sum: 1 },
                rating_distribution: {
                    $push: '$rating'
                }
            }
        },
        {
            $addFields: {
                rating_counts: {
                    five_star: {
                        $size: {
                            $filter: {
                                input: '$rating_distribution',
                                cond: { $eq: ['$$this', 5] }
                            }
                        }
                    },
                    four_star: {
                        $size: {
                            $filter: {
                                input: '$rating_distribution',
                                cond: { $eq: ['$$this', 4] }
                            }
                        }
                    },
                    three_star: {
                        $size: {
                            $filter: {
                                input: '$rating_distribution',
                                cond: { $eq: ['$$this', 3] }
                            }
                        }
                    },
                    two_star: {
                        $size: {
                            $filter: {
                                input: '$rating_distribution',
                                cond: { $eq: ['$$this', 2] }
                            }
                        }
                    },
                    one_star: {
                        $size: {
                            $filter: {
                                input: '$rating_distribution',
                                cond: { $eq: ['$$this', 1] }
                            }
                        }
                    }
                }
            }
        },
        {
            $project: {
                rating_distribution: 0
            }
        }
    ]);
};

/**
 * Get average rating for a stock symbol across all analyses
 */
analysisFeedbackSchema.statics.getAverageRatingForStock = function(stockSymbol) {
    return this.aggregate([
        {
            $match: {
                stock_symbol: stockSymbol,
                is_deleted: false
            }
        },
        {
            $group: {
                _id: '$stock_symbol',
                average_rating: { $avg: '$rating' },
                total_feedbacks: { $sum: 1 },
                average_accuracy: { $avg: '$detailed_ratings.accuracy' },
                average_usefulness: { $avg: '$detailed_ratings.usefulness' },
                average_clarity: { $avg: '$detailed_ratings.clarity' }
            }
        }
    ]);
};

/**
 * Get all feedback for a user (their feedback history)
 */
analysisFeedbackSchema.statics.getUserFeedbackHistory = function(userId, limit = 20) {
    return this.find({
        user_id: userId,
        is_deleted: false
    })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('analysis_id', 'stock_symbol analysis_type generated_at_ist')
    .lean();
};

/**
 * Get recent feedback for admin dashboard
 */
analysisFeedbackSchema.statics.getRecentFeedback = function(limit = 50) {
    return this.find({
        is_deleted: false
    })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('user_id', 'name email')
    .populate('analysis_id', 'stock_symbol analysis_type')
    .lean();
};

/**
 * Get feedback statistics for AI model improvement
 */
analysisFeedbackSchema.statics.getFeedbackStats = function(daysBack = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    return this.aggregate([
        {
            $match: {
                createdAt: { $gte: startDate },
                is_deleted: false
            }
        },
        {
            $group: {
                _id: null,
                total_feedbacks: { $sum: 1 },
                average_rating: { $avg: '$rating' },
                average_accuracy: { $avg: '$detailed_ratings.accuracy' },
                average_usefulness: { $avg: '$detailed_ratings.usefulness' },
                average_clarity: { $avg: '$detailed_ratings.clarity' },
                trades_taken_count: {
                    $sum: {
                        $cond: [{ $eq: ['$outcome.trade_taken', true] }, 1, 0]
                    }
                },
                accurate_predictions_count: {
                    $sum: {
                        $cond: [{ $eq: ['$outcome.prediction_accurate', true] }, 1, 0]
                    }
                },
                common_tags: {
                    $push: '$tags'
                }
            }
        },
        {
            $addFields: {
                common_tags: {
                    $reduce: {
                        input: '$common_tags',
                        initialValue: [],
                        in: { $concatArrays: ['$$value', '$$this'] }
                    }
                }
            }
        }
    ]);
};

// Instance methods

/**
 * Soft delete feedback
 */
analysisFeedbackSchema.methods.softDelete = function() {
    this.is_deleted = true;
    return this.save();
};

/**
 * Update feedback
 */
analysisFeedbackSchema.methods.updateFeedback = function(updates) {
    if (updates.rating !== undefined) this.rating = updates.rating;
    if (updates.comment !== undefined) this.comment = updates.comment;
    if (updates.tags !== undefined) this.tags = updates.tags;
    if (updates.detailed_ratings !== undefined) {
        this.detailed_ratings = { ...this.detailed_ratings, ...updates.detailed_ratings };
    }
    if (updates.outcome !== undefined) {
        this.outcome = { ...this.outcome, ...updates.outcome };
    }
    this.edited_at = new Date();
    return this.save();
};

const AnalysisFeedback = mongoose.model('AnalysisFeedback', analysisFeedbackSchema);

export default AnalysisFeedback;
