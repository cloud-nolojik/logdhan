/**
 * Weekend Screening Job
 *
 * Runs ChartInk scans and populates weekly watchlists
 * Schedule: Saturday 6 PM IST
 */

import Agenda from 'agenda';
import chartinkService from '../chartinkService.js';
import stockEnrichmentService from '../stockEnrichmentService.js';
import WeeklyWatchlist from '../../models/weeklyWatchlist.js';
import agendaScheduledBulkAnalysisService from '../agendaScheduledBulkAnalysis.service.js';

class WeekendScreeningJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.stats = {
      runsCompleted: 0,
      stocksProcessed: 0,
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
    // Main weekend screening job
    this.agenda.define('weekend-screening', async (job) => {
      console.log('[SCREENING JOB] Starting weekend screening run...');

      try {
        const result = await this.runWeekendScreening(job.attrs.data || {});
        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        console.log(`[SCREENING JOB] Completed: ${result.totalStocksAdded} stocks added across ${result.usersProcessed} users`);

        // Trigger bulk analysis after screening completes (for freshly screened stocks)
        console.log('[SCREENING JOB] Triggering bulk analysis for screened stocks...');
        try {
          await agendaScheduledBulkAnalysisService.triggerManually('Post-weekend-screening analysis');
          console.log('[SCREENING JOB] Bulk analysis triggered successfully');
        } catch (bulkError) {
          console.error('[SCREENING JOB] Failed to trigger bulk analysis:', bulkError.message);
          // Don't throw - screening completed successfully
        }

      } catch (error) {
        console.error('[SCREENING JOB] Weekend screening failed:', error);
        this.stats.errors++;
        throw error;
      }
    });

    // Manual trigger for testing
    this.agenda.define('manual-screening', async (job) => {
      const { userId, scanTypes } = job.attrs.data || {};
      console.log(`[SCREENING JOB] Manual screening run for user: ${userId || 'all'}`);

      try {
        const result = await this.runWeekendScreening({
          userId,
          scanTypes: scanTypes || ['breakout', 'pullback', 'momentum', 'consolidation_breakout']
        });

        return result;
      } catch (error) {
        console.error('[SCREENING JOB] Manual screening failed:', error);
        throw error;
      }
    });
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {
      console.log('[SCREENING JOB] Agenda ready');
    });

    this.agenda.on('start', (job) => {
      console.log(`[SCREENING JOB] Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`[SCREENING JOB] Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`[SCREENING JOB] Job failed: ${job.attrs.name}`, err);
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel existing jobs to avoid duplicates
      await this.agenda.cancel({
        name: 'weekend-screening'
      });

      // Saturday 6 PM IST only
      await this.agenda.every('0 18 * * 6', 'weekend-screening', { day: 'saturday' }, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[SCREENING JOB] Recurring job scheduled: Sat 6PM IST');

    } catch (error) {
      console.error('[SCREENING JOB] Failed to schedule jobs:', error);
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
    const {
      userId = null,
      scanTypes = ['breakout', 'pullback', 'momentum', 'consolidation_breakout'],
      maxStocksPerUser = 10
    } = options;

    const result = {
      usersProcessed: 0,
      totalStocksAdded: 0,
      errors: [],
      scanResults: {}
    };

    try {
      // Step 1: Run ChartInk scans
      console.log('[SCREENING JOB] Running ChartInk scans...');

      const allResults = [];

      for (const scanType of scanTypes) {
        try {
          let scanResults = [];

          switch (scanType) {
            case 'breakout':
              scanResults = await chartinkService.runBreakoutScan();
              break;
            case 'pullback':
              scanResults = await chartinkService.runPullbackScan();
              break;
            case 'momentum':
              scanResults = await chartinkService.runMomentumScan();
              break;
            case 'consolidation_breakout':
              scanResults = await chartinkService.runConsolidationScan();
              break;
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

      if (allResults.length === 0) {
        console.log('[SCREENING JOB] No results from any scan');
        return result;
      }

      // Step 2: Enrich with technical data and scores
      console.log(`[SCREENING JOB] Enriching ${allResults.length} stocks...`);

      // First pass: Get all enriched stocks with basic filter
      const { stocks: allEnrichedStocks, metadata } = await stockEnrichmentService.runEnrichmentPipeline(
        allResults,
        {
          minScore: 0,   // Get all for filtering
          maxResults: 100
        }
      );

      console.log(`[SCREENING JOB] Enriched ${allEnrichedStocks.length} stocks`);
      console.log(`[SCREENING JOB] Grade distribution: A=${metadata.grade_distribution.A}, B=${metadata.grade_distribution.B}, C=${metadata.grade_distribution.C}`);

      // Filter for quality stocks - minimum score threshold
      const MIN_SCORE = 60;
      const MAX_STOCKS = 15;

      const enrichedStocks = allEnrichedStocks
        .filter(s => s.setup_score >= MIN_SCORE)
        .sort((a, b) => b.setup_score - a.setup_score)
        .slice(0, MAX_STOCKS);

      console.log(`[SCREENING JOB] Qualified stocks (${MIN_SCORE}+): ${enrichedStocks.length} stocks`);

      if (enrichedStocks.length === 0) {
        console.log('[SCREENING JOB] No qualified stocks found this week');
        return result;
      }

      // Step 3: Add to global WeeklyWatchlist (no user concept)
      console.log(`[SCREENING JOB] Adding ${enrichedStocks.length} stocks to global WeeklyWatchlist...`);

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
          rsi: stock.indicators.rsi,
          atr: stock.indicators.atr,
          atr_pct: stock.indicators.atr_pct,
          volume_vs_avg: stock.indicators.volume_vs_avg,
          distance_from_20dma_pct: stock.indicators.distance_from_20dma_pct
        },
        entry_zone: stock.entry_zone,
        status: 'WATCHING'
      }));

      const addResult = await WeeklyWatchlist.addStocks(stocksToAdd);

      // Update watchlist metadata
      const watchlist = addResult.watchlist;
      watchlist.screening_run_at = new Date();
      watchlist.scan_types_used = scanTypes;
      watchlist.total_screener_results = allResults.length;
      watchlist.grade_a_count = enrichedStocks.length;
      await watchlist.save();

      result.totalStocksAdded = addResult.added;
      console.log(`[SCREENING JOB] Added ${addResult.added} new stocks, skipped ${addResult.skipped} duplicates`);

      this.stats.stocksProcessed += enrichedStocks.length;

      return result;

    } catch (error) {
      console.error('[SCREENING JOB] runWeekendScreening failed:', error);
      throw error;
    }
  }

  /**
   * Manually trigger screening
   */
  async triggerNow(options = {}) {
    if (!this.isInitialized) {
      throw new Error('Screening job not initialized');
    }

    console.log('[SCREENING JOB] Manual trigger requested');

    const job = await this.agenda.now('manual-screening', options);

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
