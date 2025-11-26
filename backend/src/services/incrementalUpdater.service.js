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
  async fetchIncrementalDataAndMerge(instrumentKey, dbData, staleTimeframes, fetchCandlesFromAPI, skipIntraday) {

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
        const dbRecord = dbData.find((db) => db.timeframe === timeframe);

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

        // Map timeframe to Upstox interval
        const upstoxInterval = TIMEFRAME_TO_UPSTOX_INTERVAL[timeframe] || timeframe;

        try {
          // Fetch missing candles
          const apiCandles = await fetchCandlesFromAPI(
            instrumentKey,
            upstoxInterval,
            fromDate,
            toDate,
            skipIntraday

          );

          if (apiCandles && apiCandles.length > 0) {

            // Normalize existing DB candles
            const rawExistingCandles = dbRecord?.candle_data || [];
            const existingCandles = formatCandles(rawExistingCandles);

            // Build timestamp index for deduplication
            const existingTimestamps = new Set(
              existingCandles.map((c) => c.timestamp.toString())
            );

            const newCandles = apiCandles.filter((apiCandle) => {
              const apiTimestamp = apiCandle.timestamp.toString();
              return !existingTimestamps.has(apiTimestamp);
            });

            if (newCandles.length > 0) {

              // Append and sort
              const mergedCandles = [...existingCandles, ...newCandles].
              sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

              // Keep only required number of bars
              const maxBars = dateCalculator.requiredBars[timeframe] || 400;
              const finalCandles = mergedCandles.slice(-maxBars);
              const trimmedCount = mergedCandles.length - finalCandles.length;

              // Update DB

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

            } else {

              updatedData[timeframe] = existingCandles;
              successCount++;

            }
          } else {
            // Data is stale but API returned 0 candles - this is an error condition

            throw new Error(
              `STALE DATA ERROR: ${timeframe} timeframe is stale (last bar: ${lastBarTime.toISOString()}) ` +
              `but API returned 0 candles for range ${fromDate} to ${toDate}. ` +
              `Cannot proceed with stale data. This may indicate: ` +
              `market closure, data unavailability, or incomplete historical data.`
            );
          }
        } catch (apiError) {

          console.error(`   ├─ Error: ${apiError.message}`);
          if (apiError.stack) {
            console.error(`   └─ Stack trace: ${apiError.stack.split('\n')[0]}\n`);
          }

          // If this is a STALE DATA ERROR, re-throw it to stop the entire operation
          if (apiError.message.includes('STALE DATA ERROR')) {

            throw apiError;
          }

          // For other errors, use existing DB data as fallback
          updatedData[timeframe] = dbRecord?.candle_data || [];
          errorCount++;

        }
      }

      // Add fresh timeframes as-is
      for (const dbRecord of dbData) {
        const timeframe = dbRecord.timeframe;
        if (!updatedData[timeframe]) {
          updatedData[timeframe] = dbRecord.candle_data || [];
        }
      }

      Object.keys(updatedData).forEach((tf) => {

      });

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