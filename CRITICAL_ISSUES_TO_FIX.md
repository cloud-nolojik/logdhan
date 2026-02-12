# Critical Issues to Fix Before Production

**Status:** 🔴 BLOCKING - Do not deploy until these are resolved

---

## Issue #1: Entry Order Type Logic (CRITICAL)

### Problem
The scan-type-aware fix changes entry logic for momentum LONG trades:
- **OLD:** Entry = lastClose (₹4,850)
- **NEW:** Entry = above Friday high (₹4,920)

But the order placement at 9:15 AM uses **LIMIT orders**, which execute BELOW the price:

```javascript
// Line 752-763: placeEntryOrders()
const result = await kiteOrderService.placeOrder({
  transaction_type: 'BUY',
  order_type: 'LIMIT',  // ❌ WRONG for "buy_above" entries
  price: 4920
});
```

### Why This is Broken

| Scenario | Entry Price | Order Type | Opening Price | Execution | Expected? |
|----------|-------------|------------|---------------|-----------|-----------|
| Gap up | ₹4,920 | LIMIT BUY | ₹5,000 | NO FILL ❌ | ❌ Should NOT enter (price away from entry) |
| Gap down | ₹4,920 | LIMIT BUY | ₹4,800 | **FILLS AT ₹4,800** ❌ | ❌ Should NOT enter (momentum broken!) |
| Opens at entry | ₹4,920 | LIMIT BUY | ₹4,920 | FILLS AT ₹4,920 ✅ | ✅ Correct |

**The killer:** If EICHERMOT gaps down to ₹4,800 (momentum broken), the LIMIT BUY still executes, but the setup is now invalidated.

### What We Need

Entry logic needs to be **entryType-aware**:

```javascript
const entryType = pick.levels.entry_type;  // 'buy_above', 'sell_below', 'limit'

if (entryType === 'buy_above') {
  // LONG momentum: Use SL (stop-loss trigger) order
  // Triggers BUY only when price crosses ABOVE entry
  order_type = 'SL';
  trigger_price = entry;
  price = entry + (0.1% buffer);  // Slight buffer for slippage

} else if (entryType === 'sell_below') {
  // SHORT breakdown: Use SL-M (stop-loss market) order
  // Triggers SELL only when price crosses BELOW entry
  order_type = 'SL-M';
  trigger_price = entry;

} else {
  // Pullback: Use LIMIT order (buy at/below entry)
  order_type = 'LIMIT';
  price = entry;
}
```

### Files to Modify
1. **`dailyPicksService.js:placeEntryOrders()`** - Add entryType branching logic
2. **`calculateLevels()`** - Ensure `entry_type` is passed through from scanLevels result

---

## Issue #2: Stop Cap for Daily Picks (HIGH PRIORITY)

### Problem
The 5% stop cap in `applyGuardrails()` is too wide for **intraday MIS** positions that force-close at 3 PM.

```javascript
// backend/src/engine/scanLevels.js:1177
const MAX_RISK_PERCENT = 8.0;  // ❌ Too high for daily picks
```

### Why This Matters

| Example | ATR % | Stop Distance | Problem |
|---------|-------|---------------|---------|
| HEG | 14.55% | 5% stop = ₹750 risk | ❌ Daily picks close at 3 PM - no time to recover |
| High volatility stocks | 10%+ | 5% stop reasonable for **swing** | ❌ But NOT for **intraday** |

### Solution Options

**Option A: Separate guardrails for daily vs weekly**
```javascript
function applyGuardrails(entry, stop, target, atr, scanType, tradingHorizon = 'swing') {
  const MAX_RISK_PERCENT = tradingHorizon === 'intraday' ? 3.0 : 8.0;
  // ...
}
```

**Option B: Cap at scanLevels call site**
```javascript
// In dailyPicksService.js:calculateLevels()
const result = scanLevels.calculateTradingLevels(scan_type, scanData);

if (result.valid && result.riskPercent > 3.0) {
  console.log(`${symbol}: Risk ${result.riskPercent}% exceeds daily picks cap (3%) - REJECTED`);
  return null;
}
```

**Recommendation:** Option B (cleaner separation, doesn't pollute scanLevels with context-specific logic)

### Files to Modify
1. **`dailyPicksService.js:calculateLevels()`** - Add 3% risk cap check after scanLevels call

---

## Issue #3: Pass Rate Validation (HIGH PRIORITY)

### Problem
We estimated 35-45% pass rate (50-70 picks from 148), but this is **unverified**.

If pass rate is:
- **<10%:** Filters too strict (defeats the fix)
- **10-30%:** Good (5-15 viable picks after scoring)
- **>50%:** Too loose (70+ picks overwhelms scoring/execution)

### What to Test

Run yesterday's 148 candidates through the new engine:

```bash
# Simulate yesterday's scan with new logic
node backend/scripts/test-daily-picks-pass-rate.js
```

Expected output:
```
Total scanned: 148
After scanLevels: 45 passed (30.4%)
After scoring (top 10): 10 picks
After selection (top 3): 3 picks for execution
```

### Validation Criteria
- **Pass rate:** 20-40% (30-60 picks)
- **After top-10 scoring:** 5-10 picks remain
- **After top-3 selection:** Exactly 3 picks executed (current logic caps at 3)

### Files to Create
1. **`backend/scripts/test-daily-picks-pass-rate.js`** - Replay yesterday's scan with new logic

---

## Issue #4: Top-N Selection Logic (MEDIUM PRIORITY)

### Current Logic
```javascript
// Line 712: placeEntryOrders()
const pendingPicks = doc.picks.filter(p => p.trade.status === 'PENDING');
```

This places orders for **ALL pending picks**, not just top 3.

### Verification Needed

Check if there's a cap earlier in the pipeline:

```javascript
// In runDailyPicks() or savePicks()
const topPicks = scoredPicks
  .sort((a, b) => b.rank_score - a.rank_score)
  .slice(0, 3);  // ← Is this cap still in place?
```

**If no cap exists:** With 50+ passing picks, this will try to place 50 orders (capital allocation will spread too thin).

### Files to Check
1. **`dailyPicksService.js:runDailyPicks()`** - Verify top-N selection
2. **`dailyPicksService.js:savePicks()`** - Check if picks are capped before save

---

## Issue #5: high_5d Calculation (VERIFIED ✅)

### Checked
```javascript
// backend/src/engine/indicators.js:277
indicators.high_5d = round2(max(recent5.map(c => c.high)));
```

Uses **candle.high** (intraday high), not **candle.close**. ✅ Correct!

**Status:** No fix needed.

---

## Priority Order

| Priority | Issue | Impact | Effort | Blocker? |
|----------|-------|--------|--------|----------|
| **P0** | #1: Entry order type | CRITICAL - Wrong entries execute | Medium | ✅ YES |
| **P1** | #2: Stop cap (3% for daily) | High volatility stocks rejected | Low | ⚠️ Recommended |
| **P1** | #3: Pass rate validation | Unknown if fix works as expected | Low | ⚠️ Recommended |
| **P2** | #4: Top-N selection | Potential capital spread | Low | ⚠️ Verify only |
| ✅ | #5: high_5d calculation | Already correct | N/A | No |

---

## Implementation Plan

### Phase 1: Blockers (Do NOT deploy without these)
1. ✅ Fix entry order type logic (`placeEntryOrders()`)
2. ✅ Add 3% risk cap for daily picks (`calculateLevels()`)
3. ✅ Create pass rate validation script

### Phase 2: Validation (Run before going live)
4. Test pass rate with yesterday's 148 picks
5. Verify top-N selection caps at 3
6. Monitor first day with strict limits

### Phase 3: Tuning (After 5 days of live data)
7. Adjust risk cap if needed (2-4% range)
8. Tune pass rate if rejection too high/low
9. Consider adding min score threshold

---

## Test Checklist Before Production

- [ ] Entry order type logic added
- [ ] 3% risk cap enforced for daily picks
- [ ] Pass rate validation script created and run
- [ ] Verified top-3 selection still in place
- [ ] Test suite still passes (4/4 tests)
- [ ] Reviewed order execution flow for "buy_above" entries
- [ ] Confirmed stop orders supported by kiteOrderService
- [ ] Dry run with 1 day of real picks

---

## Notes

### Why LIMIT Orders Fail for Momentum

**LIMIT BUY:** "Buy at or below X"
- Good for: Pullbacks (buy the dip)
- Bad for: Momentum (buy the breakout)

**SL (Stop Loss) BUY:** "Trigger BUY when price crosses above X"
- Good for: Momentum (confirms continuation)
- Bad for: Nothing (it's the right order type)

### Kite Order Types

| Type | Description | Use Case |
|------|-------------|----------|
| **MARKET** | Buy/Sell at current market price | Immediate execution |
| **LIMIT** | Buy at or below X, Sell at or above X | Pullbacks, mean reversion |
| **SL** | Trigger when price crosses level, then LIMIT | Breakouts, stop-loss exits |
| **SL-M** | Trigger when price crosses level, then MARKET | Fast execution after trigger |

**For momentum LONG:** Use **SL** (stop-loss trigger) to enter only when price crosses above entry.

---

## Questions for Review

1. Does `kiteOrderService.placeOrder()` support `order_type: 'SL'` with `trigger_price`?
2. Is there a top-3 cap before `placeEntryOrders()` is called?
3. Should we add a min score threshold (e.g., reject if rank_score < 60)?
4. What's the actual ATR distribution for daily picks (median, 90th percentile)?

---

## Status

**Current:** 🔴 BLOCKING - Issues #1, #2, #3 must be resolved
**Next Step:** Implement Phase 1 fixes
**ETA:** 1-2 hours for all P0/P1 fixes
