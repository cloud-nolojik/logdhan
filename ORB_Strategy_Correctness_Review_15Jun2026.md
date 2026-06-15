# LOGDHAN ORB — Is the deployed intraday strategy "correct"?

**Date:** 15 Jun 2026
**Scope:** (1) Does the running code faithfully implement the paper it cites? (2) Is it likely to be profitable on NSE?
**Source paper:** Zarattini, Barbon & Aziz, *A Profitable Day Trading Strategy for the U.S. Equity Market*, SFI Research Paper 24-98 / SSRN 4729284 (16 Feb 2024) — the "Stocks in Play" 5-minute ORB.

---

## Bottom line

The implementation is a **faithful port of the paper's trade mechanics** — on the core rules it matches 4729284 almost exactly. The problem is **not the logic, it's the economics**: the deviations that exist (8 funded slots vs 20, a proxy RVOL, an F&O-only universe) all push you toward the paper's *fragile* case, and the paper's edge (~+0.08R per trade) is too small to survive NSE intraday transaction costs given how tight the 0.10×ATR stop makes 1R. As deployed, the strategy is **most likely net-negative after costs and slippage**, not because it's wrongly built but because the cost structure was never re-derived for India.

A useful frame: the paper's *base* strategy (same mechanics, no relative-volume selection) earned only **3.2%/yr, Sharpe 0.48** — barely above zero. The jump to **41.6%/yr, Sharpe 2.81** came entirely from (a) precise high-relative-volume selection, (b) a diversified ~20-name long/short book, and (c) near-zero US per-share commissions. The deployment weakens all three.

---

## 1. Faithfulness to the paper

### Matches the paper (core mechanics — high marks)

| Rule | Paper (4729284) | Deployed code | Verdict |
|---|---|---|---|
| Opening range | First 5-min candle (09:30–09:35 ET) | First 5-min candle (09:15–09:20 IST), `slotKey==='09:15'` | ✅ |
| Direction | First-candle bullish → long only; bearish → short only; doji → skip | Same (`close>open`→LONG, `<`→SHORT, doji→skip) | ✅ |
| Entry | Resting **stop order** at OR high (long) / low (short), in trend direction | Resting **SL-M** at OR edge, no confirmation, no distance floor | ✅ |
| Stop loss | **10% of daily ATR(14)** from fill | `PAPER_STOP_ATR_MULT = 0.10 × ATR14d` from fill | ✅ |
| Profit target | **None** — exit on stop or end of day | None — stop or 15:15 force-exit | ✅ |
| Selection | Relative Volume ≥ 100%, trade **top 20** by RV | `RVOL5_MIN = 1.0`, `RVOL5_TOP_N = 20` | ✅ (see caveat 2) |
| Index/regime gate | None | None (regime gate is dead-gated legacy) | ✅ |
| Risk sizing | Size so a stop = **1%** of capital | `PAPER_RISK_PCT = 1.0` | ✅ |
| Liquidity/vol filters | price>$5, 14d vol>1M sh, ATR(14)>$0.50 | F&O universe (liquid by construction) + `PAPER_MIN_ATR14D` | ⚠️ (see caveat 4) |

Worth calling out: the code comment claiming *"the paper has no profit target"* is **correct** for 4729284. (The 10R target people associate with Zarattini is from the earlier single-asset QQQ/TQQQ paper, ref [23] — a different study. You cited the right one.)

### Deviations from the paper (faithful-but-altered)

1. **Funds only 8 of the top 20 (capital-limited).** `PAPER_MAX_ENTRIES = 8` because 5× cash ≈ ₹78k only spans 8 slots. The paper's smooth 2.81 Sharpe is a **breadth** result: an average edge of +0.08R/trade only compounds into a clean equity curve across many roughly-independent positions. Eight names/day (often fewer filled) gives a lumpy, high-variance realisation of the same EV. This is the single biggest structural departure.

2. **RVOL is a 09:21 proxy, not the paper's measured OR volume.** The paper computes RV = (actual first-5-min volume) ÷ (14-day average first-5-min volume) *after* the 5-min candle closes. The code estimates it at 09:21 as day-cumulative volume ÷ (09:15-slot average × **0.55**), to allow arming at 09:24. Selection *is* the entire edge (base strategy without it = 3.2%/yr), so noise here goes straight to the bottom line. The `0.55` fraction is also flagged in your own code as un-calibrated.

3. **Universe = ~215 NSE F&O names, not ~7,000 US stocks.** The paper's returns are driven by the **high-RV tail** (its Fig. 4: RV>100% averages only +0.08R/trade, but the 30× RV bucket averages +0.38R). A 215-name universe rarely surfaces 10×–30× RV "in play" names, so you trade much closer to the marginal +0.08R than to the tail that pays.

4. **ATR floor mis-scaled.** Paper filter is ATR(14) > **$0.50** — a genuine volatility floor for $5–$500 US stocks. The code ports it as **₹0.50**, which on ₹100–₹50,000 NSE stocks is effectively a no-op (it only guarantees the stop ≥ 1 tick). The volatility-floor intent is lost.

5. **Leverage 5× (MIS) vs 4× (US Reg-T).** Minor; amplifies both tails.

6. **Long/short symmetry depends on short availability.** The paper is market-neutral (β≈0) because it runs longs and shorts daily. If intraday MIS shorting is restricted on some of your names, half the book disappears and the neutrality with it.

---

## 2. Likely profitability on NSE

### The decisive issue: 1R is tiny relative to Indian costs

The 0.10×ATR stop is **very tight**. For a liquid large-cap, ATR(14) ≈ 1.5–2.5% of price, so:

- **1R = stop distance ≈ 0.10 × ~2% ≈ 0.2% of position value** (this morning's live trades confirm it: ASIANPAINT stop ₹6.15 on ₹2,780 = 0.22%; PETRONET ₹0.65 on ₹287 = 0.23%).

NSE equity **intraday** round-trip cost (verified, Jun 2026): STT 0.025% (sell) + exchange txn ~0.00297%×2 + stamp 0.003% (buy) + SEBI + 18% GST + brokerage (₹20-or-0.03% cap) ≈ **~0.10% of position value per round trip**, before slippage. SL-M exits fill at market, so add realistic slippage of a tick-plus in fast moves.

Putting it in the paper's own unit:

> **Friction ≈ 0.10% ÷ 0.2% ≈ 0.5R per trade in explicit costs alone**, plus stop-market slippage → call it **~0.3–0.6R of friction per trade**.

The paper's *average* edge at RV>100% is **~+0.08R**, and even its **30× RV bucket is only +0.38R**. In other words, the Indian cost of one trade is comparable to — or larger than — the gross edge of even the best relative-volume bucket. The US backtest survived because $0.0035/share on a $50–$100 stock is ~0.005% — negligible against the same stop. **That cost advantage does not translate, and it's the crux.**

### Secondary profitability risks

- **Small-N variance.** ≤8 trades/day (frequently fewer filled) means a true small +EV needs thousands of trades to surface. Expect long, deep drawdown stretches even if the edge is real — and you can't tell an unlucky run from a dead edge for months.
- **Selection noise** (caveat 2) directly degrades the only thing that lifted the paper above 3.2%/yr.
- **Concentration** (8 names, possibly net-directional on a given day) raises worst-day risk vs the paper's diversified book — the paper itself noted the 20-name version already had a *worse* worst-day than the all-stocks book.
- **Right-skewed payoff, 48% hit rate.** With no target and EOD exit, profits live in a few large-R winners. Tight stops + costs eat the many small trades while you wait for the rare big R — the maths only works if the big-R winners are genuinely large *net of ~0.5R costs*, which requires the high-RV tail you mostly can't reach in F&O.

---

## 3. What I'd do before trusting it with size

These are ordered by impact on the profitability gap, not effort:

1. **Backtest on NSE data with realistic costs + SL-M slippage**, and report the distribution of **per-trade R net of costs**. This single number settles the question. If net average R ≤ 0, nothing else matters.
2. **Widen the stop** (e.g. 0.25–0.5×ATR, or test a range). A bigger R directly improves the cost/R ratio — and the paper explicitly found stop width drives expected value. The 0.10×ATR value was tuned for a near-zero-commission world.
3. **Recover breadth or accept the variance.** Either fund ~20 slots (smaller per-slot size / more capital) to get the law-of-large-numbers the edge needs, or explicitly accept that 8 slots is a high-variance bet on the same EV.
4. **Replace the 09:21 RVOL proxy** with the true first-5-min OR-volume RV once the 09:20 candle closes; calibrate or retire the `0.55` fraction. Arm a minute or two later if needed — selection precision is worth more than the head start.
5. **Re-scale the ATR/volatility floor** to something meaningful for INR price bands (ATR% of price, or a price-banded ₹ floor), so it actually screens out low-vol names where cost/R is worst.
6. **Confirm intraday short availability** across your F&O names so the long/short symmetry (and β≈0 property) actually holds.

---

## Sources

- [Zarattini, Barbon & Aziz — *A Profitable Day Trading Strategy for the U.S. Equity Market* (SSRN 4729284, full PDF)](https://www.alexandria.unisg.ch/server/api/core/bitstreams/3c2989c4-688d-4d78-8a71-f02690990d51/content)
- [SSRN abstract page (4729284)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4729284)
- [Swiss Finance Institute — Research Paper 24-98](https://www.sfi.ch/en/publications/n-24-98-a-profitable-day-trading-strategy-for-the-u.s.-equity-market)
- [Zerodha — brokerage, STT and intraday charges](https://zerodha.com/charges/)
- [NSE — SEBI turnover fees, STT and other levies](https://www.nseindia.com/static/invest/first-time-investor-sebi-turnover-fees-stt-other-levies)
- Deployed spec read from `backend/src/services/orb/orbService.js` (constants block + `placeOrbEntryOrdersOn`, `placePaperProtectiveStop`).
