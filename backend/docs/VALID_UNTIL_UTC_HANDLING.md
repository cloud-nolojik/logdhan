# valid_until UTC Handling

## ✅ **Answer: YES, valid_until is stored in UTC format**

MongoDB always stores dates in **UTC** format, and we explicitly convert IST to UTC before storing.

---

## 🌍 **Time Conversion Logic**

### **3:30 PM IST = 10:00 AM UTC**

```
IST (India Standard Time):  UTC + 5:30
                           ↓
3:30 PM IST = 15:30 IST
            = 15:30 - 5:30
            = 10:00 UTC
```

---

## 📝 **Code Implementation**

### **In `getValidUntilTime()` method:**

```javascript
// Step 1: Get IST date for the trading day
const validUntilDateIST = new Date(istNow);  // e.g., Friday in IST

// Step 2: Extract date components (year, month, day)
const year = validUntilDateIST.getFullYear();   // 2025
const month = validUntilDateIST.getMonth();     // 0 (January)
const day = validUntilDateIST.getDate();        // 13

// Step 3: Create UTC date for 3:30 PM IST (10:00 AM UTC)
const validUntilUTC = new Date(Date.UTC(
    year,   // 2025
    month,  // 0 (January)
    day,    // 13
    10,     // 10 AM UTC = 3:30 PM IST
    0,      // 0 minutes
    0,      // 0 seconds
    0       // 0 milliseconds
));

// Returns: 2025-01-13T10:00:00.000Z (UTC)
return validUntilUTC;
```

---

## 📊 **Database Storage**

### **Example Document:**

```javascript
{
    _id: ObjectId("..."),
    stock_symbol: "RELIANCE",
    created_at: ISODate("2025-01-13T08:30:00.000Z"),    // Friday 2:00 PM IST
    valid_until: ISODate("2025-01-13T10:00:00.000Z"),   // Friday 3:30 PM IST (10:00 AM UTC)
    analysis_data: { ... }
}
```

**Verification in MongoDB:**
```javascript
// In MongoDB shell
db.stockanalyses.findOne({ stock_symbol: "RELIANCE" }, {
    created_at: 1,
    valid_until: 1
})

// Output:
{
    created_at: ISODate("2025-01-13T08:30:00.000Z"),  // UTC
    valid_until: ISODate("2025-01-13T10:00:00.000Z")  // UTC
}
```

---

## 🔍 **How Comparisons Work**

### **JavaScript Date Comparison:**

```javascript
// When checking if strategy is valid
const now = new Date();  // Current time in UTC
const existing = await StockAnalysis.findOne(...);

// MongoDB returns valid_until as UTC Date object
console.log(existing.valid_until);
// Output: 2025-01-13T10:00:00.000Z (UTC)

// Comparison works correctly because both are UTC
if (now > existing.valid_until) {
    console.log('Strategy expired, needs revalidation');
} else {
    console.log('Strategy still valid');
}
```

---

## ✅ **Why UTC is Important**

### **1. Database Consistency**
```
MongoDB stores ALL dates in UTC
↓
Consistent queries across timezones
↓
No ambiguity
```

### **2. Server Location Independence**
```
Server in US (PST):  3:30 PM IST → Stores as 10:00 AM UTC ✅
Server in India:     3:30 PM IST → Stores as 10:00 AM UTC ✅
Server in UK (GMT):  3:30 PM IST → Stores as 10:00 AM UTC ✅

Result: All servers store same UTC value
```

### **3. Correct Comparisons**
```javascript
// Server time: Any timezone
const now = new Date();  // JavaScript auto-converts to UTC internally

// MongoDB valid_until: Always UTC
existing.valid_until     // UTC Date object

// Comparison: Both UTC, works correctly ✅
now > existing.valid_until
```

---

## 📅 **Complete Examples**

### **Example 1: Friday 2:00 PM Analysis**

```javascript
// User creates analysis
Created at: Friday 2:00 PM IST
         = 2025-01-13 14:00:00 IST
         = 2025-01-13 08:30:00 UTC  ← Stored in DB

Valid until: Friday 3:30 PM IST
          = 2025-01-13 15:30:00 IST
          = 2025-01-13 10:00:00 UTC  ← Stored in DB

// Database document:
{
    created_at: ISODate("2025-01-13T08:30:00.000Z"),
    valid_until: ISODate("2025-01-13T10:00:00.000Z")
}
```

### **Example 2: Friday 4:00 PM Analysis (After Close)**

```javascript
// User creates analysis after market close
Created at: Friday 4:00 PM IST
         = 2025-01-13 16:00:00 IST
         = 2025-01-13 10:30:00 UTC  ← Stored in DB

Valid until: Monday 3:30 PM IST (next trading day)
          = 2025-01-16 15:30:00 IST
          = 2025-01-16 10:00:00 UTC  ← Stored in DB

// Database document:
{
    created_at: ISODate("2025-01-13T10:30:00.000Z"),
    valid_until: ISODate("2025-01-16T10:00:00.000Z")  // Monday
}
```

---

## 🔄 **Validation Check Logic**

```javascript
// aiAnalyze.service.js

const existing = await StockAnalysis.findByInstrument(instrument_key, 'swing');

if (existing && existing.status === 'completed') {
    const now = new Date();  // Current UTC time

    console.log('Current time (UTC):', now.toISOString());
    console.log('Valid until (UTC):', existing.valid_until.toISOString());

    // Example output:
    // Current time (UTC): 2025-01-13T11:00:00.000Z
    // Valid until (UTC):  2025-01-13T10:00:00.000Z

    if (now > existing.valid_until) {
        console.log('⚠️ Strategy expired, needs AI revalidation');
        // Pass to AI for validation
        return await this.validateExistingStrategy(existing);
    }

    console.log('✅ Strategy still valid, using cache');
    return { success: true, data: existing, cached: true };
}
```

---

## 🎯 **Key Points**

1. ✅ **valid_until is ALWAYS stored in UTC**
2. ✅ **MongoDB automatically handles UTC storage**
3. ✅ **JavaScript Date comparisons work correctly** (both are UTC)
4. ✅ **3:30 PM IST = 10:00 AM UTC** (consistent conversion)
5. ✅ **Works regardless of server location**

---

## 🧪 **Testing**

### **Test Script:**

```javascript
// backend/scripts/test-valid-until.js

import MarketHoursUtil from '../src/utils/marketHours.js';

async function testValidUntil() {
    // Test 1: Friday 2 PM IST
    const friday2pm = new Date('2025-01-13T08:30:00.000Z'); // 2 PM IST
    const validUntil1 = await MarketHoursUtil.getValidUntilTime(friday2pm);

    console.log('Test 1: Friday 2 PM IST');
    console.log('Created:', friday2pm.toISOString());
    console.log('Valid until UTC:', validUntil1.toISOString());
    console.log('Valid until IST:', validUntil1.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'}));
    console.log('Expected: Friday 3:30 PM IST (10:00 AM UTC)');
    console.log('---');

    // Test 2: Friday 4 PM IST (after close)
    const friday4pm = new Date('2025-01-13T10:30:00.000Z'); // 4 PM IST
    const validUntil2 = await MarketHoursUtil.getValidUntilTime(friday4pm);

    console.log('Test 2: Friday 4 PM IST');
    console.log('Created:', friday4pm.toISOString());
    console.log('Valid until UTC:', validUntil2.toISOString());
    console.log('Valid until IST:', validUntil2.toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'}));
    console.log('Expected: Monday 3:30 PM IST (10:00 AM UTC)');
}

testValidUntil();
```

**Expected Output:**
```
Test 1: Friday 2 PM IST
Created: 2025-01-13T08:30:00.000Z
Valid until UTC: 2025-01-13T10:00:00.000Z
Valid until IST: 13/1/2025, 3:30:00 pm
Expected: Friday 3:30 PM IST (10:00 AM UTC)
---
Test 2: Friday 4 PM IST
Created: 2025-01-13T10:30:00.000Z
Valid until UTC: 2025-01-16T10:00:00.000Z
Valid until IST: 16/1/2025, 3:30:00 pm
Expected: Monday 3:30 PM IST (10:00 AM UTC)
```

---

## 📝 **Summary**

| Aspect | Value |
|--------|-------|
| **Storage Format** | UTC (always) |
| **Market Close IST** | 3:30 PM |
| **Market Close UTC** | 10:00 AM |
| **MongoDB Format** | ISODate("YYYY-MM-DDTHH:MM:SS.000Z") |
| **JavaScript Type** | Date object (UTC internally) |
| **Comparison** | Direct comparison works (both UTC) |

---

**Yes, `valid_until` is stored in UTC format in the database!** ✅
