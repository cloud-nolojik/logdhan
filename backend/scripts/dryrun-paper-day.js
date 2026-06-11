/**
 * DRY-RUN — replay the paper-spec ORB pipeline on a finished trading day.
 *
 * Runs the EXACT selection + arming logic against real historical candles and
 * prints what would have happened — which 8 names get armed, where the triggers
 * and stops sit, which entries fire, and the simulated PnL. PLACES NO ORDERS,
 * WRITES NOTHING to orb_trades / orb_baselines / orb_pipeline_log.
 *
 * Usage (from backend/):
 *   node scripts/dryrun-paper-day.js                  # today (IST)
 *   node scripts/dryrun-paper-day.js --date=2026-06-11
 *
 * Needs: valid Kite session in DB (the 06:00 token job), MONGODB_URI in .env.
 * API load: ~220 paced historical calls (~2-3 min) — run after market close.
 *
 * Fidelity notes vs live:
 *   • rvol5 numerator = sum of today's minute-bar volume 09:15–09:20 inclusive
 *     (live uses /quote day-volume at 09:21 — same window, cleaner source).
 *   • Baselines computed fresh through D-1 (never the cache) — no lookahead.
 *   • Entry fills at the trigger price (or bar open on gap-through) — ignores
 *     slippage; stop exits likewise. Treat PnL as upper-bound-ish.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

import kiteOrderService from '../src/services/kiteOrder.service.js';
import { getFnoSymbols } from '../src/constants/fnoUniverse.js';
import {
  computeRvol5,
  selectInPlay,
  buildVolumeProfile,
  computeATR,
  slotKey,
} from '../src/services/orb/orbService.js';

// ── Constants mirrored from orbService (keep in sync) ───────────────────────
const PAPER_MAX_ENTRIES   = 8;
const PAPER_STOP_ATR_MULT = 0.10;
const PAPER_MIN_ATR14D    = 0.50;
const PAPER_RISK_PCT      = 1.0;
const ORB_CAPITAL_PCT     = 0.90;
const ENTRY_CUTOFF_MIN    = 15 * 60;        // 15:00 — no entries after
const FORCE_EXIT_MIN      = 15 * 60 + 15;   // 15:15 — flat

const snap = (p, mode = 'round') => {
  const f = 20; // 1/0.05
  return (mode === 'floor' ? Math.floor(p * f) : mode === 'ceil' ? Math.ceil(p * f) : Math.round(p * f)) / f;
};
const barMin = (b) => { const [h, m] = slotKey(b.date).split(':').map(Number); return h * 60 + m; };

async function main() {
  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1];
  const istNow  = new Date(Date.now() + 5.5 * 3600e3);
  const D       = dateArg || istNow.toISOString().slice(0, 10);
  const Dm1     = new Date(new Date(`${D}T00:00:00Z`).getTime() - 86400e3); // calendar D-1 (range start handles weekends)
  const Dm31    = new Date(new Date(`${D}T00:00:00Z`).getTime() - 31 * 86400e3);
  const fmt     = (d) => d.toISOString().slice(0, 10);

  console.log(`\n══════ DRY-RUN paper-spec replay for ${D} (NO ORDERS) ══════\n`);
  await mongoose.connect(process.env.MONGODB_URI);

  // 0) Token resolution — USE THE EXISTING TOKEN, NEVER AUTO-LOGIN.
  // Two reasons: (a) getValidSession's is_valid/expiry gate can reject a doc
  // whose raw access_token still works (observed 2026-06-11: live backend
  // trading fine while the doc read is_valid=false); (b) a successful
  // auto-login from this script would mint a NEW token, and Kite invalidates
  // the old one — i.e. a dry-run would KILL the live backend's session.
  // So: take KITE_ACCESS_TOKEN env if given, else the freshest access_token in
  // kitesessions regardless of validity flags, patch it in, and hard-disable
  // auto-login for this process.
  const kiteSvc = kiteOrderService.kiteService;
  kiteSvc._doAutoLogin = async () => { throw new Error('auto-login disabled in dry-run (would clobber the live token)'); };

  // Gather candidate tokens: env override first, then EVERY distinct token in
  // kitesessions (newest token_expiry first). We PROBE each against Kite and
  // use the first that works — sorting by updatedAt alone is a trap, because
  // the 403-invalidation handler bumps updatedAt on DEAD docs, making the
  // most-recently-updated doc the most-recently-killed token.
  const candidates = [];
  if (process.env.KITE_ACCESS_TOKEN) candidates.push({ access_token: process.env.KITE_ACCESS_TOKEN, src: 'env' });
  const docs = await mongoose.connection.collection('kitesessions')
    .find({ access_token: { $exists: true, $nin: [null, ''] } })
    .sort({ token_expiry: -1, updatedAt: -1 }).limit(10).toArray();
  const seen = new Set(candidates.map(c => c.access_token));
  for (const d of docs) {
    if (seen.has(d.access_token)) continue;
    seen.add(d.access_token);
    candidates.push({ ...d, src: `db(expiry=${d.token_expiry?.toISOString?.()?.slice(0, 16) ?? '?'})` });
  }
  if (!candidates.length) {
    console.error('\n❌ No access_token found anywhere (env or kitesessions collection).');
    console.error('   Trigger a fresh login from the live backend (or wait for the 06:00 job), then rerun.\n');
    await mongoose.disconnect(); process.exit(1);
  }

  let working = null;
  for (const cand of candidates) {
    kiteSvc.getValidSession = async () => cand;            // bypass validity gate
    try {
      await kiteOrderService.getLTP(['NSE:RELIANCE']);
      working = cand;
      console.log(`[0] ✅ Token …${cand.access_token.slice(-6)} works (${cand.src})`);
      break;
    } catch (_) {
      console.log(`[0] ✗ token …${cand.access_token.slice(-6)} rejected (${cand.src}) — trying next`);
    }
  }
  if (!working) {
    console.error(`\n❌ Probed ${candidates.length} token(s) — Kite rejected all. No live token exists right now.`);
    console.error('   The clean fix: trigger the backend\'s own token refresh (it owns the login');
    console.error('   lifecycle), then rerun. On the server:');
    console.error('     pm2 restart logdhan-backend     # next API call auto-logins at startup');
    console.error('   or wait for the 06:00 kite-token-refresh job and run this before market open.\n');
    await mongoose.disconnect(); process.exit(1);
  }

  // 1) Universe
  const symbols = await getFnoSymbols();
  console.log(`[1] Universe: ${symbols.length} F&O symbols`);

  // 2) Baselines through D-1 — computed fresh (cache may include D → lookahead)
  console.log(`[2] Baselines: 15-min history ${fmt(Dm31)} → ${fmt(Dm1)} (paced, ~2 min)...`);
  const hist15 = await kiteOrderService.getHistoricalCandles(
    symbols, '15minute', `${fmt(Dm31)} 09:15:00`, `${fmt(Dm1)} 15:30:00`, { batch: 2, delayMs: 600 });
  const profiles = {};
  for (const s of symbols) {
    const p = buildVolumeProfile(hist15[s] || []);
    if (Object.keys(p).length) profiles[s] = p;
  }
  console.log(`    profiles for ${Object.keys(profiles).length}/${symbols.length}`);

  // 3) Target-day minute bars (one call per symbol — feeds rvol5 AND simulation)
  console.log(`[3] Minute bars for ${D} (paced)...`);
  const mins = await kiteOrderService.getHistoricalCandles(
    symbols, 'minute', `${D} 09:15:00`, `${D} 15:30:00`, { batch: 2, delayMs: 600 });

  // 4) 09:21 snapshot replay — volume of minute bars 09:15..09:20 inclusive
  const rows = [];
  for (const s of symbols) {
    const bars = mins[s] || [];
    const v0921 = bars.filter(b => barMin(b) <= 9 * 60 + 20).reduce((a, b) => a + (b.volume || 0), 0);
    const r5 = computeRvol5(v0921, profiles[s]);
    if (Number.isFinite(r5)) rows.push({ symbol: s, rvol5: parseFloat(r5.toFixed(2)) });
  }
  const { selected, fallback, ranked } = selectInPlay(rows);
  console.log(`\n[4] 09:21 SNAPSHOT — in-play ${selected.size}/${rows.length}${fallback ? '  ⚠ FALLBACK selection' : ''}`);
  ranked.slice(0, 20).forEach((r, i) =>
    console.log(`    #${String(i + 1).padStart(2)} ${r.symbol.padEnd(14)} rvol5=${r.rvol5.toFixed(2)}x ${selected.has(r.symbol) ? '✅' : ''}`));

  // 5) 09:24 arming replay — top 8 by rvol5
  const top8 = ranked.filter(r => selected.has(r.symbol)).slice(0, PAPER_MAX_ENTRIES);
  console.log(`\n[5] 09:24 ARMING — top ${top8.length}: ${top8.map(r => r.symbol).join(', ')}`);

  const daily = await kiteOrderService.getHistoricalCandles(
    top8.map(r => r.symbol), 'day', fmt(new Date(Dm31.getTime() - 15 * 86400e3)), fmt(Dm1), { batch: 2, delayMs: 600 });

  let slotCap = 9800, cash = 45000;   // fallbacks if balance unavailable
  try {
    const bal = await kiteOrderService.getAvailableBalance();
    slotCap = Math.floor(((bal.usableIntraday ?? bal.available) * ORB_CAPITAL_PCT) / PAPER_MAX_ENTRIES);
    cash    = bal.available;
  } catch (_) { console.warn('    (balance unavailable — using fallback slotCap ₹9800 / cash ₹45k)'); }
  const riskBudget = Math.floor(cash * PAPER_RISK_PCT / 100);
  console.log(`    capital: slotCap=₹${slotCap}  riskBudget(1%)=₹${riskBudget}\n`);

  const trades = [];
  for (const { symbol, rvol5 } of top8) {
    const bars = mins[symbol] || [];
    const or5  = bars.filter(b => barMin(b) >= 555 && barMin(b) <= 559);   // 09:15..09:19
    if (or5.length < 3) { console.log(`    ${symbol.padEnd(14)} ⏭ insufficient 09:15 candle data`); continue; }
    const o = or5[0].open, c = or5[or5.length - 1].close;
    const orHigh = Math.max(...or5.map(b => b.high)), orLow = Math.min(...or5.map(b => b.low));
    const direction = c > o ? 'LONG' : c < o ? 'SHORT' : null;
    if (!direction) { console.log(`    ${symbol.padEnd(14)} ⏭ doji first candle`); continue; }
    const isLong = direction === 'LONG';

    const atr = computeATR(daily[symbol] || [], 14);
    if (!(atr >= PAPER_MIN_ATR14D)) { console.log(`    ${symbol.padEnd(14)} ⏭ ATR14d ${atr?.toFixed?.(2)} < ₹${PAPER_MIN_ATR14D}`); continue; }
    const stopDist = Math.max(0.05, snap(PAPER_STOP_ATR_MULT * atr));
    const trigger  = isLong ? snap(orHigh, 'ceil') : snap(orLow, 'floor');
    const qty      = Math.min(Math.floor(riskBudget / stopDist), Math.floor(slotCap / trigger));
    if (qty < 1) { console.log(`    ${symbol.padEnd(14)} ⏭ qty<1`); continue; }

    // Simulate from 09:24: entry on trigger cross (cutoff 15:00), then stop or 15:15
    let entry = null, entryT = null, exit = null, exitT = null, reason = null;
    for (const b of bars) {
      const t = barMin(b);
      if (t < 564) continue;                                  // before 09:24
      if (entry === null) {
        if (t >= ENTRY_CUTOFF_MIN) { reason = 'never_triggered'; break; }
        const crossed = isLong ? b.high >= trigger : b.low <= trigger;
        if (crossed) {
          entry = isLong ? Math.max(trigger, b.open) : Math.min(trigger, b.open);  // gap-through fills at open
          entryT = slotKey(b.date);
        }
        continue;
      }
      const stop = isLong ? snap(entry - stopDist, 'floor') : snap(entry + stopDist, 'ceil');
      if (t >= FORCE_EXIT_MIN) { exit = b.open; exitT = slotKey(b.date); reason = 'force_exit_15:15'; break; }
      const stopped = isLong ? b.low <= stop : b.high >= stop;
      if (stopped) { exit = isLong ? Math.min(stop, b.open) : Math.max(stop, b.open); exitT = slotKey(b.date); reason = 'stop_hit'; break; }
    }
    if (entry !== null && exit === null) {       // still open at last bar
      const last = bars[bars.length - 1];
      exit = last.close; exitT = slotKey(last.date); reason = reason || 'eod_close';
    }

    const pnl = entry !== null && exit !== null
      ? parseFloat((((isLong ? exit - entry : entry - exit)) * qty).toFixed(2)) : null;
    trades.push({ symbol, direction, rvol5, orLow, orHigh, trigger, stopDist, qty, entry, entryT, exit, exitT, reason, pnl });
  }

  // 6) Report
  console.log(`\n══════ RESULT — what the system would have done on ${D} ══════`);
  let total = 0, fired = 0;
  for (const t of trades) {
    const line = t.entry === null
      ? `    ${t.symbol.padEnd(14)} ${t.direction.padEnd(5)} trigger=₹${t.trigger}  — never triggered`
      : `    ${t.symbol.padEnd(14)} ${t.direction.padEnd(5)} entry=₹${t.entry} @${t.entryT}  exit=₹${t.exit} @${t.exitT} (${t.reason})  qty=${t.qty}  PnL=₹${t.pnl >= 0 ? '+' : ''}${t.pnl}`;
    console.log(line);
    if (t.entry !== null) { total += t.pnl; fired++; }
  }
  console.log(`\n    Armed: ${trades.length}  Triggered: ${fired}  Simulated day PnL: ₹${total >= 0 ? '+' : ''}${total.toFixed(2)}`);
  console.log(`    (fills at trigger/stop exactly — real slippage will cost a bit more)\n`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => { console.error('DRY-RUN failed:', err); process.exit(1); });
