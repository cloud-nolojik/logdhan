/**
 * SHARED BACKTEST UTILITIES
 *
 * Common functions used by both trueBacktest.js and pipelineBacktest.js.
 * Extracted to avoid duplication — single source of truth for:
 * - SIM constants (matching real trading system)
 * - Upstox historical candle API
 * - ORB data building from candles
 * - Tick-by-tick trade simulation engine
 * - IST time helpers
 */

import crypto from 'crypto';
import { validatePicks } from '../services/dailyPicks/orbValidationService.js';
import { round2 } from '../services/dailyPicks/dailyPicksHelpers.js';
import * as C from '../services/dailyPicks/dailyPicksConstants.js';
import {
  checkGapProtection,
  checkPartialBooking,
  checkStopHit,
  checkTargetHit,
  checkSidewaysExit,
  checkTimeExit,
  computePositionSize,
  computePnl,
  computeDynamicTrail,
  computeATRFromCandles,
} from '../services/dailyPicks/tradingDecisions.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — imported from dailyPicksConstants.js (single source of truth)
// Re-exported as SIM object for backward compatibility with trueBacktest.js
// ═══════════════════════════════════════════════════════════════════════════════

export const SIM = {
  GAP_PROTECTION_MAX_PCT: C.GAP_PROTECTION_MAX_PCT,
  ORB_BUFFER_PCT: C.ORB_BUFFER_PCT,
  MIN_ORB_RR_BY_REGIME: C.MIN_ORB_RR_BY_REGIME,
  MAX_ORB_ATR_RATIO: C.MAX_ORB_ATR_RATIO,
  MAX_ORB_RANGE_PCT_ABSOLUTE: C.MAX_ORB_RANGE_PCT_ABSOLUTE,
  NIFTY_THRESHOLD_PCT: C.NIFTY_THRESHOLD_PCT,
  SLIPPAGE_BUFFER_PCT: C.SLIPPAGE_BUFFER_PCT,
  PARTIAL_BOOK_PCT: C.PARTIAL_BOOK_PCT,
  PARTIAL_BOOK_QTY_RATIO: C.PARTIAL_BOOK_QTY_RATIO,
  TRAIL_MIN_PROFIT_PCT: C.TRAIL_MIN_PROFIT_PCT,
  TRAIL_LOCK_RATIO: C.TRAIL_LOCK_RATIO,
  TRAIL_MIN_MINUTES: C.TRAIL_MIN_MINUTES,
  TRAIL_START_HOUR: C.TRAIL_START_HOUR,
  SIDEWAYS_EXIT_MINUTES: C.SIDEWAYS_EXIT_MINUTES,
  SIDEWAYS_THRESHOLD_PCT: C.SIDEWAYS_THRESHOLD_PCT,
  TIGHTEN_HOUR: C.TIGHTEN_HOUR,
  EXIT_HOUR: C.EXIT_HOUR,
  INTRADAY_CAPITAL_PCT: C.INTRADAY_CAPITAL_PCT,
  MIS_LEVERAGE_FACTOR: 5,  // Zerodha MIS ~5x leverage on most stocks
  MAX_PICKS: C.MAX_PICKS,
  BASELINE_ATR_PCT: C.BASELINE_ATR_PCT,
  MIN_ATR_MULT: C.MIN_ATR_MULT,
  MAX_ATR_MULT: C.MAX_ATR_MULT,
  TRAIL_ATR_LOOKBACK: C.TRAIL_ATR_LOOKBACK,
};

export const ORB_PASSES = [
  { pass: 1, hour: 9, minute: 30 },
  { pass: 2, hour: 9, minute: 46 },
  { pass: 3, hour: 10, minute: 1 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// UPSTOX HISTORICAL CANDLE API
// ═══════════════════════════════════════════════════════════════════════════════

let _accessToken = null;

export async function getAccessToken() {
  if (_accessToken) return _accessToken;

  const UpstoxUser = (await import('../models/upstoxUser.js')).default;
  const user = await UpstoxUser.findOne({ connection_status: 'connected' }).lean();
  if (!user || !user.access_token) throw new Error('No connected Upstox user found');

  const encKey = process.env.UPSTOX_ENCRYPTION_KEY;
  if (encKey) {
    try {
      const key = crypto.createHash('sha256').update(encKey).digest();
      const parts = user.access_token.split(':');
      if (parts.length === 2) {
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = Buffer.from(parts[1], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        _accessToken = decipher.update(encrypted, undefined, 'utf8') + decipher.final('utf8');
      } else {
        _accessToken = user.access_token;
      }
    } catch { _accessToken = user.access_token; }
  } else {
    _accessToken = user.access_token;
  }
  return _accessToken;
}

export async function fetch5minCandles(instrumentKey, dateStr) {
  const token = await getAccessToken();
  const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentKey)}/minutes/5/${dateStr}/${dateStr}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
      });
      if (resp.status === 429 || resp.status === 403) {
        await sleep(attempt * 2000);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      if (json?.data?.candles) {
        return json.data.candles.map(c => ({
          timestamp: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] || 0
        })).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      }
      return [];
    } catch (err) {
      if (attempt === 3) {
        console.error(`    [BACKTEST] Failed candles ${instrumentKey} ${dateStr}: ${err.message}`);
        return [];
      }
      await sleep(1000);
    }
  }
  return [];
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════════
// CANDLE TIME HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export function getISTTime(timestamp) {
  const d = new Date(timestamp);
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(d.getTime() + istOffset);
  return {
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
    totalMinutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    timeStr: `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')}`
  };
}

export function candlesInRange(candles, fromH, fromM, toH, toM) {
  const from = fromH * 60 + fromM;
  const to = toH * 60 + toM;
  return candles.filter(c => {
    const t = getISTTime(c.timestamp);
    return t.totalMinutes >= from && t.totalMinutes <= to;
  });
}

/**
 * Build ORB data from candles — same format as collectOpeningRange() in the real system.
 * This lets us pass it directly to the REAL validatePicks() function.
 */
export function buildORBDataFromCandles(stockCandles, niftyCandles, pick, passNum) {
  const endTimes = { 1: [9, 30], 2: [9, 46], 3: [10, 1] };
  const [endH, endM] = endTimes[passNum];
  const orbCandles = candlesInRange(stockCandles, 9, 15, endH, endM - 1);

  if (orbCandles.length === 0) return null;

  let high = -Infinity, low = Infinity;
  for (const c of orbCandles) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }

  const openCandle = orbCandles[0];
  const lastCandle = orbCandles[orbCandles.length - 1];
  const prevClose = pick.levels?.entry || openCandle.open;
  const gapPct = prevClose ? round2(((openCandle.open - prevClose) / prevClose) * 100) : 0;

  let orbDir = 'NEUTRAL';
  if (lastCandle.close > openCandle.open * 1.001) orbDir = 'UP';
  else if (lastCandle.close < openCandle.open * 0.999) orbDir = 'DOWN';

  const result = {};
  // Extract date from candle timestamp for logging
  const candleDate = openCandle.timestamp ? new Date(openCandle.timestamp).toISOString().split('T')[0] : '';

  result[pick.symbol] = {
    high: round2(high),
    low: round2(low),
    opening_price: round2(openCandle.open),
    gap_percent: gapPct,
    orb_direction: orbDir,
    date: candleDate
  };

  // NIFTY ORB
  if (niftyCandles && niftyCandles.length > 0) {
    const niftyOrb = candlesInRange(niftyCandles, 9, 15, endH, endM - 1);
    if (niftyOrb.length > 0) {
      const nOpen = niftyOrb[0].open;
      const nClose = niftyOrb[niftyOrb.length - 1].close;
      let nDir = 'NEUTRAL';
      if (nClose > nOpen * 1.001) nDir = 'UP';
      else if (nClose < nOpen * 0.999) nDir = 'DOWN';

      result['_NIFTY'] = {
        orb_direction: nDir,
        nifty_change_pct: round2(((nClose - nOpen) / nOpen) * 100)
      };
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMULATION ENGINE — uses REAL validatePicks() for ORB, custom tick replay for monitoring
// ═══════════════════════════════════════════════════════════════════════════════

export function simulatePick(pick, stockCandles, niftyCandles, capital, allPicks = null, regime = 'STRONG_BULL') {
  const result = {
    symbol: pick.symbol,
    direction: pick.direction,
    scanType: pick.scan_type,
    score: pick.rank_score || 0,
    plannedEntry: pick.levels?.entry || 0,
    plannedStop: pick.levels?.stop || 0,
    plannedTarget: pick.levels?.target || 0,
    plannedRR: pick.levels?.risk_reward || 0,
    gapProtection: null,
    orbResult: null,
    entered: false,
    entryPrice: 0, entryTime: null, orbEntry: 0,
    partialBooked: false, partialQty: 0, partialPrice: 0, partialPnl: 0,
    trailingHistory: [],
    exitPrice: 0, exitTime: null, exitReason: null, finalStatus: 'UNKNOWN',
    qty: 0, remainingQty: 0, pnl: 0, returnPct: 0,
    timeline: []
  };

  if (!stockCandles || stockCandles.length === 0) {
    result.finalStatus = 'NO_DATA';
    result.timeline.push('[BACKTEST] No candle data available');
    return result;
  }

  const isBullish = pick.direction === 'LONG';
  const firstCandle = stockCandles[0];
  const openingPrice = firstCandle.open;
  const prevClose = pick.levels?.entry || openingPrice;
  const gapPct = ((openingPrice - prevClose) / prevClose) * 100;

  result.timeline.push(`[BACKTEST] 9:15 Open=₹${round2(openingPrice)} Gap=${round2(gapPct)}% PrevClose=₹${round2(prevClose)}`);

  // ── STEP 1: Gap protection (shared decision function) ──
  const gap = checkGapProtection(openingPrice, prevClose, pick.direction);
  result.gapProtection = gap.cancel ? `CANCELLED: ${gap.reason}` : 'PASS';
  result.timeline.push(`[BACKTEST] 9:16 GAP_PROTECT: ${gap.reason}`);

  // ── STEP 2: ORB Validation using REAL validatePicks() ──
  let orbPassed = false;
  let orbEntryPrice = 0;
  let validationResult = null;

  for (const orbPass of ORB_PASSES) {
    const orbData = buildORBDataFromCandles(stockCandles, niftyCandles, pick, orbPass.pass);
    if (!orbData) {
      result.timeline.push(`[BACKTEST] ${orbPass.hour}:${String(orbPass.minute).padStart(2, '0')} ORB Pass ${orbPass.pass}: NO_DATA`);
      continue;
    }

    const mockPick = {
      symbol: pick.symbol,
      direction: pick.direction,
      scan_type: pick.scan_type,
      levels: { ...pick.levels },
      orb: orbData[pick.symbol] ? {
        high: orbData[pick.symbol].high,
        low: orbData[pick.symbol].low,
        opening_price: orbData[pick.symbol].opening_price,
        gap_percent: orbData[pick.symbol].gap_percent,
        orb_direction: orbData[pick.symbol].orb_direction,
        nifty_orb_direction: orbData['_NIFTY']?.orb_direction || 'NEUTRAL',
        nifty_change_pct: orbData['_NIFTY']?.nifty_change_pct ?? 0,
        orb_pass: orbPass.pass,
        orb_passes: []
      } : null,
      regime_aligned: false,
      validation: null
    };

    const validated = validatePicks([mockPick], orbData, regime);
    const vPick = validated[0];

    const passed = vPick.validation?.passed;
    const failReason = vPick.validation?.skip_reason || '';
    const timeStr = `${orbPass.hour}:${String(orbPass.minute).padStart(2, '0')}`;

    if (passed) {
      orbPassed = true;
      orbEntryPrice = vPick.validation.checks.orb_alignment?.new_entry || pick.levels.entry;
      validationResult = vPick.validation;
      result.timeline.push(`[BACKTEST] ${timeStr} ORB Pass ${orbPass.pass}: PASSED entry=₹${round2(orbEntryPrice)} R:R=${vPick.validation.checks.orb_alignment?.new_rr || '?'}`);
      break;
    } else {
      result.timeline.push(`[BACKTEST] ${timeStr} ORB Pass ${orbPass.pass}: FAILED (${failReason})`);
      const PERMANENT_FAIL_CHECKS = ['gap_check', 'gap_direction', 'no_orb_data'];
      const isPermanent = failReason.split(', ').every(c => PERMANENT_FAIL_CHECKS.includes(c));
      if (isPermanent) {
        result.timeline.push(`[BACKTEST] ${timeStr} PERMANENT_FAIL — skipping remaining passes`);
        break;
      }
    }
  }

  if (!orbPassed) {
    result.finalStatus = 'SKIPPED';
    result.exitReason = 'ORB validation failed';
    result.orbResult = 'FAILED';
    result.timeline.push('[BACKTEST] SKIPPED: ORB validation failed all passes');
    return result;
  }

  result.orbResult = 'PASSED';
  result.orbEntry = orbEntryPrice;

  // ── STEP 3: Entry detection (SL-M trigger at ORB breakout + slippage buffer) ──
  const triggerWithSlippage = isBullish
    ? orbEntryPrice * (1 + SIM.SLIPPAGE_BUFFER_PCT)
    : orbEntryPrice * (1 - SIM.SLIPPAGE_BUFFER_PCT);

  const lastPassUsed = ORB_PASSES.find(p => p.pass === (validationResult?.checks?.orb_alignment ?
    Math.max(...ORB_PASSES.filter(op => op.pass <= 3).map(op => op.pass)) : 1));

  const passEndMinutes = lastPassUsed ? (lastPassUsed.hour * 60 + lastPassUsed.minute) : 570;
  const postOrbCandles = stockCandles.filter(c => getISTTime(c.timestamp).totalMinutes >= passEndMinutes);

  let entryCandle = null;
  for (const candle of postOrbCandles) {
    if (isBullish && candle.high >= triggerWithSlippage) { entryCandle = candle; break; }
    else if (!isBullish && candle.low <= triggerWithSlippage) { entryCandle = candle; break; }
  }

  if (!entryCandle) {
    result.finalStatus = 'NO_FILL';
    result.exitReason = 'Price never hit ORB trigger';
    result.timeline.push(`[BACKTEST] NO_FILL: Price never reached trigger ₹${round2(triggerWithSlippage)}`);
    return result;
  }

  result.entryPrice = round2(triggerWithSlippage);
  result.entryTime = entryCandle.timestamp;
  result.entered = true;

  // Capital allocation — shared decision function (same formula as live system)
  const atrPct = pick._ohlcv?.atr && pick.levels?.entry
    ? (pick._ohlcv.atr / pick.levels.entry) * 100
    : (pick.indicators?.atr && pick.levels?.entry ? (pick.indicators.atr / pick.levels.entry) * 100 : 0);

  const sizing = computePositionSize({
    totalCapital: capital,
    entryPrice: result.entryPrice,
    pickScore: pick.rank_score || 0,
    allPicks: allPicks || [],
    atrPct,
    leverageFactor: SIM.MIS_LEVERAGE_FACTOR,
  });

  result.qty = sizing.qty;
  result.remainingQty = sizing.qty;
  result.timeline.push(`[BACKTEST] SIZING: capital=₹${capital} → perPick=₹${sizing.perPickCapital} (ATR mult=${sizing.atrMult}) → ₹${sizing.marginPerShare}/share (${SIM.MIS_LEVERAGE_FACTOR}x MIS) = ${sizing.qty} shares`);

  if (result.qty <= 0) {
    result.finalStatus = 'NO_FILL';
    result.exitReason = 'qty=0';
    result.timeline.push('[BACKTEST] NO_FILL: qty=0 insufficient capital');
    return result;
  }

  const entryIST = getISTTime(entryCandle.timestamp);
  result.timeline.push(`[BACKTEST] ${entryIST.timeStr} ENTERED: ₹${round2(result.entryPrice)} x${result.qty} (trigger=₹${round2(orbEntryPrice)} +slippage)`);

  // ── STEP 4: Tick-by-tick monitoring (mirrors monitorDailyPickOrders logic) ──
  // Dynamic Chandelier Exit — trails from highest high using ATR multiplier
  const originalStop = pick.levels?.stop || 0;
  const originalTarget = pick.levels?.target || 0;
  let currentStop = originalStop;
  let currentTarget = originalTarget;
  let partialBooked = false;
  let breakevenMoved = false;
  let exited = false;

  // Track extreme price since entry: highest high (LONG) / lowest low (SHORT) for Chandelier Exit
  let extremePrice = result.entryPrice;

  const entryTimeMs = new Date(entryCandle.timestamp).getTime();
  const monitorCandles = stockCandles.filter(c => new Date(c.timestamp).getTime() > entryTimeMs);

  // Compute intraday ATR from candles seen so far (up to entry)
  const candlesBeforeEntry = stockCandles.filter(c => new Date(c.timestamp).getTime() <= entryTimeMs);
  let intradayATR = computeATRFromCandles(candlesBeforeEntry, SIM.TRAIL_ATR_LOOKBACK);

  // If intraday ATR not available, try from pick's stored ATR
  if (intradayATR <= 0) {
    intradayATR = pick._ohlcv?.atr || pick.indicators?.atr || 0;
  }
  result.timeline.push(`[BACKTEST] TRAIL_ENGINE: ATR=₹${round2(intradayATR)} method=${intradayATR > 0 ? 'chandelier' : 'fixed_ratio_fallback'}`);

  for (const candle of monitorCandles) {
    if (exited) break;
    const t = getISTTime(candle.timestamp);
    const minutesSinceEntry = (new Date(candle.timestamp).getTime() - entryTimeMs) / 60000;
    const currentPrice = candle.close;
    const profitPct = isBullish
      ? ((currentPrice - result.entryPrice) / result.entryPrice) * 100
      : ((result.entryPrice - currentPrice) / result.entryPrice) * 100;

    // Update extreme price: highest high (LONG) / lowest low (SHORT) for Chandelier Exit
    if (isBullish) {
      if (candle.high > extremePrice) extremePrice = candle.high;
    } else {
      if (candle.low < extremePrice) extremePrice = candle.low;
    }

    // Update rolling ATR with each new candle (keeps it fresh)
    const candlesSoFar = stockCandles.filter(c => new Date(c.timestamp).getTime() <= new Date(candle.timestamp).getTime());
    if (candlesSoFar.length > SIM.TRAIL_ATR_LOOKBACK + 1) {
      const freshATR = computeATRFromCandles(candlesSoFar, SIM.TRAIL_ATR_LOOKBACK);
      if (freshATR > 0) intradayATR = freshATR;
    }

    // ── STOP HIT (shared decision) ──
    const stop = checkStopHit({ candleLow: candle.low, candleHigh: candle.high, stopLevel: currentStop, originalStop, direction: pick.direction });
    if (stop.hit) {
      result.exitPrice = stop.exitPrice;
      result.exitTime = candle.timestamp;
      result.exitReason = stop.reason;
      result.finalStatus = 'STOPPED_OUT';
      result.timeline.push(`[BACKTEST] ${t.timeStr} STOPPED_OUT at ₹${round2(stop.exitPrice)} (${stop.reason}, low=₹${round2(candle.low)} high=₹${round2(candle.high)})`);
      exited = true; break;
    }

    // ── TARGET HIT (shared decision) ──
    const target = checkTargetHit({ candleLow: candle.low, candleHigh: candle.high, targetLevel: currentTarget, direction: pick.direction });
    if (target.hit) {
      result.exitPrice = target.exitPrice;
      result.exitTime = candle.timestamp;
      result.exitReason = 'target_hit';
      result.finalStatus = 'TARGET_HIT';
      result.timeline.push(`[BACKTEST] ${t.timeStr} TARGET_HIT at ₹${round2(target.exitPrice)}`);
      exited = true; break;
    }

    // ── PARTIAL PROFIT BOOKING (shared decision) ──
    const partial = checkPartialBooking({
      entryPrice: result.entryPrice,
      currentPrice: isBullish ? candle.high : candle.low,
      targetPrice: originalTarget,
      direction: pick.direction,
      totalQty: result.qty,
      alreadyBooked: partialBooked,
    });
    if (partial.shouldBook) {
      result.partialBooked = true;
      result.partialQty = partial.bookQty;
      result.partialPrice = partial.bookLevel;
      result.remainingQty = result.qty - partial.bookQty;
      const pPnl = (isBullish ? partial.bookLevel - result.entryPrice : result.entryPrice - partial.bookLevel) * partial.bookQty;
      result.partialPnl = round2(pPnl);
      currentStop = result.entryPrice; // SL → breakeven
      partialBooked = true;
      result.timeline.push(`[BACKTEST] ${t.timeStr} PARTIAL_BOOK: ${partial.bookQty}qty at ₹${round2(partial.bookLevel)} (+₹${result.partialPnl}) SL→breakeven`);
    }

    // ── +1R BREAKEVEN (price-based) ──
    const originalRisk = Math.abs(result.entryPrice - originalStop);
    const currentProfit = isBullish ? currentPrice - result.entryPrice : result.entryPrice - currentPrice;
    const profitR = originalRisk > 0 ? currentProfit / originalRisk : 0;
    if (profitR >= 1.0 && !breakevenMoved) {
      const beStop = result.entryPrice;
      const shouldMove = isBullish ? beStop > currentStop : beStop < currentStop;
      if (shouldMove) {
        result.trailingHistory.push({ time: t.timeStr, oldStop: currentStop, newStop: beStop, price: currentPrice, reason: 'breakeven_1R' });
        result.timeline.push(`[BACKTEST] ${t.timeStr} +1R BE: SL ₹${round2(currentStop)}→₹${round2(beStop)} (${round2(profitR)}R)`);
        currentStop = beStop;
      }
      breakevenMoved = true;
    }

    // ── DYNAMIC TRAILING STOPS (Chandelier Exit via shared engine) ──
    const trail = computeDynamicTrail({
      entryPrice: result.entryPrice,
      currentPrice,
      extremePrice,
      currentStop,
      atr: intradayATR,
      profitPct,
      minutesSinceEntry,
      istHour: t.hour,
      isBullish,
      partialBooked,
    });

    if (trail.shouldTrail) {
      result.trailingHistory.push({ time: t.timeStr, oldStop: currentStop, newStop: trail.newStop, price: currentPrice, phase: trail.phase, method: trail.method });
      result.timeline.push(`[BACKTEST] ${t.timeStr} TRAIL[${trail.method}]: SL ₹${round2(currentStop)}→₹${round2(trail.newStop)} (peak=₹${round2(extremePrice)} ${trail.reason})`);
      currentStop = trail.newStop;
    }

    // ── SIDEWAYS EXIT (shared decision) ──
    const sideways = checkSidewaysExit(minutesSinceEntry, profitPct);
    if (sideways.shouldExit) {
      result.exitPrice = currentPrice;
      result.exitTime = candle.timestamp;
      result.exitReason = sideways.reason;
      result.finalStatus = 'TIME_EXIT';
      result.timeline.push(`[BACKTEST] ${t.timeStr} SIDEWAYS_EXIT: ${sideways.reason} profit=${round2(profitPct)}%`);
      exited = true; break;
    }

    // ── 3 PM FORCED EXIT (shared decision) ──
    const timeExit = checkTimeExit(t.hour);
    if (timeExit.shouldExit) {
      result.exitPrice = currentPrice;
      result.exitTime = candle.timestamp;
      result.exitReason = timeExit.reason;
      result.finalStatus = 'TIME_EXIT';
      result.timeline.push(`[BACKTEST] ${t.timeStr} TIME_EXIT at ₹${round2(currentPrice)}`);
      exited = true; break;
    }
  }

  // Safety: if candles ran out before 3 PM
  if (!exited) {
    const lastCandle = stockCandles[stockCandles.length - 1];
    result.exitPrice = lastCandle.close;
    result.exitTime = lastCandle.timestamp;
    result.exitReason = 'end_of_data';
    result.finalStatus = 'TIME_EXIT';
    result.timeline.push(`[BACKTEST] END_OF_DATA exit at ₹${round2(lastCandle.close)}`);
  }

  // ── STEP 5: P&L calculation (shared decision function) ──
  const pnlResult = computePnl({
    entryPrice: result.entryPrice,
    exitPrice: result.exitPrice,
    qty: result.qty,
    direction: pick.direction,
    partialQty: result.partialBooked ? result.partialQty : 0,
    partialPrice: result.partialBooked ? result.partialPrice : 0,
  });
  result.pnl = pnlResult.pnl;
  result.returnPct = pnlResult.returnPct;
  result.timeline.push(`[BACKTEST] P&L: ₹${round2(result.pnl)} (${round2(result.returnPct)}%) status=${result.finalStatus}`);

  return result;
}

/**
 * Load instrument key map from Stock collection
 */
export async function loadInstrumentMap() {
  const Stock = (await import('../models/stock.js')).default;
  const stocks = await Stock.find({
    instrument_key: { $exists: true, $ne: null },
    exchange: 'NSE'
  }).select('trading_symbol instrument_key').lean();
  const instrumentMap = {};
  for (const s of stocks) {
    if (s.trading_symbol) instrumentMap[s.trading_symbol] = s.instrument_key;
  }
  return instrumentMap;
}

/**
 * Get NIFTY instrument key from map
 */
export function getNiftyKey(instrumentMap) {
  return instrumentMap['NIFTY 50'] || instrumentMap['Nifty 50'] || 'NSE_INDEX|Nifty 50';
}
