/**
 * Legacy regime labels and per-setup warning lookups.
 *
 * Broad-market regime DETECTION is owned by engine/regimeV2.js (continuous score).
 * This file now holds only:
 *   - REGIME enum — legacy label strings consumed by sectorRegime.js for sector classification
 *   - getRegimeWarning() — per-candidate (BUY / SELL) warning message lookup, called from
 *     dailyPicks Step 4 when a pick is counter-regime
 */

/**
 * Regime labels — 5-tier.
 * Used by sector-level regime classification (sectorRegime.js) and by the warning lookup below.
 */
export const REGIME = {
  STRONG_BULLISH: 'STRONG_BULLISH',  // >3% above EMA50
  BULLISH: 'BULLISH',                // 1–3% above EMA50
  NEUTRAL: 'NEUTRAL',                // ±1% of EMA50
  BEARISH: 'BEARISH',                // 1–3% below EMA50
  STRONG_BEARISH: 'STRONG_BEARISH',  // >3% below EMA50
  UNKNOWN: 'UNKNOWN'
};

/**
 * Generate warning if setup conflicts with market regime.
 *
 * @param {string} setupType - 'BUY' or 'SELL'
 * @param {Object} regimeCheck - { regime, distancePct }
 * @returns {Object|null} Warning object or null if no conflict
 */
export function getRegimeWarning(setupType, regimeCheck) {
  if (!regimeCheck || regimeCheck.regime === REGIME.UNKNOWN) {
    return null;
  }

  const { regime, distancePct } = regimeCheck;

  // BUY in strong bearish market — CRITICAL
  if (setupType === 'BUY' && regime === REGIME.STRONG_BEARISH) {
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

  // SELL in strong bullish market — CRITICAL
  if (setupType === 'SELL' && regime === REGIME.STRONG_BULLISH) {
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

export default {
  REGIME,
  getRegimeWarning
};
