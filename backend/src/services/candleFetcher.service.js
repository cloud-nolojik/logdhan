import axios from 'axios';
import { aiReviewService } from './ai/aiReview.service.js';
import dailyDataPrefetchService from './dailyDataPrefetch.service.js';
import dateCalculator from '../utils/dateCalculator.js';
import PreFetchedData from '../models/preFetchedData.js';
import MarketHoursUtil from '../utils/marketHours.js';
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
     */
    async getCandleDataForAnalysis(instrumentKey, term) {
        console.log(`📊 [CANDLE FETCHER] Getting data for ${instrumentKey} (${term})`);
        
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
                // CRITICAL: Check data freshness first (trading_date must be recent)
                const freshnessCheck = this.checkDataFreshness(preFetchedResult.data);

                if (!freshnessCheck.fresh) {
                    console.log(`⚠️ [CANDLE FETCHER] Stale data detected: ${freshnessCheck.reason}`);
                    console.log(`🔄 [INCREMENTAL FETCH] Fetching missing data and merging with DB...`);

                    // Perform incremental fetch for stale timeframes
                    const incrementalResult = await this.fetchIncrementalDataAndMerge(
                        instrumentKey,
                        preFetchedResult.data,
                        freshnessCheck.staleTimeframes
                    );

                    if (incrementalResult.success) {
                        console.log(`✅ [INCREMENTAL FETCH] Successfully updated stale data`);
                        return {
                            success: true,
                            source: 'database+api (incremental)',
                            data: incrementalResult.data
                        };
                    } else {
                        console.log(`⚠️ [INCREMENTAL FETCH] Failed, falling back to full API fetch`);
                        // Fall through to full API fetch
                    }
                } else {
                    // Data is fresh, now check sufficiency
                    const sufficientData = this.checkDataSufficiency(preFetchedResult.data);

                    if (sufficientData.sufficient) {
                        console.log(`✅ [CANDLE FETCHER] Using pre-fetched data: ${preFetchedResult.data.length} timeframes`);

                        return {
                            success: true,
                            source: 'database',
                            data: this.formatDatabaseData(preFetchedResult.data)
                        };
                    } else {
                        console.log(`⚠️ [CANDLE FETCHER] Insufficient data: ${sufficientData.reason}. Fetching from API.`);
                    }
                }
            }

            // Step 2: Fallback to API fetching
            console.log(`🔄 [CANDLE FETCHER] Fetching fresh data from API`);
            const apiResult = await this.fetchFromAPI(instrumentKey, term);
            
            return {
                success: true,
                source: 'api',
                data: apiResult
            };
            
        } catch (error) {
            console.error(`❌ [CANDLE FETCHER] Failed to get data: ${error.message}`);
            throw error;
        }
    }

    /**
     * Check if pre-fetched data is fresh (trading_date is recent)
     * @param {Array} preFetchedData - Array of pre-fetched data records
     * @returns {Object} - { fresh: boolean, reason: string, staleTimeframes: [] }
     */
    checkDataFreshness(preFetchedData) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`🔍 [FRESHNESS CHECK] Starting data freshness validation`);
        console.log(`${'='.repeat(80)}`);

        const today = new Date();
        today.setHours(0, 0, 0, 0); // Start of today
        console.log(`📅 [FRESHNESS CHECK] Today's date (normalized): ${today.toISOString().split('T')[0]}`);
        console.log(`📊 [FRESHNESS CHECK] Total timeframes to check: ${preFetchedData.length}\n`);

        const staleTimeframes = [];

        for (const timeframeData of preFetchedData) {
            console.log(`🔹 [FRESHNESS CHECK] Checking timeframe: ${timeframeData.timeframe}`);

            const tradingDate = new Date(timeframeData.trading_date);
            tradingDate.setHours(0, 0, 0, 0); // Normalize to start of day for comparison
            const daysDiff = Math.floor((today - tradingDate) / (1000 * 60 * 60 * 24));

            // CRITICAL FIX: For intraday timeframes, data MUST be from TODAY (not yesterday)
            // For daily timeframe, allow 3-day gap (weekend buffer)
            const isToday = tradingDate.getTime() === today.getTime();
            let isStale = false;

            console.log(`   ├─ Trading date: ${tradingDate.toISOString().split('T')[0]}`);
            console.log(`   ├─ Age: ${daysDiff} days`);
            console.log(`   ├─ Is today: ${isToday}`);
            console.log(`   ├─ Bars in DB: ${timeframeData.bars_count || timeframeData.candle_data?.length || 0}`);

            if (timeframeData.timeframe === '1d') {
                // Daily timeframe: Allow 3-day gap (accounts for weekends)
                if (daysDiff > 3) {
                    isStale = true;
                    console.log(`   └─ Status: ❌ STALE (${daysDiff} days > 3 days for daily)\n`);
                } else {
                    console.log(`   └─ Status: ✅ FRESH (${daysDiff} days <= 3 days for daily)\n`);
                }
            } else {
                // Intraday timeframes (15m, 1h): MUST be from TODAY
                if (!isToday) {
                    isStale = true;
                    console.log(`   └─ Status: ❌ STALE (intraday data not from today - ${daysDiff} days old)\n`);
                } else {
                    console.log(`   └─ Status: ✅ FRESH (intraday data from today)\n`);
                }
            }

            if (isStale) {
                staleTimeframes.push({
                    timeframe: timeframeData.timeframe,
                    trading_date: tradingDate,
                    age_days: daysDiff
                });
            }
        }

        if (staleTimeframes.length > 0) {
            console.log(`${'='.repeat(80)}`);
            console.log(`⚠️  [FRESHNESS CHECK RESULT] ${staleTimeframes.length}/${preFetchedData.length} timeframe(s) are STALE`);
            console.log(`${'='.repeat(80)}`);
            staleTimeframes.forEach((st, idx) => {
                console.log(`   ${idx + 1}. ${st.timeframe}: ${st.age_days} days old (trading_date: ${st.trading_date.toISOString().split('T')[0]})`);
            });
            console.log(`\n🔄 [DECISION] Will trigger incremental data fetch for stale timeframes\n`);

            return {
                fresh: false,
                reason: `${staleTimeframes.length} timeframe(s) have stale data (older than max age)`,
                staleTimeframes: staleTimeframes
            };
        }

        console.log(`${'='.repeat(80)}`);
        console.log(`✅ [FRESHNESS CHECK RESULT] All ${preFetchedData.length} timeframes have FRESH data`);
        console.log(`${'='.repeat(80)}`);
        console.log(`🎯 [DECISION] No incremental fetch needed, using DB data as-is\n`);
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
    async fetchFromAPI(instrumentKey, term) {
        try {
            // Build endpoints using existing smart API selection
            const tradeData = { instrument_key: instrumentKey, term: term };
            const endpoints = await this.buildEndpoints(tradeData);
            
            console.log(`🔄 [API FETCH] Processing ${endpoints.length} endpoints`);
            
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
            
            for (const timeframe of timeframes) {
                console.log(`🔍 [ENDPOINT DEBUG] ================================`);
                console.log(`🔍 [ENDPOINT DEBUG] Processing timeframe: ${timeframe}`);
                
                const params = await dateCalculator.getTimeframeParams(timeframe);
                console.log(`🔍 [ENDPOINT DEBUG] ${timeframe} - params.useIntraday:`, params.useIntraday);
                console.log(`🔍 [ENDPOINT DEBUG] ${timeframe} - params.barsNeeded:`, params.barsNeeded);
                
                if (params.useIntraday && (timeframe === '15m' || timeframe === '1h' || timeframe === '1d')) {
                    console.log(`✅ [ENDPOINT DEBUG] ${timeframe} - Using HYBRID APPROACH (intraday + historical)`);
                    // HYBRID APPROACH: Get both intraday (today) + historical (past days)
                    
                    // 1. Intraday endpoint for today's data
                    const intradayUrl = this.buildIntradayUrl(tradeData.instrument_key, timeframe);
                    console.log(`📊 [INTRADAY] ${timeframe}: ${intradayUrl}`);
                    
                    endpoints.push({
                        frame: timeframe,
                        kind: 'intraday',
                        url: intradayUrl,
                        params: params
                    });
                    
                    // 2. Historical endpoints for remaining bars (may be multiple chunks)
                    // Use yesterday as the ending point for historical data (excluding today)
                    // Create yesterday date using local date arithmetic (avoid timezone issues)
                    const today = new Date();
                    const todayDateStr = today.getFullYear() + '-' + 
                                       String(today.getMonth() + 1).padStart(2, '0') + '-' + 
                                       String(today.getDate()).padStart(2, '0');
                    
                    const yesterdayDate = new Date(today);
                    yesterdayDate.setDate(today.getDate() - 1);
                    const yesterdayDateStr = yesterdayDate.getFullYear() + '-' + 
                                           String(yesterdayDate.getMonth() + 1).padStart(2, '0') + '-' + 
                                           String(yesterdayDate.getDate()).padStart(2, '0');
                    
                    // Create clean date objects for yesterday (avoid timezone conversion)
                    const yesterday = new Date(yesterdayDateStr + 'T12:00:00'); // Use noon to avoid timezone edge cases
                    
                    console.log(`📅 [HYBRID] Today: ${todayDateStr}, Yesterday: ${yesterdayDateStr}`);
                    console.log(`📅 [HYBRID DEBUG] Yesterday object: ${yesterday.toISOString()}, formatDateISO: ${dateCalculator.formatDateISO(yesterday)}`);
                    
                    const historicalParams = await dateCalculator.getHistoricalDateRange(timeframe, yesterday, params.barsNeeded);
                    console.log(`📅 [HISTORICAL PARAMS] toDate: ${dateCalculator.formatDateISO(historicalParams.toDate)}, fromDate: ${dateCalculator.formatDateISO(historicalParams.fromDate)}`);
                    
                    // Create endpoints for each chunk
                    console.log(`🔍 [ENDPOINT DEBUG] ${timeframe} - historicalParams.chunks:`, historicalParams.chunks ? `${historicalParams.chunks.length} chunks` : 'null/undefined');
                    
                    if (historicalParams.chunks && historicalParams.chunks.length > 0) {
                        console.log(`✅ [ENDPOINT DEBUG] ${timeframe} - Using chunked approach with ${historicalParams.chunks.length} chunks`);
                        
                        historicalParams.chunks.forEach((chunk, index) => {
                            const chunkUrl = this.buildHistoricalUrlFromDates(
                                tradeData.instrument_key, 
                                timeframe, 
                                chunk.fromDate, 
                                chunk.toDate
                            );
                            console.log(`📊 [HISTORICAL CHUNK ${index + 1}/${historicalParams.chunks.length}] ${timeframe}: ${chunkUrl}`);
                            
                            endpoints.push({
                                frame: timeframe,
                                kind: 'historical',
                                url: chunkUrl,
                                params: { ...historicalParams, chunk: chunk, chunkIndex: index }
                            });
                        });
                    } else {
                        console.log(`⚠️ [ENDPOINT DEBUG] ${timeframe} - No chunks found, using fallback single call`);
                        
                        // Fallback: single historical call
                        console.log(`🔍 [ENDPOINT DEBUG] ${timeframe} - Building fallback URL with params:`, {
                            fromDate: dateCalculator.formatDateISO(historicalParams.fromDate),
                            toDate: dateCalculator.formatDateISO(historicalParams.toDate),
                            tradingDaysFound: historicalParams.tradingDaysFound,
                            calendarDaysNeeded: historicalParams.calendarDaysNeeded
                        });
                        
                        const historicalUrl = this.buildHistoricalUrl(tradeData.instrument_key, timeframe, historicalParams);
                        console.log(`📊 [HISTORICAL FALLBACK] ${timeframe}: ${historicalUrl}`);
                        
                        endpoints.push({
                            frame: timeframe,
                            kind: 'historical',
                            url: historicalUrl,
                            params: historicalParams
                        });
                    }
                    
                } else {
                    console.log(`⚠️ [ENDPOINT DEBUG] ${timeframe} - Using HISTORICAL ONLY approach`);
                    console.log(`🔍 [ENDPOINT DEBUG] ${timeframe} - Reason: useIntraday=${params.useIntraday}, timeframe in list=${timeframe === '15m' || timeframe === '1h' || timeframe === '1d'}`);
                    
                    // Use only historical API for daily timeframe or when market is closed
                    const historicalUrl = this.buildHistoricalUrl(tradeData.instrument_key, timeframe, params);
                    console.log(`📊 [HISTORICAL] ${timeframe}: ${historicalUrl}`);
                    
                    endpoints.push({
                        frame: timeframe,
                        kind: 'historical',
                        url: historicalUrl,
                        params: params
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
        const timeframeMapping = {
            '1m': { unit: 'minutes', interval: '1' },
            '15m': { unit: 'minutes', interval: '15' },
            '1h': { unit: 'hours', interval: '1' },
            '1d': { unit: 'days', interval: '1' }
        };
        
        const mapping = timeframeMapping[timeframe];
        if (!mapping) {
            throw new Error(`Unsupported timeframe for intraday API: ${timeframe}`);
        }
        
        return `https://api.upstox.com/v3/historical-candle/intraday/${instrumentKey}/${mapping.unit}/${mapping.interval}`;
    }

    /**
     * Build historical URL with proper date range
     */
    buildHistoricalUrl(instrumentKey, timeframe, params) {
        const timeframeMapping = {
            '15m': { unit: 'minutes', interval: '15' },
            '1h': { unit: 'hours', interval: '1' },
            '1d': { unit: 'days', interval: '1' }
        };
        
        const mapping = timeframeMapping[timeframe];
        if (!mapping) {
            throw new Error(`Unsupported timeframe for historical API: ${timeframe}`);
        }
        
        const fromDate = dateCalculator.formatDateISO(params.fromDate);
        const toDate = dateCalculator.formatDateISO(params.toDate);
        
        return `https://api.upstox.com/v3/historical-candle/${instrumentKey}/${mapping.unit}/${mapping.interval}/${toDate}/${fromDate}`;
    }

    /**
     * Build historical URL from specific from/to dates (for chunks)
     */
    buildHistoricalUrlFromDates(instrumentKey, timeframe, fromDate, toDate) {
        const timeframeMapping = {
            '15m': { unit: 'minutes', interval: '15' },
            '1h': { unit: 'hours', interval: '1' },
            '1d': { unit: 'days', interval: '1' }
        };
        
        const mapping = timeframeMapping[timeframe];
        if (!mapping) {
            throw new Error(`Unsupported timeframe for historical API: ${timeframe}`);
        }
        
        const fromDateStr = dateCalculator.formatDateISO(fromDate);
        const toDateStr = dateCalculator.formatDateISO(toDate);
        
        return `https://api.upstox.com/v3/historical-candle/${instrumentKey}/${mapping.unit}/${mapping.interval}/${toDateStr}/${fromDateStr}`;
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
            const formattedCandles = candles.map(candle => ({
                timestamp: Array.isArray(candle) ? candle[0] : candle.time || candle.timestamp,
                open: Array.isArray(candle) ? candle[1] : candle.open,
                high: Array.isArray(candle) ? candle[2] : candle.high,
                low: Array.isArray(candle) ? candle[3] : candle.low,
                close: Array.isArray(candle) ? candle[4] : candle.close,
                volume: Array.isArray(candle) ? candle[5] : candle.volume
            }));

            // Use dailyDataPrefetchService to handle the merge properly
            const stockInfo = {
                instrument_key: instrumentKey,
                stock_symbol: instrumentKey.split('|')[2] || instrumentKey,
                stock_name: instrumentKey.split('|')[2] || instrumentKey
            };
            
            const today = new Date();
            today.setHours(0, 0, 0, 0);

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
     * Fetch incremental data for stale timeframes and merge with DB
     * @param {string} instrumentKey - The instrument key
     * @param {Array} dbData - Existing database records
     * @param {Array} staleTimeframes - List of stale timeframes to update
     * @returns {Object} - { success: boolean, data: formattedData }
     */
    async fetchIncrementalDataAndMerge(instrumentKey, dbData, staleTimeframes) {
        console.log(`\n${'█'.repeat(80)}`);
        console.log(`📡 [INCREMENTAL MERGE] Starting incremental data fetch and merge`);
        console.log(`${'█'.repeat(80)}`);
        console.log(`📋 [INCREMENTAL MERGE] Job details:`);
        console.log(`   ├─ Instrument: ${instrumentKey}`);
        console.log(`   ├─ Total timeframes: ${dbData.length}`);
        console.log(`   ├─ Stale timeframes: ${staleTimeframes.length}`);
        console.log(`   └─ Fresh timeframes: ${dbData.length - staleTimeframes.length}\n`);

        try {
            const updatedData = {};
            let successCount = 0;
            let errorCount = 0;

            // Process each timeframe
            for (let i = 0; i < dbData.length; i++) {
                const dbRecord = dbData[i];
                const timeframe = dbRecord.timeframe;
                const isStale = staleTimeframes.some(st => st.timeframe === timeframe);

                console.log(`${'─'.repeat(80)}`);
                console.log(`📊 [TIMEFRAME ${i + 1}/${dbData.length}] Processing: ${timeframe}`);
                console.log(`${'─'.repeat(80)}`);

                if (isStale) {
                    console.log(`⚠️  [${timeframe}] Status: STALE - Needs incremental fetch`);
                    console.log(`🔄 [${timeframe}] Starting API fetch for missing data...\n`);

                    // Get last bar time from DB
                    console.log(`📍 [${timeframe}] Step 1: Determining last bar time from DB...`);
                    const lastBarTime = dbRecord.data_quality?.last_bar_time
                        ? new Date(dbRecord.data_quality.last_bar_time)
                        : new Date(dbRecord.candle_data[dbRecord.candle_data.length - 1].timestamp);

                    const now = new Date();
                    const fromDate = lastBarTime.toISOString().split('T')[0];
                    const toDate = now.toISOString().split('T')[0];
                    const timeDiffDays = Math.floor((now - lastBarTime) / (1000 * 60 * 60 * 24));

                    console.log(`   ├─ Last bar time: ${lastBarTime.toISOString()}`);
                    console.log(`   ├─ Current time: ${now.toISOString()}`);
                    console.log(`   ├─ Time gap: ${timeDiffDays} days`);
                    console.log(`   ├─ Fetch range: ${fromDate} → ${toDate}`);
                    console.log(`   └─ Existing bars in DB: ${dbRecord.candle_data?.length || 0}\n`);

                    // Map timeframe to Upstox interval
                    const intervalMap = { '15m': '15minute', '1h': '60minute', '1d': 'day' };
                    const upstoxInterval = intervalMap[timeframe] || timeframe;
                    console.log(`📡 [${timeframe}] Step 2: Fetching from Upstox API (interval: ${upstoxInterval})...`);

                    try {
                        // Fetch missing candles
                        const apiCandles = await this.fetchCandlesFromAPI(
                            instrumentKey,
                            upstoxInterval,
                            fromDate,
                            toDate
                        );

                        console.log(`\n📥 [${timeframe}] Step 3: API fetch completed`);
                        if (apiCandles && apiCandles.length > 0) {
                            console.log(`   ✅ Received ${apiCandles.length} candles from API`);
                            console.log(`   ├─ First candle: ${apiCandles[0].timestamp}`);
                            console.log(`   └─ Last candle: ${apiCandles[apiCandles.length - 1].timestamp}\n`);

                            console.log(`🔀 [${timeframe}] Step 4: Merging API data with existing DB data...`);
                            // Merge: Keep all DB candles + append only NEW candles
                            const existingCandles = dbRecord.candle_data || [];
                            const existingTimestamps = new Set(
                                existingCandles.map(c => c.timestamp.toString())
                            );

                            console.log(`   ├─ Building timestamp index from ${existingCandles.length} existing candles...`);
                            const newCandles = apiCandles.filter(apiCandle => {
                                const apiTimestamp = apiCandle.timestamp.toString();
                                return !existingTimestamps.has(apiTimestamp);
                            });

                            console.log(`   ├─ Existing candles in DB: ${existingCandles.length}`);
                            console.log(`   ├─ API candles: ${apiCandles.length}`);
                            console.log(`   ├─ Duplicate candles: ${apiCandles.length - newCandles.length}`);
                            console.log(`   └─ New unique candles: ${newCandles.length}\n`);

                            if (newCandles.length > 0) {
                                console.log(`✨ [${timeframe}] Step 5: Appending ${newCandles.length} new candles...`);
                                // Append and sort
                                const mergedCandles = [...existingCandles, ...newCandles]
                                    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

                                // Keep only required number of bars (trim oldest if necessary)
                                const maxBars = dateCalculator.requiredBars[timeframe] || 400;
                                const finalCandles = mergedCandles.slice(-maxBars);
                                const trimmedCount = mergedCandles.length - finalCandles.length;

                                console.log(`   ├─ After merge: ${mergedCandles.length} total candles`);
                                console.log(`   ├─ Max bars allowed: ${maxBars}`);
                                console.log(`   ├─ Trimmed oldest: ${trimmedCount} candles`);
                                console.log(`   └─ Final dataset: ${finalCandles.length} candles\n`);

                                // Update DB
                                console.log(`💾 [${timeframe}] Step 6: Updating MongoDB...`);
                                const newLastBarTime = new Date(finalCandles[finalCandles.length - 1].timestamp);
                                const updateResult = await PreFetchedData.updateOne(
                                    { instrument_key: instrumentKey, timeframe: timeframe },
                                    {
                                        $set: {
                                            candle_data: finalCandles,
                                            bars_count: finalCandles.length,
                                            trading_date: now,
                                            updated_at: now,
                                            'data_quality.last_bar_time': newLastBarTime
                                        }
                                    }
                                );

                                console.log(`   ├─ MongoDB update result: ${updateResult.modifiedCount} document(s) modified`);
                                console.log(`   ├─ New bars_count: ${finalCandles.length}`);
                                console.log(`   ├─ New trading_date: ${now.toISOString().split('T')[0]}`);
                                console.log(`   └─ New last_bar_time: ${newLastBarTime.toISOString()}\n`);

                                updatedData[timeframe] = finalCandles;
                                successCount++;
                                console.log(`✅ [${timeframe}] SUCCESS - Incremental update completed!\n`);
                            } else {
                                console.log(`ℹ️  [${timeframe}] Step 5: No new unique candles to add`);
                                console.log(`   └─ All ${apiCandles.length} API candles already exist in DB\n`);
                                // No new candles, use existing
                                updatedData[timeframe] = existingCandles;
                                successCount++;
                                console.log(`✅ [${timeframe}] SUCCESS - Using existing data (no updates needed)\n`);
                            }
                        } else {
                            console.log(`   ⚠️  API returned 0 candles (market closed or no data available)`);
                            console.log(`   └─ Reason: Likely market closed or no trading data for date range\n`);
                            // API returned no data, use existing
                            updatedData[timeframe] = dbRecord.candle_data || [];
                            successCount++;
                            console.log(`✅ [${timeframe}] SUCCESS - Using existing DB data\n`);
                        }
                    } catch (apiError) {
                        console.log(`\n❌ [${timeframe}] ERROR during API fetch or merge!`);
                        console.error(`   ├─ Error type: ${apiError.name}`);
                        console.error(`   ├─ Error message: ${apiError.message}`);
                        if (apiError.stack) {
                            console.error(`   └─ Stack trace: ${apiError.stack.split('\n')[0]}\n`);
                        }
                        // On error, use existing DB data
                        updatedData[timeframe] = dbRecord.candle_data || [];
                        errorCount++;
                        console.log(`⚠️  [${timeframe}] FALLBACK - Continuing with existing DB data (${updatedData[timeframe].length} bars)\n`);
                    }
                } else {
                    // Not stale, use as-is
                    console.log(`✅ [${timeframe}] Status: FRESH - No fetch needed`);
                    updatedData[timeframe] = dbRecord.candle_data || [];
                    successCount++;
                    console.log(`   └─ Using existing ${updatedData[timeframe].length} bars from DB\n`);
                }
            }

            console.log(`${'█'.repeat(80)}`);
            console.log(`📊 [INCREMENTAL MERGE] Job Summary`);
            console.log(`${'█'.repeat(80)}`);
            console.log(`✅ Success: ${successCount}/${dbData.length} timeframes`);
            console.log(`❌ Errors: ${errorCount}/${dbData.length} timeframes`);
            console.log(`📦 Total data ready: ${Object.keys(updatedData).length} timeframes`);
            Object.keys(updatedData).forEach(tf => {
                console.log(`   - ${tf}: ${updatedData[tf].length} bars`);
            });
            console.log(`${'█'.repeat(80)}\n`);

            return {
                success: true,
                data: updatedData
            };

        } catch (error) {
            console.error(`❌ [INCREMENTAL MERGE] Failed: ${error.message}`);
            return { success: false, error: error.message };
        }
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
    async fetchCandlesFromAPI(instrumentKey, interval, fromDate, toDate) {
        console.log(`\n${'▼'.repeat(80)}`);
        console.log(`📡 [API FETCH] Starting Upstox Historical API call`);
        console.log(`${'▼'.repeat(80)}`);

        try {
            console.log(`📋 [API FETCH] Request parameters:`);
            console.log(`   ├─ Instrument: ${instrumentKey}`);
            console.log(`   ├─ Interval: ${interval}`);
            console.log(`   ├─ From date: ${fromDate}`);
            console.log(`   └─ To date: ${toDate}`);

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

            console.log(`   └─ Mapped to timeframe: ${timeframe}`);

            // Convert date strings to Date objects if needed
            console.log(`\n🔧 [API FETCH] Preparing dates for URL builder...`);
            const fromDateObj = typeof fromDate === 'string' ? new Date(fromDate) : fromDate;
            const toDateObj = typeof toDate === 'string' ? new Date(toDate) : toDate;
            console.log(`   ├─ From Date Object: ${fromDateObj.toISOString()}`);
            console.log(`   └─ To Date Object: ${toDateObj.toISOString()}`);

            // Use existing method to build URL (avoids code duplication)
            console.log(`\n🔧 [API FETCH] Building URL using buildHistoricalUrlFromDates()...`);
            const url = this.buildHistoricalUrlFromDates(instrumentKey, timeframe, fromDateObj, toDateObj);
            console.log(`🔗 [API FETCH] URL: ${url}`);
            console.log(`⏳ [API FETCH] Sending HTTP request...\n`);

            const startTime = Date.now();
            const response = await this.fetchCandleData(url);
            const duration = Date.now() - startTime;

            console.log(`✅ [API FETCH] HTTP response received in ${duration}ms`);

            if (!response) {
                console.log(`❌ [API FETCH] Response is null or undefined`);
                console.log(`${'▲'.repeat(80)}\n`);
                return [];
            }

            if (!response.data) {
                console.log(`❌ [API FETCH] Response has no 'data' field`);
                console.log(`   └─ Response keys: ${Object.keys(response).join(', ')}`);
                console.log(`${'▲'.repeat(80)}\n`);
                return [];
            }

            if (!response.data.candles) {
                console.log(`❌ [API FETCH] Response.data has no 'candles' field`);
                console.log(`   └─ Response.data keys: ${Object.keys(response.data).join(', ')}`);
                console.log(`${'▲'.repeat(80)}\n`);
                return [];
            }

            const candles = response.data.candles;
            console.log(`\n📊 [API FETCH] Candles received: ${candles.length}`);

            if (candles.length === 0) {
                console.log(`⚠️  [API FETCH] API returned 0 candles`);
                console.log(`   └─ Possible reasons: Market closed, no trading data, weekend/holiday`);
                console.log(`${'▲'.repeat(80)}\n`);
                return [];
            }

            // Show sample of raw data
            console.log(`📋 [API FETCH] Sample raw candle (first): [${candles[0].join(', ')}]`);
            if (candles.length > 1) {
                console.log(`📋 [API FETCH] Sample raw candle (last): [${candles[candles.length - 1].join(', ')}]`);
            }

            // Convert array format to object format
            console.log(`\n🔄 [API FETCH] Converting ${candles.length} candles from array to object format...`);
            const formattedCandles = candles.map(c => ({
                timestamp: c[0],
                open: c[1],
                high: c[2],
                low: c[3],
                close: c[4],
                volume: c[5]
            }));

            console.log(`✅ [API FETCH] Conversion complete`);
            console.log(`   ├─ First timestamp: ${formattedCandles[0].timestamp}`);
            console.log(`   ├─ Last timestamp: ${formattedCandles[formattedCandles.length - 1].timestamp}`);
            console.log(`   └─ Total formatted: ${formattedCandles.length} candles`);
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
            // Extract unique timeframes from triggers
            const timeframesNeeded = new Set(['1m']); // Always get current price (1m)
            triggers.forEach(trigger => {
                if (trigger.timeframe) {
                    let normalized = trigger.timeframe.toLowerCase();
                    if (normalized === '1d' || normalized === 'day' || normalized === '1day') {
                        normalized = '1d';
                    }
                    timeframesNeeded.add(normalized);
                }
            });

            console.log(`📊 Required timeframes: ${Array.from(timeframesNeeded).join(', ')}`);

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
                    const today = new Date();
                    today.setHours(0, 0, 0, 0); // Start of today

                    const lastBarTime = dbRecord.data_quality?.last_bar_time
                        ? new Date(dbRecord.data_quality.last_bar_time)
                        : new Date(candles[candles.length - 1].timestamp || candles[candles.length - 1][0]);

                    console.log(`   ├─ Trading date: ${tradingDate.toISOString()}`);
                    console.log(`   ├─ Last bar time: ${lastBarTime.toISOString()}`);
                    console.log(`   ├─ Bars in DB: ${dbRecord.bars_count}`);
                    console.log(`   └─ Updated at: ${new Date(dbRecord.updated_at).toISOString()}`);

                    // Check if data is from previous day(s)
                    if (tradingDate < today) {
                        console.log(`   ⚠️  DB has data from ${tradingDate.toDateString()}, today is ${today.toDateString()}`);
                        console.log(`   🔄 Fetching missing candles from API...`);

                        // Calculate how many candles we need to fetch
                        const now = new Date();
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
                                        const formattedCandles = todayCandles.map(candle => ({
                                            timestamp: Array.isArray(candle) ? candle[0] : candle.time || candle.timestamp,
                                            open: Array.isArray(candle) ? candle[1] : candle.open,
                                            high: Array.isArray(candle) ? candle[2] : candle.high,
                                            low: Array.isArray(candle) ? candle[3] : candle.low,
                                            close: Array.isArray(candle) ? candle[4] : candle.close,
                                            volume: Array.isArray(candle) ? candle[5] : candle.volume
                                        }));

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

                                            await PreFetchedData.updateOne(
                                                { instrument_key: instrumentKey, timeframe: timeframe },
                                                {
                                                    $set: {
                                                        candle_data: candles,
                                                        bars_count: candles.length,
                                                        trading_date: today,
                                                        updated_at: new Date(),
                                                        'data_quality.last_bar_time': newLastBarTime
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