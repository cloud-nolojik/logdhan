/**
 * Pre-open Depth Analyzer
 *
 * Takes a Kite /quote response for a single candidate and computes:
 *   - imbalance      = total_buy_qty / total_ask_qty   (>1 LONG-biased)
 *   - mid_pct        = (weighted_mid - prev_close) / prev_close × 100
 *   - liquidity      = total_buy_qty + total_sell_qty  (drop if < floor)
 *   - spread_pct     = (best_ask - best_bid) / best_bid × 100
 *   - score          ∈ [-1, +1] — direction-aware combined signal
 *   - status         — one of: 'kept', 'dropped_preopen_thin',
 *                              'dropped_preopen_imbalance',
 *                              'dropped_preopen_wide_spread',
 *                              'dropped_preopen_no_quote'
 *
 * Applied per-candidate in preopenDepthJob; the caller decides what to do with
 * candidates marked 'dropped_*' (typically: remove from DailyPick.picks[]).
 */

const LOG = '[PREOPEN-ANALYZER]';

// Tunables — one place to adjust thresholds.
export const THRESHOLDS = Object.freeze({
  /**
   * Minimum total pre-open book depth in rupee value.
   *
   * Old: MIN_LIQUIDITY_QTY = 1000 shares — not price-normalised. For a ₹600
   * stock 1000 shares = ₹6L depth (reasonable); for a ₹50 PSU it's ₹50K
   * (genuinely thin). Expert-calibrated April 2026: switch to rupee value.
   *
   * ₹10L floor = absolute minimum. Even for small positions you want enough
   * book depth that entry + stop + any co-running algo don't move the price.
   *
   * If prevClose is unavailable the check falls back to a 1000-share count
   * guard (legacy behavior) to avoid false-passes on missing data.
   */
  MIN_DEPTH_VALUE_RUPEES: 10_00_000, // ₹10 lakh total pre-open depth
  MAX_SPREAD_PCT:       0.50,   // top-of-book spread %, above = drop
  IMBALANCE_LONG_MIN:   0.60,   // LONG requires imbalance >= this (else drop)
  IMBALANCE_SHORT_MAX:  1.67,   // SHORT requires imbalance <= this (i.e. 1/0.60)
  // Score component weights (sum must be 1.0)
  W_IMBALANCE:          0.45,
  W_MID_PCT:            0.30,
  W_LIQUIDITY:          0.15,
  W_SPREAD:             0.10,
  // Normalization bands
  IMBALANCE_BAND:       3.0,    // imbalance=3 (or 1/3) → ±1
  MID_PCT_BAND:         1.0,    // ±1% gap → ±1
  LIQUIDITY_BAND:       10000,  // total qty of 10k → +1
  SPREAD_BAND:          0.50,   // 0.5% spread → score 0, 0% spread → +1
});

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

/**
 * Sum quantities across bid or ask depth levels (filter zeros).
 */
function sumDepth(levels) {
  if (!Array.isArray(levels)) return 0;
  return levels.reduce((s, l) => s + (Number(l?.quantity) || 0), 0);
}

/**
 * Volume-weighted mid across top-5 levels (returns NaN if empty).
 */
function weightedMid(bids, asks) {
  const valueAndQty = (levels) => {
    let value = 0, qty = 0;
    if (!Array.isArray(levels)) return { value, qty };
    for (const l of levels) {
      const p = Number(l?.price) || 0;
      const q = Number(l?.quantity) || 0;
      if (p > 0 && q > 0) { value += p * q; qty += q; }
    }
    return { value, qty };
  };
  const b = valueAndQty(bids);
  const a = valueAndQty(asks);
  const totalQty = b.qty + a.qty;
  if (totalQty === 0) return NaN;
  return (b.value + a.value) / totalQty;
}

/**
 * Analyze a single candidate's pre-open quote.
 *
 * @param {Object} candidate     — from ShortlistWatchlist.candidates
 * @param {Object} quote         — Kite /quote response for this candidate (or null)
 * @param {number} prevClose     — yesterday's close (for gap computation)
 * @returns {Object}             — { imbalance, mid_pct, liquidity, spread_pct, score, status }
 */
export function analyzeOne(candidate, quote, prevClose) {
  // No quote at all — most likely the symbol is delisted or was typo'd.
  if (!quote || !quote.depth) {
    return {
      imbalance: null, mid_pct: null, liquidity: null, spread_pct: null,
      score: null, status: 'dropped_preopen_no_quote'
    };
  }

  const direction = candidate.direction;
  const bids = quote.depth.buy || [];
  const asks = quote.depth.sell || [];

  // Prefer exchange-wide aggregate pending qty if present; fall back to top-5 sum.
  const totalBuy  = (typeof quote.buy_quantity  === 'number' && quote.buy_quantity  > 0)
                    ? quote.buy_quantity  : sumDepth(bids);
  const totalSell = (typeof quote.sell_quantity === 'number' && quote.sell_quantity > 0)
                    ? quote.sell_quantity : sumDepth(asks);
  const liquidity = totalBuy + totalSell;

  // Imbalance — guard against divide-by-zero.
  const imbalance = totalSell > 0 ? totalBuy / totalSell : (totalBuy > 0 ? 999 : 0);

  // Best-price spread.
  const bestBid = Number(bids?.[0]?.price) || 0;
  const bestAsk = Number(asks?.[0]?.price) || 0;
  const spreadPct = (bestBid > 0 && bestAsk > 0)
    ? ((bestAsk - bestBid) / bestBid) * 100
    : null;

  // IEP proxy — weighted mid across top-5 of both sides.
  const wMid = weightedMid(bids, asks);
  const midPct = (Number.isFinite(wMid) && prevClose > 0)
    ? ((wMid - prevClose) / prevClose) * 100
    : null;

  // ─── Hard drops ───────────────────────────────────────────────────────
  // Thin depth: rupee-normalised. prevClose used as price proxy; falls back
  // to 1000-share legacy guard if price data is unavailable.
  const depthPrice    = prevClose > 0 ? prevClose
                      : (bestBid  > 0 ? bestBid
                      : (bestAsk  > 0 ? bestAsk : 0));
  const depthValueInr = depthPrice > 0 ? liquidity * depthPrice : 0;
  const thinDepth     = depthPrice > 0
    ? depthValueInr < THRESHOLDS.MIN_DEPTH_VALUE_RUPEES
    : liquidity < 1000; // fallback: no price data

  if (thinDepth) {
    return { imbalance, mid_pct: midPct, liquidity,
             depth_value_inr: depthPrice > 0 ? Math.round(depthValueInr) : null,
             spread_pct: spreadPct, score: null, status: 'dropped_preopen_thin' };
  }
  if (spreadPct !== null && spreadPct > THRESHOLDS.MAX_SPREAD_PCT) {
    return { imbalance, mid_pct: midPct, liquidity, spread_pct: spreadPct,
             score: null, status: 'dropped_preopen_wide_spread' };
  }
  if (direction === 'LONG'  && imbalance < THRESHOLDS.IMBALANCE_LONG_MIN)  {
    return { imbalance, mid_pct: midPct, liquidity, spread_pct: spreadPct,
             score: null, status: 'dropped_preopen_imbalance' };
  }
  if (direction === 'SHORT' && imbalance > THRESHOLDS.IMBALANCE_SHORT_MAX) {
    return { imbalance, mid_pct: midPct, liquidity, spread_pct: spreadPct,
             score: null, status: 'dropped_preopen_imbalance' };
  }

  // ─── Score (direction-aware, each component in [-1, +1]) ──────────────
  // Imbalance: normalize log(imbalance) so 3× → +1, 1× → 0, 1/3 → -1
  const imb_norm = clamp(Math.log(Math.max(imbalance, 1e-6)) / Math.log(THRESHOLDS.IMBALANCE_BAND), -1, 1);
  // Mid gap: ±1% → ±1
  const mid_norm = (midPct == null) ? 0 : clamp(midPct / THRESHOLDS.MID_PCT_BAND, -1, 1);
  // Liquidity: more is better, always non-negative
  const liq_norm = clamp(liquidity / THRESHOLDS.LIQUIDITY_BAND, 0, 1);
  // Spread: tighter is better; map 0% → +1, MAX_SPREAD_PCT → 0
  const spr_norm = (spreadPct == null)
    ? 0
    : clamp(1 - (spreadPct / THRESHOLDS.SPREAD_BAND), -1, 1);

  // Flip signs for SHORT so the score is "alignment with trade direction"
  const dirSign = direction === 'SHORT' ? -1 : 1;

  const score = clamp(
    dirSign * THRESHOLDS.W_IMBALANCE * imb_norm +
    dirSign * THRESHOLDS.W_MID_PCT  * mid_norm +
              THRESHOLDS.W_LIQUIDITY * liq_norm +
              THRESHOLDS.W_SPREAD    * spr_norm,
    -1, 1
  );

  return {
    imbalance:       Math.round(imbalance * 1000) / 1000,
    mid_pct:         midPct == null ? null : Math.round(midPct * 100) / 100,
    liquidity,
    depth_value_inr: depthPrice > 0 ? Math.round(depthValueInr) : null,
    spread_pct:      spreadPct == null ? null : Math.round(spreadPct * 1000) / 1000,
    score:           Math.round(score * 1000) / 1000,
    status:          'kept'
  };
}

/**
 * Analyze every candidate in the given list against a keyed quote map.
 *
 * @param {Object[]} candidates   — [{ trading_symbol, direction }, ...]
 * @param {Object} quoteMap       — { 'NSE:SYMBOL': {depth, buy_quantity, ohlc:{close}} }
 * @returns {Map<string, Object>} — symbol → analyzer result
 */
export function analyzeAll(candidates, quoteMap) {
  const out = new Map();
  for (const c of candidates) {
    if (!c?.trading_symbol) continue;
    const key = `NSE:${c.trading_symbol}`;
    const quote = quoteMap[key] || null;
    const prevClose = quote?.ohlc?.close || null;
    out.set(c.trading_symbol, analyzeOne(c, quote, prevClose));
  }
  const kept = [...out.values()].filter(v => v.status === 'kept').length;
  console.log(`${LOG} analyzeAll: ${kept}/${candidates.length} kept`);
  return out;
}

export default { THRESHOLDS, analyzeOne, analyzeAll };
