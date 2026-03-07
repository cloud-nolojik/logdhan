/**
 * Daily Tracking Service
 *
 * Two-phase daily tracking for WeeklyWatchlist stocks:
 *
 * PHASE 1: Status Update (every stock, NO AI, ~5-10 seconds total)
 *   - Uses getDailyAnalysisData() for all symbols at once
 *   - Compares closing data against weekend levels (pure math)
 *   - Sets tracking_status per stock
 *   - Saves daily_snapshot to WeeklyWatchlist
 *   - Detects status CHANGES → queue for Phase 2
 *
 * PHASE 2: AI Analysis (ONLY stocks with status change, 0-2 per day)
 *   - Claude with weekend context + trigger reason
 *   - Short focused output (500-800 tokens)
 *   - Save to StockAnalysis (analysis_type: 'daily_track')
 */

import WeeklyWatchlist from '../models/weeklyWatchlist.js';
import StockAnalysis from '../models/stockAnalysis.js';
import { getDailyAnalysisData } from './technicalData.service.js';
import { getDailyCandlesForRange } from '../utils/stockDb.js';
import { buildDailyTrackPrompt } from '../prompts/dailyTrackPrompts.js';
import Anthropic from '@anthropic-ai/sdk';
import ApiUsage from '../models/apiUsage.js';
import { firebaseService } from './firebase/firebase.service.js';
import { processSimulationForKiteOrders, processPostEntryOrders, syncKiteGTTs, isKiteIntegrationEnabled } from './kiteTradeIntegration.service.js';

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 TRIGGERS - When to call AI
// ═══════════════════════════════════════════════════════════════════════════

const PHASE2_TRIGGERS = {
  // Status transitions that need AI guidance
  'WATCHING → ENTRY_ZONE':     'Stock entered buy zone. Should user enter now?',
  'WATCHING → RETEST_ZONE':    '52W breakout stock retesting old high. Is retest holding?',
  'APPROACHING → ENTRY_ZONE':  'Stock moved from approaching to entry zone.',
  'ENTRY_ZONE → ABOVE_ENTRY':  'Entry triggered. Confirm position or caution?',
  'ANY → STOPPED_OUT':         'Stop hit. Confirm exit or false break?',
  'ANY → TARGET1_HIT':         'T1 reached. 50% booked, trailing remainder.',
  'ANY → TARGET_HIT':          'Main target reached. Exit now or hold for T2?',
  'ANY → TARGET2_HIT':         'T2 reached. Full exit recommended.',

  // Flags that need AI guidance (only if flag is NEW today)
  'NEW_FLAG: RSI_DANGER':      'RSI crossed 72. Risk of overextension.',
  'NEW_FLAG: RSI_EXIT':        'RSI crossed 75. Strong exit signal.',
  'NEW_FLAG: VOLUME_SPIKE':    'Unusual volume (2x+ average). Distribution or accumulation?',
  'NEW_FLAG: GAP_DOWN':        'Significant gap down (>3%). Reassess stop.'
};

// ═══════════════════════════════════════════════════════════════════════════
// STATUS CALCULATION (Pure Math, No AI)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate tracking status based on current price vs levels
 * @param {Object} dailyData - { ltp, daily_rsi, todays_volume, avg_volume_50d, ... }
 * @param {Object} levels - { entry, entryRange, stop, target1, target2, target3, archetype, ... }
 * @param {string} symbol - Stock symbol for logging
 * @returns {string} - New tracking status
 */
function calculateStatus(dailyData, levels, symbol = 'UNKNOWN') {
  const { ltp } = dailyData;
  const { entry, entryRange, stop, target1, target2, target3, archetype } = levels;

  // Use entryRange if available, otherwise ±1% of entry
  const entryLow = entryRange?.[0] || entry * 0.99;
  const entryHigh = entryRange?.[1] || entry * 1.01;

  // 3-stage targets: T1 → T2 → T3 (T3 is optional)
  const t1 = target1;    // T1: 50% booking
  const t2 = target2;    // T2: Main target (70% of remaining if T3 exists, else 100%)
  const t3 = target3;    // T3: Extension target (optional - final 30%)

  // Priority order matters — check terminal states first
  let result;

  // 1. Stop hit (terminal for the week)
  if (ltp < stop) {
    result = 'STOPPED_OUT';
  }
  // 2. T3 hit (if exists) — full target achieved
  else if (t3 && ltp >= t3) {
    result = 'TARGET3_HIT';
  }
  // 3. T2 hit — main target
  else if (t2 && ltp >= t2) {
    result = 'TARGET2_HIT';
  }
  // 4. T1 hit — 50% booked, trailing remainder
  else if (t1 && ltp >= t1) {
    result = 'TARGET1_HIT';
  }
  // 5. Entry zone (price within entry range)
  else if (ltp >= entryLow && ltp <= entryHigh) {
    result = 'ENTRY_ZONE';
  }
  // 6. 52W breakout retest (archetype-aware)
  else if (archetype === '52w_breakout') {
    const retestZoneBottom = stop * 1.02;
    const retestZoneTop = entryLow;
    if (ltp >= retestZoneBottom && ltp < retestZoneTop) {
      result = 'RETEST_ZONE';
    }
  }

  if (!result) {
    // 7. Above entry but below T1 (running, no action needed)
    const upperBound = t1 || t2;
    if (ltp > entryHigh && upperBound && ltp < upperBound) {
      result = 'ABOVE_ENTRY';
    }
    // 8. Approaching entry (within 2% above entry)
    else {
      const distanceFromEntry = ((ltp - entry) / entry) * 100;
      if (distanceFromEntry > 0 && distanceFromEntry <= 2) {
        result = 'APPROACHING';
      } else {
        result = 'WATCHING';
      }
    }
  }

  console.log(`[STATUS-CALC] ${symbol}: LTP=₹${ltp} | E=₹${entry} S=₹${stop} T1=${t1 || '-'} T2=${t2} T3=${t3 || '-'} → ${result}`);
  return result;
}

/**
 * Calculate tracking flags based on daily data
 * @param {Object} dailyData - { daily_rsi, todays_volume, avg_volume_50d, open, prev_close, ... }
 * @param {Object} levels - { entry, ... }
 * @returns {string[]} - Array of flag strings
 */
function calculateFlags(dailyData, levels, symbol = 'UNKNOWN') {
  const flags = [];
  const { daily_rsi, todays_volume, avg_volume_50d, ltp, open, prev_close } = dailyData;
  const { entry } = levels;

  // RSI flags
  if (daily_rsi >= 75) {
    flags.push('RSI_EXIT');
  } else if (daily_rsi >= 72) {
    flags.push('RSI_DANGER');
  }

  // Volume spike (2x or more above 50-day average)
  if (avg_volume_50d > 0 && todays_volume >= avg_volume_50d * 2) {
    flags.push('VOLUME_SPIKE');
  }

  // Approaching entry (within 2% above entry) — only when OUTSIDE entry zone.
  const entryLow = levels.entryRange?.[0] || entry * 0.99;
  const entryHigh = levels.entryRange?.[1] || entry * 1.01;
  const inEntryZone = ltp >= entryLow && ltp <= entryHigh;
  const distFromEntry = ((ltp - entry) / entry) * 100;
  if (!inEntryZone && distFromEntry > 0 && distFromEntry <= 2) {
    flags.push('APPROACHING_ENTRY');
  }

  // Gap down detection (today's open significantly below previous day's close)
  if (prev_close && prev_close > 0 && open && open > 0) {
    if (open < prev_close * 0.97) {
      const gapPct = ((open - prev_close) / prev_close * 100).toFixed(1);
      flags.push('GAP_DOWN');
      console.log(`[FLAGS-CALC] ${symbol}: Gap down ${gapPct}% (open=₹${open} vs prev_close=₹${prev_close})`);
    }
  }

  // Only log if flags were found (no noise for clean stocks)
  if (flags.length > 0) {
    console.log(`[FLAGS-CALC] ${symbol}: RSI=${daily_rsi?.toFixed(1) || '?'} Vol=${avg_volume_50d > 0 ? (todays_volume / avg_volume_50d).toFixed(1) + 'x' : '?'} → [${flags.join(', ')}]`);
  }
  return flags;
}

/**
 * Determine if Phase 2 (AI analysis) should run
 * @param {string} newStatus - Current tracking status
 * @param {string} oldStatus - Previous tracking status
 * @param {string[]} newFlags - Current flags
 * @param {string[]} oldFlags - Previous flags
 * @param {Object} dailyData - Today's OHLC data { high, low, ... }
 * @param {Object} levels - Stock levels { entry, entryRange, ... }
 * @param {string} symbol - Stock symbol for logging
 * @returns {{ trigger: boolean, reason: string|null }}
 */
function shouldTriggerPhase2(newStatus, oldStatus, newFlags, oldFlags, dailyData = null, levels = null, symbol = 'UNKNOWN') {
  // Status change
  if (newStatus !== oldStatus) {
    const specificKey = `${oldStatus} → ${newStatus}`;
    const anyKey = `ANY → ${newStatus}`;

    if (PHASE2_TRIGGERS[specificKey]) {
      return { trigger: true, reason: PHASE2_TRIGGERS[specificKey] };
    }
    if (PHASE2_TRIGGERS[anyKey]) {
      return { trigger: true, reason: PHASE2_TRIGGERS[anyKey] };
    }
  }

  // CHECK: Entry signal (Two-Phase Entry)
  // For close_above: daily CLOSE >= entry confirms signal
  // For touch_bounce: open must be near/above entry, low dips to touch entry, close >= entry
  // Actual entry happens at NEXT day's open (user buys after seeing notification)
  if (dailyData && levels) {
    const entry = levels.entry;
    const close = dailyData.ltp || dailyData.close;  // ltp for live, close for historical
    const low = dailyData.low;
    const stop = levels.stop;
    const entryConfirmation = levels.entryConfirmation || 'close_above';
    const capital = 100000;  // Standard simulation capital
    const plannedQty = Math.floor(capital / entry);

    // Statuses that indicate we were BELOW entry before
    const belowEntryStatuses = ['WATCHING', 'RETEST_ZONE', 'APPROACHING'];

    // Check entry signal based on confirmation type (must match simulateTrade logic)
    let entrySignalConfirmed = false;
    if (entryConfirmation === 'close_above') {
      entrySignalConfirmed = close >= entry;
    } else if (entryConfirmation === 'touch_bounce') {
      const open = dailyData.open;
      entrySignalConfirmed = open >= entry * 0.99 && low <= entry && close >= entry;
    }
    // Note: 'touch' entries are same-day fills handled in simulation, not here

    if (belowEntryStatuses.includes(oldStatus) && entrySignalConfirmed) {
      // Check entry quality to include in the trigger reason
      const entryQuality = checkEntryQuality(close, entry, stop);
      const premiumPct = entryQuality.premium_pct;
      const quality = entryQuality.quality;

      console.log(`[PHASE2-TRIGGER] ${symbol}: Entry SIGNAL confirmed on close! Close ₹${close.toFixed(2)} >= Entry ₹${entry.toFixed(2)} (${quality}: +${premiumPct}%)`);

      // Different trigger reasons based on entry quality
      // Note: This is a SIGNAL, not actual entry. User should buy at tomorrow's open.
      if (quality === 'OVEREXTENDED') {
        return {
          trigger: true,
          reason: `Entry signal skipped — close ₹${close.toFixed(2)} is +${premiumPct}% above entry ₹${entry.toFixed(2)}. Too extended. Wait for pullback.`
        };
      } else if (quality === 'EXTENDED') {
        // Calculate adjusted qty for extended entry
        const originalRiskPerShare = entry - stop;
        const newRiskPerShare = close - stop;
        const adjustedQty = Math.floor(plannedQty * originalRiskPerShare / newRiskPerShare);
        return {
          trigger: true,
          reason: `Entry signal confirmed (EXTENDED +${premiumPct}%). Close ₹${close.toFixed(2)} above entry ₹${entry.toFixed(2)}. Buy ${adjustedQty} shares (reduced from ${plannedQty}) at tomorrow's open. Stop: ₹${stop.toFixed(2)}.`
        };
      } else {
        return {
          trigger: true,
          reason: `Entry signal confirmed (GOOD +${premiumPct}%). Close ₹${close.toFixed(2)} at entry ₹${entry.toFixed(2)}. Buy ${plannedQty} shares at tomorrow's open. Stop: ₹${stop.toFixed(2)}.`
        };
      }
    }
  }

  // New flags (only flags that weren't present before)
  const brandNewFlags = newFlags.filter(f => !oldFlags.includes(f));
  for (const flag of brandNewFlags) {
    const key = `NEW_FLAG: ${flag}`;
    if (PHASE2_TRIGGERS[key]) {
      return { trigger: true, reason: PHASE2_TRIGGERS[key] };
    }
  }

  return { trigger: false, reason: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// ENTRY QUALITY CHECK
// ═══════════════════════════════════════════════════════════════════════════
//
// For close-based entry confirmation, we need to check if the close is:
// - GOOD: Close is within 2% above entry (ideal for momentum breakouts)
// - EXTENDED: Close is 2-5% above entry (acceptable but note the premium)
// - OVEREXTENDED: Close is >5% above entry (too far, skip or wait for pullback)
//
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check entry quality for close-based confirmation
 *
 * @param {number} close - Today's closing price
 * @param {number} entry - Entry level from weekend analysis
 * @param {number} stop - Stop loss level
 * @returns {{ quality: string, premium_pct: number, adjusted_rr: number|null, recommendation: string }}
 */
function checkEntryQuality(close, entry, stop) {
  const premiumPct = ((close - entry) / entry) * 100;
  const originalRisk = entry - stop;
  const adjustedRisk = close - stop;
  const adjustedRR = originalRisk > 0 ? adjustedRisk / originalRisk : null;

  // Quality thresholds (matching spec: ≤2% GOOD, 2-5% EXTENDED, >5% OVEREXTENDED)
  if (premiumPct <= 2.0) {
    return {
      quality: 'GOOD',
      premium_pct: parseFloat(premiumPct.toFixed(2)),
      adjusted_rr: adjustedRR ? parseFloat(adjustedRR.toFixed(2)) : null,
      recommendation: 'Entry confirmed. Close near entry level — ideal fill.'
    };
  }

  if (premiumPct <= 5.0) {
    return {
      quality: 'EXTENDED',
      premium_pct: parseFloat(premiumPct.toFixed(2)),
      adjusted_rr: adjustedRR ? parseFloat(adjustedRR.toFixed(2)) : null,
      recommendation: 'Entry confirmed but extended. Consider smaller position or wait for pullback.'
    };
  }

  return {
    quality: 'OVEREXTENDED',
    premium_pct: parseFloat(premiumPct.toFixed(2)),
    adjusted_rr: adjustedRR ? parseFloat(adjustedRR.toFixed(2)) : null,
    recommendation: 'Close too far above entry. Skip this entry — wait for pullback or next setup.'
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADE SIMULATION v2 (Pure Math, No AI)
// ═══════════════════════════════════════════════════════════════════════════
//
// v2 Changes:
// - Close-based entry confirmation (for buy_above) — intraday touch not enough
// - Touch-based entry for limit orders (pullback)
// - Entry window expiry (if entry not triggered within N days)
// - Week-end rules (exit/hold/trail depending on archetype)
// - Max hold period
//
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Trade Simulation Engine v2
 *
 * Replays daily snapshots to simulate a ₹1,00,000 trade with:
 * - Close-based entry confirmation (for buy_above) or touch (for limit)
 * - Entry window expiry (if entry not triggered within N days)
 * - 50% booking at T1, stop moved to entry
 * - Full exit at T2 (or trailing stop)
 * - Week-end rules (exit/hold/trail)
 * - Max hold period
 *
 * @param {Object} stock - Stock from WeeklyWatchlist with levels
 * @param {Array} snapshots - Daily snapshots [{date, open, high, low, close}]
 * @param {number} currentPrice - Latest price for unrealized P&L
 * @returns {Object} trade_simulation object for DB
 */
// PERF NOTE: Replays all snapshots from day 1 on every run.
// Fine for current scale (10 stocks x 5 days). For multi-week
// holds or larger watchlists, consider incremental simulation.
function simulateTrade(stock, snapshots, currentPrice) {
  const levels = stock.levels;
  const entry = levels.entry;
  const stop = levels.stop;
  // 3-stage targets: T1 → T2 → T3 (T3 is optional)
  const t1 = levels.target1;    // T1: 50% booking
  const t2 = levels.target2;    // T2: Main target (70% of remaining if T3 exists, else 100%)
  const t3 = levels.target3;    // T3: Extension target (optional - final 30%)

  // Time rules from levels (with defaults for backward compat)
  const entryConfirmation = levels.entryConfirmation || 'close_above';
  const entryWindowDays = levels.entryWindowDays || 3;
  const maxHoldDays = levels.maxHoldDays || 5;
  const weekEndRule = levels.weekEndRule || 'exit_if_no_t1';

  const capital = 100000;
  const qty = Math.floor(capital / entry);

  const sim = {
    status: 'WAITING',
    entry_price: null,
    entry_date: null,
    capital,
    qty_total: qty,
    qty_remaining: qty,
    qty_exited: 0,
    trailing_stop: stop,
    realized_pnl: 0,
    unrealized_pnl: 0,
    total_pnl: 0,
    total_return_pct: 0,
    peak_price: 0,
    peak_gain_pct: 0,
    events: []
  };

  let dayCount = 0;

  for (const day of snapshots) {
    const { date, open, high, low, close } = day;
    dayCount++;

    // ══════════════════════════════════════════════
    // ENTRY_SIGNALED: Execute at this day's open (Phase 2 of two-phase entry)
    // ══════════════════════════════════════════════
    if (sim.status === 'ENTRY_SIGNALED') {
      const actualEntryPrice = open;  // This day's open = user's realistic entry

      // Run entry quality check against OPEN price (not signal day's close)
      const premium_pct = ((actualEntryPrice - entry) / entry) * 100;
      const originalQty = sim.qty_total;  // Qty was pre-calculated at signal time
      const originalRiskPerShare = entry - stop;
      const newRiskPerShare = actualEntryPrice - stop;

      let entryQuality, actualQty;

      // Check if open is below stop — don't enter a losing position
      if (actualEntryPrice < stop) {
        entryQuality = 'BELOW_STOP';
        actualQty = 0;
        sim.status = 'WAITING';  // Reset back to waiting
        sim.signal_date = null;
        sim.signal_close = null;
        sim.qty_total = null;
        sim.events.push({
          date: date instanceof Date ? date : new Date(date),
          type: 'ENTRY_SKIPPED',
          price: actualEntryPrice,
          qty: 0,
          pnl: 0,
          detail: `Entry skipped — next day open ₹${actualEntryPrice.toFixed(2)} is BELOW stop ₹${stop.toFixed(2)}. Wait for better setup.`
        });

        console.log(`[ENTRY-EXECUTE] ${stock.symbol}: Open ₹${actualEntryPrice.toFixed(2)} < stop ₹${stop.toFixed(2)} — entry skipped`);
        continue;
      } else if (premium_pct > 5) {
        // OVEREXTENDED at open — skip entry entirely
        entryQuality = 'OVEREXTENDED';
        actualQty = 0;
        sim.status = 'WAITING';  // Reset back to waiting
        sim.signal_date = null;
        sim.signal_close = null;
        sim.qty_total = null;
        sim.events.push({
          date: date instanceof Date ? date : new Date(date),
          type: 'ENTRY_SKIPPED',
          price: actualEntryPrice,
          qty: 0,
          pnl: 0,
          detail: `Entry skipped — next day open ₹${actualEntryPrice.toFixed(2)} is OVEREXTENDED (+${premium_pct.toFixed(1)}% above entry ₹${entry.toFixed(2)}). Wait for pullback.`
        });

        console.log(`[ENTRY-EXECUTE] ${stock.symbol}: OVEREXTENDED at open ₹${actualEntryPrice.toFixed(2)} (+${premium_pct.toFixed(1)}%) — entry skipped`);
        continue;
      } else if (premium_pct > 2) {
        // EXTENDED — same rupee risk sizing
        entryQuality = 'EXTENDED';
        actualQty = Math.floor(originalQty * originalRiskPerShare / newRiskPerShare);
        console.log(`[ENTRY-EXECUTE] ${stock.symbol}: EXTENDED entry at open ₹${actualEntryPrice.toFixed(2)} (+${premium_pct.toFixed(1)}%)`);
        console.log(`[ENTRY-EXECUTE] ${stock.symbol}:   Original: ${originalQty} shares × ₹${originalRiskPerShare.toFixed(2)} risk = ₹${(originalQty * originalRiskPerShare).toFixed(0)} max loss`);
        console.log(`[ENTRY-EXECUTE] ${stock.symbol}:   Adjusted: ${actualQty} shares × ₹${newRiskPerShare.toFixed(2)} risk = ₹${(actualQty * newRiskPerShare).toFixed(0)} max loss`);
      } else if (premium_pct >= 0) {
        // GOOD — full position
        entryQuality = 'GOOD';
        actualQty = originalQty;
        console.log(`[ENTRY-EXECUTE] ${stock.symbol}: GOOD entry at open ₹${actualEntryPrice.toFixed(2)} (+${premium_pct.toFixed(1)}%)`);
      } else {
        // Negative premium — open gapped below entry level
        // Still enter since signal was confirmed, but note the gap down
        entryQuality = 'GAP_DOWN';
        actualQty = originalQty;
        console.log(`[ENTRY-EXECUTE] ${stock.symbol}: GAP_DOWN entry at open ₹${actualEntryPrice.toFixed(2)} (${premium_pct.toFixed(1)}% below entry) — signal was confirmed yesterday`);
      }

      // Execute the entry
      sim.entry_price = actualEntryPrice;
      sim.entry_date = date instanceof Date ? date : new Date(date);
      sim.trailing_stop = stop;
      console.log(`[TRAILING-STOP-INIT] ${stock.symbol}: Set trailing_stop = ${stop} (original stop from levels)`);
      sim.status = 'ENTERED';
      sim.qty_total = actualQty;
      sim.qty_remaining = actualQty;

      const qualityNote = entryQuality === 'GOOD'
        ? ''
        : entryQuality === 'GAP_DOWN'
          ? ` (GAP_DOWN: opened ${premium_pct.toFixed(1)}% below entry)`
          : ` (${entryQuality}: +${premium_pct.toFixed(1)}% premium, R:R adjusted)`;

      const signalDateStr = sim.signal_date instanceof Date
        ? sim.signal_date.toISOString().split('T')[0]
        : new Date(sim.signal_date).toISOString().split('T')[0];

      sim.events.push({
        date: sim.entry_date,
        type: 'ENTRY',
        price: actualEntryPrice,
        qty: actualQty,
        pnl: 0,
        detail: `Bought ${actualQty} shares at open ₹${actualEntryPrice.toFixed(2)}${qualityNote}. Signal was ₹${sim.signal_close.toFixed(2)} close on ${signalDateStr}.`,
        entry_quality: { quality: entryQuality, premium_pct: parseFloat(premium_pct.toFixed(2)) }
      });

      // Clear signal fields
      sim.signal_date = null;
      sim.signal_close = null;

      // DON'T continue — fall through to check stop/T1/T2 on this same day
    }

    // ══════════════════════════════════════════════
    // WAITING: Check if entry signal triggers (Phase 1 of two-phase entry)
    // ══════════════════════════════════════════════
    if (sim.status === 'WAITING') {

      // Entry window expired?
      if (dayCount > entryWindowDays) {
        sim.status = 'EXPIRED';
        sim.events.push({
          date: date instanceof Date ? date : new Date(date),
          type: 'EXPIRED',
          price: close,
          qty: 0,
          pnl: 0,
          detail: `Entry window expired — no ${entryConfirmation === 'close_above' ? 'close above' : entryConfirmation === 'touch_bounce' ? 'touch+bounce at' : 'touch at'} ₹${entry.toFixed(2)} within ${entryWindowDays} days`
        });
        break;
      }

      // Check entry signal based on confirmation type
      let signalTriggered = false;

      if (entryConfirmation === 'close_above') {
        // buy_above: Daily close must be at or above entry
        signalTriggered = close >= entry;
      } else if (entryConfirmation === 'touch') {
        // touch-based: signal when price touches entry (for limit order fills)
        // For touch, we could enter same day at the limit price
        signalTriggered = low <= entry && high >= entry;
      } else if (entryConfirmation === 'touch_bounce') {
        // touch_bounce: stock must open near/above entry, dip to touch it, close above
        signalTriggered = open >= entry * 0.99 && low <= entry && close >= entry;
      }

      if (signalTriggered) {
        const premium_pct = ((close - entry) / entry) * 100;

        // For touch-based entries, execute immediately at the limit level
        if (entryConfirmation === 'touch') {
          const actualEntryPrice = entry;  // Limit order fills at planned level
          const actualQty = Math.floor(capital / actualEntryPrice);

          sim.entry_price = actualEntryPrice;
          sim.entry_date = date instanceof Date ? date : new Date(date);
          sim.trailing_stop = stop;
          sim.status = 'ENTERED';
          sim.qty_total = actualQty;
          sim.qty_remaining = actualQty;

          sim.events.push({
            date: sim.entry_date,
            type: 'ENTRY',
            price: actualEntryPrice,
            qty: actualQty,
            pnl: 0,
            detail: `Pullback entry — limit filled at ₹${entry.toFixed(2)}. Bought ${actualQty} shares.`
          });

          console.log(`[ENTRY-TOUCH] ${stock.symbol}: Limit filled at ₹${actualEntryPrice.toFixed(2)}, ${actualQty} shares`);
          // Fall through to check stop/targets on this same day
        } else {
          // close_above: Signal only — actual entry happens at NEXT day's open
          // Check if signal is OVEREXTENDED — skip it entirely, wait for pullback
          if (premium_pct > 5) {
            console.log(`[ENTRY-SIGNAL] ${stock.symbol}: Close ₹${close.toFixed(2)} is OVEREXTENDED (+${premium_pct.toFixed(1)}%) — signal skipped, waiting for pullback`);
            sim.events.push({
              date: date instanceof Date ? date : new Date(date),
              type: 'ENTRY_SKIPPED',
              price: close,
              qty: 0,
              pnl: 0,
              detail: `Entry signal skipped — close ₹${close.toFixed(2)} is OVEREXTENDED (+${premium_pct.toFixed(1)}% above entry ₹${entry.toFixed(2)}). Wait for pullback.`
            });
            continue;  // Wait for another opportunity
          }

          // Pre-calculate qty at signal time (will be adjusted at execution based on open price)
          const plannedQty = Math.floor(capital / entry);

          // For EXTENDED entries (2-5%), pre-calculate adjusted qty using same-rupee-risk formula
          // This matches what Phase 2 trigger shows to user
          let displayQty = plannedQty;
          let qtyNote = '';
          if (premium_pct > 2) {
            const originalRiskPerShare = entry - stop;
            const newRiskPerShare = close - stop;
            const adjustedQty = Math.floor(plannedQty * originalRiskPerShare / newRiskPerShare);
            displayQty = adjustedQty;
            qtyNote = ` (EXTENDED: reduced from ${plannedQty})`;
          }

          sim.status = 'ENTRY_SIGNALED';
          sim.signal_date = date instanceof Date ? date : new Date(date);
          sim.signal_close = close;
          sim.qty_total = plannedQty;  // Store original planned qty for execution phase

          sim.events.push({
            date: sim.signal_date,
            type: 'ENTRY_SIGNAL',
            price: close,
            qty: displayQty,
            pnl: 0,
            detail: `Entry signal confirmed — close ₹${close.toFixed(2)} ${premium_pct >= 0 ? 'above' : 'at'} entry ₹${entry.toFixed(2)} (+${premium_pct.toFixed(1)}%). Buy ${displayQty} shares${qtyNote} at next day's open.`
          });

          console.log(`[ENTRY-SIGNAL] ${stock.symbol}: Close ₹${close.toFixed(2)} confirmed entry signal (+${premium_pct.toFixed(1)}%). Buy ${displayQty} shares${qtyNote} at next day's open.`);

          continue;  // Don't check stop/targets — not in trade yet
        }
      } else {
        continue; // No signal yet, next day
      }
    }

    // ══════════════════════════════════════════════
    // TERMINAL: Skip if trade already done
    // ══════════════════════════════════════════════
    if (sim.status === 'STOPPED_OUT' || sim.status === 'FULL_EXIT') {
      continue;
    }

    // Track peak price since entry
    if (high > sim.peak_price) {
      sim.peak_price = high;
      sim.peak_gain_pct = ((high - sim.entry_price) / sim.entry_price) * 100;
    }

    // ══════════════════════════════════════════════
    // CHECK STOP LOSS (always check first — worst case)
    // ══════════════════════════════════════════════
    if (low <= sim.trailing_stop) {
      const exitPrice = sim.trailing_stop;
      const pnl = (exitPrice - sim.entry_price) * sim.qty_remaining;
      sim.realized_pnl += pnl;
      const isTrailing = sim.trailing_stop > stop;
      sim.events.push({
        date,
        type: isTrailing ? 'TRAILING_STOP' : 'STOPPED_OUT',
        price: exitPrice,
        qty: sim.qty_remaining,
        pnl: Math.round(pnl),
        detail: isTrailing
          ? `Trailing stop hit at ₹${exitPrice.toFixed(2)} — exited ${sim.qty_remaining} shares (profit locked from T1)`
          : `Stop loss hit at ₹${exitPrice.toFixed(2)} — exited ${sim.qty_remaining} shares`
      });
      sim.qty_exited += sim.qty_remaining;
      sim.qty_remaining = 0;
      sim.status = 'STOPPED_OUT';
      continue;
    }

    // ══════════════════════════════════════════════
    // CHECK T1 — 50% booking
    // ══════════════════════════════════════════════
    if (sim.status === 'ENTERED' && t1 && high >= t1) {
      const exitQty = Math.floor(sim.qty_total / 2);
      const pnl = (t1 - sim.entry_price) * exitQty;
      sim.realized_pnl += pnl;
      sim.qty_remaining -= exitQty;
      sim.qty_exited += exitQty;
      sim.trailing_stop = sim.entry_price;  // Move stop to breakeven
      sim.status = 'PARTIAL_EXIT';
      sim.events.push({
        date,
        type: 'T1_HIT',
        price: t1,
        qty: exitQty,
        pnl: Math.round(pnl),
        detail: `T1 hit! Booked 50% (${exitQty} shares) at ₹${t1.toFixed(2)} | +₹${Math.round(pnl).toLocaleString('en-IN')} locked | Stop → entry ₹${sim.entry_price.toFixed(2)} (risk-free)`
      });

      // Same day: also check T2 (and T3 if exists)
      if (t2 && high >= t2) {
        // If T3 exists: book 70%, keep 30% for T3
        // If T3 does NOT exist: book 100% (full exit at T2)
        const t2ExitQty = t3 ? Math.floor(sim.qty_remaining * 0.7) : sim.qty_remaining;
        const t2KeepQty = sim.qty_remaining - t2ExitQty;
        const t2Pnl = (t2 - sim.entry_price) * t2ExitQty;
        sim.realized_pnl += t2Pnl;
        sim.qty_remaining = t2KeepQty;
        sim.qty_exited += t2ExitQty;

        // If holding for T3, move trailing stop to T2
        if (t3) {
          sim.trailing_stop = t2;
        }

        const t2DetailMsg = t3
          ? `T2 hit! Booked 70% (${t2ExitQty} shares) at ₹${t2.toFixed(2)} | Holding ${t2KeepQty} for T3 (₹${t3.toFixed(2)}) | Stop → T2 ₹${t2.toFixed(2)}`
          : `T2 hit! Booked 100% (${t2ExitQty} shares) at ₹${t2.toFixed(2)} — FULL TARGET (no T3) 🏆`;
        sim.events.push({
          date,
          type: 'T2_HIT',
          price: t2,
          qty: t2ExitQty,
          pnl: Math.round(t2Pnl),
          detail: t2DetailMsg
        });

        if (!t3) {
          sim.status = 'FULL_EXIT';
        }

        // Same day: also check T3 (if it exists and we haven't already full exited)
        if (t3 && high >= t3 && sim.qty_remaining > 0) {
          const t3Pnl = (t3 - sim.entry_price) * sim.qty_remaining;
          sim.realized_pnl += t3Pnl;
          sim.events.push({
            date,
            type: 'T3_HIT',
            price: t3,
            qty: sim.qty_remaining,
            pnl: Math.round(t3Pnl),
            detail: `T3 hit! Booked remaining ${sim.qty_remaining} shares at ₹${t3.toFixed(2)} — FULL TARGET 🏆`
          });
          sim.qty_exited += sim.qty_remaining;
          sim.qty_remaining = 0;
          sim.status = 'FULL_EXIT';
        }
      }
      continue;
    }

    // ══════════════════════════════════════════════
    // CHECK T2 (main swing target - only after PARTIAL_EXIT from T1)
    // If T3 exists: book 70%, keep 30% for T3
    // If T3 does NOT exist: book 100% (full exit)
    // ══════════════════════════════════════════════
    if (sim.status === 'PARTIAL_EXIT' && t2 && high >= t2) {
      // Check if we already logged T2_HIT (don't double-book)
      const alreadyHitT2 = sim.events.some(e => e.type === 'T2_HIT');
      if (!alreadyHitT2) {
        // If T3 exists: book 70%, keep 30% for T3
        // If T3 does NOT exist: book 100% (full exit at T2)
        const exitQty = t3 ? Math.floor(sim.qty_remaining * 0.7) : sim.qty_remaining;
        const keepQty = sim.qty_remaining - exitQty;
        const pnl = (t2 - sim.entry_price) * exitQty;
        sim.realized_pnl += pnl;
        sim.qty_remaining = keepQty;
        sim.qty_exited += exitQty;

        // If holding for T3, move trailing stop to T2
        if (t3) {
          sim.trailing_stop = t2;
        }

        const detailMsg = t3
          ? `T2 hit! Booked 70% (${exitQty} shares) at ₹${t2.toFixed(2)} | Holding ${keepQty} for T3 (₹${t3.toFixed(2)}) | Stop → T2 ₹${t2.toFixed(2)}`
          : `T2 hit! Booked 100% (${exitQty} shares) at ₹${t2.toFixed(2)} — FULL TARGET (no T3) 🏆`;
        sim.events.push({
          date,
          type: 'T2_HIT',
          price: t2,
          qty: exitQty,
          pnl: Math.round(pnl),
          detail: detailMsg
        });

        if (!t3) {
          sim.status = 'FULL_EXIT';
          continue;
        }
      }

      // Same day: also check T3 (if it exists)
      if (t3 && high >= t3 && sim.qty_remaining > 0) {
        const pnl = (t3 - sim.entry_price) * sim.qty_remaining;
        sim.realized_pnl += pnl;
        sim.events.push({
          date,
          type: 'T3_HIT',
          price: t3,
          qty: sim.qty_remaining,
          pnl: Math.round(pnl),
          detail: `T3 hit! Booked remaining ${sim.qty_remaining} shares at ₹${t3.toFixed(2)} — FULL TARGET 🏆`
        });
        sim.qty_exited += sim.qty_remaining;
        sim.qty_remaining = 0;
        sim.status = 'FULL_EXIT';
        continue;
      }
    }

    // ══════════════════════════════════════════════
    // CHECK T3 — final 30% (only if T3 exists and after T2 hit)
    // ══════════════════════════════════════════════
    if (sim.status === 'PARTIAL_EXIT' && t3 && high >= t3) {
      const pnl = (t3 - sim.entry_price) * sim.qty_remaining;
      sim.realized_pnl += pnl;
      sim.events.push({
        date,
        type: 'T3_HIT',
        price: t3,
        qty: sim.qty_remaining,
        pnl: Math.round(pnl),
        detail: `T3 hit! Booked remaining ${sim.qty_remaining} shares at ₹${t3.toFixed(2)} — FULL TARGET 🏆`
      });
      sim.qty_exited += sim.qty_remaining;
      sim.qty_remaining = 0;
      sim.status = 'FULL_EXIT';
      continue;
    }

    // ══════════════════════════════════════════════
    // WEEK-END RULES (on last trading day)
    // ══════════════════════════════════════════════
    if (dayCount >= maxHoldDays && sim.qty_remaining > 0) {

      // Rule: exit_if_no_t1 — T1 never hit, close position at market
      if (weekEndRule === 'exit_if_no_t1' && sim.status === 'ENTERED') {
        const pnl = (close - sim.entry_price) * sim.qty_remaining;
        sim.realized_pnl += pnl;
        sim.events.push({
          date,
          type: 'WEEK_END_EXIT',
          price: close,
          qty: sim.qty_remaining,
          pnl: Math.round(pnl),
          detail: `Week ended — T1 not reached. Exited ${sim.qty_remaining} shares at ₹${close.toFixed(2)} (${pnl >= 0 ? 'profit' : 'loss'})`
        });
        sim.qty_exited += sim.qty_remaining;
        sim.qty_remaining = 0;
        sim.status = 'FULL_EXIT';
        continue;
      }

      // Rule: hold_if_above_entry — pullback setups can carry over
      if (weekEndRule === 'hold_if_above_entry') {
        if (close >= sim.entry_price) {
          sim.events.push({
            date,
            type: 'WEEK_END_HOLD',
            price: close,
            qty: 0,
            pnl: 0,
            detail: `Week ended — above entry ₹${sim.entry_price.toFixed(2)}, position held`
          });
        } else {
          // Below entry on Friday — exit
          const pnl = (close - sim.entry_price) * sim.qty_remaining;
          sim.realized_pnl += pnl;
          sim.events.push({
            date,
            type: 'WEEK_END_EXIT',
            price: close,
            qty: sim.qty_remaining,
            pnl: Math.round(pnl),
            detail: `Week ended — below entry. Exited ${sim.qty_remaining} shares at ₹${close.toFixed(2)}`
          });
          sim.qty_exited += sim.qty_remaining;
          sim.qty_remaining = 0;
          sim.status = 'FULL_EXIT';
        }
        continue;
      }

      // Rule: trail_or_exit — 52W breakout, tighten stop
      if (weekEndRule === 'trail_or_exit') {
        const prevDay = dayCount >= 2 ? snapshots[dayCount - 2] : null;
        if (prevDay) {
          const newTrail = Math.max(sim.trailing_stop, prevDay.low);
          if (newTrail > sim.trailing_stop) {
            sim.trailing_stop = newTrail;
            sim.events.push({
              date,
              type: 'TRAIL_TIGHTENED',
              price: newTrail,
              qty: 0,
              pnl: 0,
              detail: `Week ending — trailing stop tightened to ₹${newTrail.toFixed(2)} (previous day's low)`
            });
          }
        }
        // Don't force exit — let trail handle it next week
        continue;
      }
    }
  }

  // ══════════════════════════════════════════════
  // FINAL P&L CALCULATION
  // ══════════════════════════════════════════════
  if (sim.qty_remaining > 0 && sim.entry_price) {
    sim.unrealized_pnl = (currentPrice - sim.entry_price) * sim.qty_remaining;
  }
  sim.total_pnl = Math.round(sim.realized_pnl + sim.unrealized_pnl);
  sim.realized_pnl = Math.round(sim.realized_pnl);
  sim.unrealized_pnl = Math.round(sim.unrealized_pnl);
  sim.total_return_pct = parseFloat(((sim.total_pnl / capital) * 100).toFixed(2));
  sim.peak_gain_pct = parseFloat((sim.peak_gain_pct || 0).toFixed(2));

  return sim;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SERVICE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run Phase 1: Status update for all stocks
 * @param {Object} options - { targetDate: string (YYYY-MM-DD), dryRun: boolean }
 * @returns {{ phase1Results: Object[], phase2Queue: Object[] }}
 */
async function runPhase1(options = {}) {
  const { targetDate, dryRun, forceEntrySignaled } = options;
  const runLabel = dryRun ? '[DAILY-TRACK-P1-DRYRUN]' : '[DAILY-TRACK-P1]';
  console.log(`${runLabel} Starting Phase 1: Status Update...`);
  if (targetDate) console.log(`${runLabel} Target date: ${targetDate}`);
  if (dryRun) console.log(`${runLabel} DRY RUN MODE - no changes will be saved`);

  // Get current week's watchlist
  const watchlist = await WeeklyWatchlist.getCurrentWeek();
  if (!watchlist || watchlist.stocks.length === 0) {
    console.log(`${runLabel} No active watchlist or no stocks. Skipping.`);
    return { phase1Results: [], phase2Queue: [], stocksMap: new Map() };
  }

  console.log(`${runLabel} Found ${watchlist.stocks.length} stocks in watchlist: ${watchlist.week_label}`);

  // Filter to only stocks with valid levels (target2 is the main target)
  const validStocks = watchlist.stocks.filter(s => s.levels?.entry && s.levels?.stop && s.levels?.target2);
  console.log(`${runLabel} ${validStocks.length} stocks have valid levels`);

  if (validStocks.length === 0) {
    console.log(`${runLabel} No stocks with valid levels. Skipping.`);
    return { phase1Results: [], phase2Queue: [], stocksMap: new Map() };
  }

  // Create stocksMap for Kite integration (symbol → stock object)
  const stocksMap = new Map();
  validStocks.forEach(s => stocksMap.set(s.symbol, s));

  // Get IST date components
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const weekStartUtc = new Date(watchlist.week_start);
  const weekStartIst = new Date(weekStartUtc.getTime() + IST_OFFSET_MS);
  const weekStartDateStr = weekStartIst.toISOString().split('T')[0];

  // Determine processing date (targetDate or today)
  let processingDateStr;
  let processingDate;
  if (targetDate) {
    processingDateStr = targetDate;
    processingDate = new Date(targetDate + 'T10:30:00.000Z'); // 4 PM IST
  } else {
    const todayIst = new Date(Date.now() + IST_OFFSET_MS);
    processingDateStr = todayIst.toISOString().split('T')[0];
    processingDate = new Date();
  }

  console.log(`${runLabel} Week start: ${weekStartDateStr}, Processing date: ${processingDateStr}`);

  // Extract symbols for batch fetch
  const symbols = validStocks.map(s => s.symbol);
  console.log(`${runLabel} Fetching daily data for: ${symbols.join(', ')}`);

  let dailyDataMap;
  let nifty_change_pct = 0;

  if (targetDate) {
    // ══════════════════════════════════════════════════════════════════
    // HISTORICAL MODE: Fetch candles from stockDb for the target date
    // ══════════════════════════════════════════════════════════════════
    console.log(`${runLabel} HISTORICAL MODE: Fetching candles for ${targetDate}`);
    dailyDataMap = new Map();

    for (const stock of validStocks) {
      try {
        const candles = await getDailyCandlesForRange(stock.instrument_key, weekStartDateStr, targetDate);
        const targetCandle = candles?.find(c => c.date.toISOString().split('T')[0] === targetDate);

        if (targetCandle) {
          // Find prev_close from the candle before targetDate for gap detection
          const targetIndex = candles.findIndex(c => c.date.toISOString().split('T')[0] === targetDate);
          const prevCandle = targetIndex > 0 ? candles[targetIndex - 1] : null;

          // Build dailyData structure matching what getDailyAnalysisData returns
          dailyDataMap.set(stock.symbol, {
            symbol: stock.symbol,
            ltp: targetCandle.close,
            open: targetCandle.open,
            high: targetCandle.high,
            low: targetCandle.low,
            todays_volume: targetCandle.volume,
            prev_close: prevCandle ? prevCandle.close : 0,  // Previous trading day's close for gap detection
            avg_volume_50d: 0,  // Not available from historical data
            daily_rsi: null,    // Not available from historical data
            _candles: candles   // Store all candles for simulation
          });
          console.log(`${runLabel} ${stock.symbol}: Got candle for ${targetDate} — Close: ₹${targetCandle.close.toFixed(2)}, Prev close: ${prevCandle ? '₹' + prevCandle.close.toFixed(2) : 'N/A'}`);
        } else {
          console.log(`${runLabel} ${stock.symbol}: No candle for ${targetDate}`);
        }
      } catch (err) {
        console.error(`${runLabel} ${stock.symbol}: Error fetching candles:`, err.message);
      }
    }
  } else {
    // ══════════════════════════════════════════════════════════════════
    // LIVE MODE: Use getDailyAnalysisData for real-time prices
    // ══════════════════════════════════════════════════════════════════
    const dailyDataResponse = await getDailyAnalysisData(symbols);
    const { stocks: dailyDataArray, nifty_change_pct: niftyPct } = dailyDataResponse;
    nifty_change_pct = niftyPct;
    dailyDataMap = new Map(dailyDataArray.map(d => [d.symbol, d]));
  }

  const phase1Results = [];
  const phase2Queue = [];

  // Process each stock
  for (const stock of validStocks) {
    const dailyData = dailyDataMap.get(stock.symbol);

    if (!dailyData || !dailyData.ltp || dailyData.ltp <= 0) {
      if (forceEntrySignaled) console.log(`${runLabel} ⏭️ ${stock.symbol} - SKIP forced signal (no valid price data)`);
      else console.log(`${runLabel} ⏭️ ${stock.symbol} - SKIP (no valid price data)`);
      continue;
    }

    // ── FORCE ENTRY_SIGNALED: Must come before terminal state check ──
    if (forceEntrySignaled === true || forceEntrySignaled?.includes?.(stock.symbol)) {
      const sim = stock.trade_simulation || { events: [] };
      if (!sim.events) sim.events = [];

      // Force to ENTRY_SIGNALED regardless of current status
      if (sim.status !== 'ENTRY_SIGNALED') {
        console.log(`${runLabel} 🔥 ${stock.symbol}: Overriding ${sim.status || 'N/A'} → ENTRY_SIGNALED`);
        const signalPrice = stock.levels.entry;
        const qty = Math.floor((sim.capital || 100000) / signalPrice);
        sim.status = 'ENTRY_SIGNALED';
        sim.signal_date = new Date();
        sim.signal_close = signalPrice;
        sim.capital = sim.capital || 100000;
        sim.qty_total = qty;
        sim.events.push({
          date: new Date(), type: 'ENTRY_SIGNAL', price: signalPrice, qty, pnl: 0,
          detail: `[FORCED] Entry: ₹${signalPrice.toFixed(2)}, Qty: ${qty}`
        });
        stock.trade_simulation = sim;
        stock.tracking_status = 'ABOVE_ENTRY';
        if (stock.grade !== 'A+' && stock.grade !== 'A') stock.grade = 'A+';
        console.log(`${runLabel} 🔥 ${stock.symbol}: Set ENTRY_SIGNALED, tracking_status → ABOVE_ENTRY (Entry: ₹${signalPrice}, Qty: ${qty}, Grade: ${stock.grade}, LTP: ₹${dailyData.ltp})`);
      } else {
        // Still reset tracking_status in case it's stale (e.g., EXPIRED)
        if (stock.tracking_status === 'EXPIRED' || stock.tracking_status === 'PARTIAL_EXIT') {
          stock.tracking_status = 'ABOVE_ENTRY';
          console.log(`${runLabel} 🔥 ${stock.symbol}: Already ENTRY_SIGNALED, tracking_status → ABOVE_ENTRY (Entry: ₹${stock.levels.entry}, LTP: ₹${dailyData.ltp})`);
        } else {
          console.log(`${runLabel} 🔥 ${stock.symbol}: Already ENTRY_SIGNALED (Entry: ₹${stock.levels.entry}, LTP: ₹${dailyData.ltp})`);
        }
      }

      phase1Results.push({
        symbol: stock.symbol, instrument_key: stock.instrument_key,
        oldStatus: stock.tracking_status, newStatus: stock.tracking_status,
        oldFlags: stock.tracking_flags || [], newFlags: stock.tracking_flags || [],
        ltp: dailyData.ltp, statusChanged: false, phase2Triggered: false, phase2Reason: null,
        simulation: { status: stock.trade_simulation?.status, total_pnl: stock.trade_simulation?.total_pnl || 0, total_return_pct: stock.trade_simulation?.total_return_pct || 0 }
      });
      continue;
    }

    // ── OPTIMIZATION: Skip full processing for terminal simulation states ──
    // Trade story is complete — just save today's snapshot for historical record
    const simTerminalStates = ['FULL_EXIT', 'STOPPED_OUT'];
    if (simTerminalStates.includes(stock.trade_simulation?.status)) {
      const termPnl = stock.trade_simulation.total_pnl || 0;
      const termPnlStr = termPnl >= 0 ? `+₹${termPnl.toLocaleString('en-IN')}` : `-₹${Math.abs(termPnl).toLocaleString('en-IN')}`;
      console.log(`${runLabel} ⏭️ ${stock.symbol} — ${stock.trade_simulation.status} (${termPnlStr}), snapshot only`);

      // Build minimal snapshot for historical record
      const existingSnapshotIndex = stock.daily_snapshots?.findIndex(
        s => s.date.toISOString().split('T')[0] === processingDateStr
      );

      const terminalSnapshot = {
        date: processingDate,
        open: dailyData.open,
        high: dailyData.high,
        low: dailyData.low,
        close: dailyData.ltp,
        volume: dailyData.todays_volume,
        volume_vs_avg: dailyData.avg_volume_50d > 0
          ? parseFloat((dailyData.todays_volume / dailyData.avg_volume_50d).toFixed(2))
          : null,
        rsi: dailyData.daily_rsi,
        tracking_status: stock.tracking_status,  // Keep terminal status
        tracking_flags: [],
        nifty_change_pct: nifty_change_pct,
        phase2_triggered: false
      };

      if (existingSnapshotIndex >= 0) {
        stock.daily_snapshots[existingSnapshotIndex] = terminalSnapshot;
      } else {
        if (!stock.daily_snapshots) stock.daily_snapshots = [];
        stock.daily_snapshots.push(terminalSnapshot);
      }

      // Add to results without full processing
      phase1Results.push({
        symbol: stock.symbol,
        instrument_key: stock.instrument_key,
        oldStatus: stock.tracking_status,
        newStatus: stock.tracking_status,
        oldFlags: [],
        newFlags: [],
        ltp: dailyData.ltp,
        statusChanged: false,
        phase2Triggered: false,
        phase2Reason: null,
        simulation: {
          status: stock.trade_simulation.status,
          total_pnl: stock.trade_simulation.total_pnl,
          total_return_pct: stock.trade_simulation.total_return_pct
        }
      });
      continue;  // Skip to next stock
    }

    // ══════════════════════════════════════════════════════════════════
    // BACKFILL: If no snapshots exist, fetch historical daily candles
    // This catches cases where the stock was added mid-week
    // ══════════════════════════════════════════════════════════════════
    if (!stock.daily_snapshots || stock.daily_snapshots.length === 0) {
      console.log(`${runLabel} ${stock.symbol}: No snapshots — attempting historical backfill from ${weekStartDateStr} to ${processingDateStr}`);

      try {
        const historicalCandles = await getDailyCandlesForRange(stock.instrument_key, weekStartDateStr, processingDateStr);

        if (historicalCandles && historicalCandles.length > 0) {
          console.log(`${runLabel} ${stock.symbol}: BACKFILL — got ${historicalCandles.length} historical daily candles`);

          // Add all historical candles as snapshots (excluding today, which we'll add with full data below)
          const processingDateStrForComparison = processingDateStr;
          stock.daily_snapshots = historicalCandles
            .filter(c => {
              const candleDateStr = c.date.toISOString().split('T')[0];
              return candleDateStr !== processingDateStrForComparison;
            })
            .map(c => ({
              date: c.date,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
              is_backfill: true
            }));

          console.log(`${runLabel} ${stock.symbol}: BACKFILL — added ${stock.daily_snapshots.length} historical snapshots`);
        } else {
          console.log(`${runLabel} ${stock.symbol}: BACKFILL — no historical candles found`);
          stock.daily_snapshots = [];
        }
      } catch (backfillError) {
        console.error(`${runLabel} ${stock.symbol}: BACKFILL error:`, backfillError.message);
        stock.daily_snapshots = [];
      }
    }

    // Get previous snapshot (if any)
    const prevSnapshot = stock.daily_snapshots?.length > 0
      ? stock.daily_snapshots[stock.daily_snapshots.length - 1]
      : null;

    // Compact per-stock input log (replaces verbose object dumps)
    const prevStatus = prevSnapshot?.tracking_status || 'NEW';
    const dayChg = dailyData.prev_close ? ((dailyData.ltp - dailyData.prev_close) / dailyData.prev_close * 100).toFixed(1) : '?';
    const volRatio = dailyData.avg_volume_50d > 0 ? (dailyData.todays_volume / dailyData.avg_volume_50d).toFixed(1) + 'x' : '?';
    console.log(`[DAILY-TRACK-P1] ${stock.symbol}: ₹${dailyData.ltp} (${dayChg}%) | RSI=${dailyData.daily_rsi?.toFixed(1) || '?'} Vol=${volRatio} | prev=${prevStatus} | E=₹${stock.levels.entry} S=₹${stock.levels.stop} T1=${stock.levels.target1 || '-'} T2=₹${stock.levels.target2}`);

    // Calculate new status and flags
    const oldStatus = stock.tracking_status || 'WATCHING';
    const oldFlags = stock.tracking_flags || [];

    let newStatus = calculateStatus(dailyData, stock.levels, stock.symbol);
    const newFlags = calculateFlags(dailyData, stock.levels, stock.symbol);

    // Calculate distance percentages (target2 is the main target)
    const distFromEntry = ((dailyData.ltp - stock.levels.entry) / stock.levels.entry) * 100;
    const distFromStop = ((dailyData.ltp - stock.levels.stop) / stock.levels.stop) * 100;
    const distFromTarget = ((dailyData.ltp - stock.levels.target2) / stock.levels.target2) * 100;

    // Build daily snapshot
    const snapshot = {
      date: processingDate,
      open: dailyData.open,
      high: dailyData.high,
      low: dailyData.low,
      close: dailyData.ltp,
      volume: dailyData.todays_volume,
      volume_vs_avg: dailyData.avg_volume_50d > 0
        ? parseFloat((dailyData.todays_volume / dailyData.avg_volume_50d).toFixed(2))
        : null,
      rsi: dailyData.daily_rsi,
      distance_from_entry_pct: parseFloat(distFromEntry.toFixed(2)),
      distance_from_stop_pct: parseFloat(distFromStop.toFixed(2)),
      distance_from_target_pct: parseFloat(distFromTarget.toFixed(2)),
      tracking_status: newStatus,
      tracking_flags: newFlags,
      nifty_change_pct: nifty_change_pct,
      phase2_triggered: false  // Updated after simulation sync below
    };

    // Update stock in watchlist
    stock.tracking_status = newStatus;
    stock.tracking_flags = newFlags;

    if (newStatus !== oldStatus) {
      stock.previous_status = oldStatus;
      stock.status_changed_at = processingDate;
    }

    // Add snapshot (replace any existing snapshot for today, including intraday)
    // processingDateStr is already defined at the top of the loop
    const existingSnapshotIndex = stock.daily_snapshots?.findIndex(s => {
      const snapDateStr = s.date.toISOString().split('T')[0];
      return snapDateStr === processingDateStr;
    });

    if (existingSnapshotIndex >= 0) {
      // Replace existing snapshot (could be intraday or from backfill) with full EOD data
      const wasIntraday = stock.daily_snapshots[existingSnapshotIndex].is_intraday;
      if (wasIntraday) {
        console.log(`${runLabel} ${stock.symbol}: Replacing intraday snapshot with EOD data`);
      }
      stock.daily_snapshots[existingSnapshotIndex] = snapshot;
    } else {
      if (!stock.daily_snapshots) stock.daily_snapshots = [];
      stock.daily_snapshots.push(snapshot);
    }

    // ── RUN TRADE SIMULATION ──
    // Replay ALL snapshots to calculate entry, exits, and P&L
    const allSnapshots = stock.daily_snapshots.map(s => ({
      date: s.date,
      open: s.open,
      high: s.high,
      low: s.low,
      close: s.close
    }));
    stock.trade_simulation = simulateTrade(stock, allSnapshots, dailyData.ltp);

    // Log simulation result with event summary
    const simStatus = stock.trade_simulation.status;
    const pnl = stock.trade_simulation.total_pnl;
    const pnlStr = pnl >= 0 ? `+₹${pnl.toLocaleString('en-IN')}` : `-₹${Math.abs(pnl).toLocaleString('en-IN')}`;
    const simEvents = stock.trade_simulation.events?.map(e => e.type).join('→') || 'none';
    const qtyRemain = stock.trade_simulation.qty_remaining || 0;
    const peakPct = stock.trade_simulation.peak_gain_pct || 0;
    console.log(`[DAILY-TRACK-SIM] ${stock.symbol}: ${simStatus} | P&L=${pnlStr} (${stock.trade_simulation.total_return_pct}%) | peak=${peakPct}% | qty_left=${qtyRemain} | events=[${simEvents}]`);

    // ── SYNC tracking_status WITH SIMULATION STATES ──
    // Simulation is the source of truth for trade outcomes
    // Check for TARGET_HIT by looking at events (simulation doesn't have a TARGET_HIT status)
    const hasTargetHitEvent = stock.trade_simulation.events?.some(e => e.type === 'TARGET_HIT');
    const hasT1HitEvent = stock.trade_simulation.events?.some(e => e.type === 'T1_HIT');

    if (simStatus === 'FULL_EXIT' && stock.tracking_status !== 'FULL_EXIT') {
      stock.previous_status = stock.tracking_status;
      stock.tracking_status = 'FULL_EXIT';
      stock.status_changed_at = processingDate;
      newStatus = 'FULL_EXIT';  // Update for logging
    }
    else if (simStatus === 'STOPPED_OUT' && stock.tracking_status !== 'STOPPED_OUT') {
      stock.previous_status = stock.tracking_status;
      stock.tracking_status = 'STOPPED_OUT';
      stock.status_changed_at = processingDate;
      newStatus = 'STOPPED_OUT';
    }
    else if (simStatus === 'PARTIAL_EXIT' && hasTargetHitEvent && stock.tracking_status !== 'TARGET_HIT') {
      // Main target was hit - 70% booked, holding 30% for T2
      stock.previous_status = stock.tracking_status;
      stock.tracking_status = 'TARGET_HIT';
      stock.status_changed_at = processingDate;
      newStatus = 'TARGET_HIT';
    }
    else if (simStatus === 'PARTIAL_EXIT' && hasT1HitEvent && !hasTargetHitEvent && stock.tracking_status !== 'TARGET1_HIT') {
      // Only T1 hit - 50% booked, trailing to Target
      stock.previous_status = stock.tracking_status;
      stock.tracking_status = 'TARGET1_HIT';
      stock.status_changed_at = processingDate;
      newStatus = 'TARGET1_HIT';
    }
    else if (simStatus === 'EXPIRED' && stock.tracking_status !== 'EXPIRED') {
      stock.previous_status = stock.tracking_status;
      stock.tracking_status = 'EXPIRED';
      stock.status_changed_at = processingDate;
      newStatus = 'EXPIRED';
    }
    else if (simStatus === 'ENTRY_SIGNALED' && stock.tracking_status === 'EXPIRED') {
      // Edge case: simulation signaled entry but tracking_status is stale
      stock.previous_status = stock.tracking_status;
      stock.tracking_status = 'ABOVE_ENTRY';
      stock.status_changed_at = processingDate;
      newStatus = 'ABOVE_ENTRY';
    }

    // Update snapshot with simulation-corrected status
    snapshot.tracking_status = newStatus;

    // Check if Phase 2 should trigger (AFTER simulation sync so status is accurate)
    const { trigger, reason } = shouldTriggerPhase2(newStatus, oldStatus, newFlags, oldFlags, dailyData, stock.levels, stock.symbol);
    snapshot.phase2_triggered = trigger;

    // Check if trade is in terminal state
    const isTerminal = ['FULL_EXIT', 'STOPPED_OUT', 'EXPIRED'].includes(simStatus);

    const result = {
      symbol: stock.symbol,
      instrument_key: stock.instrument_key,
      oldStatus,
      newStatus,
      oldFlags,
      newFlags,
      ltp: dailyData.ltp,
      statusChanged: newStatus !== oldStatus,
      phase2Triggered: trigger && !isTerminal,  // Don't trigger Phase 2 for terminal states
      phase2Reason: reason,
      simulation: {
        status: simStatus,
        total_pnl: pnl,
        total_return_pct: stock.trade_simulation.total_return_pct
      }
    };

    phase1Results.push(result);

    // Skip Phase 2 for terminal states — trade story is complete
    if (isTerminal) {
      console.log(`${runLabel} ⏭️ ${stock.symbol}: ${oldStatus} → ${newStatus} | Sim: ${simStatus} (${pnlStr}) [TRADE COMPLETE - SKIP PHASE 2]`);
    } else if (trigger) {
      // Queue for Phase 2 WITH simulation state
      phase2Queue.push({
        stock,
        dailyData,
        triggerReason: reason,
        snapshot,
        tradeSimulation: stock.trade_simulation,  // Pass simulation state to Phase 2
        processingDate  // Pass the target date for analysis timestamp
      });
      console.log(`${runLabel} 🎯 ${stock.symbol}: ${oldStatus} → ${newStatus} | Sim: ${simStatus} (${pnlStr}) [PHASE 2 QUEUED: ${reason}]`);
    } else if (newStatus !== oldStatus) {
      console.log(`${runLabel} 📊 ${stock.symbol}: ${oldStatus} → ${newStatus} | Sim: ${simStatus} (${pnlStr})`);
    } else {
      console.log(`${runLabel} ✓ ${stock.symbol}: ${newStatus} | Sim: ${simStatus} (${pnlStr})`);
    }
  }

  // Save watchlist with all updates (skip if dry run)
  if (!dryRun) {
    await watchlist.save();
    console.log(`${runLabel} ✅ Phase 1 complete. ${phase1Results.length} stocks processed, ${phase2Queue.length} queued for Phase 2`);
  } else {
    console.log(`${runLabel} ✅ Phase 1 complete (DRY RUN - not saved). ${phase1Results.length} stocks processed, ${phase2Queue.length} would be queued for Phase 2`);
  }

  return { phase1Results, phase2Queue, stocksMap, watchlist };
}

/**
 * Run Phase 2: AI analysis for triggered stocks
 * @param {Object[]} phase2Queue - Array of { stock, dailyData, triggerReason, snapshot, tradeSimulation }
 * @param {Object|null} watchlist - Watchlist reference from Phase 1 (avoids re-fetching from DB)
 * @returns {Object[]} - Results array
 */
async function runPhase2(phase2Queue, watchlist = null) {
  const runLabel = '[DAILY-TRACK-P2]';

  if (phase2Queue.length === 0) {
    console.log(`${runLabel} No stocks queued for Phase 2. Skipping AI calls.`);
    return [];
  }

  // Use watchlist from Phase 1 if available, otherwise fetch once from DB
  const wl = watchlist || await WeeklyWatchlist.getCurrentWeek();

  console.log(`${runLabel} Starting Phase 2: AI Analysis for ${phase2Queue.length} stocks...`);

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const results = [];

  for (const item of phase2Queue) {
    const { stock, dailyData, triggerReason, snapshot, tradeSimulation, processingDate } = item;

    try {
      console.log(`${runLabel} 🤖 Analyzing ${stock.symbol}...`);

      // Get the weekend swing analysis for context
      const weekendAnalysis = await StockAnalysis.findOne({
        instrument_key: stock.instrument_key,
        analysis_type: 'swing',
        status: 'completed'
      }).sort({ created_at: -1 }).lean();

      // Fetch today's news for this stock (if any)
      const recentNews = await fetchRecentNewsForStock(stock.symbol, stock.instrument_key);

      // Build prompt with simulation state
      const { system, user } = buildDailyTrackPrompt({
        stock,
        weekendAnalysis,
        dailyData,
        triggerReason,
        snapshot,
        recentNews,
        tradeSimulation  // Pass simulation state to prompt builder
      });

      // Call Claude
      const startTime = Date.now();
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        temperature: 0.2,
        system,
        messages: [{ role: 'user', content: user }]
      });

      const duration = Date.now() - startTime;
      const content = response.content[0]?.text;

      if (!content) {
        throw new Error('Empty response from Claude');
      }

      // Parse JSON response
      let analysisData;
      try {
        // Extract JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in response');
        }
        analysisData = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error(`${runLabel} JSON parse error for ${stock.symbol}:`, parseError.message);
        console.error(`${runLabel} Raw content:`, content.substring(0, 500));
        throw new Error(`JSON parse failed: ${parseError.message}`);
      }

      // Log API usage
      await ApiUsage.create({
        provider: 'ANTHROPIC',
        model: 'claude-sonnet-4-20250514',
        feature: 'DAILY_TRACK',
        tokens: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0,
          total: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
        },
        usage_date: getTodayStart(),
        context: {
          symbol: stock.symbol,
          description: `Daily track Phase 2: ${triggerReason}`
        }
      });

      // Calculate valid_until (next trading day 9 AM IST from the processing date)
      const validUntil = getNextDay9AM(processingDate);

      // Save to StockAnalysis
      // Use processingDate for the analysis timestamp (matches the trading day being analyzed)
      const analysisDate = processingDate || new Date();
      const analysisDayStart = new Date(analysisDate);
      analysisDayStart.setUTCHours(0, 0, 0, 0);
      const analysisDayEnd = new Date(analysisDate);
      analysisDayEnd.setUTCHours(23, 59, 59, 999);

      const savedAnalysis = await StockAnalysis.findOneAndUpdate(
        {
          instrument_key: stock.instrument_key,
          analysis_type: 'daily_track',
          created_at: { $gte: analysisDayStart, $lte: analysisDayEnd }
        },
        {
          instrument_key: stock.instrument_key,
          stock_name: stock.stock_name || stock.symbol,
          stock_symbol: stock.symbol,
          analysis_type: 'daily_track',
          current_price: dailyData.ltp,
          analysis_data: {
            schema_version: '2.0',
            daily_track: analysisData,
            trigger: {
              reason: triggerReason,
              old_status: snapshot.tracking_status,
              new_flags: snapshot.tracking_flags
            },
            weekend_analysis_id: weekendAnalysis?._id || null,
            original_levels: {
              entry: stock.levels.entry,
              stop: stock.levels.stop,
              target1: stock.levels.target1,
              target2: stock.levels.target2,
              target3: stock.levels.target3,
              archetype: stock.levels.archetype
            },
            daily_snapshot: {
              open: snapshot.open,
              high: snapshot.high,
              low: snapshot.low,
              close: snapshot.close,
              rsi: snapshot.rsi,
              volume: snapshot.volume,
              volume_vs_avg: snapshot.volume_vs_avg,
              nifty_change_pct: snapshot.nifty_change_pct
            }
          },
          status: 'completed',
          valid_until: validUntil,
          created_at: analysisDate  // Use processing date, not current date
        },
        { upsert: true, new: true }
      );

      // Update snapshot with analysis reference (using in-memory watchlist, no per-stock DB fetch)
      if (wl) {
        const stockInWatchlist = wl.stocks.find(s => s.instrument_key === stock.instrument_key);
        if (stockInWatchlist) {
          const lastSnapshot = stockInWatchlist.daily_snapshots[stockInWatchlist.daily_snapshots.length - 1];
          if (lastSnapshot) {
            lastSnapshot.phase2_analysis_id = savedAnalysis._id;
          }
        }
      }

      const tokensIn = response.usage?.input_tokens || 0;
      const tokensOut = response.usage?.output_tokens || 0;
      const action = analysisData?.action_recommendation?.action || analysisData?.status_assessment || '?';
      console.log(`${runLabel} ✅ ${stock.symbol}: ${action} | ${duration}ms | tokens=${tokensIn}+${tokensOut} | trigger="${triggerReason.substring(0, 60)}"`);

      results.push({
        symbol: stock.symbol,
        success: true,
        analysisId: savedAnalysis._id,
        status: analysisData.status_assessment,
        duration
      });

    } catch (error) {
      console.error(`${runLabel} ❌ ${stock.symbol}: AI analysis failed:`, error.message);
      results.push({
        symbol: stock.symbol,
        success: false,
        error: error.message
      });
    }
  }

  // Save watchlist once with all Phase 2 analysis references
  if (wl && results.some(r => r.success)) {
    try {
      await wl.save();
      console.log(`${runLabel} Watchlist saved with Phase 2 analysis references`);
    } catch (saveErr) {
      console.error(`${runLabel} Failed to save watchlist with Phase 2 references:`, saveErr.message);
    }
  }

  console.log(`${runLabel} ✅ Phase 2 complete. ${results.filter(r => r.success).length}/${results.length} successful`);
  return results;
}

/**
 * Run full daily tracking (Phase 1 + Phase 2)
 * @param {Object} options - { targetDate: string (YYYY-MM-DD), dryRun: boolean, forceReanalyze: boolean, forceEntrySignaled: string[] }
 * @returns {Object} - Full run results
 */
async function runDailyTracking(options = {}) {
  const { targetDate, dryRun, forceEntrySignaled } = options;
  const runLabel = dryRun ? '[DAILY-TRACK-DRYRUN]' : '[DAILY-TRACK]';
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`${runLabel} DAILY TRACKING STARTED`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`${runLabel} Time: ${new Date().toISOString()}`);
  if (targetDate) console.log(`${runLabel} Target date: ${targetDate}`);
  if (dryRun) console.log(`${runLabel} DRY RUN MODE - no changes will be saved`);

  try {
    // Phase 1: Status updates
    const { phase1Results, phase2Queue, stocksMap, watchlist } = await runPhase1({ targetDate, dryRun, forceEntrySignaled });

    // Kite Order Placement: Place GTT orders for ENTRY_SIGNALED stocks
    let kiteResults = null;
    console.log(`${runLabel} Kite: enabled=${isKiteIntegrationEnabled()} dryRun=${dryRun} stocks=${phase1Results?.length || 0}`);

    if (!dryRun && isKiteIntegrationEnabled()) {
      try {
        kiteResults = await processSimulationForKiteOrders(phase1Results, stocksMap);
        if (kiteResults.ordersPlaced > 0) {
          console.log(`${runLabel} Kite: ${kiteResults.ordersPlaced} GTT orders placed`);
        } else if (kiteResults.skipped) {
          console.log(`${runLabel} Kite: Skipped — ${kiteResults.reason}`);
        }
      } catch (kiteError) {
        console.error(`${runLabel} Kite order placement failed:`, kiteError.message);
        // Don't fail the entire job if Kite fails
      }
    } else {
      console.log(`${runLabel} ⏭️ Skipping Kite integration (dryRun=${dryRun}, enabled=${isKiteIntegrationEnabled()})`);
    }

    // Sync Kite GTTs — cancel stale/orphaned GTTs before placing new ones
    if (!dryRun && isKiteIntegrationEnabled()) {
      try {
        const syncResults = await syncKiteGTTs(phase1Results, stocksMap);
        console.log(`${runLabel} 🔄 Kite GTT sync: ${syncResults.cancelled} cancelled, ${syncResults.alreadyCancelled} already gone, ${syncResults.errors.length} errors`);
      } catch (syncError) {
        console.error(`${runLabel} ❌ Kite GTT sync failed:`, syncError.message);
      }
    }

    // Post-entry orders — handle T1_HIT (new OCO), ENTRY (OCO for breakout), T2_HIT
    if (!dryRun && isKiteIntegrationEnabled()) {
      try {
        const postEntryResults = await processPostEntryOrders(phase1Results, stocksMap);
        console.log(`${runLabel} 📊 Kite post-entry: ${postEntryResults.gttPlaced} placed, ${postEntryResults.errors.length} errors`);
      } catch (postError) {
        console.error(`${runLabel} ❌ Kite post-entry failed:`, postError.message);
      }
    }

    // Phase 2: AI analysis (only for triggered stocks, skip in dry run)
    let phase2Results = [];
    if (!dryRun && phase2Queue.length > 0) {
      phase2Results = await runPhase2(phase2Queue, watchlist);
    } else if (dryRun && phase2Queue.length > 0) {
      console.log(`${runLabel} SKIP Phase 2 (dry run) — would analyze ${phase2Queue.length} stocks:`);
      phase2Queue.forEach(item => {
        console.log(`  - ${item.stock.symbol}: ${item.triggerReason}`);
      });
    }

    const totalDuration = Date.now() - startTime;

    const summary = {
      success: true,
      dryRun: dryRun || false,
      targetDate: targetDate || null,
      duration_ms: totalDuration,
      phase1: {
        stocks_processed: phase1Results.length,
        status_changes: phase1Results.filter(r => r.statusChanged).length,
        phase2_triggered: phase2Queue.length
      },
      phase2: {
        stocks_analyzed: phase2Results.length,
        successful: phase2Results.filter(r => r.success).length,
        failed: phase2Results.filter(r => !r.success).length
      },
      kite: kiteResults ? {
        ordersPlaced: kiteResults.ordersPlaced || 0,
        ordersSkipped: kiteResults.ordersSkipped || 0,
        errors: kiteResults.errors?.length || 0
      } : null
    };

    console.log(`\n${runLabel} ${'─'.repeat(40)}`);
    console.log(`${runLabel} SUMMARY${dryRun ? ' (DRY RUN)' : ''}`);
    console.log(`${runLabel} Phase 1: ${summary.phase1.stocks_processed} stocks, ${summary.phase1.status_changes} changes`);
    console.log(`${runLabel} Phase 2: ${dryRun ? `${phase2Queue.length} would be analyzed` : `${summary.phase2.successful}/${summary.phase2.stocks_analyzed} AI calls succeeded`}`);
    if (summary.kite) {
      console.log(`${runLabel} Kite: ${summary.kite.ordersPlaced} orders placed, ${summary.kite.errors} errors`);
    }
    console.log(`${runLabel} Total time: ${totalDuration}ms`);
    console.log(`${'═'.repeat(60)}\n`);

    // Send push notification to all users after every run (skip in dry run)
    if (!dryRun) {
      try {
        const analyzed = summary.phase2.successful;
        const title = analyzed > 0 ? 'Daily Analysis Complete' : 'Daily Tracking Complete';
        const body = analyzed > 0
          ? `${analyzed} stock${analyzed > 1 ? 's' : ''} analyzed with status updates`
          : `${summary.phase1.stocks_processed} stocks tracked — no changes today`;
        await firebaseService.sendAnalysisCompleteToAllUsers(title, body, {
          type: 'daily_analysis',
          route: '/weekly-watchlist'
        });
        console.log(`${runLabel} 📱 Push notifications sent to all users`);
      } catch (notifError) {
        console.error(`${runLabel} ⚠️ Failed to send notifications:`, notifError.message);
      }
    }

    return summary;

  } catch (error) {
    console.error(`${runLabel} ❌ Daily tracking failed:`, error);
    return {
      success: false,
      error: error.message,
      duration_ms: Date.now() - startTime
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch recent news for a stock (stub — DailyNewsStock removed, globalMarketIntel handles news for daily picks)
 * @returns {Promise<null>} Always returns null
 */
async function fetchRecentNewsForStock(symbol, instrumentKey) {
  return null;
}

/**
 * Get today at midnight IST (returns UTC Date for MongoDB queries)
 *
 * Example: Feb 4, 4:00 PM IST = Feb 4, 10:30 UTC
 *          getTodayStart() returns Feb 3, 18:30 UTC (= Feb 4, 00:00 IST)
 */
function getTodayStart() {
  const now = new Date();
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  // Convert to IST epoch
  const istEpoch = now.getTime() + IST_OFFSET_MS;

  // Get IST date components
  const istDate = new Date(istEpoch);
  const year = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth();
  const day = istDate.getUTCDate();

  // IST midnight = that date at 00:00:00 IST = subtract IST offset for UTC
  const istMidnightUTC = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  return new Date(istMidnightUTC.getTime() - IST_OFFSET_MS);
}

/**
 * Get next day 9 AM IST (valid_until time)
 * 9 AM IST = 3:30 AM UTC
 * Skips weekends: Fri → Mon 9AM, Sat → Mon 9AM, Sun → Mon 9AM
 * @param {Date} fromDate - Base date to calculate from (defaults to now)
 */
function getNextDay9AM(fromDate = new Date()) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(fromDate.getTime() + IST_OFFSET_MS);
  const dayOfWeek = istNow.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat

  let daysToAdd = 1;
  // Skip weekends: next day should be a weekday
  if (dayOfWeek === 5) daysToAdd = 3; // Fri → Mon
  else if (dayOfWeek === 6) daysToAdd = 2; // Sat → Mon
  else if (dayOfWeek === 0) daysToAdd = 1; // Sun → Mon

  const nextDay = new Date(istNow);
  nextDay.setUTCDate(nextDay.getUTCDate() + daysToAdd);

  // Extract IST calendar date, then build 9 AM IST as UTC
  const year = nextDay.getUTCFullYear();
  const month = nextDay.getUTCMonth();
  const day = nextDay.getUTCDate();
  const utcMs = Date.UTC(year, month, day, 9, 0, 0, 0) - IST_OFFSET_MS;
  return new Date(utcMs);
}

export {
  runDailyTracking,
  runPhase1,
  runPhase2,
  calculateStatus,
  calculateFlags,
  shouldTriggerPhase2,
  simulateTrade,
  checkEntryQuality
};

export default {
  runDailyTracking,
  runPhase1,
  runPhase2,
  simulateTrade,
  checkEntryQuality
};
