# ORB "9:08" Intraday System — Audit against the *deployed* code (2026-05-31, rewritten)

> **2026-05-31 rewrite note.** The previous contents of this file described a *different* codebase than what is deployed (it cited `calculatePositionSize` at line 2362 in a 1573-line file, a `MAX_RISK_PER_TRADE=₹2000` risk-sizing path that exists nowhere, and an `orbBacktestService.js` that isn't in the tree). That version has been replaced. Everything below is verified line-by-line against the working tree at commit `fab4ac0` (last deploy 2026-05-29). The Phase-2 bug from §3 has since been **fixed** — see that section.

Scope: code-quality / risk review of the live ORB pipeline (`orbService.js`, `orbJob.js`). Not investment advice; no win-rate is claimed — it is unknowable from code (see §6).

---

## 1. What actually runs (from `orbJob.js`, IST cron)

- **09:08** `orb-pre-open` → `fetchPreOpenUniverse()` — Kite `/quote/ohlc` over ~200 F&O names, gap logged for observability only, **no gap filter**, save all ≤250 as `WATCHING`.
- **09:30** `orb-record-range` → `recordOpeningRanges()` — set OR high/low, keep OR width in **0.5–2.5%** band.
- **10:01–14:01 at :01/:16/:31/:46** `orb-check-breakout` → `checkBreakouts()` — 2-bar 15-min confirm, distance floor, bias gate, enter ≤3 MARKET MIS.
- **every 5 min, 09:00–14:59** `orb-monitor` → `monitorOrbPositions()` — SL status, BE-trail at +1R, candle-structure tighten/exit, 40-min sideways cut.
- **15:15** `orb-force-exit` → `forceExitOrb()`.

Import/export names line up — no wiring crash. The 10:30 time-exit is gated off (`ORB_TIME_EXIT_ENABLED` unset). Earliest possible entry is **10:01** (constants `BREAKOUT_START_HOUR=10`, `_MIN=1`), not 09:31.

## 2. Position sizing is notional, with no per-trade rupee risk cap — the real risk-management gap

`enterTrade` line 803:

```js
const qty = Math.max(1, Math.floor(capitalPerTrade / ltp));
```

Sizing is **capital/price**. The stop (line 808–815) is pinned to the breakout level: `OR_High − min(1%·OR_High, OR_range)` for LONG (mirror for SHORT). Nothing ties qty to the stop distance, so **rupee risk per trade = (entry − stop) × qty is uncontrolled** and scales with both account size and how extended the entry is.

The extension is structurally guaranteed: entry only fires once price has closed ≥ `MIN_DISTANCE_PCT = 1.0%` past the OR (§4), entry is a MARKET fill at a live LTP that can be further past the OR than the confirming candle close, and the stop sits *below* the breakout level. So 1R is routinely ~1.5–2%+ of notional, larger on the most-extended names (which the ranker actively prefers — §4). There is no `MAX_RISK_PER_TRADE` backstop. Fix: size off the stop — `qty = floor(RISK_BUDGET / |entry − stop|)` with a notional ceiling — so 1R is a fixed rupee number and the BE-trail/40-min logic engages at predictable points.

## 3. ✅ FIXED (2026-05-31) — `recordOpeningRanges()` ReferenceError at 09:30

**Was:** lines 593–594 referenced `rangesSkipped` and `rangesNoBar`, which were never declared (leftover from a removed per-symbol summary). In an ES module (strict mode) that throws `ReferenceError` — *after* `doc.save()` at line 591, so OR levels persisted and trading continued, but Phase 2 logged as a failed job with a stack every morning and lost its return payload.

**Now:** the summary log and return use the real counters (`rangesSkippedWide`, `rangesSkippedTight`, `rangesNoData`), with a derived `rangesSkipped = wide + tight`:

```js
await doc.save();
const rangesSkipped = rangesSkippedWide + rangesSkippedTight;
console.log(`${LOG} [PHASE2] Summary: RANGE_SET=${rangesSet}  SKIPPED=${rangesSkipped} (wide=${rangesSkippedWide} tight=${rangesSkippedTight})  NO_DATA=${rangesNoData}  of ${watching.length} WATCHING`);
return { success: true, rangesSet, rangesSkipped, rangesSkippedWide, rangesSkippedTight, rangesNoData };
```

`node --check` passes; no undeclared identifiers remain in the function. Phase 2 now completes cleanly. **Caveat:** the change is in the working tree but not committed, and no test covers `recordOpeningRanges` (Phase 2 is untested — §7).

## 4. Structural choices worth A/B-ing (all currently hand-tuned on n≈3 days)

- **You enter late and extended.** Earliest entry 10:01 (two completed 15-min bars after the 09:30 OR) and only ≥1.0% past the OR. Structurally buying after the initial run. The 1.0% floor was set 2026-05-29 off 3 losing sub-1% trades (`-₹47` total) — n=3, never A/B'd.
- **Slot allocation takes the *most* extended names.** `confirmed.sort((a,b) => b.distancePct - a.distancePct)` (line 711) then top-3 ENTER. On a trend day you're selecting the three closest to exhaustion. The opposite (least-extended valid breakouts) is at least as defensible and untested.
- **Mixed units on the accept axis.** The distance floor gates in price-% (`distancePct`), the stale flag gates in OR-range multiples (`distance > orRange × 2`, line 684). A 0.5%-OR and a 2.5%-OR name get very different effective accept bands. Pick one unit.
- **OR capture uses day OHLC, not the true 9:15–9:30 candle.** `recordOpeningRanges` reads `kc.getOHLC` running H/L (line 522, `q.ohlc.high/low`) and assumes "at 09:30:00 that equals the 09:15–09:30 candle" (comment line 545). With Agenda `processEvery: '30 seconds'` plus jitter, a late fire ingests post-09:30 ticks and silently widens the OR, shifting every downstream distance/SL calc. The file-header comment (line 6) advertises *"Kite historical 15-min candle → OR High/Low"* — that's not what the code does. Either pull the real historical 15-min candle, or fix the comment.

## 5. Bias gate **is** a per-day lock (not per-cycle)

Once `decideBreakoutActions` sets a side (≥10 confirmed and one side ≥70%, lines 178–194), `checkBreakouts` writes it to `doc.dailyDirectionBias` (line 724) and persists it. Every later cycle passes that back in as `existingBias`, and the helper uses it as-is (lines 195–197). So it locks on the **first** scan that reaches 10 confirmed — typically 10:01 — and holds all day. That's the documented intent, but it can't adapt if the tape flips after 10:01. Worth a hysteresis variant (require the dominant side to hold two scans before locking) once a backtest exists.

## 6. There is no ORB backtest at all

The orb directory contains only `orbService.js`. The `backend/src/scripts/*backtest*` files are for the **dormant daily-picks** system, not ORB. So every threshold in §2/§4/§5 — the 1.0% floor, 70% bias, 0.5–2.5% OR band, rank direction, 2-bar confirm — is a live-tuned guess. At ~1 week live and <3 trades/day, total live ORB trades are ~10–15: statistically meaningless. **Building an ORB backtest harness is the highest-leverage work.** No profitability statement can be made until then.

## 7. What's genuinely good — keep it

The order-safety layer is the strongest part of the system and it's real, not cosmetic:

- **Broker-position re-check before every exit** (`getActualPositionQty`, line 247) guards the force-exit / sideways / candle paths against the "exit order opens a fresh opposite position" failure (the 2026-05-26 CONCOR incident). Direction-mismatch and qty-drift are both handled.
- **Rejection guard** (line 871–879): entry must be `COMPLETE/OPEN` with `filledQty ≥ qty` before any SL is placed — kills the phantom-short bug.
- **SL trail via cancel+replace with emergency-market fallback** (`replaceSlOrderWithNewTrigger`, line 275): cancel-first ordering avoids double-exit, and a failed re-place fires an emergency market exit rather than leaving the position naked.
- **Tick-size re-snap on Kite rejection** (line 917–927) re-snaps the *buffered* stop, not the raw OR boundary.
- **Direction symmetry** (LONG/SHORT) is clean through sizing, SL, bias, P&L, and exits.

**Test coverage gap:** only the pure decision helper (`decideBreakoutActions` — bias/floor/slot) is unit-tested. `enterTrade`, sizing, the inline SL math, `replaceSlOrderWithNewTrigger`, `recordOpeningRanges`, the monitor/exit/force-exit paths, and the broker-safety guards — i.e. every function that places a real order — have **no tests**.

## 8. Prioritized

1. ~~Fix the Phase-2 ReferenceError~~ — **done 2026-05-31** (§3). Still needs committing.
2. **Build an ORB backtest** (§6) so everything below is tuned offline, not on live capital.
3. **Switch to risk-based sizing** (§2) so per-trade 1R is a fixed rupee amount and the trail/40-min logic engages predictably.
4. **A/B the untested knobs** in the backtest: rank by smallest vs largest qualifying distance; 1-bar vs 2-bar confirm; 0.5% vs 1.0% floor.
5. **Fix the OR-capture comment/data mismatch** (§4) — real 09:15–09:30 candle or honest comment.
6. **Bias-gate hysteresis** (§5) + unify the distance/stale units.
7. **Add execution-path tests** (§7) around sizing, the SL math, `recordOpeningRanges`, and the broker-safety guards.

---
*Verified against `orbService.js`, `orbJob.js`, the `orb-*` test files, and `backend/src/services/orb/` directory contents on 2026-05-31 at commit `fab4ac0` (plus the §3 working-tree fix). Code review only; not investment advice.*
