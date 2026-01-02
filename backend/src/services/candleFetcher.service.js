import axios from 'axios';
import { aiReviewService } from './ai/aiReview.service.js';
import dailyDataPrefetchService from './dailyDataPrefetch.service.js';
import incrementalUpdaterService from './incrementalUpdater.service.js';
import intradayDailyMergeService from './intradayDailyMerge.service.js';
import dateCalculator from '../utils/dateCalculator.js';
import PreFetchedData from '../models/preFetchedData.js';
import MarketHoursUtil from '../utils/marketHours.js';
import { formatCandles } from '../utils/candleFormatter.js';
import { TIMEFRAME_TO_UPSTOX } from '../constants/timeframeMap.js';
// Import indicator calculation function from unified engine
import { indicators } from '../engine/index.js';
const calculateTechnicalIndicators = indicators.calculate;

/**
 * Dedicated service for candle data fetching and storage
 * Separates data fetching concerns from AI analysis
 */
class CandleFetcherService {
  constructor() {
    this.maxRetries = 3;
    this.retryDelay = 1000; // 1 second
  }

  /**
   * Main method: Get candle data for analysis (DB first, API fallback)
   * Automatically excludes intraday candles during market hours to avoid incomplete data
   * @param {string} instrumentKey - Stock instrument key
   * @param {string} term - Analysis term (short/long)
   * @param {boolean} skipIntraday - Skip intraday candles
   * @param {Object} options - Additional options
   * @param {Date} options.cutoffDate - Only include candles up to this date (for weekly analysis)
   */
  async getCandleDataForAnalysis(instrumentKey, term, skipIntraday = false, options = {}) {
    const { cutoffDate } = options;

    // ========== DEBUG: DATA FETCH TRACKING ==========
    const fetchStartTime = new Date();
    const istTime = new Date(fetchStartTime.getTime() + (5.5 * 60 * 60 * 1000)); // Convert to IST
    console.log(`\n🔍 ========== CANDLE DATA FETCH DEBUG ==========`);
    console.log(`📅 Fetch requested at: ${istTime.toISOString().replace('T', ' ').slice(0, 19)} IST`);
    console.log(`📊 Instrument: ${instrumentKey}`);
    console.log(`📈 Term: ${term}`);
    console.log(`⏭️ Skip Intraday: ${skipIntraday}`);
    console.log(`📅 Cutoff Date: ${cutoffDate ? cutoffDate.toISOString() : 'NONE (using latest data)'}`);
    console.log(`================================================\n`);

    // Check if market is currently open - if yes, exclude incomplete intraday candles
    try {
      // Step 1: Try to get pre-fetched data from database

      const preFetchedResult = await dailyDataPrefetchService.constructor.getDataForAnalysis(
        instrumentKey,
        term
      );

      if (preFetchedResult.data?.length > 0) {
        preFetchedResult.data.forEach((record, index) => {

        });
      }

      if (preFetchedResult.success && preFetchedResult.data?.length > 0) {
        // ========== DEBUG: DATABASE DATA FOUND ==========
        console.log(`\n💾 ========== DATABASE DATA FOUND ==========`);
        preFetchedResult.data.forEach((record) => {
          const lastBarTime = record.data_quality?.last_bar_time;
          const lastBarIST = lastBarTime ? new Date(new Date(lastBarTime).getTime() + (5.5 * 60 * 60 * 1000)).toISOString().replace('T', ' ').slice(0, 19) : 'N/A';
          const lastCandle = record.candle_data?.[record.candle_data.length - 1];
          const lastCandleTime = lastCandle?.timestamp || lastCandle?.[0];
          const lastCandleIST = lastCandleTime ? new Date(new Date(lastCandleTime).getTime() + (5.5 * 60 * 60 * 1000)).toISOString().replace('T', ' ').slice(0, 19) : 'N/A';
          console.log(`📊 ${record.timeframe}: ${record.candle_data?.length || 0} candles`);
          console.log(`   └─ Last bar time (DB metadata): ${lastBarIST} IST`);
          console.log(`   └─ Last candle timestamp: ${lastCandleIST} IST`);
          console.log(`   └─ Last candle OHLCV: O=${lastCandle?.open} H=${lastCandle?.high} L=${lastCandle?.low} C=${lastCandle?.close} V=${lastCandle?.volume}`);
        });
        console.log(`=============================================\n`);

        const freshnessCheck = await this.checkDataFreshness(preFetchedResult.data);

        // ========== DEBUG: FRESHNESS CHECK RESULT ==========
        console.log(`\n🕐 ========== DATA FRESHNESS CHECK ==========`);
        console.log(`📊 Is data fresh? ${freshnessCheck.fresh ? '✅ YES' : '❌ NO - NEEDS UPDATE'}`);
        if (!freshnessCheck.fresh && freshnessCheck.staleTimeframes?.length > 0) {
          console.log(`⚠️ Stale timeframes that need update:`);
          freshnessCheck.staleTimeframes.forEach((stale) => {
            const lastBarIST = stale.last_bar_time ? new Date(new Date(stale.last_bar_time).getTime() + (5.5 * 60 * 60 * 1000)).toISOString().replace('T', ' ').slice(0, 19) : 'N/A';
            console.log(`   └─ ${stale.timeframe}: Last bar at ${lastBarIST} IST (${stale.time_diff_hours || 0}h behind)`);
          });
        }
        console.log(`=============================================\n`);

        if (!freshnessCheck.fresh) {
          console.log(`\n🔄 ========== FETCHING INCREMENTAL UPDATE FROM API ==========`);
          const incrementalResult = await incrementalUpdaterService.fetchIncrementalDataAndMerge(
            instrumentKey,
            preFetchedResult.data,
            freshnessCheck.staleTimeframes,
            this.fetchCandlesFromAPI.bind(this),
            skipIntraday
          );
          if (incrementalResult.success) {
            console.log(`✅ Incremental update successful!`);
            // Refresh DB data
            const refreshed = await dailyDataPrefetchService.constructor.getDataForAnalysis(instrumentKey, term);
            preFetchedResult.data = refreshed.data;

            // ========== DEBUG: UPDATED DATA ==========
            console.log(`\n📊 ========== DATA AFTER INCREMENTAL UPDATE ==========`);
            refreshed.data.forEach((record) => {
              const lastCandle = record.candle_data?.[record.candle_data.length - 1];
              const lastCandleTime = lastCandle?.timestamp || lastCandle?.[0];
              const lastCandleIST = lastCandleTime ? new Date(new Date(lastCandleTime).getTime() + (5.5 * 60 * 60 * 1000)).toISOString().replace('T', ' ').slice(0, 19) : 'N/A';
              console.log(`📊 ${record.timeframe}: Now has ${record.candle_data?.length || 0} candles`);
              console.log(`   └─ Latest candle: ${lastCandleIST} IST`);
              console.log(`   └─ Latest OHLCV: O=${lastCandle?.open} H=${lastCandle?.high} L=${lastCandle?.low} C=${lastCandle?.close}`);
            });
            console.log(`======================================================\n`);
          } else {
            console.log(`❌ Incremental update failed - using stale DB data`);
          }
        }
        const sufficientData = this.checkDataSufficiency(preFetchedResult.data);
        if (sufficientData.sufficient) {

          // Apply cutoff date if provided (for weekly analysis using Friday-only data)
          const formattedData = this.formatDatabaseData(preFetchedResult.data, cutoffDate);

          if (cutoffDate) {
            console.log(`📅 [CANDLE FETCHER] Applied cutoff date: ${cutoffDate.toISOString()}`);
          }

          // ========== DEBUG: FINAL DATA SUMMARY ==========
          const fetchEndTime = new Date();
          const fetchDuration = fetchEndTime - fetchStartTime;
          console.log(`\n✅ ========== FINAL DATA FOR ANALYSIS ==========`);
          console.log(`📦 Data Source: DATABASE${!freshnessCheck.fresh ? ' + INCREMENTAL API UPDATE' : ''}`);
          console.log(`⏱️ Total fetch time: ${fetchDuration}ms`);
          Object.entries(formattedData).forEach(([timeframe, candles]) => {
            if (candles && candles.length > 0) {
              const lastCandle = candles[candles.length - 1];
              const lastCandleTime = lastCandle?.timestamp || lastCandle?.[0];
              const lastCandleIST = lastCandleTime ? new Date(new Date(lastCandleTime).getTime() + (5.5 * 60 * 60 * 1000)).toISOString().replace('T', ' ').slice(0, 19) : 'N/A';
              console.log(`📊 ${timeframe}: ${candles.length} candles → LATEST: ${lastCandleIST} IST (Close: ₹${lastCandle?.close})`);
            }
          });
          console.log(`================================================\n`);

          return {
            success: true,
            source: 'database',
            data: formattedData,
            cutoffApplied: !!cutoffDate
          };
        } else {

          // Return error response instead of falling through
          return {
            success: false,
            error: 'insufficient_data',
            reason: sufficientData.reason,
            source: 'database'
          };
        }

      } else
      {
        // ========== DEBUG: NO DATABASE DATA - FETCHING FROM API ==========
        console.log(`\n⚠️ ========== NO DATABASE DATA FOUND ==========`);
        console.log(`🌐 Fetching fresh data from Upstox API...`);
        console.log(`================================================\n`);

        const apiResult = await this.fetchFromAPI(instrumentKey, term, skipIntraday);

        // Apply cutoff date filter if provided (for weekly analysis using Friday-only data)
        let filteredData = apiResult;
        if (cutoffDate) {
          filteredData = {};
          const cutoffTime = cutoffDate.getTime();
          for (const [timeframe, candles] of Object.entries(apiResult)) {
            const originalCount = candles.length;
            const lastCandleBefore = candles.length > 0 ? candles[candles.length - 1]?.timestamp : null;

            filteredData[timeframe] = candles.filter(candle => {
              const candleTime = new Date(candle.timestamp).getTime();
              return candleTime <= cutoffTime;
            });

            const lastCandleAfter = filteredData[timeframe].length > 0 ? filteredData[timeframe][filteredData[timeframe].length - 1]?.timestamp : null;

            console.log(`📅 [CUTOFF FILTER API] ${timeframe}: ${originalCount} → ${filteredData[timeframe].length} candles`);
            console.log(`📅 [CUTOFF FILTER API] ${timeframe}: Last candle BEFORE filter: ${lastCandleBefore}`);
            console.log(`📅 [CUTOFF FILTER API] ${timeframe}: Last candle AFTER filter: ${lastCandleAfter}`);
          }
          console.log(`📅 [CANDLE FETCHER] Applied cutoff date to API data: ${cutoffDate.toISOString()}`);
        }

        // ========== DEBUG: API DATA SUMMARY ==========
        const fetchEndTime = new Date();
        const fetchDuration = fetchEndTime - fetchStartTime;
        console.log(`\n✅ ========== FINAL DATA FOR ANALYSIS (FROM API) ==========`);
        console.log(`📦 Data Source: UPSTOX API (fresh fetch)`);
        console.log(`⏱️ Total fetch time: ${fetchDuration}ms`);
        Object.entries(filteredData).forEach(([timeframe, candles]) => {
          if (candles && candles.length > 0) {
            const lastCandle = candles[candles.length - 1];
            const lastCandleTime = lastCandle?.timestamp || lastCandle?.[0];
            const lastCandleIST = lastCandleTime ? new Date(new Date(lastCandleTime).getTime() + (5.5 * 60 * 60 * 1000)).toISOString().replace('T', ' ').slice(0, 19) : 'N/A';
            console.log(`📊 ${timeframe}: ${candles.length} candles → LATEST: ${lastCandleIST} IST (Close: ₹${lastCandle?.close})`);
          }
        });
        console.log(`===========================================================\n`);

        return {
          success: true,
          source: 'api',
          data: filteredData,
          cutoffApplied: !!cutoffDate
        };
      }

      // Step 2: Fallback to API fetching

    } catch (error) {
      console.error(`❌ [CANDLE FETCHER] Failed to get data: ${error.message}`);
      throw error;
    }
  }

  async checkDataFreshness(preFetchedData) {

    const staleTimeframes = [];

    for (const timeframeData of preFetchedData) {
      const timeframe = timeframeData.timeframe;
      const lastBarTime = timeframeData.data_quality?.last_bar_time ?
      new Date(timeframeData.data_quality.last_bar_time) :
      null;

      if (!lastBarTime) {

        staleTimeframes.push({ timeframe, reason: 'no_last_bar_time' });
        continue;
      }

      // Get effective time for this specific timeframe
      // This already handles market open/closed logic internally
      const expectedTime = await MarketHoursUtil.getEffectiveTradingTime(new Date(), timeframe);

      // Calculate time difference
      const timeDiffMs = expectedTime - lastBarTime;
      const timeDiffHours = (timeDiffMs / (1000 * 60 * 60)).toFixed(2);
      const daysDiff = Math.floor(timeDiffMs / (1000 * 60 * 60 * 24));

      // Simple freshness check: Allow up to 3 days old (handles weekends/holidays)
      const isStale = lastBarTime < expectedTime;

      if (isStale) {
        staleTimeframes.push({
          timeframe,
          last_bar_time: lastBarTime,
          time_diff_hours: parseFloat(timeDiffHours)
        });
      }
    }

    if (staleTimeframes.length > 0) {

      return {
        fresh: false,
        reason: `${staleTimeframes.length} timeframe(s) have stale data`,
        staleTimeframes
      };
    }

    return { fresh: true, staleTimeframes: [] };
  }

  /**
   * Check if pre-fetched data has sufficient candles for analysis
   */
  checkDataSufficiency(preFetchedData) {
    for (const timeframeData of preFetchedData) {
      const required = dateCalculator.requiredBars[timeframeData.timeframe] || 100;
      const available = timeframeData.candle_data?.length || 0;
      const threshold = Math.floor(required * 0.98); // Need 98% of required data (reasonable for holidays/gaps)

      if (available < threshold) {

        return {
          sufficient: false,
          reason: `${timeframeData.timeframe} has only ${available}/${required} bars (need at least ${threshold})`
        };
      } else {

      }
    }

    return { sufficient: true };
  }

  /**
   * Format database data into standard structure
   * @param {Array} preFetchedData - Pre-fetched data from database
   * @param {Date} cutoffDate - Optional cutoff date to filter candles (for weekly analysis)
   */
  formatDatabaseData(preFetchedData, cutoffDate = null) {
    const candlesByTimeframe = {};

    preFetchedData.forEach((data) => {
      let candles = data.candle_data || [];
      const originalCount = candles.length;

      // Apply cutoff filter if provided (for weekly analysis using Friday-only data)
      if (cutoffDate) {
        const cutoffTime = cutoffDate.getTime();

        // Get last candle timestamp before filtering for logging
        const lastCandleBefore = candles.length > 0 ? candles[candles.length - 1]?.timestamp : null;

        candles = candles.filter(candle => {
          const candleTime = new Date(candle.timestamp).getTime();
          return candleTime <= cutoffTime;
        });

        // Get last candle timestamp after filtering for logging
        const lastCandleAfter = candles.length > 0 ? candles[candles.length - 1]?.timestamp : null;

        console.log(`📅 [CUTOFF FILTER] ${data.timeframe}: ${originalCount} → ${candles.length} candles`);
        console.log(`📅 [CUTOFF FILTER] ${data.timeframe}: Last candle BEFORE filter: ${lastCandleBefore}`);
        console.log(`📅 [CUTOFF FILTER] ${data.timeframe}: Last candle AFTER filter: ${lastCandleAfter}`);
        console.log(`📅 [CUTOFF FILTER] ${data.timeframe}: Cutoff applied: ${cutoffDate.toISOString()}`);
      }

      candlesByTimeframe[data.timeframe] = candles;
    });

    return candlesByTimeframe;
  }

  /**
   * Fetch candle data from API and store in database
   */
  async fetchFromAPI(instrumentKey, term, skipIntraday) {
    try {
      // Build endpoints using existing smart API selection
      const tradeData = { instrument_key: instrumentKey, term: term, skipIntraday };
      const endpoints = await this.buildEndpoints(tradeData);

      // console.log(`🔄 [API FETCH] Processing ${endpoints.length} endpoints`);

      // Fetch data from all endpoints
      const candleResults = [];
      for (const endpoint of endpoints) {
        const result = await this.fetchSingleEndpoint(endpoint, instrumentKey);
        candleResults.push(result);
      }

      // Process and clean the results
      const processedData = this.processAPIResults(candleResults);

      return processedData;

    } catch (error) {
      console.error(`❌ [API FETCH] Failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Build endpoints using hybrid approach: intraday + historical for complete data
   */
  async buildEndpoints(tradeData) {
    try {
      const timeframes = ['15m', '1h', '1d']; // Standard timeframes for analysis
      const endpoints = [];

      // Check if market is open (for AI analysis, skip intraday during market hours)

      for (const timeframe of timeframes) {

        const params = await dateCalculator.getTimeframeParams(timeframe);

        // Check if we need to use chunks (multiple API calls)
        if (params.chunks && params.chunks.length > 1) {

          // Create endpoint for each chunk (need to await async buildHistoricalUrlFromDates)
          for (let index = 0; index < params.chunks.length; index++) {
            const chunk = params.chunks[index];
            const chunkUrls = await this.buildHistoricalUrlFromDates(
              tradeData.instrument_key,
              timeframe,
              chunk.fromDate,
              chunk.toDate,
              tradeData.skipIntraday // Skip intraday if market is open
            );

            // Handle array of URLs (historical + intraday if needed)
            chunkUrls.forEach((url, urlIndex) => {
              const kind = url.includes('/intraday/') ? 'intraday' : 'historical';

              endpoints.push({
                frame: timeframe,
                kind: kind,
                url: url,
                params: { ...params, chunk: chunk, chunkIndex: index, urlIndex }
              });
            });
          }
        } else {
          // Single API call is sufficient
          const urls = await this.buildHistoricalUrlFromDates(
            tradeData.instrument_key,
            timeframe,
            params.fromDate,
            params.toDate,
            tradeData.skipIntraday // Skip intraday if market is open
          );

          // Handle array of URLs (historical + intraday if needed)
          urls.forEach((url, urlIndex) => {
            const kind = url.includes('/intraday/') ? 'intraday' : 'historical';

            endpoints.push({
              frame: timeframe,
              kind: kind,
              url: url,
              params: { ...params, urlIndex }
            });
          });
        }

      }

      return endpoints;
    } catch (error) {
      console.error(`❌ [ENDPOINTS] Failed to build: ${error.message}`);
      throw error;
    }
  }

  /**
   * Build intraday URL for current day data
   */
  buildIntradayUrl(instrumentKey, timeframe) {
    const mapping = TIMEFRAME_TO_UPSTOX[timeframe];
    if (!mapping) {
      throw new Error(`Unsupported timeframe for intraday API: ${timeframe}`);
    }

    return `https://api.upstox.com/v3/historical-candle/intraday/${instrumentKey}/${mapping.unit}/${mapping.interval}`;
  }

  /**
   * Build historical URL with proper date range
   */
  buildHistoricalUrl(instrumentKey, timeframe, params) {
    const mapping = TIMEFRAME_TO_UPSTOX[timeframe];
    if (!mapping) {
      throw new Error(`Unsupported timeframe for historical API: ${timeframe}`);
    }

    const fromDate = dateCalculator.formatDateISO(params.fromDate);
    const toDate = dateCalculator.formatDateISO(params.toDate);

    return `https://api.upstox.com/v3/historical-candle/${instrumentKey}/${mapping.unit}/${mapping.interval}/${toDate}/${fromDate}`;
  }

  /**
   * Build historical URL from specific from/to dates (for chunks)
   * Smart routing: Returns array of URLs
   * - If toDate is current trading day: Returns [historical_url_up_to_yesterday, intraday_url_for_today]
   * - Otherwise: Returns [historical_url]
   *
   * @param {boolean} skipIntraday - Skip intraday URLs (for AI analysis during market hours)
   * @returns {Promise<Array<string>>} Array of URLs to fetch
   */
  async buildHistoricalUrlFromDates(instrumentKey, timeframe, fromDate, toDate, skipIntraday = false) {
    const mapping = TIMEFRAME_TO_UPSTOX[timeframe];
    if (!mapping) {
      throw new Error(`Unsupported timeframe for historical API: ${timeframe}`);
    }

    if (fromDate instanceof Date && toDate instanceof Date) {
      fromDate = dateCalculator.formatDateISO(fromDate);
      toDate = dateCalculator.formatDateISO(toDate);
    }

    // Get effective trading time for this timeframe (in IST)
    const effectiveTime = await MarketHoursUtil.getEffectiveTradingTime(new Date(), timeframe);
    const effectiveDate = MarketHoursUtil.normalizeDateToMidnight(effectiveTime);
    const toDateNormalized = MarketHoursUtil.normalizeDateToMidnight(new Date(toDate));
    // Convert current time to IST before normalizing to avoid UTC/IST date mismatch
    const todayIST = MarketHoursUtil.toIST(new Date());
    const today = MarketHoursUtil.normalizeDateToMidnight(todayIST);

    // Check if toDate matches effective trading date (current trading day)
    const isCurrentTradingDay = toDateNormalized.getTime() === effectiveDate.getTime();
    const toDateIsToday = toDateNormalized.getTime() === today.getTime();

    // Debug logging for intraday URL decision

    const urls = [];

    // Always add historical URL first (for past data)
    const historicalUrl = `https://api.upstox.com/v3/historical-candle/${instrumentKey}/${mapping.unit}/${mapping.interval}/${toDate}/${fromDate}`;
    urls.push(historicalUrl);

    // Add intraday URL if toDate is current trading day (for today's live data)
    if ((isCurrentTradingDay || toDateIsToday) && !skipIntraday) {
      let intradayUrl = this.buildIntradayUrl(instrumentKey, timeframe);
      urls.push(intradayUrl);

    }

    return urls;
  }

  /**
   * Fetch data from a single endpoint with retry logic
   */
  async fetchSingleEndpoint(endpoint, instrumentKey) {
    let lastError;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {

        const response = await this.fetchCandleData(endpoint.url);
        const candles = response?.data?.candles || response?.candles || [];

        // Log detailed bar information
        const required = dateCalculator.requiredBars[endpoint.frame] || 400;
        const received = candles.length;
        const percentage = required > 0 ? (received / required * 100).toFixed(1) : 0;

        if (candles.length > 0) {
          const firstCandle = candles[0];
          const lastCandle = candles[candles.length - 1];
          const firstTime = Array.isArray(firstCandle) ? firstCandle[0] : firstCandle.time || firstCandle.timestamp;
          const lastTime = Array.isArray(lastCandle) ? lastCandle[0] : lastCandle.time || lastCandle.timestamp;

        }

        // Store in database for future use
        if (candles.length > 0) {
          await this.storeCandlesInDB(instrumentKey, endpoint.frame, candles);
        }

        return {
          success: true,
          frame: endpoint.frame,
          kind: endpoint.kind,
          candles: candles
        };

      } catch (error) {
        lastError = error;
        console.warn(`⚠️ [FETCH] ${endpoint.frame} attempt ${attempt} failed: ${error.message}`);

        if (attempt < this.maxRetries) {
          await this.delay(this.retryDelay);
        }
      }
    }

    return {
      success: false,
      frame: endpoint.frame,
      kind: endpoint.kind,
      error: lastError?.message || 'Unknown error'
    };
  }

  /**
   * Fetch candle data from URL (HTTP request)
   */
  async fetchCandleData(url) {
    try {
      const encodedUrl = url.replace(/\|/g, '%7C');

      const response = await axios.get(encodedUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000,
        validateStatus: function (status) {
          return status < 500;
        }
      });

      return response.data;

    } catch (error) {
      console.error(`❌ [HTTP] Candle fetch error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Store fetched candles in database with smart merge logic
   */
  async storeCandlesInDB(instrumentKey, timeframe, candles) {
    try {

      // Convert to standard format
      const formattedCandles = formatCandles(candles);

      // Use dailyDataPrefetchService to handle the merge properly
      const stockInfo = {
        instrument_key: instrumentKey,
        stock_symbol: instrumentKey.split('|')[2] || instrumentKey,
        stock_name: instrumentKey.split('|')[2] || instrumentKey
      };

      const today = MarketHoursUtil.normalizeDateToMidnight(new Date());

      // Check if existing data exists
      const existingData = await PreFetchedData.findOne({
        instrument_key: instrumentKey,
        timeframe: timeframe
      }).sort({ updated_at: -1 });

      if (existingData) {

        // Merge new candles with existing data
        const mergeResult = await this.mergeWithExistingData(existingData, formattedCandles, today, timeframe);

        if (mergeResult.success) {

        } else {
          console.warn(`⚠️ [MERGE] Merge failed: ${mergeResult.error}`);
        }
      } else {

        // Store as new record using prefetch service
        await dailyDataPrefetchService.storeCandleData(stockInfo, timeframe, today, formattedCandles);

      }

    } catch (error) {
      console.warn(`⚠️ [STORE] Failed to store ${timeframe} data: ${error.message}`);
    }
  }

  /**
   * Merge new candles with existing database data
   */
  async mergeWithExistingData(existingData, newCandles, tradingDate, timeframe) {
    try {
      const existingCandles = existingData.candle_data || [];

      // Filter new candles to only include ones not already in DB (by timestamp)
      const existingTimestamps = new Set(existingCandles.map((c) => new Date(c.timestamp).getTime()));
      const newCandlesOnly = newCandles.filter((candle) =>
      !existingTimestamps.has(new Date(candle.timestamp).getTime())
      );

      if (newCandlesOnly.length === 0) {
        return { success: true, newBars: 0, totalBars: existingCandles.length };
      }

      // Merge and sort all candles chronologically
      const allCandles = [...existingCandles, ...newCandlesOnly].
      sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      // Keep only required number of bars (trim oldest if necessary)
      const maxBars = dateCalculator.requiredBars[timeframe] || 400;
      const finalCandles = allCandles.slice(-maxBars);

      // Update the existing record
      existingData.candle_data = finalCandles;
      existingData.bars_count = finalCandles.length;
      existingData.trading_date = tradingDate;
      existingData.updated_at = new Date();

      // Ensure stock_symbol is set (may be missing in old records)
      if (!existingData.stock_symbol && existingData.instrument_key) {
        existingData.stock_symbol = existingData.instrument_key.split('|')[2] || existingData.instrument_key;
      }

      await existingData.save();

      return {
        success: true,
        newBars: newCandlesOnly.length,
        totalBars: finalCandles.length
      };

    } catch (error) {
      console.error(`❌ [MERGE] Error merging candles:`, error);
      return {
        success: false,
        error: error.message,
        newBars: 0
      };
    }
  }

  /**
   * Process API results into clean timeframe structure with smart merging
   */
  processAPIResults(candleResults) {
    const candlesByTimeframe = {};

    // Group results by timeframe and kind
    const resultsByTimeframe = {};

    candleResults.forEach((result) => {
      if (result.success && result.candles?.length > 0) {
        const timeframe = result.frame;

        if (!resultsByTimeframe[timeframe]) {
          resultsByTimeframe[timeframe] = { intraday: [], historical: [] };
        }

        // Group by kind (intraday vs historical)
        if (result.kind === 'intraday') {
          resultsByTimeframe[timeframe].intraday.push(...result.candles);

        } else {
          resultsByTimeframe[timeframe].historical.push(...result.candles);

        }
      }
    });

    // Merge intraday + historical for each timeframe
    Object.keys(resultsByTimeframe).forEach((timeframe) => {
      const { intraday, historical } = resultsByTimeframe[timeframe];

      // Combine all candles for this timeframe
      const allCandles = [...historical, ...intraday]; // Historical first, then intraday (chronological order)

      // Remove duplicates and sort
      candlesByTimeframe[timeframe] = this.deduplicateAndSort(allCandles);

      const requiredBars = dateCalculator.requiredBars[timeframe] || 400;
      const finalCount = candlesByTimeframe[timeframe].length;
      const percentage = (finalCount / requiredBars * 100).toFixed(1);

    });

    return candlesByTimeframe;
  }

  /**
   * Remove duplicate candles by timestamp and sort chronologically
   */
  deduplicateAndSort(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return [];

    // Create map to track unique timestamps (keeps latest occurrence)
    const uniqueCandles = new Map();

    candles.forEach((candle) => {
      const timestamp = Array.isArray(candle) ? candle[0] : candle.time || candle.timestamp;
      if (timestamp) {
        uniqueCandles.set(timestamp, candle);
      }
    });

    // Convert back to array and sort chronologically
    const sortedCandles = Array.from(uniqueCandles.values()).sort((a, b) => {
      const timeA = Array.isArray(a) ? a[0] : a.time || a.timestamp;
      const timeB = Array.isArray(b) ? b[0] : b.time || b.timestamp;
      return new Date(timeA) - new Date(timeB);
    });

    return sortedCandles;
  }

  /**
   * Utility delay function
   */
  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fetch candles from API for a specific date range (used for incremental updates)
   * Reuses existing buildHistoricalUrlFromDates() method to avoid code duplication
   * @param {string} instrumentKey - The instrument key
   * @param {string} interval - Upstox interval ('15minute', '60minute', 'day')
   * @param {string} fromDate - Start date (YYYY-MM-DD or Date object)
   * @param {string} toDate - End date (YYYY-MM-DD or Date object)
   * @returns {Array} - Array of candle objects
   */
  async fetchCandlesFromAPI(instrumentKey, interval, fromDate, toDate, skipIntraday = false) {

    try {

      // Map Upstox interval to standard timeframe for URL builder
      const intervalToTimeframeMap = {
        '15minute': '15m',
        '60minute': '1h',
        'day': '1d'
      };

      const timeframe = intervalToTimeframeMap[interval];
      if (!timeframe) {
        throw new Error(`Unsupported interval: ${interval}. Expected one of: 15minute, 60minute, day`);
      }

      // Convert string dates to Date objects if needed
      const fromDateObj = typeof fromDate === 'string' ? new Date(fromDate) : fromDate;
      const toDateObj = typeof toDate === 'string' ? new Date(toDate) : toDate;

      // Split date range into chunks based on Upstox API limits
      const chunks = await dateCalculator.splitDateRangeIntoChunks(timeframe, fromDateObj, toDateObj);
      let allCandles = [];
      let totalUrls = 0;

      // Check if we need to use chunks (multiple API calls due to Upstox limits)
      if (chunks && chunks.length > 1) {

        // Fetch data for each chunk
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunk = chunks[chunkIndex];

          const chunkUrls = await this.buildHistoricalUrlFromDates(
            instrumentKey,
            timeframe,
            chunk.fromDate,
            chunk.toDate,
            skipIntraday
          );

          totalUrls += chunkUrls.length;

          // Fetch data from each URL in this chunk
          for (let urlIndex = 0; urlIndex < chunkUrls.length; urlIndex++) {
            const url = chunkUrls[urlIndex];
            const urlType = url.includes('/intraday/') ? 'INTRADAY' : 'HISTORICAL';

            const startTime = Date.now();
            const response = await this.fetchCandleData(url);
            const duration = Date.now() - startTime;

            if (!response || !response.data || !response.data.candles) {

              continue;
            }

            const candles = response.data.candles;
            if (candles.length === 0) {

              continue;
            }

            // Show sample of raw data
            if (candles.length > 1) {

            }

            // Add to collection
            allCandles.push(...candles);
          }
        }
      } else {
        // Single API call is sufficient (no chunking needed)

        const urls = await this.buildHistoricalUrlFromDates(instrumentKey, timeframe, fromDate, toDate, skipIntraday);
        totalUrls = urls.length;

        // Fetch data from each URL
        for (let i = 0; i < urls.length; i++) {
          const url = urls[i];
          const urlType = url.includes('/intraday/') ? 'INTRADAY' : 'HISTORICAL';

          const startTime = Date.now();
          const response = await this.fetchCandleData(url);
          const duration = Date.now() - startTime;

          if (!response || !response.data || !response.data.candles) {

            continue;
          }

          const candles = response.data.candles;
          if (candles.length === 0) {

            continue;
          }

          // Show sample of raw data
          if (candles.length > 1) {

          }

          // Add to collection
          allCandles.push(...candles);
        }
      }
      if (allCandles.length === 0) {

        return [];
      }

      // Remove duplicates and sort by timestamp

      const uniqueCandles = new Map();
      allCandles.forEach((candle) => {
        const timestamp = candle[0]; // First element is timestamp
        uniqueCandles.set(timestamp, candle);
      });

      const dedupedCandles = Array.from(uniqueCandles.values());

      // Sort by timestamp
      const sortedCandles = dedupedCandles.sort((a, b) => {
        const timeA = a[0];
        const timeB = b[0];
        return new Date(timeA) - new Date(timeB);
      });

      // Convert array format to object format

      const formattedCandles = formatCandles(sortedCandles);

      return formattedCandles;

    } catch (error) {

      console.error(`   ├─ Error type: ${error.name}`);
      console.error(`   ├─ Error message: ${error.message}`);
      if (error.response) {
        console.error(`   ├─ HTTP status: ${error.response.status}`);
        console.error(`   └─ Response data: ${JSON.stringify(error.response.data).substring(0, 200)}`);
      }
      if (error.stack) {
        console.error(`   └─ Stack trace (first line): ${error.stack.split('\n')[0]}`);
      }

      throw error;
    }
  }

  /**
   * Get market data for trigger monitoring (adapter for candleData.js compatibility)
   * Returns data in format expected by trigger monitoring system
   * @param {string} instrumentKey - The instrument key
   * @param {Array} triggers - Array of trigger conditions with timeframes
   * @returns {Object} - Market data with timeframes and indicators
   */
  async getMarketDataForTriggers(instrumentKey, triggers = []) {

    try {
      // Extract unique timeframes from triggers (only DB-available timeframes: 15m, 1h, 1d)
      // Note: Current price (1m) is fetched separately via API below
      const timeframesNeeded = new Set();
      triggers.forEach((trigger) => {
        if (trigger.timeframe) {
          let normalized = trigger.timeframe.toLowerCase();
          if (normalized === '1d' || normalized === 'day' || normalized === '1day') {
            normalized = '1d';
          }
          // Only add timeframes that exist in our storage pipeline (15m, 1h, 1d)
          if (['15m', '1h', '1d'].includes(normalized)) {
            timeframesNeeded.add(normalized);
          } else {

          }
        }
      });

      // Get candle data using existing service (DB-first strategy)
      const result = await this.getCandleDataForAnalysis(instrumentKey, 'swing');

      if (!result.success) {
        throw new Error('Failed to fetch candle data');
      }

      // Transform data to trigger monitoring format
      const marketData = {
        current_price: null,
        timeframes: {},
        indicators: {}
      };

      // Process each timeframe
      for (const timeframe of Array.from(timeframesNeeded)) {
        let candles = result.data[timeframe];

        if (!candles || candles.length === 0) {

          continue;
        }

        // CRITICAL: Check trading_date from DB to determine data freshness
        // Strategy: DB = historical (previous days), API = today only

        // Query PreFetchedData directly to check trading_date
        const dbRecord = await PreFetchedData.findOne({
          instrument_key: instrumentKey,
          timeframe: timeframe
        }).lean();

        if (dbRecord) {
          const tradingDate = new Date(dbRecord.trading_date);
          const now = new Date();

          const lastBarTime = dbRecord.data_quality?.last_bar_time ?
          new Date(dbRecord.data_quality.last_bar_time) :
          new Date(candles[candles.length - 1].timestamp || candles[candles.length - 1][0]);

          // Determine staleness based on last bar time, not trading date
          // Add buffer time based on timeframe to avoid unnecessary API calls during non-trading hours
          const bufferMinutes = timeframe === '15m' ? 15 : timeframe === '1h' ? 60 : 1440;
          const bufferMs = bufferMinutes * 60 * 1000;
          const timeSinceLastBar = now - lastBarTime;

          // Check if data is stale (last bar is older than buffer time)
          if (timeSinceLastBar > bufferMs) {

            // Calculate how many candles we need to fetch
            const timeDiffMs = now - lastBarTime;
            const timeDiffHours = timeDiffMs / (1000 * 60 * 60);

            // Determine how many bars to fetch based on timeframe
            let barsToFetch = 0;
            if (timeframe === '15m') {
              barsToFetch = Math.ceil(timeDiffHours * 4); // 4 bars per hour
            } else if (timeframe === '1h') {
              barsToFetch = Math.ceil(timeDiffHours);
            } else if (timeframe === '1d') {
              barsToFetch = Math.ceil(timeDiffHours / 24);
            }

            if (barsToFetch > 0) {
              try {
                // Use intraday API for 15m and 1h timeframes
                if (timeframe === '15m' || timeframe === '1h') {
                  const intradayUrl = this.buildIntradayUrl(instrumentKey, timeframe);

                  const response = await this.fetchCandleData(intradayUrl);
                  const todayCandles = response?.data?.candles || response?.candles || [];

                  if (todayCandles && todayCandles.length > 0) {

                    // Convert to standard format
                    const formattedCandles = formatCandles(todayCandles);

                    // Merge: Keep all DB candles + append only NEW candles
                    const existingTimestamps = new Set(
                      candles.map((c) => (c.timestamp || c[0]).toString())
                    );

                    const newCandles = formattedCandles.filter((candle) =>
                    !existingTimestamps.has(candle.timestamp.toString())
                    );

                    if (newCandles.length > 0) {
                      // Append and sort chronologically
                      candles = [...candles, ...newCandles].
                      sort((a, b) => new Date(a.timestamp || a[0]) - new Date(b.timestamp || b[0]));

                      // Update DB with merged data
                      const newLastBarTime = new Date(candles[candles.length - 1].timestamp || candles[candles.length - 1][0]);

                      // Extract trading date (date only, normalized to midnight)
                      const tradingDate = MarketHoursUtil.normalizeDateToMidnight(newLastBarTime);

                      await PreFetchedData.updateOne(
                        { instrument_key: instrumentKey, timeframe: timeframe },
                        {
                          $set: {
                            candle_data: candles,
                            bars_count: candles.length,
                            trading_date: tradingDate, // Date only (for queries & TTL)
                            updated_at: new Date(),
                            'data_quality.last_bar_time': newLastBarTime // Full timestamp (for staleness)
                          }
                        }
                      );

                    }
                  } else {

                  }
                }
              } catch (apiError) {
                console.error(`   ❌ Failed to fetch from API: ${apiError.message}`);

              }
            } else {

            }
          } else {

          }
        } else {

        }

        // Get latest candle (after potential merge)
        const latestCandle = candles[candles.length - 1];

        // Calculate indicators if we have enough data
        let indicators = {};
        if (candles.length >= 50) {
          indicators = calculateTechnicalIndicators(candles);

        } else {

        }

        // Format latest candle
        const formattedCandle = {
          timestamp: latestCandle.timestamp || latestCandle[0],
          open: latestCandle.open || latestCandle[1],
          high: latestCandle.high || latestCandle[2],
          low: latestCandle.low || latestCandle[3],
          close: latestCandle.close || latestCandle[4],
          volume: latestCandle.volume || latestCandle[5]
        };

        // Merge candle data with indicators
        marketData.timeframes[timeframe] = { ...formattedCandle, ...indicators };
        marketData.indicators[timeframe] = indicators;
      }

      // CRITICAL: Always fetch latest 1m candle for current price (real-time)

      try {
        const oneMinUrl = this.buildIntradayUrl(instrumentKey, '1m');

        const response = await this.fetchCandleData(oneMinUrl);
        const oneMinCandles = response?.data?.candles || response?.candles || [];

        if (oneMinCandles && oneMinCandles.length > 0) {
          const latestCandle = oneMinCandles[0];
          const latestPrice = Array.isArray(latestCandle) ? latestCandle[4] : latestCandle.close;
          const latestTimestamp = Array.isArray(latestCandle) ? latestCandle[0] : latestCandle.timestamp;

          marketData.current_price = latestPrice;

        } else {

          // Fallback: Use latest candle from available timeframes
          if (Object.keys(marketData.timeframes).length > 0) {
            const firstTimeframe = Object.values(marketData.timeframes)[0];
            marketData.current_price = firstTimeframe.close;

          }
        }
      } catch (priceError) {
        console.error(`❌ [CURRENT PRICE] Failed to fetch 1m candle: ${priceError.message}`);

        // Fallback for current price
        if (!marketData.current_price && Object.keys(marketData.timeframes).length > 0) {
          const firstTimeframe = Object.values(marketData.timeframes)[0];
          marketData.current_price = firstTimeframe.close;

        }
      }

      return marketData;

    } catch (error) {
      console.error(`❌ [TRIGGER ADAPTER] Failed: ${error.message}`);
      throw error;
    }
  }

}

const candleFetcherService = new CandleFetcherService();
export default candleFetcherService;