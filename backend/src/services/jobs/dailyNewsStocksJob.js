/**
 * Daily News Stocks Job
 *
 * Scrapes StreetGains pre-market news and stores stocks
 * Schedule: Daily at 8:30 AM IST (before market open)
 */

import Agenda from 'agenda';
import streetGainsScraper from '../streetGainsScraper.service.js';

class DailyNewsStocksJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.stats = {
      runsCompleted: 0,
      stocksProcessed: 0,
      errors: 0,
      lastRunAt: null,
      lastResult: null
    };
  }

  /**
   * Initialize the job scheduler
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('[DAILY NEWS JOB] Already initialized');
      return;
    }

    try {
      console.log('[DAILY NEWS JOB] Initializing daily news stocks job...');

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'daily_news_jobs',
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
      console.log('[DAILY NEWS JOB] Initialization complete');

    } catch (error) {
      console.error('[DAILY NEWS JOB] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // Main daily news scraping job
    this.agenda.define('daily-news-scrape', async (job) => {
      console.log('[DAILY NEWS JOB] Starting daily news scrape...');

      try {
        const result = await streetGainsScraper.scrapeAndStoreDailyNewsStocks();

        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;

        if (result.success) {
          this.stats.stocksProcessed += result.stocks_count;
          console.log(`[DAILY NEWS JOB] Completed: ${result.stocks_count} stocks processed`);
        } else {
          this.stats.errors++;
          console.error(`[DAILY NEWS JOB] Failed: ${result.error}`);
        }

        return result;

      } catch (error) {
        console.error('[DAILY NEWS JOB] Daily news scrape failed:', error);
        this.stats.errors++;
        throw error;
      }
    });

    // Manual trigger for testing
    this.agenda.define('manual-news-scrape', async (job) => {
      console.log('[DAILY NEWS JOB] Manual news scrape requested');

      try {
        const result = await streetGainsScraper.scrapeAndStoreDailyNewsStocks();

        this.stats.lastRunAt = new Date();
        this.stats.lastResult = result;

        return result;

      } catch (error) {
        console.error('[DAILY NEWS JOB] Manual news scrape failed:', error);
        throw error;
      }
    });

    // Retry job for failed scrapes
    this.agenda.define('retry-news-scrape', async (job) => {
      const { attempt = 1, maxAttempts = 3 } = job.attrs.data || {};

      console.log(`[DAILY NEWS JOB] Retry attempt ${attempt}/${maxAttempts}`);

      try {
        const result = await streetGainsScraper.scrapeAndStoreDailyNewsStocks();

        if (result.success) {
          console.log(`[DAILY NEWS JOB] Retry succeeded on attempt ${attempt}`);
          return result;
        }

        // If still failing and more attempts left, schedule another retry
        if (attempt < maxAttempts) {
          await this.agenda.schedule('in 10 minutes', 'retry-news-scrape', {
            attempt: attempt + 1,
            maxAttempts
          });
          console.log(`[DAILY NEWS JOB] Scheduling retry ${attempt + 1} in 10 minutes`);
        } else {
          console.error(`[DAILY NEWS JOB] All ${maxAttempts} retry attempts failed`);
        }

        return result;

      } catch (error) {
        console.error(`[DAILY NEWS JOB] Retry attempt ${attempt} failed:`, error);

        if (attempt < maxAttempts) {
          await this.agenda.schedule('in 10 minutes', 'retry-news-scrape', {
            attempt: attempt + 1,
            maxAttempts
          });
        }

        throw error;
      }
    });
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {
      console.log('[DAILY NEWS JOB] Agenda ready');
    });

    this.agenda.on('start', (job) => {
      console.log(`[DAILY NEWS JOB] Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`[DAILY NEWS JOB] Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`[DAILY NEWS JOB] Job failed: ${job.attrs.name}`, err);

      // Schedule retry on failure (for main job only)
      if (job.attrs.name === 'daily-news-scrape') {
        this.agenda.schedule('in 5 minutes', 'retry-news-scrape', {
          attempt: 1,
          maxAttempts: 3
        });
        console.log('[DAILY NEWS JOB] Scheduled retry in 5 minutes');
      }
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel existing jobs to avoid duplicates
      await this.agenda.cancel({
        name: 'daily-news-scrape'
      });

      // Daily at 8:30 AM IST (weekdays only)
      // Cron: minute hour day month weekday
      // 30 8 * * 1-5 = 8:30 AM, Monday through Friday
      await this.agenda.every('30 8 * * 1-5', 'daily-news-scrape', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[DAILY NEWS JOB] Recurring job scheduled: 8:30 AM IST, Mon-Fri');

    } catch (error) {
      console.error('[DAILY NEWS JOB] Failed to schedule jobs:', error);
      throw error;
    }
  }

  /**
   * Manually trigger news scrape
   */
  async triggerNow() {
    if (!this.isInitialized) {
      throw new Error('Daily news job not initialized');
    }

    console.log('[DAILY NEWS JOB] Manual trigger requested');

    const job = await this.agenda.now('manual-news-scrape', {});

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
   * Get next scheduled run
   */
  async getNextRun() {
    if (!this.agenda) return null;

    const jobs = await this.agenda.jobs({
      name: 'daily-news-scrape',
      nextRunAt: { $exists: true }
    });

    if (jobs.length > 0) {
      return jobs[0].attrs.nextRunAt;
    }

    return null;
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log('[DAILY NEWS JOB] Shutdown complete');
    }
  }
}

// Export singleton instance
const dailyNewsStocksJob = new DailyNewsStocksJob();

export default dailyNewsStocksJob;
export { DailyNewsStocksJob };
