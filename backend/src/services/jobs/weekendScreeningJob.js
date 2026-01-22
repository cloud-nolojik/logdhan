/**
 * Weekend Screening Job
 *
 * Runs ChartInk scans and populates weekly watchlists
 * Schedule: Saturday 6 PM IST
 *
 * UPDATED: Now handles eliminated stocks (RSI > 72) and stores trading levels
 */

import Agenda from 'agenda';
import chartinkService from '../chartinkService.js';
import stockEnrichmentService from '../stockEnrichmentService.js';
import WeeklyWatchlist from '../../models/weeklyWatchlist.js';
import agendaScheduledBulkAnalysisService from '../agendaScheduledBulkAnalysis.service.js';
import { getCurrentPrice } from '../../utils/stockDb.js';
import priceCacheService from '../priceCache.service.js';

class WeekendScreeningJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.stats = {
      runsCompleted: 0,
      stocksProcessed: 0,
      stocksEliminated: 0,  // NEW: Track eliminated stocks
      errors: 0,
      lastRunAt: null
    };
  }

  /**
   * Initialize the job scheduler
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('[SCREENING JOB] Already initialized');
      return;
    }

    try {
      console.log('[SCREENING JOB] Initializing weekend screening job...');

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'weekend_screening_jobs',
          options: {
            useUnifiedTopology: true
          }
        },
        processEvery: '1 minute',
        maxConcurrency: 1,
        defaultConcurrency: 1
      });

      // Define jobs
      this.defineJobs();

      // Setup event handlers
      this.setupEventHandlers();

      // Start agenda
      await this.agenda.start();

      // Schedule recurring jobs
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log('[SCREENING JOB] Initialization complete');

    } catch (error) {
      console.error('[SCREENING JOB] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    console.log('[SCREENING JOB] 📝 defineJobs() called - registering job handlers...');

    // Main weekend screening job
    this.agenda.define('weekend-screening', async (job) => {
      console.log('');
      console.log('═'.repeat(80));
      console.log('[SCREENING JOB] 🚀 WEEKEND-SCREENING JOB TRIGGERED');
      console.log('═'.repeat(80));
      console.log(`[SCREENING JOB] ⏰ Triggered at: ${new Date().toISOString()}`);
      console.log(`[SCREENING JOB] 📋 Job ID: ${job.attrs._id}`);
      console.log(`[SCREENING JOB] 📋 Job Name: ${job.attrs.name}`);
      console.log(`[SCREENING JOB] 📋 Job Data: ${JSON.stringify(job.attrs.data)}`);
      console.log(`[SCREENING JOB] 📋 Last Run At: ${job.attrs.lastRunAt}`);
      console.log(`[SCREENING JOB] 📋 Next Run At: ${job.attrs.nextRunAt}`);
      console.log('─'.repeat(80));

      try {
        console.log('[SCREENING JOB] 📌 STEP 1: Calling runWeekendScreening()...');
        const result = await this.runWeekendScreening(job.attrs.data || {});
        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        console.log(`[SCREENING JOB] ✅ STEP 1 COMPLETE: ${result.totalStocksAdded} stocks added, ${result.totalStocksUpdated || 0} updated, ${result.totalStocksEliminated || 0} eliminated`);

        // Trigger bulk analysis after screening completes (for freshly screened stocks)
        console.log('─'.repeat(80));
        console.log('[SCREENING JOB] 📌 STEP 2: Triggering bulk analysis for screened stocks...');
        console.log('[SCREENING JOB] 🔧 Options: analyzeAllChartink=true, useLastFridayData=true');
        try {
          const bulkResult = await agendaScheduledBulkAnalysisService.triggerManually('Post-weekend-screening analysis', {
            source: 'chartink',
            analyzeAllChartink: true,  // Analyze all ChartInk stocks from weekly watchlist
            useLastFridayData: true    // Use only Friday's closing data for consistent weekly analysis
          });
          console.log('[SCREENING JOB] ✅ STEP 2 COMPLETE: Bulk analysis triggered');
          console.log(`[SCREENING JOB] 📋 Bulk job ID: ${bulkResult.jobId}, scheduled at: ${bulkResult.scheduledAt}`);
        } catch (bulkError) {
          console.error('[SCREENING JOB] ❌ STEP 2 FAILED: Bulk analysis error:', bulkError.message);
          console.error('[SCREENING JOB] ❌ Stack:', bulkError.stack);
          // Don't throw - screening completed successfully
        }

        console.log('═'.repeat(80));
        console.log('[SCREENING JOB] ✅ WEEKEND-SCREENING JOB COMPLETED SUCCESSFULLY');
        console.log('═'.repeat(80));
        console.log('');

      } catch (error) {
        console.error('═'.repeat(80));
        console.error('[SCREENING JOB] ❌ WEEKEND-SCREENING JOB FAILED');
        console.error('═'.repeat(80));
        console.error('[SCREENING JOB] ❌ Error:', error.message);
        console.error('[SCREENING JOB] ❌ Stack:', error.stack);
        this.stats.errors++;
        throw error;
      }
    });

    console.log('[SCREENING JOB] ✅ Registered handler: weekend-screening');

    // Manual trigger for testing
    this.agenda.define('manual-screening', async (job) => {
      const { userId, scanTypes } = job.attrs.data || {};
      console.log('');
      console.log('═'.repeat(80));
      console.log('[SCREENING JOB] 🔧 MANUAL-SCREENING JOB TRIGGERED');
      console.log('═'.repeat(80));
      console.log(`[SCREENING JOB] ⏰ Triggered at: ${new Date().toISOString()}`);
      console.log(`[SCREENING JOB] 📋 Job ID: ${job.attrs._id}`);
      console.log(`[SCREENING JOB] 📋 User ID: ${userId || 'all'}`);
      console.log(`[SCREENING JOB] 📋 Scan Types: ${JSON.stringify(scanTypes || ['a_plus_momentum'])}`);
      console.log('─'.repeat(80));

      try {
        const result = await this.runWeekendScreening({
          userId,
          scanTypes: scanTypes || ['a_plus_momentum']
        });

        console.log('═'.repeat(80));
        console.log('[SCREENING JOB] ✅ MANUAL-SCREENING JOB COMPLETED');
        console.log('═'.repeat(80));
        console.log('');

        return result;
      } catch (error) {
        console.error('[SCREENING JOB] ❌ Manual screening failed:', error.message);
        console.error('[SCREENING JOB] ❌ Stack:', error.stack);
        throw error;
      }
    });

    console.log('[SCREENING JOB] ✅ Registered handler: manual-screening');
    console.log('[SCREENING JOB] 📝 defineJobs() complete');
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    console.log('[SCREENING JOB] 📝 Setting up Agenda event handlers...');

    this.agenda.on('ready', () => {
      console.log('[SCREENING JOB] 🟢 EVENT: Agenda ready - can now process jobs');
    });

    this.agenda.on('start', (job) => {
      console.log('');
      console.log('[SCREENING JOB] 🟡 EVENT: Job STARTING');
      console.log(`[SCREENING JOB]    Name: ${job.attrs.name}`);
      console.log(`[SCREENING JOB]    ID: ${job.attrs._id}`);
      console.log(`[SCREENING JOB]    Data: ${JSON.stringify(job.attrs.data)}`);
      console.log(`[SCREENING JOB]    Scheduled for: ${job.attrs.nextRunAt}`);
    });

    this.agenda.on('complete', (job) => {
      console.log('[SCREENING JOB] 🟢 EVENT: Job COMPLETED');
      console.log(`[SCREENING JOB]    Name: ${job.attrs.name}`);
      console.log(`[SCREENING JOB]    ID: ${job.attrs._id}`);
      console.log(`[SCREENING JOB]    Finished at: ${new Date().toISOString()}`);
      console.log('');
    });

    this.agenda.on('fail', (err, job) => {
      console.error('[SCREENING JOB] 🔴 EVENT: Job FAILED');
      console.error(`[SCREENING JOB]    Name: ${job.attrs.name}`);
      console.error(`[SCREENING JOB]    ID: ${job.attrs._id}`);
      console.error(`[SCREENING JOB]    Error: ${err.message}`);
      console.error(`[SCREENING JOB]    Stack: ${err.stack}`);
      console.error('');
    });

    this.agenda.on('error', (err) => {
      console.error('[SCREENING JOB] 🔴 EVENT: Agenda ERROR');
      console.error(`[SCREENING JOB]    Error: ${err.message}`);
      console.error(`[SCREENING JOB]    Stack: ${err.stack}`);
    });

    console.log('[SCREENING JOB] ✅ Event handlers configured');
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    console.log('[SCREENING JOB] 📝 scheduleRecurringJobs() called...');

    try {
      // Cancel existing jobs to avoid duplicates
      console.log('[SCREENING JOB] 🗑️ Cancelling existing weekend-screening jobs...');
      const cancelResult = await this.agenda.cancel({
        name: 'weekend-screening'
      });
      console.log(`[SCREENING JOB] 🗑️ Cancelled ${cancelResult} existing jobs`);

      // Saturday 6 PM IST only
      console.log('[SCREENING JOB] 📅 Scheduling new recurring job: "0 18 * * 6" (Sat 6PM IST)');
      const job = await this.agenda.every('0 18 * * 6', 'weekend-screening', { day: 'saturday' }, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[SCREENING JOB] ✅ Recurring job scheduled: Sat 6PM IST');
      console.log(`[SCREENING JOB] 📋 Job ID: ${job.attrs._id}`);
      console.log(`[SCREENING JOB] 📋 Next Run At: ${job.attrs.nextRunAt}`);

    } catch (error) {
      console.error('[SCREENING JOB] ❌ Failed to schedule jobs:', error.message);
      console.error('[SCREENING JOB] ❌ Stack:', error.stack);
      throw error;
    }
  }

  /**
   * Run the weekend screening process
   * @param {Object} options
   * @param {string} [options.userId] - Specific user ID (optional)
   * @param {Array<string>} [options.scanTypes] - Scan types to run
   * @param {number} [options.maxStocksPerUser] - Max stocks per user
   */
  async runWeekendScreening(options = {}) {
    console.log('');
    console.log('[SCREENING JOB] ┌─────────────────────────────────────────────────────────────┐');
    console.log('[SCREENING JOB] │          runWeekendScreening() STARTED                      │');
    console.log('[SCREENING JOB] └─────────────────────────────────────────────────────────────┘');
    console.log(`[SCREENING JOB] 📋 Input options: ${JSON.stringify(options)}`);

    const {
      userId = null,
      scanTypes = ['a_plus_momentum'],
      maxStocksPerUser = 10
    } = options;

    console.log(`[SCREENING JOB] 📋 Parsed options:`);
    console.log(`[SCREENING JOB]    - userId: ${userId}`);
    console.log(`[SCREENING JOB]    - scanTypes: ${JSON.stringify(scanTypes)}`);
    console.log(`[SCREENING JOB]    - maxStocksPerUser: ${maxStocksPerUser}`);

    const result = {
      usersProcessed: 0,
      totalStocksAdded: 0,
      totalStocksEliminated: 0,  // NEW: Track eliminated stocks
      errors: [],
      scanResults: {}
    };

    try {
      // Step 1: Run ChartInk scans
      console.log('');
      console.log('[SCREENING JOB] ──────────────────────────────────────────────────────────────');
      console.log('[SCREENING JOB] 📌 STEP 1/4: Running ChartInk scans...');
      console.log('[SCREENING JOB] ──────────────────────────────────────────────────────────────');

      const allResults = [];

      for (const scanType of scanTypes) {
        try {
          let scanResults = [];

          switch (scanType) {
            case 'a_plus_momentum':
              scanResults = await chartinkService.runAPlusNextWeekScan();
              break;
            // Legacy scans - commented out
            // case 'breakout':
            //   scanResults = await chartinkService.runBreakoutScan();
            //   break;
            // case 'pullback':
            //   scanResults = await chartinkService.runPullbackScan();
            //   break;
            // case 'momentum':
            //   scanResults = await chartinkService.runMomentumScan();
            //   break;
            // case 'consolidation_breakout':
            //   scanResults = await chartinkService.runConsolidationScan();
            //   break;
            default:
              console.warn(`[SCREENING JOB] Unknown scan type: ${scanType}`);
          }

          console.log(`[SCREENING JOB] ${scanType} scan: ${scanResults.length} results`);
          result.scanResults[scanType] = scanResults.length;

          // Tag with scan type
          allResults.push(...scanResults.map(s => ({ ...s, scan_type: scanType })));

          // Delay between scans
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
          console.error(`[SCREENING JOB] ${scanType} scan failed:`, error.message);
          result.errors.push({ scanType, error: error.message });
        }
      }

      console.log(`[SCREENING JOB] ✅ STEP 1 COMPLETE: Total ${allResults.length} results from all scans`);

      if (allResults.length === 0) {
        console.log('[SCREENING JOB] ⚠️ No results from any scan - EXITING EARLY');
        return result;
      }

      // Step 2: PREFETCH FRESH PRICES before enrichment
      console.log('');
      console.log('[SCREENING JOB] ──────────────────────────────────────────────────────────────');
      console.log('[SCREENING JOB] 📌 STEP 2/4: Prefetching fresh prices...');
      console.log('[SCREENING JOB] ──────────────────────────────────────────────────────────────');
      console.log(`[SCREENING JOB] 📊 Prefetching fresh prices for ${allResults.length} stocks...`);

      // First map all symbols to instrument_keys
      const instrumentKeyMap = new Map();
      for (const stock of allResults) {
        const mapped = await stockEnrichmentService.mapToInstrumentKey(stock.nsecode);
        if (mapped?.instrument_key) {
          instrumentKeyMap.set(stock.nsecode, mapped.instrument_key);
        }
      }

      const instrumentKeys = Array.from(instrumentKeyMap.values());
      console.log(`[SCREENING JOB] 📊 Mapped ${instrumentKeys.length} instrument keys`);

      // Fetch prices from API and save to LatestPrice collection
      const BATCH_SIZE = 50;
      let priceSuccessCount = 0;
      let priceFailCount = 0;

      for (let i = 0; i < instrumentKeys.length; i += BATCH_SIZE) {
        const batch = instrumentKeys.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(instrumentKeys.length / BATCH_SIZE);

        console.log(`[SCREENING JOB] 📊 Fetching prices batch ${batchNum}/${totalBatches} (${batch.length} stocks)`);

        const pricePromises = batch.map(async (instrumentKey) => {
          try {
            const price = await getCurrentPrice(instrumentKey, false);
            if (price !== null) {
              // Save to LatestPrice for enrichment to use
              await priceCacheService.storePriceInDB(instrumentKey, price, null, Date.now());
              return { instrumentKey, success: true };
            }
            return { instrumentKey, success: false };
          } catch (error) {
            return { instrumentKey, success: false, error: error.message };
          }
        });

        const results = await Promise.all(pricePromises);
        results.forEach(r => {
          if (r.success) priceSuccessCount++;
          else priceFailCount++;
        });

        // Small delay between batches
        if (i + BATCH_SIZE < instrumentKeys.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      console.log(`[SCREENING JOB] ✅ STEP 2 COMPLETE: Price prefetch - ${priceSuccessCount} success, ${priceFailCount} failed`);

      // Step 3: Enrich with technical data, LEVELS, and scores (now uses fresh prices)
      console.log('');
      console.log('[SCREENING JOB] ──────────────────────────────────────────────────────────────');
      console.log('[SCREENING JOB] 📌 STEP 3/4: Enriching stocks with technical data & levels...');
      console.log('[SCREENING JOB] ──────────────────────────────────────────────────────────────');
      console.log(`[SCREENING JOB] Enriching ${allResults.length} stocks...`);

      // First pass: Get all enriched stocks with basic filter
      const { stocks: allEnrichedStocks, metadata } = await stockEnrichmentService.runEnrichmentPipeline(
        allResults,
        {
          minScore: 0,   // Get all for filtering (including eliminated)
          maxResults: 100,
          debug: true,   // Enable debug for first few stocks
          debugCount: 3
        }
      );

      console.log(`[SCREENING JOB] Enriched ${allEnrichedStocks.length} stocks`);
      console.log(`[SCREENING JOB] Grade distribution: A+=${metadata.grade_distribution['A+'] || 0}, A=${metadata.grade_distribution.A || 0}, B+=${metadata.grade_distribution['B+'] || 0}, B=${metadata.grade_distribution.B || 0}, C=${metadata.grade_distribution.C || 0}`);
      
      // NEW: Log levels stats
      if (metadata.levels_stats) {
        console.log(`[SCREENING JOB] Levels stats: ${metadata.levels_stats.with_levels} with levels, ${metadata.levels_stats.without_levels} without`);
      }

      // Filter for quality stocks - minimum score threshold
      // NEW: Eliminated stocks are already filtered out by enrichment service
      const MIN_SCORE = 60;
      const MAX_STOCKS = 15;

      const qualifiedStocks = allEnrichedStocks
        .filter(s => !s.eliminated && s.setup_score >= MIN_SCORE)
        .sort((a, b) => b.setup_score - a.setup_score);

      // Count eliminated stocks for reporting
      const eliminatedCount = allEnrichedStocks.filter(s => s.eliminated).length;
      result.totalStocksEliminated = eliminatedCount;
      this.stats.stocksEliminated += eliminatedCount;

      if (eliminatedCount > 0) {
        console.log(`[SCREENING JOB] ⚠️ ${eliminatedCount} stocks eliminated (RSI > 72 or other criteria)`);
      }

      // Deduplicate by instrument_key - keep the entry with highest score
      // Same stock may appear from multiple scans (breakout + momentum) with different grades
      const deduplicatedStocks = [];
      const seenInstrumentKeys = new Set();

      for (const stock of qualifiedStocks) {
        if (!seenInstrumentKeys.has(stock.instrument_key)) {
          seenInstrumentKeys.add(stock.instrument_key);
          deduplicatedStocks.push(stock);
        } else {
          // Log discarded duplicate (lower score version)
          console.log(`[SCREENING JOB] 🔄 Duplicate removed: ${stock.symbol} (${stock.scan_type}, score=${stock.setup_score}) - keeping higher scored entry`);
        }
      }

      const enrichedStocks = deduplicatedStocks.slice(0, MAX_STOCKS);

      console.log(`[SCREENING JOB] ✅ STEP 3 COMPLETE: Qualified stocks (${MIN_SCORE}+): ${qualifiedStocks.length} total, ${deduplicatedStocks.length} unique, ${enrichedStocks.length} selected`);

      if (enrichedStocks.length === 0) {
        console.log('[SCREENING JOB] ⚠️ No qualified stocks found this week - EXITING EARLY');
        return result;
      }

      // Step 4: Add to global WeeklyWatchlist (no user concept)
      console.log('');
      console.log('[SCREENING JOB] ──────────────────────────────────────────────────────────────');
      console.log('[SCREENING JOB] 📌 STEP 4/4: Adding stocks to WeeklyWatchlist...');
      console.log('[SCREENING JOB] ──────────────────────────────────────────────────────────────');
      console.log(`[SCREENING JOB] Adding ${enrichedStocks.length} stocks to global WeeklyWatchlist...`);
      console.log(`[SCREENING JOB] Stocks to add: ${enrichedStocks.map(s => `${s.symbol}(${s.setup_score}/${s.grade})`).join(', ')}`);

      const stocksToAdd = enrichedStocks.map(stock => ({
        instrument_key: stock.instrument_key,
        symbol: stock.symbol,
        stock_name: stock.stock_name,
        selection_reason: `${stock.scan_type} scan`,
        scan_type: stock.scan_type,
        setup_score: stock.setup_score,
        grade: stock.grade,
        screening_data: {
          price_at_screening: stock.current_price,
          dma20: stock.indicators.dma20,
          dma50: stock.indicators.dma50,
          dma200: stock.indicators.dma200,
          ema20: stock.indicators.ema20,
          ema50: stock.indicators.ema50,
          rsi: stock.indicators.rsi,
          atr: stock.indicators.atr,
          atr_pct: stock.indicators.atr_pct,
          volume_vs_avg: stock.indicators.volume_vs_avg,
          distance_from_20dma_pct: stock.indicators.distance_from_20dma_pct,
          weekly_change_pct: stock.indicators.weekly_change_pct  // NEW: Weekly change for framework
        },
        // NEW: Include trading levels
        levels: stock.levels ? {
          entry: stock.levels.entry,
          entryRange: stock.levels.entryRange,
          stop: stock.levels.stop,
          target: stock.levels.target,
          riskReward: stock.levels.riskReward,
          riskPercent: stock.levels.riskPercent,
          rewardPercent: stock.levels.rewardPercent,
          entryType: stock.levels.entryType,
          mode: stock.levels.mode,
          reason: stock.levels.reason
        } : null,
        entry_zone: stock.entry_zone,
        status: 'WATCHING'
      }));

      const addResult = await WeeklyWatchlist.addStocks(stocksToAdd);

      // Update watchlist metadata
      const watchlist = addResult.watchlist;
      watchlist.screening_run_at = new Date();
      watchlist.scan_types_used = scanTypes;
      watchlist.total_screener_results = allResults.length;
      watchlist.total_eliminated = eliminatedCount;  // NEW: Track eliminated count
      // Count actual Grade A+ and A stocks in the watchlist
      watchlist.grade_a_plus_count = watchlist.stocks.filter(s => s.grade === 'A+').length;
      watchlist.grade_a_count = watchlist.stocks.filter(s => s.grade === 'A' || s.grade === 'A+').length;
      await watchlist.save();

      result.totalStocksAdded = addResult.added;
      result.totalStocksUpdated = addResult.updated;
      console.log(`[SCREENING JOB] ✅ STEP 4 COMPLETE: Added ${addResult.added} new stocks, updated ${addResult.updated} existing stocks`);

      this.stats.stocksProcessed += enrichedStocks.length;

      console.log('');
      console.log('[SCREENING JOB] ┌─────────────────────────────────────────────────────────────┐');
      console.log('[SCREENING JOB] │          runWeekendScreening() COMPLETED                    │');
      console.log('[SCREENING JOB] └─────────────────────────────────────────────────────────────┘');
      console.log(`[SCREENING JOB] 📊 Final Result: ${JSON.stringify(result)}`);
      console.log('');

      return result;

    } catch (error) {
      console.error('');
      console.error('[SCREENING JOB] ┌─────────────────────────────────────────────────────────────┐');
      console.error('[SCREENING JOB] │          runWeekendScreening() FAILED                       │');
      console.error('[SCREENING JOB] └─────────────────────────────────────────────────────────────┘');
      console.error(`[SCREENING JOB] ❌ Error: ${error.message}`);
      console.error(`[SCREENING JOB] ❌ Stack: ${error.stack}`);
      console.error('');
      throw error;
    }
  }

  /**
   * Manually trigger screening
   */
  async triggerNow(options = {}) {
    console.log('');
    console.log('[SCREENING JOB] ═══════════════════════════════════════════════════════════════');
    console.log('[SCREENING JOB] 🔧 triggerNow() called - Manual trigger requested');
    console.log('[SCREENING JOB] ═══════════════════════════════════════════════════════════════');
    console.log(`[SCREENING JOB] 📋 Options: ${JSON.stringify(options)}`);
    console.log(`[SCREENING JOB] 📋 Is Initialized: ${this.isInitialized}`);

    if (!this.isInitialized) {
      console.error('[SCREENING JOB] ❌ Cannot trigger - not initialized!');
      throw new Error('Screening job not initialized');
    }

    console.log('[SCREENING JOB] 📤 Calling agenda.now("manual-screening", options)...');

    const job = await this.agenda.now('manual-screening', options);

    console.log('[SCREENING JOB] ✅ Job scheduled successfully');
    console.log(`[SCREENING JOB] 📋 Job ID: ${job.attrs._id}`);
    console.log(`[SCREENING JOB] 📋 Scheduled At: ${job.attrs.nextRunAt}`);
    console.log('[SCREENING JOB] ═══════════════════════════════════════════════════════════════');
    console.log('');

    return {
      success: true,
      jobId: job.attrs._id,
      scheduledAt: job.attrs.nextRunAt
    };
  }

  /**
   * Get job stats
   */
  getStats() {
    return {
      ...this.stats,
      isInitialized: this.isInitialized
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log('[SCREENING JOB] Shutdown complete');
    }
  }
}

// Export singleton instance
const weekendScreeningJob = new WeekendScreeningJob();

export default weekendScreeningJob;
export { WeekendScreeningJob };