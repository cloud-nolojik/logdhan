/**
 * SHARED TRADING DECISIONS — Pure functions used by BOTH live system & backtest
 *
 * This module contains ALL trading decision logic as pure functions.
 * Each function takes inputs and returns a decision — no side effects,
 * no API calls, no state mutation.
 *
 * The CALLER (live system or backtest) is responsible for:
 *   - Feeding the right data (LTP vs candle price)
 *   - Executing the decision (Kite API vs simulation state)
 *   - Logging appropriately
 *
 * Used by:
 *   - dailyPicksService.js   (live monitoring — feeds LTP, executes via Kite)
 *   - backtestUtils.js        (simulation — feeds candle data, updates result object)
 *
 * ⚠️  LIVE MONEY: Changing any logic here affects BOTH real trades and backtests.
 */

import { round2 } from './dailyPicksHelpers.js';
import {
  GAP_PROTECTION_MAX_PCT,
  PARTIAL_BOOK_PCT,
  PARTIAL_BOOK_QTY_RATIO,
  SIDEWAYS_EXIT_MINUTES,
  SIDEWAYS_THRESHOLD_PCT,
  EXIT_HOUR,
  INTRADAY_CAPITAL_PCT,
  MAX_PICKS,
  BASELINE_ATR_PCT,
  MIN_ATR_MULT,
  MAX_ATR_MULT,
} from './dailyPicksConstants.js';

// Re-export trailing engine (it's already a shared pure function)
export { computeDynamicTrail, computeATRFromCandles } from './trailingStopEngine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. GAP PROTECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a stock's opening gap is too large to enter safely.
 *
 * @param {number} openingPrice — first candle open / actual open
 * @param {number} prevClose    — previous close (entry level)
 * @param {string} direction    — 'LONG' or 'SHORT'
 * @returns {{ cancel: boolean, gapPct: number, reason: string }}
 */
export function checkGapProtection(openingPrice, prevClose, direction) {
  if (openingPrice == null || openingPrice <= 0 || prevClose == null || prevClose <= 0) {
    return { cancel: true, gapPct: 0, reason: 'invalid price data (null or zero)' };
  }
  const isBullish = direction === 'LONG';
  const directionalGap = isBullish
    ? ((openingPrice - prevClose) / prevClose) * 100
    : ((prevClose - openingPrice) / prevClose) * 100;

  const cancel = directionalGap > GAP_PROTECTION_MAX_PCT;
  return {
    cancel,
    gapPct: round2(directionalGap),
    reason: cancel
      ? `directional gap ${round2(directionalGap)}% > ${GAP_PROTECTION_MAX_PCT}%`
      : `PASS (${round2(directionalGap)}%)`
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PARTIAL PROFIT BOOKING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Decide whether to book partial profit.
 *
 * @param {Object} params
 * @param {number} params.entryPrice
 * @param {number} params.currentPrice  — LTP or candle high/low
 * @param {number} params.targetPrice   — original target
 * @param {string} params.direction     — 'LONG' or 'SHORT'
 * @param {number} params.totalQty      — current position qty
 * @param {boolean} params.alreadyBooked — whether partial already done
 * @returns {{ shouldBook: boolean, bookLevel: number, bookQty: number, reason: string }}
 */
export function checkPartialBooking({ entryPrice, currentPrice, targetPrice, direction, totalQty, alreadyBooked }) {
  if (alreadyBooked || totalQty <= 1 || !targetPrice) {
    return { shouldBook: false, bookLevel: 0, bookQty: 0, reason: 'not eligible' };
  }

  const isBullish = direction === 'LONG';
  const targetDist = Math.abs(targetPrice - entryPrice);
  const bookLevel = isBullish
    ? round2(entryPrice + targetDist * PARTIAL_BOOK_PCT)
    : round2(entryPrice - targetDist * PARTIAL_BOOK_PCT);

  const reached = isBullish ? currentPrice >= bookLevel : currentPrice <= bookLevel;

  if (!reached) {
    return { shouldBook: false, bookLevel, bookQty: 0, reason: 'price not at book level' };
  }

  const bookQty = Math.floor(totalQty * PARTIAL_BOOK_QTY_RATIO);
  if (bookQty <= 0) {
    return { shouldBook: false, bookLevel, bookQty: 0, reason: 'qty too small to split' };
  }

  return {
    shouldBook: true,
    bookLevel,
    bookQty,
    reason: `price reached ${PARTIAL_BOOK_PCT * 100}% of target distance`
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. STOP HIT / TARGET HIT DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if stop loss was hit on this candle/tick.
 *
 * @param {Object} params
 * @param {number} params.candleLow   — candle low (or current LTP for live)
 * @param {number} params.candleHigh  — candle high (or current LTP for live)
 * @param {number} params.stopLevel   — current stop loss level
 * @param {number} params.originalStop — original stop (to detect trailing_stop vs stop_hit)
 * @param {string} params.direction
 * @returns {{ hit: boolean, exitPrice: number, reason: string }}
 */
export function checkStopHit({ candleLow, candleHigh, stopLevel, originalStop, direction }) {
  const isBullish = direction === 'LONG';
  if (isBullish && candleLow <= stopLevel) {
    return {
      hit: true,
      exitPrice: stopLevel,
      reason: stopLevel > originalStop ? 'trailing_stop' : 'stop_hit'
    };
  }
  if (!isBullish && candleHigh >= stopLevel) {
    return {
      hit: true,
      exitPrice: stopLevel,
      reason: stopLevel < originalStop ? 'trailing_stop' : 'stop_hit'
    };
  }
  return { hit: false, exitPrice: 0, reason: '' };
}

/**
 * Check if target was hit on this candle/tick.
 *
 * @param {Object} params
 * @param {number} params.candleLow
 * @param {number} params.candleHigh
 * @param {number} params.targetLevel
 * @param {string} params.direction
 * @returns {{ hit: boolean, exitPrice: number }}
 */
export function checkTargetHit({ candleLow, candleHigh, targetLevel, direction }) {
  const isBullish = direction === 'LONG';
  if (isBullish && candleHigh >= targetLevel) {
    return { hit: true, exitPrice: targetLevel };
  }
  if (!isBullish && candleLow <= targetLevel) {
    return { hit: true, exitPrice: targetLevel };
  }
  return { hit: false, exitPrice: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SIDEWAYS EXIT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if position should be exited due to sideways movement.
 *
 * @param {number} minutesSinceEntry
 * @param {number} profitPct — absolute profit % (can be negative)
 * @returns {{ shouldExit: boolean, reason: string }}
 */
export function checkSidewaysExit(minutesSinceEntry, profitPct) {
  if (minutesSinceEntry >= SIDEWAYS_EXIT_MINUTES && Math.abs(profitPct) < SIDEWAYS_THRESHOLD_PCT) {
    return {
      shouldExit: true,
      reason: `sideways_${Math.round(minutesSinceEntry)}min`
    };
  }
  return { shouldExit: false, reason: '' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. TIME EXIT (3 PM hard stop)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if it's time for forced exit.
 *
 * @param {number} istHour — current IST hour (0-23)
 * @returns {{ shouldExit: boolean, reason: string }}
 */
export function checkTimeExit(istHour) {
  if (istHour >= EXIT_HOUR) {
    return { shouldExit: true, reason: 'time_exit_3pm' };
  }
  return { shouldExit: false, reason: '' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. POSITION SIZING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute position size using score-weighted allocation + ATR adjustment.
 *
 * @param {Object} params
 * @param {number} params.totalCapital    — total available capital (₹)
 * @param {number} params.entryPrice      — price per share
 * @param {number} params.pickScore       — this pick's rank_score
 * @param {Array}  params.allPicks        — all selected picks (for weight calc)
 * @param {number} params.atrPct          — ATR as % of price (0 = unknown)
 * @param {number} params.leverageFactor  — MIS leverage (e.g., 5)
 * @param {number} [params.maxWeight=0.5] — cap any single pick at this weight
 * @returns {{ perPickCapital: number, qty: number, marginPerShare: number, atrMult: number }}
 */
export function computePositionSize({
  totalCapital,
  entryPrice,
  pickScore,
  allPicks = [],
  atrPct = 0,
  leverageFactor = 5,
  maxWeight = 0.5,
}) {
  const intradayPool = totalCapital * INTRADAY_CAPITAL_PCT;
  let perPickCapital;

  if (allPicks.length > 0) {
    const totalScore = allPicks.reduce((sum, p) => sum + (p.rank_score || 0), 0);
    const rawWeight = totalScore > 0
      ? Math.min(pickScore / totalScore, maxWeight)
      : 1 / allPicks.length;
    const weightSum = allPicks.reduce((sum, p) => {
      return sum + Math.min((p.rank_score || 0) / (totalScore || 1), maxWeight);
    }, 0);
    perPickCapital = weightSum > 0
      ? Math.floor(intradayPool * (rawWeight / weightSum))
      : Math.floor(intradayPool / MAX_PICKS);
  } else {
    perPickCapital = Math.floor(intradayPool / MAX_PICKS);
  }

  // ATR-based adjustment (high vol → smaller position)
  let atrMult = 1.0;
  if (atrPct > 0) {
    atrMult = Math.max(MIN_ATR_MULT, Math.min(MAX_ATR_MULT, BASELINE_ATR_PCT / atrPct));
    perPickCapital = Math.floor(perPickCapital * atrMult);
  }

  // MIS margin-based qty
  const marginPerShare = entryPrice / leverageFactor;
  const qty = Math.floor(perPickCapital / marginPerShare);

  return { perPickCapital, qty, marginPerShare: round2(marginPerShare), atrMult: round2(atrMult) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. P&L CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute P&L for a trade.
 *
 * @param {Object} params
 * @param {number} params.entryPrice
 * @param {number} params.exitPrice
 * @param {number} params.qty           — total original qty
 * @param {string} params.direction     — 'LONG' or 'SHORT'
 * @param {number} [params.partialQty]  — qty already booked at partial level
 * @param {number} [params.partialPrice] — price at which partial was booked
 * @returns {{ pnl: number, returnPct: number }}
 */
export function computePnl({ entryPrice, exitPrice, qty, direction, partialQty = 0, partialPrice = 0 }) {
  const isBullish = direction === 'LONG';
  let pnl;

  if (partialQty > 0 && partialPrice > 0) {
    // Guard: partialQty can never exceed total qty
    const safePartialQty = Math.min(partialQty, qty);
    const partialPnl = (isBullish ? partialPrice - entryPrice : entryPrice - partialPrice) * safePartialQty;
    const remainingQty = Math.max(0, qty - safePartialQty);
    const remainingPnl = (isBullish ? exitPrice - entryPrice : entryPrice - exitPrice) * remainingQty;
    pnl = round2(partialPnl + remainingPnl);
  } else {
    const pnlPerShare = isBullish ? exitPrice - entryPrice : entryPrice - exitPrice;
    pnl = round2(pnlPerShare * qty);
  }

  const returnPct = entryPrice > 0 ? round2((pnl / (entryPrice * qty)) * 100) : 0;
  return { pnl, returnPct };
}
