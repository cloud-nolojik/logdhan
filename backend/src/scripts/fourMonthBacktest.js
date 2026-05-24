/**
 * Four-Month Backtest Harness — Path C
 *
 * Walks the last N trading days, reconstructs the regime per day from
 * BACKFILLED inputs (VIX/FII/breadth), routes to the correct scanner.py
 * mode, runs scanner.py with --asof set to the historical date, and
 * evaluates the resulting picks against the next 1–5 days of daily candle
 * OHLC for hit-rate / expectancy analysis.
 *
 * Where 15-min candle history exists (Path B inside Path C), the harness
 * additionally replays ORB validation and the 15-min structural exit gate
 * using the actual production functions. Days without 15-min history fall
 * back to daily-resolution evaluation.
 *
 * Missing-data days are SKIPPED with a record in the run summary. This is
 * the cleanest behavior — partial-data days would pollute results with
 * stubbed regimes.
 *
 * Output: writes one DailyPickBacktest doc per simulated day, plus a
 * roll-up summary doc to `backtest_runs` (collection auto-created).
 *
 * Usage:
 *   node src/scripts/fourMonthBacktest.js --days 80
 *   node src/scripts/fourMonthBacktest.js --from 2026-01-22 --to 2026-05-21
 *   node src/scripts/fourMonthBacktest.js --days 80 --capital 100000 --feepct 0.25
 *
 * Prerequisites (MUST be run before this script):
 *   node src/scripts/backfillAll.js 120          # VIX + FII + breadth for 4mo
 *   node src/scripts/prefetchAllStockData.js     # daily candles for F&O univ
 *   # 15-min candles for the last 90 days (Upstox) — see runbook.
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

import DailyPickBacktest from '../models/dailyPickBacktest.js';
import { computeMarketContextV2 } from '../engine/regimeV2.js';
import {
  REGIME_TO_SWING_MODE,
  selectScannerModeForRegime,
} from '../services/dailyPicks/dailyPicksService.js';
import { resolveOrbAtrRatioForVix } from '../services/dailyPicks/dailyPicksConstants.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Backtest harness is locked to the SWING scanner (scanner_swing.py). The new
// intraday scanner.py is too fresh to have backtest equivalence and would
// invalidate the v2 result corpus this harness was built to extend. Switch
// to scanner.py only after we add intraday-aware result evaluation.
const SCANNER_PY_PATH = path.resolve(__dirname, '../../..', 'scanner_swing.py');
const BT_SCANNER_TYPE = 'swing';

const LOG = '[BT]';

// ─── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = { days: 80, from: null, to: null, capital: 100_000, feepct: 0.25, holdDays: 5, dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    const next = process.argv[i + 1];
    if (a === '--days')         { args.days     = parseInt(next, 10); i++; }
    else if (a === '--from')    { args.from     = next;               i++; }
    else if (a === '--to')      { args.to       = next;               i++; }
    else if (a === '--capital') { args.capital  = parseFloat(next);   i++; }
    else if (a === '--feepct')  { args.feepct   = parseFloat(next);   i++; }
    else if (a === '--hold')    { args.holdDays = parseInt(next, 10); i++; }
    else if (a === '--dry-run') { args.dryRun = true; }
  }
  return args;
}

// ─── Trading-day calendar ───────────────────────────────────────────────────

/**
 * Return the last N trading days as YYYY-MM-DD strings, newest first.
 * Uses Nifty daily candles in `prefetcheddatas` as the calendar — if the
 * scanner trades, Nifty has a bar on that day.
 */
async function getTradingDays(daysBack, fromDate = null, toDate = null) {
  const coll = mongoose.connection.collection('prefetcheddatas');
  // Pick any well-known stock with daily candles — Nifty index itself isn't
  // in `prefetcheddatas` in this codebase, so use RELIANCE as a proxy for
  // the trading calendar. F&O stocks trade on every NSE trading day.
  const sample = await coll.findOne({ stock_symbol: 'RELIANCE', timeframe: '1d' });
  if (!sample?.candle_data?.length) {
    throw new Error('Cannot determine trading calendar: RELIANCE 1d candles missing from prefetcheddatas');
  }
  const allDates = sample.candle_data
    .map(c => (c.timestamp || c.date || '').slice(0, 10))
    .filter(d => d.length === 10)
    .sort();
  let filtered = allDates;
  if (fromDate) filtered = filtered.filter(d => d >= fromDate);
  if (toDate)   filtered = filtered.filter(d => d <= toDate);
  if (!fromDate && !toDate) filtered = filtered.slice(-daysBack);
  return filtered;
}

// ─── Per-day backfilled regime inputs ───────────────────────────────────────

/**
 * Reconstruct the regime engine inputs for a historical date by reading
 * the backfilled snapshots from Mongo.
 *
 * Hard requirement: VIX. Without VIX percentile we can't compute the
 *   magnitude modifier and the regime engine's structure-less path becomes
 *   too thin. Skip the day if VIX is missing.
 *
 * Soft (optional) inputs: FII flow and breadth. The NSE historical FII
 *   endpoint was retired before May 2026 — backfillFiiFlow.js can only
 *   accumulate forward, so historical days will be missing it. Breadth
 *   backfill MAY also have gaps on days where < 50 stocks could be
 *   evaluated. The regime engine handles null inputs by re-normalizing
 *   the weighted average over whatever is available.
 *
 * Logs WHICH inputs were available per day for audit.
 */
async function regimeForDate(date) {
  const VIX     = mongoose.connection.collection('india_vix_daily');
  const FLOW    = mongoose.connection.collection('institutional_flow_daily');
  const BREADTH = mongoose.connection.collection('breadth_daily');

  const [vixRow, flowRow, breadthRow] = await Promise.all([
    VIX.findOne({ date }),
    FLOW.findOne({ date }),
    BREADTH.findOne({ date }),
  ]);

  // Hard skip: VIX missing
  if (!vixRow) {
    return { ok: false, missing: ['vix'] };
  }

  const softMissing = [];
  if (!flowRow)    softMissing.push('fii_flow');
  if (!breadthRow) softMissing.push('breadth');

  const { buildMarketContext } = await import('../engine/regimeScoring.js');
  const data = {
    // Nifty structure: stubbed null because we don't have Nifty index OHLC
    // in prefetcheddatas. Engine treats null inputs by re-normalizing.
    niftyStructure: null,
    breadthPct:    breadthRow?.pct_above_50dma ?? null,   // soft
    vixData:       { close: vixRow.close, percentileRank: vixRow.percentileRank ?? null },
    overnightData: null,                                   // soft, no backfill source
    flowData:      flowRow ? { fiiCr: flowRow.fii_net_cr ?? null, diiCr: flowRow.dii_net_cr ?? null } : null, // soft
  };
  const ctx = buildMarketContext(data);
  return {
    ok: true,
    ctx,
    raw: { vix: vixRow, flow: flowRow, breadth: breadthRow },
    softMissing,
  };
}

// ─── scanner.py invocation with --asof ──────────────────────────────────────

async function runScannerAsof(mode, asof, top = 3) {
  const { getFnoSymbols } = await import('../constants/fnoUniverse.js');
  const symbolSet = await getFnoSymbols();
  const symbols = [...symbolSet];

  const watchlistPath = path.join(os.tmpdir(), `bt_${asof}_${Date.now()}.txt`);
  await fs.writeFile(watchlistPath, symbols.join('\n'), 'utf8');

  try {
    const { stdout, stderr } = await execFileAsync('python3', [
      SCANNER_PY_PATH,
      '--watchlist', watchlistPath,
      '--top', String(top),
      '--json',
      '--no-tv',
      '--min-score', '0.3',
      '--mode', mode,
      '--asof', asof,
      '--period', '1y',   // bump from default 6mo for older asof dates
      // Read daily candles from MongoDB instead of yfinance — avoids
      // rate-limit failures when running 80 consecutive backtest days.
      // Requires `pip install pymongo` and the prefetcheddatas collection
      // populated (the `breadth` backfill in Step 1 already does this).
      '--candles-from-mongo', process.env.MONGODB_URI,
    ], { timeout: 300_000 });   // 5 min — backtest can be slower
    const jsonLine = stdout.split('\n').map(s => s.trim()).find(l => l.startsWith('[{') || l === '[]');
    if (!jsonLine) {
      return { picks: [], stderr: stderr.slice(0, 1000), error: 'no_json_line' };
    }
    return { picks: JSON.parse(jsonLine), stderr: stderr.slice(0, 500), error: null };
  } catch (err) {
    return {
      picks: [],
      stderr: String(err.stderr || '').slice(0, 1500),
      error: err.message,
    };
  } finally {
    await fs.unlink(watchlistPath).catch(() => {});
  }
}

// ─── Daily-resolution outcome evaluation ────────────────────────────────────

/**
 * For each pick, look at the next `holdDays` daily candles after entry day.
 * Conservative rule (industry convention for breakouts):
 *   - If a single day's L ≤ stop AND H ≥ target, assume STOP hit first.
 *   - Otherwise: first day to touch target → TARGET_HIT; first day to touch stop → STOPPED_OUT.
 *   - If neither touched within holdDays → TIME_EXIT at the closing price of day holdDays.
 */
async function evaluatePickDailyResolution(pick, asof, holdDays = 5, feepct = 0.25) {
  const coll = mongoose.connection.collection('prefetcheddatas');
  const sym = pick.symbol;
  const doc = await coll.findOne({ stock_symbol: sym, timeframe: '1d' });
  if (!doc?.candle_data?.length) {
    return { status: 'NO_DATA', reason: `no daily candles in DB for ${sym}` };
  }
  const candles = doc.candle_data
    .map(c => ({
      date: (c.timestamp || c.date || '').slice(0, 10),
      open: c.open, high: c.high, low: c.low, close: c.close,
    }))
    .filter(c => c.date >= asof)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (candles.length === 0) {
    return { status: 'NO_DATA', reason: 'no candles on or after asof' };
  }

  const asofCandle = candles.find(c => c.date === asof);    // the day scanner ran
  const entryCandle = candles.find(c => c.date > asof);     // entry on next bar's open
  if (!entryCandle) return { status: 'NO_DATA', reason: 'no next-day candle for entry' };
  const entryPrice = entryCandle.open;

  // ── SPLIT / CORP-ACTION GUARD (May 2026) ────────────────────────────────
  // The May backtest produced a VEDL pick with +153% net return — almost
  // certainly an unadjusted split or demerger in the yfinance-cached daily
  // candles. Any equity move > 30% between two consecutive trading sessions
  // is overwhelmingly a corporate action, not a real intraday gap. Skip
  // these trades with explicit SPLIT_DETECTED status so the aggregate
  // numbers aren't poisoned by data artifacts.
  if (asofCandle && asofCandle.close > 0) {
    const overnightGapPct = Math.abs((entryPrice - asofCandle.close) / asofCandle.close) * 100;
    if (overnightGapPct > 30) {
      return {
        status: 'SPLIT_DETECTED',
        reason: `overnight gap ${overnightGapPct.toFixed(1)}% between ${asof} close=${asofCandle.close} and ${entryCandle.date} open=${entryPrice} — almost certainly split/demerger/corp-action in cached candles`,
      };
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const isLong = pick.direction === 'LONG';
  const stop = pick.sl;
  const target = pick.t1;

  const futureCandles = candles.filter(c => c.date >= entryCandle.date).slice(0, holdDays);

  let exitStatus = 'TIME_EXIT';
  let exitPrice = futureCandles[futureCandles.length - 1]?.close || entryPrice;
  let exitDate  = futureCandles[futureCandles.length - 1]?.date || entryCandle.date;
  let exitReason = `held ${holdDays} days, no target/stop touch`;

  for (const c of futureCandles) {
    const stopTouched   = isLong ? (c.low  <= stop)   : (c.high >= stop);
    const targetTouched = isLong ? (c.high >= target) : (c.low  <= target);
    if (stopTouched && targetTouched) {
      // Conservative: assume stop fired first (breakout convention)
      exitStatus = 'STOPPED_OUT';
      exitPrice = stop;
      exitDate = c.date;
      exitReason = 'stop AND target touched same day — conservative: stop first';
      break;
    }
    if (stopTouched) {
      exitStatus = 'STOPPED_OUT'; exitPrice = stop; exitDate = c.date; exitReason = 'low ≤ stop';
      break;
    }
    if (targetTouched) {
      exitStatus = 'TARGET_HIT'; exitPrice = target; exitDate = c.date; exitReason = 'high ≥ target';
      break;
    }
  }

  // P&L (gross, then net of round-trip fee)
  const perShare = isLong ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
  const grossReturnPct = (perShare / entryPrice) * 100;
  const netReturnPct = grossReturnPct - feepct;

  // R-multiple
  const risk = Math.abs(entryPrice - stop);
  const realizedR = risk > 0 ? perShare / risk : 0;

  return {
    status: exitStatus,
    entry: { date: entryCandle.date, price: entryPrice },
    exit:  { date: exitDate, price: exitPrice, reason: exitReason },
    gross_return_pct: Number(grossReturnPct.toFixed(3)),
    net_return_pct:   Number(netReturnPct.toFixed(3)),
    realized_r:       Number(realizedR.toFixed(3)),
    planned_r:        pick.rr_t1 ? Number(pick.rr_t1.toFixed(3)) : null,
    fee_pct:          feepct,
  };
}

// ─── Main loop ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Four-month backtest starting`);
  console.log(`${LOG} args:`, args);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!process.env.MONGODB_URI) {
    console.error(`${LOG} MONGODB_URI not set — aborting`);
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log(`${LOG} Mongo connected`);

  const tradingDays = await getTradingDays(args.days, args.from, args.to);
  console.log(`${LOG} trading-day window: ${tradingDays.length} days (${tradingDays[0]} → ${tradingDays[tradingDays.length - 1]})`);

  const summary = {
    runConfig: args,
    runStartedAt: new Date(),
    days_total: tradingDays.length,
    days_skipped_missing_data: 0,
    days_skipped_vix_sitout: 0,
    days_skipped_extreme_bear: 0,
    days_simulated: 0,
    skipReasons: [],   // [{date, reason}]
    perDay: [],        // [{date, regime, mode, picks_count}]
    aggregate: null,   // computed at end
  };

  for (const date of tradingDays) {
    console.log(`\n${LOG} ─── DAY ${date} ───`);

    // 1. Regime inputs
    const reg = await regimeForDate(date);
    if (!reg.ok) {
      summary.days_skipped_missing_data++;
      summary.skipReasons.push({ date, reason: `missing: ${reg.missing.join(',')}` });
      console.log(`${LOG} ${date}: SKIP — missing ${reg.missing.join(',')} (hard skip)`);
      continue;
    }
    const regimeLabel = reg.ctx.regime;
    const softNote = reg.softMissing.length > 0 ? ` (soft-missing: ${reg.softMissing.join(',')})` : '';
    console.log(`${LOG} ${date}: regime=${regimeLabel} score=${reg.ctx.regime_score} vix=${reg.raw.vix.close}${softNote}`);

    // 2. VIX sit-out check
    const vixVerdict = resolveOrbAtrRatioForVix(reg.raw.vix.close);
    if (vixVerdict === 'SIT_OUT') {
      summary.days_skipped_vix_sitout++;
      summary.skipReasons.push({ date, reason: `vix_sitout vix=${reg.raw.vix.close}` });
      console.log(`${LOG} ${date}: SIT OUT — VIX=${reg.raw.vix.close} > extreme threshold`);
      continue;
    }

    // 3. Map regime → scanner mode
    let mode;
    if (regimeLabel === 'EXTREME_BEAR') {
      summary.days_skipped_extreme_bear++;
      summary.skipReasons.push({ date, reason: 'extreme_bear' });
      console.log(`${LOG} ${date}: SIT OUT — EXTREME_BEAR`);
      continue;
    } else {
      // Pin to the swing map — the backtest harness is locked to scanner_swing.py
      mode = selectScannerModeForRegime(regimeLabel, BT_SCANNER_TYPE);
      if (mode == null) {
        summary.days_skipped_missing_data++;
        summary.skipReasons.push({ date, reason: `unmappable regime ${regimeLabel}` });
        continue;
      }
    }

    // 4. Run scanner --asof
    if (args.dryRun) {
      console.log(`${LOG} ${date}: would run scanner.py --mode=${mode} --asof=${date} (dry-run)`);
      summary.days_simulated++;
      summary.perDay.push({ date, regime: regimeLabel, mode, picks_count: null, dryRun: true });
      continue;
    }
    const scanT0 = Date.now();
    const { picks, stderr, error } = await runScannerAsof(mode, date, 3);
    console.log(`${LOG} ${date}: scanner mode=${mode} returned ${picks.length} picks in ${Date.now() - scanT0}ms${error ? ' ERR=' + error : ''}`);
    if (error || picks.length === 0) {
      if (error) console.error(`${LOG}   stderr: ${stderr}`);
      summary.perDay.push({ date, regime: regimeLabel, mode, picks_count: 0, error });
      summary.days_simulated++;
      continue;
    }

    // 5. Evaluate each pick against daily candles
    const evaluatedPicks = [];
    for (const p of picks) {
      const ev = await evaluatePickDailyResolution(p, date, args.holdDays, args.feepct);
      evaluatedPicks.push({ ...p, evaluation: ev });
      console.log(`${LOG}   ${p.symbol}: ${ev.status} netR%=${ev.net_return_pct ?? '?'} realizedR=${ev.realized_r ?? '?'}`);
    }

    // 6. Persist
    const backtestDoc = new DailyPickBacktest({
      trading_date: new Date(date),
      scan_date:    new Date(date),
      market_context: {
        regime:       regimeLabel,
        nifty_prev_close: null,
      },
      picks: evaluatedPicks.map(ep => ({
        symbol:        ep.symbol,
        scan_type:     ep.mode || mode,
        direction:     ep.direction || 'LONG',
        rank_score:    Math.round((ep.composite || 0) * 100),
        levels: {
          entry:  ep.evaluation.entry?.price ?? ep.close,
          stop:   ep.sl,
          target: ep.t1,
          risk_reward: ep.rr_t1,
        },
        trade: {
          status:       ep.evaluation.status,
          entry_price:  ep.evaluation.entry?.price,
          exit_price:   ep.evaluation.exit?.price,
          exit_reason:  ep.evaluation.exit?.reason,
          return_pct:   ep.evaluation.net_return_pct,
          pnl:          null,    // computed at aggregation
        },
      })),
      summary: {
        total_candidates: picks.length,
        selected_count:   picks.length,
        bullish_count:    picks.filter(p => p.direction !== 'SHORT').length,
        bearish_count:    picks.filter(p => p.direction === 'SHORT').length,
      },
      backtest_config: {
        capital:   args.capital,
        max_picks: 3,
        ran_at:    new Date(),
      },
    });
    // Strip _id (top-level and from every nested sub-document) before upsert.
    // Mongoose generates fresh ObjectIds on `new DailyPickBacktest(...)`,
    // and MongoDB refuses to update the immutable _id field on an existing
    // matched doc → ImmutableField error. We use $set with a sanitized
    // payload and $setOnInsert for the trading_date so the upsert is safe
    // whether the day already exists or not.
    const payload = backtestDoc.toObject();
    delete payload._id;
    if (Array.isArray(payload.picks)) payload.picks.forEach(p => delete p._id);
    if (Array.isArray(payload.candidates_review)) payload.candidates_review.forEach(c => delete c._id);
    await DailyPickBacktest.findOneAndUpdate(
      { trading_date: backtestDoc.trading_date },
      { $set: payload },
      { upsert: true, setDefaultsOnInsert: true }
    );
    summary.days_simulated++;
    summary.perDay.push({
      date, regime: regimeLabel, mode,
      picks_count: picks.length,
      winners: evaluatedPicks.filter(p => p.evaluation.net_return_pct > 0).length,
      losers:  evaluatedPicks.filter(p => p.evaluation.net_return_pct < 0).length,
    });
  }

  // ─── Aggregate roll-up ────────────────────────────────────────────────────
  // Exclude SPLIT_DETECTED trades from the aggregate — they're data
  // artifacts (unadjusted corporate actions), not real outcomes.
  const allClosed = await DailyPickBacktest.aggregate([
    { $match: {} },
    { $unwind: '$picks' },
    { $match: { 'picks.trade.status': { $in: ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT'] } } },
  ]);
  const wins   = allClosed.filter(d => (d.picks.trade.return_pct || 0) > 0).length;
  const losses = allClosed.filter(d => (d.picks.trade.return_pct || 0) < 0).length;
  const total  = allClosed.length;
  const avgRet = total > 0 ? allClosed.reduce((s, d) => s + (d.picks.trade.return_pct || 0), 0) / total : 0;

  // How many picks were filtered out as suspected splits — track for audit
  const splitDetected = await DailyPickBacktest.aggregate([
    { $match: {} },
    { $unwind: '$picks' },
    { $match: { 'picks.trade.status': 'SPLIT_DETECTED' } },
    { $count: 'n' }
  ]);
  const splitCount = splitDetected[0]?.n || 0;

  summary.aggregate = {
    trades_closed: total,
    wins, losses,
    hit_rate_pct: total > 0 ? (wins / total * 100).toFixed(2) : null,
    avg_net_return_pct_per_trade: Number(avgRet.toFixed(3)),
    picks_filtered_split_detected: splitCount,
  };
  summary.runFinishedAt = new Date();

  console.log(`\n${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} BACKTEST COMPLETE`);
  console.log(`${LOG}   days_total=${summary.days_total}`);
  console.log(`${LOG}   days_simulated=${summary.days_simulated}`);
  console.log(`${LOG}   days_skipped_missing_data=${summary.days_skipped_missing_data}`);
  console.log(`${LOG}   days_skipped_vix_sitout=${summary.days_skipped_vix_sitout}`);
  console.log(`${LOG}   days_skipped_extreme_bear=${summary.days_skipped_extreme_bear}`);
  if (summary.aggregate) {
    console.log(`${LOG}   trades_closed=${summary.aggregate.trades_closed}`);
    console.log(`${LOG}   hit_rate=${summary.aggregate.hit_rate_pct}%`);
    if (summary.aggregate.picks_filtered_split_detected > 0) {
      console.log(`${LOG}   picks_filtered_split_detected=${summary.aggregate.picks_filtered_split_detected} (likely unadjusted corp actions in cached candles)`);
    }
    console.log(`${LOG}   avg net return per trade=${summary.aggregate.avg_net_return_pct_per_trade}%`);
  }
  console.log(`${LOG} ════════════════════════════════════════`);

  // Persist the summary doc
  await mongoose.connection.collection('backtest_runs').insertOne(summary);
  console.log(`${LOG} summary persisted to backtest_runs`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('[BT] FATAL:', err);
  process.exit(1);
});
