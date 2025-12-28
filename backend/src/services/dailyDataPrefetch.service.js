import { User } from '../models/user.js';
import Stock from '../models/stock.js';
import PreFetchedData from '../models/preFetchedData.js';
import DailyJobStatus from '../models/dailyJobStatus.js';
import MarketHoursUtil from '../utils/marketHours.js';
import upstoxMarketTimingService from './upstoxMarketTiming.service.js';
import candleFetcherService from './candleFetcher.service.js';

class DailyDataPrefetchService {

  /**
   * Normalize timeframe to lowercase for consistency
   * @param {string} timeframe - Input timeframe (1d, 1d, 15M, 15m, etc.)
   * @returns {string} - Normalized lowercase timeframe
   */
  normalizeTimeframe(timeframe) {
    return timeframe.toLowerCase();
  }

  constructor() {
    this.timeframes = ['15m', '1h', '1d'];
    this.barsRequired = {
      '15m': 400,
      '1h': 900,
      '1d': 240
    };
    this.maxConcurrentFetches = 5; // Rate limiting
    this.delayBetweenFetches = 1000; // 1 second delay
  }

  /**
   * Main entry point for daily data pre-fetch
   */
  async runDailyPrefetch(targetDate = null) {
    const tradingDate = MarketHoursUtil.normalizeDateToMidnight(targetDate || new Date());

    // Check if this is a trading day
    const isTradingDay = await MarketHoursUtil.isTradingDay(tradingDate);
    if (!isTradingDay) {

      return { success: false, reason: 'not_trading_day' };
    }

    // Check if job already completed
    const existingJob = await DailyJobStatus.getLatestJob('data_prefetch', tradingDate);
    if (existingJob && existingJob.status === 'completed') {

      return { success: true, reason: 'already_completed', job: existingJob };
    }

    // Get unique stocks from all user watchlists
    const uniqueStocks = await this.getUniqueWatchlistStocks();

    if (uniqueStocks.length === 0) {

      return { success: false, reason: 'no_stocks' };
    }

    // Create or update job status
    let jobStatus = existingJob && existingJob.status !== 'completed' ?
    existingJob :
    DailyJobStatus.createJob(tradingDate, 'data_prefetch', uniqueStocks.length);

    jobStatus.status = 'running';
    jobStatus.started_at = new Date();
    await jobStatus.save();

    try {
      const results = await this.prefetchStockData(uniqueStocks, tradingDate, jobStatus);

      // Update job summary
      jobStatus.summary.unique_stocks = uniqueStocks.length;
      jobStatus.summary.user_watchlists_processed = await this.getUserWatchlistCount();

      jobStatus.markCompleted();
      await jobStatus.save();

      return {
        success: true,
        job: jobStatus,
        results: results
      };

    } catch (error) {
      console.error(`❌ [PREFETCH] Daily pre-fetch failed:`, error);
      jobStatus.markFailed(error.message);
      await jobStatus.save();

      return {
        success: false,
        error: error.message,
        job: jobStatus
      };
    }
  }

  /**
   * Get unique stocks from all user watchlists
   */
  async getUniqueWatchlistStocks() {
    try {
      // Get all users with non-empty watchlists
      const users = await User.find({
        watchlist: { $exists: true, $not: { $size: 0 } }
      }).select('watchlist').lean();

      // Flatten all watchlists and get unique instrument_keys
      const allStocks = users.flatMap((user) => user.watchlist || []);
      const uniqueInstrumentKeys = [...new Set(allStocks.map((stock) => stock.instrument_key))];

      // Get stock details for each unique instrument_key
      const stockDetails = [];
      for (const instrumentKey of uniqueInstrumentKeys) {
        const stockInfo = await Stock.getByInstrumentKey(instrumentKey);
        if (stockInfo) {
          stockDetails.push({
            instrument_key: instrumentKey,
            stock_symbol: stockInfo.trading_symbol,
            stock_name: stockInfo.name
          });
        }
      }

      return stockDetails;

    } catch (error) {
      console.error(`❌ [PREFETCH] Error getting watchlist stocks:`, error);
      throw error;
    }
  }

  /**
   * Pre-fetch data for all stocks and timeframes
   */
  async prefetchStockData(stocks, tradingDate, jobStatus) {
    let successCount = 0;
    let totalBars = 0;
    let totalApiCalls = 0;
    const errors = [];

    // Process stocks in batches to avoid overwhelming the API
    for (let i = 0; i < stocks.length; i += this.maxConcurrentFetches) {
      const batch = stocks.slice(i, i + this.maxConcurrentFetches);

      // Process batch concurrently
      const batchPromises = batch.map((stock) => this.prefetchSingleStock(stock, tradingDate, jobStatus));
      const batchResults = await Promise.allSettled(batchPromises);

      // Process results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          successCount++;
          totalBars += result.value.totalBars;
          totalApiCalls += result.value.apiCalls;
        } else {
          errors.push(result.reason);
          console.error(`❌ [PREFETCH] Batch error:`, result.reason);
        }
      }

      // Update progress
      jobStatus.updateProgress(Math.min(i + this.maxConcurrentFetches, stocks.length));
      await jobStatus.save();

      // Rate limiting delay between batches
      if (i + this.maxConcurrentFetches < stocks.length) {
        await this.delay(this.delayBetweenFetches);
      }
    }

    // Update final job summary
    jobStatus.summary.total_api_calls = totalApiCalls;
    jobStatus.summary.total_bars_fetched = totalBars;

    return {
      successCount,
      totalBars,
      totalApiCalls,
      errors
    };
  }

  /**
   * Pre-fetch data for a single stock using candleFetcherService (simplified)
   */
  async prefetchSingleStock(stock, tradingDate, jobStatus) {
    const startTime = Date.now();
    let totalBars = 0;
    let apiCalls = 0;

    try {
      // Use candleFetcherService as single source of truth
      const candleResult = await candleFetcherService.getCandleDataForAnalysis(
        stock.instrument_key,
        'swing' // Use swing term for comprehensive data
      );

      if (candleResult.success) {
        const timeframes = Object.keys(candleResult.data);

        // Count bars and log results
        for (const timeframe of timeframes) {
          const bars = candleResult.data[timeframe]?.length || 0;
          totalBars += bars;

          jobStatus.updateProgress(jobStatus.stocks_processed, timeframe, bars);
        }

        // If data came from API, count as API call
        if (candleResult.source === 'api') {
          apiCalls = 1; // candleFetcherService handles all API calls internally
        }

        const duration = Date.now() - startTime;

        return { totalBars, apiCalls, duration };

      } else {
        const errorMsg = `Failed to get data: ${candleResult.error || 'Unknown error'}`;
        jobStatus.addError('FETCH_ERROR', stock.stock_symbol, 'all', errorMsg);
        console.error(`❌ [PREFETCH] ${stock.stock_symbol}: ${errorMsg}`);

        return { totalBars: 0, apiCalls: 0, duration: Date.now() - startTime };
      }

    } catch (error) {
      jobStatus.addError('FETCH_ERROR', stock.stock_symbol, 'all', error.message);
      console.error(`❌ [PREFETCH] Failed to process ${stock.stock_symbol}:`, error);

      return { totalBars: 0, apiCalls: 0, duration: Date.now() - startTime };
    }
  }

  /**
   * Run current day data pre-fetch using candleFetcherService
   * ENHANCED: Uses intraday API to get today's candlestick data and append to existing historical data
   * Perfect timing: runs at 4:05 PM after market close to get complete EOD data
   */
  async runCurrentDayPrefetch() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const currentTimeMinutes = hours * 60 + minutes;
    const PREFETCH_AFTER = 16 * 60; // 4:00 PM

    if (currentTimeMinutes < PREFETCH_AFTER) {

      return { success: false, reason: 'too_early' };
    }

    // Check if today is a trading day
    const today = MarketHoursUtil.normalizeDateToMidnight(new Date());

    const isTradingDay = await MarketHoursUtil.isTradingDay(today);
    if (!isTradingDay) {

      return { success: false, reason: 'not_trading_day' };
    }

    // Get unique stocks from all user watchlists
    const uniqueStocks = await this.getUniqueWatchlistStocks();

    if (uniqueStocks.length === 0) {
      return { success: false, reason: 'no_stocks' };
    }

    let successCount = 0;
    let totalBars = 0;
    let totalApiCalls = 0;
    const errors = [];

    try {
      // Process stocks in smaller batches
      for (let i = 0; i < uniqueStocks.length; i += this.maxConcurrentFetches) {
        const batch = uniqueStocks.slice(i, i + this.maxConcurrentFetches);

        // Use candleFetcherService for each stock in batch
        const batchPromises = batch.map(async (stock) => {
          try {
            const candleResult = await candleFetcherService.getCandleDataForAnalysis(
              stock.instrument_key,
              'swing'
            );

            if (candleResult.success) {
              const timeframes = Object.keys(candleResult.data);
              const stockTotalBars = timeframes.reduce((sum, tf) =>
              sum + (candleResult.data[tf]?.length || 0), 0
              );

              return {
                totalBars: stockTotalBars,
                apiCalls: candleResult.source === 'api' ? 1 : 0,
                success: true
              };
            } else {
              console.error(`❌ [CURRENT DAY PREFETCH] ${stock.stock_symbol}: ${candleResult.error}`);
              return { totalBars: 0, apiCalls: 0, success: false };
            }
          } catch (error) {
            console.error(`❌ [CURRENT DAY PREFETCH] ${stock.stock_symbol}:`, error.message);
            return { totalBars: 0, apiCalls: 0, success: false };
          }
        });

        const batchResults = await Promise.allSettled(batchPromises);

        // Process results
        for (const result of batchResults) {
          if (result.status === 'fulfilled' && result.value.success) {
            successCount++;
            totalBars += result.value.totalBars;
            totalApiCalls += result.value.apiCalls;
          } else {
            errors.push(result.reason || 'Unknown error');
          }
        }

        // Rate limiting delay between batches
        if (i + this.maxConcurrentFetches < uniqueStocks.length) {
          await this.delay(this.delayBetweenFetches);
        }
      }

      return {
        success: true,
        results: { successCount, totalBars, totalApiCalls, errors }
      };

    } catch (error) {
      console.error(`❌ [CURRENT DAY PREFETCH] Current day pre-fetch failed:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Store candle data in database
   */
  async storeCandleData(stock, timeframe, tradingDate, candleData) {
    try {
      // Analyze data quality
      const dataQuality = this.analyzeDataQuality(candleData, timeframe);

      const preFetchedData = new PreFetchedData({
        instrument_key: stock.instrument_key,
        stock_symbol: stock.stock_symbol,
        timeframe: this.normalizeTimeframe(timeframe),
        trading_date: tradingDate,
        candle_data: candleData,
        bars_count: candleData.length,
        data_quality: dataQuality,
        fetched_at: new Date(),
        updated_at: new Date(),
        upstox_payload: {
          fetched_at: new Date(),
          original_count: candleData.length,
          timeframe: timeframe
        }
      });

      await preFetchedData.save();
      return preFetchedData;

    } catch (error) {
      if (error.code === 11000) {
        // Duplicate key - data already exists

        return null;
      }
      throw error;
    }
  }

  /**
   * Analyze data quality for gaps and missing bars
   */
  analyzeDataQuality(candleData, timeframe) {
    if (!candleData || candleData.length === 0) {
      return {
        missing_bars: 0,
        has_gaps: false,
        last_bar_time: null
      };
    }

    // Sort by timestamp (IST string timestamps)
    const sortedData = candleData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const expectedBars = this.barsRequired[timeframe] || 100;
    const missingBars = Math.max(0, expectedBars - sortedData.length);

    // Check for gaps (simplified)
    let hasGaps = false;
    if (sortedData.length > 1) {
      const timeInterval = this.getTimeIntervalMs(timeframe);
      for (let i = 1; i < sortedData.length; i++) {
        const timeDiff = new Date(sortedData[i].timestamp) - new Date(sortedData[i - 1].timestamp);
        if (timeDiff > timeInterval * 1.5) {// Allow 50% tolerance
          hasGaps = true;
          break;
        }
      }
    }

    return {
      missing_bars: missingBars,
      has_gaps: hasGaps,
      last_bar_time: new Date(sortedData[sortedData.length - 1].timestamp) // Convert to Date for storage
    };
  }

  /**
   * Get time interval in milliseconds for timeframe
   */
  getTimeIntervalMs(timeframe) {
    const intervals = {
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000
    };
    return intervals[timeframe] || 60 * 1000;
  }

  /**
   * Get count of users with watchlists
   */
  async getUserWatchlistCount() {
    return await User.countDocuments({
      watchlist: { $exists: true, $not: { $size: 0 } }
    });
  }

  /**
   * Utility delay function
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get pre-fetched data for analysis
   */
  static async getDataForAnalysis(instrumentKey, analysisType = 'swing') {
    const today = MarketHoursUtil.normalizeDateToMidnight(new Date());

    try {
      const data = await PreFetchedData.getDataForAnalysis(
        instrumentKey,
        ['15m', '1h', '1d'], // Standardized to lowercase only
        today
      );

      if (data && data.length > 0) {
        data.forEach((record, index) => {

        });
      }

      if (data && data.length > 0) {

        return {
          success: true,
          data: data,
          source: 'prefetched',
          timeframes: data.map((d) => d.timeframe)
        };
      } else {

        return {
          success: false,
          reason: 'no_prefetched_data'
        };
      }

    } catch (error) {
      console.error(`❌ [PREFETCH] Error getting pre-fetched data:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

const dailyDataPrefetchService = new DailyDataPrefetchService();
export default dailyDataPrefetchService;