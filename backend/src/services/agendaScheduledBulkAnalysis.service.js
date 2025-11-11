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

            for (const user of users) {
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

            // 3. Analyze each stock for each user who has it in their watchlist
            let analysisCount = 0;
            let successCount = 0;
            let failureCount = 0;
            let skippedCount = 0;
            const limitReachedUsers = new Set();

            console.log(`🔄 [SCHEDULED BULK] Starting analysis for ${uniqueStocks.length} stocks...`);

            // Set release time to 5:00 PM IST today
            const releaseTime = new Date(today);
            releaseTime.setHours(17, 0, 0, 0); // 5:00 PM IST
            console.log(`📅 [SCHEDULED BULK] Analysis will be released at: ${releaseTime.toISOString()}`);

            for (const stock of uniqueStocks) {
                console.log(`\n📊 [SCHEDULED BULK] Analyzing ${stock.trading_symbol} for ${stock.users.length} user(s)...`);

                // Get stock details from database
                let stockDetails;
                try {
                    stockDetails = await Stock.findOne({ instrument_key: stock.instrument_key }).lean();
                    if (!stockDetails) {
                        console.log(`  ⚠️  Stock ${stock.instrument_key} not found in database, skipping...`);
                        skippedCount += stock.users.length;
                        continue;
                    }
                } catch (error) {
                    console.error(`  ❌ Error fetching stock details for ${stock.instrument_key}:`, error.message);
                    failureCount += stock.users.length;
                    continue;
                }

                // Get current price
                let current_price;
                try {
                    current_price = await getCurrentPrice(stock.instrument_key);
                    if (!current_price) {
                        console.log(`  ⚠️  Could not get price for ${stock.trading_symbol}, using 0`);
                        current_price = 0;
                    }
                } catch (error) {
                    console.log(`  ⚠️  Error getting price for ${stock.trading_symbol}, using 0`);
                    current_price = 0;
                }

                // Analyze this stock for each user who has it
                for (const userId of stock.users) {
                    const userKey = userId.toString();
                    if (limitReachedUsers.has(userKey)) {
                        skippedCount++;
                        continue;
                    }

                    analysisCount++;

                    try {
                        const result = await aiAnalyzeService.analyzeStock({
                            instrument_key: stock.instrument_key,
                            stock_name: stockDetails.name,
                            stock_symbol: stockDetails.trading_symbol,
                            current_price: current_price,
                            analysis_type: 'swing',
                            user_id: userId.toString(),
                            skipNotification: true,  // Skip notifications for scheduled bulk pre-analysis
                            scheduled_release_time: releaseTime,  // Release at 5:00 PM
                            forceFresh: false  // Always get fresh daily analysis, no cache
                        });

                        if (result.success) {
                            if (result.cached) {
                                skippedCount++;
                                console.log(`  ⏭️  [${analysisCount}/${totalWatchlistItems}] ${stock.trading_symbol} already analyzed for user ${userId}`);
                            } else {
                                successCount++;
                                console.log(`  ✅ [${analysisCount}/${totalWatchlistItems}] ${stock.trading_symbol} analyzed for user ${userId}`);
                            }
                        } else if (result.error === 'daily_stock_limit_reached') {
                            skippedCount++;
                            limitReachedUsers.add(userKey);
                            const limitInfo = result.limitInfo || {};
                            const used = limitInfo.usedCount ?? 'unknown';
                            const limit = limitInfo.stockLimit ?? 'unknown';
                            console.log(`  ⚖️  [${analysisCount}/${totalWatchlistItems}] Daily limit reached for user ${userId} (${used}/${limit})`);
                        } else {
                            failureCount++;
                            console.log(`  ❌ [${analysisCount}/${totalWatchlistItems}] ${stock.trading_symbol} failed for user ${userId} - ${result.error || 'Unknown error'}`);
                        }
                    } catch (error) {
                        failureCount++;
                        console.error(`  ❌ [${analysisCount}/${totalWatchlistItems}] Error analyzing ${stock.trading_symbol} for user ${userId}:`, error.message);
                    }

                    // Add delay between analyses to avoid rate limiting
                    await this.delay(2000); // 2 second delay
                }
            }

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
