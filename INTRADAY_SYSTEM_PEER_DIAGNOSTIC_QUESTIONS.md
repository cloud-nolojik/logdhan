# Intraday Auto-Trading System — Peer-Comparison Diagnostic Questions

A question-set to evaluate an intraday stock-picking + auto-order system against peers (Streak, Sensibull, Tickertape Screens, AlgoTest, prop-desk setups, Chartink + manual hybrids). Organised so that each section exposes a dimension where systems typically differ.

Each question has two parts — **what your system does**, and **what a peer would have to answer differently to beat you on that axis**. Use it as a self-audit, not a tick-box.

---

## 1. Signal quality — what are you actually ranking on?

1. On a flat-SGX morning with no overnight news, can your system still produce ≥3 high-conviction picks, or does it collapse to 0–1? (If yes, what is the non-news signal carrying the day? If no, you are a news-trading system labelled as an intraday system.)
2. What is the independent-signal count on your best pick today? Peers that rely on a single scanner condition collapse to 1; a multi-signal composite (catalyst + gap + RS + sector + volume + regime fit) should report ≥3 agreeing signals per pick.
3. Does your signal set include at least one **leading** indicator (pre-open depth, overnight futures flow, options OI shift), at least one **contemporaneous** indicator (opening-range volume, first 15-min ATR%), and at least one **lagging** confirmation (sector breadth, RSI zone)?
4. How does your scanner distinguish "momentum continuation" from "extended chase"? A peer without a chase penalty will keep flagging stocks at +3 ATR above EMA20 as buys.
5. What is your stock's RSI ceiling before the stock is rejected as over-extended? (BHEL today sat at RSI 77 — a system with no RSI cap would buy it at the top.)
6. Do you score sector leadership separately from stock RS, or is sector just a tag? The failure mode is picking an underperforming stock in a top sector because RS alone saved it.
7. Are your weights static or regime-adaptive? In a WEAK_BULL regime, is `direction_fit` really only 0.05 of composite — should it be higher in clearly-trending regimes and zero in NEUTRAL regimes?
8. Does your shortlist have look-ahead bias? (E.g., does any signal use today's close, a forward sector return, or any data not available at 08:30 AM?)
9. How often is your signal ordering replicable across re-runs? A non-deterministic scorer (tied on composite, broken by Map iteration order) is invisible bugs waiting to happen.

## 2. Execution — the gap between "pick" and "fill"

10. What is your average slippage between signal price and actual fill, in bps? Do you track it per-stock or only in aggregate? Peers usually don't track this at all.
11. What order type enters the position — MKT, SL-M, LMT, or a hybrid? On what logic is the choice made (e.g., LMT for liquid large-caps, SL-M for momentum, MKT never)?
12. How do you handle a partial fill at 09:30 — add to position at 09:46, cancel and re-signal, or accept the partial? Peers that don't have an explicit policy get inconsistent position sizes.
13. What is your policy for "entry condition no longer valid" between pick time and order fire time? (E.g., the pre-market gap estimate said LONG, but at 09:15 the stock opens down 2% — do you still fire, abort, or re-evaluate?)
14. Does the system send a single order or split into iceberg/TWAP for large tickets? At what rupee-size does the behaviour change?
15. When the broker API rejects an order (margin, risk, freeze period), what happens to the pick — retried, demoted, logged, notified? Silent failure is the most common peer weakness.
16. What is your latency from signal-generation to order-placement, measured p50 / p95 / p99? Under 2 seconds is table stakes for intraday.

## 3. Position management & exits

17. Is the stop fixed-pct, ATR-based, or structure-based (below last swing low / EMA20)? Fixed-pct stops on wildly different volatility profiles (BHEL ATR% 2.4 vs. HDFCBANK ATR% 1.0) create wildly different risk exposures per stock.
18. Do you trail the stop, and on what trigger — new high, close above prior high, breakeven hit, partial book? Peers without trailing leave money on the table; peers with aggressive trailing get stopped on noise.
19. Do you take partial profits? At what multiple of R, and how is the remaining position's stop adjusted?
20. Is there a **time-based** exit? (E.g., if position is still flat after 2 hours, or the stock has gone sideways in a tight range for 45 min, exit.) Peers without this sit in dead positions until EOD.
21. What is your force-exit rule for EOD and how early does it fire? A 15:00 force-exit vs a 15:15 force-exit means different liquidity and slippage regimes.
22. Does an exit trigger re-enter the same stock if conditions re-qualify, or is there a cool-off? Without cool-off you can churn. With too long a cool-off you miss the real re-entry.

## 4. Risk & capital management

23. What is your per-trade max loss, in ₹ and in % of capital? Does it scale by regime_score (smaller on WEAK_BULL, larger on BULL)?
24. What is your daily loss kill-switch? At what drawdown does the system refuse new signals for the rest of the day?
25. Do you enforce correlation caps — e.g., "max 1 BANKING" and "max 2 ENERGY stocks simultaneously"? Symbol-level diversity ≠ risk diversity. (Your BANKING cap of 1 dropped ICICI today — does it still apply when Bank Nifty leads the tape?)
26. How do you size positions — fixed qty, fixed ₹ notional, volatility-parity (equal ATR-risk), or Kelly? Peers almost universally use fixed notional; volatility-parity is where prop desks start separating themselves.
27. What is your max concurrent intraday exposure vs. your capital? Leverage usage is a real variable — some brokers give 5x intraday; 5x is only "free money" when your edge is stationary.
28. What happens on circuit / market halt / broker API outage? Is there a pre-agreed position-unwind policy, or does the system just freeze?
29. Do you check margin availability at 08:30 *and* at 09:15? A pick generated against stale margin data will reject at the broker.

## 5. Regime & context awareness

30. How many distinct regime states does your system recognise, and do they meaningfully change behaviour (trade count, size mult, gate thresholds, playbook)? Peers with one regime ("is Nifty up?") will overfit to bull markets.
31. How often does regime recheck run? Once at 08:30 and once at 11:00 is thin — what about 13:00 and 14:30? (Your `regimeRecheckJob` currently runs 11:00 only.)
32. Does the system behave differently on expiry days (weekly Thu, monthly last-Thu)? Options unwinds distort price action — a naive intraday system will be whipsawed.
33. Does it skip / down-size on known-event days (RBI policy, Fed, CPI, Budget, election results)?
34. Are earnings days for individual stocks flagged and handled (skip, down-size, widen stop)? Your `earningsFilter.js` filters for lookahead — does it also handle *today's* earnings?
35. Does the system recognise a gap-fade regime vs. a gap-and-go regime, or does it use the same playbook for both?
36. How does it handle Monday-open behaviour differently from mid-week open behaviour? Monday gaps tend to fade more often; peers using identical logic across all weekdays miss this.

## 6. Cost & capital efficiency

37. Does your edge calculation subtract round-trip cost — brokerage + STT + stamp duty + GST + exchange fees + SEBI turnover + slippage? An edge of 0.4% per trade sounds fine until you realise the all-in cost is 0.25%.
38. What is your capital utilisation per day, measured as avg deployed ÷ total capital? Picking 1 stock out of 2 slots today means 50% utilisation — is that intentional or a filter bug?
39. Do you reinvest realised profits intraday, or park them until next session? This matters for Kelly-sizing consistency.
40. How do you handle a margin call mid-day? Forced exit on the winner, the loser, or the lowest-conviction position?

## 7. Observability & diagnostics

41. For any pick that made it to final selection, can you reproduce the full pipeline decision: composite score, each signal value, each gate pass/fail, diversity cap impact, AI insight text? Your log seems to log most of this — does the frontend dashboard surface it?
42. For any stock that was *dropped*, can you answer in one query "why was it dropped, at which step, and what threshold was it short by"? The `neutralDropped` set is tracked — is it exposed to the UI?
43. Do you track per-signal hit-rate: "stocks tagged with catalyst=1 won 62% of the time over last 90 days; stocks tagged with sector_top3=1 alone won 48%"? Without per-signal attribution, you can't prune bad signals.
44. Is there a scan-duration / signal-staleness dashboard? Today your shortlist took 16.7 seconds; is that normal, fast, or an early sign of API degradation?
45. Do you alert when signal_status shows `degraded` or `failed` for any signal — and when a pick was selected with one or more signals in that state?
46. Is there replay-ability — can you re-run today's 08:30 scan on demand against the same inputs to debug, or is the scan a destructive mutation that overwrites state?

## 8. Edge quantification (backtest vs. live)

47. What is your live hit-rate, and how does it compare to backtest? A drop of more than 10 pp live-vs-backtest is the fingerprint of look-ahead bias.
48. What is your avg R-multiple on wins vs. avg R on losses? Anything with win-R < 1.5 × loss-R needs a hit rate above 50% to be profitable after costs.
49. What is your Sharpe / Sortino / Calmar over your live track record? Peers that only report "returns" are hiding volatility.
50. What is your max drawdown, and how long did recovery take? Most retail algos have never seen a real drawdown because they launched post-Covid.
51. Do you walk-forward validate (train on 2020–2022, test on 2023; retrain on 2020–2023, test on 2024), or did you optimise on the full history once?
52. Are your results net of a realistic cost model, or gross? Gross returns are useless.
53. What is your beta to Nifty? If it's 0.9, you're an expensive index tracker.

## 9. Failure modes & resilience

54. What is the system's behaviour when the catalyst scraper's only source (Upstox article) is late, 500s, or formatted differently? Is there a fallback or does catalyst go to `failed` and the day becomes sector-less?
55. What happens on broker token expiry mid-day? Is there a refresh job, a retry, or does the position become un-manageable?
56. What happens if the scheduler fires twice (process restart, duplicate Agenda job)? Do you get double positions?
57. If MongoDB is slow or unavailable at 08:30, what happens — abort scan, serve stale shortlist, or crash?
58. What is your recovery behaviour if the system was down at 09:30 and comes up at 10:15 — does it still try to enter the 09:30 picks, skip the day, or honour pass-2 / pass-3 only?
59. Is there a "shadow mode" for new signals — compute but don't trade for N days? Your `shadowMode.js` exists; is it actually wired in for new signal rollouts?

## 10. Peer-comparison axes (explicit)

60. **vs. Streak / Tickertape Screens:** Streak offers user-defined scanner conditions but no composite score, no regime adaptation, no AI insight. Does your system's added complexity produce measurably better hit-rate, or is it just more moving parts?
61. **vs. Sensibull:** Options-Greek-aware. Does your F&O universe selection consider the *options* side (OI build-up, IV skew, put-call ratio) or only the underlying?
62. **vs. Chartink + manual execution:** Chartink is pure screener — trader decides trade. You automate the decision. Is the automated decision at least as good as a disciplined human using the same screener? If you can't prove this, you have automation without edge.
63. **vs. AlgoTest / QuantFi:** They do rigorous backtest + paper trade then go live. What is your backtest-to-live pipeline, and how much live data do you need before promoting a signal from shadow to trading?
64. **vs. prop-desk setups:** Prop desks have dedicated exit-management engines (separate from entry engines), tick-data replay, and co-location. You are unlikely to beat them on speed; where is your edge — sector-rotation sensing, news parsing, or discipline?
65. **vs. "just buy Nifty":** After costs, what is your alpha over buy-and-hold Nifty on the same capital? If your Sharpe isn't at least 1.5 and your max drawdown isn't materially lower, you are selling complexity, not edge.

## 11. Self-honesty questions

66. If the next 5 trading days produce 0 catalysts (no Upstox article content hits your F&O universe), does your system still trade? If the answer is "no / very little", the system is a news-trading system.
67. If you removed the 08:30 scan entirely and replaced it with "buy the top 2 stocks in the top-3 sectors with volume ≥ 1.5x", how much worse would you be? This is your actual benchmark — not Nifty.
68. What is the last signal you *removed* from the composite because it wasn't pulling its weight? A system that has only added and never subtracted is over-parameterised.
69. If you had to defend your system to a sceptical trader in two sentences, what is its edge, and in what regime does that edge break? The inability to answer this is itself a diagnostic.
70. Over your live track record, what percentage of your total P&L came from the top 3 trades? If it's >60%, your system isn't a system — it's a few lucky catches.

---

**How to use this list:** Score your answers 0 / 1 / 2 per question (no-policy / has-policy / measured-and-optimised). 140 is the ceiling. Anything under 90 means peers with half your complexity may be beating you on execution hygiene. Anything over 120 means the complexity is earning its keep.

The questions are deliberately phrased so that a "no" answer is informative — it identifies an axis where you are probably worse than a competent peer. "Unknown" is the worst answer; it means there's no instrumentation to even check.
