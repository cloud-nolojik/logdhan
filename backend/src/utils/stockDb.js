import Stock from '../models/stock.js';
import axios from 'axios';

const API_KEY = process.env.UPSTOX_API_KEY || '5d2c7442-7ce9-44b3-a0df-19c110d72262';

// Cache for frequently accessed stocks (5 minute TTL)
const stockCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper: Match scoring logic for better search results
function calculateMatchScore(searchTerm, stock) {
  const term = searchTerm.toLowerCase().replace(/\s+/g, '');
  let score = 0;

  const symbol = stock.trading_symbol?.toLowerCase() || '';
  const name = stock.name?.replace(/\s+/g, '').toLowerCase() || '';
  const shortName = stock.short_name?.replace(/\s+/g, '').toLowerCase() || '';

  // Exact matches get highest scores
  if (symbol === term) score += 100;
  if (name === term) score += 90;
  if (shortName === term) score += 85;

  // Contains matches
  if (symbol.includes(term)) score += 50;
  if (name.includes(term)) score += 40;
  if (shortName.includes(term)) score += 35;

  // Starts with matches
  if (symbol.startsWith(term)) score += 30;
  if (name.startsWith(term)) score += 25;
  if (shortName.startsWith(term)) score += 20;

  // Boost score for popular stocks (can add a popularity field later)
  if (['RELIANCE', 'TCS', 'INFY', 'HDFC', 'ICICI'].some((popular) => symbol.includes(popular))) {
    score += 10;
  }

  return score;
}

// Search stocks in database
export async function searchStocks(searchTerm) {
  try {
    if (!searchTerm || searchTerm.length < 2) {
      return { allMatches: [] };
    }

    const searchRegex = new RegExp(searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    // Parallel search in both exchanges
    const [nseMatches, bseMatches] = await Promise.all([
    Stock.find({
      segment: 'NSE_EQ',
      is_active: true,
      $or: [
      { trading_symbol: searchRegex },
      { name: searchRegex },
      { short_name: searchRegex }]

    }).
    select('segment name exchange trading_symbol instrument_key short_name isin').
    limit(50).
    lean(),

    Stock.find({
      segment: 'BSE_EQ',
      is_active: true,
      $or: [
      { trading_symbol: searchRegex },
      { name: searchRegex },
      { short_name: searchRegex }]

    }).
    select('segment name exchange trading_symbol instrument_key short_name isin').
    limit(50).
    lean()]
    );

    // Calculate match scores and combine results
    const allMatches = [
    ...nseMatches.map((stock) => ({
      ...stock,
      matchScore: calculateMatchScore(searchTerm, stock)
    })),
    ...bseMatches.map((stock) => ({
      ...stock,
      matchScore: calculateMatchScore(searchTerm, stock)
    }))];

    // Sort by match score (best matches first)
    allMatches.sort((a, b) => b.matchScore - a.matchScore);

    // Remove duplicate stocks (same company in both exchanges)
    const uniqueMatches = [];
    const seenNames = new Set();

    for (const match of allMatches) {
      const key = match.name.toLowerCase().replace(/\s+/g, '');
      if (!seenNames.has(key)) {
        seenNames.add(key);
        uniqueMatches.push(match);
      } else {
        // Prefer NSE over BSE for duplicates
        const existingIndex = uniqueMatches.findIndex((m) =>
        m.name.toLowerCase().replace(/\s+/g, '') === key
        );
        if (existingIndex >= 0 && match.exchange === 'NSE' && uniqueMatches[existingIndex].exchange === 'BSE') {
          uniqueMatches[existingIndex] = match;
        }
      }
    }

    return {
      allMatches: uniqueMatches.slice(0, 20) // Return top 20 results
    };

  } catch (error) {
    console.error('Error searching stocks in DB:', error);
    // Fallback to empty results on error
    return { allMatches: [] };
  }
}

// Get exact stock by instrument key
export async function getExactStock(instrumentKey) {
  try {
    if (!instrumentKey) {
      return null;
    }

    // Check cache first
    const cacheKey = `stock:${instrumentKey}`;
    const cached = stockCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }

    // Query database
    const stock = await Stock.findOne({
      instrument_key: instrumentKey,
      is_active: true
    }).
    select('-__v -createdAt -updatedAt -search_keywords').
    lean();

    if (stock) {
      // Update cache
      stockCache.set(cacheKey, {
        data: stock,
        timestamp: Date.now()
      });
    }

    return stock;

  } catch (error) {
    console.error('Error fetching exact stock from DB:', error);
    return null;
  }
}

// Validate if stock exists
export async function validateStock(instrumentKey) {
  try {
    if (!instrumentKey) {
      return false;
    }

    const exists = await Stock.exists({
      instrument_key: instrumentKey,
      is_active: true
    });

    return !!exists;

  } catch (error) {
    console.error('Error validating stock:', error);
    return false;
  }
}

// Fetch daily candles to get previous day's close price
// This is specifically for calculating accurate daily change
// @param {string} instrumentKey - The instrument key to fetch price for
// @returns {Object|null} { previousClose, todayOpen, todayHigh, todayLow, todayClose } or null
export async function getDailyCandles(instrumentKey) {
  const currentDate = new Date();
  const previousDay = new Date(currentDate);
  previousDay.setDate(currentDate.getDate() - 10); // Look back 10 days to cover weekends/holidays
  const currentDayFormattedDate = getFormattedDate(currentDate);
  const previousDayFormattedDate = getFormattedDate(previousDay);

  // URL-encode the instrument key (| needs to be encoded as %7C)
  const encodedInstrumentKey = encodeURIComponent(instrumentKey);

  const axiosConfig = {
    headers: {
      'Accept': 'application/json',
      'x-api-key': API_KEY
    },
    timeout: 15000
  };

  try {
    // Use daily candles API - this gives us one candle per trading day
    const url = `https://api.upstox.com/v3/historical-candle/${encodedInstrumentKey}/day/1/${currentDayFormattedDate}/${previousDayFormattedDate}`;

    const response = await axios.get(url, axiosConfig);
    const candles = response.data?.data?.candles || [];

    if (candles.length >= 2) {
      // Candles are in reverse chronological order: [today, yesterday, day before, ...]
      // Candle format: [timestamp, open, high, low, close, volume, ...]
      const todayCandle = candles[0];
      const previousDayCandle = candles[1];

      return {
        previousClose: previousDayCandle[4], // Close price of previous trading day
        todayOpen: todayCandle[1],
        todayHigh: todayCandle[2],
        todayLow: todayCandle[3],
        todayClose: todayCandle[4],
        todayVolume: todayCandle[5],
        candleDate: todayCandle[0],
        previousCandleDate: previousDayCandle[0]
      };
    } else if (candles.length === 1) {
      // Only today's candle available (market just opened or first trading day)
      const todayCandle = candles[0];
      return {
        previousClose: todayCandle[1], // Use today's open as fallback
        todayOpen: todayCandle[1],
        todayHigh: todayCandle[2],
        todayLow: todayCandle[3],
        todayClose: todayCandle[4],
        todayVolume: todayCandle[5],
        candleDate: todayCandle[0],
        previousCandleDate: null
      };
    }

    return null;
  } catch (error) {
    console.error(`Error fetching daily candles for ${instrumentKey}:`, error.message);
    return null;
  }
}

// Get current price from Upstox API
// @param {string} instrumentKey - The instrument key to fetch price for
// @param {boolean} sendCandles - If true, returns full candle array; if false, returns only price
export async function getCurrentPrice(instrumentKey, sendCandles = false) {
  const currentDate = new Date();
  const previousDay = new Date(currentDate);
  previousDay.setDate(currentDate.getDate() - 7); // Look back 7 days to cover weekends/holidays
  const currentDayFormattedDate = getFormattedDate(currentDate);
  const previousDayFormattedDate = getFormattedDate(previousDay);

  // URL-encode the instrument key (| needs to be encoded as %7C)
  const encodedInstrumentKey = encodeURIComponent(instrumentKey);

  const axiosConfig = {
    headers: {
      'Accept': 'application/json',
      'x-api-key': API_KEY
    },
    timeout: 15000 // 15 second timeout for better reliability
  };

  try {
    // Try different API endpoints
    const apiFormats = [
    // Current day intraday data (1-minute candles)
    {
      name: 'v3-intraday-current',
      url: `https://api.upstox.com/v3/historical-candle/intraday/${encodedInstrumentKey}/minutes/1`
    },
    // Historical data with date range (1-minute candles)
    {
      name: 'v3-historical-minutes',
      url: `https://api.upstox.com/v3/historical-candle/${encodedInstrumentKey}/minutes/1/${currentDayFormattedDate}/${previousDayFormattedDate}`
    },
    // Daily candles fallback (for non-market hours when intraday data is unavailable)
    {
      name: 'v3-historical-daily',
      url: `https://api.upstox.com/v3/historical-candle/${encodedInstrumentKey}/day/1/${currentDayFormattedDate}/${previousDayFormattedDate}`
    }];

    for (const format of apiFormats) {
      try {
        const response = await axios.get(format.url, axiosConfig);
        const candles = response.data?.data?.candles || [];

        if (candles.length > 0) {
          if (sendCandles) {
            // Return full candle array for market route and other use cases
            return candles;
          } else {
            // Return only price for simple price queries
            const latest = candles[0]; // most recent candle
            const currentPrice = latest ? latest[4] : null; // close price
            return currentPrice;
          }
        }
      } catch (apiError) {
        // Continue to next format on error
        continue;
      }
    }

    return null;

  } catch (error) {
    console.error(`Error fetching current price for ${instrumentKey}:`, error.message);
    if (error.code === 'ECONNABORTED') {
      console.error(`Request timeout for ${instrumentKey}`);
    }
    return null;
  }
}

function getFormattedDate(date) {
  return date.toISOString().split('T')[0];
}

// Get stock exchange from instrument key
export async function getStockExchange(instrumentKey) {
  const stock = await getExactStock(instrumentKey);
  return stock ? stock.exchange : null;
}

// Get stocks by exchange (for market overview)
export async function getStocksByExchange(exchange, limit = 100) {
  try {
    const segment = exchange === 'NSE' ? 'NSE_EQ' : 'BSE_EQ';

    const stocks = await Stock.find({
      segment,
      is_active: true
    }).
    select('name trading_symbol instrument_key exchange').
    limit(limit).
    lean();

    return stocks;

  } catch (error) {
    console.error('Error fetching stocks by exchange:', error);
    return [];
  }
}

// Get popular/index stocks
export async function getIndexStocks() {
  try {
    const indexStocks = [
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
    'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK',
    'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI', 'WIPRO'];

    const stocks = await Stock.find({
      segment: 'NSE_EQ',
      trading_symbol: { $in: indexStocks },
      is_active: true
    }).
    select('name trading_symbol instrument_key exchange').
    lean();

    return stocks;

  } catch (error) {
    console.error('Error fetching index stocks:', error);
    return [];
  }
}

// Bulk validate stocks
export async function bulkValidateStocks(instrumentKeys) {
  try {
    if (!instrumentKeys || !Array.isArray(instrumentKeys)) {
      return [];
    }

    const validStocks = await Stock.find({
      instrument_key: { $in: instrumentKeys },
      is_active: true
    }).
    select('instrument_key').
    lean();

    return validStocks.map((s) => s.instrument_key);

  } catch (error) {
    console.error('Error bulk validating stocks:', error);
    return [];
  }
}

// Clear cache (useful for maintenance)
export function clearStockCache() {
  stockCache.clear();

}

// Export all functions
export default {
  searchStocks,
  getExactStock,
  validateStock,
  getCurrentPrice,
  getDailyCandles,
  getStockExchange,
  getStocksByExchange,
  getIndexStocks,
  bulkValidateStocks,
  clearStockCache
};