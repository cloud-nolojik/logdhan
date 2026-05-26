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
// TIER-1 changes (2026-05-26 evening):
// • No pre-open gap filter. ALL F&O stocks are candidates.
// • Direction (LONG/SHORT) is decided at the OR-break moment, not at 9:08.
// • MAX_CANDIDATES is now an upper bound for safety; in practice we save all
//   ~215 F&O symbols that returned valid OHLC.
const MAX_CANDIDATES        = 250;
const MIN_OR_RANGE_PCT      = 0.5;    // skip stocks with OR < 0.5% of price (tight chop, fake breakouts)
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
// pain. NOTE: the trail/intelligent monitor was re-enabled later that same
// evening with proper cancel+replace SL handling.
//
// Flow per trade:
//   1. Entry: MARKET BUY (LONG) / SELL (SHORT) on 2-bar 15-min OR confirmation
//   2. SL: placed ONCE at the breakout level + buffer, modified via cancel+replace
//        LONG  → OR_High − min(1% of OR_High, OR_range)
//        SHORT → OR_Low  + min(1% of OR_Low,  OR_range)
//   3. NO target order — let the winner run.
//   4. Monitor: SL fill check, BE trail at +1R, candle structure tighten.
//   5. 15:15 force-exit anything still open.
const SL_BUFFER_PCT         = 1.0;    // target SL buffer in % of breakout level
                                       // (capped at OR range for tight-range stocks)

// Entry window — TIER-1 2026-05-26 evening update:
// First entry at 10:01 (when 2-bar 15-min confirmation is first possible).
// Last entry at 14:01 (gives 74 min before 15:15 force-exit).
// Rationale: today (May 25) CANBK only broke out cleanly past 10:30 — at the
// OLD 11:00 cutoff we'd have missed it. With the candle-structure tighten +
// 15:15 force-exit handling risk, a longer window catches afternoon breakouts
// (often common on trend days post-lunch consolidation).
//
// Window now begins 10:01 (when 2-bar 15-min confirmation becomes possible)
// and ends 14:01 (last 15-min boundary that gives ≥74 min runway to 15:15).
const BREAKOUT_START_HOUR   = 10;
const BREAKOUT_START_MIN    = 1;
const BREAKOUT_END_HOUR     = 14;
const BREAKOUT_END_MIN      = 1;
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

// ── Broker position check before placing exits ──────────────────────────
// Critical safety: before firing any exit order (force-exit, time-exit,
// candle-exit, sideways-exit), verify there's actually an open position at
// the broker. Without this check, if you manually closed the position in
// Kite during the day, the system's "exit" would OPEN a fresh trade in the
// opposite direction.
//
// Concrete incident: 2026-05-26 CONCOR. System entered SHORT 27 @ 482.95
// at 11:03. User manually BUY-covered at 13:58 (₹476). At 15:15 the force-
// exit cron fired a BUY-MARKET to "close the short", which actually opened
// a LONG 27 @ ₹476.60. Then Zerodha auto-squared at 15:25 SELL @ ₹475.10.
// Net give-back: ~₹40 on top of the ~₹187 captured. This helper prevents
// that.
//
// Returns the actual open qty for the symbol (signed: negative for SHORT,
// positive for LONG, 0 for flat). Returns null on Kite API error so callers
// can choose to fall through (existing behavior) rather than skip.
async function getActualPositionQty(symbol) {
  try {
    const positions = await kiteOrderService.getPositions();
    const dayList   = positions?.data?.day || [];
    const found     = dayList.find(p => p.tradingsymbol === symbol);
    if (!found) return 0;
    return Number(found.quantity || 0);
  } catch (err) {
    console.error(`${LOG} [POS-CHECK] ${symbol}: getPositions failed (${err.message}) — falling through`);
    return null;  // unknown — caller decides
  }
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

  // ── TIER-1 (2026-05-26 evening): NO GAP FILTER ────────────────────────────
  // Every F&O symbol with valid OHLC becomes a candidate. Direction is decided
  // at the OR-break moment in Phase 3 (whichever side of OR is crossed). The
  // gap distribution is logged for observability only — it does NOT filter.
  const gapUpStrong    = mapped.filter(c => c.preOpenPct >=  1.0);
  const gapDownStrong  = mapped.filter(c => c.preOpenPct <= -1.0);
  const flatish        = mapped.filter(c => Math.abs(c.preOpenPct) < 1.0);

  console.log(`${LOG} [PHASE1] Gap distribution (observability only — all stocks pass to Phase 2):`);
  console.log(`${LOG} [PHASE1]   strong gap UP   (≥+1%):  ${gapUpStrong.length}`);
  console.log(`${LOG} [PHASE1]   strong gap DOWN (≤-1%):  ${gapDownStrong.length}`);
  console.log(`${LOG} [PHASE1]   flat-ish        (|gap|<1%): ${flatish.length}`);

  if (gapUpStrong.length) {
    const top5 = gapUpStrong.sort((a, b) => b.preOpenPct - a.preOpenPct).slice(0, 5);
    console.log(`${LOG} [PHASE1] Top-5 gap UP today:`);
    top5.forEach(c => console.log(`${LOG} [PHASE1]   ${c.symbol.padEnd(14)} gap=+${c.preOpenPct.toFixed(2)}%  IEP=₹${c.iep}`));
  }
  if (gapDownStrong.length) {
    const top5 = gapDownStrong.sort((a, b) => a.preOpenPct - b.preOpenPct).slice(0, 5);
    console.log(`${LOG} [PHASE1] Top-5 gap DOWN today:`);
    top5.forEach(c => console.log(`${LOG} [PHASE1]   ${c.symbol.padEnd(14)} gap=${c.preOpenPct.toFixed(2)}%  IEP=₹${c.iep}`));
  }

  // Save ALL stocks (cap at MAX_CANDIDATES = 250 as safety bound). Direction
  // is intentionally NOT set — Phase 3 sets it when price breaks OR.
  // We keep preOpenPct on the candidate object for later scoring/observability.
  const candidates = mapped
    .filter(c => c.iep > 0 && c.prevClose > 0)
    .slice(0, MAX_CANDIDATES);

  console.log(`${LOG} [PHASE1] Universe — ${candidates.length} F&O stocks saved (no gap filter, direction decided at break)`);
  if (!candidates.length) {
    console.warn(`${LOG} [PHASE1] ⚠️  No candidates — Kite OHLC may be unavailable`);
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
  console.log(`${LOG} [PHASE2] TIER-1 mode: fetching OR via /quote/ohlc for ${symbols.length} stocks (batched)`);
  // TIER-1 change: instead of slow per-symbol historical candle calls (would
  // rate-limit at 215 stocks), use /quote/ohlc which returns today's running
  // H/L. Called at 9:30:00, those values equal the 9:15-9:30 OR candle.

  const CHUNK = 100;
  const ohlcMap = {};
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const batch = symbols.slice(i, i + CHUNK);
    const instruments = batch.map(s => `NSE:${s}`);
    console.log(`${LOG} [PHASE2] OHLC batch ${Math.floor(i / CHUNK) + 1}/${Math.ceil(symbols.length / CHUNK)}: ${batch.length} symbols`);
    try {
      const data = await kiteOrderService.getOHLC(instruments);
      Object.assign(ohlcMap, data);
    } catch (err) {
      console.error(`${LOG} [PHASE2] OHLC batch failed (${err.message}) — continuing with what we have`);
    }
  }
  console.log(`${LOG} [PHASE2] OHLC complete: ${Object.keys(ohlcMap).length}/${symbols.length} symbols returned data`);

  let rangesSet = 0;
  let rangesSkippedWide = 0;
  let rangesSkippedTight = 0;
  let rangesNoData = 0;

  for (const candidate of doc.candidates) {
    if (candidate.status !== 'WATCHING') continue;

    const q = ohlcMap[`NSE:${candidate.symbol}`];
    if (!q || !q.ohlc) {
      console.warn(`${LOG} [PHASE2] ${candidate.symbol.padEnd(14)} ⚠ no OHLC data — leaving WATCHING`);
      rangesNoData++;
      continue;
    }

    // At 9:30:00, ohlc.open = 9:15 open, ohlc.high/low = today's H/L so far
    // (which = the 9:15-9:30 candle since market just opened 15 min ago).
    const orHigh  = q.ohlc.high;
    const orLow   = q.ohlc.low;
    const orRange = parseFloat((orHigh - orLow).toFixed(2));
    const rangePct = candidate.iep > 0 ? (orRange / candidate.iep) * 100 : 99;

    // Quality filter 1: skip too-wide OR (existing — target would be unreachable)
    if (rangePct > MAX_OR_RANGE_PCT) {
      candidate.status = 'SKIPPED';
      candidate.skipReason = `or_too_wide_${rangePct.toFixed(2)}pct`;
      rangesSkippedWide++;
      continue;
    }
    // Quality filter 2 (TIER-1 new): skip too-tight OR (noise breakouts likely)
    if (rangePct < MIN_OR_RANGE_PCT) {
      candidate.status = 'SKIPPED';
      candidate.skipReason = `or_too_tight_${rangePct.toFixed(2)}pct`;
      rangesSkippedTight++;
      continue;
    }

    candidate.orHigh  = orHigh;
    candidate.orLow   = orLow;
    candidate.orRange = orRange;
    candidate.status  = 'RANGE_SET';
    // direction is intentionally left unset — will be set in Phase 3 at break time
    rangesSet++;
  }

  // Summary log (instead of 200+ per-symbol lines that would blow up the log)
  console.log(`${LOG} [PHASE2] Summary: RANGE_SET=${rangesSet}  SKIPPED tight=${rangesSkippedTight}  SKIPPED wide=${rangesSkippedWide}  NO_DATA=${rangesNoData}  of ${watching.length}`);

  // Log a sample of accepted candidates for visibility
  const accepted = doc.candidates.filter(c => c.status === 'RANGE_SET');
  if (accepted.length) {
    const sample = accepted
      .sort((a, b) => (b.orRange / b.iep) - (a.orRange / a.iep))   // widest OR first
      .slice(0, 10);
    console.log(`${LOG} [PHASE2] Top-10 by OR range %:`);
    sample.forEach(c => {
      const pct = (c.orRange / c.iep * 100).toFixed(2);
      console.log(`${LOG} [PHASE2]   ${c.symbol.padEnd(14)} OR=₹${c.orLow}–₹${c.orHigh} (₹${c.orRange.toFixed(2)} = ${pct}%)  IEP=₹${c.iep}`);
    });
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
  const windowStart = BREAKOUT_START_HOUR * 60 + BREAKOUT_START_MIN;   // 10:01
  const windowEnd   = BREAKOUT_END_HOUR   * 60 + BREAKOUT_END_MIN;     // 14:01

  if (istMin < windowStart || istMin > windowEnd) {
    console.log(`${LOG} [BREAKOUT] Outside entry window (now=${istTimeStr()}  window=${String(BREAKOUT_START_HOUR).padStart(2,'0')}:${String(BREAKOUT_START_MIN).padStart(2,'0')}–${String(BREAKOUT_END_HOUR).padStart(2,'0')}:${String(BREAKOUT_END_MIN).padStart(2,'0')}) — skipping`);
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

  // TIER-1 + 2-BAR CONFIRM (2026-05-26 evening):
  // Fetch the last 2 completed 15-min candles for each RANGE_SET candidate.
  // BOTH candles must close past OR in the SAME direction → confirmed breakout.
  // This filters out:
  //   • wick fake-outs (price touches past OR then reverts within the candle)
  //   • whipsaws (one candle each side of OR)
  //   • single-candle late stabs (less reliable than 2-bar trend)
  //
  // Chunk size 20 keeps Kite historical-data rate limit happy (3 req/sec).
  // At ~130 RANGE_SET stocks: 130/20 = ~7 chunks × ~1.5s each = ~10s total.
  console.log(`${LOG} [BREAKOUT] Fetching last 2×15-min candles for ${rangeSet.length} stocks (chunked)...`);
  const allCandles = {};
  const CANDLE_CHUNK = 20;
  for (let i = 0; i < rangeSet.length; i += CANDLE_CHUNK) {
    const chunkSymbols = rangeSet.slice(i, i + CANDLE_CHUNK).map(c => c.symbol);
    try {
      const result = await kiteOrderService.getIntradayMultiCandles(chunkSymbols, [
        { interval: '15minute', count: 2 },
      ]);
      Object.assign(allCandles, result['15minute'] || {});
    } catch (err) {
      console.error(`${LOG} [BREAKOUT] Candle chunk ${i}-${i + CANDLE_CHUNK} failed: ${err.message}`);
    }
  }
  console.log(`${LOG} [BREAKOUT] Candle data: ${Object.keys(allCandles).length}/${rangeSet.length} symbols returned`);

  // ── Evaluate 2-bar confirmation for each candidate ──
  // For LONG-confirm: bar1.close > OR_High AND bar2.close > OR_High
  // For SHORT-confirm: bar1.close < OR_Low  AND bar2.close < OR_Low
  // Whipsaw / mixed: skip
  const confirmed = [];
  let waitingBars = 0;
  let stillInsideOR = 0;
  let whipsaws = 0;

  for (const candidate of rangeSet) {
    const bars = allCandles[candidate.symbol] || [];
    if (bars.length < 2) { waitingBars++; continue; }

    const [b1, b2] = bars.slice(-2);
    const c1 = b1.close;
    const c2 = b2.close;

    const c1AboveOR = c1 > candidate.orHigh;
    const c1BelowOR = c1 < candidate.orLow;
    const c2AboveOR = c2 > candidate.orHigh;
    const c2BelowOR = c2 < candidate.orLow;

    if (c1AboveOR && c2AboveOR) {
      const distance    = c2 - candidate.orHigh;
      const distancePct = distance / candidate.orHigh * 100;
      const staleFlag   = distance > candidate.orRange * 2;
      confirmed.push({
        candidate, direction: 'LONG', bar1Close: c1, bar2Close: c2,
        distance, distancePct, staleFlag,
      });
    } else if (c1BelowOR && c2BelowOR) {
      const distance    = candidate.orLow - c2;
      const distancePct = distance / candidate.orLow * 100;
      const staleFlag   = distance > candidate.orRange * 2;
      confirmed.push({
        candidate, direction: 'SHORT', bar1Close: c1, bar2Close: c2,
        distance, distancePct, staleFlag,
      });
    } else if ((c1AboveOR && c2BelowOR) || (c1BelowOR && c2AboveOR)) {
      whipsaws++;
    } else {
      stillInsideOR++;
    }
  }

  console.log(`${LOG} [BREAKOUT] Scan summary: ${confirmed.length} 2-bar confirmed, ${stillInsideOR} inside OR, ${whipsaws} whipsaws (bar mismatch), ${waitingBars} missing bars`);

  if (!confirmed.length) {
    return { success: true, entered: 0 };
  }

  // Rank confirmed signals by distance% past OR (biggest move first)
  confirmed.sort((a, b) => b.distancePct - a.distancePct);

  // Mark actions: ENTER / SLOT_FULL / SKIP_STALE
  const slotsLeft = MAX_ENTRIES - enteredCount;
  let slotsConsumed = 0;
  confirmed.forEach(b => {
    if (b.staleFlag) {
      b._action = 'SKIP_STALE';
    } else if (slotsConsumed < slotsLeft) {
      b._action = 'ENTER';
      slotsConsumed++;
    } else {
      b._action = 'SLOT_FULL';
    }
  });

  console.log(`${LOG} [BREAKOUT] Ranked 2-bar confirmed breakouts:`);
  confirmed.forEach((b, idx) => {
    const dirTag     = b.direction === 'LONG' ? 'L' : 'S';
    const orRangePct = (b.candidate.orRange / b.candidate.iep * 100).toFixed(2);
    const actionTag  = {
      ENTER:      '✅ ENTERING',
      SLOT_FULL:  '⏸  slot full',
      SKIP_STALE: '⚠ STALE — skipped',
    }[b._action] || '?';
    console.log(
      `${LOG} [BREAKOUT]   #${String(idx + 1).padStart(2)} ${dirTag} ${b.candidate.symbol.padEnd(14)} ` +
      `OR=₹${b.candidate.orLow}–₹${b.candidate.orHigh} (${orRangePct}%)  ` +
      `bar1.close=₹${b.bar1Close} bar2.close=₹${b.bar2Close}  ` +
      `distance=₹${b.distance.toFixed(2)} (${b.distancePct.toFixed(2)}%)  → ${actionTag}`
    );
  });

  // We need CURRENT LTP for the entries (position sizing + entry price log).
  // Candle close was from up-to-15-min ago; LTP is now.
  const entryCandidates = confirmed.filter(b => b._action === 'ENTER');
  let currentLtps = {};
  if (entryCandidates.length) {
    try {
      const ltpQuery = entryCandidates.map(b => `NSE:${b.candidate.symbol}`);
      currentLtps = await kiteOrderService.getLTP(ltpQuery);
    } catch (err) {
      console.error(`${LOG} [BREAKOUT] LTP fetch for entries failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // Capital allocation
  let capitalPerTrade = MIN_CAPITAL_PER_TRADE;
  try {
    const balance = await kiteOrderService.getAvailableBalance();
    const orbBudget = balance.available * ORB_CAPITAL_PCT;
    const slotsForCap = MAX_ENTRIES - enteredCount;
    capitalPerTrade = Math.floor(orbBudget / Math.max(slotsForCap, 1));
    console.log(`${LOG} [BREAKOUT] Capital — available=₹${balance.available}  ORB budget (${ORB_CAPITAL_PCT*100}%)=₹${Math.round(orbBudget)}  per-trade=₹${capitalPerTrade}`);
    if (capitalPerTrade < MIN_CAPITAL_PER_TRADE) {
      console.warn(`${LOG} [BREAKOUT] ⚠ per-trade capital ₹${capitalPerTrade} < floor ₹${MIN_CAPITAL_PER_TRADE} — skipping entries`);
      return { skipped: true, reason: 'insufficient_capital', capitalPerTrade };
    }
  } catch (err) {
    console.error(`${LOG} [BREAKOUT] Balance fetch failed — using floor ₹${capitalPerTrade}: ${err.message}`);
  }

  // Execute entries
  let entered = 0;
  for (const b of confirmed) {
    if (b._action !== 'ENTER') continue;
    if (doc.candidates.filter(c => c.status === 'ENTERED').length >= MAX_ENTRIES) break;
    b.candidate.direction = b.direction;
    const liveLtp = currentLtps[`NSE:${b.candidate.symbol}`]?.last_price || b.bar2Close;
    await enterTrade(doc, b.candidate, liveLtp, capitalPerTrade);
    entered++;
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
      // Verify broker position before placing exit (2026-05-26 safety fix).
      const actualQty = await getActualPositionQty(c.symbol);
      if (actualQty === 0) {
        console.log(`${LOG} [MONITOR]   ⚠ ${c.symbol}: broker shows position=0 — skipping time-exit order (already closed externally)`);
        c.status     = 'TIME_EXIT';
        c.exitReason = 'already_closed_externally';
        c.exitTime   = new Date();
        exitedThisRun++;
        changed = true;
        continue;
      }
      if (actualQty !== null && (cIsLong ? actualQty <= 0 : actualQty >= 0)) {
        console.error(`${LOG} [MONITOR]   ⚠⚠ ${c.symbol}: broker qty=${actualQty} but direction=${cIsLong ? 'LONG' : 'SHORT'} — mismatch, skipping`);
        c.status     = 'TIME_EXIT';
        c.exitReason = `direction_mismatch_broker_qty_${actualQty}`;
        exitedThisRun++;
        changed = true;
        continue;
      }
      if (actualQty !== null) c.qty = Math.abs(actualQty);
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
          // 2026-05-26 safety: verify broker has the position before placing exit.
          const actualQty = await getActualPositionQty(c.symbol);
          if (actualQty === 0) {
            console.log(`${LOG} [CANDLE]   ⚠ ${c.symbol}: broker position=0 — skipping sideways exit (already closed externally)`);
            c.status = 'TIME_EXIT';
            c.exitReason = 'already_closed_externally';
            c.exitTime = new Date();
            changed = true;
            continue;
          }
          if (actualQty !== null && (cIsLong ? actualQty <= 0 : actualQty >= 0)) {
            console.error(`${LOG} [CANDLE]   ⚠⚠ ${c.symbol}: broker qty=${actualQty} but direction=${cDirTag} — mismatch, skipping`);
            c.status = 'TIME_EXIT';
            c.exitReason = `direction_mismatch_broker_qty_${actualQty}`;
            changed = true;
            continue;
          }
          if (actualQty !== null) c.qty = Math.abs(actualQty);
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
        // 2026-05-26 safety: verify broker has the position before placing exit.
        const actualQty = await getActualPositionQty(c.symbol);
        if (actualQty === 0) {
          console.log(`${LOG} [CANDLE]   ⚠ ${c.symbol}: broker position=0 — skipping candle exit (already closed externally)`);
          c.status = 'TIME_EXIT';
          c.exitReason = 'already_closed_externally';
          c.exitTime = new Date();
          changed = true;
          continue;
        }
        if (actualQty !== null && (cIsLong ? actualQty <= 0 : actualQty >= 0)) {
          console.error(`${LOG} [CANDLE]   ⚠⚠ ${c.symbol}: broker qty=${actualQty} but direction=${cDirTag} — mismatch, skipping`);
          c.status = 'TIME_EXIT';
          c.exitReason = `direction_mismatch_broker_qty_${actualQty}`;
          changed = true;
          continue;
        }
        if (actualQty !== null) c.qty = Math.abs(actualQty);
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

    // ── CRITICAL: verify broker position before firing exit (2026-05-26 fix) ──
    // If user manually closed the position in Kite during the day, the system's
    // exit MARKET order would OPEN a fresh position in the opposite direction.
    // (Observed CONCOR on 05-26: user manual exit at 13:58, system force-exit
    // at 15:15 opened accidental LONG that auto-square closed at 15:25.)
    const actualQty = await getActualPositionQty(c.symbol);
    if (actualQty === 0) {
      console.log(`${LOG} [FORCE-EXIT]   ⚠ ${c.symbol}: broker shows position=0 — skipping exit order (already closed externally)`);
      c.status     = 'TIME_EXIT';
      c.exitPrice  = c.entryPrice;  // unknown actual exit — preserve entry, note in reason
      c.exitTime   = new Date();
      c.exitReason = 'already_closed_externally';
      c.pnl        = 0;             // unknown — would need to fetch trade history
      c.returnPct  = 0;
      console.log(`${LOG} [FORCE-EXIT]   ${c.symbol}: marked TIME_EXIT (manual close detected, no system action)`);
      exited++;
      continue;
    }
    if (actualQty !== null) {
      // Direction-aware sanity check: SHORT must have qty < 0, LONG must have qty > 0
      const directionMatch = cIsLong ? (actualQty > 0) : (actualQty < 0);
      if (!directionMatch) {
        console.error(`${LOG} [FORCE-EXIT]   ⚠⚠ ${c.symbol}: broker qty=${actualQty} but direction=${cDirTag} — DIRECTION MISMATCH, skipping to avoid opening fresh position`);
        c.status     = 'TIME_EXIT';
        c.exitReason = `direction_mismatch_broker_qty_${actualQty}`;
        exited++;
        continue;
      }
      // Use the ACTUAL open qty, not the candidate's recorded qty (in case of partial close)
      const exitQty = Math.abs(actualQty);
      if (exitQty !== c.qty) {
        console.warn(`${LOG} [FORCE-EXIT]   ${c.symbol}: candidate qty=${c.qty} but broker qty=${exitQty} — using broker qty`);
      }
      c.qty = exitQty;
    }
    // actualQty === null means getPositions failed; fall through to place exit
    // anyway (preserving original behavior, but log a warning).
    if (actualQty === null) {
      console.warn(`${LOG} [FORCE-EXIT]   ⚠ ${c.symbol}: position check failed — proceeding with system-recorded qty=${c.qty}`);
    }

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
