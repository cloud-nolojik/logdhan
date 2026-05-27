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
  STRUCTURE_EXIT_MIN_R_CUSHION,
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
/**
 * analyzeIntradayStructure
 *
 * Candle-based trade management decision — runs every 5 min monitor cycle.
 * Two-timeframe approach: 15-min for BOTH trend structure AND stop placement.
 * 5-min candles are used only as the SIGNAL (pattern detection) — the SL
 * LEVEL always comes from the last completed 15-min candle's extreme. This
 * matches the entry timeframe (we enter on 15-min confirmation, so we trail
 * on 15-min lows / highs) and stops the 5-min-low whipsaws that killed
 * JSWENERGY, LODHA, and TITAGARH on 2026-05-27.
 *
 * Decision matrix:
 *   15-min structure broken            → 'exit'    (close below prior 15-min low for LONG)
 *   5-min bearish engulfing / star     → 'tighten' (stop to LAST 15-MIN candle low/high)
 *   5-min doji / inside bar            → 'hold'    (indecision — don't move stop)
 *   5-min bullish + 15-min intact      → 'trail'   (trail stop to LAST 15-MIN candle low/high)
 *   5-min bullish but volume drying    → 'hold'    (possible exhaustion)
 *
 * @param {Object[]} candles5m   - last N completed 5-min candles [{open,high,low,close,volume}]
 * @param {Object[]} candles15m  - last N completed 15-min candles
 * @param {string}   direction   - 'LONG' | 'SHORT'
 * @param {number}   currentStop - current stop level (for trail direction guard)
 * @param {number}  [entryPrice] - actual fill price; required to apply structural-exit cushion
 * @param {number}  [plannedStop] - original planned stop; required to compute R-cushion
 * @returns {{ action: string, reason: string, newStop: number|null }}
 *
 * STRUCTURAL EXIT CUSHION (May 2026):
 *   When entryPrice and plannedStop are supplied, the 15-min structural break
 *   ONLY triggers exit if the trade is at least STRUCTURE_EXIT_MIN_R_CUSHION R
 *   in profit (default 0.5R). Below that cushion, the function downgrades the
 *   exit to a 'tighten' or 'hold' so the planned stop continues to govern risk.
 *   This stops marginally-profitable winners getting cut on a single retrace.
 *   Backward-compat: omit entryPrice/plannedStop to keep legacy (immediate exit)
 *   behavior — the function still works but logs a warning.
 */
export function analyzeIntradayStructure({ candles5m, candles15m, direction, currentStop, entryPrice, plannedStop }) {
  const NO_CHANGE = (reason) => ({ action: 'hold', reason, newStop: null });

  if (!candles5m  || candles5m.length  < 2) return NO_CHANGE('insufficient 5-min candle data');
  if (!candles15m || candles15m.length < 2) return NO_CHANGE('insufficient 15-min candle data');

  const isBullish = direction === 'LONG';

  // ── 15-min structure ──
  const c15prev = candles15m[candles15m.length - 2];
  const c15last = candles15m[candles15m.length - 1];

  // Broken: last close breaches prior candle's low (LONG) or high (SHORT)
  const struct15Broken = isBullish
    ? c15last.close < c15prev.low
    : c15last.close > c15prev.high;

  // Intact: last low >= prior low for LONG (higher lows = uptrend maintained)
  const struct15Intact = isBullish
    ? c15last.low >= c15prev.low
    : c15last.high <= c15prev.high;

  // ── 5-min candle classification ──
  const c5prev = candles5m[candles5m.length - 2];
  const c5last = candles5m[candles5m.length - 1];

  const c5Range    = c5last.high - c5last.low;
  const c5Body     = Math.abs(c5last.close - c5last.open);
  const c5prevBody = Math.abs(c5prev.close - c5prev.open);
  const bodyRatio  = c5Range > 0 ? c5Body / c5Range : 0;
  const upperWick  = c5last.high - Math.max(c5last.open, c5last.close);
  const lowerWick  = Math.min(c5last.open, c5last.close) - c5last.low;

  // Strong directional bars (filter out wicks via body-ratio > 50%)
  const is5mBullish = c5last.close > c5last.open && bodyRatio > 0.50;
  const is5mBearish = c5last.close < c5last.open && bodyRatio > 0.50;

  // ── Reversal patterns — only activate when AGAINST the trade direction ──
  // For LONG: bearish patterns warn of reversal → tighten the stop
  // For SHORT: bullish patterns warn of reversal → tighten the stop (mirror)

  // Bearish engulfing intraday: relaxed gap condition (>= not >) since consecutive
  // 5-min bars open at the prior bar's close — a strict gap-up almost never happens.
  const is5mBearEngulf = isBullish
    && c5last.close  <  c5last.open          // bearish body
    && c5last.open   >= c5prev.close         // opens at or above prior close (relaxed)
    && c5last.close  <= c5prev.open          // closes at or below prior open
    && c5Body        >  c5prevBody;          // body larger than prior — confirms engulf

  // Bullish engulfing (SHORT mirror): only relevant when we're SHORT — a strong
  // bullish bar engulfing the prior bar is the reversal signal we'd want to
  // tighten our stop on. Same relaxed-gap logic as bearish engulfing.
  const is5mBullEngulf = !isBullish
    && c5last.close  >  c5last.open          // bullish body
    && c5last.open   <= c5prev.close         // opens at or below prior close (relaxed)
    && c5last.close  >= c5prev.open          // closes at or above prior open
    && c5Body        >  c5prevBody;          // body larger than prior — confirms engulf

  // Shooting star: upper wick > 2× body, small body in lower third of range
  // (only relevant for LONGs — bearish reversal signal at a top)
  const is5mShootingStar = isBullish
    && c5Range > 0
    && upperWick > 2 * c5Body
    && c5Body   < 0.30 * c5Range;

  // Hammer (SHORT mirror): long lower wick > 2× body, small body in upper third
  // of range. Bullish reversal signal at a bottom — what we'd want to see to
  // tighten a SHORT stop.
  const is5mHammer = !isBullish
    && c5Range > 0
    && lowerWick > 2 * c5Body
    && c5Body   < 0.30 * c5Range;

  const is5mDoji   = bodyRatio < 0.15;
  const is5mInside = c5last.high <= c5prev.high && c5last.low >= c5prev.low;

  // ── Volume trend (compare last candle vs avg of prior 3) ──
  const priorVols   = candles5m.slice(-4, -1).map(c => c.volume);
  const avgVol      = priorVols.length > 0
    ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length
    : c5last.volume;
  const volRatio    = avgVol > 0 ? c5last.volume / avgVol : 1;
  const volDrying   = volRatio < 0.60;
  const volExpanding = volRatio > 1.40;

  // ── Debug dump — visible in logs every cycle for each position ──
  const dbg = [
    `dir=${direction} stop=₹${currentStop}`,
    `15m: prev[L=${c15prev.low} H=${c15prev.high} C=${c15prev.close}] last[L=${c15last.low} H=${c15last.high} C=${c15last.close}] broken=${struct15Broken} intact=${struct15Intact}`,
    `5m:  prev[O=${c5prev.open} H=${c5prev.high} L=${c5prev.low} C=${c5prev.close} body=${round2(c5prevBody)}]`,
    `5m:  last[O=${c5last.open} H=${c5last.high} L=${c5last.low} C=${c5last.close} body=${round2(c5Body)} range=${round2(c5Range)} bodyRatio=${round2(bodyRatio)} upperWick=${round2(upperWick)} lowerWick=${round2(lowerWick)}]`,
    `5m:  bullish=${is5mBullish} bearish=${is5mBearish} bearEngulf=${is5mBearEngulf} bullEngulf=${is5mBullEngulf} shootingStar=${is5mShootingStar} hammer=${is5mHammer} doji=${is5mDoji} inside=${is5mInside}`,
    `vol: last=${c5last.volume} avg=${round2(avgVol)} ratio=${round2(volRatio)}x drying=${volDrying} expanding=${volExpanding}`,
  ].join(' | ');

  // ── Decision matrix ──

  if (struct15Broken) {
    // ── Structural-exit gating (May 2026, two layers) ──
    //
    // Layer 1 (cushion): if entryPrice + plannedStop are supplied, require
    // the trade to be at least STRUCTURE_EXIT_MIN_R_CUSHION R in profit
    // before any structural exit can fire. Below the cushion we just tighten
    // — the planned stop continues to manage risk.
    //
    // Layer 2 (two-bar confirmation): even when above the cushion, a SINGLE
    // 15-min break is too jumpy — one noisy bar can take out the prior low
    // intra-trend. We now require the prior 15-min candle ALSO to have closed
    // below its own prior low (for LONGs; mirror for SHORTs) before firing
    // a market exit. If only the latest bar broke, we tighten instead of
    // exit, awaiting confirmation on the next 15-min bar.
    //
    // This is the change requested after observing zero TARGET_HIT trades
    // and many structure-exits firing on first-bar noise.

    const haveRContext =
      typeof entryPrice === 'number' && entryPrice > 0 &&
      typeof plannedStop === 'number' && plannedStop > 0;
    const cushion = STRUCTURE_EXIT_MIN_R_CUSHION;

    // ── Layer 1: profit-cushion gate ──
    if (haveRContext && cushion > 0) {
      const riskPerShare = Math.abs(entryPrice - plannedStop);
      if (riskPerShare > 0) {
        const unrealizedPerShare = isBullish
          ? c15last.close - entryPrice
          : entryPrice - c15last.close;
        const unrealizedR = unrealizedPerShare / riskPerShare;

        if (unrealizedR < cushion) {
          const tightenLevel = isBullish ? round2(c15prev.low) : round2(c15prev.high);
          const isImprovement = isBullish ? tightenLevel > currentStop : tightenLevel < currentStop;
          return {
            action: isImprovement ? 'tighten' : 'hold',
            reason: `15-min structure broken but unrealized R=${round2(unrealizedR)} < cushion ${cushion}R — downgraded to ${isImprovement ? 'tighten' : 'hold'} (planned stop still active) | ${dbg}`,
            newStop: isImprovement ? tightenLevel : null,
          };
        }
      }
    } else if (!haveRContext) {
      // FAIL LOUD: a caller without R-context bypasses HALF of the structural-
      // exit protection (Layer 1, the cushion). All 3 known callers in this
      // codebase pass both fields; if we hit this, a new caller was added or
      // an existing caller was refactored to drop them. Refuse to act —
      // return `hold` with an explicit reason so the calling job logs the
      // miss and a human can find it. The hard planned stop is still active,
      // so risk is bounded; we just won't tighten or exit on structure today.
      return {
        action: 'hold',
        reason: `MISSING_R_CONTEXT: analyzeIntradayStructure called without entryPrice/plannedStop. Caller must pass both. Hard stop still active, but structural management is disabled until fixed. dbg: ${dbg}`,
        newStop: null,
      };
    }

    // ── Layer 2: two-bar confirmation gate ──
    // Needs at least 3 completed 15-min candles to look back one bar.
    // Without a third candle we can't confirm, so we downgrade to tighten
    // and wait. The hard planned stop is still active in the meantime.
    const c15prev2 = candles15m.length >= 3 ? candles15m[candles15m.length - 3] : null;
    const priorBarBroke = c15prev2
      ? (isBullish ? c15prev.close < c15prev2.low : c15prev.close > c15prev2.high)
      : null;

    if (priorBarBroke !== true) {
      const tightenLevel = isBullish ? round2(c15prev.low) : round2(c15prev.high);
      const isImprovement = isBullish ? tightenLevel > currentStop : tightenLevel < currentStop;
      const reasonDetail = priorBarBroke === null
        ? 'insufficient 15-min history (need 3 candles) — awaiting next bar'
        : `prior 15-min candle closed ${isBullish ? `at ${c15prev.close} ≥ its prior low ${c15prev2.low}` : `at ${c15prev.close} ≤ its prior high ${c15prev2.high}`} — single-bar break unconfirmed`;
      return {
        action: isImprovement ? 'tighten' : 'hold',
        reason: `15-min structure broken (single bar, unconfirmed): ${reasonDetail} — downgraded to ${isImprovement ? 'tighten' : 'hold'} | ${dbg}`,
        newStop: isImprovement ? tightenLevel : null,
      };
    }

    // ── Both gates passed: cushion OK + two-bar confirmation ──
    return {
      action: 'exit',
      reason: isBullish
        ? `15-min structure CONFIRMED broken (2 bars): last close ₹${c15last.close} < prior low ₹${c15prev.low}, prior close ₹${c15prev.close} < its prior low ₹${c15prev2.low} | ${dbg}`
        : `15-min structure CONFIRMED broken (2 bars): last close ₹${c15last.close} > prior high ₹${c15prev.high}, prior close ₹${c15prev.close} > its prior high ₹${c15prev2.high} | ${dbg}`,
      newStop: null,
    };
  }

  // Reversal candle → tighten stop. Each pattern is direction-gated above so
  // only against-trade-direction reversals trigger here:
  //   LONG  → bearish engulfing or shooting star at a top → tighten to last 15-MIN LOW
  //   SHORT → bullish engulfing or hammer at a bottom    → tighten to last 15-MIN HIGH
  //
  // Why 15-min, not 5-min: a 5-min candle right after entry has a tiny range,
  // and using its low/high places the SL within paise of LTP — the next
  // ordinary wiggle takes us out flat. The 15-min candle's low/high is a
  // real, market-tested support/resistance level (see JSWENERGY/LODHA/
  // TITAGARH on 2026-05-27 for the failure mode this replaces).
  const reversalLong  = is5mBearEngulf || is5mShootingStar;     // for LONG positions
  const reversalShort = is5mBullEngulf || is5mHammer;            // for SHORT positions
  if (reversalLong || reversalShort) {
    const tightStop = isBullish ? round2(c15last.low) : round2(c15last.high);
    const patternName = is5mBearEngulf  ? '5-min bearish engulfing'
                      : is5mShootingStar ? '5-min shooting star'
                      : is5mBullEngulf  ? '5-min bullish engulfing'
                      : is5mHammer       ? '5-min hammer'
                      : 'reversal candle';
    return {
      action: 'tighten',
      reason: `${patternName} (against ${direction} trade) — SL to last 15-min ${isBullish ? 'low' : 'high'} ₹${tightStop} | ${dbg}`,
      newStop: tightStop,
    };
  }

  // Doji or inside bar → pause, don't move stop
  if (is5mDoji || is5mInside) {
    return NO_CHANGE(`${is5mDoji ? '5-min doji — indecision' : '5-min inside bar — consolidation'} | ${dbg}`);
  }

  // Continuation candle (WITH the trade direction) + 15-min intact + volume not drying
  //   LONG  → bullish 5-min bar (signal) → trail stop UP to last 15-MIN low
  //   SHORT → bearish 5-min bar (signal) → trail stop DOWN to last 15-MIN high
  //
  // 5-min candle = the SIGNAL that the trend is continuing.
  // 15-min candle low/high = the LEVEL where the stop goes.
  const continuationBar = isBullish ? is5mBullish : is5mBearish;
  if (continuationBar && struct15Intact && !volDrying) {
    const trailStop = isBullish ? round2(c15last.low) : round2(c15last.high);
    const isImprovement = isBullish ? trailStop > currentStop : trailStop < currentStop;
    if (!isImprovement) return NO_CHANGE(`5-min ${isBullish ? 'bullish' : 'bearish'} (signal) but trail ₹${trailStop} (last 15-min ${isBullish ? 'low' : 'high'}) would not improve stop ₹${currentStop} | ${dbg}`);
    return {
      action: 'trail',
      reason: `5-min ${isBullish ? 'bullish' : 'bearish'} signal${volExpanding ? ' + expanding volume' : ''}, 15-min intact — trail to last 15-min ${isBullish ? 'low' : 'high'} ₹${trailStop} | ${dbg}`,
      newStop: trailStop,
    };
  }

  // Continuation bar but volume drying up → hold, exhaustion warning
  // (mirror logic for SHORT — a bearish bar with drying volume = bears tiring too)
  if (continuationBar && volDrying) {
    return NO_CHANGE(`5-min ${isBullish ? 'bullish' : 'bearish'} but volume drying (${round2(volRatio)}× avg) — exhaustion risk on ${direction} | ${dbg}`);
  }

  return NO_CHANGE(`5-min candle neutral | ${dbg}`);
}

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
