# Scan Rejection Investigation — 12 Mar 2026

## Summary

On 12 Mar, **35/35 candidates rejected** (0 viable, 0 selected). Two rejection categories:
- **1H Conflict (21)** — 1H swing structure blocks the trade direction
- **Levels Fail (14)** — `scanLevels` engine can't find viable entry/stop/target with adequate R:R

All 5 visible rejections in the screenshot are **volume_shocker_bearish** (SHORT direction), all failing with:
> `Breakdown REJECTED: Daily pivots and fixed 3% both failed R:R (3% R:R 0.0:1 < 1.2:1)`

---

## Root Cause Analysis Per Rejection Category

### 1. "1H Conflict" (21 rejections) — NOT too optimistic, working as designed

**What it does:** `check1HStructuralConflict()` in `dailyPicksService.js:790`

- **LONG**: Reject if any 1H resistance zone midpoint is within **2% above PDH** (entry zone)
- **SHORT**: Reject if any 1H support zone midpoint is within **2% below PDL** (entry zone)

**Is it too aggressive?**
The 2% threshold is **reasonable** for intraday. If a stock has structural resistance/support within 2% of entry, the trade has no room to breathe. Having 21/35 candidates fail this gate on 12 Mar suggests the **market was range-bound/choppy** — lots of overhead resistance for longs, lots of support for shorts.

**Verdict: Working correctly.** High 1H conflict rate = low-conviction market day. No code change needed.

---

### 2. "Levels Fail" (14 rejections) — HAS REAL BUGS (partially fixed)

The `volume_shocker_bearish` scans all show **R:R 0.0:1**, which means **risk = 0 or negative**. This is the bug.

#### Bug: Breakdown scan R:R 0.0:1 (FIXED in commit d414b56)

**Root cause:** In `calculateBreakdownLevels()`, the intraday stop was using `low20D` (20-day low) instead of `prevLow`. When a stock bounced from a lower low weeks ago, `low20D < entry`, causing `stop < entry` → negative risk → R:R = 0.0:1.

**Fix applied:** Use `prevLow` (the level that just broke) as intraday stop reference, not `low20D`.

**However, the fix was committed AFTER the 12 Mar scan ran** — so today's rejections still show the old bug.

---

## Detailed Level Logic Per Scan Type (VJDD = the 16 ChartInk scans)

### BULLISH SCANS (8 types)

| Scan Type | Archetype | Entry | Stop (Intraday) | Target (Intraday) | Min R:R |
|-----------|-----------|-------|------------------|--------------------|---------|
| `compression_bullish` | `consolidation_breakout` | prevHigh + 0.1×ATR | prevLow - 0.1×ATR | 1H swing → Daily R1/R2 → REJECT | 1.2:1 |
| `pullback_at_support` | `pullback` | EMA20 (limit) or prevHigh (buy_above) | min(EMA50, PDL) - 0.15% | 1H swing → Daily R1/R2 → REJECT | 1.2:1 |
| `fiftyTwoWeek_high` | `fiftytwoweek_high` | prevClose | PDL - 0.15% | Daily R1/R2 → ATR extension | 1.2:1 |
| `breakout_setup` | `breakout` | high20D + 0.2×ATR | resistanceLevel - 0.1×ATR | Daily R1/R2 → Fixed 3% → REJECT | 1.2:1 |
| `volume_shocker_bullish` | `breakout` | (same as breakout) | (same as breakout) | Daily R1/R2 → Fixed 3% → REJECT | 1.2:1 |
| `nr7_bullish` | `consolidation_breakout` | (same as consolidation) | (same as consolidation) | 1H swing → Daily R1/R2 → REJECT | 1.2:1 |
| `inside_day_bullish` | `consolidation_breakout` | (same as consolidation) | (same as consolidation) | 1H swing → Daily R1/R2 → REJECT | 1.2:1 |
| `bull_flag` | `breakout` | (same as breakout) | (same as breakout) | Daily R1/R2 → Fixed 3% → REJECT | 1.2:1 |

### BEARISH SCANS (8 types)

| Scan Type | Archetype | Entry | Stop (Intraday) | Target (Intraday) | Min R:R |
|-----------|-----------|-------|------------------|--------------------|---------|
| `compression_bearish` | `compression_bearish` | prevLow - 0.1×ATR | prevHigh + 0.1×ATR | 1H swing → Daily S1/S2 → REJECT | 1.2:1 |
| `failed_at_resistance` | `failed_at_resistance` | prevLow - 0.1×ATR | PDH + 0.15% | 1H swing → Daily S1/S2 → REJECT | 1.2:1 |
| `fiftyTwoWeek_low` | `fiftytwoweek_low` | prevClose | PDH + 0.15% | Daily S1/S2 → ATR extension | 1.2:1 |
| `breakdown_setup` | `breakdown_setup` | prevLow - 0.15×ATR | **prevLow + 0.1×ATR** (FIXED) | Daily S1/S2 → Fixed 3% → REJECT | 1.2:1 |
| `volume_shocker_bearish` | `breakdown_setup` | (same as breakdown) | (same as breakdown) | Daily S1/S2 → Fixed 3% → REJECT | 1.2:1 |
| `nr7_bearish` | `compression_bearish` | (same as compression) | (same as compression) | 1H swing → Daily S1/S2 → REJECT | 1.2:1 |
| `inside_day_bearish` | `compression_bearish` | (same as compression) | (same as compression) | 1H swing → Daily S1/S2 → REJECT | 1.2:1 |
| `bear_flag` | `breakdown_setup` | (same as breakdown) | (same as breakdown) | Daily S1/S2 → Fixed 3% → REJECT | 1.2:1 |

---

## Are the Levels Intraday or Too Optimistic?

### YES, levels are correctly set for intraday (isIntraday = true)

The `dailyPicksService.js:1161` always sets `isIntraday: true` for all daily picks. This correctly routes to:
- **Daily pivots** (R1/R2, S1/S2) instead of weekly pivots for targets
- **PDH/PDL-based stops** instead of EMA/ATR-based swing stops
- **1H swing structure** as primary target source (for pullback/consolidation types)
- **Fixed 3%** as fallback target (for breakout/momentum/breakdown types)
- **minRR: 1.2** (relaxed from swing's 1.5:1)

### Target fallback chain per scan type (intraday):

| Scan Types | Target Chain | Issue? |
|------------|-------------|--------|
| `breakout`, `volume_shocker_bullish`, `bull_flag` | Daily R1 → Daily R2 → PDH → **Fixed 3%** → REJECT | Fixed 3% fallback gives R:R 0.0:1 when stop is too wide (>3% from entry) |
| `breakdown`, `volume_shocker_bearish`, `bear_flag` | Daily S1 → Daily S2 → PDL → **Fixed 3%** → REJECT | **BUG (fixed d414b56)**: stop was based on low20D, not prevLow |
| `pullback`, `nr7_bullish`, `inside_day_bullish`, `compression_bullish` | **1H Swing Resistance** → Daily R1 → Daily R2 → PDH → REJECT | No fixed % fallback — if 1H swing + daily pivots fail, immediate REJECT |
| `failed_at_resistance`, `nr7_bearish`, `inside_day_bearish`, `compression_bearish` | **1H Swing Support** → Daily S1 → Daily S2 → PDL → REJECT | No fixed % fallback — same issue |

---

## Remaining Issues After d414b56 Fix

### Issue 1: Breakout/Breakdown "Fixed 3%" fallback produces R:R 0.0:1

Even with the `prevLow` stop fix, the **breakdown** and **breakout** intraday fallback can still produce terrible R:R when:
- Daily pivots are all missing or too close to entry
- The 3% target doesn't offset the stop distance

For **breakdown_setup** specifically:
- Entry: `prevLow - 0.15×ATR`
- Stop: `prevLow + 0.1×ATR` (after fix)
- Risk: `0.25×ATR` (very tight)
- Target (3%): `entry × 0.97`
- If ATR is large relative to price (high-vol stock), the 3% target may still fail R:R

This is actually **correct behavior** — it's rejecting setups where the risk/reward doesn't work. The 3% target is a reasonable intraday ceiling.

### Issue 2: No "Fixed 3%" fallback for pullback/consolidation/compression types

These types go: `1H Swing → Daily Pivots → REJECT`

If both 1H swing data and daily pivot data are missing or inadequate, these scans have **no fallback** before rejection. Adding a fixed % fallback (like breakout/breakdown have) would reduce rejection rates.

### Issue 3: 1H Conflict 2% threshold may be too tight on volatile days

On high-ATR days, 2% can be within normal noise. Consider making the conflict threshold ATR-aware:
- Current: `midpoint <= pdh * 1.02` (fixed 2%)
- Proposed: `midpoint <= pdh + 0.5×ATR` (dynamic, ATR-based)

---

## Recommendations

1. **Wait for d414b56 fix to take effect** — The breakdown R:R 0.0:1 bug is fixed, need next trading day to verify.

2. **Add fixed 3% fallback for compression/pullback/NR7/inside_day types** — Currently these types go straight from 1H swing + daily pivots to REJECT. Adding a 3% fallback would catch more viable trades.

3. **Consider ATR-based 1H conflict threshold** — On volatile days, the 2% fixed threshold rejects too aggressively.

4. **Monitor next 3 days (13-17 Mar)** — Compare rejection rates after the fix. If >80% still reject, the pivot data may be stale or missing (API issue, not logic issue).
