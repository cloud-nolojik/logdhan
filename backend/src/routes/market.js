import express from 'express';
import axios from 'axios';
import { auth } from '../middleware/auth.js';

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

// Function to fetch market data from Upstox (you'll need to implement this)
async function fetchMarketDataFromUpstox() {
  try {
    // This is a placeholder - you'll need to implement Upstox API integration
    // For now, return mock data that looks realistic
    const indices = [];
    
    for (const [key, indexInfo] of Object.entries(MARKET_INDICES)) {
      // Generate realistic mock data
      const basePrice = key === 'SENSEX' ? 75000 : 
                       key === 'NIFTY_50' ? 22500 :
                       key === 'NIFTY_BANK' ? 48000 : 35000;
      
      const changePercent = (Math.random() - 0.5) * 4; // -2% to +2%
      const change = (basePrice * changePercent) / 100;
      const currentPrice = basePrice + change;
      
      indices.push({
        name: indexInfo.name,
        symbol: indexInfo.symbol,
        currentPrice: Math.round(currentPrice * 100) / 100,
        change: Math.round(change * 100) / 100,
        changePercent: Math.round(changePercent * 100) / 100,
        high: Math.round((currentPrice * 1.02) * 100) / 100,
        low: Math.round((currentPrice * 0.98) * 100) / 100,
        volume: `${Math.floor(Math.random() * 500 + 100)}M`,
        lastUpdated: new Date().toISOString()
      });
    }
    
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
    if (marketDataCache && (now - cacheTimestamp) < CACHE_DURATION) {
      console.log('Returning cached market data');
      return res.status(200).json({
        success: true,
        data: {
          indices: marketDataCache
        },
        message: 'Market data retrieved successfully (cached)'
      });
    }
    
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
    if (!marketDataCache || (now - cacheTimestamp) >= CACHE_DURATION) {
      marketDataCache = await fetchMarketDataFromUpstox();
      cacheTimestamp = now;
    }
    
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