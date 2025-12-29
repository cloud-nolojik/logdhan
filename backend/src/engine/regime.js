/**
 * Market Regime Module
 *
 * Checks overall market health to filter/warn on setups that go against the trend.
 * A bullish setup in a bearish market has much lower probability of success.
 *
 * Uses Nifty 50 as the market proxy.
 */

import { round2, isNum } from './helpers.js';

const NIFTY_50_INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';

/**
 * Regime types
 */
export const REGIME = {
  BULLISH: 'BULLISH',      // Nifty above 50 EMA
  BEARISH: 'BEARISH',      // Nifty below 50 EMA
  NEUTRAL: 'NEUTRAL',      // Within 1% of 50 EMA (choppy)
  UNKNOWN: 'UNKNOWN'       // Couldn't determine
};

/**
 * Check market regime based on Nifty 50 position relative to its 50 EMA
 *
 * @param {Object} options
 * @param {Array} options.niftyCandles - Daily candles for Nifty 50
 * @returns {Object} { regime, niftyLast, ema50, distancePct, description }
 */
export function checkMarketRegime({ niftyCandles }) {
  if (!niftyCandles || niftyCandles.length < 50) {
    return {
      regime: REGIME.UNKNOWN,
      niftyLast: null,
      ema50: null,
      distancePct: null,
      description: 'Insufficient Nifty data for regime check'
    };
  }

  // Calculate 50 EMA
  const closes = niftyCandles.map(c =>
    Array.isArray(c) ? c[4] : c.close
  );

  const ema50 = calculateEMA(closes, 50);
  const niftyLast = closes[closes.length - 1];

  if (!isNum(ema50) || !isNum(niftyLast)) {
    return {
      regime: REGIME.UNKNOWN,
      niftyLast,
      ema50,
      distancePct: null,
      description: 'Could not calculate Nifty EMA'
    };
  }

  const distancePct = round2(((niftyLast - ema50) / ema50) * 100);

  let regime;
  let description;

  if (distancePct > 1) {
    regime = REGIME.BULLISH;
    description = `Nifty ${round2(distancePct)}% above 50 EMA - bullish regime`;
  } else if (distancePct < -1) {
    regime = REGIME.BEARISH;
    description = `Nifty ${round2(Math.abs(distancePct))}% below 50 EMA - bearish regime`;
  } else {
    regime = REGIME.NEUTRAL;
    description = `Nifty within 1% of 50 EMA - neutral/choppy regime`;
  }

  return {
    regime,
    niftyLast: round2(niftyLast),
    ema50: round2(ema50),
    distancePct,
    description
  };
}

/**
 * Calculate EMA for an array of values
 * @param {Array<number>} data - Price data (oldest first)
 * @param {number} period - EMA period
 * @returns {number} - EMA value
 */
function calculateEMA(data, period) {
  if (!data || data.length < period) return null;

  const k = 2 / (period + 1);

  // Start with SMA for initial EMA value
  let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;

  // Calculate EMA for remaining values
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }

  return ema;
}

/**
 * Generate warning if setup conflicts with market regime
 *
 * @param {string} setupType - 'BUY' or 'SELL'
 * @param {Object} regimeCheck - Result from checkMarketRegime()
 * @returns {Object|null} Warning object or null if no conflict
 */
export function getRegimeWarning(setupType, regimeCheck) {
  if (!regimeCheck || regimeCheck.regime === REGIME.UNKNOWN) {
    return null;
  }

  const { regime, distancePct, description } = regimeCheck;

  // BUY in bearish market
  if (setupType === 'BUY' && regime === REGIME.BEARISH) {
    return {
      code: 'BEARISH_REGIME',
      severity: 'high',
      text: `Market is ${Math.abs(distancePct)}% below 50 EMA — bullish setups have lower success rates in bearish regimes`,
      applies_when: ['entry'],
      mitigation: [
        'Reduce position size by 50%',
        'Wait for Nifty to reclaim 50 EMA before aggressive buying',
        'Focus on defensive sectors or cash'
      ]
    };
  }

  // SELL (short) in bullish market - less common but worth flagging
  if (setupType === 'SELL' && regime === REGIME.BULLISH) {
    return {
      code: 'BULLISH_REGIME',
      severity: 'medium',
      text: `Market is ${distancePct}% above 50 EMA — bearish setups often fail in strong uptrends`,
      applies_when: ['entry'],
      mitigation: [
        'Avoid counter-trend shorts in strong markets',
        'If shorting, use tight stops'
      ]
    };
  }

  // Neutral regime - add caution for any setup
  if (regime === REGIME.NEUTRAL) {
    return {
      code: 'CHOPPY_REGIME',
      severity: 'low',
      text: 'Market is near 50 EMA — choppy conditions, breakouts may fail',
      applies_when: ['entry'],
      mitigation: [
        'Wait for clear direction before committing',
        'Reduce position size in range-bound markets'
      ]
    };
  }

  return null;
}

/**
 * Fetch Nifty candles and check regime
 * This is a convenience function that handles the data fetching
 *
 * @returns {Promise<Object>} Regime check result
 */
export async function fetchAndCheckRegime() {
  try {
    // Dynamic import to avoid circular dependencies
    const { default: PreFetchedData } = await import('../models/preFetchedData.js');

    // Try to get Nifty data from PreFetchedData first
    const niftyPrefetch = await PreFetchedData.findOne({
      instrument_key: NIFTY_50_INSTRUMENT_KEY,
      timeframe: '1d'
    }).lean();

    if (niftyPrefetch?.candle_data?.length >= 50) {
      return checkMarketRegime({ niftyCandles: niftyPrefetch.candle_data });
    }

    // Fallback: Fetch from API
    const { default: candleFetcherService } = await import('../services/candleFetcher.service.js');

    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 90); // 90 days to ensure 50+ trading days

    const formatDate = (d) => d.toISOString().split('T')[0];

    const candles = await candleFetcherService.fetchCandlesFromAPI(
      NIFTY_50_INSTRUMENT_KEY,
      'day',
      formatDate(fromDate),
      formatDate(toDate),
      true
    );

    if (candles && candles.length >= 50) {
      const result = checkMarketRegime({ niftyCandles: candles });
      console.log(`[REGIME] ${result.description}`);
      return result;
    }

    console.warn('[REGIME] Could not fetch sufficient Nifty data');
    return {
      regime: REGIME.UNKNOWN,
      niftyLast: null,
      ema50: null,
      distancePct: null,
      description: 'Could not fetch Nifty data for regime check'
    };

  } catch (error) {
    console.error('[REGIME] Error checking market regime:', error.message);
    return {
      regime: REGIME.UNKNOWN,
      niftyLast: null,
      ema50: null,
      distancePct: null,
      description: `Regime check failed: ${error.message}`
    };
  }
}

export default {
  REGIME,
  checkMarketRegime,
  getRegimeWarning,
  fetchAndCheckRegime
};
