import { getCurrentPrice, getExactStock } from '../utils/stockDb.js';
import MarketHoursUtil from '../utils/marketHours.js';
import LatestPrice from '../models/latestPrice.js';

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
            'BSE_INDEX|BSE-500'
        ];

        // Add market indices by default
        this.MARKET_INDICES.forEach(key => this.trackedInstruments.add(key));
    }

    /**
     * Start the price caching service
     * Fetches prices every 2 minutes at the 0th second
     */
    start() {
        if (this.pollingInterval) {
            console.log('⚡ Price cache service already running');
            return;
        }

        console.log('🚀 Starting price cache service...');

        // Fetch immediately on startup
        this.fetchAndCachePrices();

        // Then fetch every 2 minutes (120 seconds)
        this.pollingInterval = setInterval(() => {
            this.fetchAndCachePrices();
        }, this.CACHE_DURATION);

        console.log('⚡ Price cache service started - polling every 2 minutes (120 seconds)');
    }

    /**
     * Stop the price caching service
     */
    stop() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
            console.log('⏸️ Price cache service stopped');
        }
    }

    /**
     * Add instruments to track
     * @param {Array<string>} instrumentKeys - Array of instrument keys to track
     */
    addInstruments(instrumentKeys) {
        const beforeCount = this.trackedInstruments.size;
        const newInstruments = [];

        instrumentKeys.forEach(key => {
            if (!this.trackedInstruments.has(key)) {
                newInstruments.push(key);
                this.trackedInstruments.add(key);
            }
        });

        const afterCount = this.trackedInstruments.size;
        const newCount = afterCount - beforeCount;

        if (newCount > 0) {
            console.log(`📊 Added ${newCount} new instruments to cache (total: ${afterCount})`);
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
            console.log(`🔍 Checking database for ${instrumentKeys.length} new instruments...`);
            const existingPrices = await LatestPrice.getPricesForInstruments(instrumentKeys);
            const existingKeys = new Set(existingPrices.map(p => p.instrument_key));

            // Instruments that don't exist in DB (need API fetch)
            const missingInstruments = instrumentKeys.filter(key => !existingKeys.has(key));

            // Instruments that exist in DB (load into memory cache)
            const foundInstruments = instrumentKeys.filter(key => existingKeys.has(key));

            console.log(`📊 DB Check: ${foundInstruments.length} found in DB, ${missingInstruments.length} missing`);

            // Step 2: Load existing prices from DB into memory cache
            if (foundInstruments.length > 0) {
                existingPrices.forEach(priceDoc => {
                    this.priceCache.set(priceDoc.instrument_key, {
                        ltp: priceDoc.last_traded_price,
                        candles: priceDoc.recent_candles || null,
                        timestamp: new Date(priceDoc.updated_at).getTime(),
                        lastUpdated: priceDoc.updated_at
                    });
                });
                console.log(`✅ Loaded ${foundInstruments.length} prices from DB into memory cache`);
            }

            // Step 3: If all instruments found in DB, we're done
            if (missingInstruments.length === 0) {
                console.log('✅ All instruments found in DB - no API fetch needed');
                return;
            }

            // Step 4: For missing instruments, check market hours
            const isMarketOpen = await MarketHoursUtil.isMarketOpen();

            if (isMarketOpen) {
                // Market is open - fetch real-time prices for missing instruments
                console.log(`✅ Market is open - fetching real-time prices for ${missingInstruments.length} missing instruments`);
                await this.fetchPricesForInstruments(missingInstruments);
            } else {
                // Market is closed - fetch last known prices (historical) for missing instruments
                console.log(`⏸️ Market is closed - fetching last known prices for ${missingInstruments.length} missing instruments`);
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

        console.log(`⚡ [PRICE CACHE] Fetching prices on-demand for ${instrumentKeys.length} new instruments...`);

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

            console.log(`⚡ [PRICE CACHE] On-demand fetch completed - ${successCount}/${instrumentKeys.length} successful`);
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

        console.log(`📚 [PRICE CACHE] Fetching last known prices for ${instrumentKeys.length} instruments (market closed)...`);

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
                Promise.all(dbUpdatePromises)
                    .then(results => {
                        const dbSuccessCount = results.filter(r => r.success).length;
                        console.log(`💾 [PRICE CACHE] Stored ${dbSuccessCount}/${dbUpdatePromises.length} historical prices in database`);
                    })
                    .catch(error => {
                        console.error(`❌ [PRICE CACHE] DB storage error (historical): ${error.message}`);
                    });
            }

            console.log(`📚 [PRICE CACHE] Historical fetch completed - ${successCount}/${instrumentKeys.length} successful`);
        } catch (error) {
            console.error('❌ [PRICE CACHE] Error in historical fetch:', error.message);
        }
    }

    /**
     * Remove instruments from tracking
     * @param {Array<string>} instrumentKeys - Array of instrument keys to stop tracking
     */
    removeInstruments(instrumentKeys) {
        instrumentKeys.forEach(key => {
            this.trackedInstruments.delete(key);
            this.priceCache.delete(key);
        });

        console.log(`📊 Removed ${instrumentKeys.length} instruments from cache (remaining: ${this.trackedInstruments.size})`);
    }

    /**
     * Fetch and cache prices for all tracked instruments
     * Uses getCurrentPrice internally for compatibility with existing code
     * @private
     */
    async fetchAndCachePrices() {
        if (this.trackedInstruments.size === 0) {
            console.log('⚠️ No instruments to track, skipping price fetch');
            return;
        }

        // Check if market is open before fetching
        try {
            const isMarketOpen = await MarketHoursUtil.isMarketOpen();
            if (!isMarketOpen) {
                console.log('⏸️ [PRICE CACHE] Market is closed - skipping scheduled price fetch');
                return;
            }
        } catch (error) {
            console.error('❌ [PRICE CACHE] Error checking market hours:', error.message);
            // Continue with fetch if we can't determine market hours (fail-safe)
        }

        const startTime = Date.now();
        const instrumentKeys = Array.from(this.trackedInstruments);

        console.log(`⚡ [PRICE CACHE] Fetching prices for ${instrumentKeys.length} instruments (${this.MARKET_INDICES.length} indices + ${instrumentKeys.length - this.MARKET_INDICES.length} stocks)...`);

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
                Promise.all(dbUpdatePromises)
                    .then(results => {
                        const dbSuccessCount = results.filter(r => r.success).length;
                        console.log(`💾 [PRICE CACHE] Stored ${dbSuccessCount}/${dbUpdatePromises.length} prices in database`);
                    })
                    .catch(error => {
                        console.error(`❌ [PRICE CACHE] DB storage error: ${error.message}`);
                    });
            }

            this.lastFetchTime = timestamp;

            const totalTime = Date.now() - startTime;
            console.log(`⚡ [PRICE CACHE] Cache updated in ${totalTime}ms - ${successCount}/${instrumentKeys.length} successful (using Intraday API)`);

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

        instrumentKeys.forEach(key => {
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

        instrumentKeys.forEach(key => {
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

            // If we have candle data, extract OHLCV
            if (candles && candles.length > 0) {
                const latestCandle = candles[0]; // Most recent candle
                priceData.open = latestCandle[1] || price;
                priceData.high = latestCandle[2] || price;
                priceData.low = latestCandle[3] || price;
                priceData.close = latestCandle[4] || price;
                priceData.volume = latestCandle[5] || 0;

                // Calculate change from previous candle
                if (candles.length > 1) {
                    const previousCandle = candles[1];
                    const previousClose = previousCandle[4];
                    priceData.change = price - previousClose;
                    priceData.change_percent = previousClose !== 0 ? (priceData.change / previousClose) * 100 : 0;
                } else {
                    priceData.change = price - priceData.open;
                    priceData.change_percent = priceData.open !== 0 ? (priceData.change / priceData.open) * 100 : 0;
                }

                // Store recent candles (last 5 for mini-chart)
                priceData.recent_candles = candles.slice(0, 5).map(candle => ({
                    timestamp: new Date(candle[0]),
                    open: candle[1],
                    high: candle[2],
                    low: candle[3],
                    close: candle[4],
                    volume: candle[5]
                }));
            } else {
                // No candle data, just price
                priceData.open = price;
                priceData.high = price;
                priceData.low = price;
                priceData.close = price;
                priceData.volume = 0;
                priceData.change = 0;
                priceData.change_percent = 0;
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
        console.log('🗑️ Price cache cleared');
    }

    /**
     * Get latest prices for multiple instruments using triple-fallback pattern
     * Priority: Database → Memory Cache → API
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

        console.log(`⚡ [GET LATEST PRICES] Fetching prices for ${instrumentKeys.length} instruments...`);

        // Add instruments to tracking (triggers background updates)
        this.addInstruments(instrumentKeys);

        const priceMap = {};

        // Step 1: Fetch from database (persistent, accurate)
        const dbStart = Date.now();
        try {
            const latestPrices = await LatestPrice.getPricesForInstruments(instrumentKeys);
            latestPrices.forEach(priceDoc => {
                priceMap[priceDoc.instrument_key] = priceDoc.last_traded_price;
            });
            console.log(`💾 [DB] Found ${latestPrices.length}/${instrumentKeys.length} prices in ${Date.now() - dbStart}ms`);
        } catch (error) {
            console.error(`❌ [DB] Database fetch failed: ${error.message}`);
        }

    
        // Step 3: For still missing prices, fetch from API
        const missingAfterMemory = instrumentKeys.filter(key => priceMap[key] === undefined);
        if (missingAfterMemory.length > 0) {
            console.log(`🌐 [API] Fetching ${missingAfterMemory.length} missing prices from Upstox API...`);

            const apiStart = Date.now();
            const apiPromises = missingAfterMemory.map(async (instrumentKey) => {
                try {
                    const price = await getCurrentPrice(instrumentKey, false);
                    return { instrumentKey, price };
                } catch (error) {
                    console.warn(`⚠️ [API] Failed to fetch ${instrumentKey}: ${error.message}`);
                    return { instrumentKey, price: null };
                }
            });

            const apiResults = await Promise.all(apiPromises);
            let apiSuccessCount = 0;

            apiResults.forEach(({ instrumentKey, price }) => {
                if (price !== null) {
                    priceMap[instrumentKey] = price;
                    apiSuccessCount++;

                    // Update memory cache with fetched price
                    this.priceCache.set(instrumentKey, {
                        ltp: price,
                        candles: null,
                        timestamp: Date.now(),
                        lastUpdated: new Date().toISOString()
                    });
                }
            });

            const apiTime = Date.now() - apiStart;
            console.log(`🌐 [API] Fetched ${apiSuccessCount}/${missingAfterMemory.length} prices in ${apiTime}ms`);
        }

        const totalFound = Object.keys(priceMap).length;
        console.log(`✅ [GET LATEST PRICES] Completed: ${totalFound}/${instrumentKeys.length} prices found`);

        return priceMap;
    }
}

// Export singleton instance
export default new PriceCacheService();
