# Daily Picks Pipeline — Technical Documentation

## System Overview

The Daily Picks Pipeline is an automated intraday trading system for the Indian stock market (NSE). It runs at **8:40 AM IST** each trading day — before the market opens at 9:15 AM — and produces a shortlist of high-conviction trade setups with precise entry, stop-loss, and target levels.

The pipeline is designed around a **fail-closed** philosophy: if critical data sources (regime, SGX Nifty, global intel) are unavailable, the system halts rather than trading blind.

**Key files:**

- `dailyPicksService.js` — Pipeline orchestrator (Steps 1–8)
- `dailyPicksScans.js` — Scan definitions and regime mapping
- `dailyPicksConstants.js` — Shared constants (score thresholds, intel adjustments)
- `earningsFilter.js` — NSE corporate event filter
- `globalMarketIntel.js` — AI-powered global market intelligence + SGX Nifty scraper
- `scanLevels.js` — Levels engine (entry, stop, target, R:R calculation)
- `regime.js` — Nifty structure regime detection

---

## Pipeline Flow Summary

```
Step 1:   Regime + SGX        -> CONFLICT halts
Step 2:   ChartInk scans      -> regime-gated, NEUTRAL dedup
Step 2.5: Earnings filter      -> NSE board meetings, 4-day lookahead
Step 3:   Enrich               -> Upstox OHLCV + indicators
Step 4:   Score                -> composite + scan priority bonus
Step 5:   Levels engine        -> entry/stop/target/R:R, ATR-based stops
Step 5.5: Global intel         -> AI web search, STAY_OUT gate, sector/stock adjustments
Step 6:   Select picks         -> sector cap -> scan diversity -> fill by score
Step 6b:  AI insights          -> 1-2 sentence technical rationale (non-fatal)
Step 7:   Save to DB
Step 8:   Notification
```

---

## Step 1: Market Context (Regime + SGX Nifty)

### What it does

Two data sources are fetched **in parallel**. Both are **fail-closed** — if either fails, the pipeline throws an error and sends a notification. There is no fallback.

1. **Nifty Structure Regime** — Fetches Nifty's previous close and 50-day EMA from `fetchAndCheckRegime()`. Determines whether the market structure is bullish (Nifty > EMA50), bearish (Nifty < EMA50), or flat.

2. **SGX Nifty (GIFT Nifty)** — Scraped from sgxnifty.org. Provides pre-market sentiment via the change percentage. Determines whether overnight sentiment is bullish (>+0.3%), bearish (<-0.3%), or flat.

### Combined Regime Decision Matrix

`getCombinedRegime(niftyClose, ema50, giftNiftyChangePct)` merges structure and sentiment into a **7-branch decision tree**:

| Structure (Nifty vs EMA50) | SGX Sentiment     | Combined Regime | maxTrades | sizeMultiplier |
|-----------------------------|-------------------|-----------------|-----------|----------------|
| Bull (>0.3% above EMA50)   | Bull (>+0.3%)     | STRONG_BULL     | 3         | 1.0            |
| Bull                        | Bear (<-0.3%)     | WEAK_BULL       | 2         | 0.6            |
| Bull                        | Flat (-0.3~+0.3%) | WEAK_BULL       | 2         | 0.6            |
| Bear (<0.3% below EMA50)   | Bear              | STRONG_BEAR     | 3         | 1.0            |
| Bear                        | Bull              | CONFLICT        | 0         | 0.0            |
| Bear                        | Flat              | WEAK_BEAR       | 2         | 0.6            |
| Flat                        | Any               | NEUTRAL         | 1         | 0.5            |

### CONFLICT Halt

**CONFLICT** (structure bearish + SGX bullish) means contradictory signals. The pipeline **halts immediately** — saves an empty document, sends a notification ("mixed signals, sitting out"), and exits. No scans are run.

### Output

`marketContext` object containing: `regime`, `structure_regime`, `nifty_prev_close`, `distance_pct`, `ema50`, `sgx_data`, `size_multiplier`, `max_trades`, `decided_at`.

---

## Step 2: Run Scans (ChartInk)

### What it does

Runs ChartInk technical scans based on the regime. Each regime only allows specific scan types — this is the **first filter** that prevents running bearish scans in a bull market and vice versa.

### Scan Types (16 Total)

**Bullish Momentum (4):** breakout_setup, fiftyTwoWeek_high, bull_flag, volume_shocker_bullish

**Bullish Compression (4):** pullback_at_support, compression_bullish, nr7_bullish, inside_day_bullish

**Bearish Momentum (4):** breakdown_setup, fiftyTwoWeek_low, bear_flag, volume_shocker_bearish

**Bearish Compression (4):** failed_at_resistance, compression_bearish, nr7_bearish, inside_day_bearish

### Regime-Gated Scan Selection

| Regime      | Scans Allowed | Count | Priority Order                                                    |
|-------------|---------------|-------|-------------------------------------------------------------------|
| STRONG_BULL | All bullish   | 8     | Momentum-first: breakout, 52W, flag, vol shocker, then compression |
| WEAK_BULL   | Compression   | 4     | pullback, compression, NR7, inside day                             |
| NEUTRAL     | Low-vol only  | 4     | NR7 bull/bear, inside day bull/bear                                |
| WEAK_BEAR   | Compression   | 4     | failed at resistance, compression, NR7, inside day                 |
| STRONG_BEAR | All bearish   | 8     | Momentum-first: breakdown, 52W, flag, vol shocker, then compression |
| CONFLICT    | None          | 0     | Halted at Step 1                                                   |

### NEUTRAL Cross-Direction Dedup

In NEUTRAL regime, stocks that appear in **both** bullish and bearish scans are removed entirely. If a stock triggers NR7 bullish AND NR7 bearish, it means there's no directional conviction — the stock is just compressed, not directional. These are removed before proceeding.

### Exit Condition

Zero candidates after scanning -> saves empty doc, sends notification, exits.

---

## Step 2.5: Earnings / Corporate Event Filter

### What it does

Removes stocks with upcoming board meetings or corporate events that could cause unpredictable gaps, invalidating technical setups. Runs **before** enrichment (Step 3) to avoid wasting Upstox API calls on stocks that will be discarded.

### Data Source

**NSE Board Meetings API:** `https://www.nseindia.com/api/corporate-board-meetings?index=equities`

### How it works

1. Fetches the full list of upcoming board meetings from NSE
2. For each meeting, checks both `bm_purpose` (structured: "Financial Results", "Dividend") and `bm_desc` (free-text detail) for risky keywords
3. Keywords: `result`, `financial`, `quarterly`, `annual`, `dividend`, `buyback`, `fund rais`
4. Meeting date must be within **4 days** of today (lookahead window)
5. All date comparisons are **IST-aware** (the server may run in UTC, but NSE dates are Indian market dates)

### Fail-Open Design

If the NSE API is unreachable (timeout, HTTP error), **all candidates pass through**. This is intentional — a network glitch shouldn't block the entire pipeline. The earnings data is supplementary, not critical.

### Cache

4-hour TTL, keyed by IST date. First call each day fetches fresh data; subsequent calls within the same day use cache.

### Exit Condition

All candidates removed by earnings filter -> saves empty doc, exits.

---

## Step 3: Enrich with OHLCV + Indicators

### What it does

Calls the **Upstox API** for each surviving candidate to fetch real market data:

- **OHLCV:** Open, High, Low, Close, Previous Close, Volume
- **Indicators:** EMA20, ATR (Average True Range), RSI (Relative Strength Index)
- **Additional:** Weekly close, weekly EMA20 (for multi-timeframe confirmation)

### Why this step exists

ChartInk scans only tell us a stock triggered a pattern. They don't provide the actual OHLCV data or indicator values needed for scoring and level calculation. This step bridges that gap.

### Failure Handling

Candidates that fail enrichment (API error, delisted stock, data unavailable) are silently dropped. Zero enriched -> saves empty doc, exits.

---

## Step 4: Score Candidates

### What it does

Applies a **composite scoring model** to rank candidates. Each candidate receives a score out of 100 base points, plus bonus points from confluence, scan priority, regime alignment, and weekly trend.

### Base Scoring Components (100 pts max)

| Component            | Max Points | Logic                                                                 |
|----------------------|------------|-----------------------------------------------------------------------|
| Close in Range (CIR) | 25         | How close the stock closed to its high (LONG) or low (SHORT)          |
| Volume Ratio         | 25         | Current volume vs average: >3x=25, >2x=20, >1.5x=15, >1.2x=10, else=5 |
| RSI Positioning      | 20         | LONG: 55-65 sweet spot=20; SHORT: 35-45 sweet spot=20                 |
| ATR Tradability      | 15         | ATR%: >2.5%=15, >2.0%=10, >1.5%=5, else=0                            |
| Candle Pattern       | 15         | Engulfing=15, Hammer=12, Directional candle=10, else=5                 |

### EMA20 Extension Filter (Pre-score gate)

- If a stock is **chasing** (LONG and >3% above EMA20, or SHORT and >3% below), it is **skipped entirely**
- If chasing between 2-3%, it receives a **-15 penalty**
- 52W scans are exempt (they are inherently extended)

### Minimum Score Gate

Score must be >= **60** (`MIN_SCORE`) to proceed. Below this -> candidate dropped.

### Bonus Points (Applied after MIN_SCORE check)

| Bonus                  | Points  | Condition                                                          |
|------------------------|---------|--------------------------------------------------------------------|
| Confluence             | +varies | Cluster detection across Daily / 1H / 4H pivots                   |
| Scan Priority          | +0 to +10 | STRONG regimes only (see table below)                            |
| Regime Alignment       | +5      | Trade direction matches regime                                     |
| Weekly Trend Aligned   | +5      | LONG + weekly bullish, or SHORT + weekly bearish                   |
| Weekly Trend Contra    | -10     | LONG + weekly bearish, or SHORT + weekly bullish                   |

### Scan Priority Bonus (STRONG regimes only)

| Scan Type              | STRONG_BULL | STRONG_BEAR |
|------------------------|-------------|-------------|
| breakout / breakdown   | +10         | +10         |
| 52W high / low         | +8          | +8          |
| bull flag / bear flag  | +6          | +6          |
| volume shocker         | +5          | +5          |
| pullback / failed res  | +3          | +3          |
| compression            | +2          | +2          |
| NR7                    | +1          | +1          |
| inside day             | +0          | +0          |

### Counter-Regime Warning

Trades that go against the regime (e.g., LONG in STRONG_BEAR) receive a **regime warning** attached to the pick. This doesn't reject the trade but flags it for position sizing reduction later.

### Output

Sorted descending by `rank_score`. Zero scored -> saves empty doc, exits.

---

## Step 5: Levels Engine (Entry, Stop, Target, R:R)

### What it does

Every scored candidate passes through two gates. If both pass, the candidate gets precise entry, stop-loss, target, and risk-reward levels attached.

### Gate 1: 1H Structural Conflict Check

- **LONG:** Rejected if a resistance zone exists within 2% above the Previous Day High (entry would slam into overhead resistance)
- **SHORT:** Rejected if a support zone exists within 2% below the Previous Day Low (entry would bounce off support)

### Gate 2: calculateLevels() — Scan-Archetype-Specific

Each scan type has its own entry, stop, and target logic.

#### Entry Levels

| Scan Type                     | Entry Logic                              |
|-------------------------------|------------------------------------------|
| breakout_setup                | Resistance level + 0.15 x ATR            |
| pullback_at_support           | EMA20 zone (4-rule decision logic)       |
| compression / NR7 / inside (bull) | Pattern high + 0.15 x ATR            |
| breakdown_setup               | Support level - 0.15 x ATR               |
| failed_at_resistance          | EMA20 zone (4-rule decision logic)       |
| compression / NR7 / inside (bear) | Pattern low - 0.15 x ATR             |

#### Stop-Loss Levels (All use 0.1 x ATR buffer)

| Scan Type                     | Stop Logic                               |
|-------------------------------|------------------------------------------|
| breakout_setup                | Resistance level - 0.1 x ATR             |
| pullback_at_support           | Swing low - 0.1 x ATR                    |
| compression / NR7 / inside (bull) | Pattern low - 0.1 x ATR              |
| breakdown_setup               | Support level + 0.1 x ATR                |
| failed_at_resistance          | Swing high + 0.1 x ATR                   |
| compression / NR7 / inside (bear) | Pattern high + 0.1 x ATR             |

All stops use **ATR-based buffers** (not percentage-based). This adapts to each stock's volatility — a stock with ATR of Rs 50 gets a Rs 5 buffer, while a stock with ATR of Rs 5 gets a Rs 0.50 buffer.

#### Target Levels — Structural Pivot Ladder

Targets are **NOT** a simple `entry + risk x R:R` formula. The engine uses a **structural pivot ladder** that prioritizes institutional profit-taking levels:

**Bullish targets cascade through:**
```
Daily R1 -> Daily R2 -> Weekly R1 -> Weekly R2 -> 52W High -> ATR Extension -> REJECT
```

**Bearish targets cascade through:**
```
Daily S1 -> Daily S2 -> Weekly S1 -> Weekly S2 -> 20-Day Low -> ATR Extension -> REJECT
```

Each level is validated against the **minimum R:R requirement**. If a pivot is too close (fails R:R), the engine cascades to the next level. If ALL levels fail R:R, the trade is **rejected** rather than forced.

**Scan-specific ladder priority:**

| Scan Type              | Intraday Target Ladder                  | Swing Target Ladder                         |
|------------------------|-----------------------------------------|---------------------------------------------|
| Breakout               | Daily R1 -> R2 -> 3% fallback           | Weekly R1 -> R2 -> 52W High                 |
| Pullback               | 1H Swings -> Daily R1/R2                | Daily R1 -> R2 -> Weekly R1 -> R2 -> 52W High |
| Compression (bull)     | 1H Swings -> Daily R1/R2                | Weekly R1 -> R2 -> 52W High                 |
| 52W High               | Daily R1/R2 -> 2.5x ATR                 | Weekly R1 -> R2 -> ATR Extension (2.5x/4.0x) |
| Breakdown              | Daily S1 -> S2 -> 3% fallback           | Weekly S1 -> S2 -> 20D Low -> ATR Extension  |
| Failed at Resistance   | 1H Swings -> Daily S1/S2                | Weekly S1 -> S2 -> 20D Low                   |
| Compression (bear)     | 1H Swings -> Daily S1/S2                | Weekly S1 -> S2 -> 20D Low                   |
| 52W Low                | Daily S1/S2 -> 2.5x ATR                 | ATR Extension (2x/3x)                        |

#### Partial Booking (Target 1 — 50% exit)

- **Intraday:** Daily Pivot -> midpoint between entry and main target
- **Swing:** Weekly R1 -> Daily R1 -> midpoint

Target 1 is constrained to be between entry + 2% buffer and main target - 5% buffer.

### Output

`allViable[]` — candidates with full levels (entry, stop, target, target1, risk_pct, risk_reward, mode, target_basis) attached. R:R below minimum -> rejected.

---

## Step 5.5: Global Market Intel (AI Web Search)

### What it does

Sends the viable candidate symbols to an AI model (GPT or Claude) with **web search enabled** to fetch real-time global market intelligence. This runs at ~8:40 AM IST, providing intelligence that is current to the moment of decision-making.

### Provider Options

| Provider | Model      | Cost       |
|----------|------------|------------|
| OpenAI   | GPT-4.1    | ~Rs 55/month  |
| Claude   | Sonnet 4   | ~Rs 85/month  |

Configurable via `INTEL_PROVIDER` environment variable.

### What it fetches

1. **US markets overnight** — S&P 500, Nasdaq, Dow close + Indian sector impact
2. **Asian markets** — Nikkei, Hang Seng + sentiment impact
3. **Dollar/Rupee** — DXY strength -> FII flow direction
4. **Crude oil** — Price direction -> Indian impact (import dependent economy)
5. **FII/DII flows** — Institutional buying/selling from previous session
6. **Major events** — RBI policy, budget, elections, global crises, tariffs
7. **Sector outlook** — Which NSE sectors bullish/bearish and WHY
8. **Stock-specific news** — For the exact viable symbols (earnings, SEBI actions, M&A)

### STAY_OUT Gate

If the AI returns `trading_recommendation: "STAY_OUT"` or `risk_level: "EXTREME"`, the **pipeline halts entirely**. No trades that day. This covers black swan events, budget day, RBI policy announcements.

### Direction Filter

- `AVOID_SHORTS` -> removes all SHORT candidates from viable pool
- `AVOID_LONGS` -> removes all LONG candidates

### Score Adjustments

**Sector sentiment:**

| Condition                        | Adjustment |
|----------------------------------|------------|
| Sector BULLISH + trade LONG      | +5         |
| Sector BEARISH + trade SHORT     | +5         |
| Sector BEARISH + trade LONG      | -5         |
| Sector BULLISH + trade SHORT     | -5         |

**Stock-specific news (HIGH impact only):**

| Condition         | Adjustment |
|-------------------|------------|
| Aligned sentiment | +8         |
| Opposing sentiment| -12        |

### Re-sort

After all adjustments, viable candidates are **re-sorted** by adjusted `rank_score` descending.

### SGX Data Reuse

Uses pre-fetched SGX data from Step 1 (passed via `prefetchedSGXData` parameter) to avoid a duplicate scrape.

### Cache

2-hour TTL keyed by IST date. Prevents re-fetching if the pipeline retries.

---

## Step 6: Select Diverse Picks

### What it does

Selects the final trade picks from the viable pool, enforcing **sector diversity** (no correlated positions) and **scan-type diversity** (variety of setups).

### Max Picks Per Regime

`maxPicksToday = min(regime.maxTrades, MAX_DAILY_PICKS)`

| Regime                       | maxTrades | With MAX_DAILY_PICKS = 3 |
|------------------------------|-----------|--------------------------|
| STRONG_BULL / STRONG_BEAR    | 3         | 3                        |
| WEAK_BULL / WEAK_BEAR        | 2         | 2                        |
| NEUTRAL                      | 1         | 1                        |
| CONFLICT                     | 0         | Halted at Step 1         |

### Three-Step Selection (Sector Cap First)

**STEP 1 — Sector cap on full pool:**
Keep only the highest-scored stock per sector. If ONGC (score 88) and RELIANCE (score 82) are both ENERGY, ONGC survives and RELIANCE is dropped. UNKNOWN sector stocks are allowed through (multiple unknowns can coexist). The pool is now sector-clean.

**STEP 2 — Round 1 (one per scan type):**
Groups the clean pool by `scan_type`. Sorts groups by their best candidate's score. Picks the top candidate from each type until slots are filled. This ensures you don't get 3 breakout picks from different stocks.

**STEP 3 — Round 2 (fill by score):**
If slots remain after Round 1, fills from the remaining clean pool by `rank_score` regardless of scan type.

### Why Sector Cap First

Previous approach (cap last) created a replacement problem:
```
Round 1 -> Round 2 -> Sector cap removes a pick -> now need replacement logic
```

Current approach (cap first) eliminates it:
```
Sector cap on ALL viable -> Round 1 -> Round 2 (clean pool, no replacements needed)
```

### Example

STRONG_BULL regime, 3 slots, 6 viable candidates:

Pool after sector cap: RELIANCE (breakout, 82), TCS (compression, 76), HDFCBANK (pullback, 71), MARUTI (NR7, 65)

Round 1: picks RELIANCE from breakout (82), TCS from compression (76), HDFCBANK from pullback (71) -> 3 slots filled

Result: 3 picks, all different scan types, all different sectors.

---

## Step 6b: AI Insights Generation (Non-fatal)

### What it does

Generates a short AI-written technical insight for each selected pick using **Claude Sonnet**. The insight explains WHY the trade setup is compelling based on the technical data.

### Input to AI

For each pick:
- Symbol, direction, scan type (human-readable label)
- OHLCV (open, high, low, close, prev_close, volume_ratio)
- RSI, candle pattern
- Levels (entry, stop, target, R:R)
- Market regime

### System Prompt

"Ultra-brief Indian equity technical analyst. For each stock, write exactly 1-2 sentences explaining WHY this is a good intraday trade candidate based on the technical data. Focus on the setup (candle pattern, volume confirmation, key levels). Be specific with numbers."

### Example Output

> "Bullish engulfing at Rs 3,850 with 2.1x volume confirms breakout above resistance. RSI 62 with room to run — entry Rs 3,865, tight stop at Rs 3,830 gives 1:2.5 R:R."

### Non-fatal Design

This step **never blocks the pipeline**. Three failure modes, all handled gracefully:
1. No `ANTHROPIC_API_KEY` -> skips, picks proceed with `ai_insight: null`
2. Response not parseable as JSON -> skips
3. API error (timeout, rate limit) -> catches, logs, picks proceed unchanged

### Output

Each pick gets `ai_insight` (string or null) and `ai_generated` (boolean) fields attached.

---

## Step 7: Save to DB

### What it does

Saves everything into a single **DailyPick** MongoDB document, upserted by `trading_date` (one document per trading day).

### Document Contents

| Field               | Description                                                          |
|---------------------|----------------------------------------------------------------------|
| trading_date        | The date these picks will be traded                                  |
| scan_date           | The date the scans were based on (usually previous day's candle)     |
| market_context      | Full regime data, SGX data, global intel summary                     |
| picks[]             | Final picks with levels, scores, AI insights, trade status           |
| summary             | Counts: total_candidates, bullish_count, bearish_count, selected     |
| candidates_review[] | Every candidate's journey: viable, rejected (with reason), selected  |
| global_intel        | Full intel snapshot: mood, risk, sectors, stock news, events         |

### Date Logic

- **Before 3 PM IST** (scheduled 8:40 AM run): scan_date = yesterday, trading_date = today
- **After 3 PM IST** (manual evening run): scan_date = today, trading_date = next trading day

---

## Step 8: Send Notification

### What it does

Sends a **push notification** to the admin via Firebase Cloud Messaging with the day's picks summary.

### Notification Content

**With picks:** "Daily Picks: 2 BUY + 1 SELL" with body listing symbols and entry prices.

**Special cases:**
- CONFLICT regime: "CONFLICT — Sitting Out: Structure bearish but SGX bullish"
- STAY_OUT from intel: "Trading Halted: [reason from intel]"
- No picks: "No picks today" with count of candidates scanned
- STRONG_BEAR: Flags the bearish regime in the notification

---

## Pipeline Exit Points

The pipeline has multiple early exit points. At each, it saves whatever data is available to the DB and sends a notification:

| Exit Point         | Condition                    | DB Save | Notification |
|--------------------|------------------------------|---------|--------------|
| Step 1             | CONFLICT regime              | Empty   | Yes          |
| Step 1             | Regime/SGX fetch failure     | None    | Error alert  |
| Step 2             | Zero candidates from scans   | Empty   | Yes          |
| Step 2.5           | All removed by earnings      | Empty   | Yes          |
| Step 3             | All failed enrichment        | Empty   | Yes          |
| Step 4             | Zero above MIN_SCORE         | Empty   | Yes          |
| Step 5.5           | Global intel fetch failure   | Empty   | Error alert  |
| Step 5.5           | STAY_OUT / EXTREME risk      | Empty   | Yes (halted) |
| Step 5.5           | Direction filter removes all | Empty   | Yes          |
| Step 6             | All rejected by levels engine| Empty   | Yes          |

---

## Constants Reference

| Constant                    | Value | Description                                      |
|-----------------------------|-------|--------------------------------------------------|
| MAX_DAILY_PICKS             | 3     | Hard cap on picks per day                        |
| MIN_SCORE                   | 60    | Minimum composite score to proceed               |
| EARNINGS_LOOKAHEAD_DAYS     | 4     | Days ahead to check for earnings events          |
| INTEL_SECTOR_ALIGNED        | +5    | Score boost for sector-aligned trades            |
| INTEL_SECTOR_OPPOSING       | -5    | Score penalty for sector-opposing trades          |
| INTEL_STOCK_NEWS_ALIGNED    | +8    | Score boost for aligned stock-specific news      |
| INTEL_STOCK_NEWS_OPPOSING   | -12   | Score penalty for opposing stock-specific news    |
| ATR buffer (stops)          | 0.1x  | Universal stop-loss buffer in ATR terms          |
| ATR buffer (entries)        | 0.15x | Universal entry buffer in ATR terms              |
| EMA20 chase skip threshold  | 3%    | Skip candidates >3% extended from EMA20         |
| EMA20 chase penalty range   | 2-3%  | -15 penalty for candidates 2-3% extended         |
| INTEL_CACHE_TTL             | 2h    | Global intel cache expiry                        |
| EARNINGS_CACHE_TTL          | 4h    | Earnings data cache expiry                       |

---

*Document generated: March 2026*
*System: Daily Picks Pipeline v2 — Logdhan Trading System*
