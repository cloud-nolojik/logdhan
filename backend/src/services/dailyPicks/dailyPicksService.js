/**
 * Daily Picks Service — Core Orchestrator (Scanner Path)
 *
 * Flow:
 *   08:30  scanner.py → top-N picks with structural entry/stop/target → save → AMO MARKET MIS orders placed
 *   09:05  gapProtectionCheck — cancel adverse-gap AMOs before 9:08 pre-open auction
 *   09:08  AMO fills at pre-open auction price
 *   09:00–10:59  checkFillsFallback every 2 min — detects fills, places SL-M + LIMIT target
 *   09:30–14:59  monitorDailyPickOrders every 3 min — SL/target hit detection, trailing, partial booking
 *   15:15  runDailyExit — force-exit all remaining MIS positions
 *
 * ORB validation path (Steps 0–6) preserved in disabled blocks for reference.
 * Standalone from swing trading. Shared infra: Kite orders, Firebase notifications.
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
// Two scanner scripts live at logdhan/ — 4 dirs up from dailyPicks/.
//   scanner.py        — INTRADAY scanner (default, May 2026 v3). Same-day setups.
//   scanner_swing.py  — SWING scanner (the previous 8-mode scanner). Kept for
//                       A/B comparison and for SCANNER_TYPE=swing override.
// Selection is controlled by the SCANNER_TYPE env var via getActiveScannerType().
const SCANNER_INTRADAY_PY_PATH = path.resolve(__dirname, '../../../..', 'scanner.py');
const SCANNER_SWING_PY_PATH    = path.resolve(__dirname, '../../../..', 'scanner_swing.py');
// Backwards-compat alias — some legacy log strings still reference this.
// Always equals the *active* script (intraday by default).
const SCANNER_PY_PATH = SCANNER_INTRADAY_PY_PATH;

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
  resolveOrbAtrRatioForVix,    // VIX → MAX_ORB_ATR_RATIO scaling + extreme sit-out
  // 9:30 scanner confirmation (Tier-1 intraday upgrade, May 2026)
  SCANNER_ORB_CONFIRM_MIN_MOVE_PCT,
  SCANNER_ORB_CONFIRM_VOL_RATIO_THRESHOLD,
  SCANNER_ORB_CONFIRM_NIFTY_AGAINST_PCT,
  SCANNER_ORB_CONFIRM_MIN_FAILS_FOR_EXIT,
  // Pre-open shortlist (Commit 1 of the 9:32 selection architecture)
  SHORTLIST_SIZE,
  // Risk floor for ORB-breakout entry (mirror the scanner's MIN_RISK_PCT)
  MIN_RISK_PCT_PER_TRADE,
} from './dailyPicksConstants.js';
import { computeDynamicTrail, checkPartialBooking, checkSidewaysExit, analyzeIntradayStructure } from './tradingDecisions.js';
import { fetchVixData } from '../../engine/regimeDataFetchers.js';
// Regime-aware routing (added May 2026): regime engine drives scanner.py mode
import { computeMarketContextV2 } from '../../engine/regimeV2.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_DAILY_PICKS = MAX_PICKS; // from shared constants (currently 3)
const TARGET_PCT = 2.0;
const LOG = '[DAILY-PICKS]';

/**
 * Snap a price to the nearest valid NSE tick.
 *
 * NSE equities have a minimum tick of 0.05 (5 paise). Some higher-priced scripts
 * (BHARTIARTL, TATACOMM, etc.) use 0.10. Since 0.10 is a multiple of 0.05, we
 * default to 0.05 — and Kite's InputException message tells us the actual tick when
 * it differs, letting the caller re-snap and retry.
 *
 * @param {number} price
 * @param {number} [tick=0.05]
 * @param {'floor'|'ceil'|'round'} [mode='round']
 */
function snapToNSETick(price, tick, mode = 'round') {
  // Default: derive tick from price using NSE band rules (0.01 / 0.05 / 0.10 / ...)
  // so high-priced stocks like TATACOMM (>₹1000) use 0.10 automatically.
  // Callers that already know the tick (e.g. Kite error retry) may pass it explicitly.
  const t = tick ?? getNseTickSize(price);
  // Use integer arithmetic to avoid floating-point drift (e.g., 0.05 × 20 = 1)
  const factor = Math.round(1 / t);
  let snapped;
  if (mode === 'floor')      snapped = Math.floor(price * factor) / factor;
  else if (mode === 'ceil')  snapped = Math.ceil(price * factor)  / factor;
  else                       snapped = Math.round(price * factor) / factor;
  // Final precision fix: serialize at exactly the tick's decimal count so Kite
  // never sees a value like 1104.8500000000001 (which it rejects as "not on
  // tick"). Decimals = 0 for ticks ≥ 1, else 2 (covers 0.01/0.05/0.10).
  const decimals = t >= 1 ? 0 : 2;
  return parseFloat(snapped.toFixed(decimals));
}

/**
 * Parse the tick size Kite returns in InputException messages like:
 *   "Tick size for this script is 0.10. Kindly enter trigger price..."
 * Returns null if not a tick-size error.
 */
function parseKiteTickError(err) {
  // 2026-05-27: accepts either a string OR an Error/axios-error object and
  // digs into err.response.data.message (Kite's actual error). See
  // orbService.js for the full incident note (ABB ₹6840.9 SL placement).
  let str;
  if (err && typeof err === 'object') {
    str = err.response?.data?.message
       || err.responseData?.message
       || err.message
       || String(err);
  } else {
    str = String(err || '');
  }
  const patterns = [
    /[Tt]ick\s+size\s+for\s+this\s+script\s+is\s+([\d.]+)/,
    /[Tt]ick\s+size\s+is\s+([\d.]+)/,
    /multiple\s+of\s+([\d.]+)/,
  ];
  for (const p of patterns) {
    const m = str.match(p);
    if (m) {
      const tick = parseFloat(m[1]);
      if (tick > 0 && tick <= 10) return tick;
    }
  }
  return null;
}

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

// ═══════════════════════════════════════════════════════════════════════════════
// REGIME → SCANNER MODE ROUTER (May 2026)
//
// Maps the regime label to one of scanner.py's --mode values. Returns null
// when the regime says "sit out" (EXTREME_BEAR). Default fallback is
// 'recovery_breakout' so any unknown label keeps the legacy behavior.
// ═══════════════════════════════════════════════════════════════════════════════

// Regime → scanner mode mappings.
//
// Two separate routing tables — one per scanner script. The active table is
// chosen at runtime by SCANNER_TYPE (see getActiveScannerType() below).
//
// ─── SWING table (May 2026 v2) ──────────────────────────────────────────────
// Used when SCANNER_TYPE=swing → spawns scanner_swing.py. Modes selected from
// research review (Minervini VCP, Raschke Holy Grail, Connors RSI(2),
// Daniel-Moskowitz crash overlay) + 80-day backtest. failed_bounce is the
// only mode with confirmed live edge (+0.14R, 69% hit in WEAK_BEAR).
export const REGIME_TO_SWING_MODE = {
  STRONG_BULL:  'vcp_pivot',         // Minervini VCP — base-break with contraction
  WEAK_BULL:    'pullback_20ema',    // Raschke Holy Grail — first 20-EMA touch in uptrend
  NEUTRAL:      'rsi2_meanrev',      // Connors RSI(2) — deep dip in long-term uptrend
  WEAK_BEAR:    'failed_bounce',     // proven winner — kept
  STRONG_BEAR:  'failed_bounce',     // route to winner (was broken 'breakdown')
  EXTREME_BEAR: null,                // sit out
};

// ─── INTRADAY table (May 2026 v3 — default) ─────────────────────────────────
// Used when SCANNER_TYPE=intraday (default) → spawns scanner.py. One intraday
// mode per regime, tuned for same-day exit (1R/2R/3R via ATR) rather than
// multi-day swings. The live ORB validator refines the actual entry at 9:30am.
export const REGIME_TO_INTRADAY_MODE = {
  STRONG_BULL:  'intraday_gap_long',       // close in top-quartile + vol + near 20d high
  WEAK_BULL:    'intraday_breakout_long',  // 3-day coil + above-rising-20EMA + near 20d high
  NEUTRAL:      'intraday_range_fade',     // ADX<20 + RSI(2)<15 + bottom-quartile of 10d range
  WEAK_BEAR:    'intraday_failed_rally',   // SHORT — yesterday rallied >2% intraday but closed red
  STRONG_BEAR:  'intraday_gap_short',      // SHORT — closed near low, below 20/50 EMA, near 20d low
  EXTREME_BEAR: null,                      // sit out
};

// SHORT-direction mode set — used by the routing log to print direction.
// Update this whenever a new SHORT mode is added to either map.
const SHORT_SCANNER_MODES = new Set([
  // swing SHORTs
  'failed_bounce', 'breakdown',
  // intraday SHORTs
  'intraday_failed_rally', 'intraday_gap_short',
]);

/**
 * Returns 'intraday' or 'swing' based on SCANNER_TYPE env var.
 * Defaults to 'intraday' (the new May 2026 v3 scanner.py).
 */
export function getActiveScannerType() {
  const raw = (process.env.SCANNER_TYPE || 'intraday').toString().toLowerCase().trim();
  return raw === 'swing' ? 'swing' : 'intraday';
}

/**
 * Returns the regime → mode map for the given scanner type. Defaults to the
 * active type. Exported so tests + diagnostics can introspect either map.
 */
export function getRegimeToScannerMode(scannerType = getActiveScannerType()) {
  return scannerType === 'swing' ? REGIME_TO_SWING_MODE : REGIME_TO_INTRADAY_MODE;
}

/**
 * Returns the absolute path to the python script for the given scanner type.
 */
function getScannerScriptPath(scannerType = getActiveScannerType()) {
  return scannerType === 'swing' ? SCANNER_SWING_PY_PATH : SCANNER_INTRADAY_PY_PATH;
}

// Backwards-compat alias — DEPRECATED. Older test files + log strings still
// import this name. Points to the active map at module-load time, so flipping
// SCANNER_TYPE before `node` boots picks the right table. New call sites
// should use getRegimeToScannerMode() so the choice is dynamic.
export const REGIME_TO_SCANNER_MODE = getRegimeToScannerMode();

/**
 * Pick the first scanner.py target (t1 → t2 → t3) that achieves at least
 * `minRR` reward:risk. For LONG: targets above close, sl below; reward is
 * target − close. For SHORT: targets below close, sl above; reward is
 * close − target. Falls back to the widest viable target if none meet
 * the threshold (caller can choose to log).
 *
 * Exported for unit testing. The `runScannerPy` IIFE wraps a logging-only
 * variant; this is the pure-function core.
 *
 * @param {Object} s — scanner.py Score-shaped object with at minimum:
 *   { direction, close, sl, t1, t2, t3, t1_pct, t2_pct, t3_pct, rr_t1, rr_t2, rr_t3 }
 * @param {number} [minRR=1.0]
 * @returns {{ t, pct, rr, label, isFallback }}
 */
export function pickScannerTarget(s, minRR = 1.0) {
  const isLong = (s.direction || 'LONG') === 'LONG';
  const risk = isLong ? (s.close - s.sl) : (s.sl - s.close);
  const candidates = [
    { t: s.t1, pct: s.t1_pct, rr: s.rr_t1, label: 't1' },
    { t: s.t2, pct: s.t2_pct, rr: s.rr_t2, label: 't2' },
    { t: s.t3, pct: s.t3_pct, rr: s.rr_t3, label: 't3' },
  ].filter(c => c.t && (isLong ? c.t > s.close : c.t < s.close));
  const reward = (c) => isLong ? (c.t - s.close) : (s.close - c.t);
  const viable = candidates.find(c => reward(c) >= risk * minRR);
  if (viable) return { ...viable, isFallback: false };
  const fallback = candidates[candidates.length - 1]
                || { t: s.t1, pct: s.t1_pct, rr: s.rr_t1, label: 't1' };
  return { ...fallback, isFallback: true };
}

export function selectScannerModeForRegime(regimeLabel, scannerType = getActiveScannerType()) {
  // Null / missing regime → sit out. Do NOT default to a LONG mode —
  // a missing label means the regime engine failed or returned nothing
  // useful, and trading LONG on a guess in that state is the failure mode
  // we want to avoid (especially on a bear morning where a fetcher broke).
  if (regimeLabel == null) return null;
  const map = getRegimeToScannerMode(scannerType);
  // Use Object.hasOwn (ES2022) to avoid:
  //   - calling .hasOwnProperty as an inherited method (which can be
  //     shadowed by an own property with the same name), AND
  //   - the `in` operator walking the prototype chain (so a regime label
  //     of 'toString' / 'constructor' / '__proto__' would otherwise return
  //     the inherited function from Object.prototype). Caught by unit test.
  if (Object.hasOwn(map, regimeLabel)) {
    return map[regimeLabel];
  }
  // Unknown / HALT / legacy labels (e.g. 'SCANNER', 'UNKNOWN', 'HALT', 'CONFLICT')
  // → sit out. Same principle: if we don't know what regime we're in, don't
  // pretend we do. The regime engine signals this by returning HALT with
  // max_trades=0; we honor that intent by returning null here.
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCANNER 09:30 ORB CONFIRMATION (Tier-1 intraday upgrade, May 2026)
//
// Scanner picks fill at the 9:08 auction without ever seeing today's tape.
// This step re-introduces a *day-of* gate that runs at 09:32 IST and exits
// any pick whose 9:15-9:30 opening range disagrees with the pre-open thesis.
//
// Pure decision (evaluateScannerOrbConfirmation) is split from I/O so we can
// unit-test the logic without a broker. The orchestrator wires the I/O.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pure function: given a pick, its 9:15-9:30 opening-range OHLCV, a volume
 * ratio (actual/expected from fetchOrbVolume), and Nifty's % change since
 * open, return a decision object. No side effects.
 *
 * @param {Object} args
 * @param {{ direction:'LONG'|'SHORT' }} args.pick
 * @param {{ open:number, high:number, low:number, close:number, volume?:number }} args.orb
 *        — opening 15-min OHLCV. close should be the LTP at ~09:30. Pass null
 *          if OHLC isn't available (returns SKIPPED).
 * @param {number|null} args.volumeRatio  — actual_volume / expected_volume from
 *        fetchOrbVolume. null/undefined means we don't know — the volume check
 *        auto-passes (consistent with orbValidationService's behavior).
 * @param {number|null} args.niftyChangePct — Nifty % change since open. null
 *        means we don't know — the nifty check auto-passes.
 * @returns {{ decision:'CONFIRMED'|'WARN'|'EXITED'|'SKIPPED',
 *            fail_count:number, fail_reasons:string[],
 *            checks:object, stock_change_pct:number }}
 */
export function evaluateScannerOrbConfirmation({ pick, orb, volumeRatio, niftyChangePct }) {
  if (!orb || !Number.isFinite(orb.open) || orb.open <= 0 ||
      !Number.isFinite(orb.close) || orb.close <= 0) {
    return {
      decision: 'SKIPPED',
      fail_count: 0,
      fail_reasons: ['missing_or_invalid_orb'],
      checks: {},
      stock_change_pct: 0,
    };
  }

  const isLong = (pick?.direction || 'LONG') === 'LONG';
  const stockChangePct = ((orb.close / orb.open) - 1) * 100;
  const minMove = SCANNER_ORB_CONFIRM_MIN_MOVE_PCT;

  // ── CHECK 1: DIRECTION ─────────────────────────────────────────────────
  // For LONG: stock should be ≥ +minMove% above open. For SHORT: ≤ -minMove%.
  // A stock drifting flat (within ±minMove) counts as a failed direction
  // check — the pre-open thesis predicted a move, and the open didn't deliver.
  const inTradeDirection = isLong ? stockChangePct >= minMove : stockChangePct <= -minMove;
  const directionCheck = {
    passed: inTradeDirection,
    stock_change_pct: stockChangePct,
    in_trade_direction: inTradeDirection,
  };

  // ── CHECK 2: VOLUME ────────────────────────────────────────────────────
  // Null volumeRatio = unknown → auto-pass (we don't penalize on missing data).
  const volThreshold = SCANNER_ORB_CONFIRM_VOL_RATIO_THRESHOLD;
  const volumePassed = (volumeRatio == null) || (volumeRatio >= volThreshold);
  const volumeCheck = {
    passed: volumePassed,
    ratio: volumeRatio == null ? null : Number(volumeRatio),
    threshold: volThreshold,
  };

  // ── CHECK 3: NIFTY ALIGNMENT ───────────────────────────────────────────
  // Nifty moving against trade direction by more than the threshold = fail.
  // Null/zero nifty change = auto-pass.
  const niftyAgainstThreshold = SCANNER_ORB_CONFIRM_NIFTY_AGAINST_PCT;
  let niftyAgainst = false;
  if (niftyChangePct != null && Number.isFinite(niftyChangePct)) {
    if (isLong) niftyAgainst = niftyChangePct < -niftyAgainstThreshold;
    else        niftyAgainst = niftyChangePct >  niftyAgainstThreshold;
  }
  const niftyCheck = {
    passed: !niftyAgainst,
    nifty_change_pct: niftyChangePct == null ? null : Number(niftyChangePct),
    threshold: niftyAgainstThreshold,
    against: niftyAgainst,
  };

  const checks = { direction: directionCheck, volume: volumeCheck, nifty_alignment: niftyCheck };
  const fail_reasons = [];
  if (!directionCheck.passed) fail_reasons.push('direction');
  if (!volumeCheck.passed)    fail_reasons.push('volume');
  if (!niftyCheck.passed)     fail_reasons.push('nifty');

  const fail_count = fail_reasons.length;
  let decision;
  if (fail_count === 0)                                       decision = 'CONFIRMED';
  else if (fail_count >= SCANNER_ORB_CONFIRM_MIN_FAILS_FOR_EXIT) decision = 'EXITED';
  else                                                        decision = 'WARN';

  return { decision, fail_count, fail_reasons, checks, stock_change_pct: stockChangePct };
}

/**
 * Cancel both protective legs and place a market exit for a single pick.
 * Mirrors the pattern in dailyPicksExitService.js (cancel → wait → market).
 * Returns true on success, false on failure (caller decides what to do).
 *
 * @param {Object} pick — DailyPick sub-doc, must have kite.{stop_order_id,target_order_id}
 *                        and trade.{qty,status}
 * @param {string} reason — for logging / pick.trade.exit_reason
 */
/**
 * Generic force-exit: cancel both protective legs and place a market exit.
 * Used by both the 9:32 scanner ORB confirmation path AND the live VWAP
 * exit path. The caller passes a `tag` for log clarity and a `reasonPrefix`
 * for pick.trade.exit_reason so each exit path is auditable.
 *
 * @param {Object} pick — DailyPick sub-doc, must have kite.{stop_order_id,target_order_id}
 *                        and trade.{qty,status}
 * @param {Object} opts
 * @param {string} opts.tag           — log prefix, e.g. '[VWAP-EXIT]'
 * @param {string} opts.reasonPrefix  — exit_reason prefix, e.g. 'vwap_exit'
 * @param {string} opts.reason        — detail (concatenated to prefix)
 * @param {string} opts.orderType     — Kite orderType label (audit-only)
 */
async function _forceExitPick(pick, { tag, reasonPrefix, reason, orderType }) {
  console.log(`${LOG} ${tag} ${pick.symbol}: FORCE EXIT — ${reason}`);

  // Step 1 — cancel both protective legs (best-effort, idempotent)
  if (pick.kite?.stop_order_id) {
    try {
      await kiteOrderService.cancelOrder(pick.kite.stop_order_id);
      console.log(`${LOG} ${tag} ${pick.symbol}: cancelled SL-M ${pick.kite.stop_order_id}`);
    } catch (e) {
      console.error(`${LOG} ${tag} ${pick.symbol}: SL cancel failed — ${e.message}`);
    }
  }
  if (pick.kite?.target_order_id) {
    try {
      await kiteOrderService.cancelOrder(pick.kite.target_order_id);
      console.log(`${LOG} ${tag} ${pick.symbol}: cancelled target ${pick.kite.target_order_id}`);
    } catch (e) {
      console.error(`${LOG} ${tag} ${pick.symbol}: target cancel failed — ${e.message}`);
    }
  }

  // Wait for cancellations to settle so the market-exit qty isn't double-counted
  await delay(2000);

  // Step 2 — re-check status: a leg might have triggered while we were cancelling
  if (pick.trade.status !== 'ENTERED') {
    console.log(`${LOG} ${tag} ${pick.symbol}: status changed to ${pick.trade.status} during cancel — skip market exit`);
    return true;
  }

  // Step 3 — place MARKET exit (opposite side)
  const exitSide = pick.direction === 'LONG' ? 'SELL' : 'BUY';
  try {
    const result = await kiteOrderService.placeOrder({
      tradingsymbol: pick.symbol,
      exchange: 'NSE',
      transaction_type: exitSide,
      order_type: 'MARKET',
      product: 'MIS',
      quantity: pick.trade.qty,
      simulationId: `${reasonPrefix}_${pick.symbol}`,
      orderType: orderType || reasonPrefix.toUpperCase(),
      source: 'DAILY_PICKS',
    });
    if (!result?.success) throw new Error(`placeOrder returned ${JSON.stringify(result)}`);
    console.log(`${LOG} ${tag} ${pick.symbol}: ✅ market ${exitSide} placed — orderId=${result.orderId}`);
    pick.trade.status = 'TIME_EXIT';
    pick.trade.exit_reason = `${reasonPrefix}_${reason}`;
    pick.trade.exit_time = new Date();
    return true;
  } catch (err) {
    console.error(`${LOG} ${tag} ${pick.symbol}: ❌ market exit FAILED — ${err.message}`);
    console.error(`${LOG} ${tag} ${pick.symbol}: position remains open; broker auto-square at 15:20 is the backstop`);
    return false;
  }
}

/**
 * Back-compat wrapper for the existing 9:32 scanner ORB confirmation path.
 */
async function _scannerForceExitPick(pick, reason) {
  return _forceExitPick(pick, {
    tag: '[SCANNER-ORB-CONFIRM]',
    reasonPrefix: 'scanner_orb_confirm',
    reason,
    orderType: 'SCANNER_ORB_EXIT',
  });
}

/**
 * Orchestrator: at 09:32 IST, for each scanner pick that filled at the 9:08
 * auction (status ENTERED, levels.mode === 'scanner', not yet confirmed),
 * fetch 9:15-9:30 OHLC + volume + Nifty change, run evaluateScannerOrbConfirmation,
 * persist the audit, and force-exit positions that fail confirmation.
 *
 * Returns a summary: { success, picks_processed, confirmed, warned, exited, skipped }
 */
export async function confirmScannerOpeningRange({ allowOutsideHours = false } = {}) {
  const tag = '[SCANNER-ORB-CONFIRM]';
  const t0 = Date.now();
  console.log(`${LOG} ${tag} ─── 09:32 confirmation step starting ───`);

  // Find today's DailyPick doc
  const today = getISTMidnight();
  const doc = await DailyPick.findOne({ trading_date: today });
  if (!doc || !doc.picks?.length) {
    console.log(`${LOG} ${tag} no DailyPick doc for today — nothing to confirm`);
    return { success: true, picks_processed: 0, confirmed: 0, warned: 0, exited: 0, skipped: 0 };
  }

  // Filter: scanner picks that ENTERED but haven't been confirmed yet.
  // Skip entered_awaiting_915 — the SL-M leg isn't placed yet, the fill-fallback
  // will handle it; confirmation runs on the *next* invocation after status flips.
  const eligible = doc.picks.filter(p =>
    p.levels?.mode === 'scanner' &&
    p.trade?.status === 'ENTERED' &&
    !p.scanner_orb_confirmation?.checked_at
  );

  if (eligible.length === 0) {
    console.log(`${LOG} ${tag} no eligible scanner picks (statuses: ${doc.picks.map(p => `${p.symbol}=${p.trade?.status}`).join(', ')})`);
    return { success: true, picks_processed: 0, confirmed: 0, warned: 0, exited: 0, skipped: 0 };
  }

  console.log(`${LOG} ${tag} ${eligible.length} pick(s) to confirm: ${eligible.map(p => `${p.symbol}(${p.direction})`).join(', ')}`);

  // Single batched API call for OHLC + Nifty (cheaper than per-pick).
  const symbols = eligible.map(p => p.symbol);
  let orbMap = {};
  try {
    orbMap = await collectOpeningRange(symbols, eligible);
  } catch (err) {
    console.error(`${LOG} ${tag} collectOpeningRange threw — ${err.message}. All picks → SKIPPED.`);
  }

  // Volume ratios (best-effort; null on missing data → auto-pass in evaluator).
  let volMap = {};
  try {
    volMap = await fetchOrbVolume(eligible) || {};
  } catch (err) {
    console.error(`${LOG} ${tag} fetchOrbVolume threw — ${err.message}. Volume checks auto-pass.`);
  }

  const niftyEntry = orbMap?._NIFTY;
  const niftyChangePct = niftyEntry?.nifty_change_pct ?? null;

  const summary = { success: true, picks_processed: 0, confirmed: 0, warned: 0, exited: 0, skipped: 0 };

  for (const pick of eligible) {
    summary.picks_processed++;
    const orb = orbMap?.[pick.symbol] || null;
    const vol = volMap?.[pick.symbol]?.ratio ?? null;

    // Build the OHLC payload for the pure evaluator
    const orbPayload = orb ? {
      open: orb.opening_price,
      high: orb.high,
      low: orb.low,
      // collectOpeningRange returns `last` or similar; if not present, fall back
      // to mid of high/low as a defensive default so close-ish is always defined
      close: orb.close ?? orb.last ?? orb.ltp ?? ((orb.high + orb.low) / 2),
      volume: volMap?.[pick.symbol]?.actual ?? null,
    } : null;

    const result = evaluateScannerOrbConfirmation({
      pick,
      orb: orbPayload,
      volumeRatio: vol,
      niftyChangePct,
    });

    console.log(`${LOG} ${tag} ${pick.symbol} (${pick.direction}): decision=${result.decision} fails=${result.fail_count}${result.fail_reasons.length ? ` [${result.fail_reasons.join(',')}]` : ''}  Δ=${result.stock_change_pct?.toFixed(2)}%`);

    // Persist the audit object regardless of decision
    pick.scanner_orb_confirmation = {
      checked_at: new Date(),
      orb_high: orbPayload?.high ?? null,
      orb_low: orbPayload?.low ?? null,
      orb_open: orbPayload?.open ?? null,
      orb_close: orbPayload?.close ?? null,
      orb_volume: orbPayload?.volume ?? null,
      expected_volume: volMap?.[pick.symbol]?.expected ?? null,
      nifty_change_pct: niftyChangePct,
      checks: result.checks,
      decision: result.decision,
      fail_count: result.fail_count,
      fail_reasons: result.fail_reasons,
      exit_placed: false,
      notes: null,
    };

    if (result.decision === 'EXITED') {
      const exitOk = await _scannerForceExitPick(pick, result.fail_reasons.join('+'));
      pick.scanner_orb_confirmation.exit_placed = exitOk;
      pick.scanner_orb_confirmation.notes = exitOk
        ? 'force-exit placed; awaiting fill'
        : 'force-exit FAILED — broker auto-square is backstop';
      summary.exited++;
    } else if (result.decision === 'CONFIRMED') {
      summary.confirmed++;
    } else if (result.decision === 'WARN') {
      summary.warned++;
    } else {
      summary.skipped++;
    }
  }

  doc.markModified('picks');
  await doc.save();

  console.log(`${LOG} ${tag} ─── done in ${Date.now() - t0}ms ───`);
  console.log(`${LOG} ${tag}   processed=${summary.picks_processed}  confirmed=${summary.confirmed}  warned=${summary.warned}  exited=${summary.exited}  skipped=${summary.skipped}`);
  return summary;
}


// ═══════════════════════════════════════════════════════════════════════════════
// 09:32 ORB-BREAKOUT ENTRY (Commit 2 — replaces 8:30 AMO market entries)
//
// Flow:
//   08:30  scanner.py → 15-candidate shortlist saved to doc.candidates_shortlist
//   09:15-30  opening range candle forms
//   09:32  THIS PATH:
//          a. For each shortlist candidate, read 9:15-9:30 OHLC + volume
//          b. Score each: combined = 0.5 × scanner_composite + 0.5 × intraday_score
//          c. Filter to direction-confirmed (else the entry would fire backwards)
//          d. Take top MAX_DAILY_PICKS by combined score
//          e. For each selected: compute ORB-based entry trigger / SL / R targets,
//             place SL-M BUY (LONG) or SELL (SHORT) entry order at 9:30_close ± buffer
//          f. Persist new pick.levels, pick.kite.entry_order_id, pick.trade.qty
//          g. Entries trigger only on actual breakout; if price doesn't cross
//             trigger by 12:00 IST, the cancel-pending-stops cron kills the order
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute ORB-breakout entry levels from a 9:15-9:30 candle.
 *
 *   LONG  entry = ORB close + buffer,  SL = ORB low,  T_n = entry + n×R
 *   SHORT entry = ORB close - buffer,  SL = ORB high, T_n = entry - n×R
 *
 * Buffer = max(1 NSE tick, bufferPct% of price). Default bufferPct = 0.05%.
 * The buffer keeps us from buying inside the noise band immediately above
 * the close — we want a meaningful break, not a wick.
 *
 * @param {Object} args
 * @param {'LONG'|'SHORT'} args.direction
 * @param {{ high:number, low:number, close:number }} args.orb
 * @param {number} [args.bufferPct=0.05]  buffer in % of price (0.05 = 0.05%)
 * @returns {{ entry:number, sl:number, t1:number, t2:number, t3:number,
 *             risk:number, risk_pct:number, reward_pct:number, risk_reward:1,
 *             valid:boolean, reason?:string }}
 */
export function computeOrbBreakoutLevels({ direction, orb, bufferPct = 0.05 }) {
  const empty = (reason) => ({
    entry: 0, sl: 0, t1: 0, t2: 0, t3: 0, risk: 0,
    risk_pct: 0, reward_pct: 0, risk_reward: 0, valid: false, reason,
  });

  if (!orb || !Number.isFinite(orb.high) || !Number.isFinite(orb.low) ||
      !Number.isFinite(orb.close) || orb.close <= 0) {
    return empty('missing_or_invalid_orb');
  }
  if (orb.high <= orb.low) return empty('zero_or_negative_orb_range');
  if (orb.close > orb.high + 1e-6 || orb.close < orb.low - 1e-6) {
    return empty('orb_close_outside_high_low');
  }

  const isLong = direction === 'LONG';
  const tick   = getNseTickSize(orb.close);
  const buffer = Math.max(tick, orb.close * (bufferPct / 100));
  const entry  = isLong ? (orb.close + buffer) : (orb.close - buffer);
  const sl     = isLong ? orb.low : orb.high;
  const risk   = isLong ? (entry - sl) : (sl - entry);

  if (risk <= 0) return empty('non_positive_risk');

  const t1 = isLong ? (entry + risk * 1.0) : (entry - risk * 1.0);
  const t2 = isLong ? (entry + risk * 2.0) : (entry - risk * 2.0);
  const t3 = isLong ? (entry + risk * 3.0) : (entry - risk * 3.0);
  const risk_pct = (risk / entry) * 100;
  const reward_pct = (Math.abs(t1 - entry) / entry) * 100;

  return {
    entry, sl, t1, t2, t3,
    risk, risk_pct, reward_pct, risk_reward: 1.0, valid: true,
  };
}

// ─── VWAP helpers ───────────────────────────────────────────────────────────
// VWAP = Σ(typical_price × volume) / Σ(volume), accumulated from 9:15 IST.
// Used for two purposes:
//   1. Entry filter — 1-bar close above trigger AND above VWAP (literature
//      standard: institutional flow is on our side at the moment of breakout)
//   2. Exit signal — 2 consecutive 5-min closes on the wrong side of VWAP
//      (LONG closes below / SHORT closes above) → institutional flow has
//      flipped, exit before the hard SL fires
// All three functions are pure so they're trivially testable; the state-
// machine + Mongo persistence lives in the orchestrator/monitor.

/**
 * Compute cumulative VWAP from a list of 5-min OHLCV bars.
 * Returns { vwap, totalVol, totalTpVol } — pass the result back in via
 * `prev` for an incremental update when a new bar arrives.
 */
export function computeVwap(bars, prev = null) {
  let cumTpVol = prev?.totalTpVol ?? 0;
  let cumVol   = prev?.totalVol   ?? 0;
  for (const b of bars) {
    if (!Number.isFinite(b?.high) || !Number.isFinite(b?.low) || !Number.isFinite(b?.close)) continue;
    if (!Number.isFinite(b?.volume) || b.volume <= 0) continue;
    const tp = (b.high + b.low + b.close) / 3;
    cumTpVol += tp * b.volume;
    cumVol   += b.volume;
  }
  return {
    vwap:        cumVol > 0 ? cumTpVol / cumVol : null,
    totalVol:    cumVol,
    totalTpVol:  cumTpVol,
  };
}

/**
 * Decide whether to exit a position based on VWAP. Returns { exit, reason,
 * consecutiveBelow }. State is passed in (the `consecutiveBelow` counter)
 * and the new counter value is returned — caller persists it.
 *
 * Rules:
 *   LONG  — exit when latestClose < vwap AND prevWasBelowVwap (2nd consecutive)
 *   SHORT — exit when latestClose > vwap AND prevWasAboveVwap (2nd consecutive)
 *
 * If vwap is null (not enough volume), abstain — return { exit: false, reason: 'no_vwap' }
 *
 * @param {Object} args
 * @param {'LONG'|'SHORT'} args.direction
 * @param {number} args.latestClose      — close of the just-closed 5-min bar
 * @param {number|null} args.vwap        — current cumulative VWAP
 * @param {number} args.consecutiveOpp   — counter of consecutive bars on wrong side
 * @returns {{ exit:boolean, reason:string|null, consecutiveOpp:number, side:string }}
 */
export function evaluateVwapExit({ direction, latestClose, vwap, consecutiveOpp = 0 }) {
  if (vwap == null || !Number.isFinite(vwap) || !Number.isFinite(latestClose)) {
    return { exit: false, reason: 'no_vwap', consecutiveOpp, side: 'unknown' };
  }
  const isLong = direction === 'LONG';
  const onWrongSide = isLong ? (latestClose < vwap) : (latestClose > vwap);
  const newCount = onWrongSide ? consecutiveOpp + 1 : 0;

  if (newCount >= 2) {
    return {
      exit: true,
      reason: isLong ? 'two_consecutive_closes_below_vwap' : 'two_consecutive_closes_above_vwap',
      consecutiveOpp: newCount,
      side: 'wrong',
    };
  }
  return {
    exit: false,
    reason: onWrongSide ? 'first_close_on_wrong_side' : 'on_correct_side',
    consecutiveOpp: newCount,
    side: onWrongSide ? 'wrong' : 'correct',
  };
}

/**
 * Pure function: score a single shortlist candidate against its 9:15-9:30
 * opening range. Returns whether it passes the gate + a combined score for
 * ranking + the computed entry levels. No side effects.
 *
 *   combined_score = 0.5 × scanner_composite + 0.5 × intraday_score
 *   intraday_score = 0.5×direction_pass + 0.3×volume_pass + 0.2×nifty_pass
 *
 * Direction MUST pass for `passes = true` (we never enter against direction).
 * RR of computed entry must be valid (>0) for `passes = true`.
 * VWAP MUST be on the correct side of trigger (LONG: trigger>vwap, SHORT: trigger<vwap)
 * — when `vwapAtOrbClose` is provided. If omitted (null), the VWAP check is skipped.
 *
 * @returns {{ passes:boolean, rejection_reason:string|null,
 *             intradayScore:number, combinedScore:number,
 *             computedLevels:object, confirmation:object,
 *             vwapAtEntry:number|null }}
 */
export function evaluateShortlistCandidate({ candidate, orb, volumeRatio, niftyChangePct, bufferPct = 0.05, vwapAtOrbClose = null }) {
  // Use the existing intraday confirmation primitive to score direction/volume/nifty.
  const confirmation = evaluateScannerOrbConfirmation({
    pick: candidate, orb, volumeRatio, niftyChangePct,
  });

  if (confirmation.decision === 'SKIPPED') {
    return {
      passes: false, rejection_reason: 'no_orb_data',
      intradayScore: 0, combinedScore: 0, computedLevels: null, confirmation,
    };
  }

  // Direction is a hard gate — we never enter a trade where today's open
  // already moved against the pre-open thesis.
  if (!confirmation.checks?.direction?.passed) {
    return {
      passes: false, rejection_reason: 'direction_not_confirmed',
      intradayScore: 0, combinedScore: 0, computedLevels: null, confirmation,
    };
  }

  // Intraday score: weighted sum of the three checks
  const intradayScore =
    (confirmation.checks.direction?.passed       ? 0.5 : 0) +
    (confirmation.checks.volume?.passed          ? 0.3 : 0) +
    (confirmation.checks.nifty_alignment?.passed ? 0.2 : 0);

  // Compute ORB-based entry levels
  const computedLevels = computeOrbBreakoutLevels({
    direction: candidate.direction,
    orb,
    bufferPct,
  });

  if (!computedLevels.valid) {
    return {
      passes: false, rejection_reason: `levels_invalid_${computedLevels.reason}`,
      intradayScore, combinedScore: 0, computedLevels, confirmation,
    };
  }

  // Reject sub-floor risk picks (mirror the scanner's MIN_RISK_PCT_PER_TRADE
  // floor; ORB ranges can be tiny on quiet stocks).
  if (computedLevels.risk_pct < MIN_RISK_PCT_PER_TRADE) {
    return {
      passes: false,
      rejection_reason: `risk_pct_${computedLevels.risk_pct.toFixed(2)}%_below_floor_${MIN_RISK_PCT_PER_TRADE}%`,
      intradayScore, combinedScore: 0, computedLevels, confirmation,
      vwapAtEntry: vwapAtOrbClose,
    };
  }

  // ── VWAP entry filter ────────────────────────────────────────────────────
  // For LONG: trigger MUST be above VWAP at the moment of breakout.
  //           Buying below VWAP means we're chasing while institutional
  //           sellers are still active — a known fake-breakout signature.
  // For SHORT: trigger MUST be below VWAP.
  // Null vwap (no volume data) → skip the check (don't penalize on missing data).
  if (vwapAtOrbClose != null && Number.isFinite(vwapAtOrbClose)) {
    const isLong = candidate.direction === 'LONG';
    const triggerVsVwap = isLong
      ? computedLevels.entry > vwapAtOrbClose
      : computedLevels.entry < vwapAtOrbClose;
    if (!triggerVsVwap) {
      return {
        passes: false,
        rejection_reason: `trigger_${computedLevels.entry.toFixed(2)}_on_wrong_side_of_vwap_${vwapAtOrbClose.toFixed(2)}`,
        intradayScore, combinedScore: 0, computedLevels, confirmation,
        vwapAtEntry: vwapAtOrbClose,
      };
    }
  }

  const composite = (candidate.composite != null)
    ? candidate.composite
    : (Number(candidate.rank_score || 0) / 100);
  const combinedScore = 0.5 * composite + 0.5 * intradayScore;

  return {
    passes: true, rejection_reason: null,
    intradayScore, combinedScore, computedLevels, confirmation,
    vwapAtEntry: vwapAtOrbClose,
  };
}

/**
 * Pure function: given an array of evaluated shortlist entries, sort by
 * combinedScore (desc), filter to passers only, return top `limit`.
 */
export function selectTopOrbEntries(evaluated, limit) {
  return evaluated
    .filter(e => e.passes)
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);
}

// ───────────────────────────────────────────────────────────────────────────
// Orchestrator: read shortlist, score against ORB, place SL-M entries.
// Called by the 09:32 cron in dailyEntryJob.
// ───────────────────────────────────────────────────────────────────────────

/**
 * 09:32 IST: score the 8:30 shortlist against today's 9:15-9:30 opening range,
 * select top MAX_DAILY_PICKS, place SL-M STOP entry orders that trigger only
 * if price actually breaks the 9:30 close in our direction.
 *
 * Returns a summary object usable for logging + the agenda job.
 */
// ═══════════════════════════════════════════════════════════════════════════════
// DAILY TRACKING LOGS — single-source observability for day-by-day review
//
// Two functions, both pure formatting + I/O:
//   logMorningBriefing(doc, ctx)  — called from runDailyPicks Step 7 after save.
//                                    One concise block summarizing today's setup.
//   logEndOfDaySummary()          — called by the 15:30 cron. Comprehensive
//                                    pick-by-pick lifecycle, VWAP effectiveness,
//                                    shortlist post-mortem, P&L breakdown.
//                                    Also persists to daily_metrics collection.
// ═══════════════════════════════════════════════════════════════════════════════

function _hr(ch = '─', n = 78) { return ch.repeat(n); }
function _pad(s, n) { return String(s ?? '').padEnd(n); }
function _padl(s, n) { return String(s ?? '').padStart(n); }

/**
 * Called at the end of runDailyPicks (8:31ish IST) — one block summarizing
 * today's regime + shortlist + the 3 picks that WILL be candidates for
 * 9:32 SL-M entry. Easy to grep in production logs.
 */
function logMorningBriefing(doc, marketContext) {
  const tag = '[MORNING-BRIEFING]';
  try {
    const date = doc?.trading_date ? new Date(doc.trading_date).toISOString().slice(0, 10) : 'unknown';
    const regime = marketContext?.regime || 'UNKNOWN';
    const score = marketContext?.regime_score ?? '?';
    const shortlist = doc?.candidates_shortlist || [];
    const picks = doc?.picks || [];
    console.log(`${LOG} ${tag} ${_hr('═')}`);
    console.log(`${LOG} ${tag}  MORNING BRIEFING — ${date}`);
    console.log(`${LOG} ${tag} ${_hr('═')}`);
    console.log(`${LOG} ${tag}  regime              = ${regime}  (score ${score})`);
    console.log(`${LOG} ${tag}  playbook            = ${marketContext?.playbook || '-'}`);
    console.log(`${LOG} ${tag}  shortlist size      = ${shortlist.length}`);
    console.log(`${LOG} ${tag}  top-3 candidates (pre-open, will be re-evaluated at 9:32):`);
    picks.slice(0, 3).forEach((p, i) => {
      const risk = p.levels?.risk_pct?.toFixed?.(2) ?? '?';
      const rr   = p.levels?.risk_reward?.toFixed?.(2) ?? '?';
      console.log(`${LOG} ${tag}    ${i+1}. ${_pad(p.symbol, 12)} ${_pad(p.direction, 5)} score=${p.rank_score}  risk=${risk}%  RR=${rr}  scan=${p.scan_type}`);
      // ── Daily pivot reference (observability only — see if pivots sit near targets) ──
      const pv = p.scan_meta?.pivots;
      if (pv && Number.isFinite(pv.P)) {
        const entry = p.levels?.entry;
        const t1    = p.levels?.target;
        const t2    = p.levels?.target2;
        const t3    = p.levels?.target3;
        const sl    = p.levels?.stop;
        const isLong = p.direction === 'LONG';
        // Mark each pivot with whether it sits between entry and a target —
        // an "INSIDE" pivot is a hint that the target may overshoot or fall short.
        const annotate = (label, level) => {
          if (!Number.isFinite(level) || !Number.isFinite(entry)) return `${label}=${level}`;
          // for LONG: pivot is "ahead" if level > entry; "behind" if level < entry
          // for SHORT: pivot is "ahead" if level < entry; "behind" if level > entry
          const ahead = isLong ? level > entry : level < entry;
          if (!ahead) return `${label}=${level}`;
          // which target tier does it sit just below?
          let zone = '';
          if (isLong) {
            if (t1 && level < t1) zone = ' <T1';
            else if (t2 && level < t2) zone = ' (T1..T2)';
            else if (t3 && level < t3) zone = ' (T2..T3)';
            else zone = ' >T3';
          } else {
            if (t1 && level > t1) zone = ' <T1';
            else if (t2 && level > t2) zone = ' (T1..T2)';
            else if (t3 && level > t3) zone = ' (T2..T3)';
            else zone = ' >T3';
          }
          return `${label}=${level}${zone}`;
        };
        // Show pivots in trade direction (resistances for LONG, supports for SHORT)
        const aheadLevels = isLong
          ? [['R1', pv.R1], ['R2', pv.R2], ['R3', pv.R3]]
          : [['S1', pv.S1], ['S2', pv.S2], ['S3', pv.S3]];
        const aheadStr = aheadLevels.map(([k, v]) => annotate(k, v)).join('  ');
        console.log(`${LOG} ${tag}        pivots:  P=${pv.P}  ${aheadStr}`);
        console.log(`${LOG} ${tag}        levels:  entry=${entry}  SL=${sl}  T1=${t1}  T2=${t2}  T3=${t3}`);
      }
    });
    if (shortlist.length > 3) {
      const extras = shortlist.slice(3, 8).map(c => c.symbol).join(', ');
      const more = shortlist.length - 8 > 0 ? ` (+${shortlist.length - 8} more)` : '';
      console.log(`${LOG} ${tag}  9:32 re-selection pool: ${extras}${more}`);
    }
    console.log(`${LOG} ${tag}  9:32 cron will: re-score against 9:15-9:30 ORB, apply VWAP+direction filters, place SL-M STOPs for top 3`);
    console.log(`${LOG} ${tag} ${_hr('═')}`);
  } catch (err) {
    console.error(`${LOG} ${tag} failed to print briefing: ${err.message}`);
  }
}

/**
 * Called at 15:30 IST (after 15:15 hard flat) — comprehensive end-of-day
 * summary. Prints to console AND upserts a `daily_metrics` doc for
 * week-over-week analysis. Idempotent — safe to call multiple times.
 *
 * Returns the metrics object that was persisted.
 */
export async function logEndOfDaySummary({ dateOverride = null } = {}) {
  const tag = '[EOD-SUMMARY]';
  const tradingDate = dateOverride ? new Date(dateOverride + 'T00:00:00Z') : getISTMidnight();
  const doc = await DailyPick.findOne({ trading_date: tradingDate });
  if (!doc) {
    console.log(`${LOG} ${tag} no DailyPick doc for ${tradingDate.toISOString().slice(0,10)} — nothing to summarize`);
    return null;
  }

  const date = tradingDate.toISOString().slice(0, 10);
  const regime = doc.market_context?.regime || 'UNKNOWN';
  const shortlist = doc.candidates_shortlist || [];
  const picks = doc.picks || [];

  // ── Pick-by-pick lifecycle ────────────────────────────────────────────────
  const triggered  = picks.filter(p => p.trade?.entry_price);
  const winners    = triggered.filter(p => (p.trade?.pnl || 0) > 0);
  const losers     = triggered.filter(p => (p.trade?.pnl || 0) < 0);
  const scratched  = triggered.filter(p => (p.trade?.pnl || 0) === 0);
  const totalPnl   = triggered.reduce((s, p) => s + (p.trade?.pnl || 0), 0);
  const totalRsum  = triggered.reduce((s, p) => {
    if (!p.trade?.entry_price || !p.trade?.exit_price || !p.levels?.stop) return s;
    const isLong = p.direction === 'LONG';
    const risk = isLong ? (p.trade.entry_price - p.levels.stop) : (p.levels.stop - p.trade.entry_price);
    const reward = isLong ? (p.trade.exit_price - p.trade.entry_price) : (p.trade.entry_price - p.trade.exit_price);
    return s + (risk > 0 ? reward / risk : 0);
  }, 0);

  // ── VWAP exit effectiveness ───────────────────────────────────────────────
  const vwapExits = triggered.filter(p => p.trade?.exit_reason?.startsWith?.('vwap_exit'));
  const hardSLs   = triggered.filter(p => p.trade?.exit_reason === 'stop_hit' || p.trade?.status === 'STOPPED_OUT');
  const targetHits = triggered.filter(p => p.trade?.exit_reason === 'target_hit' || p.trade?.status === 'TARGET_HIT');
  const timeExits  = triggered.filter(p => p.trade?.status === 'TIME_EXIT' && !p.trade?.exit_reason?.startsWith?.('vwap_exit'));

  // ── Shortlist post-mortem ─────────────────────────────────────────────────
  const slSelected = shortlist.filter(c => c.shortlist_decision === 'SELECTED_AT_932');
  const slFiltered = shortlist.filter(c => c.shortlist_decision === 'FILTERED_AT_932');
  const slUnused   = shortlist.filter(c => c.shortlist_decision === 'UNUSED' || !c.shortlist_decision);

  // ── Print ─────────────────────────────────────────────────────────────────
  console.log(`${LOG} ${tag} ${_hr('═')}`);
  console.log(`${LOG} ${tag}  END-OF-DAY SUMMARY — ${date}  (regime ${regime})`);
  console.log(`${LOG} ${tag} ${_hr('═')}`);
  console.log(`${LOG} ${tag}`);
  console.log(`${LOG} ${tag}  SHORTLIST FLOW:`);
  console.log(`${LOG} ${tag}    8:30   scanner produced ${shortlist.length} candidates`);
  console.log(`${LOG} ${tag}    9:32   ${slSelected.length} selected for entry, ${slFiltered.length} filtered out, ${slUnused.length} unused`);
  console.log(`${LOG} ${tag}    -----  entries triggered = ${triggered.length}, never triggered = ${picks.length - triggered.length}`);
  console.log(`${LOG} ${tag}`);

  if (triggered.length > 0) {
    console.log(`${LOG} ${tag}  TRADE LIFECYCLE:`);
    console.log(`${LOG} ${tag}    ${_pad('symbol', 12)} ${_pad('dir', 5)} ${_padl('entry', 9)} ${_padl('exit', 9)} ${_pad('outcome', 18)} ${_padl('P&L₹', 9)} ${_padl('P&L%', 7)} ${_padl('R', 6)}`);
    console.log(`${LOG} ${tag}    ${_hr('-', 75)}`);
    for (const p of triggered) {
      const entryPx = p.trade?.entry_price || 0;
      const exitPx  = p.trade?.exit_price  || 0;
      const pnlR    = (entryPx && exitPx && p.levels?.stop)
        ? (p.direction === 'LONG'
            ? (exitPx - entryPx) / (entryPx - p.levels.stop)
            : (entryPx - exitPx) / (p.levels.stop - entryPx))
        : 0;
      const outcome = p.trade?.exit_reason || p.trade?.status || '?';
      console.log(`${LOG} ${tag}    ${_pad(p.symbol, 12)} ${_pad(p.direction, 5)} ${_padl(entryPx.toFixed(2), 9)} ${_padl(exitPx.toFixed(2), 9)} ${_pad(outcome.slice(0,18), 18)} ${_padl((p.trade?.pnl || 0).toFixed(0), 9)} ${_padl((p.trade?.return_pct || 0).toFixed(2)+'%', 7)} ${_padl(pnlR.toFixed(2)+'R', 6)}`);
    }
    console.log(`${LOG} ${tag}`);
    console.log(`${LOG} ${tag}  EXIT BREAKDOWN:`);
    console.log(`${LOG} ${tag}    target hits     ${targetHits.length}`);
    console.log(`${LOG} ${tag}    hard SL hits    ${hardSLs.length}`);
    console.log(`${LOG} ${tag}    VWAP exits      ${vwapExits.length}   ← these are the "saved from full SL" exits`);
    console.log(`${LOG} ${tag}    time/sideways   ${timeExits.length}`);
    console.log(`${LOG} ${tag}`);
    console.log(`${LOG} ${tag}  DAY P&L:`);
    console.log(`${LOG} ${tag}    winners / losers / scratch = ${winners.length} / ${losers.length} / ${scratched.length}`);
    console.log(`${LOG} ${tag}    hit rate                   = ${triggered.length ? (winners.length / triggered.length * 100).toFixed(0) : 0}%`);
    console.log(`${LOG} ${tag}    total P&L                  = ₹${totalPnl.toFixed(0)}`);
    console.log(`${LOG} ${tag}    sum-R (across triggered)   = ${totalRsum.toFixed(2)}R`);
    console.log(`${LOG} ${tag}    avg R per triggered trade  = ${triggered.length ? (totalRsum / triggered.length).toFixed(2) : 0}R`);
  } else {
    console.log(`${LOG} ${tag}  NO TRADES TAKEN — either all 15 filtered at 9:32 or no SL-M triggered before 12:00`);
  }
  console.log(`${LOG} ${tag} ${_hr('═')}`);

  // ── Persist to daily_metrics for week-over-week ──────────────────────────
  const metrics = {
    trading_date: tradingDate,
    regime,
    shortlist_size:       shortlist.length,
    selected_at_932:      slSelected.length,
    filtered_at_932:      slFiltered.length,
    entries_triggered:    triggered.length,
    entries_never_fired:  picks.length - triggered.length,
    winners:              winners.length,
    losers:               losers.length,
    scratched:            scratched.length,
    total_pnl_rupees:     totalPnl,
    total_r_multiples:    totalRsum,
    hit_rate_pct:         triggered.length ? (winners.length / triggered.length * 100) : null,
    exit_breakdown: {
      target_hits:    targetHits.length,
      hard_sl_hits:   hardSLs.length,
      vwap_exits:     vwapExits.length,
      time_exits:     timeExits.length,
    },
    pick_summaries: triggered.map(p => ({
      symbol: p.symbol, direction: p.direction,
      entry_price: p.trade?.entry_price, exit_price: p.trade?.exit_price,
      pnl: p.trade?.pnl, return_pct: p.trade?.return_pct,
      exit_reason: p.trade?.exit_reason, scan_type: p.scan_type,
    })),
    generated_at: new Date(),
  };
  try {
    const mongoose = (await import('mongoose')).default;
    const DailyMetrics = mongoose.models.DailyMetrics || mongoose.model('DailyMetrics',
      new mongoose.Schema({}, { strict: false, collection: 'daily_metrics' })
    );
    await DailyMetrics.findOneAndUpdate(
      { trading_date: tradingDate },
      { $set: metrics },
      { upsert: true, new: true }
    );
    console.log(`${LOG} ${tag} metrics persisted to daily_metrics collection`);
  } catch (err) {
    console.error(`${LOG} ${tag} failed to persist metrics: ${err.message}`);
  }

  return metrics;
}

export async function executeShortlistOrbEntry({ dryRun = false } = {}) {
  const tag = '[SHORTLIST-ORB-ENTRY]';
  const t0 = Date.now();
  console.log(`${LOG} ${tag} ─── 09:32 ORB-breakout entry starting${dryRun ? ' [DRY RUN]' : ''} ───`);

  const today = getISTMidnight();
  const doc = await DailyPick.findOne({ trading_date: today });
  if (!doc) {
    console.log(`${LOG} ${tag} no DailyPick doc for today — nothing to do`);
    return { success: true, picks_placed: 0, message: 'no_doc' };
  }
  const shortlist = doc.candidates_shortlist || [];
  if (shortlist.length === 0) {
    console.log(`${LOG} ${tag} shortlist empty — nothing to do`);
    return { success: true, picks_placed: 0, message: 'empty_shortlist' };
  }
  console.log(`${LOG} ${tag} processing ${shortlist.length} shortlist candidate(s): ${shortlist.map(c => `${c.symbol}(${c.direction})`).join(', ')}`);

  // ── Batch fetch 9:15-9:30 OHLC + volume + Nifty ──
  const symbols = shortlist.map(c => c.symbol);
  let orbMap = {};
  let volMap = {};
  try {
    orbMap = await collectOpeningRange(symbols, shortlist);
  } catch (err) {
    console.error(`${LOG} ${tag} collectOpeningRange threw — ${err.message}. All picks → SKIPPED.`);
  }
  try {
    volMap = await fetchOrbVolume(shortlist) || {};
  } catch (err) {
    console.error(`${LOG} ${tag} fetchOrbVolume threw — ${err.message}. Volume checks will auto-pass.`);
  }
  const niftyChangePct = orbMap?._NIFTY?.nifty_change_pct ?? null;
  console.log(`${LOG} ${tag} Nifty change since open = ${niftyChangePct == null ? 'unknown' : niftyChangePct.toFixed(2) + '%'}`);

  // ── Score every candidate ──
  const evaluated = shortlist.map(c => {
    const orb = orbMap?.[c.symbol] || null;
    const orbPayload = orb ? {
      open:   orb.opening_price,
      high:   orb.high,
      low:    orb.low,
      close:  orb.close ?? orb.last ?? orb.ltp ?? ((orb.high + orb.low) / 2),
    } : null;
    const volumeRatio = volMap?.[c.symbol]?.ratio ?? null;

    const result = evaluateShortlistCandidate({
      candidate: c, orb: orbPayload, volumeRatio, niftyChangePct,
    });

    return {
      candidate: c, orb: orbPayload, volumeRatio,
      ...result,
    };
  });

  // Visibility — log every candidate's score + decision
  evaluated
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .forEach((e, i) => {
      const status = e.passes ? '✓' : '✗';
      const reason = e.rejection_reason ? ` (${e.rejection_reason})` : '';
      console.log(`${LOG} ${tag}   ${status} ${e.candidate.symbol.padEnd(12)} dir=${e.candidate.direction} composite=${(e.candidate.composite ?? 0).toFixed(2)} intra=${e.intradayScore.toFixed(2)} combined=${e.combinedScore.toFixed(3)}${reason}`);
    });

  // ── Select top MAX_DAILY_PICKS ──
  const selected = selectTopOrbEntries(evaluated, MAX_DAILY_PICKS);
  console.log(`${LOG} ${tag} selected ${selected.length} of ${evaluated.length} for entry: ${selected.map(s => s.candidate.symbol).join(', ') || '(none)'}`);

  // ── Update shortlist decisions on the doc ──
  const selectedSymbols = new Set(selected.map(s => s.candidate.symbol));
  for (const c of doc.candidates_shortlist) {
    const ev = evaluated.find(e => e.candidate.symbol === c.symbol);
    if (!ev) {
      c.shortlist_decision = 'UNUSED';
      continue;
    }
    c.intraday_score = ev.intradayScore;
    c.combined_score = ev.combinedScore;
    c.shortlist_decision = selectedSymbols.has(c.symbol) ? 'SELECTED_AT_932' : 'FILTERED_AT_932';
  }

  if (selected.length === 0) {
    doc.markModified('candidates_shortlist');
    await doc.save();
    console.log(`${LOG} ${tag} no candidates passed the ORB gate — sitting out today`);
    return {
      success: true, picks_placed: 0, evaluated: evaluated.length,
      passed: 0, selected: 0, duration_ms: Date.now() - t0,
      message: 'all_filtered_at_932',
    };
  }

  // ── Place SL-M STOP entry orders ──
  // FIXED 2026-05-25: previously called kiteOrderService.getFunds() — which
  // does NOT exist on the service. The real method is getAvailableBalance(),
  // returning { total, available, usable, usableSwing, usableIntraday, ... }.
  // The typo caught a TypeError silently (stderr only) and returned early
  // with picks_placed=0 — the function never reached the placeOrder loop.
  // Result on 2026-05-25: SHORTLIST selected LICI/DIVISLAB/TORNTPHARM but
  // placed zero orders. usableIntraday is the MIS-leveraged pool net of
  // pending orders — exactly the right number for an intraday SL-M entry.
  let balance = null;
  if (!dryRun && isKiteIntegrationEnabled()) {
    try {
      balance = await kiteOrderService.getAvailableBalance();
    } catch (e) {
      console.error(`${LOG} ${tag} getAvailableBalance failed: ${e.message} — aborting entry placement`);
      doc.markModified('candidates_shortlist');
      await doc.save();
      return {
        success: false, picks_placed: 0,
        evaluated: evaluated.length,
        passed: evaluated.filter(e => e.passes).length,
        selected: selected.length,
        error: 'balance_fetch_failed', duration_ms: Date.now() - t0,
      };
    }
  }
  const totalCapital = balance?.usableIntraday ?? balance?.usable ?? balance?.available ?? null;
  if (!dryRun && (!totalCapital || totalCapital <= 0)) {
    console.error(`${LOG} ${tag} no available intraday capital (usableIntraday=${balance?.usableIntraday}) — aborting`);
    doc.markModified('candidates_shortlist');
    await doc.save();
    return {
      success: false, picks_placed: 0,
      evaluated: evaluated.length,
      passed: evaluated.filter(e => e.passes).length,
      selected: selected.length,
      error: 'no_capital', duration_ms: Date.now() - t0,
    };
  }
  console.log(`${LOG} ${tag} intraday capital available: ₹${totalCapital?.toFixed?.(0) ?? totalCapital}`);

  const ordersPlaced = [];
  for (const sel of selected) {
    const c = sel.candidate;
    const levels = sel.computedLevels;
    const isLong = c.direction === 'LONG';

    // Snap entry trigger via snapToNSETick (integer arithmetic + final .toFixed
    // for clean float serialization to Kite). Use ceil for LONG / floor for
    // SHORT so the trigger sits at-or-above (LONG) the breakout level.
    let trigger = snapToNSETick(levels.entry, null, isLong ? 'ceil' : 'floor');

    // Position size (uses existing computePositionSize helper)
    const sizing = computePositionSize({
      totalCapital:  totalCapital || 100000,  // dry-run fallback
      entryPrice:    trigger,
      pickScore:     c.rank_score || 50,
      allPicks:      selected.map(s => ({ rank_score: s.candidate.rank_score || 50 })),
      atrPct:        c.scan_scores?.atr_pct ?? c.scan_meta?.atr_pct ?? 2.0,
      leverageFactor: 5,
    });

    if (sizing.qty <= 0) {
      console.warn(`${LOG} ${tag} ${c.symbol}: qty=0 (capital_per_pick=₹${sizing.perPickCapital} margin=₹${sizing.marginPerShare}) — skipping`);
      continue;
    }

    const txnType = isLong ? 'BUY' : 'SELL';
    console.log(`${LOG} ${tag} ${c.symbol}: place SL-M ${txnType} qty=${sizing.qty} trigger=₹${trigger} sl=₹${roundToTick(levels.sl)} t1=₹${roundToTick(levels.t1)} risk=${levels.risk_pct.toFixed(2)}%`);

    // ── Retry loop: try-twice with tick re-snap on first failure ──
    // Mirror of the placeSLAndTarget retry pattern. If Kite rejects with
    // "Tick size for this script is X" we parse the actual tick from the
    // error, re-snap the trigger, and retry once. Failures after that are
    // logged + the pick is skipped for the day.
    let orderResult = null;
    if (!dryRun) {
      for (let attempt = 1; attempt <= 2 && !orderResult?.success; attempt++) {
        try {
          if (attempt > 1) {
            console.log(`${LOG} ${tag} ${c.symbol}: SL-M retry attempt 2/2 (trigger=₹${trigger})`);
            await delay(500);
          }
          orderResult = await kiteOrderService.placeOrder({
            tradingsymbol: c.symbol,
            exchange:      'NSE',
            transaction_type: txnType,
            order_type:    'SL-M',
            trigger_price: trigger,
            product:       'MIS',
            quantity:      sizing.qty,
            simulationId:  `daily_pick_orb_entry_${c.symbol}`,
            orderType:     'ENTRY',
            source:        'DAILY_PICKS',
          });
          if (!orderResult?.success) {
            throw new Error(`placeOrder returned ${JSON.stringify(orderResult)}`);
          }
          console.log(`${LOG} ${tag} ${c.symbol}: ✅ SL-M placed orderId=${orderResult.orderId}${attempt > 1 ? ' (attempt 2)' : ''}`);
        } catch (err) {
          const brokerTick = parseKiteTickError(err);
          if (brokerTick && attempt === 1) {
            // Kite told us the real tick — re-snap and the retry loop will use it
            const newTrigger = snapToNSETick(levels.entry, brokerTick, isLong ? 'ceil' : 'floor');
            console.log(`${LOG} ${tag} ${c.symbol}: Kite says tick=${brokerTick} — re-snapping trigger ₹${trigger} → ₹${newTrigger}`);
            trigger = newTrigger;
          } else {
            console.error(`${LOG} ${tag} ${c.symbol}: ❌ SL-M placement failed (attempt ${attempt}/2) — ${err.message}`);
            orderResult = null;
          }
        }
      }
      if (!orderResult?.success) {
        console.error(`${LOG} ${tag} ${c.symbol}: ❌ all SL-M attempts failed — skipping this pick`);
        continue;
      }
    } else {
      console.log(`${LOG} ${tag} ${c.symbol}: [DRY RUN] would place SL-M trigger=₹${trigger}`);
      orderResult = { success: true, orderId: `dry_${c.symbol}_${Date.now()}` };
    }

    // ── Promote shortlist candidate → pick (or update existing pick) ──
    let pick = doc.picks?.find(p => p.symbol === c.symbol);
    if (!pick) {
      pick = {
        symbol:         c.symbol,
        stock_name:     c.stock_name || c.symbol,
        instrument_key: c.instrument_key || null,
        scan_type:      c.scan_type,
        direction:      c.direction,
        rank_score:     c.rank_score,
        scan_scores:    c.scan_scores || {},
        scan_meta:      c.scan_meta || {},
        levels:         { mode: 'scanner', entry_type: 'sl-m' },
        trade:          { status: 'PENDING' },
        kite:           { kite_status: 'pending' },
      };
      doc.picks.push(pick);
    }

    // Refresh levels with the ORB-derived numbers
    pick.levels.entry       = trigger;
    pick.levels.stop        = roundToTick(levels.sl);
    pick.levels.target      = roundToTick(levels.t1);
    pick.levels.target2     = roundToTick(levels.t2);
    pick.levels.target3     = roundToTick(levels.t3);
    pick.levels.risk_pct    = levels.risk_pct;
    pick.levels.reward_pct  = levels.reward_pct;
    pick.levels.risk_reward = 1.0;
    pick.levels.entry_type  = 'sl-m';
    pick.levels.mode        = 'scanner';
    pick.levels.source      = `orb_breakout 9:30_close=${roundToTick(sel.orb.close)} sl=orb_${isLong ? 'low' : 'high'}`;

    pick.kite.entry_order_id = orderResult.orderId;
    pick.kite.kite_status    = 'order_placed';
    pick.trade.status        = 'ORDER_PLACED';
    pick.trade.qty           = sizing.qty;

    ordersPlaced.push({
      symbol: c.symbol, orderId: orderResult.orderId,
      trigger, sl: pick.levels.stop, qty: sizing.qty, direction: c.direction,
    });
  }

  doc.markModified('candidates_shortlist');
  doc.markModified('picks');
  await doc.save();

  console.log(`${LOG} ${tag} ─── done in ${Date.now() - t0}ms ───`);
  console.log(`${LOG} ${tag}   evaluated=${evaluated.length}  passed=${evaluated.filter(e => e.passes).length}  selected=${selected.length}  orders_placed=${ordersPlaced.length}`);

  return {
    success: true,
    picks_placed: ordersPlaced.length,
    orders: ordersPlaced,
    evaluated: evaluated.length,
    passed: evaluated.filter(e => e.passes).length,
    selected: selected.length,
    duration_ms: Date.now() - t0,
  };
}

/**
 * 12:00 IST: cancel any ORDER_PLACED SL-M entries that haven't triggered.
 * The breakout we were waiting for didn't happen — better to free the
 * capital + margin than to be filled into a 13:30 lunch-time chop.
 */
export async function cancelStaleOrbEntries() {
  const tag = '[ORB-ENTRY-CANCEL]';
  const t0 = Date.now();
  const today = getISTMidnight();
  const doc = await DailyPick.findOne({ trading_date: today });
  if (!doc?.picks?.length) {
    console.log(`${LOG} ${tag} no picks today — nothing to cancel`);
    return { success: true, cancelled: 0 };
  }
  const unfilled = doc.picks.filter(p => p.trade?.status === 'ORDER_PLACED' && p.kite?.entry_order_id);
  if (!unfilled.length) {
    console.log(`${LOG} ${tag} all picks already filled or no entry orders — nothing to cancel`);
    return { success: true, cancelled: 0 };
  }
  console.log(`${LOG} ${tag} cancelling ${unfilled.length} unfilled SL-M entry order(s): ${unfilled.map(p => p.symbol).join(', ')}`);
  let cancelled = 0;
  for (const pick of unfilled) {
    try {
      await kiteOrderService.cancelOrder(pick.kite.entry_order_id);
      pick.trade.status = 'SKIPPED';
      pick.trade.exit_reason = 'orb_breakout_did_not_trigger_by_1200';
      pick.kite.kite_status = 'cancelled';
      cancelled++;
      console.log(`${LOG} ${tag} ${pick.symbol}: ✅ cancelled ${pick.kite.entry_order_id}`);
    } catch (err) {
      console.error(`${LOG} ${tag} ${pick.symbol}: ❌ cancel failed — ${err.message}`);
    }
  }
  doc.markModified('picks');
  await doc.save();
  console.log(`${LOG} ${tag} done in ${Date.now() - t0}ms — cancelled ${cancelled}/${unfilled.length}`);
  return { success: true, cancelled };
}


async function runScannerPy({ mode, scannerType = getActiveScannerType(), top = MAX_DAILY_PICKS } = {}) {
  const { getFnoSymbols } = await import('../../constants/fnoUniverse.js');
  const symbolSet = await getFnoSymbols();
  const symbols = [...symbolSet];

  // Choose the right python script based on SCANNER_TYPE (intraday | swing).
  const scriptPath = getScannerScriptPath(scannerType);
  const scriptName = path.basename(scriptPath);

  // Sensible default mode per scanner type if caller didn't pass one.
  const effectiveMode = mode || (scannerType === 'swing' ? 'recovery_breakout' : 'intraday_gap_long');

  // Bounded top — at minimum 1, at most 50 (anything bigger is wasted compute
  // since the F&O universe rarely has 50 valid setups per regime per day).
  const effectiveTop = Math.max(1, Math.min(50, Math.floor(Number(top) || MAX_DAILY_PICKS)));

  // Write watchlist to a temp file — both scanners read one symbol per line
  const watchlistPath = path.join(os.tmpdir(), `logdhan_fno_${Date.now()}.txt`);
  await fs.writeFile(watchlistPath, symbols.join('\n'), 'utf8');

  console.log(`${LOG} [Scanner] ─── Step 3: run ${scriptName} ───`);
  console.log(`${LOG} [Scanner]   scanner_type=${scannerType}  mode=${effectiveMode}`);
  console.log(`${LOG} [Scanner]   universe=${symbols.length} F&O symbols, top=${effectiveTop}, min-score=0.3, no-tv`);
  console.log(`${LOG} [Scanner]   python path=${scriptPath}`);
  console.log(`${LOG} [Scanner]   watchlist temp=${watchlistPath}`);
  const t0 = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync('python3', [
      scriptPath,
      '--watchlist', watchlistPath,
      '--top', String(effectiveTop),
      '--json',
      '--no-tv',
      '--min-score', '0.3',
      '--mode', effectiveMode,
    ], { timeout: 180_000 }); // 3 min max — yfinance batch can be slow on 400 symbols
    const ms = Date.now() - t0;

    // Always log stderr if present — scanner.py uses it for progress + warnings.
    // Truncate to 2000 chars so we don't blow up the log.
    if (stderr && stderr.trim()) {
      console.log(`${LOG} [Scanner]   stderr (${stderr.length} chars): ${stderr.slice(0, 2000)}${stderr.length > 2000 ? '...[truncated]' : ''}`);
    }
    console.log(`${LOG} [Scanner]   completed in ${ms}ms (${(ms / 1000).toFixed(1)}s)`);

    // stdout has progress lines + one JSON array line (the picks)
    const stdoutLines = stdout.split('\n');
    const jsonLine = stdoutLines.map(l => l.trim()).find(l => l.startsWith('[{') || l === '[]');
    if (!jsonLine) {
      console.error(`${LOG} [Scanner] ❌ No JSON array found in stdout.`);
      console.error(`${LOG} [Scanner]   stdout (${stdout.length} chars): ${stdout.slice(0, 1500)}${stdout.length > 1500 ? '...[truncated]' : ''}`);
      console.error(`${LOG} [Scanner]   typical cause: yfinance threw before the JSON line was printed; check stderr above`);
      return [];
    }

    let raw;
    try {
      raw = JSON.parse(jsonLine);
    } catch (parseErr) {
      console.error(`${LOG} [Scanner] ❌ JSON.parse failed: ${parseErr.message}`);
      console.error(`${LOG} [Scanner]   offending line: ${jsonLine.slice(0, 800)}${jsonLine.length > 800 ? '...' : ''}`);
      return [];
    }

    if (raw.length === 0) {
      console.warn(`${LOG} [Scanner] ⚠️  ${scriptName} returned ZERO picks (composite scores all below min-score=0.3 or all symbols failed history fetch)`);
      console.warn(`${LOG} [Scanner]   for mode=${effectiveMode} this usually means: no F&O stock matched the setup criteria today`);
      return [];
    }
    console.log(`${LOG} [Scanner] ✔ ${raw.length} picks returned, top-of-list scores: ${raw.slice(0, 5).map(p => `${p.symbol}=${p.composite?.toFixed(2)}`).join(', ')}`);
    // Per-pick detail line so a failure can be diagnosed pick-by-pick later
    for (const p of raw) {
      console.log(`${LOG} [Scanner]   ${p.symbol.padEnd(12)} dir=${p.direction || 'LONG'} mode=${p.mode || effectiveMode} close=${p.close} sl=${p.sl} t1=${p.t1} t2=${p.t2} t3=${p.t3} RR(t1/t2/t3)=${(p.rr_t1 || 0).toFixed(2)}/${(p.rr_t2 || 0).toFixed(2)}/${(p.rr_t3 || 0).toFixed(2)} composite=${(p.composite || 0).toFixed(3)}`);
    }

    // Wrap the exported pure-function helper so we get the same behavior
    // PLUS a warn log when we fall back. See pickScannerTarget() above.
    const MIN_RR = 1.0;
    function pickTarget(s) {
      const chosen = pickScannerTarget(s, MIN_RR);
      if (chosen.isFallback) {
        console.warn(`${LOG} [Scanner] ${s.symbol}: no target ≥ 1:1 R:R — using ${chosen?.label} (rr=${chosen?.rr?.toFixed(2)})`);
      }
      return chosen;
    }

    // Map scanner.py Score → internal pick shape.
    // scan_type now comes from the scanner's mode (e.g. 'momentum_leader'),
    // direction from the scanner's direction field (LONG or SHORT).
    return raw.map(s => {
      const tgt = pickTarget(s);
      const scanType = s.mode || effectiveMode;
      const direction = s.direction || 'LONG';
      return {
      symbol: s.symbol,
      stock_name: s.symbol,
      instrument_key: null,
      scan_type: scanType,
      direction,
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
        source:      `scanner.py mode=${scanType} | sl_src=${s.sl_src} | tgt_src=${tgt.label}`,
      },
      scan_scores: {
        volume_ratio:       round2(s.volume_spike || 0),
        rsi:                round2(s.rsi || 0),
        atr_pct:            s.atr && s.close ? round2((s.atr / s.close) * 100) : null,
        close_in_range_pct: Math.round((s.range_pos || 0) * 100),
        avg_volume_50d:     null, // not provided by scanner.py
      },
      // scan_meta — per-mode telemetry from scanner.py. Currently populated
      // by nr7_compression (records LONG-default + setup features). Other
      // modes leave this null; safe to read with optional chaining.
      scan_meta: s.scan_meta || null,
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
    // REGIME-AWARE ROUTING (May 2026, always on — no env flag)
    //
    // 1. Compute the real market regime via computeMarketContextV2(). Result
    //    is persisted onto the DailyPick doc so audit data records actual
    //    regimes instead of the legacy "SCANNER" placeholder.
    // 2. The regime label decides which scanner.py mode runs today.
    //    Mapping is REGIME_TO_SCANNER_MODE (defined at the top of this file).
    //    EXTREME_BEAR sits out — no picks. Other regimes always produce a
    //    mode and run the scanner.
    // 3. If the chosen mode throws, fall back to recovery_breakout so we
    //    never end the morning with zero picks due to a scanner-side bug.
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`${LOG} [Regime] ─── Step 1: compute market regime ───`);
    const regimeT0 = Date.now();
    let realContext = null;
    try {
      realContext = await computeMarketContextV2();
      const regimeMs = Date.now() - regimeT0;
      console.log(`${LOG} [Regime] computeMarketContextV2 OK in ${regimeMs}ms`);
      console.log(`${LOG} [Regime]   regime=${realContext?.regime} score=${realContext?.regime_score} playbook=${realContext?.playbook}`);
      console.log(`${LOG} [Regime]   max_trades=${realContext?.max_trades} size_mult=${realContext?.size_multiplier}`);
      if (realContext?.inputs) {
        console.log(`${LOG} [Regime]   inputs: structure=${realContext.inputs.structure} breadth=${realContext.inputs.breadth} volatility=${realContext.inputs.volatility} overnight=${realContext.inputs.overnight} flow=${realContext.inputs.flow}`);
      }
      if (realContext?.raw_data) {
        const r = realContext.raw_data;
        console.log(`${LOG} [Regime]   raw: nifty=${r.nifty_close} ema20=${r.ema20} ema50=${r.ema50} vix=${r.vix_close}(${r.vix_percentile}p) breadth=${r.breadth_pct}% gift=${r.gift_pct}% fii=${r.fii_cr}cr dii=${r.dii_cr}cr`);
      }
      if (realContext?.halt_reason) {
        console.warn(`${LOG} [Regime]   ⚠️  halt_reason: ${realContext.halt_reason}`);
      }
    } catch (rErr) {
      const regimeMs = Date.now() - regimeT0;
      console.error(`${LOG} [Regime] computeMarketContextV2 THREW after ${regimeMs}ms: ${rErr.message}`);
      console.error(`${LOG} [Regime] stack: ${rErr.stack?.split('\n').slice(0, 5).join(' | ') || '(no stack)'}`);
      console.warn(`${LOG} [Regime] → regimeLabel will fall through to UNKNOWN → system will SIT OUT today`);
    }

    // ─── Regime → scanner-mode routing (always on) ────────────────────────
    // No env flag. Every morning the regime label decides which scanner mode
    // runs. The system SITS OUT (no picks, no orders) in any of these cases:
    //   • EXTREME_BEAR regime (intentional defensive sit-out)
    //   • UNKNOWN regime (regime engine threw or returned no label)
    //   • HALT / CONFLICT / SCANNER / any unrecognized label
    //   • The chosen scanner mode itself throws
    //
    // Mapping (REGIME_TO_SCANNER_MODE, defined above):
    //   STRONG_BULL  → vcp_pivot         (LONG, Minervini VCP)
    //   WEAK_BULL    → pullback_20ema    (LONG, Raschke 20-EMA bounce)
    //   NEUTRAL      → rsi2_meanrev      (LONG, Connors RSI-2 mean reversion)
    //   WEAK_BEAR    → failed_bounce     (SHORT, proven 69% hit)
    //   STRONG_BEAR  → failed_bounce     (SHORT, route to winner — was 'breakdown')
    //   EXTREME_BEAR / unknown / HALT → null (sit out)
    //
    // Rationale: when the regime engine fails or returns a non-trading label,
    // running recovery_breakout LONG on a guess is the worst failure mode —
    // it biases us to LONG on a morning that may genuinely be bearish. Sitting
    // out is the correct response when conviction is unavailable.
    const regimeLabel = realContext?.regime || 'UNKNOWN';
    const haltReason = realContext?.halt_reason || null;
    let chosenMode;
    let chosenPath;
    let sitOutReason = null;
    let picksWithLevels = [];

    console.log(`${LOG} [Route] ─── Step 2: regime → scanner-mode routing ───`);
    console.log(`${LOG} [Route] regimeLabel="${regimeLabel}" haltReason=${haltReason ? `"${haltReason}"` : 'null'}`);

    // Decision is made in a linear sequence of guards. The first guard that
    // produces a `chosenPath` short-circuits the rest. This is easier to
    // reason about than the prior nested if/else.
    const indiaVixForRoute = realContext?.raw_data?.vix_close ?? null;

    // Guard 1: catastrophic VIX → sit out regardless of regime label
    if (chosenPath == null && typeof indiaVixForRoute === 'number' && indiaVixForRoute > 0) {
      if (resolveOrbAtrRatioForVix(indiaVixForRoute) === 'SIT_OUT') {
        chosenMode = null;
        chosenPath = 'sit_out_extreme_vix';
        sitOutReason = `India VIX=${indiaVixForRoute} > VIX_EXTREME_SIT_OUT_THRESHOLD — catastrophic-vol day, system not calibrated`;
        console.warn(`${LOG} [Route] DECISION: SIT OUT — ${sitOutReason}`);
      }
    }

    // Guard 2: regime is EXTREME_BEAR → defensive sit-out
    if (chosenPath == null && regimeLabel === 'EXTREME_BEAR') {
      chosenMode = null;
      chosenPath = 'sit_out_extreme_bear';
      sitOutReason = 'EXTREME_BEAR — defensive sit-out';
      console.warn(`${LOG} [Route] DECISION: SIT OUT (regime=EXTREME_BEAR by design)`);
    }

    // Guard 3: map regime → scanner mode. null means UNKNOWN / HALT / etc.
    // The active scanner type (intraday | swing) is decided at startup from
    // SCANNER_TYPE and selects which of the two routing maps to consult.
    const activeScannerType = getActiveScannerType();
    if (chosenPath == null) {
      chosenMode = selectScannerModeForRegime(regimeLabel, activeScannerType);
      if (chosenMode == null) {
        chosenPath = `sit_out_${regimeLabel.toLowerCase()}`;
        sitOutReason = haltReason
          ? `regime=${regimeLabel} (${haltReason}) — sitting out`
          : `regime=${regimeLabel} not recognized — sitting out (regime engine likely failed)`;
        console.warn(`${LOG} [Route] DECISION: SIT OUT — ${sitOutReason}`);
        console.warn(`${LOG} [Route]   to debug: check the [REGIME V2] log lines above. If they are missing, computeMarketContextV2 threw — look for its stack trace.`);
        console.warn(`${LOG} [Route]   typical causes: India VIX fetcher failed, FII data unavailable, breadth scan timed out, MongoDB read error on regime inputs.`);
      } else {
        chosenPath = `regime_scanner_${chosenMode}`;
        const direction = SHORT_SCANNER_MODES.has(chosenMode) ? 'SHORT' : 'LONG';
        console.log(`${LOG} [Route] DECISION: scanner_type=${activeScannerType}  regime="${regimeLabel}" → --mode=${chosenMode} (${direction})`);
      }
    }

    // Run the chosen scanner mode (if one was selected). We request the FULL
    // shortlist (SHORTLIST_SIZE candidates) in one call:
    //   • the top MAX_DAILY_PICKS become today's `picks` (placed as AMO at 8:30
    //     — preserves existing behavior)
    //   • all SHORTLIST_SIZE entries are persisted to candidates_shortlist for
    //     the 9:32 re-selection job (Commit 2)
    // If the scanner throws, we sit out — we do NOT silently fall back, for the
    // same reason we sit out on unknown regimes: a guessed-direction trade is
    // the wrong response to "we don't know what to do today."
    let scannerShortlist = [];
    if (chosenMode && picksWithLevels.length === 0) {
      try {
        scannerShortlist = await runScannerPy({
          mode: chosenMode,
          scannerType: activeScannerType,
          top: SHORTLIST_SIZE,
        });
        // Top MAX_DAILY_PICKS become the AMO picks. Rest stay in shortlist only.
        picksWithLevels = scannerShortlist.slice(0, MAX_DAILY_PICKS);
        console.log(`${LOG} [Route] scanner returned ${scannerShortlist.length} candidates → picks=${picksWithLevels.length}, shortlist_extras=${Math.max(0, scannerShortlist.length - picksWithLevels.length)}`);
        if (scannerShortlist.length === 0) {
          // Scanner ran cleanly but found nothing. Different failure mode
          // from "scanner crashed" — record it so the audit trail is honest.
          sitOutReason = `scanner ${chosenMode} returned 0 picks (no setups today)`;
          chosenPath = `${chosenPath}_zero_picks`;
          console.warn(`${LOG} [Route] ⚠️  scanner returned no picks for mode=${chosenMode} — will save empty doc`);
        }
      } catch (scErr) {
        console.error(`${LOG} [Route] ❌ scanner mode=${chosenMode} THREW: ${scErr.message}`);
        console.error(`${LOG} [Route]   stack: ${scErr.stack?.split('\n').slice(0, 6).join(' | ') || '(no stack)'}`);
        if (scErr.stdout) console.error(`${LOG} [Route]   scanner stdout: ${String(scErr.stdout).slice(0, 1500)}`);
        if (scErr.stderr) console.error(`${LOG} [Route]   scanner stderr: ${String(scErr.stderr).slice(0, 1500)}`);
        console.error(`${LOG} [Route]   typical causes: python3 not on PATH, yfinance throttled, scanner.py raised an unhandled exception, network timeout`);
        sitOutReason = `scanner ${chosenMode} failed: ${scErr.message}`;
        chosenPath = `${chosenPath}_scanner_failed`;
        picksWithLevels = [];
        scannerShortlist = [];
      }
    }
    console.log(`${LOG} [Route] ─── Step 4: finalize ───`);
    console.log(`${LOG} [Route]   final path=${chosenPath}`);
    console.log(`${LOG} [Route]   picks=${picksWithLevels.length}${sitOutReason ? `, sit_out_reason="${sitOutReason}"` : ''}`);

    // compat aliases used by Step 7/8 logging
    const enriched  = picksWithLevels;
    const scored    = picksWithLevels;
    const allViable = picksWithLevels;

    // marketContext: use the REAL regime if we have one; otherwise mark
    // explicitly as UNKNOWN with the sit-out reason so the audit DB doesn't
    // get the misleading "SCANNER" placeholder.
    const marketContext = realContext
      ? {
          ...realContext,
          source_path:    chosenPath,
          sit_out_reason: sitOutReason,                 // null when we traded
          decided_at:     realContext.decided_at || new Date().toISOString(),
        }
      : {
          regime:          'UNKNOWN',
          regime_score:    null,
          playbook:        'halt',
          max_trades:      0,
          size_multiplier: 0,
          halt_reason:     'computeMarketContextV2 failed or returned no regime',
          source_path:     chosenPath,
          sit_out_reason:  sitOutReason || 'regime engine failed',
          inputs:          { source: 'no regime context available' },
          decided_at:      new Date().toISOString(),
        };

    if (picksWithLevels.length === 0) {
      console.log(`${LOG} [Empty] ─── Step 5a: empty-picks path ───`);
      console.log(`${LOG} [Empty]   reason=${sitOutReason || 'unknown (no sit_out_reason captured)'}`);
      console.log(`${LOG} [Empty]   regime=${marketContext.regime} chosenPath=${chosenPath}`);
      console.log(`${LOG} [Empty]   saving empty DailyPick doc + sending "no picks today" notification`);
      try {
        const emptyDoc = await saveToDB(marketContext, [], { candidates: [], bullish_count: 0, bearish_count: 0 });
        console.log(`${LOG} [Empty]   ✔ empty doc saved id=${emptyDoc?._id}`);
        await sendNotification(marketContext, [], emptyDoc);
        console.log(`${LOG} [Empty]   ✔ notification sent`);
        return { success: true, picks: 0, doc: emptyDoc, halted: true, reason: sitOutReason };
      } catch (emptyErr) {
        console.error(`${LOG} [Empty] ❌ failed to save empty doc / send notification: ${emptyErr.message}`);
        throw emptyErr;
      }
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


    // Step 7: Save to DB (picks + pre-open shortlist)
    console.log(`${LOG} [Step 7] Saving to DB: ${picksWithInsights.length} picks + ${scannerShortlist.length} shortlist candidates`);
    const doc = await saveToDB(marketContext, picksWithInsights, scanResult, candidatesReview, null, scannerShortlist);
    console.log(`${LOG} [Step 7] Saved DailyPick doc: ${doc._id}`);
    if (doc.candidates_shortlist?.length) {
      console.log(`${LOG} [Step 7] Shortlist: ${doc.candidates_shortlist.map(c => `${c.symbol}(rank=${c.shortlist_rank},dec=${c.shortlist_decision})`).join(', ')}`);
    }

    // Morning briefing — concise day-1 summary easy to grep at 8:31 IST
    logMorningBriefing(doc, marketContext);
    for (const p of doc.picks) {
      const ss = p.scan_scores;
      console.log(`${LOG} [Step 7] ${p.symbol}: entry=₹${p.levels?.entry} stop=₹${p.levels?.stop} target=₹${p.levels?.target} vol_ratio=${ss?.volume_ratio} rsi=${ss?.rsi} atr_pct=${ss?.atr_pct}%`);
    }

    // Step 7.5: Place AMO MARKET orders immediately (scanner path)
    // Orders queue at the broker and execute at the 9:08 AM pre-open auction.
    // This avoids any separate 9:30 AM scheduled step — by the time market opens,
    // orders are already in the system. The 9:30 validateAndPlaceEntries call
    // becomes a no-op (picks are already ORDER_PLACED, eligiblePicks filter skips them).
    // ─── Step 7.5: AMO placement DISABLED ────────────────────────────────────
    // May 2026 architecture shift: we no longer market-order at the 9:08 auction.
    // The 8:30 scanner now produces a 15-candidate shortlist (persisted on the
    // doc). At 9:32, executeShortlistOrbEntry re-scores against the 9:15-9:30
    // opening range and places SL-M STOP entries at the 9:30 close ± buffer —
    // entries trigger only on actual breakout. picks[] is populated then.
    //
    // The placePreMarketEntries function is preserved (not deleted) for fast
    // rollback if the new path proves unreliable. To re-enable, swap the block
    // below for the original `await placePreMarketEntries(doc)` call.
    console.log(`${LOG} [Step 7.5] AMO placement skipped — using 9:32 SL-M STOP entries instead (see executeShortlistOrbEntry)`);
    void placePreMarketEntries; // keep reference so unused-vars linter doesn't complain

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
  ATR_MIN_PCT: 1.0,          // below this, stop is inside noise → whipsaw (lowered 1.2→1.0 to admit borderline midcaps with genuine catalysts)
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
 *   G2  ATR envelope — 1.0% ≤ atr_pct ≤ 5.0%
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

async function saveToDB(marketContext, picks, scanResult, candidatesReview = [], globalIntel = null, candidatesShortlist = []) {
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

  // ─── Pre-open shortlist (Commit 1) ─────────────────────────────────────────
  // Persist every scanner candidate (typically SHORTLIST_SIZE = 15) so the
  // 9:32 selection job (Commit 2) has a richer pool than just the 3 picks.
  // The top MAX_DAILY_PICKS candidates that became actual picks are tagged
  // SELECTED_AT_830; the rest are UNUSED until the 9:32 job re-scores them.
  const selectedSymbols = new Set((picks || []).map(p => p.symbol));
  const shortlistDocs = (candidatesShortlist || []).map((c, idx) => ({
    symbol:        c.symbol,
    stock_name:    c.stock_name || c.symbol,
    instrument_key: c.instrument_key || null,
    scan_type:     c.scan_type || null,
    direction:     c.direction || 'LONG',
    rank_score:    c.rank_score ?? null,
    composite:     (c.rank_score != null) ? c.rank_score / 100 : null,
    levels: c.levels ? {
      entry:       c.levels.entry,
      stop:        c.levels.stop,
      target:      c.levels.target,
      target2:     c.levels.target2 ?? null,
      target3:     c.levels.target3 ?? null,
      risk_pct:    c.levels.risk_pct,
      reward_pct:  c.levels.reward_pct,
      risk_reward: c.levels.risk_reward,
      entry_type:  c.levels.entry_type,
      mode:        c.levels.mode,
      source:      c.levels.source,
    } : null,
    scan_scores: c.scan_scores || null,
    scan_meta:   c.scan_meta || null,
    shortlist_rank: idx + 1,
    shortlist_decision: selectedSymbols.has(c.symbol) ? 'SELECTED_AT_830' : 'UNUSED',
    intraday_score: null,
    combined_score: null,
  }));

  // Upsert: one document per trading day
  const doc = await DailyPick.findOneAndUpdate(
    { trading_date: tradingDate },
    {
      $set: {
        trading_date: tradingDate,
        scan_date: scanDate,
        market_context: marketContext,
        picks: pickDocs,
        candidates_shortlist: shortlistDocs,
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
    body = `${pickSummary} — pre-open candidates from a ${doc?.candidates_shortlist?.length || picks.length}-shortlist. Final entry decision at 9:32 IST after 9:15-9:30 ORB confirmation. SL-M STOPs will be placed only for picks that pass direction + VWAP gates.`;
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
 * Place pre-market AMO MARKET orders for scanner.py picks.
 *
 * Called immediately after runDailyPicks() at 8:30 AM. Places AMO MARKET MIS
 * orders that execute at the 9:08 AM pre-open auction. By market open at 9:15 AM
 * the orders are either filled (→ checkFillsFallback places SL+target) or still
 * pending (→ gapProtectionCheck may cancel at 9:05 AM if gap is adverse).
 *
 * Non-scanner docs (levels.mode !== 'scanner') are skipped — ORB path handles those.
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

    // ATR-based sizing: scale capital inversely with volatility.
    // Use scan_scores.atr_pct (persisted in DB) — _ohlcv is NOT in the DB shape so
    // it is undefined on the doc returned by findOneAndUpdate({ new: true }).
    const atrPct = pick.scan_scores?.atr_pct || null;
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

  // Redistribute capital from picks that can't afford ≥1 share to the remaining picks.
  // Example: APOLLOHOSP at ₹8308 gets proportional budget ₹5451 → qty=0 → freed capital
  // rolls into GRASIM + ABFRL so the full intraday pool is deployed.
  // Iterates until stable (no further picks become unaffordable after redistribution).
  // Picks with capital=0 (regime-blocked) are never funded.
  {
    let changed = true;
    while (changed) {
      changed = false;
      let freedCapital = 0;
      const viable = [];
      for (const a of allocations) {
        if (a.capital <= 0) continue;
        if (Math.floor(a.capital / a.pick.levels.entry) < 1) {
          console.log(`${LOG} [Step 7.5] ${a.pick.symbol}: qty=0 at ₹${a.capital} — freeing ₹${a.capital} for redistribution`);
          freedCapital += a.capital;
          a.capital = 0;
          changed = true;
        } else {
          viable.push(a);
        }
      }
      if (freedCapital > 0 && viable.length > 0) {
        const viableScoreSum = viable.reduce((s, a) => s + a.pick.rank_score, 0);
        for (const a of viable) {
          const added = Math.floor(freedCapital * (a.pick.rank_score / viableScoreSum));
          a.capital += added;
          console.log(`${LOG} [Step 7.5] ${a.pick.symbol}: +₹${added} redistributed → new capital ₹${a.capital}`);
        }
      }
    }
  }

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

  // Persist pick status updates atomically using targeted $set per symbol.
  // Avoids Mongoose VersionError that fires when doc.save() is called on a
  // document returned by findOneAndUpdate (concurrent writes bump __v between
  // the two calls).
  for (const { pick } of allocations) {
    // Picks with qty=0 were skipped — their kite_status is still 'pending', no write needed.
    if (pick.kite.kite_status === 'pending') continue;
    try {
      await DailyPick.updateOne(
        { _id: doc._id, 'picks.symbol': pick.symbol },
        {
          $set: {
            'picks.$.trade.status':        pick.trade.status,
            'picks.$.trade.qty':           pick.trade.qty || 0,
            'picks.$.kite.kite_status':    pick.kite.kite_status,
            'picks.$.kite.entry_order_id': pick.kite.entry_order_id || null,
          }
        }
      );
    } catch (saveErr) {
      console.error(`${LOG} [Step 7.5] ⚠️ DB update failed for ${pick.symbol}: ${saveErr.message}`);
    }
  }

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
    // Targeted per-pick updates — avoids Mongoose version-key conflict
    for (const pick of amoPicks) {
      if (pick.kite.kite_status !== 'pending') continue; // only write changed picks
      try {
        await DailyPick.updateOne(
          { _id: doc._id, 'picks.symbol': pick.symbol },
          {
            $set: {
              'picks.$.trade.status':     pick.trade.status,
              'picks.$.kite.kite_status': pick.kite.kite_status,
              'picks.$.trade.exit_reason': pick.trade.exit_reason || null,
            }
          }
        );
      } catch (saveErr) {
        console.error(`${LOG} [GAP-PROTECT] DB update failed for ${pick.symbol}: ${saveErr.message}`);
      }
    }

    try {
      await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
        `Gap Protection: ${cancelled} AMO cancelled`,
        `${cancelled} entry order(s) cancelled due to excessive gap at open.`,
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

  console.log(`${LOG} [DEBUG] Persisting ORB data — ${storedCount} picks updated, ${skippedCount} skipped (wrong status)`);
  for (const pick of pendingPicks) {
    if (!pick.orb?.high) continue; // skip picks that had no ORB data in the response
    try {
      await DailyPick.updateOne(
        { _id: doc._id, 'picks.symbol': pick.symbol },
        { $set: { 'picks.$.orb': pick.orb } }
      );
    } catch (dbErr) {
      console.error(`${LOG} [ERROR] updateOne failed for ${pick.symbol} (ORB store): ${dbErr.message}`);
    }
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

  // India VIX for Check 5 scaling. PREFER the value already on the saved
  // marketContext (computed at 8:30 by computeMarketContextV2) so we don't
  // re-fetch the same value an hour later — avoids both an extra API call
  // and any risk of value mismatch between the regime decision and the
  // validation gate. Falls back to a live fetch only if the saved value is
  // missing (e.g. legacy doc from before the regime engine was wired).
  let indiaVix = doc.market_context?.raw_data?.vix_close ?? null;
  if (indiaVix == null) {
    console.warn(`${LOG} [DEBUG] India VIX not on marketContext — falling back to live fetch`);
    try {
      const vix = await fetchVixData();
      indiaVix = typeof vix?.close === 'number' ? vix.close : null;
    } catch (vixErr) {
      console.warn(`${LOG} [WARN] fetchVixData failed: ${vixErr.message} — Check 5 will use baseline ratio`);
    }
  }
  console.log(`${LOG} [DEBUG] India VIX for Check 5 scaling: ${indiaVix ?? 'unavailable (baseline ratio)'}`);

  console.log(`${LOG} [DEBUG] Calling validatePicks() — regime=${regime}, orbPass=${orbPass}, vix=${indiaVix ?? 'n/a'}`);
  validatePicks(eligiblePicks, orbData, regime, orbPass, orbVolumeMap, indiaVix);
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
    for (const pick of eligiblePicks) {
      try {
        await DailyPick.updateOne(
          { _id: doc._id, 'picks.symbol': pick.symbol },
          { $set: {
            'picks.$.trade.status':      pick.trade.status,
            'picks.$.kite.kite_status':  pick.kite.kite_status,
            'picks.$.trade.exit_reason': pick.trade.exit_reason || null,
          }}
        );
      } catch (dbErr) {
        console.error(`${LOG} [ERROR] updateOne failed for ${pick.symbol} (all-failed path): ${dbErr.message}`);
      }
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
    for (const pick of validatedPicks) {
      try {
        await DailyPick.updateOne(
          { _id: doc._id, 'picks.symbol': pick.symbol },
          { $set: {
            'picks.$.trade.status':      pick.trade.status,
            'picks.$.kite.kite_status':  pick.kite.kite_status,
            'picks.$.trade.exit_reason': pick.trade.exit_reason || null,
          }}
        );
      } catch (dbErr) {
        console.error(`${LOG} [ERROR] updateOne failed for ${pick.symbol} (circuit breaker): ${dbErr.message}`);
      }
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
    // ATR-based sizing: scale inversely with volatility.
    // Use scan_scores.atr_pct (persisted in DB) — _ohlcv is NOT in the DB shape.
    const atrPct = pick.scan_scores?.atr_pct || null;
    if (atrPct && atrPct > 0) {
      const atrMult = Math.max(MIN_ATR_MULT_ORB, Math.min(MAX_ATR_MULT_ORB, BASELINE_ATR_PCT_ORB / atrPct));
      capital = Math.floor(capital * atrMult);
      console.log(`${LOG}   ${pick.symbol}: ATR=${round2(atrPct)}% → mult=${round2(atrMult)}x → capital=₹${capital}`);
    }
    return { pick, capital };
  });

  // Redistribute capital from picks that can't afford ≥1 share to the remaining picks.
  {
    let changed = true;
    while (changed) {
      changed = false;
      let freedCapital = 0;
      const viable = [];
      for (const a of allocations) {
        if (a.capital <= 0) continue;
        if (Math.floor(a.capital / a.pick.levels.entry) < 1) {
          console.log(`${LOG} [Step 3.5] ${a.pick.symbol}: qty=0 at ₹${a.capital} — freeing ₹${a.capital} for redistribution`);
          freedCapital += a.capital;
          a.capital = 0;
          changed = true;
        } else {
          viable.push(a);
        }
      }
      if (freedCapital > 0 && viable.length > 0) {
        const viableScoreSum = viable.reduce((s, a) => s + a.pick.rank_score, 0);
        for (const a of viable) {
          const added = Math.floor(freedCapital * (a.pick.rank_score / viableScoreSum));
          a.capital += added;
          console.log(`${LOG} [Step 3.5] ${a.pick.symbol}: +₹${added} redistributed → new capital ₹${a.capital}`);
        }
      }
    }
  }

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

  console.log(`${LOG} [DEBUG] Persisting order placement results — statuses: ${eligiblePicks.map(p => `${p.symbol}=${p.trade.status}`).join(', ')}`);
  for (const pick of eligiblePicks) {
    try {
      await DailyPick.updateOne(
        { _id: doc._id, 'picks.symbol': pick.symbol },
        { $set: {
          'picks.$.trade.status':        pick.trade.status,
          'picks.$.trade.qty':           pick.trade.qty || 0,
          'picks.$.kite.kite_status':    pick.kite.kite_status,
          'picks.$.kite.entry_order_id': pick.kite.entry_order_id || null,
          'picks.$.trade.exit_reason':   pick.trade.exit_reason || null,
        }}
      );
    } catch (dbErr) {
      console.error(`${LOG} [ERROR] updateOne failed for ${pick.symbol} (after orders): ${dbErr.message}`);
    }
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
  // Deferred path MUST be checked first — AMO fills before 9:15 AM set status=ENTERED
  // (not ORDER_PLACED), so the idempotency guard below would incorrectly skip them.
  if (pick.kite.kite_status === 'entered_awaiting_915' && pick.trade.status === 'ENTERED') {
    // Deferred call from post-9:15 scheduler — proceed with stored entry price
    entryPrice = entryPrice || pick.trade.entry_price;
    console.log(`${LOG} ${pick.symbol}: Processing deferred SL+target (was awaiting 9:15 AM) — entry @ ₹${entryPrice}`);
    // Fall through to placement below
  } else if (pick.kite.kite_status === 'sl_target_placed' || pick.trade.status !== 'ORDER_PLACED') {
    // Idempotency guard — prevent double-placement for normal (non-deferred) picks
    console.log(`${LOG} ${pick.symbol}: SL+target already placed or status changed — skipping`);
    return;
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
    await DailyPick.updateOne(
      { _id: doc._id, 'picks.symbol': pick.symbol },
      {
        $set: {
          'picks.$.trade.status':     'ENTERED',
          'picks.$.trade.entry_price': entryPrice,
          'picks.$.trade.entry_time':  new Date(),
          'picks.$.kite.kite_status': 'entered_awaiting_915',
        }
      }
    );
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

  // Pre-snap to NSE standard tick (0.05).
  // For LONG: stop trigger rounds DOWN (conservative — don't fire early).
  // For SHORT: stop trigger rounds UP.
  // If Kite rejects with a larger tick (e.g. 0.10), we re-snap on the retry.
  const isBullishSL = pick.direction === 'LONG';
  let slTrigger  = snapToNSETick(pick.levels.stop, null, isBullishSL ? 'floor' : 'ceil');
  let tgtPrice   = snapToNSETick(target,           null, isBullishSL ? 'ceil'  : 'floor');

  console.log(`${LOG} ${pick.symbol}: Snapped SL ₹${pick.levels.stop} → ₹${slTrigger} | Target ₹${target} → ₹${tgtPrice} (tick=${getNseTickSize(pick.levels.stop)})`);

  // MIS allows multiple pending orders — place SL-M + LIMIT separately.
  // Retry SL-M up to 2 attempts. On attempt 2, re-snap using the actual tick
  // from Kite's InputException message — this fixes the 0.05/0.10 mismatch.
  for (let slAttempt = 1; slAttempt <= 2 && !slPlaced; slAttempt++) {
    try {
      if (slAttempt > 1) {
        console.log(`${LOG} ${pick.symbol}: SL-M retry attempt 2/2 (trigger=₹${slTrigger})`);
        await delay(500);
      }
      const slResult = await kiteOrderService.placeOrder({
        tradingsymbol: pick.symbol, exchange: 'NSE',
        transaction_type: exitSide, order_type: 'SL-M',
        trigger_price: slTrigger, product: 'MIS',
        quantity: pick.trade.qty,
        simulationId: `daily_pick_sl_${pick.symbol}`,
        orderType: 'STOP_LOSS', source: 'DAILY_PICKS'
      });
      if (slResult.success) {
        pick.kite.stop_order_id = slResult.orderId;
        pick.levels.stop = slTrigger; // keep levels in sync with what Kite actually accepted
        slPlaced = true;
        console.log(`${LOG} ${pick.symbol}: SL-M placed @ ₹${slTrigger} — orderId=${slResult.orderId}${slAttempt > 1 ? ' (attempt 2)' : ''}`);
      }
    } catch (err) {
      const tick = parseKiteTickError(err);
      if (tick && slAttempt === 1) {
        // Kite told us the real tick size — re-snap and the retry loop will use it
        slTrigger = snapToNSETick(pick.levels.stop, tick, isBullishSL ? 'floor' : 'ceil');
        tgtPrice  = snapToNSETick(target,           tick, isBullishSL ? 'ceil'  : 'floor');
        console.log(`${LOG} ${pick.symbol}: Tick size is ${tick} — re-snapped SL → ₹${slTrigger}, target → ₹${tgtPrice}`);
      } else {
        console.error(`${LOG} ${pick.symbol}: SL-M error (attempt ${slAttempt}/2):`, err.message);
      }
    }
  }

  // Target LIMIT retry loop — same try-twice + tick-re-snap pattern as SL-M.
  // Critical: before this fix, a target tick rejection abandoned the order and
  // left the position with only a hard SL (no profit target = exit relies on
  // monitor/15:15 only). Now we re-snap and retry once on tick errors.
  for (let tgtAttempt = 1; tgtAttempt <= 2 && !tgtPlaced; tgtAttempt++) {
    try {
      if (tgtAttempt > 1) {
        console.log(`${LOG} ${pick.symbol}: Target LIMIT retry attempt 2/2 (price=₹${tgtPrice})`);
        await delay(500);
      }
      const tgtResult = await kiteOrderService.placeOrder({
        tradingsymbol: pick.symbol, exchange: 'NSE',
        transaction_type: exitSide, order_type: 'LIMIT',
        price: tgtPrice, product: 'MIS',
        quantity: pick.trade.qty,
        simulationId: `daily_pick_tgt_${pick.symbol}`,
        orderType: 'TARGET', source: 'DAILY_PICKS'
      });
      if (tgtResult.success) {
        pick.kite.target_order_id = tgtResult.orderId;
        pick.levels.target = tgtPrice; // sync levels with accepted price
        tgtPlaced = true;
        console.log(`${LOG} ${pick.symbol}: Target LIMIT placed @ ₹${tgtPrice} — orderId=${tgtResult.orderId}${tgtAttempt > 1 ? ' (attempt 2)' : ''}`);
      }
    } catch (err) {
      const brokerTick = parseKiteTickError(err);
      if (brokerTick && tgtAttempt === 1) {
        const newTgt = snapToNSETick(target, brokerTick, isBullishSL ? 'ceil' : 'floor');
        console.log(`${LOG} ${pick.symbol}: Target tick mismatch — Kite says tick=${brokerTick} — re-snapping ₹${tgtPrice} → ₹${newTgt}`);
        tgtPrice = newTgt;
      } else {
        console.error(`${LOG} ${pick.symbol}: Target LIMIT error (attempt ${tgtAttempt}/2):`, err.message);
      }
    }
  }
  if (!tgtPlaced) {
    console.error(`${LOG} ${pick.symbol}: ⚠️  Target LIMIT NOT PLACED after retries — position has SL but no profit target. Monitor + 15:15 hard-flat are the only exit paths.`);
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

  // Persist all state changes for this pick atomically.
  // Using updateOne + positional $ prevents Mongoose VersionError from concurrent
  // fill-listener postback and polling-fallback both calling doc.save() on the same doc.
  try {
    await DailyPick.updateOne(
      { _id: doc._id, 'picks.symbol': pick.symbol },
      {
        $set: {
          'picks.$.trade.status':         pick.trade.status,
          'picks.$.trade.entry_price':    pick.trade.entry_price ?? null,
          'picks.$.trade.entry_time':     pick.trade.entry_time ?? null,
          'picks.$.trade.qty':            pick.trade.qty ?? null,
          'picks.$.trade.exit_price':     pick.trade.exit_price ?? null,
          'picks.$.trade.exit_time':      pick.trade.exit_time ?? null,
          'picks.$.trade.exit_reason':    pick.trade.exit_reason ?? null,
          'picks.$.trade.pnl':            pick.trade.pnl ?? null,
          'picks.$.trade.return_pct':     pick.trade.return_pct ?? null,
          'picks.$.kite.kite_status':     pick.kite.kite_status,
          'picks.$.kite.stop_order_id':   pick.kite.stop_order_id ?? null,
          'picks.$.kite.target_order_id': pick.kite.target_order_id ?? null,
          'picks.$.levels.target':        pick.levels.target ?? null,
          'picks.$.trailing_history':     pick.trailing_history ?? [],
        }
      }
    );
  } catch (dbErr) {
    console.error(`${LOG} ${pick.symbol}: DB update failed in placeSLAndTarget: ${dbErr.message}`);
  }
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
          await DailyPick.updateOne(
            { _id: doc._id, 'picks.symbol': pick.symbol },
            { $set: { 'picks.$.trade.status': 'SKIPPED', 'picks.$.kite.kite_status': 'skipped' } }
          ).catch(e => console.error(`${LOG} [FILL-FALLBACK] ${pick.symbol}: DB update failed: ${e.message}`));
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
          await DailyPick.updateOne(
            { _id: doc._id, 'picks.symbol': pick.symbol },
            { $set: { 'picks.$.trade.status': 'SKIPPED', 'picks.$.kite.kite_status': 'skipped' } }
          ).catch(e => console.error(`${LOG} [FILL-FALLBACK] ${pick.symbol}: DB update failed: ${e.message}`));
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

    try {
      await DailyPick.updateOne(
        { _id: doc._id, 'picks.symbol': pick.symbol },
        { $set: {
          'picks.$.trade.status':      'SKIPPED',
          'picks.$.trade.exit_reason': 'setup_expired_1030',
          'picks.$.kite.kite_status':  'skipped',
        }}
      );
    } catch (dbErr) {
      console.error(`${LOG} ${pick.symbol}: DB update failed in cancelExpiredEntries: ${dbErr.message}`);
    }
  }

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

  // [MIDDAY-INTEL REMOVED] fetchGlobalMarketIntel / shouldAvoidTrading were part of
  // the disabled global-intel pipeline (import commented out at line 53).
  // Calling them here caused ReferenceError on every 12 PM monitor cycle.
  // If midday risk-off is needed in future, re-import from globalMarketIntel.js
  // and restore this block — the modifyOrder logic is correct, just needs the import.

  // ── POSITION RECONCILIATION: detect manual closes before any order activity ──
  // If the user manually exits a position in Kite, our DB still shows ENTERED.
  // Without this check every subsequent monitor cycle tries to re-place SL orders
  // or even fire a candle-structure exit — creating an unintended naked short.
  // We fetch the actual Kite day positions once per monitor run and mark any
  // ENTERED pick with net qty = 0 as manually_exited before touching anything else.
  const kiteNetQty = {}; // symbol → net qty
  try {
    const posData = await kiteOrderService.getPositions();
    const dayPos  = posData?.data?.day || [];
    for (const p of dayPos) {
      kiteNetQty[p.tradingsymbol] = (kiteNetQty[p.tradingsymbol] || 0) + p.quantity;
    }
  } catch (posErr) {
    console.warn(`${LOG} Position fetch failed — skipping reconciliation: ${posErr.message}`);
  }

  let statusChanged = false;

  for (const pick of enteredPicks) {
    // ── Manual-close guard ──────────────────────────────────────────────────────
    // If Kite shows net qty = 0 for this symbol, the user closed it manually.
    // Mark it completed in DB and skip all order logic for this cycle.
    if (Object.keys(kiteNetQty).length > 0 && (kiteNetQty[pick.symbol] ?? pick.trade.qty) === 0) {
      console.warn(`${LOG} ⚠️ ${pick.symbol}: Kite net qty = 0 but DB shows ENTERED — marking as manually exited`);
      // Cancel any lingering SL / target orders before closing out
      if (pick.kite.stop_order_id)   { try { await kiteOrderService.cancelOrder(pick.kite.stop_order_id);   } catch (_) {} }
      if (pick.kite.target_order_id) { try { await kiteOrderService.cancelOrder(pick.kite.target_order_id); } catch (_) {} }
      pick.kite.stop_order_id   = null;
      pick.kite.target_order_id = null;
      pick.trade.status         = 'TIME_EXIT';
      pick.trade.exit_reason    = 'manual_close';
      pick.trade.exit_time      = new Date();
      pick.kite.kite_status     = 'completed';
      statusChanged = true;
      try {
        await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
          `ℹ️ ${pick.symbol}: Manual Close Detected`,
          `Kite position = 0 but DB showed ENTERED. Marked as completed. Lingering SL/target orders cancelled.`,
          { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
        );
      } catch (_) {}
      continue; // skip SL/target/candle logic for this pick
    }

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

      } else if (stopStatus === 'REJECTED') {
        // ── SL-M REJECTED: clear dead order ID and re-place a fresh one ──────────
        // Kite rejects SL-M orders immediately in some edge cases (price band,
        // tick mismatch, circuit limit). The dead order ID cannot be modified.
        // We track consecutive rejections in pick.kite.sl_rejected_count (DB field
        // so it survives across 5-min monitor cycles; _slRejectedCount was in-memory
        // only and reset to 0 every cycle when DailyPick.findToday() re-loaded picks):
        //   • Each cycle: nudge stop 1 tick toward LTP (away from circuit)
        //   • After SL_REJECT_FORCE_EXIT_THRESHOLD consecutive failures:
        //     place a MARKET exit to close the naked position rather than loop forever.
        const SL_REJECT_FORCE_EXIT_THRESHOLD = 3;

        pick.kite.sl_rejected_count = (pick.kite.sl_rejected_count || 0) + 1;

        const deadOrderId = pick.kite.stop_order_id;
        const isBullishSL = pick.direction === 'LONG';
        const slTick      = getNseTickSize(pick.levels.stop);

        // Nudge stop 1 tick toward LTP on every consecutive rejection so we
        // walk away from the circuit price. For LONG (SELL SL-M) → nudge UP.
        // For SHORT (BUY SL-M) → nudge DOWN.
        const nudgedStop = isBullishSL
          ? snapToNSETick(pick.levels.stop + slTick, null, 'ceil')
          : snapToNSETick(pick.levels.stop - slTick, null, 'floor');

        console.warn(
          `${LOG} ⚠️ ${pick.symbol}: SL order ${deadOrderId} REJECTED ` +
          `(consecutive #${pick.kite.sl_rejected_count}) — ` +
          `clearing dead ID, nudging stop ₹${pick.levels.stop} → ₹${nudgedStop} (+${slTick} tick, ${isBullishSL ? 'up' : 'down'})`
        );
        // Attempt cancel on the dead order before nulling it — guards against it
        // somehow surviving as OPEN alongside the fresh order (double-fill risk).
        // Terminal orders (REJECTED/CANCELLED) will throw; catch and ignore.
        try {
          await kiteOrderService.cancelOrder(deadOrderId);
          console.log(`${LOG} ${pick.symbol}: Cancelled dead SL order ${deadOrderId}`);
        } catch (cancelErr) {
          console.log(`${LOG} ${pick.symbol}: Cancel of ${deadOrderId} failed (likely already terminal): ${cancelErr.message}`);
        }
        pick.kite.stop_order_id = null; // clear immediately so candle monitor won't try to modify it
        pick.levels.stop        = nudgedStop; // adopt nudged level before re-placing

        // ── Force-exit path: too many consecutive rejections ─────────────────
        if (pick.kite.sl_rejected_count >= SL_REJECT_FORCE_EXIT_THRESHOLD) {
          console.error(
            `${LOG} 🚨 ${pick.symbol}: SL rejected ${pick.kite.sl_rejected_count}× in a row — ` +
            `circuit or band blocks every re-placement. Forcing MARKET exit now.`
          );
          try {
            await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
              `🚨 ${pick.symbol}: Force-Exit — SL Blocked`,
              `SL-M rejected ${pick.kite.sl_rejected_count}× (circuit/band). Placing MARKET ${isBullishSL ? 'SELL' : 'BUY'} to close position.`,
              { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
            );
          } catch (_) { /* ignore */ }

          if (!dryRun) {
            try {
              const exitResult = await kiteOrderService.placeOrder({
                tradingsymbol:    pick.symbol,
                exchange:         'NSE',
                transaction_type: isBullishSL ? 'SELL' : 'BUY',
                order_type:       'MARKET',
                product:          'MIS',
                quantity:         pick.trade.qty,
                simulationId:     `daily_pick_sl_forced_exit_${pick.symbol}`,
                orderType:        'EXIT',
                source:           'DAILY_PICKS',
              });
              if (exitResult.success) {
                pick.trade.exit_reason   = 'sl_force_exit';
                pick.trade.exit_time     = new Date();
                pick.kite.kite_status    = 'completed';
                pick.kite.sl_rejected_count    = 0;
                console.log(`${LOG} ✅ ${pick.symbol}: Force MARKET exit placed — orderId=${exitResult.orderId}`);
              }
            } catch (exitErr) {
              console.error(`${LOG} ${pick.symbol}: Force-exit MARKET order failed:`, exitErr.message);
            }
          }

          statusChanged = true;
          // Skip the normal re-place block below
        } else {
          // ── Normal re-place path (attempt 1-2 with tick re-snap on error) ──
          try {
            await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
              `⚠️ ${pick.symbol}: SL-M Rejected — Re-placing (#${pick.kite.sl_rejected_count})`,
              `SL order ${deadOrderId} rejected. Re-placing SL-M @ ₹${nudgedStop} (nudged ${slTick} tick). Check position.`,
              { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
            );
          } catch (_) { /* ignore notification failure */ }

          if (!dryRun) {
            const exitSide = isBullishSL ? 'SELL' : 'BUY';
            let slTrigger  = snapToNSETick(nudgedStop, null, isBullishSL ? 'floor' : 'ceil');
            let slReplaced = false;

            for (let attempt = 1; attempt <= 2 && !slReplaced; attempt++) {
              try {
                if (attempt > 1) {
                  console.log(`${LOG} ${pick.symbol}: SL re-place retry 2/2 (trigger=₹${slTrigger})`);
                  await delay(500);
                }
                const slResult = await kiteOrderService.placeOrder({
                  tradingsymbol:    pick.symbol,
                  exchange:         'NSE',
                  transaction_type: exitSide,
                  order_type:       'SL-M',
                  trigger_price:    slTrigger,
                  product:          'MIS',
                  quantity:         pick.trade.qty,
                  simulationId:     `daily_pick_sl_replay_${pick.symbol}`,
                  orderType:        'STOP_LOSS',
                  source:           'DAILY_PICKS',
                });
                if (slResult.success) {
                  pick.kite.stop_order_id = slResult.orderId;
                  // pick.levels.stop already set to nudgedStop above
                  slReplaced = true;
                  console.log(
                    `${LOG} ✅ ${pick.symbol}: Fresh SL-M placed @ ₹${slTrigger} — ` +
                    `orderId=${slResult.orderId}${attempt > 1 ? ' (attempt 2)' : ''}`
                  );
                }
              } catch (slErr) {
                const tick = parseKiteTickError(slErr);
                if (tick && attempt === 1) {
                  slTrigger = snapToNSETick(nudgedStop, tick, isBullishSL ? 'floor' : 'ceil');
                  console.log(`${LOG} ${pick.symbol}: SL re-place tick re-snap → ₹${slTrigger} (tick=${tick})`);
                } else {
                  console.error(`${LOG} ${pick.symbol}: SL re-place error (attempt ${attempt}/2):`, slErr.message);
                }
              }
            }

            if (!slReplaced) {
              console.error(
                `${LOG} ⚠️ NAKED POSITION: ${pick.symbol} SL re-placement failed — ` +
                `no stop protection. Consecutive rejections: ${pick.kite.sl_rejected_count}/${SL_REJECT_FORCE_EXIT_THRESHOLD}. ` +
                `Next cycle will retry with further nudge.`
              );
              try {
                await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
                  `🚨 ${pick.symbol}: NAKED — SL Re-place Failed (#${pick.kite.sl_rejected_count})`,
                  `Could not place SL-M @ ₹${slTrigger}. Force-exit in ${SL_REJECT_FORCE_EXIT_THRESHOLD - pick.kite.sl_rejected_count} more failure(s).`,
                  { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
                );
              } catch (_) { /* ignore */ }
            }
          }

          // statusChanged = true so the end-of-monitor DB persist writes the new
          // stop_order_id (fresh order ID or null) and updated levels.stop
          statusChanged = true;
        }
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
                      // SL-M = trigger only (see 2026-05-25 incident). Passing
                      // `price` converts to SL (limit) and the spread blows past
                      // NSE's permissible-range rule → every modify rejects.
                      await kiteOrderService.modifyOrder(pick.kite.stop_order_id, {
                        trigger_price: newStop,
                      });
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
            const snappedBE = snapToNSETick(beStop, null, isBullish ? 'floor' : 'ceil');
            try {
              // SL-M modify: trigger only (see 2026-05-25 incident).
              await kiteOrderService.modifyOrder(pick.kite.stop_order_id, {
                trigger_price: snappedBE,
              });
              if (!pick.trailing_history) pick.trailing_history = [];
              pick.trailing_history.push({ timestamp: new Date(), old_stop: currentStop, new_stop: snappedBE, price_at_trail: currentPrice, reason: 'breakeven_1R' });
              pick.levels.stop = snappedBE;
              pick._breakeven_moved = true;
              statusChanged = true;
              console.log(`${LOG} [+1R BE] ${pick.symbol}: Profit ${round2(profitR)}R — stop moved to breakeven ₹${currentStop} → ₹${snappedBE}`);
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
          const snappedTrail = snapToNSETick(trail.newStop, null, isBullish ? 'floor' : 'ceil');
          try {
            // SL-M modify: trigger only (see 2026-05-25 incident).
            await kiteOrderService.modifyOrder(pick.kite.stop_order_id, {
              trigger_price: snappedTrail,
            });
            if (!pick.trailing_history) pick.trailing_history = [];
            pick.trailing_history.push({ timestamp: new Date(), old_stop: currentStop, new_stop: snappedTrail, price_at_trail: currentPrice, phase: trail.phase, method: trail.method });
            pick.levels.stop = snappedTrail;
            pick._layer2TrailedThisCycle = true;  // Guard — candle block checks this to avoid double modifyOrder
            statusChanged = true;
            console.log(`${LOG} [TRAILING] ${pick.symbol}: Stop ₹${currentStop} → ₹${snappedTrail} [${trail.method} P${trail.phase}] (price=₹${currentPrice}, peak=₹${round2(pick._extreme_price)}, ${trail.reason})`);
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

  // ── CANDLE-BASED STRUCTURE ANALYSIS (5-min + 15-min) ──
  // Runs for ALL entered picks (with or without protective orders).
  // For picks with no protective orders this is the only intraday protection besides 3 PM exit.
  if (enteredPicks.length > 0 && !dryRun) {
    try {
      const candleSymbols = enteredPicks
        .filter(p => p.trade.status === 'ENTERED')
        .map(p => p.symbol);

      console.log(`${LOG} [CANDLE] ── Candle analysis cycle ──────────────────────────`);
      // 5-min: 80 bars covers 9:15→15:15 — needed for full-session VWAP.
      // 15-min: 4 bars suffices for structural analysis (last 60 min).
      console.log(`${LOG} [CANDLE] Fetching 5-min (80 bars) + 15-min (4 bars) for: ${candleSymbols.join(', ')}`);
      const multiCandles = await kiteOrderService.getIntradayMultiCandles(candleSymbols, [
        { interval: '5minute',  count: 80 },
        { interval: '15minute', count: 4 },
      ]);
      const candles5m  = multiCandles['5minute']  || {};
      const candles15m = multiCandles['15minute'] || {};

      for (const pick of enteredPicks) {
        if (pick.trade.status !== 'ENTERED') continue;

        const sym5m  = candles5m[pick.symbol]  || [];
        const sym15m = candles15m[pick.symbol] || [];

        console.log(`${LOG} [CANDLE] ${pick.symbol}: 5m_bars=${sym5m.length} 15m_bars=${sym15m.length} currentStop=₹${pick.levels.stop} hasSL=${!!pick.kite.stop_order_id} layer2Trailed=${!!pick._layer2TrailedThisCycle}`);

        // ── VWAP EXIT (NEW, May 2026 — fires BEFORE cushion-gated structural exit) ──
        // Compute cumulative day-VWAP from all available 5-min bars (today only —
        // getIntradayMultiCandles returns same-day bars). If price has closed on
        // the wrong side of VWAP for 2 consecutive 5-min bars, exit immediately
        // — institutional flow has flipped against the trade, no need to ride
        // the hard SL. This is NOT cushion-gated (works even at break-even or
        // slight loss) because VWAP-flip is itself a directional signal.
        if (sym5m.length >= 2) {
          const vwapResult = computeVwap(sym5m);
          const latestBar = sym5m[sym5m.length - 1];
          const latestClose = Number(latestBar.close);
          const prevConsecutive = Number(pick.vwap_consecutive_opp || 0);

          const vwapDecision = evaluateVwapExit({
            direction: pick.direction,
            latestClose,
            vwap: vwapResult.vwap,
            consecutiveOpp: prevConsecutive,
          });

          // Persist updated counter + latest VWAP for next cycle
          pick.vwap_consecutive_opp = vwapDecision.consecutiveOpp;
          pick.vwap_last_value      = vwapResult.vwap;
          pick.vwap_last_checked_at = new Date();

          console.log(`${LOG} [VWAP] ${pick.symbol}: close=₹${latestClose} vwap=₹${vwapResult.vwap?.toFixed(2) ?? 'null'} side=${vwapDecision.side} consec=${vwapDecision.consecutiveOpp} exit=${vwapDecision.exit}`);

          if (vwapDecision.exit) {
            console.log(`${LOG} [VWAP] ${pick.symbol}: 🚨 VWAP EXIT FIRED — ${vwapDecision.reason}`);
            const exitOk = await _forceExitPick(pick, {
              tag: '[VWAP-EXIT]',
              reasonPrefix: 'vwap_exit',
              reason: vwapDecision.reason,
              orderType: 'VWAP_EXIT',
            });
            if (exitOk && pick.trade.status === 'TIME_EXIT') {
              statusChanged = true;
              // P&L using latest close as exit-price proxy (will be refined when
              // the order's actual fill comes back via fill-fallback)
              pick.trade.exit_price = latestClose;
              pick.trade.exit_price_source = 'vwap_exit_close_proxy';
              calculatePnl(pick);
            }
            continue;   // skip the rest of the monitor logic for this pick this cycle
          }
        }

        // ── SIDEWAYS EXIT for no-SL picks (Layer 2 skips them; use 5-min close as LTP proxy) ──
        if (!pick.kite.stop_order_id) {
          const priceProxy      = sym5m.length > 0 ? sym5m[sym5m.length - 1].close : pick.trade.entry_price;
          const minutesSinceEntry = pick.trade.entry_time
            ? (Date.now() - new Date(pick.trade.entry_time).getTime()) / 60000
            : 999;
          const profitPctProxy  = ((priceProxy - pick.trade.entry_price) / pick.trade.entry_price) * 100
            * (pick.direction === 'LONG' ? 1 : -1);
          const sidewaysDecision = checkSidewaysExit(minutesSinceEntry, profitPctProxy);

          console.log(`${LOG} [CANDLE/SIDEWAYS] ${pick.symbol} (no-SL): proxy=₹${priceProxy} pnl=${round2(profitPctProxy)}% min=${round2(minutesSinceEntry)} shouldExit=${sidewaysDecision.shouldExit}`);

          if (sidewaysDecision.shouldExit) {
            console.log(`${LOG} [CANDLE/SIDEWAYS] ${pick.symbol}: ${sidewaysDecision.reason} — exiting dead no-SL position`);
            try {
              const exitSide   = pick.direction === 'LONG' ? 'SELL' : 'BUY';
              const exitResult = await kiteOrderService.placeOrder({
                tradingsymbol: pick.symbol, exchange: 'NSE',
                transaction_type: exitSide, order_type: 'MARKET',
                product: 'MIS', quantity: pick.trade.qty,
                simulationId: `daily_pick_sideways_nosl_${pick.symbol}`,
                orderType: 'SIDEWAYS_EXIT', source: 'DAILY_PICKS',
              });
              if (exitResult.success) {
                await delay(1500);
                let exitPrice = priceProxy;
                try {
                  const exitOrder = await kiteOrderService.getOrderDetails(exitResult.orderId);
                  if (exitOrder?.average_price) exitPrice = exitOrder.average_price;
                } catch (_) {}
                pick.trade.status     = 'TIME_EXIT';
                pick.trade.exit_price = exitPrice;
                pick.trade.exit_time  = new Date();
                pick.trade.exit_reason = sidewaysDecision.reason;
                pick.trade.exit_price_source = 'order_fill';
                calculatePnl(pick);
                pick.kite.kite_status = 'completed';
                statusChanged = true;
                console.log(`${LOG} [CANDLE/SIDEWAYS] ✅ ${pick.symbol}: Exited @ ₹${exitPrice}, PnL: ₹${pick.trade.pnl}`);
              }
            } catch (err) {
              console.error(`${LOG} [CANDLE/SIDEWAYS] ${pick.symbol}: Exit failed:`, err.message);
            }
            continue; // Skip candle structure analysis for this pick after exit
          }
        }

        const decision = analyzeIntradayStructure({
          candles5m:   sym5m,
          candles15m:  sym15m,
          direction:   pick.direction,
          currentStop: pick.levels.stop,
          // R-cushion context: pass actual fill + original planned stop so the
          // structural-exit cushion (STRUCTURE_EXIT_MIN_R_CUSHION) can gate
          // single-bar break-outs that haven't built any profit yet.
          entryPrice:  pick.trade?.entry_price,
          plannedStop: pick.validation?.original_levels?.stop ?? pick.levels?.stop,
        });

        // Full decision + all intermediate values (the reason string embeds the debug dump)
        console.log(`${LOG} [CANDLE] ${pick.symbol}: ▶ action=${decision.action}${decision.newStop ? ` newStop=₹${decision.newStop}` : ''}`);
        console.log(`${LOG} [CANDLE] ${pick.symbol}:   ${decision.reason}`);

        // ── Telemetry: track how often each structural-exit gate blocked an
        //    exit. Counters persist on the pick.trade subdoc so post-trade
        //    analytics can answer "did the cushion / two-bar rule cost us
        //    real winners or save us real losers?" (review S2).
        if (decision.action !== 'exit' && /15-min structure broken/i.test(decision.reason || '')) {
          if (!pick.trade.exit_gate_blocks) {
            pick.trade.exit_gate_blocks = { cushion: 0, two_bar: 0, missing_r_ctx: 0 };
          }
          if (/cushion/i.test(decision.reason)) {
            pick.trade.exit_gate_blocks.cushion = (pick.trade.exit_gate_blocks.cushion || 0) + 1;
          } else if (/single bar|unconfirmed|insufficient 15-min history/i.test(decision.reason)) {
            pick.trade.exit_gate_blocks.two_bar = (pick.trade.exit_gate_blocks.two_bar || 0) + 1;
          }
        }
        if (decision.action === 'hold' && /MISSING_R_CONTEXT/.test(decision.reason || '')) {
          if (!pick.trade.exit_gate_blocks) {
            pick.trade.exit_gate_blocks = { cushion: 0, two_bar: 0, missing_r_ctx: 0 };
          }
          pick.trade.exit_gate_blocks.missing_r_ctx = (pick.trade.exit_gate_blocks.missing_r_ctx || 0) + 1;
          // ERROR level — this is a programming error, not a normal operational
          // metric. Counter persists in DB for monitoring (`exit_gate_blocks
          // .missing_r_ctx > 0` over any window = active bug). Stack trace
          // helps identify the caller — though the call site in this file is
          // line ~3820, the stack reveals the chain (monitor cron → here).
          const stack = new Error('R-context missing').stack
            .split('\n').slice(0, 6).join(' | ');
          console.error(`${LOG} [CANDLE] ${pick.symbol}: 🚨 PROGRAMMING ERROR — analyzeIntradayStructure called without entryPrice/plannedStop. Hard stop still active but structural management is OFF. Stack: ${stack}`);
        }

        if (decision.action === 'exit') {
          // ── CANDLE EXIT — 15-min structure broken ──
          console.log(`${LOG} [CANDLE] ${pick.symbol}: STRUCTURE BREAK — placing market exit`);
          try {
            if (pick.kite.stop_order_id)   { try { await kiteOrderService.cancelOrder(pick.kite.stop_order_id);   } catch (_) {} }
            if (pick.kite.target_order_id) { try { await kiteOrderService.cancelOrder(pick.kite.target_order_id); } catch (_) {} }
            await delay(500);

            const exitSide = pick.direction === 'LONG' ? 'SELL' : 'BUY';
            const exitResult = await kiteOrderService.placeOrder({
              tradingsymbol: pick.symbol, exchange: 'NSE',
              transaction_type: exitSide, order_type: 'MARKET',
              product: 'MIS', quantity: pick.trade.qty,
              simulationId: `daily_pick_candle_exit_${pick.symbol}`,
              orderType: 'CANDLE_STRUCTURE_EXIT', source: 'DAILY_PICKS',
            });

            if (exitResult.success) {
              await delay(1500);
              let exitPrice = sym5m.length > 0 ? sym5m[sym5m.length - 1].close : pick.trade.entry_price;
              try {
                const exitOrder = await kiteOrderService.getOrderDetails(exitResult.orderId);
                if (exitOrder?.average_price) exitPrice = exitOrder.average_price;
              } catch (_) {}

              pick.trade.status = 'TIME_EXIT';
              pick.trade.exit_price = exitPrice;
              pick.trade.exit_time = new Date();
              pick.trade.exit_reason = `candle_structure_exit: ${decision.reason}`;
              pick.trade.exit_price_source = 'order_fill';
              calculatePnl(pick);
              pick.kite.kite_status = 'completed';
              statusChanged = true;
              console.log(`${LOG} [CANDLE] ✅ ${pick.symbol}: Exited @ ₹${exitPrice} — ${decision.reason}. PnL: ₹${pick.trade.pnl}`);
            }
          } catch (err) {
            console.error(`${LOG} [CANDLE] ${pick.symbol}: Exit order failed:`, err.message);
          }

        } else if ((decision.action === 'trail' || decision.action === 'tighten') && decision.newStop) {
          // ── CANDLE TRAIL / TIGHTEN ──
          const isBullish = pick.direction === 'LONG';
          const currentStop = pick.levels.stop;
          // Only apply if it improves the stop (never widen it)
          const isImprovement = isBullish
            ? decision.newStop > currentStop
            : decision.newStop < currentStop;

          if (isImprovement) {
            if (pick.kite.stop_order_id) {
              if (pick._layer2TrailedThisCycle) {
                // Layer 2 Chandelier already called modifyOrder this cycle — skip the extra API call.
                // The stop has already been moved on Kite; just ensure DB level reflects the best value.
                if (isBullish ? decision.newStop > pick.levels.stop : decision.newStop < pick.levels.stop) {
                  pick.levels.stop = decision.newStop;
                  statusChanged = true;
                }
                console.log(`${LOG} [CANDLE] ${pick.symbol}: Layer 2 already trailed this cycle — skipping modifyOrder, noted stop ₹${decision.newStop} [${decision.action}]`);
              } else {
                let snappedCandelStop = snapToNSETick(decision.newStop, null, isBullish ? 'floor' : 'ceil');

                // Guard: Kite rejects SL-M modify when trigger_price >= LTP (for SELL) or <= LTP (for BUY).
                // Use last 5-min close as LTP proxy. If trigger would equal/cross LTP, nudge by 1 tick.
                const ltpProxy = sym5m.length > 0 ? sym5m[sym5m.length - 1].close : null;
                if (ltpProxy !== null) {
                  const instrTick = getNseTickSize(ltpProxy);
                  if (isBullish && snappedCandelStop >= ltpProxy) {
                    snappedCandelStop = snapToNSETick(ltpProxy - instrTick, null, 'floor');
                    console.log(`${LOG} [CANDLE] ${pick.symbol}: tighten nudged to ₹${snappedCandelStop} (was ≥ LTP proxy ₹${ltpProxy}, tick=${instrTick})`);
                  } else if (!isBullish && snappedCandelStop <= ltpProxy) {
                    snappedCandelStop = snapToNSETick(ltpProxy + instrTick, null, 'ceil');
                    console.log(`${LOG} [CANDLE] ${pick.symbol}: tighten nudged to ₹${snappedCandelStop} (was ≤ LTP proxy ₹${ltpProxy}, tick=${instrTick})`);
                  }
                }

                try {
                  // SL-M modify: trigger only (see 2026-05-25 incident).
                  await kiteOrderService.modifyOrder(pick.kite.stop_order_id, {
                    trigger_price: snappedCandelStop,
                  });
                  if (!pick.trailing_history) pick.trailing_history = [];
                  pick.trailing_history.push({
                    timestamp:      new Date(),
                    old_stop:       currentStop,
                    new_stop:       snappedCandelStop,
                    price_at_trail: sym5m.length > 0 ? sym5m[sym5m.length - 1].close : null,
                    reason:         `candle_${decision.action}`,
                  });
                  pick.levels.stop = snappedCandelStop;
                  statusChanged = true;
                  console.log(`${LOG} [CANDLE] ${pick.symbol}: Stop ₹${currentStop} → ₹${snappedCandelStop} [${decision.action}] — ${decision.reason}`);
                } catch (err) {
                  const isTriggerVsLtpError  = /lower than the last traded price|higher than the last traded price/i.test(err.message);
                  const isBeingProcessed     = /being processed/i.test(err.message);

                  if (isTriggerVsLtpError) {
                    // ltpProxy (candle close) was stale — actual LTP moved past our snapped stop.
                    // Existing SL stays active at its current trigger; retry next cycle.
                    console.warn(
                      `${LOG} [CANDLE] ${pick.symbol}: modifyOrder skipped — ` +
                      `trigger ₹${snappedCandelStop} crossed real-time LTP (proxy was stale). ` +
                      `Existing SL @ ₹${currentStop} remains active.`
                    );
                  } else if (isBeingProcessed) {
                    // Order is transitioning to REJECTED in the exchange — modifyOrder is impossible.
                    // Cancel the old order first (guards against it somehow ending up OPEN with a
                    // second fresh order → double-fill → naked short). Cancel will throw if the order
                    // is already in a terminal state (REJECTED/CANCELLED) — that's fine, we ignore it.
                    const deadId = pick.kite.stop_order_id;
                    console.warn(
                      `${LOG} [CANDLE] ${pick.symbol}: modifyOrder → "being processed" on ` +
                      `${deadId} (likely exchange-REJECTED). ` +
                      `Attempting cancel of dead order before placing fresh SL-M @ ₹${snappedCandelStop}.`
                    );
                    try {
                      await kiteOrderService.cancelOrder(deadId);
                      console.log(`${LOG} [CANDLE] ${pick.symbol}: Cancelled dead order ${deadId}`);
                    } catch (cancelErr) {
                      // Expected if already REJECTED/terminal — safe to proceed
                      console.log(`${LOG} [CANDLE] ${pick.symbol}: Cancel of ${deadId} failed (likely already terminal): ${cancelErr.message}`);
                    }
                    pick.kite.stop_order_id = null;
                    if (!dryRun) {
                      try {
                        const freshResult = await kiteOrderService.placeOrder({
                          tradingsymbol:    pick.symbol,
                          exchange:         'NSE',
                          transaction_type: isBullish ? 'SELL' : 'BUY',
                          order_type:       'SL-M',
                          trigger_price:    snappedCandelStop,
                          product:          'MIS',
                          quantity:         pick.trade.qty,
                          simulationId:     `daily_pick_sl_candle_fresh_${pick.symbol}`,
                          orderType:        'STOP_LOSS',
                          source:           'DAILY_PICKS',
                        });
                        if (freshResult.success) {
                          pick.kite.stop_order_id = freshResult.orderId;
                          pick.levels.stop        = snappedCandelStop;
                          statusChanged = true;
                          console.log(
                            `${LOG} [CANDLE] ✅ ${pick.symbol}: Fresh SL-M placed @ ₹${snappedCandelStop} ` +
                            `— orderId=${freshResult.orderId} [${decision.action}]`
                          );
                        }
                      } catch (freshErr) {
                        console.error(`${LOG} [CANDLE] ${pick.symbol}: fresh SL-M place failed:`, freshErr.message);
                      }
                    }
                  } else {
                    console.error(`${LOG} [CANDLE] ${pick.symbol}: modifyOrder failed:`, err.message);
                  }
                }
              }
            } else {
              // No SL order in Kite — place a fresh SL-M to protect this position going forward
              const freshSlTrigger = snapToNSETick(decision.newStop, null, isBullish ? 'floor' : 'ceil');
              console.log(`${LOG} [CANDLE] ${pick.symbol}: No SL order — placing fresh SL-M @ ₹${freshSlTrigger} [${decision.action}]`);
              try {
                const slSide   = pick.direction === 'LONG' ? 'SELL' : 'BUY';
                const slResult = await kiteOrderService.placeOrder({
                  tradingsymbol:    pick.symbol,
                  exchange:         'NSE',
                  transaction_type: slSide,
                  order_type:       'SL-M',
                  trigger_price:    freshSlTrigger,
                  product:          'MIS',
                  quantity:         pick.trade.qty,
                  simulationId:     `daily_pick_candle_slm_${pick.symbol}`,
                  orderType:        'CANDLE_SL_PLACE',
                  source:           'DAILY_PICKS',
                });
                if (slResult.success) {
                  pick.kite.stop_order_id = slResult.orderId;
                  if (!pick.trailing_history) pick.trailing_history = [];
                  pick.trailing_history.push({
                    timestamp:      new Date(),
                    old_stop:       currentStop,
                    new_stop:       freshSlTrigger,
                    price_at_trail: sym5m.length > 0 ? sym5m[sym5m.length - 1].close : null,
                    reason:         `candle_${decision.action}_fresh_slm`,
                  });
                  pick.levels.stop = freshSlTrigger;
                  statusChanged = true;
                  console.log(`${LOG} [CANDLE] ✅ ${pick.symbol}: Fresh SL-M placed @ ₹${freshSlTrigger} [${decision.action}] — orderId=${slResult.orderId}`);
                }
              } catch (err) {
                console.error(`${LOG} [CANDLE] ${pick.symbol}: Fresh SL-M placement failed:`, err.message);
                // Fallback — at least update level in DB so 3 PM exit uses the tighter stop
                pick.levels.stop = freshSlTrigger;
                statusChanged = true;
                console.warn(`${LOG} [CANDLE] ${pick.symbol}: Fallback — stop level updated to ₹${freshSlTrigger} in DB (SL-M placement failed)`);
              }
            }
          }
        }
        // 'hold' → no action
      }
    } catch (err) {
      console.error(`${LOG} [CANDLE] Candle analysis failed:`, err.message);
    }
  }

  if (statusChanged) {
    updateDailyResults(doc);
    // Persist all in-flight state changes per pick atomically.
    // Using updateOne + positional $ prevents VersionError if the fill listener or
    // another monitor cycle runs concurrently on the same document.
    // Fields covered: all terminal exit fields, trailing/partial in-flight mutations.
    let saveFailed = false;
    for (const pick of enteredPicks) {
      try {
        await DailyPick.updateOne(
          { _id: doc._id, 'picks.symbol': pick.symbol },
          {
            $set: {
              'picks.$.trade.status':           pick.trade.status,
              'picks.$.trade.qty':              pick.trade.qty ?? null,
              'picks.$.trade.exit_price':       pick.trade.exit_price ?? null,
              'picks.$.trade.exit_time':        pick.trade.exit_time ?? null,
              'picks.$.trade.exit_reason':      pick.trade.exit_reason ?? null,
              'picks.$.trade.exit_price_source':pick.trade.exit_price_source ?? null,
              'picks.$.trade.pnl':              pick.trade.pnl ?? null,
              'picks.$.trade.return_pct':       pick.trade.return_pct ?? null,
              'picks.$.trade.partial_exit_qty': pick.trade.partial_exit_qty ?? null,
              'picks.$.trade.partial_exit_price':pick.trade.partial_exit_price ?? null,
              'picks.$.kite.kite_status':       pick.kite.kite_status,
              'picks.$.kite.stop_order_id':     pick.kite.stop_order_id ?? null,   // persist fresh SL-M placements
              'picks.$.levels.stop':            pick.levels.stop ?? null,
              'picks.$.levels.target':          pick.levels.target ?? null,
              'picks.$.trailing_history':       pick.trailing_history ?? [],
              'picks.$._breakeven_moved':       pick._breakeven_moved ?? false,
              'picks.$._partial_booked':        pick._partial_booked ?? false,
              'picks.$._extreme_price':         pick._extreme_price ?? null,
            }
          }
        );
      } catch (dbErr) {
        saveFailed = true;
        console.error(`${LOG} ⚠️ CRITICAL: updateOne failed for ${pick.symbol} in monitor: ${dbErr.message}`);
      }
    }
    if (saveFailed) {
      try {
        await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
          'CRITICAL: Trade State Save Failed',
          `Monitor detected changes but one or more DB writes failed. Check logs.`,
          { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
        );
      } catch (_) { /* ignore */ }
    } else {
      console.log(`${LOG} Updated results after status changes`);
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

// tightenStops() removed — breakeven is handled inline in the monitor loop
// via the +1R gate (profitR >= 1.0 → move stop to entry price). No separate
// time-based cron needed.

/* istanbul ignore next — kept as dead code reference, not exported
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
          // SL-M modify: trigger only (see 2026-05-25 incident).
          await kiteOrderService.modifyOrder(pick.kite.stop_order_id, {
            trigger_price: newStop,
          });

          const trailEntry = {
            timestamp: new Date(),
            old_stop: currentStop,
            new_stop: newStop,
            price_at_trail: currentPrice,
            reason: 'tighten_2pm',
          };

          try {
            await DailyPick.updateOne(
              { _id: doc._id, 'picks.symbol': pick.symbol },
              {
                $set:  { 'picks.$.levels.stop': newStop },
                $push: { 'picks.$.trailing_history': trailEntry },
              }
            );
            tightened++;
            console.log(`${LOG} ${pick.symbol}: Stop tightened to breakeven ₹${newStop} (was ₹${currentStop}, profit=${round2(profitPct)}%)`);
          } catch (dbErr) {
            console.error(`${LOG} ${pick.symbol}: DB update failed after tightening:`, dbErr.message);
          }
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

  console.log(`${LOG} Tightened ${tightened}/${enteredPicks.length} stops to breakeven`);
  return { success: true, tightened };
}
*/

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
  detectCandlePattern,
  selectDiversePicks,
  getStockSector,
  MAX_DAILY_PICKS
};