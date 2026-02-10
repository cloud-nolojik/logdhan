/**
 * Daily Picks — ChartInk Scan Formulas
 *
 * 6 scans for next-day +2% trade candidates.
 * Bullish scans (1-3): run in BULLISH/NEUTRAL market regimes.
 * Bearish scans (4-6): run in BEARISH/NEUTRAL market regimes.
 *
 * ChartInk returns: { nsecode, bsecode, name, per_change, close, volume }
 * Enrichment (OHLCV, indicators) happens separately via Upstox.
 */

export const DAILY_SCANS = {
  // ═══════════════════════════════════════════════════════════════
  // BULLISH SCANS — Stocks likely to move 2%+ UP today
  // ═══════════════════════════════════════════════════════════════

  // Scan 1: Volatility Compression Bullish
  // Range narrowing for 2 days in an uptrend = spring loaded for expansion
  // WHY IT WORKS: Energy builds during compression, releases as breakout
  compression_bullish: {
    type: 'bullish',
    query: `( {cash} (
      1 day ago high - 1 day ago low < 2 days ago high - 2 days ago low and
      2 days ago high - 2 days ago low < 3 days ago high - 3 days ago low and
      1 day ago close > 1 day ago open and
      1 day ago close > 1 day ago ema( close, 20 ) and
      1 day ago ema( close, 20 ) > 1 day ago ema( close, 50 ) and
      1 day ago close > 1 day ago sma( close, 200 ) and
      1 day ago rsi( 14 ) > 45 and
      1 day ago rsi( 14 ) < 65 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      3 days ago high - 3 days ago low > 3 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 2: Pullback at EMA20 Support — Ready to bounce
  // Stock pulled back to EMA20 on LOW volume in an uptrend
  pullback_at_support: {
    type: 'bullish',
    query: `( {cash} (
      1 day ago low <= 1 day ago ema( close, 20 ) * 1.01 and
      1 day ago close >= 1 day ago ema( close, 20 ) * 0.98 and
      1 day ago close > 1 day ago sma( close, 200 ) and
      1 day ago ema( close, 20 ) > 1 day ago ema( close, 50 ) and
      1 day ago ema( close, 50 ) > 1 day ago sma( close, 200 ) and
      1 day ago volume < 1 day ago sma( volume, 50 ) and
      1 day ago rsi( 14 ) > 35 and
      1 day ago rsi( 14 ) < 55 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      3 days ago high - 3 days ago low > 3 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 3: Momentum Carry — Yesterday closed at high with strong volume
  // Buyers still in control, likely gap up or continuation today
  momentum_carry: {
    type: 'bullish',
    query: `( {cash} (
      1 day ago close >= 1 day ago high * 0.98 and
      1 day ago close > 1 day ago open and
      1 day ago close > 2 days ago close * 1.01 and
      1 day ago volume > 1 day ago sma( volume, 50 ) * 1.5 and
      1 day ago rsi( 14 ) > 55 and
      1 day ago rsi( 14 ) < 72 and
      1 day ago ema( close, 20 ) > 1 day ago ema( close, 50 ) and
      1 day ago close > 1 day ago sma( close, 200 ) and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      3 days ago high - 3 days ago low > 3 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 4: Breakout Setup — Sitting just below 20-day high
  // One push away from breakout, coiling near resistance
  breakout_setup: {
    type: 'bullish',
    query: `( {cash} (
      1 day ago close > 1 day ago max( 20, high ) * 0.97 and
      1 day ago close <= 1 day ago max( 20, high ) and
      1 day ago close > 1 day ago open and
      1 day ago ema( close, 20 ) > 1 day ago ema( close, 50 ) and
      1 day ago rsi( 14 ) > 50 and
      1 day ago rsi( 14 ) < 68 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      3 days ago high - 3 days ago low > 3 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // ═══════════════════════════════════════════════════════════════
  // BEARISH SCANS — Stocks likely to move 2%+ DOWN today
  // ═══════════════════════════════════════════════════════════════

  // Scan 5: Volatility Compression Bearish
  // Range narrowing in a downtrend = about to break down further
  compression_bearish: {
    type: 'bearish',
    query: `( {cash} (
      1 day ago high - 1 day ago low < 2 days ago high - 2 days ago low and
      2 days ago high - 2 days ago low < 3 days ago high - 3 days ago low and
      1 day ago close < 1 day ago open and
      1 day ago close < 1 day ago ema( close, 20 ) and
      1 day ago ema( close, 20 ) < 1 day ago ema( close, 50 ) and
      1 day ago rsi( 14 ) > 35 and
      1 day ago rsi( 14 ) < 50 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      3 days ago high - 3 days ago low > 3 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 6: Failed at EMA20 Resistance
  // Tried to rally to EMA20, got rejected, closed red on low volume
  failed_at_resistance: {
    type: 'bearish',
    query: `( {cash} (
      1 day ago high >= 1 day ago ema( close, 20 ) * 0.99 and
      1 day ago close <= 1 day ago ema( close, 20 ) * 1.01 and
      1 day ago close < 1 day ago open and
      1 day ago close < 1 day ago sma( close, 200 ) and
      1 day ago ema( close, 20 ) < 1 day ago ema( close, 50 ) and
      1 day ago volume < 1 day ago sma( volume, 50 ) and
      1 day ago rsi( 14 ) > 40 and
      1 day ago rsi( 14 ) < 55 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      3 days ago high - 3 days ago low > 3 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 7: Bearish Momentum Carry
  // Yesterday closed at low with strong volume = sellers in control
  momentum_carry_bearish: {
    type: 'bearish',
    query: `( {cash} (
      1 day ago close <= 1 day ago low * 1.02 and
      1 day ago close < 1 day ago open and
      1 day ago close < 2 days ago close * 0.99 and
      1 day ago volume > 1 day ago sma( volume, 50 ) * 1.5 and
      1 day ago rsi( 14 ) > 28 and
      1 day ago rsi( 14 ) < 45 and
      1 day ago ema( close, 20 ) < 1 day ago ema( close, 50 ) and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      3 days ago high - 3 days ago low > 3 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 8: Breakdown Setup — Near 20-day low, about to crack
  // Sitting just above support, one push = new 20-day low
  breakdown_setup: {
    type: 'bearish',
    query: `( {cash} (
      1 day ago close < 1 day ago min( 20, low ) * 1.03 and
      1 day ago close >= 1 day ago min( 20, low ) and
      1 day ago close < 1 day ago open and
      1 day ago ema( close, 20 ) < 1 day ago ema( close, 50 ) and
      1 day ago rsi( 14 ) < 45 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      3 days ago high - 3 days ago low > 3 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  }
};

/**
 * Human-readable labels for each scan type (used in dashboard and notifications)
 */
export const SCAN_LABELS = {
  compression_bullish: 'Compression Bullish',
  pullback_at_support: 'Pullback Support',
  momentum_carry: 'Momentum Carry',
  breakout_setup: 'Breakout Setup',
  compression_bearish: 'Compression Bearish',
  failed_at_resistance: 'Failed Resistance',
  momentum_carry_bearish: 'Momentum Carry Bear',
  breakdown_setup: 'Breakdown Setup'
};

/**
 * Scan execution priority order per regime.
 * Scans are run in this order; deduplication keeps the first match.
 */
export const SCAN_ORDER_BY_REGIME = {
  BULLISH: ['compression_bullish', 'pullback_at_support', 'momentum_carry', 'breakout_setup'],
  BEARISH: ['compression_bearish', 'failed_at_resistance', 'momentum_carry_bearish', 'breakdown_setup'],
  NEUTRAL: ['compression_bullish', 'pullback_at_support', 'momentum_carry', 'breakout_setup', 'compression_bearish', 'failed_at_resistance', 'momentum_carry_bearish', 'breakdown_setup'],
  UNKNOWN: ['compression_bullish', 'pullback_at_support', 'momentum_carry', 'breakout_setup']
};

/**
 * Map daily picks scan types to scanLevels engine archetypes.
 * Used by calculateLevels() for scan-type-specific entry/stop/target.
 * Only LONG picks use the engine; SHORT picks use mirrored pivot logic.
 */
export const SCAN_ARCHETYPE = {
  compression_bullish: 'consolidation_breakout',
  pullback_at_support: 'pullback',
  momentum_carry: 'momentum',
  breakout_setup: 'breakout',
  compression_bearish: 'consolidation_breakout',
  failed_at_resistance: 'pullback',
  momentum_carry_bearish: 'momentum',
  breakdown_setup: 'breakout'
};
