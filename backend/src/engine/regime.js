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
 * Regime types — 5-tier model
 *
 * STRONG tiers (>3% from EMA50): hard-block counter-regime scans (crash/euphoria safety net)
 * Normal tiers (1-3%): all scans run, aligned scans get +5 score bonus
 * NEUTRAL (±1%): all scans run, no bonus
 */
export const REGIME = {
  STRONG_BULLISH: 'STRONG_BULLISH',  // Nifty >3% above 50 EMA — block bearish scans
  BULLISH: 'BULLISH',                // Nifty 1-3% above 50 EMA — +5 bonus to bullish
  NEUTRAL: 'NEUTRAL',                // Within ±1% of 50 EMA (choppy)
  BEARISH: 'BEARISH',                // Nifty 1-3% below 50 EMA — +5 bonus to bearish
  STRONG_BEARISH: 'STRONG_BEARISH',  // Nifty >3% below 50 EMA — block bullish scans
  UNKNOWN: 'UNKNOWN'                 // Couldn't determine
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

  if (distancePct > 3) {
    regime = REGIME.STRONG_BULLISH;
    description = `Nifty ${round2(distancePct)}% above 50 EMA — strong bullish (bearish scans blocked)`;
  } else if (distancePct > 1) {
    regime = REGIME.BULLISH;
    description = `Nifty ${round2(distancePct)}% above 50 EMA — bullish (+5 bonus to aligned)`;
  } else if (distancePct < -3) {
    regime = REGIME.STRONG_BEARISH;
    description = `Nifty ${round2(Math.abs(distancePct))}% below 50 EMA — strong bearish (bullish scans blocked)`;
  } else if (distancePct < -1) {
    regime = REGIME.BEARISH;
    description = `Nifty ${round2(Math.abs(distancePct))}% below 50 EMA — bearish (+5 bonus to aligned)`;
  } else {
    regime = REGIME.NEUTRAL;
    description = `Nifty within 1% of 50 EMA — neutral/choppy`;
  }

  console.log(`[REGIME] ═══════════════════════════════════════`);
  console.log(`[REGIME] Nifty last=${round2(niftyLast)} EMA50=${round2(ema50)} distance=${distancePct}%`);
  console.log(`[REGIME] Regime: ${regime} — ${description}`);
  console.log(`[REGIME] ═══════════════════════════════════════`);

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
    console.log(`[REGIME] getRegimeWarning(${setupType}): no regime data — skipping`);
    return null;
  }

  const { regime, distancePct } = regimeCheck;

  // BUY in strong bearish market — CRITICAL (scans blocked)
  if (setupType === 'BUY' && regime === REGIME.STRONG_BEARISH) {
    console.log(`[REGIME] ⛔ CRITICAL: ${setupType} in ${regime} (${distancePct}% from EMA50) — BLOCKED`);
    return {
      code: 'STRONG_BEARISH_REGIME',
      severity: 'critical',
      text: `Market is ${Math.abs(distancePct)}% below 50 EMA — bullish scans blocked in crash conditions`,
      applies_when: ['entry'],
      mitigation: [
        'Do not initiate long positions',
        'Wait for Nifty to recover above -3% from 50 EMA',
        'Focus on cash preservation'
      ]
    };
  }

  // BUY in bearish market
  if (setupType === 'BUY' && regime === REGIME.BEARISH) {
    console.log(`[REGIME] ⚠️ HIGH: ${setupType} in ${regime} (${distancePct}% from EMA50) — reduce 50%`);
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

  // SELL in strong bullish market — CRITICAL (scans blocked)
  if (setupType === 'SELL' && regime === REGIME.STRONG_BULLISH) {
    console.log(`[REGIME] ⛔ CRITICAL: ${setupType} in ${regime} (${distancePct}% from EMA50) — BLOCKED`);
    return {
      code: 'STRONG_BULLISH_REGIME',
      severity: 'critical',
      text: `Market is ${distancePct}% above 50 EMA — bearish scans blocked in euphoric conditions`,
      applies_when: ['entry'],
      mitigation: [
        'Do not initiate short positions',
        'Wait for Nifty to cool below +3% from 50 EMA',
        'Focus on riding the trend or cash'
      ]
    };
  }

  // SELL (short) in bullish market
  if (setupType === 'SELL' && regime === REGIME.BULLISH) {
    console.log(`[REGIME] ⚠️ MEDIUM: ${setupType} in ${regime} (${distancePct}% from EMA50) — use tight stops`);
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
    console.log(`[REGIME] Warning: ${setupType} in NEUTRAL regime — choppy conditions (severity: low)`);
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

  console.log(`[REGIME] ${setupType} aligned with ${regime} regime — no warning`);
  return null;
}

/**
 * Fetch Nifty candles and check regime
 * This is a convenience function that handles the data fetching
 *
 * @returns {Promise<Object>} Regime check result
 */
export async function fetchAndCheckRegime({ allowOutdated = false } = {}) {
  try {
    // Use getCandleData which handles DB cache, outdated checks, and Cloudflare cache-busting
    const { getCandleData } = await import('../services/technicalData.service.js');

    const candles = await getCandleData(NIFTY_50_INSTRUMENT_KEY, 'NIFTY50', '1d', { allowOutdated });

    if (candles && candles.length >= 50) {
      return checkMarketRegime({ niftyCandles: candles });
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
