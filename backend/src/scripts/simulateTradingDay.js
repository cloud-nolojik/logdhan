#!/usr/bin/env node
/**
 * simulateTradingDay.js — end-to-end replay of one trading day with real data
 *
 * Walks through the full morning the same way the live system would:
 *   08:30   scanner.py --asof <prev day>  → 15-candidate shortlist
 *   09:15   market opens (use yfinance 5-min bars)
 *   09:30   ORB candle closes (we use first three 5-min bars: 9:15, 9:20, 9:25)
 *   09:32   re-score shortlist against the ORB, select top 3, compute entry
 *           triggers + SL + T1/T2/T3
 *   09:30-15:15  walk through the day's 5-min bars to determine:
 *           - did the SL-M trigger fill?
 *           - did SL or T1 hit first?
 *           - 12:00 cancellation if entry didn't trigger
 *           - 15:15 hard flat for anything still open
 *
 * Usage:
 *   node src/scripts/simulateTradingDay.js                    # last Friday
 *   node src/scripts/simulateTradingDay.js --date 2026-05-22
 *   node src/scripts/simulateTradingDay.js --regime WEAK_BEAR # override regime
 *   node src/scripts/simulateTradingDay.js --top 5            # show top-5 trades
 *
 * Requires:
 *   - python3 + yfinance installed (pip install yfinance pandas)
 *   - logdhan/scanner.py at the canonical location
 *
 * Does NOT touch Mongo. Does NOT touch the broker. Pure replay.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  evaluateShortlistCandidate,
  selectTopOrbEntries,
  computeVwap,
  evaluateVwapExit,
  REGIME_TO_INTRADAY_MODE,
} from '../services/dailyPicks/dailyPicksService.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Find scanner.py — checks env var first, then standard layouts.
import { existsSync } from 'fs';
const SCANNER_PATH_CANDIDATES = [
  process.env.SCANNER_PY_PATH,                                   // env override
  path.resolve(__dirname, '../../..', 'scanner.py'),             // backend/ inside logdhan/
  path.resolve(__dirname, '../../../..', 'scanner.py'),          // one level deeper
  path.resolve(__dirname, '../../../logdhan', 'scanner.py'),     // backend + logdhan siblings
].filter(Boolean);
const SCANNER_PY = SCANNER_PATH_CANDIDATES.find(p => existsSync(p))
  || SCANNER_PATH_CANDIDATES[0];

// ─── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = { date: null, regime: null, top: 3, watchlist: null, confirmBars: 0, vwap: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === '--date')      { args.date = next; i++; }
    else if (a === '--regime') { args.regime = next; i++; }
    else if (a === '--top')    { args.top = parseInt(next, 10); i++; }
    else if (a === '--watchlist') { args.watchlist = next; i++; }
    else if (a === '--confirm-bars') { args.confirmBars = parseInt(next, 10); i++; }
    else if (a === '--vwap')   { args.vwap = true; }
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node simulateTradingDay.js [--date YYYY-MM-DD] [--regime <label>] [--top N] [--watchlist file] [--confirm-bars N] [--vwap]`);
      console.log(`  --confirm-bars N    require N consecutive 5-min closes above trigger before entry`);
      console.log(`  --vwap              additionally require entry close > VWAP at breakout, and exit on 2 consecutive closes below VWAP`);
      process.exit(0);
    }
  }
  return args;
}

// ─── Date utilities ─────────────────────────────────────────────────────────

function lastFridayFromToday() {
  const d = new Date();
  // back up to last Friday (weekday 5)
  const day = d.getDay();
  const offset = day >= 5 ? day - 5 : day + 2;  // Sat=6→1back, Sun=0→2back, Mon=1→3back, ...
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
}

function prevTradingDay(yyyyMmDd) {
  const d = new Date(yyyyMmDd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  // Skip weekends
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

// ─── yfinance subprocess: fetch 5-min bars for a list of symbols on a date ──

async function fetchIntradayBars(symbols, dateYyyyMmDd) {
  const py = `
import sys, json, warnings
warnings.filterwarnings("ignore")
import yfinance as yf
import pandas as pd

symbols = sys.argv[1].split(",")
target_date = sys.argv[2]

result = {}
for sym in symbols:
    try:
        df = yf.download(f"{sym}.NS", period="5d", interval="5m",
                         auto_adjust=True, progress=False, threads=False)
        if df.empty:
            continue
        # Some yfinance versions return MultiIndex columns; flatten
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        df.index = pd.to_datetime(df.index).tz_localize(None)
        # Filter to the target date
        day = df[df.index.strftime("%Y-%m-%d") == target_date]
        if day.empty:
            continue
        bars = []
        for ts, row in day.iterrows():
            bars.append({
                "ts": ts.strftime("%H:%M"),
                "open":  float(row["Open"]),
                "high":  float(row["High"]),
                "low":   float(row["Low"]),
                "close": float(row["Close"]),
                "volume": int(row["Volume"]) if pd.notna(row["Volume"]) else 0,
            })
        if bars:
            result[sym] = bars
    except Exception as e:
        print(f"[yf] {sym} failed: {type(e).__name__}: {e}", file=sys.stderr)

print(json.dumps(result))
`;
  const tmpPy = path.join(os.tmpdir(), `yf_${Date.now()}.py`);
  await fs.writeFile(tmpPy, py, 'utf8');
  try {
    const { stdout } = await execFileAsync('python3', [tmpPy, symbols.join(','), dateYyyyMmDd], {
      timeout: 120_000, maxBuffer: 50 * 1024 * 1024,
    });
    const lastLine = stdout.split('\n').filter(l => l.trim().startsWith('{')).pop() || '{}';
    return JSON.parse(lastLine);
  } finally {
    await fs.unlink(tmpPy).catch(() => {});
  }
}

// ─── Run scanner.py for the shortlist ───────────────────────────────────────

async function runScannerForDate({ asof, mode, top, watchlist }) {
  const tmpList = path.join(os.tmpdir(), `sim_wl_${Date.now()}.txt`);
  let symbols;
  if (watchlist) {
    symbols = (await fs.readFile(watchlist, 'utf8'))
      .split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  } else {
    // Default: Nifty 50 (scanner.py's built-in fallback uses these too)
    symbols = [
      'RELIANCE','HDFCBANK','ICICIBANK','INFY','TCS','BHARTIARTL','SBIN','ITC','LT',
      'HINDUNILVR','AXISBANK','KOTAKBANK','BAJFINANCE','M&M','MARUTI','ASIANPAINT',
      'HCLTECH','WIPRO','ULTRACEMCO','TITAN','SUNPHARMA','NTPC','POWERGRID',
      'TATAMOTORS','TATASTEEL','ONGC','ADANIENT','ADANIPORTS','JSWSTEEL','COALINDIA',
      'BAJAJ-AUTO','BAJAJFINSV','GRASIM','INDUSINDBK','EICHERMOT','TECHM','DRREDDY',
      'CIPLA','DIVISLAB','BRITANNIA','NESTLEIND','HEROMOTOCO','HDFCLIFE','SBILIFE',
      'APOLLOHOSP','TRENT','SHRIRAMFIN','BPCL','HINDALCO','TATACONSUM',
    ];
  }
  await fs.writeFile(tmpList, symbols.join('\n'), 'utf8');

  try {
    const { stdout } = await execFileAsync('python3', [
      SCANNER_PY,
      '--watchlist', tmpList,
      '--asof', asof,
      '--mode', mode,
      '--top', String(top),
      '--json',
      '--no-tv',
      '--min-score', '0.0',
      '--period', '1y',
    ], { timeout: 180_000, maxBuffer: 20 * 1024 * 1024 });
    const jsonLine = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('[{') || l === '[]');
    return jsonLine ? JSON.parse(jsonLine) : [];
  } finally {
    await fs.unlink(tmpList).catch(() => {});
  }
}

// ─── Build the 9:15-9:30 ORB candle from 5-min bars ─────────────────────────

function buildOrbCandle(bars) {
  // Take bars where ts is 09:15, 09:20, 09:25 (closes at 09:30)
  const opening = bars.filter(b => ['09:15', '09:20', '09:25'].includes(b.ts));
  if (opening.length === 0) return null;
  // ORB open = open of 9:15 bar; close = close of 9:25 bar (which closed at 9:30)
  const sorted = opening.sort((a, b) => a.ts.localeCompare(b.ts));
  const orbOpen = sorted[0].open;
  const orbClose = sorted[sorted.length - 1].close;
  return {
    open: orbOpen,
    high: Math.max(...opening.map(b => b.high)),
    low:  Math.min(...opening.map(b => b.low)),
    close: orbClose,
    volume: opening.reduce((s, b) => s + b.volume, 0),
  };
}

// ─── Volume ratio estimate: 9:15-9:30 volume / avg first-15-min volume ──────
// We approximate by using the day's volume distribution; without historical
// per-time-of-day data, we set ratio to null (the evaluator auto-passes).
// For a richer simulation we could compute from prior days but that's overkill.
function estimateVolumeRatio(/* bars */) { return null; }

// ─── Simulate the rest of the day after entry ───────────────────────────────

// Walk through bars from 09:15 to a given timestamp, returning the cumulative
// VWAP at that point. Used both for entry filter (VWAP at breakout bar close)
// and for the post-entry exit walk (VWAP recomputed each new bar).
function vwapUpTo(bars, untilTs) {
  const slice = bars.filter(b => b.ts >= '09:15' && b.ts <= untilTs);
  return computeVwap(slice).vwap;
}

function simulateTradeOutcome({ direction, entryTrigger, sl, t1, t2, t3, bars, confirmBars = 0, useVwap = false }) {
  const post930 = bars.filter(b => b.ts >= '09:30');
  if (post930.length === 0) return { outcome: 'NO_DATA' };

  const isLong = direction === 'LONG';
  let triggered = false;
  let entryBar = null;
  let entryPrice = null;
  let breakoutBar = null;        // when the level was first crossed (high/low)
  let confirmHistory = [];       // for logging the confirmation sequence

  if (confirmBars > 0) {
    // ── CONFIRMATION-BASED ENTRY ────────────────────────────────────────
    // Step 1: find the breakout bar (any bar whose H/L crosses trigger)
    // Step 2: from the NEXT bar onwards, require N consecutive closes
    //         on the trade side of the trigger. Any failure resets the
    //         counter (still watching for a fresh confirm sequence).
    let confirmed = 0;
    let watching = true;     // whether we're still tracking confirmations
    for (let i = 0; i < post930.length; i++) {
      const bar = post930[i];
      if (bar.ts >= '12:00') break;
      // Once breakout happens, start the confirmation count on subsequent bars
      if (!breakoutBar) {
        const crossed = isLong ? bar.high >= entryTrigger : bar.low <= entryTrigger;
        if (crossed) { breakoutBar = bar.ts; }
        continue;
      }
      // Confirmation bar: check CLOSE on the trade side
      const closeConfirms = isLong ? bar.close > entryTrigger : bar.close < entryTrigger;
      confirmHistory.push({ ts: bar.ts, close: bar.close, confirms: closeConfirms });
      if (closeConfirms) {
        confirmed++;
        if (confirmed >= confirmBars) {
          // Enter at this bar's close (next available execution)
          triggered = true;
          entryBar = bar.ts;
          entryPrice = bar.close;   // market order at confirmation bar close
          break;
        }
      } else {
        confirmed = 0;    // reset on any failure — need consecutive
        // Don't reset breakoutBar — we keep watching for re-confirm on the
        // SAME breakout. Alternative interpretation: reset entirely.
        // For simplicity we keep the breakout flag and just require
        // confirmBars consecutive closes from somewhere in the watch window.
      }
    }
  } else {
    // ── SL-M behavior (current production): enter on first H/L crossing ──
    for (const bar of post930) {
      if (bar.ts >= '12:00') break;
      if (isLong && bar.high >= entryTrigger) { triggered = true; entryBar = bar.ts; entryPrice = entryTrigger; break; }
      if (!isLong && bar.low  <= entryTrigger) { triggered = true; entryBar = bar.ts; entryPrice = entryTrigger; break; }
    }
  }

  if (!triggered) {
    return {
      outcome: confirmBars > 0 && breakoutBar ? 'BREAKOUT_FAILED_CONFIRMATION' : 'CANCELLED_AT_1200',
      triggered: false,
      breakout_bar: breakoutBar,
      confirm_history: confirmHistory,
    };
  }

  // 2. After entry, walk through bars until SL/target/VWAP-exit/15:15
  const postEntry = post930.filter(b => b.ts > entryBar);
  let vwapConsecutiveOpp = 0;     // counter for consecutive bars on wrong side
  let vwapState = null;           // for incremental VWAP computation
  const allBarsUpToEntry = bars.filter(b => b.ts >= '09:15' && b.ts <= entryBar);
  vwapState = computeVwap(allBarsUpToEntry);

  for (const bar of postEntry) {
    if (bar.ts >= '15:15') {
      // Force-flat — exit at this bar's close
      const exitPrice = bar.close;
      const pnlPct = isLong
        ? ((exitPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - exitPrice) / entryPrice) * 100;
      return {
        outcome: 'TIME_EXIT_1515', triggered: true,
        entry_bar: entryBar, entry_price: entryPrice,
        exit_bar: bar.ts, exit_price: exitPrice, pnl_pct: pnlPct,
      };
    }
    // Did SL hit? (the broker-side hard SL — always checked first)
    if (isLong && bar.low <= sl) {
      const pnlPct = ((sl - entryPrice) / entryPrice) * 100;
      return {
        outcome: 'STOPPED_OUT', triggered: true,
        entry_bar: entryBar, entry_price: entryPrice,
        exit_bar: bar.ts, exit_price: sl, pnl_pct: pnlPct, r: -1,
      };
    }
    if (!isLong && bar.high >= sl) {
      const pnlPct = ((entryPrice - sl) / entryPrice) * 100;
      return {
        outcome: 'STOPPED_OUT', triggered: true,
        entry_bar: entryBar, entry_price: entryPrice,
        exit_bar: bar.ts, exit_price: sl, pnl_pct: pnlPct, r: -1,
      };
    }
    // Did target hit? (check T3, T2, T1 in order — highest wins)
    if (isLong) {
      if (bar.high >= t3) return outcomeAt('TARGET_3R_HIT', bar, t3, entryBar, entryPrice, isLong, 3);
      if (bar.high >= t2) return outcomeAt('TARGET_2R_HIT', bar, t2, entryBar, entryPrice, isLong, 2);
      if (bar.high >= t1) return outcomeAt('TARGET_1R_HIT', bar, t1, entryBar, entryPrice, isLong, 1);
    } else {
      if (bar.low <= t3) return outcomeAt('TARGET_3R_HIT', bar, t3, entryBar, entryPrice, isLong, 3);
      if (bar.low <= t2) return outcomeAt('TARGET_2R_HIT', bar, t2, entryBar, entryPrice, isLong, 2);
      if (bar.low <= t1) return outcomeAt('TARGET_1R_HIT', bar, t1, entryBar, entryPrice, isLong, 1);
    }
    // ── VWAP exit check (opt-in via useVwap) ───────────────────────────────
    // Update cumulative VWAP with this newly-closed bar, then check whether
    // we're on the wrong side for 2 consecutive bars.
    if (useVwap) {
      vwapState = computeVwap([bar], vwapState);
      const vwapResult = evaluateVwapExit({
        direction, latestClose: bar.close,
        vwap: vwapState.vwap, consecutiveOpp: vwapConsecutiveOpp,
      });
      vwapConsecutiveOpp = vwapResult.consecutiveOpp;
      if (vwapResult.exit) {
        const exitPrice = bar.close;
        const pnlPct = isLong
          ? ((exitPrice - entryPrice) / entryPrice) * 100
          : ((entryPrice - exitPrice) / entryPrice) * 100;
        const rValue = isLong
          ? (exitPrice - entryPrice) / (entryPrice - sl)
          : (entryPrice - exitPrice) / (sl - entryPrice);
        return {
          outcome: 'VWAP_EXIT', triggered: true,
          entry_bar: entryBar, entry_price: entryPrice,
          exit_bar: bar.ts, exit_price: exitPrice, pnl_pct: pnlPct,
          r: Number(rValue.toFixed(2)),
          vwap_at_exit: vwapState.vwap,
          vwap_exit_reason: vwapResult.reason,
        };
      }
    }
  }

  // Made it to end of bars with no resolution
  const last = postEntry[postEntry.length - 1];
  if (!last) return { outcome: 'NO_POST_ENTRY_DATA', triggered: true };
  const pnlPct = isLong
    ? ((last.close - entryPrice) / entryPrice) * 100
    : ((entryPrice - last.close) / entryPrice) * 100;
  return {
    outcome: 'OPEN_AT_END', triggered: true,
    entry_bar: entryBar, entry_price: entryPrice,
    exit_bar: last.ts, exit_price: last.close, pnl_pct: pnlPct,
  };
}

function outcomeAt(label, bar, price, entryBar, entryPrice, isLong, r) {
  const pnlPct = isLong
    ? ((price - entryPrice) / entryPrice) * 100
    : ((entryPrice - price) / entryPrice) * 100;
  return {
    outcome: label, triggered: true,
    entry_bar: entryBar, entry_price: entryPrice,
    exit_bar: bar.ts, exit_price: price, pnl_pct: pnlPct, r,
  };
}

// ─── Output helpers ─────────────────────────────────────────────────────────

const pad = (s, n) => String(s ?? '').padEnd(n);
const padl = (s, n) => String(s ?? '').padStart(n);
const hr = (ch = '─') => ch.repeat(78);

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const targetDate = args.date || lastFridayFromToday();
  const scanAsof   = prevTradingDay(targetDate);
  const regime     = args.regime || 'STRONG_BULL';     // user can override; default for demo
  const mode       = REGIME_TO_INTRADAY_MODE[regime] || 'intraday_gap_long';

  console.log(`\n${hr('═')}`);
  console.log(`  LOGDHAN INTRADAY SIMULATION — replay of ${targetDate}`);
  console.log(`${hr('═')}\n`);

  console.log(`Configuration:`);
  console.log(`  trading date    ${targetDate} (Friday)`);
  console.log(`  scanner asof    ${scanAsof} (close of prior trading day, used at 8:30)`);
  console.log(`  regime          ${regime} → ${mode}`);
  console.log(`  top picks       ${args.top}\n`);

  // ── 08:30 ─────────────────────────────────────────────────────────────────
  console.log(`${hr()}`);
  console.log(`  08:30 IST — scanner.py --asof ${scanAsof} --mode ${mode} --top 15`);
  console.log(`${hr()}`);
  const shortlist = await runScannerForDate({ asof: scanAsof, mode, top: 15, watchlist: args.watchlist });
  if (shortlist.length === 0) {
    console.log(`  ❌ scanner returned 0 candidates. Try a different date or regime.\n`);
    process.exit(1);
  }
  console.log(`\n  Shortlist of ${shortlist.length} candidates (sorted by composite):\n`);
  console.log(`  ${pad('rank',5)} ${pad('symbol',12)} ${pad('dir',5)} ${padl('composite',10)} ${padl('SL%',7)} ${padl('T1%',7)}`);
  console.log(`  ${'-'.repeat(54)}`);
  shortlist.forEach((c, i) => {
    console.log(`  ${pad(i+1,5)} ${pad(c.symbol,12)} ${pad(c.direction,5)} ${padl(c.composite.toFixed(3),10)} ${padl(c.sl_pct.toFixed(2)+'%',7)} ${padl(c.t1_pct.toFixed(2)+'%',7)}`);
  });

  // ── 09:15-09:30 ──────────────────────────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log(`  09:15-09:30 IST — fetching 5-min bars from yfinance for ${shortlist.length} symbols`);
  console.log(`${hr()}\n`);
  const symbols = shortlist.map(c => c.symbol);
  let intradayMap;
  try {
    intradayMap = await fetchIntradayBars(symbols, targetDate);
  } catch (e) {
    console.log(`  ❌ yfinance fetch failed: ${e.message}`);
    process.exit(1);
  }
  const haveBars = Object.keys(intradayMap).length;
  console.log(`  fetched intraday data for ${haveBars}/${shortlist.length} symbols\n`);
  if (haveBars === 0) {
    console.log(`  No intraday data available — date may be too old (yfinance: 60 days) or non-trading day.\n`);
    process.exit(1);
  }

  // Also fetch Nifty so we can compute niftyChangePct
  let niftyChangePct = null;
  try {
    const niftyData = await fetchIntradayBars(['^NSEI'], targetDate);
    const niftyBars = niftyData['^NSEI'];
    if (niftyBars?.length) {
      const niftyOrb = buildOrbCandle(niftyBars);
      if (niftyOrb) {
        niftyChangePct = ((niftyOrb.close - niftyOrb.open) / niftyOrb.open) * 100;
      }
    }
  } catch (e) {
    console.log(`  (couldn't fetch Nifty 5-min — niftyChangePct will be null)`);
  }
  console.log(`  Nifty 9:15-9:30 change: ${niftyChangePct == null ? 'unknown' : niftyChangePct.toFixed(2) + '%'}\n`);

  // ── 09:32 — evaluate each candidate ───────────────────────────────────────
  console.log(`${hr()}`);
  console.log(`  09:32 IST — evaluate shortlist vs 9:15-9:30 ORB, select top ${args.top}`);
  console.log(`${hr()}\n`);

  const evaluated = shortlist.map(c => {
    const bars = intradayMap[c.symbol];
    const orb = bars ? buildOrbCandle(bars) : null;
    const volumeRatio = bars ? estimateVolumeRatio(bars) : null;
    // VWAP at the 9:30 ORB close — accumulated from the 9:15, 9:20, 9:25 bars.
    // Only computed (and passed to the evaluator) when --vwap is set.
    const vwapAtOrbClose = (args.vwap && bars)
      ? vwapUpTo(bars, '09:30')
      : null;
    const result = evaluateShortlistCandidate({
      candidate: { symbol: c.symbol, direction: c.direction, composite: c.composite, rank_score: c.composite * 100 },
      orb,
      volumeRatio,
      niftyChangePct,
      vwapAtOrbClose,
    });
    return { candidate: c, orb, bars, vwapAtOrbClose, ...result };
  });

  console.log(`  ${pad('sym',12)} ${pad('dir',5)} ${padl('comp',7)} ${padl('intra',7)} ${padl('combined',9)} ${pad('decision',12)} ${pad('reason / orb',40)}`);
  console.log(`  ${'-'.repeat(95)}`);
  const sorted = [...evaluated].sort((a, b) => b.combinedScore - a.combinedScore);
  for (const e of sorted) {
    const decision = e.passes ? '✓ candidate' : '✗ rejected';
    const orbStr = e.orb
      ? `O=${e.orb.open.toFixed(2)} C=${e.orb.close.toFixed(2)} (${(((e.orb.close-e.orb.open)/e.orb.open)*100).toFixed(2)}%)`
      : 'no data';
    const reason = e.rejection_reason ? `[${e.rejection_reason}]` : orbStr;
    console.log(`  ${pad(e.candidate.symbol,12)} ${pad(e.candidate.direction,5)} ${padl(e.candidate.composite.toFixed(2),7)} ${padl(e.intradayScore.toFixed(2),7)} ${padl(e.combinedScore.toFixed(3),9)} ${pad(decision,12)} ${pad(reason.slice(0,40),40)}`);
  }

  const selected = selectTopOrbEntries(evaluated, args.top);
  console.log(`\n  ${selected.length} of ${evaluated.length} candidates selected for SL-M entry:\n`);
  if (selected.length === 0) {
    console.log(`  ⚠️  NO PICKS today — all 15 candidates failed the 9:32 gate.`);
    console.log(`     This is correct behavior — sit out rather than force a trade.\n`);
    process.exit(0);
  }

  // ── Print the entries that would be placed ───────────────────────────────
  console.log(`  ${pad('symbol',12)} ${pad('dir',5)} ${padl('trigger',9)} ${padl('SL',8)} ${padl('T1',8)} ${padl('T2',8)} ${padl('T3',8)} ${padl('risk%',7)}`);
  console.log(`  ${'-'.repeat(72)}`);
  for (const s of selected) {
    const L = s.computedLevels;
    console.log(`  ${pad(s.candidate.symbol,12)} ${pad(s.candidate.direction,5)} ${padl(L.entry.toFixed(2),9)} ${padl(L.sl.toFixed(2),8)} ${padl(L.t1.toFixed(2),8)} ${padl(L.t2.toFixed(2),8)} ${padl(L.t3.toFixed(2),8)} ${padl(L.risk_pct.toFixed(2)+'%',7)}`);
  }

  // ── Simulate the rest of the day ─────────────────────────────────────────
  console.log(`\n${hr()}`);
  console.log(`  SIMULATION 09:32 → 15:15 — walk through 5-min bars for each entry`);
  console.log(`${hr()}\n`);

  const entryParts = [];
  entryParts.push(args.confirmBars > 0
    ? `${args.confirmBars}-bar close confirmation`
    : 'SL-M (first wick crossing)');
  if (args.vwap) entryParts.push('VWAP entry filter (close > VWAP at 9:30)');
  const exitParts = ['hard SL', 'T1/T2/T3'];
  if (args.vwap) exitParts.push('VWAP exit (2 consecutive closes wrong side)');
  exitParts.push('15:15 force-flat');
  console.log(`  Entry rule: ${entryParts.join(' + ')}`);
  console.log(`  Exit rule:  ${exitParts.join(' OR ')}\n`);

  const outcomes = [];
  for (const s of selected) {
    const L = s.computedLevels;
    const result = simulateTradeOutcome({
      direction: s.candidate.direction,
      entryTrigger: L.entry,
      sl: L.sl, t1: L.t1, t2: L.t2, t3: L.t3,
      bars: s.bars,
      confirmBars: args.confirmBars,
      useVwap: args.vwap,
    });
    outcomes.push({ symbol: s.candidate.symbol, direction: s.candidate.direction, levels: L, ...result });

    console.log(`  ${s.candidate.symbol} (${s.candidate.direction}):`);
    if (result.outcome === 'CANCELLED_AT_1200') {
      console.log(`    breakout never triggered → SL-M cancelled at 12:00, no trade taken.`);
    } else if (result.outcome === 'BREAKOUT_FAILED_CONFIRMATION') {
      console.log(`    breakout at ${result.breakout_bar} but failed ${args.confirmBars}-bar confirmation:`);
      for (const h of result.confirm_history.slice(0, 8)) {
        const mark = h.confirms ? '✓' : '✗';
        console.log(`      ${mark} ${h.ts}  close=${h.close.toFixed(2)}  ${h.confirms ? 'above trigger' : 'BELOW trigger → reset'}`);
      }
      console.log(`    → NO TRADE TAKEN (saved a -1R loss vs SL-M would have entered)`);
    } else if (result.outcome === 'NO_DATA') {
      console.log(`    no intraday data — cannot simulate.`);
    } else {
      if (result.confirm_history?.length) {
        console.log(`    breakout at ${result.breakout_bar}, confirmation sequence:`);
        for (const h of result.confirm_history.slice(0, 5)) {
          const mark = h.confirms ? '✓' : '✗';
          console.log(`      ${mark} ${h.ts}  close=${h.close.toFixed(2)}`);
        }
      }
      console.log(`    entered at ${result.entry_bar} @ ₹${result.entry_price.toFixed(2)}`);
      const vwapNote = result.vwap_at_exit != null
        ? `  (vwap=${result.vwap_at_exit.toFixed(2)}, ${result.vwap_exit_reason})`
        : '';
      console.log(`    exited  at ${result.exit_bar} @ ₹${result.exit_price.toFixed(2)} → ${result.outcome}${vwapNote}`);
      console.log(`    P&L:    ${result.pnl_pct >= 0 ? '+' : ''}${result.pnl_pct.toFixed(2)}% ${result.r != null ? `(${result.r > 0 ? '+' : ''}${result.r}R)` : ''}`);
    }
    console.log();
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`${hr('═')}`);
  console.log(`  DAY SUMMARY`);
  console.log(`${hr('═')}\n`);
  const triggered = outcomes.filter(o => o.triggered);
  const notTriggered = outcomes.filter(o => !o.triggered);
  const winners = triggered.filter(o => o.pnl_pct > 0);
  const losers  = triggered.filter(o => o.pnl_pct < 0);
  const totalPnl = triggered.reduce((s, o) => s + (o.pnl_pct || 0), 0);
  const avgPnl   = triggered.length ? totalPnl / triggered.length : 0;
  console.log(`  picks selected at 9:32        ${selected.length}`);
  console.log(`  entries triggered             ${triggered.length}`);
  console.log(`  cancelled at 12:00            ${notTriggered.length}`);
  console.log(`  winners / losers              ${winners.length} / ${losers.length}`);
  console.log(`  hit rate                      ${triggered.length ? (winners.length / triggered.length * 100).toFixed(0) : 0}%`);
  console.log(`  sum P&L (% per trade)         ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%`);
  console.log(`  avg P&L per triggered trade   ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%`);
  console.log();
  console.log(`  NOTE: this is a 5-min-bar simulation — real fills will have slippage,`);
  console.log(`  partial booking + breakeven moves will alter outcomes, and the live`);
  console.log(`  monitor's structural-exit may close trades earlier than the SL/target.`);
  console.log();
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
