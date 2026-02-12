# Scan-Type-Aware Entry/SL/Target Fix - Complete Implementation

**Date:** 2026-02-12
**Status:** ✅ Implemented & Tested
**Impact:** Critical - Fixes broken SHORT trades and improves LONG momentum setups

---

## Problem Diagnosis

### The Core Issue

Both LONG and SHORT daily picks were using **generic intraday formulas** that completely ignored scan types:

```javascript
// OLD (BROKEN) - Same formula for ALL scan types
if (direction === 'SHORT') {
  entry = lastClose;
  stop = entry + 1.5 * ATR;  // Generic ATR stop
  target = pivots.s1 || pivots.s2;  // Generic pivot targets
}
```

This caused:
1. **SHORT trades:** Massive stops on breakdown stocks (20D high is 15-30% above entry)
2. **LONG trades:** Tiny targets on momentum stocks (R1 pivot too close after big green day)

---

## Examples of Broken Setups

### SHORT Example: BERGEPAINT
- **Scenario:** Dropped from ₹526 → ₹458 (12.9% decline)
- **OLD Formula:**
  - Entry: ₹458
  - Stop: ₹480.50 (entry + 1.5 ATR) OR ₹526 (high20D fallback) ❌
  - Target: ₹445 (pivot S1)
  - Risk: ₹68 (14.9%), Reward: ₹13 (2.8%)
  - **R:R: 0.19:1** → REJECTED ❌

- **NEW Formula (scan-type-aware):**
  - Entry: ₹455.8 (below Friday low)
  - Stop: ₹474.5 (swing high 5D, NOT 20D high) ✅
  - Target: ₹425.8 (ATR extension / structural support)
  - Risk: ₹18.8 (4.1%), Reward: ₹30 (6.6%)
  - **R:R: 1.6:1** → PASSED ✅

### LONG Example: EICHERMOT
- **Scenario:** Big green day, closed at ₹4,850 (up 3%)
- **OLD Formula:**
  - Entry: ₹4,850 (lastClose - already extended)
  - Stop: ₹4,800 (entry - 1.5 ATR)
  - Target: ₹4,868 (pivot R1 - only ₹18 above entry) ❌
  - Risk: ₹50, Reward: ₹18
  - **R:R: 0.36:1** → REJECTED ❌

- **NEW Formula (scan-type-aware):**
  - Entry: ₹4,920 (above Friday high - confirms continuation) ✅
  - Stop: ₹4,743 (below EMA20 - momentum support)
  - Target: ₹5,200 (52W high - structural resistance)
  - Risk: ₹177 (3.6%), Reward: ₹280 (5.7%)
  - **R:R: 1.6:1** → PASSED ✅

---

## Implementation Details

### 1. Added Swing Levels to Indicators Engine ✅

**File:** `backend/src/engine/indicators.js`

Added 5D and 10D swing highs/lows for tighter stops on breakdown stocks:

```javascript
function calculateSwingLevels(candles, indicators) {
  // 5-day swing levels (for tight breakdown stops)
  if (candles.length >= 5) {
    const recent5 = lastN(candles, 5);
    indicators.high_5d = round2(max(recent5.map(c => c.high)));
    indicators.low_5d = round2(min(recent5.map(c => c.low)));
  }

  // 10-day swing levels (for consolidation setups)
  if (candles.length >= 10) {
    const recent10 = lastN(candles, 10);
    indicators.high_10d = round2(max(recent10.map(c => c.high)));
    indicators.low_10d = round2(min(recent10.map(c => c.low)));
  }

  // Existing: 20D, 50D levels...
}
```

**Why?** Stocks that already dropped 10-30% need stops at **recent swing highs** (5-10 day), not the 20D high from before the drop.

---

### 2. Passed Swing Levels Through Enrichment Pipeline ✅

**File:** `backend/src/services/technicalData.service.js`

Added to the daily analysis data structure:

```javascript
{
  // Swing levels for scan-type-aware stops
  high_5d: round2(dailyIndicators.high_5d) || 0,
  low_5d: round2(dailyIndicators.low_5d) || 0,
  high_10d: round2(dailyIndicators.high_10d) || 0,
  low_10d: round2(dailyIndicators.low_10d) || 0,
  high_20d: round2(dailyIndicators.high_20d) || 0,
  low_20d: round2(dailyIndicators.low_20d) || 0,

  // Added weekly support levels for SHORT targets
  weekly_s1: weeklyPivot?.s1 || null,
  weekly_s2: weeklyPivot?.s2 || null
}
```

---

### 3. Added SHORT Trade Functions to scanLevels.js ✅

**File:** `backend/src/engine/scanLevels.js`

Added 4 new SHORT calculation functions (~300 lines):

#### A. `calculateBreakdownLevels()` - Breakdown Setup
```javascript
// For stocks cracking support near 20D low
Entry: Below Friday low (confirms breakdown)
Stop:  Recent swing high (5-10 day), NOT 20D high ✅
Target: Weekly S1 → S2 → 20D Low → ATR Extension
```

#### B. `calculateMomentumBearishLevels()` - Momentum Carry Bearish
```javascript
// For stocks in downtrend, running below EMA20
Entry: Below Friday low (momentum continuation)
Stop:  Above EMA20 (momentum resistance), capped at 2 ATR
Target: Weekly S1 → S2 → 20D Low
```

#### C. `calculateFailedResistanceLevels()` - Failed at Resistance
```javascript
// For stocks rejected at resistance, falling back
Entry: Below Friday low (confirms rejection)
Stop:  Above resistance (high20D or weeklyR1)
Target: Weekly S1 → S2 → 20D Low
```

#### D. `calculateCompressionBearishLevels()` - Compression Bearish
```javascript
// For stocks in tight range near lows, ready to break down
Entry: Below consolidation range
Stop:  Above consolidation high (pattern fails if breaks out upward)
Target: Weekly S1 → S2 → 20D Low
```

#### Helper: `findShortStructuralTarget()`
```javascript
// Structural support ladder (downward version of resistance ladder)
Priority: Weekly S1 → Weekly S2 → 20D Low → ATR Extension → REJECT
```

---

### 4. Updated applyGuardrails() for SHORT Trades ✅

**File:** `backend/src/engine/scanLevels.js`

Made the guardrails direction-aware:

```javascript
function applyGuardrails(entry, stop, target, atr, scanType) {
  const isShortTrade = ['breakdown_setup', 'momentum_carry_bearish',
                        'failed_at_resistance', 'compression_bearish'].includes(scanType);

  // SHORT: Stop must be ABOVE entry, target BELOW entry
  // LONG: Stop must be BELOW entry, target ABOVE entry

  const risk = isShortTrade ? (stop - entry) : (entry - stop);
  const reward = isShortTrade ? (entry - target) : (target - entry);

  // Risk/reward validation works correctly for both directions
}
```

---

### 5. Wired dailyPicksService.js to scanLevels.js ✅

**File:** `backend/src/services/dailyPicks/dailyPicksService.js`

**Completely replaced** the generic `calculateLevels()` function:

```javascript
// OLD (generic, scan-agnostic)
function calculateLevels(pick) {
  if (direction === 'SHORT') {
    entry = lastClose;
    stop = entry + 1.5 * ATR;  // ❌ Generic
    target = pivots.s1 || pivots.s2;
  }
  // Similar generic logic for LONG...
}

// NEW (scan-type-aware)
function calculateLevels(pick) {
  const scanData = {
    fridayHigh, fridayLow, fridayClose,
    ema20, atr,
    high5D, high10D, high20D, low20D,
    high52W, weeklyR1, weeklyR2, weeklyS1, weeklyS2,
    dailyR1, dailyS1
  };

  // Route through scan-type-aware engine ✅
  const result = scanLevels.calculateTradingLevels(scan_type, scanData);

  if (!result.valid) {
    return null;  // Enforce discipline
  }

  return {
    ...pick,
    levels: {
      entry: result.entry,
      stop: result.stop,
      target: result.target2,
      risk_pct: result.riskPercent,
      reward_pct: result.rewardPercent,
      risk_reward: result.riskReward,
      mode: result.mode,
      reason: result.reason
    }
  };
}
```

---

### 6. Added momentum_carry Alias ✅

**File:** `backend/src/engine/scanLevels.js`

Daily picks use `momentum_carry` while weekly picks use `momentum`:

```javascript
case 'momentum':
case 'momentum_carry':  // Alias for daily picks ✅
  result = calculateMomentumLevels(data);
  break;
```

---

## Test Results

**Test Suite:** `backend/scripts/test-scan-levels-fix.js`

| Test | Scan Type | Before | After | Status |
|------|-----------|--------|-------|--------|
| **BERGEPAINT** | breakdown_setup | Stop ₹526 (14.9% risk), R:R 0.19:1 ❌ | Stop ₹474 (4.1% risk), R:R 1.6:1 ✅ | **PASSED** |
| **NEWGEN** | breakdown_setup | Stop ₹782 (46% risk!), R:R 0.3:1 ❌ | Stop ₹556 (4.7% risk), R:R 1.6:1 ✅ | **PASSED** |
| **EICHERMOT** | momentum_carry | Entry ₹4850, target ₹4868, R:R 0.36:1 ❌ | Entry ₹4920, target ₹5200, R:R 1.6:1 ✅ | **PASSED** |
| **LUMAXTECH** | momentum_carry | Entry ₹425, target ₹435, R:R 0.36:1 ❌ | Entry ₹432, target ₹460, R:R 2.0:1 ✅ | **PASSED** |

**All 4 tests passed!** 🎉

Run test: `node backend/scripts/test-scan-levels-fix.js`

---

## Key Differences: Scan-Type-Aware Logic

### SHORT Trades

| Scan Type | Entry | Stop | Target |
|-----------|-------|------|--------|
| **breakdown_setup** | Below Friday low | Swing high (5-10D) ✅ | Weekly S1 → S2 → 20D Low |
| **momentum_carry_bearish** | Below Friday low | Above EMA20 (capped 2 ATR) | Weekly S1 → S2 → 20D Low |
| **failed_at_resistance** | Below Friday low | Above resistance | Weekly S1 → S2 → 20D Low |
| **compression_bearish** | Below consolidation | Above consolidation high | Weekly S1 → S2 → 20D Low |

**Critical Fix:** Breakdown stocks now use **swing high (5-10D)** for stops, NOT 20D high!

---

### LONG Trades

| Scan Type | Entry | Stop | Target |
|-----------|-------|------|--------|
| **momentum_carry** | Above Friday high ✅ | Below EMA20 | Weekly R1 → R2 → 52W High |
| **breakout_setup** | Above 20D high | Below EMA20 (capped 1.5 ATR) | Weekly R1 → R2 → 52W High |
| **pullback_at_support** | At/near EMA20 (limit) | Below support | Weekly R1 → R2 → 52W High |
| **compression_bullish** | Above consolidation | Below consolidation low | Weekly R1 → R2 → 52W High |

**Critical Fix:** Momentum stocks now enter **above Friday high** (confirms continuation), not at lastClose!

---

## Impact & Benefits

### Before (Generic Formula)
- **148 daily picks scanned** (2026-02-10)
- **ALL 148 REJECTED** due to bad R:R ratios ❌
- SHORT: Stops at 20D high (15-30% above entry)
- LONG: Entries at lastClose, targets at tiny pivot R1

### After (Scan-Type-Aware)
- **Same 148 picks, scan-type-aware logic** ✅
- Breakdown SHORT: Viable R:R (1.5-2.0:1) using swing highs
- Momentum LONG: Viable R:R (1.5-2.0:1) with structural targets
- Expected pass rate: **30-50% of picks** (instead of 0%)

### Risk Management Improvements
- SHORT breakdown stops: **4-5% risk** instead of 15-30%
- LONG momentum targets: **5-7% reward** instead of 0.5-1%
- R:R ratios: **1.5-2.0:1** instead of 0.3-0.6:1

---

## Files Modified

1. **`backend/src/engine/indicators.js`** (+15 lines)
   - Added high_5d, low_5d, high_10d, low_10d swing levels

2. **`backend/src/services/technicalData.service.js`** (+6 lines)
   - Passed 5D/10D/weekly S1/S2 through enrichment pipeline

3. **`backend/src/engine/scanLevels.js`** (+350 lines)
   - Added 4 SHORT calculation functions
   - Added findShortStructuralTarget() helper
   - Updated applyGuardrails() for SHORT trades
   - Added momentum_carry alias

4. **`backend/src/services/dailyPicks/dailyPicksService.js`** (replaced 108 lines)
   - Replaced entire calculateLevels() function
   - Now routes through scanLevels.calculateTradingLevels()

5. **`backend/scripts/test-scan-levels-fix.js`** (new file, 320 lines)
   - Comprehensive test suite with 4 real examples

**Total:** ~700 lines changed/added

---

## Next Steps

### Immediate Actions
1. ✅ **Implemented:** Scan-type-aware entry/SL/target logic
2. ✅ **Tested:** All 4 test cases pass
3. ⏳ **Next:** Run daily picks scan with yesterday's 148 candidates to see pass rate

### Validation Steps
1. Run yesterday's scan again: `npm run daily-picks:scan`
2. Compare before/after rejection rates
3. Verify stops are using swing highs (not 20D highs) for breakdowns
4. Verify momentum entries are above Friday high (not lastClose)

### Monitoring
- Track R:R ratios for next 5 days of daily picks
- Monitor actual vs expected stop hit rates
- Compare performance: scan-aware vs generic formula

---

## Technical Notes

### Why Swing Highs for Breakdown Stops?
Stocks that already dropped 10-30% have **two different high levels**:
- **20D high:** The high from BEFORE the big drop (way above current price)
- **Swing high (5-10D):** The recent consolidation high (3-5% above current price)

Using 20D high creates stops like:
- BERGEPAINT: ₹526 (14.9% risk) ❌
- NEWGEN: ₹782 (46% risk!) ❌

Using swing high creates stops like:
- BERGEPAINT: ₹474 (4.1% risk) ✅
- NEWGEN: ₹556 (4.7% risk) ✅

### Why Entry Above Friday High for Momentum?
Momentum stocks close strong after a big green day (e.g., +3%). Entering at lastClose means:
- Already extended (price at intraday high)
- No confirmation (could reverse on Monday)
- Target too close (R1 pivot only ₹10-20 away)

Entering above Friday high means:
- Wait for Monday confirmation (breakout holds)
- Proper structural targets (Weekly R1/R2, 52W high)
- Better R:R ratios (1.5-2.0:1 instead of 0.3:1)

---

## Conclusion

The scan-type-aware fix addresses the **root cause** of 100% rejection rate for daily picks:
- SHORT trades can now handle breakdown stocks that already moved 10-30%
- LONG trades get proper momentum entries and structural targets
- Both directions use contextually appropriate stops and targets

This brings daily picks quality in line with weekly picks, which already use the same proven `scanLevels.js` engine.

**Status:** ✅ Ready for production testing
