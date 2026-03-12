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
import { rateLimitedGet } from '../utils/upstoxRateLimiter.js';
import Stock from '../models/stock.js';
import PreFetchedData from '../models/preFetchedData.js';
import { indicators as indicatorsEngine } from '../engine/index.js';
import { calcClassicPivots } from '../engine/levels.js';
import { round2 } from '../engine/helpers.js';
import { getCurrentPrice } from '../utils/stockDb.js';
import priceCacheService from './priceCache.service.js';
import MarketHoursUtil from '../utils/marketHours.js';

const API_KEY = process.env.UPSTOX_API_KEY;

// Concurrency limit for parallel Upstox API calls (avoid rate limiting)
const API_CONCURRENCY = 5;

/**
 * Run async tasks with concurrency limit
 * @param {Array} items - Items to process
 * @param {number} concurrency - Max concurrent tasks
 * @param {Function} fn - Async function to run on each item
 * @returns {Array} Results in same order as items
 */
async function pMap(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Get formatted date string for Upstox API (YYYY-MM-DD)
 */
function getFormattedDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Filter candles to only include data up to a reference date
 * @param {Array} candles - Array of candles [timestamp, open, high, low, close, volume]
 * @param {string} maxDate - Max date in YYYY-MM-DD format
 * @returns {Array} Filtered candles
 */
function filterCandlesToDate(candles, maxDate) {
  if (!candles || candles.length === 0 || !maxDate) return candles;

  return candles.filter(candle => {
    const timestamp = candle[0] || candle.timestamp;
    if (!timestamp) return false;
    // Extract just the date part (YYYY-MM-DD) from the timestamp
    const candleDateStr = timestamp.split('T')[0];
    return candleDateStr <= maxDate;
  });
}

/**
 * Check if candle data is missing the last completed trading day's data
 * Uses MarketHoursUtil.getLastCompletedTradingDay() to skip weekends/holidays
 *
 * Before 4 PM on a trading day → expects previous trading day's candle
 * After 4 PM on a trading day → expects today's candle
 * Weekend/holiday → expects last trading day's candle
 *
 * @param {Array} candles - Array of candles
 * @param {string} timeframe - '1d' or '1w'
 * @returns {Promise<boolean>} - True if data is missing the last completed trading day's candle
 */
async function isCandleDataOutdated(candles, timeframe) {
  if (!candles || candles.length === 0) return true;
  if (timeframe !== '1d') return false; // Only check for daily candles

  try {
    // Get the latest candle date
    // Extract date directly from timestamp string to avoid UTC conversion
    // Timestamps are IST (e.g., "2026-02-24T00:00:00+05:30") — parsing through
    // new Date() converts to UTC ("2026-02-23T18:30:00Z") which shifts the date back
    // Upstox API returns candles in ascending order (oldest first), so last element is the latest
    const latestCandle = candles[candles.length - 1];
    const rawTimestamp = latestCandle.timestamp || latestCandle[0];
    const latestCandleDateStr = typeof rawTimestamp === 'string'
      ? rawTimestamp.split('T')[0]
      : new Date(rawTimestamp).toISOString().split('T')[0];

    // Get last completed trading day (accounts for weekends, holidays, pre-market)
    const expectedDateStr = await MarketHoursUtil.getLastCompletedTradingDay();

    // Data is outdated if latest candle is older than the last completed trading day
    const isOutdated = latestCandleDateStr < expectedDateStr;

    if (isOutdated) {
      console.log(`[CandleData] OUTDATED: Latest candle=${latestCandleDateStr}, Expected at least=${expectedDateStr}`);
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
  // Cache-bust: Cloudflare CDN caches by URL and can serve stale index data to certain regions
  const cacheBust = `_t=${Date.now()}`;
  const url = `https://api.upstox.com/v2/historical-candle/${encodedKey}/${interval}/${toDateStr}/${fromDateStr}?${cacheBust}`;
  console.log(`[CandleData] fetchFromUpstox: ${url}`);

  try {
    const response = await rateLimitedGet(url, {
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache, no-store',
      },
      timeout: 15000
    }, { caller: 'fetchFromUpstox' });

    const candles = response.data?.data?.candles || [];

    // Log raw API response for debugging (first 3 and last 3 candles)
    if (candles.length > 0) {
      const first3 = candles.slice(0, 3).map(c => c[0]);
      const last3 = candles.slice(-3).map(c => c[0]);
      console.log(`[CandleData] fetchFromUpstox RAW response: ${candles.length} candles, first=[${first3.join(', ')}], last=[${last3.join(', ')}]`);
    }

    // Upstox returns newest first, reverse to oldest first
    return { candles: candles.reverse(), status: 200 };
  } catch (error) {
    const status = error.response?.status || 0;
    console.error(`[CandleData] fetchFromUpstox FAILED for ${instrumentKey}: HTTP ${status} - ${error.message}`);
    return { candles: [], status };
  }
}

/**
 * Get candle data from DB or fetch from API if missing/stale
 * @param {string} instrumentKey - The instrument key
 * @param {string} symbol - Trading symbol for logging
 * @param {string} timeframe - '1d' or '1w'
 * @returns {Array} Array of candles in format [timestamp, open, high, low, close, volume]
 */
async function getCandleData(instrumentKey, symbol, timeframe, { allowOutdated = false } = {}) {
  const dbTimeframe = timeframe === '1w' ? '1w' : '1d';
  const upstoxTimeframe = timeframe === '1w' ? 'week' : 'day';

  try {
    // Step 1: Check DB for existing data
    console.log(`[CandleData] ${symbol}: checking DB for ${instrumentKey} / ${dbTimeframe}`);
    const dbRecord = await PreFetchedData.findOne({
      instrument_key: instrumentKey,
      timeframe: dbTimeframe
    }).sort({ updated_at: -1 }).lean();

    // Step 2: Check if data exists and has the last completed trading day's candle
    if (dbRecord && dbRecord.candle_data?.length > 0) {
      const lastCandle = dbRecord.candle_data[dbRecord.candle_data.length - 1];
      console.log(`[CandleData] ${symbol}: DB has ${dbRecord.candle_data.length} candles, last=${lastCandle?.timestamp}`);

      const candleArray = dbRecord.candle_data.map(c => [
        c.timestamp,
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume
      ]);

      const isOutdated = await isCandleDataOutdated(dbRecord.candle_data, dbTimeframe);
      console.log(`[CandleData] ${symbol}: isOutdated=${isOutdated}`);

      if (!isOutdated) {
        console.log(`[CandleData] ${symbol}: CACHED — returning ${candleArray.length} candles`);
        return candleArray;
      }

    } else {
      console.log(`[CandleData] ${symbol}: NO DB record found`);
    }

    // Step 3: Data missing or outdated - fetch from API
    console.log(`[CandleData] ${symbol}: fetching from Upstox API (${upstoxTimeframe}, 400 days)...`);
    let fetchResult = await fetchFromUpstox(instrumentKey, upstoxTimeframe, 400);
    let apiCandles = fetchResult.candles;
    let activeKey = instrumentKey;

    // If HTTP 400 (invalid instrument key), try refreshing the key from Stock DB
    if (fetchResult.status === 400 && apiCandles.length === 0) {
      console.warn(`[CandleData] ${symbol}: HTTP 400 — instrument key may be stale, looking up fresh key...`);
      const freshStock = await Stock.findOne({
        trading_symbol: symbol.toUpperCase(),
        exchange: 'NSE',
        is_active: true
      }).lean();

      if (freshStock && freshStock.instrument_key !== instrumentKey) {
        console.log(`[CandleData] ${symbol}: Key changed: ${instrumentKey} → ${freshStock.instrument_key}`);
        activeKey = freshStock.instrument_key;
        fetchResult = await fetchFromUpstox(activeKey, upstoxTimeframe, 400);
        apiCandles = fetchResult.candles;
      }
    }

    console.log(`[CandleData] ${symbol}: API returned ${apiCandles.length} candles`);

    if (apiCandles.length === 0) {
      console.warn(`[CandleData] ${symbol}: API failed for ${activeKey} — skipping (stale DB data not used)`);
      return [];
    }

    // Upstox API returns candles in ascending order (oldest first)
    const oldestApi = apiCandles[0];
    const latestApi = apiCandles[apiCandles.length - 1];
    console.log(`[CandleData] ${symbol}: API fresh ${apiCandles.length} candles, latest=${latestApi?.[0]}, oldest=${oldestApi?.[0]}`);

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
      { instrument_key: activeKey, timeframe: dbTimeframe },
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
      { upsert: true }
    );
    console.log(`[CandleData] ${symbol}: saved ${candleDataForDb.length} candles to DB`);

    // Step 5: Verify API data is actually fresh after saving
    const isStillOutdated = await isCandleDataOutdated(candleDataForDb, dbTimeframe);
    if (isStillOutdated) {
      const latestApiDateStr = typeof latestApi?.[0] === 'string' ? latestApi[0].split('T')[0] : 'unknown';
      const expectedDateStr = await MarketHoursUtil.getLastCompletedTradingDay();
      const msg = `${symbol}: API data still outdated after fetch (latest=${latestApiDateStr}, expected=${expectedDateStr})`;
      if (allowOutdated) {
        console.warn(`[CandleData] ⚠️ ${msg} — allowOutdated=true, proceeding with latest available`);
        return apiCandles;
      }
      console.error(`[CandleData] ⛔ ${msg}`);
      throw new Error(msg);
    }

    return apiCandles;

  } catch (error) {
    console.error(`[CandleData] ${symbol}: ERROR — ${error.message}`);
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
 * @param {string} symbol - Stock symbol
 * @param {string} instrumentKey - Instrument key
 * @param {string|null} referenceDate - Optional date to filter candles (YYYY-MM-DD)
 */
async function calculateStockData(symbol, instrumentKey, referenceDate = null) {
  try {
    // Get daily candles from DB or API
    let dailyCandles = await getCandleData(instrumentKey, symbol, '1d');

    // Filter candles to reference date if provided
    if (referenceDate && dailyCandles.length > 0) {
      const beforeCount = dailyCandles.length;
      dailyCandles = filterCandlesToDate(dailyCandles, referenceDate);
      console.log(`[TechnicalData] ${symbol} - Filtered daily candles to ${referenceDate}: ${beforeCount} → ${dailyCandles.length}`);
    }

    if (dailyCandles.length === 0) {
      console.warn(`[TechnicalData] ${symbol} - NO DAILY CANDLES available (instrumentKey: ${instrumentKey})`);
      return { symbol, error: 'No daily candle data available' };
    }

    console.log(`[TechnicalData] ${symbol} - Daily candles: ${dailyCandles.length}`);

    // Get weekly candles - try DB/API first, fallback to aggregation
    let weeklyCandles = await getCandleData(instrumentKey, symbol, '1w');

    // Filter weekly candles to reference date if provided
    if (referenceDate && weeklyCandles.length > 0) {
      weeklyCandles = filterCandlesToDate(weeklyCandles, referenceDate);
    }

    if (weeklyCandles.length === 0) {
      console.log(`[TechnicalData] No weekly data for ${symbol}, aggregating from daily...`);
      weeklyCandles = aggregateToWeekly(dailyCandles);
      console.log(`[TechnicalData] ${symbol} - Aggregated weekly candles: ${weeklyCandles.length}`);
    } else {
      console.log(`[TechnicalData] ${symbol} - Weekly candles from DB/API: ${weeklyCandles.length}`);
    }

    // Calculate indicators
    const dailyIndicators = indicatorsEngine.calculate(dailyCandles);
    const weeklyIndicators = weeklyCandles.length > 0 ? indicatorsEngine.calculate(weeklyCandles) : {};

    // Log weekly indicator issues
    if (weeklyCandles.length === 0) {
      console.warn(`[TechnicalData] ${symbol} - weekly_rsi NULL: no weekly candles available (even after aggregation)`);
    } else if (!weeklyIndicators.rsi14) {
      console.warn(`[TechnicalData] ${symbol} - weekly_rsi NULL: weeklyCandles=${weeklyCandles.length}, but RSI calc failed`);
    }

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
      } else {
        console.warn(`[TechnicalData] ${symbol} - weekly_change_pct NULL: currentClose=${currentClose}, weekAgoClose=${weekAgoClose}`);
      }
    } else {
      console.warn(`[TechnicalData] ${symbol} - weekly_change_pct NULL: not enough candles (need 5, have ${dailyCandles.length})`);
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
        console.log(`[Lookup] ${symbol}: NSE → ${stock.instrument_key}`);
      } else {
        const bseStock = await Stock.findOne({
          trading_symbol: symbol.toUpperCase(),
          exchange: 'BSE',
          is_active: true
        }).lean();

        if (bseStock) {
          symbolMap[symbol] = { instrumentKey: bseStock.instrument_key, name: bseStock.name };
          console.log(`[Lookup] ${symbol}: BSE → ${bseStock.instrument_key}`);
        } else {
          symbolMap[symbol] = null;
          console.warn(`[Lookup] ${symbol}: NOT FOUND in NSE or BSE`);
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

  // Get NIFTY context in parallel with concurrency-limited stock data
  const [stocks, nifty] = await Promise.all([
    pMap(symbols, API_CONCURRENCY, async (symbol) => {
      const stockInfo = symbolMap[symbol];
      if (!stockInfo) {
        return { symbol, error: 'Symbol not found in database' };
      }
      return calculateStockData(symbol, stockInfo.instrumentKey);
    }),
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
 * Returns NULL if intraday data is not from today - caller should use daily candles instead
 *
 * Intraday API Availability (IST):
 *   - Available: Until 11:59 PM IST on the same trading day
 *   - After midnight (12:01 AM IST), intraday API returns yesterday's data
 *   - In that case, this function returns null and caller should use historical daily candles
 *
 * Uses existing priceCacheService for consistent behavior
 */
async function fetchLiveIntradayData(instrumentKey) {
  try {
    const candles = await getCurrentPrice(instrumentKey, true);

    if (!candles || candles.length === 0) return null;

    const nowIST = MarketHoursUtil.toIST(new Date());
    const todayIST = nowIST.toISOString().split('T')[0];
    const latestCandle = candles[0];
    const latestCandleDate = latestCandle[0].split('T')[0];

    if (latestCandleDate !== todayIST) return null;

    const todayCandles = candles.filter(c => c[0].startsWith(todayIST));
    if (todayCandles.length === 0) return null;

    const todayFirstCandle = todayCandles[todayCandles.length - 1];
    const todayLatestCandle = todayCandles[0];

    const todayOpen = todayFirstCandle[1];
    const todayHigh = Math.max(...todayCandles.map(c => c[2]));
    const todayLow = Math.min(...todayCandles.map(c => c[3]));
    const ltp = todayLatestCandle[4];
    const todayVolume = todayCandles.reduce((sum, c) => sum + (c[5] || 0), 0);

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
 * Detect 1H swing highs/lows from hourly candles and cluster into zones.
 * A swing high is a candle whose high is higher than the 3 candles before and after it.
 * A swing low is a candle whose low is lower than the 3 candles before and after it.
 * Nearby levels within 0.5% are clustered into zones with a midpoint.
 *
 * @param {Array} candles - Sorted oldest-first 1H candles [timestamp, open, high, low, close, volume, oi]
 * @returns {{ swingHighs: number[], swingLows: number[], resistanceZones: Array<{levels: number[], midpoint: number}>, supportZones: Array<{levels: number[], midpoint: number}> }}
 */
function find1HSwingLevels(candles) {
  if (!candles || candles.length < 7) {
    console.log(`[SwingLevels] Not enough candles (${candles?.length || 0}) for swing detection — need at least 7`);
    return { swingHighs: [], swingLows: [], resistanceZones: [], supportZones: [] };
  }

  const firstDate = candles[0][0]?.split('T')[0];
  const lastDate = candles[candles.length - 1][0]?.split('T')[0];
  const firstTime = candles[0][0]?.split('T')[1]?.split('+')[0] || '';
  const lastTime = candles[candles.length - 1][0]?.split('T')[1]?.split('+')[0] || '';
  console.log(`[SwingLevels] Using ${candles.length} candles from ${firstDate} ${firstTime} to ${lastDate} ${lastTime}`);

  const swingHighs = [];
  const swingLows = [];

  // Detect swings: 3-bar lookback, 3-bar lookahead (inclusive bounds)
  for (let i = 3; i <= candles.length - 4; i++) {
    const high = candles[i][2];
    const low = candles[i][3];

    // Check swing high: candle[i] high > all 3 before and 3 after
    let isSwingHigh = true;
    for (let j = 1; j <= 3; j++) {
      if (high <= candles[i - j][2] || high <= candles[i + j][2]) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) swingHighs.push(round2(high));

    // Check swing low: candle[i] low < all 3 before and 3 after
    let isSwingLow = true;
    for (let j = 1; j <= 3; j++) {
      if (low >= candles[i - j][3] || low >= candles[i + j][3]) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) swingLows.push(round2(low));
  }

  // Cluster nearby levels within 0.5% into zones
  const clusterLevels = (levels) => {
    if (levels.length === 0) return [];
    const sorted = [...levels].sort((a, b) => a - b);
    const zones = [];
    let currentZone = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const zoneMid = currentZone.reduce((a, b) => a + b, 0) / currentZone.length;
      // Within 0.5% of zone midpoint → same zone
      if (Math.abs(sorted[i] - zoneMid) / zoneMid <= 0.005) {
        currentZone.push(sorted[i]);
      } else {
        zones.push({ levels: currentZone, midpoint: round2(currentZone.reduce((a, b) => a + b, 0) / currentZone.length) });
        currentZone = [sorted[i]];
      }
    }
    zones.push({ levels: currentZone, midpoint: round2(currentZone.reduce((a, b) => a + b, 0) / currentZone.length) });
    return zones;
  };

  const resistanceZones = clusterLevels(swingHighs);
  const supportZones = clusterLevels(swingLows);

  console.log(`[SwingLevels] Found ${swingHighs.length} swing highs → ${resistanceZones.length} resistance zones, ${swingLows.length} swing lows → ${supportZones.length} support zones`);
  if (resistanceZones.length > 0) {
    console.log(`[SwingLevels] Resistance zones: ${resistanceZones.map(z => z.midpoint).join(', ')}`);
  }
  if (supportZones.length > 0) {
    console.log(`[SwingLevels] Support zones: ${supportZones.map(z => z.midpoint).join(', ')}`);
  }

  return { swingHighs, swingLows, resistanceZones, supportZones };
}

/**
 * Fetch 1H candles from Upstox V3 and compute 1H + 4H pivot levels.
 * Used for multi-timeframe confluence scoring in daily picks.
 *
 * @param {string} instrumentKey - Upstox instrument key (e.g. NSE_EQ|INE002A01018)
 * @param {string} tradingDateStr - Timestamp from latestDailyCandle[0] (handles weekends/holidays)
 * @returns {{ hourly_1h_pivots: object|null, hourly_4h_pivots: object|null }}
 */
async function fetchHourlyPivots(instrumentKey, tradingDateStr) {
  const EMPTY = { hourly_1h_pivots: null, hourly_4h_pivots: null, swing_levels_1h: null };

  if (!instrumentKey || !tradingDateStr) return EMPTY;

  try {
    // Parse trading date — handles "2026-02-13T00:00:00+05:30" or "2026-02-13"
    const tradingDate = tradingDateStr.split('T')[0];
    // toDate = next calendar day (to catch all IST candles from trading day)
    const nextDay = new Date(tradingDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const toDate = nextDay.toISOString().split('T')[0];

    // fromDate = 10 calendar days back (covers ~7 trading days for swing detection)
    const fromDateObj = new Date(tradingDate);
    fromDateObj.setDate(fromDateObj.getDate() - 10);
    const fromDate = fromDateObj.toISOString().split('T')[0];

    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/hours/1/${toDate}/${fromDate}`;

    const response = await rateLimitedGet(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 10000
    }, { caller: 'fetchHourlyPivots' });

    const allCandles = response.data?.data?.candles || [];

    // Candles come newest-first from API. Sort oldest-first for aggregation.
    allCandles.sort((a, b) => new Date(a[0]) - new Date(b[0]));

    // Compute 1H swing levels from ALL candles (7 trading days) — must run before the trading date filter
    const swingLevels = allCandles.length > 0 ? find1HSwingLevels(allCandles) : null;

    // Filter trading date candles for 1H/4H pivot calculation (original behavior)
    const tradingDateCandles = allCandles.filter(c => c[0]?.startsWith(tradingDate));

    if (tradingDateCandles.length === 0) {
      return { hourly_1h_pivots: null, hourly_4h_pivots: null, swing_levels_1h: swingLevels };
    }

    // Candle format: [timestamp, open, high, low, close, volume, oi]
    // 1H pivot: from the LAST hourly candle of trading date
    const lastCandle = tradingDateCandles[tradingDateCandles.length - 1];
    const hourly1hPivots = calcClassicPivots(lastCandle[2], lastCandle[3], lastCandle[4]);

    // 4H pivot: aggregate last N candles of trading date (4 if available, all if 2-3, skip if < 2)
    let hourly4hPivots = null;
    if (tradingDateCandles.length >= 2) {
      const n = Math.min(4, tradingDateCandles.length);
      const slice = tradingDateCandles.slice(-n);
      const aggHigh = Math.max(...slice.map(c => c[2]));
      const aggLow = Math.min(...slice.map(c => c[3]));
      const aggClose = slice[slice.length - 1][4];
      hourly4hPivots = calcClassicPivots(aggHigh, aggLow, aggClose);
    }

    return { hourly_1h_pivots: hourly1hPivots, hourly_4h_pivots: hourly4hPivots, swing_levels_1h: swingLevels };
  } catch (error) {
    console.error(`[ENRICH-DEBUG] HourlyPivots FAILED for ${instrumentKey}: ${error.message}`);
    return EMPTY;
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
async function calculateDailyStockData(symbol, instrumentKey, bulkLivePrice = null, skipIntraday = false) {
  try {
    // Fetch historical daily candles for RSI, pivots, avg volume
    console.log(`[DailyStock] ${symbol}: calling getCandleData(${instrumentKey}, '1d')...`);
    const dailyCandles = await getCandleData(instrumentKey, symbol, '1d');
    console.log(`[DailyStock] ${symbol}: getCandleData returned ${dailyCandles.length} candles`);

    if (dailyCandles.length === 0) {
      console.log(`[DailyStock] ${symbol}: NO CANDLES — returning zeros`);
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
        avg_volume_50d: 0,
        hourly_1h_pivots: null,
        hourly_4h_pivots: null,
        swing_levels_1h: null
      };
    }

    // Calculate daily indicators from historical data
    const dailyIndicators = indicatorsEngine.calculate(dailyCandles);

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

    if (skipIntraday) {
      // Skip all intraday API calls — use daily candle data only
      open = round2(latestDailyCandle[1]) || 0;
      high = round2(latestDailyCandle[2]) || 0;
      low = round2(latestDailyCandle[3]) || 0;
      ltp = round2(latestDailyCandle[4]) || 0;
      todayVolume = latestDailyCandle[5] || 0;
      dataSource = 'DAILY';
    } else if (bulkLivePrice) {
      const liveData = await fetchLiveIntradayData(instrumentKey);
      if (liveData) {
        open = liveData.open;
        high = liveData.high;
        low = liveData.low;
        ltp = round2(bulkLivePrice);
        todayVolume = liveData.volume;
        dataSource = 'BULK+INTRADAY';
      } else {
        open = round2(latestDailyCandle[1]) || 0;
        high = round2(latestDailyCandle[2]) || 0;
        low = round2(latestDailyCandle[3]) || 0;
        ltp = round2(bulkLivePrice);
        todayVolume = latestDailyCandle[5] || 0;
        dataSource = 'BULK+DAILY';
      }
    } else {
      const liveData = await fetchLiveIntradayData(instrumentKey);
      if (liveData) {
        open = liveData.open;
        high = liveData.high;
        low = liveData.low;
        ltp = liveData.ltp;
        todayVolume = liveData.volume;
        dataSource = 'INTRADAY';
      } else {
        open = round2(latestDailyCandle[1]) || 0;
        high = round2(latestDailyCandle[2]) || 0;
        low = round2(latestDailyCandle[3]) || 0;
        ltp = round2(latestDailyCandle[4]) || 0;
        todayVolume = latestDailyCandle[5] || 0;
        dataSource = 'DAILY';
      }
    }

    // prev_close = PREVIOUS day's close (for gap detection)
    const prevClose = previousDayCandle ? round2(previousDayCandle[4]) : round2(latestDailyCandle[4]);

    // last_daily_close = close of the most recent completed daily candle
    const lastDailyClose = round2(latestDailyCandle[4]);

    // Calculate 52-week high (max high from last 252 trading days)
    const tradingDays52w = Math.min(dailyCandles.length, 252);
    const recentCandles52w = dailyCandles.slice(-tradingDays52w);
    const high52w = Math.max(...recentCandles52w.map(c => c[2]));

    // Calculate weekly pivots and trend from aggregated weekly candles
    const weeklyCandles = aggregateToWeekly(dailyCandles);
    let weeklyPivot = null;
    let weeklyEma20 = 0;
    let weeklyClose = 0;
    let weeklyTrendBullish = null; // true/false/null (null = insufficient data)
    if (weeklyCandles.length >= 2) {
      const prevWeek = weeklyCandles[weeklyCandles.length - 2];
      weeklyPivot = calcClassicPivots(prevWeek[2], prevWeek[3], prevWeek[4]);
    }
    if (weeklyCandles.length >= 20) {
      // Calculate weekly EMA20 for multi-timeframe confirmation
      const weeklyIndicators = indicatorsEngine.calculate(weeklyCandles);
      weeklyEma20 = round2(weeklyIndicators.ema20) || 0;
      weeklyClose = round2(weeklyCandles[weeklyCandles.length - 1][4]) || 0;
      weeklyTrendBullish = weeklyClose > weeklyEma20;
    }

    // Fetch hourly pivots for intraday confluence scoring
    // Always fetch — swing_levels_1h uses historical 1H candles (available after hours),
    // only 1H/4H pivots for current trading day need market open (they gracefully return null)
    const hourlyPivots = await fetchHourlyPivots(instrumentKey, latestDailyCandle[0]);

    // === FINGERPRINT: Single debug line with all scoring-critical values ===
    console.log(`[ENRICH-DEBUG] ${symbol}: src=${dataSource} candles=${dailyCandles.length} | O=${open} H=${high} L=${low} C=${ltp} prevC=${prevClose} vol=${todayVolume} avgVol50=${avgVolume50d} | RSI=${dailyIndicators.rsi14} EMA20=${dailyIndicators.ema20} ATR=${dailyIndicators.atr} | pivot=${dailyPivot?.pivot} 1hP=${hourlyPivots.hourly_1h_pivots?.pivot || 'null'} 4hP=${hourlyPivots.hourly_4h_pivots?.pivot || 'null'}`);

    return {
      symbol,
      instrument_key: instrumentKey,
      prev_close: prevClose,
      last_daily_close: lastDailyClose,
      open,
      high,
      low,
      ltp,
      daily_rsi: round2(dailyIndicators.rsi14) || 0,
      daily_pivot: dailyPivot?.pivot || 0,
      daily_s1: dailyPivot?.s1 || 0,
      daily_r1: dailyPivot?.r1 || 0,
      todays_volume: todayVolume,
      avg_volume_50d: avgVolume50d,
      latest_candle_date: latestDailyCandle[0]?.split('T')[0] || null,
      prev_candle_date: previousDayCandle ? previousDayCandle[0]?.split('T')[0] : null,
      data_source: dataSource,
      // Indicators for scan-type-specific level calculation
      ema20: round2(dailyIndicators.ema20) || 0,
      ema50: round2(dailyIndicators.ema50) || 0,
      sma200: round2(dailyIndicators.sma200) || 0,
      atr: round2(dailyIndicators.atr) || 0,
      // Swing levels for scan-type-aware stops (5D/10D for breakdown, 20D for momentum)
      high_5d: round2(dailyIndicators.high_5d) || 0,
      low_5d: round2(dailyIndicators.low_5d) || 0,
      high_10d: round2(dailyIndicators.high_10d) || 0,
      low_10d: round2(dailyIndicators.low_10d) || 0,
      high_20d: round2(dailyIndicators.high_20d) || 0,
      low_20d: round2(dailyIndicators.low_20d) || 0,
      high_52w: round2(high52w) || 0,
      daily_pivot_levels: dailyPivot,
      weekly_r1: weeklyPivot?.r1 || null,
      weekly_r2: weeklyPivot?.r2 || null,
      weekly_s1: weeklyPivot?.s1 || null,
      weekly_s2: weeklyPivot?.s2 || null,
      hourly_1h_pivots: hourlyPivots.hourly_1h_pivots,
      hourly_4h_pivots: hourlyPivots.hourly_4h_pivots,
      swing_levels_1h: hourlyPivots.swing_levels_1h,
      // Multi-timeframe: weekly trend for confirmation
      weekly_ema20: weeklyEma20,
      weekly_close: weeklyClose,
      weekly_trend_bullish: weeklyTrendBullish
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
      avg_volume_50d: 0,
      hourly_1h_pivots: null,
      hourly_4h_pivots: null,
      swing_levels_1h: null
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
export async function getDailyAnalysisData(symbols, { skipIntraday = true } = {}) {
  const startTime = Date.now();

  // Check if market is open
  const isMarketOpen = await MarketHoursUtil.isMarketOpen();
  console.log(`[DailyAnalysis] ${symbols.length} symbols, market=${isMarketOpen ? 'OPEN' : 'CLOSED'}, skipIntraday=${skipIntraday}: ${symbols.join(', ')}`);

  // Look up instrument keys
  const symbolMap = await lookupInstrumentKeys(symbols);

  // Get NIFTY data - use live intraday for current level
  const niftyKey = 'NSE_INDEX|Nifty 50';
  const [niftyCandles, niftyLive] = await Promise.all([
    getCandleData(niftyKey, 'NIFTY50', '1d'),
    skipIntraday ? Promise.resolve(null) : fetchLiveIntradayData(niftyKey)
  ]);

  let niftyLevel = 0;
  let niftyChangePct = 0;

  if (niftyCandles.length > 0) {
    const prevNifty = niftyCandles[niftyCandles.length - 1];
    const prevClose = prevNifty[4];
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
      livePriceMap = await priceCacheService.getLatestPrices(instrumentKeys);
    }
  }
  const stocks = await pMap(symbols, API_CONCURRENCY, async (symbol) => {
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
    return calculateDailyStockData(symbol, stockInfo.instrumentKey, livePrice, skipIntraday);
  });

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

export { getCandleData };

export default {
  getTechnicalData,
  getDailyAnalysisData,
  getNiftyContext,
  calculateStockData,
  getClassificationData,
  getCandleData
};
