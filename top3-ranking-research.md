# From "Active" to Top 3: Ranking In-Play NSE F&O Stocks at the Open

*Research brief — 16 Jun 2026. Question: given a set of high-RVOL "in-play" names ranked ~6 min after open (09:21 IST), how do we narrow to the 3 highest-quality ORB / momentum candidates — adding directional conviction and risk-adjusted quality on top of raw RVOL?*

---

## TL;DR — the three things the evidence is loudest about

1. **Your biggest leak today was the stop, not the selection.** The strongest single piece of research in this whole brief (Zarattini & Aziz, 7,000+ US stocks, 5-min ORB) found that placing the stop at the **opening-range edge / day's extreme is the wrong choice** — it sits inside the noise band and gets wicked. They get materially better results from an **ATR-fraction stop placed outside the noise + holding to EOD**. That is almost exactly the HCLTECH trade: directionally right, stopped on the day's low, closed +3.7%. Fix this before touching the ranker.

2. **RVOL measures attention, not direction — and at the extreme it flips from signal to warning.** Moderate, *persistent* RVOL (≈1.5–3×) confirms continuation; a single **extreme spike (your 14.5× AARTIIND) is the exhaustion/climax regime and is reversal-prone.** Ranking purely by peak RVOL systematically surfaces the names most likely to fade. Extreme RVOL should demand a *second* agreeing signal, not earn the top slot.

3. **Shorts need a harder gate than longs, and arming them at the open is the weakest moment.** Intraday returns carry a structural upward drift; small opening breakdowns revert (killing fresh shorts), only *large, trend-violating* breakdowns continue. Symmetric long/short thresholds will over-arm shorts into the reversion pocket — which is what happened (CYIENT, KALYANKJIL bled).

Everything below supports and operationalizes these.

---

## 1. Directional conviction — what actually predicts continuation at the open

All of these are computable from price/volume/OHLC alone (no news feed). Ranked by strength of evidence:

**Strong / use as primary directional features:**

- **Intraday relative strength vs Nifty.** Stock return-since-open ÷ index return-since-open. The cross-sectional momentum literature solidly backs buying relative strength; gives a clean directional tilt at 6 min. Needs the index feed (you have it).
- **Gap size × first-candle agreement.** The combination is the tell, not either alone. NSE-specific study: when Nifty gaps 150+ pts *and* the first 5-min candle closes in the gap direction, gap-fill probability drops below 25% (i.e. continuation). Practitioner sweet spot for stock gap-and-go: ~2–5% gap with real pre-market volume; sub-2% lacks fuel, very large gaps risk exhaustion fades.
- **Price vs prior-day H/L/C and floor pivots.** Deterministic from yesterday's data, zero extra cost. Use position vs prior-close and vs P/R1/S1 as a *continuous* directional tilt, not a binary.
- **Academic backbone (Gao, Han, Li & Zhou, JFE 2018):** the first half-hour return predicts the last half-hour return, and predictability is **stronger on high-volume, high-volatility days** — i.e. exactly the days your RVOL filter selects. This is the best peer-reviewed support that early direction carries information; just don't over-map an index close-to-close effect onto single-name spikes.

**Confirmation/veto layers (sound mechanism, no isolated quantified edge):**

- **VWAP position + slope.** Above a rising VWAP = long regime; below a falling VWAP = short regime. At 6 min you only have ~6 one-minute bars, so the slope sign is noisy — more reliable by ~09:30–09:35. Use as a gate, not a primary ranker.
- **Breadth / sector alignment.** Intraday advance-decline of your F&O universe + the relevant sector index agreeing with the move. Use as a veto.

**One genuine open question for your data:** opening-range *width*. US single-stock research says **tight ranges win** (51% vs 35% by width alone); the Nifty-*index* ORB study says **wide ranges win**. These don't both hold for NSE F&O single stocks — you have to backtest which pattern your universe follows before coding a width rule.

---

## 2. Risk-adjusted ranking and the stop fix

- **Normalize on ADR% / ATR.** ADR% (avg of daily high/low over ~20 days, as a percent) is the unit-free comparator for ranking across names and price levels. Qullamaggie-style practice uses an ADR% floor (~3–5%) to drop names that don't move enough to be worth the risk. Computable from OHLC.
- **Rank by reward-to-risk, not raw RVOL.** Expected move (ADR%/ATR-derived) ÷ required stop distance. A 14.5× name with a 2.7% stop (AARTIIND today) ranks *worse* on R:R than a moderate name with a tight, clean range.
- **The stop change (highest-leverage fix in this whole document):**
  - Move the stop **off the OR edge / day extreme** — that's the highest-noise zone.
  - Use an **ATR-fraction or ATR-multiple buffer beyond the level** (research: ~5–10% of 14-day ATR in the Zarattini setup; practitioner day-trade norm 1–1.5× ATR beyond the level).
  - Require **close-beyond-level, not touch** — a wick through without a closing print is a test, not a breakout. This alone cuts false triggers.
  - **Size inversely to ATR** (Position = rupee-risk ÷ (ATR × multiple)) so every trade risks equal rupees and the wider stop doesn't blow up position risk.
- **Liquidity gate:** per-name turnover/spread filter to keep slippage from eating the edge (largely handled by trading liquid F&O underlyings, but worth an explicit per-day check).

---

## 3. How to combine the signals into one score (top-3 selector)

Consensus from the quant-scoring literature, tuned for a live ~20-name cross-section at 09:21:

- **Standardize within today's universe**, not against history. Winsorize each factor (1st/99th pct) first so one runaway RVOL name can't dominate.
- **Use within-universe rank (or robust median/MAD z-score), then equal-weight sum.** Equal weighting is a hard benchmark to beat; optimized weights overfit and have no stable intraday history to fit against anyway. Rank-sum is the robust default; it's O(n log n), no fitting, point-in-time safe by construction.
- **Treat ATR as a denominator/normalizer, not an additive factor** — it's a risk scaler, not a direction signal.
- **De-correlate the momentum axis.** Gap %, VWAP position, and relative strength are partly the same thing (a gap-and-go name is above VWAP *and* strong vs index). Summing all three silently triple-weights momentum. Merge or drop one.

---

## 4. Recommended concrete top-3 scheme

A staged filter → score → pick, all deployable now on Kite price/volume (catalyst feeds would only sharpen the gap/quality step):

**Stage A — Directional gate (decide LONG / SHORT / SKIP per name).**
Keep a name only if its directional signals *agree*: price vs VWAP, price vs prior-day close/pivot, intraday RS vs Nifty, and first-5-min candle direction all point the same way. Disagreement → SKIP. This is the multi-signal-AND tightening, and it's what today's run lacked.

**Stage B — Asymmetric short rule.**
For SHORT candidates, additionally require the breakdown to be **large enough to violate trend** (not a shallow opening dip) *and* respect a short delay past the immediate post-open reversion pocket (your 09:46 entry window helps, but the 09:24 arming fires too early — consider arming shorts later or demanding stronger confirmation).

**Stage C — RVOL regime check.**
Favor **persistent moderate RVOL** (elevated across several bars while price holds). **Penalize/flag extreme single-bar RVOL** (climax) unless a second signal confirms — invert today's logic where the 14.5× name got armed first.

**Stage D — Composite score on survivors, take top 3.**
Equal-weight rank-sum of:
- Intraday RS vs Nifty (directional strength)
- Gap × first-candle agreement (continuation quality)
- Reward-to-risk = expected move ÷ ATR-based stop distance (risk-adjusted)
- Volume persistence (not peak RVOL)

with ATR as the normalizer and the momentum factors de-correlated. Rank descending, arm the top 3.

**Stage E — Execution (the part that bit you today).**
Trigger on **close-beyond-level**, stop at an **ATR-fraction buffer outside the range** (not the day's extreme), size inversely to ATR for equal-rupee risk, hold toward your 15:15 force-exit rather than getting wicked early.

---

## 5. What to validate on your own data before committing

- **Opening-range width direction** (tight-wins vs wide-wins) on NSE F&O singles — the one genuine contradiction in the literature.
- **The RVOL continuation/reversal crossover level** — no study isolates the exact multiple where extreme RVOL flips from momentum to exhaustion; backtest it on your universe.
- **The long/short threshold asymmetry** — quantify how much harder the short gate needs to be on your tape.

Costs/slippage caveat: every practitioner win-rate quoted in the sources excludes costs; real-world haircuts on Indian intraday are non-trivial, so treat absolute numbers as directional, not bankable.

---

## Sources

**Peer-reviewed / large-sample (strongest):**
- Gao, Han, Li & Zhou — *Market Intraday Momentum* (JFE 2018) — https://www.sciencedirect.com/science/article/abs/pii/S0304405X18301351
- Zarattini & Aziz — *Can Day Trading Really Be Profitable?* (5-min ORB, 7,000+ stocks) — https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4416622
- *Should You Buy or Sell Stocks that Gap Down?* (QuantRocket, 1-min study, gap-magnitude discriminator) — https://www.quantrocket.com/blog/buy-or-sell-down-gaps/
- *A Tug of War: Overnight Versus Intraday Expected Returns* (LSE) — https://personal.lse.ac.uk/polk/research/TugOfWar.pdf
- *Strikingly Suspicious Overnight and Intraday Returns* (arXiv) — https://arxiv.org/pdf/2010.01727

**Practitioner backtests (moderate, vendor-published):**
- ORB Setups — *Opening Range Breakout Win Rate: 150,000+ Trades* — https://orbsetups.com/research/opening-range-breakout-win-rate/
- ORB Setups — *How to Identify and Avoid False Breakouts* (width, timing) — https://orbsetups.com/research/how-to-identify-and-avoid-false-breakouts-a-data-driven-approach/
- ORB Setups — *Gap and Go + ORB* (gap size, sector alignment) — https://orbsetups.com/research/gap-and-go-trading-strategy-how-to-combine-gap-plays-with-opening-range-breakouts/
- Intraday Lab — *Nifty ORB Strategy, 8-yr backtest* (wide-range / short / Friday skew) — https://intradaylab.com/blog/nifty-orb-breakout-strategy-backtest
- Intraday Lab — *Nifty Gap Down History* — https://intradaylab.com/blog/nifty-gap-down-history-analysis
- MarketNetra — *Gap Up/Down Trading in Nifty* (gap × first-candle stats) — https://marketnetra.in/blog/gap-up-gap-down-trading-nifty-ai
- QuantifiedStrategies — *Gap Fill Trading Strategies* — https://www.quantifiedstrategies.com/gap-fill-trading-strategies/

**Methodology — composite scoring & risk:**
- FactSet — *A Practical Approach to Weighting Signals* — https://insight.factset.com/a-practical-approach-to-weighting-signals
- QuantPedia — *Outperforming Equal Weighting* — https://quantpedia.com/outperforming-equal-weighting/
- Deepvue — *Momentum Stocks: ATR & ADR Screening* — https://deepvue.com/screener/momentum-stocks/
- QuantStrategy.io — *Using ATR to Adjust Position Size* — https://quantstrategy.io/blog/using-atr-to-adjust-position-size-volatility-based-risk/
- *Robustness of rank aggregation methods* (ScienceDirect) — https://www.sciencedirect.com/science/article/abs/pii/S0020025523000087

**Directional / confirmation signals & India mechanics:**
- StockCharts — *Pivot Points* — https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/pivot-points
- MNCL — *Relative Strength to Identify Momentum Stocks in India* — https://www.mnclgroup.com/using-relative-strength-to-identify-momentum-stocks-in-india
- LuxAlgo — *How Volume Confirms Breakouts* — https://www.luxalgo.com/blog/how-volume-confirms-breakouts-in-trading/
- In The Money by Zerodha — *The Overnight Drift* — https://inthemoneybyzerodha.substack.com/p/the-overnight-drift-why-markets-move
- StockGro — *Intraday Trading Rules* (NSE auto square-off, cash shorting) — https://www.stockgro.club/blogs/intraday-trading/intraday-trading-rules/

*Reliability note: figures from ORB Setups, Intraday Lab, MarketNetra, and similar are large but vendor-published and exclude costs. The Zarattini/Aziz, Gao et al., QuantRocket, and overnight-drift findings are the rigor anchors. Specific thresholds (ATR multiples, ADR% floors, RVOL crossover) are practitioner heuristics to calibrate on your own data.*
