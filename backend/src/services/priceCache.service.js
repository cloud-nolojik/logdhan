import { getCurrentPrice, getExactStock, getDailyCandles } from '../utils/stockDb.js';
import MarketHoursUtil from '../utils/marketHours.js';
import LatestPrice from '../models/latestPrice.js';
import upstoxService from './upstox.service.js';
import { User } from '../models/user.js';

/**
 * PriceCacheService - In-memory price caching for real-time updates
 *
 * Features:
 * - Fetches prices every 2 minutes (120 seconds)
 * - Caches prices in memory for instant API responses
 * - Supports bulk fetching (up to 500 stocks per request)
 * - Supports both single and multiple instrument queries
 * - Includes market indices (Nifty 50, Sensex, etc.)
 * - Aggregates all user watchlists automatically (up to 2000 stocks)
 */
class PriceCacheService {
  constructor() {
    // In-memory price cache: { instrumentKey: { ltp, candles, timestamp, ... } }
    this.priceCache = new Map();

    // Set of all instrument keys to track (aggregated from all users + market indices)
    this.trackedInstruments = new Set();

    // Polling interval ID
    this.pollingInterval = null;

    // Last fetch timestamp
    this.lastFetchTime = null;

    // Fetch status tracking
    this.isFetching = false;
    this.lastFetchStartTime = null;
    this.lastFetchEndTime = null;

    // Cache duration (300 seconds = 5 minutes)
    this.CACHE_DURATION = 300 * 1000;

    // Market indices to always track
    this.MARKET_INDICES = [
    'NSE_INDEX|Nifty 50',
    'BSE_INDEX|SENSEX',
    'NSE_INDEX|Nifty Bank',
    'BSE_INDEX|BSE-500'];

    // Add market indices by default
    this.MARKET_INDICES.forEach((key) => this.trackedInstruments.add(key));
  }

  /**
   * Start the price caching service
   * Fetches prices every 2 minutes at the 0th second
   */
  start() {
    if (this.pollingInterval) {

      return;
    }

    // Fetch immediately on startup
    this.fetchAndCachePrices();

    // Then fetch every 2 minutes (120 seconds)
    this.pollingInterval = setInterval(() => {
      this.fetchAndCachePrices();
    }, this.CACHE_DURATION);

  }

  /**
   * Stop the price caching service
   */
  stop() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;

    }
  }

  /**
   * Add instruments to track
   * @param {Array<string>} instrumentKeys - Array of instrument keys to track
   */
  addInstruments(instrumentKeys) {
    const beforeCount = this.trackedInstruments.size;
    const newInstruments = [];

    instrumentKeys.forEach((key) => {
      if (!this.trackedInstruments.has(key)) {
        newInstruments.push(key);
        this.trackedInstruments.add(key);
      }
    });

    const afterCount = this.trackedInstruments.size;
    const newCount = afterCount - beforeCount;

    if (newCount > 0) {

      // Fetch prices immediately for new instruments only if market is open
      this.fetchPricesForInstrumentsIfMarketOpen(newInstruments);
    }
  }

  /**
   * Fetch prices for instruments - checks DB first, then decides API call
   * @param {Array<string>} instrumentKeys - Array of instrument keys to fetch
   * @private
   */
  async fetchPricesForInstrumentsIfMarketOpen(instrumentKeys) {
    try {
      // Step 1: Check which instruments already exist in database

      const existingPrices = await LatestPrice.getPricesForInstruments(instrumentKeys);
      const existingKeys = new Set(existingPrices.map((p) => p.instrument_key));

      // Instruments that don't exist in DB (need API fetch)
      const missingInstruments = instrumentKeys.filter((key) => !existingKeys.has(key));

      // Instruments that exist in DB (load into memory cache)
      const foundInstruments = instrumentKeys.filter((key) => existingKeys.has(key));

      // Step 2: Load existing prices from DB into memory cache
      if (foundInstruments.length > 0) {
        existingPrices.forEach((priceDoc) => {
          this.priceCache.set(priceDoc.instrument_key, {
            ltp: priceDoc.last_traded_price,
            candles: priceDoc.recent_candles || null,
            timestamp: new Date(priceDoc.updated_at).getTime(),
            lastUpdated: priceDoc.updated_at
          });
        });

      }

      // Step 3: If all instruments found in DB, we're done
      if (missingInstruments.length === 0) {

        return;
      }

      // Step 4: For missing instruments, check market hours
      const isMarketOpen = await MarketHoursUtil.isMarketOpen();

      if (isMarketOpen) {
        // Market is open - fetch real-time prices for missing instruments

        await this.fetchPricesForInstruments(missingInstruments);
      } else {
        // Market is closed - fetch last known prices (historical) for missing instruments

        await this.fetchHistoricalPricesForInstruments(missingInstruments);
      }
    } catch (error) {
      console.error('❌ Error in fetchPricesForInstrumentsIfMarketOpen:', error.message);
    }
  }

  /**
   * Fetch prices for specific instruments (on-demand)
   * @param {Array<string>} instrumentKeys - Array of instrument keys to fetch
   * @private
   */
  async fetchPricesForInstruments(instrumentKeys) {
    if (!instrumentKeys || instrumentKeys.length === 0) {
      return;
    }

    try {
      const pricePromises = instrumentKeys.map(async (instrumentKey) => {
        try {
          const sendCandles = this.MARKET_INDICES.includes(instrumentKey);
          const result = await getCurrentPrice(instrumentKey, sendCandles);

          if (sendCandles && result) {
            const latestCandle = result[0];
            const price = latestCandle ? latestCandle[4] : null;
            return { instrumentKey, price, candles: result };
          } else {
            return { instrumentKey, price: result, candles: null };
          }
        } catch (error) {
          console.warn(`⚠️ [PRICE CACHE] On-demand fetch failed for ${instrumentKey}:`, error.message);
          return { instrumentKey, price: null, candles: null };
        }
      });

      const results = await Promise.all(pricePromises);
      const timestamp = Date.now();
      let successCount = 0;

      results.forEach(({ instrumentKey, price, candles }) => {
        if (price !== null) {
          this.priceCache.set(instrumentKey, {
            ltp: price,
            candles: candles,
            timestamp: timestamp,
            lastUpdated: new Date().toISOString()
          });
          successCount++;
        }
      });

    } catch (error) {
      console.error('❌ [PRICE CACHE] Error in on-demand fetch:', error.message);
    }
  }

  /**
   * Fetch historical/last known prices for instruments when market is closed
   * This ensures we always have price data even if added after market hours
   * @param {Array<string>} instrumentKeys - Array of instrument keys to fetch
   * @private
   */
  async fetchHistoricalPricesForInstruments(instrumentKeys) {
    if (!instrumentKeys || instrumentKeys.length === 0) {
      return;
    }

    try {
      // Fetch historical prices using getCurrentPrice (which supports historical data)
      // getCurrentPrice will automatically fallback to historical API when intraday fails
      const pricePromises = instrumentKeys.map(async (instrumentKey) => {
        try {
          const sendCandles = this.MARKET_INDICES.includes(instrumentKey);
          const result = await getCurrentPrice(instrumentKey, sendCandles);

          if (sendCandles && result) {
            const latestCandle = result[0];
            const price = latestCandle ? latestCandle[4] : null;
            return { instrumentKey, price, candles: result };
          } else {
            return { instrumentKey, price: result, candles: null };
          }
        } catch (error) {
          console.warn(`⚠️ [PRICE CACHE] Historical fetch failed for ${instrumentKey}:`, error.message);
          return { instrumentKey, price: null, candles: null };
        }
      });

      const results = await Promise.all(pricePromises);
      const timestamp = Date.now();
      let successCount = 0;
      const dbUpdatePromises = [];

      results.forEach(({ instrumentKey, price, candles }) => {
        if (price !== null) {
          // Update in-memory cache
          this.priceCache.set(instrumentKey, {
            ltp: price,
            candles: candles,
            timestamp: timestamp,
            lastUpdated: new Date().toISOString()
          });

          // Store in database (parallel, non-blocking)
          dbUpdatePromises.push(this.storePriceInDB(instrumentKey, price, candles, timestamp));
          successCount++;
        }
      });

      // Store all prices in DB (parallel, non-blocking)
      if (dbUpdatePromises.length > 0) {
        Promise.all(dbUpdatePromises).
        then((results) => {
          const dbSuccessCount = results.filter((r) => r.success).length;

        }).
        catch((error) => {
          console.error(`❌ [PRICE CACHE] DB storage error (historical): ${error.message}`);
        });
      }

    } catch (error) {
      console.error('❌ [PRICE CACHE] Error in historical fetch:', error.message);
    }
  }

  /**
   * Remove instruments from tracking
   * @param {Array<string>} instrumentKeys - Array of instrument keys to stop tracking
   */
  removeInstruments(instrumentKeys) {
    instrumentKeys.forEach((key) => {
      this.trackedInstruments.delete(key);
      this.priceCache.delete(key);
    });

  }

  /**
   * Fetch and cache prices for all tracked instruments
   * Uses getCurrentPrice internally for compatibility with existing code
   * @private
   */
  async fetchAndCachePrices() {
    if (this.trackedInstruments.size === 0) {

      return;
    }

    // Check if market is open before fetching
    try {
      const isMarketOpen = await MarketHoursUtil.isMarketOpen();
      if (!isMarketOpen) {

        return;
      }
    } catch (error) {
      console.error('❌ [PRICE CACHE] Error checking market hours:', error.message);
      // Continue with fetch if we can't determine market hours (fail-safe)
    }

    const startTime = Date.now();
    const instrumentKeys = Array.from(this.trackedInstruments);

    try {
      // Fetch prices using getCurrentPrice (Intraday API) for each instrument in parallel
      const pricePromises = instrumentKeys.map(async (instrumentKey) => {
        try {
          // For market indices, fetch candles; for stocks, fetch just the price
          const sendCandles = this.MARKET_INDICES.includes(instrumentKey);
          const result = await getCurrentPrice(instrumentKey, sendCandles);

          if (sendCandles && result) {
            // For indices, result is candle array
            const latestCandle = result[0]; // Most recent candle
            const price = latestCandle ? latestCandle[4] : null; // Close price
            return { instrumentKey, price, candles: result };
          } else {
            // For stocks, result is just the price
            return { instrumentKey, price: result, candles: null };
          }
        } catch (error) {
          console.warn(`⚠️ [PRICE CACHE] Price fetch failed for ${instrumentKey}:`, error.message);
          return { instrumentKey, price: null, candles: null };
        }
      });

      const results = await Promise.all(pricePromises);

      // Update cache with fetched data AND store in database
      const timestamp = Date.now();
      let successCount = 0;
      const dbUpdatePromises = [];

      results.forEach(({ instrumentKey, price, candles }) => {
        if (price !== null) {
          // Update in-memory cache (for instant access)
          this.priceCache.set(instrumentKey, {
            ltp: price,
            candles: candles,
            timestamp: timestamp,
            lastUpdated: new Date().toISOString()
          });

          // Prepare DB update (parallel execution)
          dbUpdatePromises.push(this.storePriceInDB(instrumentKey, price, candles, timestamp));
          successCount++;
        }
      });

      // Store all prices in DB (parallel, non-blocking)
      if (dbUpdatePromises.length > 0) {
        Promise.all(dbUpdatePromises).
        then((results) => {
          const dbSuccessCount = results.filter((r) => r.success).length;

        }).
        catch((error) => {
          console.error(`❌ [PRICE CACHE] DB storage error: ${error.message}`);
        });
      }

      this.lastFetchTime = timestamp;

      const totalTime = Date.now() - startTime;

    } catch (error) {
      console.error('❌ [PRICE CACHE] Error fetching prices:', error.message);
    }
  }

  /**
   * Get cached price for a single instrument (LTP only)
   * @param {string} instrumentKey - Instrument key to get price for
   * @returns {number|null} Last traded price or null if not found
   */
  getPrice(instrumentKey) {
    const cached = this.priceCache.get(instrumentKey);

    if (!cached) {
      return null;
    }

    // Check if cache is stale (older than 3 minutes means we missed a fetch)
    const age = Date.now() - cached.timestamp;
    if (age > 180000) {
      console.warn(`⚠️ [PRICE CACHE] Stale cache for ${instrumentKey} (${Math.round(age / 1000)}s old)`);
    }

    return cached.ltp;
  }

  /**
   * Get full cached data for a single instrument (LTP + candles if available)
   * @param {string} instrumentKey - Instrument key to get data for
   * @returns {Object|null} Full price data or null if not found
   */
  getPriceData(instrumentKey) {
    const cached = this.priceCache.get(instrumentKey);

    if (!cached) {
      return null;
    }

    // Check if cache is stale (older than 3 minutes)
    const age = Date.now() - cached.timestamp;
    if (age > 180000) {
      console.warn(`⚠️ [PRICE CACHE] Stale cache for ${instrumentKey} (${Math.round(age / 1000)}s old)`);
    }

    return cached;
  }

  /**
   * Get cached prices for multiple instruments (LTP only)
   * @param {Array<string>} instrumentKeys - Array of instrument keys
   * @returns {Object} Map of instrumentKey -> LTP
   */
  getPrices(instrumentKeys) {
    const prices = {};

    instrumentKeys.forEach((key) => {
      const price = this.getPrice(key);
      if (price !== null) {
        prices[key] = price;
      }
    });

    return prices;
  }

  /**
   * Get full cached data for multiple instruments (LTP + candles if available)
   * @param {Array<string>} instrumentKeys - Array of instrument keys
   * @returns {Object} Map of instrumentKey -> price data
   */
  getPricesData(instrumentKeys) {
    const pricesData = {};

    instrumentKeys.forEach((key) => {
      const data = this.getPriceData(key);
      if (data) {
        pricesData[key] = data;
      }
    });

    return pricesData;
  }

  /**
   * Get all cached prices (LTP only)
   * @returns {Object} Map of all instrument keys -> LTP
   */
  getAllPrices() {
    const prices = {};

    this.priceCache.forEach((data, key) => {
      prices[key] = data.ltp;
    });

    return prices;
  }

  /**
   * Get candles for a specific instrument (market indices only)
   * @param {string} instrumentKey - Instrument key
   * @returns {Array|null} Candle data or null if not available
   */
  getCandles(instrumentKey) {
    const cached = this.priceCache.get(instrumentKey);
    return cached?.candles || null;
  }

  /**
   * Check if previous_day_close needs refresh
   * Returns true if:
   * - No previous_day_close exists in DB
   * - The previous_day_close_date is not today (IST)
   * @param {Object} existingDoc - Existing LatestPrice document
   * @returns {boolean}
   */
  needsPreviousDayCloseRefresh(existingDoc) {
    if (!existingDoc || !existingDoc.previous_day_close) {
      console.log(`[PRICE CACHE] needsRefresh: true (no previous_day_close)`);
      return true; // No data, needs refresh
    }

    // Check if previous_day_close was fetched today using the date field
    const now = new Date();
    const istNow = MarketHoursUtil.toIST(now);
    const todayDateStr = istNow.toISOString().split('T')[0]; // "YYYY-MM-DD"

    const storedDate = existingDoc.previous_day_close_date;

    if (!storedDate || storedDate !== todayDateStr) {
      console.log(`[PRICE CACHE] needsRefresh: true for ${existingDoc.instrument_key} (stored: ${storedDate}, today: ${todayDateStr})`);
      return true; // previous_day_close was not fetched today
    }

    console.log(`[PRICE CACHE] needsRefresh: false for ${existingDoc.instrument_key} (already fetched today: ${storedDate})`);
    return false; // previous_day_close was fetched today, no refresh needed
  }

  /**
   * Store price in database (Latest Price collection)
   * SMART LOGIC:
   * - Only fetches daily candles if previous_day_close is missing or stale
   * - During trading hours: Updates LTP frequently, previous_day_close once per day
   * - After trading hours: Uses cached data
   * @param {string} instrumentKey - The instrument key
   * @param {number} price - Last traded price
   * @param {Array} candles - Candle data (if available)
   * @param {number} timestamp - Fetch timestamp
   * @returns {Promise<Object>} Success status
   */
  async storePriceInDB(instrumentKey, price, candles, timestamp) {
    try {
      // Extract stock info from instrument key
      const parts = instrumentKey.split('|');
      const exchange = parts[0]; // NSE, BSE, NSE_INDEX, BSE_INDEX
      const stock_symbol = parts[parts.length - 1] || instrumentKey;

      // Get stock details for name (optional, not critical)
      let stock_name = stock_symbol;
      try {
        const stockInfo = await getExactStock(instrumentKey);
        if (stockInfo) {
          stock_name = stockInfo.name || stock_symbol;
        }
      } catch (error) {
        // Ignore error, use symbol as name
      }

      // Check existing record to see if we need to refresh previous_day_close
      let existingDoc = null;
      let previousDayClose = null;

      try {
        existingDoc = await LatestPrice.findOne({ instrument_key: instrumentKey }).lean();
      } catch (error) {
        // Ignore, will create new record
      }

      // SMART: Only fetch daily candles if previous_day_close is missing or stale
      const needsRefresh = this.needsPreviousDayCloseRefresh(existingDoc);
      let previousDayCloseDate = existingDoc?.previous_day_close_date || null;

      if (needsRefresh) {
        console.log(`[PRICE CACHE] Fetching daily candles for ${instrumentKey} (previous_day_close refresh needed)`);
        try {
          const dailyData = await getDailyCandles(instrumentKey);
          if (dailyData && dailyData.previousClose) {
            previousDayClose = dailyData.previousClose;
            // Set today's date as the fetch date
            const now = new Date();
            const istNow = MarketHoursUtil.toIST(now);
            previousDayCloseDate = istNow.toISOString().split('T')[0]; // "YYYY-MM-DD"
            console.log(`[PRICE CACHE] Got previous_day_close for ${instrumentKey}: ${previousDayClose} (date: ${previousDayCloseDate})`);
          }
        } catch (error) {
          console.warn(`⚠️ [DB STORE] Failed to fetch daily candles for ${instrumentKey}: ${error.message}`);
        }
      } else {
        // Use existing previous_day_close from DB
        previousDayClose = existingDoc.previous_day_close;
        console.log(`[PRICE CACHE] Using cached previous_day_close for ${instrumentKey}: ${previousDayClose}`);
      }

      // Prepare price data
      let priceData = {
        instrument_key: instrumentKey,
        stock_symbol,
        stock_name,
        exchange,
        ltp: price,
        candle_timestamp: new Date(timestamp),
        data_source: 'intraday_api'
      };

      // Set previous_day_close if available
      if (previousDayClose !== null) {
        priceData.previous_day_close = previousDayClose;
        priceData.previous_day_close_date = previousDayCloseDate;
      }

      // If we have intraday candle data, extract OHLCV
      if (candles && candles.length > 0) {
        const latestCandle = candles[0]; // Most recent candle
        priceData.open = latestCandle[1] || price;
        priceData.high = latestCandle[2] || price;
        priceData.low = latestCandle[3] || price;
        priceData.close = latestCandle[4] || price;
        priceData.volume = latestCandle[5] || 0;

        // Store recent candles (last 5 for mini-chart)
        priceData.recent_candles = candles.slice(0, 5).map((candle) => ({
          timestamp: new Date(candle[0]),
          open: candle[1],
          high: candle[2],
          low: candle[3],
          close: candle[4],
          volume: candle[5]
        }));
      } else {
        // No intraday candle data, just use price
        priceData.open = existingDoc?.open || price;
        priceData.high = Math.max(existingDoc?.high || price, price);
        priceData.low = Math.min(existingDoc?.low || price, price);
        priceData.close = price;
        priceData.volume = existingDoc?.volume || 0;
      }

      // Calculate change using previous day's close
      if (previousDayClose !== null && previousDayClose !== 0) {
        priceData.change = price - previousDayClose;
        priceData.change_percent = (priceData.change / previousDayClose) * 100;
      } else {
        // Fallback: use today's open
        priceData.change = price - (priceData.open || price);
        priceData.change_percent = priceData.open && priceData.open !== 0 ?
          (priceData.change / priceData.open) * 100 : 0;
      }

      // Upsert to database
      await LatestPrice.upsertPrice(priceData);

      return { success: true, instrumentKey, previousDayClose };

    } catch (error) {
      console.error(`❌ [DB STORE] Failed to store price for ${instrumentKey}: ${error.message}`);
      return { success: false, instrumentKey, error: error.message };
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getStats() {
    return {
      trackedInstruments: this.trackedInstruments.size,
      cachedPrices: this.priceCache.size,
      isFetching: this.isFetching,
      lastFetchTime: this.lastFetchTime ? new Date(this.lastFetchTime).toISOString() : null,
      lastFetchStartTime: this.lastFetchStartTime ? new Date(this.lastFetchStartTime).toISOString() : null,
      lastFetchEndTime: this.lastFetchEndTime ? new Date(this.lastFetchEndTime).toISOString() : null,
      nextFetchIn: this.lastFetchTime ? Math.max(0, this.CACHE_DURATION - (Date.now() - this.lastFetchTime)) : 0,
      cacheAge: this.lastFetchTime ? Date.now() - this.lastFetchTime : null,
      isRunning: !!this.pollingInterval
    };
  }

  /**
   * Clear all cache
   */
  clearCache() {
    this.priceCache.clear();
    this.trackedInstruments.clear();

  }

  /**
   * Fetch bulk LTP prices using Upstox market-quote/ltp API
   * Much faster than fetching one by one - single API call for up to 500 instruments
   *
   * @param {Array<string>} instrumentKeys - Array of instrument keys
   * @returns {Promise<Object>} Map of instrument_key → price
   * @private
   */
  async fetchBulkLTP(instrumentKeys) {
    if (!instrumentKeys || instrumentKeys.length === 0) {
      return {};
    }

    const priceMap = {};

    try {
      // Get any user's access token for market data (market data is same for all users)
      const user = await User.findOne({ 'broker.upstox.access_token': { $exists: true, $ne: null } })
        .select('broker.upstox.access_token')
        .lean();

      if (!user?.broker?.upstox?.access_token) {
        console.warn('⚠️ [BULK LTP] No Upstox access token available, falling back to individual fetch');
        return null; // Signal to use fallback
      }

      const accessToken = user.broker.upstox.access_token;

      // Upstox allows up to 500 instruments per request
      const BATCH_SIZE = 500;
      const batches = [];
      for (let i = 0; i < instrumentKeys.length; i += BATCH_SIZE) {
        batches.push(instrumentKeys.slice(i, i + BATCH_SIZE));
      }

      // Fetch all batches in parallel
      const batchPromises = batches.map(async (batch) => {
        const result = await upstoxService.getLiveMarketData(batch, accessToken);
        return result;
      });

      const batchResults = await Promise.all(batchPromises);

      // Aggregate results from all batches
      // Returns full data object including last_price, last_trade_time, etc.
      batchResults.forEach((result) => {
        if (result.success && result.data) {
          Object.entries(result.data).forEach(([key, data]) => {
            if (data?.last_price !== undefined) {
              priceMap[key] = {
                last_price: data.last_price,
                last_trade_time: data.last_trade_time || null,
                instrument_token: data.instrument_token || key
              };
            }
          });
        }
      });

      return priceMap;

    } catch (error) {
      console.error(`❌ [BULK LTP] Failed: ${error.message}`);
      return null; // Signal to use fallback
    }
  }

  /**
   * Get latest prices for multiple instruments
   *
   * Market Hours:
   *   1. Try BULK LTP API (single call for all stocks - FAST!)
   *   2. Fallback to individual getCurrentPrice calls if bulk fails
   * Non-Market Hours: LatestPrice collection only (fast, no API calls)
   *
   * @param {Array<string>} instrumentKeys - Array of instrument keys to fetch prices for
   * @returns {Promise<Object>} Map of instrument_key → current_price
   *
   * @example
   * const prices = await priceCacheService.getLatestPrices(['NSE_EQ|INE123', 'NSE_EQ|INE456']);
   * console.log(prices['NSE_EQ|INE123']); // 150.50
   */
  async getLatestPrices(instrumentKeys) {
    if (!instrumentKeys || instrumentKeys.length === 0) {
      return {};
    }

    // Add instruments to tracking (triggers background updates)
    this.addInstruments(instrumentKeys);

    const priceMap = {};

    // Check if market is open
    let isMarketOpen = false;
    try {
      isMarketOpen = await MarketHoursUtil.isMarketOpen();
    } catch (error) {
      console.warn(`⚠️ [PRICES] Could not check market hours: ${error.message}`);
    }

    // Determine which API to use based on time and day:
    // - Trading day, 9:15 AM - 12:00 AM: Use Intraday API (1-min candles)
    // - Trading day, 12:00 AM - 9:15 AM: Use Historical Daily API (daily candles)
    // - Weekend/Holiday (any time): Use Historical Daily API (daily candles)
    const now = new Date();
    const istNow = MarketHoursUtil.toIST(now);
    const currentHour = istNow.getHours();
    const currentMinute = istNow.getMinutes();
    const timeInMinutes = currentHour * 60 + currentMinute;
    const marketOpenTime = 9 * 60 + 15; // 9:15 AM = 555 minutes

    // Check if today is a trading day (not weekend/holiday)
    let isTradingDay = true;
    try {
      isTradingDay = await MarketHoursUtil.isTradingDay(istNow);
    } catch (error) {
      console.warn(`⚠️ [PRICES] Could not check trading day: ${error.message}`);
    }

    // Use Historical API if:
    // 1. It's night time (12 AM - 9:15 AM) on a trading day, OR
    // 2. It's a weekend/holiday (any time)
    const isNightTime = timeInMinutes < marketOpenTime;
    const useHistoricalAPI = !isTradingDay || isNightTime;

    console.log(`[PRICES] Time check: IST ${currentHour}:${currentMinute.toString().padStart(2, '0')}, isTradingDay=${isTradingDay}, isNightTime=${isNightTime}, useHistoricalAPI=${useHistoricalAPI}, isMarketOpen=${isMarketOpen}`);

    if (isMarketOpen) {
      // MARKET HOURS: Try BULK LTP first (much faster!)
      const apiStart = Date.now();

      // Try bulk LTP API first
      const bulkResult = await this.fetchBulkLTP(instrumentKeys);

      if (bulkResult !== null && Object.keys(bulkResult).length > 0) {
        // Bulk API worked - use results
        const dbUpdatePromises = [];

        Object.entries(bulkResult).forEach(([instrumentKey, price]) => {
          priceMap[instrumentKey] = price;

          // Update memory cache
          this.priceCache.set(instrumentKey, {
            ltp: price,
            candles: null,
            timestamp: Date.now(),
            lastUpdated: new Date().toISOString()
          });

          // Queue DB update (saves to LatestPrice for non-market hours)
          dbUpdatePromises.push(this.storePriceInDB(instrumentKey, price, null, Date.now()));
        });

        const apiTime = Date.now() - apiStart;
        console.log(`⚡ [BULK LTP] Fetched ${Object.keys(bulkResult).length}/${instrumentKeys.length} prices in ${apiTime}ms (market open)`);

        // Store prices to DB in background (non-blocking)
        if (dbUpdatePromises.length > 0) {
          Promise.all(dbUpdatePromises).catch((err) => {
            console.error(`❌ [DB] Failed to persist prices: ${err.message}`);
          });
        }
      } else {
        // Bulk API failed - fallback to individual calls
        console.warn('⚠️ [BULK LTP] Failed, falling back to individual API calls');

        const apiPromises = instrumentKeys.map(async (instrumentKey) => {
          try {
            const price = await getCurrentPrice(instrumentKey, false);
            return { instrumentKey, price };
          } catch (error) {
            console.warn(`⚠️ [API] Failed to fetch ${instrumentKey}: ${error.message}`);
            return { instrumentKey, price: null };
          }
        });

        const apiResults = await Promise.all(apiPromises);
        const dbUpdatePromises = [];

        apiResults.forEach(({ instrumentKey, price }) => {
          if (price !== null) {
            priceMap[instrumentKey] = price;

            // Update memory cache
            this.priceCache.set(instrumentKey, {
              ltp: price,
              candles: null,
              timestamp: Date.now(),
              lastUpdated: new Date().toISOString()
            });

            // Queue DB update
            dbUpdatePromises.push(this.storePriceInDB(instrumentKey, price, null, Date.now()));
          }
        });

        const apiTime = Date.now() - apiStart;
        console.log(`📡 [API] Fetched ${Object.keys(priceMap).length}/${instrumentKeys.length} prices in ${apiTime}ms (market open - fallback)`);

        // Store prices to DB in background
        if (dbUpdatePromises.length > 0) {
          Promise.all(dbUpdatePromises).catch((err) => {
            console.error(`❌ [DB] Failed to persist prices: ${err.message}`);
          });
        }
      }

      // For any missing prices, fall back to database
      const missingAfterApi = instrumentKeys.filter((key) => priceMap[key] === undefined);
      if (missingAfterApi.length > 0) {
        try {
          const latestPrices = await LatestPrice.getPricesForInstruments(missingAfterApi);
          latestPrices.forEach((priceDoc) => {
            priceMap[priceDoc.instrument_key] = priceDoc.last_traded_price;
          });
        } catch (error) {
          console.error(`❌ [DB FALLBACK] Database fetch failed: ${error.message}`);
        }
      }
    } else {
      // NON-MARKET HOURS: Use LatestPrice collection, fallback to PreFetchedData candles, then Upstox API
      const dbStart = Date.now();
      try {
        const latestPrices = await LatestPrice.getPricesForInstruments(instrumentKeys);
        const staleKeys = []; // Track keys with stale prices that need refresh
        const stalePriceThreshold = 24 * 60 * 60 * 1000; // 24 hours

        latestPrices.forEach((priceDoc) => {
          const priceAge = Date.now() - new Date(priceDoc.updated_at).getTime();
          if (priceAge > stalePriceThreshold) {
            // Price is stale, mark for refresh but use as fallback
            staleKeys.push(priceDoc.instrument_key);
          }
          priceMap[priceDoc.instrument_key] = priceDoc.last_traded_price;
        });

        // For missing prices, try PreFetchedData (last candle close)
        const missingKeys = instrumentKeys.filter((key) => priceMap[key] === undefined);
        if (missingKeys.length > 0) {
          const PreFetchedData = (await import('../models/preFetchedData.js')).default;
          const prefetched = await PreFetchedData.find({
            instrument_key: { $in: missingKeys },
            timeframe: '1d'
          }).lean();

          prefetched.forEach((doc) => {
            if (doc.candle_data?.length > 0) {
              const lastCandle = doc.candle_data[doc.candle_data.length - 1];
              // Candle format: [timestamp, open, high, low, close, volume]
              const closePrice = Array.isArray(lastCandle) ? lastCandle[4] : lastCandle.close;
              if (closePrice) {
                priceMap[doc.instrument_key] = closePrice;
              }
            }
          });
        }

        // For still missing prices OR stale prices, fetch from Upstox API
        const stillMissingKeys = instrumentKeys.filter((key) => priceMap[key] === undefined);
        const keysToRefresh = [...new Set([...stillMissingKeys, ...staleKeys])]; // Combine missing + stale, dedupe
        if (keysToRefresh.length > 0) {
          const missingCount = stillMissingKeys.length;
          const staleCount = staleKeys.length;

          // Use different API based on time/day:
          // - useHistoricalAPI=true (night time OR weekend/holiday): Use Historical Daily API
          // - useHistoricalAPI=false (trading day after 9:15 AM): Use Intraday API
          const apiType = useHistoricalAPI ? 'HISTORICAL DAILY' : 'INTRADAY';
          console.log(`📡 [API FALLBACK] Fetching ${keysToRefresh.length} prices from ${apiType} API (market closed) - ${missingCount} missing, ${staleCount} stale`);

          const apiPromises = keysToRefresh.map(async (instrumentKey) => {
            try {
              let price = null;

              if (useHistoricalAPI) {
                // Night time OR weekend/holiday: Use Historical Daily API (previous day close)
                const dailyData = await getDailyCandles(instrumentKey);
                if (dailyData) {
                  // Use todayClose if available (market traded today), else previousClose
                  price = dailyData.todayClose || dailyData.previousClose;
                  console.log(`📡 [HISTORICAL] ${instrumentKey} -> close: ${price}`);
                }
              } else {
                // Trading day after 9:15 AM: Use Intraday API
                price = await getCurrentPrice(instrumentKey, false);
                console.log(`📡 [INTRADAY] ${instrumentKey} -> price: ${price}`);
              }

              return { instrumentKey, price };
            } catch (error) {
              console.warn(`⚠️ [API] Failed to fetch ${instrumentKey}: ${error.message}`);
              return { instrumentKey, price: null };
            }
          });

          const apiResults = await Promise.all(apiPromises);
          const dbUpdatePromises = [];

          apiResults.forEach(({ instrumentKey, price }) => {
            if (price !== null) {
              priceMap[instrumentKey] = price;

              // Update memory cache
              this.priceCache.set(instrumentKey, {
                ltp: price,
                candles: null,
                timestamp: Date.now(),
                lastUpdated: new Date().toISOString()
              });

              // Queue DB update to persist for future requests
              dbUpdatePromises.push(this.storePriceInDB(instrumentKey, price, null, Date.now()));
            } else {
              console.warn(`⚠️ [API FALLBACK] No price returned for ${instrumentKey}`);
            }
          });

          // Store fetched prices to DB in background (non-blocking)
          if (dbUpdatePromises.length > 0) {
            Promise.all(dbUpdatePromises).catch((err) => {
              console.error(`❌ [DB] Failed to persist API-fetched prices: ${err.message}`);
            });
          }

          const apiFetchedCount = apiResults.filter(r => r.price !== null).length;
          console.log(`✅ [API FALLBACK] Fetched ${apiFetchedCount}/${keysToRefresh.length} prices from ${apiType} API`);
        }

        const dbTime = Date.now() - dbStart;
        console.log(`📦 [DB] Fetched ${Object.keys(priceMap).length}/${instrumentKeys.length} prices in ${dbTime}ms (market closed)`);
      } catch (error) {
        console.error(`❌ [DB] Database fetch failed: ${error.message}`);
      }
    }

    const totalFound = Object.keys(priceMap).length;
    if (totalFound < instrumentKeys.length) {
      console.log(`💰 [PRICES] Resolved ${totalFound}/${instrumentKeys.length} prices`);
    }

    return priceMap;
  }

  /**
   * Get latest prices with change data for multiple instruments
   * DIRECT API CALL - Bypasses DB cache, calls API directly based on time/day:
   * - Trading day, 9:15 AM onwards: Use Intraday API
   * - Night time (12 AM - 9:15 AM) OR Weekend/Holiday: Use Historical Daily API
   *
   * @param {Array<string>} instrumentKeys - Array of instrument keys to fetch prices for
   * @returns {Promise<Object>} Map of instrument_key → { price, change, change_percent, previous_day_close }
   */
  async getLatestPricesWithChange(instrumentKeys) {
    if (!instrumentKeys || instrumentKeys.length === 0) {
      return {};
    }

    const priceDataMap = {};

    // Determine which API to use based on time and day
    const now = new Date();
    const istNow = MarketHoursUtil.toIST(now);
    const currentHour = istNow.getHours();
    const currentMinute = istNow.getMinutes();
    const timeInMinutes = currentHour * 60 + currentMinute;
    const marketOpenTime = 9 * 60 + 15; // 9:15 AM = 555 minutes

    // Check if today is a trading day (not weekend/holiday)
    let isTradingDay = true;
    try {
      isTradingDay = await MarketHoursUtil.isTradingDay(istNow);
    } catch (error) {
      console.warn(`⚠️ [PRICES WITH CHANGE] Could not check trading day: ${error.message}`);
    }

    // Check if market is open
    let isMarketOpen = false;
    try {
      isMarketOpen = await MarketHoursUtil.isMarketOpen();
    } catch (error) {
      console.warn(`⚠️ [PRICES WITH CHANGE] Could not check market hours: ${error.message}`);
    }

    // Use Historical API if:
    // 1. It's night time (12 AM - 9:15 AM), OR
    // 2. It's a weekend/holiday (any time)
    const isNightTime = timeInMinutes < marketOpenTime;
    const useHistoricalAPI = !isTradingDay || isNightTime;

    const apiType = useHistoricalAPI ? 'HISTORICAL DAILY' : (isMarketOpen ? 'BULK LTP' : 'INTRADAY');
    console.log(`[PRICES WITH CHANGE] Time: IST ${currentHour}:${currentMinute.toString().padStart(2, '0')}, isTradingDay=${isTradingDay}, isNightTime=${isNightTime}, useHistoricalAPI=${useHistoricalAPI}, isMarketOpen=${isMarketOpen}, API=${apiType}`);

    // DIRECT API CALL - No DB cache lookup
    const apiStart = Date.now();

    if (isMarketOpen) {
      // Market is open - try BULK LTP first
      const bulkResult = await this.fetchBulkLTP(instrumentKeys);

      if (bulkResult !== null && Object.keys(bulkResult).length > 0) {
        console.log(`⚡ [PRICES WITH CHANGE] BULK LTP returned ${Object.keys(bulkResult).length} prices`);

        // Now get previous_day_close from daily API for change calculation
        await Promise.all(instrumentKeys.map(async (instrumentKey) => {
          try {
            const bulkData = bulkResult[instrumentKey];
            if (!bulkData) return;

            const currentPrice = bulkData.last_price;
            const lastTradeTime = bulkData.last_trade_time || null;

            // Fetch daily candles for previous_day_close
            const dailyData = await getDailyCandles(instrumentKey);
            const previousClose = dailyData?.previousClose || null;

            // Calculate change
            let change = 0;
            let changePercent = 0;
            if (previousClose && currentPrice) {
              change = currentPrice - previousClose;
              changePercent = (change / previousClose) * 100;
            }

            priceDataMap[instrumentKey] = {
              price: currentPrice,
              change: Math.round(change * 100) / 100,
              change_percent: Math.round(changePercent * 100) / 100,
              previous_day_close: previousClose,
              timestamp: lastTradeTime
            };

            console.log(`[PRICES WITH CHANGE] ${instrumentKey}: price=${currentPrice}, prevClose=${previousClose}, change=${change.toFixed(2)} (${changePercent.toFixed(2)}%) @ ${lastTradeTime}`);
          } catch (error) {
            console.warn(`⚠️ [PRICES WITH CHANGE] Failed to get change data for ${instrumentKey}: ${error.message}`);
            // Still add price without change
            const bulkData = bulkResult[instrumentKey];
            if (bulkData) {
              priceDataMap[instrumentKey] = {
                price: bulkData.last_price,
                change: 0,
                change_percent: 0,
                previous_day_close: null,
                timestamp: bulkData.last_trade_time || null
              };
            }
          }
        }));
      } else {
        // Bulk LTP failed - fallback to individual intraday API calls
        console.warn('⚠️ [PRICES WITH CHANGE] BULK LTP failed, using individual INTRADAY calls');

        await Promise.all(instrumentKeys.map(async (instrumentKey) => {
          try {
            const currentPrice = await getCurrentPrice(instrumentKey, false);
            if (currentPrice === null) return;

            // Fetch daily candles for previous_day_close
            const dailyData = await getDailyCandles(instrumentKey);
            const previousClose = dailyData?.previousClose || null;

            // Calculate change
            let change = 0;
            let changePercent = 0;
            if (previousClose && currentPrice) {
              change = currentPrice - previousClose;
              changePercent = (change / previousClose) * 100;
            }

            priceDataMap[instrumentKey] = {
              price: currentPrice,
              change: Math.round(change * 100) / 100,
              change_percent: Math.round(changePercent * 100) / 100,
              previous_day_close: previousClose
            };

            console.log(`[PRICES WITH CHANGE] ${instrumentKey}: price=${currentPrice}, prevClose=${previousClose}, change=${change.toFixed(2)} (${changePercent.toFixed(2)}%)`);
          } catch (error) {
            console.warn(`⚠️ [PRICES WITH CHANGE] Failed for ${instrumentKey}: ${error.message}`);
          }
        }));
      }
    } else {
      // Market is closed - use appropriate API based on time
      await Promise.all(instrumentKeys.map(async (instrumentKey) => {
        try {
          let currentPrice = null;
          let previousClose = null;

          if (useHistoricalAPI) {
            // Night time OR weekend/holiday: Use Historical Daily API
            const dailyData = await getDailyCandles(instrumentKey);
            if (dailyData) {
              // Use todayClose if market traded today, else use previousClose
              currentPrice = dailyData.todayClose || dailyData.previousClose;
              previousClose = dailyData.previousClose;
              console.log(`📡 [HISTORICAL] ${instrumentKey} -> todayClose=${dailyData.todayClose}, prevClose=${dailyData.previousClose}, using=${currentPrice}`);
            }
          } else {
            // Trading day after 9:15 AM but market closed (3:30 PM - 12 AM): Use Intraday API
            currentPrice = await getCurrentPrice(instrumentKey, false);
            const dailyData = await getDailyCandles(instrumentKey);
            previousClose = dailyData?.previousClose || null;
            console.log(`📡 [INTRADAY] ${instrumentKey} -> price=${currentPrice}, prevClose=${previousClose}`);
          }

          if (currentPrice !== null) {
            // Calculate change
            let change = 0;
            let changePercent = 0;
            if (previousClose && currentPrice) {
              change = currentPrice - previousClose;
              changePercent = (change / previousClose) * 100;
            }

            priceDataMap[instrumentKey] = {
              price: currentPrice,
              change: Math.round(change * 100) / 100,
              change_percent: Math.round(changePercent * 100) / 100,
              previous_day_close: previousClose
            };

            console.log(`[PRICES WITH CHANGE] ${instrumentKey}: price=${currentPrice}, prevClose=${previousClose}, change=${change.toFixed(2)} (${changePercent.toFixed(2)}%)`);
          }
        } catch (error) {
          console.warn(`⚠️ [PRICES WITH CHANGE] Failed for ${instrumentKey}: ${error.message}`);
        }
      }));
    }

    const apiTime = Date.now() - apiStart;
    console.log(`✅ [PRICES WITH CHANGE] Fetched ${Object.keys(priceDataMap).length}/${instrumentKeys.length} prices in ${apiTime}ms using ${apiType} API`);

    return priceDataMap;
  }

  /**
   * Load weekly watchlist stocks into tracking
   * Called on startup to ensure all active watchlist stocks are tracked
   */
  async loadWeeklyWatchlistStocks() {
    try {
      // Dynamic import to avoid circular dependency
      const WeeklyWatchlist = (await import('../models/weeklyWatchlist.js')).default;

      const watchlist = await WeeklyWatchlist.getCurrentWeek();
      if (!watchlist || !watchlist.stocks || watchlist.stocks.length === 0) {
        console.log('[PRICE CACHE] No active weekly watchlist stocks to track');
        return;
      }

      const instrumentKeys = watchlist.stocks.map(stock => stock.instrument_key);
      this.addInstruments(instrumentKeys);
      console.log(`✅ [PRICE CACHE] Added ${instrumentKeys.length} weekly watchlist stocks to tracking`);
    } catch (error) {
      console.error('❌ [PRICE CACHE] Failed to load weekly watchlist stocks:', error.message);
    }
  }
}

// Export singleton instance
export default new PriceCacheService();