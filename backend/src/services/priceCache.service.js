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

    // Cache duration (120 seconds = 2 minutes)
    this.CACHE_DURATION = 120 * 1000;

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
   * Store price in database (Latest Price collection)
   * For market indices, fetches daily candles to get accurate previous day's close
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

      // Fetch daily candles to get accurate previous day's close for ALL stocks
      let previousDayClose = null;

      try {
        const dailyData = await getDailyCandles(instrumentKey);
        if (dailyData && dailyData.previousClose) {
          previousDayClose = dailyData.previousClose;
          priceData.previous_day_close = previousDayClose;

          // Use daily candle data for OHLC if intraday candles not available
          if (!candles || candles.length === 0) {
            priceData.open = dailyData.todayOpen || price;
            priceData.high = dailyData.todayHigh || price;
            priceData.low = dailyData.todayLow || price;
            priceData.close = dailyData.todayClose || price;
            priceData.volume = dailyData.todayVolume || 0;
          }
        }
      } catch (error) {
        console.warn(`⚠️ [DB STORE] Failed to fetch daily candles for ${instrumentKey}: ${error.message}`);
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
      } else if (!priceData.open) {
        // No candle data at all, just use price
        priceData.open = price;
        priceData.high = price;
        priceData.low = price;
        priceData.close = price;
        priceData.volume = 0;
      }

      // Calculate change using previous day's close (from daily API)
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

      return { success: true, instrumentKey };

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
      batchResults.forEach((result) => {
        if (result.success && result.data) {
          Object.entries(result.data).forEach(([key, data]) => {
            if (data?.last_price !== undefined) {
              priceMap[key] = data.last_price;
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

        // For still missing prices OR stale prices, fetch from Upstox API (historical data)
        const stillMissingKeys = instrumentKeys.filter((key) => priceMap[key] === undefined);
        const keysToRefresh = [...new Set([...stillMissingKeys, ...staleKeys])]; // Combine missing + stale, dedupe
        if (keysToRefresh.length > 0) {
          const missingCount = stillMissingKeys.length;
          const staleCount = staleKeys.length;
          console.log(`📡 [API FALLBACK] Fetching ${keysToRefresh.length} prices from Upstox API (market closed) - ${missingCount} missing, ${staleCount} stale`);

          const apiPromises = keysToRefresh.map(async (instrumentKey) => {
            try {
              const price = await getCurrentPrice(instrumentKey, false);
              console.log(`📡 [API FALLBACK] ${instrumentKey} -> price: ${price}`);
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
          console.log(`✅ [API FALLBACK] Fetched ${apiFetchedCount}/${keysToRefresh.length} prices from Upstox API`);
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
   * Returns price, change, and change_percent for each instrument
   *
   * @param {Array<string>} instrumentKeys - Array of instrument keys to fetch prices for
   * @returns {Promise<Object>} Map of instrument_key → { price, change, change_percent, previous_day_close }
   *
   * @example
   * const priceData = await priceCacheService.getLatestPricesWithChange(['NSE_EQ|INE123']);
   * console.log(priceData['NSE_EQ|INE123']);
   * // { price: 150.50, change: 2.30, change_percent: 1.55, previous_day_close: 148.20 }
   */
  async getLatestPricesWithChange(instrumentKeys) {
    if (!instrumentKeys || instrumentKeys.length === 0) {
      return {};
    }

    const priceDataMap = {};

    // First, try to get from database (which has previous_day_close)
    try {
      const latestPrices = await LatestPrice.getPricesForInstruments(instrumentKeys);

      latestPrices.forEach((priceDoc) => {
        const currentPrice = priceDoc.last_traded_price;
        let change = priceDoc.change || 0;
        let changePercent = priceDoc.change_percent || 0;

        // Recalculate change using previous_day_close if available (more accurate)
        if (priceDoc.previous_day_close && currentPrice) {
          change = currentPrice - priceDoc.previous_day_close;
          changePercent = (change / priceDoc.previous_day_close) * 100;
        }

        priceDataMap[priceDoc.instrument_key] = {
          price: currentPrice,
          change: Math.round(change * 100) / 100,
          change_percent: Math.round(changePercent * 100) / 100,
          previous_day_close: priceDoc.previous_day_close || null
        };
      });
    } catch (error) {
      console.error(`❌ [PRICES WITH CHANGE] Database fetch failed: ${error.message}`);
    }

    // For missing instruments, fetch fresh data
    const missingKeys = instrumentKeys.filter((key) => !priceDataMap[key]);
    if (missingKeys.length > 0) {
      // Fetch prices (this will also store to DB with previous_day_close)
      const freshPrices = await this.getLatestPrices(missingKeys);

      // Now re-fetch from DB to get the change data
      try {
        const freshPricesDocs = await LatestPrice.getPricesForInstruments(missingKeys);

        freshPricesDocs.forEach((priceDoc) => {
          const currentPrice = priceDoc.last_traded_price;
          let change = priceDoc.change || 0;
          let changePercent = priceDoc.change_percent || 0;

          if (priceDoc.previous_day_close && currentPrice) {
            change = currentPrice - priceDoc.previous_day_close;
            changePercent = (change / priceDoc.previous_day_close) * 100;
          }

          priceDataMap[priceDoc.instrument_key] = {
            price: currentPrice,
            change: Math.round(change * 100) / 100,
            change_percent: Math.round(changePercent * 100) / 100,
            previous_day_close: priceDoc.previous_day_close || null
          };
        });
      } catch (error) {
        // Fallback: use just the price
        Object.entries(freshPrices).forEach(([key, price]) => {
          if (!priceDataMap[key]) {
            priceDataMap[key] = {
              price: price,
              change: 0,
              change_percent: 0,
              previous_day_close: null
            };
          }
        });
      }
    }

    return priceDataMap;
  }
}

// Export singleton instance
export default new PriceCacheService();