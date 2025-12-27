/**
 * Agenda-based Scheduled Bulk Analysis Service
 * Runs at 4:00 PM every trading day to analyze watchlist stocks
 *
 * Sources:
 * - User.watchlist: Per-user stocks from Screener.in sync
 * - WeeklyWatchlist: Global stocks from ChartInk weekend screening (shared by all users)
 *
 * So users see fresh analysis for next day's trading (market closes at 3:30 PM)
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
import { syncScreenerWatchlist } from '../scripts/syncScreenerWatchlist.js';
import WeeklyWatchlist from '../models/weeklyWatchlist.js';

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

      return;
    }

    try {

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
      const options = job.attrs.data || {};
      await this.runScheduledAnalysis(options);
    });

    // Manual trigger job (for testing and admin purposes)
    this.agenda.define('manual-watchlist-bulk-analysis', async (job) => {
      const { reason, ...options } = job.attrs.data || {};
      await this.runScheduledAnalysis(options);
    });
  }

  /**
   * Setup event handlers for monitoring
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {
      console.log('[SCHEDULED BULK] Agenda ready - scheduled job listeners attached');
    });

    this.agenda.on('start', (job) => {
      if (job.attrs.name.includes('bulk-analysis')) {
        console.log(`[SCHEDULED BULK] ▶️  Job started: ${job.attrs.name} at ${new Date().toISOString()}`);
      }
    });

    this.agenda.on('complete', (job) => {
      if (job.attrs.name.includes('bulk-analysis')) {
        console.log(`[SCHEDULED BULK] ✅ Job completed: ${job.attrs.name} at ${new Date().toISOString()}`);
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

    } catch (error) {
      console.error('❌ [SCHEDULED BULK] Failed to schedule recurring jobs:', error);
      throw error;
    }
  }

  /**
   * Main function that runs at 4:30 PM
   * @param {Object} options
   * @param {string} [options.source='chartink'] - Which watchlist to analyze: 'chartink', 'screener', or 'all'
   * @param {boolean} [options.skipTradingDayCheck=false] - Skip trading day check (for manual triggers)
   */
  async runScheduledAnalysis(options = {}) {
    const {
      source = 'chartink',  // Default to ChartInk only
      skipTradingDayCheck = false
    } = options;

    // Check if already running
    if (this.isRunning) {
      console.log('[SCHEDULED BULK] Already running, skipping duplicate trigger');
      return;
    }

    // Check if today is a trading day (skip holidays)
    const today = new Date();
    const runLabel = `[SCHEDULED BULK ${today.toISOString()}]`;
    const istNow = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata', hour12: false }).replace(' ', 'T') + '+05:30';
    console.log(`${runLabel} 🚀 Starting scheduled bulk analysis (source=${source}) at ${istNow}`);

    if (!skipTradingDayCheck) {
      const isTradingDay = await MarketHoursUtil.isTradingDay(today);
      if (!isTradingDay) {
        console.log(`⏭️  [SCHEDULED BULK] ${today.toISOString().split('T')[0]} is not a trading day, skipping analysis`);
        return;
      }
    }

    this.isRunning = true;
    this.stats.totalRuns++;

    try {
      // STEP 0: Sync watchlists from Screener.in (only if source includes screener)
      if (source === 'screener' || source === 'all') {
        console.log('[SCHEDULED BULK] 🔄 Step 0: Syncing watchlists from Screener.in...');
        const syncResult = await syncScreenerWatchlist({
          StockModel: Stock,
          UserModel: User,
          dryRun: false
        });

        if (!syncResult.success) {
          console.error('[SCHEDULED BULK] ❌ Screener sync failed:', syncResult.error);
          console.log('[SCHEDULED BULK] Continuing with existing watchlists...');
        } else {
          console.log(`[SCHEDULED BULK] ✅ Screener sync complete: ${syncResult.matchedStocksCount} stocks synced to ${syncResult.usersUpdated} users`);
        }
      }

      // 1. Get all users
      const users = await User.find({}).select('_id email name watchlist').lean();
      console.log(`[SCHEDULED BULK] 👥 Loaded ${users.length} users`);

      // 2. Collect all unique stocks from watchlists
      const stockMap = new Map();
      let totalWatchlistItems = 0;

      // 2a. Collect from User.watchlist (Screener.in stocks)
      if (source === 'screener' || source === 'all') {
        console.log('[SCHEDULED BULK] 📋 Collecting stocks from User.watchlist (Screener)...');
        for (const user of users) {
          if (user.watchlist && user.watchlist.length > 0) {
            totalWatchlistItems += user.watchlist.length;

            for (const item of user.watchlist) {
              if (item.instrument_key) {
                if (!stockMap.has(item.instrument_key)) {
                  stockMap.set(item.instrument_key, {
                    instrument_key: item.instrument_key,
                    trading_symbol: item.trading_symbol || '',
                    name: item.name || '',
                    users: [],
                    source: 'screener'
                  });
                }
                stockMap.get(item.instrument_key).users.push(user._id);
              }
            }
          }
        }
        console.log(`[SCHEDULED BULK] 📋 Collected ${stockMap.size} stocks from User.watchlist`);
      }

      // 2b. Collect from WeeklyWatchlist (ChartInk screened stocks - GLOBAL, no user_id)
      let activeWeeklyWatchlist = null;
      let weeklyWatchlistStocksAdded = 0;
      if (source === 'chartink' || source === 'all') {
        console.log('[SCHEDULED BULK] 📊 Collecting stocks from WeeklyWatchlist (ChartInk - Global)...');
        // Get current week's global watchlist
        activeWeeklyWatchlist = await WeeklyWatchlist.getCurrentWeek();

        if (activeWeeklyWatchlist && activeWeeklyWatchlist.stocks?.length > 0) {
          for (const stock of activeWeeklyWatchlist.stocks) {
            // Only include stocks that are still actionable (WATCHING, APPROACHING, TRIGGERED)
            if (!['WATCHING', 'APPROACHING', 'TRIGGERED'].includes(stock.status)) {
              continue;
            }

            if (stock.instrument_key) {
              totalWatchlistItems++;

              if (!stockMap.has(stock.instrument_key)) {
                stockMap.set(stock.instrument_key, {
                  instrument_key: stock.instrument_key,
                  trading_symbol: stock.symbol || '',
                  name: stock.stock_name || '',
                  users: [],  // Empty - global watchlist, analyzed once for all users
                  source: 'chartink',
                  scan_type: stock.scan_type,  // breakout, pullback, momentum, consolidation_breakout
                  setup_score: stock.setup_score,
                  weeklyWatchlistStockId: stock._id  // Track for linking analysis later
                });
                weeklyWatchlistStocksAdded++;
              }
            }
          }
          console.log(`[SCHEDULED BULK] 📊 Added ${weeklyWatchlistStocksAdded} unique stocks from global WeeklyWatchlist`);
        } else {
          console.log('[SCHEDULED BULK] 📊 No active WeeklyWatchlist found or no stocks in it');
        }
      }

      const uniqueStocks = Array.from(stockMap.values());

      if (uniqueStocks.length === 0) {
        console.log('[SCHEDULED BULK] No watchlist stocks found across users, skipping');
        return;
      }

      // 3. Fetch prices for all unique stocks at once

      const instrumentKeys = uniqueStocks.map((stock) => stock.instrument_key);
      const priceFetchStart = Date.now();
      const priceMap = await priceCacheService.getLatestPrices(instrumentKeys);
      console.log(`[SCHEDULED BULK] 💰 Fetched latest prices for ${instrumentKeys.length} unique stocks in ${Date.now() - priceFetchStart}ms`);

      // No delayed release - analysis visible immediately after 7:30 AM run
      const releaseTime = null;

      // 4. Check existing strategies and decide: VALIDATE or CREATE pending record

      let recordsCreated = 0;
      let recordsToValidate = 0;
      let recordsSkipped = 0;

      const StockAnalysis = (await import('../models/stockAnalysis.js')).default;

      for (const stock of uniqueStocks) {
        const current_price = priceMap[stock.instrument_key];

        if (!current_price || isNaN(current_price) || current_price <= 0) {

          recordsSkipped++;
          continue;
        }

        // Get stock details from database
        let stockDetails;
        try {
          stockDetails = await Stock.findOne({ instrument_key: stock.instrument_key }).lean();
          if (!stockDetails) {

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

            } else {
              // Strategy still valid - skip
              recordsSkipped++;

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

          }
        } catch (error) {
          console.error(`  ❌ Failed to check/create record for ${stock.trading_symbol}:`, error.message);
          recordsSkipped++;
        }
      }

      // 5. Analyze each stock for each user who has it in their watchlist - PARALLEL PROCESSING
      let analysisCount = 0;
      let successCount = 0;
      let failureCount = 0;
      let skippedCount = 0;
      const candleLogged = new Set();

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
      const CONCURRENCY_LIMIT = 5; // Safe for Tier 1, increase to 10 for Tier 2+
      const limit = pLimit(CONCURRENCY_LIMIT);

      const bulkStartTime = Date.now();

      // Create analysis tasks for all stocks
      const analysisTasks = [];

      for (const stock of uniqueStocks) {
        // Get price from our pre-fetched priceMap
        const current_price = priceMap[stock.instrument_key];
        if (!current_price || isNaN(current_price) || current_price <= 0) {
          // Skip count is 1 for global watchlist stocks (no users), or users.length for screener stocks
          skippedCount += stock.users.length > 0 ? stock.users.length : 1;
          continue;
        }

        // For global WeeklyWatchlist stocks (ChartInk), analyze once with no specific user
        // For screener stocks, analyze for each user who has it in their watchlist
        const usersToAnalyze = stock.users.length > 0 ? stock.users : [null];

        for (const userId of usersToAnalyze) {
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
                  user_id: userId ? userId.toString() : null,  // null for global watchlist stocks
                  skipNotification: true, // Skip notifications for scheduled bulk pre-analysis
                  scheduled_release_time: releaseTime, // null = visible immediately
                  skipIntraday: false, // Use previous day's data for pre-market analysis
                  // ChartInk screening context
                  scan_type: stock.scan_type,  // breakout, pullback, momentum, consolidation_breakout
                  setup_score: stock.setup_score
                });
              });

              const taskTime = Date.now() - taskStartTime;

              if (result.success) {
                if (result.cached) {
                  skippedCount++;
                } else {
                  successCount++;

                  // Link analysis to WeeklyWatchlist stock if this is a ChartInk stock
                  if (stock.source === 'chartink' && stock.weeklyWatchlistStockId && result.data?._id) {
                    try {
                      await WeeklyWatchlist.linkAnalysis(
                        stock.instrument_key,
                        result.data._id,
                        result.data?.recommendation?.summary || null
                      );
                    } catch (linkError) {
                      console.warn(`[SCHEDULED BULK] ⚠️ Failed to link analysis for ${stock.trading_symbol}:`, linkError.message);
                    }
                  }
                }
                if (!candleLogged.has(stock.instrument_key) && result.data) {
                  const candleInfo =
                    result.data?.analysis_meta?.candle_info ||
                    result.data?.analysis_data?.analysis_meta?.candle_info ||
                    result.data?.analysis_data?.meta?.candle_info ||
                    result.data?.meta?.candle_info;
                  if (candleInfo) {
                    const frames = (candleInfo.timeframes_used || [])
                      .map((tf) => `${tf.key || tf.timeframe || 'n/a'}:${tf.last_candle_time || 'n/a'}`)
                      .join(', ');
                    console.log(
                      `[SCHEDULED BULK] 🕒 Candles for ${stock.trading_symbol || stock.instrument_key} ` +
                      `(cached=${result.cached ? 'yes' : 'no'}): primary=${candleInfo.primary_timeframe || 'n/a'}, ` +
                      `last=${candleInfo.last_candle_time || 'n/a'}, frames=${frames || 'none'}`
                    );
                  } else {
                    console.log(
                      `[SCHEDULED BULK] ⚠️  No candle metadata found for ${stock.trading_symbol || stock.instrument_key} ` +
                      `(cached=${result.cached ? 'yes' : 'no'})`
                    );
                  }
                  candleLogged.add(stock.instrument_key);
                }
              } else {
                failureCount++;
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

      await Promise.all(analysisTasks);

      const bulkTotalTime = Date.now() - bulkStartTime;

      // 4. Summary
      const screenerStocks = uniqueStocks.filter(s => s.source === 'screener').length;
      const chartinkStocks = uniqueStocks.filter(s => s.source === 'chartink').length;
      const summary = {
        date: today.toISOString().split('T')[0],
        totalAnalyses: analysisCount,
        successful: successCount,
        skipped: skippedCount,
        failed: failureCount,
        uniqueStocks: uniqueStocks.length,
        screenerStocks,
        chartinkStocks,
        totalUsers: users.length,
        hasActiveWeeklyWatchlist: !!activeWeeklyWatchlist,
        weeklyWatchlistStocks: activeWeeklyWatchlist?.stocks?.length || 0
      };
      console.log(
        `${runLabel} 🧾 Summary: uniqueStocks=${summary.uniqueStocks} (screener=${screenerStocks}, chartink=${chartinkStocks}), ` +
        `totalAnalyses=${summary.totalAnalyses}, success=${summary.successful}, skipped=${summary.skipped}, failed=${summary.failed}, ` +
        `users=${summary.totalUsers}, weeklyWatchlistStocks=${summary.weeklyWatchlistStocks}, duration_ms=${bulkTotalTime}`
      );

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

    }
  }

  /**
   * Helper: Delay function
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

        await this.delay(totalDelay);
        retries++;
      }
    }
  }

  /**
   * Manual trigger for testing
   * @param {string} [reason='Manual trigger'] - Reason for trigger
   * @param {Object} [options={}] - Options to pass to runScheduledAnalysis
   * @param {string} [options.source='chartink'] - 'chartink', 'screener', or 'all'
   * @param {boolean} [options.skipTradingDayCheck=false] - Skip trading day check
   */
  async triggerManually(reason = 'Manual trigger', options = {}) {
    try {
      const job = await this.agenda.now('manual-watchlist-bulk-analysis', { reason, ...options });

      return {
        success: true,
        jobId: job.attrs._id,
        jobName: 'manual-watchlist-bulk-analysis',
        scheduledAt: job.attrs.nextRunAt,
        options
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
        jobs: jobs.map((job) => ({
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

      if (this.agenda) {
        await this.agenda.stop();

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

    } catch (error) {
      console.error('❌ [SCHEDULED BULK] Error resuming jobs:', error);
      throw error;
    }
  }
}

// Export singleton instance
const agendaScheduledBulkAnalysisService = new AgendaScheduledBulkAnalysisService();
export default agendaScheduledBulkAnalysisService;
