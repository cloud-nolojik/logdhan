import Agenda from 'agenda';
import dailyDataPrefetchService from './dailyDataPrefetch.service.js';
import DailyJobStatus from '../models/dailyJobStatus.js';
import MarketTiming from '../models/marketTiming.js';

/**
 * Agenda-based Data Pre-fetch Service
 * Handles daily data pre-fetching, cache cleanup, and system health monitoring
 * Uses MongoDB for job persistence and scheduling
 */
class AgendaDataPrefetchService {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.stats = {
      dataPrefetchJobs: 0,
      successfulJobs: 0,
      failedJobs: 0
    };
  }

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
          collection: 'data_prefetch_jobs',
          options: {
            useUnifiedTopology: true
          }
        },
        processEvery: '1 minute',
        maxConcurrency: 5,
        defaultConcurrency: 2
      });

      // Define all job types
      this.defineJobs();

      // Handle job events
      this.setupEventHandlers();

      // Start agenda
      await this.agenda.start();

      // Schedule recurring jobs
      await this.scheduleRecurringJobs();

      this.isInitialized = true;

    } catch (error) {
      console.error('❌ [AGENDA DATA] Failed to initialize service:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // REMOVED: daily-data-prefetch job (not required)

    // Note: Cache cleanup removed - MongoDB TTL index handles this automatically and more efficiently

    // Note: Job status cleanup removed - MongoDB TTL indexes handle this automatically
    // Note: System health check removed - manual monitoring preferred

    // REMOVED: chart-cleanup job (not required)

    // Manual trigger job (for testing and admin purposes)
    this.agenda.define('manual-data-prefetch', async (job) => {
      const { targetDate, reason } = job.attrs.data;

      try {
        const result = await dailyDataPrefetchService.runDailyPrefetch(targetDate ? new Date(targetDate) : null);

        this.stats.successfulJobs++;

      } catch (error) {
        console.error('❌ [AGENDA DATA] Manual data pre-fetch failed:', error);
        this.stats.failedJobs++;
        throw error;
      }
    });

    // Current day data pre-fetch job (runs after 4:00 PM on trading days)
    this.agenda.define('current-day-prefetch', async (job) => {

      try {
        const result = await dailyDataPrefetchService.runCurrentDayPrefetch();

        if (result.success) {

          this.stats.successfulJobs++;
        } else {

          this.stats.successfulJobs++;
        }

      } catch (error) {
        console.error('❌ [AGENDA DATA] Current day data pre-fetch failed:', error);
        this.stats.failedJobs++;
        throw error;
      }
    });

    // NEW: AI Analysis trigger job (runs at 4:30 PM after data is ready)
    this.agenda.define('trigger-analysis', async (job) => {

      try {
        // Import the analysis service dynamically to avoid circular dependency
        const { default: aiAnalyzeService } = await import('./aiAnalyze.service.js');

        // Get list of recently analyzed stocks for re-analysis
        const StockAnalysis = (await import('../models/stockAnalysis.js')).default;

        // Find analyses from the last 7 days to refresh with new EOD data
        const recentAnalyses = await StockAnalysis.find({
          created_at: {
            $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
          },
          status: 'completed'
        }).distinct('instrument_key');

        // Trigger fresh analysis for each stock (this will use the latest data from 4:00-4:05 PM fetch)
        let successCount = 0;
        let errorCount = 0;

        for (const instrumentKey of recentAnalyses.slice(0, 20)) {// Limit to 20 stocks to avoid overload
          try {
            // This will create fresh analysis with the updated EOD data

            // Note: We're not waiting for completion to avoid timeouts
            // The analysis will run in background and send WhatsApp when complete
            aiAnalyzeService.generateStockAnalysisWithPayload({
              instrument_key: instrumentKey,
              analysis_type: 'swing',
              force_fresh: true // Force fresh analysis with new EOD data
            }).catch((error) => {
              console.error(`❌ [AGENDA DATA] Analysis failed for ${instrumentKey}:`, error.message);
            });

            successCount++;

            // Small delay to avoid overwhelming the system
            await new Promise((resolve) => setTimeout(resolve, 100));

          } catch (error) {
            console.error(`❌ [AGENDA DATA] Failed to trigger analysis for ${instrumentKey}:`, error.message);
            errorCount++;
          }
        }

        this.stats.successfulJobs++;

      } catch (error) {
        console.error('❌ [AGENDA DATA] AI analysis trigger failed:', error);
        this.stats.failedJobs++;
        throw error;
      }
    });
  }

  /**
   * Setup event handlers for monitoring
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {

    });

    this.agenda.on('start', (job) => {

    });

    this.agenda.on('complete', (job) => {

    });

    this.agenda.on('fail', (err, job) => {
      console.error(`❌ [AGENDA DATA] Job failed: ${job.attrs.name}`, err);
    });

    this.agenda.on('error', (err) => {
      console.error('❌ [AGENDA DATA] Agenda error:', err);
    });
  }

  /**
   * Schedule all recurring jobs
   * NOTE: Bulk analysis is now handled by agendaScheduledBulkAnalysis.service.js at 4:30 PM
   * This service only handles manual triggers and admin operations
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel any existing recurring jobs to avoid duplicates
      // These jobs are no longer scheduled - bulk analysis handles everything at 4:30 PM
      await this.agenda.cancel({
        name: { $in: ['current-day-prefetch', 'trigger-analysis', 'chart-cleanup'] }
      });

      // REMOVED: current-day-prefetch (4:05 PM) - redundant, bulk analysis fetches data
      // REMOVED: trigger-analysis (4:30 PM) - redundant, agendaScheduledBulkAnalysis handles this
      // REMOVED: chart-cleanup - MongoDB TTL index handles this

    } catch (error) {
      console.error('❌ [AGENDA DATA] Failed to schedule recurring jobs:', error);
      throw error;
    }
  }

  // Note: getSystemHealthStats method removed - manual monitoring preferred

  /**
   * Manually trigger a job (for testing and admin purposes)
   */
  async triggerJob(jobName, data = {}) {
    try {

      const job = await this.agenda.now(jobName, data);

      return {
        success: true,
        jobId: job.attrs._id,
        jobName: jobName,
        scheduledAt: job.attrs.nextRunAt
      };

    } catch (error) {
      console.error(`❌ [AGENDA DATA] Failed to trigger job ${jobName}:`, error);
      throw error;
    }
  }

  /**
   * Get job statistics
   */
  async getJobStats() {
    try {
      const jobs = await this.agenda.jobs({});
      const jobsByName = {};

      jobs.forEach((job) => {
        const name = job.attrs.name;
        if (!jobsByName[name]) {
          jobsByName[name] = {
            name: name,
            total: 0,
            scheduled: 0,
            running: 0,
            completed: 0,
            failed: 0
          };
        }

        jobsByName[name].total++;

        if (job.attrs.nextRunAt && job.attrs.nextRunAt > new Date()) {
          jobsByName[name].scheduled++;
        } else if (job.attrs.lastRunAt && !job.attrs.lastFinishedAt) {
          jobsByName[name].running++;
        } else if (job.attrs.lastFinishedAt && !job.attrs.failedAt) {
          jobsByName[name].completed++;
        } else if (job.attrs.failedAt) {
          jobsByName[name].failed++;
        }
      });

      return {
        summary: this.stats,
        jobs: Object.values(jobsByName),
        totalJobs: jobs.length
      };

    } catch (error) {
      console.error('❌ [AGENDA DATA] Error getting job stats:', error);
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
      console.error('❌ [AGENDA DATA] Error stopping service:', error);
      throw error;
    }
  }

  /**
   * Pause all recurring jobs
   */
  async pauseJobs() {
    try {
      await this.agenda.cancel({
        name: { $in: [] } // All removed
      });

    } catch (error) {
      console.error('❌ [AGENDA DATA] Error pausing jobs:', error);
      throw error;
    }
  }

  /**
   * Resume all recurring jobs
   */
  async resumeJobs() {
    try {
      await this.scheduleRecurringJobs();

    } catch (error) {
      console.error('❌ [AGENDA DATA] Error resuming jobs:', error);
      throw error;
    }
  }
}

const agendaDataPrefetchService = new AgendaDataPrefetchService();
export default agendaDataPrefetchService;