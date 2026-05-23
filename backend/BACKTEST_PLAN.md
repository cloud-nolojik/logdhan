# Logdhan Daily Picks — 250-Day Backtest Plan

**Drafted:** 22 May 2026
**Capital assumption:** ₹1,00,000 (retail typical, 5× MIS leverage via Kite)
**Cost model:** Realistic Indian retail (~0.25–0.30% round-trip, see §4)
**Status:** Plan only — no code changes pending approval.

This document is the implementation plan, not the backtest itself. The backtest is approved to build once the path below is confirmed.

---

## 1. Why we are doing this

The live track record has 8 closed trades over 17 days. That sample is statistically empty: a 50% hit rate at n=8 has a 95% confidence interval of 16%–84%, which is no signal at all. Every claim the system makes about hit rate, R-multiple, regime sensitivity, or scenario coverage is currently unproven.

Before deploying any of the recent patches (structural-exit cushion, two-bar confirmation, VIX-aware ORB gate, risk floor, bear-shorts path, flipped volatility amplifier) to real money at scale, we need at least one rigorous backtest answering three questions:

1. Does the scanner pick stocks with positive expectancy *over a long horizon*, before any intraday machinery?
2. Does the intraday machinery (ORB, structural exits, trailing, partials) add or subtract from that edge?
3. Are there market regimes in which the system breaks — and how should they be handled?

A 250-day window is the minimum to cover at least one full quarter cycle (earnings season, expiry months, RBI policy days, budget). 250 trading days ≈ 1 calendar year.

## 2. Data inventory and gaps

The codebase already has the backtest *engine* — `src/scripts/backtestUtils.js` simulates a single day by calling the real `validatePicks()` and `checkGapProtection()` functions. The problem is data.

| What backtest needs                         | Current state in Mongo            | Gap                 |
| ------------------------------------------- | --------------------------------- | ------------------- |
| Daily candles, 250 trading days, F&O univ.  | 269 days, ~2000 stocks            | None                |
| 15-min candles, 250 days                    | 23 days (Dec 31 → Jan 23)         | 227 days missing    |
| 5-min candles, 250 days                     | 0 documents                       | All 250 days missing |
| India VIX history, 250 days                 | 21 trading days (Apr 17 → May 7)  | 229 days missing    |
| FII/DII flow history, 250 days              | 16 docs (Apr 17 → May 7)          | 234 days missing    |
| Breadth (% above 50-DMA), 250 days          | 15 docs                           | 235 days missing    |
| Nifty 50 daily OHLC                         | Available via stock collection    | None                |
| Catalyst/news history                       | Live scraper only — no archive    | All 250 days missing |
| Overnight cues (SGX/Asia/DXY) history       | None                              | All 250 days missing |

The daily candle coverage is excellent. Everything else has at most 3 weeks of history.

This shapes the three paths below.

## 3. Three paths and the recommended approach

### Path A — Daily-only walk-forward backtest

**What it tests:** The scanner's stock-picking quality, evaluated against next-day daily candles.

**What it skips:** ORB validation (no intraday data), structural exits, partial booking, trailing stops, gap protection logic, India VIX scaling, the new bear-shorts path's intraday behavior. Regime computation falls back to NEUTRAL for the 229 days where VIX/FII/breadth history is missing.

**How it works, in plain language:**
1. For each of the 250 trading days, pretend it is the morning of that day. Run the `scanner.py` analog on daily candles dated *strictly before* that morning.
2. Take the top 3 LONG picks (the scanner only produces longs today).
3. Assume entry at the next day's open (best available proxy without 1-min data).
4. Walk forward day by day. If the day's high ≥ planned target → TARGET_HIT. If day's low ≤ planned stop → STOP_HIT. Otherwise carry to the next day. After 5 days unresolved → TIME_EXIT at that day's close.
5. Net the P&L against ~0.25% round-trip fees per trade.
6. Aggregate hit rate, expectancy in R, average days-to-resolution, max drawdown, Sharpe-equivalent.

**Honest limits:**
- Day-resolution evaluation overstates target-hits and understates stop-hits when both prices were touched intraday (the candle traversed both levels in some order we can't see). Industry convention is to assume "if both touched, stop was hit first" for breakouts — conservative.
- No 5-min structural exit means trades hold longer than they would in live; that's the wrong way to test the recent patches but the right way to test the scanner's underlying picks.
- Counter-regime trades (longs on bearish days) are tested but not gated by the regime engine — we don't have the data to compute regime.
- The bear-shorts path (`runBearishShortPath`) cannot be evaluated at all.

**Verdict on this path:** It is a *necessary first step* but not sufficient. It answers "do the picks have edge?" — not "does the trading system have edge?" If Path A shows the picks themselves are random, no amount of intraday machinery saves the system. If Path A shows the picks have edge, that's a green light to invest in Path B.

**Effort:** 1–2 engineer-days.
**Compute time:** 1–2 hours to run on the 269-day window.

### Path B — Hybrid: Path A + 90 days of full-intraday replay

**What it adds over A:**
1. Backfill ~90 days of 15-min candles for the F&O universe via the existing `prefetchAllStockData.js` script (Upstox intraday endpoint supports 90 days lookback).
2. Backfill 90 days of India VIX, FII/DII, and breadth using the existing `backfillIndiaVix.js`, `backfillFiiFlow.js`, and `backfillBreadth.js` scripts.
3. For the recent 90 days, run the full pipeline: regime → scanner → ORB validation → entry → 15-min structural exit (approximated, since 5-min data is missing) → partial / trailing / time exit.
4. For the older 160 days, fall back to the Path A daily-only logic.

**What it still skips:** The 5-min granularity of `analyzeIntradayStructure` is approximated by using 15-min candles as both "fast" and "slow" inputs to the function (similar to how the weekly-picks monitor in `intradayMonitorJob.js` already does — fast=15m, slow=60m). That's a known approximation; it'll overstate structural exits because the 5-min layer of confirmation is gone.

**Verdict:** This is the most honest backtest you can build from current data. 90 days of full-intraday replay covers two earnings seasons, one expiry cycle, and probably at least one regime shift. Enough to draw real conclusions.

**Effort:** 1 engineer-week. Breakdown:
- Day 1: backfill 90 days of 15-min candles (script exists; needs running + verification).
- Day 1: backfill VIX/FII/breadth (scripts exist; verify they reach 90 days).
- Day 2–3: write the replay driver that walks day-by-day and reconstructs `marketContext`.
- Day 4: fix the inevitable bugs (cron vs UTC, IST midnight handling, missing-data fallbacks).
- Day 5: run, analyze, write up.

**Compute time:** 4–8 hours.

### Path C — Full 250-day intraday replay

**What it would take:**
1. Procure a tick or 1-min historical data source. Upstox's intraday endpoint maxes out at 90 days lookback. Yahoo Finance doesn't have reliable intraday. Options:
   - **GlobalDataFeeds (GDFL)** — Indian institutional provider, sells 1-min historical, ~₹15k–25k/year for F&O universe.
   - **Bhavcopy + tick reconstruction** — NSE publishes EOD bhavcopy free, but it's daily-only.
   - **Yfinance with retries** — possible 1-year of 15-min for select stocks, but quality is patchy.
   - **Your own broker logs** — Kite's API can fetch historical 1-min for stocks you've traded, but limited.
2. Backfill 250 days of: 15-min candles, 5-min candles, India VIX, FII/DII flow, breadth, SGX Nifty close, Asian markets composite, DXY.
3. Build a replay calendar that respects Indian holidays.
4. Run.

**Verdict:** Path C is institutional-quality validation but not feasible without paid data and ~4–8 engineer-weeks of work. Skip unless Path B results justify the investment.

### Recommendation

**Do Path A first** (this week, 1–2 days). Two outcomes:

- *Scanner has no edge:* hit rate ≤ 40% or expectancy ≤ 0 in R. Stop investing in this strategy. Either rewrite the scanner or pivot to a different setup.
- *Scanner has edge:* hit rate 45%+ with expectancy ≥ 0.2R. Green light Path B.

**Then Path B** (week 2, 5 days). Two outcomes:

- *Intraday machinery hurts:* full-pipeline expectancy < scanner-alone expectancy. Reduce intraday gating, simplify exits.
- *Intraday machinery helps:* full-pipeline expectancy > scanner-alone. Ship the system to paper-trade for 30 days, then live.

Skip Path C unless and until live performance fails to match Path B predictions.

## 4. Cost model — Indian retail intraday MIS

These numbers come from Zerodha's published fee structure (Apr 2026). Adjust if you trade with a different broker.

For a typical ₹100,000 capital × 5× MIS leverage = ₹500,000 notional per trade (assuming one position fills the intraday pool).

| Component               | Long entry (buy)    | Long exit (sell)    | Notes                                  |
| ----------------------- | ------------------- | ------------------- | -------------------------------------- |
| Brokerage               | 0.03% or ₹20 (lower) | 0.03% or ₹20       | Flat ₹20 for trades > ₹66,667         |
| STT                     | 0                   | 0.025%              | Sellside only for intraday equity     |
| Exchange transaction    | 0.00297%            | 0.00297%            | NSE cash                              |
| GST                     | 18% on brokerage + exch | 18% on brokerage + exch | ~0.0011%             |
| SEBI charges            | ₹10 / crore         | ₹10 / crore         | Negligible                            |
| Stamp duty              | 0.003%              | 0                   | Buy-side only                         |
| **Sub-total**           | **~0.04%**          | **~0.07%**          | **Round-trip: ~0.11%**                |
| Slippage (SL-M fill drift) | 0.05% – 0.10%    | 0.05% – 0.10%       | Worse on volatile / low-liquidity     |
| **Total round-trip**    | **~0.21% – 0.31%**  |                     | Use **0.25%** as the backtest default |

For SHORTs (when `ENABLE_BEAR_SHORTS=true`):
- Same fees but STT is **0.025%** on the *sell* (entry), and 0 on the buy (exit). Net cost is the same order of magnitude.

**Backtest implementation:** subtract `0.25%` × `entry_price` × `qty` from every closed trade's gross P&L. This is the simplest faithful model. A more sophisticated approach would model slippage as a function of ATR%, but 0.25% flat is honest enough at this stage.

## 5. Output schema — what the backtest writes back

Each simulated trading day produces one document in `daily_picks_backtest` (collection already exists). The schema is already defined in `src/models/dailyPickBacktest.js` — no changes needed. Per day we record:

- `trading_date`, `scan_date`
- `market_context` (regime, score if computable, else NEUTRAL placeholder)
- `picks[]` (each with planned levels, simulated entry/exit, P&L, status)
- `summary` (counts, candidates seen, viable, selected)
- `results` (winners, losers, avg_return_pct, total_pnl, best/worst)
- `comparison` (versus real DailyPick on the same date, if one exists)

Plus a new aggregate roll-up document per backtest run:

```
backtest_run_{timestamp}:
  config: { path: 'A'|'B', capital, fee_pct, start_date, end_date }
  totals: {
    days_simulated, days_with_picks, days_no_pick,
    trades_total, trades_closed,
    wins, losses, breakeven,
    hit_rate_pct,
    avg_return_per_trade_pct,
    avg_planned_R,
    avg_realized_R,
    expectancy_in_R,
    total_pnl_inr,
    max_consecutive_losses,
    max_drawdown_inr, max_drawdown_pct,
    sharpe_proxy_daily,
    best_day_pnl, worst_day_pnl,
  }
  by_regime: { STRONG_BULL: {...}, WEAK_BULL: {...}, NEUTRAL: {...}, WEAK_BEAR: {...}, STRONG_BEAR: {...} }
  by_scan_type: { recovery_breakout: {...}, shortlist_short: {...} }
  by_direction: { LONG: {...}, SHORT: {...} }
  by_month: [ Jan: {...}, Feb: {...}, ... ]
```

This roll-up is what we read to make decisions.

## 6. Statistical analysis — what we compute from results

For each backtest run, we compute the following. None of these are vanity metrics; each maps to a specific decision.

### Headline metrics

- **Hit rate** — % of closed trades with P&L > 0. Useful as a sanity check, not a target. **70% is unrealistic** for this strategy class; 45–55% is the achievable range.
- **Expectancy in R** — Average `realized_R` per trade. This is the metric that actually matters. `≥ 0.2R` means the strategy makes money over many trades; `< 0` means it loses systematically.
- **Average planned R** — Average `risk_reward` set at entry. Tracks whether the levels engine is producing real R-asymmetric setups vs ~1R coin-flips.
- **R drift** — `avg_realized_R − avg_planned_R`. Negative drift > 0.3 means realized outcomes are systematically worse than planned (typically: targets too far, exits too jumpy, slippage worse than modeled). The audit found planned R averaging ~1.1 and realized R near 0, so drift was ~−1.0R — catastrophic.
- **Max consecutive losses** — How long the system loses before recovering. Above 6 in a row is psychologically and financially intolerable for retail.
- **Max drawdown** — Peak-to-trough equity loss. Must be < 30% of starting capital to be tolerable.
- **Sharpe proxy (daily)** — `avg_daily_pnl / std_daily_pnl`. Not annualized (no risk-free conversion). Useful for relative comparison only.

### Regime-conditional analysis

The system *must* perform differently across regimes. If hit rate is identical in STRONG_BULL and STRONG_BEAR, the regime engine is providing no value and should be simplified or removed. Specifically check:

- LONG hit rate in STRONG_BULL vs WEAK_BEAR — should be substantially higher in the former.
- SHORT hit rate in STRONG_BEAR (if `ENABLE_BEAR_SHORTS=true`) — must be > 50% to justify the path.
- Trades-per-day count by regime — system should trade more in conviction regimes, less in NEUTRAL.

### Time-of-day and time-of-month analysis

Indian markets have known seasonality. Expect to see:
- Worse performance on expiry days (last Thursday of the month for monthly, every Thursday for weekly).
- Worse performance immediately after major events (RBI policy, budget, election results).
- Better performance in the first 60 minutes after open.

If the backtest shows performance is *identical* across all of these, something is wrong with the harness — real Indian intraday data has these patterns.

### Drawdown sequence

Plot equity curve day by day. Mark each drawdown period. For each drawdown > 10%:
- Was it concentrated in one regime?
- Did one stock or one scan type cause it?
- Was it driven by a few outsized losses or a slow grind?

This is the most useful single chart for deciding whether to deploy.

## 7. Decision framework — when to ship vs not ship

The backtest output is only useful if we agree in advance what it has to show before we deploy. Without that agreement, every result gets rationalized.

### Minimum bar to ship to live trading with full capital

All four must hold simultaneously:
1. **Expectancy ≥ 0.2R per trade** over the full 250-day window, after the 0.25% round-trip fee model.
2. **Hit rate between 45% and 65%.** Above 65% with low planned-R is suspicious and probably overfit; below 45% with high planned-R can work but requires patience that most retail can't sustain.
3. **Max drawdown ≤ 25%** of starting capital.
4. **Max consecutive losses ≤ 7.** Anything higher and the live operator will turn off the system during the drawdown, exactly when they shouldn't.

### Minimum bar to ship to paper trading

Two must hold:
1. Expectancy ≥ 0.1R per trade.
2. No single month had drawdown > 15%.

Paper trade for 30 trading days, then re-evaluate.

### Stop and rewrite

If any of these:
1. Expectancy negative across 250 days.
2. Hit rate < 40%.
3. Single-day worst loss > 5% of capital (suggests stops aren't being respected or position sizing is broken).
4. The scanner picks lose money but the intraday machinery turns it profitable. This is suspect — usually means the backtest harness has a look-ahead bug.

## 8. Risks and limitations to disclose alongside any result

Every backtest report must carry these caveats in writing:

1. **Survivorship bias in the universe.** The F&O list used today is not the F&O list of 250 days ago. Stocks delisted from F&O between then and now are invisible to the backtest. Estimated impact: 5–15% optimistic bias on hit rate.

2. **Look-ahead bias risk.** Even with careful engineering, scanner.py's daily-candle inputs include the *current* day's close in some sub-computations (e.g., RSI on yesterday's close vs the open of today is sometimes muddied). The backtest harness must explicitly use `candles[i-1]` not `candles[i]` for each decision day. Audit this carefully before trusting results.

3. **Slippage is single-figure flat.** Real slippage on Indian midcaps in panic VIX days is dramatically worse than 0.05%. The 0.25% round-trip is an *average*; on the worst 5% of trades it could be 1–2%. The expectancy result will be optimistic.

4. **Liquidity is not modeled.** A ₹500k notional position can move a thinly-traded midcap. The backtest assumes infinite liquidity at the candle prices. Most painful in `recovery_breakout` picks on names with avg daily turnover < ₹50 crore.

5. **No real-time news.** The shortlist's `catalystSignal` scrapes overnight news live and can't be replayed. Path A and B both run without catalysts. This means the bear-shorts path (Path B only) is using a partial signal set.

6. **Walk-forward, not in-sample.** Hyperparameters were tuned to recent live data (Phase 3 tuning notes in `dailyPicksConstants.js`). The backtest tests them on data they were tuned against — that's overfitting risk. For honest validation, hold out the most recent 30 days entirely, tune on the older 220 days, and report results on the held-out window separately.

7. **The 0.5R cushion and two-bar confirmation logic was added May 22, 2026.** No live data exists with these rules active. The backtest is the *first* test of these — there's a real risk that backtest results look great but live behavior diverges because the new logic interacts with intraday noise differently than 15-min candle replay captures.

## 9. Phased timeline

Assuming one developer working solo:

**Week 1 — Path A**
- Day 1: Write the walk-forward driver. Wire it to the existing daily-candle Mongo collection. Implement the next-day evaluation logic.
- Day 2: Run, debug, validate against the 10 existing `daily_picks_backtest` documents (sanity check that days we have ground truth for produce sensible numbers).
- Day 2 EOD: Write up Path A results, share, decide whether Path B is justified.

**Week 2 — Path B (only if Path A justifies it)**
- Day 1: Run `prefetchAllStockData.js` for 90 days of 15-min candles. Verify completeness. Backfill VIX/FII/breadth for 90 days.
- Day 2: Build the regime-replay step (compute `marketContext` per day from the backfilled inputs).
- Day 3: Wire the full pipeline into the backtest engine. Day-by-day replay through `validatePicks`, `analyzeIntradayStructure`, `checkPartialBooking`, `computeDynamicTrail`.
- Day 4: Bug fixes (IST timezone, market-hours filtering, missing-data handling, the new 0.5R cushion + two-bar confirm logic).
- Day 5: Run the 90-day Path B + 160-day Path A combined run. Write up.

**Week 3 — Decision**
- Day 1: Review combined results against the decision framework in §7. Three branches:
  - Ship to paper trade.
  - Tune one specific thing the backtest exposed (e.g., loosen the structural exit further, or tighten the chase guard).
  - Stop and rewrite.

## 10. What I'm NOT planning to do, and why

These were considered and rejected:

- **A neural-net or ML regime classifier.** Too little data. ML models on 250 days of one market regime are guaranteed to overfit. Wait until you have 3+ years of clean data.
- **Monte Carlo simulation of slippage.** Adds complexity, doesn't change the order of magnitude of the result. The 0.25% flat is fine for a first pass.
- **Optimizing parameters with the backtest.** Optimizing on the same data you validate on is the cardinal sin of quantitative research. The backtest is for *validation* of the current parameters, not tuning. If results are bad, change parameters and re-run; do not search.
- **Backtesting the live monitoring jobs (`intradayMonitorJob.js`, etc.).** These manage state across 5-minute cycles. Replaying them requires tick-or-quote data we don't have. Path B's day-by-day replay is the right level of abstraction for now.
- **Building a UI for the backtest.** Results go to Mongo (`daily_picks_backtest`) and a markdown/JSON roll-up file. UI is wasted effort until results are good enough to share with stakeholders.

## 11. Next step

If you approve Path A: I'll write the walk-forward driver, run it on the 269 days of daily data already in your Mongo, and have results in 1–2 days.

If you want Path A and Path B together: I'll do Path A first, then immediately start Path B with the data backfill running in parallel.

If neither: this document is the artifact. Hand it to a developer with the codebase and they can execute.

---

*This plan is intentionally conservative. The honest version of any backtest report is "here is what we tested, here are the things we deliberately couldn't test, here is what the result means and doesn't mean." If the eventual report claims certainty beyond what the data supports, ignore that report.*
