#!/usr/bin/env node
/**
 * BACKTEST — current paper-spec ORB (Zarattini/Barbon/Aziz "stocks in play").
 *
 * Replays archived 1-min candles (backtest_candles) through the SAME strategy
 * functions the live system uses — no reimplemented strategy logic, no Kite
 * orders. Only the fill/exit simulation is custom (you can't call the live
 * broker for history).
 *
 * Reused live functions (single source of truth):
 *   • computeRvol5   — 09:21 relative-volume metric (incl. the 0.55 fraction)
 *   • selectInPlay   — top-N in-play selection + fallback
 *   • computeATR     — daily ATR(14) (only used for the ATR floor now)
 *   • slotKey        — 'HH:MM' bucket from a candle timestamp
 *   • buildPaperSetup— direction / entry trigger / OR-edge stop / 1% sizing
 *   • PAPER_MAX_ENTRIES, PAPER_RISK_PCT — live constants
 *
 * Per day, per symbol with data:
 *   1. OR = the 09:15 five-min candle (aggregated from 1-min bars 09:15–09:19).
 *   2. rvol5 at ~09:21 = sum(vol 09:15–09:20) ÷ (avg 15-min 09:15 vol over prior
 *      archived days × 0.55) — fed to computeRvol5.
 *   3. selectInPlay → top in-play; take the top PAPER_MAX_ENTRIES by rvol5.
 *   4. buildPaperSetup → trigger (OR edge), stop (opposite OR edge), qty.
 *   5. Simulate: resting entry fills when price crosses the trigger (09:24–15:00);
 *      then exit at the OR-edge stop if hit, else at the 15:15 close.
 *   6. PnL net of costs + stop slippage; report R-multiples, hit rate, totals.
 *
 * Sizing mirrors the live capital preflight approximately: slotCap =
 * (cash × 5 × 0.90) ÷ 8, riskBudget = cash × 1%. (Live pulls real margins; here
 * it's derived from --capital.) No intraday compounding — sizes off the starting
 * capital each day; over a short window the difference is negligible.
 *
 * ASSUMPTIONS (flagged so results aren't over-read):
 *   • Entry/stop fills AT the level (no entry slippage; stop slippage = --slip ticks).
 *   • ATR(14) uses daily bars resampled from the archive, so it's thin until ~14
 *     archived days exist — but ATR now only feeds the ₹0.50 floor, so impact ≈ 0.
 *   • The first archived day has no baseline → no trades that day (correct).
 *
 * Usage:
 *   node src/scripts/backtestOrbPaper.js                     # all archived data
 *   node src/scripts/backtestOrbPaper.js --from 2026-06-03 --to 2026-06-13
 *   node src/scripts/backtestOrbPaper.js --capital 200000 --cost 0.0011 --slip 1
 *   node src/scripts/backtestOrbPaper.js --verbose          # per-trade detail
 *
 * READ ONLY — never writes to the DB.
 */

import '../loadEnv.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import BacktestCandle from '../models/backtestCandle.js';
import OrbTrade from '../models/orbTrade.js';
import Stock from '../models/stock.js';
import {
  computeRvol5, selectInPlay, computeATR, slotKey, buildPaperSetup,
  PAPER_MAX_ENTRIES, PAPER_RISK_PCT,
} from '../services/orb/orbService.js';

// ── args ────────────────────────────────────────────────────────────────────
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(`--${k}`);
const FROM = arg('from', null);
const TO = arg('to', null);
const CAPITAL = Number(arg('capital', 100000));
// Default 0 — the backtest is a PURE replay of the live strategy (fill at trigger,
// exit at stop or 15:15 close, PnL = (exit−entry)×qty), with nothing of its own.
// Real brokerage/slippage can be layered on optionally with --cost / --slip.
const COST_RT = Number(arg('cost', 0));        // round-trip cost as fraction of notional (off by default)
const SLIP_TICKS = Number(arg('slip', 0));     // adverse ticks on a stop-market exit (off by default)
const ENTRY_SLIP = Number(arg('entryslip', 0)); // breakout entry slippage as fraction of price (e.g. 0.0003 = 3bps)
const TOP_N = Math.min(Number(arg('top', PAPER_MAX_ENTRIES)), PAPER_MAX_ENTRIES); // trade only the top-N picks by rvol5/day (default 8)
const VERBOSE = has('verbose');
const NO_XLSX = has('no-xlsx');
const OUT = arg('out', null);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');   // backend/src/scripts → repo root (logdhan)

const BASELINE_FRACTION_NOTE = 0.55;           // (informational; computeRvol5 applies it internally)
const toMin = (slot) => { const [h, m] = slot.split(':').map(Number); return h * 60 + m; };
const mapBar = (b) => ({ date: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });

// Plain-language outcome for each trade.
function labelReason(reason) {
  switch (reason) {
    case 'stop':         return 'exited at stoploss';
    case 'time':         return 'exited at 15:15';
    case 'no_fill':      return 'no fill (never triggered)';
    case 'no_candles':   return 'no candle data';
    case 'no_or_levels': return 'no OR levels recorded';
    default:             return reason ? `skipped (${reason})` : '';
  }
}

// per-symbol tick size (cached) — same source the live getNseTickSize uses
const _tick = new Map();
async function tickOf(sym) {
  const k = sym.toUpperCase();
  if (_tick.has(k)) return _tick.get(k);
  let t = 0.05;
  try {
    const s = await Stock.findOne({ trading_symbol: k, segment: 'NSE_EQ' }).select('tick_size').lean();
    const v = Number(s?.tick_size);
    // accept only a sane NSE tick (≤ ₹1); corrupt data (e.g. ₹10/₹100) would
    // inflate the stop-slippage line — fall back to ₹0.05
    if (Number.isFinite(v) && v > 0 && v <= 1) t = v;
  } catch { /* default */ }
  _tick.set(k, t);
  return t;
}

// Aggregate 1-min bars whose slot is within [fromSlot,toSlot] into one OHLCV bar.
function aggregate(bars, fromSlot, toSlot) {
  const lo = toMin(fromSlot), hi = toMin(toSlot);
  const win = bars.filter(b => { const s = slotKey(b.date); if (!s) return false; const m = toMin(s); return m >= lo && m <= hi; });
  if (!win.length) return null;
  return {
    open: win[0].open,
    close: win[win.length - 1].close,
    high: Math.max(...win.map(b => b.high)),
    low: Math.min(...win.map(b => b.low)),
    volume: win.reduce((s, b) => s + (b.volume || 0), 0),
  };
}

// A candidate counts as "selected that day" if the live system committed an entry
// order for it (armed / entered / exited) — i.e. the basket it actually traded.
const SELECTED_STATUS = new Set(['ARMED', 'ENTERED', 'STOPPED_OUT', 'TARGET_HIT', 'TIME_EXIT']);

// Load the live orb_trades doc for an IST trading day (the recorded selection).
async function loadOrbDoc(dateStr) {
  const start = new Date(`${dateStr}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 86400000);
  return OrbTrade.findOne({ date: { $gte: start, $lt: end } }).lean();
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error('[backtest] MONGODB_URI not set'); process.exit(1); }
  await mongoose.connect(uri);

  // capital model (mirrors the live preflight shape)
  const cash = CAPITAL;
  const slotCap = (cash * 5 * 0.90) / PAPER_MAX_ENTRIES;
  const riskBudget = cash * (PAPER_RISK_PCT / 100);

  // dates present in the archive (1-min), ascending
  let dates = await BacktestCandle.distinct('date', { interval: 'minute' });
  dates = dates.filter(d => (!FROM || d >= FROM) && (!TO || d <= TO)).sort();
  if (!dates.length) { console.error('[backtest] no 1-min candle data for the given range'); process.exit(1); }

  console.log(`\n=========  ORB PAPER-SPEC BACKTEST  =========`);
  console.log(`Days: ${dates.length} (${dates[0]} → ${dates[dates.length - 1]})  capital ₹${cash}  slotCap ₹${slotCap.toFixed(0)}  riskBudget ₹${riskBudget.toFixed(0)}`);
  console.log(`Costs: ${(COST_RT * 100).toFixed(3)}% round-trip + ${SLIP_TICKS} tick stop slippage + ${(ENTRY_SLIP * 100).toFixed(3)}% entry slippage   |  trading top ${TOP_N} by rvol5/day (cap ${PAPER_MAX_ENTRIES})\n`);

  const dailyBars = {};   // sym -> [{high,low,close} ...] prior daily bars (for ATR)
  const base15 = {};      // sym -> [past 15-min 09:15 volumes]
  const trades = [];
  const perDay = [];

  const srcCount = { recorded: 0, reconstructed: 0 };
  const diag = [];   // why recorded picks couldn't be replayed (bar coverage)
  const orWinCount = (bars) => (bars || []).filter(b => { const s = slotKey(b.date); if (!s) return false; const m = toMin(s); return m >= toMin('09:15') && m <= toMin('09:19'); }).length;
  for (const date of dates) {
    const docs = await BacktestCandle.find({ date, interval: 'minute' }).select('symbol bars').lean();
    const symBars = {};
    for (const doc of docs) {
      if (doc.symbol === 'NIFTY 50') continue;          // index: not a tradable candidate
      const bars = (doc.bars || []).map(mapBar);
      if (bars.length) symBars[doc.symbol] = bars;
    }

    // DEFAULT: trade exactly the stocks the live system selected that day (from
    // orb_trades). The strategy mechanics (OR, entry, OR-edge stop, sizing) are
    // still recomputed by the shared functions — only the basket comes from the
    // live record, so the backtest matches what was actually traded.
    let picks = [];
    let daySource = 'reconstructed';
    const orbDoc = await loadOrbDoc(date);
    const selectedRec = orbDoc ? (orbDoc.candidates || []).filter(c => SELECTED_STATUS.has(c.status)) : [];
    if (selectedRec.length) {
      daySource = 'recorded';
      for (const c of selectedRec) {
        // Use the OR levels + direction the LIVE system recorded (orb_trades). These
        // already passed live's selection gates (RVOL, ATR floor, doji), so we do NOT
        // re-derive or re-gate them from the thin archive — we only replay the trade.
        const orHigh = c.orHigh, orLow = c.orLow;
        if (!(Number.isFinite(orHigh) && Number.isFinite(orLow) && orHigh > orLow)) {
          trades.push({ date, symbol: c.symbol, dir: c.direction === 'SHORT' ? 'S' : 'L', filled: false, reason: 'no_or_levels', source: 'recorded' });
          continue;
        }
        const isShort = c.direction === 'SHORT';
        // synthesize the first candle so buildPaperSetup derives the recorded direction
        const orBar = { high: orHigh, low: orLow, open: isShort ? orHigh : orLow, close: isShort ? orLow : orHigh };
        picks.push({ symbol: c.symbol, orBar, atr14d: Number.isFinite(c.atr14d) ? c.atr14d : 1, rvol5: c.rvol5 ?? null, recorded: true });
      }
    }

    // FALLBACK: no recorded picks for this date → reconstruct selection via RVOL.
    if (!picks.length) {
      const rows = [];
      for (const [sym, bars] of Object.entries(symBars)) {
        const orBar = aggregate(bars, '09:15', '09:19');
        const volSoFar = (aggregate(bars, '09:15', '09:20') || {}).volume || 0;  // ≈ first 6 min @09:21
        const baseArr = base15[sym] || [];
        const baseline = baseArr.length ? baseArr.reduce((s, x) => s + x, 0) / baseArr.length : 0;
        const rvol5 = computeRvol5(volSoFar, { '09:15': baseline });
        const atr14d = computeATR(dailyBars[sym] || [], 14);
        if (orBar && Number.isFinite(rvol5)) rows.push({ symbol: sym, rvol5, orBar, atr14d });
      }
      const { selected } = selectInPlay(rows);
      picks = rows.filter(r => selected.has(r.symbol)).sort((a, b) => b.rvol5 - a.rvol5).slice(0, PAPER_MAX_ENTRIES);
    }
    srcCount[daySource]++;

    // LEVERAGE CAP (always on): ₹{cash} can only fund PAPER_MAX_ENTRIES slots at
    // 5×. If more names were selected (live occasionally armed >8), keep the top
    // 8 by rvol5 — otherwise the backtest takes positions the account can't hold
    // and over-states PnL on exactly the busiest days.
    picks = picks.sort((a, b) => (b.rvol5 ?? -Infinity) - (a.rvol5 ?? -Infinity)).slice(0, TOP_N);

    let dayNet = 0, dayFilled = 0, dayArmed = 0;
    for (const p of picks) {
      const tickSize = await tickOf(p.symbol);
      // recorded picks already passed live's ATR floor → bypass it (minAtr 0)
      const setup = buildPaperSetup({ bar: p.orBar, atr14d: p.atr14d, tickSize, riskBudget, slotCap, ...(p.recorded ? { minAtr: 0 } : {}) });
      if (!setup.ok) {          // doji / ATR floor (reconstructed only) / qty<1 / bad levels
        if (p.recorded && diag.length < 15) diag.push(`${date} ${p.symbol.padEnd(12)} ${setup.skipReason.padEnd(16)} OR=${p.orBar.low}–${p.orBar.high}  tick=${tickSize}`);
        trades.push({ date, symbol: p.symbol, dir: '', filled: false, reason: setup.skipReason, source: daySource });
        continue;
      }
      dayArmed++;
      const { isLong, trigger, orStop, stopDist, qty } = setup;

      // need intraday candles to replay the fill/exit path
      const allBars = symBars[p.symbol];
      if (!allBars || !allBars.length) {
        if (diag.length < 15) diag.push(`${date} ${p.symbol.padEnd(12)} no intraday candles in archive`);
        trades.push({ date, symbol: p.symbol, dir: isLong ? 'L' : 'S', filled: false, reason: 'no_candles', trigger, stop: orStop, source: daySource });
        dayArmed--; continue;
      }
      // simulate fill (09:24–15:00) then exit (stop or 15:15 close)
      const bars = allBars.filter(b => { const s = slotKey(b.date); return s && toMin(s) >= toMin('09:24'); });
      let entryIdx = -1;
      for (let i = 0; i < bars.length; i++) {
        const s = slotKey(bars[i].date); if (toMin(s) > toMin('15:00')) break;
        if (isLong ? bars[i].high >= trigger : bars[i].low <= trigger) { entryIdx = i; break; }
      }
      if (entryIdx < 0) { trades.push({ date, symbol: p.symbol, dir: isLong ? 'L' : 'S', filled: false, reason: 'no_fill', trigger, stop: orStop, source: daySource }); continue; }

      let exit = null, reason = null;
      for (let i = entryIdx + 1; i < bars.length; i++) {
        const s = slotKey(bars[i].date);
        if (isLong ? bars[i].low <= orStop : bars[i].high >= orStop) { exit = orStop; reason = 'stop'; break; }
        if (toMin(s) >= toMin('15:15')) { exit = bars[i].close; reason = 'time'; break; }
      }
      if (exit === null) { const last = bars[bars.length - 1]; exit = last.close; reason = 'time'; }

      // breakout entry fills slightly worse than the trigger (price moving through it)
      const entryFill = isLong ? trigger * (1 + ENTRY_SLIP) : trigger * (1 - ENTRY_SLIP);
      const gross = (isLong ? (exit - entryFill) : (entryFill - exit)) * qty;
      const cost = COST_RT * trigger * qty;
      const slip = reason === 'stop' ? SLIP_TICKS * tickSize * qty : 0;
      const net = gross - cost - slip;
      const R = stopDist * qty;
      trades.push({ date, symbol: p.symbol, dir: isLong ? 'L' : 'S', filled: true, reason, trigger, stop: orStop, exit, qty, gross, net, r: net / R, rvol5: p.rvol5, source: daySource });
      dayNet += net; dayFilled++;
    }
    perDay.push({ date, armed: dayArmed, trades: dayFilled, net: dayNet });

    // append today's daily bar + 15-min baseline for future days (ascending pass)
    for (const sym of Object.keys(symBars)) {
      const d = aggregate(symBars[sym], '09:15', '15:30');
      if (d) (dailyBars[sym] = dailyBars[sym] || []).push({ high: d.high, low: d.low, close: d.close });
      const v = aggregate(symBars[sym], '09:15', '09:29');
      if (v) (base15[sym] = base15[sym] || []).push(v.volume);
    }
  }

  // ── report ──────────────────────────────────────────────────────────────
  const filled = trades.filter(t => t.filled);
  const stops = filled.filter(t => t.reason === 'stop');
  const times = filled.filter(t => t.reason === 'time');
  const wins = filled.filter(t => t.net > 0);
  const netSum = filled.reduce((s, t) => s + t.net, 0);
  const grossSum = filled.reduce((s, t) => s + t.gross, 0);
  const rSum = filled.reduce((s, t) => s + t.r, 0);

  const noFill = trades.filter(t => !t.filled && t.reason === 'no_fill');
  const notArmed = trades.filter(t => !t.filled && t.reason !== 'no_fill');  // no_candles / doji / qty<1 / atr floor

  if (VERBOSE) {
    console.log(`EVERY recorded/selected pick and its outcome:`);
    console.log(`date        sym            dir  result                      trig     stop     exit     qty   net₹     R`);
    for (const t of trades) {
      console.log(`${t.date} ${t.symbol.padEnd(13)} ${(t.dir || '-')}    ${labelReason(t.reason).padEnd(26)} ${String(t.trigger ?? '').padStart(8)} ${String(t.stop ?? '').padStart(8)} ${String(t.exit ?? '').padStart(8)} ${String(t.qty ?? '').padStart(4)} ${(t.net != null ? t.net.toFixed(0) : '').padStart(7)} ${(t.r != null ? t.r.toFixed(2) : '').padStart(6)}`);
    }
    console.log('');
  }

  console.log(`Per-day (armed = passed paper rule, filled = entry triggered):`);
  for (const d of perDay) console.log(`  ${d.date}  armed=${String(d.armed).padStart(2)}  filled=${String(d.trades).padStart(2)}  net=₹${d.net.toFixed(0)}`);

  console.log(`\n----------------  SUMMARY  ----------------`);
  console.log(`  Selection source:       ${srcCount.recorded} days from live orb_trades, ${srcCount.reconstructed} days reconstructed`);
  console.log(`  Funnel:                 ${trades.length} selected → ${filled.length + noFill.length} armed → ${filled.length} filled`);
  console.log(`  Not armed (skipped):    ${notArmed.length}  (${[...new Set(notArmed.map(t => t.reason))].join(', ') || 'none'})`);
  console.log(`  Armed but no fill:      ${noFill.length}  (trigger never crossed)`);
  console.log(`  Exits:                  ${stops.length} stop-outs, ${times.length} at 15:15`);
  console.log(`  Win rate (net>0):       ${filled.length ? (wins.length / filled.length * 100).toFixed(1) : '0'}%  (${wins.length}/${filled.length})`);
  console.log(`  Avg R per trade (net):  ${filled.length ? (rSum / filled.length).toFixed(3) : '0'}R    total: ${rSum.toFixed(1)}R`);
  console.log(`  Gross PnL:              ₹${grossSum.toFixed(0)}`);
  console.log(`  Net PnL (after costs):  ₹${netSum.toFixed(0)}   (${(netSum / cash * 100).toFixed(2)}% of ₹${cash} capital)`);
  console.log(`  Cost drag:              ₹${(grossSum - netSum).toFixed(0)}`);
  console.log(`============================================`);
  if (diag.length) {
    console.log(`\n⚠ Recorded picks with no usable opening-range candles (archive coverage gap):`);
    diag.forEach(d => console.log(`   ${d}`));
    console.log(`   → "in 09:15–09:19=0" means the archive has no opening-range bars for that name/day.`);
    console.log(`   → run checkBacktestCoverage.js, and backfill those days (backfillCandles.js).`);
  }
  console.log(`NOTE: indicative only — short sample, ATR/baseline thin early, fills idealised.\n`);

  // ── CSV export ────────────────────────────────────────────────────────────
  if (!NO_XLSX) {
    const base = (OUT || path.join(REPO_ROOT, `orb_backtest_${dates[0]}_to_${dates[dates.length - 1]}`)).replace(/\.(csv|xlsx)$/i, '');
    // per-day rollup (date-ordered) with stops/time-exits/gross/cumulative
    const dayMap = new Map(perDay.map(d => [d.date, { date: d.date, armed: d.armed, filled: 0, stops: 0, times: 0, gross: 0, net: 0 }]));
    for (const t of filled) { const r = dayMap.get(t.date); r.filled++; if (t.reason === 'stop') r.stops++; else r.times++; r.gross += t.gross; r.net += t.net; }
    let cum = 0;
    const dayRows = perDay.map(d => { const r = dayMap.get(d.date); cum += r.net; return { ...r, cum }; });

    const tradesCsv = `${base}_trades.csv`;
    const dailyCsv = `${base}_daily.csv`;
    writeCsv(tradesCsv,
      ['Date', 'Symbol', 'Dir', 'Filled', 'Result', 'Trigger', 'Stop', 'Exit', 'Qty', 'Gross', 'Net', 'R', 'rvol5', 'Source'],
      trades.map(x => [x.date, x.symbol, x.dir, x.filled ? 'Y' : 'N', labelReason(x.reason),
        x.trigger ?? '', x.stop ?? '', x.exit ?? '', x.qty ?? '',
        x.gross != null ? Math.round(x.gross) : '', x.net != null ? Math.round(x.net) : '',
        x.r != null ? x.r.toFixed(2) : '', x.rvol5 ?? '', x.source || '']));
    writeCsv(dailyCsv,
      ['Date', 'Armed', 'Filled', 'StopOuts', 'Exit1515', 'Gross', 'Net', 'Cumulative'],
      dayRows.map(r => [r.date, r.armed, r.filled, r.stops, r.times, Math.round(r.gross), Math.round(r.net), Math.round(r.cum)]));

    console.log(`📄 CSV saved:`);
    console.log(`   ${tradesCsv}`);
    console.log(`   ${dailyCsv}\n`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

// Minimal CSV writer (no deps). Quotes any field containing comma/quote/newline.
function writeCsv(filePath, headers, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))];
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

main().catch(err => { console.error(err); process.exit(1); });
