/**
 * Technical Indicators Module
 *
 * Single source of truth for all technical indicator calculations.
 * Uses technicalindicators library for core calculations.
 */

import * as TI from 'technicalindicators';
import { round2, normalizeCandles, extractOHLCV, last, lastN, max, min, average } from './helpers.js';

/**
 * Minimum candle requirements for each indicator
 */
export const MIN_BARS = {
  EMA20: 20,
  EMA50: 50,
  SMA20: 20,
  SMA50: 50,
  SMA200: 200,
  RSI: 14,
  ATR: 14,
  ADX: 14,
  MACD: 26,
  STOCHASTIC: 14,
  BOLLINGER: 20,
  VWAP: 20
};

/**
 * Calculate all technical indicators from candle data
 *
 * @param {Array} candles - Array of candles (any format)
 * @param {Object} options - Optional settings
 * @returns {Object} All calculated indicators
 */
export function calculate(candles, options = {}) {
  const normalized = normalizeCandles(candles);

  if (normalized.length === 0) {
    return { error: 'No valid candle data provided' };
  }

  const { opens, highs, lows, closes, volumes } = extractOHLCV(normalized);
  const indicators = {};

  try {
    // Moving Averages
    calculateMovingAverages(closes, indicators);

    // Momentum Indicators
    calculateMomentumIndicators(closes, highs, lows, indicators);

    // Volatility Indicators
    calculateVolatilityIndicators(closes, highs, lows, indicators);

    // Volume Indicators
    calculateVolumeIndicators(closes, highs, lows, volumes, indicators);

    // Swing Levels (from candle data)
    calculateSwingLevels(normalized, indicators);

    // Current Price Info
    const lastCandle = last(normalized);
    if (lastCandle) {
      indicators.last = lastCandle.close;
      indicators.open = lastCandle.open;
      indicators.high = lastCandle.high;
      indicators.low = lastCandle.low;
      indicators.close = lastCandle.close;
      indicators.volume = lastCandle.volume;
    }

  } catch (error) {
    console.error('Error calculating indicators:', error);
    indicators.error = error.message;
  }

  return indicators;
}

/**
 * Calculate Moving Averages (EMA, SMA)
 */
function calculateMovingAverages(closes, indicators) {
  // EMA 20
  if (closes.length >= MIN_BARS.EMA20) {
    const ema20 = TI.EMA.calculate({ period: 20, values: closes });
    const value = round2(last(ema20));
    indicators.ema20 = value;
    indicators.ema20_1D = value;
  }

  // EMA 50
  if (closes.length >= MIN_BARS.EMA50) {
    const ema50 = TI.EMA.calculate({ period: 50, values: closes });
    const value = round2(last(ema50));
    indicators.ema50 = value;
    indicators.ema50_1D = value;
  }

  // SMA 20
  if (closes.length >= MIN_BARS.SMA20) {
    const sma20 = TI.SMA.calculate({ period: 20, values: closes });
    const value = round2(last(sma20));
    indicators.sma20 = value;
    indicators.sma20_1D = value;
    // Alias for backward compatibility
    indicators.dma20 = value;
  }

  // SMA 50
  if (closes.length >= MIN_BARS.SMA50) {
    const sma50 = TI.SMA.calculate({ period: 50, values: closes });
    const value = round2(last(sma50));
    indicators.sma50 = value;
    indicators.sma50_1D = value;
    indicators.dma50 = value;
  }

  // SMA 200
  if (closes.length >= MIN_BARS.SMA200) {
    const sma200 = TI.SMA.calculate({ period: 200, values: closes });
    const value = round2(last(sma200));
    indicators.sma200 = value;
    indicators.sma200_1D = value;
    indicators.dma200 = value;
  }
}

/**
 * Calculate Momentum Indicators (RSI, MACD, Stochastic)
 */
function calculateMomentumIndicators(closes, highs, lows, indicators) {
  // RSI 14
  if (closes.length >= MIN_BARS.RSI) {
    const rsi = TI.RSI.calculate({ period: 14, values: closes });
    const value = round2(last(rsi));
    indicators.rsi = value;
    indicators.rsi14 = value;
    indicators.rsi14_1D = value;
  }

  // MACD
  if (closes.length >= MIN_BARS.MACD) {
    const macd = TI.MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    });
    if (macd.length > 0) {
      const latest = last(macd);
      indicators.macd = round2(latest.MACD);
      indicators.macd_signal = round2(latest.signal);
      indicators.macd_histogram = round2(latest.histogram);
    }
  }

  // Stochastic
  if (closes.length >= MIN_BARS.STOCHASTIC) {
    const stoch = TI.Stochastic.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14,
      signalPeriod: 3
    });
    if (stoch.length > 0) {
      const latest = last(stoch);
      indicators.stochastic_k = round2(latest.k);
      indicators.stochastic_d = round2(latest.d);
    }
  }

  // ADX
  if (closes.length >= MIN_BARS.ADX) {
    const adx = TI.ADX.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14
    });
    if (adx.length > 0) {
      const latest = last(adx);
      indicators.adx = round2(latest.adx);
      indicators.adx14 = round2(latest.adx);
      indicators.pdi = round2(latest.pdi);
      indicators.mdi = round2(latest.mdi);
    }
  }
}

/**
 * Calculate Volatility Indicators (ATR, Bollinger Bands)
 */
function calculateVolatilityIndicators(closes, highs, lows, indicators) {
  // ATR 14
  if (closes.length >= MIN_BARS.ATR) {
    const atr = TI.ATR.calculate({
      high: highs,
      low: lows,
      close: closes,
      period: 14
    });
    if (atr.length > 0) {
      const value = round2(last(atr));
      indicators.atr = value;
      indicators.atr14 = value;
      indicators.atr14_1D = value;

      // ATR as percentage of price
      if (indicators.last) {
        indicators.atr_pct = round2((value / indicators.last) * 100);
      }
    }
  }

  // Bollinger Bands
  if (closes.length >= MIN_BARS.BOLLINGER) {
    const bb = TI.BollingerBands.calculate({
      period: 20,
      values: closes,
      stdDev: 2
    });
    if (bb.length > 0) {
      const latest = last(bb);
      indicators.bb_upper = round2(latest.upper);
      indicators.bb_middle = round2(latest.middle);
      indicators.bb_lower = round2(latest.lower);
      indicators.bb_width = round2(latest.upper - latest.lower);
    }
  }
}

/**
 * Calculate Volume Indicators (VWAP, Volume vs Average)
 */
function calculateVolumeIndicators(closes, highs, lows, volumes, indicators) {
  // VWAP (simplified - uses last 20 bars)
  if (volumes.length >= MIN_BARS.VWAP) {
    const recentCount = Math.min(20, closes.length);
    let sumPriceVolume = 0;
    let sumVolume = 0;

    for (let i = 0; i < recentCount; i++) {
      const idx = closes.length - 1 - i;
      const typicalPrice = (highs[idx] + lows[idx] + closes[idx]) / 3;
      sumPriceVolume += typicalPrice * volumes[idx];
      sumVolume += volumes[idx];
    }

    if (sumVolume > 0) {
      indicators.vwap = round2(sumPriceVolume / sumVolume);
    }
  }

  // Volume vs 20-day average
  if (volumes.length >= 20) {
    const recent20Volumes = lastN(volumes, 20);
    const avgVolume = average(recent20Volumes);
    const currentVolume = last(volumes);

    indicators.volume_20avg = round2(avgVolume);
    indicators.volume_vs_avg = avgVolume > 0 ? round2(currentVolume / avgVolume) : 1;
  }
}

/**
 * Calculate Swing Levels (High/Low over periods)
 */
function calculateSwingLevels(candles, indicators) {
  // 20-day swing levels
  if (candles.length >= 20) {
    const recent20 = lastN(candles, 20);
    indicators.high_20d = round2(max(recent20.map(c => c.high)));
    indicators.low_20d = round2(min(recent20.map(c => c.low)));
  }

  // 50-day swing levels
  if (candles.length >= 50) {
    const recent50 = lastN(candles, 50);
    indicators.high_50d = round2(max(recent50.map(c => c.high)));
    indicators.low_50d = round2(min(recent50.map(c => c.low)));
  }

  // Previous session (last complete candle)
  if (candles.length >= 2) {
    const prevCandle = candles[candles.length - 2];
    indicators.prev_high = round2(prevCandle.high);
    indicators.prev_low = round2(prevCandle.low);
    indicators.prev_close = round2(prevCandle.close);
  }

  // 1-month return (approx 22 trading days)
  if (candles.length >= 22) {
    const currentClose = last(candles).close;
    const pastClose = candles[candles.length - 22].close;
    indicators.return_1m = round2(((currentClose - pastClose) / pastClose) * 100);
  }

  // Distance from 20 DMA
  if (indicators.dma20 && indicators.last) {
    indicators.distance_from_20dma_pct = round2(
      ((indicators.last - indicators.dma20) / indicators.dma20) * 100
    );
  }
}

/**
 * Determine trend from indicators
 *
 * @param {Object} indicators - Calculated indicators
 * @returns {string} "BULLISH" | "BEARISH" | "NEUTRAL"
 */
export function determineTrend(indicators) {
  const { last, ema20, ema50, sma200 } = indicators;

  if (!last) return 'NEUTRAL';

  // Bullish: Price > SMA200 AND EMA20 > EMA50
  if (sma200 && ema20 && ema50) {
    if (last > sma200 && ema20 > ema50) return 'BULLISH';
    if (last < sma200 && ema20 < ema50) return 'BEARISH';
  }

  // Fallback: just use price vs EMA20
  if (ema20) {
    if (last > ema20 * 1.02) return 'BULLISH';
    if (last < ema20 * 0.98) return 'BEARISH';
  }

  return 'NEUTRAL';
}

/**
 * Determine volatility level from ATR
 *
 * @param {Object} indicators - Calculated indicators
 * @returns {string} "LOW" | "MEDIUM" | "HIGH"
 */
export function determineVolatility(indicators) {
  const { atr_pct } = indicators;

  if (!atr_pct) return 'MEDIUM';

  if (atr_pct < 1) return 'LOW';
  if (atr_pct > 2) return 'HIGH';
  return 'MEDIUM';
}

/**
 * Determine volume classification
 *
 * @param {Object} indicators - Calculated indicators
 * @returns {string} "ABOVE_AVERAGE" | "AVERAGE" | "BELOW_AVERAGE"
 */
export function determineVolumeClassification(indicators) {
  const { volume_vs_avg } = indicators;

  if (!volume_vs_avg) return 'AVERAGE';

  if (volume_vs_avg >= 1.3) return 'ABOVE_AVERAGE';
  if (volume_vs_avg <= 0.7) return 'BELOW_AVERAGE';
  return 'AVERAGE';
}

/**
 * Check data health - which indicators are available
 *
 * @param {Object} indicators - Calculated indicators
 * @returns {Object} { ok, missing, available }
 */
export function checkDataHealth(indicators) {
  const required = ['last', 'ema20', 'atr'];
  const recommended = ['sma200', 'ema50', 'rsi', 'prev_high', 'prev_low', 'prev_close'];

  const missing = [];
  const available = [];

  for (const field of [...required, ...recommended]) {
    if (indicators[field] !== undefined && indicators[field] !== null) {
      available.push(field);
    } else {
      missing.push(field);
    }
  }

  const requiredMissing = required.filter(f => missing.includes(f));
  const ok = requiredMissing.length === 0;

  return {
    ok,
    missing,
    available,
    requiredMissing
  };
}

export default {
  calculate,
  determineTrend,
  determineVolatility,
  determineVolumeClassification,
  checkDataHealth,
  MIN_BARS
};
