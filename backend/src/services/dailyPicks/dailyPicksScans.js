/**
 * Daily Picks — ChartInk Scan Formulas
 *
 * 16 scans for next-day +2% trade candidates (8 bullish + 8 bearish).
 * STRONG_BULLISH/STRONG_BEARISH (>3% from EMA50): hard-block counter-regime scans.
 * BULLISH/BEARISH (1-3%): all 16 scans run, aligned scans get +5 score bonus.
 * NEUTRAL/UNKNOWN: all 16 scans run, no bonus.
 *
 * ChartInk returns: { nsecode, bsecode, name, per_change, close, volume }
 * Enrichment (OHLCV, indicators) happens separately via Upstox.
 */

  export const DAILY_SCANS = {
    // ═══════════════════════════════════════════════════════════════
    // BULLISH SCANS — Stocks likely to move 2%+ UP today
    // ═══════════════════════════════════════════════════════════════
    // 
    // ⏰ TIMING: These scans run at 8:40 AM IST (pre-market)
    // At 8:40 AM, Chartink's "latest" = yesterday's completed candle
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

    // Scan 5: Volume Shocker Bullish
    // 2x+ volume surge with strong bullish close = institutional buying
    // WHY IT WORKS: Big volume spikes signal smart money entering; continuation likely next day
    volume_shocker_bullish: {
      type: 'bullish',
      query: `( {cash} (
        latest volume > 2 * latest sma( volume, 10 ) and
        latest close > latest open and
        latest close > latest ema( close, 20 ) and
        latest ema( close, 20 ) > latest ema( close, 50 ) and
        latest close > latest sma( close, 200 ) and
        latest rsi( 14 ) > 45 and
        latest rsi( 14 ) < 75 and
        latest high - latest low > latest close * 0.015 and
        market cap >= 1000
      ) )`
    },

    // Scan 6: NR7 Bullish — Narrowest Range in 7 Days (Coiled Spring)
    // Today's range is the smallest of the last 7 days in an uptrend
    // WHY IT WORKS: Market cycles between contraction and expansion; NR7 = maximum compression before explosive move
    nr7_bullish: {
      type: 'bullish',
      query: `( {cash} (
        latest high - latest low < 1 day ago high - 1 day ago low and
        latest high - latest low < 2 days ago high - 2 days ago low and
        latest high - latest low < 3 days ago high - 3 days ago low and
        latest high - latest low < 4 days ago high - 4 days ago low and
        latest high - latest low < 5 days ago high - 5 days ago low and
        latest high - latest low < 6 days ago high - 6 days ago low and
        latest close > latest ema( close, 20 ) and
        latest ema( close, 20 ) > latest ema( close, 50 ) and
        latest close > latest sma( close, 200 ) and
        latest high - latest low > latest close * 0.01 and
        market cap >= 1000
      ) )`
    },

    // Scan 7: Inside Day Bullish — Today's candle within yesterday's range
    // Maximum energy compression in an uptrend = breakout imminent
    // WHY IT WORKS: Sellers exhausted, buyers accumulating in tight range; next candle decides direction
    inside_day_bullish: {
      type: 'bullish',
      query: `( {cash} (
        latest high < 1 day ago high and
        latest low > 1 day ago low and
        latest close > latest ema( close, 20 ) and
        latest ema( close, 20 ) > latest ema( close, 50 ) and
        latest close > latest sma( close, 200 ) and
        latest volume < latest sma( volume, 10 ) and
        latest high - latest low > latest close * 0.01 and
        market cap >= 1000
      ) )`
    },

    // Scan 8: Bull Flag — Strong pole move + tight consolidation
    // Stock ran up 8%+ in last 15 days, then consolidated tightly near the top
    // WHY IT WORKS: Strong demand (pole) followed by orderly profit-taking (flag) = continuation pattern
    bull_flag: {
      type: 'bullish',
      query: `( {cash} (
        latest close > 1.08 * 15 days ago close and
        latest close > 0.97 * max( 10, high ) and
        latest high - latest low < 1 day ago high - 1 day ago low and
        latest volume < latest sma( volume, 10 ) and
        latest close > latest ema( close, 20 ) and
        latest ema( close, 20 ) > latest ema( close, 50 ) and
        latest close > latest sma( close, 200 ) and
        latest high - latest low > latest close * 0.01 and
        market cap >= 1000
      ) )`
    },

    // ═══════════════════════════════════════════════════════════════
    // BEARISH SCANS — Stocks likely to move 2%+ DOWN today
    // ═══════════════════════════════════════════════════════════════

    // Scan 9: Volatility Compression Bearish
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

    // Scan 10: Failed at EMA20 Resistance
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

    // Scan 11: 52-Week Low Breakdown — Strong volume near yearly low
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

    // Scan 12: Breakdown Setup — Near 20-day low, about to crack
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
    },

    // Scan 13: Volume Shocker Bearish
    // 2x+ volume surge with strong bearish close = institutional selling
    // WHY IT WORKS: Big volume on red candles = smart money exiting; breakdown continues next day
    volume_shocker_bearish: {
      type: 'bearish',
      query: `( {cash} (
        latest volume > 2 * latest sma( volume, 10 ) and
        latest close < latest open and
        latest close < latest ema( close, 20 ) and
        latest ema( close, 20 ) < latest ema( close, 50 ) and
        latest rsi( 14 ) > 25 and
        latest rsi( 14 ) < 50 and
        latest high - latest low > latest close * 0.015 and
        market cap >= 1000
      ) )`
    },

    // Scan 14: NR7 Bearish — Narrowest Range in 7 Days in downtrend
    // Maximum compression in a downtrend = breakdown imminent
    // WHY IT WORKS: Silence before the storm; 7-day compression in downtrend almost always resolves lower
    nr7_bearish: {
      type: 'bearish',
      query: `( {cash} (
        latest high - latest low < 1 day ago high - 1 day ago low and
        latest high - latest low < 2 days ago high - 2 days ago low and
        latest high - latest low < 3 days ago high - 3 days ago low and
        latest high - latest low < 4 days ago high - 4 days ago low and
        latest high - latest low < 5 days ago high - 5 days ago low and
        latest high - latest low < 6 days ago high - 6 days ago low and
        latest close < latest ema( close, 20 ) and
        latest ema( close, 20 ) < latest ema( close, 50 ) and
        latest high - latest low > latest close * 0.01 and
        market cap >= 1000
      ) )`
    },

    // Scan 15: Inside Day Bearish — Today's candle within yesterday's range in downtrend
    // Compression in downtrend = sellers regrouping before next leg down
    // WHY IT WORKS: Buyers tried to hold but couldn't push higher; breakdown resumes
    inside_day_bearish: {
      type: 'bearish',
      query: `( {cash} (
        latest high < 1 day ago high and
        latest low > 1 day ago low and
        latest close < latest ema( close, 20 ) and
        latest ema( close, 20 ) < latest ema( close, 50 ) and
        latest volume < latest sma( volume, 10 ) and
        latest high - latest low > latest close * 0.01 and
        market cap >= 1000
      ) )`
    },

    // Scan 16: Bear Flag — Strong drop + tight consolidation near the low
    // Stock dropped 8%+ in last 15 days, then consolidated tightly = continuation lower
    // WHY IT WORKS: Strong supply (pole) followed by weak bounce (flag) = sellers still in control
    bear_flag: {
      type: 'bearish',
      query: `( {cash} (
        latest close < 0.92 * 15 days ago close and
        latest close < 1.03 * min( 10, low ) and
        latest high - latest low < 1 day ago high - 1 day ago low and
        latest volume < latest sma( volume, 10 ) and
        latest close < latest ema( close, 20 ) and
        latest ema( close, 20 ) < latest ema( close, 50 ) and
        latest high - latest low > latest close * 0.01 and
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
  volume_shocker_bullish: 'Volume Shocker Bull',
  nr7_bullish: 'NR7 Coiled Bull',
  inside_day_bullish: 'Inside Day Bull',
  bull_flag: 'Bull Flag',
  compression_bearish: 'Compression Bearish',
  failed_at_resistance: 'Failed Resistance',
  fiftyTwoWeek_low: '52W Low Breakdown',
  breakdown_setup: 'Breakdown Setup',
  volume_shocker_bearish: 'Volume Shocker Bear',
  nr7_bearish: 'NR7 Coiled Bear',
  inside_day_bearish: 'Inside Day Bear',
  bear_flag: 'Bear Flag'
};

/**
 * Scan execution priority order per regime.
 * Scans are run in this order; deduplication keeps the first match.
 *
 * STRONG tiers: hard-block counter-regime (safety net for crashes/euphoria, ~5-10 days/year)
 * Normal tiers: all 16 scans, scoring handles differentiation via +5 regime bonus
 * NEUTRAL/UNKNOWN: all 16 scans, no bonus
 */
// ── Scan priority lists per regime ──
// Order matters: first scan in the list gets run first, dedup keeps the first match.
// Momentum scans: ride the trend when it's running
const BULLISH_MOMENTUM = [
  'breakout_setup', 'fiftyTwoWeek_high', 'bull_flag', 'volume_shocker_bullish'
];
// Compression scans: buy the dip / wait for clean setup
const BULLISH_COMPRESSION = [
  'pullback_at_support', 'compression_bullish', 'nr7_bullish', 'inside_day_bullish'
];
const BEARISH_MOMENTUM = [
  'breakdown_setup', 'fiftyTwoWeek_low', 'bear_flag', 'volume_shocker_bearish'
];
const BEARISH_COMPRESSION = [
  'failed_at_resistance', 'compression_bearish', 'nr7_bearish', 'inside_day_bearish'
];

export const SCAN_ORDER_BY_REGIME = {
  // Combined regime (structure + SGX sentiment)
  // STRONG_BULL: momentum-first bullish — trend is running, ride it
  STRONG_BULL: [...BULLISH_MOMENTUM, ...BULLISH_COMPRESSION],
  // WEAK_BULL: compression-only bullish — weak open = buy the dip, no momentum chasing
  WEAK_BULL: [...BULLISH_COMPRESSION],
  // NEUTRAL: choppy — only tightest compression setups with defined risk
  NEUTRAL: ['nr7_bullish', 'nr7_bearish', 'inside_day_bullish', 'inside_day_bearish'],
  // WEAK_BEAR: compression-only bearish — structure bearish but SGX flat
  WEAK_BEAR: [...BEARISH_COMPRESSION],
  // STRONG_BEAR: momentum-first bearish — trend is falling, ride it down
  STRONG_BEAR: [...BEARISH_MOMENTUM, ...BEARISH_COMPRESSION],
  // CONFLICT: structure bearish + SGX green → contradictory, sit out
  CONFLICT: [],
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
  volume_shocker_bullish: 'breakout',           // Volume surge = momentum breakout
  nr7_bullish: 'consolidation_breakout',         // NR7 = extreme consolidation → breakout
  inside_day_bullish: 'consolidation_breakout',   // Inside day = consolidation → breakout
  bull_flag: 'breakout',                          // Flag continuation = breakout
  // SHORT — pass through to dedicated calculators in scanLevels.js
  compression_bearish: 'compression_bearish',
  failed_at_resistance: 'failed_at_resistance',
  fiftyTwoWeek_low: 'fiftyTwoWeek_low',
  breakdown_setup: 'breakdown_setup',
  volume_shocker_bearish: 'breakdown_setup',      // Volume surge down = breakdown
  nr7_bearish: 'compression_bearish',             // NR7 in downtrend = compression breakdown
  inside_day_bearish: 'compression_bearish',      // Inside day in downtrend = compression breakdown
  bear_flag: 'breakdown_setup'                    // Flag continuation down = breakdown
};
