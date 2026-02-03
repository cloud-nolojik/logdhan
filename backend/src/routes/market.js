import express from 'express';
import axios from 'axios';
import { auth } from '../middleware/auth.js';
import priceCacheService from '../services/priceCache.service.js';
import LatestPrice from '../models/latestPrice.js';
import { getCurrentPrice } from '../utils/stockDb.js';

const router = express.Router();

// Cache for market data (1 minute cache)
let marketDataCache = null;
let cacheTimestamp = 0;
const CACHE_DURATION = 60 * 1000; // 1 minute

// Market indices data - using Upstox API or fallback data
const MARKET_INDICES = {
  'NIFTY_50': {
    name: 'Nifty 50',
    symbol: 'NIFTY 50',
    upstoxKey: 'NSE_INDEX|Nifty 50'
  },
  'SENSEX': {
    name: 'Sensex',
    symbol: 'SENSEX',
    upstoxKey: 'BSE_INDEX|SENSEX'
  },
  'NIFTY_BANK': {
    name: 'Nifty Bank',
    symbol: 'NIFTY BANK',
    upstoxKey: 'NSE_INDEX|Nifty Bank'
  }

};

// ⚡ OPTIMIZED: Function to fetch market data with triple fallback (memory → DB → API)
async function fetchMarketDataFromCache() {
  try {
    const startTime = Date.now();

    // Extract all instrument keys
    const instrumentKeys = Object.values(MARKET_INDICES).map((info) => info.upstoxKey);

    // ⚡ Step 1: Get bulk LTP data from memory cache - instant!
    const bulkPrices = priceCacheService.getPrices(instrumentKeys);
    const ltpTime = Date.now() - startTime;

    // Store change data from DB (keyed by instrument_key)
    const changeData = {};

    // ⚡ Step 2: Get candles from memory cache (pre-fetched for indices)
    const candleStartTime = Date.now();
    const candleResults = Object.entries(MARKET_INDICES).map(([key, indexInfo]) => {
      const candles = priceCacheService.getCandles(indexInfo.upstoxKey);
      return { key, indexInfo, candles };
    });
    const candleTime = Date.now() - candleStartTime;

    // ⚡ Step 3: Check for missing indices (not in memory cache)
    const missingIndices = instrumentKeys.filter((key) => !bulkPrices[key] || !priceCacheService.getCandles(key));

    if (missingIndices.length > 0) {

      // Fetch from database
      const dbStartTime = Date.now();
      const dbPrices = await LatestPrice.getPricesForInstruments(missingIndices);
      const dbTime = Date.now() - dbStartTime;

      // Merge DB prices into bulkPrices and store change data
      dbPrices.forEach((priceDoc) => {
        bulkPrices[priceDoc.instrument_key] = priceDoc.last_traded_price;

        // Store change data from DB (calculated from previous day's close via daily API)
        if (priceDoc.previous_day_close && priceDoc.last_traded_price) {
          // Recalculate change using previous day's close for accuracy
          const change = priceDoc.last_traded_price - priceDoc.previous_day_close;
          const changePercent = (change / priceDoc.previous_day_close) * 100;
          changeData[priceDoc.instrument_key] = {
            change: change,
            changePercent: changePercent
          };
        } else if (priceDoc.change !== undefined && priceDoc.change_percent !== undefined) {
          // Fallback to stored change if previous_day_close not available
          changeData[priceDoc.instrument_key] = {
            change: priceDoc.change,
            changePercent: priceDoc.change_percent
          };
        }

        // Also update candles if available
        if (priceDoc.recent_candles && priceDoc.recent_candles.length > 0) {
          const matchingIndex = candleResults.find((r) => r.indexInfo.upstoxKey === priceDoc.instrument_key);
          if (matchingIndex && !matchingIndex.candles) {
            matchingIndex.candles = priceDoc.recent_candles.map((c) => [
            new Date(c.timestamp).getTime(),
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume]
            );
          }
        }
      });

      // ⚡ Step 4: For still missing indices, fetch from API
      const stillMissing = missingIndices.filter((key) => !bulkPrices[key]);

      if (stillMissing.length > 0) {

        const apiStartTime = Date.now();
        const apiPromises = stillMissing.map(async (instrumentKey) => {
          try {
            const candles = await getCurrentPrice(instrumentKey, true); // true = fetch candles for indices
            if (candles && candles.length > 0) {
              const latestCandle = candles[0];
              const price = latestCandle[4]; // Close price
              return { instrumentKey, price, candles };
            }
            return { instrumentKey, price: null, candles: null };
          } catch (error) {
            console.warn(`⚠️ [MARKET] API fetch failed for ${instrumentKey}:`, error.message);
            return { instrumentKey, price: null, candles: null };
          }
        });

        const apiResults = await Promise.all(apiPromises);
        const apiTime = Date.now() - apiStartTime;

        let apiSuccessCount = 0;
        apiResults.forEach(({ instrumentKey, price, candles }) => {
          if (price !== null) {
            bulkPrices[instrumentKey] = price;

            // Update candles for this index
            const matchingIndex = candleResults.find((r) => r.indexInfo.upstoxKey === instrumentKey);
            if (matchingIndex) {
              matchingIndex.candles = candles;
            }

            apiSuccessCount++;
          }
        });

      }
    }

    // ⚡ Step 3: Process results combining LTP + candle data
    const indices = candleResults.map(({ key, indexInfo, candles }) => {
      try {
        // Get current price from bulk fetch (fastest!)
        const currentPrice = bulkPrices[indexInfo.upstoxKey];

        // Get stored change data from DB (correctly calculated from previous close)
        const storedChange = changeData[indexInfo.upstoxKey];

        if (candles && candles.length > 0) {
          // Get the latest candle data (first element is most recent)
          const latestCandle = candles[0];
          const [timestamp, open, high, low, close, volume] = latestCandle;

          // Use stored change data from DB if available (calculated from previous day's close)
          // Otherwise, calculate from previous candle in the array
          let change = 0;
          let changePercent = 0;

          if (storedChange) {
            // Use pre-calculated change from database (correct: based on previous close)
            change = storedChange.change;
            changePercent = storedChange.changePercent;
          } else if (candles.length > 1) {
            // Calculate from previous candle's close
            const previousCandle = candles[1];
            const previousClose = previousCandle[4]; // candle[4] = close
            change = close - previousClose;
            changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;
          } else {
            // Fallback: calculate from today's open (less accurate but better than nothing)
            change = close - open;
            changePercent = open !== 0 ? (change / open) * 100 : 0;
          }

          return {
            name: indexInfo.name,
            symbol: indexInfo.symbol,
            instrumentKey: indexInfo.upstoxKey,
            currentPrice: currentPrice || Math.round(close * 100) / 100,
            change: Math.round(change * 100) / 100,
            changePercent: Math.round(changePercent * 100) / 100,
            high: Math.round(high * 100) / 100,
            low: Math.round(low * 100) / 100,
            open: Math.round(open * 100) / 100,
            volume: volume ? `${Math.round(volume / 1000000)}M` : 'N/A',
            timestamp: new Date(timestamp).toISOString(),
            lastUpdated: new Date().toISOString(),
            totalCandles: candles.length
          };
        } else if (currentPrice) {
          // Use LTP data with stored change if available
          const change = storedChange?.change || 0;
          const changePercent = storedChange?.changePercent || 0;

          return {
            name: indexInfo.name,
            symbol: indexInfo.symbol,
            instrumentKey: indexInfo.upstoxKey,
            currentPrice: Math.round(currentPrice * 100) / 100,
            change: Math.round(change * 100) / 100,
            changePercent: Math.round(changePercent * 100) / 100,
            high: Math.round(currentPrice * 100) / 100,
            low: Math.round(currentPrice * 100) / 100,
            open: Math.round(currentPrice * 100) / 100,
            volume: 'N/A',
            timestamp: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            dataSource: 'ltp_only'
          };
        } else {
          // Fallback to reasonable default values
          console.warn(`⚠️ No data available for ${indexInfo.name}, using fallback`);
          const basePrice = key === 'SENSEX' ? 75000 :
          key === 'NIFTY_50' ? 22500 :
          key === 'NIFTY_BANK' ? 48000 : 35000;

          return {
            name: indexInfo.name,
            symbol: indexInfo.symbol,
            instrumentKey: indexInfo.upstoxKey,
            currentPrice: basePrice,
            change: 0,
            changePercent: 0,
            high: basePrice,
            low: basePrice,
            open: basePrice,
            volume: 'N/A',
            timestamp: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            dataSource: 'fallback'
          };
        }
      } catch (error) {
        console.error(`❌ Error processing ${indexInfo.name}:`, error.message);
        const basePrice = key === 'SENSEX' ? 75000 :
        key === 'NIFTY_50' ? 22500 :
        key === 'NIFTY_BANK' ? 48000 : 35000;

        return {
          name: indexInfo.name,
          symbol: indexInfo.symbol,
          instrumentKey: indexInfo.upstoxKey,
          currentPrice: basePrice,
          change: 0,
          changePercent: 0,
          high: basePrice,
          low: basePrice,
          open: basePrice,
          volume: 'N/A',
          timestamp: new Date().toISOString(),
          lastUpdated: new Date().toISOString(),
          dataSource: 'fallback',
          error: error.message
        };
      }
    });

    const totalTime = Date.now() - startTime;

    return indices;
  } catch (error) {
    console.error('❌ [MARKET] Error fetching market data from cache:', error);
    throw error;
  }
}

// Route to get market indices
router.get('/indices', auth, async (req, res) => {
  try {
    // Fetch data from in-memory cache service (indices are always pre-cached)

    const indices = await fetchMarketDataFromCache();

    res.status(200).json({
      success: true,
      data: {
        indices: indices
      },
      message: 'Market data retrieved successfully (from cache)'
    });

  } catch (error) {
    console.error('❌ [MARKET] Error in /market/indices:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch market data',
      message: error.message
    });
  }
});

// Route to force refresh market indices (fetches fresh data with previous_day_close)
// No auth required - used for system maintenance
router.post('/refresh-indices', async (req, res) => {
  try {
    const instrumentKeys = Object.values(MARKET_INDICES).map((info) => info.upstoxKey);

    // Clear existing records to force fresh fetch
    await LatestPrice.deleteMany({ instrument_key: { $in: instrumentKeys } });

    // Fetch fresh prices - this will call getDailyCandles and store previous_day_close
    const freshPrices = await priceCacheService.getLatestPrices(instrumentKeys);

    // Now get the updated data from DB
    const updatedPrices = await LatestPrice.getPricesForInstruments(instrumentKeys);

    const result = updatedPrices.map((priceDoc) => ({
      instrument_key: priceDoc.instrument_key,
      last_traded_price: priceDoc.last_traded_price,
      previous_day_close: priceDoc.previous_day_close,
      change: priceDoc.change,
      change_percent: priceDoc.change_percent
    }));

    res.json({
      success: true,
      message: 'Market indices refreshed with previous day close data',
      data: result
    });
  } catch (error) {
    console.error('Error refreshing market indices:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Route to get specific index data
router.get('/index/:symbol', auth, async (req, res) => {
  try {
    const { symbol } = req.params;

    // Fetch data from in-memory cache service

    const indices = await fetchMarketDataFromCache();

    const indexData = indices.find((index) =>
    index.symbol.toLowerCase().includes(symbol.toLowerCase())
    );

    if (!indexData) {
      return res.status(404).json({
        success: false,
        error: 'Index not found',
        message: `Index with symbol ${symbol} not found`
      });
    }

    res.status(200).json({
      success: true,
      data: indexData,
      message: 'Index data retrieved successfully (from cache)'
    });

  } catch (error) {
    console.error('❌ [MARKET] Error in /market/index/:symbol:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch index data',
      message: error.message
    });
  }
});

export default router;
