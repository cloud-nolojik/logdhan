/**
 * Intraday Daily Merge Service
 *
 * Handles fetching and saving today's intraday data to database (for post-market updates).
 * Called after 4 PM IST on trading days to ensure DB has current day's data.
 *
 * This service is responsible for:
 * - Fetching today's complete intraday data
 * - Merging with existing historical data
 * - Updating MongoDB with merged results
 */

import PreFetchedData from '../models/preFetchedData.js';
import dateCalculator from '../utils/dateCalculator.js';
import MarketHoursUtil from '../utils/marketHours.js';

class IntradayDailyMergeService {
    /**
     * Fetch and save today's intraday data to database (for post-market updates)
     * @param {string} instrumentKey - The instrument key
     * @param {Function} buildIntradayUrl - Function to build intraday URL
     * @param {Function} fetchCandleData - Function to fetch candle data from API
     * @returns {Promise<void>}
     */
    async fetchAndSaveTodaysIntradayData(instrumentKey, buildIntradayUrl, fetchCandleData) {
        console.log(`\n${'='.repeat(80)}`);
        console.log(`🕐 [POST-MARKET UPDATE] Fetching today's complete intraday data`);
        console.log(`${'='.repeat(80)}`);
        console.log(`📊 Instrument: ${instrumentKey}`);

        const today = MarketHoursUtil.normalizeDateToMidnight(new Date());
        const timeframes = ['15m', '1h', '1d'];

        try {
            for (const timeframe of timeframes) {
                console.log(`\n🔄 [${timeframe}] Fetching today's complete data...`);

                // Build intraday URL for today's data
                const intradayUrl = buildIntradayUrl(instrumentKey, timeframe);
                console.log(`📡 [${timeframe}] URL: ${intradayUrl}`);

                // Fetch candle data
                const response = await fetchCandleData(intradayUrl);
                let todayCandles = response?.data?.candles || response?.candles || [];

                if (todayCandles.length === 0) {
                    console.log(`⚠️ [${timeframe}] No data returned from API`);
                    continue;
                }

                // Transform candles to our format
                const transformedCandles = todayCandles.map(candle => ({
                    timestamp: new Date(candle[0]),
                    open: parseFloat(candle[1]),
                    high: parseFloat(candle[2]),
                    low: parseFloat(candle[3]),
                    close: parseFloat(candle[4]),
                    volume: parseInt(candle[5] || 0)
                }));

                console.log(`✅ [${timeframe}] Fetched ${transformedCandles.length} candles from API`);

                // Get existing data from DB to merge
                const existingData = await PreFetchedData.findOne({
                    instrument_key: instrumentKey,
                    timeframe: timeframe
                });

                let finalCandles = [];

                if (existingData && existingData.candle_data?.length > 0) {
                    console.log(`📦 [${timeframe}] Found existing DB data: ${existingData.candle_data.length} candles`);

                    // Merge: Keep historical data + add today's data (remove duplicates)
                    const existingMap = new Map();
                    existingData.candle_data.forEach(candle => {
                        const key = new Date(candle.timestamp).getTime();
                        existingMap.set(key, candle);
                    });

                    // Add/update with today's candles
                    transformedCandles.forEach(candle => {
                        const key = candle.timestamp.getTime();
                        existingMap.set(key, candle);
                    });

                    // Convert back to array and sort
                    finalCandles = Array.from(existingMap.values())
                        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

                    // Trim to max required bars
                    const maxBars = dateCalculator.requiredBars[timeframe] || 400;
                    if (finalCandles.length > maxBars) {
                        finalCandles = finalCandles.slice(-maxBars);
                    }

                    console.log(`✅ [${timeframe}] Merged data: ${finalCandles.length} candles (max: ${maxBars})`);
                } else {
                    finalCandles = transformedCandles;
                    console.log(`✅ [${timeframe}] Using fresh data: ${finalCandles.length} candles`);
                }

                // Save/update in database with today's trading_date
                console.log(`💾 [${timeframe}] Saving to database with today's date...`);
                const lastBarTime = finalCandles.length > 0 ?
                    new Date(finalCandles[finalCandles.length - 1].timestamp) : null;

                await PreFetchedData.updateOne(
                    { instrument_key: instrumentKey, timeframe: timeframe },
                    {
                        $set: {
                            candle_data: finalCandles, // Store the array of candles, not indicators
                            bars_count: finalCandles.length,
                            trading_date: today, // CRITICAL: Update to today's date
                            updated_at: new Date(),
                            'data_quality.last_bar_time': lastBarTime
                        },
                        $setOnInsert: {
                            // These fields are only set when creating a new document (upsert creates new)
                            stock_symbol: instrumentKey.split('|')[2] || instrumentKey,
                            instrument_key: instrumentKey,
                            timeframe: timeframe
                        }
                    },
                    { upsert: true }
                );

                console.log(`✅ [${timeframe}] Successfully saved to DB with trading_date: ${today.toISOString().split('T')[0]}`);
            }

            console.log(`\n${'='.repeat(80)}`);
            console.log(`✅ [POST-MARKET UPDATE] Complete - All timeframes updated with today's data`);
            console.log(`${'='.repeat(80)}\n`);

        } catch (error) {
            console.error(`❌ [POST-MARKET UPDATE] Error: ${error.message}`);
            throw error;
        }
    }
}

const intradayDailyMergeService = new IntradayDailyMergeService();
export default intradayDailyMergeService;
