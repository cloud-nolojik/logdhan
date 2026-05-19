/**
 * ORB Service — Opening Range Breakout (intraday)
 *
 * Flow:
 *   09:08 AM  fetchPreOpenUniverse()  — NSE pre-open IEP top gainers → candidates
 *   09:30 AM  recordOpeningRanges()   — Kite historical 15-min candle → OR High / Low
 *   every 1m  checkBreakouts()        — LTP > OR High → enter (max 3, window closes 10:30)
 *   every 5m  monitorOrbPositions()   — poll stop/target order status
 *   15:15     forceExitOrb()          — MARKET exit all remaining ENTERED positions
 *
 * Completely independent of dailyPicksService — shares only kiteOrderService.
 */

import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import kiteOrderService from '../kiteOrder.service.js';
import OrbTrade from '../../models/orbTrade.js';
import MarketHoursUtil from '../../utils/marketHours.js';

const LOG = '[ORB]';

// ── Strategy constants ──────────────────────────────────────────────────────
const MAX_ENTRIES          = 3;       // max positions per day
const MAX_CANDIDATES       = 15;      // top N from pre-open list
const MIN_PRE_OPEN_PCT     = 1.5;     // min gap % to watch
const MAX_PRE_OPEN_PCT     = 8.0;     // max gap % (exhausted move)
const ORB_CAPITAL_PCT      = 0.90;    // use at most 90% of whatever is available at entry time
const MIN_CAPITAL_PER_TRADE = 5000;  // skip entry if budget too thin (e.g. daily picks consumed most)
const TARGET_RANGE_MULT    = 1.5;     // target = OR High + 1.5 × OR Range
const BREAKOUT_END_HOUR    = 11;
const BREAKOUT_END_MIN     = 0;       // no new entries after 11:00 AM
const MAX_OR_RANGE_PCT     = 2.5;     // reject candidates where OR range > 2.5% of IEP (unreachable target)
const TIME_EXIT_HOUR       = 10;
const TIME_EXIT_MIN        = 30;      // exit stalled positions at 10:30 AM

// ── Tick snap helpers (mirrors dailyPicksService) ──────────────────────────
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

// ── NSE pre-open session client ────────────────────────────────────────────
function createNseClient() {
  const jar = new CookieJar();
  return wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 15000,
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':          '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Referer':         'https://www.nseindia.com/',
      'Connection':      'keep-alive',
    },
  }));
}

async function fetchNsePreOpenRaw() {
  const client = createNseClient();
  // Step 1: establish session + get cookies
  const homeResp = await client.get('https://www.nseindia.com', { timeout: 15000 });
  console.log(`${LOG} NSE homepage GET: status=${homeResp.status}`);
  await delay(1200);
  // Step 2: fetch actual pre-open data
  const resp = await client.get(
    'https://www.nseindia.com/api/market-data-pre-open?key=FO',
    { headers: { 'Accept': 'application/json, text/plain, */*' } }
  );
  const list = resp.data?.data || [];
  console.log(`${LOG} NSE pre-open API: status=${resp.status} records=${list.length}`);
  return resp.data;
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 1 — Pre-open universe (9:08 AM)
// ══════════════════════════════════════════════════════════════════════════

export async function fetchPreOpenUniverse() {
  console.log(`${LOG} ═══ Phase 1: NSE pre-open universe ═══`);

  let raw;
  try {
    raw = await fetchNsePreOpenRaw();
  } catch (err) {
    console.error(`${LOG} NSE pre-open fetch failed:`, err.message);
    return { success: false, error: err.message };
  }

  // NSE response: { data: [{ metadata: { symbol, iep, previousClose, pChange, ... } }] }
  const list = raw?.data || [];
  console.log(`${LOG} Raw pre-open records: ${list.length}`);

  const candidates = list
    .map(item => {
      const m = item?.metadata || item;
      return {
        symbol:     String(m.symbol || '').toUpperCase().trim(),
        iep:        parseFloat(m.iep        || m.lastPrice     || 0),
        prevClose:  parseFloat(m.previousClose               || 0),
        preOpenPct: parseFloat(m.pChange    || m.perChange    || 0),
        status:     'WATCHING',
      };
    })
    .filter(c =>
      c.symbol                            &&
      c.preOpenPct >= MIN_PRE_OPEN_PCT    &&
      c.preOpenPct <= MAX_PRE_OPEN_PCT
    )
    .sort((a, b) => b.preOpenPct - a.preOpenPct)
    .slice(0, MAX_CANDIDATES);

  console.log(`${LOG} Filtered candidates (${candidates.length}):`);
  candidates.forEach(c =>
    console.log(`${LOG}   ${c.symbol.padEnd(14)} IEP=₹${c.iep} prev=₹${c.prevClose} gap=+${c.preOpenPct.toFixed(2)}%`)
  );

  // Upsert today's ORB document
  const now      = new Date();
  const istOff   = 5.5 * 60 * 60 * 1000;
  const istNow   = new Date(now.getTime() + istOff);
  const startIST = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());
  const utcDate  = new Date(startIST.getTime() - istOff);

  await OrbTrade.findOneAndUpdate(
    { date: { $gte: utcDate, $lt: new Date(utcDate.getTime() + 86400000) } },
    { $set: { date: utcDate, candidates } },
    { upsert: true, new: true }
  );

  return { success: true, count: candidates.length };
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 2 — Record opening range (9:30 AM)
// ══════════════════════════════════════════════════════════════════════════

export async function recordOpeningRanges() {
  console.log(`${LOG} ═══ Phase 2: Record opening ranges ═══`);

  const doc = await OrbTrade.findToday();
  if (!doc) {
    console.log(`${LOG} No ORB doc today — skipping range recording`);
    return { success: false, reason: 'no_doc' };
  }

  const watching = doc.candidates.filter(c => c.status === 'WATCHING');
  if (!watching.length) {
    console.log(`${LOG} No WATCHING candidates`);
    return { success: true, rangesSet: 0 };
  }

  const symbols = watching.map(c => c.symbol);
  console.log(`${LOG} Fetching first 15-min candle for: ${symbols.join(', ')}`);

  let multiCandles;
  try {
    multiCandles = await kiteOrderService.getIntradayMultiCandles(symbols, [
      { interval: '15minute', count: 1 },
    ]);
  } catch (err) {
    console.error(`${LOG} Kite candle fetch failed:`, err.message);
    return { success: false, error: err.message };
  }

  const candles15m = multiCandles['15minute'] || {};
  let rangesSet = 0;

  for (const candidate of doc.candidates) {
    if (candidate.status !== 'WATCHING') continue;

    const bars = candles15m[candidate.symbol] || [];
    if (!bars.length) {
      console.warn(`${LOG} ${candidate.symbol}: no 15-min bar yet — leaving as WATCHING`);
      continue;
    }

    const bar      = bars[0];
    const orRange  = parseFloat((bar.high - bar.low).toFixed(2));
    const rangePct = candidate.iep > 0 ? (orRange / candidate.iep) * 100 : 99;

    if (rangePct > MAX_OR_RANGE_PCT) {
      candidate.status = 'SKIPPED';
      console.log(
        `${LOG} ${candidate.symbol.padEnd(14)} ` +
        `OR range ₹${orRange} = ${rangePct.toFixed(1)}% of IEP — too wide, skipping`
      );
      continue;
    }

    candidate.orHigh  = bar.high;
    candidate.orLow   = bar.low;
    candidate.orRange = orRange;
    candidate.status  = 'RANGE_SET';
    rangesSet++;

    console.log(
      `${LOG} ${candidate.symbol.padEnd(14)} ` +
      `OR High=₹${bar.high}  Low=₹${bar.low}  Range=₹${orRange} (${rangePct.toFixed(1)}%)  ` +
      `(gap was +${candidate.preOpenPct.toFixed(2)}%)`
    );
  }

  await doc.save();
  console.log(`${LOG} Ranges set for ${rangesSet}/${watching.length} candidates`);
  return { success: true, rangesSet };
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 3 — Check breakouts + enter (every 1 min, 9:30–10:30 AM)
// ══════════════════════════════════════════════════════════════════════════

export async function checkBreakouts() {
  const ist    = MarketHoursUtil.toIST(new Date());
  const istMin = ist.getHours() * 60 + ist.getMinutes();

  // Only run inside the breakout window (9:30–10:30 AM)
  if (istMin < 9 * 60 + 30 || istMin > BREAKOUT_END_HOUR * 60 + BREAKOUT_END_MIN) {
    return { skipped: true, reason: 'outside_window' };
  }

  const doc = await OrbTrade.findToday();
  if (!doc) return { skipped: true, reason: 'no_doc' };

  const enteredCount = doc.candidates.filter(c => c.status === 'ENTERED').length;
  if (enteredCount >= MAX_ENTRIES) {
    console.log(`${LOG} [BREAKOUT] Max ${MAX_ENTRIES} entries reached`);
    return { skipped: true, reason: 'max_entries' };
  }

  const rangeSet = doc.candidates.filter(c => c.status === 'RANGE_SET');
  if (!rangeSet.length) return { skipped: true, reason: 'no_range_set' };

  // Fetch LTP for all candidates in one call
  const symbols = rangeSet.map(c => `NSE:${c.symbol}`);
  let ltpData;
  try {
    ltpData = await kiteOrderService.getLTP(symbols);
  } catch (err) {
    console.error(`${LOG} [BREAKOUT] LTP fetch failed:`, err.message);
    return { success: false, error: err.message };
  }

  // Compute per-trade capital dynamically:
  //   equity.net at this point already reflects what daily picks consumed at 9:08.
  //   ORB takes 90% of what's left, split equally across remaining entry slots.
  let capitalPerTrade = MIN_CAPITAL_PER_TRADE; // fallback floor
  try {
    const balance    = await kiteOrderService.getAvailableBalance();
    const orbBudget  = balance.available * ORB_CAPITAL_PCT;
    const slotsLeft  = MAX_ENTRIES - enteredCount;
    capitalPerTrade  = Math.floor(orbBudget / Math.max(slotsLeft, 1));
    console.log(
      `${LOG} [BREAKOUT] Balance: net=₹${balance.available}  ` +
      `ORB budget (90%)=₹${Math.round(orbBudget)}  ` +
      `slots left=${slotsLeft}  per-trade=₹${capitalPerTrade}`
    );
    if (capitalPerTrade < MIN_CAPITAL_PER_TRADE) {
      console.warn(`${LOG} [BREAKOUT] Per-trade capital ₹${capitalPerTrade} below floor ₹${MIN_CAPITAL_PER_TRADE} — skipping entries`);
      return { skipped: true, reason: 'insufficient_capital', capitalPerTrade };
    }
  } catch (err) {
    console.error(`${LOG} [BREAKOUT] Balance fetch failed — using floor ₹${capitalPerTrade}:`, err.message);
  }

  let entered = 0;
  for (const candidate of rangeSet) {
    if (doc.candidates.filter(c => c.status === 'ENTERED').length >= MAX_ENTRIES) break;

    const ltp = ltpData[`NSE:${candidate.symbol}`]?.last_price;
    if (!ltp) continue;

    const aboveOR = ltp > candidate.orHigh;
    console.log(
      `${LOG} [BREAKOUT] ${candidate.symbol.padEnd(14)} ` +
      `LTP=₹${ltp}  OR_High=₹${candidate.orHigh}  ${aboveOR ? '✅ BREAKOUT' : '⬜ below'}`
    );

    if (aboveOR) {
      await enterTrade(doc, candidate, ltp, capitalPerTrade);
      entered++;
    }
  }

  if (entered > 0 || doc.isModified()) await doc.save();
  return { success: true, entered };
}

// ── Enter a breakout trade ─────────────────────────────────────────────────
async function enterTrade(doc, candidate, ltp, capitalPerTrade) {
  const qty    = Math.max(1, Math.floor(capitalPerTrade / ltp));
  const target = snapToNSETick(candidate.orHigh + TARGET_RANGE_MULT * candidate.orRange, 0.05, 'ceil');
  let   stop   = snapToNSETick(candidate.orLow, 0.05, 'floor');

  console.log(`${LOG} [ENTER] ${candidate.symbol}: qty=${qty} LTP≈₹${ltp} stop=₹${stop} target=₹${target}`);

  // ── Step 1: Market entry ─────────────────────────────────────────────────
  let entryOrderId, entryPrice;
  try {
    const res = await kiteOrderService.placeOrder({
      tradingsymbol:    candidate.symbol,
      exchange:         'NSE',
      transaction_type: 'BUY',
      order_type:       'MARKET',
      product:          'MIS',
      quantity:         qty,
      simulationId:     `orb_entry_${candidate.symbol}`,
      orderType:        'ORB_ENTRY',
      source:           'ORB',
    });
    if (!res.success) throw new Error('placeOrder returned not-success');
    entryOrderId = res.orderId;
    console.log(`${LOG} [ENTER] ${candidate.symbol}: entry order placed — orderId=${entryOrderId}`);
  } catch (err) {
    console.error(`${LOG} [ENTER] ${candidate.symbol}: entry FAILED:`, err.message);
    candidate.status = 'SKIPPED';
    return;
  }

  // Wait for fill then read average price
  await delay(2000);
  try {
    const ord = await kiteOrderService.getOrderDetails(entryOrderId);
    entryPrice = ord?.average_price || ltp;
  } catch (_) { entryPrice = ltp; }

  candidate.entryOrderId = entryOrderId;
  candidate.entryPrice   = entryPrice;
  candidate.qty          = qty;
  candidate.stopPrice    = stop;
  candidate.targetPrice  = target;
  candidate.entryTime    = new Date();
  candidate.status       = 'ENTERED';
  doc.entriesCount       = (doc.entriesCount || 0) + 1;

  // ── Step 2: SL-M — retry with correct tick on rejection ─────────────────
  let slOrderId;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const slRes = await kiteOrderService.placeOrder({
        tradingsymbol:    candidate.symbol,
        exchange:         'NSE',
        transaction_type: 'SELL',
        order_type:       'SL-M',
        trigger_price:    stop,
        product:          'MIS',
        quantity:         qty,
        simulationId:     `orb_sl_${candidate.symbol}`,
        orderType:        'ORB_STOP',
        source:           'ORB',
      });
      if (slRes.success) { slOrderId = slRes.orderId; break; }
    } catch (err) {
      const tick = parseKiteTickError(err.message);
      if (tick && attempt === 1) {
        stop = snapToNSETick(candidate.orLow, tick, 'floor');
        candidate.stopPrice = stop;
        console.log(`${LOG} [ENTER] ${candidate.symbol}: tick=${tick} → re-snapped stop=₹${stop}`);
      } else {
        console.error(`${LOG} [ENTER] ${candidate.symbol}: SL-M attempt ${attempt} failed:`, err.message);
      }
    }
  }
  candidate.stopOrderId = slOrderId;

  // ── SL failure safety — if both attempts failed, exit the position immediately ──
  if (!slOrderId) {
    console.error(`${LOG} [ENTER] ${candidate.symbol}: SL-M failed after 2 attempts — emergency market exit`);
    try {
      await kiteOrderService.placeOrder({
        tradingsymbol:    candidate.symbol,
        exchange:         'NSE',
        transaction_type: 'SELL',
        order_type:       'MARKET',
        product:          'MIS',
        quantity:         qty,
        simulationId:     `orb_emergency_exit_${candidate.symbol}`,
        orderType:        'ORB_EMERGENCY_EXIT',
        source:           'ORB',
      });
    } catch (exitErr) {
      console.error(`${LOG} [ENTER] ${candidate.symbol}: emergency exit also failed — MANUAL ACTION REQUIRED:`, exitErr.message);
    }
    candidate.status = 'SKIPPED';
    candidate.exitReason = 'sl_placement_failed';
    doc.entriesCount = Math.max(0, (doc.entriesCount || 1) - 1);
    return;
  }

  // ── Step 3: LIMIT target ─────────────────────────────────────────────────
  let tgtOrderId;
  try {
    const tgtRes = await kiteOrderService.placeOrder({
      tradingsymbol:    candidate.symbol,
      exchange:         'NSE',
      transaction_type: 'SELL',
      order_type:       'LIMIT',
      price:            target,
      product:          'MIS',
      quantity:         qty,
      simulationId:     `orb_tgt_${candidate.symbol}`,
      orderType:        'ORB_TARGET',
      source:           'ORB',
    });
    if (tgtRes.success) tgtOrderId = tgtRes.orderId;
  } catch (err) {
    const tick = parseKiteTickError(err.message);
    if (tick) {
      const snappedTgt = snapToNSETick(target, tick, 'ceil');
      try {
        const r2 = await kiteOrderService.placeOrder({
          tradingsymbol: candidate.symbol, exchange: 'NSE',
          transaction_type: 'SELL', order_type: 'LIMIT',
          price: snappedTgt, product: 'MIS', quantity: qty,
          simulationId: `orb_tgt_${candidate.symbol}`,
          orderType: 'ORB_TARGET', source: 'ORB',
        });
        if (r2.success) { tgtOrderId = r2.orderId; candidate.targetPrice = snappedTgt; }
      } catch (_) {}
    }
    console.error(`${LOG} [ENTER] ${candidate.symbol}: target error:`, err.message);
  }
  candidate.targetOrderId = tgtOrderId;

  console.log(
    `${LOG} [ENTER] ✅ ${candidate.symbol} LIVE — ` +
    `entry=₹${entryPrice}  stop=₹${stop}  target=₹${target}  ` +
    `SL=${slOrderId || 'FAILED'}  TGT=${tgtOrderId || 'FAILED'}`
  );
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 4 — Monitor positions (every 5 min)
// ══════════════════════════════════════════════════════════════════════════

export async function monitorOrbPositions() {
  const doc = await OrbTrade.findToday();
  if (!doc) return;

  const entered = doc.candidates.filter(c => c.status === 'ENTERED');
  if (!entered.length) return;

  const ist    = MarketHoursUtil.toIST(new Date());
  const istMin = ist.getHours() * 60 + ist.getMinutes();
  const pastTimeExit = istMin >= TIME_EXIT_HOUR * 60 + TIME_EXIT_MIN;

  console.log(`${LOG} [MONITOR] ${entered.length} open ORB position(s)${pastTimeExit ? ' — past 10:30, time-exit mode' : ''}`);

  // Fetch LTP for all open positions in one call (needed for breakeven trailing)
  const ltpSymbols = entered.map(c => `NSE:${c.symbol}`);
  let ltpData = {};
  try {
    ltpData = await kiteOrderService.getLTP(ltpSymbols);
  } catch (_) {}

  let changed = false;

  for (const c of entered) {
    // ── 10:30 time-exit — stalled breakout, cut the position ────────────────
    if (pastTimeExit) {
      if (c.stopOrderId)   { try { await kiteOrderService.cancelOrder(c.stopOrderId);   } catch (_) {} }
      if (c.targetOrderId) { try { await kiteOrderService.cancelOrder(c.targetOrderId); } catch (_) {} }
      await delay(500);
      try {
        const res = await kiteOrderService.placeOrder({
          tradingsymbol:    c.symbol,
          exchange:         'NSE',
          transaction_type: 'SELL',
          order_type:       'MARKET',
          product:          'MIS',
          quantity:         c.qty,
          simulationId:     `orb_time_exit_${c.symbol}`,
          orderType:        'ORB_TIME_EXIT',
          source:           'ORB',
        });
        if (res.success) {
          await delay(2000);
          let exitPrice = c.entryPrice;
          try {
            const ord = await kiteOrderService.getOrderDetails(res.orderId);
            if (ord?.average_price) exitPrice = ord.average_price;
          } catch (_) {}
          c.status     = 'TIME_EXIT';
          c.exitPrice  = exitPrice;
          c.exitTime   = new Date();
          c.exitReason = 'time_exit_10:30am';
          c.pnl        = parseFloat(((exitPrice - c.entryPrice) * c.qty).toFixed(2));
          c.returnPct  = parseFloat(((exitPrice - c.entryPrice) / c.entryPrice * 100).toFixed(2));
          console.log(`${LOG} [MONITOR] ${c.symbol}: TIME EXIT (10:30) @ ₹${exitPrice}  PnL=₹${c.pnl}`);
          changed = true;
        }
      } catch (err) {
        console.error(`${LOG} [MONITOR] ${c.symbol}: time-exit order failed:`, err.message);
      }
      continue;
    }

    // ── Check if stop order filled ───────────────────────────────────────────
    if (c.stopOrderId) {
      try {
        const ord = await kiteOrderService.getOrderDetails(c.stopOrderId);
        if (ord?.status === 'COMPLETE') {
          c.status     = 'STOPPED_OUT';
          c.exitPrice  = ord.average_price;
          c.exitTime   = new Date();
          c.exitReason = 'stop_hit';
          c.pnl        = parseFloat(((c.exitPrice - c.entryPrice) * c.qty).toFixed(2));
          c.returnPct  = parseFloat(((c.exitPrice - c.entryPrice) / c.entryPrice * 100).toFixed(2));
          if (c.targetOrderId) { try { await kiteOrderService.cancelOrder(c.targetOrderId); } catch (_) {} }
          console.log(`${LOG} [MONITOR] ${c.symbol}: STOPPED OUT @ ₹${c.exitPrice}  PnL=₹${c.pnl}`);
          changed = true;
          continue;
        }
      } catch (_) {}
    }

    // ── Check if target order filled ─────────────────────────────────────────
    if (c.targetOrderId) {
      try {
        const ord = await kiteOrderService.getOrderDetails(c.targetOrderId);
        if (ord?.status === 'COMPLETE') {
          c.status     = 'TARGET_HIT';
          c.exitPrice  = ord.average_price;
          c.exitTime   = new Date();
          c.exitReason = 'target_hit';
          c.pnl        = parseFloat(((c.exitPrice - c.entryPrice) * c.qty).toFixed(2));
          c.returnPct  = parseFloat(((c.exitPrice - c.entryPrice) / c.entryPrice * 100).toFixed(2));
          if (c.stopOrderId) { try { await kiteOrderService.cancelOrder(c.stopOrderId); } catch (_) {} }
          console.log(`${LOG} [MONITOR] ${c.symbol}: TARGET HIT @ ₹${c.exitPrice}  PnL=₹${c.pnl}`);
          changed = true;
          continue;
        }
      } catch (_) {}
    }

    // ── Breakeven trail — move stop to entry once 1R in profit ───────────────
    if (c.status === 'ENTERED' && c.stopOrderId && !c._beTrailed) {
      const ltp   = ltpData[`NSE:${c.symbol}`]?.last_price;
      const risk  = c.entryPrice - c.stopPrice;
      if (ltp && risk > 0 && (ltp - c.entryPrice) >= risk) {
        const beStop      = snapToNSETick(c.entryPrice, 0.05, 'floor');
        const beStopLimit = snapToNSETick(c.entryPrice - 5, 0.05, 'ceil');
        try {
          await kiteOrderService.modifyOrder(c.stopOrderId, {
            trigger_price: beStop,
            price:         beStopLimit,
          });
          c.stopPrice  = beStop;
          c._beTrailed = true;
          console.log(`${LOG} [MONITOR] ${c.symbol}: breakeven trail → stop moved to ₹${beStop} (LTP=₹${ltp}, 1R achieved)`);
          changed = true;
        } catch (err) {
          console.error(`${LOG} [MONITOR] ${c.symbol}: breakeven trail failed:`, err.message);
        }
      }
    }

    if (c.status === 'ENTERED') {
      const ltp = ltpData[`NSE:${c.symbol}`]?.last_price;
      console.log(
        `${LOG} [MONITOR] ${c.symbol}: still open  ` +
        `entry=₹${c.entryPrice}  stop=₹${c.stopPrice}  target=₹${c.targetPrice}` +
        (ltp ? `  LTP=₹${ltp}` : '')
      );
    }
  }

  if (changed) {
    doc.totalPnl = parseFloat(
      doc.candidates.reduce((s, c) => s + (c.pnl || 0), 0).toFixed(2)
    );
    await doc.save();
  }
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 5 — Force exit at 3:15 PM
// ══════════════════════════════════════════════════════════════════════════

export async function forceExitOrb() {
  console.log(`${LOG} ═══ Phase 5: Force exit all ORB positions ═══`);

  const doc = await OrbTrade.findToday();
  if (!doc) { console.log(`${LOG} No ORB doc today`); return; }

  const entered = doc.candidates.filter(c => c.status === 'ENTERED');
  if (!entered.length) {
    console.log(`${LOG} No open ORB positions — nothing to exit`);
    return;
  }

  for (const c of entered) {
    // Cancel protective orders first
    if (c.stopOrderId)   { try { await kiteOrderService.cancelOrder(c.stopOrderId);   } catch (_) {} }
    if (c.targetOrderId) { try { await kiteOrderService.cancelOrder(c.targetOrderId); } catch (_) {} }
    await delay(500);

    try {
      const res = await kiteOrderService.placeOrder({
        tradingsymbol:    c.symbol,
        exchange:         'NSE',
        transaction_type: 'SELL',
        order_type:       'MARKET',
        product:          'MIS',
        quantity:         c.qty,
        simulationId:     `orb_exit_${c.symbol}`,
        orderType:        'ORB_TIME_EXIT',
        source:           'ORB',
      });

      if (res.success) {
        await delay(2000);
        let exitPrice = c.entryPrice;
        try {
          const ord = await kiteOrderService.getOrderDetails(res.orderId);
          if (ord?.average_price) exitPrice = ord.average_price;
        } catch (_) {}

        c.status    = 'TIME_EXIT';
        c.exitPrice = exitPrice;
        c.exitTime  = new Date();
        c.exitReason = 'time_exit_3:15pm';
        c.pnl        = parseFloat(((exitPrice - c.entryPrice) * c.qty).toFixed(2));
        c.returnPct  = parseFloat(((exitPrice - c.entryPrice) / c.entryPrice * 100).toFixed(2));
        console.log(`${LOG} ✅ ${c.symbol}: force-exited @ ₹${exitPrice}  PnL=₹${c.pnl}`);
      }
    } catch (err) {
      console.error(`${LOG} ${c.symbol}: force exit failed:`, err.message);
    }
  }

  doc.totalPnl = parseFloat(
    doc.candidates.reduce((s, c) => s + (c.pnl || 0), 0).toFixed(2)
  );
  await doc.save();

  console.log(`${LOG} ═══ ORB day complete ═══`);
  console.log(`${LOG} Total PnL today: ₹${doc.totalPnl}`);
  const completed = doc.candidates.filter(c => ['STOPPED_OUT','TARGET_HIT','TIME_EXIT'].includes(c.status));
  completed.forEach(c =>
    console.log(`${LOG}   ${c.symbol.padEnd(14)} ${c.status.padEnd(12)} ₹${c.pnl >= 0 ? '+' : ''}${c.pnl}`)
  );
}
