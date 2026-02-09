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
  // BULLISH SCANS (Long candidates)
  // ═══════════════════════════════════════════════════════════════

  // Scan 1: Momentum Continuation — Strong up day with volume confirming trend
  momentum_continuation: {
    type: 'bullish',
    query: `( {cash} ( latest close > latest open and latest close >= latest high * 0.97 and latest close > 1 day ago close * 1.02 and latest volume > latest sma( volume, 50 ) * 2 and latest rsi( 14 ) > 55 and latest rsi( 14 ) < 72 and latest ema( close, 20 ) > latest ema( close, 50 ) and latest ema( close, 50 ) > latest sma( close, 200 ) and latest close > latest sma( close, 200 ) and market cap >= 1000 ) )`
  },

  // Scan 2: Pullback Bounce — Bounced off EMA20 support with volume confirmation
  pullback_bounce: {
    type: 'bullish',
    query: `( {cash} ( latest close > latest open and latest close > 1 day ago high and latest volume > 1 day ago volume and latest rsi( 14 ) > 40 and latest rsi( 14 ) < 55 and latest ema( close, 20 ) > latest ema( close, 50 ) and latest ema( close, 50 ) > latest sma( close, 200 ) and latest close >= latest ema( close, 20 ) * 0.98 and latest close <= latest ema( close, 20 ) * 1.02 and market cap >= 1000 ) )`
  },

  // Scan 3: Breakout Fresh — First close above 20-day high with volume surge
  breakout_fresh: {
    type: 'bullish',
    query: `( {cash} ( latest close > latest max( 20, high ) and latest close >= latest high * 0.97 and latest volume > latest sma( volume, 50 ) * 2 and latest close > latest open and latest rsi( 14 ) > 50 and latest rsi( 14 ) < 75 and market cap >= 1000 ) )`
  },

  // ═══════════════════════════════════════════════════════════════
  // BEARISH SCANS (Short candidates)
  // ═══════════════════════════════════════════════════════════════

  // Scan 4: Momentum Breakdown — Strong down day with volume confirming weakness
  momentum_breakdown: {
    type: 'bearish',
    query: `( {cash} ( latest close < latest open and latest close <= latest low * 1.03 and latest close < 1 day ago close * 0.98 and latest volume > latest sma( volume, 50 ) * 2 and latest rsi( 14 ) > 28 and latest rsi( 14 ) < 45 and latest ema( close, 20 ) < latest ema( close, 50 ) and market cap >= 1000 ) )`
  },

  // Scan 5: Failed Bounce / Breakdown — Failed to hold previous day's low
  failed_bounce: {
    type: 'bearish',
    query: `( {cash} ( latest close < latest open and latest close < 1 day ago low and latest volume > 1 day ago volume and latest rsi( 14 ) > 30 and latest rsi( 14 ) < 55 and latest close < latest ema( close, 20 ) and latest ema( close, 20 ) < latest ema( close, 50 ) and market cap >= 1000 ) )`
  },

  // Scan 6: Breakdown Fresh — First close below 20-day low with volume surge
  breakdown_fresh: {
    type: 'bearish',
    query: `( {cash} ( latest close < latest min( 20, low ) and latest close <= latest low * 1.03 and latest volume > latest sma( volume, 50 ) * 2 and latest close < latest open and latest rsi( 14 ) < 45 and market cap >= 1000 ) )`
  }
};

/**
 * Human-readable labels for each scan type (used in dashboard and notifications)
 */
export const SCAN_LABELS = {
  momentum_continuation: 'Momentum',
  pullback_bounce: 'Pullback Bounce',
  breakout_fresh: 'Breakout',
  momentum_breakdown: 'Breakdown',
  failed_bounce: 'Failed Bounce',
  breakdown_fresh: 'Breakdown Fresh'
};

/**
 * Scan execution priority order per regime.
 * Scans are run in this order; deduplication keeps the first match.
 */
export const SCAN_ORDER_BY_REGIME = {
  BULLISH: ['momentum_continuation', 'pullback_bounce', 'breakout_fresh'],
  BEARISH: ['momentum_breakdown', 'failed_bounce', 'breakdown_fresh'],
  NEUTRAL: ['momentum_continuation', 'pullback_bounce', 'breakout_fresh', 'momentum_breakdown', 'failed_bounce', 'breakdown_fresh'],
  UNKNOWN: ['momentum_continuation', 'pullback_bounce', 'breakout_fresh']
};
