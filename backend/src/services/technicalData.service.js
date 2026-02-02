/**
 * Technical Data Service
 *
 * Provides comprehensive technical data for stocks including:
 * - Price data (CMP, High, Low, 52-week high)
 * - Technical indicators (RSI, ATR, EMA)
 * - Pivot points (Daily/Weekly P, S1, R1)
 * - NIFTY 50 context with market events
 *
 * Data Strategy:
 * 1. Check DB for daily/weekly candle data
 * 2. If missing or stale → fetch from Upstox API
 * 3. Save fetched data to DB for future use
 * 4. Calculate indicators from the data
 */

import OpenAI from 'openai';
import axios from 'axios';
import Stock from '../models/stock.js';
import PreFetchedData from '../models/preFetchedData.js';
import { indicators as indicatorsEngine } from '../engine/index.js';
import { calcClassicPivots } from '../engine/levels.js';
import { round2 } from '../engine/helpers.js';
import { getCurrentPrice } from '../utils/stockDb.js';
import priceCacheService from './priceCache.service.js';
import MarketHoursUtil from '../utils/marketHours.js';

const API_KEY = process.env.UPSTOX_API_KEY;

// Data is considered stale if older than 1 day
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Get formatted date string for Upstox API (YYYY-MM-DD)
 */
function getFormattedDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Check if data is stale (older than threshold)
 */
function isDataStale(updatedAt) {
  if (!updatedAt) return true;
  const age = Date.now() - new Date(updatedAt).getTime();
  return age > STALE_THRESHOLD_MS;
}

/**
 * Check if candle data is missing the previous day's data
 * Compares latest candle date with (current IST date - 1 day)
 *
 * @param {Array} candles - Array of candles
 * @param {string} timeframe - '1d' or '1w'
 * @returns {boolean} - True if data is missing yesterday's candle
 */
function isCandleDataOutdated(candles, timeframe) {
  if (!candles || candles.length === 0) return true;
  if (timeframe !== '1d') return false; // Only check for daily candles

  try {
    // Get the latest candle date
    const latestCandle = candles[candles.length - 1];
    const latestCandleDate = new Date(latestCandle.timestamp || latestCandle[0]);
    const latestCandleDateStr = latestCandleDate.toISOString().split('T')[0];

    // Get yesterday in IST (current IST date - 1 day)
    const nowIST = MarketHoursUtil.toIST(new Date());
    const yesterdayIST = new Date(nowIST);
    yesterdayIST.setDate(yesterdayIST.getDate() - 1);
    const yesterdayStr = yesterdayIST.toISOString().split('T')[0];

    // Data is outdated if latest candle is older than yesterday
    const isOutdated = latestCandleDateStr < yesterdayStr;

    if (isOutdated) {
      console.log(`[CandleData] OUTDATED: Latest candle=${latestCandleDateStr}, Expected at least=${yesterdayStr}`);
    }

    return isOutdated;
  } catch (error) {
    console.error(`[CandleData] Error checking if outdated:`, error.message);
    return false; // Don't block on error
  }
}

/**
 * Fetch candles from Upstox API
 * Uses IST dates to ensure we get the correct data for Indian market
 *
 * @param {string} instrumentKey - The instrument key
 * @param {string} timeframe - 'day' or 'week'
 * @param {number} days - Number of days to fetch
 * @returns {Array} Array of candles
 */
async function fetchFromUpstox(instrumentKey, timeframe, days = 365) {
  // Use IST dates (not UTC) for Indian market
  const nowIST = MarketHoursUtil.toIST(new Date());

  // toDate = today IST (API will return up to yesterday's completed candle)
  const toDateStr = nowIST.toISOString().split('T')[0];

  // fromDate = today - days
  const fromDateIST = new Date(nowIST);
  fromDateIST.setDate(fromDateIST.getDate() - days);
  const fromDateStr = fromDateIST.toISOString().split('T')[0];

  const encodedKey = encodeURIComponent(instrumentKey);

  // Upstox uses 'day' for daily, 'week' for weekly
  const interval = timeframe === 'week' ? 'week' : 'day';
  const url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/${interval}/${toDateStr}/${fromDateStr}`;

  console.log(`[TechnicalData] Fetching ${timeframe} candles from Upstox: ${instrumentKey}`);
  console.log(`[TechnicalData] Date range (IST): ${fromDateStr} to ${toDateStr}`);

  try {
    const response = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
        'Api-Version': '2.0'
      },
      timeout: 15000
    });

    const candles = response.data?.data?.candles || [];
    console.log(`[TechnicalData] Fetched ${candles.length} ${timeframe} candles for ${instrumentKey}`);

    if (candles.length > 0) {
      const latestCandle = candles[0]; // Newest first from API
      console.log(`[TechnicalData] Latest candle date: ${latestCandle[0]?.split('T')[0]}`);
    }

    // Upstox returns newest first, reverse to oldest first
    return candles.reverse();
  } catch (error) {
    console.error(`[TechnicalData] Error fetching ${timeframe} candles for ${instrumentKey}:`, error.message);
    return [];
  }
}

/**
 * Get candle data from DB or fetch from API if missing/stale
 * @param {string} instrumentKey - The instrument key
 * @param {string} symbol - Trading symbol for logging
 * @param {string} timeframe - '1d' or '1w'
 * @returns {Array} Array of candles in format [timestamp, open, high, low, close, volume]
 */
async function getCandleData(instrumentKey, symbol, timeframe) {
  const dbTimeframe = timeframe === '1w' ? '1w' : '1d';
  const upstoxTimeframe = timeframe === '1w' ? 'week' : 'day';

  try {
    // Step 1: Check DB for existing data
    const dbRecord = await PreFetchedData.findOne({
      instrument_key: instrumentKey,
      timeframe: dbTimeframe
    }).lean();

    // Step 2: Check if data exists, is fresh, AND has recent candles
    if (dbRecord && dbRecord.candle_data?.length > 0) {
      const candleArray = dbRecord.candle_data.map(c => [
        c.timestamp,
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume
      ]);

      // Check if candles are missing recent trading days
      const isOutdated = isCandleDataOutdated(dbRecord.candle_data, dbTimeframe);

      if (!isDataStale(dbRecord.updated_at) && !isOutdated) {
        console.log(`[TechnicalData] Using cached ${dbTimeframe} data for ${symbol} (${dbRecord.candle_data.length} candles)`);
        return candleArray;
      }

      // Log why we're fetching
      if (isOutdated) {
        console.log(`[TechnicalData] ${dbTimeframe} data for ${symbol} is OUTDATED (missing recent trading days), fetching from API...`);
      } else {
        console.log(`[TechnicalData] ${dbTimeframe} data for ${symbol} is STALE (>24h old), fetching from API...`);
      }
    } else {
      console.log(`[TechnicalData] ${dbTimeframe} data for ${symbol} is MISSING, fetching from API...`);
    }

    // Step 3: Data missing, stale, or outdated - fetch from API

    const apiCandles = await fetchFromUpstox(instrumentKey, upstoxTimeframe, 400);

    if (apiCandles.length === 0) {
      // If API fails but we have stale data, use it
      if (dbRecord && dbRecord.candle_data?.length > 0) {
        console.log(`[TechnicalData] API failed, using stale ${dbTimeframe} data for ${symbol}`);
        return dbRecord.candle_data.map(c => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]);
      }
      return [];
    }

    // Step 4: Save to DB for future use
    const candleDataForDb = apiCandles.map(c => ({
      timestamp: c[0],
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5] || 0
    }));

    await PreFetchedData.findOneAndUpdate(
      { instrument_key: instrumentKey, timeframe: dbTimeframe },
      {
        $set: {
          stock_symbol: symbol,
          trading_date: new Date(),
          candle_data: candleDataForDb,
          bars_count: candleDataForDb.length,
          updated_at: new Date(),
          fetched_at: new Date()
        }
      },
      { upsert: true, new: true }
    );

    console.log(`[TechnicalData] Saved ${candleDataForDb.length} ${dbTimeframe} candles to DB for ${symbol}`);

    return apiCandles;

  } catch (error) {
    console.error(`[TechnicalData] Error getting ${timeframe} data for ${symbol}:`, error.message);
    return [];
  }
}

/**
 * Aggregate daily candles to weekly candles (fallback if weekly API fails)
 */
function aggregateToWeekly(dailyCandles) {
  if (!dailyCandles || dailyCandles.length === 0) return [];

  const weeklyCandles = [];
  let currentWeek = null;
  let weekData = null;

  for (const candle of dailyCandles) {
    const timestamp = new Date(candle[0]);
    const weekStart = getWeekStart(timestamp);

    if (currentWeek !== weekStart) {
      if (weekData) {
        weeklyCandles.push([
          weekData.timestamp,
          weekData.open,
          weekData.high,
          weekData.low,
          weekData.close,
          weekData.volume
        ]);
      }

      currentWeek = weekStart;
      weekData = {
        timestamp: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5] || 0
      };
    } else {
      weekData.high = Math.max(weekData.high, candle[2]);
      weekData.low = Math.min(weekData.low, candle[3]);
      weekData.close = candle[4];
      weekData.volume += candle[5] || 0;
    }
  }

  if (weekData) {
    weeklyCandles.push([
      weekData.timestamp,
      weekData.open,
      weekData.high,
      weekData.low,
      weekData.close,
      weekData.volume
    ]);
  }

  return weeklyCandles;
}

/**
 * Get week start date string for grouping
 */
function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

/**
 * Calculate technical data for a single stock
 */
async function calculateStockData(symbol, instrumentKey) {
  try {
    // Get daily candles from DB or API
    const dailyCandles = await getCandleData(instrumentKey, symbol, '1d');

    if (dailyCandles.length === 0) {
      return { symbol, error: 'No daily candle data available' };
    }

    // Get weekly candles - try DB/API first, fallback to aggregation
    let weeklyCandles = await getCandleData(instrumentKey, symbol, '1w');

    if (weeklyCandles.length === 0) {
      console.log(`[TechnicalData] No weekly data for ${symbol}, aggregating from daily...`);
      weeklyCandles = aggregateToWeekly(dailyCandles);
    }

    // Calculate indicators
    const dailyIndicators = indicatorsEngine.calculate(dailyCandles);
    const weeklyIndicators = weeklyCandles.length > 0 ? indicatorsEngine.calculate(weeklyCandles) : {};

    // Get latest candle data
    const latestCandle = dailyCandles[dailyCandles.length - 1];
    const prevCandle = dailyCandles.length > 1 ? dailyCandles[dailyCandles.length - 2] : null;

    // Calculate 52-week high (max high from last 252 trading days)
    const tradingDays = Math.min(dailyCandles.length, 252);
    const recentCandles = dailyCandles.slice(-tradingDays);
    const high52w = Math.max(...recentCandles.map(c => c[2]));

    // Calculate daily pivots (using previous day's OHLC)
    let dailyPivot = null;
    if (prevCandle) {
      dailyPivot = calcClassicPivots(prevCandle[2], prevCandle[3], prevCandle[4]);
    }

    // Calculate weekly pivots (using last completed week's OHLC)
    // TradingView uses the most recently completed week:
    // - On Sat/Sun: use the week that just ended (last week)
    // - On Mon-Thu: use the previous week (week before current)
    // - On Fri after market close: use current week
    let weeklyPivot = null;
    if (weeklyCandles.length > 0) {
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
      const hourIST = (now.getUTCHours() + 5.5) % 24; // IST hour

      // Market closes at 3:30 PM IST on Friday
      const isFridayAfterClose = dayOfWeek === 5 && hourIST >= 15.5;
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

      // If it's after Friday close or weekend, the last candle is the completed week
      // Otherwise, we need the week before the current (incomplete) week
      let pivotWeekIndex;
      if (isFridayAfterClose || isWeekend) {
        // Use the last week (just completed)
        pivotWeekIndex = weeklyCandles.length - 1;
      } else {
        // Mid-week: use the previous week (skip current incomplete week)
        pivotWeekIndex = weeklyCandles.length - 2;
      }

      if (pivotWeekIndex >= 0) {
        const prevWeek = weeklyCandles[pivotWeekIndex];
        // calcClassicPivots returns: { pivot, r1, r2, r3, s1, s2, s3 }
        weeklyPivot = calcClassicPivots(prevWeek[2], prevWeek[3], prevWeek[4]);
      }
    }

    // Calculate 50-day average volume
    const last50Candles = dailyCandles.slice(-50);
    const volumes = last50Candles.map(c => c[5] || 0);
    const avgVolume50d = volumes.length > 0
      ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length)
      : 0;

    // EMA stack check
    const emaStackBullish = dailyIndicators.ema20 && dailyIndicators.ema50 && dailyIndicators.sma200
      ? dailyIndicators.ema20 > dailyIndicators.ema50 && dailyIndicators.ema50 > dailyIndicators.sma200
      : null;

    // Calculate 20-day high for level calculations
    const last20Candles = dailyCandles.slice(-20);
    const high20d = last20Candles.length > 0
      ? Math.max(...last20Candles.map(c => c[2]))
      : null;

    // Calculate 1-month return (22 trading days)
    let return1m = null;
    if (dailyCandles.length >= 22) {
      const currentClose = latestCandle[4];
      const monthAgoClose = dailyCandles[dailyCandles.length - 22][4];
      if (currentClose && monthAgoClose) {
        return1m = round2(((currentClose - monthAgoClose) / monthAgoClose) * 100);
      }
    }

    // Calculate weekly change (5 trading days)
    let weeklyChangePct = null;
    if (dailyCandles.length >= 5) {
      const currentClose = latestCandle[4];
      const weekAgoClose = dailyCandles[dailyCandles.length - 5][4];
      if (currentClose && weekAgoClose) {
        weeklyChangePct = round2(((currentClose - weekAgoClose) / weekAgoClose) * 100);
      }
    }

    // Calculate distance from 20 DMA
    let distanceFrom20DmaPct = null;
    if (dailyIndicators.sma20 && latestCandle[4]) {
      distanceFrom20DmaPct = round2(((latestCandle[4] - dailyIndicators.sma20) / dailyIndicators.sma20) * 100);
    }

    return {
      symbol,
      cmp: round2(latestCandle[4]),
      todays_high: round2(latestCandle[2]),
      todays_low: round2(latestCandle[3]),
      high_52w: round2(high52w),
      high_20d: round2(high20d),                              // NEW: For level calculations
      daily_rsi: round2(dailyIndicators.rsi14) || null,
      weekly_rsi: round2(weeklyIndicators.rsi14) || null,
      daily_pivot: dailyPivot?.pivot || null,
      daily_s1: dailyPivot?.s1 || null,
      daily_r1: dailyPivot?.r1 || null,
      daily_r2: dailyPivot?.r2 || null,           // NEW: For structural ladder
      weekly_pivot: weeklyPivot?.pivot || null,
      weekly_s1: weeklyPivot?.s1 || null,
      weekly_r1: weeklyPivot?.r1 || null,
      weekly_r2: weeklyPivot?.r2 || null,         // NEW: For structural ladder
      atr_14: round2(dailyIndicators.atr14) || null,
      atr_pct: dailyIndicators.atr14 && latestCandle[4] > 0
        ? round2((dailyIndicators.atr14 / latestCandle[4]) * 100)
        : null,
      // Moving averages (NEW: needed for level calculations)
      ema_20: round2(dailyIndicators.ema20) || null,
      ema_50: round2(dailyIndicators.ema50) || null,
      sma_50: round2(dailyIndicators.sma50) || null,  // For dma50 fallback chain
      sma_200: round2(dailyIndicators.sma200) || null,
      sma_20: round2(dailyIndicators.sma20) || null,
      ema_stack_bullish: emaStackBullish,
      todays_volume: latestCandle[5] || 0,
      avg_volume_50d: avgVolume50d,
      // Returns (NEW: for scoring)
      return_1m: return1m,
      weekly_change_pct: weeklyChangePct,
      distance_from_20dma_pct: distanceFrom20DmaPct
    };
  } catch (error) {
    console.error(`[TechnicalData] Error calculating data for ${symbol}:`, error.message);
    return { symbol, error: error.message };
  }
}

/**
 * Determine NIFTY 50 trend based on EMA stack
 */
function determineTrend(indicators) {
  const { ema20, ema50, sma200, close } = indicators;

  if (!ema20 || !ema50 || !sma200 || !close) return 'Unknown';

  if (ema20 > ema50 && ema50 > sma200 && close > ema20) return 'Bullish';
  if (ema20 < ema50 && ema50 < sma200 && close < ema20) return 'Bearish';
  return 'Sideways';
}

/**
 * Fetch major market events using OpenAI web search
 */
async function fetchMarketEvents() {
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.responses.create({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search_preview' }],
      input: `What are the major Indian stock market events this week and next week?
Include:
- Union Budget dates if applicable
- RBI monetary policy dates
- F&O expiry dates (monthly/weekly)
- Any major economic data releases
- Any market holidays

Return ONLY a JSON array of strings with event names and dates. Example:
["F&O Weekly Expiry - Feb 6, 2026", "RBI Policy - Feb 7, 2026"]`
    });

    const content = response.output_text || response.choices?.[0]?.message?.content || '';

    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return [content.replace(/[\[\]"]/g, '').trim()];
      }
    }

    return ['Unable to fetch market events'];
  } catch (error) {
    console.error('[TechnicalData] Error fetching market events:', error.message);
    return ['Unable to fetch market events'];
  }
}

/**
 * Get NIFTY 50 context including current level, trend, and market events
 */
async function getNiftyContext() {
  try {
    const niftyKey = 'NSE_INDEX|Nifty 50';

    // Get daily candles for NIFTY
    const candles = await getCandleData(niftyKey, 'NIFTY50', '1d');

    if (candles.length === 0) {
      return {
        current_level: null,
        trend: 'Unknown',
        major_events: ['Unable to fetch NIFTY data']
      };
    }

    const indicators = indicatorsEngine.calculate(candles);
    const latestCandle = candles[candles.length - 1];
    const trend = determineTrend({ ...indicators, close: latestCandle[4] });

    // Fetch market events in parallel
    const events = await fetchMarketEvents();

    return {
      current_level: round2(latestCandle[4]),
      trend,
      major_events: events
    };
  } catch (error) {
    console.error('[TechnicalData] Error getting NIFTY context:', error.message);
    return {
      current_level: null,
      trend: 'Unknown',
      major_events: ['Error fetching data']
    };
  }
}

/**
 * Look up instrument keys for given trading symbols
 */
async function lookupInstrumentKeys(symbols) {
  const symbolMap = {};

  for (const symbol of symbols) {
    try {
      const stock = await Stock.findOne({
        trading_symbol: symbol.toUpperCase(),
        exchange: 'NSE',
        is_active: true
      }).lean();

      if (stock) {
        symbolMap[symbol] = { instrumentKey: stock.instrument_key, name: stock.name };
      } else {
        const bseStock = await Stock.findOne({
          trading_symbol: symbol.toUpperCase(),
          exchange: 'BSE',
          is_active: true
        }).lean();

        if (bseStock) {
          symbolMap[symbol] = { instrumentKey: bseStock.instrument_key, name: bseStock.name };
        } else {
          symbolMap[symbol] = null;
        }
      }
    } catch (error) {
      console.error(`[TechnicalData] Error looking up ${symbol}:`, error.message);
      symbolMap[symbol] = null;
    }
  }

  return symbolMap;
}

/**
 * Main function: Get technical data for multiple symbols
 * @param {Array<string>} symbols - Array of trading symbols
 * @returns {Object} Technical data response
 */
export async function getTechnicalData(symbols) {
  const startTime = Date.now();

  console.log(`[TechnicalData] Processing ${symbols.length} symbols: ${symbols.join(', ')}`);

  // Look up instrument keys
  const symbolMap = await lookupInstrumentKeys(symbols);

  // Calculate data for each stock in parallel
  const stockPromises = symbols.map(async (symbol) => {
    const stockInfo = symbolMap[symbol];
    if (!stockInfo) {
      return { symbol, error: 'Symbol not found in database' };
    }
    return calculateStockData(symbol, stockInfo.instrumentKey);
  });

  // Get NIFTY context in parallel with stock data
  const [stocks, nifty] = await Promise.all([
    Promise.all(stockPromises),
    getNiftyContext()
  ]);

  console.log(`[TechnicalData] Completed in ${Date.now() - startTime}ms`);

  return {
    generated_at: new Date().toISOString(),
    processing_time_ms: Date.now() - startTime,
    nifty,
    stocks
  };
}

/**
 * Fetch live intraday data for a stock
 * Returns today's OHLC and current LTP from intraday candles
 * Returns NULL if market is closed - caller should use daily candles instead
 *
 * Market Hours (IST):
 *   - Open: 9:15 AM to 3:30 PM (regular trading)
 *   - After Hours: 4:00 PM to 9:00 AM next day
 *
 * Uses existing priceCacheService for consistent behavior
 */
async function fetchLiveIntradayData(instrumentKey) {
  try {
    // Check if market is open using MarketHoursUtil
    const isMarketOpen = await MarketHoursUtil.isMarketOpen();

    if (!isMarketOpen) {
      console.log(`[LiveIntraday] ${instrumentKey}: Market CLOSED - returning null (use daily candles)`);
      return null;
    }

    // Market is open - fetch live intraday data
    const candles = await getCurrentPrice(instrumentKey, true);

    console.log(`[LiveIntraday] ${instrumentKey}: Got ${candles?.length || 0} intraday candles`);

    if (!candles || candles.length === 0) {
      console.log(`[LiveIntraday] ${instrumentKey}: No intraday candles - returning null`);
      return null;
    }

    // Get today's date in IST
    const nowIST = MarketHoursUtil.toIST(new Date());
    const todayIST = nowIST.toISOString().split('T')[0];

    // Candles are sorted newest first: [timestamp, open, high, low, close, volume]
    const latestCandle = candles[0];
    const latestCandleDate = latestCandle[0].split('T')[0];

    console.log(`[LiveIntraday] ${instrumentKey}: Today IST = ${todayIST}, Latest candle date = ${latestCandleDate}`);

    // If latest candle is not from today, intraday data is stale
    if (latestCandleDate !== todayIST) {
      console.log(`[LiveIntraday] ${instrumentKey}: STALE - intraday from ${latestCandleDate}, not today ${todayIST}. Will use daily candles.`);
      return null;
    }

    // Filter to only today's candles (cache may contain multiple days)
    const todayCandles = candles.filter(c => c[0].startsWith(todayIST));
    console.log(`[LiveIntraday] ${instrumentKey}: Filtered to ${todayCandles.length} candles for today`);

    if (todayCandles.length === 0) {
      console.log(`[LiveIntraday] ${instrumentKey}: No candles for today after filtering - returning null`);
      return null;
    }

    // Calculate OHLC from TODAY's candles only
    const todayFirstCandle = todayCandles[todayCandles.length - 1]; // Oldest of today (sorted newest first)
    const todayLatestCandle = todayCandles[0]; // Most recent

    console.log(`[LiveIntraday] ${instrumentKey}: Today's first candle: ${todayFirstCandle[0]}, open=${todayFirstCandle[1]}`);
    console.log(`[LiveIntraday] ${instrumentKey}: Today's latest candle: ${todayLatestCandle[0]}, close=${todayLatestCandle[4]}`);

    const todayOpen = todayFirstCandle[1];
    const todayHigh = Math.max(...todayCandles.map(c => c[2]));
    const todayLow = Math.min(...todayCandles.map(c => c[3]));
    const ltp = todayLatestCandle[4];
    const todayVolume = todayCandles.reduce((sum, c) => sum + (c[5] || 0), 0);

    console.log(`[LiveIntraday] ${instrumentKey}: CALCULATED -> Open=${round2(todayOpen)}, High=${round2(todayHigh)}, Low=${round2(todayLow)}, LTP=${round2(ltp)}, Vol=${todayVolume}`);

    return {
      open: round2(todayOpen),
      high: round2(todayHigh),
      low: round2(todayLow),
      ltp: round2(ltp),
      volume: todayVolume
    };
  } catch (error) {
    console.error(`[LiveData] Error fetching intraday for ${instrumentKey}:`, error.message);
    return null;
  }
}

/**
 * Calculate daily analysis data for a single stock
 * Uses LIVE intraday data for current prices + historical daily data for indicators
 *
 * @param {string} symbol - Trading symbol
 * @param {string} instrumentKey - Instrument key
 * @param {number|null} bulkLivePrice - Optional live price from bulk fetch (priceCacheService)
 */
async function calculateDailyStockData(symbol, instrumentKey, bulkLivePrice = null) {
  try {
    console.log(`\n[DailyStockData] ========== ${symbol} ==========`);
    console.log(`[DailyStockData] ${symbol}: Instrument key = ${instrumentKey}`);
    if (bulkLivePrice) {
      console.log(`[DailyStockData] ${symbol}: Bulk live price provided = ${bulkLivePrice}`);
    }

    // Fetch historical daily candles for RSI, pivots, avg volume
    const dailyCandles = await getCandleData(instrumentKey, symbol, '1d');
    console.log(`[DailyStockData] ${symbol}: Daily candles fetched = ${dailyCandles.length}`);

    if (dailyCandles.length === 0) {
      console.log(`[DailyStockData] ${symbol}: NO CANDLES - returning zeros`);
      return {
        symbol,
        instrument_key: instrumentKey,
        prev_close: 0,
        open: 0,
        high: 0,
        low: 0,
        ltp: 0,
        daily_rsi: 0,
        daily_pivot: 0,
        daily_s1: 0,
        daily_r1: 0,
        todays_volume: 0,
        avg_volume_50d: 0
      };
    }

    // Log the last few candles
    const lastCandle = dailyCandles[dailyCandles.length - 1];
    const secondLastCandle = dailyCandles.length > 1 ? dailyCandles[dailyCandles.length - 2] : null;
    console.log(`[DailyStockData] ${symbol}: Last candle (latest daily):`, {
      date: lastCandle[0],
      open: lastCandle[1],
      high: lastCandle[2],
      low: lastCandle[3],
      close: lastCandle[4],
      volume: lastCandle[5]
    });
    if (secondLastCandle) {
      console.log(`[DailyStockData] ${symbol}: Second last candle:`, {
        date: secondLastCandle[0],
        close: secondLastCandle[4]
      });
    }

    // Calculate daily indicators from historical data
    const dailyIndicators = indicatorsEngine.calculate(dailyCandles);
    console.log(`[DailyStockData] ${symbol}: Daily RSI-14 = ${dailyIndicators.rsi14}`);

    // Latest daily candle = most recent completed trading day
    const latestDailyCandle = dailyCandles[dailyCandles.length - 1];
    // Previous day candle = day before that (for gap detection)
    const previousDayCandle = dailyCandles.length > 1 ? dailyCandles[dailyCandles.length - 2] : null;

    // Calculate daily pivots using latest completed day's OHLC
    let dailyPivot = null;
    if (latestDailyCandle) {
      dailyPivot = calcClassicPivots(latestDailyCandle[2], latestDailyCandle[3], latestDailyCandle[4]);
    }

    // Calculate 50-day average volume
    const last50Candles = dailyCandles.slice(-50);
    const volumes = last50Candles.map(c => c[5] || 0);
    const avgVolume50d = volumes.length > 0
      ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length)
      : 0;

    // Determine data source and values
    // Priority: 1) Bulk live price (from priceCacheService), 2) Intraday candles, 3) Daily candle
    let open, high, low, ltp, todayVolume, dataSource;

    if (bulkLivePrice) {
      // Use bulk live price from priceCacheService (market hours - most efficient)
      // For OHLC we still need intraday candles, but LTP comes from bulk fetch
      const liveData = await fetchLiveIntradayData(instrumentKey);

      if (liveData) {
        open = liveData.open;
        high = liveData.high;
        low = liveData.low;
        ltp = round2(bulkLivePrice); // Use bulk price for LTP (more current)
        todayVolume = liveData.volume;
        dataSource = 'BULK LTP + INTRADAY OHLC';
      } else {
        // Intraday not available, use daily + bulk LTP
        open = round2(latestDailyCandle[1]) || 0;
        high = round2(latestDailyCandle[2]) || 0;
        low = round2(latestDailyCandle[3]) || 0;
        ltp = round2(bulkLivePrice);
        todayVolume = latestDailyCandle[5] || 0;
        dataSource = 'BULK LTP + DAILY OHLC';
      }
    } else {
      // No bulk price - try intraday candles
      const liveData = await fetchLiveIntradayData(instrumentKey);
      console.log(`[DailyStockData] ${symbol}: Live intraday data:`, liveData ? {
        ltp: liveData.ltp,
        open: liveData.open,
        high: liveData.high,
        low: liveData.low,
        volume: liveData.volume
      } : 'NULL - will use daily candles');

      if (liveData) {
        // Live intraday data available (market hours)
        open = liveData.open;
        high = liveData.high;
        low = liveData.low;
        ltp = liveData.ltp;
        todayVolume = liveData.volume;
        dataSource = 'LIVE INTRADAY (today)';
      } else {
        // Use latest daily candle (after market hours)
        open = round2(latestDailyCandle[1]) || 0;
        high = round2(latestDailyCandle[2]) || 0;
        low = round2(latestDailyCandle[3]) || 0;
        ltp = round2(latestDailyCandle[4]) || 0;
        todayVolume = latestDailyCandle[5] || 0;
        dataSource = `DAILY CANDLE (${latestDailyCandle[0]?.split('T')[0]})`;
      }
    }

    // prev_close = PREVIOUS day's close (for gap detection)
    // This is the close BEFORE today/latest candle
    const prevClose = previousDayCandle ? round2(previousDayCandle[4]) : round2(latestDailyCandle[4]);

    console.log(`[DailyStockData] ${symbol}: Data source = ${dataSource}`);
    console.log(`[DailyStockData] ${symbol}: FINAL -> LTP=${ltp}, Open=${open}, High=${high}, Low=${low}, Vol=${todayVolume}`);
    console.log(`[DailyStockData] ${symbol}: prev_close=${prevClose} (from ${previousDayCandle ? previousDayCandle[0]?.split('T')[0] : 'same candle'}), avgVol50d=${avgVolume50d}`);

    return {
      symbol,
      instrument_key: instrumentKey,
      prev_close: prevClose,
      open,
      high,
      low,
      ltp,
      daily_rsi: round2(dailyIndicators.rsi14) || 0,
      daily_pivot: dailyPivot?.pivot || 0,
      daily_s1: dailyPivot?.s1 || 0,
      daily_r1: dailyPivot?.r1 || 0,
      todays_volume: todayVolume,
      avg_volume_50d: avgVolume50d
    };
  } catch (error) {
    console.error(`[DailyAnalysis] Error calculating data for ${symbol}:`, error.message);
    return {
      symbol,
      instrument_key: instrumentKey,
      prev_close: 0,
      open: 0,
      high: 0,
      low: 0,
      ltp: 0,
      daily_rsi: 0,
      daily_pivot: 0,
      daily_s1: 0,
      daily_r1: 0,
      todays_volume: 0,
      avg_volume_50d: 0
    };
  }
}

/**
 * Get daily analysis data for multiple symbols
 * Uses priceCacheService for efficient bulk price fetching
 *
 * Data Strategy:
 *   - Market Open (9:15 AM - 4:00 PM IST): Bulk fetch live prices via priceCacheService
 *   - Market Closed (After Hours): Use daily candles from DB
 *
 * @param {Array<string>} symbols - Array of trading symbols
 * @returns {Object} Daily analysis response
 */
export async function getDailyAnalysisData(symbols) {
  const startTime = Date.now();

  console.log(`[DailyAnalysis] Processing ${symbols.length} symbols: ${symbols.join(', ')}`);

  // Check if market is open
  const isMarketOpen = await MarketHoursUtil.isMarketOpen();
  console.log(`[DailyAnalysis] Market is ${isMarketOpen ? 'OPEN' : 'CLOSED'}`);

  // Look up instrument keys
  const symbolMap = await lookupInstrumentKeys(symbols);

  // Get NIFTY data - use live intraday for current level
  const niftyKey = 'NSE_INDEX|Nifty 50';
  const [niftyCandles, niftyLive] = await Promise.all([
    getCandleData(niftyKey, 'NIFTY50', '1d'),
    fetchLiveIntradayData(niftyKey)
  ]);

  let niftyLevel = 0;
  let niftyChangePct = 0;

  if (niftyCandles.length > 0) {
    const prevNifty = niftyCandles[niftyCandles.length - 1];
    const prevClose = prevNifty[4];

    // Use live LTP if available, otherwise use last daily close
    niftyLevel = niftyLive?.ltp || round2(prevClose);
    niftyChangePct = round2(((niftyLevel - prevClose) / prevClose) * 100);
  }

  // If market is open, bulk fetch live prices for all stocks via priceCacheService
  let livePriceMap = {};
  if (isMarketOpen) {
    const instrumentKeys = Object.values(symbolMap)
      .filter(s => s?.instrumentKey)
      .map(s => s.instrumentKey);

    if (instrumentKeys.length > 0) {
      console.log(`[DailyAnalysis] Bulk fetching ${instrumentKeys.length} live prices via priceCacheService`);
      livePriceMap = await priceCacheService.getLatestPrices(instrumentKeys);
      console.log(`[DailyAnalysis] Got ${Object.keys(livePriceMap).length} live prices`);
    }
  }

  // Calculate data for each stock in parallel
  const stockPromises = symbols.map(async (symbol) => {
    const stockInfo = symbolMap[symbol];
    if (!stockInfo) {
      return {
        symbol,
        instrument_key: null,
        prev_close: 0,
        open: 0,
        high: 0,
        low: 0,
        ltp: 0,
        daily_rsi: 0,
        daily_pivot: 0,
        daily_s1: 0,
        daily_r1: 0,
        todays_volume: 0,
        avg_volume_50d: 0
      };
    }

    // Pass live price from bulk fetch if available
    const livePrice = livePriceMap[stockInfo.instrumentKey];
    return calculateDailyStockData(symbol, stockInfo.instrumentKey, livePrice);
  });

  const stocks = await Promise.all(stockPromises);

  // Generate IST timestamp
  const nowIST = MarketHoursUtil.toIST(new Date());
  const dateStr = nowIST.toISOString().split('T')[0];
  const generatedAtIST = nowIST.toISOString().replace('Z', '+05:30');

  console.log(`[DailyAnalysis] Completed in ${Date.now() - startTime}ms`);

  return {
    date: dateStr,
    generated_at_ist: generatedAtIST,
    nifty_level: niftyLevel,
    nifty_change_pct: niftyChangePct,
    stocks
  };
}

/**
 * Get classification data for on-demand analysis
 * Returns simplified indicator object for quick setup classification
 *
 * @param {string} symbol - Trading symbol
 * @param {string} instrumentKey - Instrument key
 * @returns {Object} Classification-ready data
 */
export async function getClassificationData(symbol, instrumentKey) {
  try {
    const techData = await calculateStockData(symbol, instrumentKey);

    if (techData.error) {
      return { error: techData.error, symbol };
    }

    const volumeVsAvg = techData.avg_volume_50d > 0
      ? round2(techData.todays_volume / techData.avg_volume_50d)
      : null;

    return {
      symbol,
      price: techData.cmp,
      ema20: techData.ema_20,
      ema50: techData.ema_50,
      sma200: techData.sma_200,
      rsi: techData.daily_rsi,
      weeklyRsi: techData.weekly_rsi,
      high52W: techData.high_52w,
      high20D: techData.high_20d,
      atr: techData.atr_14,
      atrPct: techData.atr_pct,
      weeklyChange: techData.weekly_change_pct,
      volumeVsAvg,
      // Additional fields for quick reject messages
      todaysHigh: techData.todays_high,
      todaysLow: techData.todays_low,
      weeklyR1: techData.weekly_r1,
      weeklyS1: techData.weekly_s1,
      dailyR1: techData.daily_r1,
      dailyS1: techData.daily_s1
    };
  } catch (error) {
    console.error(`[ClassificationData] Error for ${symbol}:`, error.message);
    return { error: error.message, symbol };
  }
}

export default {
  getTechnicalData,
  getDailyAnalysisData,
  getNiftyContext,
  calculateStockData,
  getClassificationData
};
