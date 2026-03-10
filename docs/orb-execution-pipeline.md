# ORB Execution Pipeline — Technical Documentation

## System Overview

The ORB (Opening Range Breakout) Execution Pipeline is the **live trading layer** that bridges the pre-market Daily Picks pipeline (8:40 AM) and actual order execution on the Indian stock market via **Kite Connect** (Zerodha). It runs between **9:30 AM and 3:00 PM IST** each trading day.

The pipeline implements a **Crabel-style ORB** approach: rather than entering at a fixed price, it places SL-M (Stop-Loss Market) orders at the ORB breakout level. The market itself confirms the trade by triggering the order when price breaks out of the opening range.

**Key files:**

- `orbValidationService.js` — ORB data collection + 6-check validation engine
- `dailyPicksService.js` — Orchestrator (validation, entries, fill handling, monitoring)
- `dailyEntryJob.js` — Agenda scheduler (all cron schedules)
- `dailyPicksExitService.js` — 3:00 PM force-exit
- `dailyPicksRiskService.js` — Circuit breaker + startup recovery
- `tradingDecisions.js` — Pure decision functions (gap, partial, sideways, sizing, P&L)
- `trailingStopEngine.js` — Chandelier Exit trailing stop engine
- `dailyPicksConstants.js` — All trading constants (single source of truth)

---

## Pipeline Flow Summary

```
Phase 1:  9:30 AM  — ORB Pass 1 (15-min range): collect OHLC + validate + place SL-M entries
          9:46 AM  — ORB Pass 2 (30-min range): retry retryable failures
         10:01 AM  — ORB Pass 3 (45-min FINAL): last chance, then SKIPPED
Phase 2:  On fill   — Instant SL + Target placement (postback listener)
          */2 min   — Fill detection fallback (polling, 9:30-10:30)
Phase 3:  */3 min   — Monitor: stop/target fills, partial booking, trailing stops, sideways exit
         12:00 PM  — Midday intel re-check (EXTREME risk → tighten all stops)
Phase 4: 14:00 PM  — Tighten profitable stops to breakeven
Phase 5: 15:00 PM  — Force-exit all positions + cancel unfilled orders
```

---

## Phase 1: ORB Collection + Validation + Entry (Multi-Pass)

### Schedule

| Pass | Time | ORB Window | Status |
|---|---|---|---|
| Pass 1 | 9:30 AM IST | 15-min range (9:15–9:30) | First attempt |
| Pass 2 | 9:46 AM IST | 30-min range (9:15–9:45) | Retry retryable failures |
| Pass 3 | 10:01 AM IST | 45-min range (9:15–10:00) | FINAL — no more retries |

Each pass consists of two steps: **ORB data collection** followed by **validation + entry placement**.

---

### Step 1: ORB Data Collection — `startOrbCollection()`

**How it works:** A single `getOHLC()` call to Kite Connect. At 9:30 AM, the day's OHLC values represent the cumulative range since market open (9:15). At 9:46, the range is wider (30 min). At 10:01, it covers 45 min.

**For each pick + NIFTY 50, captures:**

| Field | Description |
|---|---|
| `high` | ORB high — upper boundary of the opening range |
| `low` | ORB low — lower boundary of the opening range |
| `opening_price` | Where the stock actually opened at 9:15 |
| `gap_percent` | `(open - pre-market entry) / entry × 100` |
| `orb_direction` | 15-min candle direction: UP (close > open×1.001), DOWN, or NEUTRAL |

**NIFTY 50** is always included for Check 4 (Nifty alignment). Its `nifty_change_pct` measures how much the index moved in the opening range.

**Only fetches for picks still in `PENDING` or `COLLECTING_ORB` status** — picks already placed or skipped are ignored.

**Multi-pass data refresh:** Pass 1 uses stored ORB data. Pass 2+ re-fetches fresh OHLC from Kite (the range has widened with 15 more minutes of price action).

**Key file:** `orbValidationService.js` → `collectOpeningRange()`

---

### Step 2: Validation — 6 Checks (Crabel-Style) — `validatePicks(picks, orbData, regime)`

Every pick runs through 6 sequential checks. **All must pass** for the trade to proceed. The `regime` parameter is **required** — unknown regimes throw an error (no fallback).

#### Check 1: Gap Size

```
|gap_percent| < 1.5%
```

A stock that gapped >1.5% from the pre-market entry has already moved too far. The pre-market levels (entry, stop, target) are stale and unreliable.

#### Check 2: Gap Direction

Gap must not oppose the trade direction:

| Direction | Fail Condition | Rationale |
|---|---|---|
| LONG | gap < -1.0% | Stock gapped down — bullish thesis invalidated |
| SHORT | gap > +1.0% | Stock gapped up — bearish thesis invalidated |

#### Check 3: ORB Breakout R:R (Core Crabel Logic)

This is the heart of the ORB system. Instead of entering at the pre-market calculated price, entry shifts to the ORB breakout level:

**Entry calculation:**
- LONG: `ORB_high × 1.001` (0.1% buffer above range high)
- SHORT: `ORB_low × 0.999` (0.1% buffer below range low)

**R:R recalculation:**
```
risk   = |new_entry - original_stop|
reward = |original_target - new_entry|
new_RR = reward / risk
```

**Regime-tiered minimum R:R:**

| Regime | Min R:R | Rationale |
|---|---|---|
| STRONG_BULL / STRONG_BEAR | 1.5 | High-conviction trend — more permissive R:R |
| WEAK_BULL / WEAK_BEAR | 1.8 | Lower conviction — demand better R:R to compensate |
| NEUTRAL | 2.0 | No directional edge — only take excellent setups |

If `new_RR < min_RR` for the current regime, the check fails. The `MIN_ORB_RR_BY_REGIME` map in `dailyPicksConstants.js` is the single source of truth. Regime is required — unknown regimes throw an error.

#### Check 4: NIFTY Alignment

If NIFTY moved against the trade direction during the opening range, the trade is blocked:

| Trade Direction | NIFTY Move | Threshold | Result |
|---|---|---|---|
| LONG | NIFTY < -0.3% | Standard | FAIL |
| LONG | NIFTY < -0.5% | Regime-aligned | FAIL |
| SHORT | NIFTY > +0.3% | Standard | FAIL |
| SHORT | NIFTY > +0.5% | Regime-aligned | FAIL |

**Regime-aligned trades get a wider 0.5% threshold** — e.g., a SHORT in STRONG_BEAR gets more tolerance for a morning relief rally, because the structural thesis (bearish regime) still holds.

#### Check 5: ORB Range Width

```
(ORB_high - ORB_low) / ORB_low × 100 < 3.0%
```

If the ORB range exceeds 3% of the stock price, the stock is too volatile for a breakout entry. The entry would be far from the original stop, making risk unacceptable.

#### Check 6: Volume

**Auto-pass.** Kite's OHLC endpoint doesn't provide volume data, so this check is a placeholder for future enhancement.

---

### Failure Classification

Failures are classified as **permanent** or **retryable** to determine whether a pick gets another chance:

| Check | Failure Type | Rationale |
|---|---|---|
| `gap_check` | Permanent | Gap won't shrink as time passes |
| `gap_direction` | Permanent | Direction won't reverse |
| `no_orb_data` | Permanent | If Kite has no data, it won't appear later |
| `orb_alignment` (R:R) | Retryable | Wider ORB range in later passes may improve R:R |
| `entry_still_valid` (range width) | Retryable | Range may stabilize (less likely, but possible) |
| `nifty_alignment` | Retryable | NIFTY direction may settle by next pass |

**Permanent failures** → status set to `SKIPPED` immediately, regardless of pass number.

**Retryable failures** → status stays `PENDING` for the next pass to retry.

**On the final pass (Pass 3)**, all remaining failures become permanent `SKIPPED`.

Each pass result is recorded in `pick.orb.orb_passes[]` for analytics:
```js
{ pass: 2, timestamp: Date, orb_high: 3850, orb_low: 3820, result: 'FAILED', reason: 'orb_alignment' }
```

---

### Step 3: Entry Placement — `validateAndPlaceEntries()`

For picks that pass all 6 checks:

#### 3a. Entry Level Update

The pre-market entry level is replaced with the ORB breakout level:
```js
pick.levels.entry = orbBreakoutEntry;  // ORB_high × 1.001 (LONG) or ORB_low × 0.999 (SHORT)
pick.levels.entry_type = 'buy_above' | 'sell_below';
```
Original levels are preserved in `pick.validation.original_levels` for audit trail.

#### 3b. Circuit Breaker Check

Before placing any orders, `checkCircuitBreaker()` verifies:
- Daily realized P&L + unrealized P&L haven't breached **-2% drawdown limit**
- If breached: all validated picks are `SKIPPED`, no orders placed
- Circuit breaker state persists to DB (survives server restarts)
- Admin notification sent

#### 3c. Capital Allocation (Score-Weighted + ATR-Adjusted)

```
intradayBudget = balance.usableIntraday
```

1. **Score-weighted allocation:** Higher-ranked picks get more capital. Max weight cap of 45% per pick.
2. **ATR-based sizing:** Volatile stocks (high ATR%) get less capital, low-vol stocks get more:
   ```
   atrMult = clamp(BASELINE_ATR(2%) / actual_ATR%, min=0.4, max=1.5)
   capital = scoreWeightedCapital × atrMult
   ```
3. **Order cap:** Each order capped at `MAX_ORDER_VALUE`
4. **Quantity:** `qty = floor(cappedCapital / entry_price)`

#### 3d. SL-M Order Placement (Crabel-Style)

| Parameter | Value |
|---|---|
| Order type | `SL-M` (Stop-Loss Market) |
| Trigger price | `entry × 1.0015` (LONG) or `entry × 0.9985` (SHORT) — 0.15% slippage buffer |
| Product | `MIS` (intraday — auto-squared by exchange at 3:20 PM as safety net) |
| Exchange | NSE |

The SL-M order sits dormant until price breaks the ORB range. **The market itself confirms the trade** by triggering the breakout order — this is the core Crabel insight.

**Key file:** `dailyPicksService.js` → `validateAndPlaceEntries()`

---

## Phase 2: Fill Detection + Instant Protection

### Dual-System Fill Detection

**Primary — Postback Listener (instant):**

Kite sends a webhook (`order:complete`) when the SL-M entry triggers. `initFillListener()` subscribes to this event on server startup.

On fill detection:
1. Matches the order ID to a daily pick
2. Calls `placeSLAndTarget(pick, doc, fillPrice)` immediately

**Fallback — Polling (every 2 min, 9:30–10:30):**

`checkFillsFallback()` catches fills that the postback missed (delayed/dropped webhooks):
1. Queries `getOrderDetails()` for each `ORDER_PLACED` pick
2. If status is `COMPLETE` → calls `placeSLAndTarget()`
3. If status is `CANCELLED`/`REJECTED` → marks pick as `SKIPPED`

**Both systems are idempotent:** `placeSLAndTarget()` checks `kite_status !== 'sl_target_placed'` before acting, preventing double-placement.

---

### Instant Protection — `placeSLAndTarget()`

Called immediately after a fill is detected. Places two protective orders:

#### Stop-Loss (SL-M) — Critical

| Parameter | Value |
|---|---|
| Order type | `SL-M` |
| Trigger | `pick.levels.stop` (from pre-market levels engine) |
| Side | Opposite of entry (SELL for LONG, BUY for SHORT) |
| Product | `MIS` |
| Retries | **2 attempts** (1s then 3s delay) — this is critical, position must be protected |

#### Target (LIMIT)

| Parameter | Value |
|---|---|
| Order type | `LIMIT` |
| Price | Structural target from pre-market pipeline (Daily R1, Weekly R1, etc.) |
| Side | Opposite of entry |
| Product | `MIS` |
| Fallback | If structural target missing, flat 2% from entry (rare) |

#### Failure Handling

| Scenario | Action |
|---|---|
| SL placed + Target placed | Normal flow — `kite_status = 'sl_target_placed'` |
| SL **failed** | **CRITICAL** — emergency MARKET exit immediately. Position cannot exist without a stop. Admin notification sent. |
| SL placed + Target failed | Acceptable — SL protects position, will rely on stop or 3 PM exit |

**Key file:** `dailyPicksService.js` → `placeSLAndTarget()`

---

## Phase 3: Active Position Monitoring (every 3 min, 10:00–14:59)

`monitorDailyPickOrders()` runs the following checks **sequentially per pick** on all `ENTERED` picks. The order matters — earlier checks can exit the pick before later checks run.

**Execution order per pick:**
```
1. Stop/target fill detection   → if filled, skip remaining checks
2. Partial profit booking       → books 50%, moves stop to BE, updates qty
3. +1R breakeven                → moves stop to BE (idempotent with partial)
4. Chandelier trailing          → trails from peak using updated stop/qty
5. Sideways exit                → if triggered, exits and skips to next pick
```

Midday intel re-check (12 PM) runs **once before the per-pick loop**, affecting all picks.

---

### 3a. Stop/Target Fill Detection

Checks `getOrderDetails()` for both SL and target orders:

| Detection | Action |
|---|---|
| Stop `COMPLETE` | Cancel target order. Status → `STOPPED_OUT`. Calculate P&L. |
| Target `COMPLETE` | Cancel stop order. Status → `TARGET_HIT`. Calculate P&L. |
| **Both** `COMPLETE` (race condition) | Place corrective order (reverse the extra fill). Status → `STOPPED_OUT`. Alert admin. |

---

### 3b. Partial Profit Booking — `checkPartialBooking()`

**Trigger:** Price reaches **60%** of the target distance from entry.

```
bookLevel = entry + (target - entry) × 0.60    [LONG]
bookLevel = entry - (entry - target) × 0.60    [SHORT]
```

**Action when triggered:**
1. Market-sell **50%** of position (`PARTIAL_BOOK_QTY_RATIO`)
2. Modify SL and target order quantities to remaining qty
3. Move stop to **breakeven** (entry price)

**Eligibility:** Only fires once per pick (`_partial_booked` flag). Requires qty > 1.

---

### 3b½. +1R Breakeven (Price-Based)

**Trigger:** Profit reaches **+1R** (one times the original risk distance).

```
originalRisk = |entry_price - original_stop|
profitR      = current_profit / originalRisk
```

When `profitR >= 1.0`, stop moves to **breakeven** (entry price) immediately — regardless of time.

This is distinct from the 2 PM tighten (Phase 4), which is time-based. On a fast trending day, a stock might hit +1R by 10 AM. Without this check, the stop would stay at the original SL until 2 PM — 4 hours of exposed risk. The +1R trigger eliminates that gap.

Fires once per pick (`_breakeven_moved` flag). If the stop is already at/above breakeven (e.g., from partial booking), the flag is set without modifying the order.

---

### 3c. Dynamic Trailing Stops (Chandelier Exit) — `computeDynamicTrail()`

Trails the stop from the **highest high** reached since entry (LONG) or **lowest low** (SHORT), using ATR-based multipliers that tighten in phases.

**Why Chandelier Exit over fixed ratio:**
- Fixed ratio (old: 40% of profit from entry) places stops too tight when stock consolidates at highs → gets whipsawed on minor pullbacks
- Chandelier trails from peak price — consolidation at highs = stop stays safe
- ATR adapts to each stock's volatility automatically

#### Trailing Phases

| Phase | Profit Range | ATR Multiplier | Trailing Logic |
|---|---|---|---|
| Phase 1 | 0–2% | 2.5× ATR | Loose — let trend develop |
| Phase 2 | 2–4% | 2.0× ATR | Moderate — trend confirmed |
| Phase 3 | 4%+ | 1.5× ATR | Tight — protect big gains |

**Formula:**
```
LONG:  newStop = highestHigh - (ATR × multiplier)
SHORT: newStop = lowestLow  + (ATR × multiplier)
```

**After 2 PM:** Multiplier reduced by 0.5 (time running out, tighten for EOD). Floor at 0.5× ATR.

**Post-partial safety:** After partial profit booking, trailing stop never goes below breakeven.

**Fallback (no ATR data):** Old fixed-ratio method: `entry + (profit × 0.40)`.

**Stop can never move backward** — only improves (higher for LONG, lower for SHORT).

All trailing moves are recorded in `pick.trailing_history[]` with timestamp, old/new stop, price at trail, phase, and method.

#### Trailing Eligibility

| Condition | Requirement |
|---|---|
| Minimum profit | ≥1.0% (`TRAIL_MIN_PROFIT_PCT`) |
| Minimum time | ≥60 min since entry OR after 10 AM IST |

---

### 3d. Sideways Exit — `checkSidewaysExit()`

**Trigger:** Position open ≥120 minutes AND price within ±0.3% of entry.

This catches "dead" positions that are going nowhere — no trend, no momentum, tying up capital.

**Action:**
1. Cancel SL and target orders
2. Market-exit the full position
3. Status → `TIME_EXIT` with reason `sideways_Nmin`

---

### 3e. Midday Intel Re-Check (12:00 PM)

At 12 PM (once per day), the monitor re-fetches global market intelligence:

1. Clears intel cache → forces fresh AI web search
2. If risk level escalates to `EXTREME` (black swan mid-day):
   - All open stops tightened to **breakeven** immediately
   - Admin notification: "Midday Alert — Stops Tightened"
3. If risk level is normal → no action

---

### Daily P&L Dashboard

After each monitor run, a dashboard is logged:
```
┌── DAILY DASHBOARD ──────────────────────────
│ Active: 1 | Completed: 2 (W:1 L:1)
│ Realized P&L: ₹850
│   RELIANCE: TARGET_HIT P&L=₹1200 (target_hit)
│   TCS: STOPPED_OUT P&L=-₹350 (stop_hit)
└──────────────────────────────────────────────
```

**Key files:** `dailyPicksService.js` → `monitorDailyPickOrders()`, `tradingDecisions.js`, `trailingStopEngine.js`

---

## Phase 4: 2:00 PM Stop Tightening — `tightenStops()`

### What it does

Simple defensive step at 2 PM. For each `ENTERED` pick with a stop order:

| Position Status | Action |
|---|---|
| In profit (LTP above entry for LONG) | Move stop to **breakeven** (entry price) |
| At loss | Keep original SL — don't widen the loss window |

Only modifies stop if breakeven improves on current stop (stop can never move backward).

Trailing history entry recorded with `price_at_trail` for audit.

**Key file:** `dailyPicksService.js` → `tightenStops()`

---

## Phase 5: 3:00 PM Force Exit — `runDailyExit()`

End-of-day cleanup. Guarantees no positions carry overnight (MIS product).

### Step-by-Step

**Step 1a: Cancel unfilled entries**

Picks with status `ORDER_PLACED` (SL-M triggers that never fired):
- `cancelOrder()` for each unfilled SL-M entry
- Status → `SKIPPED`, reason: `unfilled_at_3pm`

**Step 1b: Check already-exited**

For each `ENTERED` pick, check if SL or target already triggered between last monitor and now:
- Stop `COMPLETE` → `STOPPED_OUT`, cancel target
- Target `COMPLETE` → `TARGET_HIT`, cancel stop

**Step 2: Cancel protective orders**

Cancel remaining SL-M and LIMIT orders. Wait 2s for cancellation to propagate.

**Step 3: Market exit**

Place `MARKET` order (opposite side) for full remaining quantity:
- 1 retry on failure (5s delay between attempts)
- If both attempts fail → admin notification: "CRITICAL: Daily Pick Exit Failed"
- Safety net: MIS positions auto-squared by exchange at 3:20 PM regardless

**Step 4: Record exit price**

Wait 3s for settlement, then fetch `average_price` from `getOrderDetails()`.
Fallback chain: order fill → LTP from price cache → entry price (last resort).

**Step 5: Calculate P&L**

For each exited position:
```
LONG:  pnl = (exit_price - entry_price) × qty
SHORT: pnl = (entry_price - exit_price) × qty
```
If partial booking occurred, P&L is split: partial qty at partial price + remaining qty at exit price.

**Step 6: Update daily results**

Aggregate:
- `total_pnl`, `winners`, `losers`, `avg_return_pct`, `best_pick`

**Step 7: Send notification**

"Daily Picks Closed: 2W/1L +₹X,XXX (+Y.Z% avg)"

**Key file:** `dailyPicksExitService.js` → `runDailyExit()`

---

## Risk Management: Circuit Breaker — `checkCircuitBreaker()`

### What it does

Portfolio-level daily drawdown limit. Checked **before every ORB entry placement**.

### How it works

1. Sums **realized P&L** from completed trades (TARGET_HIT, STOPPED_OUT, TIME_EXIT, FAILED)
2. Estimates **unrealized P&L** from open positions via LTP
3. Calculates drawdown: `total_pnl / starting_capital × 100`

### Trip Conditions

| Condition | Threshold |
|---|---|
| Daily drawdown % | > -2.0% (`MAX_DAILY_DRAWDOWN_PCT`) |

### When tripped:

- All validated picks → `SKIPPED`
- No new orders placed for the rest of the day
- **Open positions still managed** (SL/target/trailing/exit continue normally)
- Persisted to DailyPick doc (`circuit_breaker_tripped: true`) — survives server restarts
- Admin notification: "Circuit Breaker — Trading Halted"
- Resets at start of next trading day

### Fail-Open Design

If the circuit breaker check itself fails (DB error, LTP fetch error), trading is **allowed** to continue. Conservative alternative would be fail-closed.

---

## Risk Management: Startup Recovery — `reconcilePositionsOnStartup()`

### What it does

If the server restarts mid-day, open positions may lose monitoring coverage. This runs once on startup to reconcile.

### Steps

1. Fetches current Kite positions via `getPositions()`
2. Matches each open position against DailyPick DB records
3. **Missed fills:** If DB says `ORDER_PLACED` but Kite shows open position → update to `ENTERED`, recover entry price
4. **Lost stops:** If DB says `ENTERED` but stop order was cancelled/rejected → re-mark for SL placement
5. **Orphaned positions:** Open on Kite with no DB record → admin alert for manual review

---

## Trade Status Lifecycle

```
PENDING
  ↓
  ├── COLLECTING_ORB (ORB data stored)
  │     ↓
  │     ├── VALIDATED (all 6 checks passed)
  │     │     ↓
  │     │     ├── ORDER_PLACED (SL-M entry submitted)
  │     │     │     ↓
  │     │     │     ├── ENTERED (fill detected, SL+target placed)
  │     │     │     │     ↓
  │     │     │     │     ├── TARGET_HIT (target LIMIT filled)
  │     │     │     │     ├── STOPPED_OUT (stop SL-M triggered)
  │     │     │     │     └── TIME_EXIT (3 PM exit or sideways exit)
  │     │     │     │
  │     │     │     └── SKIPPED (unfilled at 3 PM)
  │     │     │
  │     │     └── FAILED (order placement error or SL placement failed → emergency exit)
  │     │
  │     └── SKIPPED (validation failed — permanent or final pass)
  │
  └── SKIPPED (validation failed on all passes)
```

---

## Scheduled Jobs Summary (dailyEntryJob.js)

| Time (IST) | Job | Description |
|---|---|---|
| 9:30 AM | `daily-picks-validate-entry` | ORB Pass 1: 15-min range → validate + SL-M entry |
| 9:46 AM | `daily-picks-validate-entry-pass2` | ORB Pass 2: 30-min range → retry failed picks |
| 10:01 AM | `daily-picks-validate-entry-pass3` | ORB Pass 3: 45-min FINAL → last chance entry |
| */2 min (9–10) | `daily-picks-fill-fallback` | Polling fallback for fill detection |
| */3 min (10–14) | `daily-picks-monitor` | Monitor: trailing, partial booking, sideways exit |
| 2:00 PM | `daily-picks-tighten` | Tighten profitable stops to breakeven |
| 3:00 PM | `daily-picks-exit` | Force-exit all positions + cancel unfilled orders |

All jobs use `timezone: 'Asia/Kolkata'` and run Mon–Fri only. `maxConcurrency: 1` prevents overlap. Each job checks `isTradingDay()` and skips on holidays.

Manual triggers available for each job via API endpoints.

---

## Constants Reference

### ORB Validation

| Constant | Value | Description |
|---|---|---|
| `ORB_BUFFER_PCT` | 0.001 (0.1%) | Buffer above ORB high / below ORB low for entry |
| `MIN_ORB_RR_BY_REGIME.STRONG_BULL` | 1.5 | Min R:R in strong trend regimes |
| `MIN_ORB_RR_BY_REGIME.WEAK_BULL` | 1.8 | Min R:R in weak trend regimes |
| `MIN_ORB_RR_BY_REGIME.NEUTRAL` | 2.0 | Min R:R in neutral regime |
| `MAX_ORB_RANGE_PCT` | 3.0% | Max ORB range width |
| `NIFTY_THRESHOLD_PCT` | 0.3% | Max opposing NIFTY move (0.5% for regime-aligned) |

### Order Execution

| Constant | Value | Description |
|---|---|---|
| `SLIPPAGE_BUFFER_PCT` | 0.0015 (0.15%) | SL-M trigger buffer for slippage |

### Partial Profit Booking

| Constant | Value | Description |
|---|---|---|
| `PARTIAL_BOOK_PCT` | 0.60 | Book at 60% of target distance |
| `PARTIAL_BOOK_QTY_RATIO` | 0.50 | Sell 50% of position |

### Trailing Stops (Chandelier Exit)

| Constant | Value | Description |
|---|---|---|
| `TRAIL_MIN_PROFIT_PCT` | 1.0% | Minimum profit to start trailing |
| `TRAIL_MIN_MINUTES` | 60 | Minimum time before trailing |
| `TRAIL_START_HOUR` | 10 (AM) | Earliest trailing hour |
| `TRAIL_ATR_MULT_PHASE1` | 2.5 | Phase 1 (0–2%): loose |
| `TRAIL_ATR_MULT_PHASE2` | 2.0 | Phase 2 (2–4%): moderate |
| `TRAIL_ATR_MULT_PHASE3` | 1.5 | Phase 3 (4%+): tight |
| `TRAIL_PHASE2_PCT` | 2.0% | Profit threshold for Phase 2 |
| `TRAIL_PHASE3_PCT` | 4.0% | Profit threshold for Phase 3 |
| `TRAIL_EOD_TIGHTEN` | 0.5 | Reduce ATR mult after 2 PM |
| `TRAIL_LOCK_RATIO` | 0.40 | Fallback: lock 40% of profit (no ATR) |

### Sideways Exit

| Constant | Value | Description |
|---|---|---|
| `SIDEWAYS_EXIT_MINUTES` | 120 | Exit after 2 hours of sideways |
| `SIDEWAYS_THRESHOLD_PCT` | 0.3% | "Sideways" = within ±0.3% of entry |

### Time-Based

| Constant | Value | Description |
|---|---|---|
| `TIGHTEN_HOUR` | 14 (2 PM) | Tighten stops to breakeven |
| `EXIT_HOUR` | 15 (3 PM) | Force-exit all positions |

### Capital Allocation

| Constant | Value | Description |
|---|---|---|
| `INTRADAY_CAPITAL_PCT` | 0.40 (40%) | Portion of capital for daily picks |
| `MAX_PICKS` | 3 | Maximum daily picks |
| `BASELINE_ATR_PCT` | 2.0% | "Normal" volatility baseline |
| `MIN_ATR_MULT` | 0.4 | Minimum ATR sizing multiplier |
| `MAX_ATR_MULT` | 1.5 | Maximum ATR sizing multiplier |

### Circuit Breaker

| Constant | Value | Description |
|---|---|---|
| `MAX_DAILY_DRAWDOWN_PCT` | 2.0% | Halt new trades if daily P&L breaches -2% |

---

*Document generated: March 2026*
*System: ORB Execution Pipeline v2 — Logdhan Trading System*
