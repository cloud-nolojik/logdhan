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
      latest high - latest low < 1 day ago high - 1 day ago low and
      1 day ago high - 1 day ago low < 2 days ago high - 2 days ago low and
      latest close > latest open and
      latest close > latest ema( close, 20 ) and
      latest ema( close, 20 ) > latest ema( close, 50 ) and
      latest close > latest sma( close, 200 ) and
      latest rsi( 14 ) > 45 and
      latest rsi( 14 ) < 65 and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 2: Pullback at EMA20 Support — Ready to bounce
  // Stock pulled back to EMA20 on LOW volume in an uptrend
  // WHY IT WORKS: Low volume pullback = healthy dip, not panic selling
  // High ADR stock bouncing from support = 2%+ move likely
  pullback_at_support: {
    type: 'bullish',
    query: `( {cash} (
      latest low <= latest ema( close, 20 ) * 1.01 and
      latest close >= latest ema( close, 20 ) * 0.98 and
      latest close > latest sma( close, 200 ) and
      latest ema( close, 20 ) > latest ema( close, 50 ) and
      latest ema( close, 50 ) > latest sma( close, 200 ) and
      latest volume < latest sma( volume, 50 ) and
      latest rsi( 14 ) > 35 and
      latest rsi( 14 ) < 55 and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 3: Momentum Carry — Yesterday closed at high with strong volume
  // Buyers still in control, likely gap up or continuation today
  // WHY IT WORKS: Close near high + above-avg volume = unfilled demand
  momentum_carry: {
    type: 'bullish',
    query: `( {cash} (
      latest close >= latest high * 0.98 and
      latest close > latest open and
      latest close > 1 day ago close * 1.01 and
      latest volume > latest sma( volume, 50 ) * 1.5 and
      latest rsi( 14 ) > 55 and
      latest rsi( 14 ) < 72 and
      latest ema( close, 20 ) > latest ema( close, 50 ) and
      latest close > latest sma( close, 200 ) and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 4: Breakout Setup — Sitting just below 20-day high
  // One push away from breakout, coiling near resistance
  // WHY IT WORKS: Within 3% of 20-day high + uptrend = a 2% move = new high
  breakout_setup: {
    type: 'bullish',
    query: `( {cash} (
      latest close > latest max( 20, high ) * 0.97 and
      latest close <= latest max( 20, high ) and
      latest close > latest open and
      latest ema( close, 20 ) > latest ema( close, 50 ) and
      latest rsi( 14 ) > 50 and
      latest rsi( 14 ) < 68 and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
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
      latest high - latest low < 1 day ago high - 1 day ago low and
      1 day ago high - 1 day ago low < 2 days ago high - 2 days ago low and
      latest close < latest open and
      latest close < latest ema( close, 20 ) and
      latest ema( close, 20 ) < latest ema( close, 50 ) and
      latest rsi( 14 ) > 35 and
      latest rsi( 14 ) < 50 and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 6: Failed at EMA20 Resistance
  // Tried to rally to EMA20, got rejected, closed red on low volume
  // WHY IT WORKS: Weak bounce to resistance in downtrend = sellers waiting
  failed_at_resistance: {
    type: 'bearish',
    query: `( {cash} (
      latest high >= latest ema( close, 20 ) * 0.99 and
      latest close <= latest ema( close, 20 ) * 1.01 and
      latest close < latest open and
      latest close < latest sma( close, 200 ) and
      latest ema( close, 20 ) < latest ema( close, 50 ) and
      latest volume < latest sma( volume, 50 ) and
      latest rsi( 14 ) > 40 and
      latest rsi( 14 ) < 55 and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 7: Bearish Momentum Carry
  // Yesterday closed at low with strong volume = sellers in control
  // WHY IT WORKS: Close near low + above-avg volume = unfilled supply
  momentum_carry_bearish: {
    type: 'bearish',
    query: `( {cash} (
      latest close <= latest low * 1.02 and
      latest close < latest open and
      latest close < 1 day ago close * 0.99 and
      latest volume > latest sma( volume, 50 ) * 1.5 and
      latest rsi( 14 ) > 28 and
      latest rsi( 14 ) < 45 and
      latest ema( close, 20 ) < latest ema( close, 50 ) and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      market cap >= 1000
    ) )`
  },

  // Scan 8: Breakdown Setup — Near 20-day low, about to crack
  // Sitting just above support, one push = new 20-day low
  breakdown_setup: {
    type: 'bearish',
    query: `( {cash} (
      latest close < latest min( 20, low ) * 1.03 and
      latest close >= latest min( 20, low ) and
      latest close < latest open and
      latest ema( close, 20 ) < latest ema( close, 50 ) and
      latest rsi( 14 ) < 45 and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
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
