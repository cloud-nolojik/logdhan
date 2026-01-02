/**
 * Intraday Analysis Engine
 *
 * Calculates ATR-based intraday levels with news-adjusted multipliers.
 * Used for pre-market analysis (8:30 AM IST) based on previous day's close.
 */

import { round2 } from './index.js';

/**
 * ATR multipliers based on news impact
 */
const ATR_MULTIPLIERS = {
  HIGH: 1.75,    // Results, fraud, SEBI, major deals → expect 1.75x normal move
  MEDIUM: 1.25,  // Order wins, contracts, routine announcements
  LOW: 1.0       // General mentions, sector news
};

/**
 * Calculate ATR (Average True Range) from daily candles
 * @param {Array<{ high: number, low: number, close: number }>} candles - Last 14+ daily candles
 * @param {number} period - ATR period (default 14)
 * @returns {number} ATR value
 */
export function calculateATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    console.warn(`[IntradayEngine] Insufficient candles for ATR: ${candles?.length || 0} < ${period + 1}`);
    return null;
  }

  // Calculate True Range for each candle
  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,                    // High - Low
      Math.abs(current.high - previous.close),       // |High - Prev Close|
      Math.abs(current.low - previous.close)         // |Low - Prev Close|
    );

    trueRanges.push(tr);
  }

  // Calculate ATR as SMA of True Ranges
  const recentTRs = trueRanges.slice(-period);
  const atr = recentTRs.reduce((sum, tr) => sum + tr, 0) / recentTRs.length;

  return round2(atr);
}

/**
 * Calculate pivot points (for reference only, not used for entry/SL/target)
 * @param {{ high: number, low: number, close: number }} candle - Previous day candle
 * @returns {{ P: number, R1: number, R2: number, S1: number, S2: number }}
 */
export function calculatePivotPoints(candle) {
  const { high, low, close } = candle;

  const P = round2((high + low + close) / 3);
  const R1 = round2(2 * P - low);
  const R2 = round2(P + (high - low));
  const S1 = round2(2 * P - high);
  const S2 = round2(P - (high - low));

  return { P, R1, R2, S1, S2 };
}

/**
 * Calculate intraday levels based on ATR and news sentiment
 * @param {Object} params
 * @param {{ high: number, low: number, close: number }} params.prevDayCandle - Previous day OHLC
 * @param {number} params.atr14 - 14-day ATR
 * @param {string} params.sentiment - 'BULLISH' | 'BEARISH' | 'NEUTRAL'
 * @param {string} params.newsImpact - 'HIGH' | 'MEDIUM' | 'LOW'
 * @param {number} [params.openingPrice] - Opening price (if available, post 9:15 AM)
 * @returns {Object} Intraday levels with direction
 */
export function calculateIntradayLevels({
  prevDayCandle,
  atr14,
  sentiment,
  newsImpact,
  openingPrice = null
}) {
  if (!prevDayCandle || !atr14) {
    return {
      direction: 'NEUTRAL',
      error: 'Missing required data (prevDayCandle or atr14)',
      base_price: prevDayCandle?.close || null,
      atr: atr14
    };
  }

  const prevClose = prevDayCandle.close;

  // Get ATR multiplier based on news impact
  const atrMultiplier = ATR_MULTIPLIERS[newsImpact] || 1.0;
  const adjustedATR = round2(atr14 * atrMultiplier);

  // Gap detection (if opening price available - post 9:15 AM)
  if (openingPrice) {
    const gap = Math.abs(openingPrice - prevClose);
    if (gap > 1.2 * adjustedATR) {
      return {
        direction: 'AVOID',
        reason: 'Gap too wide for safe entry',
        gap_amount: round2(gap),
        gap_pct: round2((gap / prevClose) * 100),
        gap_vs_atr: round2(gap / adjustedATR),
        prev_close: prevClose,
        opening_price: openingPrice,
        atr: atr14,
        adjusted_atr: adjustedATR
      };
    }
  }

  // Determine direction from sentiment
  let direction;
  if (sentiment === 'BEARISH') {
    direction = 'SELL';
  } else if (sentiment === 'BULLISH') {
    direction = 'BUY';
  } else {
    direction = 'NEUTRAL';
  }

  // Calculate entry zone (±0.3 ATR from prev close)
  const entryZoneLow = round2(prevClose - 0.3 * adjustedATR);
  const entryZoneHigh = round2(prevClose + 0.3 * adjustedATR);

  // Calculate pivot points for reference
  const pivots = calculatePivotPoints(prevDayCandle);

  // Build response based on direction
  if (direction === 'BUY') {
    return {
      direction: 'BUY',
      base_price: prevClose,
      entry: prevClose,
      entry_zone: {
        low: entryZoneLow,
        high: entryZoneHigh
      },
      stop_loss: round2(prevClose - 1.0 * adjustedATR),
      target_1: round2(prevClose + 1.2 * adjustedATR),
      target_2: round2(prevClose + 2.0 * adjustedATR),
      atr: atr14,
      adjusted_atr: adjustedATR,
      atr_multiplier: atrMultiplier,
      news_impact: newsImpact,
      risk_reward: '1:1.2 to 1:2',
      pivots,
      pivots_note: 'Reference only - not used for levels'
    };
  } else if (direction === 'SELL') {
    return {
      direction: 'SELL',
      base_price: prevClose,
      entry: prevClose,
      entry_zone: {
        low: entryZoneLow,
        high: entryZoneHigh
      },
      stop_loss: round2(prevClose + 1.0 * adjustedATR),
      target_1: round2(prevClose - 1.2 * adjustedATR),
      target_2: round2(prevClose - 2.0 * adjustedATR),
      atr: atr14,
      adjusted_atr: adjustedATR,
      atr_multiplier: atrMultiplier,
      news_impact: newsImpact,
      risk_reward: '1:1.2 to 1:2',
      pivots,
      pivots_note: 'Reference only - not used for levels'
    };
  } else {
    // NEUTRAL - no directional trade
    return {
      direction: 'NEUTRAL',
      message: 'News sentiment unclear - no trade recommendation',
      base_price: prevClose,
      entry_zone: {
        low: entryZoneLow,
        high: entryZoneHigh
      },
      atr: atr14,
      adjusted_atr: adjustedATR,
      news_impact: newsImpact,
      pivots,
      pivots_note: 'Reference only'
    };
  }
}

/**
 * Calculate valid_until timestamp for intraday analysis cache
 * Analysis is valid until next market open (9:15 AM IST)
 * @param {Date} scrapeDate - Date of the scrape (IST date as UTC)
 * @returns {Date} valid_until timestamp in UTC
 */
export function calculateValidUntil(scrapeDate) {
  // Find next trading day
  let nextTradingDay = new Date(scrapeDate);
  nextTradingDay.setDate(nextTradingDay.getDate() + 1);

  // Skip weekends
  while (isWeekend(nextTradingDay)) {
    nextTradingDay.setDate(nextTradingDay.getDate() + 1);
  }

  // Set to 9:15 AM IST = 3:45 AM UTC
  const validUntilUTC = new Date(nextTradingDay);
  validUntilUTC.setUTCHours(3, 45, 0, 0);

  return validUntilUTC;
}

/**
 * Check if a date is a weekend
 * @param {Date} date
 * @returns {boolean}
 */
function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6; // Sunday = 0, Saturday = 6
}

/**
 * Check if intraday analysis is still valid
 * @param {Object} analysis - Analysis document with valid_until field
 * @returns {boolean}
 */
export function isIntradayAnalysisValid(analysis) {
  if (!analysis || !analysis.valid_until) return false;

  const now = new Date();
  const validUntil = new Date(analysis.valid_until);

  return now < validUntil;
}

/**
 * Get next market open time (9:15 AM IST) in UTC
 * @param {Date} [fromDate] - Starting date (defaults to now)
 * @returns {Date} Next market open in UTC
 */
export function getNextMarketOpen(fromDate = new Date()) {
  // Convert to IST for day calculation
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(fromDate.getTime() + istOffset);

  let nextOpen = new Date(istNow);

  // Get current IST hour
  const istHour = istNow.getUTCHours();
  const istMinute = istNow.getUTCMinutes();

  // If already past 9:15 AM IST today, move to next day
  if (istHour > 9 || (istHour === 9 && istMinute >= 15)) {
    nextOpen.setUTCDate(nextOpen.getUTCDate() + 1);
  }

  // Skip weekends
  while (isWeekend(nextOpen)) {
    nextOpen.setUTCDate(nextOpen.getUTCDate() + 1);
  }

  // Set to 9:15 AM IST = 3:45 AM UTC
  const nextOpenUTC = new Date(nextOpen);
  nextOpenUTC.setUTCHours(3, 45, 0, 0);

  return nextOpenUTC;
}

export default {
  calculateATR,
  calculatePivotPoints,
  calculateIntradayLevels,
  calculateValidUntil,
  isIntradayAnalysisValid,
  getNextMarketOpen,
  ATR_MULTIPLIERS
};
