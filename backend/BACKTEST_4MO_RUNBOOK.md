# 4-Month Backtest Runbook (Path C)

**Goal:** validate the regime-aware daily-pick system against the past ~80 trading days of real Indian-equity data, using your actual production code (regime engine + scanner.py with `--mode` and `--asof`).

**Output:** one `daily_picks_backtest` document per simulated day in Mongo, plus a `backtest_runs` roll-up document with hit rate, expectancy, drawdown.

**Estimated wall-clock time on your Mac:** 4–6 hours for backfill, 30–60 minutes for the harness run.

---

## Before you start

You'll be running these on your local Mac (not in the Cowork sandbox). Things to confirm:

- Python 3 with `pandas`, `numpy`, `yfinance` installed (`pip install yfinance pandas numpy`).
- Node 18+ with project dependencies installed (`cd backend && npm install`).
- `.env` is populated with `MONGODB_URI`, `UPSTOX_API_KEY`, etc.
- MongoDB connection works (`mongosh "$MONGODB_URI" --eval 'db.runCommand({ping:1})'`).
- ~10 GB of free disk (the daily-candle prefetch is large).
- A stable internet connection — yfinance, Upstox, NSE, ChartInk are all external calls.

If you're unsure about any of those, do **Step 0** below first.

## Step 0 — Sanity-check the environment

```bash
cd ~/Documents/logdhan/backend
node --version          # ≥ 18
python3 --version       # ≥ 3.9
python3 -c "import yfinance, pandas, numpy; print('ok')"
mongosh "$MONGODB_URI" --eval 'db.runCommand({ping:1})'
```

If any of those fail, fix before proceeding.

## Step 1 — Backfill the regime inputs (VIX + FII + breadth)

These three feed the regime engine. The harness skips any day where one of them is missing, so coverage matters.

```bash
cd ~/Documents/logdhan/backend

# Run all three in sequence. 120 calendar days covers ~80 trading days comfortably.
node src/scripts/backfillAll.js 120
```

Expected runtime: **30–60 minutes**. Breadth is the slow one (it iterates ~500 stocks).

Verify after it finishes:

```bash
mongosh "$MONGODB_URI" --eval '
const date90 = new Date(Date.now() - 90*24*3600*1000).toISOString().slice(0,10);
print("VIX rows in last 90 days:    " + db.india_vix_daily.countDocuments({date: {$gte: date90}}));
print("FII rows in last 90 days:    " + db.institutional_flow_daily.countDocuments({date: {$gte: date90}}));
print("Breadth rows in last 90 days:" + db.breadth_daily.countDocuments({date: {$gte: date90}}));
'
```

Each should show **60–80 rows** (trading days ≠ calendar days). If any is under 50, re-run just that script:

- `node src/scripts/backfillIndiaVixYahoo.js 120`
- `node src/scripts/backfillFiiFlow.js 120`
- `node src/scripts/backfillBreadth.js 120`

## Step 2 — Backfill daily candles for the F&O universe

The scanner needs ~6 months of daily candles per stock. yfinance is the source.

```bash
node src/scripts/prefetchAllStockData.js
```

Expected runtime: **2–4 hours** (rate-limited at ~5s per stock × ~400 F&O symbols). It's resumable — if it errors out, just re-run; it skips stocks that already have complete data.

Verify:

```bash
mongosh "$MONGODB_URI" --eval '
const cnt = db.prefetcheddatas.countDocuments({timeframe: "1d"});
const newest = db.prefetcheddatas.findOne({stock_symbol: "RELIANCE", timeframe: "1d"});
const lastBar = newest?.candle_data?.[newest.candle_data.length - 1];
print("Daily-candle docs: " + cnt);
print("RELIANCE last bar: " + JSON.stringify(lastBar));
'
```

The RELIANCE last bar should be within 2 days of today.

## Step 3 — (Optional) Backfill 15-min candles for the most recent 90 days

This unlocks the **full intraday replay** part of Path C. Without it, the harness still works but evaluates at daily resolution.

```bash
# Note: prefetchAllStockData.js fetches 15m via candleFetcher.service.js.
# Upstox's intraday endpoint caps at 90 days lookback — the script will fetch
# whatever it can. If the script already ran in Step 2 with 'swing' timeframe,
# it should have fetched 15m too.

# Verify after running:
mongosh "$MONGODB_URI" --eval '
const fifteenM = db.prefetcheddatas.countDocuments({timeframe: "15m"});
const sample = db.prefetcheddatas.findOne({stock_symbol: "RELIANCE", timeframe: "15m"});
const len = sample?.candle_data?.length || 0;
print("15m docs total: " + fifteenM);
print("RELIANCE 15m bars: " + len);
'
```

You want **15m_bars ≥ 5000** for RELIANCE (~80 days × 25 bars/day × allowance). If it's under 1000, the 15m intraday replay path will be skipped and the backtest falls back to daily resolution. Not a blocker — just less rigorous.

## Step 4 — Dry-run the backtest harness

A dry run lists the days it would simulate and confirms regime inputs are available, without running scanner.py 80 times.

```bash
node src/scripts/fourMonthBacktest.js --days 80 --dry-run
```

Look for output like:

```
[BT] ─── DAY 2026-01-22 ───
[BT] 2026-01-22: regime=WEAK_BULL score=0.31 vix=14.2
[BT] 2026-01-22: would run scanner.py --mode=recovery_breakout --asof=2026-01-22 (dry-run)
```

If you see many lines like `SKIP — missing vix,fii_flow,breadth`, go back to **Step 1** — your backfills are incomplete for those dates.

If you see `SIT OUT — VIX > extreme threshold`, that's correct behavior for India-VIX > 35.

## Step 5 — Run the real backtest

```bash
node src/scripts/fourMonthBacktest.js --days 80 --capital 100000 --feepct 0.25 --hold 5
```

Expected runtime: **30–60 minutes** (each day = one scanner.py run ≈ 30–60s × 80 days). Watch progress; if it dies, you can re-run — completed days are upserted by `trading_date` so they'll be skipped.

CLI options:

| Flag | Default | Meaning |
| ---- | ------- | ------- |
| `--days N` | 80 | how many recent trading days to backtest |
| `--from YYYY-MM-DD` | — | start date (overrides `--days`) |
| `--to YYYY-MM-DD` | — | end date (use with `--from`) |
| `--capital N` | 100000 | INR capital assumption for sizing |
| `--feepct X` | 0.25 | round-trip fee % (brokerage + STT + slippage) |
| `--hold N` | 5 | max days to hold before TIME_EXIT |
| `--dry-run` | off | list days that would run without running scanner |

## Step 6 — Read the results

The harness writes to two collections:

- `daily_picks_backtest` — one document per simulated day, picks with planned levels + evaluated outcome.
- `backtest_runs` — one roll-up per run with `runConfig`, `aggregate`, `perDay`.

Useful queries:

```javascript
// Headline numbers
db.backtest_runs.find().sort({runFinishedAt: -1}).limit(1).pretty();

// Hit rate by regime
db.daily_picks_backtest.aggregate([
  { $unwind: '$picks' },
  { $match: { 'picks.trade.status': { $in: ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT'] } } },
  { $group: {
      _id: '$market_context.regime',
      total: { $sum: 1 },
      wins:  { $sum: { $cond: [{ $gt: ['$picks.trade.return_pct', 0] }, 1, 0] } },
      avgRet: { $avg: '$picks.trade.return_pct' }
  }},
  { $project: {
      regime: '$_id', total: 1, wins: 1,
      hit_rate_pct: { $multiply: [{ $divide: ['$wins', '$total'] }, 100] },
      avg_return_pct: '$avgRet'
  }}
]);

// Hit rate by scanner mode
db.daily_picks_backtest.aggregate([
  { $unwind: '$picks' },
  { $match: { 'picks.trade.status': { $in: ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT'] } } },
  { $group: { _id: '$picks.scan_type', total: { $sum: 1 }, wins: { $sum: { $cond: [{ $gt: ['$picks.trade.return_pct', 0] }, 1, 0] } } } }
]);

// Worst losing trades
db.daily_picks_backtest.aggregate([
  { $unwind: '$picks' },
  { $project: { date: '$trading_date', symbol: '$picks.symbol', mode: '$picks.scan_type', ret: '$picks.trade.return_pct' } },
  { $sort: { ret: 1 } },
  { $limit: 10 }
]);
```

## Step 7 — Decision framework

Decide ship-or-not against these thresholds (from `BACKTEST_PLAN.md`):

| Bar | Threshold |
| --- | --------- |
| **Ship to live full capital** (all four must hold) | Expectancy ≥ 0.2R, hit rate 45–65%, max drawdown ≤ 25%, max consecutive losses ≤ 7 |
| **Ship to paper-trade for 30 days** (both must hold) | Expectancy ≥ 0.1R, no single month with > 15% drawdown |
| **Stop and rewrite** (any of these) | Negative expectancy, hit rate < 40%, single-day worst loss > 5% capital |

## Common failures and what to do

**"MONGODB_URI not set"** — your shell didn't pick up `.env`. Either `source .env` or use `node -r dotenv/config`.

**"Cannot determine trading calendar: RELIANCE 1d candles missing"** — Step 2 didn't finish. Re-run prefetch.

**"scanner.py: invalid choice: 'momentum_leader'"** — your scanner.py is old. Pull the latest from the May 2026 changes.

**"ModuleNotFoundError: No module named 'yfinance'"** — `pip install yfinance pandas numpy` in the Python you're using.

**Many days SKIP for missing data** — Step 1 backfills are incomplete. Run individual backfill scripts with more `daysBack`.

**scanner.py timeout (5 min)** — yfinance is throttling. Wait 10 minutes and retry; results from completed days are saved.

**Hit rate looks too good (> 70%)** — likely a look-ahead bug. Check that the as-of cutoff in scanner.py is truncating dataframes correctly — print `df.iloc[-1].name` (the timestamp of the last bar) before scoring; it should equal `--asof`.

## Known limitations of this Path C implementation

1. **Nifty structure stubbed.** The regime engine's structure input (Nifty close vs EMA20/EMA50) isn't backfilled in `prefetcheddatas` (only individual stocks are). The harness sets `niftyStructure: null`, which makes the regime engine reweight over breadth + flow + vix + overnight. The regime label will still be directionally right but slightly less stable than live.

2. **Overnight cues (SGX Nifty / Asia / DXY) not backfilled.** Same treatment — `overnightData: null`. Reduces signal slightly but the engine handles it gracefully.

3. **Daily-resolution evaluation, not tick-resolution.** When a day's high touched the target AND the low touched the stop, the harness conservatively assumes stop was hit first. Real intraday tape might have gone target → stop instead. This *understates* win rate by 1–3%.

4. **No news/catalyst replay.** The shortlist's catalyst signal is live-only. `nr7_compression` mode doesn't use catalysts directly but the broader regime context might shift slightly.

5. **F&O universe is the current list.** Stocks delisted from F&O in the past 4 months are invisible. This *overstates* hit rate by an estimated 3–8%.

Carry all five caveats in any report you produce from this backtest.

## When you're done

Share with me:
- The `backtest_runs` summary doc (one JSON, easy paste).
- The "hit rate by regime" + "hit rate by scanner mode" aggregations.
- The 10 worst losers (for failure-mode analysis).

I'll write up the verdict against the decision framework and identify which parameters are worth tuning before any live deployment.
