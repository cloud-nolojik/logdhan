import express from 'express';
import axios from 'axios';
import { auth } from '../middleware/auth.js';
import priceCacheService from '../services/priceCache.service.js';
import LatestPrice from '../models/latestPrice.js';
import { getCurrentPrice, getDailyCandles } from '../utils/stockDb.js';

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

// ⚡ OPTIMIZED: Function to fetch market data with SMART previous_day_close handling
// - First call of the day: Fetches previous_day_close from daily API, stores in DB
// - Subsequent calls: Uses cached previous_day_close, only fetches real-time price
async function fetchMarketDataFromCache() {
  try {
    const startTime = Date.now();

    // Extract all instrument keys
    const instrumentKeys = Object.values(MARKET_INDICES).map((info) => info.upstoxKey);

    // ⚡ SMART: Use getLatestPricesWithChange which handles previous_day_close intelligently
    // - Checks if previous_day_close exists and is from today
    // - If stale/missing, fetches from daily API (once per day)
    // - Returns price + change data
    const priceDataMap = await priceCacheService.getLatestPricesWithChange(instrumentKeys);

    // Store change data (keyed by instrument_key)
    const changeData = {};
    const bulkPrices = {};

    // Extract prices and change data from the smart fetch
    Object.entries(priceDataMap).forEach(([instrumentKey, data]) => {
      bulkPrices[instrumentKey] = data.price;
      if (data.change !== undefined && data.change_percent !== undefined) {
        changeData[instrumentKey] = {
          change: data.change,
          changePercent: data.change_percent
        };
      }
    });

    // ⚡ Get candles from memory cache (for OHLC display)
    const candleResults = Object.entries(MARKET_INDICES).map(([key, indexInfo]) => {
      const candles = priceCacheService.getCandles(indexInfo.upstoxKey);
      return { key, indexInfo, candles };
    });

    // For indices without candles in memory, try to get from DB
    const missingCandleIndices = candleResults.filter(r => !r.candles).map(r => r.indexInfo.upstoxKey);
    if (missingCandleIndices.length > 0) {
      const dbPrices = await LatestPrice.getPricesForInstruments(missingCandleIndices);
      dbPrices.forEach((priceDoc) => {
        if (priceDoc.recent_candles && priceDoc.recent_candles.length > 0) {
          const matchingIndex = candleResults.find((r) => r.indexInfo.upstoxKey === priceDoc.instrument_key);
          if (matchingIndex && !matchingIndex.candles) {
            matchingIndex.candles = priceDoc.recent_candles.map((c) => [
              new Date(c.timestamp).getTime(),
              c.open,
              c.high,
              c.low,
              c.close,
              c.volume
            ]);
          }
        }
      });
    }

    // ⚡ For indices still missing prices, fetch from API directly
    const stillMissing = instrumentKeys.filter((key) => !bulkPrices[key]);

    if (stillMissing.length > 0) {
      console.log(`[MARKET] Fetching ${stillMissing.length} missing indices from API`);

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

      apiResults.forEach(({ instrumentKey, price, candles }) => {
        if (price !== null) {
          bulkPrices[instrumentKey] = price;

          // Update candles for this index
          const matchingIndex = candleResults.find((r) => r.indexInfo.upstoxKey === instrumentKey);
          if (matchingIndex) {
            matchingIndex.candles = candles;
          }
        }
      });
    }

    // ⚡ Process results combining LTP + candle data
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
router.get('/refresh-indices', async (req, res) => {
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

// Debug endpoint to test daily candles API directly
router.get('/debug-daily-candles', async (req, res) => {
  try {
    const instrumentKeys = Object.values(MARKET_INDICES).map((info) => info.upstoxKey);

    const results = await Promise.all(instrumentKeys.map(async (key) => {
      const dailyData = await getDailyCandles(key);
      return {
        instrument_key: key,
        dailyData: dailyData
      };
    }));

    res.json({
      success: true,
      message: 'Debug daily candles response',
      data: results
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
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
