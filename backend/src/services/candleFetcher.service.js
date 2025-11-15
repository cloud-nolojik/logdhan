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
// Import indicator calculation function
const { calculateTechnicalIndicators } = await import('../utils/indicatorCalculator.js');

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
     */
    async getCandleDataForAnalysis(instrumentKey, term, skipIntraday = false) {
        // Check if market is currently open - if yes, exclude incomplete intraday candles
        try {
            // Step 1: Try to get pre-fetched data from database
            console.log(`🔍 [DB QUERY] Looking for instrument_key: "${instrumentKey}", term: "${term}"`);
            
            const preFetchedResult = await dailyDataPrefetchService.constructor.getDataForAnalysis(
                instrumentKey,
                term
            );
            
            console.log(`📊 [DB RESULT] Success: ${preFetchedResult.success}, Data length: ${preFetchedResult.data?.length || 0}`);
            if (preFetchedResult.data?.length > 0) {
                preFetchedResult.data.forEach((record, index) => {
                    console.log(`📋 [DB RECORD ${index + 1}] ${record.timeframe}: ${record.bars_count || record.candle_data?.length || 0} bars`);
                });
            }
            
            if (preFetchedResult.success && preFetchedResult.data?.length > 0) {

                const freshnessCheck = await this.checkDataFreshness(preFetchedResult.data);
                if(!freshnessCheck.fresh){
                    const incrementalResult = await incrementalUpdaterService.fetchIncrementalDataAndMerge(
                            instrumentKey,
                            preFetchedResult.data,
                            freshnessCheck.staleTimeframes,
                            this.fetchCandlesFromAPI.bind(this),
                            skipIntraday
                        );
                     if (incrementalResult.success) {
                            // Refresh DB data
                            const refreshed = await dailyDataPrefetchService.constructor.getDataForAnalysis(instrumentKey, term);
                            preFetchedResult.data = refreshed.data;
                        } else {
                            console.log(`⚠️ [HISTORICAL FETCH] Failed to fetch historical data`);
                        }
                }  
                const sufficientData = this.checkDataSufficiency(preFetchedResult.data);
                if (sufficientData.sufficient) {
                    console.log(`✅ [FRESHNESS] Data is fresh and sufficient`);
                    console.log(`✅ [CANDLE FETCHER] Using DB data: ${preFetchedResult.data.length} timeframes\n`);
                    return {
                            success: true,
                            source: 'database',
                            data: this.formatDatabaseData(preFetchedResult.data)
                    };
                } else {
                    console.log(`⚠️ [INSUFFICIENT] ${sufficientData.reason}`);
                    // Return error response instead of falling through
                    return {
                        success: false,
                        error: 'insufficient_data',
                        reason: sufficientData.reason,
                        source: 'database'
                    };
                }


            }
            else{

                console.log(`🔄 [CANDLE FETCHER] Fetching fresh data from API`);
                const apiResult = await this.fetchFromAPI(instrumentKey, term,skipIntraday);

                return {
                    success: true,
                    source: 'api',
                    data: apiResult
                };
            }


           


            

            // Step 2: Fallback to API fetching
            
            
        } catch (error) {
            console.error(`❌ [CANDLE FETCHER] Failed to get data: ${error.message}`);
            throw error;
        }
    }

    async checkDataFreshness(preFetchedData) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`🔍 [FRESHNESS CHECK] Starting data freshness validation`);
        console.log(`${'='.repeat(80)}`);
        console.log(`📊 Total timeframes to check: ${preFetchedData.length}\n`);

        const staleTimeframes = [];

        for (const timeframeData of preFetchedData) {
            const timeframe = timeframeData.timeframe;
            const lastBarTime = timeframeData.data_quality?.last_bar_time
                ? new Date(timeframeData.data_quality.last_bar_time)
                : null;

            console.log(`🔹 Checking ${timeframe}:`);

            if (!lastBarTime) {
                console.log(`   └─ Status: ❌ STALE (no last_bar_time found)\n`);
                staleTimeframes.push({ timeframe, reason: 'no_last_bar_time' });
                continue;
            }

            // Get effective time for this specific timeframe
            // This already handles market open/closed logic internally
            const expectedTime = await MarketHoursUtil.getEffectiveTradingTime(new Date(), timeframe);

            console.log(`   ├─ Last bar time: ${lastBarTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
            console.log(`   ├─ Expected time: ${expectedTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);

            // Calculate time difference
            const timeDiffMs = expectedTime - lastBarTime;
            const timeDiffHours = (timeDiffMs / (1000 * 60 * 60)).toFixed(2);
            const daysDiff = Math.floor(timeDiffMs / (1000 * 60 * 60 * 24));

            console.log(`   ├─ Time diff: ${timeDiffHours} hours (${daysDiff} days)`);

            // Simple freshness check: Allow up to 3 days old (handles weekends/holidays)
            const isStale = (lastBarTime < expectedTime);

            console.log(`   └─ Status: ${isStale ? '❌ STALE' : '✅ FRESH'}\n`);

            if (isStale) {
                staleTimeframes.push({
                    timeframe,
                    last_bar_time: lastBarTime,
                    time_diff_hours: parseFloat(timeDiffHours)
                });
            }
        }

        if (staleTimeframes.length > 0) {
            console.log(`${'='.repeat(80)}`);
            console.log(`⚠️  [RESULT] ${staleTimeframes.length}/${preFetchedData.length} timeframe(s) are STALE`);
            console.log(`${'='.repeat(80)}\n`);
            return {
                fresh: false,
                reason: `${staleTimeframes.length} timeframe(s) have stale data`,
                staleTimeframes
            };
        }

        console.log(`${'='.repeat(80)}`);
        console.log(`✅ [RESULT] All ${preFetchedData.length} timeframes have FRESH data`);
        console.log(`${'='.repeat(80)}\n`);
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
                console.log(`⚠️ [INSUFFICIENT] ${timeframeData.timeframe}: ${available}/${required} bars (${((available/required)*100).toFixed(1)}% - need 98%)`);
                return {
                    sufficient: false,
                    reason: `${timeframeData.timeframe} has only ${available}/${required} bars (need at least ${threshold})`
                };
            } else {
                console.log(`✅ [SUFFICIENT] ${timeframeData.timeframe}: ${available}/${required} bars (${((available/required)*100).toFixed(1)}% >= 98%)`);
            }
        }
        
        return { sufficient: true };
    }

    /**
     * Format database data into standard structure
     */
    formatDatabaseData(preFetchedData) {
        const candlesByTimeframe = {};
        
        preFetchedData.forEach(data => {
            candlesByTimeframe[data.timeframe] = data.candle_data || [];
        });
        
        return candlesByTimeframe;
    }

    /**
     * Fetch candle data from API and store in database
     */
    async fetchFromAPI(instrumentKey, term,skipIntraday) {
        try {
            // Build endpoints using existing smart API selection
            const tradeData = { instrument_key: instrumentKey, term: term,skipIntraday };
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
                console.log(`🔍 [ENDPOINT DEBUG] ================================`);
                console.log(`🔍 [ENDPOINT DEBUG] Processing timeframe: ${timeframe}`);

                const params = await dateCalculator.getTimeframeParams(timeframe);

                // Check if we need to use chunks (multiple API calls)
                if (params.chunks && params.chunks.length > 1) {
                    console.log(`📦 [CHUNKS] ${timeframe} requires ${params.chunks.length} API calls due to Upstox limits`);

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

                        console.log(`📊 [CHUNK ${index + 1}/${params.chunks.length}] ${timeframe}: ${chunkUrls.length} URL(s) generated`);

                        // Handle array of URLs (historical + intraday if needed)
                        chunkUrls.forEach((url, urlIndex) => {
                            const kind = url.includes('/intraday/') ? 'intraday' : 'historical';
                            console.log(`   ${urlIndex === 0 ? '├─' : '└─'} [${kind.toUpperCase()}] ${url}`);

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

                    console.log(`📊 [SINGLE CALL] ${timeframe}: ${urls.length} URL(s) generated`);

                    // Handle array of URLs (historical + intraday if needed)
                    urls.forEach((url, urlIndex) => {
                        const kind = url.includes('/intraday/') ? 'intraday' : 'historical';
                        console.log(`   ${urlIndex === 0 ? '├─' : '└─'} [${kind.toUpperCase()}] ${url}`);

                        endpoints.push({
                            frame: timeframe,
                            kind: kind,
                            url: url,
                            params: { ...params, urlIndex }
                        });
                    });
                }

                console.log(`🔍 [ENDPOINT DEBUG] ${timeframe} - Endpoints added for this timeframe: ${endpoints.filter(e => e.frame === timeframe).length}`);
                console.log(`🔍 [ENDPOINT DEBUG] ================================`);
            }
            
            console.log(`📡 [ENDPOINTS] Built ${endpoints.length} endpoints using hybrid approach`);
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

        if( fromDate instanceof Date && toDate instanceof Date){
            fromDate = dateCalculator.formatDateISO(fromDate);
            toDate = dateCalculator.formatDateISO(toDate);
        }

      

        

        // Get effective trading time for this timeframe
        const effectiveTime = await MarketHoursUtil.getEffectiveTradingTime(new Date(), timeframe);
        const effectiveDate = MarketHoursUtil.normalizeDateToMidnight(effectiveTime);
        const toDateNormalized = MarketHoursUtil.normalizeDateToMidnight(new Date(toDate));
        const today = MarketHoursUtil.normalizeDateToMidnight(new Date());

        // Check if toDate matches effective trading date (current trading day)
        const isCurrentTradingDay = toDateNormalized.getTime() === effectiveDate.getTime();
        const toDateIsToday = toDateNormalized.getTime() === today.getTime();

        const urls = [];
         if ((isCurrentTradingDay || toDateIsToday) && !skipIntraday) {
            let intradayUrl = this.buildIntradayUrl(instrumentKey, timeframe);
            console.log(`   └─ Intraday (today): ${intradayUrl}`);
           
        }
        const historicalUrl = `https://api.upstox.com/v3/historical-candle/${instrumentKey}/${mapping.unit}/${mapping.interval}/${toDate}/${fromDate}`;
       
        urls.push(historicalUrl);  


        console.log("buildHistoricalUrlFromDates",JSON.stringify(urls));

        return urls;
    }

    /**
     * Fetch data from a single endpoint with retry logic
     */
    async fetchSingleEndpoint(endpoint, instrumentKey) {
        let lastError;
        
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                console.log(`📡 [FETCH] ${endpoint.frame} ${endpoint.kind} (attempt ${attempt}/${this.maxRetries})`);
                console.log(`🔗 [URL] ${endpoint.url}`);
                
                const response = await this.fetchCandleData(endpoint.url);
                const candles = response?.data?.candles || response?.candles || [];
                
                // Log detailed bar information
                const required = dateCalculator.requiredBars[endpoint.frame] || 400;
                const received = candles.length;
                const percentage = required > 0 ? ((received / required) * 100).toFixed(1) : 0;
                
                console.log(`📊 [BARS] ${endpoint.frame}: received ${received}/${required} bars (${percentage}%)`);
                
                if (candles.length > 0) {
                    const firstCandle = candles[0];
                    const lastCandle = candles[candles.length - 1];
                    const firstTime = Array.isArray(firstCandle) ? firstCandle[0] : firstCandle.time || firstCandle.timestamp;
                    const lastTime = Array.isArray(lastCandle) ? lastCandle[0] : lastCandle.time || lastCandle.timestamp;
                    
                    console.log(`⏰ [TIME RANGE] ${endpoint.frame}: ${firstTime} → ${lastTime}`);
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
            console.log(`💾 [STORE] Merging ${candles.length} ${timeframe} candles with existing data`);

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
                console.log(`🔄 [MERGE] Found existing ${timeframe} data with ${existingData.bars_count} bars`);
                
                // Merge new candles with existing data
                const mergeResult = await this.mergeWithExistingData(existingData, formattedCandles, today, timeframe);
                
                if (mergeResult.success) {
                    console.log(`✅ [MERGE] Successfully merged ${mergeResult.newBars} new bars (${mergeResult.totalBars} total)`);
                } else {
                    console.warn(`⚠️ [MERGE] Merge failed: ${mergeResult.error}`);
                }
            } else {
                console.log(`🆕 [STORE] No existing data, creating new record`);
                
                // Store as new record using prefetch service
                await dailyDataPrefetchService.storeCandleData(stockInfo, timeframe, today, formattedCandles);
                console.log(`✅ [STORE] Successfully stored ${timeframe} data`);
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
            const existingTimestamps = new Set(existingCandles.map(c => new Date(c.timestamp).getTime()));
            const newCandlesOnly = newCandles.filter(candle => 
                !existingTimestamps.has(new Date(candle.timestamp).getTime())
            );

            if (newCandlesOnly.length === 0) {
                return { success: true, newBars: 0, totalBars: existingCandles.length };
            }

            // Merge and sort all candles chronologically
            const allCandles = [...existingCandles, ...newCandlesOnly]
                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

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
        
        candleResults.forEach(result => {
            if (result.success && result.candles?.length > 0) {
                const timeframe = result.frame;
                
                if (!resultsByTimeframe[timeframe]) {
                    resultsByTimeframe[timeframe] = { intraday: [], historical: [] };
                }
                
                // Group by kind (intraday vs historical)
                if (result.kind === 'intraday') {
                    resultsByTimeframe[timeframe].intraday.push(...result.candles);
                    console.log(`📊 [MERGE] ${timeframe} INTRADAY: ${result.candles.length} bars`);
                } else {
                    resultsByTimeframe[timeframe].historical.push(...result.candles);
                    console.log(`📊 [MERGE] ${timeframe} HISTORICAL: ${result.candles.length} bars`);
                }
            }
        });
        
        // Merge intraday + historical for each timeframe
        Object.keys(resultsByTimeframe).forEach(timeframe => {
            const { intraday, historical } = resultsByTimeframe[timeframe];
            
            // Combine all candles for this timeframe
            const allCandles = [...historical, ...intraday]; // Historical first, then intraday (chronological order)
            
            // Remove duplicates and sort
            candlesByTimeframe[timeframe] = this.deduplicateAndSort(allCandles);
            
            const requiredBars = dateCalculator.requiredBars[timeframe] || 400;
            const finalCount = candlesByTimeframe[timeframe].length;
            const percentage = ((finalCount / requiredBars) * 100).toFixed(1);
            
            console.log(`📊 [FINAL] ${timeframe}: ${finalCount}/${requiredBars} bars (${percentage}%) - Historical: ${historical.length}, Intraday: ${intraday.length}`);
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
        
        candles.forEach(candle => {
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
        return new Promise(resolve => setTimeout(resolve, ms));
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
    async fetchCandlesFromAPI(instrumentKey, interval, fromDate, toDate,skipIntraday = false) {
       
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

            const urls = await this.buildHistoricalUrlFromDates(instrumentKey, timeframe, fromDate, toDate,skipIntraday);
            let allCandles = [];

            // Fetch data from each URL
            for (let i = 0; i < urls.length; i++) {
                const url = urls[i];
                const urlType = url.includes('/intraday/') ? 'INTRADAY' : 'HISTORICAL';

              
                const startTime = Date.now();
                const response = await this.fetchCandleData(url);
                const duration = Date.now() - startTime;

             
                if (!response) {
                    console.log(`⚠️  [API FETCH ${i + 1}/${urls.length}] Response is null or undefined`);
                    continue;
                }

                if (!response.data) {
                     continue;
                }

                if (!response.data.candles) {
                     continue;
                }

                const candles = response.data.candles;
                if (candles.length === 0) {
                    console.log(`⚠️  [API FETCH ${i + 1}/${urls.length}] API returned 0 candles`);
                    console.log(`   └─ Possible reasons: Market closed, no trading data, weekend/holiday`);
                    continue;
                }

                // Show sample of raw data
                if (candles.length > 1) {
                    console.log(`📋 [SAMPLE] Last candle: [${candles[candles.length - 1].join(', ')}]`);
                }

                // Add to collection
                allCandles.push(...candles);
            }
            if (allCandles.length === 0) {
                console.log(`\n❌ [API FETCH] No candles collected from any URL`);
                console.log(`${'▲'.repeat(80)}\n`);
                return [];
            }

            // Remove duplicates and sort by timestamp
            console.log(`\n🔄 [MERGE] Removing duplicates from ${allCandles.length} candles...`);
            const uniqueCandles = new Map();
            allCandles.forEach(candle => {
                const timestamp = candle[0]; // First element is timestamp
                uniqueCandles.set(timestamp, candle);
            });

            const dedupedCandles = Array.from(uniqueCandles.values());
            console.log(`✅ [MERGE] After deduplication: ${dedupedCandles.length} unique candles`);

            // Sort by timestamp
            const sortedCandles = dedupedCandles.sort((a, b) => {
                const timeA = a[0];
                const timeB = b[0];
                return new Date(timeA) - new Date(timeB);
            });

            // Convert array format to object format
            console.log(`\n🔄 [FORMAT] Converting ${sortedCandles.length} candles to object format...`);
            const formattedCandles = formatCandles(sortedCandles);

            console.log(`✅ [API FETCH] Complete`);
            console.log(`   ├─ Total URLs fetched: ${urls.length}`);
            console.log(`   ├─ Raw candles collected: ${allCandles.length}`);
            console.log(`   ├─ After deduplication: ${formattedCandles.length}`);
            console.log(`   ├─ First timestamp: ${formattedCandles[0].timestamp}`);
            console.log(`   └─ Last timestamp: ${formattedCandles[formattedCandles.length - 1].timestamp}`);
            console.log(`${'▲'.repeat(80)}\n`);

            return formattedCandles;

        } catch (error) {
            console.log(`\n❌ [API FETCH] Exception caught!`);
            console.error(`   ├─ Error type: ${error.name}`);
            console.error(`   ├─ Error message: ${error.message}`);
            if (error.response) {
                console.error(`   ├─ HTTP status: ${error.response.status}`);
                console.error(`   └─ Response data: ${JSON.stringify(error.response.data).substring(0, 200)}`);
            }
            if (error.stack) {
                console.error(`   └─ Stack trace (first line): ${error.stack.split('\n')[0]}`);
            }
            console.log(`${'▲'.repeat(80)}\n`);
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
        console.log(`🔍 [TRIGGER ADAPTER] Getting market data for ${instrumentKey}`);

        try {
            // Extract unique timeframes from triggers (only DB-available timeframes: 15m, 1h, 1d)
            // Note: Current price (1m) is fetched separately via API below
            const timeframesNeeded = new Set();
            triggers.forEach(trigger => {
                if (trigger.timeframe) {
                    let normalized = trigger.timeframe.toLowerCase();
                    if (normalized === '1d' || normalized === 'day' || normalized === '1day') {
                        normalized = '1d';
                    }
                    // Only add timeframes that exist in our storage pipeline (15m, 1h, 1d)
                    if (['15m', '1h', '1d'].includes(normalized)) {
                        timeframesNeeded.add(normalized);
                    } else {
                        console.log(`⚠️  [TRIGGER ADAPTER] Skipping unsupported timeframe: ${normalized} (only 15m/1h/1d available in DB)`);
                    }
                }
            });

            console.log(`📊 Required timeframes from DB: ${Array.from(timeframesNeeded).join(', ')}`);

            // Get candle data using existing service (DB-first strategy)
            const result = await this.getCandleDataForAnalysis(instrumentKey, 'swing');

            if (!result.success) {
                throw new Error('Failed to fetch candle data');
            }

            console.log(`✅ [TRIGGER ADAPTER] Data source: ${result.source}`);
            console.log(`✅ [TRIGGER ADAPTER] Timeframes available: ${Object.keys(result.data).join(', ')}`);

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
                    console.log(`⚠️  [TRIGGER ADAPTER] No data for ${timeframe}`);
                    continue;
                }

                // CRITICAL: Check trading_date from DB to determine data freshness
                // Strategy: DB = historical (previous days), API = today only
                console.log(`\n🔍 [FRESHNESS CHECK] ${timeframe}: Checking data freshness...`);

                // Query PreFetchedData directly to check trading_date
                const dbRecord = await PreFetchedData.findOne({
                    instrument_key: instrumentKey,
                    timeframe: timeframe
                }).lean();

                if (dbRecord) {
                    const tradingDate = new Date(dbRecord.trading_date);
                    const now = new Date();


                    const lastBarTime = dbRecord.data_quality?.last_bar_time
                        ? new Date(dbRecord.data_quality.last_bar_time)
                        : new Date(candles[candles.length - 1].timestamp || candles[candles.length - 1][0]);

                    console.log(`   ├─ Trading date: ${tradingDate.toISOString()}`);
                    console.log(`   ├─ Last bar time: ${lastBarTime.toISOString()}`);
                    console.log(`   ├─ Bars in DB: ${dbRecord.bars_count}`);
                    console.log(`   └─ Updated at: ${new Date(dbRecord.updated_at).toISOString()}`);

                    // Determine staleness based on last bar time, not trading date
                    // Add buffer time based on timeframe to avoid unnecessary API calls during non-trading hours
                    const bufferMinutes = timeframe === '15m' ? 15 : timeframe === '1h' ? 60 : 1440;
                    const bufferMs = bufferMinutes * 60 * 1000;
                    const timeSinceLastBar = now - lastBarTime;

                    // Check if data is stale (last bar is older than buffer time)
                    if (timeSinceLastBar > bufferMs) {
                        console.log(`   ⚠️  Data is stale. Last bar: ${lastBarTime.toISOString()} (${Math.floor(timeSinceLastBar / (60 * 1000))} minutes ago)`);
                        console.log(`   🔄 Fetching missing candles from API...`);

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

                        console.log(`   ├─ Time gap: ${timeDiffHours.toFixed(1)} hours`);
                        console.log(`   └─ Estimated bars to fetch: ${barsToFetch}`);

                        if (barsToFetch > 0) {
                            try {
                                // Use intraday API for 15m and 1h timeframes
                                if (timeframe === '15m' || timeframe === '1h') {
                                    const intradayUrl = this.buildIntradayUrl(instrumentKey, timeframe);
                                    console.log(`📡 [INTRADAY FETCH] Fetching ${timeframe}: ${intradayUrl}`);

                                    const response = await this.fetchCandleData(intradayUrl);
                                    const todayCandles = response?.data?.candles || response?.candles || [];

                                    if (todayCandles && todayCandles.length > 0) {
                                        console.log(`   ✅ Fetched ${todayCandles.length} ${timeframe} candles from intraday API`);

                                        // Convert to standard format
                                        const formattedCandles = formatCandles(todayCandles);

                                        // Merge: Keep all DB candles + append only NEW candles
                                        const existingTimestamps = new Set(
                                            candles.map(c => (c.timestamp || c[0]).toString())
                                        );

                                        const newCandles = formattedCandles.filter(candle =>
                                            !existingTimestamps.has(candle.timestamp.toString())
                                        );

                                        console.log(`   ├─ New unique candles: ${newCandles.length}`);

                                        if (newCandles.length > 0) {
                                            // Append and sort chronologically
                                            candles = [...candles, ...newCandles]
                                                .sort((a, b) => new Date(a.timestamp || a[0]) - new Date(b.timestamp || b[0]));

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

                                            console.log(`   ✅ DB updated: ${candles.length} total bars, last bar: ${newLastBarTime.toISOString()}`);
                                        }
                                    } else {
                                        console.log(`   ⚠️  No candles from intraday API (market may be closed)`);
                                    }
                                }
                            } catch (apiError) {
                                console.error(`   ❌ Failed to fetch from API: ${apiError.message}`);
                                console.log(`   ℹ️  Continuing with existing DB data`);
                            }
                        } else {
                            console.log(`   ✅ DB data is fresh enough (within same day)`);
                        }
                    } else {
                        console.log(`   ✅ DB data is from today, no incremental fetch needed`);
                    }
                } else {
                    console.log(`   ⚠️  No DB record found for ${timeframe}, using data as-is`);
                }


                // Get latest candle (after potential merge)
                const latestCandle = candles[candles.length - 1];
                console.log(`✅ [TRIGGER ADAPTER] ${timeframe}: Using ${candles.length} candles`)

                // Calculate indicators if we have enough data
                let indicators = {};
                if (candles.length >= 50) {
                    indicators = calculateTechnicalIndicators(candles);
                    console.log(`📊 [TRIGGER ADAPTER] ${timeframe}: ${Object.keys(indicators).length} indicators calculated`);
                } else {
                    console.log(`⚠️  [TRIGGER ADAPTER] ${timeframe}: Only ${candles.length} candles (need 50+ for indicators)`);
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
            console.log(`\n💰 [CURRENT PRICE] Fetching latest 1-minute candle for real-time price...`);
            try {
                const oneMinUrl = this.buildIntradayUrl(instrumentKey, '1m');
                console.log(`📡 [CURRENT PRICE] Fetching: ${oneMinUrl}`);

                const response = await this.fetchCandleData(oneMinUrl);
                const oneMinCandles = response?.data?.candles || response?.candles || [];

                if (oneMinCandles && oneMinCandles.length > 0) {
                    const latestCandle = oneMinCandles[0];
                    const latestPrice = Array.isArray(latestCandle) ? latestCandle[4] : latestCandle.close;
                    const latestTimestamp = Array.isArray(latestCandle) ? latestCandle[0] : latestCandle.timestamp;

                    marketData.current_price = latestPrice;
                    console.log(`✅ [CURRENT PRICE] Latest price: ₹${latestPrice} (timestamp: ${latestTimestamp})`);
                } else {
                    console.log(`⚠️  [CURRENT PRICE] No 1m candles received, using fallback`);

                    // Fallback: Use latest candle from available timeframes
                    if (Object.keys(marketData.timeframes).length > 0) {
                        const firstTimeframe = Object.values(marketData.timeframes)[0];
                        marketData.current_price = firstTimeframe.close;
                        console.log(`📊 [CURRENT PRICE] Fallback price from ${Object.keys(marketData.timeframes)[0]}: ₹${marketData.current_price}`);
                    }
                }
            } catch (priceError) {
                console.error(`❌ [CURRENT PRICE] Failed to fetch 1m candle: ${priceError.message}`);

                // Fallback for current price
                if (!marketData.current_price && Object.keys(marketData.timeframes).length > 0) {
                    const firstTimeframe = Object.values(marketData.timeframes)[0];
                    marketData.current_price = firstTimeframe.close;
                    console.log(`📊 [CURRENT PRICE] Fallback price: ₹${marketData.current_price}`);
                }
            }

            console.log(`\n✅ [TRIGGER ADAPTER] Market data ready: ${Object.keys(marketData.timeframes).length} timeframes, Current Price: ₹${marketData.current_price}\n`);

            console.log(`🔽 [TRIGGER ADAPTER] Market Data Output:`,JSON.stringify(marketData));
            return marketData;


        } catch (error) {
            console.error(`❌ [TRIGGER ADAPTER] Failed: ${error.message}`);
            throw error;
        }
    }

}

const candleFetcherService = new CandleFetcherService();
export default candleFetcherService;