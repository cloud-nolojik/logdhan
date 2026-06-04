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
import { computeVwap, evaluateVwapExit } from '../dailyPicks/dailyPicksService.js';

const LOG = '[ORB]';

// ── Strategy constants ──────────────────────────────────────────────────────
const MAX_ENTRIES           = 16;     // max TRADES per day (cumulative, LONG + SHORT
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

async function attachVolumeBaselines(candidates, logTag = '[PHASE1]') {
  if (!candidates?.length) return 0;
  const istNowD = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const toD     = new Date(istNowD); toD.setDate(toD.getDate() - 1);   // through yesterday
  const fromD   = new Date(istNowD); fromD.setDate(fromD.getDate() - 30); // ~20 trading days
  const fmt     = d => d.toISOString().slice(0, 10);
  const symbols = candidates.map(c => c.symbol);
  const hist    = await kiteOrderService.getHistoricalCandles(symbols, '15minute', `${fmt(fromD)} 09:15:00`, `${fmt(toD)} 15:30:00`);
  let withProfile = 0;
  for (const c of candidates) {
    const bars    = hist[c.symbol] || [];
    const profile = buildVolumeProfile(bars);
    const slots   = Object.values(profile);
    if (slots.length) {
      c.volumeProfile  = profile;
      c.avgDailyVolume = slots.reduce((a, v) => a + v, 0);   // ≈ avg full-day volume
      withProfile++;
    }
    c.adrPct = computeADRPct(bars, c.iep);   // ADR% — denominator for the OR-width filter
  }
  console.log(`${LOG} ${logTag} RVOL baseline: time-matched volume profile set for ${withProfile}/${candidates.length} symbols`);
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

  // Capital allocation
  let capitalPerTrade = MIN_CAPITAL_PER_TRADE;
  try {
    const balance = await kiteOrderService.getAvailableBalance();
    const orbBudget = balance.available * ORB_CAPITAL_PCT;
    const slotsForCap = MAX_ENTRIES - dayEntries;
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
    // enterTrade increments doc.entriesCount on a successful fill, so this guard
    // tracks the cumulative day count as we place entries within this scan.
    if ((doc.entriesCount || 0) >= MAX_ENTRIES) break;
    b.candidate.direction   = b.direction;
    b.candidate.rvol        = b.rvol;
    b.candidate.relStrength = b.relStrength;
    b.candidate.rankScore   = b.score;
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
        } else if (replaceRes.exited) {
          // SL re-place failed → helper fired an emergency exit AND booked the
          // close on the candidate. Persist it this run.
          exitedThisRun++;
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
    console.log(`${LOG} [CANDLE] Fetching 5-min (full session, for VWAP) + 15-min (4 bars) for: ${candleSymbols.join(', ')}`);

    let candles5m = {}, candles15m = {};
    try {
      // 5-min count 90 = the whole session, so per-stock cumulative VWAP is correct
      // (computeVwap needs every bar since 09:15). analyzeIntradayStructure only
      // looks at the last few bars, so we hand it sym5m.slice(-6) below.
      const multi = await kiteOrderService.getIntradayMultiCandles(candleSymbols, [
        { interval: '5minute',  count: 90 },
        { interval: '15minute', count: 4 },
      ]);
      candles5m  = multi['5minute']  || {};
      candles15m = multi['15minute'] || {};
    } catch (err) {
      console.error(`${LOG} [CANDLE] ❌ Candle fetch FAILED:`, err.message);
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
          } else if (replaceRes.exited) {
            // SL re-place failed → emergency exit fired and was booked on c. Persist.
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

  return { exited };
}
