/**
 * Incremental Data Updater Service
 *
 * Handles incremental fetching and merging of candle data when existing DB data is stale.
 * This service is responsible for:
 * - Detecting stale timeframes
 * - Fetching missing data from API
 * - Merging new data with existing DB records
 * - Updating MongoDB with merged results
 */

import PreFetchedData from '../models/preFetchedData.js';
import dateCalculator from '../utils/dateCalculator.js';
import { formatCandles } from '../utils/candleFormatter.js';
import { TIMEFRAME_TO_UPSTOX_INTERVAL } from '../constants/timeframeMap.js';
import MarketHoursUtil from '../utils/marketHours.js';

class IncrementalUpdaterService {
    /**
     * Fetch incremental data for stale timeframes and merge with DB
     * @param {string} instrumentKey - The instrument key
     * @param {Array} dbData - Existing database records
     * @param {Array} staleTimeframes - List of stale timeframes to update
     * @param {Function} fetchCandlesFromAPI - Function to fetch candles from API
     * @returns {Object} - { success: boolean, data: formattedData }
     */
    async fetchIncrementalDataAndMerge(instrumentKey, dbData, staleTimeframes, fetchCandlesFromAPI,skipIntraday) {
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
            const now = new Date();

            // Process only stale timeframes
            for (let i = 0; i < staleTimeframes.length; i++) {
                const staleInfo = staleTimeframes[i];
                const timeframe = staleInfo.timeframe;

                // Find corresponding DB record
                const dbRecord = dbData.find(db => db.timeframe === timeframe);

                console.log(`${'─'.repeat(80)}`);
                console.log(`📊 [STALE ${i + 1}/${staleTimeframes.length}] Processing: ${timeframe}`);
                console.log(`${'─'.repeat(80)}`);

                // Get last bar time from staleInfo
                const lastBarTime = new Date(staleInfo.last_bar_time);

                // Calculate fromDate: For intraday timeframes (15m, 1h), use the same day as last bar
                // For daily timeframe, use next day
                // The API will return candles AFTER the last bar timestamp
                const fromDateObj = new Date(lastBarTime);
                if (timeframe === '1d') {
                    // For daily, move to next day
                    fromDateObj.setDate(fromDateObj.getDate() + 1);
                }
                // For intraday (15m, 1h), keep the same day so we don't miss candles from that day

                const fromDate = fromDateObj.toISOString().split('T')[0];
                const toDate = now.toISOString().split('T')[0];

                console.log(`📍 [${timeframe}] Date calculation:`);
                console.log(`   ├─ Last bar time: ${lastBarTime.toISOString()}`);
                console.log(`   ├─ From date: ${fromDate}`);
                console.log(`   ├─ To date (today): ${toDate}`);
                console.log(`   └─ Existing bars in DB: ${dbRecord?.candle_data?.length || 0}\n`);

                // Map timeframe to Upstox interval
                const upstoxInterval = TIMEFRAME_TO_UPSTOX_INTERVAL[timeframe] || timeframe;
                console.log(`📡 [${timeframe}] Fetching from Upstox API (interval: ${upstoxInterval})...`);

                try {
                    // Fetch missing candles
                    const apiCandles = await fetchCandlesFromAPI(
                        instrumentKey,
                        upstoxInterval,
                        fromDate,
                        toDate,
                        skipIntraday

                    );

                    console.log(`\n📥 [${timeframe}] API fetch completed`);
                    if (apiCandles && apiCandles.length > 0) {
                        console.log(`   ✅ Received ${apiCandles.length} candles from API`);
                        console.log(`   ├─ First candle: ${apiCandles[0].timestamp}`);
                        console.log(`   └─ Last candle: ${apiCandles[apiCandles.length - 1].timestamp}\n`);

                        console.log(`🔀 [${timeframe}] Merging API data with existing DB data...`);

                        // Normalize existing DB candles
                        const rawExistingCandles = dbRecord?.candle_data || [];
                        const existingCandles = formatCandles(rawExistingCandles);
                        console.log(`   ├─ Normalized ${existingCandles.length} existing candles from DB`);

                        // Build timestamp index for deduplication
                        const existingTimestamps = new Set(
                            existingCandles.map(c => c.timestamp.toString())
                        );

                        const newCandles = apiCandles.filter(apiCandle => {
                            const apiTimestamp = apiCandle.timestamp.toString();
                            return !existingTimestamps.has(apiTimestamp);
                        });

                        console.log(`   ├─ Existing candles in DB: ${existingCandles.length}`);
                        console.log(`   ├─ API candles: ${apiCandles.length}`);
                        console.log(`   ├─ Duplicate candles: ${apiCandles.length - newCandles.length}`);
                        console.log(`   └─ New unique candles: ${newCandles.length}\n`);

                        if (newCandles.length > 0) {
                            console.log(`✨ [${timeframe}] Appending ${newCandles.length} new candles...`);

                            // Append and sort
                            const mergedCandles = [...existingCandles, ...newCandles]
                                .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

                            // Keep only required number of bars
                            const maxBars = dateCalculator.requiredBars[timeframe] || 400;
                            const finalCandles = mergedCandles.slice(-maxBars);
                            const trimmedCount = mergedCandles.length - finalCandles.length;

                            console.log(`   ├─ After merge: ${mergedCandles.length} total candles`);
                            console.log(`   ├─ Max bars allowed: ${maxBars}`);
                            console.log(`   ├─ Trimmed oldest: ${trimmedCount} candles`);
                            console.log(`   └─ Final dataset: ${finalCandles.length} candles\n`);

                            // Update DB
                            console.log(`💾 [${timeframe}] Updating MongoDB...`);
                            const newLastBarTime = new Date(finalCandles[finalCandles.length - 1].timestamp);
                            const tradingDate = MarketHoursUtil.normalizeDateToMidnight(newLastBarTime);

                            await PreFetchedData.updateOne(
                                { instrument_key: instrumentKey, timeframe: timeframe },
                                {
                                    $set: {
                                        candle_data: finalCandles,
                                        bars_count: finalCandles.length,
                                        trading_date: tradingDate,
                                        updated_at: now,
                                        'data_quality.last_bar_time': newLastBarTime
                                    }
                                }
                            );

                            updatedData[timeframe] = finalCandles;
                            successCount++;
                            console.log(`✅ [${timeframe}] SUCCESS - Incremental update completed!\n`);
                        } else {
                            console.log(`ℹ️  [${timeframe}] No new unique candles to add`);
                            updatedData[timeframe] = existingCandles;
                            successCount++;
                            console.log(`✅ [${timeframe}] SUCCESS - Using existing data\n`);
                        }
                    } else {
                        // Data is stale but API returned 0 candles - this is an error condition
                        console.log(`❌ [${timeframe}] API returned 0 candles for STALE data!`);
                        console.log(`   ├─ Last bar time: ${lastBarTime.toISOString()}`);
                        console.log(`   ├─ Requested range: ${fromDate} to ${toDate}`);
                        console.log(`   └─ This indicates stale data that cannot be refreshed`);
                        throw new Error(
                            `STALE DATA ERROR: ${timeframe} timeframe is stale (last bar: ${lastBarTime.toISOString()}) ` +
                            `but API returned 0 candles for range ${fromDate} to ${toDate}. ` +
                            `Cannot proceed with stale data. This may indicate: ` +
                            `market closure, data unavailability, or incomplete historical data.`
                        );
                    }
                } catch (apiError) {
                    console.log(`\n❌ [${timeframe}] ERROR during API fetch or merge!`);
                    console.error(`   ├─ Error: ${apiError.message}`);
                    if (apiError.stack) {
                        console.error(`   └─ Stack trace: ${apiError.stack.split('\n')[0]}\n`);
                    }

                    // If this is a STALE DATA ERROR, re-throw it to stop the entire operation
                    if (apiError.message.includes('STALE DATA ERROR')) {
                        console.log(`🛑 [${timeframe}] STOPPING - Cannot proceed with stale data\n`);
                        throw apiError;
                    }

                    // For other errors, use existing DB data as fallback
                    updatedData[timeframe] = dbRecord?.candle_data || [];
                    errorCount++;
                    console.log(`⚠️  [${timeframe}] FALLBACK - Using existing DB data\n`);
                }
            }

            // Add fresh timeframes as-is
            for (const dbRecord of dbData) {
                const timeframe = dbRecord.timeframe;
                if (!updatedData[timeframe]) {
                    updatedData[timeframe] = dbRecord.candle_data || [];
                }
            }

            console.log(`${'█'.repeat(80)}`);
            console.log(`📊 [INCREMENTAL MERGE] Job Summary`);
            console.log(`${'█'.repeat(80)}`);
            console.log(`✅ Success: ${successCount}/${staleTimeframes.length} stale timeframes updated`);
            console.log(`❌ Errors: ${errorCount}/${staleTimeframes.length} stale timeframes`);
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
}

const incrementalUpdaterService = new IncrementalUpdaterService();
export default incrementalUpdaterService;
