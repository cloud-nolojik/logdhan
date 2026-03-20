/**
 * Daily Picks — ChartInk Scan Formulas
 *
 * 6 focused scans: 2 structural (52W), 2 reversal, 2 volume confirmation.
 * All scans run every day. Sector cross-filter (Step 2B) handles direction.
 *
 * ChartInk returns: { nsecode, bsecode, name, per_change, close, volume }
 * Enrichment (OHLCV, indicators) happens separately via Upstox.
 */

export const DAILY_SCANS = {
  // ═══════════════════════════════════════════════════════════════
  // STRUCTURAL SCANS — 52-Week Breakdowns/Breakouts
  // Highest conviction: institutional capitulation / breakout
  // ═══════════════════════════════════════════════════════════════

  // Scan 1: 52-Week Low Breakdown — Approaching yearly low with volume
  // Stock within 5% of 52W low (using yesterday's 52W low to exclude already-broken stocks)
  // Volume surge confirms institutional selling pressure
  fiftyTwoWeek_low: {
    type: 'bearish',
    query: `( {cash} (
      latest close > 1 day ago min( 250, low ) and
      latest close <= 1 day ago min( 250, low ) * 1.05 and
      latest close < latest open and
      latest volume > latest sma( volume, 50 ) * 2 and
      latest close < latest ema( close, 20 ) and
      latest ema( close, 20 ) < latest ema( close, 50 ) and
      latest rsi( 14 ) < 45 and
      latest rsi( 14 ) > 20 and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      latest volume * latest close >= 5000000 and
      market cap >= 5000
    ) )`
  },

  // Scan 2: 52-Week High Breakout — Approaching yearly high with volume
  // Stock within 5% of 52W high (using yesterday's 52W high to exclude already-broken stocks)
  // Volume surge confirms institutional buying pressure
  fiftyTwoWeek_high: {
    type: 'bullish',
    query: `( {cash} (
      latest close < 1 day ago max( 250, high ) and
      latest close >= 1 day ago max( 250, high ) * 0.95 and
      latest close > latest open and
      latest volume > latest sma( volume, 50 ) * 2 and
      latest close > latest ema( close, 20 ) and
      latest ema( close, 20 ) > latest ema( close, 50 ) and
      latest rsi( 14 ) > 55 and
      latest rsi( 14 ) < 80 and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      latest volume * latest close >= 5000000 and
      market cap >= 5000
    ) )`
  },

  // ═══════════════════════════════════════════════════════════════
  // REVERSAL SCANS — Key level rejections
  // ═══════════════════════════════════════════════════════════════

  // Scan 3: Failed at EMA20 Resistance — Bounce rejected, closing red
  // Tried to rally to EMA20, got rejected on low volume
  // Must close below yesterday's close (actual fall, not just red candle)
  failed_at_resistance: {
    type: 'bearish',
    query: `( {cash} (
      latest high >= latest ema( close, 20 ) * 0.99 and
      latest close <= latest ema( close, 20 ) * 1.01 and
      latest close < latest open and
      latest close < 1 day ago close and
      latest close < latest sma( close, 200 ) and
      latest ema( close, 20 ) < latest ema( close, 50 ) and
      latest volume < latest sma( volume, 50 ) and
      latest rsi( 14 ) > 40 and
      latest rsi( 14 ) < 55 and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      latest volume * latest close >= 5000000 and
      market cap >= 3000
    ) )`
  },

  // Scan 4: Pullback at EMA20 Support — Dip bought at key level
  // Pulled back to EMA20 on low volume in uptrend = ready to bounce
  // RSI 40-55 = healthy pullback zone (35 is too weak, suggests trend break)
  pullback_at_support: {
    type: 'bullish',
    query: `( {cash} (
      latest low <= latest ema( close, 20 ) * 1.01 and
      latest close >= latest ema( close, 20 ) * 0.98 and
      latest close > latest sma( close, 200 ) and
      latest ema( close, 20 ) > latest ema( close, 50 ) and
      latest ema( close, 50 ) > latest sma( close, 200 ) and
      latest volume < latest sma( volume, 50 ) and
      latest rsi( 14 ) > 40 and
      latest rsi( 14 ) < 55 and
      latest high - latest low > latest close * 0.015 and
      1 day ago high - 1 day ago low > 1 day ago close * 0.015 and
      2 days ago high - 2 days ago low > 2 days ago close * 0.015 and
      latest volume * latest close >= 5000000 and
      market cap >= 3000
    ) )`
  },

  // ═══════════════════════════════════════════════════════════════
  // VOLUME CONFIRMATION SCANS — Institutional money flow
  // ═══════════════════════════════════════════════════════════════

  // Scan 5: Volume Shocker Bearish — 2x+ volume on strong red candle
  // Uses 20-day volume average (not 10-day) for meaningful baseline
  // Prior day also red = confirms existing downtrend, not a one-off
  volume_shocker_bearish: {
    type: 'bearish',
    query: `( {cash} (
      latest volume > 2 * latest sma( volume, 20 ) and
      latest close < latest open and
      1 day ago close < 1 day ago open and
      latest close < latest ema( close, 20 ) and
      latest ema( close, 20 ) < latest ema( close, 50 ) and
      latest rsi( 14 ) > 25 and
      latest rsi( 14 ) < 50 and
      latest high - latest low > latest close * 0.015 and
      latest volume * latest close >= 5000000 and
      market cap >= 3000
    ) )`
  },

  // Scan 6: Volume Shocker Bullish — 2x+ volume on strong green candle
  // Uses 20-day volume average for meaningful baseline
  // Prior day also green = confirms existing uptrend, not a one-off bounce
  volume_shocker_bullish: {
    type: 'bullish',
    query: `( {cash} (
      latest volume > 2 * latest sma( volume, 20 ) and
      latest close > latest open and
      1 day ago close > 1 day ago open and
      latest close > latest ema( close, 20 ) and
      latest ema( close, 20 ) > latest ema( close, 50 ) and
      latest close > latest sma( close, 200 ) and
      latest rsi( 14 ) > 45 and
      latest rsi( 14 ) < 75 and
      latest high - latest low > latest close * 0.015 and
      latest volume * latest close >= 5000000 and
      market cap >= 3000
    ) )`
  },
};

/**
 * Human-readable labels for each scan type (used in dashboard and notifications)
 */
export const SCAN_LABELS = {
  fiftyTwoWeek_low: '52W Low Breakdown',
  fiftyTwoWeek_high: '52W High Breakout',
  failed_at_resistance: 'Failed Resistance',
  pullback_at_support: 'Pullback Support',
  volume_shocker_bearish: 'Volume Shocker Bear',
  volume_shocker_bullish: 'Volume Shocker Bull',
};

/**
 * Scan priority ladder — used by two-pass dedup to assign scan_type when a stock
 * appears in multiple scans. Lower rank = stronger signal.
 *
 * All scans run every day. Sector cross-filter (Step 2B) handles direction filtering.
 */
export const SCAN_PRIORITY = {
  // Bearish — strongest to weakest
  fiftyTwoWeek_low:       { rank: 1, direction: 'SHORT' },
  failed_at_resistance:   { rank: 2, direction: 'SHORT' },
  volume_shocker_bearish: { rank: 3, direction: 'SHORT' },
  // Bullish — strongest to weakest
  fiftyTwoWeek_high:      { rank: 1, direction: 'LONG' },
  pullback_at_support:    { rank: 2, direction: 'LONG' },
  volume_shocker_bullish: { rank: 3, direction: 'LONG' },
};

// Run order for ChartInk API calls — bearish first, then bullish
export const ALL_SCAN_ORDER = [
  'fiftyTwoWeek_low', 'failed_at_resistance', 'volume_shocker_bearish',
  'fiftyTwoWeek_high', 'pullback_at_support', 'volume_shocker_bullish',
];

/**
 * Map daily picks scan types to scanLevels engine archetypes.
 * Used by calculateLevels() for scan-type-specific entry/stop/target.
 */
export const SCAN_ARCHETYPE = {
  fiftyTwoWeek_low: 'fiftyTwoWeek_low',
  failed_at_resistance: 'failed_at_resistance',
  volume_shocker_bearish: 'breakdown_setup',
  fiftyTwoWeek_high: 'fiftyTwoWeek_high',
  pullback_at_support: 'pullback',
  volume_shocker_bullish: 'breakout',
};
