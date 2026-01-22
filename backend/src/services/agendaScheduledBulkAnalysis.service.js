/**
 * Agenda-based Scheduled Bulk Analysis Service
 *
 * PURPOSE: Discovery Mode (Swing Analysis) - analyze stocks for NEW trade opportunities
 *
 * USAGE:
 * - Weekend ChartInk screening (manual trigger with analyzeAllChartink=true)
 * - Manual trigger for testing/debugging
 *
 * NOTE: Daily 4 PM swing re-analysis is DISABLED.
 * - Position management for weekly_track stocks → weeklyTrackAnalysisJob.js (4:00 PM)
 * - Swing analysis has weekly cache validity (until Friday 3:30 PM)
 * - Manual stocks get swing analysis on-demand via "Analyze" button
 *
 * Sources:
 * - User.watchlist: Per-user stocks from Screener.in sync
 * - WeeklyWatchlist: Global stocks from ChartInk weekend screening (shared by all users)
 *
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
import { fetchAndCheckRegime } from '../engine/index.js';

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
      console.log('[SCHEDULED BULK] Initializing Agenda service...');

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

      // Define the job BEFORE waiting for ready
      this.defineJobs();

      // Setup event handlers
      this.setupEventHandlers();

      // Wait for Agenda's MongoDB connection to be ready before starting
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Agenda MongoDB connection timeout after 30s'));
        }, 30000);

        this.agenda.on('ready', () => {
          clearTimeout(timeout);
          console.log('[SCHEDULED BULK] Agenda MongoDB connection ready');
          resolve();
        });

        this.agenda.on('error', (err) => {
          clearTimeout(timeout);
          console.error('[SCHEDULED BULK] Agenda error:', err);
          reject(err);
        });
      });

      // Start agenda processing AFTER connection is ready
      await this.agenda.start();
      console.log('[SCHEDULED BULK] Agenda started processing jobs');

      // Schedule the recurring job
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log('[SCHEDULED BULK] ✅ Initialization complete');

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
   *
   * NOTE: The 4 PM daily swing re-analysis is DISABLED.
   *
   * Reason:
   * - Swing analysis has weekly validity (until Friday 3:30 PM)
   * - Position management for weekly_track stocks is handled by weeklyTrackAnalysisJob.js at 4:00 PM
   * - Manual stocks need swing analysis first (on-demand via "Analyze" button)
   * - Running swing re-analysis daily with forceRevalidate=true was expensive (250+ AI calls/week)
   *
   * This service is still used for:
   * - Weekend ChartInk screening (via manual trigger with analyzeAllChartink=true)
   * - Manual trigger for testing
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel any existing jobs to avoid duplicates
      await this.agenda.cancel({
        name: 'watchlist-bulk-analysis'
      });

      // DISABLED: Daily 4 PM swing re-analysis
      // Position management is handled by weeklyTrackAnalysisJob.js
      // Swing analysis uses weekly cache (valid until Friday 3:30 PM)
      //
      // await this.agenda.every('0 16 * * 1-5', 'watchlist-bulk-analysis', {
      //   source: 'screener',
      //   forceRevalidate: true
      // }, {
      //   timezone: 'Asia/Kolkata'
      // });

      console.log('[SCHEDULED BULK] No recurring jobs scheduled (4 PM swing re-analysis disabled)');
      console.log('[SCHEDULED BULK] Position management is handled by weeklyTrackAnalysisJob.js at 4:00 PM');

    } catch (error) {
      console.error('❌ [SCHEDULED BULK] Failed to schedule recurring jobs:', error);
      throw error;
    }
  }

  /**
   * Main function that runs at 4:30 PM
   * @param {Object} options
   * @param {string} [options.source='screener'] - Which watchlist to analyze: 'chartink', 'screener', or 'all'
   * @param {boolean} [options.skipTradingDayCheck=false] - Skip trading day check (for manual triggers)
   * @param {boolean} [options.analyzeAllChartink=false] - If true, analyze ALL ChartInk stocks even if not in user watchlists
   * @param {boolean} [options.useLastFridayData=false] - If true, use only Friday's closing data (for weekend screening)
   * @param {boolean} [options.forceRevalidate=false] - If true, re-analyze stocks even if they have valid cached analysis
   */
  async runScheduledAnalysis(options = {}) {
    const {
      source = 'screener',  // Default to Screener.in user watchlists only
      skipTradingDayCheck = false,
      analyzeAllChartink = false,  // When triggered from weekend screening, set this to true
      useLastFridayData = false,   // When triggered from weekend screening, use only Friday's data
      forceRevalidate = false      // When true, re-analyze even if cached (for 4 PM refresh)
    } = options;

    // Check if already running
    if (this.isRunning) {
      console.log('[SCHEDULED BULK] Already running, skipping duplicate trigger');
      return;
    }

    // Check if today is a trading day (skip holidays)
    const today = new Date();
    const runLabel = `[BULK-4PM]`;
    const istNow = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata', hour12: false }).replace(' ', 'T') + '+05:30';

    console.log(`\n${'='.repeat(80)}`);
    console.log(`${runLabel} 🚀 STEP 0: STARTING BULK ANALYSIS JOB`);
    console.log(`${'='.repeat(80)}`);
    console.log(`${runLabel} ⏰ Start Time (IST): ${istNow}`);
    console.log(`${runLabel} ⏰ Start Time (UTC): ${today.toISOString()}`);
    console.log(`${runLabel} 🔧 Options received:`);
    console.log(`${runLabel}    - source: ${source}`);
    console.log(`${runLabel}    - skipTradingDayCheck: ${skipTradingDayCheck}`);
    console.log(`${runLabel}    - analyzeAllChartink: ${analyzeAllChartink}`);
    console.log(`${runLabel}    - useLastFridayData: ${useLastFridayData}`);
    console.log(`${runLabel}    - forceRevalidate: ${forceRevalidate}`);

    if (analyzeAllChartink) {
      console.log(`${runLabel} ✅ analyzeAllChartink=true → Will analyze ALL ChartInk stocks from WeeklyWatchlist`);
    } else {
      console.log(`${runLabel} ℹ️  analyzeAllChartink=false → Will only analyze stocks that overlap with user watchlists`);
    }
    if (useLastFridayData) {
      console.log(`${runLabel} 📅 useLastFridayData=true → Using only Friday's closing data for weekly analysis`);
    }
    if (forceRevalidate) {
      console.log(`${runLabel} 🔄 forceRevalidate=true → Will RE-ANALYZE all stocks with latest data (ignoring cache)`);
    }

    // if (!skipTradingDayCheck) {
    //   const isTradingDay = await MarketHoursUtil.isTradingDay(today);
    //   if (!isTradingDay) {
    //     console.log(`⏭️  [SCHEDULED BULK] ${today.toISOString().split('T')[0]} is not a trading day, skipping analysis`);
    //     return;
    //   }
    // }

    this.isRunning = true;
    this.stats.totalRuns++;

    try {
      // STEP 1: Sync watchlists from Screener.in (only if source includes screener)
      console.log(`\n${runLabel} ${'─'.repeat(60)}`);
      console.log(`${runLabel} 📋 STEP 1: SYNC SCREENER WATCHLISTS`);
      console.log(`${runLabel} ${'─'.repeat(60)}`);

      if (source === 'screener' || source === 'all') {
        console.log(`${runLabel} 🔄 Syncing watchlists from Screener.in...`);
        const syncResult = await syncScreenerWatchlist({
          StockModel: Stock,
          UserModel: User,
          dryRun: false
        });

        if (!syncResult.success) {
          console.error(`${runLabel} ❌ Screener sync failed:`, syncResult.error);
          console.log(`${runLabel} ⚠️ Continuing with existing watchlists...`);
        } else {
          console.log(`${runLabel} ✅ Screener sync complete: ${syncResult.matchedStocksCount} stocks synced to ${syncResult.usersUpdated} users`);
        }
      } else {
        console.log(`${runLabel} ⏭️ SKIPPED (source=${source}, not 'screener' or 'all')`);
      }

      // STEP 2: Load all users
      console.log(`\n${runLabel} ${'─'.repeat(60)}`);
      console.log(`${runLabel} 👥 STEP 2: LOAD ALL USERS`);
      console.log(`${runLabel} ${'─'.repeat(60)}`);

      const users = await User.find({}).select('_id email name watchlist').lean();
      console.log(`${runLabel} ✅ Loaded ${users.length} users from database`);

      // Show users with watchlists
      const usersWithWatchlist = users.filter(u => u.watchlist && u.watchlist.length > 0);
      console.log(`${runLabel} 📊 Users with watchlist items: ${usersWithWatchlist.length}/${users.length}`);
      usersWithWatchlist.forEach(u => {
        console.log(`${runLabel}    - ${u.email || u.name || u._id}: ${u.watchlist.length} stocks`);
      });

      // STEP 3: Collect stocks from user watchlists (Screener.in)
      console.log(`\n${runLabel} ${'─'.repeat(60)}`);
      console.log(`${runLabel} 📊 STEP 3: COLLECT STOCKS FROM USER WATCHLISTS`);
      console.log(`${runLabel} ${'─'.repeat(60)}`);

      const stockMap = new Map();
      let totalWatchlistItems = 0;

      // 3a. Collect from User.watchlist (Screener.in stocks)
      if (source === 'screener' || source === 'all') {
        console.log(`${runLabel} 🔍 Scanning User.watchlist (Screener source)...`);
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
        console.log(`${runLabel} ✅ Collected ${stockMap.size} unique stocks from User.watchlist`);
        if (stockMap.size > 0) {
          console.log(`${runLabel} 📝 User watchlist stocks:`);
          Array.from(stockMap.values()).forEach(s => {
            console.log(`${runLabel}    - ${s.trading_symbol || s.instrument_key} (${s.users.length} users)`);
          });
        }
      } else {
        console.log(`${runLabel} ⏭️ SKIPPED (source=${source}, not 'screener' or 'all')`);
      }

      // STEP 4: Collect stocks from WeeklyWatchlist (ChartInk screened stocks)
      console.log(`\n${runLabel} ${'─'.repeat(60)}`);
      console.log(`${runLabel} 📊 STEP 4: COLLECT STOCKS FROM CHARTINK (WeeklyWatchlist)`);
      console.log(`${runLabel} ${'─'.repeat(60)}`);

      // Behavior depends on analyzeAllChartink flag:
      // - analyzeAllChartink=true (weekend screening trigger): Analyze ALL ChartInk stocks
      // - analyzeAllChartink=false (daily 4PM job): Only re-analyze stocks in user watchlists
      let activeWeeklyWatchlist = null;
      let weeklyWatchlistStocksAdded = 0;
      let weeklyWatchlistStocksSkipped = 0;

      if (source === 'chartink' || source === 'all') {
        console.log(`${runLabel} 🔍 Fetching WeeklyWatchlist.getCurrentWeek()...`);
        console.log(`${runLabel} 🔧 analyzeAllChartink=${analyzeAllChartink}`);
        console.log(`${runLabel}    - true  → Analyze ALL ChartInk stocks (weekend screening behavior)`);
        console.log(`${runLabel}    - false → Only analyze ChartInk stocks that overlap with user watchlists`);

        // Get current week's global watchlist
        activeWeeklyWatchlist = await WeeklyWatchlist.getCurrentWeek();

        if (activeWeeklyWatchlist && activeWeeklyWatchlist.stocks?.length > 0) {
          console.log(`${runLabel} ✅ Found WeeklyWatchlist with ${activeWeeklyWatchlist.stocks.length} total stocks`);
          console.log(`${runLabel} 📅 Week: ${activeWeeklyWatchlist.week_start?.toISOString()} to ${activeWeeklyWatchlist.week_end?.toISOString()}`);

          // List all ChartInk stocks
          console.log(`${runLabel} 📝 ChartInk stocks in WeeklyWatchlist:`);
          for (const stock of activeWeeklyWatchlist.stocks) {
            const statusIcon = ['WATCHING', 'APPROACHING', 'TRIGGERED'].includes(stock.status) ? '✅' : '⏭️';
            console.log(`${runLabel}    ${statusIcon} ${stock.symbol || stock.trading_symbol} (${stock.scan_type}, status=${stock.status})`);
          }

          for (const stock of activeWeeklyWatchlist.stocks) {
            // Only include stocks that are still actionable (WATCHING, APPROACHING, TRIGGERED)
            if (!['WATCHING', 'APPROACHING', 'TRIGGERED'].includes(stock.status)) {
              console.log(`${runLabel}    ⏭️ Skipping ${stock.symbol} - status=${stock.status} (not actionable)`);
              continue;
            }

            if (stock.instrument_key) {
              // Check if this ChartInk stock is already in stockMap (from User.watchlist)
              if (stockMap.has(stock.instrument_key)) {
                // Stock is in a user's watchlist - enrich with ChartInk metadata
                const existingStock = stockMap.get(stock.instrument_key);
                existingStock.source = 'both';  // Mark as both screener + chartink
                existingStock.scan_type = stock.scan_type;
                existingStock.setup_score = stock.setup_score;
                existingStock.weeklyWatchlistStockId = stock._id;
                weeklyWatchlistStocksAdded++;
                totalWatchlistItems++;
                console.log(`${runLabel}    🔗 ${stock.symbol} - OVERLAP with user watchlist (added)`);
              } else if (analyzeAllChartink) {
                // analyzeAllChartink=true: Add stock even if not in user watchlist
                // This is used when triggered from weekend screening
                // Note: WeeklyWatchlist uses 'symbol' and 'stock_name', not 'trading_symbol' and 'name'
                stockMap.set(stock.instrument_key, {
                  instrument_key: stock.instrument_key,
                  trading_symbol: stock.symbol || stock.trading_symbol || '',
                  name: stock.stock_name || stock.name || '',
                  users: [],  // No specific users - global analysis
                  source: 'chartink',
                  scan_type: stock.scan_type,
                  setup_score: stock.setup_score,
                  weeklyWatchlistStockId: stock._id
                });
                weeklyWatchlistStocksAdded++;
                totalWatchlistItems++;
                console.log(`${runLabel}    ➕ ${stock.symbol} - ADDED (analyzeAllChartink=true)`);
              } else {
                // analyzeAllChartink=false: Skip - daily job only re-analyzes user watchlist stocks
                weeklyWatchlistStocksSkipped++;
                console.log(`${runLabel}    ⏭️ ${stock.symbol} - SKIPPED (not in user watchlist, analyzeAllChartink=false)`);
              }
            }
          }

          console.log(`\n${runLabel} 📊 ChartInk summary:`);
          console.log(`${runLabel}    - Total in WeeklyWatchlist: ${activeWeeklyWatchlist.stocks.length}`);
          console.log(`${runLabel}    - Will analyze: ${weeklyWatchlistStocksAdded}`);
          console.log(`${runLabel}    - Skipped: ${weeklyWatchlistStocksSkipped}`);

          if (weeklyWatchlistStocksSkipped > 0 && !analyzeAllChartink) {
            console.log(`${runLabel} ⚠️ ${weeklyWatchlistStocksSkipped} ChartInk stocks skipped because analyzeAllChartink=false`);
            console.log(`${runLabel} 💡 To analyze ALL ChartInk stocks, trigger with analyzeAllChartink=true`);
          }
        } else {
          console.log(`${runLabel} ⚠️ No active WeeklyWatchlist found or no stocks in it`);
          console.log(`${runLabel}    - activeWeeklyWatchlist: ${activeWeeklyWatchlist ? 'exists' : 'null'}`);
          console.log(`${runLabel}    - stocks.length: ${activeWeeklyWatchlist?.stocks?.length || 0}`);
        }
      } else {
        console.log(`${runLabel} ⏭️ SKIPPED (source=${source}, not 'chartink' or 'all')`);
      }

      // STEP 5: Final stock list summary
      console.log(`\n${runLabel} ${'─'.repeat(60)}`);
      console.log(`${runLabel} 📋 STEP 5: FINAL STOCK LIST SUMMARY`);
      console.log(`${runLabel} ${'─'.repeat(60)}`);

      const uniqueStocks = Array.from(stockMap.values());

      console.log(`${runLabel} 📊 Total unique stocks to analyze: ${uniqueStocks.length}`);

      if (uniqueStocks.length === 0) {
        console.log(`${runLabel} ❌ NO STOCKS TO ANALYZE - EXITING JOB`);
        console.log(`${runLabel} ⚠️ Reason: source=${source}, analyzeAllChartink=${analyzeAllChartink}`);
        console.log(`${runLabel} 💡 If triggered from weekend screening, ensure analyzeAllChartink=true was passed`);
        return;
      }

      // List all stocks that will be analyzed
      console.log(`${runLabel} 📝 Stocks to analyze:`);
      uniqueStocks.forEach((s, i) => {
        console.log(`${runLabel}    ${i + 1}. ${s.trading_symbol || s.instrument_key} (source=${s.source}, users=${s.users.length})`);
      });

      // STEP 6: Fetch prices
      console.log(`\n${runLabel} ${'─'.repeat(60)}`);
      console.log(`${runLabel} 💰 STEP 6: FETCH LATEST PRICES`);
      console.log(`${runLabel} ${'─'.repeat(60)}`);

      const instrumentKeys = uniqueStocks.map((stock) => stock.instrument_key);
      console.log(`${runLabel} 🔍 Fetching prices for ${instrumentKeys.length} stocks...`);
      const priceFetchStart = Date.now();
      const priceMap = await priceCacheService.getLatestPrices(instrumentKeys);
      console.log(`${runLabel} ✅ Fetched prices in ${Date.now() - priceFetchStart}ms`);

      // Log prices
      console.log(`${runLabel} 📝 Prices fetched:`);
      uniqueStocks.forEach(s => {
        const price = priceMap[s.instrument_key];
        const priceStatus = (price && !isNaN(price) && price > 0) ? `₹${price.toFixed(2)}` : '❌ MISSING/INVALID';
        console.log(`${runLabel}    - ${s.trading_symbol || s.instrument_key}: ${priceStatus}`);
      });

      // No delayed release - analysis visible immediately after 7:30 AM run
      const releaseTime = null;

      // STEP 7: Check existing strategies
      console.log(`\n${runLabel} ${'─'.repeat(60)}`);
      console.log(`${runLabel} 🔍 STEP 7: CHECK EXISTING STRATEGIES`);
      console.log(`${runLabel} ${'─'.repeat(60)}`);

      let recordsCreated = 0;
      let recordsToValidate = 0;
      let recordsSkipped = 0;

      const StockAnalysis = (await import('../models/stockAnalysis.js')).default;

      for (const stock of uniqueStocks) {
        const current_price = priceMap[stock.instrument_key];

        if (!current_price || isNaN(current_price) || current_price <= 0) {
          console.log(`${runLabel}    ⏭️ ${stock.trading_symbol} - SKIP (no valid price)`);
          recordsSkipped++;
          continue;
        }

        // Get stock details from database
        let stockDetails;
        try {
          stockDetails = await Stock.findOne({ instrument_key: stock.instrument_key }).lean();
          if (!stockDetails) {
            console.log(`${runLabel}    ⏭️ ${stock.trading_symbol} - SKIP (not found in Stock collection)`);
            recordsSkipped++;
            continue;
          }
        } catch (error) {
          console.error(`${runLabel}    ❌ ${stock.trading_symbol} - ERROR fetching details: ${error.message}`);
          recordsSkipped++;
          continue;
        }

        try {
          // Check if existing completed strategy exists
          const existing = await StockAnalysis.findByInstrument(stock.instrument_key, 'swing');

          // Valid completed statuses: completed, in_position, exited, expired
          const completedStatuses = ['completed', 'in_position', 'exited', 'expired'];
          if (existing && completedStatuses.includes(existing.status) && existing.valid_until) {
            const now = new Date();

            if (forceRevalidate) {
              // forceRevalidate=true: Re-analyze regardless of cache validity
              recordsToValidate++;
              console.log(`${runLabel}    🔄 ${stock.trading_symbol} - FORCE REVALIDATE (ignoring cache, valid_until=${existing.valid_until.toISOString()})`);
            } else if (now > existing.valid_until) {
              // Strategy expired - will be validated by analyzeStock()
              recordsToValidate++;
              console.log(`${runLabel}    🔄 ${stock.trading_symbol} - EXPIRED (valid_until=${existing.valid_until.toISOString()}) → will re-analyze`);
            } else {
              // Strategy still valid - skip
              recordsSkipped++;
              console.log(`${runLabel}    ✅ ${stock.trading_symbol} - VALID (valid_until=${existing.valid_until.toISOString()}) → cache hit`);
              continue;
            }
          } else {
            // No existing strategy or not completed - create pending record
            // Use weekly expiry for ALL swing analysis (valid until Friday 3:29:59 PM)
            await aiAnalyzeService.createPendingAnalysisRecord({
              instrument_key: stock.instrument_key,
              stock_name: stockDetails.name,
              stock_symbol: stockDetails.trading_symbol,
              analysis_type: 'swing',
              current_price: current_price,
              scheduled_release_time: releaseTime,
              useWeeklyExpiry: true  // All swing analyses use weekly expiry
            });
            recordsCreated++;
            console.log(`${runLabel}    ➕ ${stock.trading_symbol} - NEW pending record created`);
          }
        } catch (error) {
          console.error(`${runLabel}    ❌ ${stock.trading_symbol} - ERROR: ${error.message}`);
          recordsSkipped++;
        }
      }

      console.log(`\n${runLabel} 📊 Strategy check summary:`);
      console.log(`${runLabel}    - New pending records: ${recordsCreated}`);
      console.log(`${runLabel}    - Expired (will re-analyze): ${recordsToValidate}`);
      console.log(`${runLabel}    - Skipped (valid cache or error): ${recordsSkipped}`);

      // STEP 8: Run AI Analysis
      console.log(`\n${runLabel} ${'─'.repeat(60)}`);
      console.log(`${runLabel} 🤖 STEP 8: RUN AI ANALYSIS (PARALLEL)`);
      console.log(`${runLabel} ${'─'.repeat(60)}`);

      let analysisCount = 0;
      let successCount = 0;
      let failureCount = 0;
      let skippedCount = 0;
      const candleLogged = new Set();

      // Configure concurrency limit based on OpenAI rate limits
      const CONCURRENCY_LIMIT = 5; // Safe for Tier 1, increase to 10 for Tier 2+
      const limit = pLimit(CONCURRENCY_LIMIT);

      console.log(`${runLabel} ⚙️ Concurrency limit: ${CONCURRENCY_LIMIT} parallel analyses`);

      const bulkStartTime = Date.now();

      // Fetch market regime once for all stocks (Nifty 50 vs 50 EMA)
      console.log(`${runLabel} 📊 Fetching market regime (Nifty 50 vs 50 EMA)...`);
      let regimeCheck = null;
      try {
        regimeCheck = await fetchAndCheckRegime();
        console.log(`${runLabel} ✅ Market regime: ${regimeCheck.regime} (Nifty ${regimeCheck.distancePct?.toFixed(2)}% from 50 EMA)`);
      } catch (regimeError) {
        console.warn(`${runLabel} ⚠️ Failed to fetch market regime: ${regimeError.message}`);
        // Continue without regime - analyses will proceed without the warning
      }

      // Create analysis tasks for all stocks
      const analysisTasks = [];
      const totalStocksToAnalyze = uniqueStocks.filter(s => {
        const price = priceMap[s.instrument_key];
        return price && !isNaN(price) && price > 0;
      }).length;

      console.log(`${runLabel} 🚀 Starting parallel analysis of ${totalStocksToAnalyze} stocks...`);
      console.log(`${runLabel} ${'─'.repeat(40)}`);

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
            const taskNum = analysisCount;
            const taskStartTime = Date.now();

            console.log(`${runLabel} 🔄 [${taskNum}/${totalStocksToAnalyze}] ANALYZING: ${stock.trading_symbol} @ ₹${current_price.toFixed(2)}`);

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
                  setup_score: stock.setup_score,
                  // Market regime context (for BUY setups in bearish market warnings)
                  regimeCheck,
                  // Weekly analysis - use only Friday's closing data (for weekend screening)
                  useLastFridayData,
                  // Force re-analysis even if cached (for 4 PM refresh with latest data)
                  forceRevalidate
                });
              });

              const taskTime = Date.now() - taskStartTime;

              if (result.success) {
                if (result.cached) {
                  skippedCount++;
                  console.log(`${runLabel} ⏭️ [${taskNum}/${totalStocksToAnalyze}] ${stock.trading_symbol} - CACHE HIT (${taskTime}ms)`);
                } else {
                  successCount++;
                  const action = result.data?.analysis_data?.recommendation?.action || result.data?.recommendation?.action || 'N/A';
                  console.log(`${runLabel} ✅ [${taskNum}/${totalStocksToAnalyze}] ${stock.trading_symbol} - SUCCESS → ${action} (${taskTime}ms)`);

                  // Link analysis to WeeklyWatchlist stock if this is a ChartInk stock
                  if (stock.source === 'chartink' && stock.weeklyWatchlistStockId && result.data?._id) {
                    try {
                      await WeeklyWatchlist.linkAnalysis(
                        stock.instrument_key,
                        result.data._id,
                        result.data?.recommendation?.summary || null
                      );
                      console.log(`${runLabel}    🔗 Linked to WeeklyWatchlist`);
                    } catch (linkError) {
                      console.warn(`${runLabel}    ⚠️ Failed to link to WeeklyWatchlist: ${linkError.message}`);
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
                      `${runLabel}    🕒 Candles: primary=${candleInfo.primary_timeframe || 'n/a'}, ` +
                      `last=${candleInfo.last_candle_time || 'n/a'}`
                    );
                  }
                  candleLogged.add(stock.instrument_key);
                }
              } else {
                failureCount++;
                console.log(`${runLabel} ❌ [${taskNum}/${totalStocksToAnalyze}] ${stock.trading_symbol} - FAILED: ${result.error || 'Unknown error'} (${taskTime}ms)`);
              }
            } catch (error) {
              failureCount++;
              const taskTime = Date.now() - taskStartTime;
              console.error(`${runLabel} ❌ [${taskNum}/${totalStocksToAnalyze}] ${stock.trading_symbol} - ERROR: ${error.message} (${taskTime}ms)`);
            }
          });

          analysisTasks.push(task);
        }
      }

      // Execute all tasks in parallel with concurrency limit
      console.log(`${runLabel} ⏳ Waiting for ${analysisTasks.length} analysis tasks to complete...`);
      await Promise.all(analysisTasks);

      const bulkTotalTime = Date.now() - bulkStartTime;

      // STEP 9: Final Summary
      console.log(`\n${runLabel} ${'='.repeat(80)}`);
      console.log(`${runLabel} 📊 STEP 9: FINAL SUMMARY`);
      console.log(`${runLabel} ${'='.repeat(80)}`);

      const screenerOnlyStocks = uniqueStocks.filter(s => s.source === 'screener').length;
      const chartinkOnlyStocks = uniqueStocks.filter(s => s.source === 'chartink').length;
      const bothSourceStocks = uniqueStocks.filter(s => s.source === 'both').length;  // In user watchlist + ChartInk

      const summary = {
        date: today.toISOString().split('T')[0],
        totalAnalyses: analysisCount,
        successful: successCount,
        skipped: skippedCount,
        failed: failureCount,
        uniqueStocks: uniqueStocks.length,
        screenerOnlyStocks,
        chartinkOnlyStocks,
        chartinkInWatchlist: bothSourceStocks,  // ChartInk stocks that users added to watchlist
        chartinkSkipped: weeklyWatchlistStocksSkipped,  // ChartInk stocks not in any watchlist (skipped)
        totalUsers: users.length,
        hasActiveWeeklyWatchlist: !!activeWeeklyWatchlist,
        weeklyWatchlistTotalStocks: activeWeeklyWatchlist?.stocks?.length || 0,
        durationMs: bulkTotalTime
      };

      console.log(`${runLabel} ⏱️ Total Duration: ${(bulkTotalTime / 1000).toFixed(1)} seconds`);
      console.log(`${runLabel}`);
      console.log(`${runLabel} 📈 ANALYSIS RESULTS:`);
      console.log(`${runLabel}    ✅ Successful: ${successCount}`);
      console.log(`${runLabel}    ⏭️ Skipped (cache hit): ${skippedCount}`);
      console.log(`${runLabel}    ❌ Failed: ${failureCount}`);
      console.log(`${runLabel}    📊 Total analyses: ${analysisCount}`);
      console.log(`${runLabel}`);
      console.log(`${runLabel} 📋 STOCK SOURCES:`);
      console.log(`${runLabel}    - Total unique stocks: ${uniqueStocks.length}`);
      console.log(`${runLabel}    - Screener only: ${screenerOnlyStocks}`);
      console.log(`${runLabel}    - ChartInk only: ${chartinkOnlyStocks}`);
      console.log(`${runLabel}    - Both sources (overlap): ${bothSourceStocks}`);
      console.log(`${runLabel}    - ChartInk skipped (analyzeAllChartink=false): ${weeklyWatchlistStocksSkipped}`);
      console.log(`${runLabel}`);
      console.log(`${runLabel} 👥 USERS: ${users.length}`);
      console.log(`${runLabel} 📅 WeeklyWatchlist: ${activeWeeklyWatchlist?.stocks?.length || 0} stocks`);
      console.log(`${runLabel} ${'='.repeat(80)}`);
      console.log(`${runLabel} ✅ BULK ANALYSIS JOB COMPLETED`);
      console.log(`${runLabel} ${'='.repeat(80)}\n`);

      // Update stats
      this.stats.successfulRuns++;
      this.stats.lastRunDate = today;
      this.stats.lastRunSummary = summary;

    } catch (error) {
      console.error(`\n${runLabel} ${'='.repeat(80)}`);
      console.error(`${runLabel} ❌ BULK ANALYSIS JOB FAILED`);
      console.error(`${runLabel} ${'='.repeat(80)}`);
      console.error(`${runLabel} Error:`, error.message);
      console.error(`${runLabel} Stack:`, error.stack);
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
