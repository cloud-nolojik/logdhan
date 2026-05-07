/**
 * Daily Picks Service — Core Orchestrator
 *
 * Handles: scan → enrich → score → levels → intel → select → save → notify (8:30 AM IST)
 *          ORB validation + entry placement (9:15 AM - 10:01 AM, multi-pass)
 *          fill check + SL/target placement (9:45 AM)
 *          order monitoring every 15 min (10:00 AM - 2:45 PM)
 *
 * Standalone from swing trading. Shared infra: ChartInk, Upstox, Kite orders.
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// scanner.py lives at logdhan/scanner.py — 4 dirs up from dailyPicks/
const SCANNER_PY_PATH = path.resolve(__dirname, '../../../..', 'scanner.py');

import { SCAN_LABELS, SCAN_ARCHETYPE } from './dailyPicksScans.js';
import { buildShortlist } from '../shortlist/shortlistService.js';
import { runBreadthSnapshotJob } from '../jobs/breadthSnapshotJob.js';
import { runVixSnapshotJob } from '../jobs/vixSnapshotJob.js';
import { runFiiFlowJob } from '../jobs/fiiFlowJob.js';
import { getDailyAnalysisData } from '../technicalData.service.js';
import { getRegimeWarning } from '../../engine/regime.js';
import DailyPick from '../../models/dailyPick.js';
import ApiUsage from '../../models/apiUsage.js';
import kiteOrderService from '../kiteOrder.service.js';
import kiteOrderEvents from '../kiteOrderEvents.js';
import { isKiteIntegrationEnabled } from '../kiteTradeIntegration.service.js';
import { firebaseService } from '../firebase/firebase.service.js';
import priceCacheService from '../priceCache.service.js';
import MarketHoursUtil from '../../utils/marketHours.js';
import kiteConfig from '../../config/kite.config.js';
import { getISTMidnight, calculatePnl, updateDailyResults, round2, roundToTick, getNseTickSize, delay } from './dailyPicksHelpers.js';
import { collectOpeningRange, validatePicks, fetchOrbVolume } from './orbValidationService.js';
import { checkCircuitBreaker, resetCircuitBreaker, reconcilePositionsOnStartup } from './dailyPicksRiskService.js';
import { filterEarningsStocks } from './earningsFilter.js';
import { checkEventBlackout } from './eventBlackout.js';
// newsSentimentFilter.js is DEPRECATED — scoring now done inline at Step 5.5 using constants below
import { clearIntelCache } from './globalMarketIntel.js';
// scrapeUpstoxNewsForCandidates import removed — Step 6.5 is gone.
// The scraper module itself is still used by the shortlist catalyst signal.
// Intel imports — kept for future re-enable. Currently replaced by checkEconomicCalendar.
// import { fetchGlobalMarketIntel, shouldAvoidTrading, getTradingAdjustment } from './globalMarketIntel.js';
// scanLevels import removed — pure-ORB flow no longer pre-computes structural levels
import { SECTOR_MAPPING } from '../../utils/sectorMapping.js';
// import { mapSectorToIntelKey } from '../../utils/sectorMapping.js'; // used by intel, currently disabled
import {
  GAP_PROTECTION_MAX_PCT,
  SLIPPAGE_BUFFER_PCT,
  PARTIAL_BOOK_PCT,
  PARTIAL_BOOK_QTY_RATIO,
  TRAIL_MIN_PROFIT_PCT,
  TRAIL_LOCK_RATIO,
  TRAIL_MIN_MINUTES,
  TRAIL_START_HOUR,
  SIDEWAYS_EXIT_MINUTES,
  SIDEWAYS_THRESHOLD_PCT,
  BASELINE_ATR_PCT,
  MIN_ATR_MULT,
  MAX_ATR_MULT,
  MAX_PICKS,
  TRAIL_ATR_LOOKBACK,
  // INTEL_STOCK_NEWS_ALIGNED_HIGH, // used by intel, currently disabled
  // INTEL_STOCK_NEWS_OPPOSING_HIGH,
  // INTEL_SECTOR_ALIGNED,
  // INTEL_SECTOR_OPPOSING,
  // EXHAUSTION_PENALTY, // removed — Step 4 now hard-rejects on exhaustion instead of penalizing
  EXHAUSTION_CONSECUTIVE_DAYS,
  EXHAUSTION_EMA20_DIST_ATR,
  EXHAUSTION_EMA20_DIST_ABS_PCT,
  CHASE_MAX_ATR_DIST,
  CHASE_SOFT_PENALTY_START_ATR,
  CHASE_SOFT_PENALTY_MAX_PTS,
  // NR7_BONUS, // removed — NR7 scans no longer in pipeline
  // NR7_NEUTRAL_BONUS,
  MAX_COUNTER_REGIME_PICKS, // kept: selectDiversePicks still references it (dead branch now, harmless)
  // COUNTER_REGIME_MIN_SCORE, // removed — Step 4 hard-rejects counter-regime, no threshold needed
} from './dailyPicksConstants.js';
import { computeDynamicTrail, checkPartialBooking, checkSidewaysExit } from './tradingDecisions.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_DAILY_PICKS = MAX_PICKS; // from shared constants (currently 3)
const TARGET_PCT = 2.0;
const LOG = '[DAILY-PICKS]';

// Note: MIN_SCORE / SHORTLIST_COMPOSITE_BONUS_MAX are gone.
// Step 4 is now a pass/reject gate filter — no 0-100 score to compare against.
// rank_score on survivors is the shortlist composite_score × 100.

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_OUTPUT_TOKENS = 5000;

// Multi-pass ORB constants
const MAX_ORB_PASS = 3;
const ORB_PASS_LABELS = { 1: '15-min (9:30)', 2: '30-min (9:46)', 3: '45-min (10:01)' };
// nifty_alignment removed from permanent — Nifty direction changes throughout morning,
// a 9:30 AM relief rally doesn't invalidate the thesis at 9:46 or 10:01
// gap_direction removed from permanent — gap-fade path: if stock gaps against direction
// but LTP fades back through original entry by Pass 2/3, the trade thesis is alive
const PERMANENT_FAIL_CHECKS = ['gap_check', 'no_orb_data'];

let anthropic = null;
function getAnthropicClient() {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCANNER.PY INTEGRATION
// Calls scanner.py (recovery-breakout screener) on the full F&O universe.
// Returns picks mapped to the DailyPick shape with pre-computed levels (entry,
// stop, target from structural pivots). Replaces Steps 0–6.
// ═══════════════════════════════════════════════════════════════════════════════

async function runScannerPy() {
  const { getFnoSymbols } = await import('../../constants/fnoUniverse.js');
  const symbolSet = await getFnoSymbols();
  const symbols = [...symbolSet];

  // Write watchlist to a temp file — scanner.py reads one symbol per line
  const watchlistPath = path.join(os.tmpdir(), `logdhan_fno_${Date.now()}.txt`);
  await fs.writeFile(watchlistPath, symbols.join('\n'), 'utf8');

  console.log(`${LOG} [Scanner] Running scanner.py on ${symbols.length} F&O symbols (path=${SCANNER_PY_PATH})...`);
  const t0 = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync('python3', [
      SCANNER_PY_PATH,
      '--watchlist', watchlistPath,
      '--top', String(MAX_DAILY_PICKS),
      '--json',
      '--no-tv',
      '--min-score', '0.3',
    ], { timeout: 180_000 }); // 3 min max — yfinance batch can be slow on 400 symbols

    if (stderr) console.warn(`${LOG} [Scanner] stderr: ${stderr.slice(0, 800)}`);
    console.log(`${LOG} [Scanner] Done in ${Date.now() - t0}ms`);

    // stdout has progress lines ("[scanner] N symbols...") + one JSON array line
    const jsonLine = stdout.split('\n').map(l => l.trim()).find(l => l.startsWith('[{') || l === '[]');
    if (!jsonLine) {
      console.warn(`${LOG} [Scanner] No JSON array found in stdout. stdout=${stdout.slice(0, 400)}`);
      return [];
    }

    const raw = JSON.parse(jsonLine); // array of Score dicts from scanner.py
    console.log(`${LOG} [Scanner] ${raw.length} picks returned: ${raw.map(p => `${p.symbol}(${p.composite?.toFixed(2)})`).join(', ')}`);

    // Pick the first target (t1 → t2 → t3) that achieves at least 1:1 R:R.
    // T1 is often the nearest pivot and sits just above price — terrible R:R.
    // T2/T3 are wider levels that usually give a sensible reward.
    const MIN_RR = 1.0;
    function pickTarget(s) {
      const risk = s.close - s.sl; // always positive for LONG (sl < close)
      const candidates = [
        { t: s.t1, pct: s.t1_pct, rr: s.rr_t1, label: 't1' },
        { t: s.t2, pct: s.t2_pct, rr: s.rr_t2, label: 't2' },
        { t: s.t3, pct: s.t3_pct, rr: s.rr_t3, label: 't3' },
      ].filter(c => c.t && c.t > s.close);
      const viable = candidates.find(c => (c.t - s.close) >= risk * MIN_RR);
      const chosen = viable || candidates[candidates.length - 1]; // fallback: widest available
      if (!viable) console.warn(`${LOG} [Scanner] ${s.symbol}: no target ≥ 1:1 R:R — using ${chosen?.label} (rr=${chosen?.rr?.toFixed(2)})`);
      return chosen || { t: s.t1, pct: s.t1_pct, rr: s.rr_t1, label: 't1' };
    }

    // Map scanner.py Score → internal pick shape
    return raw.map(s => {
      const tgt = pickTarget(s);
      return {
      symbol: s.symbol,
      stock_name: s.symbol,
      instrument_key: null,
      scan_type: 'recovery_breakout',
      direction: 'LONG', // scanner.py is a bullish recovery-breakout screener
      rank_score: Math.round((s.composite || 0) * 100),
      levels: {
        entry:       s.close,
        stop:        s.sl,
        target:      tgt.t,
        target2:     s.t2 || null,
        target3:     s.t3 || null,
        risk_pct:    s.sl_pct,
        reward_pct:  tgt.pct,
        risk_reward: tgt.rr,
        entry_type:  'market',
        mode:        'scanner',
        source:      `scanner.py | sl_src=${s.sl_src} | tgt_src=${tgt.label}`,
      },
      scan_scores: {
        volume_ratio:       round2(s.volume_spike || 0),
        rsi:                round2(s.rsi || 0),
        atr_pct:            s.atr && s.close ? round2((s.atr / s.close) * 100) : null,
        close_in_range_pct: Math.round((s.range_pos || 0) * 100),
        avg_volume_50d:     null, // not provided by scanner.py
      },
      _ohlcv: {
        atr:   s.atr,
        close: s.close,
      },
    };
  });
  } finally {
    await fs.unlink(watchlistPath).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR — 8:30 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run daily picks scan, enrich, score, save, and notify.
 * Called at 8:30 AM IST before market open.
 */
async function runDailyPicks(options = {}) {
  const { dryRun = false, allowOutdatedCandle = false } = options;
  const startTime = Date.now();

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Starting daily picks scan${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`${LOG} ════════════════════════════════════════`);

  // Reset circuit breaker and intel cache at start of new trading day
  resetCircuitBreaker();
  clearIntelCache();

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // SCANNER.PY — Steps 0–6 replaced by recovery-breakout screener
    //
    // scanner.py runs on the full F&O universe (yfinance, 6mo history) and
    // returns top-N picks with pre-computed entry/stop/target from structural
    // pivots. The ORB entry flow is bypassed — orders are placed at market open
    // in validateAndPlaceEntries (MARKET order, balance.usableIntraday sizing).
    // ═══════════════════════════════════════════════════════════════════════
    const picksWithLevels = await runScannerPy();
    // compat aliases used by Step 7/8 logging
    const enriched  = picksWithLevels;
    const scored    = picksWithLevels;
    const allViable = picksWithLevels;

    const marketContext = {
      regime:         'SCANNER',
      regime_score:   1.0,
      playbook:       'recovery_breakout',
      max_trades:     MAX_DAILY_PICKS,
      size_multiplier: 1,
      inputs:         { source: 'scanner.py' },
      decided_at:     new Date().toISOString(),
    };

    if (picksWithLevels.length === 0) {
      console.log(`${LOG} [Scanner] No picks above threshold — saving empty doc.`);
      const emptyDoc = await saveToDB(marketContext, [], { candidates: [], bullish_count: 0, bearish_count: 0 });
      await sendNotification(marketContext, [], emptyDoc);
      return { success: true, picks: 0, doc: emptyDoc };
    }

    const scanResult = {
      candidates:           picksWithLevels,
      bullish_count:        picksWithLevels.filter(p => p.direction === 'LONG').length,
      bearish_count:        picksWithLevels.filter(p => p.direction === 'SHORT').length,
      shortlist_date:       null,
      shortlist_raw_symbols: [],
      neutral_dropped:      [],
    };

    const candidatesReview = picksWithLevels.map(p => ({
      symbol:           p.symbol,
      scan_type:        p.scan_type,
      direction:        p.direction,
      rank_score:       p.rank_score,
      candle:           { close: p._ohlcv?.close },
      indicators:       { rsi: p.scan_scores?.rsi, atr: p._ohlcv?.atr },
      levels:           p.levels,
      status:           'selected',
      rejection_reason: null,
    }));

    // No AI insights in scanner path
    const picksWithInsights = picksWithLevels;

    console.log(`${LOG} [Scanner] ${picksWithLevels.length} picks selected: ${picksWithLevels.map(p => `${p.symbol}(${p.rank_score})`).join(', ')}`);

    // ─── DISABLED: Old Steps 0–6 (regime snapshots, shortlist, enrich, gate filter, select)
    // Preserved below for reference — remove after scanner.py path is validated.
    // eslint-disable-next-line no-constant-condition
    if (false) {
    // NOTE: Global intel now runs AFTER shortlist + enrichment + scoring + levels
    // so we can pass viable candidate symbols for stock-specific Indian market analysis.
    // See Step 5.5 below.

    // ───────────────────────────────────────────────────────────────────────
    // Step 0: Refresh Regime v2 data snapshots (inline — no separate cron jobs).
    //
    // Three data sources are upserted into their Mongo collections before the
    // regime compute reads them in Step 1:
    //   • institutional_flow_daily  (prev-day FII/DII from NSE — ~1–3s)
    //   • india_vix_daily           (prev-day India VIX close from NSE — ~1–3s)
    //   • breadth_daily             (% Nifty 500 above 50-DMA — TWO ChartInk
    //                                 scans, ~2–5s total — replaced the earlier
    //                                 500-stock Upstox sweep)
    //
    // All three run in parallel. Each is fail-soft: if one fails, we log and
    // continue — Regime v2's fetchers are null-safe and will reweight the
    // score across whichever inputs are available.
    // ───────────────────────────────────────────────────────────────────────
    console.log(`${LOG} [Step 0] Refreshing regime data snapshots (fii, vix, breadth) in parallel...`);
    const step0T0 = Date.now();
    const [fiiSettled, vixSettled, breadthSettled] = await Promise.allSettled([
      runFiiFlowJob(),
      runVixSnapshotJob(),
      runBreadthSnapshotJob(),
    ]);
    const step0Ms = Date.now() - step0T0;
    const snapshotStatus = {
      fii:     fiiSettled.status     === 'fulfilled' ? 'ok' : `failed: ${fiiSettled.reason?.message || 'unknown'}`,
      vix:     vixSettled.status     === 'fulfilled' ? 'ok' : `failed: ${vixSettled.reason?.message || 'unknown'}`,
      breadth: breadthSettled.status === 'fulfilled' ? 'ok' : `failed: ${breadthSettled.reason?.message || 'unknown'}`,
    };
    console.log(`${LOG} [Step 0] Snapshots done in ${step0Ms}ms — ${JSON.stringify(snapshotStatus)}`);
    if (fiiSettled.status     === 'rejected') console.error(`${LOG} [Step 0] fii snapshot failed:`,     fiiSettled.reason);
    if (vixSettled.status     === 'rejected') console.error(`${LOG} [Step 0] vix snapshot failed:`,     vixSettled.reason);
    if (breadthSettled.status === 'rejected') console.error(`${LOG} [Step 0] breadth snapshot failed:`, breadthSettled.reason);

    // Step 0.5 — Event blackout calendar
    // Hard block before regime compute. Budget day, RBI MPC, major election
    // results — the historical priors the system is tuned against don't hold
    // on these days.
    const blackout = checkEventBlackout();
    if (blackout.blocked) {
      const reason = `EVENT_BLACKOUT — ${blackout.reason} (${blackout.date})`;
      console.log(`${LOG} ⛔ ${reason}. Sitting out today.`);
      const haltCtx = {
        regime: 'HALT', regime_score: null, playbook: 'halt',
        halt_reason: reason, max_trades: 0, size_multiplier: 0,
        score_floor_override: null, inputs: null,
        decided_at: new Date().toISOString(),
      };
      const doc = await saveToDB(haltCtx, [], { candidates: [], bullish_count: 0, bearish_count: 0 });
      await sendNotification(haltCtx, [], doc);
      return { success: true, picks: 0, doc, halted: true, reason };
    }

    // Step 1: Market context (continuous regime score — 5 inputs: structure, breadth, volatility, overnight, flow)
    //
    // REGIME_VERSION env flag (kill-switch, not a v1 rollback — v1 is deleted):
    //   'v2' (default)  → run the standard v2 compute
    //   'off'           → return HALT marketContext, no trades today
    //   anything else   → treated as 'off' (fail-closed)
    const REGIME_VERSION = (process.env.REGIME_VERSION || 'v2').toLowerCase();
    let marketContext;
    if (REGIME_VERSION === 'v2') {
      const { computeMarketContextV2 } = await import('../../engine/regimeV2.js');
      marketContext = await computeMarketContextV2();
    } else {
      console.warn(`${LOG} [Step 1] REGIME_VERSION="${REGIME_VERSION}" — regime disabled, HALTING pipeline`);
      marketContext = {
        regime: 'HALT',
        regime_score: null,
        playbook: 'halt',
        halt_reason: `regime_disabled (REGIME_VERSION=${REGIME_VERSION})`,
        max_trades: 0,
        size_multiplier: 0,
        score_floor_override: null,
        inputs: null,
        decided_at: new Date().toISOString(),
      };
    }
    console.log(`${LOG} Market regime: ${marketContext.regime} score=${marketContext.regime_score} playbook=${marketContext.playbook}`);
    console.log(`${LOG} [Step 1] marketContext:`, JSON.stringify(marketContext, null, 2));

    // HALT — insufficient data or extreme volatility
    if (marketContext.regime === 'HALT') {
      const reason = `HALT — ${marketContext.halt_reason || 'unknown'}`;
      console.log(`${LOG} ⛔ ${reason}. Sitting out today.`);
      const doc = await saveToDB(marketContext, [], { candidates: [], bullish_count: 0, bearish_count: 0 });
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc, halted: true, reason };
    }

    // Gap-fade playbook gated off (max_trades=0) until the playbook is live
    if (marketContext.playbook === 'gap_fade' && marketContext.max_trades === 0) {
      const reason = 'gap_fade_playbook_disabled — gap-fade conditions detected; playbook not yet live';
      console.log(`${LOG} ⛔ ${reason}. Sitting out today.`);
      const doc = await saveToDB(marketContext, [], { candidates: [], bullish_count: 0, bearish_count: 0 });
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc, halted: true, reason };
    }

    // Step 2: Build shortlist from F&O universe (replaces legacy ChartInk scans)
    // buildShortlist produces a top-N ranked list using 5 signals: catalyst, gap, RS,
    // sector-top-3, direction-fit. This call both persists the ShortlistWatchlist doc
    // (for audit) AND returns the same candidates adapted to the downstream shape.
    const scanResult = await runShortlistScan(marketContext);
    console.log(`${LOG} Total candidates: ${scanResult.candidates.length} (${scanResult.bullish_count}B / ${scanResult.bearish_count}Be)`);
    console.log(`${LOG} [Step 2] shortlist top-${scanResult.candidates.length} (${scanResult.signal_status ? JSON.stringify(scanResult.signal_status) : 'no signal_status'})`);

    if (scanResult.candidates.length === 0) {
      console.log(`${LOG} No candidates found. Saving empty doc and notifying.`);
      const doc = await saveToDB(marketContext, [], scanResult);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 2.5: Earnings/event filter — remove stocks with upcoming board meetings
    // Runs BEFORE enrichment to avoid wasting Upstox API calls on stocks we'll discard
    const { filtered: earningsFiltered, removed: earningsRemoved } = await filterEarningsStocks(scanResult.candidates);
    if (earningsRemoved.length > 0) {
      console.log(`${LOG} [Step 2.5] Earnings filter: ${earningsRemoved.length} removed (${earningsRemoved.map(r => r.symbol).join(', ')}), ${earningsFiltered.length} remaining`);
    }

    if (earningsFiltered.length === 0) {
      console.log(`${LOG} All candidates removed by earnings filter. Saving empty doc.`);
      const doc = await saveToDB(marketContext, [], scanResult);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 3: Enrich with OHLCV + indicators
    const enriched = await enrichCandidates(earningsFiltered, { allowOutdatedCandle });
    console.log(`${LOG} Enriched ${enriched.length}/${earningsFiltered.length} candidates`);

    if (enriched.length === 0) {
      console.log(`${LOG} All candidates failed enrichment. Saving empty doc.`);
      const doc = await saveToDB(marketContext, [], scanResult);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 4: Gate filter (replaces the old 0-100 technical scorer).
    // The shortlist already produced the composite ranking; here we only apply
    // four execution sanity gates (liquidity, ATR envelope, chase guard,
    // exhaustion) plus a hard counter-regime block. Survivors keep their
    // shortlist composite as rank_score.
    const scored = scoreCandidates(enriched, marketContext);
    console.log(`${LOG} Filtered: ${scored.length} candidates passed gates`);

    if (scored.length === 0) {
      console.log(`${LOG} No picks above minimum score.`);
      const doc = await saveToDB(marketContext, [], scanResult, []);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // ───────────────────────────────────────────────────────────────────────
    // Step 5 (REMOVED — pure-ORB design).
    //
    // The old Step 5 pre-computed structural entry/stop/target from yesterday's
    // PDH/PDL/pivots/1H swing zones and applied an R:R + 1H-conflict pre-gate.
    // In the pure-ORB design those price levels are computed live at 9:30 AM
    // from the opening range (see orbValidationService → validateAndPlaceEntries).
    //
    // Here we simply promote every Step-4 survivor to "viable" and build the
    // review entries. No levels are attached at this stage; `pick.levels` will
    // be populated at ORB validation time.
    // ───────────────────────────────────────────────────────────────────────
    const allViable = [...scored];
    const candidatesReview = scored.map(c => {
      const _ohlcv = c._ohlcv || {};
      return {
        symbol: c.symbol,
        scan_type: c.scan_type,
        direction: c.direction,
        rank_score: c.rank_score,
        candle: {
          open: _ohlcv.open, high: _ohlcv.high, low: _ohlcv.low,
          close: _ohlcv.close, prev_close: _ohlcv.prev_close, volume: _ohlcv.volume,
        },
        indicators: {
          ema20: _ohlcv.ema20, atr: _ohlcv.atr, rsi: c.scan_scores?.rsi || 0,
        },
        levels: null,              // filled in at ORB time (9:30)
        status: 'viable',           // no pre-market level rejection anymore
        rejection_reason: null,
      };
    });
    console.log(`${LOG} [Step 5] Skipped pre-market levels computation — ${allViable.length} picks forwarded to selection. Entry/stop/target will be set from ORB at 09:30.`);

    // ── Step 5.5 (DISABLED): Global Market Intelligence via Claude/OpenAI ──
    // Commented out — the scoring pipeline captures sector/macro from live price data.
    // Sector regimes (Step 1), SECTOR_SCORE_MAP (Step 4), and SGX sentiment already
    // provide the same signal that Claude was restating from web search.
    // The only unique value was shouldAvoidTrading() — now replaced by checkEconomicCalendar().
    // To re-enable: uncomment below and wire a proper news API for stock_specific.
    /*
    const viableSymbols = allViable.map(v => v.symbol);
    let globalIntel;
    try {
      globalIntel = await fetchGlobalMarketIntel(undefined, viableSymbols, marketContext.sgx_data);
    } catch (intelErr) {
      const doc = await saveToDB(marketContext, [], scanResult, candidatesReview, null);
      return { success: false, picks: 0, doc, error: `Global intel failed: ${intelErr.message}` };
    }
    // ... sector adjustments, stock news, direction filter ...
    */

    // Select top picks with scan-type diversity:
    // Pick the best from each scan type first, then fill remaining slots by score.
    // Use combined regime's maxTrades if available, otherwise fall back to MAX_DAILY_PICKS
    const maxPicksToday = marketContext.max_trades != null ? Math.min(marketContext.max_trades, MAX_DAILY_PICKS) : MAX_DAILY_PICKS;
    let picksWithLevels = [];
    if (allViable.length > 0) {
      console.log(`${LOG} [Step 6] Max picks today: ${maxPicksToday} (regime=${marketContext.regime}, cap=${MAX_DAILY_PICKS})`);
      picksWithLevels = selectDiversePicks(allViable, maxPicksToday, marketContext.regime);
      console.log(`${LOG} Selected ${picksWithLevels.length} picks (diversity-weighted) from ${allViable.length} viable`);
    } else {
      console.log(`${LOG} [Step 6] No viable shortlist candidates — skipping selection.`);
    }

    // ─── Quality-over-quota gate: abort if the system found too few setups ──
    // If fewer than 50% of today's max_trades slots have quality picks, sit
    // out entirely. A STRONG_BULL day with max_trades=3 that yielded only 1
    // pick means everything is either extended or unclean — the marginal 1
    // pick is likely negative-expectancy. A pro reads this: "my system is
    // telling me this isn't my day."
    const MIN_PICKS_RATIO = 0.5;  // need at least 50% of max_trades to trade
    const minPicksRequired = Math.ceil(maxPicksToday * MIN_PICKS_RATIO);
    if (maxPicksToday > 0 && picksWithLevels.length > 0 && picksWithLevels.length < minPicksRequired) {
      console.log(`${LOG} [Step 6] ⛔ Quality-over-quota abort: ${picksWithLevels.length} picks < ${minPicksRequired} required (${Math.round(MIN_PICKS_RATIO*100)}% of max_trades=${maxPicksToday})`);
      console.log(`${LOG} [Step 6] Sitting out today — marginal single pick on a ${marketContext.regime} day is negative EV`);
      const reason = `too_few_setups: ${picksWithLevels.length}/${maxPicksToday} survived (needed ${minPicksRequired})`;
      // Save an intentional-sit-out doc so the audit trail shows why we skipped
      const haltedCtx = { ...marketContext, halt_reason: reason };
      const doc = await saveToDB(haltedCtx, [], scanResult, candidatesReview);
      await sendNotification(haltedCtx, [], doc);
      return { success: true, picks: 0, doc, halted: true, reason };
    }

    // Sync candidatesReview with intel-adjusted scores and mark selected picks
    const selectedSymbols = new Set(picksWithLevels.map(p => p.symbol));
    const viableScoreMap = {};
    for (const v of allViable) viableScoreMap[v.symbol] = v.rank_score;
    for (const entry of candidatesReview) {
      // Update rank_score to reflect intel adjustments (sector/stock news ±)
      if (viableScoreMap[entry.symbol] !== undefined) {
        entry.rank_score = viableScoreMap[entry.symbol];
      }
      if (entry.status === 'viable' && selectedSymbols.has(entry.symbol)) {
        entry.status = 'selected';
      }
    }

    // ─── Post-filter stamp back to ShortlistWatchlist ──────────────────────
    // Build a verdict per shortlist symbol based on the downstream journey:
    //   selected        — made it into picksWithLevels (top max_trades)
    //   not_selected    — passed gates (allViable/scored) but didn't win a slot
    //   dropped_*       — various drops along 2.5 / 3 / 4
    //   dropped_neutral_direction — adapter drop in Step 2 (NEUTRAL)
    //
    // Reject-reason → post_filter_status mapping for Step 4 gates:
    const GATE_REJECT_TO_STATUS = {
      counter_regime: 'dropped_gate_counter_regime',
      g1_turnover:    'dropped_gate_liquidity',
      g1_volume:      'dropped_gate_liquidity',
      g2_atr:         'dropped_gate_atr',
      g3_chase:       'dropped_gate_chase',
      g4_exhaustion:  'dropped_gate_exhaustion',
      no_ohlcv:       'dropped_no_ohlcv',
    };

    try {
      if (scanResult.shortlist_date && scanResult.shortlist_raw_symbols?.length) {
        const statusMap = new Map();

        // 1. NEUTRAL-dropped by adapter
        for (const sym of (scanResult.neutral_dropped || [])) {
          statusMap.set(sym, 'dropped_neutral_direction');
        }

        // 2. Earnings-filtered (Step 2.5)
        for (const r of (earningsRemoved || [])) {
          if (r?.symbol) statusMap.set(r.symbol, 'dropped_earnings');
        }

        // 3. Not enriched (Step 3 missing from analysisData)
        //    earningsFiltered went into enrichCandidates; anything in earningsFiltered
        //    that isn't in `enriched` is a no-OHLCV drop.
        const enrichedSymbols = new Set((enriched || []).map(c => c.symbol));
        for (const c of (earningsFiltered || [])) {
          if (!enrichedSymbols.has(c.symbol) && !statusMap.has(c.symbol)) {
            statusMap.set(c.symbol, 'dropped_no_ohlcv');
          }
        }

        // 4. Step 4 gate rejects
        const rejMap = scored._rejectedBySymbol || new Map();
        for (const [sym, reason] of rejMap.entries()) {
          const status = GATE_REJECT_TO_STATUS[reason] || 'dropped_no_ohlcv';
          if (!statusMap.has(sym)) statusMap.set(sym, status);
        }

        // 5. Step 4 survivors — either selected or not_selected
        for (const v of allViable) {
          statusMap.set(v.symbol, selectedSymbols.has(v.symbol) ? 'selected' : 'not_selected');
        }

        const { default: ShortlistWatchlist } = await import('../../models/shortlistWatchlist.js');
        const res = await ShortlistWatchlist.stampPostFilter(scanResult.shortlist_date, statusMap);
        console.log(`${LOG} [Step 6] Stamped ShortlistWatchlist: ${res.modifiedCount}/${res.matchedCount} candidates tagged (date=${scanResult.shortlist_date})`);
      }
    } catch (stampErr) {
      console.error(`${LOG} [Step 6] ShortlistWatchlist stamp failed (non-fatal): ${stampErr.message}`);
    }

    // Step 6: Generate AI insights (non-fatal) — skip if no viable picks
    let picksWithInsights = [];
    if (picksWithLevels.length > 0) {
      console.log(`${LOG} [Step 6] Generating AI insights for ${picksWithLevels.length} picks: ${picksWithLevels.map(p => p.symbol).join(', ')}`);
      picksWithInsights = await generatePickInsights(picksWithLevels, marketContext);
      console.log(`${LOG} [Step 6] AI insights done: ${picksWithInsights.filter(p => p.ai_generated).length}/${picksWithInsights.length} generated`);
    } else {
      console.log(`${LOG} [Step 6] No viable shortlist picks — skipping AI insights.`);
    }

    // Step 6.5 (news pipeline) REMOVED. News picks were advisory-only — never
    // traded — so they're not part of the automation path.
    } // end disabled Steps 0–6
    // ─────────────────────────────────────────────────────────────────────────


    // Step 7: Save to DB
    console.log(`${LOG} [Step 7] Saving to DB: ${picksWithInsights.length} picks`);
    const doc = await saveToDB(marketContext, picksWithInsights, scanResult, candidatesReview, null);
    console.log(`${LOG} [Step 7] Saved DailyPick doc: ${doc._id}`);
    for (const p of doc.picks) {
      const ss = p.scan_scores;
      console.log(`${LOG} [Step 7] ${p.symbol}: entry=₹${p.levels?.entry} stop=₹${p.levels?.stop} target=₹${p.levels?.target} vol_ratio=${ss?.volume_ratio} rsi=${ss?.rsi} atr_pct=${ss?.atr_pct}%`);
    }

    // Step 7.5: Place AMO MARKET orders immediately (scanner path)
    // Orders queue at the broker and execute at the 9:08 AM pre-open auction.
    // This avoids any separate 9:30 AM scheduled step — by the time market opens,
    // orders are already in the system. The 9:30 validateAndPlaceEntries call
    // becomes a no-op (picks are already ORDER_PLACED, eligiblePicks filter skips them).
    if (picksWithInsights.length > 0) {
      console.log(`${LOG} [Step 7.5] Placing AMO MARKET orders for ${picksWithInsights.length} picks...`);
      try {
        const amoResult = await placePreMarketEntries(doc);
        console.log(`${LOG} [Step 7.5] AMO done: ${amoResult.ordersPlaced ?? 0} orders placed`);
      } catch (amoErr) {
        console.error(`${LOG} [Step 7.5] AMO placement failed (non-fatal — picks saved, manual entry possible): ${amoErr.message}`);
      }
    }

    // Step 8: Send notification
    console.log(`${LOG} [Step 8] Sending notification...`);
    await sendNotification(marketContext, picksWithInsights, doc);

    const elapsed = Date.now() - startTime;
    console.log(`${LOG} ════════════════════════════════════════`);
    console.log(`${LOG} ✅ PIPELINE COMPLETE in ${elapsed}ms`);
    console.log(`${LOG} Pipeline summary: ${scanResult.candidates.length} scanned → ${picksWithInsights.length} picks selected → AMO orders queued`);
    for (const p of picksWithInsights) {
      console.log(`${LOG} FINAL PICK: ${p.symbol} | ${p.scan_type} | ${p.direction} | score=${p.rank_score} | entry=₹${p.levels?.entry} stop=₹${p.levels?.stop} target=₹${p.levels?.target}`);
    }
    console.log(`${LOG} ════════════════════════════════════════`);
    return { success: true, picks: picksWithInsights.length, doc };

  } catch (error) {
    console.error(`${LOG} ❌ Fatal error in runDailyPicks:`, error.message);

    // Send push notification on pipeline failure
    try {
      const adminUserId = kiteConfig.ADMIN_USER_ID;
      if (adminUserId) {
        await firebaseService.sendToUser(adminUserId,
          'Daily Picks: PIPELINE FAILED',
          error.message,
          { type: 'DAILY_PICKS_ERROR', route: '/daily-picks' }
        );
        console.log(`${LOG} Failure notification sent`);
      }
    } catch (notifErr) {
      console.error(`${LOG} Failure notification also failed:`, notifErr.message);
    }

    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: BUILD SHORTLIST (replaces legacy ChartInk scans)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The shortlist engine (services/shortlist/shortlistService.js) is the single
// source of pre-market candidates. It ranks the entire F&O universe by a 5-signal
// composite: catalyst (news), gap (sector×SGX + catalyst), relative strength
// (5-day z-score vs Nifty), sector-top-3, and direction-fit vs marketContext.
//
// This adapter calls buildShortlist() and maps each shortlist candidate into the
// shape Steps 2.5 onward already expect (symbol, stock_name, scan_type, direction,
// sector, chartink_data placeholder). The shortlist result is also persisted to
// its own Mongo collection (`shortlist_watchlists`) for audit, separate from the
// DailyPick document written in Step 7.

/**
 * Map a shortlist candidate's dominant signal + direction to a scan_type.
 * scan_type is consumed by Step 4 (scoring bonus), Step 5 (levels engine
 * archetype via SCAN_ARCHETYPE), and Step 6 (diversity selection).
 */
function deriveScanType(candidate) {
  const s = candidate.signals || {};
  const dir = candidate.direction === 'SHORT' ? 'short' : 'long';

  // Prefer the strongest informative signal as the scan_type label.
  if (s.catalyst === 1)                     return `shortlist_catalyst`;
  if (s.gap !== null && s.gap >= 0.6)       return `shortlist_gap_${dir}`;
  if (s.rs !== null && s.rs >= 0.6)         return `shortlist_rs_${dir}`;
  if (s.sector_top3 === 1)                  return `shortlist_sector`;
  // Fallback: pure directional ranking
  return `shortlist_${dir}`;
}

async function runShortlistScan(marketContext) {
  console.log(`${LOG} [Step 2] buildShortlist(regime=${marketContext.regime} score=${marketContext.regime_score} playbook=${marketContext.playbook})`);

  const shortlistDoc = await buildShortlist(marketContext, {
    outputSize: 50,
    topSectorsN: 3,
    persist: true,
  });

  const raw = shortlistDoc?.candidates || [];

  // Adapt shortlist candidates to the downstream shape. Fields Step 3+ expect:
  //   symbol, stock_name, scan_type, direction, sector, chartink_data (placeholder)
  // Extra fields carried through for audit / scoring:
  //   _shortlist_signals, _composite_score, _reasons, _catalyst_meta
  const candidates = [];
  let bullishCount = 0;
  let bearishCount = 0;
  // Track symbols dropped by the adapter (NEUTRAL direction) so the post-filter
  // stamp can flag them in the ShortlistWatchlist doc.
  const neutralDropped = new Set();

  for (const c of raw) {
    // Skip NEUTRAL direction — we only trade directional setups
    if (!c.direction || c.direction === 'NEUTRAL') {
      if (c.trading_symbol) neutralDropped.add(c.trading_symbol);
      continue;
    }

    const scan_type = deriveScanType(c);

    const adapted = {
      symbol: c.trading_symbol,
      stock_name: c.name,
      instrument_key: c.instrument_key,
      scan_type,
      direction: c.direction,
      sector: c.sector || 'OTHER',
      // Chartink parity fields — kept as a placeholder so downstream logging
      // that references candidate.chartink_data doesn't crash. Real OHLCV
      // comes from Step 3 (Upstox enrichment).
      chartink_data: {},
      scan_matches: [scan_type],
      scan_count: 1,
      // Audit trail
      _shortlist_signals: c.signals || null,
      _composite_score: c.composite_score,
      _reasons: c.reasons || [],
      _catalyst_meta: c.catalyst_meta || null,
    };

    candidates.push(adapted);
    if (adapted.direction === 'LONG') bullishCount++;
    else bearishCount++;
  }

  console.log(`${LOG} [Step 2] Shortlist produced ${candidates.length} directional candidates (${bullishCount}B / ${bearishCount}Be). signal_status=${JSON.stringify(shortlistDoc?.signal_status || {})}`);
  if (shortlistDoc?.warnings?.length) {
    for (const w of shortlistDoc.warnings) console.warn(`${LOG} [Step 2] warning: ${w}`);
  }

  return {
    candidates,
    bullish_count: bullishCount,
    bearish_count: bearishCount,
    signal_status: shortlistDoc?.signal_status || null,
    shortlist_date: shortlistDoc?.date || null,
    shortlist_stats: shortlistDoc?.stats || null,
    // Extra audit trail for stampPostFilter
    shortlist_raw_symbols: raw.map(c => c.trading_symbol).filter(Boolean),
    neutral_dropped: [...neutralDropped],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: ENRICH CANDIDATES
// ═══════════════════════════════════════════════════════════════════════════════

async function enrichCandidates(candidates, { allowOutdatedCandle = false } = {}) {
  const symbols = candidates.map(c => c.symbol);
  console.log(`${LOG} [Step 3] Enriching ${symbols.length} candidates: ${symbols.join(', ')}`);

  let analysisData;
  try {
    analysisData = await getDailyAnalysisData(symbols, { allowOutdated: allowOutdatedCandle });
  } catch (err) {
    console.error(`${LOG} getDailyAnalysisData failed:`, err.message);
    return [];
  }

  const stockMap = {};
  for (const stock of analysisData.stocks) {
    stockMap[stock.symbol] = stock;
  }

  const missingSymbols = symbols.filter(s => !stockMap[s]);
  if (missingSymbols.length > 0) {
    console.log(`${LOG} [Step 3] Missing from enrichment: ${missingSymbols.join(', ')}`);
  }

  const enriched = [];
  for (const candidate of candidates) {
    const stock = stockMap[candidate.symbol];
    if (!stock || !stock.instrument_key) {
      console.log(`${LOG} [Step 3] ${candidate.symbol}: SKIPPED — no enrichment data`);
      continue;
    }

    // Calculate scan scores
    const high = stock.high || 0;
    const low = stock.low || 0;
    const close = stock.ltp || stock.prev_close || 0;
    const open = stock.open || 0;
    const range = high - low;

    const closeInRangePct = range > 0 ? ((close - low) / range) * 100 : 50;
    const effectiveVolume = stock.todays_volume > 0 ? stock.todays_volume : (candidate.chartink_data?.volume || 0);
    const volumeRatio = stock.avg_volume_50d > 0
      ? effectiveVolume / stock.avg_volume_50d
      : 1;
    const atrPct = close > 0 ? (range / close) * 100 : 0;

    const prevClose = stock.prev_close || 0;
    const prevHigh = high;
    const prevLow = low;
    // Engulfing detection requires two complete candles (prev OHLC) which enrichment doesn't provide.
    // prevOpen=0 means engulfing is never detected — scoring falls to bullish/bearish_candle (10 pts vs 15).
    // This is acceptable — 5 pts difference is minor, and false engulfing detection is worse than missing it.
    const candlePattern = detectCandlePattern(open, high, low, close, 0, prevHigh, prevLow, prevClose);
    const lastDailyClose = stock.last_daily_close || close;
    const volSource = stock.todays_volume > 0 ? 'live' : 'chartink';

    // Step 3 enrichment debug — logs per-stock data including avg_volume_50d for Monday verification
    console.log(`${LOG} [ENRICH] ${candidate.symbol} (${candidate.scan_type}/${candidate.direction}): src=${stock.data_source || 'N/A'} O=${open} H=${high} L=${low} C=${close} prevC=${prevClose} | vol=${effectiveVolume}(${volSource}) avgVol50d=${stock.avg_volume_50d || 0} volRatio=${round2(volumeRatio)}x | RSI=${stock.daily_rsi} EMA20=${stock.ema20 || 0} ATR=${round2(atrPct)}% CIR=${round2(closeInRangePct)}% candle=${candlePattern}`);

    enriched.push({
      ...candidate,
      instrument_key: stock.instrument_key,
      scan_scores: {
        close_in_range_pct: round2(closeInRangePct),
        volume_ratio: round2(volumeRatio),
        avg_volume_50d: stock.avg_volume_50d || 0,
        rsi: stock.daily_rsi || 0,
        atr_pct: round2(atrPct),
        candle_pattern: candlePattern
      },
      _ohlcv: {
        open,
        high,
        low,
        close,
        prev_close: prevClose,
        last_daily_close: lastDailyClose,
        volume: stock.todays_volume || 0,
        avg_volume_50d: stock.avg_volume_50d || 0,
        ema20: stock.ema20 || 0,
        ema50: stock.ema50 || 0,
        atr: stock.atr || 0,
        high_5d: stock.high_5d || 0,
        low_5d: stock.low_5d || 0,
        high_10d: stock.high_10d || 0,
        low_10d: stock.low_10d || 0,
        high_20d: stock.high_20d || 0,
        low_20d: stock.low_20d || 0,
        high_52w: stock.high_52w || 0,
        daily_pivot_levels: stock.daily_pivot_levels || null,
        weekly_pivot_levels: {
          r1: stock.weekly_r1 || null,
          r2: stock.weekly_r2 || null,
          s1: stock.weekly_s1 || null,
          s2: stock.weekly_s2 || null
        },
        hourly_1h_pivots: stock.hourly_1h_pivots || null,
        hourly_4h_pivots: stock.hourly_4h_pivots || null,
        swing_levels_1h: stock.swing_levels_1h || null,
        // Multi-timeframe: weekly trend confirmation
        weekly_ema20: stock.weekly_ema20 || 0,
        weekly_close: stock.weekly_close || 0,
        weekly_trend_bullish: stock.weekly_trend_bullish,
        // Exhaustion detection
        consecutive_up_days: stock.consecutive_up_days || 0,
        consecutive_down_days: stock.consecutive_down_days || 0
      }
    });
  }

  console.log(`${LOG} [Step 3] Enriched ${enriched.length}/${candidates.length} (${candidates.length - enriched.length} missing)`);

  return enriched;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: SCORE CANDIDATES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a candidate's direction aligns with the current regime for score bonus.
 *
 * Only normal BULLISH/BEARISH qualify for the +5 bonus:
 * - STRONG_BULLISH/STRONG_BEARISH: no bonus needed — counter-regime scans are already
 *   hard-blocked at the scan selection level, so all surviving candidates are aligned.
 * - NEUTRAL/UNKNOWN: no directional bias, no bonus.
 */
function isRegimeAligned(direction, regime) {
  if (regime === 'BULLISH' && direction === 'LONG') return true;
  if (regime === 'BEARISH' && direction === 'SHORT') return true;
  // Combined regime types
  if (regime === 'EXTREME_BULL' && direction === 'LONG') return true;
  if (regime === 'STRONG_BULL' && direction === 'LONG') return true;
  if (regime === 'WEAK_BULL' && direction === 'LONG') return true;
  if (regime === 'WEAK_BEAR' && direction === 'SHORT') return true;
  if (regime === 'STRONG_BEAR' && direction === 'SHORT') return true;
  if (regime === 'EXTREME_BEAR' && direction === 'SHORT') return true;
  return false;
}

// MIN_RR_BY_SCAN_TYPE and MIN_REWARD_PCT_BY_SCAN_TYPE removed — pure-ORB flow
// computes target = entry + (risk × 2) at ORB time, giving a fixed 2:1 R:R by
// construction. Per-scan-type R:R customization no longer applies because every
// pick uses the same ORB-derived entry/stop/target formula.

/**
 * Gate thresholds for Step 4 execution-sanity filter.
 * Tunables — adjust here, not inside the loop.
 */
const GATE = Object.freeze({
  MIN_TURNOVER_CR: 5,        // prev-day close × volume ≥ ₹5 Cr  (fill-at-scale liquidity)
  MIN_VOLUME_RATIO: 1.0,     // prev-day volume ≥ 50d-avg        (not a dead day)
  ATR_MIN_PCT: 1.2,          // below this, stop is inside noise → whipsaw
  ATR_MAX_PCT: 5.0,          // raised 4→5% (expert April 2026): ORB Check 5 now handles
                             // today-specific wide opens; G2 guards structural pathologies
                             // (spreads, slippage, structural-level reliability). Real
                             // pathology threshold is ~5–5.5%; below that is normal F&O.
                             // Unlocks RVNL/SIEMENS/KEI/INOXWIND (~4 extra names/week).
                             // TODO: make regime-adaptive (tighten back to 4% when VIX
                             // percentile > 70) once 60+ days of paper-trade data exists.
  CHASE_MAX_ATR_DIST,        // reject if price > 3 ATRs beyond EMA20 (volatility-aware)
});

/**
 * Step 4 — Execution-sanity gates (replaces the old 0–100 technical scorer).
 *
 * The shortlist (Step 2) already produced composite_score ∈ [-1, +1] that captures
 * stock-selection merit. Here we only apply hard gates that the shortlist
 * cannot see:
 *   G1  Liquidity — prev-day turnover ≥ 5 Cr AND volume_ratio ≥ 1.0
 *   G2  ATR envelope — 1.2% ≤ atr_pct ≤ 4.0%
 *   G3  Chase guard — price not > 3 ATRs beyond EMA20 in trade direction (ATR-normalized)
 *   G4  Exhaustion — 3+ consec same-direction closes + >3% EMA20 dist + RSI extreme → reject
 *   G5  Counter-regime — LONG in bear regime or SHORT in bull regime → reject
 *
 * Survivors keep their shortlist composite as rank_score (scaled ×100 for
 * readability: +0.748 → 74.8). No extra scoring, no confluence bonus, no
 * regime alignment bonus. Downstream sorting is pure composite order.
 */
function scoreCandidates(enrichedCandidates, marketContext) {
  const regime = marketContext?.regime || 'UNKNOWN';
  console.log(`${LOG} [Step 4] Gate filter on ${enrichedCandidates.length} candidates (regime=${regime}, score=${marketContext?.regime_score ?? 'n/a'})`);

  const scored = [];
  const rejects = {};                    // reason → count (for reconciliation log)
  const rejectedBySymbol = new Map();    // symbol → rejection reason (for post-filter stamp)
  const reject = (symbol, reason) => {
    rejects[reason] = (rejects[reason] || 0) + 1;
    if (symbol) rejectedBySymbol.set(symbol, reason);
  };

  for (const c of enrichedCandidates) {
    const o = c._ohlcv;
    const s = c.scan_scores;
    const direction = c.direction;

    if (!o) {
      console.log(`${LOG} ❌ ${c.symbol}: G0 no enriched OHLCV`);
      reject(c.symbol, 'no_ohlcv');
      continue;
    }

    // ── G5: Counter-regime hard block ─────────────────────────────────────
    const isCounter =
      (direction === 'LONG'  && (regime === 'STRONG_BEAR' || regime === 'EXTREME_BEAR' || regime === 'WEAK_BEAR')) ||
      (direction === 'SHORT' && (regime === 'STRONG_BULL' || regime === 'EXTREME_BULL' || regime === 'WEAK_BULL'));
    if (isCounter) {
      console.log(`${LOG} ❌ ${c.symbol} (${direction}): G5 counter-regime (regime=${regime})`);
      reject(c.symbol, 'counter_regime');
      continue;
    }

    // ── G1: Liquidity ─────────────────────────────────────────────────────
    const turnoverCr = (o.close * o.volume) / 1e7;          // 1 Cr = 10M
    if (turnoverCr < GATE.MIN_TURNOVER_CR) {
      console.log(`${LOG} ❌ ${c.symbol}: G1 turnover=₹${round2(turnoverCr)}Cr < ${GATE.MIN_TURNOVER_CR}Cr`);
      reject(c.symbol, 'g1_turnover');
      continue;
    }
    const volRatio = s?.volume_ratio ?? 0;
    if (volRatio < GATE.MIN_VOLUME_RATIO) {
      console.log(`${LOG} ❌ ${c.symbol}: G1 volume_ratio=${volRatio}x < ${GATE.MIN_VOLUME_RATIO}x`);
      reject(c.symbol, 'g1_volume');
      continue;
    }

    // ── G2: ATR envelope ──────────────────────────────────────────────────
    const atrPct = s?.atr_pct ?? 0;
    if (atrPct < GATE.ATR_MIN_PCT || atrPct > GATE.ATR_MAX_PCT) {
      console.log(`${LOG} ❌ ${c.symbol}: G2 atr_pct=${atrPct}% outside [${GATE.ATR_MIN_PCT}, ${GATE.ATR_MAX_PCT}]`);
      reject(c.symbol, 'g2_atr');
      continue;
    }

    // ── G3: Chase guard (ATR-normalized) ──────────────────────────────────
    // Normalize EMA20 distance by ATR so the threshold is volatility-aware.
    // A 3%-ATR stock 3% above EMA20 (1 ATR) is fine; a 1%-ATR stock 3% above
    // EMA20 (3 ATRs) is extended. Raw % treats them identically — wrong.
    // Falls back to raw % comparison if ATR is unavailable.
    const ema20 = o.ema20;
    if (ema20 && ema20 > 0) {
      const rawDist = ((o.close - ema20) / ema20) * 100; // + above EMA20, - below
      const atrDist = atrPct > 0 ? rawDist / atrPct : rawDist; // ATRs from EMA20
      const chasing =
        (direction === 'LONG'  && atrDist >  GATE.CHASE_MAX_ATR_DIST) ||
        (direction === 'SHORT' && atrDist < -GATE.CHASE_MAX_ATR_DIST);
      if (chasing) {
        console.log(`${LOG} ❌ ${c.symbol} (${direction}): G3 chasing ${round2(atrDist)}x ATR from EMA20 (${round2(rawDist)}%)`);
        reject(c.symbol, 'g3_chase');
        continue;
      }
    }

    // ── G4: Exhaustion (ATR-normalized + absolute floor) ─────────────────
    // Old: flat 8% EMA20 distance. Now: ATR-normalized (2.5×) OR abs floor (6%),
    // whichever triggers first. G4 is intentionally less strict on extension
    // than G3 (2.5× vs 3.0×) because duration + RSI do additional work.
    // The absolute 6% floor catches low-ATR stocks where 2.5× is too permissive
    // (e.g. WIPRO at 1.5% ATR: 2.5× = 3.75%, but 6% is the right absolute cap).
    if (ema20 && ema20 > 0) {
      const ema20Dist    = Math.abs(((o.close - ema20) / ema20) * 100);
      const ema20DistAtr = atrPct > 0 ? ema20Dist / atrPct : null;
      const distExceeded = (ema20DistAtr !== null && ema20DistAtr > EXHAUSTION_EMA20_DIST_ATR)
                           || ema20Dist > EXHAUSTION_EMA20_DIST_ABS_PCT;
      const consUp   = o.consecutive_up_days   || 0;
      const consDown = o.consecutive_down_days || 0;
      const rsi = s?.rsi ?? 0;
      const exhaustedLong  = direction === 'LONG'  && consUp   >= EXHAUSTION_CONSECUTIVE_DAYS && distExceeded && rsi > 70;
      const exhaustedShort = direction === 'SHORT' && consDown >= EXHAUSTION_CONSECUTIVE_DAYS && distExceeded && rsi < 30;
      if (exhaustedLong || exhaustedShort) {
        const detail = exhaustedLong ? `${consUp} up days` : `${consDown} down days`;
        const distDetail = ema20DistAtr !== null
          ? `${round2(ema20DistAtr)}x ATR (${round2(ema20Dist)}%)`
          : `${round2(ema20Dist)}%`;
        console.log(`${LOG} ❌ ${c.symbol} (${direction}): G4 exhaustion (${detail}, ${distDetail} from EMA20, RSI=${rsi})`);
        reject(c.symbol, 'g4_exhaustion');
        continue;
      }
    }

    // ── All gates passed — compute rank_score with soft chase penalty ─────
    // Base: shortlist composite × 100 (range 0–100).
    // Soft chase penalty: linear reduction in 1.25–3.0 ATR band, max 15pts.
    // This pre-shapes selection so chasing stocks rank below identical setups
    // at lower extension, even when G3's hard gate hasn't fired yet.
    // Direction-aware: LONG penalised for extension above EMA20; SHORT below.
    const composite = typeof c._composite_score === 'number' ? c._composite_score : 0;
    let rankScore = round2(composite * 100);

    if (ema20 && ema20 > 0 && atrPct > 0) {
      const rawDist = ((o.close - ema20) / ema20) * 100;
      const atrDist = rawDist / atrPct;
      // Direction-aligned extension (positive = extended in trade direction)
      const directedDist = direction === 'LONG' ? atrDist : -atrDist;
      if (directedDist > CHASE_SOFT_PENALTY_START_ATR) {
        const penaltyFraction = Math.min(1,
          (directedDist - CHASE_SOFT_PENALTY_START_ATR) /
          (GATE.CHASE_MAX_ATR_DIST - CHASE_SOFT_PENALTY_START_ATR)
        );
        const pts = round2(penaltyFraction * CHASE_SOFT_PENALTY_MAX_PTS);
        rankScore = round2(rankScore - pts);
        console.log(`${LOG} ⚠️  ${c.symbol} (${direction}): soft chase penalty −${pts}pts (${round2(directedDist)}x ATR from EMA20) → rank=${rankScore}`);
      }
    }

    const pick = {
      ...c,
      rank_score: rankScore,
      shortlist_composite: composite,
      shortlist_signals: c._shortlist_signals,
      regime_aligned: true,        // counter-regime already rejected above
      gate_passed: true,
    };

    console.log(`${LOG} ✅ ${c.symbol} (${c.scan_type}/${direction}): composite=${composite.toFixed(3)} rank=${rankScore} [turnover=₹${round2(turnoverCr)}Cr vol=${volRatio}x ATR=${atrPct}% RSI=${s?.rsi}]`);
    scored.push(pick);
  }

  // Reconciliation
  const rejectedCount = Object.values(rejects).reduce((a, b) => a + b, 0);
  const totalProcessed = scored.length + rejectedCount;
  const rejectSummary = Object.entries(rejects).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  console.log(`${LOG} [Step 4] RECONCILIATION: input=${enrichedCandidates.length} passed=${scored.length} rejected=${rejectedCount} [${rejectSummary}]${totalProcessed !== enrichedCandidates.length ? ' ⚠️ MISMATCH' : ''}`);

  // Sort descending by composite-based rank_score
  scored.sort((a, b) => b.rank_score - a.rank_score);

  if (scored.length > 0) {
    console.log(`${LOG} [Step 4] Ranked: ${scored.map(p => `${p.symbol}(${p.scan_type}:${p.rank_score})`).join(', ')}`);
  }

  // Attach per-symbol rejection trail onto the array itself as a non-enumerable
  // property. Callers that only need the array get the array; callers that want
  // the rejection map (runDailyPicks, for the ShortlistWatchlist post-filter
  // stamp) can read scored._rejectedBySymbol.
  Object.defineProperty(scored, '_rejectedBySymbol', { value: rejectedBySymbol, enumerable: false });
  return scored;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: DEPRECATED — LEVELS ARE NOW COMPUTED AT ORB TIME (9:30)
// ═══════════════════════════════════════════════════════════════════════════════
// The scanLevels-based pre-market structural entry/stop/target is gone. In the
// pure-ORB design these are computed at 9:30 AM from the opening range by
// orbValidationService.validatePicks → validateAndPlaceEntries, with a fixed
// 2:1 R:R by construction:
//   entry  = isLong ? orb.high × 1.001 : orb.low × 0.999
//   stop   = isLong ? orb.low  × 0.999 : orb.high × 1.001
//   target = entry ± (|entry - stop| × 2)
// ═══════════════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════════════
// STEP 6: AI INSIGHTS (NON-FATAL)
// ═══════════════════════════════════════════════════════════════════════════════

async function generatePickInsights(picks, marketContext) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`${LOG} [Step 6] No ANTHROPIC_API_KEY — skipping AI insights`);
    return picks.map(p => ({ ...p, ai_insight: null, ai_generated: false }));
  }

  console.log(`${LOG} [Step 6] Generating AI insights for ${picks.length} picks...`);
  const requestId = uuidv4();
  const startTime = Date.now();

  try {
    const client = getAnthropicClient();

    const picksData = picks.map((p, i) => ({
      rank: i + 1,
      symbol: p.symbol,
      direction: p.direction,
      scan_type: SCAN_LABELS[p.scan_type] || p.scan_type,
      score: p.rank_score,
      ohlcv: {
        open: p._ohlcv.open,
        high: p._ohlcv.high,
        low: p._ohlcv.low,
        close: p._ohlcv.close,
        prev_close: p._ohlcv.prev_close,
        volume_ratio: p.scan_scores.volume_ratio
      },
      rsi: p.scan_scores.rsi,
      candle: p.scan_scores.candle_pattern,
      levels: p.levels
    }));

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      system: `You are an ultra-brief Indian equity technical analyst. For each stock, write exactly 1-2 sentences explaining WHY this is a good intraday trade candidate based on the technical data. Focus on the setup (candle pattern, volume confirmation, key levels). Be specific with numbers. Respond in JSON: { "insights": [{ "symbol": "...", "insight": "..." }] }`,
      messages: [{
        role: 'user',
        content: `Market regime: ${marketContext.regime}.

Today's picks:
${JSON.stringify(picksData, null, 2)}

Generate 1-2 sentence insights for each pick.`
      }]
    });

    const responseTime = Date.now() - startTime;
    const text = response.content?.[0]?.text || '';

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const insightMap = {};
      for (const item of (parsed.insights || [])) {
        insightMap[item.symbol] = item.insight;
      }

      // Log API usage
      await logApiUsage(requestId, response, responseTime, true, picks.map(p => p.symbol).join(','));

      console.log(`${LOG} AI insights generated in ${responseTime}ms`);

      return picks.map(p => ({
        ...p,
        ai_insight: insightMap[p.symbol] || null,
        ai_generated: !!insightMap[p.symbol]
      }));
    }

    console.log(`${LOG} AI response not parseable as JSON — skipping insights`);
    await logApiUsage(requestId, response, responseTime, true, 'parse_failed');
    return picks.map(p => ({ ...p, ai_insight: null, ai_generated: false }));

  } catch (err) {
    console.error(`${LOG} AI insight generation failed (non-fatal):`, err.message);
    await logApiUsage(requestId, null, Date.now() - startTime, false, err.message).catch(() => {});
    return picks.map(p => ({ ...p, ai_insight: null, ai_generated: false }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 7: SAVE TO DB
// ═══════════════════════════════════════════════════════════════════════════════

async function saveToDB(marketContext, picks, scanResult, candidatesReview = [], globalIntel = null) {
  // Determine scan_date and trading_date based on when we're running:
  // - 8:30 AM scheduled run: scan_date = yesterday, trading_date = today
  // - Manual evening run:    scan_date = today,     trading_date = next trading day
  const now = new Date();
  const istHour = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours();
  const todayMidnight = getISTMidnight();

  let scanDate, tradingDate;
  if (istHour < 15) {
    // Before market close (scheduled 8:30 AM run or manual pre-market)
    // ChartInk "latest" = yesterday's candle, we trade today
    scanDate = new Date(todayMidnight);
    scanDate.setDate(scanDate.getDate() - 1);
    tradingDate = todayMidnight;
  } else {
    // After market close (manual evening run)
    // ChartInk "latest" = today's completed candle, we trade next trading day
    scanDate = todayMidnight;
    tradingDate = await MarketHoursUtil.getNextTradingDay(todayMidnight);
  }

  console.log(`${LOG} [Step 7] Run at ${istHour}:xx IST → scanDate=${scanDate.toISOString()} tradingDate=${tradingDate.toISOString()} candidatesReview=${candidatesReview.length}`);

  const pickDocs = picks.map(p => {
    const o = p._ohlcv || {};
    // Persist structural price levels from Step 3 enrichment.
    // Used as reference data (prev high/low, 52w high, pivot levels) on the
    // DailyPick document. ORB target is now always fixed 2R — structural levels
    // are no longer used by orbValidationService but kept for analysis/debugging.
    const structural_levels = {
      prev_high: o.high ?? null,
      prev_low:  o.low ?? null,
      prev_close: o.prev_close ?? o.close ?? null,
      high_20d: o.high_20d ?? null,
      low_20d: o.low_20d ?? null,
      high_52w: o.high_52w ?? null,
      daily_r1: o.daily_pivot_levels?.r1 ?? null,
      daily_r2: o.daily_pivot_levels?.r2 ?? null,
      daily_s1: o.daily_pivot_levels?.s1 ?? null,
      daily_s2: o.daily_pivot_levels?.s2 ?? null,
      weekly_r1: o.weekly_pivot_levels?.r1 ?? null,
      weekly_r2: o.weekly_pivot_levels?.r2 ?? null,
      weekly_s1: o.weekly_pivot_levels?.s1 ?? null,
      weekly_s2: o.weekly_pivot_levels?.s2 ?? null,
      swing_resistance: (o.swing_levels_1h?.resistanceZones || []).map(z => z.midpoint).filter(x => typeof x === 'number'),
      swing_support:    (o.swing_levels_1h?.supportZones    || []).map(z => z.midpoint).filter(x => typeof x === 'number'),
      atr: o.atr ?? null,
    };
    return {
      symbol: p.symbol,
      instrument_key: p.instrument_key,
      stock_name: p.stock_name,
      scan_type: p.scan_type,
      direction: p.direction,
      scan_scores: p.scan_scores,
      rank_score: p.rank_score,
      confluence_score: p.confluence_score || 0,
      confluence_detail: p.confluence_detail || null,
      regime_bonus: p.regime_bonus || 0,
      levels: p.levels,
      structural_levels,
      trade: { status: 'PENDING' },
      kite: { kite_status: 'pending' },
      ai_insight: p.ai_insight || null,
      ai_generated: p.ai_generated || false,
      news_sentiment: p.news_sentiment || null,
      news_adjustment: p.news_adjustment || 0,
      news_context: p.news_context || null,
    };
  });

  // Upsert: one document per trading day
  const doc = await DailyPick.findOneAndUpdate(
    { trading_date: tradingDate },
    {
      $set: {
        trading_date: tradingDate,
        scan_date: scanDate,
        market_context: marketContext,
        picks: pickDocs,
        summary: {
          total_candidates: scanResult.candidates?.length || 0,
          bullish_count: scanResult.bullish_count || 0,
          bearish_count: scanResult.bearish_count || 0,
          selected_count: picks.length
        },
        candidates_review: candidatesReview,
        ...(globalIntel ? {
          global_intel: {
            market_mood: globalIntel.market_mood,
            risk_level: globalIntel.risk_level,
            risk_reason: globalIntel.risk_reason || null,
            trading_recommendation: globalIntel.trading_recommendation,
            recommendation_reason: globalIntel.recommendation_reason || null,
            sgx_nifty: globalIntel.sgx_nifty || null,
            global_cues: globalIntel.global_cues || null,
            institutional: globalIntel.institutional || null,
            sectors: globalIntel.sectors || {},
            major_events: globalIntel.major_events || [],
            stock_specific: globalIntel.stock_specific || {},
            fetched_at: globalIntel.fetched_at ? new Date(globalIntel.fetched_at) : new Date(),
            source: globalIntel.source || 'claude_websearch'
          }
        } : {})
      }
    },
    { upsert: true, new: true }
  );

  return doc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 8: SEND NOTIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

async function sendNotification(marketContext, picks, doc) {
  const adminUserId = kiteConfig.ADMIN_USER_ID;
  if (!adminUserId) {
    console.log(`${LOG} [Step 8] No ADMIN_USER_ID — skipping notification`);
    return;
  }

  const { isPaperTradeMode } = await import('../kiteTradeIntegration.service.js');
  const paperTag = isPaperTradeMode() ? '[PAPER] ' : '';

  let title, body;

  if (picks.length > 0) {
    // Pure-ORB: pick.levels is null at 8:32 notify time. Entry price is
    // computed at 9:30 ORB. Show direction + symbol only here.
    const pickSummary = picks
      .map(p => `${p.symbol} (${p.direction})`)
      .join(', ');
    const longCount = picks.filter(p => p.direction === 'LONG').length;
    const shortCount = picks.filter(p => p.direction === 'SHORT').length;
    if (longCount > 0 && shortCount > 0) {
      title = `${paperTag}Daily Picks: ${longCount} BUY + ${shortCount} SELL`;
    } else {
      title = `${paperTag}Daily Picks: ${picks[0].direction === 'LONG' ? 'BUY' : 'SELL'} ${picks.length} stocks`;
    }
    body = `${pickSummary} — levels will be set at 09:30 ORB`;
  } else if (marketContext.regime === 'CONFLICT') {
    title = 'Daily Picks: CONFLICT — Sitting Out';
    body = `Structure vs SGX beyond dynamic threshold. No trades today.`;
  } else if (marketContext.regime === 'RANGING') {
    title = 'Daily Picks: RANGING — Sitting Out';
    body = '5+ consecutive neutral days — range-bound market. No trades today.';
  } else if (marketContext.regime.includes('BEAR')) {
    title = 'Daily Picks: No setups';
    body = `Market weak (${marketContext.regime}). No daily picks. Protect capital.`;
  } else if (marketContext.regime.includes('BULL')) {
    title = 'Daily Picks: No setups';
    body = `Bullish regime (${marketContext.regime}) — no setups qualified. Watch for pullback entries.`;
  } else {
    title = 'Daily Picks: No setups';
    body = 'No quality setups found today. Sitting out.';
  }

  try {
    await firebaseService.sendToUser(adminUserId, title, body, {
      type: 'DAILY_PICKS',
      route: '/daily-picks'
    });

    // Update notification in doc
    await DailyPick.findByIdAndUpdate(doc._id, {
      $set: {
        'summary.notification_sent': true,
        'summary.notification_body': body
      }
    });

    console.log(`${LOG} Notification sent: ${title}`);
  } catch (err) {
    console.error(`${LOG} Notification failed:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 7.5: PRE-MARKET ENTRY ORDERS (GTT for LONG, AMO for SHORT)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Place pre-market entry orders.
 *
 * DEPRECATED in the pure-ORB flow. With Step 5 gone, picks arrive at this
 * function WITHOUT levels (entry/stop/target are computed at 9:30 AM inside
 * validateAndPlaceEntries). This function now returns immediately so the admin
 * endpoint that calls it doesn't crash — the ORB path is the sole entry path.
 *
 * Kept as a function (not deleted) because routes/dailyPicks.js still imports
 * and calls it at `POST /dailyPicks/premarket/place`.
 */
async function placePreMarketEntries(doc) {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} [Step 7.5] placePreMarketEntries — scanner.py AMO path`);
  console.log(`${LOG} ════════════════════════════════════════`);

  // Scanner path: picks have pre-computed levels (mode='scanner'), place AMO MARKET
  // orders immediately after the 8:30 AM scan so they queue for the 9:08 opening auction.
  const isScannerDoc = doc.picks.some(p => p.levels?.mode === 'scanner');
  if (!isScannerDoc) {
    // Non-scanner doc (e.g. manual run with old path) — skip
    console.log(`${LOG} [Step 7.5] Non-scanner doc — skipping AMO placement`);
    return { success: true, message: 'Non-scanner doc — skipping', ordersPlaced: 0 };
  }

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG} [Step 7.5] Kite not enabled — skipping`);
    return { success: true, message: 'Kite not enabled', ordersPlaced: 0 };
  }

  if (process.env.ENABLE_PRE_MARKET_ENTRY === 'false') {
    console.log(`${LOG} [Step 7.5] Pre-market entry disabled — skipping`);
    return { success: true, message: 'Pre-market entry disabled', ordersPlaced: 0 };
  }

  const pendingPicks = doc.picks.filter(p => p.trade.status === 'PENDING' || p.trade.status === 'FAILED');
  if (pendingPicks.length === 0) {
    console.log(`${LOG} [Step 7.5] No PENDING/FAILED picks — skipping`);
    return { success: true, message: 'No pending picks', ordersPlaced: 0 };
  }

  // Capital allocation — all picks use MIS (intraday), single pool with leverage
  const MAX_WEIGHT = 0.45;
  let balance;
  const MAX_BALANCE_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_BALANCE_RETRIES; attempt++) {
    try {
      balance = await kiteOrderService.getAvailableBalance();
      console.log(`${LOG} [Step 7.5] Balance fetched on attempt ${attempt}`);
      break;
    } catch (err) {
      console.error(`${LOG} [Step 7.5] ❌ Balance fetch failed (attempt ${attempt}/${MAX_BALANCE_RETRIES}) — ${err.message}`);
      if (attempt < MAX_BALANCE_RETRIES) {
        // Token error → try auto-login refresh before retry
        const is403 = err.response?.status === 403 || err.message?.includes('403') || err.message?.includes('TokenException');
        if (is403) {
          console.log(`${LOG} [Step 7.5] Token error detected — triggering auto-login refresh`);
          try {
            const kiteAutoLogin = (await import('../kiteAutoLogin.service.js')).default;
            await kiteAutoLogin.refreshSession();
            console.log(`${LOG} [Step 7.5] Auto-login refresh successful — retrying`);
          } catch (loginErr) {
            console.error(`${LOG} [Step 7.5] Auto-login refresh failed: ${loginErr.message}`);
          }
        }
        await delay(2000);
      }
    }
  }

  // Fallback if all retries failed — use conservative balance so entries still proceed
  if (!balance) {
    console.warn(`${LOG} [Step 7.5] ⚠️ All balance attempts failed — using conservative fallback`);
    try {
      const prevDoc = await DailyPick.findOne({
        trading_date: { $lt: getISTMidnight(new Date()) }
      }).sort({ trading_date: -1 }).lean();
      const prevBalance = prevDoc?.execution_summary?.available_balance;
      if (prevBalance && prevBalance > 0) {
        const conservativeAmt = round2(prevBalance * 0.5);
        balance = {
          total: conservativeAmt, available: conservativeAmt,
          usableSwing: round2(conservativeAmt * 0.6),
          usableIntraday: round2(conservativeAmt * 0.4),
          pendingSwing: 0, pendingIntraday: 0, used: 0,
          is_fallback: true, fallback_source: 'previous_day'
        };
        console.warn(`${LOG} [Step 7.5] Fallback: 50% of prev day balance = ₹${conservativeAmt}`);
      }
    } catch (dbErr) {
      console.error(`${LOG} [Step 7.5] Fallback DB lookup failed: ${dbErr.message}`);
    }
    // Last resort hardcoded minimum
    if (!balance) {
      balance = {
        total: 50000, available: 50000,
        usableSwing: 30000, usableIntraday: 20000,
        pendingSwing: 0, pendingIntraday: 0, used: 0,
        is_fallback: true, fallback_source: 'hardcoded_minimum'
      };
      console.warn(`${LOG} [Step 7.5] Using hardcoded minimum fallback: ₹50,000`);
    }
    // Notify admin about fallback usage
    try {
      await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
        '⚠️ Balance Fallback Used',
        `Kite balance fetch failed after ${MAX_BALANCE_RETRIES} retries. Using ${balance.fallback_source} fallback (₹${balance.available}). Review trades carefully.`,
        { type: 'BALANCE_FALLBACK', route: '/daily-picks' }
      );
    } catch (_) { /* notification failure is non-critical */ }
  }
  console.log(`${LOG} [Step 7.5] Balance: ₹${balance.available}, Swing budget: ₹${balance.usableSwing}, Intraday budget: ₹${balance.usableIntraday}`);

  // ATR-based position sizing: higher ATR → smaller position (inverse volatility weighting)
  // BASELINE_ATR_PCT, MIN_ATR_MULT, MAX_ATR_MULT imported from dailyPicksConstants.js

  const totalScore = pendingPicks.reduce((sum, p) => sum + p.rank_score, 0);
  const rawWeights = pendingPicks.map(p => Math.min(p.rank_score / totalScore, MAX_WEIGHT));
  const weightSum = rawWeights.reduce((s, w) => s + w, 0);

  // Daily picks use only the intraday pool (40%) — swing pool (60%) reserved for weekly setups
  const totalPool = balance.usableIntraday;

  const allocations = pendingPicks.map((pick, i) => {
    let capital = weightSum > 0 ? Math.floor(totalPool * (rawWeights[i] / weightSum)) : 0;

    // ATR-based sizing: scale capital inversely with volatility
    const atrPct = pick._ohlcv?.atr && pick.levels?.entry
      ? (pick._ohlcv.atr / pick.levels.entry) * 100
      : null;
    if (atrPct && atrPct > 0) {
      const atrMultiplier = Math.max(MIN_ATR_MULT, Math.min(MAX_ATR_MULT, BASELINE_ATR_PCT / atrPct));
      const preSized = capital;
      capital = Math.floor(capital * atrMultiplier);
      console.log(`${LOG}   ${pick.symbol}: ATR=${round2(atrPct)}% → multiplier=${round2(atrMultiplier)}x (₹${preSized} → ₹${capital})`);
    }

    // Regime-based position size reduction for counter-regime trades
    if (pick.regime_warning) {
      const { severity } = pick.regime_warning;
      if (severity === 'critical') {
        // Critical counter-regime (e.g. LONG in STRONG_BEARISH): block entirely
        console.log(`${LOG}   ${pick.symbol}: ⛔ BLOCKED — critical regime conflict (${pick.regime_warning.code}), capital=₹0`);
        capital = 0;
        pick.position_size_reduction_pct = 100;
      } else if (severity === 'high' || severity === 'medium') {
        // High/medium conflict: reduce position by 50%
        const original = capital;
        capital = Math.floor(capital * 0.5);
        pick.position_size_reduction_pct = 50;
        console.log(`${LOG}   ${pick.symbol}: ⚠️ Regime risk (${pick.regime_warning.code}) — position halved ₹${original} → ₹${capital}`);
      }
    }

    return { pick, capital };
  });

  console.log(`${LOG} [Step 7.5] Capital allocation: totalScore=${totalScore} totalPool=₹${totalPool} (all MIS intraday)`);
  for (const { pick, capital } of allocations) {
    const cappedAmount = Math.min(capital, kiteConfig.MAX_ORDER_VALUE);
    const estQty = Math.floor(cappedAmount / pick.levels.entry);
    console.log(`${LOG}   ${pick.symbol}: ${pick.direction} weight=${round2(rawWeights[pendingPicks.indexOf(pick)] / weightSum * 100)}% capital=₹${capital} capped=₹${cappedAmount} estQty=${estQty} entry=₹${pick.levels.entry}`);
  }

  // Circuit breaker check — halt new entries if daily drawdown exceeded
  const cbCheck = await checkCircuitBreaker();
  if (!cbCheck.allowed) {
    console.log(`${LOG} [Step 7.5] ⛔ CIRCUIT BREAKER: ${cbCheck.reason} — skipping all entries`);
    return { success: true, message: `Circuit breaker: ${cbCheck.reason}`, ordersPlaced: 0 };
  }

  // Scanner path: all picks are recovery_breakout (LONG), no ORB-wait scan filter needed.
  let ordersPlaced = 0;

  for (const { pick, capital } of allocations) {
    const orderAmount = Math.min(capital, kiteConfig.MAX_ORDER_VALUE);
    const qty = Math.floor(orderAmount / pick.levels.entry);
    if (qty <= 0) {
      console.log(`${LOG} [Step 7.5] ${pick.symbol}: qty=0 (price ₹${pick.levels.entry} > capital ₹${orderAmount}) — skipping`);
      continue;
    }

    const txnType = pick.direction === 'LONG' ? 'BUY' : 'SELL';
    console.log(`${LOG} [Step 7.5] ${pick.symbol}: AMO MARKET ${pick.direction} qty=${qty} capital=₹${orderAmount}`);

    try {
      // AMO MARKET — executes at the 9:08 pre-open auction price.
      // No trigger_price: we take whatever the market opens at.
      const result = await kiteOrderService.placeAMOOrder({
        tradingsymbol: pick.symbol,
        exchange: 'NSE',
        transaction_type: txnType,
        order_type: 'MARKET',
        product: 'MIS',
        quantity: qty,
        simulationId: `daily_pick_${pick.symbol}`,
        orderType: 'ENTRY',
        source: 'DAILY_PICKS'
      });

      if (result.success && result.orderId) {
        pick.trade.status = 'ORDER_PLACED';
        pick.trade.qty = qty;
        pick.kite.entry_order_id = result.orderId;
        pick.kite.kite_status = 'amo_placed';
        ordersPlaced++;

        console.log(`${LOG} [Step 7.5] ┌── AMO MARKET ENTRY: ${pick.symbol} ──────────────────`);
        console.log(`${LOG} [Step 7.5] │ Direction: ${pick.direction} | Scan: ${pick.scan_type} | Product: MIS`);
        console.log(`${LOG} [Step 7.5] │ Ref entry: ₹${pick.levels.entry} (scanner prev-close) | Qty: ${qty} | Capital: ₹${orderAmount}`);
        console.log(`${LOG} [Step 7.5] │ Stop: ₹${pick.levels.stop} | Target: ₹${pick.levels.target} | R:R=${pick.levels.risk_reward}`);
        console.log(`${LOG} [Step 7.5] │ AMO Order ID: ${result.orderId}`);
        console.log(`${LOG} [Step 7.5] └─────────────────────────────────────────────────────`);
      } else {
        console.error(`${LOG} [Step 7.5] ❌ ${pick.symbol}: AMO placement failed — ${JSON.stringify(result)}`);
        pick.trade.status = 'FAILED';
        pick.kite.kite_status = 'failed';
      }
    } catch (err) {
      console.error(`${LOG} [Step 7.5] ❌ ${pick.symbol}: Order error — ${err.message}`, err.response?.data ? JSON.stringify(err.response.data) : '');
      pick.trade.status = 'FAILED';
      pick.kite.kite_status = 'failed';
    }
  }

  doc.markModified('picks');
  await doc.save();

  console.log(`${LOG} [Step 7.5] Pre-market entries: ${ordersPlaced}/${pendingPicks.length} placed`);
  return { success: true, ordersPlaced };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAP PROTECTION — Cancel AMO entries if stock gaps >2% past trigger
// Called at 9:16 AM (right after pre-open session closes)
// ═══════════════════════════════════════════════════════════════════════════════

// GAP_PROTECTION_MAX_PCT imported from dailyPicksConstants.js

/**
 * Cancel AMO SL-M entry orders that have gapped too far past the trigger price.
 * When a stock gaps 3%+ past the trigger, SL-M fills at market = massive slippage.
 * Better to cancel and let ORB validation handle it with fresh levels.
 */
async function gapProtectionCheck() {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Gap protection check (post-open)`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) return { success: true, message: 'Kite not enabled' };

  const doc = await DailyPick.findToday();
  if (!doc) return { success: true, message: 'No picks today' };

  // Only check AMO orders that haven't filled yet
  const amoPicks = doc.picks.filter(p =>
    p.trade.status === 'ORDER_PLACED' &&
    (p.kite.kite_status === 'amo_placed' || p.kite.kite_status === 'order_placed')
  );

  if (amoPicks.length === 0) {
    console.log(`${LOG} No AMO entries to check for gap protection`);
    return { success: true, cancelled: 0 };
  }

  // Fetch opening prices via Kite OHLC
  const symbols = amoPicks.map(p => `NSE:${p.symbol}`);
  let ltpData;
  try {
    ltpData = await kiteOrderService.getLTP(symbols);
  } catch (err) {
    console.error(`${LOG} [GAP-PROTECT] LTP fetch failed:`, err.message);
    return { success: false, error: err.message };
  }

  let cancelled = 0;

  for (const pick of amoPicks) {
    const currentPrice = ltpData[`NSE:${pick.symbol}`]?.last_price;
    if (!currentPrice) continue;

    const entryTrigger = pick.levels.entry;
    const gapPct = pick.direction === 'LONG'
      ? ((currentPrice - entryTrigger) / entryTrigger) * 100
      : ((entryTrigger - currentPrice) / entryTrigger) * 100;

    console.log(`${LOG} [GAP-PROTECT] ${pick.symbol}: trigger=₹${entryTrigger} open=₹${currentPrice} gap=${round2(gapPct)}%`);

    if (gapPct > GAP_PROTECTION_MAX_PCT) {
      // Gap too large — cancel AMO to avoid slippage
      console.log(`${LOG} [GAP-PROTECT] ⚠️ ${pick.symbol}: Gap ${round2(gapPct)}% > ${GAP_PROTECTION_MAX_PCT}% — cancelling AMO`);

      try {
        await kiteOrderService.cancelOrder(pick.kite.entry_order_id);
        pick.trade.status = 'PENDING';   // Reset to PENDING so ORB validation can retry with fresh levels
        pick.kite.kite_status = 'pending';
        pick.trade.exit_reason = `gap_protection_${round2(gapPct)}pct`;
        cancelled++;
        console.log(`${LOG} [GAP-PROTECT] ${pick.symbol}: AMO cancelled — deferred to ORB validation`);
      } catch (err) {
        console.error(`${LOG} [GAP-PROTECT] ${pick.symbol}: Cancel failed:`, err.message);
        // Check if it already filled
        try {
          const order = await kiteOrderService.getOrderDetails(pick.kite.entry_order_id);
          if (order?.status?.toUpperCase() === 'COMPLETE') {
            console.log(`${LOG} [GAP-PROTECT] ${pick.symbol}: Already filled @ ₹${order.average_price} — cannot cancel`);
          }
        } catch (_) { /* ignore */ }
      }
    } else if (gapPct < -1.0) {
      // Negative gap (gap in wrong direction) — also cancel
      console.log(`${LOG} [GAP-PROTECT] ⚠️ ${pick.symbol}: Adverse gap ${round2(gapPct)}% — cancelling AMO`);
      try {
        await kiteOrderService.cancelOrder(pick.kite.entry_order_id);
        pick.trade.status = 'PENDING';
        pick.kite.kite_status = 'pending';
        pick.trade.exit_reason = `adverse_gap_${round2(gapPct)}pct`;
        cancelled++;
      } catch (err) {
        console.error(`${LOG} [GAP-PROTECT] ${pick.symbol}: Cancel failed:`, err.message);
      }
    }
  }

  if (cancelled > 0) {
    doc.markModified('picks');
    await doc.save();

    try {
      await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
        `Gap Protection: ${cancelled} AMO cancelled`,
        `${cancelled} entry order(s) cancelled due to excessive gap at open. Deferred to ORB validation.`,
        { type: 'GAP_PROTECTION', route: '/daily-picks' }
      );
    } catch (_) { /* ignore */ }
  }

  console.log(`${LOG} [GAP-PROTECT] Cancelled ${cancelled}/${amoPicks.length} AMO entries`);
  return { success: true, cancelled };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: ORB COLLECTION — 9:15 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch ORB (Opening Range Breakout) data via single OHLC call.
 * Multi-pass: Pass 1 (9:30) = 15-min range, Pass 2 (9:46) = 30-min, Pass 3 (10:01) = 45-min.
 * At each time, the day's OHLC reflects the cumulative range since market open.
 * Only updates picks still in PENDING/COLLECTING_ORB status.
 */
async function startOrbCollection(options = {}) {
  const { orbPass = 1 } = options;

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Fetching ORB data — Pass ${orbPass}: ${ORB_PASS_LABELS[orbPass] || orbPass}`);
  console.log(`${LOG} ════════════════════════════════════════`);

  const kiteEnabled = isKiteIntegrationEnabled();
  if (!kiteEnabled) {
    console.log(`${LOG} Kite not enabled — skipping ORB`);
    return { success: true, message: 'Kite not enabled' };
  }

  const doc = await DailyPick.findToday();
  if (!doc) {
    console.log(`${LOG} No DailyPick doc for today — nothing to collect`);
    return { success: true, message: 'No picks today' };
  }

  // Only fetch for picks still PENDING, COLLECTING_ORB, or GAP_FADE_WATCH
  const pendingPicks = doc.picks.filter(p =>
    p.trade.status === 'PENDING' || p.trade.status === 'COLLECTING_ORB' || p.trade.status === 'GAP_FADE_WATCH'
  );

  if (pendingPicks.length === 0) {
    console.log(`${LOG} No PENDING picks for pass ${orbPass} — skipping ORB`);
    return { success: true, message: 'No pending picks' };
  }

  console.log(`${LOG} Fetching ORB pass ${orbPass} for ${pendingPicks.length} picks: ${pendingPicks.map(p => p.symbol).join(', ')}`);

  const symbols = pendingPicks.map(p => p.symbol);

  let orbData;
  try {
    orbData = await collectOpeningRange(symbols, pendingPicks);
    console.log(`${LOG} ORB data received for: ${Object.keys(orbData).join(', ')}`);
  } catch (orbErr) {
    console.error(`${LOG} [ERROR] collectOpeningRange() THREW: ${orbErr.message}`);
    return { success: false, error: orbErr.message };
  }

  // Store ORB data on each pick — only update PENDING picks
  let storedCount = 0;
  let skippedCount = 0;
  for (const pick of pendingPicks) {
    if (pick.trade.status !== 'PENDING' && pick.trade.status !== 'COLLECTING_ORB') {
      console.log(`${LOG} [DEBUG] ${pick.symbol}: skipping ORB store — status=${pick.trade.status} (not PENDING/COLLECTING_ORB)`);
      skippedCount++;
      continue;
    }

    const orb = orbData[pick.symbol];
    if (orb) {
      const existingPasses = pick.orb?.orb_passes || [];
      pick.orb = {
        high: orb.high,
        low: orb.low,
        opening_price: orb.opening_price,
        gap_percent: orb.gap_percent,
        orb_direction: orb.orb_direction,
        nifty_orb_direction: orbData['_NIFTY']?.orb_direction || 'NEUTRAL',
        nifty_change_pct: orbData['_NIFTY']?.nifty_change_pct ?? 0,
        orb_pass: orbPass,
        orb_passes: existingPasses
      };
      storedCount++;
      console.log(`${LOG} [DEBUG] ${pick.symbol}: ORB stored — H=${orb.high} L=${orb.low} O=${orb.opening_price} gap=${orb.gap_percent}% dir=${orb.orb_direction}`);
    } else {
      console.warn(`${LOG} [WARN] ${pick.symbol}: NO ORB data in response — symbol missing from OHLC result`);
    }
  }

  console.log(`${LOG} [DEBUG] Saving doc — ${storedCount} picks with ORB data, ${skippedCount} skipped (wrong status)`);
  doc.markModified('picks');
  try {
    await doc.save();
    console.log(`${LOG} [DEBUG] doc.save() SUCCESS — updatedAt=${doc.updatedAt}`);
  } catch (saveErr) {
    console.error(`${LOG} [ERROR] doc.save() FAILED in startOrbCollection: ${saveErr.message}`);
    console.error(`${LOG} [ERROR] Mongoose validation errors:`, saveErr.errors ? JSON.stringify(Object.keys(saveErr.errors)) : 'none');
    return { success: false, error: `doc.save() failed: ${saveErr.message}` };
  }

  console.log(`${LOG} ORB pass ${orbPass} complete — data stored for ${storedCount} symbols`);
  return { success: true, symbolsCollected: Object.keys(orbData).length, storedCount, orbPass };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: VALIDATE + PLACE ENTRIES — 9:30 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate picks against ORB data and place entries for validated picks.
 * Multi-pass: orbPass 1 (9:30), 2 (9:46), 3 (10:01 FINAL).
 * Permanent failures (gap, nifty) are skipped immediately.
 * Retryable failures (R:R, range) stay PENDING for next pass.
 */
async function validateAndPlaceEntries(options = {}) {
  const { dryRun = false, orbPass = 1 } = options;
  const isFinalPass = orbPass >= MAX_ORB_PASS;

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Validating picks — Pass ${orbPass}: ${ORB_PASS_LABELS[orbPass]} ${isFinalPass ? '(FINAL)' : '(retry available)'}${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG} Kite not enabled — skipping`);
    return { success: true, message: 'Kite not enabled', orders: 0, validated: 0, skipped: 0 };
  }

  console.log(`${LOG} [DEBUG] Loading today's DailyPick doc...`);
  const doc = await DailyPick.findToday();
  if (!doc) {
    console.log(`${LOG} No DailyPick doc for today — nothing to place`);
    return { success: true, message: 'No picks today', orders: 0, validated: 0, skipped: 0 };
  }
  console.log(`${LOG} [DEBUG] Doc loaded — ${doc.picks.length} total picks, updatedAt=${doc.updatedAt}`);

  // Accept COLLECTING_ORB (normal flow), PENDING (if ORB collection was skipped/manual),
  // and GAP_FADE_WATCH (gap-direction failures monitoring for fade-through-entry)
  const eligiblePicks = doc.picks.filter(p =>
    p.trade.status === 'COLLECTING_ORB' || p.trade.status === 'PENDING' || p.trade.status === 'GAP_FADE_WATCH'
  );
  console.log(`${LOG} [DEBUG] Pick statuses: ${doc.picks.map(p => `${p.symbol}=${p.trade.status}`).join(', ')}`);
  if (eligiblePicks.length === 0) {
    console.log(`${LOG} No eligible picks for validation — skipping`);
    return { success: true, message: 'No eligible picks', orders: 0, validated: 0, skipped: 0 };
  }

  // ─── SCANNER PATH: ORB validation bypassed ─────────────────────────────
  // scanner.py picks (levels.mode === 'scanner') have pre-computed entry/stop/
  // target from structural pivots. Mark all eligible picks VALIDATED directly.
  //
  // Non-scanner path (ORB validation + level assignment) is preserved below
  // in a disabled block for future reference.
  // ─────────────────────────────────────────────────────────────────────────
  const isScanner = eligiblePicks.some(p => p.levels?.mode === 'scanner');

  if (isScanner) {
    console.log(`${LOG} [Scanner] Bypassing ORB — marking ${eligiblePicks.length} pick(s) VALIDATED (levels from scanner.py structural pivots)`);
    for (const pick of eligiblePicks) {
      pick.validation = { passed: true, checks: { scanner: true }, skip_reason: null };
    }
    doc.markModified('picks');
  } else {
    // ── DISABLED: ORB validation + level assignment (non-scanner path) ────
    // eslint-disable-next-line no-constant-condition
    if (false) {
  // Step 1: Validate against ORB data
  // Pass 1: use stored ORB data. Pass 2+: RE-FETCH fresh OHLC (market has moved 15-30 min)
  let orbData = {};
  if (orbPass > 1) {
    // Fresh fetch — ORB high/low will now reflect the wider range (30-min or 45-min candle)
    console.log(`${LOG} Pass ${orbPass}: Re-fetching fresh OHLC for ${eligiblePicks.length} picks (stale data is ${orbPass === 2 ? '16' : '31'} min old)`);
    try {
      const freshSymbols = eligiblePicks.map(p => p.symbol);
      orbData = await collectOpeningRange(freshSymbols, eligiblePicks);
      // Update stored ORB data on picks with fresh values
      for (const pick of eligiblePicks) {
        const freshOrb = orbData[pick.symbol];
        if (freshOrb) {
          const existingPasses = pick.orb?.orb_passes || [];
          pick.orb = {
            high: freshOrb.high,
            low: freshOrb.low,
            opening_price: freshOrb.opening_price,
            gap_percent: freshOrb.gap_percent,
            orb_direction: freshOrb.orb_direction,
            nifty_orb_direction: orbData['_NIFTY']?.orb_direction || 'NEUTRAL',
            nifty_change_pct: orbData['_NIFTY']?.nifty_change_pct ?? 0,
            orb_pass: orbPass,
            orb_passes: existingPasses
          };
        }
      }
      console.log(`${LOG} Pass ${orbPass}: Fresh OHLC received for ${Object.keys(orbData).filter(k => k !== '_NIFTY').length} symbols`);
    } catch (freshErr) {
      console.error(`${LOG} Pass ${orbPass}: Fresh OHLC fetch failed, falling back to stored data: ${freshErr.message}`);
      // Fallback to stored data
      for (const pick of eligiblePicks) {
        if (pick.orb?.high) {
          orbData[pick.symbol] = {
            high: pick.orb.high, low: pick.orb.low,
            opening_price: pick.orb.opening_price,
            gap_percent: pick.orb.gap_percent,
            orb_direction: pick.orb.orb_direction
          };
        }
      }
      const firstWithNifty = eligiblePicks.find(p => p.orb?.nifty_orb_direction);
      if (firstWithNifty) {
        orbData['_NIFTY'] = { orb_direction: firstWithNifty.orb.nifty_orb_direction, nifty_change_pct: firstWithNifty.orb.nifty_change_pct ?? 0 };
      }
    }
  } else {
    // Pass 1: use stored ORB data from startOrbCollection
    console.log(`${LOG} [DEBUG] Pass 1: Loading stored ORB data from DB...`);
    for (const pick of eligiblePicks) {
      if (pick.orb?.high) {
        orbData[pick.symbol] = {
          high: pick.orb.high, low: pick.orb.low,
          opening_price: pick.orb.opening_price,
          gap_percent: pick.orb.gap_percent,
          orb_direction: pick.orb.orb_direction
        };
        console.log(`${LOG} [DEBUG] ${pick.symbol}: stored ORB found — H=${pick.orb.high} L=${pick.orb.low} dir=${pick.orb.orb_direction}`);
      } else {
        console.warn(`${LOG} [WARN] ${pick.symbol}: NO stored ORB data (orb.high is ${pick.orb?.high}) — startOrbCollection may have failed to save`);
      }
    }
    const firstWithNifty = eligiblePicks.find(p => p.orb?.nifty_orb_direction);
    if (firstWithNifty) {
      orbData['_NIFTY'] = { orb_direction: firstWithNifty.orb.nifty_orb_direction, nifty_change_pct: firstWithNifty.orb.nifty_change_pct ?? 0 };
    }
    const orbDataKeys = Object.keys(orbData);
    console.log(`${LOG} [DEBUG] orbData has ${orbDataKeys.length} keys: ${orbDataKeys.join(', ') || 'EMPTY — all validation will return no_orb_data'}`);
  }

  // Pass regime alignment info so nifty_alignment can use wider threshold for regime-aligned trades
  const regime = doc.market_context?.regime || 'UNKNOWN';
  for (const pick of eligiblePicks) {
    pick.regime_aligned = isRegimeAligned(pick.direction, regime);
  }

  // Fetch 15m volume from Upstox for Check 6 volume gate (auto-pass on failure)
  let orbVolumeMap = null;
  try {
    console.log(`${LOG} [DEBUG] Fetching Upstox volume for ${eligiblePicks.length} picks...`);
    orbVolumeMap = await fetchOrbVolume(eligiblePicks);
    console.log(`${LOG} [DEBUG] fetchOrbVolume result: ${orbVolumeMap ? Object.keys(orbVolumeMap).join(', ') : 'null (all auto-pass)'}`);
  } catch (volErr) {
    console.warn(`${LOG} [WARN] fetchOrbVolume failed: ${volErr.message} — Check 6 will auto-pass`);
  }

  console.log(`${LOG} [DEBUG] Calling validatePicks() — regime=${regime}, orbPass=${orbPass}`);
  validatePicks(eligiblePicks, orbData, regime, orbPass, orbVolumeMap);
  console.log(`${LOG} [DEBUG] validatePicks() complete — results: ${eligiblePicks.map(p => `${p.symbol}=${p.validation?.passed ? 'PASS' : 'FAIL(' + (p.validation?.skip_reason || '?') + ')'}`).join(', ')}`);

  // Record pass history on each pick for analytics
  for (const pick of eligiblePicks) {
    if (!pick.orb) pick.orb = {};
    if (!pick.orb.orb_passes) pick.orb.orb_passes = [];

    const failedChecks = pick.validation?.skip_reason || null;
    const isPermanentFail = failedChecks && failedChecks.split(', ').every(c => PERMANENT_FAIL_CHECKS.includes(c));

    pick.orb.orb_passes.push({
      pass: orbPass,
      timestamp: new Date(),
      orb_high: pick.orb?.high,
      orb_low: pick.orb?.low,
      result: pick.validation?.passed ? 'PASSED' : (isPermanentFail ? 'PERMANENT_FAIL' : 'FAILED'),
      reason: failedChecks
    });
  }

  // Step 2: Pure-ORB level assignment.
  // Pre-market picks arrive with pick.levels === null (Step 5 deprecated).
  // Here we build pick.levels fresh from the orb_alignment check output.
  //   entry  = ORB breakout price
  //   stop   = opposite end of ORB
  //   target = entry ± (risk × 2)  (fixed 2:1 R:R — computed in orbValidationService)
  for (const pick of eligiblePicks) {
    if (pick.validation?.passed && pick.validation.checks.orb_alignment?.new_entry) {
      const orbCheck = pick.validation.checks.orb_alignment;
      const risk   = Math.abs(orbCheck.new_entry - orbCheck.new_stop);
      const reward = Math.abs(orbCheck.new_target - orbCheck.new_entry);
      pick.levels = {
        entry:  orbCheck.new_entry,
        stop:   orbCheck.new_stop,
        target: orbCheck.new_target,
        risk_reward: risk > 0 ? Math.round((reward / risk) * 100) / 100 : 0,
        entry_type: pick.direction === 'LONG' ? 'buy_above' : 'sell_below',
        mode: 'orb',
        source: 'orb_breakout',
      };
      pick.validation.levels_recalculated = true;
    }
  }
  // Mongoose needs a nudge to detect nested changes on subdocument arrays
  doc.markModified('picks');
    } // end disabled ORB validation
    // ─────────────────────────────────────────────────────────────────────
  }


  // Step 3: Separate validated vs skipped
  const validatedPicks = eligiblePicks.filter(p => p.validation?.passed);
  const skippedPicks = eligiblePicks.filter(p => !p.validation?.passed);

  for (const pick of skippedPicks) {
    const failedChecks = pick.validation?.skip_reason || '';
    const isPermanentFail = failedChecks && failedChecks.split(', ').every(c => PERMANENT_FAIL_CHECKS.includes(c));
    const isGapDirectionFail = failedChecks.split(', ').includes('gap_direction');

    if (isFinalPass || isPermanentFail) {
      // Gap-fade picks that never faded get a distinct terminal status
      if (isGapDirectionFail && !isPermanentFail) {
        pick.trade.status = 'GAP_FADE_EXPIRED';
        pick.trade.exit_reason = `gap_fade_expired_pass_${orbPass}: LTP never faded through today's open`;
        pick.kite.kite_status = 'skipped';
        // Pure-ORB: pick.levels is null for failed-validation picks. Log the
        // opening price (the fade anchor) instead.
        const fadeAnchor = pick.orb?.opening_price ?? 'n/a';
        console.log(`${LOG} ${pick.symbol}: GAP_FADE_EXPIRED (pass ${orbPass}) — gap never faded through open=${fadeAnchor}`);
      } else {
        pick.trade.status = 'SKIPPED';
        pick.trade.exit_reason = `validation_failed_pass_${orbPass}: ${failedChecks}`;
        pick.kite.kite_status = 'skipped';
        const reason = isPermanentFail ? 'permanent' : 'final pass';
        console.log(`${LOG} ${pick.symbol}: SKIPPED (${reason}, pass ${orbPass}) — ${failedChecks}`);
      }
    } else {
      // Retryable failure — track gap-fade watches distinctly
      if (isGapDirectionFail) {
        pick.trade.status = 'GAP_FADE_WATCH';
        // Pure-ORB: log the fade anchor (today's open), not pick.levels.entry
        const fadeAnchor = pick.orb?.opening_price ?? 'n/a';
        console.log(`${LOG} ${pick.symbol}: GAP_FADE_WATCH (pass ${orbPass}, gap=${pick.orb?.gap_percent}%) — monitoring for fade through open=${fadeAnchor} at pass ${orbPass + 1} (${ORB_PASS_LABELS[orbPass + 1]})`);
      } else {
        pick.trade.status = 'PENDING';
        console.log(`${LOG} ${pick.symbol}: FAILED pass ${orbPass} (retryable: ${failedChecks}) — will retry at pass ${orbPass + 1} (${ORB_PASS_LABELS[orbPass + 1]})`);
      }
    }
  }

  const retryingPicks = skippedPicks.filter(p => p.trade.status === 'PENDING');
  if (validatedPicks.length === 0) {
    console.log(`${LOG} All picks failed validation on pass ${orbPass} — ${retryingPicks.length} retrying, ${skippedPicks.length - retryingPicks.length} permanently skipped`);
    console.log(`${LOG} [DEBUG] Saving failed validation results — statuses: ${eligiblePicks.map(p => `${p.symbol}=${p.trade.status}`).join(', ')}`);
    try {
      await doc.save();
      console.log(`${LOG} [DEBUG] doc.save() SUCCESS (all failed) — updatedAt=${doc.updatedAt}`);
    } catch (saveErr) {
      console.error(`${LOG} [ERROR] doc.save() FAILED after validation: ${saveErr.message}`);
      console.error(`${LOG} [ERROR] Mongoose errors:`, saveErr.errors ? JSON.stringify(Object.keys(saveErr.errors)) : 'none');
    }
    return { success: true, message: `All picks failed pass ${orbPass}`, orders: 0, validated: 0, skipped: skippedPicks.length - retryingPicks.length, retrying: retryingPicks.length, orbPass };
  }

  // Mark as VALIDATED
  for (const pick of validatedPicks) {
    pick.trade.status = 'VALIDATED';
    pick.kite.kite_status = 'validated';
  }

  // Circuit breaker check before placing ORB entries
  const cbCheck = await checkCircuitBreaker();
  if (!cbCheck.allowed) {
    console.log(`${LOG} ⛔ CIRCUIT BREAKER: ${cbCheck.reason} — skipping ORB entries`);
    for (const pick of validatedPicks) {
      pick.trade.status = 'SKIPPED';
      pick.trade.exit_reason = `circuit_breaker: ${cbCheck.reason}`;
      pick.kite.kite_status = 'skipped';
    }
    try {
      await doc.save();
      console.log(`${LOG} [DEBUG] doc.save() SUCCESS (circuit breaker) — updatedAt=${doc.updatedAt}`);
    } catch (saveErr) {
      console.error(`${LOG} [ERROR] doc.save() FAILED (circuit breaker): ${saveErr.message}`);
    }
    return { success: true, message: `Circuit breaker: ${cbCheck.reason}`, orders: 0, validated: validatedPicks.length, skipped: skippedPicks.length };
  }

  // Step 3: Capital allocation + order placement (with ATR-based sizing)
  const MAX_WEIGHT = 0.45;
  // ATR constants from dailyPicksConstants.js (same values for pre-market and ORB entries)
  const BASELINE_ATR_PCT_ORB = BASELINE_ATR_PCT;
  const MIN_ATR_MULT_ORB = MIN_ATR_MULT;
  const MAX_ATR_MULT_ORB = MAX_ATR_MULT;
  const balance = await kiteOrderService.getAvailableBalance();
  console.log(`${LOG} Balance: ₹${balance.available}, Intraday budget: ₹${balance.usableIntraday}`);

  const totalScore = validatedPicks.reduce((sum, p) => sum + p.rank_score, 0);
  const rawWeights = validatedPicks.map(p => Math.min(p.rank_score / totalScore, MAX_WEIGHT));
  const weightSum = rawWeights.reduce((s, w) => s + w, 0);
  const allocations = validatedPicks.map((pick, i) => {
    let capital = Math.floor(balance.usableIntraday * (rawWeights[i] / weightSum));
    // ATR-based sizing: scale inversely with volatility
    const atrPct = pick._ohlcv?.atr && pick.levels?.entry
      ? (pick._ohlcv.atr / pick.levels.entry) * 100
      : null;
    if (atrPct && atrPct > 0) {
      const atrMult = Math.max(MIN_ATR_MULT_ORB, Math.min(MAX_ATR_MULT_ORB, BASELINE_ATR_PCT_ORB / atrPct));
      capital = Math.floor(capital * atrMult);
      console.log(`${LOG}   ${pick.symbol}: ATR=${round2(atrPct)}% → mult=${round2(atrMult)}x → capital=₹${capital}`);
    }
    return { pick, capital };
  });

  console.log(`${LOG} Capital allocation: totalScore=${totalScore} intradayBudget=₹${balance.usableIntraday}`);
  for (const { pick, capital } of allocations) {
    const cappedAmount = Math.min(capital, kiteConfig.MAX_ORDER_VALUE);
    const estQty = Math.floor(cappedAmount / pick.levels.entry);
    console.log(`${LOG}   ${pick.symbol}: weight=${round2(rawWeights[validatedPicks.indexOf(pick)] / weightSum * 100)}% capital=₹${capital} capped=₹${cappedAmount} estQty=${estQty} entry=₹${pick.levels.entry}`);
  }

  let ordersPlaced = 0;

  for (const { pick, capital } of allocations) {
    const orderAmount = Math.min(capital, kiteConfig.MAX_ORDER_VALUE);
    const qty = Math.floor(orderAmount / pick.levels.entry);
    if (qty <= 0) {
      console.log(`${LOG} ${pick.symbol}: qty=0 (price ₹${pick.levels.entry} > capital ₹${orderAmount}) — skipping`);
      pick.trade.status = 'SKIPPED';
      pick.kite.kite_status = 'skipped';
      continue;
    }

    // ── Order type: MARKET for scanner.py picks, SL-M for ORB picks ─────────
    const isScannerPick = pick.levels?.mode === 'scanner';

    // SL-M / trigger logic (ORB path only — kept for reference, unused in scanner path)
    const ORB_SLIPPAGE_BUFFER = 0.0015;
    const orbRawTrigger = pick.direction === 'LONG'
      ? pick.levels.entry * (1 + ORB_SLIPPAGE_BUFFER)
      : pick.levels.entry * (1 - ORB_SLIPPAGE_BUFFER);
    const triggerPrice = isScannerPick ? null : roundToTick(orbRawTrigger);
    const originalEntry = pick.validation?.checks?.orb_alignment?.original_entry;

    if (isScannerPick) {
      console.log(`${LOG} ${pick.symbol}: MARKET ${pick.direction} qty=${qty} entry=₹${pick.levels.entry} stop=₹${pick.levels.stop} target=₹${pick.levels.target}`);
    } else {
      console.log(`${LOG} ${pick.symbol}: SL-M ${pick.direction} qty=${qty} trigger=₹${triggerPrice} (original entry=₹${originalEntry || 'N/A'})`);
    }

    if (dryRun) {
      console.log(`${LOG} [DRY RUN] Would place ${isScannerPick ? 'MARKET' : 'SL-M'} order for ${pick.symbol}`);
      continue;
    }

    try {
      const orderParams = {
        tradingsymbol: pick.symbol,
        exchange: 'NSE',
        transaction_type: pick.direction === 'LONG' ? 'BUY' : 'SELL',
        order_type: isScannerPick ? 'MARKET' : 'SL-M',
        product: 'MIS',
        quantity: qty,
        ...(isScannerPick ? {} : { trigger_price: triggerPrice }),
        simulationId: `daily_pick_${pick.symbol}`,
        orderType: 'ENTRY',
        source: 'DAILY_PICKS'
      };

      const result = await kiteOrderService.placeOrder(orderParams);

      if (result.success && result.orderId) {
        pick.trade.status = 'ORDER_PLACED';
        pick.trade.qty = qty;
        pick.kite.entry_order_id = result.orderId;
        pick.kite.kite_status = 'order_placed';
        ordersPlaced++;

        // ── TRADE CARD: Entry Order Placed ──
        const riskPerShare = Math.abs(pick.levels.entry - pick.levels.stop);
        const maxLoss = round2(riskPerShare * qty);
        const rewardPerShare = Math.abs(pick.levels.target - pick.levels.entry);
        const maxProfit = round2(rewardPerShare * qty);
        console.log(`${LOG} ┌── TRADE: ${pick.symbol} ──────────────────────────────`);
        console.log(`${LOG} │ Direction: ${pick.direction} | Scan: ${pick.scan_type} | Mode: ${pick.levels.mode}`);
        console.log(`${LOG} │ Entry: ₹${pick.levels.entry}${!isScannerPick ? ` (ORB, original=₹${originalEntry || 'N/A'})` : ' (scanner structural)'} | Stop: ₹${pick.levels.stop} | Target: ₹${pick.levels.target}`);
        console.log(`${LOG} │ T2: ${pick.levels.target2 ? '₹' + pick.levels.target2 : 'N/A'} | T3: ${pick.levels.target3 ? '₹' + pick.levels.target3 : 'N/A'}`);
        console.log(`${LOG} │ R:R=${pick.levels.risk_reward} | Risk=${pick.levels.risk_pct}% | Reward=${pick.levels.reward_pct}%`);
        console.log(`${LOG} │ Order → ${isScannerPick ? 'MARKET' : 'SL-M'} qty=${qty}${!isScannerPick ? ` trigger=₹${triggerPrice}` : ''} orderId=${result.orderId}`);
        console.log(`${LOG} │ Capital: ₹${orderAmount} | Max Loss: ₹${maxLoss} | Max Profit: ₹${maxProfit}`);
        console.log(`${LOG} │ Reason: ${pick.levels.reason}`);
        console.log(`${LOG} └─────────────────────────────────────────────────────`);
      } else {
        pick.trade.status = 'FAILED';
        pick.kite.kite_status = 'failed';
        console.error(`${LOG} ❌ ${pick.symbol}: Order placement failed — ${JSON.stringify(result)}`);
      }
    } catch (err) {
      pick.trade.status = 'FAILED';
      pick.kite.kite_status = 'failed';
      console.error(`${LOG} ❌ ${pick.symbol}: Order error —`, err.message);
    }
  }

  console.log(`${LOG} [DEBUG] Saving after order placement — statuses: ${eligiblePicks.map(p => `${p.symbol}=${p.trade.status}`).join(', ')}`);
  try {
    await doc.save();
    console.log(`${LOG} [DEBUG] doc.save() SUCCESS (after orders) — updatedAt=${doc.updatedAt}`);
  } catch (saveErr) {
    console.error(`${LOG} [ERROR] doc.save() FAILED after order placement: ${saveErr.message}`);
    console.error(`${LOG} [ERROR] Mongoose errors:`, saveErr.errors ? JSON.stringify(Object.keys(saveErr.errors)) : 'none');
  }
  console.log(`${LOG} Pass ${orbPass} result: ${validatedPicks.length} validated, ${skippedPicks.length - retryingPicks.length} skipped, ${retryingPicks.length} retrying, ${ordersPlaced} orders placed`);

  return { success: true, validated: validatedPicks.length, skipped: skippedPicks.length - retryingPicks.length, retrying: retryingPicks.length, orders: ordersPlaced, orbPass };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: FILL LISTENER — Instant SL+Target on postback fill
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Place SL-M stop + LIMIT target immediately after entry fill.
 * Shared by both postback listener and polling fallback.
 * Idempotency: checks kite_status !== 'sl_target_placed' before acting.
 */
async function placeSLAndTarget(pick, doc, entryPrice) {
  // Idempotency guard — prevent double-placement
  if (pick.kite.kite_status === 'sl_target_placed' || pick.trade.status !== 'ORDER_PLACED') {
    console.log(`${LOG} ${pick.symbol}: SL+target already placed or status changed — skipping`);
    return;
  }

  // Also handle deferred picks that are now ready (entered_awaiting_915)
  if (pick.kite.kite_status === 'entered_awaiting_915' && pick.trade.status === 'ENTERED') {
    // This is a deferred call from post-9:15 scheduler — proceed with stored entry price
    entryPrice = entryPrice || pick.trade.entry_price;
    console.log(`${LOG} ${pick.symbol}: Processing deferred SL+target (was awaiting 9:15 AM) — entry @ ₹${entryPrice}`);
  }

  // Pre-9:15 AM guard: defer SL/target placement if market hasn't opened yet
  // AMO fills during pre-open (~9:08 AM) but regular orders rejected before 9:15 AM
  const istNow = MarketHoursUtil.toIST(new Date());
  const istMinutes = istNow.getHours() * 60 + istNow.getMinutes();
  if (istMinutes < 9 * 60 + 15 && pick.kite.kite_status !== 'entered_awaiting_915') {
    console.log(`${LOG} ${pick.symbol}: Fill @ ₹${entryPrice} received at ${istNow.toTimeString().slice(0, 8)} IST (before 9:15 AM) — deferring SL+target`);
    pick.trade.status = 'ENTERED';
    pick.trade.entry_price = entryPrice;
    pick.trade.entry_time = new Date();
    pick.kite.kite_status = 'entered_awaiting_915';
    await doc.save();
    return; // Exit early — post-9:15 scheduler will call us again
  }

  pick.trade.status = 'ENTERED';
  pick.trade.entry_price = entryPrice;
  pick.trade.entry_time = new Date();

  // Preserve structural target from pre-market pipeline (Daily R1, 1H swing, etc.)
  // Only fall back to flat 2% if structural target is somehow missing
  const structuralTarget = pick.levels.target;
  const target = (structuralTarget && structuralTarget > 0)
    ? structuralTarget
    : (pick.direction === 'LONG'
        ? round2(entryPrice * (1 + TARGET_PCT / 100))
        : round2(entryPrice * (1 - TARGET_PCT / 100)));
  pick.levels.target = target;
  const targetSource = (structuralTarget && structuralTarget > 0) ? 'structural' : 'flat_2pct_fallback';

  // All daily picks use MIS (intraday) — separate SL-M + LIMIT orders
  const product = 'MIS';
  const exitSide = pick.direction === 'LONG' ? 'SELL' : 'BUY';

  console.log(`${LOG} ✅ ${pick.symbol}: Filled @ ₹${entryPrice} — placing SL @ ₹${pick.levels.stop} + target @ ₹${target} (${targetSource}) product=${product}`);

  let slPlaced = false;
  let tgtPlaced = false;

  // MIS allows multiple pending orders — place SL-M + LIMIT separately
  // Retry SL-M up to 2 attempts (critical — position must be protected)
  for (let slAttempt = 1; slAttempt <= 2 && !slPlaced; slAttempt++) {
    try {
      if (slAttempt > 1) {
        console.log(`${LOG} ${pick.symbol}: SL-M retry attempt ${slAttempt}/2 after ${slAttempt === 2 ? '3s' : '1s'} wait`);
        await delay(slAttempt === 2 ? 3000 : 1000);
      }
      const slResult = await kiteOrderService.placeOrder({
        tradingsymbol: pick.symbol, exchange: 'NSE',
        transaction_type: exitSide, order_type: 'SL-M',
        trigger_price: pick.levels.stop, product: 'MIS',
        quantity: pick.trade.qty,
        simulationId: `daily_pick_sl_${pick.symbol}`,
        orderType: 'STOP_LOSS', source: 'DAILY_PICKS'
      });
      if (slResult.success) {
        pick.kite.stop_order_id = slResult.orderId;
        slPlaced = true;
        console.log(`${LOG} ${pick.symbol}: SL-M placed @ ₹${pick.levels.stop} — orderId=${slResult.orderId}${slAttempt > 1 ? ` (attempt ${slAttempt})` : ''}`);
      }
    } catch (err) {
      console.error(`${LOG} ${pick.symbol}: SL-M error (attempt ${slAttempt}/2):`, err.message);
    }
  }

  try {
    const tgtResult = await kiteOrderService.placeOrder({
      tradingsymbol: pick.symbol, exchange: 'NSE',
      transaction_type: exitSide, order_type: 'LIMIT',
      price: target, product: 'MIS',
      quantity: pick.trade.qty,
      simulationId: `daily_pick_tgt_${pick.symbol}`,
      orderType: 'TARGET', source: 'DAILY_PICKS'
    });
    if (tgtResult.success) {
      pick.kite.target_order_id = tgtResult.orderId;
      tgtPlaced = true;
      console.log(`${LOG} ${pick.symbol}: Target LIMIT placed @ ₹${target} — orderId=${tgtResult.orderId}`);
    }
  } catch (err) {
    console.error(`${LOG} ${pick.symbol}: Target error:`, err.message);
  }

  if (slPlaced && tgtPlaced) {
    pick.kite.kite_status = 'sl_target_placed';

    // ── TRADE CARD: Position Live ──
    const riskPerShare = Math.abs(entryPrice - pick.levels.stop);
    const maxLoss = round2(riskPerShare * pick.trade.qty);
    const rewardPerShare = Math.abs(target - entryPrice);
    const maxProfit = round2(rewardPerShare * pick.trade.qty);
    const capital = round2(entryPrice * pick.trade.qty);
    const slippage = round2(entryPrice - pick.levels.entry);
    console.log(`${LOG} ┌── POSITION LIVE: ${pick.symbol} ────────────────────────`);
    console.log(`${LOG} │ Direction: ${pick.direction} | Scan: ${pick.scan_type}`);
    console.log(`${LOG} │ Planned Entry: ₹${pick.levels.entry} → Actual Fill: ₹${entryPrice} (slippage: ${slippage >= 0 ? '+' : ''}₹${slippage})`);
    console.log(`${LOG} │ Stop: ₹${pick.levels.stop} (SL-M orderId=${pick.kite.stop_order_id})`);
    console.log(`${LOG} │ Target: ₹${target} [${targetSource}] (LIMIT orderId=${pick.kite.target_order_id})`);
    console.log(`${LOG} │ Qty: ${pick.trade.qty} | Capital Deployed: ₹${capital}`);
    console.log(`${LOG} │ Max Loss: ₹${maxLoss} (${round2((riskPerShare / entryPrice) * 100)}%) | Max Profit: ₹${maxProfit} (${round2((rewardPerShare / entryPrice) * 100)}%)`);
    console.log(`${LOG} └─────────────────────────────────────────────────────`);
  } else if (!slPlaced) {
    // CRITICAL: No stop-loss — emergency market exit
    console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} SL-M failed — emergency market exit`);
    try {
      await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
        'CRITICAL: SL Failed — Emergency Exit',
        `${pick.symbol} SL-M placement failed. Emergency market exit attempted.`,
        { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
      );
    } catch (_) { /* ignore */ }

    try {
      if (tgtPlaced && pick.kite.target_order_id) {
        await kiteOrderService.cancelOrder(pick.kite.target_order_id);
      }
      const exitResult = await kiteOrderService.placeOrder({
        tradingsymbol: pick.symbol,
        exchange: 'NSE',
        transaction_type: pick.direction === 'LONG' ? 'SELL' : 'BUY',
        order_type: 'MARKET',
        product,
        quantity: pick.trade.qty,
        simulationId: `daily_pick_emergency_${pick.symbol}`,
        orderType: 'EMERGENCY_EXIT',
        source: 'DAILY_PICKS'
      });
      if (exitResult.success) {
        await delay(3000);
        try {
          const exitOrder = await kiteOrderService.getOrderDetails(exitResult.orderId);
          pick.trade.exit_price = exitOrder?.average_price || pick.trade.entry_price;
          pick.trade.exit_price_source = exitOrder?.average_price ? 'order_fill' : 'ltp_approximate';
        } catch (_) {
          pick.trade.exit_price = pick.trade.entry_price;
          pick.trade.exit_price_source = 'ltp_approximate';
        }
      } else {
        pick.trade.exit_price = pick.trade.entry_price;
        pick.trade.exit_price_source = 'ltp_approximate';
      }
    } catch (exitErr) {
      console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} emergency exit also failed:`, exitErr.message);
      pick.trade.exit_price = pick.trade.entry_price;
      pick.trade.exit_price_source = 'ltp_approximate';
    }
    pick.trade.status = 'FAILED';
    pick.trade.exit_time = new Date();
    pick.trade.exit_reason = 'sl_placement_failed_emergency_exit';
    calculatePnl(pick);
    pick.kite.kite_status = 'failed';
  } else {
    // Target failed but SL is in place — acceptable
    console.error(`${LOG} ⚠️ ${pick.symbol}: Target placement failed — SL active, will rely on stop or 3 PM exit`);
    pick.kite.kite_status = 'sl_target_placed';
  }

  await doc.save();
}

/**
 * Initialize fill listener — subscribes to postback events for instant SL+target.
 * Called once on server startup.
 */
function initFillListener() {
  console.log(`${LOG} Initializing fill listener (postback → instant SL+target)`);

  kiteOrderEvents.on('order:complete', async (postback) => {
    try {
      console.log(`${LOG} [FILL-LISTENER] Received order:complete — orderId=${postback.order_id} symbol=${postback.tradingsymbol} avg_price=${postback.average_price}`);

      const doc = await DailyPick.findToday();
      if (!doc) {
        console.log(`${LOG} [FILL-LISTENER] No DailyPick doc today — ignoring postback`);
        return;
      }

      // Match regular/AMO orders by order ID
      let pick = doc.picks.find(p =>
        p.kite.entry_order_id === postback.order_id &&
        p.trade.status === 'ORDER_PLACED' &&
        p.kite.kite_status !== 'sl_target_placed'
      );

      // Match GTT fills by tradingsymbol — GTT child orders have a different ID than the trigger ID
      if (!pick) {
        pick = doc.picks.find(p =>
          p.symbol === postback.tradingsymbol &&
          p.trade.status === 'ORDER_PLACED' &&
          p.kite.kite_status === 'gtt_placed'
        );
        if (pick) {
          console.log(`${LOG} [FILL-LISTENER] ${pick.symbol}: Matched GTT fill by tradingsymbol — child orderId=${postback.order_id} (GTT triggerId=${pick.kite.entry_order_id})`);
        }
      }

      if (!pick) {
        console.log(`${LOG} [FILL-LISTENER] orderId=${postback.order_id} not matched to any ORDER_PLACED daily pick — ignoring (may be swing/manual order)`);
        return;
      }

      console.log(`${LOG} [FILL-LISTENER] ${pick.symbol}: Entry fill detected via postback — orderId=${postback.order_id} price=₹${postback.average_price} qty=${postback.filled_quantity}`);
      await placeSLAndTarget(pick, doc, parseFloat(postback.average_price));
      console.log(`${LOG} [FILL-LISTENER] ${pick.symbol}: SL+target placement complete — kite_status=${pick.kite.kite_status}`);
    } catch (err) {
      console.error(`${LOG} [FILL-LISTENER] Error processing fill:`, err.message, err.stack);
    }
  });

  console.log(`${LOG} Fill listener active`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: FILL CHECK FALLBACK — Polling backup (every 2 min, 9:30-10:30)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Polling fallback for fill detection. Postback handles most fills instantly,
 * but this catches any that slip through (e.g. postback delayed or missed).
 * Idempotency: skips picks where SL+target already placed by postback listener.
 */
async function checkFillsFallback(options = {}) {
  if (!isKiteIntegrationEnabled()) return { success: true, message: 'Kite not enabled' };

  const doc = await DailyPick.findToday();
  if (!doc) return { success: true, message: 'No picks today' };

  // Handle deferred SL+target placements from pre-9:15 AM AMO fills
  const istNow = MarketHoursUtil.toIST(new Date());
  const istMinutes = istNow.getHours() * 60 + istNow.getMinutes();
  if (istMinutes >= 9 * 60 + 15) {
    const deferredPicks = doc.picks.filter(p =>
      p.kite.kite_status === 'entered_awaiting_915' && p.trade.status === 'ENTERED'
    );
    if (deferredPicks.length > 0) {
      console.log(`${LOG} [FILL-FALLBACK] Processing ${deferredPicks.length} deferred SL+target placements (post-9:15 AM)`);
      for (const pick of deferredPicks) {
        try {
          await placeSLAndTarget(pick, doc, pick.trade.entry_price);
        } catch (err) {
          console.error(`${LOG} [FILL-FALLBACK] Deferred SL+target failed for ${pick.symbol}:`, err.message);
        }
      }
    }
  }

  const orderPlacedPicks = doc.picks.filter(p =>
    p.trade.status === 'ORDER_PLACED' && p.kite.kite_status !== 'sl_target_placed'
  );
  if (orderPlacedPicks.length === 0) return { success: true, message: 'No pending fills' };

  console.log(`${LOG} [FILL-FALLBACK] Checking ${orderPlacedPicks.length} picks: ${orderPlacedPicks.map(p => p.symbol).join(', ')}`);

  let filled = 0;

  // Fetch all active GTTs once (for GTT fill detection)
  let activeGTTs = null;
  const hasGTTPicks = orderPlacedPicks.some(p => p.kite.kite_status === 'gtt_placed');
  if (hasGTTPicks) {
    try {
      activeGTTs = await kiteOrderService.getGTTs();
      console.log(`${LOG} [FILL-FALLBACK] Fetched ${activeGTTs.length} active GTTs for fill check`);
    } catch (err) {
      console.error(`${LOG} [FILL-FALLBACK] Failed to fetch GTTs:`, err.message);
    }
  }

  for (const pick of orderPlacedPicks) {
    try {
      if (pick.kite.kite_status === 'gtt_placed') {
        // GTT pick — check GTT status via API
        console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Checking GTT trigger ${pick.kite.entry_order_id}...`);
        if (!activeGTTs) continue;

        const gtt = activeGTTs.find(g => String(g.id) === String(pick.kite.entry_order_id));
        if (!gtt) {
          // GTT not in active list — likely triggered and completed already.
          // The postback listener should have caught it, but check LTP as fallback.
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: GTT ${pick.kite.entry_order_id} not found in active GTTs — may have already triggered. Postback listener should handle fill.`);
          continue;
        }

        const gttStatus = gtt.status?.toLowerCase();
        console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: GTT status=${gttStatus}`);

        if (gttStatus === 'triggered') {
          // GTT triggered — find the child order's fill price from GTT response
          const fillPrice = gtt.orders?.[0]?.result?.average_price || pick.levels.entry;
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: GTT triggered — fill @ ₹${fillPrice} — placing SL+target`);
          await placeSLAndTarget(pick, doc, fillPrice);
          filled++;
        } else if (gttStatus === 'cancelled' || gttStatus === 'rejected' || gttStatus === 'disabled') {
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: GTT ${gttStatus} — marking as SKIPPED`);
          pick.trade.status = 'SKIPPED';
          pick.kite.kite_status = 'skipped';
          await doc.save();
        } else {
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: GTT still active — will check next poll`);
        }

      } else {
        // Regular/AMO order — existing logic
        console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Checking entry order ${pick.kite.entry_order_id}...`);
        const order = await kiteOrderService.getOrderDetails(pick.kite.entry_order_id);
        if (!order) {
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Order not found — skipping`);
          continue;
        }

        const status = order.status?.toUpperCase();
        console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Order status=${status} avg_price=${order.average_price} filled_qty=${order.filled_quantity}`);

        if (status === 'COMPLETE') {
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Fill detected via polling @ ₹${order.average_price} — placing SL+target`);
          await placeSLAndTarget(pick, doc, order.average_price || pick.levels.entry);
          filled++;
        } else if (status === 'CANCELLED' || status === 'REJECTED') {
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Order ${status} — marking as SKIPPED`);
          pick.trade.status = 'SKIPPED';
          pick.kite.kite_status = 'skipped';
          await doc.save();
        } else {
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Still pending (status=${status}) — will check next poll`);
        }
      }
    } catch (err) {
      console.error(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Error —`, err.message);
    }
  }

  return { success: true, filled };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: CANCEL EXPIRED ENTRIES — 10:30 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cancel unfilled entry orders at 10:30 AM. Setup has expired.
 */
async function cancelExpiredEntries(options = {}) {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Cancelling expired entry orders (10:30 AM cutoff)`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) return { success: true, message: 'Kite not enabled' };

  const doc = await DailyPick.findToday();
  if (!doc) return { success: true, message: 'No picks today' };

  const orderPlacedPicks = doc.picks.filter(p => p.trade.status === 'ORDER_PLACED');
  if (orderPlacedPicks.length === 0) {
    console.log(`${LOG} No ORDER_PLACED picks to cancel`);
    return { success: true, cancelled: 0 };
  }

  let cancelled = 0;
  for (const pick of orderPlacedPicks) {
    try {
      console.log(`${LOG} ${pick.symbol}: Cancelling expired entry order ${pick.kite.entry_order_id}`);
      await kiteOrderService.cancelOrder(pick.kite.entry_order_id);
    } catch (err) {
      console.error(`${LOG} ${pick.symbol}: Cancel failed:`, err.message);
    }
    pick.trade.status = 'SKIPPED';
    pick.trade.exit_reason = 'setup_expired_1030';
    pick.kite.kite_status = 'skipped';
    cancelled++;
  }

  await doc.save();
  console.log(`${LOG} Cancelled ${cancelled} expired entries`);
  return { success: true, cancelled };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: ORDER MONITORING — Every 3 min (10:00 AM - 2:59 PM) + Trailing Stops
// ═══════════════════════════════════════════════════════════════════════════════

// Trailing, partial booking, sideways constants — ALL imported from dailyPicksConstants.js
// TRAIL_MIN_PROFIT_PCT, TRAIL_LOCK_RATIO, TRAIL_MIN_MINUTES, TRAIL_START_HOUR
// PARTIAL_BOOK_PCT, PARTIAL_BOOK_QTY_RATIO
// SIDEWAYS_EXIT_MINUTES, SIDEWAYS_THRESHOLD_PCT

/**
 * Monitor entered picks for stop/target fills + trailing stops.
 * When one fills, cancel the counterpart order.
 * After 12 PM, trail stops upward for profitable positions.
 */
async function monitorDailyPickOrders(options = {}) {
  const { dryRun = false } = options;

  console.log(`${LOG} Monitoring daily pick orders${dryRun ? ' [DRY RUN]' : ''}...`);

  if (!isKiteIntegrationEnabled()) return { success: true, message: 'Kite not enabled' };

  const doc = await DailyPick.findToday();
  if (!doc) return { success: true, message: 'No picks today' };

  const enteredPicks = doc.picks.filter(p => p.trade.status === 'ENTERED');
  if (enteredPicks.length === 0) {
    console.log(`${LOG} No ENTERED picks to monitor`);
    return { success: true, message: 'No active positions' };
  }

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} MONITOR RUN — ${enteredPicks.length} active positions`);
  for (const pick of enteredPicks) {
    const hasStop = !!pick.kite.stop_order_id;
    const hasTarget = !!pick.kite.target_order_id;
    const minSinceEntry = pick.trade.entry_time
      ? Math.round((Date.now() - new Date(pick.trade.entry_time).getTime()) / 60000)
      : '?';
    console.log(`${LOG}   ${pick.symbol}: ${pick.direction} entry=₹${pick.trade.entry_price} stop=₹${pick.levels.stop} target=₹${pick.levels.target} qty=${pick.trade.qty} SL=${hasStop ? 'YES' : 'NO'} TGT=${hasTarget ? 'YES' : 'NO'} age=${minSinceEntry}min partial=${pick._partial_booked ? 'YES' : 'NO'}`);
  }
  console.log(`${LOG} ════════════════════════════════════════`);

  // Midday intel re-check: at 12 PM, re-fetch global market intel for breaking events
  // If risk level escalates to EXTREME mid-day, tighten all stops to breakeven
  const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const istHourNow = istNow.getHours();
  const istMinNow = istNow.getMinutes();
  if (istHourNow === 12 && istMinNow < 20 && !doc._middayIntelChecked) {
    try {
      console.log(`${LOG} [MIDDAY-INTEL] 12 PM re-check — fetching fresh global intel...`);
      clearIntelCache(); // Force fresh fetch
      const middayIntel = await fetchGlobalMarketIntel();
      const middayAvoid = shouldAvoidTrading();

      if (middayAvoid.avoid) {
        console.log(`${LOG} [MIDDAY-INTEL] ⛔ EXTREME event detected mid-day: ${middayAvoid.reason}`);
        console.log(`${LOG} [MIDDAY-INTEL] Tightening all stops to breakeven or current price...`);

        for (const pick of enteredPicks) {
          if (!pick.trade.entry_price || !pick.kite.stop_order_id) continue;
          const breakeven = pick.trade.entry_price;
          const currentStop = pick.levels.stop;
          const shouldTighten = pick.direction === 'LONG' ? breakeven > currentStop : breakeven < currentStop;

          if (shouldTighten) {
            try {
              const newStop = roundToTick(breakeven);
              await kiteOrderService.modifyOrder(pick.kite.stop_order_id, { trigger_price: newStop });
              console.log(`${LOG} [MIDDAY-INTEL] ${pick.symbol}: Stop tightened ₹${currentStop} → ₹${newStop} (breakeven)`);
              pick.levels.stop = newStop;
              if (!pick.trailing_history) pick.trailing_history = [];
              pick.trailing_history.push({ timestamp: new Date(), old_stop: currentStop, new_stop: newStop, price_at_trail: breakeven, reason: 'midday_intel_extreme' });
            } catch (modErr) {
              console.error(`${LOG} [MIDDAY-INTEL] ${pick.symbol}: Stop modify failed: ${modErr.message}`);
            }
          }
        }

        try {
          await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
            '⛔ Midday Alert — Stops Tightened',
            `Midday intel re-check detected extreme risk: ${middayAvoid.reason}. All stops moved to breakeven.`,
            { type: 'MIDDAY_INTEL', route: '/daily-picks' }
          );
        } catch (_) { /* ignore */ }
      } else {
        console.log(`${LOG} [MIDDAY-INTEL] Risk level: ${middayIntel.risk_level} — no action needed`);
      }
      doc._middayIntelChecked = true;
    } catch (intelErr) {
      console.error(`${LOG} [MIDDAY-INTEL] Re-check failed (non-fatal): ${intelErr.message}`);
    }
  }

  let statusChanged = false;

  for (const pick of enteredPicks) {
    if (!pick.kite.stop_order_id && !pick.kite.target_order_id) {
      console.log(`${LOG} ${pick.symbol}: No protective orders — will be handled by 3 PM exit`);
      continue;
    }

    try {
      console.log(`${LOG} ${pick.symbol}: Checking SL=${pick.kite.stop_order_id || 'none'} TGT=${pick.kite.target_order_id || 'none'} (entry=₹${pick.trade.entry_price} stop=₹${pick.levels.stop} target=₹${pick.levels.target})`);

      const [stopOrder, targetOrder] = await Promise.all([
        pick.kite.stop_order_id ? kiteOrderService.getOrderDetails(pick.kite.stop_order_id) : null,
        pick.kite.target_order_id ? kiteOrderService.getOrderDetails(pick.kite.target_order_id) : null
      ]);

      const stopStatus = stopOrder?.status?.toUpperCase();
      const targetStatus = targetOrder?.status?.toUpperCase();
      console.log(`${LOG} ${pick.symbol}: SL status=${stopStatus || 'N/A'} TGT status=${targetStatus || 'N/A'}`);

      if (stopStatus === 'COMPLETE' && targetStatus === 'COMPLETE') {
        // Both filled — race condition
        console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} — BOTH stop and target filled!`);

        const correctiveSide = pick.direction === 'LONG' ? 'BUY' : 'SELL';
        if (!dryRun) {
          try {
            const correctiveResult = await kiteOrderService.placeOrder({
              tradingsymbol: pick.symbol,
              exchange: 'NSE',
              transaction_type: correctiveSide,
              order_type: 'MARKET',
              product: 'MIS',
              quantity: pick.trade.qty,
              simulationId: `daily_pick_corrective_${pick.symbol}`,
              orderType: 'CORRECTIVE',
              source: 'DAILY_PICKS'
            });
            if (correctiveResult.success) {
              console.log(`${LOG} ✅ ${pick.symbol}: Corrective ${correctiveSide} placed`);
            }
          } catch (corrErr) {
            console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} corrective order error:`, corrErr.message);
          }

          try {
            await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
              'CRITICAL: Both SL+Target Filled',
              `${pick.symbol}: Race condition. Corrective order placed.`,
              { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
            );
          } catch (_) { /* ignore */ }
        }

        pick.trade.status = 'STOPPED_OUT';
        pick.trade.exit_price = stopOrder.average_price;
        pick.trade.exit_time = new Date();
        pick.trade.exit_reason = 'stop_hit_race_condition';
        pick.trade.exit_price_source = 'order_fill';
        calculatePnl(pick);
        pick.kite.kite_status = 'completed';
        statusChanged = true;

      } else if (stopStatus === 'COMPLETE') {
        console.log(`${LOG} ${pick.symbol}: STOP HIT @ ₹${stopOrder.average_price}`);
        if (!dryRun && pick.kite.target_order_id) {
          try { await kiteOrderService.cancelOrder(pick.kite.target_order_id); }
          catch (e) { console.error(`${LOG} ${pick.symbol}: Cancel target failed:`, e.message); }
        }
        pick.trade.status = 'STOPPED_OUT';
        pick.trade.exit_price = stopOrder.average_price;
        pick.trade.exit_time = new Date();
        pick.trade.exit_reason = 'stop_hit';
        pick.trade.exit_price_source = 'order_fill';
        calculatePnl(pick);
        pick.kite.kite_status = 'completed';
        statusChanged = true;
        console.log(`${LOG} ${pick.symbol}: PnL: ₹${pick.trade.pnl} (${pick.trade.return_pct}%)`);

      } else if (targetStatus === 'COMPLETE') {
        console.log(`${LOG} ${pick.symbol}: TARGET HIT @ ₹${targetOrder.average_price}`);
        if (!dryRun && pick.kite.stop_order_id) {
          try { await kiteOrderService.cancelOrder(pick.kite.stop_order_id); }
          catch (e) { console.error(`${LOG} ${pick.symbol}: Cancel stop failed:`, e.message); }
        }
        pick.trade.status = 'TARGET_HIT';
        pick.trade.exit_price = targetOrder.average_price;
        pick.trade.exit_time = new Date();
        pick.trade.exit_reason = 'target_hit';
        pick.trade.exit_price_source = 'order_fill';
        calculatePnl(pick);
        pick.kite.kite_status = 'completed';
        statusChanged = true;
        console.log(`${LOG} ${pick.symbol}: PnL: ₹${pick.trade.pnl} (${pick.trade.return_pct}%)`);
      }
    } catch (err) {
      console.error(`${LOG} ${pick.symbol}: Monitor error —`, err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ENHANCED MONITORING: Trailing + Partial Profit Booking + Sideways Exit
  // ═══════════════════════════════════════════════════════════════════════════
  const istNow2 = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const istHour = istNow2.getHours();
  const istMinutes2 = istHour * 60 + istNow2.getMinutes();
  const stillEnteredPicks = doc.picks.filter(p => p.trade.status === 'ENTERED' && p.kite.stop_order_id);

  if (istHour >= TRAIL_START_HOUR && stillEnteredPicks.length > 0 && !dryRun) {
    console.log(`${LOG} [MONITOR+] Checking trailing/partial/sideways for ${stillEnteredPicks.length} positions`);

    // Fetch fresh LTP via Kite Connect API
    const symbols = stillEnteredPicks.map(p => `NSE:${p.symbol}`);
    try {
      const ltpData = await kiteOrderService.getLTP(symbols);

      for (const pick of stillEnteredPicks) {
        const currentPrice = ltpData[`NSE:${pick.symbol}`]?.last_price;
        if (!currentPrice || !pick.trade.entry_price) continue;

        const profitPct = ((currentPrice - pick.trade.entry_price) / pick.trade.entry_price) * 100 *
          (pick.direction === 'LONG' ? 1 : -1);
        const minutesSinceEntry = pick.trade.entry_time
          ? (Date.now() - new Date(pick.trade.entry_time).getTime()) / 60000
          : 999;

        // ── 1. PARTIAL PROFIT BOOKING (shared decision function) ──
        const partialDecision = checkPartialBooking({
          entryPrice: pick.trade.entry_price,
          currentPrice,
          targetPrice: pick.levels.target,
          direction: pick.direction,
          totalQty: pick.trade.qty,
          alreadyBooked: !!pick._partial_booked,
        });

        if (partialDecision.shouldBook) {
            {
              const partialQty = partialDecision.bookQty;
              console.log(`${LOG} [PARTIAL] ${pick.symbol}: Price ₹${currentPrice} reached book level ₹${round2(partialDecision.bookLevel)} — booking ${partialQty}/${pick.trade.qty} shares`);
              try {
                const exitSide = pick.direction === 'LONG' ? 'SELL' : 'BUY';
                const partialResult = await kiteOrderService.placeOrder({
                  tradingsymbol: pick.symbol, exchange: 'NSE',
                  transaction_type: exitSide, order_type: 'MARKET',
                  product: 'MIS', quantity: partialQty,
                  simulationId: `daily_pick_partial_${pick.symbol}`,
                  orderType: 'PARTIAL_EXIT', source: 'DAILY_PICKS'
                });

                if (partialResult.success) {
                  // Reduce remaining qty and update SL/target order quantities
                  const remainingQty = pick.trade.qty - partialQty;
                  pick._partial_booked = true;
                  pick.trade.partial_exit_qty = partialQty;
                  pick.trade.partial_exit_price = currentPrice;

                  // Modify SL and target orders to remaining qty
                  try {
                    if (pick.kite.stop_order_id) {
                      await kiteOrderService.modifyOrder(pick.kite.stop_order_id, { quantity: remainingQty });
                    }
                    if (pick.kite.target_order_id) {
                      await kiteOrderService.modifyOrder(pick.kite.target_order_id, { quantity: remainingQty });
                    }
                    pick.trade.qty = remainingQty;
                  } catch (modErr) {
                    console.error(`${LOG} [PARTIAL] ${pick.symbol}: Failed to modify SL/target qty:`, modErr.message);
                  }

                  // Move stop to breakeven after partial booking
                  const newStop = pick.trade.entry_price;
                  const currentStop = pick.levels.stop;
                  const shouldMove = pick.direction === 'LONG' ? newStop > currentStop : newStop < currentStop;
                  if (shouldMove) {
                    try {
                      await kiteOrderService.modifyOrder(pick.kite.stop_order_id, { trigger_price: newStop });
                      if (!pick.trailing_history) pick.trailing_history = [];
                      pick.trailing_history.push({ timestamp: new Date(), old_stop: currentStop, new_stop: newStop, price_at_trail: currentPrice });
                      pick.levels.stop = newStop;
                      console.log(`${LOG} [PARTIAL] ${pick.symbol}: Stop moved to breakeven ₹${newStop} after partial exit`);
                    } catch (_) { /* SL modify fail is non-fatal since we already booked profit */ }
                  }

                  statusChanged = true;
                  console.log(`${LOG} [PARTIAL] ✅ ${pick.symbol}: Booked ${partialQty} shares @ ₹${currentPrice}, remaining ${remainingQty}`);
                }
              } catch (err) {
                console.error(`${LOG} [PARTIAL] ${pick.symbol}: Partial exit failed:`, err.message);
              }
            }
        }

        // ── 1b. +1R BREAKEVEN (price-based, not time-based) ──
        // Move stop to breakeven as soon as profit reaches 1R (original risk distance)
        const isBullish = pick.direction === 'LONG';
        const originalRisk = Math.abs(pick.trade.entry_price - pick.levels.stop);
        const currentProfit = isBullish
          ? currentPrice - pick.trade.entry_price
          : pick.trade.entry_price - currentPrice;
        const profitR = originalRisk > 0 ? currentProfit / originalRisk : 0;

        if (profitR >= 1.0 && !pick._breakeven_moved) {
          const currentStop = pick.levels.stop;
          const beStop = pick.trade.entry_price;
          const shouldMove = isBullish ? beStop > currentStop : beStop < currentStop;

          if (shouldMove) {
            try {
              await kiteOrderService.modifyOrder(pick.kite.stop_order_id, { trigger_price: beStop });
              if (!pick.trailing_history) pick.trailing_history = [];
              pick.trailing_history.push({ timestamp: new Date(), old_stop: currentStop, new_stop: beStop, price_at_trail: currentPrice, reason: 'breakeven_1R' });
              pick.levels.stop = beStop;
              pick._breakeven_moved = true;
              statusChanged = true;
              console.log(`${LOG} [+1R BE] ${pick.symbol}: Profit ${round2(profitR)}R — stop moved to breakeven ₹${currentStop} → ₹${beStop}`);
            } catch (err) {
              console.error(`${LOG} [+1R BE] ${pick.symbol}: modifyOrder failed:`, err.message);
            }
          } else {
            pick._breakeven_moved = true; // Already at/above breakeven
          }
        }

        // ── 2. DYNAMIC TRAILING STOPS (Chandelier Exit via shared engine) ──
        // Tracks highest high since entry, trails using ATR-based multiplier
        // Falls back to fixed ratio if ATR not available

        // Track highest high / lowest low on the pick object (persists across monitor cycles)
        if (!pick._extreme_price) pick._extreme_price = pick.trade.entry_price;
        if (isBullish) {
          if (currentPrice > pick._extreme_price) pick._extreme_price = currentPrice;
        } else {
          if (currentPrice < pick._extreme_price) pick._extreme_price = currentPrice;
        }

        // Use ATR from enrichment step (stored on pick during scoring)
        const pickATR = pick._ohlcv?.atr || pick.indicators?.atr || 0;

        const currentStop = pick.levels.stop;
        const trail = computeDynamicTrail({
          entryPrice: pick.trade.entry_price,
          currentPrice,
          extremePrice: pick._extreme_price,
          currentStop,
          atr: pickATR,
          profitPct,
          minutesSinceEntry,
          istHour,
          isBullish,
          partialBooked: !!pick._partial_booked,
        });

        if (trail.shouldTrail) {
          try {
            await kiteOrderService.modifyOrder(pick.kite.stop_order_id, {
              trigger_price: trail.newStop
            });
            if (!pick.trailing_history) pick.trailing_history = [];
            pick.trailing_history.push({ timestamp: new Date(), old_stop: currentStop, new_stop: trail.newStop, price_at_trail: currentPrice, phase: trail.phase, method: trail.method });
            pick.levels.stop = trail.newStop;
            statusChanged = true;
            console.log(`${LOG} [TRAILING] ${pick.symbol}: Stop ₹${currentStop} → ₹${trail.newStop} [${trail.method} P${trail.phase}] (price=₹${currentPrice}, peak=₹${round2(pick._extreme_price)}, ${trail.reason})`);
          } catch (err) {
            console.error(`${LOG} [TRAILING] ${pick.symbol}: modifyOrder failed:`, err.message);
          }
        }

        // ── 3. SIDEWAYS EXIT (shared decision function) ──
        const sidewaysDecision = checkSidewaysExit(minutesSinceEntry, profitPct);
        if (sidewaysDecision.shouldExit) {
          console.log(`${LOG} [SIDEWAYS] ${pick.symbol}: ${sidewaysDecision.reason}, P&L=${round2(profitPct)}% — exiting dead position`);
          try {
            // Cancel protective orders
            if (pick.kite.stop_order_id) {
              try { await kiteOrderService.cancelOrder(pick.kite.stop_order_id); } catch (_) { /* ignore */ }
            }
            if (pick.kite.target_order_id) {
              try { await kiteOrderService.cancelOrder(pick.kite.target_order_id); } catch (_) { /* ignore */ }
            }
            await delay(1000);

            const exitSide = pick.direction === 'LONG' ? 'SELL' : 'BUY';
            const exitResult = await kiteOrderService.placeOrder({
              tradingsymbol: pick.symbol, exchange: 'NSE',
              transaction_type: exitSide, order_type: 'MARKET',
              product: 'MIS', quantity: pick.trade.qty,
              simulationId: `daily_pick_sideways_${pick.symbol}`,
              orderType: 'SIDEWAYS_EXIT', source: 'DAILY_PICKS'
            });

            if (exitResult.success) {
              await delay(2000);
              let exitPrice = currentPrice;
              try {
                const exitOrder = await kiteOrderService.getOrderDetails(exitResult.orderId);
                if (exitOrder?.average_price) exitPrice = exitOrder.average_price;
              } catch (_) { /* use LTP */ }

              pick.trade.status = 'TIME_EXIT';
              pick.trade.exit_price = exitPrice;
              pick.trade.exit_time = new Date();
              pick.trade.exit_reason = sidewaysDecision.reason;
              pick.trade.exit_price_source = 'order_fill';
              calculatePnl(pick);
              pick.kite.kite_status = 'completed';
              statusChanged = true;
              console.log(`${LOG} [SIDEWAYS] ✅ ${pick.symbol}: Exited @ ₹${exitPrice}, PnL: ₹${pick.trade.pnl}`);
            }
          } catch (err) {
            console.error(`${LOG} [SIDEWAYS] ${pick.symbol}: Exit failed:`, err.message);
          }
          continue; // Skip further checks (trailing etc.) for this pick after exit
        }
      }
    } catch (err) {
      console.error(`${LOG} [MONITOR+] LTP fetch failed:`, err.message);
    }
  }

  if (statusChanged) {
    updateDailyResults(doc);
    try {
      await doc.save();
      console.log(`${LOG} Updated results after status changes`);
    } catch (saveErr) {
      console.error(`${LOG} ⚠️ CRITICAL: Failed to save trade state changes:`, saveErr.message);
      try {
        await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
          'CRITICAL: Trade State Save Failed',
          `Monitor detected status changes but doc.save() failed.`,
          { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
        );
      } catch (_) { /* ignore */ }
    }
  }

  const stillEntered = enteredPicks.filter(p => p.trade.status === 'ENTERED').length;
  const exited = enteredPicks.length - stillEntered;

  // Daily P&L dashboard — aggregate all completed + in-progress trades
  const allPicks = doc.picks;
  const completed = allPicks.filter(p => ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT'].includes(p.trade.status));
  const totalRealizedPnl = completed.reduce((sum, p) => sum + (p.trade.pnl || 0), 0);
  const winners = completed.filter(p => (p.trade.pnl || 0) > 0).length;
  const losers = completed.filter(p => (p.trade.pnl || 0) < 0).length;
  console.log(`${LOG} ┌── DAILY DASHBOARD ──────────────────────────`);
  console.log(`${LOG} │ Active: ${stillEntered} | Completed: ${completed.length} (W:${winners} L:${losers})`);
  console.log(`${LOG} │ Realized P&L: ₹${round2(totalRealizedPnl)}`);
  for (const p of completed) {
    console.log(`${LOG} │   ${p.symbol}: ${p.trade.status} P&L=₹${round2(p.trade.pnl || 0)} (${p.trade.exit_reason || 'N/A'})`);
  }
  console.log(`${LOG} └──────────────────────────────────────────────`);

  return { success: true, active: stillEntered };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: 2:00 PM STOP TIGHTENING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tighten stops to breakeven for profitable positions at 2:00 PM.
 * For positions in profit → move stop to entry price (breakeven).
 * For positions at loss → keep original SL.
 */
async function tightenStops(options = {}) {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} 2:00 PM stop tightening`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) return { success: true, message: 'Kite not enabled' };

  const doc = await DailyPick.findToday();
  if (!doc) return { success: true, message: 'No picks today' };

  const enteredPicks = doc.picks.filter(p => p.trade.status === 'ENTERED' && p.kite.stop_order_id);
  if (enteredPicks.length === 0) {
    console.log(`${LOG} No ENTERED picks with stops to tighten`);
    return { success: true, tightened: 0 };
  }

  // Fetch fresh LTP via Kite Connect API
  const symbols = enteredPicks.map(p => `NSE:${p.symbol}`);
  let ltpData;
  try {
    console.log(`${LOG} [TIGHTEN] Fetching LTP for: ${symbols.join(', ')}`);
    ltpData = await kiteOrderService.getLTP(symbols);
  } catch (err) {
    console.error(`${LOG} LTP fetch failed for tightening:`, err.message);
    return { success: false, error: err.message };
  }

  let tightened = 0;

  for (const pick of enteredPicks) {
    const currentPrice = ltpData[`NSE:${pick.symbol}`]?.last_price;
    if (!currentPrice || !pick.trade.entry_price) continue;

    const profitPct = ((currentPrice - pick.trade.entry_price) / pick.trade.entry_price) * 100 *
      (pick.direction === 'LONG' ? 1 : -1);

    if (profitPct > 0) {
      // In profit → tighten to breakeven
      const newStop = pick.trade.entry_price;
      const currentStop = pick.levels.stop;
      const shouldTighten = pick.direction === 'LONG' ? newStop > currentStop : newStop < currentStop;

      if (shouldTighten) {
        try {
          await kiteOrderService.modifyOrder(pick.kite.stop_order_id, {
            trigger_price: newStop
          });

          if (!pick.trailing_history) pick.trailing_history = [];
          pick.trailing_history.push({
            timestamp: new Date(),
            old_stop: currentStop,
            new_stop: newStop,
            price_at_trail: currentPrice
          });
          pick.levels.stop = newStop;
          tightened++;

          console.log(`${LOG} ${pick.symbol}: Stop tightened to breakeven ₹${newStop} (was ₹${currentStop}, profit=${round2(profitPct)}%)`);
        } catch (err) {
          console.error(`${LOG} ${pick.symbol}: modifyOrder failed for tightening:`, err.message);
        }
      } else {
        console.log(`${LOG} ${pick.symbol}: Stop already at/above breakeven (₹${currentStop} vs entry ₹${pick.trade.entry_price})`);
      }
    } else {
      console.log(`${LOG} ${pick.symbol}: At loss (${round2(profitPct)}%) — keeping original SL ₹${pick.levels.stop}`);
    }
  }

  if (tightened > 0) {
    await doc.save();
  }

  console.log(`${LOG} Tightened ${tightened}/${enteredPicks.length} stops to breakeven`);
  return { success: true, tightened };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Select up to maxPicks from viable candidates with scan-type diversity.
 * Round-robin: pick the best (highest score) from each scan type first,
 * then fill remaining slots by score across all types.
 */
/**
 * Look up sector for a symbol using sectorMapping utility
 */
function getStockSector(symbol) {
  for (const [sectorKey, sectorData] of Object.entries(SECTOR_MAPPING)) {
    if (sectorData.companies && sectorData.companies.includes(symbol)) {
      return sectorKey;
    }
  }
  return 'UNKNOWN';
}

// mapSectorToIntelKey imported from ../../utils/sectorMapping.js — single source of truth


function selectDiversePicks(viable, maxPicks, regime = 'UNKNOWN') {
  console.log(`${LOG} [Diversity] Selecting ${maxPicks} from ${viable.length} viable candidates (regime=${regime})`);

  // ── STEP 1: HARD sector cap — max 1 pick per sector, INCLUDING 'OTHER' ──
  // Previously 'OTHER' was allowed multiple picks; tightened because two
  // uncategorized stocks on the same day correlate more than we'd like.
  // viable is already sorted by rank_score descending.
  const sectorBest = {};
  const sectorDropped = [];
  for (const pick of viable) {
    const sector = pick.sector || 'OTHER';
    if (!sectorBest[sector]) {
      sectorBest[sector] = pick;
    } else {
      sectorDropped.push({
        symbol: pick.symbol, sector, score: pick.rank_score,
        keptSymbol: sectorBest[sector].symbol,
      });
    }
  }
  // Build sector-filtered pool (preserving score order)
  const keptSymbols = new Set(Object.values(sectorBest).map(p => p.symbol));
  const sectorFiltered = viable.filter(p => keptSymbols.has(p.symbol));

  if (sectorDropped.length > 0) {
    console.log(`${LOG} [Diversity] Sector cap: ${viable.length} → ${sectorFiltered.length} (dropped ${sectorDropped.length}: ${sectorDropped.map(d => `${d.symbol}[${d.sector}] kept ${d.keptSymbol}`).join(', ')})`);
  }

  if (sectorFiltered.length <= maxPicks) {
    console.log(`${LOG} [Diversity] ${sectorFiltered.length} ≤ ${maxPicks} slots — taking all`);
    logDiversityBreakdown(sectorFiltered);
    return sectorFiltered;
  }

  // ── STEP 2: Round 1 — One per scan type from clean pool ──
  const byType = {};
  for (const pick of sectorFiltered) {
    const key = pick.scan_type;
    if (!byType[key]) byType[key] = [];
    byType[key].push(pick);
  }

  console.log(`${LOG} [Diversity] Groups: ${Object.entries(byType).map(([k, v]) => `${k}(${v.length}): [${v.map(p => `${p.symbol}:${p.rank_score}`).join(', ')}]`).join(' | ')}`);

  const selected = [];
  const usedSymbols = new Set();
  let counterRegimeCount = 0;

  // Counter-regime check: enforce MAX_COUNTER_REGIME_PICKS cap
  const isCounterRegimePick = (pick) => pick.counter_regime === true;

  // Sort scan type groups by their best candidate's score
  const typesByBest = Object.entries(byType)
    .sort((a, b) => b[1][0].rank_score - a[1][0].rank_score);

  console.log(`${LOG} [Diversity] Round 1 — one per scan type (${typesByBest.length} types, picking up to ${maxPicks}):`);
  for (const [typeName, picks] of typesByBest) {
    if (selected.length >= maxPicks) {
      console.log(`${LOG} [Diversity] Round 1: slots full, skipping ${typeName}`);
      break;
    }
    const best = picks.find(p => !usedSymbols.has(p.symbol));
    if (best) {
      if (isCounterRegimePick(best) && counterRegimeCount >= MAX_COUNTER_REGIME_PICKS) {
        console.log(`${LOG} [Diversity] Round 1: SKIPPED ${best.symbol} — counter-regime cap (${counterRegimeCount}/${MAX_COUNTER_REGIME_PICKS})`);
        continue;
      }
      selected.push(best);
      usedSymbols.add(best.symbol);
      if (isCounterRegimePick(best)) counterRegimeCount++;
      console.log(`${LOG} [Diversity] Round 1: picked ${best.symbol} from ${typeName} (score=${best.rank_score}, slot ${selected.length}/${maxPicks}${isCounterRegimePick(best) ? ' COUNTER-REGIME' : ''})`);
    }
  }

  // ── STEP 3: Round 2 — Fill remaining slots by score ──
  if (selected.length < maxPicks) {
    const remaining = sectorFiltered.filter(p => !usedSymbols.has(p.symbol));
    console.log(`${LOG} [Diversity] Round 2 — filling ${maxPicks - selected.length} remaining slots from ${remaining.length} candidates by score`);
    for (const pick of remaining) {
      if (selected.length >= maxPicks) break;
      if (isCounterRegimePick(pick) && counterRegimeCount >= MAX_COUNTER_REGIME_PICKS) {
        console.log(`${LOG} [Diversity] Round 2: SKIPPED ${pick.symbol} — counter-regime cap (${counterRegimeCount}/${MAX_COUNTER_REGIME_PICKS})`);
        continue;
      }
      selected.push(pick);
      usedSymbols.add(pick.symbol);
      if (isCounterRegimePick(pick)) counterRegimeCount++;
      console.log(`${LOG} [Diversity] Round 2: picked ${pick.symbol} (${pick.scan_type}, score=${pick.rank_score}, slot ${selected.length}/${maxPicks}${isCounterRegimePick(pick) ? ' COUNTER-REGIME' : ''})`);
    }
  }

  logDiversityBreakdown(selected);
  return selected;
}

function logDiversityBreakdown(picks) {
  const typeCounts = {};
  const sectorCounts = {};
  for (const p of picks) {
    typeCounts[p.scan_type] = (typeCounts[p.scan_type] || 0) + 1;
    const sector = p.sector || 'OTHER';
    sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
  }
  console.log(`${LOG} [Diversity] Final picks: ${picks.map(s => `${s.symbol}(${s.scan_type}:${s.rank_score}:${s.sector || 'OTHER'})`).join(', ')}`);
  console.log(`${LOG} [Diversity] Type distribution: ${Object.entries(typeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`${LOG} [Diversity] Sector distribution: ${Object.entries(sectorCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
}


/**
 * Detect candle pattern from OHLC data
 */
function detectCandlePattern(open, high, low, close, prevOpen, prevHigh, prevLow, prevClose) {
  if (!open || !close || !high || !low) return 'unknown';

  const body = Math.abs(close - open);
  const upperShadow = high - Math.max(open, close);
  const lowerShadow = Math.min(open, close) - low;

  // Bullish engulfing
  if (prevClose && prevOpen && close > open && close > prevHigh && open < prevLow) {
    return 'bullish_engulfing';
  }

  // Bearish engulfing
  if (prevClose && prevOpen && close < open && close < prevLow && open > prevHigh) {
    return 'bearish_engulfing';
  }

  // Hammer (bullish reversal)
  if (body > 0 && lowerShadow > 2 * body && upperShadow < body * 0.3) {
    return 'hammer';
  }

  // Simple candle direction
  if (close > open) return 'bullish_candle';
  if (close < open) return 'bearish_candle';

  return 'doji';
}

/**
 * Log API usage for Anthropic calls
 */
async function logApiUsage(requestId, response, responseTime, success, context) {
  try {
    await ApiUsage.logUsage({
      provider: 'ANTHROPIC',
      model: CLAUDE_MODEL,
      feature: 'DAILY_PICKS_INSIGHT',
      tokens: {
        input: response?.usage?.input_tokens || 0,
        output: response?.usage?.output_tokens || 0
      },
      request_id: requestId,
      response_time_ms: responseTime,
      success,
      error_message: success ? undefined : context,
      context: {
        description: `Daily pick insights`,
        source: 'daily_picks'
      }
    });
  } catch (err) {
    console.error(`${LOG} ApiUsage log failed:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
  runDailyPicks,
  placePreMarketEntries,
  gapProtectionCheck,
  startOrbCollection,
  validateAndPlaceEntries,
  checkFillsFallback,
  cancelExpiredEntries,
  initFillListener,
  monitorDailyPickOrders,
  tightenStops,
  detectCandlePattern,
  selectDiversePicks,
  getStockSector,
  MAX_DAILY_PICKS
};

export default {
  runDailyPicks,
  placePreMarketEntries,
  gapProtectionCheck,
  startOrbCollection,
  validateAndPlaceEntries,
  checkFillsFallback,
  cancelExpiredEntries,
  initFillListener,
  monitorDailyPickOrders,
  tightenStops,
  detectCandlePattern,
  selectDiversePicks,
  getStockSector,
  MAX_DAILY_PICKS
};