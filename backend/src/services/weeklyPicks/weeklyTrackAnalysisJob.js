/**
 * Weekly Track Analysis Job
 *
 * Scheduled 4:00 PM IST job that analyzes all stocks with added_source='weekly_track'.
 *
 * KEY INSIGHT: Analysis is GLOBAL (per-stock, not per-user).
 * If 10 users track RELIANCE, we run AI ONCE and all 10 see the same result.
 *
 * This job:
 * 1. Collects UNIQUE stocks from all users where added_source='weekly_track'
 * 2. Fetches today's candle + original swing analysis (entry/stop/target)
 * 3. Calls buildPositionManagementPrompt() for AI analysis
 * 4. Stores result in StockAnalysis (analysis_type: 'position_management')
 *
 * Only weekly_track stocks get position management. Manual stocks are skipped
 * (they don't have swing analysis with entry/stop/target levels).
 */

import Agenda from 'agenda';
import axios from 'axios';
import { User } from '../../models/user.js';
import StockAnalysis from '../../models/stockAnalysis.js';
import candleFetcherService from '../candleFetcher.service.js';
import { buildPositionManagementPrompt } from '../../prompts/positionPrompts.js';
import priceCacheService from '../priceCache.service.js';
import modelSelectorService from '../ai/modelSelector.service.js';
import MarketHoursUtil from '../../utils/marketHours.js';
import pLimit from 'p-limit';
import { firebaseService } from '../firebase/firebase.service.js';

class WeeklyTrackAnalysisJob {
  constructor() {
    this.agenda = null;
    this.isInitialized = false;
    this.isRunning = false;
    this.stats = {
      runsCompleted: 0,
      stocksAnalyzed: 0,
      aiCallsSuccess: 0,
      aiCallsFailed: 0,
      errors: 0,
      lastRunAt: null
    };
  }

  /**
   * Initialize the job scheduler
   */
  async initialize() {
    if (this.isInitialized) {
      console.log('[WEEKLY-TRACK] Already initialized');
      return;
    }

    try {
      console.log('[WEEKLY-TRACK] Initializing weekly track analysis job...');

      const mongoUrl = process.env.MONGODB_URI;
      this.agenda = new Agenda({
        db: {
          address: mongoUrl,
          collection: 'weekly_track_analysis_jobs',
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

      // Wait for Agenda to be ready
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Agenda MongoDB connection timeout after 30s'));
        }, 30000);

        this.agenda.on('ready', () => {
          clearTimeout(timeout);
          console.log('[WEEKLY-TRACK] Agenda MongoDB connection ready');
          resolve();
        });

        this.agenda.on('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      // Start agenda
      await this.agenda.start();

      // Schedule recurring jobs
      await this.scheduleRecurringJobs();

      this.isInitialized = true;
      console.log('[WEEKLY-TRACK] ✅ Initialization complete');

    } catch (error) {
      console.error('[WEEKLY-TRACK] ❌ Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Define all job types
   */
  defineJobs() {
    // Main weekly track analysis job - runs at 4:00 PM
    this.agenda.define('weekly-track-analysis', async (job) => {
      console.log('[WEEKLY-TRACK] Starting scheduled position management analysis...');

      try {
        const result = await this.runAnalysis(job.attrs.data || {});
        this.stats.runsCompleted++;
        this.stats.lastRunAt = new Date();
        console.log(`[WEEKLY-TRACK] ✅ Completed: ${result.stocksAnalyzed} stocks analyzed`);
      } catch (error) {
        console.error('[WEEKLY-TRACK] ❌ Analysis failed:', error);
        this.stats.errors++;
        throw error;
      }
    });

    // Manual trigger job
    this.agenda.define('manual-weekly-track-analysis', async (job) => {
      console.log('[WEEKLY-TRACK] Manual analysis triggered');
      try {
        return await this.runAnalysis(job.attrs.data || {});
      } catch (error) {
        console.error('[WEEKLY-TRACK] ❌ Manual analysis failed:', error);
        throw error;
      }
    });
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    this.agenda.on('ready', () => {
      console.log('[WEEKLY-TRACK] Agenda ready');
    });

    this.agenda.on('start', (job) => {
      console.log(`[WEEKLY-TRACK] Job starting: ${job.attrs.name}`);
    });

    this.agenda.on('complete', (job) => {
      console.log(`[WEEKLY-TRACK] Job completed: ${job.attrs.name}`);
    });

    this.agenda.on('fail', (err, job) => {
      console.error(`[WEEKLY-TRACK] Job failed: ${job.attrs.name}`, err);
    });
  }

  /**
   * Schedule recurring jobs
   */
  async scheduleRecurringJobs() {
    try {
      // Cancel existing jobs to avoid duplicates
      await this.agenda.cancel({
        name: 'weekly-track-analysis'
      });

      // 4:00 PM IST every weekday (Monday-Friday)
      // Runs after market close (3:30 PM) to use complete day's data
      await this.agenda.every('0 16 * * 1-5', 'weekly-track-analysis', {}, {
        timezone: 'Asia/Kolkata'
      });

      console.log('[WEEKLY-TRACK] Recurring job scheduled: 4:00 PM IST weekdays');

    } catch (error) {
      console.error('[WEEKLY-TRACK] Failed to schedule jobs:', error);
      throw error;
    }
  }

  /**
   * Main analysis function
   * @param {Object} options
   * @param {boolean} [options.forceReanalyze=false] - Re-analyze even if today's analysis exists
   */
  async runAnalysis(options = {}) {
    const { forceReanalyze = false } = options;
    const runLabel = '[WEEKLY-TRACK-4PM]';
    const jobId = `weekly_track_${Date.now()}`;

    if (this.isRunning) {
      console.log(`${runLabel} Already running, skipping duplicate trigger`);
      return { stocksAnalyzed: 0, skipped: 'already_running' };
    }

    this.isRunning = true;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`${runLabel} POSITION MANAGEMENT ANALYSIS STARTED`);
    console.log(`${'='.repeat(60)}`);
    console.log(`${runLabel} Job ID: ${jobId}`);
    console.log(`${runLabel} Time: ${new Date().toISOString()}`);
    console.log(`${runLabel} Force Reanalyze: ${forceReanalyze}`);

    const result = {
      stocksAnalyzed: 0,
      successful: 0,
      failed: 0,
      skipped: 0,
      cached: 0,
      errors: []
    };

    try {
      // Step 1: Get all unique instrument_keys from all users with weekly_track
      console.log(`\n${runLabel} Step 1: Collecting unique weekly_track stocks...`);
      const uniqueStocks = await this.getUniqueWeeklyTrackStocks();
      console.log(`${runLabel} Found ${uniqueStocks.length} unique stocks to analyze`);

      if (uniqueStocks.length === 0) {
        console.log(`${runLabel} No weekly_track stocks found. Exiting.`);
        this.isRunning = false;
        return result;
      }

      // Log stocks
      uniqueStocks.forEach((s, i) => {
        console.log(`${runLabel}    ${i + 1}. ${s.trading_symbol} (${s.userCount} users)`);
      });

      // Step 2: Fetch prices for all stocks
      console.log(`\n${runLabel} Step 2: Fetching current prices...`);
      const instrumentKeys = uniqueStocks.map(s => s.instrument_key);
      const priceMap = await priceCacheService.getLatestPrices(instrumentKeys);

      // Step 3: Analyze each stock
      console.log(`\n${runLabel} Step 3: Running position management analysis...`);
      console.log(`${runLabel} ${'─'.repeat(40)}`);

      // Use concurrency limit for AI calls
      const CONCURRENCY_LIMIT = 3;
      const limit = pLimit(CONCURRENCY_LIMIT);

      const analysisTasks = uniqueStocks.map(stock => {
        return limit(async () => {
          try {
            const currentPrice = priceMap[stock.instrument_key];
            if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
              console.log(`${runLabel} ⏭️ ${stock.trading_symbol} - SKIP (no valid price)`);
              result.skipped++;
              return;
            }

            const analysisResult = await this.analyzeStock(stock, currentPrice, { forceReanalyze });
            result.stocksAnalyzed++;

            if (analysisResult.cached) {
              result.cached++;
              console.log(`${runLabel} ⏭️ ${stock.trading_symbol} - CACHE HIT`);
            } else if (analysisResult.success) {
              result.successful++;
              this.stats.aiCallsSuccess++;
              console.log(`${runLabel} ✅ ${stock.trading_symbol} - ${analysisResult.status?.label || 'ANALYZED'}`);
            } else {
              result.failed++;
              this.stats.aiCallsFailed++;
              console.log(`${runLabel} ❌ ${stock.trading_symbol} - FAILED: ${analysisResult.error}`);
              result.errors.push({ symbol: stock.trading_symbol, error: analysisResult.error });
            }
          } catch (error) {
            result.failed++;
            this.stats.aiCallsFailed++;
            console.error(`${runLabel} ❌ ${stock.trading_symbol} - ERROR: ${error.message}`);
            result.errors.push({ symbol: stock.trading_symbol, error: error.message });
          }
        });
      });

      await Promise.all(analysisTasks);

      // Summary
      console.log(`\n${runLabel} ${'─'.repeat(40)}`);
      console.log(`${runLabel} ANALYSIS COMPLETE`);
      console.log(`${runLabel} ${'─'.repeat(40)}`);
      console.log(`${runLabel} Total stocks: ${uniqueStocks.length}`);
      console.log(`${runLabel} ✅ Successful: ${result.successful}`);
      console.log(`${runLabel} ⏭️ Cached: ${result.cached}`);
      console.log(`${runLabel} ⏭️ Skipped: ${result.skipped}`);
      console.log(`${runLabel} ❌ Failed: ${result.failed}`);
      console.log(`${'='.repeat(60)}\n`);

      this.stats.stocksAnalyzed += result.stocksAnalyzed;

      // Send push notification to all users if any stocks were analyzed
      if (result.successful > 0) {
        try {
          await firebaseService.sendAnalysisCompleteToAllUsers(
            'Position Analysis Ready',
            `${result.successful} stock${result.successful > 1 ? 's' : ''} analyzed for position management`,
            { type: 'weekly_analysis', route: '/watchlist' }
          );
          console.log(`${runLabel} 📱 Push notifications sent to all users`);
        } catch (notifError) {
          console.error(`${runLabel} ⚠️ Failed to send notifications:`, notifError.message);
        }
      }

      return result;

    } catch (error) {
      console.error(`${runLabel} ❌ Analysis job failed:`, error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get unique stocks from all users with weekly_track source
   * Uses MongoDB aggregation for efficiency
   */
  async getUniqueWeeklyTrackStocks() {
    const AGGREGATION_TIMEOUT_MS = 30000; // 30 second timeout

    try {
      const result = await User.aggregate([
        { $unwind: '$watchlist' },
        { $match: { 'watchlist.added_source': 'weekly_track' } },
        {
          $group: {
            _id: '$watchlist.instrument_key',
            trading_symbol: { $first: '$watchlist.trading_symbol' },
            name: { $first: '$watchlist.name' },
            exchange: { $first: '$watchlist.exchange' },
            userCount: { $sum: 1 }
          }
        }
      ]).maxTimeMS(AGGREGATION_TIMEOUT_MS);

      return result.map(r => ({
        instrument_key: r._id,
        trading_symbol: r.trading_symbol,
        name: r.name,
        exchange: r.exchange,
        userCount: r.userCount
      }));
    } catch (error) {
      // Handle MongoDB aggregation errors
      if (error.code === 50 || error.message?.includes('exceeded time limit')) {
        console.error('[WEEKLY-TRACK] MongoDB aggregation timeout - too many users/watchlist items');
        throw new Error('Database query timed out. Please try again later.');
      }
      console.error('[WEEKLY-TRACK] MongoDB aggregation error:', error.message);
      throw error;
    }
  }

  /**
   * Analyze a single stock - generates position management analysis
   * @param {Object} stock - { instrument_key, trading_symbol, name }
   * @param {number} currentPrice - Current market price
   * @param {Object} options - { forceReanalyze }
   */
  async analyzeStock(stock, currentPrice, options = {}) {
    const { forceReanalyze = false } = options;
    const { instrument_key, trading_symbol, name } = stock;

    console.log(`[POSITION-MGMT] 📍 A1: Starting analyzeStock for ${trading_symbol}`);

    // Check if today's analysis already exists
    const todayStart = this.getTodayStart();
    console.log(`[POSITION-MGMT] 📍 A2: Checking existing analysis since ${todayStart}`);

    const existingAnalysis = await StockAnalysis.findOne({
      instrument_key,
      analysis_type: 'position_management',
      status: 'completed',
      created_at: { $gte: todayStart }
    });

    if (existingAnalysis && !forceReanalyze) {
      console.log(`[POSITION-MGMT] 📍 A3: Found cached analysis, returning`);
      return { cached: true, success: true };
    }

    // 1. Get original swing analysis (for entry/stop/target levels)
    console.log(`[POSITION-MGMT] 📍 A4: Looking for swing analysis...`);
    const swingAnalysis = await StockAnalysis.findOne({
      instrument_key,
      analysis_type: 'swing',
      status: 'completed'
    }).sort({ created_at: -1 }).lean();

    if (!swingAnalysis) {
      console.log(`[POSITION-MGMT] ❌ A5: No swing analysis found!`);
      return {
        success: false,
        error: 'No swing analysis found - cannot generate position management'
      };
    }
    console.log(`[POSITION-MGMT] 📍 A5: Found swing analysis: ${swingAnalysis._id}`);

    // 2. Get today's candle data
    console.log(`[POSITION-MGMT] 📍 A6: Fetching candle data...`);
    let todayCandle = null;
    try {
      const candles = await candleFetcherService.fetchCandlesFromAPI(
        instrument_key,
        '1d',
        this.getYesterday(),
        new Date(),
        false
      );
      if (candles && candles.length > 0) {
        todayCandle = candles[candles.length - 1]; // Most recent candle
      }
      console.log(`[POSITION-MGMT] 📍 A6: Got ${candles?.length || 0} candles`);
    } catch (error) {
      console.warn(`[POSITION-MGMT] ⚠️ Could not fetch candles for ${trading_symbol}: ${error.message}`);
    }

    // Fallback if no candle data - use currentPrice or swing analysis entry as last resort
    if (!todayCandle) {
      const fallbackPrice = currentPrice || swingAnalysis.current_price || swingAnalysis.analysis_data?.market_summary?.last;
      console.log(`[POSITION-MGMT] 📍 A6: Using fallback candle with price ${fallbackPrice}`);
      todayCandle = {
        open: fallbackPrice,
        high: fallbackPrice,
        low: fallbackPrice,
        close: fallbackPrice
      };
    }

    // Use candle close as the definitive current price
    const finalCurrentPrice = todayCandle.close || currentPrice || swingAnalysis.current_price;
    console.log(`[POSITION-MGMT] 📍 A6b: Final current price: ${finalCurrentPrice}`);

    // 3. Extract original levels from swing analysis
    console.log(`[POSITION-MGMT] 📍 A7: Extracting levels from swing analysis...`);
    const strategy = swingAnalysis.analysis_data?.strategies?.[0];
    const tradingPlan = swingAnalysis.analysis_data?.trading_plan;

    const originalLevels = {
      entry: tradingPlan?.entry || strategy?.entry,
      stop: tradingPlan?.stop_loss || strategy?.stopLoss,
      target: tradingPlan?.target || strategy?.target,
      riskReward: tradingPlan?.risk_reward || strategy?.riskReward
    };

    console.log(`[POSITION-MGMT] 📍 A7: Levels:`, originalLevels);

    // Validate we have required levels
    if (!originalLevels.entry || !originalLevels.stop || !originalLevels.target) {
      console.log(`[POSITION-MGMT] ❌ A8: Missing levels!`);
      return {
        success: false,
        error: 'Missing entry/stop/target levels in swing analysis'
      };
    }

    // 4. Get RSI from indicators if available
    console.log(`[POSITION-MGMT] 📍 A8: Getting RSI...`);
    let rsi = null;
    try {
      const marketData = await candleFetcherService.getMarketDataForTriggers(instrument_key, []);
      rsi = marketData?.indicators?.['1d']?.rsi || marketData?.indicators?.['1h']?.rsi || null;
      console.log(`[POSITION-MGMT] 📍 A8: RSI = ${rsi}`);
    } catch (error) {
      console.log(`[POSITION-MGMT] ⚠️ A8: RSI fetch failed, continuing...`);
    }

    // 5. Get market context (Nifty change)
    let niftyChangePct = null;

    // 6. Build prompt (GLOBAL - shows both if_holding + if_watching)
    console.log(`[POSITION-MGMT] 📍 A9: Building prompt...`);
    const generatedAtIst = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const { system, user } = await buildPositionManagementPrompt({
      stock_name: name || trading_symbol,
      stock_symbol: trading_symbol,
      current_price: finalCurrentPrice,
      generatedAtIst,
      original_levels: originalLevels,
      original_score: {
        score: swingAnalysis.analysis_data?.setup_score?.total,
        grade: swingAnalysis.analysis_data?.setup_score?.grade
      },
      today_open: todayCandle.open,
      today_high: todayCandle.high,
      today_low: todayCandle.low,
      today_close: todayCandle.close || finalCurrentPrice,
      today_change_pct: todayCandle.close && todayCandle.open
        ? ((todayCandle.close - todayCandle.open) / todayCandle.open) * 100
        : null,
      rsi,
      nifty_change_pct: niftyChangePct
    });

    // 7. Call AI
    console.log(`[POSITION-MGMT] 📍 A10: Calling AI...`);
    let analysisData;
    try {
      analysisData = await this.callAI(system, user);
      console.log(`[POSITION-MGMT] 📍 A10: AI returned:`, analysisData?.status?.label || 'unknown');
    } catch (aiError) {
      console.log(`[POSITION-MGMT] ❌ A10: AI call failed:`, aiError.message);
      return {
        success: false,
        error: `AI call failed: ${aiError.message}`
      };
    }

    // 8. Calculate valid_until (next day 9 AM IST)
    const validUntil = this.getNextDay9AM();
    console.log(`[POSITION-MGMT] 📍 A11: Valid until ${validUntil}`);

    // 9. Store in StockAnalysis
    console.log(`[POSITION-MGMT] 📍 A12: Saving to DB with price ${finalCurrentPrice}...`);
    const savedAnalysis = await StockAnalysis.findOneAndUpdate(
      {
        instrument_key,
        analysis_type: 'position_management',
        created_at: { $gte: todayStart }
      },
      {
        instrument_key,
        stock_name: name || trading_symbol,
        stock_symbol: trading_symbol,
        analysis_type: 'position_management',
        current_price: finalCurrentPrice,
        analysis_data: {
          schema_version: '1.0',
          symbol: trading_symbol,
          analysis_type: 'position_management',
          generated_at_ist: generatedAtIst,
          position_management: analysisData,
          original_swing_analysis_id: swingAnalysis._id,
          original_levels: originalLevels
        },
        status: 'completed',
        valid_until: validUntil,
        created_at: new Date()
      },
      { upsert: true, new: true }
    );
    console.log(`[POSITION-MGMT] ✅ A13: Saved analysis: ${savedAnalysis._id}`);

    return {
      success: true,
      cached: false,
      status: analysisData?.status,
      analysisId: savedAnalysis._id
    };
  }

  /**
   * Call OpenAI API with retry logic
   */
  async callAI(systemPrompt, userPrompt) {
    const modelConfig = await modelSelectorService.determineAIModel();
    const model = modelConfig.models.analysis;

    // Format messages - handle o1 models that don't support system role
    const isO1Model = model && (model.includes('o1-') || model.startsWith('o1'));

    let messages;
    if (isO1Model) {
      messages = [
        { role: 'user', content: `${systemPrompt}\n\n${userPrompt}` }
      ];
    } else {
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];
    }

    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model,
            messages,
            temperature: 0.3,
            max_tokens: 3000
          },
          {
            headers: {
              'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 60000
          }
        );

        const content = response.data.choices[0]?.message?.content;
        if (!content) {
          throw new Error('Empty response from AI');
        }

        // Parse JSON response - extract JSON object with proper brace matching
        let analysisData;
        try {
          // Try direct parse first (if response is pure JSON)
          const trimmedContent = content.trim();
          if (trimmedContent.startsWith('{')) {
            analysisData = JSON.parse(trimmedContent);
          } else {
            // Find JSON object with brace matching
            const startIdx = content.indexOf('{');
            if (startIdx === -1) {
              throw new Error('No JSON found in AI response');
            }

            // Find matching closing brace
            let braceCount = 0;
            let endIdx = -1;
            for (let i = startIdx; i < content.length; i++) {
              if (content[i] === '{') braceCount++;
              if (content[i] === '}') braceCount--;
              if (braceCount === 0) {
                endIdx = i;
                break;
              }
            }

            if (endIdx === -1) {
              throw new Error('Incomplete JSON in AI response - missing closing brace');
            }

            const jsonStr = content.substring(startIdx, endIdx + 1);
            analysisData = JSON.parse(jsonStr);
          }
        } catch (parseError) {
          console.error('[POSITION-MGMT] JSON parse error. Raw content:', content.substring(0, 500));
          throw new Error(`Invalid JSON in AI response: ${parseError.message}`);
        }

        // Basic schema validation
        if (!analysisData.status || !analysisData.recommendation) {
          throw new Error('AI response missing required fields (status, recommendation)');
        }

        return analysisData;

      } catch (error) {
        lastError = error;

        // Check for retryable errors (rate limit + transient server errors)
        const status = error.response?.status;
        const isRetryable =
          status === 429 ||  // Rate limit
          status === 500 ||  // Server error
          status === 502 ||  // Bad gateway
          status === 503 ||  // Service unavailable
          error.code === 'ECONNRESET' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ECONNABORTED';

        if (isRetryable && attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
          console.log(`[WEEKLY-TRACK] Retryable error (${status || error.code}), waiting ${Math.round(delay)}ms before retry ${attempt + 1}`);
          await this.delay(delay);
          continue;
        }

        if (attempt === maxRetries) {
          throw lastError;
        }
      }
    }

    throw lastError;
  }

  /**
   * Helper: Get today at midnight IST (returns UTC Date for MongoDB queries)
   */
  getTodayStart() {
    // IST is UTC+5:30
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

    // Get current time in IST
    const now = new Date();
    const istNow = new Date(now.getTime() + IST_OFFSET_MS);

    // Set to midnight IST
    const istMidnight = new Date(istNow);
    istMidnight.setUTCHours(0, 0, 0, 0);

    // Convert back to UTC for MongoDB
    return new Date(istMidnight.getTime() - IST_OFFSET_MS);
  }

  /**
   * Helper: Get yesterday's date
   */
  getYesterday() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  }

  /**
   * Helper: Get next trading day 9 AM IST (valid_until time)
   * 9 AM IST = 3:30 AM UTC
   * Skips weekends: Fri → Mon 9AM, Sat → Mon 9AM, Sun → Mon 9AM
   * @param {Date} fromDate - Base date to calculate from (defaults to now)
   */
  getNextDay9AM(fromDate = new Date()) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(fromDate.getTime() + IST_OFFSET_MS);
    const dayOfWeek = istNow.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat

    let daysToAdd = 1;
    // Skip weekends: next day should be a weekday
    if (dayOfWeek === 5) daysToAdd = 3;      // Fri → Mon
    else if (dayOfWeek === 6) daysToAdd = 2;  // Sat → Mon
    else if (dayOfWeek === 0) daysToAdd = 1;  // Sun → Mon

    const nextDay = new Date(istNow);
    nextDay.setUTCDate(nextDay.getUTCDate() + daysToAdd);

    // Extract IST calendar date, then build 9 AM IST as UTC
    const year = nextDay.getUTCFullYear();
    const month = nextDay.getUTCMonth();
    const day = nextDay.getUTCDate();
    const utcMs = Date.UTC(year, month, day, 9, 0, 0, 0) - IST_OFFSET_MS;
    return new Date(utcMs);
  }

  /**
   * Helper: Delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Manually trigger analysis
   */
  async triggerNow(options = {}) {
    if (!this.isInitialized) {
      throw new Error('Weekly track analysis job not initialized');
    }

    console.log('[WEEKLY-TRACK] Manual trigger requested');

    const job = await this.agenda.now('manual-weekly-track-analysis', options);

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
      isInitialized: this.isInitialized,
      isRunning: this.isRunning
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.agenda) {
      await this.agenda.stop();
      console.log('[WEEKLY-TRACK] Shutdown complete');
    }
  }
}

// Export singleton instance
const weeklyTrackAnalysisJob = new WeeklyTrackAnalysisJob();

export default weeklyTrackAnalysisJob;
export { WeeklyTrackAnalysisJob };
