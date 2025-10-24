import axios from 'axios';
import { aiReviewService } from './ai/aiReview.service.js';
import dailyDataPrefetchService from './dailyDataPrefetch.service.js';
import dateCalculator from '../utils/dateCalculator.js';
import PreFetchedData from '../models/preFetchedData.js';

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
                const params = await dateCalculator.getTimeframeParams(timeframe);
                
                if (params.useIntraday && (timeframe === '15m' || timeframe === '1h' || timeframe === '1d')) {
                    // HYBRID APPROACH: Get both intraday (today) + historical (past days)
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
                    if (historicalParams.chunks && historicalParams.chunks.length > 0) {
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
                        // Fallback: single historical call
                        const historicalUrl = this.buildHistoricalUrl(tradeData.instrument_key, timeframe, historicalParams);
                        console.log(`📊 [HISTORICAL] ${timeframe}: ${historicalUrl}`);
                        
                        endpoints.push({
                            frame: timeframe,
                            kind: 'historical',
                            url: historicalUrl,
                            params: historicalParams
                        });
                    }
                    
                } else {
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
     * Utility delay function
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

const candleFetcherService = new CandleFetcherService();
export default candleFetcherService;