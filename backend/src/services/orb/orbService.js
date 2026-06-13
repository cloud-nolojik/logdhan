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
import OrbBaseline from '../../models/orbBaseline.js';
import OrbPipelineLog from '../../models/orbPipelineLog.js';
import MarketHoursUtil from '../../utils/marketHours.js';
import { getFnoSymbols } from '../../constants/fnoUniverse.js';
import { analyzeIntradayStructure, checkSidewaysExit } from '../dailyPicks/tradingDecisions.js';
import { computeVwap, evaluateVwapExit } from '../dailyPicks/dailyPicksService.js';

const LOG = '[ORB]';

// ── Strategy constants ──────────────────────────────────────────────────────
// 2026-06-05: Dropped from 16 → 8. With ₹45k cash × 5x MIS leverage = ₹225k
// buying power × 90% allocation = ₹202k, divided by 16 slots = ₹12.6k/trade.
// Dropping to 8 gives ₹25k/trade → meaningful position sizing, less brokerage
// drag from forcing borderline picks just to fill 16 slots. ORB-style days
// rarely produce 8 high-quality A+ setups, let alone 16.
const MAX_ENTRIES           = 8;      // max TRADES per day (cumulative, LONG + SHORT
                                      // combined). Enforced on doc.entriesCount, not the
                                      // live ENTERED count — a stopped-out slot is NOT
                                      // reused, so a choppy day cannot exceed this.
// 2026-06-04: pace entries instead of dumping all 5 in the first scan. Cap how many
// can be entered in any single scan, so the daily budget spreads across the morning
// (10:01 → ~11:46) — the high-edge window — instead of front-loading at 10:01 and
// then going dark. Research: ORB edge is concentrated in the first ~90 min; midday
// is chop. Tunable.
const MAX_ENTRIES_PER_SCAN  = 2;
// TIER-1 changes (2026-05-26 evening):
// • No pre-open gap filter. ALL F&O stocks are candidates.
// • Direction (LONG/SHORT) is decided at the OR-break moment, not at 9:08.
// • MAX_CANDIDATES is now an upper bound for safety; in practice we save all
//   ~215 F&O symbols that returned valid OHLC.
const MAX_CANDIDATES        = 250;
// (MIN_OR_RANGE_PCT removed 2026-06-03 — OR-width filter dropped entirely.)
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
// 2026-06-02: decouple 1R from the OR boundary. The OR-edge stop can create an
// oversized risk when we fill extended past the OR (entry is ≥MIN_DISTANCE_PCT past
// it), which blunts the +1R breakeven trail and the 40-min cut. MAX_SL_PCT caps the
// stop distance to a fixed % of entry, so 1R is bounded regardless of extension.
// Tunable — value should be confirmed in the backtest harness.
const MAX_SL_PCT            = 1.5;
// 15-min bars in a 09:15–15:30 session (375 min / 15). Used to derive a per-bar
// volume baseline for RVOL = breakout-candle volume ÷ (avg daily volume / this).
const BARS_PER_DAY         = 25;
// Volume-confirmation entry gate (2026-06-02): the breakout candle must trade at
// least this multiple of its time-matched slot-average volume to be eligible. Set
// MILD (1.1× = "at least a normal-volume candle for that slot") so it filters only
// thin, no-participation breakouts without starving the (already heavily-gated)
// funnel. Tunable — the exact value is a backtest question. RVOL is the gate now;
// it is NOT also in the ranking score (no double-count).
const RVOL_ENTRY_MIN       = 1.1;

// ── 2026-06-11 — 09:21 in-play RVOL snapshot ("stocks in play") ─────────────
// Zarattini/Barbon/Aziz (SSRN 4729284): ORB on ALL stocks ≈ 3.2%/yr; ORB on the
// top-20 by OPENING relative volume ≈ 41.6%/yr — the edge is in selection, not
// the pattern. This snapshot ranks the whole F&O universe by first-minutes RVOL
// at 09:21 and marks only the top names inPlay; Phase 2 then sets ranges ONLY
// for those (side effect: per-scan candle fetches drop ~215 → ~20, easing 429s).
//
// Measurement: ONE batched /quote call at 09:21 → day-cumulative volume (≈ first
// 6 min of trading) ÷ (volumeProfile['09:15'] × RVOL5_BASELINE_FRACTION). The
// window is identical for every symbol, so the RANKING is exact even though the
// absolute scale leans on the fraction estimate. FRACTION=0.55: opening volume
// is front-loaded, so the first ~6 min of the 09:15–09:30 slot normally carries
// ~55% of that slot's volume (estimate — calibrate from archived 1-min candles).
const RVOL5_TOP_N             = 20;    // max names marked in-play
const RVOL5_MIN               = 1.0;   // floor — paper spec exactly: RVOL ≥ 100% (was 1.5 pre-paper-mode)
const RVOL5_BASELINE_FRACTION = 0.55;  // share of the 09:15 slot traded by ~09:21
const RVOL5_MIN_QUALIFIED     = 5;     // if fewer clear the floor → fallback selection
const RVOL5_FALLBACK_N        = 10;    // fallback: top-10 by rvol5 regardless of floor

// ── 2026-06-11 — PAPER MODE (Zarattini/Barbon/Aziz, SSRN 4729284) ───────────
// Live cutover to the paper's exact entry/stop/exit spec, per design discussion:
//   • OR = first 5-min candle (09:15–09:20), per stock
//   • Direction = that candle's close vs open (bullish→LONG only, bearish→SHORT
//     only, doji→skip). NO index/regime gate — the paper has none.
//   • Entry = resting SL-M order AT the OR edge (distance ≈ 0, no close-confirm,
//     no 1% floor), placed ~09:24, live until the 15:00 unfilled-cancel cutoff.
//   • Stop = 0.10 × daily ATR(14) from the actual fill price.
//   • Exits = stop hit or 15:15 force-exit ONLY. No target, no BE move, no RSI/
//     VWAP/structure/sideways exits (paper has none of these; with a 0.1×ATR
//     stop the BE cushion would sit WIDER than the stop itself).
//   • Sizing = min(risk-based: 1% of cash ÷ stopDistance, leverage cap: slot
//     capital ÷ price). Paper trades top-20; current capital funds 8 slots.
const PAPER_STOP_ATR_MULT    = 0.10;   // stop distance = 10% of daily ATR(14)
const PAPER_MIN_ATR14D       = 0.50;   // ₹ — paper FILTER 3 (ATR floor); stop must be ≥ 1 tick
const PAPER_RISK_PCT         = 1.0;    // % of cash risked per trade (paper: 1% of account)
const PAPER_MAX_ENTRIES      = 8;      // paper: top-20; leverage-capped to 8 slots at current capital
const PAPER_ENTRY_CUTOFF_MIN = 15 * 60; // 15:00 IST — cancel still-unfilled ARMED entries

// ── LEGACY ENGINE — RETIRED 2026-06-11 (full paper-spec cutover, no flags) ──
// The 15-min OR path (recordOpeningRanges), the 2-bar confirmation scan
// (checkBreakouts), the Nifty regime gate, BE-at-+1R, the 10:30 time-exit, and
// the entire candle/RSI/VWAP/sideways exit engine are PERMANENTLY dead-gated
// below by this constant. Per design decision: no runtime flags — the paper
// system is THE system. The legacy code bodies are kept (unreachable) purely
// for reference; the last live version is in git history.
const LEGACY_ENGINE = false;

// Entry window + confirmation — CONFIRM_BARS = how many completed 15-min candles
// must close past the OR (same direction) to confirm a breakout. Kept as a
// constant so a backtest can sweep 1 vs 2 (vs 0 = raw LTP-cross) without surgery.
//   • CONFIRM_BARS = 2 → breakout candle + 1 confirmation candle. First entry 10:01.
//   • CONFIRM_BARS = 1 → breakout candle alone (no 2nd-candle confirm). First entry 09:46.
// Set to 1 (2026-06-04, per design discussion): enter earlier and LESS EXTENDED — on
// the first 15-min candle that CLOSES past the OR (09:30–09:45 → checked 09:46),
// instead of waiting for a 2nd confirming candle (10:01). Rationale: June-4 losses
// were from buying the extended thrust; earlier entry catches the morning edge at a
// better price. A *close* past OR is still required (rejects wicks), and the RVOL
// gate + per-scan cap absorb the extra fakeout risk. NOT backtested — reversible.
// NOTE: BREAKOUT_START must track CONFIRM_BARS — earliest a confirm is possible is
// 09:30 + CONFIRM_BARS×15min, checked on the next :01/:16/:31/:46 boundary.
const CONFIRM_BARS          = 1;
const BREAKOUT_START_HOUR   = 9;
const BREAKOUT_START_MIN    = 46;     // breakout 09:30–09:45 closes 09:45 → first check 09:46
const BREAKOUT_END_HOUR     = 11;
const BREAKOUT_END_MIN      = 46;     // last entry 11:46 (2026-06-04: pulled in from 14:01 —
                                      // ORB edge is morning-concentrated; 11:30–14:00 is chop
                                      // with deteriorating win rate, so we stop taking new
                                      // entries before the dead zone). Tunable.
// OR-width filter REMOVED 2026-06-03 (MAX_OR_RANGE_PCT / OR_ADR_MIN / OR_ADR_MAX
// deleted). Too-wide was excluding the strongest gap-down momentum shorts (TCS −8%
// got skipped) and is covered by the 1.5% SL cap + VARS; too-tight is covered by the
// 1% distance floor + RVOL gate + VARS denominator clamp. adrPct is still computed at
// pre-open for observability/backtest, just no longer used to gate.

// ── 2026-05-29 evening — quality-of-pick filters ───────────────────────────
// Born from the day-4 analysis (2026-05-29). Two findings:
//
// 1. Distance% < 1.0% bucket had 0 winners out of 3 trades (-₹47 net):
//    RBLBANK (0.97%, -₹23), PRESTIGE (0.97%, -₹10), PNBHOUSING (0.88%, -₹14).
//    These were ranked #1, #2, #3 at 10:01 because slot order favors first-fired
//    signals, but distance% was weak. Floor at 1.0% drops these systematically.
//
// 2. Direction-bias: at 10:01 first scan, 25/30 (83%) of ranked confirmed
//    breakouts were SHORTS — clear bear-day signal. System took 6 LONGs anyway
//    (LODHA, YESBANK, PRESTIGE, JUBLFOOD, CAMS, ABFRL) and lost -₹176 on CAMS
//    and -₹81 on ABFRL fighting the tape. Locking direction to the dominant
//    side once it crosses 70% saves ~₹250 on bias-discordant LONGs.
const MIN_DISTANCE_PCT          = 1.0;   // skip breakouts with distance past OR < 1%
// (BIAS_GATE_* removed 2026-06-02 — breakout-breadth direction lock superseded by
//  the live Nifty regime gate.)

// ── 2026-06-05 evening — BE-only mode (Douglas, Bandy) ─────────────────────
// After 8 trades on 2026-06-05 (-₹417 net), data confirmed the candle-tighten
// engine was the dominant loss driver: 6/8 trades exited via candle-based
// trail/tighten within 5-20 minutes of entry, all at < 0.5R profit or losses.
// One winner (BAJFINANCE +₹40) gave up +₹42 of unrealised gain to a tighten.
//
// New rule (pure BE-only):
//   Phase 1 (entry → +1R):       original SL holds, no tightening
//   Phase 2 (at +1R, one-time):  SL moves to entry ± max(0.3% × entry, 0.5 × ATR_5min)
//                                — small cushion prevents "₹0 PnL" stops on noise
//   Phase 3 (after +1R):         DO NOTHING. SL holds at cushioned-BE.
//   Phase 4 (15:15):             force exit anything still open
//
// The candle-analysis 'exit' branch (confirmed 2-bar 15-min structure break)
// STAYS active — that's a legitimate structural exit, not a "tighten."
// Trail/tighten decisions from analyzeIntradayStructure are now ignored.
const BE_CUSHION_PCT      = 0.3;   // floor: SL stays ≥ 0.3% from entry
const BE_CUSHION_ATR_MULT = 0.5;   // ATR-adaptive: SL stays ≥ 0.5 × ATR(5m,14) from entry

// ── 2026-06-05 evening (later) — RSI-exhaustion exit + SL freeze ──────────
// User feedback after the BE-only ship: "LTF still booked ₹0. RSI on the 5-min
// chart closed ≥80 right at the top — couldn't we exit there?"
//
// New rule:
//   1. [RETIRED 2026-06-11 with the paper-spec cutover — this whole RSI engine
//      is dead-gated by LEGACY_ENGINE. Paper exits: stop-hit or 15:15 only.]
//      Original 2026-06-05 rule: OR-based SL holds for the entire trade. No BE
//      move, no tightening, no candle-based trail; SL untouched until either
//      the RSI-exhaustion exit fires OR the 15:15 force-exit runs.
//   2. Each monitor cycle, compute 5-min RSI(14) + 14-period SMA on the RSI.
//      If RSI has EVER closed ≥80 in available history (armed) AND the latest
//      RSI is BOTH below 70 AND below its MA → fire a MARKET EXIT (not a SL
//      modify). Mirror for SHORT (RSI ≤20 arm, RSI >30 and >MA → exit).
//   3. The candle-analysis 'exit' branch (confirmed 2-bar 15-min structure
//      break) STAYS active as a separate exit path.
//
// The dual-condition gate prevents whipsaw: a bare RSI<MA cross fires only
// after the move has been stretched (RSI peaked past the extreme). This
// preserves the BAJFINANCE/POWERGRID-style runner case while catching the
// LTF-style "spike + rollover" case.
const RSI_PERIOD          = 14;
const RSI_MA_PERIOD       = 14;
const RSI_OVERBOUGHT      = 80;    // LONG arm threshold
const RSI_OVERSOLD        = 20;    // SHORT arm threshold
const RSI_NEUTRAL_HIGH    = 70;    // LONG exit condA: lastRSI < this
const RSI_NEUTRAL_LOW     = 30;    // SHORT exit condA: lastRSI > this

// ── 10:30 TIME EXIT — DISABLED 2026-05-25 (evening) ───────────────────────
// Hardcoded 10:30 AM force-exit was killing winners. On 2026-05-25:
//   CANBK time-exited at +0.82% (₹132.58); ran to +1.6% (₹134.09 high) later.
//   INOXWIND time-exited at +0.65% (₹97.94); was still breaking out.
// Winners now ride to either target hit, candle-structure tighten exit, or
// the 15:15 force-exit. Losers still get caught by SL (which trail logic
// tightens on bearish reversal candles via analyzeIntradayStructure).
// (2026-06-11: env toggle removed — dead-gated by LEGACY_ENGINE, see monitor.)
const TIME_EXIT_HOUR        = 10;
const TIME_EXIT_MIN         = 30;     // (kept as constants — gated by env at usage site)

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pipeline stage trail (2026-06-11): one row per stage event in
 * orb_pipeline_log, so "what ran / what failed / why" for any day is a single
 * query: db.orb_pipeline_log.find({dateKey:'YYYY-MM-DD'}).sort({t:1}).
 * Mirrors to console with a grep-able [STAGE] tag. BEST-EFFORT — a logging
 * failure must never take a trading stage down with it.
 */
async function logStage(stage, ok, detail = undefined) {
  const tag = ok ? '✅' : '❌';
  console.log(`${LOG} [STAGE] ${tag} ${stage}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  try {
    const istNow  = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const dateKey = istNow.toISOString().slice(0, 10);
    await OrbPipelineLog.create({ t: new Date(), dateKey, stage, ok, detail });
  } catch (err) {
    console.warn(`${LOG} [STAGE] trail write failed (${err.message}) — console log above is the record`);
  }
}

function snapToNSETick(price, tick = 0.05, mode = 'round') {
  const factor = Math.round(1 / tick);
  if (mode === 'floor') return Math.floor(price * factor) / factor;
  if (mode === 'ceil')  return Math.ceil(price  * factor) / factor;
  return Math.round(price * factor) / factor;
}

function parseKiteTickError(err) {
  // 2026-05-27: bug found via ABB SL placement. Kite's actual error message
  // lives in error.response.data.message (the axios response body), NOT in
  // error.message (which is just "Request failed with status code 400").
  // Our previous parser was searching .message and never finding the tick.
  //
  // This function now accepts either a string OR an Error/axios-error object
  // and digs into the right places. It also supports a few message formats
  // because Kite/NSE can phrase it slightly differently:
  //   "Tick size for this script is 0.50. Kindly enter trigger price..."
  //   "tick size is 0.10"
  //   "must be a multiple of 0.05"
  // Returns the tick size as a positive float, or null if no match.
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
      if (tick > 0 && tick <= 10) return tick;   // sanity guard
    }
  }
  return null;
}

const delay = ms => new Promise(r => setTimeout(r, ms));

/**
 * Pure stop-loss computation for an ORB entry. Returns the TIGHTER of:
 *   • OR-edge stop: breakout level ∓ min(SL_BUFFER_PCT% , OR range)
 *   • risk-cap stop: entry ∓ MAX_SL_PCT% (bounds 1R no matter how extended the fill)
 * "Tighter" = closer to entry (higher for LONG, lower for SHORT). This keeps 1R
 * bounded so the BE-trail and 40-min sideways cut engage at predictable points.
 * Pure + exported for unit testing.
 */
export function computeOrbStop({ isLong, orHigh, orLow, orRange, entry }) {
  const breakoutLevel = isLong ? orHigh : orLow;
  const targetBuffer  = breakoutLevel * (SL_BUFFER_PCT / 100);
  const effectiveBuf  = Math.min(targetBuffer, orRange);
  const orStop  = isLong
    ? snapToNSETick(orHigh - effectiveBuf, 0.05, 'floor')
    : snapToNSETick(orLow  + effectiveBuf, 0.05, 'ceil');
  const capStop = isLong
    ? snapToNSETick(entry * (1 - MAX_SL_PCT / 100), 0.05, 'floor')
    : snapToNSETick(entry * (1 + MAX_SL_PCT / 100), 0.05, 'ceil');
  // Pick the stop closer to entry: LONG → higher (max); SHORT → lower (min).
  const stop = isLong ? Math.max(orStop, capStop) : Math.min(orStop, capStop);
  const cappedByRisk = isLong ? (capStop > orStop) : (capStop < orStop);
  return { stop, orStop, capStop, effectiveBuf, source: cappedByRisk ? `risk-cap ${MAX_SL_PCT}%` : 'OR-edge' };
}

/**
 * Time-of-day slot key for a 15-min candle: 'HH:MM' of the bar's start, in IST.
 * Kite returns candle timestamps as ISO strings with the +0530 offset, so we read
 * HH:MM directly off the string (NOT via Date(), which would convert to UTC and
 * shift the slot by 5h30m). Returns null if no time can be parsed.
 */
export function slotKey(dateLike) {
  const s = typeof dateLike === 'string' ? dateLike : String(dateLike ?? '');
  const m = s.match(/(\d{2}:\d{2}):\d{2}/);
  return m ? m[1] : null;
}

/**
 * Is an N-min candle (start = dateLike's HH:MM in IST) fully closed at nowMin
 * (current IST minute-of-day)? Used to drop the still-FORMING 15-min candle from
 * the breakout fetch — Kite's intraday endpoint can return the just-started candle
 * (1 min of volume), which closes past OR fine but wrecks the RVOL ratio. Pure.
 */
export function isBarComplete(dateLike, nowMin, intervalMin = 15) {
  const sk = slotKey(dateLike);
  if (!sk) return false;
  const [h, m] = sk.split(':').map(Number);
  return (h * 60 + m + intervalMin) <= nowMin;
}

/**
 * Build a per-slot average-volume profile from historical 15-min bars (≈20 days):
 *   { '09:15': avgVol, '09:30': avgVol, … } — the average volume for each 15-min
 * slot-of-day. This is the time-matched RVOL baseline: a breakout candle is judged
 * against a *normal* candle for that same time of day, not a flat daily average
 * (intraday volume is U-shaped, so a flat baseline over/under-states by time).
 * Pure + exported for testing.
 */
export function buildVolumeProfile(bars) {
  const acc = {};
  for (const b of bars || []) {
    if (!Number.isFinite(b?.volume) || b.volume <= 0) continue;
    const slot = slotKey(b.date);
    if (!slot) continue;
    if (!acc[slot]) acc[slot] = { sum: 0, n: 0 };
    acc[slot].sum += b.volume;
    acc[slot].n   += 1;
  }
  const profile = {};
  for (const [slot, { sum, n }] of Object.entries(acc)) profile[slot] = Math.round(sum / n);
  return profile;
}

/**
 * Average Daily Range as a % of price, from historical intraday bars (≈20 days).
 * Groups bars by calendar day, takes each day's (high − low), averages them, and
 * expresses it as a % of refPrice. Used to volatility-normalise the OR-width filter
 * (OR width ÷ ADR) so the gate adapts to each stock instead of a fixed % band.
 * Returns null if there's no usable data. Pure + exported for testing.
 */
/**
 * computeATR(bars, period=14)
 * True-range average over the last `period` bars. Used by computeBeStop() to
 * size the BE cushion adaptively for high-vol stocks where a flat 0.3% is too
 * tight. Standard Wilder TR: max(high-low, |high-prevClose|, |low-prevClose|).
 * Returns 0 if insufficient data (caller should fall back to pct cushion only).
 */
export function computeATR(bars, period = 14) {
  if (!bars || bars.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    if (!Number.isFinite(b?.high) || !Number.isFinite(b?.low) || !Number.isFinite(p?.close)) continue;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    trs.push(tr);
  }
  const window = trs.slice(-period);
  if (!window.length) return 0;
  return window.reduce((s, x) => s + x, 0) / window.length;
}

/**
 * computeBeStop({ entry, isLong, atr5m })
 * Pure helper for the breakeven trail.
 *
 * Background (2026-06-05): the prior "BE = entry exactly" rule was killing
 * trades on normal intra-bar noise. Example: LTF entered ₹275.80, BE moved
 * SL to ₹275.80, hit at ₹275.80 for ₹0 — gave up 30+ paise of upside the
 * trade was already showing. The cushion gives the trade breathing room
 * while still locking in essentially-zero risk.
 *
 * Cushion size: max(BE_CUSHION_PCT × entry, BE_CUSHION_ATR_MULT × atr5m)
 *   - pct floor (0.3%) covers tight-ranged stocks where ATR is misleading
 *   - ATR multiplier (0.5×) gives more room on volatile stocks
 *
 * LONG  → returns entry − cushion (SL below entry)
 * SHORT → returns entry + cushion (SL above entry)
 *
 * @param {Object} p
 * @param {number} p.entry  — actual fill price
 * @param {boolean} p.isLong
 * @param {number} [p.atr5m=0] — ATR of last 14 × 5-min bars. 0 → pct-only fallback.
 */
export function computeBeStop({ entry, isLong, atr5m = 0 }) {
  const pctCushion = entry * (BE_CUSHION_PCT / 100);
  const atrCushion = (atr5m || 0) * BE_CUSHION_ATR_MULT;
  const cushion    = Math.max(pctCushion, atrCushion);
  return isLong ? entry - cushion : entry + cushion;
}

/**
 * computeRSI(closes, period=14)
 *
 * Wilder's smoothed RSI. Returns an array same length as `closes` with NaN for
 * positions before the period is satisfied. Used for the RSI-exhaustion exit
 * (2026-06-05 evening — LTF chart analysis showed clear RSI≥80 + cross-below-MA
 * top signal that the BE-only freeze could not capture).
 *
 *   RS  = avgGain / avgLoss   (Wilder smoothing: new = ((n-1)*prev + curr) / n)
 *   RSI = 100 - 100 / (1 + RS)
 *
 * Edge cases:
 *   - closes.length < period+1 → returns []
 *   - avgLoss === 0 (pure uptrend) → RSI = 100
 *   - non-finite diff → contributes 0
 */
export function computeRSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return [];
  const result = new Array(closes.length).fill(NaN);
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (!Number.isFinite(diff)) continue;
    if (diff > 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = Number.isFinite(diff) && diff > 0 ?  diff : 0;
    const loss = Number.isFinite(diff) && diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

/**
 * computeSMA(values, period)
 * Simple moving average. Returns array same length as input with NaN before
 * period is satisfied. Skips non-finite values gracefully.
 */
export function computeSMA(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return [];
  const result = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0, n = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (Number.isFinite(values[j])) {
        sum += values[j];
        n++;
      }
    }
    if (n === period) result[i] = sum / period;
  }
  return result;
}

/**
 * decideRsiExhaustionExit({ closes, isLong })
 *
 * Pure dual-condition exhaustion-exit decision for an open ORB position.
 *
 * 2026-06-05 evening: born from LTF chart analysis. LTF entered ₹275.80,
 * 5-min RSI(14) peaked ≥80 at the ₹277 top, then drifted back to ₹270 over
 * the next hour while the BE-only stop sat at the original OR-based level.
 * Closing the trade on the RSI rollover would have captured most of the
 * profit instead of zero.
 *
 * Logic:
 *   ARM:  has RSI ever closed ≥OVERBOUGHT (LONG) / ≤OVERSOLD (SHORT) in the
 *         available history? (We use the available bars since entry won't
 *         appear in 5-min history at the bar level; ok, the typical session
 *         starts at 09:15 so this covers all relevant context.)
 *   FIRE: latest RSI is BOTH below NEUTRAL_HIGH (70) AND below RSI MA (LONG).
 *         (Mirror for SHORT.)
 *
 * Both conditions must be true. This filters the bulk of "RSI crosses MA back
 * and forth in chop" false signals — we only act on a cross AFTER we know the
 * move stretched.
 *
 * @returns {{ armed: boolean, exit: boolean, lastRsi?: number, lastMA?: number, reason: string }}
 */
export function decideRsiExhaustionExit({
  closes,
  isLong,
  period       = RSI_PERIOD,
  maPeriod     = RSI_MA_PERIOD,
  overbought   = RSI_OVERBOUGHT,
  oversold     = RSI_OVERSOLD,
  neutralHigh  = RSI_NEUTRAL_HIGH,
  neutralLow   = RSI_NEUTRAL_LOW,
}) {
  const rsiSeries = computeRSI(closes, period);
  if (!rsiSeries.length) {
    return { armed: false, exit: false, reason: 'insufficient closes for RSI' };
  }
  const finiteRsis = rsiSeries.filter(Number.isFinite);
  if (finiteRsis.length < maPeriod) {
    return { armed: false, exit: false, reason: `only ${finiteRsis.length} finite RSI values, need ≥${maPeriod} for MA` };
  }
  const rsiMA = computeSMA(rsiSeries, maPeriod);

  const armed = isLong
    ? rsiSeries.some(r => Number.isFinite(r) && r >= overbought)
    : rsiSeries.some(r => Number.isFinite(r) && r <= oversold);
  if (!armed) {
    return {
      armed: false,
      exit:  false,
      reason: `not armed — RSI never reached ${isLong ? '≥' + overbought : '≤' + oversold}`,
    };
  }

  const lastRsi = rsiSeries[rsiSeries.length - 1];
  const lastMA  = rsiMA[rsiMA.length - 1];
  if (!Number.isFinite(lastRsi) || !Number.isFinite(lastMA)) {
    return { armed: true, exit: false, reason: 'armed but last RSI/MA non-finite' };
  }

  const condA  = isLong ? lastRsi < neutralHigh : lastRsi > neutralLow;
  const condB  = isLong ? lastRsi < lastMA      : lastRsi > lastMA;
  const exit   = condA && condB;

  return {
    armed: true,
    exit,
    lastRsi,
    lastMA,
    reason: exit
      ? `armed (RSI peaked past extreme) + RSI ${lastRsi.toFixed(1)} ${isLong ? 'below' : 'above'} ${isLong ? neutralHigh : neutralLow} AND ${isLong ? 'below' : 'above'} MA ${lastMA.toFixed(1)} → EXIT`
      : `armed but ${!condA ? `RSI ${lastRsi.toFixed(1)} still ${isLong ? '≥' + neutralHigh : '≤' + neutralLow}` : `RSI ${lastRsi.toFixed(1)} still on right side of MA ${lastMA.toFixed(1)}`} — hold`,
  };
}

export function computeADRPct(bars, refPrice) {
  if (!refPrice || refPrice <= 0) return null;
  const byDay = {};
  for (const b of bars || []) {
    if (!Number.isFinite(b?.high) || !Number.isFinite(b?.low)) continue;
    const day = typeof b.date === 'string' ? b.date.slice(0, 10) : null;
    if (!day) continue;
    if (!byDay[day]) byDay[day] = { hi: -Infinity, lo: Infinity };
    byDay[day].hi = Math.max(byDay[day].hi, b.high);
    byDay[day].lo = Math.min(byDay[day].lo, b.low);
  }
  const ranges = Object.values(byDay).map(d => d.hi - d.lo).filter(r => Number.isFinite(r) && r > 0);
  if (!ranges.length) return null;
  const adr = ranges.reduce((a, r) => a + r, 0) / ranges.length;
  return parseFloat((adr / refPrice * 100).toFixed(3));
}

/**
 * Fetch ≈20 days of 15-min candles for the given candidates and attach the RVOL
 * volume profile + avgDailyVolume + ADR%. Best-effort (throws are caught by the
 * caller). Returns the count that got a profile. Used at pre-open AND as a one-time
 * lazy retry in checkBreakouts so a single 09:08 fetch hiccup doesn't forfeit the day.
 */
/**
 * Guard for the lazy RVOL-baseline retry: true only when we haven't retried yet AND
 * *every* candidate is missing avgDailyVolume (i.e. the whole 09:08 fetch failed — a
 * partial result means Kite is reachable, so no retry). Pure + exported for testing.
 */
export function needsVolumeBaselineRetry(candidates, alreadyRetried) {
  if (alreadyRetried) return false;
  if (!candidates?.length) return false;
  return candidates.every(c => !(c.avgDailyVolume > 0));
}

// Cache validity window — covers weekends/long holidays (Friday-evening compute
// must still be valid on Monday/Tuesday morning).
const BASELINE_MAX_AGE_DAYS = 5;

/**
 * Fetch ≈20 trading days of 15-min bars for `symbols` (through `toD`) and build
 * per-symbol { volumeProfile, avgDailyVolume, adrRefBars }. Shared by the
 * evening prefetch (toD = today, session complete) and the morning live
 * fallback (toD = yesterday). Best-effort: missing symbols simply absent.
 */
async function fetchBaselineData(symbols, toD, logTag, paceOpts = undefined) {
  const fromD = new Date(toD); fromD.setDate(fromD.getDate() - 30);   // ~20 trading days
  const fmt   = d => d.toISOString().slice(0, 10);
  const hist  = await kiteOrderService.getHistoricalCandles(symbols, '15minute', `${fmt(fromD)} 09:15:00`, `${fmt(toD)} 15:30:00`, paceOpts);
  const out = {};
  for (const sym of symbols) {
    const bars    = hist[sym] || [];
    const profile = buildVolumeProfile(bars);
    const slots   = Object.values(profile);
    if (!slots.length) continue;
    out[sym] = {
      volumeProfile:  profile,
      avgDailyVolume: slots.reduce((a, v) => a + v, 0),
      bars,                                                   // for ADR%
      lastClose: bars.length ? bars[bars.length - 1].close : null,
    };
  }
  console.log(`${LOG} ${logTag} baseline build: profiles for ${Object.keys(out).length}/${symbols.length} symbols`);
  return out;
}

/**
 * BASELINE PREFETCH (08:30 IST) — compute baselines for the FULL F&O universe and
 * upsert into orb_baselines. Runs in the pre-market idle window (45 min before
 * the 09:08 pre-open job), so the ~215 historical calls that used to burst at
 * 09:08 (the known 429 hotspot, now load-bearing for the whole paper pipeline)
 * happen with zero rate contention — and with no dependency on the server having
 * been up the previous evening.
 *
 * Window is TIME-AWARE: "through the last COMPLETED session" — before 15:30 IST
 * that's yesterday (today is in progress / not started); after close it's today.
 * So the job produces correct data whenever it is run, including manual triggers.
 */
export async function prefetchVolumeBaselines() {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} ═══ BASELINE PREFETCH [${istTimeStr()}] ═══`);
  console.log(`${LOG} ════════════════════════════════════════`);

  const symbols = await getFnoSymbols();   // async! (caught in dry-run review — without await this was always "empty")
  if (!symbols?.length) {
    console.warn(`${LOG} [BASELINE] ⚠️  empty F&O universe — nothing to prefetch`);
    await logStage('prefetch', false, 'empty_universe');
    return { success: false, reason: 'empty_universe' };
  }

  // Last completed session: before today's 15:30 close → yesterday; after → today.
  const istNowD = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const toD     = new Date(istNowD);
  if (istNowD.getHours() * 60 + istNowD.getMinutes() < 15 * 60 + 30) {
    toD.setDate(toD.getDate() - 1);
  }
  console.log(`${LOG} [BASELINE] window through last completed session: ${toD.toISOString().slice(0, 10)}`);
  let data;
  try {
    // Deliberately UNDER Kite's documented 3 req/s historical limit: 2 concurrent
    // + 600ms gap ≈ 2.2–2.5 req/s → ~90s for the full universe, ZERO 429 churn.
    // (The default batch=3/400ms pacing overshoots to ~4-5 req/s and leans on the
    // makeRequest backoff to mop up — fine intraday where speed matters, wasteful
    // at 08:30 where time is free.) Reactive 3× exponential backoff in makeRequest
    // remains underneath as the safety net either way.
    data = await fetchBaselineData(symbols, toD, '[BASELINE]', { batch: 2, delayMs: 600 });
  } catch (err) {
    console.error(`${LOG} [BASELINE] ❌ fetch failed (${err.message}) — cache not updated (morning falls back to live fetch)`);
    await logStage('prefetch', false, { reason: 'fetch_failed', error: err.message });
    return { success: false, reason: 'fetch_failed' };
  }

  const now = new Date();
  const ops = Object.entries(data).map(([symbol, d]) => ({
    updateOne: {
      filter: { symbol },
      update: { $set: {
        symbol,
        volumeProfile:  d.volumeProfile,
        avgDailyVolume: d.avgDailyVolume,
        adrPct:         computeADRPct(d.bars, d.lastClose),
        lastClose:      d.lastClose,
        computedAt:     now,
      } },
      upsert: true,
    },
  }));
  if (ops.length) await OrbBaseline.bulkWrite(ops, { ordered: false });
  console.log(`${LOG} [BASELINE] ✅ upserted ${ops.length}/${symbols.length} baselines (computedAt=${now.toISOString()})`);
  await logStage('prefetch', ops.length >= symbols.length * 0.9, { upserted: ops.length, total: symbols.length });
  return { success: true, upserted: ops.length, total: symbols.length };
}

/**
 * Attach RVOL baselines to candidates — CACHE-FIRST (2026-06-11):
 *   1. Read orb_baselines (computedAt within BASELINE_MAX_AGE_DAYS) → instant,
 *      zero Kite calls for every cache hit.
 *   2. Live-fetch ONLY the misses (new F&O entrants / failed prefetch) through
 *      yesterday, and upsert those back into the cache.
 * If the evening prefetch ran, the 09:08 burst is ~0 historical calls instead
 * of ~215. If it didn't, behaviour degrades to exactly the old live fetch.
 */
async function attachVolumeBaselines(candidates, logTag = '[PHASE1]') {
  if (!candidates?.length) return 0;

  // 1) cache read
  const cached = {};
  try {
    const cutoff = new Date(Date.now() - BASELINE_MAX_AGE_DAYS * 86400000);
    const rows = await OrbBaseline.find({ computedAt: { $gte: cutoff } }).lean();
    for (const r of rows) cached[r.symbol] = r;
  } catch (err) {
    console.warn(`${LOG} ${logTag} baseline cache read failed (${err.message}) — falling back to live fetch for all`);
  }

  let fromCache = 0;
  const misses = [];
  for (const c of candidates) {
    const b = cached[c.symbol];
    if (b?.volumeProfile && b.avgDailyVolume > 0) {
      c.volumeProfile  = b.volumeProfile;
      c.avgDailyVolume = b.avgDailyVolume;
      c.adrPct         = b.adrPct;
      fromCache++;
    } else {
      misses.push(c);
    }
  }

  // 2) live fallback for misses only (through yesterday — today is in progress)
  let fromLive = 0;
  if (misses.length) {
    console.log(`${LOG} ${logTag} baseline cache: ${fromCache} hits, ${misses.length} misses — live-fetching misses`);
    try {
      const toD  = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      toD.setDate(toD.getDate() - 1);
      const data = await fetchBaselineData(misses.map(c => c.symbol), toD, logTag);
      const now  = new Date();
      const ops  = [];
      for (const c of misses) {
        const d = data[c.symbol];
        if (!d) continue;
        c.volumeProfile  = d.volumeProfile;
        c.avgDailyVolume = d.avgDailyVolume;
        c.adrPct         = computeADRPct(d.bars, c.iep ?? d.lastClose);
        fromLive++;
        ops.push({ updateOne: { filter: { symbol: c.symbol }, update: { $set: {
          symbol: c.symbol, volumeProfile: d.volumeProfile, avgDailyVolume: d.avgDailyVolume,
          adrPct: c.adrPct, lastClose: d.lastClose, computedAt: now,
        } }, upsert: true } });
      }
      if (ops.length) { try { await OrbBaseline.bulkWrite(ops, { ordered: false }); } catch (_) {} }
    } catch (err) {
      console.error(`${LOG} ${logTag} live baseline fallback failed: ${err.message}`);
    }
  }

  const withProfile = fromCache + fromLive;
  console.log(`${LOG} ${logTag} RVOL baseline: ${withProfile}/${candidates.length} symbols (cache=${fromCache}, live=${fromLive})`);
  return withProfile;
}

/**
 * Quality score for RANKING confirmed breakouts (higher = better pick). Combines:
 *   • VOLATILITY-ADJUSTED relative strength vs Nifty — relStrength (%) divided by the
 *     stock's OR width % (a same-day volatility proxy). Raw relative strength alone
 *     systematically picks the wildest movers, which reverse hardest ("momentum
 *     crash"); dividing by OR width ranks by risk-adjusted outperformance instead.
 *     Falls back to raw relStrength when orWidthPct is unavailable.
 *   • distance% past OR — PENALISED (extension ≈ closer to exhaustion).
 * NOTE (2026-06-02): RVOL is NOT in the score — it's a hard entry GATE
 * (RVOL_ENTRY_MIN, in decideBreakoutActions); having it in both would double-count.
 * Pure + exported for unit testing and reuse by the backtest harness.
 */
export function scoreCandidateQuality({ relStrength = 0, distancePct = 0, orWidthPct = null }, weights = {}) {
  const { wRs = 1.0, wDist = 0.4 } = weights;
  // Floor the denominator so a microscopic OR can't blow up the ratio and let one
  // tight-OR outlier dominate the ranking (orWidthPct 0.1 would 10× the relStrength).
  const volAdjRs = (orWidthPct && orWidthPct > 0) ? (relStrength / Math.max(orWidthPct, 0.5)) : relStrength;
  return (wRs * volAdjRs) - (wDist * Math.max(0, distancePct));
}

export function decideBreakoutActions({ confirmed, slotsLeft, marketRegime = null }) {
  // Direction gate: the live Nifty regime is the SOLE authority (the breakout-breadth
  // 70% lock was removed 2026-06-02 — it duplicated the regime, computed less reliably
  // from our own breakout sample, and the regime already overrode it). BULL→LONG only,
  // BEAR→SHORT only, NEUTRAL→both sides allowed. (UNKNOWN never reaches here — the
  // caller blocks all entries when the regime can't be read.)
  let gateSide = null;  // 'LONG' | 'SHORT' | null (both allowed)
  if (marketRegime === 'BULL')      gateSide = 'LONG';
  else if (marketRegime === 'BEAR') gateSide = 'SHORT';

  // Mark actions. Distance is now governed by ONE rule per end: a hard MIN floor
  // here, and a soft extension penalty in the quality score. The old >2×-OR-range
  // "stale" hard cut was removed 2026-06-02 — redundant with the ranking penalty and
  // it mixed units (OR-range multiples vs price-%).
  let slotsConsumed = 0;
  for (const b of confirmed) {
    if (Number.isFinite(b.rvol) && b.rvol < RVOL_ENTRY_MIN) {
      b._action = 'LOW_RVOL';                 // volume-confirmation gate (thin breakout)
    } else if (b.distancePct < MIN_DISTANCE_PCT) {
      b._action = 'BELOW_FLOOR';
    } else if (gateSide && b.direction !== gateSide) {
      b._action = 'WRONG_SIDE';
    } else if (slotsConsumed < slotsLeft) {
      b._action = 'ENTER';
      slotsConsumed++;
    } else {
      b._action = 'SLOT_FULL';
    }
  }

  return { gateSide };
}

// Export constants for testing / introspection
export const _testExports = {
  MIN_DISTANCE_PCT,
  BE_CUSHION_PCT,
  BE_CUSHION_ATR_MULT,
  RSI_PERIOD,
  RSI_MA_PERIOD,
  RSI_OVERBOUGHT,
  RSI_OVERSOLD,
  RSI_NEUTRAL_HIGH,
  RSI_NEUTRAL_LOW,
};

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

// ── Book P&L for a position found already closed (2026-06-02) ──────────────
// When a candidate is detected flat at the broker (manual close, or an exit the
// system fired but didn't record), these branches used to mark TIME_EXIT with no
// exitPrice/pnl — so the trade dropped out of the day total entirely (BSE,
// 2026-06-01). This recovers the broker's realised P&L for the day position and
// writes it onto the candidate. Falls back to pnl=0 (never undefined) so the
// trade always appears in the total. Mutates `c`; safe to await in exit branches.
async function bookAlreadyClosedPnl(c, logTag = '[MONITOR]') {
  c.exitTime = c.exitTime || new Date();
  try {
    const positions = await kiteOrderService.getPositions();
    const dayList   = positions?.data?.day || [];
    const pos       = dayList.find(p => p.tradingsymbol === c.symbol);
    if (pos && (pos.realised != null || pos.pnl != null)) {
      const realised = (pos.realised != null) ? Number(pos.realised) : Number(pos.pnl);
      c.pnl       = parseFloat(realised.toFixed(2));
      c.exitPrice = pos.last_price || pos.average_price || c.entryPrice;
      c.returnPct = (c.entryPrice && c.qty)
        ? parseFloat((c.pnl / (c.entryPrice * c.qty) * 100).toFixed(2))
        : 0;
      console.log(`${LOG} ${logTag}   ${c.symbol}: 📕 recovered broker realised P&L=₹${c.pnl >= 0 ? '+' : ''}${c.pnl}`);
      return;
    }
  } catch (err) {
    console.error(`${LOG} ${logTag}   ${c.symbol}: realised-P&L recovery failed (${err.message}) — booking 0`);
  }
  // Unknown — book 0 (not undefined) so the trade still counts in the day total.
  c.pnl       = 0;
  c.exitPrice = c.entryPrice;
  c.returnPct = 0;
}

// ── Nifty market regime — live direction read (2026-06-02) ────────────────
// So the system adapts when the index reverses intraday instead of staying on a
// morning bias lock. Uses the NIFTY 50 INDEX opening range (09:15–09:30) + the
// current index level:
//   • Nifty > OR high → BULL   (gate to LONG breakouts only)
//   • Nifty < OR low  → BEAR   (gate to SHORT breakouts only)
//   • inside the OR    → NEUTRAL (both directions allowed; breadth lock was removed)
// VWAP note: a true volume-weighted VWAP on the index is impossible (Kite returns
// volume=0 for indices), so the index direction here is OR-based (ORB-on-Nifty).
// Per-position VWAP reversal exits use each STOCK's own VWAP (which has volume) —
// see monitorOrbPositions(). On any data error this returns regime=null; the caller
// (checkBreakouts) treats unknown regime as a HARD BLOCK — no entries that scan
// (no-trade is safer than trading blind on direction). It does NOT force-exit open
// positions on null regime (those are governed by per-stock VWAP, not the index).
const NIFTY_INDEX_SYMBOL = 'NIFTY 50';
let _niftyOrCache = { date: null, orHigh: null, orLow: null };

async function getMarketRegime() {
  try {
    const istDateStr = MarketHoursUtil.toIST(new Date()).toISOString().slice(0, 10);
    // OR (09:15–09:30) = the FIRST 15-min index candle of the day; cache per day.
    if (_niftyOrCache.date !== istDateStr || _niftyOrCache.orHigh == null) {
      const multi = await kiteOrderService.getIntradayMultiCandles([NIFTY_INDEX_SYMBOL], [{ interval: '15minute', count: 40 }]);
      const bars  = multi['15minute']?.[NIFTY_INDEX_SYMBOL] || [];
      if (bars.length) {
        const first = bars[0];   // earliest bar = 09:15–09:30 opening range
        _niftyOrCache = { date: istDateStr, orHigh: first.high, orLow: first.low };
        console.log(`${LOG} [REGIME] Nifty OR set — high=${first.high} low=${first.low}`);
      }
    }
    const { orHigh, orLow } = _niftyOrCache;
    if (orHigh == null || orLow == null) return { regime: null, reason: 'no_nifty_or' };

    const ltpData  = await kiteOrderService.getLTP([`NSE:${NIFTY_INDEX_SYMBOL}`]);
    const niftyLtp = ltpData[`NSE:${NIFTY_INDEX_SYMBOL}`]?.last_price;
    if (!niftyLtp) return { regime: null, reason: 'no_nifty_ltp', orHigh, orLow };

    let regime = 'NEUTRAL';
    if (niftyLtp > orHigh)      regime = 'BULL';
    else if (niftyLtp < orLow)  regime = 'BEAR';
    console.log(`${LOG} [REGIME] Nifty=${niftyLtp}  OR=${orLow}–${orHigh}  → ${regime}`);
    return { regime, niftyLtp, orHigh, orLow };
  } catch (err) {
    console.error(`${LOG} [REGIME] getMarketRegime failed (${err.message}) — regime=null (no gate)`);
    return { regime: null, reason: 'error' };
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
      // CRITICAL (2026-06-02 fix): the emergency exit actually CLOSES the position,
      // so we must record it. Without this the candidate stays status='ENTERED'
      // while flat at the broker — the position silently vanishes and its P&L is
      // dropped from the day total (BSE, 2026-06-01). Read the fill and book it.
      const cIsLong = (candidate.direction || 'LONG') === 'LONG';
      let exitPrice = candidate.entryPrice;
      try {
        await delay(1500);
        const ord = await kiteOrderService.getOrderDetails(emergency?.orderId);
        if (ord?.average_price) exitPrice = ord.average_price;
      } catch (_) {}
      candidate.status     = 'TIME_EXIT';
      candidate.exitPrice  = exitPrice;
      candidate.exitTime   = new Date();
      candidate.exitReason = 'emergency_exit_sl_trail_failed';
      const pnlDir = cIsLong ? (exitPrice - candidate.entryPrice) : (candidate.entryPrice - exitPrice);
      candidate.pnl       = parseFloat((pnlDir * qty).toFixed(2));
      candidate.returnPct = parseFloat((pnlDir / candidate.entryPrice * 100).toFixed(2));
      console.log(`${LOG} ${logTag}   ${sym}: 📕 booked emergency exit @ ₹${exitPrice}  PnL=₹${candidate.pnl >= 0 ? '+' : ''}${candidate.pnl}`);
      return { success: false, reason: 'place_failed_emergency_fired', emergencyOrderId: emergency?.orderId, exited: true };
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
  console.log(`${LOG} ═══ PHASE 1: Day bootstrap [${istTimeStr()}] ═══`);
  console.log(`${LOG} ════════════════════════════════════════`);

  // 2026-06-11: runs at 08:35 (was 09:08). Before the 09:00–09:08 auction,
  // last_price = yesterday's last trade, so iep ≈ prevClose and gap ≈ 0 — the
  // IEP/gap fields are placeholders at this hour (nothing downstream uses them;
  // the paper pipeline keys entirely off rvol5 + the first 5-min candle).
  const istBootMin = (() => { const d = MarketHoursUtil.toIST(new Date()); return d.getHours() * 60 + d.getMinutes(); })();
  const preAuction = istBootMin < 9 * 60;   // before 09:00 → auction hasn't run
  if (preAuction) {
    console.log(`${LOG} [PHASE1] pre-auction run — IEP/gap fields will read ≈0 (observability only, not used by the pipeline)`);
  }

  let raw;
  try {
    raw = await fetchPreOpenViaKite();
  } catch (err) {
    console.error(`${LOG} [PHASE1] ❌ Kite pre-open fetch FAILED:`, err.message);
    console.error(`${LOG} [PHASE1]    Stack:`, err.stack);
    await logStage('bootstrap', false, { reason: 'kite_fetch_failed', error: err.message });
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

  if (!preAuction) {
  console.log(`${LOG} [PHASE1] Gap distribution (observability only — all stocks pass to Phase 2):`);
  console.log(`${LOG} [PHASE1]   strong gap UP   (≥+1%):  ${gapUpStrong.length}`);
  console.log(`${LOG} [PHASE1]   strong gap DOWN (≤-1%):  ${gapDownStrong.length}`);
  console.log(`${LOG} [PHASE1]   flat-ish        (|gap|<1%): ${flatish.length}`);
  }

  if (!preAuction && gapUpStrong.length) {
    const top5 = gapUpStrong.sort((a, b) => b.preOpenPct - a.preOpenPct).slice(0, 5);
    console.log(`${LOG} [PHASE1] Top-5 gap UP today:`);
    top5.forEach(c => console.log(`${LOG} [PHASE1]   ${c.symbol.padEnd(14)} gap=+${c.preOpenPct.toFixed(2)}%  IEP=₹${c.iep}`));
  }
  if (!preAuction && gapDownStrong.length) {
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

  // ── RVOL + ADR baseline (time-matched): see attachVolumeBaselines. Best-effort —
  // if this 09:08 fetch fails, checkBreakouts retries it once (lazy recovery) so a
  // single pre-open hiccup doesn't forfeit the day.
  try {
    await attachVolumeBaselines(candidates, '[PHASE1]');
  } catch (err) {
    console.warn(`${LOG} [PHASE1] ⚠ volume-profile fetch failed (${err.message}) — will retry lazily at first scan`);
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
    await logStage('bootstrap', false, { reason: 'db_upsert_failed', error: err.message });
    return { success: false, error: err.message };
  }

  // ── Capital preflight check ─────────────────────────────────────────────
  // 2026-06-05: Once per day at Phase 1 (09:08), verify the account has
  // enough intraday buying power to actually take MAX_ENTRIES trades at
  // MIN_CAPITAL_PER_TRADE each. If not, log loudly to BOTH stdout and stderr
  // so the user sees the problem early instead of debugging silent skips
  // mid-session (as on 2026-06-05 — ₹45k cash, 16 slots → all entries
  // silently skipped because per-trade ₹2,534 < floor ₹5,000).
  try {
    const balance = await kiteOrderService.getAvailableBalance();
    const buyingPower = balance.usableIntraday ?? balance.available;
    const orbBudget = buyingPower * ORB_CAPITAL_PCT;
    const perTradeIfFullDay = Math.floor(orbBudget / MAX_ENTRIES);
    const minBuyingPowerNeeded = Math.ceil(MAX_ENTRIES * MIN_CAPITAL_PER_TRADE / ORB_CAPITAL_PCT);
    console.log(`${LOG} [PHASE1] 💰 Capital preflight — intraday(5x)=₹${balance.usableIntraday}  ORB budget=₹${Math.round(orbBudget)}  per-trade (full day, ${MAX_ENTRIES} slots)=₹${perTradeIfFullDay}  floor=₹${MIN_CAPITAL_PER_TRADE}`);
    if (perTradeIfFullDay < MIN_CAPITAL_PER_TRADE) {
      const msg = `❌ INSUFFICIENT CAPITAL: intraday buying power ₹${balance.usableIntraday} is too low to take ${MAX_ENTRIES} trades at floor ₹${MIN_CAPITAL_PER_TRADE} each (per-trade would be ₹${perTradeIfFullDay}). Need ≥ ₹${minBuyingPowerNeeded}, or reduce MAX_ENTRIES, or lower MIN_CAPITAL_PER_TRADE. NO ENTRIES WILL FIRE UNTIL THIS IS FIXED.`;
      console.warn(`${LOG} [PHASE1] ${msg}`);
      console.log(`${LOG} [PHASE1] ${msg}`);   // mirror to stdout
    } else {
      console.log(`${LOG} [PHASE1] ✅ Capital preflight passed — can take up to ${MAX_ENTRIES} trades today`);
    }
  } catch (preflightErr) {
    console.error(`${LOG} [PHASE1] ⚠ Capital preflight skipped — balance fetch failed: ${preflightErr.message}`);
  }

  // Stage trail: baselines-attached count is the load-bearing fact for the day
  const withBaseline = candidates.filter(c => c.avgDailyVolume > 0).length;
  await logStage('bootstrap', candidates.length > 0 && withBaseline >= candidates.length * 0.5,
    { candidates: candidates.length, withBaseline });
  return { success: true, count: candidates.length };
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 2 — Record opening range (9:30 AM)
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// PHASE 1.5 — 09:21 in-play RVOL snapshot (between pre-open and record-range)
// ══════════════════════════════════════════════════════════════════════════

/**
 * rvol5 for one candidate: day-cumulative volume at ~09:21 vs the scaled
 * 09:15-slot baseline. Returns null when either side is missing (no baseline
 * from the 09:08 fetch, or no quote volume). Pure + exported for testing.
 */
export function computeRvol5(volumeSoFar, volumeProfile) {
  const base = volumeProfile?.['09:15'];
  if (!(base > 0) || !(volumeSoFar > 0)) return null;
  return volumeSoFar / (base * RVOL5_BASELINE_FRACTION);
}

/**
 * Select the in-play set from [{ symbol, rvol5 }] rows.
 *   normal:   top RVOL5_TOP_N of those with rvol5 ≥ RVOL5_MIN
 *   fallback: if fewer than RVOL5_MIN_QUALIFIED clear the floor, take the top
 *             RVOL5_FALLBACK_N by rvol5 regardless (guards against a mis-set
 *             BASELINE_FRACTION silently producing zero-trade days while the
 *             constant is still uncalibrated).
 * Returns { selected: Set<symbol>, fallback: boolean, ranked: rows sorted desc }.
 * Pure + exported for testing.
 */
export function selectInPlay(rows, {
  topN = RVOL5_TOP_N,
  minRvol = RVOL5_MIN,
  minQualified = RVOL5_MIN_QUALIFIED,
  fallbackN = RVOL5_FALLBACK_N,
} = {}) {
  const ranked = (rows || [])
    .filter(r => Number.isFinite(r.rvol5))
    .sort((a, b) => b.rvol5 - a.rvol5);
  const qualified = ranked.filter(r => r.rvol5 >= minRvol).slice(0, topN);
  if (qualified.length >= minQualified) {
    return { selected: new Set(qualified.map(r => r.symbol)), fallback: false, ranked };
  }
  return { selected: new Set(ranked.slice(0, fallbackN).map(r => r.symbol)), fallback: true, ranked };
}

/**
 * 09:21 — rank the WATCHING universe by first-minutes RVOL and mark the top
 * names inPlay. Phase 2 (recordOpeningRanges) then only sets ranges for
 * inPlay !== false candidates.
 *
 * Failure semantics (post paper-cutover 2026-06-11): on any of (no doc / quote
 * fetch dead / baselines missing on >50% of names) this job leaves inPlay flags
 * and rvolSnapshotAt UNSET. The consumer — placeOrbEntryOrders — then retries
 * the snapshot once inline and otherwise refuses to arm, so the SYSTEM fails
 * CLOSED: a broken snapshot = a no-trade day (selection is mandatory per the
 * paper; the unranked universe is the 3.2%/yr mode). A selection that
 * legitimately finds nothing in play is NOT a failure — that is a thin day and
 * trading less is the correct outcome (floor + fallback above still apply).
 */
export async function takeRvolSnapshot() {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} ═══ PHASE 1.5: In-play RVOL snapshot [${istTimeStr()}] ═══`);
  console.log(`${LOG} ════════════════════════════════════════`);

  const doc = await OrbTrade.findToday();
  if (!doc) {
    console.warn(`${LOG} [RVOL5] ⚠️  No ORB doc for today — bootstrap may not have run.`);
    await logStage('snapshot', false, 'no_doc — bootstrap missing');
    return { success: false, reason: 'no_doc' };
  }
  if (doc.rvolSnapshotAt) {
    console.log(`${LOG} [RVOL5] Snapshot already taken at ${doc.rvolSnapshotAt.toISOString()} — skipping`);
    return { success: true, skipped: true, reason: 'already_done' };
  }

  const watching = doc.candidates.filter(c => c.status === 'WATCHING');
  if (!watching.length) {
    console.warn(`${LOG} [RVOL5] ⚠️  No WATCHING candidates — nothing to snapshot`);
    return { success: false, reason: 'no_watching' };
  }

  // ONE batched full-quote sweep (chunked 100/call like Phase 2) — /quote (not
  // /quote/ohlc) because only the full quote carries day-cumulative `volume`.
  const symbols  = watching.map(c => c.symbol);
  const CHUNK    = 100;
  const quoteMap = {};
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const batch = symbols.slice(i, i + CHUNK);
    try {
      const data = await kiteOrderService.getQuote(batch.map(s => `NSE:${s}`));
      Object.assign(quoteMap, data);
    } catch (err) {
      console.error(`${LOG} [RVOL5] quote batch failed (${err.message}) — continuing with what we have`);
    }
  }

  const got = Object.keys(quoteMap).length;
  if (got < symbols.length * 0.5) {
    console.warn(`${LOG} [RVOL5] ⚠️  Quotes for only ${got}/${symbols.length} symbols — aborting (flags unset; arming will retry once then fail closed)`);
    await logStage('snapshot', false, { reason: 'quote_coverage', got, total: symbols.length });
    return { success: false, reason: 'quote_coverage', got, total: symbols.length };
  }

  // Compute rvol5 per candidate
  const rows = [];
  let noBaseline = 0;
  for (const c of watching) {
    const q   = quoteMap[`NSE:${c.symbol}`];
    const vol = q ? (q.volume ?? q.volume_traded ?? null) : null;
    const r5  = computeRvol5(vol, c.volumeProfile);
    c.rvol5   = Number.isFinite(r5) ? parseFloat(r5.toFixed(2)) : undefined;
    if (!Number.isFinite(r5)) noBaseline++;
    else rows.push({ symbol: c.symbol, rvol5: c.rvol5 });
  }

  if (rows.length < watching.length * 0.5) {
    console.warn(`${LOG} [RVOL5] ⚠️  rvol5 computable for only ${rows.length}/${watching.length} (no baseline/volume on ${noBaseline}) — aborting`);
    await logStage('snapshot', false, { reason: 'baseline_coverage', computable: rows.length, total: watching.length });
    return { success: false, reason: 'baseline_coverage', computable: rows.length, total: watching.length };
  }

  // Select + mark. Names without a computable rvol5 cannot prove they are in
  // play → inPlay=false (we only trade what the data positively qualifies).
  const { selected, fallback, ranked } = selectInPlay(rows);
  for (const c of watching) c.inPlay = selected.has(c.symbol);

  doc.rvolSnapshotAt = new Date();
  doc.rvol5Fallback  = fallback;
  await doc.save();

  if (fallback) {
    console.warn(`${LOG} [RVOL5] ⚠️  FALLBACK: <${RVOL5_MIN_QUALIFIED} names cleared rvol5≥${RVOL5_MIN} — took top ${selected.size} by rvol5 regardless. Check RVOL5_BASELINE_FRACTION calibration.`);
  }
  console.log(`${LOG} [RVOL5] In-play: ${selected.size}/${watching.length} (floor=${RVOL5_MIN}× topN=${RVOL5_TOP_N} fraction=${RVOL5_BASELINE_FRACTION})`);
  ranked.slice(0, RVOL5_TOP_N).forEach((r, i) => {
    const mark = selected.has(r.symbol) ? '✅ IN-PLAY ' : '   spectator';
    console.log(`${LOG} [RVOL5]   #${String(i + 1).padStart(2)} ${r.symbol.padEnd(14)} rvol5=${r.rvol5.toFixed(2)}x ${mark}`);
  });

  await logStage('snapshot', true, {
    inPlay: selected.size, total: watching.length, fallback,
    top5: ranked.slice(0, 5).map(r => `${r.symbol}:${r.rvol5}x`),
  });
  return { success: true, inPlay: selected.size, total: watching.length, fallback };
}

// ══════════════════════════════════════════════════════════════════════════
// PAPER MODE — Phase 2P: place resting entry orders at the 5-min OR edge (09:24)
// ══════════════════════════════════════════════════════════════════════════

/**
 * Protective SL-M for a just-filled paper entry: fill price ∓ stopDistance
 * (0.10 × daily ATR14, computed at arm time). 2-attempt tick-retry like
 * enterTrade; if both fail the position is UNPROTECTED → emergency MARKET exit.
 */
async function placePaperProtectiveStop(doc, c, logTag = '[PAPER]') {
  const isLong   = (c.direction || 'LONG') === 'LONG';
  const exitSide = isLong ? 'SELL' : 'BUY';
  let stop = snapToNSETick(
    isLong ? c.entryPrice - c.stopDistance : c.entryPrice + c.stopDistance,
    0.05, isLong ? 'floor' : 'ceil'
  );

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const slRes = await kiteOrderService.placeOrder({
        tradingsymbol:    c.symbol,
        exchange:         'NSE',
        transaction_type: exitSide,
        order_type:       'SL-M',
        trigger_price:    stop,
        product:          'MIS',
        quantity:         c.qty,
        simulationId:     `orb_sl_${c.symbol}`,
        orderType:        'ORB_STOP',
        source:           'ORB',
      });
      if (slRes.success) {
        c.stopOrderId = slRes.orderId;
        c.stopPrice   = stop;
        console.log(`${LOG} ${logTag} ${c.symbol}: ✅ protective SL-M ${exitSide} @ ₹${stop} (0.1×ATR14d=₹${c.stopDistance}, ${(c.stopDistance / c.entryPrice * 100).toFixed(2)}% from fill ₹${c.entryPrice}) — orderId=${slRes.orderId}`);
        return true;
      }
    } catch (err) {
      const errMsg = err?.response?.data?.message || err?.message || String(err);

      // Price already through the stop (fill-to-SL latency): Kite rejects an
      // SL-M whose trigger is on the wrong side of LTP. No retry can fix that —
      // go straight to the emergency flat (2026-06-12: TATACHEM burned ~1R
      // making a second identical doomed attempt before flatting).
      if (/than the last traded price/i.test(errMsg)) {
        console.error(`${LOG} ${logTag} ${c.symbol}: price already through the stop (${errMsg.slice(0, 90)}…) — skipping retries, flatting now`);
        break;
      }

      // Tick-size reject: re-snap the ORIGINAL stop level to the script's tick.
      // 2026-06-12 BUG FIX (ICICIGI): the old code passed the parsed tick (0.10)
      // as the PRICE — placing a stop at ₹0.1. For a BUY stop Kite rejected it,
      // but a SELL stop at ₹0.1 would be ACCEPTED and never fire = naked
      // position that looks protected. parseKiteTickError returns the TICK SIZE,
      // not a price — use it as the snap quantum.
      const tick = parseKiteTickError(err);
      if (tick && tick < 1 && attempt === 1) {
        stop = snapToNSETick(
          isLong ? c.entryPrice - c.stopDistance : c.entryPrice + c.stopDistance,
          tick, isLong ? 'floor' : 'ceil'
        );
        console.warn(`${LOG} ${logTag} ${c.symbol}: tick-size reject — re-snapping stop to ₹${tick} multiples → ₹${stop}`);
        continue;
      }
      console.error(`${LOG} ${logTag} ${c.symbol}: ❌ SL placement failed (attempt ${attempt}): ${errMsg}`);
    }
  }

  // Both attempts failed → position UNPROTECTED → emergency flat NOW.
  console.error(`${LOG} ${logTag} ${c.symbol}: ⚠⚠ NO PROTECTIVE SL — firing emergency ${exitSide} MARKET`);
  await logStage('protective-sl', false, { symbol: c.symbol, action: 'emergency_exit', entry: c.entryPrice });
  try {
    await kiteOrderService.placeOrder({
      tradingsymbol: c.symbol, exchange: 'NSE', transaction_type: exitSide,
      order_type: 'MARKET', product: 'MIS', quantity: c.qty,
      simulationId: `orb_emergency_no_sl_${c.symbol}`, orderType: 'ORB_EMERGENCY_EXIT', source: 'ORB',
    });
    c.status     = 'TIME_EXIT';
    c.exitTime   = new Date();
    c.exitReason = 'emergency_exit_no_protective_sl';
  } catch (emErr) {
    console.error(`${LOG} ${logTag} ${c.symbol}: ❌❌ EMERGENCY EXIT ALSO FAILED — MANUAL INTERVENTION NEEDED: ${emErr.message}`);
  }
  return false;
}

/**
 * 09:24 — PAPER-SPEC ENTRY ARMING. For the top in-play names (by rvol5):
 *   1. Read the 09:15–09:20 5-min candle → OR high/low + direction (close vs open)
 *   2. Daily ATR(14) → stopDistance = 0.10 × ATR (skip if ATR < ₹0.50, paper FILTER 3)
 *   3. Size: min(1% cash risk ÷ stopDistance, slot capital ÷ trigger)
 *   4. Place a resting SL-M entry AT the OR edge → status ARMED.
 *      If price already broke the edge before 09:24 the stop would have triggered —
 *      enter MARKET immediately instead (Kite rejects an SL-M already past trigger).
 * Fills are picked up by orb-monitor (ARMED → ENTERED + protective SL).
 * Idempotent via doc.paperEntriesPlacedAt. No regime gate — paper spec.
 */
export async function placeOrbEntryOrders() {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} ═══ PHASE 2P: Paper-spec entry arming [${istTimeStr()}] ═══`);
  console.log(`${LOG} ════════════════════════════════════════`);

  const doc = await OrbTrade.findToday();
  if (!doc) {
    console.warn(`${LOG} [PAPER] ⚠️  No ORB doc — Phase 1 may not have run`);
    return { success: false, reason: 'no_doc' };
  }
  if (doc.paperEntriesPlacedAt) {
    console.log(`${LOG} [PAPER] Entries already armed at ${doc.paperEntriesPlacedAt.toISOString()} — skipping`);
    return { success: true, skipped: true, reason: 'already_armed' };
  }
  // Paper spec REQUIRES the RVOL selection — without the snapshot there is no
  // in-play set, and arming the whole universe is exactly the 3.2%/yr failure
  // mode. The snapshot at 09:21 is therefore a single point of failure for the
  // whole trading day, so (2026-06-11 audit) RETRY it inline once here before
  // giving up. Still fail-closed if the retry also fails: no selection, no trades.
  if (!doc.rvolSnapshotAt) {
    console.warn(`${LOG} [PAPER] ⚠️  No RVOL snapshot from 09:21 — retrying inline before arming`);
    try {
      const retry = await takeRvolSnapshot();
      console.log(`${LOG} [PAPER] inline snapshot retry: ${JSON.stringify(retry)}`);
    } catch (err) {
      console.error(`${LOG} [PAPER] inline snapshot retry threw: ${err.message}`);
    }
    // Re-read the doc — takeRvolSnapshot loads and saves its own copy, so this
    // stale `doc` would not see the flags it just wrote.
    const fresh = await OrbTrade.findToday();
    if (!fresh?.rvolSnapshotAt) {
      console.warn(`${LOG} [PAPER] ⚠️  Snapshot still unavailable after retry — refusing to arm (fail-closed, no trades today)`);
      await logStage('arming', false, 'no_rvol_snapshot after inline retry — NO TRADES TODAY');
      return { success: false, reason: 'no_rvol_snapshot' };
    }
    return placeOrbEntryOrdersOn(fresh);
  }
  return placeOrbEntryOrdersOn(doc);
}

// Inner worker — arming logic operating on a known-fresh doc.
async function placeOrbEntryOrdersOn(doc) {

  const inPlay = doc.candidates
    .filter(c => c.status === 'WATCHING' && c.inPlay === true && Number.isFinite(c.rvol5))
    .sort((a, b) => b.rvol5 - a.rvol5)
    .slice(0, PAPER_MAX_ENTRIES);
  if (!inPlay.length) {
    console.log(`${LOG} [PAPER] No in-play candidates — thin day, no entries (correct outcome)`);
    return { success: true, armed: 0 };
  }
  const symbols = inPlay.map(c => c.symbol);
  console.log(`${LOG} [PAPER] Arming top ${symbols.length} by rvol5: ${symbols.join(', ')}`);

  // Data: first 5-min candle, ~30 trading days of daily bars (ATR14), LTP
  const istNowD = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const toD     = new Date(istNowD); toD.setDate(toD.getDate() - 1);
  const fromD   = new Date(istNowD); fromD.setDate(fromD.getDate() - 45);
  const fmt     = d => d.toISOString().slice(0, 10);
  let candles5, dailyBars, ltps;
  try {
    [candles5, dailyBars, ltps] = await Promise.all([
      kiteOrderService.getIntradayCandles(symbols, '5minute', 3),
      kiteOrderService.getHistoricalCandles(symbols, 'day', fmt(fromD), fmt(toD)),
      kiteOrderService.getLTP(symbols.map(s => `NSE:${s}`)),
    ]);
  } catch (err) {
    console.error(`${LOG} [PAPER] ❌ data fetch failed (${err.message}) — no entries armed`);
    await logStage('arming', false, { reason: 'data_fetch_failed', error: err.message });
    return { success: false, reason: 'data_fetch_failed' };
  }

  // Capital: slot cap (leverage constraint) + risk budget (1% of cash)
  let slotCap = MIN_CAPITAL_PER_TRADE, riskBudget = null;
  try {
    const balance     = await kiteOrderService.getAvailableBalance();
    const buyingPower = balance.usableIntraday ?? balance.available;
    slotCap     = Math.floor((buyingPower * ORB_CAPITAL_PCT) / PAPER_MAX_ENTRIES);
    riskBudget  = Math.floor((balance.available ?? buyingPower / 5) * (PAPER_RISK_PCT / 100));
    console.log(`${LOG} [PAPER] Capital — cash=₹${balance.available}  intraday(5x)=₹${balance.usableIntraday}  slotCap=₹${slotCap}  riskBudget(1%)=₹${riskBudget}`);
  } catch (err) {
    console.error(`${LOG} [PAPER] Balance fetch failed (${err.message}) — using floor slotCap=₹${slotCap}, risk cap disabled`);
  }

  // 2026-06-11 review fix (idempotency): stamp + persist INTENT before placing a
  // single order. Previously the stamp was only saved after the whole loop — a
  // crash (or Agenda retry on a thrown error) after some resting orders were live
  // at the broker but before that save would re-run with paperEntriesPlacedAt
  // still null and re-arm everything = double entries. Now a crash mid-loop means
  // the re-run sees the stamp and refuses: some names may go UNARMED (under-trade),
  // which is the safe failure direction. Each placement is also saved incrementally
  // below so the doc tracks broker state as closely as possible.
  doc.paperEntriesPlacedAt = new Date();
  await doc.save();

  let armed = 0, immediate = 0, skipped = 0;
  for (const c of inPlay) {
    const bars5 = candles5[c.symbol] || [];
    const bar   = bars5.find(b => slotKey(b.date) === '09:15');
    if (!bar || !(bar.high > bar.low)) {
      c.status = 'SKIPPED'; c.skipReason = 'no_5min_or_candle'; skipped++;
      console.warn(`${LOG} [PAPER] ${c.symbol.padEnd(14)} ⏭ no 09:15 5-min candle`);
      continue;
    }

    // Direction — the paper's per-stock rule, no index gate
    const direction = bar.close > bar.open ? 'LONG' : bar.close < bar.open ? 'SHORT' : null;
    if (!direction) {
      c.status = 'SKIPPED'; c.skipReason = 'doji_first_candle'; skipped++;
      console.log(`${LOG} [PAPER] ${c.symbol.padEnd(14)} ⏭ doji first candle (O=C=₹${bar.open}) — paper rule: no trade`);
      continue;
    }
    const isLong = direction === 'LONG';

    // Stop distance from daily ATR(14)
    const atr14d = computeATR(dailyBars[c.symbol] || [], 14);
    if (!(atr14d >= PAPER_MIN_ATR14D)) {
      c.status = 'SKIPPED'; c.skipReason = `atr14d_below_floor_${atr14d?.toFixed?.(2) ?? 'na'}`; skipped++;
      console.log(`${LOG} [PAPER] ${c.symbol.padEnd(14)} ⏭ ATR14d ₹${atr14d?.toFixed?.(2) ?? 'n/a'} < ₹${PAPER_MIN_ATR14D} floor`);
      continue;
    }
    const stopDist = Math.max(0.05, snapToNSETick(PAPER_STOP_ATR_MULT * atr14d, 0.05, 'round'));

    // Trigger at the OR edge
    const trigger = isLong
      ? snapToNSETick(bar.high, 0.05, 'ceil')
      : snapToNSETick(bar.low,  0.05, 'floor');

    // Sizing: risk-based, leverage-capped
    const qtyByRisk = riskBudget ? Math.floor(riskBudget / stopDist) : Infinity;
    const qtyByCap  = Math.floor(slotCap / trigger);
    const qty       = Math.min(qtyByRisk, qtyByCap);
    if (qty < 1) {
      c.status = 'SKIPPED'; c.skipReason = 'qty_below_1'; skipped++;
      console.log(`${LOG} [PAPER] ${c.symbol.padEnd(14)} ⏭ qty<1 (slotCap=₹${slotCap} / trigger=₹${trigger})`);
      continue;
    }

    // Persist the setup
    c.orHigh = bar.high; c.orLow = bar.low;
    c.orRange = parseFloat((bar.high - bar.low).toFixed(2));
    c.firstCandleOpen = bar.open; c.firstCandleClose = bar.close;
    c.direction = direction; c.atr14d = parseFloat(atr14d.toFixed(2));
    c.stopDistance = stopDist; c.qty = qty;

    const ltp        = ltps[`NSE:${c.symbol}`]?.last_price;
    const alreadyPast = ltp && (isLong ? ltp >= trigger : ltp <= trigger);
    const entrySide  = isLong ? 'BUY' : 'SELL';
    const riskPct    = (stopDist / trigger * 100).toFixed(2);
    console.log(`${LOG} [PAPER] ${c.symbol.padEnd(14)} ${direction.padEnd(5)} OR=₹${bar.low}–₹${bar.high}  trigger=₹${trigger}  stopDist=₹${stopDist} (${riskPct}%)  qty=${qty}  rvol5=${c.rvol5}x  LTP=₹${ltp ?? '?'}${alreadyPast ? ' [ALREADY PAST — MARKET]' : ''}`);

    try {
      if (alreadyPast) {
        // The paper's stop order would already have triggered → enter at market now
        const res = await kiteOrderService.placeOrder({
          tradingsymbol: c.symbol, exchange: 'NSE', transaction_type: entrySide,
          order_type: 'MARKET', product: 'MIS', quantity: qty,
          simulationId: `orb_paper_entry_${c.symbol}`, orderType: 'ORB_ENTRY', source: 'ORB',
        });
        if (!res.success) throw new Error('placeOrder returned non-success');
        await delay(2000);
        let fill = null, fillFetchFailed = false;
        try { fill = await kiteOrderService.getOrderDetails(res.orderId); }
        catch (err) { fillFetchFailed = true; console.warn(`${LOG} [PAPER] ${c.symbol}: fill-status read failed (${err.message}) — treating as potentially live`); }
        const filledQty = Number(fill?.filled_quantity || 0);

        // 2026-06-11 review fix: SKIP only on a CONFIRMED terminal reject/cancel.
        // A MARKET order almost always fills — if the status read failed or hasn't
        // reported COMPLETE within 2s, assuming "not filled" would orphan a live
        // position with NO protective stop and NO monitoring (SKIPPED is never
        // looked at again). Ambiguous → assume LIVE: mark ENTERED at LTP, place
        // the protective stop, and let the monitor / kite-order-sync reconcile.
        // Worst case of guessing wrong: a stray SL-M on a non-position, which
        // order-sync cancels — vs. the old worst case of an unstopped position.
        if (!fillFetchFailed && (fill?.status === 'REJECTED' || fill?.status === 'CANCELLED')) {
          c.status = 'SKIPPED'; c.skipReason = `paper_market_entry_${fill.status.toLowerCase()}: ${fill?.status_message || ''}`; skipped++;
          c.entryOrderId = res.orderId;
          console.error(`${LOG} [PAPER] ${c.symbol}: ❌ market entry ${fill.status} — no SL placed (confirmed dead)`);
          continue;
        }
        if (fill?.status !== 'COMPLETE') {
          console.warn(`${LOG} [PAPER] ${c.symbol}: ⚠ ambiguous fill state (status=${fill?.status ?? 'unknown'}, filled=${filledQty}/${qty}) — assuming LIVE, placing SL`);
        }
        c.entryOrderId = res.orderId;
        c.entryPrice   = fill?.average_price || ltp;
        c.qty          = filledQty || qty;
        c.entryTime    = new Date();
        c.status       = 'ENTERED';
        doc.entriesCount = (doc.entriesCount || 0) + 1;
        await placePaperProtectiveStop(doc, c);
        immediate++;
        await doc.save();   // persist live-order state immediately (crash safety)
      } else {
        // Resting stop-entry at the edge — the paper's actual mechanism
        const res = await kiteOrderService.placeOrder({
          tradingsymbol: c.symbol, exchange: 'NSE', transaction_type: entrySide,
          order_type: 'SL-M', trigger_price: trigger, product: 'MIS', quantity: qty,
          simulationId: `orb_paper_entry_${c.symbol}`, orderType: 'ORB_ENTRY', source: 'ORB',
        });
        if (!res.success) throw new Error('placeOrder returned non-success');
        c.entryOrderId = res.orderId;
        c.status       = 'ARMED';
        armed++;
        await doc.save();   // persist live-order state immediately (crash safety)
      }
    } catch (err) {
      const errMsg = err?.response?.data?.message || err?.message || String(err);
      if (/MIS orders are currently blocked/i.test(errMsg)) {
        console.warn(`${LOG} [PAPER] ${c.symbol}: ⏭ MIS-BLOCKED by broker — skipping. Msg: ${errMsg}`);
        c.status = 'SKIPPED'; c.skipReason = 'mis_blocked_by_broker';
      } else {
        console.error(`${LOG} [PAPER] ${c.symbol}: ❌ entry order failed: ${errMsg}`);
        c.status = 'SKIPPED'; c.skipReason = `paper_entry_failed: ${errMsg}`;
      }
      skipped++;
    }
  }

  await doc.save();   // final save catches the skip markers from the last iteration
  console.log(`${LOG} [PAPER] ─── Arming complete: ARMED=${armed}  immediate-ENTERED=${immediate}  skipped=${skipped} ───`);
  await logStage('arming', armed + immediate > 0 || skipped === 0, {
    armed, immediate, skipped,
    names: inPlay.map(c => `${c.symbol}:${c.status}${c.direction ? ':' + c.direction : ''}`),
  });
  return { success: true, armed, immediate, skipped };
}

export async function recordOpeningRanges() {
  // LEGACY — RETIRED 2026-06-11. The 5-min OR is set by placeOrbEntryOrders
  // (09:24). This 15-min path is permanently disabled; body kept for reference.
  console.log(`${LOG} [PHASE2] legacy 15-min OR recording retired — no-op (5-min OR set at 09:24)`);
  return { success: true, skipped: true, reason: 'legacy_retired' };
  // eslint-disable-next-line no-unreachable
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} ═══ PHASE 2: Record opening ranges [${istTimeStr()}] ═══`);
  console.log(`${LOG} ════════════════════════════════════════`);

  const doc = await OrbTrade.findToday();
  if (!doc) {
    console.warn(`${LOG} [PHASE2] ⚠️  No ORB doc for today — Phase 1 may not have run`);
    return { success: false, reason: 'no_doc' };
  }
  console.log(`${LOG} [PHASE2] Doc found — docId=${doc._id}  total candidates=${doc.candidates.length}`);

  // 2026-06-11: in-play filter — only candidates the 09:21 RVOL snapshot marked
  // inPlay get a range (inPlay !== false is FAIL-OPEN: if the snapshot never ran,
  // inPlay is undefined and everyone passes, restoring pre-snapshot behaviour).
  const allWatching = doc.candidates.filter(c => c.status === 'WATCHING');
  const watching    = allWatching.filter(c => c.inPlay !== false);
  const spectators  = allWatching.length - watching.length;
  const skipped     = doc.candidates.filter(c => c.status === 'SKIPPED');
  console.log(`${LOG} [PHASE2] Candidate states: WATCHING=${allWatching.length} (in-play=${watching.length}, spectators=${spectators})  SKIPPED=${skipped.length}  other=${doc.candidates.length - allWatching.length - skipped.length}`);
  if (spectators > 0) {
    console.log(`${LOG} [PHASE2] In-play filter ACTIVE (snapshot ${doc.rvolSnapshotAt?.toISOString() ?? '?'}${doc.rvol5Fallback ? ', FALLBACK selection' : ''}) — ranges only for ${watching.length} in-play names`);
  }

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
    if (candidate.inPlay === false) continue;   // spectator — no range, never RANGE_SET

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

    // OR-width filter REMOVED (2026-06-03): both the too-wide and too-tight bounds
    // were dropped. Too-wide was excluding the strongest gap-down momentum shorts
    // (e.g. TCS −8% was skipped or_wide) and is now covered by the 1.5% SL cap +
    // VARS down-ranking of wide-OR names. Too-tight is covered by the 1% distance
    // floor (a tiny-OR breakout still needs a real 1% move), the RVOL gate, and the
    // VARS denominator clamp. ADR (adrPct) is still computed for observability.
    // Every name with valid OHLC now becomes RANGE_SET.
    candidate.orHigh  = orHigh;
    candidate.orLow   = orLow;
    candidate.orRange = orRange;
    candidate.status  = 'RANGE_SET';
    // direction is intentionally left unset — will be set in Phase 3 at break time
    rangesSet++;
  }

  // Summary log (instead of 200+ per-symbol lines that would blow up the log)
  console.log(`${LOG} [PHASE2] Summary: RANGE_SET=${rangesSet}  (OR-width filter removed)  NO_DATA=${rangesNoData}  of ${watching.length}`);

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
  const rangesSkipped = rangesSkippedWide + rangesSkippedTight;
  console.log(`${LOG} [PHASE2] ─────────────────────────────────`);
  console.log(`${LOG} [PHASE2] Summary: RANGE_SET=${rangesSet}  SKIPPED=${rangesSkipped} (wide=${rangesSkippedWide} tight=${rangesSkippedTight})  NO_DATA=${rangesNoData}  of ${watching.length} WATCHING`);
  return { success: true, rangesSet, rangesSkipped, rangesSkippedWide, rangesSkippedTight, rangesNoData };
}

// ══════════════════════════════════════════════════════════════════════════
// PHASE 3 — Check breakouts + enter (every 1 min, 9:30–11:00 AM)
// ══════════════════════════════════════════════════════════════════════════

export async function checkBreakouts() {
  // LEGACY — RETIRED 2026-06-11. Scanning is replaced by resting SL-M entry
  // orders at the 5-min OR edge (placeOrbEntryOrders, 09:24); the exchange does
  // the breakout detection. Permanently disabled — firing this as well would
  // double-enter. Body kept for reference.
  console.log(`${LOG} [BREAKOUT] legacy 2-bar confirmation scan retired — no-op (resting entries armed at 09:24)`);
  return { skipped: true, reason: 'legacy_retired' };
  // eslint-disable-next-line no-unreachable
  const ist    = MarketHoursUtil.toIST(new Date());
  const istMin = ist.getHours() * 60 + ist.getMinutes();
  const windowStart = BREAKOUT_START_HOUR * 60 + BREAKOUT_START_MIN;   // 09:46
  const windowEnd   = BREAKOUT_END_HOUR   * 60 + BREAKOUT_END_MIN;     // 11:46

  if (istMin < windowStart || istMin > windowEnd) {
    console.log(`${LOG} [BREAKOUT] Outside entry window (now=${istTimeStr()}  window=${String(BREAKOUT_START_HOUR).padStart(2,'0')}:${String(BREAKOUT_START_MIN).padStart(2,'0')}–${String(BREAKOUT_END_HOUR).padStart(2,'0')}:${String(BREAKOUT_END_MIN).padStart(2,'0')}) — skipping`);
    return { skipped: true, reason: 'outside_window' };
  }

  const doc = await OrbTrade.findToday();
  if (!doc) {
    console.warn(`${LOG} [BREAKOUT] No ORB doc for today — Phase 1 not run?`);
    return { skipped: true, reason: 'no_doc' };
  }

  const enteredCount = doc.candidates.filter(c => c.status === 'ENTERED').length;  // open now
  const dayEntries   = doc.entriesCount || 0;   // cumulative entries today — the day cap
  const rangeSet     = doc.candidates.filter(c => c.status === 'RANGE_SET');

  console.log(`${LOG} [BREAKOUT] [${istTimeStr()}] day-entries=${dayEntries}/${MAX_ENTRIES}  open=${enteredCount}  RANGE_SET=${rangeSet.length}`);

  if (dayEntries >= MAX_ENTRIES) {
    console.log(`${LOG} [BREAKOUT] Max ${MAX_ENTRIES} trades for the day reached — skipping`);
    return { skipped: true, reason: 'max_entries' };
  }

  if (!rangeSet.length) {
    console.log(`${LOG} [BREAKOUT] No RANGE_SET candidates — skipping`);
    return { skipped: true, reason: 'no_range_set' };
  }

  // Lazy recovery: if the 09:08 volume-baseline fetch failed for everything (no
  // RANGE_SET name has avgDailyVolume), retry it ONCE here. RVOL is a hard gate, so
  // without this a single pre-open hiccup would discard every name and forfeit the
  // whole day. Guarded by a persisted flag so we don't re-fetch every scan.
  // NOTE: this recovers the RVOL baseline only — NOT the OR-width gate. ADR is also
  // recomputed but the OR-width filter already ran in recordOpeningRanges (09:30),
  // so it can't un-skip names here. ADR failure was already soft (fixed-band fallback).
  if (needsVolumeBaselineRetry(rangeSet, doc.volBaselineRetried)) {
    console.warn(`${LOG} [BREAKOUT] ⚠ No RVOL baseline on any RANGE_SET name — retrying volume-baseline fetch once`);
    try { await attachVolumeBaselines(rangeSet, '[BREAKOUT]'); }
    catch (e) { console.error(`${LOG} [BREAKOUT] lazy baseline retry failed: ${e.message}`); }
    doc.volBaselineRetried = true;
    doc.markModified('candidates');   // volumeProfile is Mixed — ensure the re-fetch persists
    await doc.save();
  }

  // TIER-1 + N-BAR CONFIRM (CONFIRM_BARS = 2):
  // Fetch the last CONFIRM_BARS completed 15-min candles for each RANGE_SET
  // candidate. ALL of them must CLOSE past OR in the SAME direction → confirmed.
  // With =2: the breakout candle closes past OR AND the next consecutive candle
  // also closes past OR (above OR_High → LONG, below OR_Low → SHORT). Earliest
  // possible confirm is 10:01 (the 09:30–09:45 + 09:45–10:00 candles). Filters:
  //   • wick fake-outs (a candle that spikes past OR but closes back inside ≠ break)
  //   • whipsaws (the two candles on opposite sides of OR)
  //
  // Chunk size 20 keeps Kite historical-data rate limit happy (3 req/sec).
  console.log(`${LOG} [BREAKOUT] Fetching last ${CONFIRM_BARS}×15-min candle(s) for ${rangeSet.length} stocks (chunked)...`);
  const allCandles = {};
  const CANDLE_CHUNK = 20;
  for (let i = 0; i < rangeSet.length; i += CANDLE_CHUNK) {
    const chunkSymbols = rangeSet.slice(i, i + CANDLE_CHUNK).map(c => c.symbol);
    try {
      // Fetch CONFIRM_BARS + 1: Kite can return the just-started (forming) 15-min
      // candle as the most recent bar; we drop it below and keep the completed ones.
      const result = await kiteOrderService.getIntradayMultiCandles(chunkSymbols, [
        { interval: '15minute', count: CONFIRM_BARS + 1 },
      ]);
      Object.assign(allCandles, result['15minute'] || {});
    } catch (err) {
      console.error(`${LOG} [BREAKOUT] Candle chunk ${i}-${i + CANDLE_CHUNK} failed: ${err.message}`);
    }
  }
  console.log(`${LOG} [BREAKOUT] Candle data: ${Object.keys(allCandles).length}/${rangeSet.length} symbols returned`);

  // ── Evaluate N-bar confirmation for each candidate ──
  // LONG-confirm:  every one of the last CONFIRM_BARS closes > OR_High
  // SHORT-confirm: every one of the last CONFIRM_BARS closes < OR_Low
  // Mixed (some past high, some past low) → whipsaw; otherwise still inside OR.
  // distance is measured off the LAST (most recent) confirming close.
  let confirmed = [];
  let waitingBars = 0;
  let stillInsideOR = 0;
  let whipsaws = 0;

  for (const candidate of rangeSet) {
    // Keep only FULLY-CLOSED 15-min candles — drop the forming one (its 1-min volume
    // would make RVOL read ~0 and the gate reject a perfectly good breakout).
    const bars = (allCandles[candidate.symbol] || []).filter(b => isBarComplete(b.date, istMin, 15));
    if (bars.length < CONFIRM_BARS) { waitingBars++; continue; }

    const confirmBars = bars.slice(-CONFIRM_BARS);
    const firstClose  = confirmBars[0].close;
    const lastClose   = confirmBars[confirmBars.length - 1].close;

    const allAbove = confirmBars.every(b => b.close > candidate.orHigh);
    const allBelow = confirmBars.every(b => b.close < candidate.orLow);

    const breakoutBar    = confirmBars[confirmBars.length - 1];
    const breakoutVolume = breakoutBar.volume || 0;
    const breakoutSlot   = slotKey(breakoutBar.date);   // 'HH:MM' for time-matched RVOL
    if (allAbove) {
      const distance    = lastClose - candidate.orHigh;
      const distancePct = distance / candidate.orHigh * 100;
      confirmed.push({
        candidate, direction: 'LONG', bar1Close: firstClose, bar2Close: lastClose,
        distance, distancePct, breakoutVolume, breakoutSlot,
      });
    } else if (allBelow) {
      const distance    = candidate.orLow - lastClose;
      const distancePct = distance / candidate.orLow * 100;
      confirmed.push({
        candidate, direction: 'SHORT', bar1Close: firstClose, bar2Close: lastClose,
        distance, distancePct, breakoutVolume, breakoutSlot,
      });
    } else {
      const anyAbove = confirmBars.some(b => b.close > candidate.orHigh);
      const anyBelow = confirmBars.some(b => b.close < candidate.orLow);
      if (anyAbove && anyBelow) whipsaws++;
      else stillInsideOR++;
    }
  }

  console.log(`${LOG} [BREAKOUT] Scan summary: ${confirmed.length} 2-bar confirmed, ${stillInsideOR} inside OR, ${whipsaws} whipsaws (bar mismatch), ${waitingBars} missing bars`);

  if (!confirmed.length) {
    return { success: true, entered: 0 };
  }

  // ── Live Nifty regime (2026-06-02): gates entry direction and adapts to
  // intraday reversals. BULL→LONG only, BEAR→SHORT only, NEUTRAL→breadth.
  // Fetched BEFORE ranking because relative-strength scoring needs the Nifty level.
  const regimeInfo = await getMarketRegime();
  doc.marketRegime = regimeInfo.regime || 'UNKNOWN';
  doc.niftyOrHigh  = regimeInfo.orHigh ?? doc.niftyOrHigh;
  doc.niftyOrLow   = regimeInfo.orLow  ?? doc.niftyOrLow;
  // Live regime trail (queryable audit of production direction decisions).
  doc.regimeHistory = doc.regimeHistory || [];
  doc.regimeHistory.push({ t: new Date(), regime: regimeInfo.regime || 'UNKNOWN', niftyLtp: regimeInfo.niftyLtp ?? null, src: 'scan' });

  // BLOCK entries when the market regime can't be read (Nifty fetch failed).
  // Per design decision 2026-06-02: if we don't know which way the market is
  // heading, we take NO trades this scan rather than falling back to breakout
  // breadth. Safer failure mode (no trade > wrong-direction trade) and it makes
  // a broken Nifty fetch loud — zero entries instead of silently mis-trading.
  if (!regimeInfo.regime) {
    console.warn(`${LOG} [BREAKOUT] ⛔ Market regime unknown (${regimeInfo.reason || 'no_data'}) — BLOCKING all entries this scan`);
    if (doc.isModified()) await doc.save();
    return { skipped: true, reason: 'no_market_regime' };
  }

  // ── Rank confirmed breakouts by QUALITY (2026-06-02) — RVOL (volume conviction)
  // + relative strength vs Nifty (alignment), minus an extension penalty — instead
  // of raw distance%. Research: distance-ranking systematically picks the most-
  // extended names (closest to exhaustion); RVOL + relative strength pick conviction
  // + market-aligned leaders. Both inputs degrade safely: relStrength is always
  // computable here (regime gate guarantees Nifty data, else we'd have blocked);
  // RVOL falls back to neutral (1) when avgDailyVolume wasn't fetched at pre-open.
  const niftyMid = (regimeInfo.orHigh != null && regimeInfo.orLow != null)
    ? (regimeInfo.orHigh + regimeInfo.orLow) / 2 : null;
  const niftyRet = (niftyMid && regimeInfo.niftyLtp) ? (regimeInfo.niftyLtp - niftyMid) / niftyMid * 100 : 0;
  for (const b of confirmed) {
    const stockMid = (b.candidate.orHigh + b.candidate.orLow) / 2;
    const stockRet = stockMid ? (b.bar2Close - stockMid) / stockMid * 100 : 0;
    const rawRel   = stockRet - niftyRet;                          // stock outperformance vs Nifty
    b.relStrength  = b.direction === 'LONG' ? rawRel : -rawRel;    // aligned to the trade side
    // RVOL: prefer the time-matched slot baseline (breakout vs a normal candle for
    // that same time of day); fall back to the flat daily average; else neutral.
    const profile  = b.candidate.volumeProfile;
    const slotAvg  = (profile && b.breakoutSlot) ? profile[b.breakoutSlot] : null;
    const avgVol   = b.candidate.avgDailyVolume;
    if (slotAvg > 0 && b.breakoutVolume > 0) {
      b.rvol = b.breakoutVolume / slotAvg;            b.rvolBasis = 'slot';
    } else if (avgVol > 0 && b.breakoutVolume > 0) {
      b.rvol = b.breakoutVolume / (avgVol / BARS_PER_DAY); b.rvolBasis = 'flat';
    } else {
      b.rvol = 1;                                     b.rvolBasis = 'none';
    }
    const orWidthPct = b.candidate.iep > 0 ? (b.candidate.orRange / b.candidate.iep * 100) : null;
    b.score        = scoreCandidateQuality({ relStrength: b.relStrength, distancePct: b.distancePct, orWidthPct });
  }

  // Discard confirmed breakouts we can't fully score — names missing the RVOL
  // baseline (no avg-volume data, or no breakout-candle volume). Per 2026-06-02
  // decision: don't trade a name without volume-conviction data rather than rank
  // it neutral. NOTE: if the whole pre-open avg-volume fetch failed, this drops
  // EVERYTHING → no entries this scan (consistent with the regime block — missing
  // data means no trade).
  const preFilter = confirmed.length;
  confirmed = confirmed.filter(b => b.candidate.avgDailyVolume > 0 && b.breakoutVolume > 0);
  if (confirmed.length < preFilter) {
    console.log(`${LOG} [BREAKOUT] Dropped ${preFilter - confirmed.length}/${preFilter} confirmed — missing RVOL baseline (no avg/breakout volume)`);
  }
  if (!confirmed.length) {
    console.warn(`${LOG} [BREAKOUT] No confirmed breakouts with RVOL data — no entries this scan`);
    if (doc.isModified()) await doc.save();
    return { skipped: true, reason: 'no_rvol_data' };
  }

  confirmed.sort((a, b) => b.score - a.score);

  // ── Apply the distance floor + regime direction gate + slots (pure helper) ──
  // slotsLeft is the SMALLER of the day's remaining budget and the per-scan cap, so
  // entries spread across the morning instead of all filling at the 10:01 scan.
  const slotsLeft = Math.min(MAX_ENTRIES - dayEntries, MAX_ENTRIES_PER_SCAN);
  const { gateSide } = decideBreakoutActions({
    confirmed,
    slotsLeft,
    marketRegime: regimeInfo.regime,
  });
  console.log(`${LOG} [BREAKOUT] 📊 Regime ${regimeInfo.regime} → direction gate: ${gateSide || 'BOTH (neutral)'}  slots this scan=${slotsLeft} (day ${dayEntries}/${MAX_ENTRIES})`);

  console.log(`${LOG} [BREAKOUT] Ranked 2-bar confirmed breakouts:`);
  confirmed.forEach((b, idx) => {
    const dirTag     = b.direction === 'LONG' ? 'L' : 'S';
    const orRangePct = (b.candidate.orRange / b.candidate.iep * 100).toFixed(2);
    const actionTag  = {
      ENTER:       '✅ ENTERING',
      SLOT_FULL:   '⏸  slot full',
      LOW_RVOL:    `⏭  rvol<${RVOL_ENTRY_MIN}× — thin volume`,
      BELOW_FLOOR: `⏭  dist<${MIN_DISTANCE_PCT}% — below floor`,
      WRONG_SIDE:  `⏭  regime=${regimeInfo.regime} — wrong side`,
    }[b._action] || '?';
    console.log(
      `${LOG} [BREAKOUT]   #${String(idx + 1).padStart(2)} ${dirTag} ${b.candidate.symbol.padEnd(14)} ` +
      `OR=₹${b.candidate.orLow}–₹${b.candidate.orHigh} (${orRangePct}%)  ` +
      `dist=${b.distancePct.toFixed(2)}%  rvol=${(b.rvol ?? 1).toFixed(2)}x[${b.rvolBasis || 'none'}]  ` +
      `relStr=${(b.relStrength ?? 0) >= 0 ? '+' : ''}${(b.relStrength ?? 0).toFixed(2)}%  ` +
      `score=${(b.score ?? 0).toFixed(3)}  → ${actionTag}`
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

  // ── Capital allocation ──────────────────────────────────────────────────
  // 2026-06-05: Two fixes here:
  //   1. Use balance.usableIntraday (MIS 5x leverage applied) instead of
  //      balance.available (cash only). For an MIS strategy, the real buying
  //      power is the leveraged figure — using cash starves every trade.
  //      Today: ₹45k cash → ₹2.5k/trade (silent skip).
  //              ₹90k intraday × 8 slots → ₹10k/trade (entry fires cleanly).
  //   2. Mirror the skip warning to stdout (console.log) as well as stderr
  //      (console.warn). The user's -out.log only captures stdout, so the
  //      original warn-only message went unseen for the entire trading day.
  let capitalPerTrade = MIN_CAPITAL_PER_TRADE;
  try {
    const balance = await kiteOrderService.getAvailableBalance();
    // usableIntraday already has 5x leverage applied (rawIntraday - pending).
    // Fall back to .available if the field is missing (older balance shape).
    const buyingPower = balance.usableIntraday ?? balance.available;
    const orbBudget   = buyingPower * ORB_CAPITAL_PCT;
    const slotsForCap = MAX_ENTRIES - dayEntries;
    capitalPerTrade   = Math.floor(orbBudget / Math.max(slotsForCap, 1));
    console.log(`${LOG} [BREAKOUT] Capital — cash=₹${balance.available} intraday(5x)=₹${balance.usableIntraday}  ORB budget (${ORB_CAPITAL_PCT*100}%)=₹${Math.round(orbBudget)}  per-trade=₹${capitalPerTrade} (${slotsForCap} slots left of ${MAX_ENTRIES})`);
    if (capitalPerTrade < MIN_CAPITAL_PER_TRADE) {
      const needed = MAX_ENTRIES * MIN_CAPITAL_PER_TRADE / ORB_CAPITAL_PCT;
      const msg = `⚠ per-trade capital ₹${capitalPerTrade} < floor ₹${MIN_CAPITAL_PER_TRADE} — skipping entries. Need intraday buying power ≥ ₹${Math.ceil(needed)} (MAX_ENTRIES=${MAX_ENTRIES} × MIN_CAPITAL=${MIN_CAPITAL_PER_TRADE} / ORB_CAPITAL_PCT=${ORB_CAPITAL_PCT}), currently ₹${balance.usableIntraday}.`;
      console.warn(`${LOG} [BREAKOUT] ${msg}`);
      console.log(`${LOG} [BREAKOUT] ${msg}`);   // mirror to stdout
      return { skipped: true, reason: 'insufficient_capital', capitalPerTrade };
    }
  } catch (err) {
    console.error(`${LOG} [BREAKOUT] Balance fetch failed — using floor ₹${capitalPerTrade}: ${err.message}`);
  }

  // Execute entries
  let entered = 0;
  for (const b of confirmed) {
    if (b._action !== 'ENTER') continue;
    // enterTrade increments doc.entriesCount on a successful fill, so this guard
    // tracks the cumulative day count as we place entries within this scan.
    if ((doc.entriesCount || 0) >= MAX_ENTRIES) break;
    b.candidate.direction   = b.direction;
    b.candidate.rvol        = b.rvol;
    b.candidate.relStrength = b.relStrength;
    b.candidate.rankScore   = b.score;
    const liveLtp = currentLtps[`NSE:${b.candidate.symbol}`]?.last_price || b.bar2Close;
    await enterTrade(doc, b.candidate, liveLtp, capitalPerTrade);
    // 2026-06-09: only count actually-filled entries. SKIPPED candidates (MIS-blocked,
    // entry rejected, etc.) shouldn't appear in the "entered=N this run" tally —
    // the old behaviour misleadingly reported entered=1 for HFCL on 2026-06-09
    // when the broker had no position.
    if (b.candidate.status === 'ENTERED') entered++;
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

  // SL: tighter of the OR-edge stop and a MAX_SL_PCT risk cap (see computeOrbStop).
  // Decouples 1R from the OR boundary so an extended fill can't create oversized risk.
  const { stop: computedStop, effectiveBuf, source: stopSource } = computeOrbStop({
    isLong, orHigh: candidate.orHigh, orLow: candidate.orLow, orRange: candidate.orRange, entry: ltp,
  });
  let stop = computedStop;

  // NO target order in SIMPLE MODE — let winners ride to 15:15.
  const target = null;

  console.log(`${LOG} [ENTER] ─── ${candidate.symbol} [${dirTag}] ───────────────────────`);
  console.log(`${LOG} [ENTER] ${candidate.symbol}: capital=₹${capitalPerTrade}  LTP≈₹${ltp}  qty=${qty}`);
  console.log(`${LOG} [ENTER] ${candidate.symbol}: stop=₹${stop} [${stopSource}]  (buffer ₹${effectiveBuf.toFixed(2)}, OR range ₹${candidate.orRange.toFixed(2)})  target=NONE (ride to 15:15)`);
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
    const errMsg = err?.response?.data?.message || err?.message || String(err);
    // 2026-06-09 — HFCL was rejected with "MIS orders are currently blocked for HFCL.
    // Place a CNC order instead." Zerodha temporarily blocks MIS on certain stocks
    // (corporate action, F&O ban list, etc.). Log it grep-ably so it's not buried.
    if (/MIS orders are currently blocked/i.test(errMsg)) {
      console.warn(`${LOG} [ENTER] ${candidate.symbol}: ⏭ MIS-BLOCKED by broker — skipping symbol (slot NOT consumed). Msg: ${errMsg}`);
      candidate.status     = 'SKIPPED';
      candidate.skipReason = 'mis_blocked_by_broker';
      return;
    }
    console.error(`${LOG} [ENTER] ${candidate.symbol}: ❌ entry order FAILED:`, errMsg);
    candidate.status     = 'SKIPPED';
    candidate.skipReason = `entry_failed: ${errMsg}`;
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
      // Pass the full err — parseKiteTickError digs into err.response.data.message
      // (Kite's actual error) instead of err.message (axios generic).
      const tick = parseKiteTickError(err);
      if (tick && attempt === 1) {
        // Re-snap the CURRENT calculated stop (which has the 1% buffer applied),
        // NOT the raw OR boundary. Old code re-snapped from orLow/orHigh which
        // discarded the buffer and put the SL right at the boundary.
        const oldStop = stop;
        stop = isLong
          ? snapToNSETick(stop, tick, 'floor')
          : snapToNSETick(stop, tick, 'ceil');
        candidate.stopPrice = stop;
        console.warn(`${LOG} [ENTER] ${candidate.symbol}: Kite tick error (broker tick=${tick}) → re-snapped stop ₹${oldStop} → ₹${stop}  retrying...`);
      } else {
        const kiteMsg = err?.response?.data?.message || err.message;
        console.error(`${LOG} [ENTER] ${candidate.symbol}: ❌ SL-M attempt ${attempt} FAILED: ${kiteMsg}`);
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
  const armed   = doc.candidates.filter(c => c.status === 'ARMED');
  if (!entered.length && !armed.length) {
    // Per-minute cadence (2026-06-12): only log the idle no-op every 5th minute
    // so the log doesn't gain ~350 useless lines a day.
    if (new Date().getMinutes() % 5 === 0) {
      console.log(`${LOG} [MONITOR] [${istTimeStr()}] No open positions or armed entries`);
    }
    return { active: 0, exited: 0 };
  }

  const ist          = MarketHoursUtil.toIST(new Date());
  const istMin       = ist.getHours() * 60 + ist.getMinutes();

  // ── PAPER MODE: ARMED entry-order servicing (2026-06-11) ──────────────────
  // Resting SL-M entries placed at 09:24. Each cycle: fill → ENTERED + protective
  // SL; reject/cancel → SKIPPED; still unfilled at 15:00 → cancel (no fresh entry
  // that close to the 15:15 flat). Runs before position monitoring so a fill is
  // protected within one cycle (≤5 min exposure between exchange fill and SL).
  let armedFilled = 0;
  for (const c of armed) {
    if (!c.entryOrderId) { c.status = 'SKIPPED'; c.skipReason = 'armed_without_order_id'; continue; }
    try {
      const ord = await kiteOrderService.getOrderDetails(c.entryOrderId);
      const st  = ord?.status;
      if (st === 'COMPLETE') {
        c.entryPrice = ord.average_price || c.orHigh;
        c.qty        = Number(ord.filled_quantity || c.qty);
        c.entryTime  = new Date();
        c.status     = 'ENTERED';
        doc.entriesCount = (doc.entriesCount || 0) + 1;
        console.log(`${LOG} [MONITOR] 🔫 ${c.symbol} [${c.direction}] ENTRY TRIGGERED @ ₹${c.entryPrice} qty=${c.qty} — placing protective SL`);
        const slOk = await placePaperProtectiveStop(doc, c, '[MONITOR]');
        armedFilled++;
        await logStage('fill', slOk, { symbol: c.symbol, direction: c.direction, entry: c.entryPrice, qty: c.qty, stop: c.stopPrice, slPlaced: slOk });
      } else if (st === 'REJECTED' || st === 'CANCELLED') {
        c.status = 'SKIPPED'; c.skipReason = `paper_entry_${st.toLowerCase()}: ${ord?.status_message || ''}`;
        console.warn(`${LOG} [MONITOR] ${c.symbol}: armed entry ${st} — ${ord?.status_message || 'no reason given'}`);
      } else if (istMin >= PAPER_ENTRY_CUTOFF_MIN) {
        try { await kiteOrderService.cancelOrder(c.entryOrderId); } catch (_) {}
        c.status = 'SKIPPED'; c.skipReason = 'unfilled_at_entry_cutoff_15:00';
        console.log(`${LOG} [MONITOR] ${c.symbol}: armed entry unfilled at 15:00 cutoff — cancelled`);
      }
    } catch (err) {
      console.error(`${LOG} [MONITOR] ${c.symbol}: armed-order status check failed: ${err.message}`);
    }
  }
  if (armedFilled || doc.isModified()) await doc.save();
  // 10:30 TIME EXIT is DISABLED by default (2026-05-25 change). Re-enable via
  // env if needed for testing. When disabled, the monitor falls through to BE
  // trail + candle-structure tighten and lets winners ride until 15:15.
  // RETIRED 2026-06-11 (paper cutover, no flags): 10:30 time-exit permanently off —
  // paper exits are stop-hit or 15:15 only.
  const timeExitEnabled = LEGACY_ENGINE;
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

  // ── Pre-fetch 5-min + 15-min bars for ALL entered positions ────────────────
  // 2026-06-05 evening: BE-trail now uses ATR-cushioned BE move (computeBeStop)
  // so it needs 5-min ATR. Doing the fetch once upfront lets both the BE-trail
  // block (below) and the candle-analysis block (further down) reuse the same
  // data — no duplicate Kite calls. If the fetch fails, BE-trail falls back to
  // pct-only cushion (atr=0) and candle-analysis skips structure check.
  let preCandles5m  = {};
  let preCandles15m = {};
  // RETIRED 2026-06-11: candle prefetch only served the BE-trail and candle-exit
  // engines, both dead-gated — skipping it saves the heaviest per-cycle Kite calls.
  if (LEGACY_ENGINE && entered.length) {
    try {
      const multi = await kiteOrderService.getIntradayMultiCandles(
        entered.map(c => c.symbol),
        [
          { interval: '5minute',  count: 90 },   // 90 × 5m = full session for VWAP / ATR(14)
          { interval: '15minute', count: 4 },    // 4 × 15m for structure-exit check
        ]
      );
      preCandles5m  = multi['5minute']  || {};
      preCandles15m = multi['15minute'] || {};
    } catch (err) {
      console.error(`${LOG} [MONITOR] ⚠ pre-fetch candles failed (${err.message}) — BE-trail will use pct-only cushion, candle-analysis will skip`);
    }
  }

  for (const c of entered) {
    const ltp = ltpData[`NSE:${c.symbol}`]?.last_price;
    console.log(`${LOG} [MONITOR] ── ${c.symbol} ──────────────────────────`);
    console.log(`${LOG} [MONITOR]   entry=₹${c.entryPrice}  stop=₹${c.stopPrice}  target=₹${c.targetPrice}  LTP=${ltp ? `₹${ltp}` : 'N/A'}`);
    console.log(`${LOG} [MONITOR]   SL orderId=${c.stopOrderId || 'none'}  TGT orderId=${c.targetOrderId || 'none'}  beTrailed=${c.beTrailed || false}`);

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
        await bookAlreadyClosedPnl(c, '[MONITOR]');
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

    // ── Breakeven trail — RE-ENABLED 2026-06-11 (BE-at-+1R, one-time) ────────
    // History: disabled 2026-06-05 ("let it be the original stoploss") because the
    // candle-tighten engine was bleeding winners and SL modifies caused Kite-reject
    // bugs. Re-enabled per design discussion 2026-06-11: with no profit target and
    // ride-to-15:15, a static 1.5%-wide SL means winners decay back into time-exits
    // while losers reliably pay −1R — negative asymmetry by construction. The
    // Zarattini EOD-exit result only holds with risk removed/tiny. ONE move only:
    //   at +1R unrealised → SL to cushioned BE (computeBeStop: entry ± max(0.3%,
    //   0.5×ATR_5m)) via cancel+replace. After that the SL never moves again —
    //   candle trail/tighten stays DISABLED (the 2026-06-05 finding stands).
    // Differences vs the old commented block:
    //   • c.beTrailed is now a PERSISTED schema field (the old `_beTrailed` was
    //     transient — reset every 5-min cycle → would re-place the same SL forever).
    //   (2026-06-11 later: dead-gated by LEGACY_ENGINE — paper spec never moves the SL.)
    // RETIRED 2026-06-11 (paper cutover, no flags): no BE move — the paper never
    // modifies its stop, and with a 0.1×ATR stop the BE cushion (≥0.3%) would sit
    // WIDER than the stop itself. Block kept (dead-gated) for reference.
    const beTrailEnabled = LEGACY_ENGINE;
    if (beTrailEnabled && c.status === 'ENTERED' && c.stopOrderId && !c.beTrailed) {
      const risk        = cIsLong ? (c.entryPrice - c.stopPrice) : (c.stopPrice - c.entryPrice);
      const currentGain = ltp ? (cIsLong ? (ltp - c.entryPrice) : (c.entryPrice - ltp)) : null;
      if (ltp) {
        console.log(`${LOG} [MONITOR]   BE trail check [${cIsLong ? 'LONG' : 'SHORT'}]: risk=₹${risk.toFixed(2)}  current gain=₹${currentGain?.toFixed(2)}  need ₹${risk.toFixed(2)} for 1R`);
      }
      if (ltp && risk > 0 && currentGain != null && currentGain >= risk) {
        const sym5mBars = preCandles5m[c.symbol] || [];
        const atr5m     = computeATR(sym5mBars, 14);
        const beStopRaw = computeBeStop({ entry: c.entryPrice, isLong: cIsLong, atr5m });
        const beStop    = snapToNSETick(beStopRaw, 0.05, cIsLong ? 'floor' : 'ceil');
        const exitSide  = cIsLong ? 'SELL' : 'BUY';
        const cushionPct = Math.abs((c.entryPrice - beStop) / c.entryPrice * 100);
        console.log(`${LOG} [MONITOR]   1R achieved → moving stop to BE cushioned=₹${beStop} (atr5m=₹${atr5m.toFixed(2)}, cushion=${cushionPct.toFixed(2)}% from entry ₹${c.entryPrice}) via cancel+replace`);
        const replaceRes = await replaceSlOrderWithNewTrigger({
          candidate:  c,
          newTrigger: beStop,
          exitSide,
          logTag:     '[MONITOR]',
        });
        if (replaceRes.success) {
          c.beTrailed = true;
          console.log(`${LOG} [MONITOR]   ✅ ${c.symbol} [${cIsLong ? 'LONG' : 'SHORT'}] BE trail complete — new SL ${replaceRes.newOrderId} @ ₹${beStop} (one-time; SL frozen here until exit)`);
          changed = true;
        } else if (replaceRes.exited) {
          exitedThisRun++;
          changed = true;
        }
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
  // RETIRED 2026-06-11 (paper cutover, no flags): the entire candle-analysis
  // engine (RSI-exhaustion, VWAP reversal, 15-min structure break, sideways cut,
  // candle-shape tighten) is permanently dead-gated — paper exits are stop-hit
  // or 15:15, nothing else. Block kept below for reference only.
  if (stillEntered.length) {
    console.log(`${LOG} [CANDLE] retired — positions ride to stop or 15:15 (paper spec)`);
  }
  if (LEGACY_ENGINE && stillEntered.length) {
    const candleSymbols = stillEntered.map(c => c.symbol);
    console.log(`${LOG} [CANDLE] ── Candle analysis [${istTimeStr()}] ──────────────────`);
    // 2026-06-05: reuse pre-fetched 5m/15m bars from the BE-trail block above
    // (saves a duplicate batched Kite call). Only re-fetch for symbols missing
    // from the pre-fetch (e.g. a position was added in the BE block? unlikely
    // but safe).
    let candles5m  = preCandles5m  || {};
    let candles15m = preCandles15m || {};
    const missing  = candleSymbols.filter(s => !candles5m[s] || !candles15m[s]);
    if (missing.length) {
      console.log(`${LOG} [CANDLE] Re-fetching candles for ${missing.length} missing symbols: ${missing.join(', ')}`);
    try {
      // 5-min count 90 = the whole session, so per-stock cumulative VWAP is correct
      // (computeVwap needs every bar since 09:15). analyzeIntradayStructure only
      // looks at the last few bars, so we hand it sym5m.slice(-6) below.
      const multi = await kiteOrderService.getIntradayMultiCandles(missing, [
        { interval: '5minute',  count: 90 },
        { interval: '15minute', count: 4 },
      ]);
      Object.assign(candles5m,  multi['5minute']  || {});
      Object.assign(candles15m, multi['15minute'] || {});
    } catch (e) {
      console.error(`${LOG} [CANDLE] missing-symbol candle fetch failed: ${e.message}`);
    }
    } else {
      console.log(`${LOG} [CANDLE] Using pre-fetched bars for ${candleSymbols.length} symbols (no extra Kite call)`);
    }

    // Live Nifty regime, computed once for this monitor run (used for regime-flip exit).
    const monitorRegime = await getMarketRegime();
    // Append to the queryable regime trail and force a save this cycle so it persists.
    doc.regimeHistory = doc.regimeHistory || [];
    doc.regimeHistory.push({ t: new Date(), regime: monitorRegime.regime || 'UNKNOWN', niftyLtp: monitorRegime.niftyLtp ?? null, src: 'monitor' });
    changed = true;

    for (const c of stillEntered) {
      const sym5m  = candles5m[c.symbol]  || [];
      const sym15m = candles15m[c.symbol] || [];
      const ltp    = ltpData[`NSE:${c.symbol}`]?.last_price;
      // Direction-aware helpers for this candidate's candle/exit logic
      const cIsLong   = (c.direction || 'LONG') === 'LONG';
      const cExitSide = cIsLong ? 'SELL' : 'BUY';
      const cDirTag   = cIsLong ? 'LONG' : 'SHORT';

      console.log(`${LOG} [CANDLE] ${c.symbol} [${cDirTag}]: 5m_bars=${sym5m.length}  15m_bars=${sym15m.length}  stop=₹${c.stopPrice}  beTrailed=${!!c._beTrailed}`);

      // ── RSI-exhaustion exit (2026-06-05 evening) ─────────────────────────────
      // Dual-condition gate on 5-min RSI(14) + its 14-period SMA:
      //   ARM:  RSI has closed ≥80 (LONG) / ≤20 (SHORT) at any point in session history
      //   FIRE: latest RSI is < 70 AND < its SMA (LONG; mirror for SHORT)
      // When fired → cancel SL + market exit. The original SL is NOT modified.
      // Born from LTF 2026-06-05: entered ₹275.80, 5-min RSI peaked ≥80 at the
      // ₹277 top, drifted back to ₹270 — would have captured +₹4-7/share vs ₹0.
      if (sym5m.length >= RSI_PERIOD + RSI_MA_PERIOD) {
        const closes = sym5m.map(b => b.close).filter(Number.isFinite);
        const rsiDecision = decideRsiExhaustionExit({ closes, isLong: cIsLong });
        console.log(`${LOG} [CANDLE] ${c.symbol}: RSI exit check — ${rsiDecision.reason}`);
        if (rsiDecision.exit) {
          console.log(`${LOG} [CANDLE] ${c.symbol}: 🛎 RSI EXHAUSTION EXIT — cancel SL + market ${cExitSide}`);
          if (c.stopOrderId)   { try { await kiteOrderService.cancelOrder(c.stopOrderId);   } catch (_) {} }
          if (c.targetOrderId) { try { await kiteOrderService.cancelOrder(c.targetOrderId); } catch (_) {} }
          await delay(500);
          // 2026-05-26 safety: verify broker has the position before placing exit.
          const actualQty = await getActualPositionQty(c.symbol);
          if (actualQty === 0) {
            console.log(`${LOG} [CANDLE]   ⚠ ${c.symbol}: broker position=0 — skipping RSI exit (already closed externally)`);
            c.status     = 'TIME_EXIT';
            c.exitReason = 'already_closed_externally';
            await bookAlreadyClosedPnl(c, '[CANDLE]');
            changed = true;
            continue;
          }
          if (actualQty !== null && (cIsLong ? actualQty <= 0 : actualQty >= 0)) {
            console.error(`${LOG} [CANDLE]   ⚠⚠ ${c.symbol}: broker qty=${actualQty} but direction=${cDirTag} — mismatch, skipping`);
            c.status     = 'TIME_EXIT';
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
              simulationId:     `orb_rsi_exit_${c.symbol}`,
              orderType:        'ORB_RSI_EXHAUSTION_EXIT',
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
              c.exitReason = `rsi_exhaustion: lastRsi=${rsiDecision.lastRsi?.toFixed(1)} lastMA=${rsiDecision.lastMA?.toFixed(1)}`;
              const pnlDir = cIsLong ? (exitPrice - c.entryPrice) : (c.entryPrice - exitPrice);
              c.pnl        = parseFloat((pnlDir * c.qty).toFixed(2));
              c.returnPct  = parseFloat((pnlDir / c.entryPrice * 100).toFixed(2));
              console.log(`${LOG} [CANDLE] ✅ ${c.symbol} [${cDirTag}] RSI exhaustion exit @ ₹${exitPrice}  PnL=₹${c.pnl >= 0 ? '+' : ''}${c.pnl} (${c.returnPct >= 0 ? '+' : ''}${c.returnPct}%)`);
              changed = true;
            }
          } catch (err) {
            console.error(`${LOG} [CANDLE] ${c.symbol}: RSI exit order FAILED:`, err.message);
          }
          continue;
        }
      }

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
            await bookAlreadyClosedPnl(c, '[CANDLE]');
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
        candles5m:   sym5m.slice(-6),  // structure logic only needs the recent bars
        candles15m:  sym15m,
        direction:   cDirTag,         // 'LONG' or 'SHORT' — symmetric patterns
        currentStop: c.stopPrice,
        // R-cushion context — see analyzeIntradayStructure docstring.
        entryPrice:  c.entryPrice,
        plannedStop: c.originalStop ?? c.stopPrice,
      });

      console.log(`${LOG} [CANDLE] ${c.symbol} [${cDirTag}]: action=${decision.action}${decision.newStop ? `  newStop=₹${decision.newStop}` : ''}`);
      console.log(`${LOG} [CANDLE] ${c.symbol}:   ${decision.reason}`);

      // ── VWAP reversal exit + Nifty regime-flip exit (2026-06-02) ──────────────
      // (a) Per-stock VWAP: the stock has real volume, so compute its own cumulative
      //     VWAP from the full session bars; 2 consecutive 5-min closes on the wrong
      //     side (below for LONG, above for SHORT) = flow flipped → exit. This is the
      //     "it ran then reversed" protection, using the live-proven daily-picks logic.
      // (b) Nifty regime flip: if the index has crossed to the opposite regime, the
      //     market turned against the position → exit.
      // Either one overrides the structure decision into an immediate exit, reusing
      // the safe broker-checked exit block below.
      if (sym5m.length >= 2) {
        const latestBar     = sym5m[sym5m.length - 1];
        const latestBarTime = latestBar.date ? String(latestBar.date) : null;
        const vwapState     = computeVwap(sym5m);
        c.vwapLast = vwapState.vwap;
        // Per-bar dedup: only advance the consecutive-wrong-side counter once per
        // NEW 5-min bar. The monitor can fire more than once within a bar (manual
        // trigger / retry / overlap); without this the same close would be counted
        // twice and could fire a spurious "2 consecutive" exit.
        const isNewBar = latestBarTime && latestBarTime !== c.vwapLastBarTime;
        if (isNewBar) {
          const vwapRes = evaluateVwapExit({
            direction:      cDirTag,
            latestClose:    latestBar.close,
            vwap:           vwapState.vwap,
            consecutiveOpp: c.vwapConsecutiveOpp || 0,
          });
          c.vwapConsecutiveOpp = vwapRes.consecutiveOpp;
          c.vwapLastBarTime    = latestBarTime;
          console.log(`${LOG} [CANDLE] ${c.symbol}: VWAP=${vwapState.vwap != null ? '₹' + vwapState.vwap.toFixed(2) : 'n/a'}  close=₹${latestBar.close}  side=${vwapRes.side}  consecOpp=${vwapRes.consecutiveOpp}  vwapExit=${vwapRes.exit}`);
          if (vwapRes.exit && decision.action !== 'exit') {
            decision.action = 'exit';
            decision.reason = `vwap_reversal: ${vwapRes.reason}`;
          }
        } else {
          console.log(`${LOG} [CANDLE] ${c.symbol}: VWAP=${vwapState.vwap != null ? '₹' + vwapState.vwap.toFixed(2) : 'n/a'}  (same bar — counter held at ${c.vwapConsecutiveOpp || 0})`);
        }
      }
      const regimeAgainst = (monitorRegime.regime === 'BULL' && !cIsLong) ||
                            (monitorRegime.regime === 'BEAR' &&  cIsLong);
      if (regimeAgainst && decision.action !== 'exit') {
        console.log(`${LOG} [CANDLE] ${c.symbol}: ⚠ Nifty regime ${monitorRegime.regime} flipped against ${cDirTag} → exit`);
        decision.action = 'exit';
        decision.reason = `regime_flip_exit: nifty_${monitorRegime.regime}`;
      }

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
          await bookAlreadyClosedPnl(c, '[CANDLE]');
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
        // ── Trail/tighten DISABLED 2026-06-05 evening — BE-only mode ──────────
        // After 2026-06-05 (8 trades, -₹417), data showed candle-based trail/
        // tighten was the dominant loss driver: 6 trades killed within 5-20 min
        // of entry by trail-placing-SL-too-close-to-LTP. BAJFINANCE: tightened
        // to ₹906 at +₹82 unrealised, hit at ₹905.60 for +₹40.
        //
        // Per Bandy ("Quantitative Technical Analysis") and Douglas ("Trading
        // in the Zone"): the simplest rule — BE-cushioned at +1R then hold —
        // outperformed every adaptive trail in their backtests.
        //
        // We now ignore trail/tighten decisions. The cushioned BE move at +1R
        // (computeBeStop, in the MONITOR loop above) handles risk-removal.
        // The 'exit' branch above (confirmed 2-bar structure break) STAYS
        // active for genuine structural exits.
        console.log(`${LOG} [CANDLE] ${c.symbol}: [BE-only] ignoring ${decision.action} → newStop=₹${decision.newStop} (mode disabled — SL holds at ₹${c.stopPrice} until structure exit / 15:15)`);
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

  // Safety net: deal with any entry order still ARMED at 15:15 (the monitor's
  // 15:00 cutoff should have caught these). FILL-AWARE (2026-06-11 audit fix):
  // an order that triggered after the last monitor cycle is a REAL POSITION —
  // blindly cancelling and marking SKIPPED would leave it open past the flat
  // with no SL. Check status first: COMPLETE → promote to ENTERED so the flat
  // loop below closes it; otherwise cancel the resting order.
  const armedLeft = doc.candidates.filter(c => c.status === 'ARMED');
  for (const c of armedLeft) {
    let filled = false;
    try {
      const ord = c.entryOrderId ? await kiteOrderService.getOrderDetails(c.entryOrderId) : null;
      if (ord?.status === 'COMPLETE') {
        c.entryPrice = ord.average_price || c.orHigh;
        c.qty        = Number(ord.filled_quantity || c.qty);
        c.entryTime  = c.entryTime || new Date();
        c.status     = 'ENTERED';
        doc.entriesCount = (doc.entriesCount || 0) + 1;
        filled = true;
        console.warn(`${LOG} [FORCE-EXIT] ${c.symbol}: armed entry had FILLED @ ₹${c.entryPrice} — promoted to ENTERED for flat`);
      }
    } catch (err) {
      console.error(`${LOG} [FORCE-EXIT] ${c.symbol}: armed-order status check failed (${err.message}) — attempting cancel`);
    }
    if (!filled) {
      try { if (c.entryOrderId) await kiteOrderService.cancelOrder(c.entryOrderId); } catch (_) {}
      c.status = 'SKIPPED'; c.skipReason = 'unfilled_at_force_exit';
      console.log(`${LOG} [FORCE-EXIT] ${c.symbol}: cancelled still-armed entry order`);
    }
  }
  if (armedLeft.length) await doc.save();

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
      c.exitReason = 'already_closed_externally';
      await bookAlreadyClosedPnl(c, '[FORCE-EXIT]');   // recover realised P&L instead of booking 0
      console.log(`${LOG} [FORCE-EXIT]   ${c.symbol}: marked TIME_EXIT (already closed; P&L=₹${c.pnl})`);
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

  await logStage('force-exit', true, { exited, totalPnl: doc.totalPnl, entriesCount: doc.entriesCount });
  return { exited };
}
