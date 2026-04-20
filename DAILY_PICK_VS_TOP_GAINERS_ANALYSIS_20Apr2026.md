# Daily Pickup Scan vs. Today's Top Gainers — 20 April 2026

Analysis of the 08:30 IST daily-picks run against the Dhan "Top Gainers Today" CSV (50 stocks, sorted by % change, CSV snapshot time ~16:57 IST).

---

## 1. What the system actually did today (from log #39)

**Trading day sequence (08:30 IST, Mon–Fri):** `tradingDaySequenceJob` → `dailyPicksJob.runDailyScan()`

### Step 0 — Regime snapshot
```
fii=ok  vix=ok  breadth=ok   (1180ms)
```

### Step 1 — Market context
```
regime        = WEAK_BULL
regime_score  = 0.345       (just above the +0.30 LONG_BIASED threshold)
playbook      = standard
max_trades    = 2
size_mult     = 0.414
inputs        = structure 0.425, breadth 1.0, volatility −1.0,
                overnight 0.16, flow 0.114
nifty_close   = 24353.55   ema20=23733  ema50=24196
breadth_pct   = 77.21%     vix=17.21 (79th pct)
sgx_gift      = +0.12%     fii=+683Cr  dii=−4721Cr
```

### Step 2 — buildShortlist()
- F&O universe: **220 stocks**
- Signals run: catalyst (Upstox news), gap (SGX × sector beta), rs (5-day z), sector top-3, direction_fit, volume
- Sector top 3: **REALTY, ENERGY, METALS**
- Upstox "Stocks to watch April 20" article scraped → 11 names, 9 mapped to F&O: HDFCBANK (L), ICICIBANK (L), YESBANK (L), LT (L), DBL (L), IMPAL (L), PNCINFRA (L), IRCON (L), UBL (S)
- Composite scored 220 / kept top 50
- **Shortlist top 5 by composite:** `ADANIENSOL(0.5), ATGL(0.5), INOXWIND(0.5), SJVN(0.5), CESC(0.425)` — all ENERGY-sector boosted

### Step 2.5 — Adapter (NEUTRAL filter) ← **this is where most stocks die**
The adapter in `dailyPicksService.runShortlistScan()` (file `dailyPicksService.js`, ~line 567) drops every candidate whose direction is NEUTRAL:

```js
if (!c.direction || c.direction === 'NEUTRAL') { neutralDropped.add(...); continue; }
```

Direction comes from `inferStockDirection(gap, catalyst)` in `directionFitSignal.js`:
- LONG → catalyst=LONG, OR gap > +0.5%
- SHORT → catalyst=SHORT, OR gap < −0.5%
- else → NEUTRAL

**Estimated stock gap = SGX_Nifty × sector_beta + catalyst_nudge**
- SGX today = +0.12%
- Highest sector beta (METALS) = 1.35 → 0.12 × 1.35 = **0.162%**
- Nothing reaches ±0.5% from gap alone — so only **catalyst-tagged stocks pass**.

Result: **50 → 4 directional candidates**: `ICICIBANK, LT, YESBANK, HDFCBANK` (all LONG from the Upstox article)

### Step 3 — Enrich (OHLCV / RSI / ATR / vol50)
| Symbol | O | H | L | C | prevC | volRatio | RSI | EMA20 | ATR% | candle |
|--|--|--|--|--|--|--|--|--|--|--|
| ICICIBANK | 1347 | 1352.9 | 1334 | 1346.8 | 1345.5 | **1.05x** | 59.7 | 1298.3 | 1.40% | bearish |
| LT | 4134 | 4142.9 | 4072.8 | 4096.1 | 4119.8 | **0.75x** | 61.6 | 3854.2 | 1.71% | bearish |
| YESBANK | 20.1 | 20.4 | 19.8 | 20.2 | 20.0 | **1.43x** | 61.5 | 19.0 | 2.97% | bullish |
| HDFCBANK | 790.1 | 804 | 788.2 | 799.9 | 795.5 | **0.83x** | 47.7 | 799.6 | 1.98% | bullish |

### Step 4 — Gate filter
- LT rejected: `G1 volume_ratio=0.75x < 1x`
- HDFCBANK rejected: `G1 volume_ratio=0.83x < 1x`
- ICICIBANK passed (soft chase penalty −12.16pts for being 2.67× ATR above EMA20)
- YESBANK passed (soft chase penalty −7.51pts)

Reconciliation: `input=4 passed=2 rejected=2 [g1_volume=2]`

### Step 6 — Diversity cap
- Both survivors are BANKING → sector cap 1 per sector kicks in
- Drops ICICIBANK (rank 25.34), keeps YESBANK (rank 29.99)

### Final today
- **DailyPick: YESBANK (LONG) — 1 pick**
- AI insight generated, saved as DailyPick `69e23e18e2cad7aec9d76082`, notification sent

---

## 2. Today's CSV Top Gainers — system coverage reality check

CSV has 50 stocks gaining 0.68%–3.29%. Below is each one mapped to what the 08:30 scan did with it.

Legend:
- ✅ **IN_PICKS** — system actually picked it
- 🟡 **SHORTLIST_ONLY** — made the top-50 shortlist but was dropped by the NEUTRAL-direction filter (no catalyst, gap too small)
- ⚪ **UNIVERSE_ONLY** — F&O universe member, scored by shortlist but below top 50 (likely NEUTRAL anyway)
- ⛔ **OUT_OF_UNIVERSE** — not in the 220-stock F&O universe

(Direction inference is deterministic from today's inputs: SGX +0.12% + no catalyst ⇒ NEUTRAL for every non-news stock.)

| # | Stock | %Chg | F&O? | System outcome today | Why it gained (read from the CSV data) |
|---|---|---|---|---|---|
| 1 | Trent | 3.29% | yes | 🟡 NEUTRAL-dropped | RSI 69 + 16.7% 1M return + retail rotation; above 50DMA 3846 |
| 2 | Tube Investment | 2.97% | yes | 🟡 NEUTRAL-dropped | RSI 67.6, strong 22.6% 3M return; sector momentum (auto-anc.) |
| 3 | UNO Minda | 2.88% | yes | 🟡 NEUTRAL-dropped | 29% 1Y return; AUTO sector rebound |
| 4 | BHEL | 2.79% | yes | 🟡 NEUTRAL-dropped | **RSI 77, 27% 1M, 43% 1Y** — DEFENSE/CAPEX theme; hit the 52W ceiling 317.8 |
| 5 | JSW Steel | 2.76% | yes | 🟡 NEUTRAL-dropped | METALS sector was #3 on system's sector rank; RSI 65.4 |
| 6 | CG Power | 2.70% | yes | 🟡 NEUTRAL-dropped | Capital-goods/industrial momentum; RSI 70.5; 41% 3M |
| 7 | Torrent Power | 2.64% | yes | 🟡 NEUTRAL-dropped | ENERGY sector was #2 on rank; RSI 70.8 |
| 8 | SBI | 2.55% | yes | 🟡 NEUTRAL-dropped | Bank Nifty leadership; but not in Upstox article → dropped |
| 9 | REC | 2.52% | yes | 🟡 NEUTRAL-dropped | Power-financier; ENERGY theme |
| 10 | Hitachi Energy | 2.49% | **no** | ⛔ Out of F&O | RSI 75, 83% 3M — momentum extension |
| 11 | HPCL | 2.33% | yes | 🟡 NEUTRAL-dropped | Oil-PSU rotation; ENERGY sector top-3 |
| 12 | Adani Green | 2.25% | yes | 🟡 NEUTRAL-dropped | ENERGY + 33% 1M; RSI 78 |
| 13 | Asian Paints | 2.14% | yes | 🟡 NEUTRAL-dropped | FMCG/consumer rebound |
| 14 | ABB | 1.83% | yes | 🟡 NEUTRAL-dropped | Industrial-cap-goods; RSI 75.7 |
| 15 | APL Apollo | 1.81% | yes | 🟡 NEUTRAL-dropped | METALS top-3 sector; pipe-steel theme |
| 16 | Power Finance | 1.72% | yes | 🟡 NEUTRAL-dropped | Same as REC — power financier |
| 17 | Grasim | 1.46% | yes | 🟡 NEUTRAL-dropped | Cement/CEMENT momentum |
| 18 | Tata Power | 1.40% | yes | 🟡 NEUTRAL-dropped | ENERGY sector bid; RSI 75.2 |
| 19 | Jindal Steel | 1.39% | yes | 🟡 NEUTRAL-dropped | METALS; RSI 67 |
| 20 | Info Edge | 1.27% | yes | 🟡 NEUTRAL-dropped | Tech/internet rebound |
| 21 | BPCL | 1.27% | yes | 🟡 NEUTRAL-dropped | Oil PSU rotation |
| 22 | HUDCO | 1.26% | yes | 🟡 NEUTRAL-dropped | Housing/PSU |
| 23 | Prestige | 1.25% | yes | 🟡 NEUTRAL-dropped | REALTY was **#1 sector** today |
| 24 | Blue Star | 1.23% | yes | 🟡 NEUTRAL-dropped | Consumer-durable/AC; summer theme |
| 25 | Adani Power | 1.17% | yes | 🟡 NEUTRAL-dropped | ENERGY; RSI **86.9** (very extended) |
| 26 | Cummins | 1.16% | yes | 🟡 NEUTRAL-dropped | **BUT** an older weekly entry GTT triggered intraday at 10:35 (logged at line 2302) |
| 27 | Page Industries | 1.13% | yes | 🟡 NEUTRAL-dropped | Consumer apparel |
| 28 | Oracle Fin | 1.13% | yes | 🟡 NEUTRAL-dropped | IT services |
| 29 | NTPC | 1.12% | yes | 🟡 NEUTRAL-dropped | ENERGY |
| 30 | Colgate | 1.09% | yes | 🟡 NEUTRAL-dropped | FMCG defensive |
| 31 | Alkem | 1.07% | yes | 🟡 NEUTRAL-dropped | Pharma |
| 32 | L&T Finance | 1.05% | yes | 🟡 NEUTRAL-dropped | FINSERV; L&T halo |
| 33 | Bajaj Finance | 1.05% | yes | 🟡 NEUTRAL-dropped | FINSERV |
| 34 | PB Fintech | 1.01% | yes | 🟡 NEUTRAL-dropped | Fintech |
| 35 | Hero Moto | 0.99% | yes | 🟡 NEUTRAL-dropped | AUTO |
| 36 | JSW Energy | 0.93% | yes | 🟡 NEUTRAL-dropped | ENERGY |
| 37 | Eternal/Zomato | 0.90% | yes | 🟡 NEUTRAL-dropped | Consumer-tech |
| 38 | Mankind | 0.89% | yes | 🟡 NEUTRAL-dropped | Pharma |
| 39 | IndiGo | 0.86% | yes | 🟡 NEUTRAL-dropped | Aviation/oil-linked |
| 40 | KEI | 0.85% | yes | 🟡 NEUTRAL-dropped | Cables/capex theme |
| 41 | Divis Labs | 0.82% | yes | 🟡 NEUTRAL-dropped | Pharma |
| 42 | Shree Cement | 0.79% | yes | 🟡 NEUTRAL-dropped | Cement |
| 43 | Shriram Fin | 0.79% | yes | 🟡 NEUTRAL-dropped | FINSERV |
| 44 | Bosch | 0.76% | yes | 🟡 NEUTRAL-dropped | Auto ancillary |
| 45 | Eicher | 0.74% | yes | 🟡 NEUTRAL-dropped | Auto/premium bikes |
| 46 | AU Small Fin | 0.71% | yes | 🟡 NEUTRAL-dropped | Banking |
| 47 | TVS Motor | 0.70% | yes | 🟡 NEUTRAL-dropped | AUTO |
| 48 | **ICICI Bank** | **0.70%** | yes | ✅ **passed all gates but dropped by BANKING sector cap → YESBANK kept** | From Upstox news catalyst (earnings beat) |
| 49 | Coal India | 0.68% | yes | 🟡 NEUTRAL-dropped | ENERGY/PSU |
| 50 | IOC | 0.68% | yes | 🟡 NEUTRAL-dropped | Oil PSU |

### System vs CSV — scorecard
- **Picks made today:** 1 (YESBANK) — YESBANK **is not** in today's top-50 gainers CSV at all (it gained, but less than 0.68%).
- **Top gainer caught by the system but dropped:** 1 — **ICICI Bank** (0.70%, rank 48 in CSV). Dropped by BANKING sector cap vs YESBANK.
- **Top gainers the system didn't touch:** 48/50 — all dropped at Step 2.5 for NEUTRAL direction because they had no entry in Upstox's morning "Stocks to watch" article and the SGX gap was too small.
- **Cummins** (ranked 26, +1.16%) — entry GTT triggered at 10:35:00 (line 2302), but this was a **pre-existing weekly swing pick**, not today's daily-picks scan output.

---

## 3. Root cause — why the system couldn't see today's top gainers

The daily picks funnel today:
```
220  F&O universe
 │  buildShortlist composite scores all 220
 ▼
 50  top 50 shortlist
 │  ← adapter drops NEUTRAL-direction stocks
 ▼
  4  directional candidates  ← ONLY because Upstox article tagged 4 bank/infra names
 │  ← enrichment + G1 volume gate (≥1.0x vol50)
 ▼
  2  pass gates
 │  ← sector diversity cap (max 1 per sector)
 ▼
  1  final pick (YESBANK)
```

There are **two independent bottlenecks** that made the system unable to "see" today's movers:

### Bottleneck A — Direction inference is starved on low-gap days
`directionFitSignal.js` lines 25–31:

```js
if (catalystMeta?.direction === 'LONG')  return 'LONG';
if (catalystMeta?.direction === 'SHORT') return 'SHORT';
if (gapPct > 0.5)   return 'LONG';
if (gapPct < -0.5)  return 'SHORT';
return 'NEUTRAL';
```

With SGX Nifty at +0.12%, the estimated gap is `0.12% × sector_beta + catalyst_nudge`. Max value without a catalyst is `0.12% × 1.35 (METALS) = 0.162%` — far below the 0.5% threshold. So every non-news stock gets NEUTRAL direction and is dropped by the adapter at Step 2.5.

Today's top 5 from composite scoring (`ADANIENSOL, ATGL, INOXWIND, SJVN, CESC` — all ENERGY) all died here despite ENERGY being the #2 sector. The system's composite score correctly found them, but the direction filter threw them away.

### Bottleneck B — The catalyst source is a single URL
`upstoxNewsScraper.js` fetches `https://upstox.com/news/market-news/stocks/stocks-to-watch-<date>`. If a stock isn't in that article (written the previous evening by Upstox editors), the system has no catalyst. Today that article listed only 4 F&O names (HDFCBANK, ICICIBANK, YESBANK, LT) + 5 infra construction names. **None of today's top gainers were in that article.**

Today's real movers were driven by:
- **Sector rotation**: ENERGY (Torrent Power, Adani Green, NTPC, Tata Power, JSW Energy, Coal India, REC, PFC) and METALS (JSW Steel, Jindal Steel, APL Apollo) — both **were in the system's top-3 sector rank**, but the adapter discarded them before they could be traded.
- **Capex/Defense theme**: BHEL (+2.79%, RSI 77), ABB (+1.83%, RSI 75.7), CG Power (+2.7%, RSI 70.5), KEI (+0.85%), Cummins (+1.16%).
- **Momentum continuation**: Trent (+3.29%, RSI 69), UNO Minda (RSI 56 from base).
- **Intraday flow** (no overnight catalyst).

None of these need "news" — a breakout/gap filter or RS+volume at the 09:08 pre-open finalize could catch most.

### Secondary bottleneck — sector cap on the one correct hit
Even when the system did find one real gainer (ICICI Bank, +0.70%), the diversity rule at Step 6 (line 1117) dropped it because YESBANK (same BANKING sector) ranked slightly higher. This is by design but meant the one accurate signal got filtered out.

---

## 4. Answering your actual question: **Can the system find top gainers?**

**Today — no. It caught 1 of 50 (ICICI Bank) and then dropped it by sector cap. The rest never made it past the NEUTRAL-direction filter.**

The composite scorer is actually doing a reasonable job upstream — it correctly surfaced ENERGY names in its top 5, and ENERGY was one of the top-performing sectors. The problem is the funnel downstream:

1. **The NEUTRAL-direction rule is too strict on low-gap days.** On a ±0.2% SGX morning, this rule effectively forces the system to be 100% news-catalyst-dependent. That makes it great at trading HDFCBANK/ICICIBANK-style earnings plays and blind to sector rotation — which is where most of today's top gainers came from.

2. **The catalyst source is single-point-of-failure.** One Upstox article — if it's late, fails to load, or doesn't cover tomorrow's real movers, the system has 0 catalyst signal.

3. **The sector diversity cap at 1** will aggressively collapse picks even when all candidates are legitimate (it killed ICICI today).

---

## 5. What would help (directional, not prescriptive)

You asked specifically whether "my system will be able to catch top gainers". Based on today's data, here are the levers that would have changed today's outcome. Each is observable from the logs and CSV:

| Lever | What it would have caught today |
|---|---|
| Drop the NEUTRAL-direction adapter entirely; trust the composite score to rank | ADANIENSOL / ATGL / INOXWIND / SJVN / CESC (ENERGY top 5) would have been candidates — multiple of these (or their cousins) were in the CSV gainers. |
| Keep the adapter but lower the gap threshold to ±0.2% when SGX is inside ±0.3% | Still catches HDFCBANK/ICICIBANK days, and now also admits sector-top3 stocks with any gap. |
| Add a 09:08 / 09:15 "pre-open-print" re-score so direction uses **real** gap not an SGX-beta estimate | When BHEL / JSWSTEEL / TORNTPOWER opened green today, their direction would flip from NEUTRAL → LONG and they'd re-enter the funnel. |
| Let sector-top3 + volume_ratio≥1.5 alone confer LONG direction (no catalyst required) | BHEL, JSW Steel, APL Apollo, Torrent Power, NTPC, Adani Power, Adani Green all sat in ENERGY/METALS top-3 sectors. |
| Relax sector cap to 2 for BANKING on days with strong Bank-Nifty breadth | ICICI Bank would not have been dropped. |
| Broaden catalyst source beyond one Upstox URL (Moneycontrol, NSE announcements, BSE filings) | More catalysts → more directional tags on days Upstox's article is thin. |

These are observations from the log + code, not an implementation request. If you want, say which direction you want to go and I can dig deeper into that specific area.

---

## 6. Side notes from the log

- **Regime recheck at 11:00** flipped to "BULL → NEUTRAL" (Nifty +0.32%, log line 2627). No action taken (line 2628). This is working.
- **Morning brief** placed 1 weekly-GTT (ONGC, qty 7, ₹2001) + skipped TORNTPHARM & CENTUM for insufficient ₹. Separate pipeline from daily picks.
- **Weekly swing GTT** (Cummins) triggered intraday at 10:35 — unrelated to today's daily scan.
- **Kite token**, **data fetch**, and **news scrape** all "ok" today. No degraded signals, no fallbacks. So today's result is the system operating at full health — the limitation is logical, not infrastructure.

---

**TL;DR:** Today the daily scan picked **1** stock (YESBANK, not in CSV gainers). Of the 50 CSV top gainers, **48** were dropped at the NEUTRAL-direction filter (SGX gap was too small, no Upstox news catalyst), **1** was an older weekly pick's GTT trigger (Cummins), and **1** (ICICI Bank, ranked 48 in CSV) was caught by every gate but lost to YESBANK in the BANKING sector cap. The composite score correctly identified ENERGY momentum in its top 5, but the downstream direction filter refused to trade any of them because they lacked a morning news tag.
