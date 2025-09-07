import express from 'express';
import axios from 'axios';
import { auth } from '../middleware/auth.js';
import { getCurrentPrice } from '../utils/stock.js';

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
  },
  'BSE500': {
    name: 'BSE 500',
    symbol: 'BSE 500',
    upstoxKey: 'BSE_INDEX|BSE-500'
  }
};

// Function to fetch real market data using existing getCurrentPrice function with candles
async function fetchMarketDataFromUpstox() {
  try {
    const indices = [];
    
    // Fetch real data for each index using the existing getCurrentPrice function
    for (const [key, indexInfo] of Object.entries(MARKET_INDICES)) {
      try {
        console.log(`Fetching candle data for ${indexInfo.name} using key: ${indexInfo.upstoxKey}`);
        
        // Get candles data using sendCandles=true parameter
        const candles = await getCurrentPrice(indexInfo.upstoxKey, true);
        
        if (candles && candles.length > 0) {
          // Get the latest candle data (first element is most recent)
          const latestCandle = candles[0];
          const [timestamp, open, high, low, close, volume] = latestCandle;
          
          // Calculate change from previous candle if available
          let change = 0;
          let changePercent = 0;
          let previousClose = open; // Default to open price
          
          if (candles.length > 1) {
            // Use previous candle's close price for change calculation
            const previousCandle = candles[1];
            previousClose = previousCandle[4]; // close price of previous candle
            change = close - previousClose;
            changePercent = previousClose !== 0 ? (change / previousClose) * 100 : 0;
          } else {
            // If only one candle, compare close to open
            change = close - open;
            changePercent = open !== 0 ? (change / open) * 100 : 0;
          }
          
          indices.push({
            name: indexInfo.name,
            symbol: indexInfo.symbol,
            instrumentKey: indexInfo.upstoxKey,
            currentPrice: Math.round(close * 100) / 100,
            change: Math.round(change * 100) / 100,
            changePercent: Math.round(changePercent * 100) / 100,
            high: Math.round(high * 100) / 100,
            low: Math.round(low * 100) / 100,
            open: Math.round(open * 100) / 100,
            volume: volume ? `${Math.round(volume / 1000000)}M` : 'N/A',
            timestamp: new Date(timestamp).toISOString(),
            lastUpdated: new Date().toISOString(),
            totalCandles: candles.length
          });
          
          console.log(`✅ Successfully fetched data for ${indexInfo.name}: ₹${close} (${candles.length} candles)`);
        } else {
          console.warn(`⚠️ No candle data available for ${indexInfo.name}, using fallback`);
          // Fallback to reasonable default values
          const basePrice = key === 'SENSEX' ? 75000 : 
                           key === 'NIFTY_50' ? 22500 :
                           key === 'NIFTY_BANK' ? 48000 : 35000;
          
          indices.push({
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
            totalCandles: 0
          });
        }
      } catch (indexError) {
        console.error(`❌ Error fetching data for ${indexInfo.name}:`, indexError.message);
        // Add fallback data for this index
        const basePrice = key === 'SENSEX' ? 75000 : 
                         key === 'NIFTY_50' ? 22500 :
                         key === 'NIFTY_BANK' ? 48000 : 35000;
        
        indices.push({
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
          totalCandles: 0,
          error: indexError.message
        });
      }
    }
    
    console.log(`📊 Market data fetch completed: ${indices.length} indices processed`);
    return indices;
  } catch (error) {
    console.error('Error fetching market data:', error);
    throw error;
  }
}

// Route to get market indices
router.get('/indices', auth, async (req, res) => {
  try {
    // Check cache first
    const now = Date.now();
    // if (marketDataCache && (now - cacheTimestamp) < CACHE_DURATION) {
    //   console.log('Returning cached market data');
    //   return res.status(200).json({
    //     success: true,
    //     data: {
    //       indices: marketDataCache
    //     },
    //     message: 'Market data retrieved successfully (cached)'
    //   });
    // }
    
    // Fetch fresh data
    console.log('Fetching fresh market data');
    const indices = await fetchMarketDataFromUpstox();
    
    // Update cache
    marketDataCache = indices;
    cacheTimestamp = now;
    
    res.status(200).json({
      success: true,
      data: {
        indices: indices
      },
      message: 'Market data retrieved successfully'
    });
    
  } catch (error) {
    console.error('Error in /market/indices:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch market data',
      message: error.message
    });
  }
});

// Route to get specific index data
router.get('/index/:symbol', auth, async (req, res) => {
  try {
    const { symbol } = req.params;
    
    // Check cache first
    const now = Date.now();
   // if (!marketDataCache || (now - cacheTimestamp) >= CACHE_DURATION) {
      marketDataCache = await fetchMarketDataFromUpstox();
      cacheTimestamp = now;
   // }
    
    const indexData = marketDataCache.find(index => 
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
      message: 'Index data retrieved successfully'
    });
    
  } catch (error) {
    console.error('Error in /market/index/:symbol:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch index data',
      message: error.message
    });
  }
});

export default router;