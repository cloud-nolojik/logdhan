# Regime Redesign v2 — Continuous Regime Score

**Status:** Design spec, not yet implemented
**Scope:** Replaces Step 1 (Market Context Gate) of the Daily Picks pipeline only. Steps 2 through 8 remain unchanged; the contract between Step 1 and Step 2 (the `marketContext` object and its fields) is preserved.
**Author:** Pre-implementation review, April 2026

---

## 1. Why This Change

The current Step 1 produces a regime label by combining two binary signals (Nifty vs EMA50 with a ±0.3% band, and SGX/GIFT Nifty change with a ±0.3% band) into a 6-cell matrix plus a CONFLICT halt. The design is readable and fail-closed, but it has five structural problems that show up in real trading:

1. **Thin structural signal.** A single indicator (Nifty vs EMA50) with a 0.3% deadband flips the regime on noise. The slope of the EMA and the fast-timeframe trend (EMA20) are not used.
2. **Stale and weak sentiment signal.** GIFT Nifty at 8:40 AM is largely reprice of overnight US/Asia moves; it is one of the most mean-reverting signals available and on many days actively misleads.
3. **No volatility input.** Regime at India VIX 11 vs VIX 22 is a materially different market. The current design sizes the same way in both.
4. **No breadth input.** You can be "structurally bullish" by Nifty vs EMA50 while only a handful of stocks hold the index up. Breadth divergence is invisible to the current gate.
5. **Hand-picked thresholds.** The 0.3% / 0.3% thresholds read as intuitive round numbers, not calibrated values. A continuous score is tunable; a discrete matrix is not.

The CONFLICT branch (structure bearish + sentiment bullish → halt) also throws away a real edge: days where overnight froth opens into structural weakness are the textbook environment for gap-fade. Halting on those days is conservative, but the edge is measurable and we should not hand it away without evidence.

---

## 2. New Design in One Page

Compute five continuous inputs, each normalized to [-1, +1]. Blend them into a single **regime score** ∈ [-1, +1]. Map the score magnitude to `maxTrades` and `sizeMultiplier`; map the score sign and inputs to a regime label and an optional **playbook** (e.g. `gap_fade`).

```
         ┌─────────────────────────────┐
         │ 5 normalized inputs         │
         │   structure  ∈ [-1, +1]     │
         │   breadth    ∈ [-1, +1]     │
         │   volatility ∈ [-1, +1]     │
         │   overnight  ∈ [-1, +1]     │
         │   flow       ∈ [-1, +1]     │
         └─────────────┬───────────────┘
                       │  weighted sum (weights sum to 1)
                       ▼
         ┌─────────────────────────────┐
         │   regimeScore ∈ [-1, +1]    │
         └──────┬───────────────┬──────┘
                │               │
                ▼               ▼
       label + playbook   maxTrades + sizeMultiplier
```

All downstream code (Steps 2 onward) continues to consume `marketContext.regime`, `marketContext.max_trades`, and `marketContext.size_multiplier` — same field names, same types. The only net-new field is `marketContext.playbook` (an enum: `standard` | `gap_fade` | `halt`), and that field is opt-in for downstream consumers. This means **zero changes required to scanning, enrichment, scoring, levels, selection, or notification code** in the first cut.

---

## 3. The Five Inputs

Each input is a pure function of its raw data and returns a value in [-1, +1]. Any input that cannot be computed (data source down) returns `null`; the composite formula handles nulls explicitly (see §4).

### 3.1 Structure (weight: 0.30)

**Goal:** Capture the underlying trend of Nifty on multiple timeframes, not just spot position vs one EMA.

**Inputs:** Nifty daily OHLC, EMA20, EMA50, EMA50 five-day slope.

**Formula:**

```
structure_position = clamp((close - ema50) / ema50 / 0.03, -1, +1)
   // ±3% distance from EMA50 maps to ±1. Wider than current 0.3% deadband
   // because 0.3% on Nifty is noise-level.

structure_fast = clamp((close - ema20) / ema20 / 0.02, -1, +1)
   // ±2% distance from EMA20 maps to ±1. Faster EMA, tighter band.

structure_slope = clamp((ema50[t] - ema50[t-5]) / ema50[t-5] / 0.01, -1, +1)
   // 5-day EMA50 slope. ±1% slope over 5 days maps to ±1.

structure_raw = 0.40 * structure_position
              + 0.35 * structure_fast
              + 0.25 * structure_slope

structure = clamp(structure_raw, -1, +1)
```

**Why these weights inside structure:** Position is the most meaningful single signal but lags; EMA20 catches regime shifts earlier; slope prevents false positives when price sits just above a flat EMA50.

**Data source:** Already available via existing `fetchAndCheckRegime()` — extend it to return `ema20` and `ema50_slope_5d`. No new external dependency.

### 3.2 Breadth (weight: 0.25) — **NEW DEPENDENCY**

**Goal:** Confirm whether the index move is broad-based or narrow.

**Inputs:** % of a reference universe trading above their own 50-DMA on the previous close.

**Reference universe:** Nifty 500 (preferred) or Nifty 200 (acceptable fallback). Not Nifty 50 — too narrow, defeats the purpose.

**Formula:**

```
// pct is a value in [0, 100]
breadth = clamp((pct - 50) / 25, -1, +1)
   // 50% = neutral, 75% = +1 (broad rally), 25% = -1 (broad weakness).
```

**Data source options (pick one, in priority order):**

1. **Self-compute** (recommended long-term). You already have instruments synced via `instrumentSyncJob.js`. Nightly job: for each Nifty 500 constituent, compute whether prev close > its own 50-DMA (from Upstox historical candles). Aggregate. Cost: ~500 Upstox API calls overnight, cacheable, no vendor fee.
2. **ChartInk proxy.** Run a ChartInk scan for "stocks trading above 50 DMA" constrained to Nifty 500 universe. Pros: no new infra. Cons: ChartInk rate limits, scan definition must be maintained.
3. **Paid vendor** (TrueData / Global Datafeeds). Cleanest but costs ~₹2–5k/month depending on plan.

**Recommendation:** Start with Option 2 (ChartInk) for fast ship; move to Option 1 once it's stable. The self-computed version is more defensible and doesn't add a third-party dependency to a load-bearing path.

**Failure mode:** If breadth is unavailable for a given day, return `null` and let the composite formula reweight.

### 3.3 Volatility (weight: 0.15) — **NEW DEPENDENCY**

**Goal:** Adjust risk appetite for the volatility regime. High VIX = smaller size, fewer trades, because realized slippage and whipsaw risk both rise.

**Inputs:** Current India VIX close, India VIX rolling 1-year percentile rank.

**Formula:**

```
// vix_pct_rank is the percentile rank of today's VIX within the trailing 252 trading days,
// expressed as a value in [0, 100].
// Note: this input is *inverted* — high VIX reduces the regime score magnitude.

volatility = clamp((50 - vix_pct_rank) / 25, -1, +1)
   // 50th percentile = 0 (neutral)
   // 25th percentile (calm) = +1
   // 75th percentile (stressed) = -1
```

**Interpretation:** Volatility is not directional — it is a *risk premium* dimension. A calm market (low percentile) gets a positive contribution that raises the magnitude of a bullish OR bearish composite score, meaning we'll trade more aggressively. A stressed market reduces magnitude, meaning we'll trade smaller or sit out.

**Important:** Volatility should be blended **by absolute contribution**, not by sign matching. This is a modification to the simple weighted sum in §4. See §4.2.

**Data source:**

- **NSE direct.** India VIX OHLC is available at `https://www.nseindia.com/api/allIndices` (free, scraped same way the existing code scrapes other NSE endpoints). Percentile rank requires maintaining a rolling 252-day history — a simple Mongo collection `india_vix_daily`, populated by a nightly job, 1-year backfill on first deploy.
- Alternative: Upstox also surfaces India VIX as an instrument. Check if Upstox historical API covers it (may or may not, depending on subscription).

**Failure mode:** If VIX is unavailable, return `null`. Do not fall back to a default — volatility is informational, and missing it should just remove the dimension from the blend.

### 3.4 Overnight Sentiment (weight: 0.15)

**Goal:** Capture what overnight markets have priced in, while acknowledging it is a weak and often mean-reverting signal.

**Inputs:**

- GIFT Nifty change % (already scraped)
- Asia composite: simple average of Nikkei 225 and Hang Seng change % at 8:30 AM IST
- DXY (US Dollar Index) change %, inverted (strong dollar → negative for Indian equities via FII flow channel)

**Formula:**

```
gift_norm  = clamp(gift_change_pct   / 0.75, -1, +1)
asia_norm  = clamp(asia_composite_pct / 0.75, -1, +1)
dxy_norm   = clamp(-dxy_change_pct   / 0.50, -1, +1)
   // ±0.75% on equity indices maps to ±1.
   // ±0.50% on DXY maps to ±1. Sign flipped: strong dollar = negative.

overnight_raw = 0.50 * gift_norm + 0.30 * asia_norm + 0.20 * dxy_norm
overnight = clamp(overnight_raw, -1, +1)
```

**Data source:**

- GIFT Nifty: already scraped in current pipeline (`sgx_nifty_scraper` — but note: the SGX name is legacy, the actual product since July 2023 is GIFT Nifty on NSE IX). Verify your scraper is actually hitting a live source.
- Asia: Nikkei and Hang Seng are available via Upstox or via a free scrape from any finance site. Global intel step already consumes this data via AI search — move the raw numbers into this input layer so they are deterministic inputs, not AI-paraphrased.
- DXY: Yahoo Finance symbol `DX-Y.NYB` or via Upstox if available.

**Rationale for low weight (0.15):** Overnight sentiment has real predictive power on the first 30 minutes but decays fast. We let ORB validation (Step 5-adjacent) and the scan-level gap filters handle the execution-time version of this signal. The regime layer only needs the coarse orientation.

### 3.5 Flow (weight: 0.15) — **NEW DEPENDENCY**

**Goal:** Capture institutional flow direction from the previous session.

**Inputs:** Prev-day FII net (equity cash segment) and DII net (optional), in crores.

**Formula:**

```
// ±3000 crore on FII net is a "notable" day. Normalize to that.
fii_norm = clamp(fii_net_crores / 3000, -1, +1)

// DII often counters FII; use sign agreement as a confidence modifier
if (dii_net available):
   if (sign(dii_net) == sign(fii_net)):
      flow = fii_norm  // agreement: use full FII signal
   else:
      flow = fii_norm * 0.5  // disagreement: dampen
else:
   flow = fii_norm
```

**Data source:**

- **NSE direct:** `https://www.nseindia.com/api/fiidiiTradeReact` publishes daily FII/DII cash figures. Free, same scraping pattern as existing NSE endpoints. Data lag is ~1 business day — acceptable because Step 1 runs at 8:40 AM for the *current* day's trading and we are looking at the *previous* day's close.
- Alternative: Moneycontrol, CDSL — but NSE is the primary.

**Failure mode:** Return `null` on scrape failure. Flow is informational.

---

## 4. Composite Score

### 4.1 Base Formula (Directional Inputs)

Four of the five inputs are directional (structure, breadth, overnight, flow). Volatility is handled separately.

```
directional_inputs = [structure, breadth, overnight, flow]
directional_weights = [0.30, 0.25, 0.15, 0.15]
   // These weights sum to 0.85. The remaining 0.15 is volatility's
   // contribution to the *magnitude* (see 4.2).

// Null-safe weighted sum:
sum_value = 0
sum_weight = 0
for (input, weight) in zip(directional_inputs, directional_weights):
   if input is not null:
      sum_value += input * weight
      sum_weight += weight

if sum_weight == 0:
   directional_score = null  // nothing usable — halt
else:
   directional_score = sum_value / sum_weight
   // renormalizes so missing inputs do not artificially shrink the score
```

### 4.2 Volatility as Magnitude Modifier

Volatility modifies the *magnitude* of the directional score, not its sign. Low-volatility markets should produce larger magnitudes (trade more aggressively); high-volatility markets shrink magnitudes (size down).

```
if volatility is null:
   vol_factor = 1.0
else:
   // volatility ∈ [-1, +1], where +1 = calm, -1 = stressed
   // Map to a multiplier in [0.6, 1.3]:
   vol_factor = 1.0 + 0.3 * volatility
   // volatility = +1 (calm)   → vol_factor = 1.3
   // volatility =  0 (neutral) → vol_factor = 1.0
   // volatility = -1 (stressed)→ vol_factor = 0.7

regime_score = clamp(directional_score * vol_factor, -1, +1)
```

### 4.3 Halt Rules

Even with the continuous design, a few hard halts remain:

- `directional_score is null` (all four directional inputs failed) → **halt** with playbook `halt`, reason `no_directional_data`.
- `vix_pct_rank > 90` (top-decile volatility day) → **halt**, reason `extreme_volatility`. This catches budget days, RBI surprises, geopolitical shocks.
- Global intel's `STAY_OUT` in Step 5.5 continues to override (unchanged).

---

## 5. Score → Label → maxTrades → sizeMultiplier

### 5.1 Regime Label (preserved for backward compat)

Map `regime_score` magnitude and sign to a label. These labels keep the existing taxonomy so downstream code does not need to change.

| regime_score range      | Label          |
|-------------------------|----------------|
| `> +0.60`               | `STRONG_BULL`  |
| `+0.25` to `+0.60`      | `WEAK_BULL`    |
| `-0.25` to `+0.25`      | `NEUTRAL`      |
| `-0.60` to `-0.25`      | `WEAK_BEAR`    |
| `< -0.60`               | `STRONG_BEAR`  |

The old `CONFLICT` label goes away as a regime label — it is replaced by the `gap_fade` **playbook** (see §6) which can coexist with any of the above labels.

### 5.2 maxTrades and sizeMultiplier from the continuous score

Drive both off the score magnitude directly — no table lookup.

```
abs_score = abs(regime_score)

// max_trades: step function on magnitude
if abs_score >= 0.60:   max_trades = 3
elif abs_score >= 0.25: max_trades = 2
elif abs_score >= 0.10: max_trades = 1
else:                   max_trades = 0

// size_multiplier: smooth function, clamped
size_multiplier = clamp(abs_score * 1.2, 0.0, 1.0)
// abs_score = 0.83 → size_multiplier = 1.0 (capped)
// abs_score = 0.50 → size_multiplier = 0.60
// abs_score = 0.25 → size_multiplier = 0.30
// abs_score = 0.10 → size_multiplier = 0.12
```

This replaces the hand-tuned `{1.0, 0.6, 0.5}` step function and is monotonic in the score, which makes behavior easier to reason about and tune.

### 5.3 Playbook (new field)

```
playbook: "standard" | "gap_fade" | "halt"

// Decision logic:
if halt_rule_triggered:
   playbook = "halt"
elif sign(structure) != sign(overnight)
     and abs(structure) > 0.30
     and abs(overnight) > 0.30:
   playbook = "gap_fade"
else:
   playbook = "standard"
```

The `gap_fade` playbook replaces what used to be a CONFLICT halt. See §6 for how it changes downstream behavior — minimally, and only via opt-in flags.

---

## 6. Gap-Fade Playbook (replaces CONFLICT halt)

**Core thesis:** When structure and overnight sentiment disagree *strongly*, the overnight gap typically fades into the structural trend during the Indian session. Historically this is one of the higher-edge intraday setups on NSE.

**What changes when `playbook == "gap_fade"`:**

1. `max_trades` is capped at `1`, regardless of what §5.2 produced. One bet, highest-conviction setup only.
2. `size_multiplier` is capped at `0.40`. Half the normal size or less.
3. `MIN_SCORE` in Step 4 is raised to `75` (vs 60 standard). This can be done by adding a `score_floor_override` field to `marketContext` that Step 4 reads if present.
4. Only candidates whose direction matches `sign(structure)` are kept. I.e., we fade the gap in the direction of the structural trend.
5. Entry is gated on first-15m candle fading the gap direction (Step 5-adjacent ORB validation already handles this; no code change needed, but the playbook may tighten the ORB validity threshold).

**If you do not want to ship the playbook in v1:** set `max_trades = 0` whenever `playbook == "gap_fade"`. That preserves the "halt on conflict" behavior from the old matrix but surfaces it as a playbook, giving you a clean path to ship the gap-fade logic later without another regime refactor.

**Recommendation:** Ship v1 with gap-fade set to `max_trades = 0` (behavior-equivalent to today's CONFLICT halt). Collect one quarter of data on what *would* have been traded under the gap-fade rules. Then decide whether to enable it based on evidence, not anecdote.

---

## 7. New Constants (proposed `regimeConstants.js`)

Keep the existing `dailyPicksConstants.js` untouched. Put regime-layer constants in a new file.

```js
// regimeConstants.js — proposed content

// === Input normalization bands ===
export const STRUCTURE_POSITION_BAND_PCT = 0.03;  // 3% distance from EMA50 → ±1
export const STRUCTURE_FAST_BAND_PCT     = 0.02;  // 2% distance from EMA20 → ±1
export const STRUCTURE_SLOPE_BAND_PCT    = 0.01;  // 1% EMA50 slope over 5d → ±1
export const BREADTH_CENTER_PCT          = 50;    // 50% = neutral
export const BREADTH_BAND_PCT            = 25;    // ±25% from center = ±1
export const VOL_CENTER_PERCENTILE       = 50;
export const VOL_BAND_PERCENTILE         = 25;
export const OVERNIGHT_EQUITY_BAND_PCT   = 0.75;
export const OVERNIGHT_DXY_BAND_PCT      = 0.50;
export const FLOW_BAND_CRORES            = 3000;

// === Weights ===
export const WEIGHT_STRUCTURE  = 0.30;
export const WEIGHT_BREADTH    = 0.25;
export const WEIGHT_OVERNIGHT  = 0.15;
export const WEIGHT_FLOW       = 0.15;
// NOTE: structure + breadth + overnight + flow = 0.85
//       volatility contributes the remaining 0.15 as a *magnitude* modifier.
export const VOL_MULTIPLIER_RANGE = 0.30;  // multiplier ∈ [1 - 0.30, 1 + 0.30]

// === Label thresholds ===
export const LABEL_STRONG_THRESHOLD = 0.60;
export const LABEL_WEAK_THRESHOLD   = 0.25;

// === Trade/size mapping ===
export const MAX_TRADES_STRONG = 3;
export const MAX_TRADES_WEAK   = 2;
export const MAX_TRADES_MIN    = 1;
export const MIN_ABS_SCORE_TO_TRADE = 0.10;
export const SIZE_SLOPE = 1.2;  // size_multiplier = clamp(abs_score * SIZE_SLOPE, 0, 1)

// === Halt rules ===
export const HALT_VIX_PERCENTILE = 90;

// === Gap-fade playbook ===
export const GAP_FADE_STRUCTURE_THRESHOLD = 0.30;
export const GAP_FADE_OVERNIGHT_THRESHOLD = 0.30;
export const GAP_FADE_MAX_TRADES = 1;
export const GAP_FADE_SIZE_MULT  = 0.40;
export const GAP_FADE_MIN_SCORE  = 75;
// For v1 rollout: set GAP_FADE_MAX_TRADES = 0 to preserve old halt behavior.
```

Every number above is a tuning knob. In the backtest plan (§10), you walk-forward sweep the most sensitive of them (label thresholds, weights, normalization bands) and record sensitivity.

---

## 8. New File: `regimeScoring.js` (pseudocode)

Proposed location: `backend/src/engine/regimeScoring.js` (alongside the existing `regime.js`, which you can deprecate once the new module is live).

```js
// regimeScoring.js — pseudocode, not final code

import { /* all constants from regimeConstants.js */ } from '../constants/regimeConstants.js';

// --- Input computation (pure functions) ---

function computeStructure(nifty) {
   // nifty: { close, ema20, ema50, ema50_prev5 }
   if (!nifty || !nifty.close || !nifty.ema50) return null;
   const position = clamp((nifty.close - nifty.ema50) / nifty.ema50 / STRUCTURE_POSITION_BAND_PCT, -1, 1);
   const fast     = clamp((nifty.close - nifty.ema20) / nifty.ema20 / STRUCTURE_FAST_BAND_PCT, -1, 1);
   const slope    = clamp((nifty.ema50 - nifty.ema50_prev5) / nifty.ema50_prev5 / STRUCTURE_SLOPE_BAND_PCT, -1, 1);
   return clamp(0.40 * position + 0.35 * fast + 0.25 * slope, -1, 1);
}

function computeBreadth(pctAbove50DMA) {
   if (pctAbove50DMA == null) return null;
   return clamp((pctAbove50DMA - BREADTH_CENTER_PCT) / BREADTH_BAND_PCT, -1, 1);
}

function computeVolatility(vixPercentileRank) {
   if (vixPercentileRank == null) return null;
   return clamp((VOL_CENTER_PERCENTILE - vixPercentileRank) / VOL_BAND_PERCENTILE, -1, 1);
}

function computeOvernight({ giftPct, asiaCompositePct, dxyPct }) {
   if (giftPct == null && asiaCompositePct == null && dxyPct == null) return null;
   const g = giftPct == null ? 0 : clamp(giftPct / OVERNIGHT_EQUITY_BAND_PCT, -1, 1);
   const a = asiaCompositePct == null ? 0 : clamp(asiaCompositePct / OVERNIGHT_EQUITY_BAND_PCT, -1, 1);
   const d = dxyPct == null ? 0 : clamp(-dxyPct / OVERNIGHT_DXY_BAND_PCT, -1, 1);
   return clamp(0.50 * g + 0.30 * a + 0.20 * d, -1, 1);
}

function computeFlow({ fiiCr, diiCr }) {
   if (fiiCr == null) return null;
   const fii = clamp(fiiCr / FLOW_BAND_CRORES, -1, 1);
   if (diiCr != null && Math.sign(diiCr) !== Math.sign(fiiCr)) return fii * 0.5;
   return fii;
}

// --- Composite ---

function computeRegimeScore(inputs) {
   const { structure, breadth, overnight, flow, volatility } = inputs;
   const directional = [
      { val: structure, w: WEIGHT_STRUCTURE },
      { val: breadth,   w: WEIGHT_BREADTH },
      { val: overnight, w: WEIGHT_OVERNIGHT },
      { val: flow,      w: WEIGHT_FLOW },
   ];
   let sumValue = 0, sumWeight = 0;
   for (const { val, w } of directional) {
      if (val != null) { sumValue += val * w; sumWeight += w; }
   }
   if (sumWeight === 0) return { score: null, reason: 'no_directional_data' };
   const directionalScore = sumValue / sumWeight;
   const volFactor = volatility == null ? 1.0 : 1.0 + VOL_MULTIPLIER_RANGE * volatility;
   return { score: clamp(directionalScore * volFactor, -1, 1), reason: null };
}

// --- Label + sizing ---

function scoreToLabel(score) {
   if (score >= LABEL_STRONG_THRESHOLD) return 'STRONG_BULL';
   if (score >= LABEL_WEAK_THRESHOLD)   return 'WEAK_BULL';
   if (score > -LABEL_WEAK_THRESHOLD)   return 'NEUTRAL';
   if (score > -LABEL_STRONG_THRESHOLD) return 'WEAK_BEAR';
   return 'STRONG_BEAR';
}

function scoreToSizing(score) {
   const abs = Math.abs(score);
   let maxTrades;
   if (abs >= LABEL_STRONG_THRESHOLD) maxTrades = MAX_TRADES_STRONG;
   else if (abs >= LABEL_WEAK_THRESHOLD) maxTrades = MAX_TRADES_WEAK;
   else if (abs >= MIN_ABS_SCORE_TO_TRADE) maxTrades = MAX_TRADES_MIN;
   else maxTrades = 0;
   const sizeMultiplier = clamp(abs * SIZE_SLOPE, 0, 1);
   return { maxTrades, sizeMultiplier };
}

function decidePlaybook({ structure, overnight, vixPctRank, haltReason }) {
   if (haltReason) return 'halt';
   if (vixPctRank != null && vixPctRank > HALT_VIX_PERCENTILE) return 'halt';
   if (structure != null && overnight != null
       && Math.sign(structure) !== Math.sign(overnight)
       && Math.abs(structure) > GAP_FADE_STRUCTURE_THRESHOLD
       && Math.abs(overnight) > GAP_FADE_OVERNIGHT_THRESHOLD) {
      return 'gap_fade';
   }
   return 'standard';
}

// --- Top-level orchestrator ---

export async function computeMarketContext() {
   const [niftyData, breadthPct, vixData, overnightData, flowData] = await Promise.all([
      fetchNiftyStructure(),      // { close, ema20, ema50, ema50_prev5 }
      fetchBreadthPct(),          // % Nifty 500 above 50-DMA
      fetchVixData(),             // { close, percentileRank }
      fetchOvernightData(),       // { giftPct, asiaCompositePct, dxyPct }
      fetchPrevDayFlow(),         // { fiiCr, diiCr }
   ]);

   const inputs = {
      structure:  computeStructure(niftyData),
      breadth:    computeBreadth(breadthPct),
      volatility: computeVolatility(vixData?.percentileRank),
      overnight:  computeOvernight(overnightData || {}),
      flow:       computeFlow(flowData || {}),
   };

   const { score, reason } = computeRegimeScore(inputs);
   if (score === null) {
      return { regime: 'HALT', playbook: 'halt', halt_reason: reason, max_trades: 0, size_multiplier: 0, inputs };
   }

   const label = scoreToLabel(score);
   const { maxTrades, sizeMultiplier } = scoreToSizing(score);
   const playbook = decidePlaybook({
      structure: inputs.structure,
      overnight: inputs.overnight,
      vixPctRank: vixData?.percentileRank,
      haltReason: null,
   });

   // Playbook overrides for gap_fade
   let finalMaxTrades = maxTrades;
   let finalSizeMult  = sizeMultiplier;
   let scoreFloorOverride = null;
   if (playbook === 'gap_fade') {
      finalMaxTrades    = Math.min(maxTrades, GAP_FADE_MAX_TRADES);
      finalSizeMult     = Math.min(sizeMultiplier, GAP_FADE_SIZE_MULT);
      scoreFloorOverride = GAP_FADE_MIN_SCORE;
   }
   if (playbook === 'halt') {
      finalMaxTrades = 0;
      finalSizeMult  = 0;
   }

   return {
      regime: label,
      regime_score: score,
      playbook,
      max_trades: finalMaxTrades,
      size_multiplier: finalSizeMult,
      score_floor_override: scoreFloorOverride,
      inputs,            // full input dump for debugging/audit
      decided_at: new Date().toISOString(),
   };
}
```

---

## 9. Step 1 Integration in `dailyPicksService.js`

The existing Step 1 calls something like:

```js
const { regime, max_trades, size_multiplier, /* ... */ } = await fetchAndCheckRegime();
// ... CONFLICT halt check ...
// ... continue to Step 2 ...
```

The replacement is a one-line swap plus the CONFLICT check becomes a `HALT` check:

```js
const marketContext = await computeMarketContext();
if (marketContext.regime === 'HALT') {
   await saveEmptyDoc({ reason: marketContext.halt_reason });
   await notify({ title: 'Trading Halted', body: `Halt: ${marketContext.halt_reason}` });
   return;
}
// Optional v1.1: if marketContext.playbook === 'gap_fade' and you have not yet
// implemented the playbook, treat it as halt:
// if (marketContext.playbook === 'gap_fade') { ...halt... }

// ... continue to Step 2 with marketContext ...
```

Step 4 (scoring) gains one line to honor the override:

```js
const minScore = marketContext.score_floor_override ?? MIN_SCORE;
// ... use minScore instead of MIN_SCORE ...
```

**Nothing else in the pipeline needs to change.** Step 2 (scan selection) still keys off `regime`, Step 5 (levels) still uses the regime-tiered R:R table, Step 6 (selection) still uses `max_trades`, Step 7 (DB save) stores the enriched `marketContext` with the new fields alongside the old ones.

---

## 10. Data Source Plan (new dependencies summary)

| Input         | Currently pulled? | Proposed source                          | Effort        |
|---------------|-------------------|------------------------------------------|---------------|
| Structure     | Yes (partial)     | Extend `fetchAndCheckRegime()`           | 1–2 hrs       |
| Breadth       | **No — new**      | Self-compute nightly (Nifty 500 vs 50-DMA) using existing Upstox historical API + instrument sync | 1–2 days initial + nightly job |
| Volatility    | **No — new**      | NSE scrape `allIndices` for VIX close + 1-yr backfill stored in Mongo | 1 day (incl. backfill script) |
| Overnight     | Partial (GIFT only) | Extend existing scraper: add Nikkei, Hang Seng, DXY via Yahoo Finance or Upstox | 1 day |
| Flow          | **No — new**      | NSE scrape `fiiDiiTradeReact` nightly    | 4–6 hrs       |

**New nightly jobs needed:**

1. `breadthSnapshotJob.js` — 9:00 PM IST. For each Nifty 500 constituent, compute prev-close vs its own 50-DMA. Store aggregate + per-stock booleans in `breadth_daily` collection.
2. `vixSnapshotJob.js` — 9:00 PM IST. Fetch India VIX close from NSE. Store in `india_vix_daily`. Compute 252-day percentile rank on the fly in the morning (trivial query).
3. `fiiFlowJob.js` — 7:00 PM IST (after NSE publishes). Store FII/DII cash figures in `institutional_flow_daily`.

All three jobs should be additive and idempotent (upsert by date), and should not interact with any existing job.

**Backfill scripts (one-time, for backtest support):**

- `backfill-breadth.js` — walk 18 months back, rebuild the `breadth_daily` collection. Heaviest of the three; expect ~500 stocks × ~400 trading days of historical candle reads.
- `backfill-vix.js` — NSE does not make long VIX history easily scrapeable; fall back to Upstox historical or a one-time CSV download.
- `backfill-fii.js` — NSE historical archive has daily FII files going back years.

Without backfills, the new backtest cannot validate the new regime. This is non-optional.

---

## 11. Backtest Plan

**Phase 1 — Shadow mode (2 weeks, zero risk).**

Run `regimeScoring.js` in parallel with the existing regime logic. Both produce a `marketContext`; store both in the DailyPick document under `market_context` (existing) and `market_context_v2` (new). Trade off the existing one. Log disagreements daily.

**Phase 2 — Historical replay (mandatory before cut-over).**

Backfill all new data sources for at least 18 months (prefer 24). Re-run `pipelineBacktest.js` with v2 regime as the *only* change; every other stage identical. Compute:

- P&L delta (v2 minus v1)
- Trade count delta
- Max drawdown v1 vs v2
- Sharpe v1 vs v2
- Days disagreed + direction of disagreement
- On disagreement days: who was right more often

Walk-forward: fit any tunable weights on months 1–12, validate on months 13–18, test on months 19–24. Do not peek.

**Phase 3 — Live shadow (1 month).**

Ship v2 logic, keep trading off v1. Compare predictions daily. Track:
- Input availability per day (how often is any source null?)
- Score stability (does it flip excessively intra-day if re-run?)
- Label distribution (is NEUTRAL eating 60% of days? That means thresholds need retuning.)

**Phase 4 — Cut-over.**

Only after Phase 2 shows positive expected value within acceptable drawdown bounds AND Phase 3 shows data sources are reliable. Switch the trading path to v2. Keep v1 computing in the background for 1 more month as a reversibility insurance.

**Red flags that should block cut-over:**

- Any new data source fails > 5% of days in shadow.
- v2 has higher drawdown in backtest despite higher Sharpe (tail risk trade-off).
- v2 trades <50% of the days v1 traded (we've become too conservative — likely thresholds too tight).
- v2 trades >150% of v1 days (too loose — likely eating costs in low-edge regimes).

---

## 12. Rollback Plan

- A single env var `REGIME_VERSION=v1|v2` in the pipeline entrypoint selects which module to call.
- Both modules return the same `marketContext` shape (v2 has extra fields that downstream safely ignores).
- Rolling back is one env-var flip; no code revert required.
- Keep `REGIME_VERSION` toggleable for at least 60 days after v2 goes live.

---

## 13. Open Questions / Tuning Knobs

Items flagged for post-implementation calibration rather than pre-implementation debate:

1. **Weights on the four directional inputs** (0.30 / 0.25 / 0.15 / 0.15). Defaults are reasonable but should be revisited after the first 3 months of shadow data.
2. **Label thresholds** (±0.25, ±0.60). If label distribution is lopsided, retune.
3. **Volatility multiplier range** (±0.30). If days with VIX > 25 still produce aggressive sizing, widen the range.
4. **Breadth reference universe** (Nifty 500 vs Nifty 200). If Nifty 500 breadth data has coverage gaps, fall back to Nifty 200 permanently.
5. **Gap-fade activation thresholds** (0.30, 0.30). These are eyeballed. Validate with historical gap-fade performance on days that would have triggered.
6. **Whether to keep the regime label at all.** With a continuous score, Steps 2 (scan selection), 4 (scoring bonuses), and 5 (R:R tiers) could eventually consume the score directly. For v1, we preserve labels for minimal downstream disruption.

---

## 14. Out of Scope for This Redesign

- Scan selection logic (Step 2) — unchanged.
- Scoring model (Step 4) — unchanged aside from `score_floor_override` plumbing.
- Levels engine (Step 5) — unchanged.
- Global intel (Step 5.5) — unchanged; its STAY_OUT still overrides v2 output.
- Selection logic (Step 6) — unchanged.
- ORB validation, trailing stops, execution layer — unchanged.

Anything we need to revisit in the execution layer should be a separate spec.

---

## 15. Implementation Checklist (for whoever ships this)

- [ ] Create `backend/src/constants/regimeConstants.js` with all §7 constants.
- [ ] Create `backend/src/engine/regimeScoring.js` following §8 pseudocode.
- [ ] Add nightly jobs: `breadthSnapshotJob.js`, `vixSnapshotJob.js`, `fiiFlowJob.js`.
- [ ] Add Mongo collections: `breadth_daily`, `india_vix_daily`, `institutional_flow_daily`.
- [ ] Write backfill scripts for each collection (18+ months).
- [ ] Extend `fetchAndCheckRegime()` (or replace with a `fetchNiftyStructure()`) to return EMA20 and 5-day EMA50 slope.
- [ ] Extend overnight scraper to include Nikkei, Hang Seng, DXY.
- [ ] Wire `REGIME_VERSION` env flag into `dailyPicksService.js` Step 1.
- [ ] Add `score_floor_override` consumption in Step 4.
- [ ] Write unit tests for each `compute*` function (edge cases: nulls, clamping, mixed signs).
- [ ] Write an integration test that drives `computeMarketContext()` with fixture data for each target regime.
- [ ] Update `pipelineBacktest.js` / `trueBacktest.js` to accept `REGIME_VERSION`.
- [ ] Run Phase 2 backtest. Produce comparison report.
- [ ] Shadow deploy. Confirm data source reliability.
- [ ] Cut over. Monitor.

---

*End of spec.*
