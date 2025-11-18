/**
 * Agenda-based Scheduled Bulk Analysis Service
 * Runs at 4:00 PM every trading day to pre-analyze all users' watchlist stocks
 * So users see analysis results immediately when they open the app at 5:00 PM
 * Uses MongoDB for job persistence via Agenda
 */

import Agenda from 'agenda';
import { User } from '../models/user.js';
import aiAnalyzeService from './aiAnalyze.service.js';
import MarketHoursUtil from '../utils/marketHours.js';
import Stock from '../models/stock.js';
import { getCurrentPrice } from '../utils/stockDb.js';
import priceCacheService from './priceCache.service.js';
import pLimit from 'p-limit';

class AgendaScheduledBulkAnalysisService {
    constructor() {
        this.agenda = null;
        this.isInitialized = false;
        this.isRunning = false;
        this.stats = {
            totalRuns: 0,
            successfulRuns: 0,
            failedRuns: 0,
            lastRunDate: null,
            lastRunSummary: null
        };
        // Rate limit tracking
        this.rateLimitStats = {
            totalRetries: 0,
            rateLimitHits: 0,
            lastRateLimitTime: null,
            tokenUsageToday: 0
        };
    }

    /**
     * Initialize the Agenda service
     */
    async initialize() {
        if (this.isInitialized) {
            console.log('⚠️ [SCHEDULED BULK] Service already initialized');
            return;
        }

        try {
            console.log('🚀 [SCHEDULED BULK] Initializing Agenda scheduled bulk analysis service...');

            // Use existing MongoDB connection
            const mongoUrl = process.env.MONGODB_URI;
            this.agenda = new Agenda({
                db: {
                    address: mongoUrl,
                    collection: 'scheduled_bulk_analysis_jobs',
                    options: {
                        useUnifiedTopology: true
                    }
                },
                processEvery: '1 minute',
                maxConcurrency: 1, // Only run one bulk analysis at a time
                defaultConcurrency: 1
            });

            // Define the job
            this.defineJobs();

            // Setup event handlers
            this.setupEventHandlers();

            // Start agenda
            await this.agenda.start();

            // Schedule the recurring job
            await this.scheduleRecurringJobs();

            this.isInitialized = true;
            console.log('✅ [SCHEDULED BULK] Service initialized successfully');

        } catch (error) {
            console.error('❌ [SCHEDULED BULK] Failed to initialize service:', error);
            throw error;
        }
    }

    /**
     * Define the bulk analysis job
     */
    defineJobs() {
        // Main scheduled bulk analysis job
        this.agenda.define('watchlist-bulk-analysis', async (job) => {
            await this.runScheduledAnalysis();
        });

        // Manual trigger job (for testing and admin purposes)
        this.agenda.define('manual-watchlist-bulk-analysis', async (job) => {
            const { reason } = job.attrs.data;
            console.log(`🔧 [SCHEDULED BULK] Manually triggered: ${reason || 'No reason provided'}`);
            await this.runScheduledAnalysis();
        });
    }

    /**
     * Setup event handlers for monitoring
     */
    setupEventHandlers() {
        this.agenda.on('ready', () => {
            console.log('🎯 [SCHEDULED BULK] Agenda scheduled bulk analysis service ready');
        });

        this.agenda.on('start', (job) => {
            if (job.attrs.name.includes('bulk-analysis')) {
                console.log(`🔄 [SCHEDULED BULK] Job started: ${job.attrs.name}`);
            }
        });

        this.agenda.on('complete', (job) => {
            if (job.attrs.name.includes('bulk-analysis')) {
                console.log(`✅ [SCHEDULED BULK] Job completed: ${job.attrs.name}`);
            }
        });

        this.agenda.on('fail', (err, job) => {
            if (job.attrs.name.includes('bulk-analysis')) {
                console.error(`❌ [SCHEDULED BULK] Job failed: ${job.attrs.name}`, err);
            }
        });

        this.agenda.on('error', (err) => {
            console.error('❌ [SCHEDULED BULK] Agenda error:', err);
        });
    }

    /**
     * Schedule the recurring job
     */
    async scheduleRecurringJobs() {
        try {
            // Cancel any existing jobs to avoid duplicates
            await this.agenda.cancel({
                name: 'watchlist-bulk-analysis'
            });

            // Schedule for 4:00 PM IST every day (Monday-Friday)
            // Cron format: minute hour * * day-of-week
            await this.agenda.every('0 16 * * 1-5', 'watchlist-bulk-analysis', {}, {
                timezone: 'Asia/Kolkata'
            });

            console.log('📅 [SCHEDULED BULK] Scheduled watchlist bulk analysis for 4:00 PM IST on trading days');

        } catch (error) {
            console.error('❌ [SCHEDULED BULK] Failed to schedule recurring jobs:', error);
            throw error;
        }
    }

    /**
     * Main function that runs at 4:00 PM
     */
    async runScheduledAnalysis() {
        // Check if already running
        if (this.isRunning) {
            console.log('⏭️  [SCHEDULED BULK] Analysis already in progress, skipping...');
            return;
        }

        // Check if today is a trading day
        const today = new Date();
        const isTradingDay = await MarketHoursUtil.isTradingDay(today);

        // if (!isTradingDay) {
        //     console.log(`⏭️  [SCHEDULED BULK] ${today.toISOString().split('T')[0]} is not a trading day, skipping analysis`);
        //     return;
        // }

        console.log('🚀 [SCHEDULED BULK] Starting scheduled bulk analysis at 4:00 PM IST...');
        this.isRunning = true;
        this.stats.totalRuns++;

        try {
            // 1. Get all users
            const users = await User.find({}).select('_id email name watchlist').lean();
            console.log(`👥 [SCHEDULED BULK] Found ${users.length} total users`);

            // 2. Collect all unique stocks from all watchlists
            const stockMap = new Map();
            let totalWatchlistItems = 0;

            // Process all users in production mode
            const usersToProcess = users;
            console.log(`📊 [PRODUCTION MODE] Processing ${usersToProcess.length} users`);

            for (const user of usersToProcess) {
                if (user.watchlist && user.watchlist.length > 0) {
                    totalWatchlistItems += user.watchlist.length;

                    for (const item of user.watchlist) {
                        if (item.instrument_key ) {
                            if (!stockMap.has(item.instrument_key)) {
                                stockMap.set(item.instrument_key, {
                                    instrument_key: item.instrument_key,
                                    trading_symbol: item.trading_symbol || '',
                                    name: item.name || '',
                                    users: []
                                });
                            }
                            // Track which users have this stock
                            stockMap.get(item.instrument_key).users.push(user._id);
                        }
                    }
                }
            }

            const uniqueStocks = Array.from(stockMap.values());
            console.log(`📈 [SCHEDULED BULK] Collected ${uniqueStocks.length} unique stocks from ${totalWatchlistItems} total watchlist items`);

            if (uniqueStocks.length === 0) {
                console.log('⏭️  [SCHEDULED BULK] No stocks to analyze');
                return;
            }

            // 3. Fetch prices for all unique stocks at once
            console.log(`💰 [SCHEDULED BULK] Fetching prices for ${uniqueStocks.length} unique stocks...`);
            const instrumentKeys = uniqueStocks.map(stock => stock.instrument_key);
            const priceMap = await priceCacheService.getLatestPrices(instrumentKeys);
            console.log(`✅ [SCHEDULED BULK] Fetched ${Object.keys(priceMap).length} prices`);

            // Set release time to 5:00 PM IST today
            const releaseTime = new Date();

            // 4. Check existing strategies and decide: VALIDATE or CREATE pending record
            console.log(`📝 [SCHEDULED BULK] Checking existing strategies for ${uniqueStocks.length} stocks...`);
            let recordsCreated = 0;
            let recordsToValidate = 0;
            let recordsSkipped = 0;

            const StockAnalysis = (await import('../models/stockAnalysis.js')).default;

            for (const stock of uniqueStocks) {
                const current_price = priceMap[stock.instrument_key];

                if (!current_price || isNaN(current_price) || current_price <= 0) {
                    console.log(`  ⚠️  Skipping ${stock.trading_symbol} - no valid price available`);
                    recordsSkipped++;
                    continue;
                }

                // Get stock details from database
                let stockDetails;
                try {
                    stockDetails = await Stock.findOne({ instrument_key: stock.instrument_key }).lean();
                    if (!stockDetails) {
                        console.log(`  ⚠️  Stock ${stock.instrument_key} not found in database, skipping...`);
                        recordsSkipped++;
                        continue;
                    }
                } catch (error) {
                    console.error(`  ❌ Error fetching stock details for ${stock.instrument_key}:`, error.message);
                    recordsSkipped++;
                    continue;
                }

                try {
                    // Check if existing completed strategy exists
                    const existing = await StockAnalysis.findByInstrument(stock.instrument_key, 'swing');

                    if (existing && existing.status === 'completed' && existing.valid_until) {
                        const now = new Date();

                        if (now > existing.valid_until) {
                            // Strategy expired - will be validated by analyzeStock()
                            recordsToValidate++;
                            console.log(`  🔄 [${recordsToValidate}/${uniqueStocks.length}] ${stock.trading_symbol} - expired strategy will be validated`);
                        } else {
                            // Strategy still valid - skip
                            recordsSkipped++;
                            console.log(`  ✅ [${recordsSkipped}/${uniqueStocks.length}] ${stock.trading_symbol} - strategy still valid until ${existing.valid_until.toISOString()}`);
                            continue;
                        }
                    } else {
                        // No existing strategy or not completed - create pending record
                        await aiAnalyzeService.createPendingAnalysisRecord({
                            instrument_key: stock.instrument_key,
                            stock_name: stockDetails.name,
                            stock_symbol: stockDetails.trading_symbol,
                            analysis_type: 'swing',
                            current_price: current_price,
                            scheduled_release_time: releaseTime
                        });
                        recordsCreated++;
                        console.log(`  📝 [${recordsCreated}/${uniqueStocks.length}] Created pending record for ${stock.trading_symbol} at ₹${current_price}`);
                    }
                } catch (error) {
                    console.error(`  ❌ Failed to check/create record for ${stock.trading_symbol}:`, error.message);
                    recordsSkipped++;
                }
            }

            console.log(`✅ [SCHEDULED BULK] Created ${recordsCreated} pending records, ${recordsToValidate} to validate, ${recordsSkipped} skipped`);

            // 5. Analyze each stock for each user who has it in their watchlist - PARALLEL PROCESSING
            let analysisCount = 0;
            let successCount = 0;
            let failureCount = 0;
            let skippedCount = 0;

            // Configure concurrency limit based on OpenAI rate limits
            // PERFORMANCE CALCULATION:
            // - 1000 stocks × 12s avg = 12,000s total work
            // - 12,000s ÷ 10 concurrent = ~1,200s = ~20 minutes (vs 3.3 hours sequential!)
            //
            // RATE LIMIT CONSIDERATIONS (OpenAI API):
            // - Free Tier: 3 RPM (too slow, need Tier 1+)
            // - Tier 1: 500 RPM, 30,000 TPM
            // - Tier 2: 5,000 RPM, 450,000 TPM
            // - Each analysis = 3 API calls (stage1, stage2, stage3)
            // - Average tokens per analysis: ~6,000 tokens
            //
            // SAFE CONCURRENCY LIMITS BY TIER:
            // - Tier 1: CONCURRENCY_LIMIT = 5  (15 RPM, ~30K TPM)
            // - Tier 2: CONCURRENCY_LIMIT = 10 (30 RPM, ~60K TPM)
            // - Tier 3: CONCURRENCY_LIMIT = 20 (60 RPM, ~120K TPM)
            //
            // With exponential backoff, the system will automatically slow down if rate limits are hit
            // START WITH CONSERVATIVE LIMIT - Increase gradually based on your tier
            const CONCURRENCY_LIMIT = 5;  // Safe for Tier 1, increase to 10 for Tier 2+
            const limit = pLimit(CONCURRENCY_LIMIT);

            console.log(`🔄 [SCHEDULED BULK] Starting PARALLEL analysis for ${uniqueStocks.length} stocks with ${CONCURRENCY_LIMIT} concurrent tasks...`);
            const bulkStartTime = Date.now();

            // Create analysis tasks for all stocks
            const analysisTasks = [];

            for (const stock of uniqueStocks) {
                // Get price from our pre-fetched priceMap
                const current_price = priceMap[stock.instrument_key];
                if (!current_price || isNaN(current_price) || current_price <= 0) {
                    console.log(`  ⚠️  Skipping ${stock.trading_symbol} - no valid price available`);
                    skippedCount += stock.users.length;
                    continue;
                }

                // Create tasks for each user who has this stock
                // NOTE: Each stock is only analyzed ONCE, but shared with all users who have it
                // The first user triggers the analysis, subsequent users get cached results
                for (const userId of stock.users) {
                    // Wrap each analysis in a limited concurrency task with retry logic
                    const task = limit(async () => {
                        analysisCount++;
                        const taskStartTime = Date.now();

                        try {
                            // Wrap API call with exponential backoff retry
                            const result = await this.retryWithExponentialBackoff(async () => {
                                return await aiAnalyzeService.analyzeStock({
                                    instrument_key: stock.instrument_key,
                                    stock_name: stock.name,
                                    stock_symbol: stock.trading_symbol,
                                    current_price: current_price,
                                    analysis_type: 'swing',
                                    user_id: userId.toString(),
                                    skipNotification: true,  // Skip notifications for scheduled bulk pre-analysis
                                    scheduled_release_time: releaseTime,  // Release at 5:00 PM
                                    skipIntraday: false, // Add buffer to intraday candles for end-of-day analysis
                                });
                            });

                            const taskTime = Date.now() - taskStartTime;

                            if (result.success) {
                                if (result.cached) {
                                    skippedCount++;
                                    console.log(`  ⏭️  [${analysisCount}/${totalWatchlistItems}] ${stock.trading_symbol} cached for user (${taskTime}ms)`);
                                } else {
                                    successCount++;
                                    console.log(`  ✅ [${analysisCount}/${totalWatchlistItems}] ${stock.trading_symbol} analyzed (${taskTime}ms)`);
                                }
                            } else {
                                failureCount++;
                                console.log(`  ❌ [${analysisCount}/${totalWatchlistItems}] ${stock.trading_symbol} failed - ${result.error || 'Unknown error'} (${taskTime}ms)`);
                            }
                        } catch (error) {
                            failureCount++;
                            const taskTime = Date.now() - taskStartTime;
                            console.error(`  ❌ [${analysisCount}/${totalWatchlistItems}] Error analyzing ${stock.trading_symbol}:`, error.message, `(${taskTime}ms)`);
                        }
                    });

                    analysisTasks.push(task);
                }
            }

            // Execute all tasks in parallel with concurrency limit
            console.log(`🚀 [SCHEDULED BULK] Executing ${analysisTasks.length} analysis tasks with ${CONCURRENCY_LIMIT} concurrent workers...`);
            await Promise.all(analysisTasks);

            const bulkTotalTime = Date.now() - bulkStartTime;
            console.log(`⏱️ [SCHEDULED BULK] All analyses completed in ${bulkTotalTime}ms (${(bulkTotalTime / 1000 / 60).toFixed(2)} minutes)`);
            console.log(`⏱️ [PERFORMANCE] Average time per analysis: ${(bulkTotalTime / analysisCount).toFixed(0)}ms`);

            // 4. Summary
            const summary = {
                date: today.toISOString().split('T')[0],
                totalAnalyses: analysisCount,
                successful: successCount,
                skipped: skippedCount,
                failed: failureCount,
                uniqueStocks: uniqueStocks.length,
                totalUsers: users.length
            };

            console.log('\n' + '='.repeat(60));
            console.log('📊 [SCHEDULED BULK] Analysis Summary:');
            console.log(`   Total Analyses: ${analysisCount}`);
            console.log(`   ✅ Successful: ${successCount}`);
            console.log(`   ⏭️  Skipped: ${skippedCount}`);
            console.log(`   ❌ Failed: ${failureCount}`);
            console.log(`   📈 Unique Stocks: ${uniqueStocks.length}`);
            console.log(`   👥 Total Users: ${users.length}`);
            console.log(`   🔄 Rate Limit Retries: ${this.rateLimitStats.totalRetries}`);
            console.log(`   ⚠️  Rate Limit Hits: ${this.rateLimitStats.rateLimitHits}`);
            console.log('='.repeat(60));

            // Update stats
            this.stats.successfulRuns++;
            this.stats.lastRunDate = today;
            this.stats.lastRunSummary = summary;

        } catch (error) {
            console.error('❌ [SCHEDULED BULK] Error in scheduled analysis:', error);
            this.stats.failedRuns++;
            throw error;
        } finally {
            this.isRunning = false;
            console.log('✅ [SCHEDULED BULK] Scheduled bulk analysis completed\n');
        }
    }

    /**
     * Helper: Delay function
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Retry with exponential backoff for rate limit errors
     * Based on OpenAI best practices
     */
    async retryWithExponentialBackoff(fn, maxRetries = 5, baseDelay = 1000) {
        let retries = 0;

        while (retries < maxRetries) {
            try {
                return await fn();
            } catch (error) {
                // Check if it's a rate limit error
                const isRateLimitError =
                    error.message?.includes('rate limit') ||
                    error.message?.includes('429') ||
                    error.status === 429;

                if (!isRateLimitError || retries === maxRetries - 1) {
                    // Not a rate limit error, or we've exhausted retries
                    throw error;
                }

                // Calculate exponential backoff with jitter
                const exponentialDelay = baseDelay * Math.pow(2, retries);
                const jitter = Math.random() * 1000; // Add 0-1 second random jitter
                const totalDelay = exponentialDelay + jitter;

                this.rateLimitStats.totalRetries++;
                this.rateLimitStats.rateLimitHits++;
                this.rateLimitStats.lastRateLimitTime = new Date();

                console.log(`⚠️ [RATE LIMIT] Hit rate limit, retry ${retries + 1}/${maxRetries} after ${totalDelay.toFixed(0)}ms`);

                await this.delay(totalDelay);
                retries++;
            }
        }
    }

    /**
     * Manual trigger for testing
     */
    async triggerManually(reason = 'Manual trigger') {
        try {
            console.log('🔧 [SCHEDULED BULK] Manually triggering watchlist bulk analysis...');

            const job = await this.agenda.now('manual-watchlist-bulk-analysis', { reason });
            console.log(`▶️ [SCHEDULED BULK] Job queued with ID: ${job.attrs._id}`);

            return {
                success: true,
                jobId: job.attrs._id,
                jobName: 'manual-watchlist-bulk-analysis',
                scheduledAt: job.attrs.nextRunAt
            };

        } catch (error) {
            console.error('❌ [SCHEDULED BULK] Failed to trigger manual job:', error);
            throw error;
        }
    }

    /**
     * Get job statistics
     */
    async getJobStats() {
        try {
            const jobs = await this.agenda.jobs({
                name: { $in: ['watchlist-bulk-analysis', 'manual-watchlist-bulk-analysis'] }
            });

            return {
                summary: this.stats,
                totalJobs: jobs.length,
                jobs: jobs.map(job => ({
                    name: job.attrs.name,
                    nextRunAt: job.attrs.nextRunAt,
                    lastRunAt: job.attrs.lastRunAt,
                    lastFinishedAt: job.attrs.lastFinishedAt,
                    failedAt: job.attrs.failedAt,
                    failReason: job.attrs.failReason
                }))
            };

        } catch (error) {
            console.error('❌ [SCHEDULED BULK] Error getting job stats:', error);
            throw error;
        }
    }

    /**
     * Stop the service gracefully
     */
    async stop() {
        try {
            console.log('🛑 [SCHEDULED BULK] Stopping service...');

            if (this.agenda) {
                await this.agenda.stop();
                console.log('✅ [SCHEDULED BULK] Service stopped successfully');
            }

            this.isInitialized = false;

        } catch (error) {
            console.error('❌ [SCHEDULED BULK] Error stopping service:', error);
            throw error;
        }
    }

    /**
     * Pause scheduled jobs
     */
    async pauseJobs() {
        try {
            await this.agenda.cancel({ name: 'watchlist-bulk-analysis' });
            console.log('⏸️ [SCHEDULED BULK] Recurring job paused');

        } catch (error) {
            console.error('❌ [SCHEDULED BULK] Error pausing jobs:', error);
            throw error;
        }
    }

    /**
     * Resume scheduled jobs
     */
    async resumeJobs() {
        try {
            await this.scheduleRecurringJobs();
            console.log('▶️ [SCHEDULED BULK] Recurring job resumed');

        } catch (error) {
            console.error('❌ [SCHEDULED BULK] Error resuming jobs:', error);
            throw error;
        }
    }
}

// Export singleton instance
const agendaScheduledBulkAnalysisService = new AgendaScheduledBulkAnalysisService();
export default agendaScheduledBulkAnalysisService;
