# ORB "9:08" Daily-Pick System — Audit (2026-05-31)

## 0. What actually runs at 9:08

The scanner.py daily-picks pipeline is **disabled**. `tradingDaySequenceJob` (the 8:30 scanner.py orchestrator) is gated behind `DAILY_PICKS_SCAN_ENABLED=true`, which is not set in `backend/.env`, and `ENABLE_ORB_VALIDATION=false`. The live entry system is **`orbJob` → `orbService.js`**, independent of daily-picks:

- **09:08** `orb-pre-open` — fetch Kite `/quote/ohlc` for ~200 F&O names, save ALL as candidates (no gap filter).
- **09:30** `orb-record-range` — set OR high/low from `/quote/ohlc` day H/L, filter OR width to 0.5%–2.5%.
- **10:01–14:01, every :01/:16/:31/:46** `orb-check-breakout` — 2-bar 15-min close confirmation, distance floor, bias gate, enter ≤3 MARKET MIS.
- **every 5 min** `orb-monitor` — SL check, BE trail at +1R, candle-structure tighten, 40-min sideways cut.
- **15:15** `orb-force-exit`.

So "the picks" = whichever ≤3 confirmed OR breakouts pass the gates between 10:01 and 14:01. The 9:08 step itself just builds the universe.

## 1. The honest answer to "what's the probability the picks are good?"

**You cannot compute it yet, and nothing in the code can tell you.**

- The current TIER-1 strategy (no-gap universe, decide-direction-at-break, 2-bar confirm, distance floor, bias gate) was built and hand-tuned between **2026-05-25 and 2026-05-29** (git history + inline dated comments).
- At <3 trades/day and ~1 week live, total live trades ≈ **10–15**. That is statistically meaningless for a win-rate estimate — one or two trades swing it 15+ points.
- There is **no historical backtest** of this rule. `simulate-orb-validation.js` only replays *today's* DailyPick doc through `validatePicks()`; it does not sweep months of candles through the 2-bar ORB logic.
- The tuning decisions are anecdotal by their own comments: the 1.0% distance floor came from "0 winners out of 3 trades," the bias gate from "saved ~₹250 on one day." These are n=3 rationalizations, not validated edges.

**Conclusion: the single highest-leverage fix is measurement, not logic.** Until a backtest exists, any profitability claim is a guess. (This is code-quality / risk-management review, not investment advice — I can't and won't put a profitability number on it.)

## 2. Structural problems that hurt expectancy regardless of sample size

These are design issues visible from the code; they would degrade results even with perfect execution.

### 2.1 You systematically enter *extended* (the chase)
2-bar 15-min confirmation + `MIN_DISTANCE_PCT ≥ 1.0%` means you only enter after price has closed beyond the OR for two full 15-min bars **and** is already ≥1% past the breakout level. Earliest possible entry is 10:01. You are structurally buying the move after it's already run. The day-4 note shows the <1% bucket lost — but raising the floor pushes entries *later and more extended*, which is the opposite failure mode. The trade-off was never tested, only flipped.

### 2.2 Risk per trade is uncontrolled — sizing is notional, not risk-based
`qty = floor(capitalPerTrade / ltp)` sizes by rupee notional, not by risk. But the stop is `breakoutLevel − 1% buffer` while entry is the *current (extended) LTP*. So stop distance from entry ranges from ~1% to 3%+ depending on how far price ran before the 2-bar confirm. A name entered 2% past OR risks 2×+ the rupees of a name entered right at OR — yet both get the same capital. **Per-trade rupee risk swings wildly and is not capped.** Standard fix: `qty = riskBudget / (entry − stop)`, with a hard per-trade risk cap.

### 2.3 SL geometry and entry geometry don't compose
The SL is pinned to the OR boundary ("tight SL just past the breakout level"), designed assuming entry near the boundary. But entry is the extended LTP. Result: when extended, the "tight" stop is actually wide from entry, **1R becomes large**, BE-trail (`+1R`) rarely triggers before a pullback, and the 40-min sideways cut / candle exit fire near flat. The two halves were tuned independently.

### 2.4 Capped upside, full downside
No target + "let winners run to 15:15" only works if the trail is tight. Here the trail is BE-only at a large 1R plus a 40-min flat-cut. So the distribution is: frequent ~1R losses (wide stop), many scratch/time exits, rare runners — the small-loss/big-win asymmetry ORB depends on is undercut by the large per-trade R from 2.2/2.3.

### 2.5 Slot allocation selects the *most* exhausted names
`MAX_ENTRIES = 3`, ranked by `distancePct` **descending**, then the `staleFlag` (distance > 2×OR range) rejects the truly blown-out ones. So on a 30-signal trend day you take the 3 most-extended survivors — i.e. the ones closest to exhaustion. It's plausible you want the *least* extended valid breakouts (just over the floor), not the most. Untested either way.

### 2.6 Two different yardsticks gate the same axis
`MIN_DISTANCE_PCT` rejects on **price %** (<1%); `staleFlag` rejects on **OR-range multiples** (>2×OR). A 0.5%-OR stock and a 2.5%-OR stock therefore have wildly different effective accept bands in % terms. Pick one unit.

### 2.7 OR via running day H/L is fragile
`recordOpeningRanges()` reads `/quote/ohlc` day high/low at the 9:30 cron and assumes it equals the 9:15–9:30 candle "because market just opened." Agenda's `processEvery` is 30s–1min; a late fire includes post-9:30 ticks, **widening the OR** and shifting all downstream SL/distance geometry. You already fetch true historical 15-min candles elsewhere (Phase 3) — use the actual 9:15–9:30 candle here, not the running H/L.

### 2.8 Bias gate is a one-shot decision on early, possibly-thin data
Once ≥70% of ≥10 confirmed signals are one side, the day locks to it and never re-evaluates. On a genuinely two-sided day, whatever the 10:01 scan happens to contain dictates the entire session. Intent (don't fight the tape) is sound; the single-shot, never-revisited implementation is the risk.

## 3. What's good — keep it

- **Order-safety hardening is genuinely strong and incident-driven:** rejection guard before SL placement (prevents phantom shorts), broker-position check before every exit (prevents the CONCOR-style reverse-open), cancel+replace SL with emergency-market fallback, Kite tick-size re-snap. These compose correctly.
- **Direction-aware symmetry** (LONG/SHORT) is clean and consistent throughout sizing, SL, P&L, trail, exits.
- **No-gap universe + decide-direction-at-break** is a defensible, bias-free design.
- **2-bar confirmation** does filter wick fakeouts and whipsaws (at the cost of lateness — see 2.1).
- **`decideBreakoutActions` is a pure, testable helper** — good structure for A/B testing the gates.

## 4. Prioritized recommendations

1. **Build a backtest harness first.** Replay 6–12 months of 15-min F&O candles through the exact pipeline (OR set, 2-bar confirm, distance floor, bias gate, BE/sideways/candle exits, 15:15 flat). Output win rate, expectancy in R, max drawdown, trade count. *Everything below should be A/B'd in this harness, not hand-tuned on live days.*
2. **Risk-based sizing + hard per-trade risk cap** (replace notional sizing). This alone normalizes the wild rupee-risk variance in 2.2.
3. **Decouple SL from the OR boundary when entry is extended:** stop = the *nearer* of (OR-based stop) and (entry − X%·entry), so 1R stays bounded and BE-trail actually fires.
4. **Test entry timing as a variable:** 1-bar vs 2-bar confirm; ranking by *smallest* qualifying distance vs largest; floor at 0.5% vs 1.0%.
5. **Fix OR capture** (true 9:15–9:30 historical candle) and **unify the distance/stale units**.
6. **Re-evaluate the bias gate** as a re-checkable signal rather than a one-shot lock.

---
*Scope: code review of the live ORB pipeline (`orbService.js`, `orbJob.js`, `tradingDaySequenceJob.js`). Not investment advice; no profitability is implied or guaranteed. Win rate is unknowable from code alone and requires out-of-sample backtesting.*
