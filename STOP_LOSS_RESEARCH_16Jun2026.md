# Stop-Loss for the ORB "Stocks in Play" Strategy — What the Research Says

*16-Jun-2026. Question: should the protective stop be widened (the 0.25×ATR buffer), and what is the ideal stop distance from entry for this strategy?*

## Bottom line

**Don't widen — go tighter.** Your strategy is the Zarattini/Barbon/Aziz "stocks in play" ORB paper (your code cites SSRN 4729284), and its entire edge rests on a **deliberately tight stop**. Moving to the opposite OR edge (your 15-Jun change) and then adding a 0.25×ATR buffer (my 16-Jun change) both move *away* from the validated edge. The wick-out problem is real, but the paper's fix is **re-entry**, not a wider stop.

## What the paper actually specifies (this is your strategy)

- **Entry:** resting stop order at the 5-min opening-range edge — you have this.
- **Stop:** **0.10 × 14-day ATR from the fill.** Tight. For HCLTECH (ATR ≈ ₹20) that's ~₹2 *below the entry* — not the opposite OR low (₹8.5 away). Your own retired constant `PAPER_STOP_ATR_MULT = 0.10` is exactly this.
- **Target:** none — **hold to EOD** (your 15:15 force-exit).
- **Sizing:** 1% risk per trade, ≤4× leverage — you have this.
- **Selection:** top-20 by opening relative volume — you have this.
- **Result (top-20 RVOL version):** 1,637% total / **41.6%/yr, Sharpe 2.81**, hit ratio **48.4%** (note: <50% — a low win rate is *by design*).

The companion QQQ paper (SSRN 4416622) swept the stop explicitly: **0.05×ATR was optimal** (zero-slippage; they flag it as unrealistic at size), **0.10×ATR is the realistic choice**, and holding to EOD beat every profit target.

## Why tight wins and wider loses (the math)

- **240,102-trade ORB study (orbsetups):** tight stop → **41.8% win, expectancy 0.044**; wide stop → **67.8% win, expectancy 0.025**. The tight stop nearly **doubles expectancy** while cutting win rate 26 points. Higher win rate, lower edge.
- **The edge is asymmetry.** Many tiny −1R losses, paid for by rare EOD-held **5–13R** runners (the paper's BLDR example is +13.6R off a ₹0.50 risk). The stop is the *denominator of every R-multiple* — widen it and you simultaneously shrink every winner's R and enlarge every loss, collapsing the positive skew the whole model depends on (Van Tharp; Carver on skew).
- **Position sizing does NOT make stop width P&L-neutral.** I implied earlier that widening the stop is "risk-neutral" because qty shrinks to hold 1% risk. That's wrong on expectancy: fixed-fractional sizing rescales *rupee risk* but stop width *reshapes the outcome distribution* (win rate, avg win in R, avg loss in R). The 240k table is the same instrument, same 1R framing, and tight still wins. Stop width is the single biggest structural lever after selection.
- **Widening a stop to raise win rate is a classic over-optimization trap** — it flatters the in-sample equity curve and crumbles out of sample.

## Why your OR-edge stop wicks (the real diagnosis)

For a 5-min opening range, **~71% of days break *both* sides**, and **~86% of days that break one side also tag the other.** The opposite OR edge sits squarely inside that wick zone — statistically the worst place to put a stop. Your 15-Jun switch to the OR edge moved the stop *into* the noise band; my buffer pushed it further out. Neither addresses the actual cause.

## The right fix for the wicks (not a wider stop)

1. **Tighten back toward the paper:** stop = breakout edge ∓ ~0.10×ATR (sweep 0.05–0.20), measured from the entry — not the opposite OR edge.
2. **Close-confirmation:** exit only on a 5-min *close* beyond the stop, not an intrabar touch. (On HCLTECH, nothing closed below 1141 — close-confirmation alone saves the trade.)
3. **Re-entry on the second breakout / reclaim.** This is what recovers the edge lost to tight-stop whipsaws: take the tiny −1R, re-enter when the level breaks again, catch the move. HCLTECH = small loss, re-enter, ride the afternoon run to 1160. *This is the #4 you already asked for — and the research says it's the actual fix, not the buffer.*
4. **Entry-quality filters** (RVOL, VWAP-side) cut false breakouts upstream so fewer trades get wicked at all.

## What to do

- **Do not increase the buffer.** Reconsider the OR-edge stop entirely — both it and the buffer contradict the paper.
- **Backtest the stop as a grid on YOUR NSE F&O data:** {0.05, 0.10, 0.15, 0.20, 0.30} × ATR from the breakout edge, plus the current OR-edge, and read the **expectancy / Sharpe / total** curve — *not* the win-rate curve. (You changed to the OR edge on 15-Jun for some reason; the grid will show whether NSE F&O genuinely behaves differently from the US universe, or whether the tight paper stop wins here too.)
- **Pair the winning tight stop with close-confirmation + re-entry** — that combination targets the wick problem directly while preserving the asymmetry.

## Sources

- Zarattini & Aziz — *Can Day Trading Really Be Profitable?* (SSRN 4416622) — 0.05×ATR sensitivity optimum, 1% risk, 10R/EoD, 24% win rate by design. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4416622
- Zarattini, Barbon & Aziz — *A Profitable Day Trading Strategy for the U.S. Equity Market* (SSRN 4729284) — your strategy; 0.10×ATR stop, resting OR-edge entry, EoD hold, top-20 RVOL, Sharpe 2.81. https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4729284
- orbsetups — *How to Identify and Avoid False Breakouts* (240,102 trades) — tight-vs-wide stop expectancy table; 5-min OR bracketed both sides ~71–86%. https://orbsetups.com/research/how-to-identify-and-avoid-false-breakouts-a-data-driven-approach/
- Van Tharp — *R-multiples & expectancy* (why a tight stop is the unit of risk). https://vantharpinstitute.com/tharp-think-trading-concepts/
- Robert Carver — *Skew and Trend Following* (high win rate buys negative skew / tail risk). https://qoppac.blogspot.com/2019/02/skew-and-trend-following.html
- QuantifiedStrategies — *Stocks in Play / Stop-Loss strategy* (stop as paid insurance; tight vs wide). https://www.quantifiedstrategies.com/stocks-in-play-trading-strategy-day-trading/
- Trade That Swing — first-5-min OR bracketing stats. https://tradethatswing.com/high-probability-stock-market-statistics/

*Confidence: the paper specs and the 240k-trade expectancy table are high-confidence (primary sources). The re-entry edge-recovery is mechanically sound but the least-quantified claim — validate the magnitude on your backtest.*
