/**
 * DYNAMIC TRAILING STOP ENGINE — Shared by live system & backtest
 *
 * Implements a Chandelier Exit approach: trail from the HIGHEST HIGH reached
 * (not from entry price) using ATR-based multipliers that tighten in phases.
 *
 * Why Chandelier Exit?
 * - Fixed ratio (old: 40% of profit from entry) places stops too tight
 *   when stock consolidates at highs → gets whipsawed on minor pullbacks
 * - Chandelier trails from peak price, so consolidation at highs = safe
 * - ATR adapts to each stock's volatility automatically
 *
 * Phases (profit from entry):
 *   Phase 1 (0–2%):  extremePrice - 2.5×ATR  → loose, let trend develop
 *   Phase 2 (2–4%):  extremePrice - 2.0×ATR  → moderate, trend confirmed
 *   Phase 3 (4%+):   extremePrice - 1.5×ATR  → tight, protect big gains
 *   After 2 PM:      multiplier -0.5         → tighten for EOD
 *
 * Falls back to old fixed-ratio method if ATR is not available.
 *
 * Used by:
 *   - dailyPicksService.js  (live monitoring loop)
 *   - backtestUtils.js      (tick-by-tick simulation)
 */

import { round2 } from './dailyPicksHelpers.js';
import {
  TRAIL_MIN_PROFIT_PCT,
  TRAIL_LOCK_RATIO,
  TRAIL_MIN_MINUTES,
  TRAIL_START_HOUR,
  TRAIL_ATR_MULT_PHASE1,
  TRAIL_ATR_MULT_PHASE2,
  TRAIL_ATR_MULT_PHASE3,
  TRAIL_PHASE2_PCT,
  TRAIL_PHASE3_PCT,
  TRAIL_EOD_TIGHTEN,
  TIGHTEN_HOUR,
} from './dailyPicksConstants.js';

/**
 * Compute the dynamic trailing stop level.
 *
 * @param {Object} params
 * @param {number} params.entryPrice       — fill price
 * @param {number} params.currentPrice     — latest price (LTP or candle close)
 * @param {number} params.extremePrice      — highest high since entry (LONG) or lowest low (SHORT)
 * @param {number} params.currentStop      — current stop loss level
 * @param {number} params.atr              — Average True Range (₹ value, not %). 0 = unavailable
 * @param {number} params.profitPct        — current profit % from entry
 * @param {number} params.minutesSinceEntry
 * @param {number} params.istHour          — current IST hour (0-23)
 * @param {boolean} params.isBullish       — true for LONG, false for SHORT
 * @param {boolean} params.partialBooked   — whether partial profit has been booked
 *
 * @returns {Object} { newStop, shouldTrail, phase, method, reason }
 *   - newStop: the computed stop level
 *   - shouldTrail: true if newStop improves on currentStop
 *   - phase: 1/2/3 or 'fallback'
 *   - method: 'chandelier' or 'fixed_ratio'
 *   - reason: human-readable explanation
 */
export function computeDynamicTrail({
  entryPrice,
  currentPrice,
  extremePrice,
  currentStop,
  atr = 0,
  profitPct,
  minutesSinceEntry,
  istHour,
  isBullish,
  partialBooked = false,
}) {
  // ── Check if trailing is allowed ──
  const canTrail = minutesSinceEntry >= TRAIL_MIN_MINUTES || istHour >= TRAIL_START_HOUR;
  if (!canTrail || profitPct < TRAIL_MIN_PROFIT_PCT) {
    return { newStop: currentStop, shouldTrail: false, phase: 0, method: 'none', reason: 'not eligible' };
  }

  let newStop;
  let phase;
  let method;
  let reason;

  // ── Chandelier Exit (preferred — when ATR is available) ──
  if (atr > 0) {
    method = 'chandelier';

    // Determine phase based on profit %
    let atrMult;
    if (profitPct >= TRAIL_PHASE3_PCT) {
      phase = 3;
      atrMult = TRAIL_ATR_MULT_PHASE3;
    } else if (profitPct >= TRAIL_PHASE2_PCT) {
      phase = 2;
      atrMult = TRAIL_ATR_MULT_PHASE2;
    } else {
      phase = 1;
      atrMult = TRAIL_ATR_MULT_PHASE1;
    }

    // After 2 PM, tighten the multiplier (less room = time running out)
    const eodTighten = istHour >= TIGHTEN_HOUR ? TRAIL_EOD_TIGHTEN : 0;
    atrMult = Math.max(0.5, atrMult - eodTighten); // floor at 0.5× ATR

    // Chandelier formula: trail from highest high (LONG) or lowest low (SHORT)
    if (isBullish) {
      newStop = round2(extremePrice - atr * atrMult);
    } else {
      // For shorts: extremePrice is actually lowestLow
      newStop = round2(extremePrice + atr * atrMult);
    }

    // Safety: never let trailing stop go below breakeven once partial is booked
    if (partialBooked) {
      if (isBullish) {
        newStop = Math.max(newStop, entryPrice);
      } else {
        newStop = Math.min(newStop, entryPrice);
      }
    }

    reason = `P${phase} ${round2(atrMult)}×ATR(₹${round2(atr)}) from peak ₹${round2(extremePrice)}${eodTighten > 0 ? ' [EOD tighten]' : ''}`;

  } else {
    // ── Fallback: old fixed-ratio method (no ATR data) ──
    method = 'fixed_ratio';
    phase = 'fallback';
    const profitPerShare = isBullish
      ? currentPrice - entryPrice
      : entryPrice - currentPrice;

    newStop = isBullish
      ? round2(entryPrice + profitPerShare * TRAIL_LOCK_RATIO)
      : round2(entryPrice - profitPerShare * TRAIL_LOCK_RATIO);

    reason = `fallback ${TRAIL_LOCK_RATIO * 100}% lock (no ATR)`;
  }

  // ── Only trail if it improves (stop can never move backward) ──
  const shouldTrail = isBullish ? newStop > currentStop : newStop < currentStop;

  return { newStop: round2(newStop), shouldTrail, phase, method, reason };
}

/**
 * Compute ATR from an array of 5-min candles.
 * True Range = max(high-low, |high-prevClose|, |low-prevClose|)
 * ATR = SMA of last N true ranges
 *
 * @param {Array} candles — sorted chronologically, each with { high, low, close }
 * @param {number} period — lookback period (default 14)
 * @returns {number} ATR value in ₹, or 0 if insufficient data
 */
export function computeATRFromCandles(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;

  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
    trueRanges.push(tr);
  }

  // Use the last `period` true ranges
  const recent = trueRanges.slice(-period);
  if (recent.length === 0) return 0;

  const sum = recent.reduce((a, b) => a + b, 0);
  return round2(sum / recent.length);
}
