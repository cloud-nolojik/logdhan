/**
 * ORB Service — Opening Range Breakout (intraday)
 *
 * Flow:
 *   09:08 AM  fetchPreOpenUniverse()  — Kite OHLC gap scan → candidates
 *   09:30 AM  recordOpeningRanges()   — Kite historical 15-min candle → OR High / Low
 *   every 1m  checkBreakouts()        — LTP > OR High → enter (max 3, window closes 10:30)
 *   every 5m  monitorOrbPositions()   — poll stop/target order status
 *   15:15     forceExitOrb()          — MARKET exit all remaining ENTERED positions
 *
 * Completely independent of dailyPicksService — shares only kiteOrderService.
 */

import kiteOrderService from '../kiteOrder.service.js';
import OrbTrade from '../../models/orbTrade.js';
import MarketHoursUtil from '../../utils/marketHours.js';
import { getFnoSymbols } from '../../constants/fnoUniverse.js';
import { analyzeIntradayStructure, checkSidewaysExit } from '../dailyPicks/tradingDecisions.js';

const LOG = '[ORB]';

// ── Strategy constants ──────────────────────────────────────────────────────
const MAX_ENTRIES           = 3;      // max positions per day (LONG + SHORT combined)
const MAX_CANDIDATES        = 15;     // total candidates across both directions
const MAX_LONG_CANDIDATES   = 8;      // top gap-UP for LONG breakouts (≥+1.5%)
const MAX_SHORT_CANDIDATES  = 7;      // top gap-DOWN for SHORT breakdowns (≤-1.5%)
// Min gap % to watch — was 1.5%, dropped to 1.0% on 2026-05-26 IST midday.
// Rationale: on 2026-05-25 the 1.5% filter qualified 4 names; on 2026-05-26
// it qualified only 2 (and neither broke OR). With <1 trade/day average we
// have too few data points to evaluate the strategy. Lowering to 1.0% should
// roughly double the universe on quiet days while still filtering pure noise.
// Re-evaluate after a week of data.
const MIN_PRE_OPEN_PCT      = 1.0;
const MAX_PRE_OPEN_PCT      = 8.0;    // max gap % (exhausted move) — unchanged
const ORB_CAPITAL_PCT       = 0.90;   // use at most 90% of whatever is available at entry time
const MIN_CAPITAL_PER_TRADE = 5000;   // skip entry if budget too thin
const TARGET_RANGE_MULT     = 1.5;    // (no longer used — see SIMPLE_MODE below)

// ── SIMPLE MODE (2026-05-26 evening) ─────────────────────────────────────────
// Switched to a clean SL-only strategy after two days of modify-bug-related
// pain (market_protection circuit-reject on 05-25, SL-M modify permissible-
// range reject on 05-26). The "intelligent" trail/target logic was good in
// theory but kept hitting Kite-API edge cases.
//
// New flow per trade:
//   1. Entry: MARKET BUY (LONG) / SELL (SHORT) on OR break
//   2. SL: placed ONCE at the breakout level + buffer, NEVER modified
//        LONG  → OR_High − min(1% of OR_High, OR_range)
//        SHORT → OR_Low  + min(1% of OR_Low,  OR_range)
//        The OR-range cap prevents the buffer from landing outside the OR
//        for very tight ranges (it then falls back to opposite-boundary stop).
//   3. NO target order — let the winner run.
//   4. Monitor: just check if SL fired. No BE trail, no candle tighten,
//      no sideways exit (all disabled below).
//   5. 15:15 force-exit anything still open.
const SL_BUFFER_PCT         = 1.0;    // target SL buffer in % of breakout level
                                       // (capped at OR range for tight-range stocks)

// Entry window extended 2026-05-25 (evening): was 9:30-11:00, now 9:30-14:00.
// Rationale: today (May 25) CANBK only broke out cleanly past 10:30 — at the
// OLD 11:00 cutoff we'd have missed it. With the candle-structure tighten +
// 15:15 force-exit handling risk, a longer window catches afternoon breakouts
// (often common on trend days post-lunch consolidation).
//
// Cap at 14:00 (not 15:00): a 14:00 entry has 75 min to work before the
// 15:15 force-exit — enough time for a breakout to either run to target or
// fail. Entries after 14:00 have too little runway (e.g., a 14:55 entry has
// only 20 min). Move to 15:00 if a week of data shows clean late-day setups
// we're missing.
const BREAKOUT_END_HOUR     = 14;
const BREAKOUT_END_MIN      = 0;      // no new entries after 14:00 (gives 75min runway before 15:15 force-exit)
const MAX_OR_RANGE_PCT      = 2.5;    // reject candidates where OR range > 2.5% of IEP

// ── 10:30 TIME EXIT — DISABLED 2026-05-25 (evening) ───────────────────────
// Hardcoded 10:30 AM force-exit was killing winners. On 2026-05-25:
//   CANBK time-exited at +0.82% (₹132.58); ran to +1.6% (₹134.09 high) later.
//   INOXWIND time-exited at +0.65% (₹97.94); was still breaking out.
// Winners now ride to either target hit, candle-structure tighten exit, or
// the 15:15 force-exit. Losers still get caught by SL (which trail logic
// tightens on bearish reversal candles via analyzeIntradayStructure).
// To re-enable for testing, set ORB_TIME_EXIT_ENABLED=true in env.
const TIME_EXIT_HOUR        = 10;
const TIME_EXIT_MIN         = 30;     // (kept as constants — gated by env at usage site)

// ── Helpers ────────────────────────────────────────────────────────────────
function snapToNSETick(price, tick = 0.05, mode = 'round') {
  const factor = Math.round(1 / tick);
  if (mode === 'floor') return Math.floor(price * factor) / factor;
  if (mode === 'ceil')  return Math.ceil(price  * factor) / factor;
  return Math.round(price * factor) / factor;
}

function parseKiteTickError(errMsg) {
  const m = (errMsg || '').match(/Tick size for this script is ([\d.]+)/i);
  return m ? parseFloat(m[1]) : null;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

function istTimeStr() {
  return MarketHoursUtil.toIST(new Date()).toTimeString().slice(0, 8);
}

// ── SL trail via cancel + place (replaces modifyOrder) ────────────────────
// Kite's modifyOrder on SL-M orders triggers the NSE "permissible range" check
// against the stale implicit limit from the original placement's market_protection
// — see Kite docs and 2026-05-26 incident notes. Modify is also not documented
// to accept market_protection as a parameter.
//
// Safe workaround: cancel the old SL-M, then place a fresh SL-M with the new
// trigger. ~1 second unprotected window between cancel and place. If place
// fails, fire an emergency market exit to close the position.
//
// IMPORTANT: we cancel FIRST, then place, to avoid the risk of both SL orders
// firing on a fast move (which would double the exit qty → naked position
// in the opposite direction).
//
// Returns { success: true, newOrderId } or { success: false, reason }.
async function replaceSlOrderWithNewTrigger({ candidate, newTrigger, exitSide, logTag = '[MONITOR]' }) {
  const sym       = candidate.symbol;
  const oldSlId   = candidate.stopOrderId;
  const qty       = candidate.qty;
  if (!oldSlId) {
    console.warn(`${LOG} ${logTag}   ⚠ ${sym}: no existing SL orderId to replace`);
    return { success: false, reason: 'no_existing_sl' };
  }

  // Step 1: cancel the old SL
  try {
    await kiteOrderService.cancelOrder(oldSlId);
    console.log(`${LOG} ${logTag}   ${sym}: cancelled old SL ${oldSlId}`);
  } catch (cancelErr) {
    console.error(`${LOG} ${logTag}   ${sym}: ❌ cancel failed (${cancelErr.message}) — keeping old SL active, aborting trail`);
    return { success: false, reason: 'cancel_failed' };
  }

  // Brief pause for cancel to register at exchange
  await delay(300);

  // Step 2: place new SL-M at the new trigger
  try {
    const placeRes = await kiteOrderService.placeOrder({
      tradingsymbol:    sym,
      exchange:         'NSE',
      transaction_type: exitSide,
      order_type:       'SL-M',
      trigger_price:    newTrigger,
      product:          'MIS',
      quantity:         qty,
      simulationId:     `orb_sl_trail_${sym}`,
      orderType:        'ORB_STOP',
      source:           'ORB',
    });
    if (placeRes?.success) {
      console.log(`${LOG} ${logTag}   ${sym}: ✅ new SL placed @ trigger ₹${newTrigger}, orderId=${placeRes.orderId}`);
      candidate.stopOrderId = placeRes.orderId;
      candidate.stopPrice   = newTrigger;
      return { success: true, newOrderId: placeRes.orderId };
    }
    throw new Error('placeOrder returned non-success');
  } catch (placeErr) {
    // CRITICAL: old SL is cancelled and new SL placement failed → position is UNPROTECTED.
    // Fire an emergency market exit to close the position immediately.
    console.error(`${LOG} ${logTag}   ${sym}: ⚠⚠ NEW SL PLACE FAILED (${placeErr.message}) — POSITION UNPROTECTED, firing emergency ${exitSide} MARKET`);
    candidate.stopOrderId = null;   // null so future cycles don't try to check a dead orderId
    try {
      const emergency = await kiteOrderService.placeOrder({
        tradingsymbol:    sym,
        exchange:         'NSE',
        transaction_type: exitSide,
        order_type:       'MARKET',
        product:          'MIS',
        quantity:         qty,
        simulationId:     `orb_emergency_after_trail_${sym}`,
        orderType:        'ORB_EMERGENCY_EXIT',
        source:           'ORB',
      });
      console.log(`${LOG} ${logTag}   ${sym}: emergency exit placed — orderId=${emergency?.orderId}`);
      return { success: false, reason: 'place_failed_emergency_fired', emergencyOrderId: emergency?.orderId };
    } catch (emergencyErr) {
      console.error(`${LOG} ${logTag}   ${sym}: ❌❌❌ EMERGENCY EXIT ALSO FAILED — MANUAL ACTION REQUIRED (${emergencyErr.message})`);
      return { success: false, reason: 'place_and_emergency_failed' };
    }
  }
}

// ── Pre-open universe via Kite OHLC ───────────────────────────────────────
// NSE's pre-open API blocks requests from VPS/cloud IPs.
// Kite's /quote/ohlc endpoint returns last_price (= IEP during pre-open auction)
// and ohlc.close (= previous day's close) for every F&O symbol in one call.
// Gap % = (last_price - ohlc.close) / ohlc.close × 100 — same calculation NSE uses.
async function fetchPreOpenViaKite() {
  const symbols = await getFnoSymbols();    // ~200 F&O underlyings from instrument master
  const CHUNK   = 100;                      // Kite OHLC accepts ~500 but 100 is safe
  const result  = {};

  console.log(`${LOG} [PHASE1] F&O universe: ${symbols.length} symbols — fetching OHLC in batches of ${CHUNK}`);

  for (let i = 0; i < symbols.length; i += CHUNK) {
    const batch       = symbols.slice(i, i + CHUNK);
    const instruments = batch.map(s => `NSE:${s}`);
    console.log(`${LOG} [PHASE1] OHLC batch ${Math.floor(i / CHUNK) + 1}/${Math.ceil(symbols.length / CHUNK)}: ${batch[0]}…${batch[batch.length - 1]} (${batch.length} symbols)`);
    try {
      const data = await kiteOrderService.getOHLC(instruments);
      const returned = Object.keys(data).length;
      console.log(`${LOG} [PHASE1]   → ${returned}/${batch.length} symbols returned data`);
      if (returned < batch.length) {
        const missing = batch.filter(s => !data[`NSE:${s}`]);
        console.warn(`${LOG} [PHASE1]   → missing: ${missing.join(', ')}`);
      }
      Object.assign(result, data);
    } catch (err) {
      console.error(`${LOG} [PHASE1] OHLC batch ${i}–${i + CHUNK} FAILED:`, err.message);
    }
  }

  const totalReturned = Object.keys(result).length;
  console.log(`${LOG} [PHASE1] OHLC complete: ${totalReturned}/${symbols.length} symbols have data`);

  // Reshape into the structure fetchPreOpenUniverse() expects
  const data = Object.entries(result).map(([key, q]) => {
    const symbol    = key.replace(/^NSE:/, '');
    const iep       = q.last_price  || 0;
    const prevClose = q.ohlc?.close || 0;
    const pChange   = prevClose > 0 ? ((iep - prevClose) / prevClose) * 100 : 0;
    return { metadata: { symbol, iep, previousClose: prevClose, pChange } };
  });

  return { data };
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 1 — Pre-open universe (9:08 AM)
// ══════════════════════════════════════════════════════════════════════════

export async function fetchPreOpenUniverse() {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} ═══ PHASE 1: Pre-open universe [${istTimeStr()}] ═══`);
  console.log(`${LOG} ════════════════════════════════════════`);

  let raw;
  try {
    raw = await fetchPreOpenViaKite();
  } catch (err) {
    console.error(`${LOG} [PHASE1] ❌ Kite pre-open fetch FAILED:`, err.message);
    console.error(`${LOG} [PHASE1]    Stack:`, err.stack);
    return { success: false, error: err.message };
  }

  const list = raw?.data || [];
  console.log(`${LOG} [PHASE1] Raw records from Kite: ${list.length}`);

  if (!list.length) {
    console.warn(`${LOG} [PHASE1] ⚠️  Zero records returned — Kite OHLC may be unavailable at this time`);
    return { success: true, count: 0 };
  }

  // Map + classify all records for near-miss visibility
  const mapped = list.map(item => {
    const m = item?.metadata || item;
    return {
      symbol:     String(m.symbol || '').toUpperCase().trim(),
      iep:        parseFloat(m.iep || m.lastPrice || 0),
      prevClose:  parseFloat(m.previousClose || 0),
      preOpenPct: parseFloat(m.pChange || m.perChange || 0),
      status:     'WATCHING',
    };
  }).filter(c => c.symbol && c.iep > 0);

  // Bucket for diagnostics — direction-aware (added 2026-05-25 evening)
  const gapUpWindow    = mapped.filter(c => c.preOpenPct >= MIN_PRE_OPEN_PCT && c.preOpenPct <= MAX_PRE_OPEN_PCT);
  const gapDownWindow  = mapped.filter(c => c.preOpenPct <= -MIN_PRE_OPEN_PCT && c.preOpenPct >= -MAX_PRE_OPEN_PCT);
  const upBelowFloor   = mapped.filter(c => c.preOpenPct > 0  && c.preOpenPct < MIN_PRE_OPEN_PCT);
  const downBelowFloor = mapped.filter(c => c.preOpenPct < 0  && c.preOpenPct > -MIN_PRE_OPEN_PCT);
  const upAboveCap     = mapped.filter(c => c.preOpenPct > MAX_PRE_OPEN_PCT);
  const downBelowCap   = mapped.filter(c => c.preOpenPct < -MAX_PRE_OPEN_PCT);
  const flat           = mapped.filter(c => c.preOpenPct === 0);

  console.log(`${LOG} [PHASE1] Gap distribution:`);
  console.log(`${LOG} [PHASE1]   gap UP   (LONG candidates, ≥+${MIN_PRE_OPEN_PCT}% to ≤+${MAX_PRE_OPEN_PCT}%): ${gapUpWindow.length}`);
  console.log(`${LOG} [PHASE1]   gap DOWN (SHORT candidates, ≤-${MIN_PRE_OPEN_PCT}% to ≥-${MAX_PRE_OPEN_PCT}%): ${gapDownWindow.length}`);
  console.log(`${LOG} [PHASE1]   up near-miss   (>0% to <+${MIN_PRE_OPEN_PCT}%):  ${upBelowFloor.length}`);
  console.log(`${LOG} [PHASE1]   down near-miss (<0% to >-${MIN_PRE_OPEN_PCT}%):  ${downBelowFloor.length}`);
  console.log(`${LOG} [PHASE1]   up exhausted   (>+${MAX_PRE_OPEN_PCT}%):         ${upAboveCap.length}`);
  console.log(`${LOG} [PHASE1]   down exhausted (<-${MAX_PRE_OPEN_PCT}%):         ${downBelowCap.length}`);
  console.log(`${LOG} [PHASE1]   flat (0%):                                       ${flat.length}`);

  // Near-miss diagnostics for both sides
  if (upBelowFloor.length) {
    const top5 = upBelowFloor.sort((a, b) => b.preOpenPct - a.preOpenPct).slice(0, 5);
    console.log(`${LOG} [PHASE1] UP near-miss top-5 (just below +${MIN_PRE_OPEN_PCT}% floor):`);
    top5.forEach(c => console.log(`${LOG} [PHASE1]   ${c.symbol.padEnd(14)} gap=+${c.preOpenPct.toFixed(2)}%  IEP=₹${c.iep}`));
  }
  if (downBelowFloor.length) {
    const top5 = downBelowFloor.sort((a, b) => a.preOpenPct - b.preOpenPct).slice(0, 5);
    console.log(`${LOG} [PHASE1] DOWN near-miss top-5 (just above -${MIN_PRE_OPEN_PCT}% floor):`);
    top5.forEach(c => console.log(`${LOG} [PHASE1]   ${c.symbol.padEnd(14)} gap=${c.preOpenPct.toFixed(2)}%  IEP=₹${c.iep}`));
  }
  if (upAboveCap.length) {
    console.log(`${LOG} [PHASE1] UP exhausted (>+${MAX_PRE_OPEN_PCT}%): ${upAboveCap.map(c => `${c.symbol}(+${c.preOpenPct.toFixed(1)}%)`).join(', ')}`);
  }
  if (downBelowCap.length) {
    console.log(`${LOG} [PHASE1] DOWN exhausted (<-${MAX_PRE_OPEN_PCT}%): ${downBelowCap.map(c => `${c.symbol}(${c.preOpenPct.toFixed(1)}%)`).join(', ')}`);
  }

  // Build final universe: top gap-UP tagged LONG + top gap-DOWN tagged SHORT
  const longCands = gapUpWindow
    .sort((a, b) => b.preOpenPct - a.preOpenPct)
    .slice(0, MAX_LONG_CANDIDATES)
    .map(c => ({ ...c, direction: 'LONG' }));

  const shortCands = gapDownWindow
    .sort((a, b) => a.preOpenPct - b.preOpenPct)   // most-negative first
    .slice(0, MAX_SHORT_CANDIDATES)
    .map(c => ({ ...c, direction: 'SHORT' }));

  const candidates = [...longCands, ...shortCands];

  console.log(`${LOG} [PHASE1] Final candidate list — ${longCands.length} LONG + ${shortCands.length} SHORT = ${candidates.length} total (cap ${MAX_CANDIDATES}):`);
  if (longCands.length) {
    console.log(`${LOG} [PHASE1]   LONG candidates (gap UP):`);
    longCands.forEach((c, i) =>
      console.log(`${LOG} [PHASE1]   #${String(i + 1).padStart(2)} L ${c.symbol.padEnd(14)} gap=+${c.preOpenPct.toFixed(2)}%  IEP=₹${c.iep}  prev=₹${c.prevClose}`)
    );
  }
  if (shortCands.length) {
    console.log(`${LOG} [PHASE1]   SHORT candidates (gap DOWN):`);
    shortCands.forEach((c, i) =>
      console.log(`${LOG} [PHASE1]   #${String(i + 1).padStart(2)} S ${c.symbol.padEnd(14)} gap=${c.preOpenPct.toFixed(2)}%  IEP=₹${c.iep}  prev=₹${c.prevClose}`)
    );
  }
  if (!candidates.length) {
    console.warn(`${LOG} [PHASE1] ⚠️  No candidates passed the gap filter (either direction) — ORB will be idle today`);
  }

  // Upsert today's ORB document
  const now      = new Date();
  const istOff   = 5.5 * 60 * 60 * 1000;
  const istNow   = new Date(now.getTime() + istOff);
  const startIST = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());
  const utcDate  = new Date(startIST.getTime() - istOff);

  try {
    const doc = await OrbTrade.findOneAndUpdate(
      { date: { $gte: utcDate, $lt: new Date(utcDate.getTime() + 86400000) } },
      { $set: { date: utcDate, candidates } },
      { upsert: true, new: true }
    );
    console.log(`${LOG} [PHASE1] ✅ orb_trades upserted — docId=${doc._id}  candidates=${candidates.length}`);
  } catch (err) {
    console.error(`${LOG} [PHASE1] ❌ DB upsert FAILED:`, err.message);
    return { success: false, error: err.message };
  }

  return { success: true, count: candidates.length };
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 2 — Record opening range (9:30 AM)
// ══════════════════════════════════════════════════════════════════════════

export async function recordOpeningRanges() {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} ═══ PHASE 2: Record opening ranges [${istTimeStr()}] ═══`);
  console.log(`${LOG} ════════════════════════════════════════`);

  const doc = await OrbTrade.findToday();
  if (!doc) {
    console.warn(`${LOG} [PHASE2] ⚠️  No ORB doc for today — Phase 1 may not have run`);
    return { success: false, reason: 'no_doc' };
  }
  console.log(`${LOG} [PHASE2] Doc found — docId=${doc._id}  total candidates=${doc.candidates.length}`);

  const watching = doc.candidates.filter(c => c.status === 'WATCHING');
  const skipped  = doc.candidates.filter(c => c.status === 'SKIPPED');
  console.log(`${LOG} [PHASE2] Candidate states: WATCHING=${watching.length}  SKIPPED=${skipped.length}  other=${doc.candidates.length - watching.length - skipped.length}`);

  if (!watching.length) {
    console.warn(`${LOG} [PHASE2] ⚠️  No WATCHING candidates — nothing to set range on`);
    return { success: true, rangesSet: 0 };
  }

  const symbols = watching.map(c => c.symbol);
  console.log(`${LOG} [PHASE2] Fetching 15-min candle for: ${symbols.join(', ')}`);

  let multiCandles;
  try {
    multiCandles = await kiteOrderService.getIntradayMultiCandles(symbols, [
      { interval: '15minute', count: 1 },
    ]);
  } catch (err) {
    console.error(`${LOG} [PHASE2] ❌ Kite candle fetch FAILED:`, err.message);
    console.error(`${LOG} [PHASE2]    Stack:`, err.stack);
    return { success: false, error: err.message };
  }

  const candles15m = multiCandles['15minute'] || {};
  console.log(`${LOG} [PHASE2] Candle data received for: ${Object.keys(candles15m).join(', ') || '(none)'}`);

  let rangesSet = 0;
  let rangesSkipped = 0;
  let rangesNoBar   = 0;

  for (const candidate of doc.candidates) {
    if (candidate.status !== 'WATCHING') continue;

    const bars = candles15m[candidate.symbol] || [];
    console.log(`${LOG} [PHASE2] ${candidate.symbol.padEnd(14)} bars received: ${bars.length}`);

    if (!bars.length) {
      console.warn(`${LOG} [PHASE2] ${candidate.symbol.padEnd(14)} ⚠️  No 15-min bar — candle not yet available, leaving as WATCHING`);
      rangesNoBar++;
      continue;
    }

    const bar     = bars[0];
    const orRange = parseFloat((bar.high - bar.low).toFixed(2));
    const rangePct = candidate.iep > 0 ? (orRange / candidate.iep) * 100 : 99;

    console.log(
      `${LOG} [PHASE2] ${candidate.symbol.padEnd(14)} ` +
      `candle → O=₹${bar.open}  H=₹${bar.high}  L=₹${bar.low}  C=₹${bar.close}` +
      `${bar.volume != null ? `  Vol=${bar.volume}` : ''}` +
      `  Range=₹${orRange} (${rangePct.toFixed(2)}% of IEP)`
    );

    if (rangePct > MAX_OR_RANGE_PCT) {
      candidate.status = 'SKIPPED';
      candidate.skipReason = `or_range_too_wide_${rangePct.toFixed(1)}pct`;
      console.warn(
        `${LOG} [PHASE2] ${candidate.symbol.padEnd(14)} ❌ SKIPPED — ` +
        `OR range ${rangePct.toFixed(2)}% > max ${MAX_OR_RANGE_PCT}% → target would be unreachable`
      );
      rangesSkipped++;
      continue;
    }

    candidate.orHigh  = bar.high;
    candidate.orLow   = bar.low;
    candidate.orRange = orRange;
    candidate.status  = 'RANGE_SET';
    rangesSet++;

    // Direction-aware implied levels:
    //   LONG: entry trigger = break above OR_High, stop = OR_Low, target = OR_High + 1.5×Range
    //   SHORT: entry trigger = break below OR_Low, stop = OR_High, target = OR_Low - 1.5×Range
    const isLong = (candidate.direction || 'LONG') === 'LONG';
    const impliedStop   = isLong
      ? snapToNSETick(bar.low,  0.05, 'floor')
      : snapToNSETick(bar.high, 0.05, 'ceil');
    const impliedTarget = isLong
      ? snapToNSETick(bar.high + TARGET_RANGE_MULT * orRange, 0.05, 'ceil')
      : snapToNSETick(bar.low  - TARGET_RANGE_MULT * orRange, 0.05, 'floor');
    console.log(
      `${LOG} [PHASE2] ${candidate.symbol.padEnd(14)} ✅ RANGE_SET [${isLong ? 'LONG' : 'SHORT'}] — ` +
      `OR High=₹${bar.high}  Low=₹${bar.low}  Range=₹${orRange}  ` +
      `implied stop=₹${impliedStop}  implied target=₹${impliedTarget}  ` +
      `gap was ${candidate.preOpenPct >= 0 ? '+' : ''}${candidate.preOpenPct.toFixed(2)}%`
    );
  }

  await doc.save();
  console.log(`${LOG} [PHASE2] ─────────────────────────────────`);
  console.log(`${LOG} [PHASE2] Summary: RANGE_SET=${rangesSet}  SKIPPED=${rangesSkipped}  NO_BAR=${rangesNoBar}  of ${watching.length} WATCHING`);
  return { success: true, rangesSet, rangesSkipped, rangesNoBar };
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 3 — Check breakouts + enter (every 1 min, 9:30–11:00 AM)
// ══════════════════════════════════════════════════════════════════════════

export async function checkBreakouts() {
  const ist    = MarketHoursUtil.toIST(new Date());
  const istMin = ist.getHours() * 60 + ist.getMinutes();
  const windowStart = 9 * 60 + 30;
  const windowEnd   = BREAKOUT_END_HOUR * 60 + BREAKOUT_END_MIN;

  if (istMin < windowStart || istMin > windowEnd) {
    console.log(`${LOG} [BREAKOUT] Outside entry window (now=${istTimeStr()}  window=09:30–${String(BREAKOUT_END_HOUR).padStart(2,'0')}:${String(BREAKOUT_END_MIN).padStart(2,'0')}) — skipping`);
    return { skipped: true, reason: 'outside_window' };
  }

  const doc = await OrbTrade.findToday();
  if (!doc) {
    console.warn(`${LOG} [BREAKOUT] No ORB doc for today — Phase 1 not run?`);
    return { skipped: true, reason: 'no_doc' };
  }

  const enteredCount = doc.candidates.filter(c => c.status === 'ENTERED').length;
  const rangeSet     = doc.candidates.filter(c => c.status === 'RANGE_SET');

  console.log(`${LOG} [BREAKOUT] [${istTimeStr()}] entries=${enteredCount}/${MAX_ENTRIES}  RANGE_SET=${rangeSet.length}`);

  if (enteredCount >= MAX_ENTRIES) {
    console.log(`${LOG} [BREAKOUT] Max ${MAX_ENTRIES} entries reached — skipping`);
    return { skipped: true, reason: 'max_entries' };
  }

  if (!rangeSet.length) {
    console.log(`${LOG} [BREAKOUT] No RANGE_SET candidates — skipping`);
    return { skipped: true, reason: 'no_range_set' };
  }

  // Fetch LTP for all candidates in one call
  const symbols = rangeSet.map(c => `NSE:${c.symbol}`);
  let ltpData;
  try {
    ltpData = await kiteOrderService.getLTP(symbols);
    console.log(`${LOG} [BREAKOUT] LTP fetched for ${Object.keys(ltpData).length}/${symbols.length} symbols`);
  } catch (err) {
    console.error(`${LOG} [BREAKOUT] ❌ LTP fetch FAILED:`, err.message);
    return { success: false, error: err.message };
  }

  // Capital allocation
  let capitalPerTrade = MIN_CAPITAL_PER_TRADE;
  try {
    const balance   = await kiteOrderService.getAvailableBalance();
    const orbBudget = balance.available * ORB_CAPITAL_PCT;
    const slotsLeft = MAX_ENTRIES - enteredCount;
    capitalPerTrade = Math.floor(orbBudget / Math.max(slotsLeft, 1));
    console.log(
      `${LOG} [BREAKOUT] Capital — available=₹${balance.available}  ` +
      `ORB budget (${ORB_CAPITAL_PCT * 100}%)=₹${Math.round(orbBudget)}  ` +
      `slots left=${slotsLeft}  per-trade=₹${capitalPerTrade}`
    );
    if (capitalPerTrade < MIN_CAPITAL_PER_TRADE) {
      console.warn(`${LOG} [BREAKOUT] ⚠️  Per-trade capital ₹${capitalPerTrade} < floor ₹${MIN_CAPITAL_PER_TRADE} — skipping entries`);
      return { skipped: true, reason: 'insufficient_capital', capitalPerTrade };
    }
  } catch (err) {
    console.error(`${LOG} [BREAKOUT] Balance fetch FAILED — using floor ₹${capitalPerTrade}:`, err.message);
  }

  // Check each candidate
  console.log(`${LOG} [BREAKOUT] Checking ${rangeSet.length} candidate(s):`);
  let entered = 0;

  for (const candidate of rangeSet) {
    if (doc.candidates.filter(c => c.status === 'ENTERED').length >= MAX_ENTRIES) break;

    const ltpEntry = ltpData[`NSE:${candidate.symbol}`];
    const ltp      = ltpEntry?.last_price;

    if (!ltp) {
      console.warn(`${LOG} [BREAKOUT]   ${candidate.symbol.padEnd(14)} ⚠️  No LTP returned — skipping`);
      continue;
    }

    // Direction-aware breakout test:
    //   LONG  → LTP > OR_High  (price broke ABOVE the opening range)
    //   SHORT → LTP < OR_Low   (price broke BELOW the opening range)
    const isLong       = (candidate.direction || 'LONG') === 'LONG';
    const triggered    = isLong ? (ltp > candidate.orHigh) : (ltp < candidate.orLow);
    const triggerLevel = isLong ? candidate.orHigh : candidate.orLow;
    const distance     = parseFloat((ltp - triggerLevel).toFixed(2));
    const distancePct  = parseFloat((Math.abs(ltp - triggerLevel) / triggerLevel * 100).toFixed(2));
    const dirTag       = isLong ? 'L' : 'S';

    console.log(
      `${LOG} [BREAKOUT]   ${dirTag} ${candidate.symbol.padEnd(14)} ` +
      `LTP=₹${ltp}  OR_High=₹${candidate.orHigh}  OR_Low=₹${candidate.orLow}  ` +
      (triggered
        ? (isLong
            ? `✅ BREAKOUT ABOVE OR_High (by ₹${Math.abs(distance)})`
            : `✅ BREAKDOWN BELOW OR_Low (by ₹${Math.abs(distance)})`)
        : (isLong
            ? `⬜ below OR_High (₹${Math.abs(distance)} = ${distancePct}% away)`
            : `⬜ above OR_Low (₹${Math.abs(distance)} = ${distancePct}% away)`))
    );

    if (triggered) {
      await enterTrade(doc, candidate, ltp, capitalPerTrade);
      entered++;
    }
  }

  if (entered > 0 || doc.isModified()) await doc.save();
  console.log(`${LOG} [BREAKOUT] Done — entered=${entered} this run`);
  return { success: true, entered };
}

// ── Enter a breakout trade ─────────────────────────────────────────────────
async function enterTrade(doc, candidate, ltp, capitalPerTrade) {
  // Direction-aware level computation:
  //   LONG: entry MARKET BUY, stop = OR_Low (snap floor), target = OR_High + 1.5×Range (snap ceil)
  //   SHORT: entry MARKET SELL, stop = OR_High (snap ceil), target = OR_Low - 1.5×Range (snap floor)
  const isLong      = (candidate.direction || 'LONG') === 'LONG';
  const entrySide   = isLong ? 'BUY'  : 'SELL';
  const exitSide    = isLong ? 'SELL' : 'BUY';
  const dirTag      = isLong ? 'LONG' : 'SHORT';

  const qty    = Math.max(1, Math.floor(capitalPerTrade / ltp));

  // SIMPLE MODE: tight SL just on the wrong side of the breakout level.
  // Buffer = min(1% of breakout level, OR range). The OR-range cap prevents
  // the SL from landing outside the OR on very tight ranges.
  const breakoutLevel = isLong ? candidate.orHigh : candidate.orLow;
  const targetBuffer  = breakoutLevel * (SL_BUFFER_PCT / 100);
  const effectiveBuf  = Math.min(targetBuffer, candidate.orRange);
  const usedSource    = effectiveBuf < targetBuffer ? 'OR cap' : `${SL_BUFFER_PCT}%`;

  let stop = isLong
    ? snapToNSETick(candidate.orHigh - effectiveBuf, 0.05, 'floor')
    : snapToNSETick(candidate.orLow  + effectiveBuf, 0.05, 'ceil');

  // NO target order in SIMPLE MODE — let winners ride to 15:15.
  const target = null;

  console.log(`${LOG} [ENTER] ─── ${candidate.symbol} [${dirTag}] ───────────────────────`);
  console.log(`${LOG} [ENTER] ${candidate.symbol}: capital=₹${capitalPerTrade}  LTP≈₹${ltp}  qty=${qty}`);
  console.log(`${LOG} [ENTER] ${candidate.symbol}: stop=₹${stop} (${isLong ? 'OR_High' : 'OR_Low'} ${isLong ? '−' : '+'} buffer ₹${effectiveBuf.toFixed(2)} [${usedSource}], OR range ₹${candidate.orRange.toFixed(2)})  target=NONE (ride to 15:15)`);
  console.log(`${LOG} [ENTER] ${candidate.symbol}: risk per share = ₹${Math.abs(ltp - stop).toFixed(2)} (${(Math.abs(ltp - stop) / ltp * 100).toFixed(2)}%)`);

  // ── Step 1: Market entry ──────────────────────────────────────────────────
  let entryOrderId, entryPrice;
  try {
    const res = await kiteOrderService.placeOrder({
      tradingsymbol:    candidate.symbol,
      exchange:         'NSE',
      transaction_type: entrySide,
      order_type:       'MARKET',
      product:          'MIS',
      quantity:         qty,
      simulationId:     `orb_entry_${candidate.symbol}`,
      orderType:        'ORB_ENTRY',
      source:           'ORB',
    });
    if (!res.success) throw new Error(`placeOrder returned success=false`);
    entryOrderId = res.orderId;
    console.log(`${LOG} [ENTER] ${candidate.symbol}: ✅ ${entrySide} entry order placed — orderId=${entryOrderId}`);
  } catch (err) {
    console.error(`${LOG} [ENTER] ${candidate.symbol}: ❌ entry order FAILED:`, err.message);
    candidate.status     = 'SKIPPED';
    candidate.skipReason = `entry_failed: ${err.message}`;
    return;
  }

  // Wait for fill then read average price
  console.log(`${LOG} [ENTER] ${candidate.symbol}: waiting 2s for fill confirmation...`);
  await delay(2000);
  let fillStatus = null;
  let filledQty = 0;
  try {
    const ord  = await kiteOrderService.getOrderDetails(entryOrderId);
    fillStatus = ord?.status;
    filledQty  = Number(ord?.filled_quantity || 0);
    entryPrice = ord?.average_price || ltp;
    console.log(`${LOG} [ENTER] ${candidate.symbol}: fill check — avg_price=₹${entryPrice}  status=${fillStatus}  filled_qty=${filledQty}`);
  } catch (err) {
    entryPrice = ltp;
    console.warn(`${LOG} [ENTER] ${candidate.symbol}: couldn't read fill details (${err.message}) — using LTP ₹${ltp} as entry price`);
  }

  // ── REJECTION GUARD (added 2026-05-25) ─────────────────────────────────────
  // If Kite rejected the entry (or it didn't fill any quantity), DO NOT proceed
  // to SL/target placement. Without this guard, on 2026-05-25 we placed phantom
  // SL-M SELL + target LIMIT SELL orders against positions that never existed
  // (entries had been REJECTED for circuit-limit breach), which then opened
  // naked SHORTs when the SL trailed and triggered.
  const isFilled = (fillStatus === 'COMPLETE' || fillStatus === 'OPEN') && filledQty >= qty;
  const isRejected = fillStatus === 'REJECTED' || fillStatus === 'CANCELLED' || filledQty === 0;
  if (isRejected || !isFilled) {
    console.error(`${LOG} [ENTER] ${candidate.symbol}: ❌ ENTRY NOT FILLED — status=${fillStatus} filled=${filledQty}/${qty} — aborting SL/target placement to prevent phantom shorts`);
    candidate.status       = 'SKIPPED';
    candidate.skipReason   = `entry_${(fillStatus || 'unknown').toLowerCase()}_filled_${filledQty}_of_${qty}`;
    candidate.entryOrderId = entryOrderId;  // keep for audit
    return;
  }

  candidate.entryOrderId = entryOrderId;
  candidate.entryPrice   = entryPrice;
  candidate.qty          = qty;
  candidate.stopPrice    = stop;
  candidate.targetPrice  = target;
  candidate.entryTime    = new Date();
  candidate.status       = 'ENTERED';
  doc.entriesCount       = (doc.entriesCount || 0) + 1;

  // ── Step 2: SL-M — direction-aware exit-side, retry on tick rejection ────
  // LONG  position → SL-M is a SELL (exit by selling when price drops to stop)
  // SHORT position → SL-M is a BUY  (exit by buying-to-cover when price rises to stop)
  let slOrderId;
  for (let attempt = 1; attempt <= 2; attempt++) {
    console.log(`${LOG} [ENTER] ${candidate.symbol}: SL-M ${exitSide} attempt ${attempt} — trigger=₹${stop}  qty=${qty}`);
    try {
      const slRes = await kiteOrderService.placeOrder({
        tradingsymbol:    candidate.symbol,
        exchange:         'NSE',
        transaction_type: exitSide,
        order_type:       'SL-M',
        trigger_price:    stop,
        product:          'MIS',
        quantity:         qty,
        simulationId:     `orb_sl_${candidate.symbol}`,
        orderType:        'ORB_STOP',
        source:           'ORB',
      });
      if (slRes.success) {
        slOrderId = slRes.orderId;
        console.log(`${LOG} [ENTER] ${candidate.symbol}: ✅ SL-M ${exitSide} placed — orderId=${slOrderId}  trigger=₹${stop}`);
        break;
      }
    } catch (err) {
      const tick = parseKiteTickError(err.message);
      if (tick && attempt === 1) {
        stop = isLong
          ? snapToNSETick(candidate.orLow,  tick, 'floor')
          : snapToNSETick(candidate.orHigh, tick, 'ceil');
        candidate.stopPrice = stop;
        console.warn(`${LOG} [ENTER] ${candidate.symbol}: tick error (tick=${tick}) → re-snapped stop=₹${stop}  retrying...`);
      } else {
        console.error(`${LOG} [ENTER] ${candidate.symbol}: ❌ SL-M attempt ${attempt} FAILED:`, err.message);
      }
    }
  }
  candidate.stopOrderId = slOrderId;

  // ── SL failure safety — emergency exit (also direction-aware) ────────────
  if (!slOrderId) {
    console.error(`${LOG} [ENTER] ${candidate.symbol}: ❌❌ SL-M FAILED after 2 attempts — EMERGENCY ${exitSide}`);
    try {
      const exitRes = await kiteOrderService.placeOrder({
        tradingsymbol:    candidate.symbol,
        exchange:         'NSE',
        transaction_type: exitSide,
        order_type:       'MARKET',
        product:          'MIS',
        quantity:         qty,
        simulationId:     `orb_emergency_exit_${candidate.symbol}`,
        orderType:        'ORB_EMERGENCY_EXIT',
        source:           'ORB',
      });
      console.log(`${LOG} [ENTER] ${candidate.symbol}: emergency ${exitSide} placed — orderId=${exitRes?.orderId}`);
    } catch (exitErr) {
      console.error(`${LOG} [ENTER] ${candidate.symbol}: ❌❌❌ EMERGENCY EXIT ALSO FAILED — MANUAL ACTION REQUIRED:`, exitErr.message);
    }
    candidate.status     = 'SKIPPED';
    candidate.skipReason = 'sl_placement_failed';
    candidate.exitReason = 'sl_placement_failed';
    doc.entriesCount     = Math.max(0, (doc.entriesCount || 1) - 1);
    return;
  }

  // ── Step 3: NO TARGET (SIMPLE MODE — 2026-05-26) ─────────────────────────
  // Target LIMIT order is intentionally NOT placed. The position rides until
  // the SL fires OR the 15:15 force-exit closes it. This avoids the modify
  // bugs we hit on 05-25/05-26 and lets winners run past any fixed cap.
  // The original target LIMIT placement code is preserved in git history if
  // we want to re-enable it later.
  candidate.targetOrderId = null;
  candidate.targetPrice   = null;

  console.log(`${LOG} [ENTER] ✅✅ ${candidate.symbol} [${dirTag}] LIVE`);
  console.log(`${LOG} [ENTER]    entry=₹${entryPrice}  stop=₹${stop}  target=NONE (ride to 15:15)`);
  console.log(`${LOG} [ENTER]    SL orderId=${slOrderId}`);
  console.log(`${LOG} [ENTER]    risk=₹${(Math.abs(entryPrice - stop) * qty).toFixed(2)} (${(Math.abs(entryPrice - stop) / entryPrice * 100).toFixed(2)}% per share)`);
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 4 — Monitor positions (every 5 min)
// ══════════════════════════════════════════════════════════════════════════

export async function monitorOrbPositions() {
  const doc = await OrbTrade.findToday();
  if (!doc) return { active: 0, exited: 0 };

  const entered = doc.candidates.filter(c => c.status === 'ENTERED');
  if (!entered.length) {
    console.log(`${LOG} [MONITOR] [${istTimeStr()}] No open positions`);
    return { active: 0, exited: 0 };
  }

  const ist          = MarketHoursUtil.toIST(new Date());
  const istMin       = ist.getHours() * 60 + ist.getMinutes();
  // 10:30 TIME EXIT is DISABLED by default (2026-05-25 change). Re-enable via
  // env if needed for testing. When disabled, the monitor falls through to BE
  // trail + candle-structure tighten and lets winners ride until 15:15.
  const timeExitEnabled = process.env.ORB_TIME_EXIT_ENABLED === 'true';
  const pastTimeExit = timeExitEnabled && (istMin >= TIME_EXIT_HOUR * 60 + TIME_EXIT_MIN);

  console.log(`${LOG} [MONITOR] ════════════ [${istTimeStr()}] ════════════`);
  console.log(`${LOG} [MONITOR] Open positions: ${entered.length}  ${pastTimeExit ? '⏰ PAST 10:30 — time-exit mode' : (timeExitEnabled ? 'within entry window' : 'monitoring (time-exit disabled, runs until 15:15)')}`);

  // Fetch LTP for all open positions in one call
  const ltpSymbols = entered.map(c => `NSE:${c.symbol}`);
  let ltpData = {};
  try {
    ltpData = await kiteOrderService.getLTP(ltpSymbols);
    console.log(`${LOG} [MONITOR] LTP fetched for ${Object.keys(ltpData).length}/${ltpSymbols.length} symbols`);
  } catch (err) {
    console.error(`${LOG} [MONITOR] ⚠️  LTP fetch failed (${err.message}) — continuing with order status checks only`);
  }

  let changed = false;
  let exitedThisRun = 0;

  for (const c of entered) {
    const ltp = ltpData[`NSE:${c.symbol}`]?.last_price;
    console.log(`${LOG} [MONITOR] ── ${c.symbol} ──────────────────────────`);
    console.log(`${LOG} [MONITOR]   entry=₹${c.entryPrice}  stop=₹${c.stopPrice}  target=₹${c.targetPrice}  LTP=${ltp ? `₹${ltp}` : 'N/A'}`);
    console.log(`${LOG} [MONITOR]   SL orderId=${c.stopOrderId || 'none'}  TGT orderId=${c.targetOrderId || 'none'}  beTrailed=${c._beTrailed || false}`);

    if (ltp) {
      // Direction-aware P&L: for SHORT, profit is when LTP < entryPrice.
      const isLong = (c.direction || 'LONG') === 'LONG';
      const priceDiff = isLong ? (ltp - c.entryPrice) : (c.entryPrice - ltp);
      const unrealised = parseFloat((priceDiff * c.qty).toFixed(2));
      const pct        = parseFloat((priceDiff / c.entryPrice * 100).toFixed(2));
      console.log(`${LOG} [MONITOR]   [${isLong ? 'LONG' : 'SHORT'}] unrealised PnL=₹${unrealised >= 0 ? '+' : ''}${unrealised} (${pct >= 0 ? '+' : ''}${pct}%)`);
    }

    // ── 10:30 time-exit ─────────────────────────────────────────────────────
    if (pastTimeExit) {
      console.log(`${LOG} [MONITOR]   ⏰ TIME EXIT — cancelling SL+TGT and placing market sell`);
      if (c.stopOrderId)   {
        try { await kiteOrderService.cancelOrder(c.stopOrderId);   console.log(`${LOG} [MONITOR]   SL cancel sent`);   } catch (e) { console.warn(`${LOG} [MONITOR]   SL cancel failed: ${e.message}`); }
      }
      if (c.targetOrderId) {
        try { await kiteOrderService.cancelOrder(c.targetOrderId); console.log(`${LOG} [MONITOR]   TGT cancel sent`); } catch (e) { console.warn(`${LOG} [MONITOR]   TGT cancel failed: ${e.message}`); }
      }
      await delay(500);
      // Direction-aware exit side: LONG closes via SELL, SHORT closes via BUY.
      const cIsLong  = (c.direction || 'LONG') === 'LONG';
      const cExitSide = cIsLong ? 'SELL' : 'BUY';
      try {
        const res = await kiteOrderService.placeOrder({
          tradingsymbol:    c.symbol,
          exchange:         'NSE',
          transaction_type: cExitSide,
          order_type:       'MARKET',
          product:          'MIS',
          quantity:         c.qty,
          simulationId:     `orb_time_exit_${c.symbol}`,
          orderType:        'ORB_TIME_EXIT',
          source:           'ORB',
        });
        if (res.success) {
          console.log(`${LOG} [MONITOR]   time-exit ${cExitSide} placed — orderId=${res.orderId}`);
          await delay(2000);
          let exitPrice = c.entryPrice;
          try {
            const ord = await kiteOrderService.getOrderDetails(res.orderId);
            if (ord?.average_price) exitPrice = ord.average_price;
            console.log(`${LOG} [MONITOR]   fill: avg_price=₹${exitPrice}  status=${ord?.status}`);
          } catch (_) {}
          c.status     = 'TIME_EXIT';
          c.exitPrice  = exitPrice;
          c.exitTime   = new Date();
          c.exitReason = 'time_exit_10:30am';
          // Direction-aware P&L: for SHORT, profit when exitPrice < entryPrice.
          const pnlDir = cIsLong ? (exitPrice - c.entryPrice) : (c.entryPrice - exitPrice);
          c.pnl        = parseFloat((pnlDir * c.qty).toFixed(2));
          c.returnPct  = parseFloat((pnlDir / c.entryPrice * 100).toFixed(2));
          console.log(`${LOG} [MONITOR]   ✅ ${c.symbol} [${cIsLong ? 'LONG' : 'SHORT'}] TIME EXIT @ ₹${exitPrice}  PnL=₹${c.pnl >= 0 ? '+' : ''}${c.pnl} (${c.returnPct >= 0 ? '+' : ''}${c.returnPct}%)`);
          exitedThisRun++;
          changed = true;
        }
      } catch (err) {
        console.error(`${LOG} [MONITOR]   ❌ time-exit order FAILED:`, err.message);
      }
      continue;
    }

    // Direction-aware sign helper for P&L (used in SL/target/BE blocks below)
    const cIsLong = (c.direction || 'LONG') === 'LONG';
    const pnlSign = (exitPrice) => cIsLong ? (exitPrice - c.entryPrice) : (c.entryPrice - exitPrice);

    // ── Check stop order status ──────────────────────────────────────────────
    if (c.stopOrderId) {
      try {
        const ord = await kiteOrderService.getOrderDetails(c.stopOrderId);
        console.log(`${LOG} [MONITOR]   SL order status=${ord?.status}  avg_price=${ord?.average_price || 'N/A'}`);
        if (ord?.status === 'COMPLETE') {
          c.status     = 'STOPPED_OUT';
          c.exitPrice  = ord.average_price;
          c.exitTime   = new Date();
          c.exitReason = 'stop_hit';
          c.pnl        = parseFloat((pnlSign(c.exitPrice) * c.qty).toFixed(2));
          c.returnPct  = parseFloat((pnlSign(c.exitPrice) / c.entryPrice * 100).toFixed(2));
          if (c.targetOrderId) { try { await kiteOrderService.cancelOrder(c.targetOrderId); console.log(`${LOG} [MONITOR]   TGT cancelled (stop hit)`); } catch (_) {} }
          console.log(`${LOG} [MONITOR]   🔴 ${c.symbol} [${cIsLong ? 'LONG' : 'SHORT'}] STOPPED OUT @ ₹${c.exitPrice}  PnL=₹${c.pnl}`);
          exitedThisRun++;
          changed = true;
          continue;
        } else if (ord?.status === 'CANCELLED' || ord?.status === 'REJECTED') {
          console.error(`${LOG} [MONITOR]   ⚠️  SL order is ${ord.status} — position UNPROTECTED! reason=${ord?.status_message}`);
        }
      } catch (err) {
        console.error(`${LOG} [MONITOR]   SL status check failed:`, err.message);
      }
    } else {
      console.error(`${LOG} [MONITOR]   ⚠️  ${c.symbol} has no SL orderId — position UNPROTECTED`);
    }

    // ── Check target order status ────────────────────────────────────────────
    if (c.targetOrderId) {
      try {
        const ord = await kiteOrderService.getOrderDetails(c.targetOrderId);
        console.log(`${LOG} [MONITOR]   TGT order status=${ord?.status}  avg_price=${ord?.average_price || 'N/A'}`);
        if (ord?.status === 'COMPLETE') {
          c.status     = 'TARGET_HIT';
          c.exitPrice  = ord.average_price;
          c.exitTime   = new Date();
          c.exitReason = 'target_hit';
          c.pnl        = parseFloat((pnlSign(c.exitPrice) * c.qty).toFixed(2));
          c.returnPct  = parseFloat((pnlSign(c.exitPrice) / c.entryPrice * 100).toFixed(2));
          if (c.stopOrderId) { try { await kiteOrderService.cancelOrder(c.stopOrderId); console.log(`${LOG} [MONITOR]   SL cancelled (target hit)`); } catch (_) {} }
          console.log(`${LOG} [MONITOR]   🟢 ${c.symbol} [${cIsLong ? 'LONG' : 'SHORT'}] TARGET HIT @ ₹${c.exitPrice}  PnL=₹${c.pnl >= 0 ? '+' : ''}${c.pnl}`);
          exitedThisRun++;
          changed = true;
          continue;
        }
      } catch (err) {
        console.error(`${LOG} [MONITOR]   TGT status check failed:`, err.message);
      }
    }

    // ── Breakeven trail — move stop to entry once 1R in profit ──────────────
    // Direction-aware: LONG → risk = entry−stop, gain = ltp−entry, BE stop moves UP.
    //                  SHORT → risk = stop−entry, gain = entry−ltp, BE stop moves DOWN.
    //
    // 2026-05-26 evening: switched from modifyOrder to cancel-and-replace.
    // Kite's modify on SL-M kept rejecting with "permissible range" because
    // of the stale implicit limit. cancel+replace avoids the whole problem.
    if (c.status === 'ENTERED' && c.stopOrderId && !c._beTrailed) {
      const risk        = cIsLong ? (c.entryPrice - c.stopPrice) : (c.stopPrice - c.entryPrice);
      const currentGain = ltp ? (cIsLong ? (ltp - c.entryPrice) : (c.entryPrice - ltp)) : null;
      if (ltp) {
        console.log(`${LOG} [MONITOR]   BE trail check [${cIsLong ? 'LONG' : 'SHORT'}]: risk=₹${risk.toFixed(2)}  current gain=₹${currentGain?.toFixed(2)}  need ₹${risk.toFixed(2)} for 1R`);
      }
      if (ltp && risk > 0 && currentGain != null && currentGain >= risk) {
        const beStop   = snapToNSETick(c.entryPrice, 0.05, cIsLong ? 'floor' : 'ceil');
        const exitSide = cIsLong ? 'SELL' : 'BUY';
        console.log(`${LOG} [MONITOR]   1R achieved → moving stop to breakeven=₹${beStop} via cancel+replace`);
        const replaceRes = await replaceSlOrderWithNewTrigger({
          candidate:  c,
          newTrigger: beStop,
          exitSide,
          logTag:     '[MONITOR]',
        });
        if (replaceRes.success) {
          c._beTrailed = true;
          console.log(`${LOG} [MONITOR]   ✅ ${c.symbol} [${cIsLong ? 'LONG' : 'SHORT'}] BE trail complete — new SL ${replaceRes.newOrderId} @ ₹${beStop}`);
          changed = true;
        }
        // On failure, helper already logged details / fired emergency exit if applicable.
      }
    }
  }

  // ── Candle structure analysis — exit / trail / tighten ────────────────────
  // Re-enabled 2026-05-26 evening after fixing the modify bug (added
  // market_protection: 1 to all SL-M modify calls so Kite recomputes the
  // implicit limit when trigger changes).
  //
  // Fetches 5-min (6 bars) + 15-min (4 bars) for all still-ENTERED positions.
  // Uses the same analyzeIntradayStructure() as dailyPicksService — two-timeframe
  // candle logic: 15-min for trend structure, 5-min for stop placement.
  // Also runs checkSidewaysExit (40 min / 0.3%) — ORB-appropriate shorter window
  // vs the 120-min used in daily picks (ORB window closes at 10:30).
  const ORB_SIDEWAYS_MINUTES = 40;
  const ORB_SIDEWAYS_PCT     = 0.3;

  const stillEntered = doc.candidates.filter(c => c.status === 'ENTERED');
  if (stillEntered.length) {
    const candleSymbols = stillEntered.map(c => c.symbol);
    console.log(`${LOG} [CANDLE] ── Candle analysis [${istTimeStr()}] ──────────────────`);
    console.log(`${LOG} [CANDLE] Fetching 5-min (6 bars) + 15-min (4 bars) for: ${candleSymbols.join(', ')}`);

    let candles5m = {}, candles15m = {};
    try {
      const multi = await kiteOrderService.getIntradayMultiCandles(candleSymbols, [
        { interval: '5minute',  count: 6 },
        { interval: '15minute', count: 4 },
      ]);
      candles5m  = multi['5minute']  || {};
      candles15m = multi['15minute'] || {};
    } catch (err) {
      console.error(`${LOG} [CANDLE] ❌ Candle fetch FAILED:`, err.message);
    }

    for (const c of stillEntered) {
      const sym5m  = candles5m[c.symbol]  || [];
      const sym15m = candles15m[c.symbol] || [];
      const ltp    = ltpData[`NSE:${c.symbol}`]?.last_price;
      // Direction-aware helpers for this candidate's candle/exit logic
      const cIsLong   = (c.direction || 'LONG') === 'LONG';
      const cExitSide = cIsLong ? 'SELL' : 'BUY';
      const cDirTag   = cIsLong ? 'LONG' : 'SHORT';

      console.log(`${LOG} [CANDLE] ${c.symbol} [${cDirTag}]: 5m_bars=${sym5m.length}  15m_bars=${sym15m.length}  stop=₹${c.stopPrice}  beTrailed=${!!c._beTrailed}`);

      // ── Sideways exit — position flat after 40 min (direction-aware profitPct) ─
      if (c.entryTime && ltp) {
        const minutesSinceEntry = (Date.now() - new Date(c.entryTime).getTime()) / 60000;
        // For SHORT: profit when ltp < entry, so flip the sign.
        const profitPct = cIsLong
          ? ((ltp - c.entryPrice) / c.entryPrice) * 100
          : ((c.entryPrice - ltp) / c.entryPrice) * 100;
        const sideways  = checkSidewaysExit(minutesSinceEntry, profitPct);
        console.log(`${LOG} [CANDLE] ${c.symbol}: sideways check — ${Math.round(minutesSinceEntry)}min in  pnl=${profitPct.toFixed(2)}%  shouldExit=${sideways.shouldExit}`);

        if (sideways.shouldExit) {
          console.log(`${LOG} [CANDLE] ${c.symbol}: SIDEWAYS EXIT — flat for ${Math.round(minutesSinceEntry)} min, cutting position`);
          if (c.stopOrderId)   { try { await kiteOrderService.cancelOrder(c.stopOrderId);   } catch (_) {} }
          if (c.targetOrderId) { try { await kiteOrderService.cancelOrder(c.targetOrderId); } catch (_) {} }
          await delay(500);
          try {
            const res = await kiteOrderService.placeOrder({
              tradingsymbol:    c.symbol,
              exchange:         'NSE',
              transaction_type: cExitSide,
              order_type:       'MARKET',
              product:          'MIS',
              quantity:         c.qty,
              simulationId:     `orb_sideways_exit_${c.symbol}`,
              orderType:        'ORB_SIDEWAYS_EXIT',
              source:           'ORB',
            });
            if (res.success) {
              await delay(1500);
              let exitPrice = ltp;
              try {
                const ord = await kiteOrderService.getOrderDetails(res.orderId);
                if (ord?.average_price) exitPrice = ord.average_price;
              } catch (_) {}
              c.status     = 'TIME_EXIT';
              c.exitPrice  = exitPrice;
              c.exitTime   = new Date();
              c.exitReason = `sideways_exit_${Math.round(minutesSinceEntry)}min`;
              const pnlDir = cIsLong ? (exitPrice - c.entryPrice) : (c.entryPrice - exitPrice);
              c.pnl        = parseFloat((pnlDir * c.qty).toFixed(2));
              c.returnPct  = parseFloat((pnlDir / c.entryPrice * 100).toFixed(2));
              console.log(`${LOG} [CANDLE] ✅ ${c.symbol} [${cDirTag}] sideways exit @ ₹${exitPrice}  PnL=₹${c.pnl >= 0 ? '+' : ''}${c.pnl}`);
              changed = true;
            }
          } catch (err) {
            console.error(`${LOG} [CANDLE] ${c.symbol}: sideways exit order FAILED:`, err.message);
          }
          continue;
        }
      }

      // ── Candle structure analysis — direction-aware via candidate.direction ─
      const decision = analyzeIntradayStructure({
        candles5m:   sym5m,
        candles15m:  sym15m,
        direction:   cDirTag,         // 'LONG' or 'SHORT' — symmetric patterns
        currentStop: c.stopPrice,
        // R-cushion context — see analyzeIntradayStructure docstring.
        entryPrice:  c.entryPrice,
        plannedStop: c.originalStop ?? c.stopPrice,
      });

      console.log(`${LOG} [CANDLE] ${c.symbol} [${cDirTag}]: action=${decision.action}${decision.newStop ? `  newStop=₹${decision.newStop}` : ''}`);
      console.log(`${LOG} [CANDLE] ${c.symbol}:   ${decision.reason}`);

      if (decision.action === 'exit') {
        // ── Structure break — exit immediately (direction-aware exit side) ────
        console.log(`${LOG} [CANDLE] ${c.symbol}: STRUCTURE BREAK → ${cExitSide} MARKET`);
        if (c.stopOrderId)   { try { await kiteOrderService.cancelOrder(c.stopOrderId);   console.log(`${LOG} [CANDLE] ${c.symbol}: SL cancelled`);   } catch (_) {} }
        if (c.targetOrderId) { try { await kiteOrderService.cancelOrder(c.targetOrderId); console.log(`${LOG} [CANDLE] ${c.symbol}: TGT cancelled`); } catch (_) {} }
        await delay(500);
        try {
          const res = await kiteOrderService.placeOrder({
            tradingsymbol:    c.symbol,
            exchange:         'NSE',
            transaction_type: cExitSide,
            order_type:       'MARKET',
            product:          'MIS',
            quantity:         c.qty,
            simulationId:     `orb_candle_exit_${c.symbol}`,
            orderType:        'ORB_CANDLE_EXIT',
            source:           'ORB',
          });
          if (res.success) {
            await delay(1500);
            let exitPrice = sym5m.length ? sym5m[sym5m.length - 1].close : c.entryPrice;
            try {
              const ord = await kiteOrderService.getOrderDetails(res.orderId);
              if (ord?.average_price) exitPrice = ord.average_price;
            } catch (_) {}
            c.status     = 'TIME_EXIT';
            c.exitPrice  = exitPrice;
            c.exitTime   = new Date();
            c.exitReason = `candle_structure_exit: ${decision.reason.split(' | ')[0]}`;
            const pnlDir = cIsLong ? (exitPrice - c.entryPrice) : (c.entryPrice - exitPrice);
            c.pnl        = parseFloat((pnlDir * c.qty).toFixed(2));
            c.returnPct  = parseFloat((pnlDir / c.entryPrice * 100).toFixed(2));
            console.log(`${LOG} [CANDLE] ✅ ${c.symbol} [${cDirTag}] candle exit @ ₹${exitPrice}  PnL=₹${c.pnl >= 0 ? '+' : ''}${c.pnl}`);
            changed = true;
          }
        } catch (err) {
          console.error(`${LOG} [CANDLE] ${c.symbol}: candle exit order FAILED:`, err.message);
        }

      } else if ((decision.action === 'trail' || decision.action === 'tighten') && decision.newStop) {
        // ── Trail or tighten — modify SL on Kite (SL-M, trigger only) ─────────
        // LONG: stop moves UP (snap floor); SHORT: stop moves DOWN (snap ceil).
        const snappedStop  = cIsLong
          ? snapToNSETick(decision.newStop, 0.05, 'floor')
          : snapToNSETick(decision.newStop, 0.05, 'ceil');
        // "Improvement" means stop moves in our favor: UP for LONG, DOWN for SHORT.
        const isImprovement = cIsLong
          ? snappedStop > c.stopPrice
          : snappedStop < c.stopPrice;

        if (!isImprovement) {
          console.log(`${LOG} [CANDLE] ${c.symbol}: ${decision.action} ₹${snappedStop} would not improve current stop ₹${c.stopPrice} — skipping`);
        } else if (!c.stopOrderId) {
          console.warn(`${LOG} [CANDLE] ${c.symbol}: ${decision.action} ₹${snappedStop} but no SL order to modify`);
        } else {
          // 2026-05-26 evening: switched from modifyOrder to cancel+replace.
          // Kite's modify kept rejecting with "permissible range" on SL-M.
          // See replaceSlOrderWithNewTrigger() docstring.
          const replaceRes = await replaceSlOrderWithNewTrigger({
            candidate:  c,
            newTrigger: snappedStop,
            exitSide:   cExitSide,
            logTag:     '[CANDLE]',
          });
          if (replaceRes.success) {
            console.log(`${LOG} [CANDLE] ✅ ${c.symbol} [${cDirTag}]: ${decision.action} — stop ₹${c.stopPrice} → ₹${snappedStop} [${decision.reason.split(' | ')[0]}]`);
            // Mark BE trailed when stop crosses entry "in our favor":
            //   LONG  → stop ≥ entry
            //   SHORT → stop ≤ entry
            const crossedBE = cIsLong ? (snappedStop >= c.entryPrice) : (snappedStop <= c.entryPrice);
            if (crossedBE) c._beTrailed = true;
            changed = true;
          }
          // On failure, helper already logged details / fired emergency exit if applicable.
        }
      }
      // 'hold' — nothing to do
    }
  }

  if (changed) {
    doc.totalPnl = parseFloat(
      doc.candidates.reduce((s, c) => s + (c.pnl || 0), 0).toFixed(2)
    );
    await doc.save();
    console.log(`${LOG} [MONITOR] Doc saved — totalPnl=₹${doc.totalPnl}`);
  }

  const stillOpen = doc.candidates.filter(c => c.status === 'ENTERED').length;
  console.log(`${LOG} [MONITOR] ─── run complete — exited=${exitedThisRun}  still open=${stillOpen} ───`);
  return { active: stillOpen, exited: exitedThisRun };
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 5 — Force exit at 3:15 PM
// ══════════════════════════════════════════════════════════════════════════

export async function forceExitOrb() {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} ═══ PHASE 5: Force exit [${istTimeStr()}] ═══`);
  console.log(`${LOG} ════════════════════════════════════════`);

  const doc = await OrbTrade.findToday();
  if (!doc) {
    console.log(`${LOG} [FORCE-EXIT] No ORB doc today — nothing to do`);
    return { exited: 0 };
  }

  const entered = doc.candidates.filter(c => c.status === 'ENTERED');
  if (!entered.length) {
    console.log(`${LOG} [FORCE-EXIT] No ENTERED positions — all already closed`);

    // Print day summary even if nothing to exit
    const allDone = doc.candidates.filter(c => ['STOPPED_OUT','TARGET_HIT','TIME_EXIT'].includes(c.status));
    if (allDone.length) {
      console.log(`${LOG} [FORCE-EXIT] ─── Day summary ───`);
      allDone.forEach(c =>
        console.log(`${LOG} [FORCE-EXIT]   ${c.symbol.padEnd(14)} ${c.status.padEnd(12)} @ ₹${c.exitPrice}  PnL=₹${c.pnl >= 0 ? '+' : ''}${c.pnl} (${c.returnPct >= 0 ? '+' : ''}${c.returnPct}%)`)
      );
      console.log(`${LOG} [FORCE-EXIT]   Total PnL: ₹${doc.totalPnl >= 0 ? '+' : ''}${doc.totalPnl}`);
    }
    return { exited: 0 };
  }

  console.log(`${LOG} [FORCE-EXIT] ${entered.length} position(s) still open — hard-flat all`);
  let exited = 0;

  for (const c of entered) {
    // Direction-aware exit side: LONG closes via SELL, SHORT closes via BUY.
    const cIsLong   = (c.direction || 'LONG') === 'LONG';
    const cExitSide = cIsLong ? 'SELL' : 'BUY';
    const cDirTag   = cIsLong ? 'LONG' : 'SHORT';

    console.log(`${LOG} [FORCE-EXIT] ── ${c.symbol} [${cDirTag}] ──`);
    console.log(`${LOG} [FORCE-EXIT]   entry=₹${c.entryPrice}  stop=₹${c.stopPrice}  target=₹${c.targetPrice}  qty=${c.qty}`);

    if (c.stopOrderId) {
      try { await kiteOrderService.cancelOrder(c.stopOrderId);   console.log(`${LOG} [FORCE-EXIT]   SL cancelled`);   }
      catch (e) { console.warn(`${LOG} [FORCE-EXIT]   SL cancel failed: ${e.message}`); }
    }
    if (c.targetOrderId) {
      try { await kiteOrderService.cancelOrder(c.targetOrderId); console.log(`${LOG} [FORCE-EXIT]   TGT cancelled`); }
      catch (e) { console.warn(`${LOG} [FORCE-EXIT]   TGT cancel failed: ${e.message}`); }
    }
    await delay(500);

    try {
      const res = await kiteOrderService.placeOrder({
        tradingsymbol:    c.symbol,
        exchange:         'NSE',
        transaction_type: cExitSide,
        order_type:       'MARKET',
        product:          'MIS',
        quantity:         c.qty,
        simulationId:     `orb_exit_${c.symbol}`,
        orderType:        'ORB_TIME_EXIT',
        source:           'ORB',
      });

      if (res.success) {
        console.log(`${LOG} [FORCE-EXIT]   ${cExitSide} order placed — orderId=${res.orderId}`);
        await delay(2000);
        let exitPrice = c.entryPrice;
        try {
          const ord = await kiteOrderService.getOrderDetails(res.orderId);
          if (ord?.average_price) exitPrice = ord.average_price;
          console.log(`${LOG} [FORCE-EXIT]   fill: avg_price=₹${exitPrice}  status=${ord?.status}`);
        } catch (_) {}

        c.status     = 'TIME_EXIT';
        c.exitPrice  = exitPrice;
        c.exitTime   = new Date();
        c.exitReason = 'time_exit_3:15pm';
        // Direction-aware P&L
        const pnlDir = cIsLong ? (exitPrice - c.entryPrice) : (c.entryPrice - exitPrice);
        c.pnl        = parseFloat((pnlDir * c.qty).toFixed(2));
        c.returnPct  = parseFloat((pnlDir / c.entryPrice * 100).toFixed(2));
        console.log(`${LOG} [FORCE-EXIT]   ✅ ${c.symbol} [${cDirTag}] exited @ ₹${exitPrice}  PnL=₹${c.pnl >= 0 ? '+' : ''}${c.pnl}`);
        exited++;
      }
    } catch (err) {
      console.error(`${LOG} [FORCE-EXIT]   ❌ exit order FAILED:`, err.message);
    }
  }

  doc.totalPnl = parseFloat(
    doc.candidates.reduce((s, c) => s + (c.pnl || 0), 0).toFixed(2)
  );
  await doc.save();

  console.log(`${LOG} ════════════ ORB DAY COMPLETE ════════════`);
  console.log(`${LOG} Entries: ${doc.entriesCount || 0}  Exited today: ${exited}`);
  const allDone = doc.candidates.filter(c => ['STOPPED_OUT','TARGET_HIT','TIME_EXIT'].includes(c.status));
  allDone.forEach(c =>
    console.log(`${LOG}   ${c.symbol.padEnd(14)} ${c.status.padEnd(12)} @ ₹${c.exitPrice}  PnL=₹${c.pnl >= 0 ? '+' : ''}${c.pnl} (${c.returnPct >= 0 ? '+' : ''}${c.returnPct}%)`)
  );
  console.log(`${LOG} Total PnL: ₹${doc.totalPnl >= 0 ? '+' : ''}${doc.totalPnl}`);
  console.log(`${LOG} ═══════════════════════════════════════════`);

  return { exited };
}
