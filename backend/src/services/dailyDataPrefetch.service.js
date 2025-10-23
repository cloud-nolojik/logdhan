import { User } from '../models/user.js';
import Stock from '../models/stock.js';
import PreFetchedData from '../models/preFetchedData.js';
import DailyJobStatus from '../models/dailyJobStatus.js';
import MarketTiming from '../models/marketTiming.js';
import upstoxMarketTimingService from './upstoxMarketTiming.service.js';
import { aiReviewService } from './ai/aiReview.service.js';

class DailyDataPrefetchService {
    constructor() {
        this.timeframes = ['5m', '15m', '1h', '1d'];
        this.barsRequired = {
            '5m': 200,   // ~16 hours of 5-min bars
            '15m': 100,  // ~25 hours of 15-min bars  
            '1h': 50,    // ~2 days of hourly bars
            '1d': 30     // ~1 month of daily bars
        };
        this.maxConcurrentFetches = 5; // Rate limiting
        this.delayBetweenFetches = 1000; // 1 second delay
    }

    /**
     * Main entry point for daily data pre-fetch
     */
    async runDailyPrefetch(targetDate = null) {
        const tradingDate = targetDate || new Date();
        tradingDate.setHours(0, 0, 0, 0);

        console.log(`🚀 [PREFETCH] Starting daily data pre-fetch for ${tradingDate.toDateString()}`);

        // Check if this is a trading day
        const isTradingDay = await this.isTradingDay(tradingDate);
        if (!isTradingDay) {
            console.log(`📅 [PREFETCH] ${tradingDate.toDateString()} is not a trading day, skipping`);
            return { success: false, reason: 'not_trading_day' };
        }

        // Check if job already completed
        const existingJob = await DailyJobStatus.getLatestJob('data_prefetch', tradingDate);
        if (existingJob && existingJob.status === 'completed') {
            console.log(`✅ [PREFETCH] Data already pre-fetched for ${tradingDate.toDateString()}`);
            return { success: true, reason: 'already_completed', job: existingJob };
        }

        // Get unique stocks from all user watchlists
        const uniqueStocks = await this.getUniqueWatchlistStocks();
        console.log(`📊 [PREFETCH] Found ${uniqueStocks.length} unique stocks across all user watchlists`);

        if (uniqueStocks.length === 0) {
            console.log(`⚠️ [PREFETCH] No stocks found in any watchlist`);
            return { success: false, reason: 'no_stocks' };
        }

        // Create or update job status
        let jobStatus = existingJob && existingJob.status !== 'completed' 
            ? existingJob 
            : DailyJobStatus.createJob(tradingDate, 'data_prefetch', uniqueStocks.length);
        
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

            console.log(`✅ [PREFETCH] Daily pre-fetch completed successfully`);
            console.log(`📊 [PREFETCH] Summary: ${results.successCount}/${uniqueStocks.length} stocks, ${results.totalBars} bars, ${results.totalApiCalls} API calls`);

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
            const allStocks = users.flatMap(user => user.watchlist || []);
            const uniqueInstrumentKeys = [...new Set(allStocks.map(stock => stock.instrument_key))];

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

            console.log(`📊 [PREFETCH] Processed ${users.length} user watchlists, found ${stockDetails.length} unique stocks`);
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

        console.log(`🔄 [PREFETCH] Starting data fetch for ${stocks.length} stocks across ${this.timeframes.length} timeframes`);

        // Process stocks in batches to avoid overwhelming the API
        for (let i = 0; i < stocks.length; i += this.maxConcurrentFetches) {
            const batch = stocks.slice(i, i + this.maxConcurrentFetches);
            
            console.log(`📦 [PREFETCH] Processing batch ${Math.floor(i/this.maxConcurrentFetches) + 1}/${Math.ceil(stocks.length/this.maxConcurrentFetches)} (${batch.length} stocks)`);

            // Process batch concurrently
            const batchPromises = batch.map(stock => this.prefetchSingleStock(stock, tradingDate, jobStatus));
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
     * Pre-fetch data for a single stock across all timeframes
     */
    async prefetchSingleStock(stock, tradingDate, jobStatus) {
        const startTime = Date.now();
        let totalBars = 0;
        let apiCalls = 0;

        console.log(`📈 [PREFETCH] Checking data for ${stock.stock_symbol} (${stock.instrument_key})`);

        try {
            for (const timeframe of this.timeframes) {
                try {
                    // Get existing data for this stock/timeframe (any date)
                    const existingData = await PreFetchedData.findOne({
                        instrument_key: stock.instrument_key,
                        timeframe: timeframe
                    }).sort({ updated_at: -1 }); // Get the most recent record

                    let updateResult;
                    if (existingData) {
                        // Update existing data with new bars
                        updateResult = await this.updateExistingData(stock, timeframe, existingData);
                    } else {
                        // First time - fetch all required bars
                        updateResult = await this.fetchInitialData(stock, timeframe, tradingDate);
                    }

                    if (updateResult.success) {
                        totalBars += updateResult.newBars;
                        if (updateResult.apiCalled) apiCalls++;
                        
                        jobStatus.updateProgress(jobStatus.stocks_processed, timeframe, updateResult.newBars);
                        
                        if (updateResult.newBars > 0) {
                            console.log(`✅ [PREFETCH] ${stock.stock_symbol} ${timeframe}: ${updateResult.newBars} new bars (${updateResult.totalBars} total)`);
                        } else {
                            console.log(`⏭️ [PREFETCH] ${stock.stock_symbol} ${timeframe}: Already up to date`);
                        }
                    } else {
                        jobStatus.addError('UPDATE_ERROR', stock.stock_symbol, timeframe, updateResult.error);
                        console.warn(`⚠️ [PREFETCH] ${updateResult.error}`);
                    }

                    // Small delay between timeframe requests
                    await this.delay(200);

                } catch (error) {
                    jobStatus.addError('FETCH_ERROR', stock.stock_symbol, timeframe, error.message);
                    console.error(`❌ [PREFETCH] Error processing ${stock.stock_symbol} ${timeframe}:`, error.message);
                }
            }

            const duration = Date.now() - startTime;
            console.log(`⏱️ [PREFETCH] ${stock.stock_symbol} completed in ${duration}ms (${totalBars} new bars, ${apiCalls} API calls)`);

            return { totalBars, apiCalls, duration };

        } catch (error) {
            console.error(`❌ [PREFETCH] Failed to process ${stock.stock_symbol}:`, error);
            throw error;
        }
    }

    /**
     * Update existing data with new bars
     */
    async updateExistingData(stock, timeframe, existingData) {
        try {
            // Check if data is from today already
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            const dataDate = new Date(existingData.trading_date);
            dataDate.setHours(0, 0, 0, 0);
            
            // If data is from today and updated recently (last 2 hours), skip
            const now = new Date();
            const lastUpdate = new Date(existingData.updated_at);
            const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);
            
            if (dataDate.getTime() === today.getTime() && hoursSinceUpdate < 2) {
                return {
                    success: true,
                    newBars: 0,
                    totalBars: existingData.bars_count,
                    apiCalled: false
                };
            }

            // Get the latest timestamp from existing data
            const existingCandles = existingData.candle_data || [];
            if (existingCandles.length === 0) {
                // No existing data, treat as initial fetch
                return await this.fetchInitialData(stock, timeframe, today);
            }

            // Find the latest timestamp
            const latestTimestamp = existingCandles.reduce((latest, candle) => {
                const candleTime = new Date(candle.timestamp);
                return candleTime > latest ? candleTime : latest;
            }, new Date(existingCandles[0].timestamp));

            console.log(`🔄 [PREFETCH] ${stock.stock_symbol} ${timeframe}: Last data from ${latestTimestamp.toISOString()}`);

            // Fetch new data since latest timestamp
            const newCandleData = await this.fetchCandleDataSince(stock.instrument_key, timeframe, latestTimestamp);
            
            if (!newCandleData || newCandleData.length === 0) {
                // No new data available
                return {
                    success: true,
                    newBars: 0,
                    totalBars: existingData.bars_count,
                    apiCalled: true
                };
            }

            // Filter out duplicates based on timestamp
            const newBarsOnly = newCandleData.filter(newCandle => {
                const newTime = new Date(newCandle.timestamp);
                return !existingCandles.some(existing => 
                    new Date(existing.timestamp).getTime() === newTime.getTime()
                );
            });

            if (newBarsOnly.length === 0) {
                return {
                    success: true,
                    newBars: 0,
                    totalBars: existingData.bars_count,
                    apiCalled: true
                };
            }

            // Append new bars to existing data
            const updatedCandles = [...existingCandles, ...newBarsOnly]
                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            // Keep only required number of bars (remove oldest if necessary)
            const maxBars = this.barsRequired[timeframe] || 200;
            const finalCandles = updatedCandles.slice(-maxBars);

            // Update the existing record
            existingData.candle_data = finalCandles;
            existingData.bars_count = finalCandles.length;
            existingData.trading_date = today;
            existingData.updated_at = new Date();
            existingData.data_quality = this.analyzeDataQuality(finalCandles, timeframe);

            await existingData.save();

            return {
                success: true,
                newBars: newBarsOnly.length,
                totalBars: finalCandles.length,
                apiCalled: true
            };

        } catch (error) {
            console.error(`❌ [PREFETCH] Error updating existing data:`, error);
            return {
                success: false,
                error: error.message,
                newBars: 0,
                apiCalled: false
            };
        }
    }

    /**
     * Fetch initial data for a new stock/timeframe
     */
    async fetchInitialData(stock, timeframe, tradingDate) {
        try {
            console.log(`🆕 [PREFETCH] ${stock.stock_symbol} ${timeframe}: First time fetch`);

            // Fetch full historical data
            const candleData = await this.fetchCandleData(stock.instrument_key, timeframe);
            
            if (!candleData || candleData.length === 0) {
                return {
                    success: false,
                    error: `No data received for ${stock.stock_symbol} ${timeframe}`,
                    newBars: 0,
                    apiCalled: true
                };
            }

            // Store in database
            await this.storeCandleData(stock, timeframe, tradingDate, candleData);

            return {
                success: true,
                newBars: candleData.length,
                totalBars: candleData.length,
                apiCalled: true
            };

        } catch (error) {
            console.error(`❌ [PREFETCH] Error fetching initial data:`, error);
            return {
                success: false,
                error: error.message,
                newBars: 0,
                apiCalled: false
            };
        }
    }

    /**
     * Fetch candle data since a specific timestamp
     */
    async fetchCandleDataSince(instrumentKey, timeframe, sinceTimestamp) {
        try {
            // For now, we'll fetch all data and filter client-side
            // In future, we could modify the API call to include date ranges
            const allData = await this.fetchCandleData(instrumentKey, timeframe);
            
            if (!allData || allData.length === 0) {
                return [];
            }

            // Filter data newer than the since timestamp
            const filtered = allData.filter(candle => {
                const candleTime = new Date(candle.timestamp);
                return candleTime > sinceTimestamp;
            });

            return filtered;

        } catch (error) {
            console.error(`❌ [PREFETCH] Error fetching data since timestamp:`, error);
            throw error;
        }
    }

    /**
     * Fetch candle data for specific stock and timeframe with smart endpoint selection
     */
    async fetchCandleData(instrumentKey, timeframe, forceCurrentDay = false) {
        try {
            let candleData, candles;

            if (forceCurrentDay && (timeframe === '5m' || timeframe === '15m' || timeframe === '1h')) {
                // Use V3 Intraday API for current day data
                console.log(`📊 [PREFETCH] Using V3 intraday API for current day ${timeframe} data`);
                
                const intradayUrl = this.buildIntradayV3Url(instrumentKey, timeframe);
                candleData = await aiReviewService.fetchCandleData(intradayUrl);
                candles = candleData?.data?.candles || candleData?.candles || [];
                
            } else {
                // Use existing historical data approach
                const tempTradeData = {
                    term: 'short', // For swing trading
                    instrument_key: instrumentKey,
                    stock: instrumentKey
                };

                const { endpoints } = await aiReviewService.buildCandleUrls(tempTradeData);
                
                // Find the endpoint for our desired timeframe
                const targetEndpoint = endpoints.find(ep => 
                    ep.url.includes(`interval=${timeframe}`) || 
                    ep.timeframe === timeframe
                );

                if (!targetEndpoint) {
                    console.warn(`⚠️ [PREFETCH] No endpoint found for timeframe ${timeframe}`);
                    return null;
                }

                // Fetch the data
                candleData = await aiReviewService.fetchCandleData(targetEndpoint.url);
                candles = candleData?.data?.candles || candleData?.candles || [];
            }

            // Convert to our standard format
            const formattedCandles = candles.map(candle => ({
                timestamp: new Date(Array.isArray(candle) ? candle[0] : candle.time),
                open: Array.isArray(candle) ? candle[1] : candle.open,
                high: Array.isArray(candle) ? candle[2] : candle.high,
                low: Array.isArray(candle) ? candle[3] : candle.low,
                close: Array.isArray(candle) ? candle[4] : candle.close,
                volume: Array.isArray(candle) ? candle[5] : candle.volume
            }));

            return formattedCandles;

        } catch (error) {
            console.error(`❌ [PREFETCH] Error fetching candle data:`, error);
            throw error;
        }
    }

    /**
     * Build V3 Intraday URL for current day data (reused from aiReview.service.js)
     */
    buildIntradayV3Url(instrumentKey, timeframe) {
        // Map our timeframes to V3 API format
        const timeframeMapping = {
            '5m': { unit: 'minutes', interval: '5' },
            '15m': { unit: 'minutes', interval: '15' },
            '30m': { unit: 'minutes', interval: '30' },
            '1h': { unit: 'hours', interval: '1' },
            '2h': { unit: 'hours', interval: '2' },
            '1d': { unit: 'days', interval: '1' }
        };

        const mapping = timeframeMapping[timeframe];
        if (!mapping) {
            throw new Error(`Unsupported timeframe for V3 intraday API: ${timeframe}`);
        }

        // V3 Intraday API URL format: 
        // https://api.upstox.com/v3/historical-candle/intraday/{instrument_key}/{unit}/{interval}
        return `https://api.upstox.com/v3/historical-candle/intraday/${instrumentKey}/${mapping.unit}/${mapping.interval}`;
    }

    /**
     * Run current day data pre-fetch after market close (after 4:00 PM)
     */
    async runCurrentDayPrefetch() {
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const currentTimeMinutes = hours * 60 + minutes;
        const PREFETCH_AFTER = 16 * 60; // 4:00 PM

        if (currentTimeMinutes < PREFETCH_AFTER) {
            console.log(`⏰ [CURRENT DAY PREFETCH] Too early to fetch current day data (${hours}:${String(minutes).padStart(2, '0')}). Will run after 4:00 PM.`);
            return { success: false, reason: 'too_early' };
        }

        // Check if today is a trading day
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const isTradingDay = await this.isTradingDay(today);
        if (!isTradingDay) {
            console.log(`📅 [CURRENT DAY PREFETCH] ${today.toDateString()} is not a trading day, skipping`);
            return { success: false, reason: 'not_trading_day' };
        }

        console.log(`🚀 [CURRENT DAY PREFETCH] Starting current day data pre-fetch for ${today.toDateString()}`);

        // Get unique stocks from all user watchlists
        const uniqueStocks = await this.getUniqueWatchlistStocks();
        console.log(`📊 [CURRENT DAY PREFETCH] Found ${uniqueStocks.length} unique stocks to update`);

        if (uniqueStocks.length === 0) {
            return { success: false, reason: 'no_stocks' };
        }

        let successCount = 0;
        let totalBars = 0;
        let totalApiCalls = 0;
        const errors = [];

        try {
            // Process stocks in smaller batches for current day updates
            for (let i = 0; i < uniqueStocks.length; i += this.maxConcurrentFetches) {
                const batch = uniqueStocks.slice(i, i + this.maxConcurrentFetches);
                
                console.log(`📦 [CURRENT DAY PREFETCH] Processing batch ${Math.floor(i/this.maxConcurrentFetches) + 1}/${Math.ceil(uniqueStocks.length/this.maxConcurrentFetches)} (${batch.length} stocks)`);

                // Process batch concurrently
                const batchPromises = batch.map(stock => this.prefetchCurrentDayStock(stock, today));
                const batchResults = await Promise.allSettled(batchPromises);

                // Process results
                for (const result of batchResults) {
                    if (result.status === 'fulfilled') {
                        successCount++;
                        totalBars += result.value.totalBars;
                        totalApiCalls += result.value.apiCalls;
                    } else {
                        errors.push(result.reason);
                        console.error(`❌ [CURRENT DAY PREFETCH] Batch error:`, result.reason);
                    }
                }

                // Rate limiting delay between batches
                if (i + this.maxConcurrentFetches < uniqueStocks.length) {
                    await this.delay(this.delayBetweenFetches);
                }
            }

            console.log(`✅ [CURRENT DAY PREFETCH] Current day pre-fetch completed successfully`);
            console.log(`📊 [CURRENT DAY PREFETCH] Summary: ${successCount}/${uniqueStocks.length} stocks, ${totalBars} bars, ${totalApiCalls} API calls`);

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
     * Pre-fetch current day data for a single stock (intraday timeframes only)
     */
    async prefetchCurrentDayStock(stock, tradingDate) {
        const startTime = Date.now();
        let totalBars = 0;
        let apiCalls = 0;

        console.log(`📈 [CURRENT DAY PREFETCH] Updating current day data for ${stock.stock_symbol} (${stock.instrument_key})`);

        try {
            // Only fetch intraday timeframes for current day
            const intradayTimeframes = ['5m', '15m', '1h'];
            
            for (const timeframe of intradayTimeframes) {
                try {
                    // Fetch current day data using V3 API
                    const currentDayData = await this.fetchCandleData(stock.instrument_key, timeframe, true);
                    
                    if (currentDayData && currentDayData.length > 0) {
                        // Check if we already have data for today
                        const existingData = await PreFetchedData.findOne({
                            instrument_key: stock.instrument_key,
                            timeframe: timeframe
                        });

                        if (existingData) {
                            // Merge current day data with existing historical data
                            const mergedResult = await this.mergeCurrentDayData(existingData, currentDayData, tradingDate);
                            if (mergedResult.success) {
                                totalBars += mergedResult.newBars;
                                apiCalls++;
                                console.log(`✅ [CURRENT DAY PREFETCH] ${stock.stock_symbol} ${timeframe}: ${mergedResult.newBars} current day bars merged`);
                            }
                        } else {
                            // Store current day data as new record
                            await this.storeCandleData(stock, timeframe, tradingDate, currentDayData);
                            totalBars += currentDayData.length;
                            apiCalls++;
                            console.log(`✅ [CURRENT DAY PREFETCH] ${stock.stock_symbol} ${timeframe}: ${currentDayData.length} current day bars stored`);
                        }
                    }

                    // Small delay between timeframe requests
                    await this.delay(200);

                } catch (error) {
                    console.error(`❌ [CURRENT DAY PREFETCH] Error processing ${stock.stock_symbol} ${timeframe}:`, error.message);
                }
            }

            const duration = Date.now() - startTime;
            console.log(`⏱️ [CURRENT DAY PREFETCH] ${stock.stock_symbol} completed in ${duration}ms (${totalBars} new bars, ${apiCalls} API calls)`);

            return { totalBars, apiCalls, duration };

        } catch (error) {
            console.error(`❌ [CURRENT DAY PREFETCH] Failed to process ${stock.stock_symbol}:`, error);
            throw error;
        }
    }

    /**
     * Merge current day data with existing historical data
     */
    async mergeCurrentDayData(existingData, currentDayData, tradingDate) {
        try {
            const existingCandles = existingData.candle_data || [];
            
            // Filter current day data to only include new timestamps
            const existingTimestamps = new Set(existingCandles.map(c => new Date(c.timestamp).getTime()));
            const newCandles = currentDayData.filter(candle => 
                !existingTimestamps.has(new Date(candle.timestamp).getTime())
            );

            if (newCandles.length === 0) {
                return { success: true, newBars: 0, totalBars: existingCandles.length };
            }

            // Merge and sort all candles
            const allCandles = [...existingCandles, ...newCandles]
                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            // Keep only required number of bars (remove oldest if necessary)
            const maxBars = this.barsRequired[existingData.timeframe] || 200;
            const finalCandles = allCandles.slice(-maxBars);

            // Update the existing record
            existingData.candle_data = finalCandles;
            existingData.bars_count = finalCandles.length;
            existingData.trading_date = tradingDate;
            existingData.updated_at = new Date();
            existingData.current_day_updated = true;
            existingData.data_quality = this.analyzeDataQuality(finalCandles, existingData.timeframe);

            await existingData.save();

            return {
                success: true,
                newBars: newCandles.length,
                totalBars: finalCandles.length
            };

        } catch (error) {
            console.error(`❌ [CURRENT DAY PREFETCH] Error merging current day data:`, error);
            return {
                success: false,
                error: error.message,
                newBars: 0
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
                timeframe: timeframe,
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
                console.log(`⚠️ [PREFETCH] Data already exists for ${stock.stock_symbol} ${timeframe}`);
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

        // Sort by timestamp
        const sortedData = candleData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        const expectedBars = this.barsRequired[timeframe] || 100;
        const missingBars = Math.max(0, expectedBars - sortedData.length);
        
        // Check for gaps (simplified)
        let hasGaps = false;
        if (sortedData.length > 1) {
            const timeInterval = this.getTimeIntervalMs(timeframe);
            for (let i = 1; i < sortedData.length; i++) {
                const timeDiff = new Date(sortedData[i].timestamp) - new Date(sortedData[i-1].timestamp);
                if (timeDiff > timeInterval * 1.5) { // Allow 50% tolerance
                    hasGaps = true;
                    break;
                }
            }
        }

        return {
            missing_bars: missingBars,
            has_gaps: hasGaps,
            last_bar_time: sortedData[sortedData.length - 1].timestamp
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
     * Check if date is a trading day
     */
    async isTradingDay(date) {
        try {
            const dateStr = date.toISOString().split('T')[0];
            const marketTiming = await MarketTiming.findOne({ date: dateStr });
            
            if (marketTiming) {
                return marketTiming.isMarketOpen;
            }
            
            // Fallback: weekdays are trading days
            const dayOfWeek = date.getDay();
            return dayOfWeek >= 1 && dayOfWeek <= 5;
            
        } catch (error) {
            console.error(`❌ [PREFETCH] Error checking trading day:`, error);
            // Fallback to weekday check
            const dayOfWeek = date.getDay();
            return dayOfWeek >= 1 && dayOfWeek <= 5;
        }
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
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get pre-fetched data for analysis
     */
    static async getDataForAnalysis(instrumentKey, analysisType = 'swing') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        console.log(`🔍 [PREFETCH SERVICE] getDataForAnalysis called:`);
        console.log(`   - instrumentKey: "${instrumentKey}"`);
        console.log(`   - analysisType: "${analysisType}"`);
        console.log(`   - today: ${today.toISOString()}`);
        
        try {
            const data = await PreFetchedData.getDataForAnalysis(
                instrumentKey, 
                ['5m', '15m', '1h', '1d', '1D'], // Include both '1d' and '1D' for compatibility
                today
            );
            
            console.log(`📊 [PREFETCH RESULT] Query completed for ${instrumentKey}`);
            console.log(`   - Records found: ${data ? data.length : 'null'}`);
            if (data && data.length > 0) {
                data.forEach((record, index) => {
                    console.log(`   - Record ${index + 1}: ${record.timeframe} (${record.bars_count} bars, trading_date: ${record.trading_date.toISOString()}, id: ${record._id})`);
                });
            }
            
            if (data && data.length > 0) {
                console.log(`📦 [PREFETCH] Using pre-fetched data for ${instrumentKey}: ${data.length} timeframes`);
                return {
                    success: true,
                    data: data,
                    source: 'prefetched',
                    timeframes: data.map(d => d.timeframe)
                };
            } else {
                console.log(`❌ [PREFETCH] No pre-fetched data found for ${instrumentKey}`);
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