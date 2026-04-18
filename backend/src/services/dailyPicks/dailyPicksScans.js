/**
 * Daily Picks — scan-type metadata.
 *
 * The ChartInk scan block was removed when Step 2 moved to the shortlist engine
 * (services/shortlist/shortlistService.js). This file now only contains the
 * lookup tables that survive the refactor:
 *
 *   SCAN_LABELS    — human-readable names for the dashboard + notifications.
 *                    Includes legacy ChartInk entries so historical DailyPick
 *                    documents in Mongo still render properly.
 *   SCAN_ARCHETYPE — maps a candidate's scan_type to the scanLevels engine
 *                    archetype used to compute entry/stop/target.
 *
 * Everything related to ChartInk queries (DAILY_SCANS, SCAN_PRIORITY,
 * ALL_SCAN_ORDER) is gone. `chartinkService.js` itself is still used by
 * weeklyPicks and the /screener route — it is not removed.
 */

// ─── Human-readable labels ───────────────────────────────────────────────────
// Includes legacy entries to keep historical DB records displaying correctly.

export const SCAN_LABELS = {
  // Current (shortlist-era) scan types
  shortlist_long:           'Shortlist · Long',
  shortlist_short:          'Shortlist · Short',
  shortlist_catalyst:       'Shortlist · News catalyst',
  shortlist_gap_long:       'Shortlist · Gap up',
  shortlist_gap_short:      'Shortlist · Gap down',
  shortlist_rs_long:        'Shortlist · RS leader',
  shortlist_rs_short:       'Shortlist · RS laggard',
  shortlist_sector:         'Shortlist · Sector leader',
  // Backups promoted into the final picks by the 09:12:30 pre-open depth job
  shortlist_promoted_long:  'Shortlist · Promoted (long)',
  shortlist_promoted_short: 'Shortlist · Promoted (short)',

  // News pipeline (Step 6.5) — still in use
  news_upstox_bullish:  'News Watch Bull',
  news_upstox_bearish:  'News Watch Bear',

  // Legacy ChartInk scan types — retained for historical DailyPick docs
  fiftyTwoWeek_low:       '52W Low Breakdown',
  fiftyTwoWeek_high:      '52W High Breakout',
  failed_at_resistance:   'Failed Resistance',
  pullback_at_support:    'Pullback Support',
  volume_shocker_bearish: 'Volume Shocker Bear',
  volume_shocker_bullish: 'Volume Shocker Bull',
};

// ─── Scan-type → scanLevels engine archetype ─────────────────────────────────
// The engine uses the archetype to decide entry logic (breakout above PDH vs
// pullback-to-EMA20 vs fade-at-resistance, etc.).

export const SCAN_ARCHETYPE = {
  // Shortlist candidates: direction-driven archetype. LONG = breakout above PDH,
  // SHORT = breakdown below PDL. scanLevels handles the rest.
  shortlist_long:           'breakout',
  shortlist_short:          'breakdown_setup',
  shortlist_catalyst:       'breakout',       // catalyst-driven — assume momentum
  shortlist_gap_long:       'breakout',
  shortlist_gap_short:      'breakdown_setup',
  shortlist_rs_long:        'breakout',
  shortlist_rs_short:       'breakdown_setup',
  shortlist_sector:         'breakout',
  shortlist_promoted_long:  'breakout',
  shortlist_promoted_short: 'breakdown_setup',

  // News pipeline
  news_upstox_bullish:  'breakout',
  news_upstox_bearish:  'breakdown_setup',

  // Legacy ChartInk types — kept so historical calculateLevels() calls still work
  fiftyTwoWeek_low:       'fiftyTwoWeek_low',
  fiftyTwoWeek_high:      'fiftyTwoWeek_high',
  failed_at_resistance:   'failed_at_resistance',
  volume_shocker_bearish: 'breakdown_setup',
  pullback_at_support:    'pullback',
  volume_shocker_bullish: 'breakout',
};
