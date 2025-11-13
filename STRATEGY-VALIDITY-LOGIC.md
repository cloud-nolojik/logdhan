# Strategy Validity Logic Based on Market Close

## 🎯 Concept

**Swing trading strategies use daily close data.** Therefore, a strategy remains valid until the next market close, after which it should be revalidated with fresh data.

---

## 📅 How It Works

### **valid_until = Next Market Close (3:59:59 PM IST)**

```
Analysis created → valid_until = Next market close at 3:59:59 PM IST
                   ↓
User requests analysis after valid_until?
                   ↓
         YES → Revalidate with AI ✅
         NO  → Use cached strategy ✅
```

---

## 📊 Examples

### **Example 1: Created Friday 2:00 PM**
```
Friday 2:00 PM: Analysis created
                ↓
                valid_until = Friday 3:59:59 PM (today's close)
                ↓
Friday 3:00 PM: User requests → Use cache ✅ (before 3:59:59 PM)
Friday 4:00 PM: User requests → Revalidate 🔄 (after 3:59:59 PM)
```

**Why?** Friday 4 PM data includes Friday's close. Need to check if strategy still valid with that new data.

---

### **Example 2: Created Friday 4:00 PM (After Close)**
```
Friday 4:00 PM: Analysis created (market closed)
                ↓
                valid_until = Monday 3:59:59 PM (next trading day close)
                ↓
Saturday 10 AM: User requests → Use cache ✅
Sunday 3 PM:    User requests → Use cache ✅
Monday 10 AM:   User requests → Use cache ✅ (before Monday 3:59:59 PM)
Monday 4 PM:    User requests → Revalidate 🔄 (after Monday 3:59:59 PM)
```

**Why?** Friday 4 PM to Monday 3:59:59 PM - No new close data. Same market context, cache is valid.

---

### **Example 3: Created Monday 10:00 AM**
```
Monday 10:00 AM: Analysis created
                 ↓
                 valid_until = Monday 3:59:59 PM (today's close)
                 ↓
Monday 2:00 PM:  User requests → Use cache ✅ (before 3:59:59 PM)
Monday 4:00 PM:  User requests → Revalidate 🔄 (after 3:59:59 PM)
```

---

### **Example 4: Bulk Analysis Friday 4:00 PM**
```
Friday 4:00 PM: Bulk analysis runs
                ↓
                Creates/updates strategies
                valid_until = Monday 3:59:59 PM
                scheduled_release_time = 5:00 PM today
                ↓
Friday 5:00 PM: Users see results ✅
Saturday-Monday 3:59:59 PM: Cache valid ✅
Monday 4:00 PM: Next bulk analysis → Revalidate 🔄
```

---

## 🔄 Revalidation Flow

### **When User Requests Analysis:**

```javascript
const existing = await StockAnalysis.findByInstrument(instrument_key, 'swing');

if (existing && existing.status === 'completed') {
    const now = new Date();

    // Check if strategy is still valid
    if (now <= existing.valid_until) {
        console.log(`✅ Strategy valid until ${existing.valid_until}`);
        return { success: true, data: existing, cached: true };
    }

    // Strategy expired, needs revalidation
    console.log(`⚠️ Strategy expired (valid_until: ${existing.valid_until})`);

    // Pass to AI for validation
    const validation = await this.validateExistingStrategy(existing);

    if (validation.action === 'KEEP') {
        // Update valid_until to next market close
        existing.valid_until = await MarketHoursUtil.getValidUntilTime();
        existing.last_validated_at = new Date();
        await existing.save();

        return { success: true, data: existing, validated: true };
    }
    else if (validation.action === 'UPDATE') {
        // Update strategy + valid_until
        existing.analysis_data.strategies[0] = validation.updated_strategy;
        existing.valid_until = await MarketHoursUtil.getValidUntilTime();
        existing.last_validated_at = new Date();
        await existing.save();

        return { success: true, data: existing, updated: true };
    }
    else {
        // REPLACE - create new analysis
        // (fall through)
    }
}

// No existing or needs replacement
return await this.createNewAnalysis(...);
```

---

## 📅 Validity Calculation Logic

### **Function: `getValidUntilTime()`**

```javascript
// In MarketHoursUtil.js

static async getValidUntilTime(fromDate = new Date()) {
    const istNow = this.toIST(fromDate);
    const isTodayTradingDay = await this.isTradingDay(istNow);

    const marketCloseTime = 15 * 60 + 59; // 3:59 PM in minutes
    const currentTimeInMinutes = istNow.getHours() * 60 + istNow.getMinutes();

    if (isTodayTradingDay && currentTimeInMinutes < marketCloseTime) {
        // Before market close → valid until today 3:59:59 PM
        const validUntil = new Date(istNow);
        validUntil.setHours(15, 59, 59, 0);
        return validUntil;
    } else {
        // After market close or non-trading day → valid until next trading day 3:59:59 PM
        const nextTradingDay = await this.getNextTradingDay(istNow);
        nextTradingDay.setHours(15, 59, 59, 0);
        return nextTradingDay;
    }
}
```

---

## 🎯 Benefits of This Approach

### **1. Data Accuracy**
- ✅ Strategy always uses relevant close data
- ✅ No stale strategies after market close
- ✅ Fresh validation when new data available

### **2. Token Efficiency**
- ✅ Cache valid for entire trading session
- ✅ Weekend/holiday requests use cache
- ✅ Only revalidate when new close data exists

### **3. User Experience**
- ✅ Fast responses (use cache when valid)
- ✅ Accurate strategies (revalidate when needed)
- ✅ Predictable behavior (tied to market hours)

### **4. Simple Logic**
- ✅ Easy to understand: "Valid until next close"
- ✅ No arbitrary time limits (6h, 24h, etc.)
- ✅ Aligns with trading reality

---

## 📊 Comparison: Old vs New Logic

### **OLD (Time-Based):**
```
Analysis created: Monday 10 AM
Cache valid for: 6 hours
Expires: Monday 4 PM (arbitrary)

Problem: Monday 2 PM = Still same day's data, but might trigger validation
```

### **NEW (Market Close-Based):**
```
Analysis created: Monday 10 AM
Valid until: Monday 3:30 PM (market close)
After 3:30 PM: Revalidate (new close data available)

Better: Aligns with actual market data freshness ✅
```

---

## 🔄 Bulk Analysis Behavior

### **Daily Bulk Analysis (4:00 PM):**

```javascript
for (const stock of uniqueStocks) {
    const existing = await StockAnalysis.findByInstrument(stock.instrument_key, 'swing');

    if (existing) {
        const now = new Date();

        // Bulk analysis ALWAYS validates (even if valid_until not passed)
        // Reason: Ensure all users get fresh validated data at 5:00 PM
        console.log(`🔄 Bulk analysis: Validating ${stock.trading_symbol}`);

        const validation = await this.validateExistingStrategy(existing);

        // Update existing document
        if (validation.action === 'UPDATE' || validation.action === 'KEEP') {
            existing.analysis_data.strategies[0] = validation.updated_strategy;
            existing.valid_until = await MarketHoursUtil.getValidUntilTime();
            existing.last_validated_at = new Date();
            existing.scheduled_release_time = releaseTime; // 5:00 PM
            await existing.save();
        }
        else {
            // Create new analysis
        }
    }
    else {
        // Create new analysis
    }
}
```

---

## 📝 Database Schema

```javascript
const stockAnalysisSchema = new mongoose.Schema({
    // ... existing fields

    created_at: {
        type: Date,
        default: Date.now,
        index: true
    },

    // When users can see the analysis (bulk analysis)
    scheduled_release_time: {
        type: Date,
        default: null,
        index: true
    },

    // When strategy should be revalidated (market close-based)
    valid_until: {
        type: Date,
        default: null,
        index: true
    },

    // When AI last checked the strategy
    last_validated_at: {
        type: Date,
        default: null
    }
});
```

---

## 🎯 Three Types of Time Fields

| Field | Purpose | Example |
|-------|---------|---------|
| `created_at` | When analysis was created | Friday 2:00 PM |
| `scheduled_release_time` | When users can SEE it | Friday 5:00 PM (bulk) |
| `valid_until` | When to REVALIDATE | Friday 3:30 PM |

**All serve different purposes!**

---

## ✅ Implementation Checklist

- [x] Add `valid_until` field to schema
- [x] Add `last_validated_at` field to schema
- [x] Create `getValidUntilTime()` method
- [ ] Update `analyzeStock()` to check `valid_until`
- [ ] Update `createPendingAnalysisRecord()` to set `valid_until`
- [ ] Create `validateExistingStrategy()` method
- [ ] Update bulk analysis to always validate
- [ ] Add migration script for existing analyses
- [ ] Test validation flow

---

## 🚀 Next Steps

1. **Update `aiAnalyze.service.js`** to use `valid_until` logic
2. **Create AI validation method** (`validateExistingStrategy`)
3. **Update bulk analysis** to always validate
4. **Create migration script** to add `valid_until` to existing analyses
5. **Test thoroughly** with different scenarios

---

**This approach is much smarter than arbitrary time limits!** 🎯
