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
    // Note: v3 API uses "days" (plural), not "day"
    const url = `https://api.upstox.com/v3/historical-candle/${encodedInstrumentKey}/days/1/${currentDayFormattedDate}/${previousDayFormattedDate}`;

    console.log(`\n========== [getDailyCandles] API CALL ==========`);
    console.log(`[getDailyCandles] Instrument Key: ${instrumentKey}`);
    console.log(`[getDailyCandles] URL: ${url}`);
    console.log(`[getDailyCandles] Headers:`, JSON.stringify(axiosConfig.headers));
    console.log(`[getDailyCandles] Date Range: ${previousDayFormattedDate} to ${currentDayFormattedDate}`);

    const response = await axios.get(url, axiosConfig);

    console.log(`[getDailyCandles] Response Status: ${response.status}`);
    console.log(`[getDailyCandles] Response Headers:`, JSON.stringify(response.headers));
    console.log(`[getDailyCandles] Response Data:`, JSON.stringify(response.data));
    console.log(`================================================\n`);

    const candles = response.data?.data?.candles || [];
    console.log(`[getDailyCandles] Candles count: ${candles.length}`);

    if (candles.length >= 1) {
      // Candles are in reverse chronological order: [most recent, previous, ...]
      // Candle format: [timestamp, open, high, low, close, volume, ...]

      // Get today's date in IST (trading day)
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
      const istNow = new Date(now.getTime() + istOffset);
      const todayISTDate = istNow.toISOString().split('T')[0]; // "YYYY-MM-DD"

      // Check if the first candle is from today
      const firstCandleDate = new Date(candles[0][0]);
      const firstCandleDateIST = new Date(firstCandleDate.getTime() + istOffset);
      const firstCandleDateStr = firstCandleDateIST.toISOString().split('T')[0];

      console.log(`[getDailyCandles] Today IST date: ${todayISTDate}`);
      console.log(`[getDailyCandles] First candle date: ${firstCandleDateStr}`);

      // Log all candles for debugging
      candles.slice(0, 3).forEach((candle, idx) => {
        const candleDate = new Date(candle[0]);
        const candleDateIST = new Date(candleDate.getTime() + istOffset);
        console.log(`[getDailyCandles] Candle[${idx}]: date=${candleDateIST.toISOString().split('T')[0]}, O=${candle[1]}, C=${candle[4]}`);
      });

      let todayCandle, previousDayCandle;

      if (firstCandleDateStr === todayISTDate) {
        // First candle IS today's candle - use normal logic
        todayCandle = candles[0];
        previousDayCandle = candles.length >= 2 ? candles[1] : null;
        console.log(`[getDailyCandles] Today's candle found at index 0`);
      } else {
        // First candle is NOT today (market open, today's daily candle doesn't exist yet)
        // First candle is actually the PREVIOUS trading day's close (what we need!)
        todayCandle = null; // No today candle yet
        previousDayCandle = candles[0]; // This is the previous day's close
        console.log(`[getDailyCandles] Today's candle NOT found - using candles[0] as previous day close`);
      }

      if (previousDayCandle) {
        const previousClose = previousDayCandle[4];
        console.log(`[getDailyCandles] Using previousClose=${previousClose} for change calculation`);

        return {
          previousClose: previousClose, // Close price of previous trading day
          todayOpen: todayCandle ? todayCandle[1] : null,
          todayHigh: todayCandle ? todayCandle[2] : null,
          todayLow: todayCandle ? todayCandle[3] : null,
          todayClose: todayCandle ? todayCandle[4] : null,
          todayVolume: todayCandle ? todayCandle[5] : null,
          candleDate: todayCandle ? todayCandle[0] : null,
          previousCandleDate: previousDayCandle[0]
        };
      }
    }

    console.log(`[getDailyCandles] No candles found for ${instrumentKey}`);
    return null;
  } catch (error) {
    console.error(`\n========== [getDailyCandles] API ERROR ==========`);
    console.error(`[getDailyCandles] Instrument Key: ${instrumentKey}`);
    console.error(`[getDailyCandles] Error Message: ${error.message}`);
    if (error.response) {
      console.error(`[getDailyCandles] Response Status: ${error.response.status}`);
      console.error(`[getDailyCandles] Response Headers:`, JSON.stringify(error.response.headers));
      console.error(`[getDailyCandles] Response Data:`, JSON.stringify(error.response.data));
    }
    if (error.request) {
      console.error(`[getDailyCandles] Request was made but no response received`);
    }
    console.error(`=================================================\n`);
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
    // Note: v3 API uses "days" (plural), not "day"
    {
      name: 'v3-historical-daily',
      url: `https://api.upstox.com/v3/historical-candle/${encodedInstrumentKey}/days/1/${currentDayFormattedDate}/${previousDayFormattedDate}`
    }];

    console.log(`\n========== [getCurrentPrice] API CALL ==========`);
    console.log(`[getCurrentPrice] Instrument Key: ${instrumentKey}`);
    console.log(`[getCurrentPrice] Send Candles: ${sendCandles}`);
    console.log(`[getCurrentPrice] Headers:`, JSON.stringify(axiosConfig.headers));

    for (const format of apiFormats) {
      try {
        console.log(`[getCurrentPrice] Trying: ${format.name}`);
        console.log(`[getCurrentPrice] URL: ${format.url}`);

        const response = await axios.get(format.url, axiosConfig);

        console.log(`[getCurrentPrice] Response Status: ${response.status}`);
        console.log(`[getCurrentPrice] Response Data:`, JSON.stringify(response.data).substring(0, 1000));

        const candles = response.data?.data?.candles || [];
        console.log(`[getCurrentPrice] Candles count: ${candles.length}`);

        if (candles.length > 0) {
          console.log(`[getCurrentPrice] SUCCESS with ${format.name}`);
          console.log(`================================================\n`);
          if (sendCandles) {
            // Return full candle array for market route and other use cases
            return candles;
          } else {
            // Return only price for simple price queries
            const latest = candles[0]; // most recent candle
            const currentPrice = latest ? latest[4] : null; // close price
            console.log(`[getCurrentPrice] Returning price: ${currentPrice}`);
            return currentPrice;
          }
        }
        console.log(`[getCurrentPrice] No candles from ${format.name}, trying next...`);
      } catch (apiError) {
        console.log(`[getCurrentPrice] ${format.name} failed: ${apiError.message}`);
        if (apiError.response) {
          console.log(`[getCurrentPrice] Error Response Status: ${apiError.response.status}`);
          console.log(`[getCurrentPrice] Error Response Data:`, JSON.stringify(apiError.response.data));
        }
        // Continue to next format on error
        continue;
      }
    }

    console.log(`[getCurrentPrice] All API formats failed for ${instrumentKey}`);
    console.log(`================================================\n`);
    return null;

  } catch (error) {
    console.error(`\n========== [getCurrentPrice] API ERROR ==========`);
    console.error(`[getCurrentPrice] Instrument Key: ${instrumentKey}`);
    console.error(`[getCurrentPrice] Error Message: ${error.message}`);
    if (error.code === 'ECONNABORTED') {
      console.error(`[getCurrentPrice] Request timeout for ${instrumentKey}`);
    }
    if (error.response) {
      console.error(`[getCurrentPrice] Response Status: ${error.response.status}`);
      console.error(`[getCurrentPrice] Response Data:`, JSON.stringify(error.response.data));
    }
    console.error(`=================================================\n`);
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

/**
 * Find the exact time when price crossed a level using historical intraday candles for a specific date
 * @param {string} instrumentKey - The instrument key
 * @param {number} level - The price level to check (entry, stop, target)
 * @param {string} direction - 'above' (price crossed above level) or 'below' (price crossed below level)
 * @param {Date|string} targetDate - The date to check (e.g., '2026-02-02' or Date object)
 * @returns {Object|null} { crossTime: Date, crossPrice: number } or null if not found
 */
export async function findHistoricalLevelCrossTime(instrumentKey, level, direction = 'above', targetDate) {
  const encodedInstrumentKey = encodeURIComponent(instrumentKey);

  const axiosConfig = {
    headers: {
      'Accept': 'application/json',
      'x-api-key': API_KEY
    },
    timeout: 15000
  };

  try {
    // Format the target date
    const dateObj = targetDate instanceof Date ? targetDate : new Date(targetDate);
    const formattedDate = dateObj.toISOString().split('T')[0];

    // Fetch historical 1-minute candles for the specific date
    // URL format: /v3/historical-candle/{instrument}/minutes/1/{to_date}/{from_date}
    const url = `https://api.upstox.com/v3/historical-candle/${encodedInstrumentKey}/minutes/1/${formattedDate}/${formattedDate}`;

    console.log(`[findHistoricalLevelCrossTime] Fetching historical intraday candles for ${instrumentKey}`);
    console.log(`[findHistoricalLevelCrossTime] Date: ${formattedDate}, Level: ${level}, Direction: ${direction}`);
    console.log(`[findHistoricalLevelCrossTime] URL: ${url}`);

    const response = await axios.get(url, axiosConfig);
    const candles = response.data?.data?.candles || [];

    console.log(`[findHistoricalLevelCrossTime] Got ${candles.length} candles`);

    if (candles.length === 0) {
      return null;
    }

    // Candles are in reverse chronological order: [most recent, ..., earliest]
    // We need to process from earliest to most recent to find FIRST crossing
    const sortedCandles = [...candles].reverse();

    // Candle format: [timestamp, open, high, low, close, volume, ...]
    for (const candle of sortedCandles) {
      const [timestamp, open, high, low, close] = candle;

      if (direction === 'above') {
        // Check if high crossed above level
        if (high >= level) {
          const crossTime = new Date(timestamp);
          // Use the actual crossing price (entry level or open if gapped above)
          const crossPrice = Math.max(level, open);
          console.log(`[findHistoricalLevelCrossTime] Found crossing at ${crossTime.toISOString()} - high=${high} >= level=${level}`);
          return { crossTime, crossPrice };
        }
      } else if (direction === 'below') {
        // Check if low crossed below level
        if (low <= level) {
          const crossTime = new Date(timestamp);
          const crossPrice = Math.min(level, open);
          console.log(`[findHistoricalLevelCrossTime] Found crossing at ${crossTime.toISOString()} - low=${low} <= level=${level}`);
          return { crossTime, crossPrice };
        }
      }
    }

    console.log(`[findHistoricalLevelCrossTime] No crossing found for level ${level} on ${formattedDate}`);
    return null;

  } catch (error) {
    console.error(`[findHistoricalLevelCrossTime] Error fetching historical intraday candles:`, error.message);
    return null;
  }
}

/**
 * Find the exact time when price crossed a level using intraday candles (today only)
 * @param {string} instrumentKey - The instrument key
 * @param {number} level - The price level to check (entry, stop, target)
 * @param {string} direction - 'above' (price crossed above level) or 'below' (price crossed below level)
 * @returns {Object|null} { crossTime: Date, crossPrice: number } or null if not found
 */
export async function findLevelCrossTime(instrumentKey, level, direction = 'above') {
  const encodedInstrumentKey = encodeURIComponent(instrumentKey);

  const axiosConfig = {
    headers: {
      'Accept': 'application/json',
      'x-api-key': API_KEY
    },
    timeout: 15000
  };

  try {
    // Fetch intraday 1-minute candles
    const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodedInstrumentKey}/minutes/1`;

    console.log(`[findLevelCrossTime] Fetching intraday candles for ${instrumentKey}`);
    console.log(`[findLevelCrossTime] Level: ${level}, Direction: ${direction}`);

    const response = await axios.get(url, axiosConfig);
    const candles = response.data?.data?.candles || [];

    console.log(`[findLevelCrossTime] Got ${candles.length} candles`);

    if (candles.length === 0) {
      return null;
    }

    // Candles are in reverse chronological order: [most recent, ..., earliest]
    // We need to process from earliest to most recent to find FIRST crossing
    const sortedCandles = [...candles].reverse();

    // Candle format: [timestamp, open, high, low, close, volume, ...]
    // Track previous candle to detect actual crossings (price moving from below to above level)
    let prevCandle = null;

    for (const candle of sortedCandles) {
      const [timestamp, open, high, low, close] = candle;

      if (direction === 'above') {
        // For "above" direction: find when price actually CROSSED above level
        // Either: (1) opened below and high went above, OR (2) previous close was below and this candle went above
        const crossedThisCandle = (open < level && high >= level) ||
                                   (prevCandle && prevCandle[4] < level && high >= level);

        if (crossedThisCandle) {
          const crossTime = new Date(timestamp);
          // Use the actual crossing price (entry level or open if gapped above)
          const crossPrice = Math.max(level, open);
          console.log(`[findLevelCrossTime] Found CROSSING at ${crossTime.toISOString()} - open=${open}, high=${high}, level=${level}`);
          return { crossTime, crossPrice };
        }
      } else if (direction === 'below') {
        // For "below" direction: find when price actually CROSSED below level
        const crossedThisCandle = (open > level && low <= level) ||
                                   (prevCandle && prevCandle[4] > level && low <= level);

        if (crossedThisCandle) {
          const crossTime = new Date(timestamp);
          const crossPrice = Math.min(level, open);
          console.log(`[findLevelCrossTime] Found CROSSING at ${crossTime.toISOString()} - open=${open}, low=${low}, level=${level}`);
          return { crossTime, crossPrice };
        }
      }

      prevCandle = candle;
    }

    console.log(`[findLevelCrossTime] No crossing found for level ${level}`);
    return null;

  } catch (error) {
    console.error(`[findLevelCrossTime] Error fetching intraday candles:`, error.message);
    return null;
  }
}

/**
 * Get daily OHLC candles from historical 1-minute data for a date range
 * Used to backfill daily snapshots when loading watchlist
 * Fetches 1-minute candles and aggregates them into daily OHLC
 * @param {string} instrumentKey - The instrument key
 * @param {Date|string} fromDate - Start date (e.g., week start)
 * @param {Date|string} toDate - End date (e.g., today)
 * @returns {Array} Array of daily candles [{date, open, high, low, close, volume}]
 */
export async function getDailyCandlesForRange(instrumentKey, fromDate, toDate) {
  const encodedInstrumentKey = encodeURIComponent(instrumentKey);

  // Format dates
  const from = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const to = toDate instanceof Date ? toDate : new Date(toDate);
  const fromStr = from.toISOString().split('T')[0];
  const toStr = to.toISOString().split('T')[0];

  const axiosConfig = {
    headers: {
      'Accept': 'application/json',
      'x-api-key': API_KEY
    },
    timeout: 30000  // Longer timeout for 1-min data
  };

  try {
    // Fetch historical 1-minute candles for the date range
    // URL format: /v3/historical-candle/{instrument}/minutes/1/{to_date}/{from_date}
    const url = `https://api.upstox.com/v3/historical-candle/${encodedInstrumentKey}/minutes/1/${toStr}/${fromStr}`;

    console.log(`[getDailyCandlesForRange] Fetching 1-min candles for ${instrumentKey}`);
    console.log(`[getDailyCandlesForRange] Date range: ${fromStr} to ${toStr}`);
    console.log(`[getDailyCandlesForRange] URL: ${url}`);

    const response = await axios.get(url, axiosConfig);
    const candles = response.data?.data?.candles || [];

    console.log(`[getDailyCandlesForRange] Got ${candles.length} 1-min candles`);

    if (candles.length === 0) {
      return [];
    }

    // Candles are in reverse chronological order
    // Format: [timestamp, open, high, low, close, volume, ...]
    // We need to aggregate them by day

    const istOffset = 5.5 * 60 * 60 * 1000; // IST offset
    const dailyMap = new Map(); // dateStr -> { open, high, low, close, volume, firstTimestamp }

    // Process candles (they're in reverse order, so last candle is earliest)
    for (const candle of candles) {
      const timestamp = new Date(candle[0]);
      const istTime = new Date(timestamp.getTime() + istOffset);
      const dateStr = istTime.toISOString().split('T')[0];

      const open = candle[1];
      const high = candle[2];
      const low = candle[3];
      const close = candle[4];
      const volume = candle[5] || 0;

      if (!dailyMap.has(dateStr)) {
        // First candle of the day (but remember we're processing in reverse)
        dailyMap.set(dateStr, {
          date: dateStr,
          open: open,      // Will be overwritten by later (earlier) candles
          high: high,
          low: low,
          close: close,    // This IS the close (last candle of day)
          volume: volume,
          firstTimestamp: timestamp
        });
      } else {
        const day = dailyMap.get(dateStr);
        // Update OHLC (processing in reverse, so this candle is EARLIER in the day)
        day.open = open;  // Keep updating - the last one we see is the day's open
        day.high = Math.max(day.high, high);
        day.low = Math.min(day.low, low);
        // day.close stays as first we saw (which is actually the day's close)
        day.volume += volume;
        if (timestamp < day.firstTimestamp) {
          day.firstTimestamp = timestamp;
        }
      }
    }

    // Convert map to array, sorted by date ascending
    const dailyCandles = Array.from(dailyMap.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(day => ({
        date: new Date(day.date + 'T09:15:00+05:30'), // Set to market open time IST
        open: day.open,
        high: day.high,
        low: day.low,
        close: day.close,
        volume: day.volume
      }));

    console.log(`[getDailyCandlesForRange] Aggregated into ${dailyCandles.length} daily candles`);
    dailyCandles.forEach((c, i) => {
      console.log(`[getDailyCandlesForRange] Day ${i + 1}: ${c.date.toISOString().split('T')[0]} O=${c.open} H=${c.high} L=${c.low} C=${c.close}`);
    });

    return dailyCandles;

  } catch (error) {
    console.error(`[getDailyCandlesForRange] Error fetching 1-min candles:`, error.message);
    return [];
  }
}

// Export all functions
export default {
  searchStocks,
  getExactStock,
  validateStock,
  getCurrentPrice,
  getDailyCandles,
  getDailyCandlesForRange,
  getStockExchange,
  getStocksByExchange,
  getIndexStocks,
  bulkValidateStocks,
  clearStockCache,
  findLevelCrossTime,
  findHistoricalLevelCrossTime
};