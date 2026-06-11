# LOGDHAN — ORB Trading System Architecture

**Living document — snapshot dated 11 Jun 2026**
Reconstructed from production backend logs (`logdhan-backend-out` 11-Jun-2026). Items inferred from log evidence rather than source are marked _(inferred)_.

---

## 1. Overview

LOGDHAN is an automated intraday Opening-Range-Breakout (ORB) system trading the NSE F&O universe through Zerodha Kite. It is built as a set of **scheduled cron jobs** — not a single event loop — that hand off state through a shared per-day MongoDB document (`orb_trades`, keyed by date).

Core design stance as of this snapshot:

- **No gap filter** — the full F&O universe is the watchlist; direction is decided at the break.
- **No profit target** — every position is exit-on-stop or exit-on-time (15:15).
- **Trailing/breakeven disabled** — trails are computed but ignored; the initial stop holds to 15:15.
- **Hard cap of 8 trades/day**, paced by a per-scan slot stagger.

---

## 2. Daily schedule

| Time (IST) | Job | Purpose |
|---|---|---|
| 06:00 | `kite-token-refresh` | Full automated login (login page → credentials → TOTP 2FA → exchange request_token for access_token) |
| 06:00 | `sync-instrument-keys` | Refresh Kite instrument map |
| 06:05 | `kite-token-backup-refresh` | Backup token refresh |
| 09:00 → 15:40 | `kite-order-sync` | Order/position reconciliation (every 5 min) |
| 09:08 | `orb-pre-open` (Phase 1) | Build universe + RVOL baseline + capital preflight |
| 09:30 | `orb-record-range` (Phase 2) | Record each stock's Opening Range |
| 09:46 → 11:46 | `orb-check-breakout` | Breakout scan + entry (every 15 min) |
| 09:00 → 15:15 | `orb-monitor` | Position monitoring + exit checks (every 5 min) |
| 11:00 | `regime-recheck` | Re-evaluate regime against held picks |
| 15:15 | `orb-force-exit` / daily exit | Hard-flat all remaining MIS positions |
| 15:30 | `eod-summary` / `recordDailyMetrics` | Write day stats |

---

## 3. Phase 1 — Pre-open universe (09:08)

- Pulls the **F&O universe (~220 symbols)**, fetches OHLC in batches of 100; today **215/220** returned data.
- **No gap filter.** Gap distribution is logged for observability only ("all stocks pass to Phase 2 … direction decided at break"). The entire universe carries forward.
- Sets the **RVOL baseline**: a *time-matched* volume profile per symbol, so relative volume at any scan is measured against the same clock-slot historically (this is the `rvol=…x[slot]` figure used downstream).
- **Capital preflight:** intraday leverage 5× → ORB budget → divided into **8 slots**. On 11-Jun: intraday(5×)=₹87,179, ORB budget=₹78,461, per-trade (8 slots)=₹9,807, floor=₹5,000. This establishes the **max-8-trades/day** ceiling.

---

## 4. Phase 2 — Opening Range (09:30)

- At 09:30, reads the **first 15-minute candle (09:15–09:30)** for every watched symbol via `/quote/ohlc`.
- That candle's **high/low = the Opening Range (OR)** for the day.
- **OR-width filter removed** — previously wide/tight ranges were dropped; currently every name with data is retained as `WATCHING`.

---

## 5. Regime engine — Nifty's own OR

Market regime is derived from **Nifty's** first-15min OR (e.g. 11-Jun: high 23148.05 / low 23072.05). Each scan classifies:

- Nifty **above** OR-high → **BULL** → direction gate = **LONG only**
- Nifty **below** OR-low → **BEAR** → direction gate = **SHORT only** _(inferred by symmetry; not exercised on 11-Jun)_
- Nifty **inside** OR → **NEUTRAL** → direction gate = **BOTH**

Regime is re-evaluated every scan; a dedicated `regime-recheck` also runs at 11:00 against held picks. (Per design notes, regime checks stop ~11:50, aligned with the entry-window close.)

---

## 6. Breakout scan + entry (every 15 min, 09:46–11:46)

Each cycle re-fetches 15-min candles for the universe and runs the scan:

### 6.1 Raw qualification
A name is a candidate only if **2-bar confirmed** — price held beyond its OR edge for two consecutive bars. (Typical scan: ~45–72 confirmed, ~140–170 still inside OR.)

### 6.2 Scoring
Confirmed names are ranked by a **score** combining four signals (all printed per line):

- **dist** — distance price has pushed past the OR edge
- **rvol[slot]** — volume vs the time-matched baseline
- **relStr** — relative strength vs Nifty
- **OR width %**

### 6.3 Hard gates (applied after ranking, in order)
1. **Direction gate** — must match the current regime.
2. **dist ≥ 1%** — else `dist<1% — below floor`.
3. **rvol ≥ 1.1×** — else `rvol<1.1× — thin volume`.
4. **Slot availability** — else `slot full`; total capped by `day X/8`.

### 6.4 Slot pacing
`slots this scan` starts at **2** early in the window and drops to **1** later — a deliberate stagger to avoid filling all 8 slots in the first cycle. Day counter enforces the 8-trade cap; once reached → `Max 8 trades for the day reached — skipping`.

> **Known design tension:** because ranking is by score but gates are independent, in a BULL regime the top-scored names are frequently shorts that the direction gate kills instantly — so the actual entry is often a mid-ranked LONG (rank ~#10–#25), not the highest-scoring signal. The score currently does less work than the gates.

---

## 7. Entry mechanics

For each ENTERING name:

- **Quantity** = per-slot capital ÷ LTP. (Per-slot capital grows as earlier slots are consumed.)
- Places a **LIMIT BUY**, waits ~2s, confirms fill via Kite postback.
- Immediately places an **SL-M SELL** at the stop.
- **Stop** = OR-derived buffer, **capped at 1.5% risk** (`stop=… [risk-cap 1.5%]`).
- **Target = NONE — "ride to 15:15."** No profit target exists; exits are stop, structure, or time only.

_Example (11-Jun, IRCTC):_ capital ₹9,807 ÷ LTP ₹530.25 → qty 18; stop ₹522.25 (risk/share ₹8.00 = 1.51%); LIMIT BUY filled @ ₹530.33; SL-M SELL placed @ ₹522.25.

---

## 8. Position monitoring + exits (`orb-monitor`, every 5 min)

For each live position the candle engine evaluates each cycle:

- **Sideways check** — time-in-trade vs pnl.
- **VWAP exit** — price closing the wrong side of VWAP with `consecOpp` consecutive opposite candles.
- **15-min structure** — prior/last 15m high-low broken vs intact.
- **5-min candle shape** — inside bar, engulf, shooting star, hammer, doji, plus volume drying/expanding.

### Trailing is disabled
The engine **computes** a trail each cycle (`action=trail newStop=…`) but then ignores it:

```
[BE-only] ignoring trail → newStop=₹17931 (mode disabled — SL holds at ₹17704 until structure exit / 15:15)
```

So breakeven/trailing is **switched off**: the initial SL-M holds untouched until a structure/VWAP exit fires or 15:15 arrives. This is the single most consequential behavioral fact of the current configuration — it is the direct cause of winning positions decaying back into time-exits.

---

## 9. Close-out (15:15 / 15:30)

- **15:15** — `FORCE-EXIT` hard-flats all remaining MIS positions and prints the day summary (per-position exit type + PnL, plus total).
- **15:30** — `EOD-SUMMARY` and `recordDailyMetrics` persist the day's statistics.

---

## 10. External dependencies & known operational risks

- **Broker:** Zerodha Kite (orders, quotes, historical candles, postbacks).
- **MIS restriction list:** some names are blocked for MIS intraday by the broker on a given day → order rejects with `MIS orders are currently blocked … Place a CNC order instead.` The screener does **not** currently pre-filter against this list, so a top signal can qualify and then fail at order placement (11-Jun: HFCL, the day's #1 signal).
- **Rate limiting:** the per-symbol `/instruments/historical/.../15minute` fetches generate heavy `429 Too many requests` bursts (~60+ per scan cycle). A retry path backfills them and scans still report `0 missing bars`, so no signal was lost on 11-Jun — but the system runs at the rate ceiling with retries as the only safety net. Candidate mitigations: batch the multi-instrument historical call, or cache OR bars once at 09:45 instead of re-pulling each cycle.
- **Token:** a transient `403 TokenException` can appear mid-session (11-Jun 09:08) and self-resolve via retry; distinct from the 429s.

---

## 11. Open design questions (as of 11-Jun-2026)

1. **Trailing/BE disabled** — intentional ("ride to 15:15") vs. a stale toggle? Re-enabling would let winners lock gains instead of decaying to time-exit.
2. **Score vs. gates mismatch** — should ranking incorporate the direction gate so the printed rank reflects actual entry priority?
3. **MIS-block pre-filter** — pre-screen candidates against the broker's daily MIS-allowed list to avoid losing the top signal at placement.
4. **Single-share sizing on high-priced names** — expensive stocks (e.g. SOLARINDS @ ₹17,974 → qty 1) concentrate full slot risk in one lot with no scaling.

---

_This is a living document. Update the snapshot date and revise sections as the system changes._
