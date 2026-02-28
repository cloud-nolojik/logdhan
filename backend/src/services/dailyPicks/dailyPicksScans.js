/**
 * Daily Picks — ChartInk Scan Formulas
 *
 * 8 scans for next-day +2% trade candidates.
 * STRONG_BULLISH/STRONG_BEARISH (>3% from EMA50): hard-block counter-regime scans.
 * BULLISH/BEARISH (1-3%): all 8 scans run, aligned scans get +5 score bonus.
 * NEUTRAL/UNKNOWN: all 8 scans run, no bonus.
 *
 * ChartInk returns: { nsecode, bsecode, name, per_change, close, volume }
 * Enrichment (OHLCV, indicators) happens separately via Upstox.
 */

  export const DAILY_SCANS = {
    // ═══════════════════════════════════════════════════════════════
    // BULLISH SCANS — Stocks likely to move 2%+ UP today
    // ═══════════════════════════════════════════════════════════════
    // 
    // ⏰ TIMING: These scans run at 8:45 AM IST (pre-market)
    // At 8:45 AM, Chartink's "latest" = yesterday's completed candle
    // So we use: latest (=yesterday), 1 day ago (=2 days back), 2 days ago (=3 days back)
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

    // Scan 3: 52-Week High Breakout — Strong volume near yearly high
    // Stock closing within 2% of 52W high with volume surge = institutional breakout
    // WHY IT WORKS: 52W high is strongest psychological resistance; breaking it with volume = new trend
    fiftyTwoWeek_high: {
      type: 'bullish',
      query: `( {cash} (
        latest close >= max( 250, high ) * 0.98 and
        latest close > latest open and
        latest volume > latest sma( volume, 50 ) * 2 and
        latest close > latest ema( close, 20 ) and
        latest ema( close, 20 ) > latest ema( close, 50 ) and
        latest rsi( 14 ) > 55 and
        latest rsi( 14 ) < 80 and
        latest high - latest low > latest close * 0.015 and
        1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
        market cap >= 1000
      ) )`
    },

    // Scan 4: Breakout Setup — Sitting just below 20-day high
    // One push away from breakout, coiling near resistance
    breakout_setup: {
      type: 'bullish',
      query: `( {cash} (
        latest close > max( 20, high ) * 0.97 and
        latest close <= max( 20, high ) and
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

    // Scan 7: 52-Week Low Breakdown — Strong volume near yearly low
    // Stock closing within 2% of 52W low with volume surge = institutional selling
    // WHY IT WORKS: 52W low is strongest psychological support; breaking it with volume = capitulation
    fiftyTwoWeek_low: {
      type: 'bearish',
      query: `( {cash} (
        latest close <= min( 250, low ) * 1.02 and
        latest close < latest open and
        latest volume > latest sma( volume, 50 ) * 2 and
        latest close < latest ema( close, 20 ) and
        latest ema( close, 20 ) < latest ema( close, 50 ) and
        latest rsi( 14 ) < 45 and
        latest rsi( 14 ) > 20 and
        latest high - latest low > latest close * 0.015 and
        1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
        market cap >= 1000
      ) )`
    },

    // Scan 8: Breakdown Setup — Near 20-day low, about to crack
    // Sitting just above support, one push = new 20-day low
    breakdown_setup: {
      type: 'bearish',
      query: `( {cash} (
        latest close < min( 20, low ) * 1.03 and
        latest close >= min( 20, low ) and
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
  fiftyTwoWeek_high: '52W High Breakout',
  breakout_setup: 'Breakout Setup',
  compression_bearish: 'Compression Bearish',
  failed_at_resistance: 'Failed Resistance',
  fiftyTwoWeek_low: '52W Low Breakdown',
  breakdown_setup: 'Breakdown Setup'
};

/**
 * Scan execution priority order per regime.
 * Scans are run in this order; deduplication keeps the first match.
 *
 * STRONG tiers: hard-block counter-regime (safety net for crashes/euphoria, ~5-10 days/year)
 * Normal tiers: all 8 scans, scoring handles differentiation via +5 regime bonus
 * NEUTRAL/UNKNOWN: all 8 scans, no bonus
 */
const ALL_BULLISH = ['compression_bullish', 'pullback_at_support', 'fiftyTwoWeek_high', 'breakout_setup'];
const ALL_BEARISH = ['compression_bearish', 'failed_at_resistance', 'fiftyTwoWeek_low', 'breakdown_setup'];
const ALL_SCANS = [...ALL_BULLISH, ...ALL_BEARISH];

export const SCAN_ORDER_BY_REGIME = {
  STRONG_BULLISH: ALL_BULLISH,   // Hard block bearish (euphoria safety)
  BULLISH: ALL_SCANS,            // All scans, aligned get +5 in scoring
  NEUTRAL: ALL_SCANS,            // All scans, no bonus
  BEARISH: ALL_SCANS,            // All scans, aligned get +5 in scoring
  STRONG_BEARISH: ALL_BEARISH,   // Hard block bullish (crash safety)
  UNKNOWN: ALL_SCANS             // Treat as neutral (no directional bias)
};

/**
 * Map daily picks scan types to scanLevels engine archetypes.
 * Used by calculateLevels() for scan-type-specific entry/stop/target.
 * Only LONG picks use the engine; SHORT picks use mirrored pivot logic.
 */
export const SCAN_ARCHETYPE = {
  // LONG — map to generic archetypes
  compression_bullish: 'consolidation_breakout',
  pullback_at_support: 'pullback',
  fiftyTwoWeek_high: 'fiftyTwoWeek_high',
  breakout_setup: 'breakout',
  // SHORT — pass through to dedicated calculators in scanLevels.js
  compression_bearish: 'compression_bearish',
  failed_at_resistance: 'failed_at_resistance',
  fiftyTwoWeek_low: 'fiftyTwoWeek_low',
  breakdown_setup: 'breakdown_setup'
};
