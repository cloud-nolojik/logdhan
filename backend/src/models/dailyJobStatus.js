import mongoose from 'mongoose';

// Track daily pre-fetch job status and performance
const dailyJobStatusSchema = new mongoose.Schema({
    job_date: {
        type: Date,
        required: true
    },
    job_type: {
        type: String,
        required: true,
        enum: ['data_prefetch', 'cache_cleanup', 'analysis_prefetch'],
        index: true
    },
    status: {
        type: String,
        required: true,
        enum: ['pending', 'running', 'completed', 'failed', 'partial'],
        default: 'pending',
        index: true
    },
    started_at: {
        type: Date,
        index: true
    },
    completed_at: {
        type: Date,
        index: true
    },
    duration_ms: {
        type: Number
    },
    stocks_processed: {
        type: Number,
        default: 0
    },
    total_stocks: {
        type: Number,
        default: 0
    },
    timeframes_processed: [{
        timeframe: String,
        stocks_completed: Number,
        total_bars_fetched: Number,
        error_count: Number
    }],
    job_errors: [{
        timestamp: {
            type: Date,
            default: Date.now
        },
        error_type: String,
        stock_symbol: String,
        timeframe: String,
        error_message: String,
        stack_trace: String
    }],
    summary: {
        total_api_calls: {
            type: Number,
            default: 0
        },
        total_bars_fetched: {
            type: Number,
            default: 0
        },
        data_size_mb: {
            type: Number,
            default: 0
        },
        cache_hits: {
            type: Number,
            default: 0
        },
        unique_stocks: {
            type: Number,
            default: 0
        },
        user_watchlists_processed: {
            type: Number,
            default: 0
        }
    },
    performance_metrics: {
        avg_fetch_time_ms: Number,
        slowest_stock: {
            symbol: String,
            time_ms: Number
        },
        fastest_stock: {
            symbol: String,
            time_ms: Number
        },
        api_rate_limit_hits: {
            type: Number,
            default: 0
        }
    },
    next_scheduled: Date
});

// Compound indexes
dailyJobStatusSchema.index({ job_date: 1, job_type: 1 }, { unique: true });
dailyJobStatusSchema.index({ status: 1, started_at: 1 });

// TTL index to keep job history for 90 days
dailyJobStatusSchema.index({ job_date: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Instance methods
dailyJobStatusSchema.methods.addError = function(errorType, stockSymbol, timeframe, errorMessage, stackTrace = null) {
    this.job_errors.push({
        timestamp: new Date(),
        error_type: errorType,
        stock_symbol: stockSymbol,
        timeframe: timeframe,
        error_message: errorMessage,
        stack_trace: stackTrace
    });
};

dailyJobStatusSchema.methods.updateProgress = function(stocksProcessed, timeframe = null, barsCount = 0) {
    this.stocks_processed = stocksProcessed;
    
    if (timeframe) {
        const tfStatus = this.timeframes_processed.find(tf => tf.timeframe === timeframe);
        if (tfStatus) {
            tfStatus.stocks_completed += 1;
            tfStatus.total_bars_fetched += barsCount;
        } else {
            this.timeframes_processed.push({
                timeframe: timeframe,
                stocks_completed: 1,
                total_bars_fetched: barsCount,
                error_count: 0
            });
        }
    }
    
    this.summary.total_bars_fetched += barsCount;
};

dailyJobStatusSchema.methods.markCompleted = function() {
    this.status = 'completed';
    this.completed_at = new Date();
    this.duration_ms = this.completed_at - this.started_at;
    
    // Calculate performance metrics
    if (this.summary.total_api_calls > 0) {
        this.performance_metrics.avg_fetch_time_ms = this.duration_ms / this.summary.total_api_calls;
    }
};

dailyJobStatusSchema.methods.markFailed = function(errorMessage) {
    this.status = 'failed';
    this.completed_at = new Date();
    this.duration_ms = this.completed_at - this.started_at;
    
    this.addError('JOB_FAILURE', null, null, errorMessage);
};

// Static methods
dailyJobStatusSchema.statics.createJob = function(jobDate, jobType, totalStocks = 0) {
    return new this({
        job_date: jobDate,
        job_type: jobType,
        status: 'pending',
        total_stocks: totalStocks,
        started_at: new Date()
    });
};

dailyJobStatusSchema.statics.getLatestJob = function(jobType, jobDate = null) {
    const query = { job_type: jobType };
    if (jobDate) {
        query.job_date = jobDate;
    }
    
    return this.findOne(query).sort({ job_date: -1, started_at: -1 });
};

dailyJobStatusSchema.statics.getJobStats = function(days = 7) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    return this.aggregate([
        { $match: { job_date: { $gte: startDate } } },
        {
            $group: {
                _id: '$job_type',
                total_jobs: { $sum: 1 },
                successful_jobs: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
                avg_duration_ms: { $avg: '$duration_ms' },
                total_stocks_processed: { $sum: '$stocks_processed' },
                total_errors: { $sum: { $size: '$job_errors' } }
            }
        }
    ]);
};

const DailyJobStatus = mongoose.model('DailyJobStatus', dailyJobStatusSchema);

export default DailyJobStatus;