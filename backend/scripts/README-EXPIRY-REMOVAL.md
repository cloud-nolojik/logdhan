# Strategy Expiry Removal Migration

## 📋 Overview

This migration removes auto-expiry from stock analysis strategies. Previously, strategies would auto-delete after 3:59 PM on the next trading day. Now, strategies persist indefinitely and are validated/updated during daily bulk analysis at 4:00 PM.

## 🎯 Changes Made

### 1. **StockAnalysis Model** (`src/models/stockAnalysis.js`)
- ❌ Removed TTL index: `{ expires_at: 1 }, { expireAfterSeconds: 0 }`
- ✅ Updated compound index to use `created_at` instead of `expires_at`
- 📝 Strategies no longer auto-delete from database

### 2. **MarketHoursUtil** (`src/utils/marketHours.js`)
- ❌ Removed complex next-trading-day expiry logic
- ✅ `getExpiryTime()` now returns far future date (10 years from now)
- 📝 No more daily expiry calculations

### 3. **Strategy Lifecycle**
- **Before:** Create strategy → Expires next day 3:59 PM → Auto-deleted by MongoDB
- **After:** Create strategy → Expires in 10 years → Validated daily during bulk analysis

## 🚀 Migration Steps

### Step 1: Update Existing Analyses

Run the migration script to update all existing analyses with far future expiry:

```bash
node backend/scripts/migrate-remove-expiry.js
```

**What it does:**
- Finds all existing `StockAnalysis` documents
- Sets `expires_at` to 10 years in the future
- Prints summary of updated records

**Expected output:**
```
🚀 Starting migration: Remove auto-expiry from analyses...
✅ Connected to MongoDB
📊 Found 125 analyses to update
📅 Setting all expires_at to: 2035-01-13T10:29:00.000Z

✅ Updated RELIANCE (507f1f77bcf86cd799439011)
✅ Updated TCS (507f1f77bcf86cd799439012)
...

====================================================================
📊 MIGRATION SUMMARY
====================================================================
Total analyses:     125
✅ Updated:         125
⏭️  Skipped:         0
❌ Errors:          0
====================================================================

🎉 Migration completed successfully!
```

### Step 2: Drop TTL Index

After migration completes, drop the TTL index from MongoDB:

```bash
node backend/scripts/drop-ttl-index.js
```

**What it does:**
- Connects to MongoDB
- Lists all indexes on `stockanalyses` collection
- Drops the `expires_at_1` TTL index
- Verifies removal

**Expected output:**
```
🚀 Starting: Drop TTL index from stockanalyses collection...
✅ Connected to MongoDB

📋 Current indexes:
   - _id_: {"_id":1}
   - instrument_key_1_analysis_type_1_created_at_1: {"instrument_key":1,"analysis_type":1,"created_at":1}
   - expires_at_1: {"expires_at":1}

⚠️  Found TTL index: expires_at_1
   - Key: {"expires_at":1}
   - expireAfterSeconds: 0

🗑️  Dropping TTL index...
✅ TTL index dropped successfully!

📋 Remaining indexes:
   - _id_: {"_id":1}
   - instrument_key_1_analysis_type_1_created_at_1: {"instrument_key":1,"analysis_type":1,"created_at":1}

🎉 TTL index removal complete!
```

### Step 3: Restart Application

Restart your Node.js application to apply the schema changes:

```bash
# If using PM2
pm2 restart all

# Or restart your process manually
```

## ✅ Verification

After migration, verify the changes:

### 1. Check Expiry Dates
```javascript
// In MongoDB shell or Compass
db.stockanalyses.find({}, { stock_symbol: 1, expires_at: 1, created_at: 1 }).limit(5)

// All expires_at should be ~10 years in future
```

### 2. Check Indexes
```javascript
db.stockanalyses.getIndexes()

// Should NOT see: { name: "expires_at_1", expireAfterSeconds: 0 }
```

### 3. Test Strategy Creation
```bash
# Create a new analysis and check expires_at
# Should be set to 10 years from now
```

## 🔄 New Strategy Lifecycle

### Before Migration:
```
Day 1 (4:00 PM): Strategy created
                 ↓
Day 2 (3:59 PM): MongoDB TTL auto-deletes strategy ❌
                 User loses data!
```

### After Migration:
```
Day 1 (4:00 PM): Strategy created, expires_at = 2035-01-13
                 ↓
Day 2 (4:00 PM): Bulk analysis runs
                 ├─ Validates existing strategy with AI
                 ├─ AI decides: KEEP | UPDATE | REPLACE
                 └─ Updates same document (no new document)
                 ↓
Day 3 (4:00 PM): Bulk analysis runs again
                 └─ Continues validation cycle
                 ↓
... Strategy persists until manually deleted or replaced by AI
```

## 🤖 Bulk Analysis Validation (To Be Implemented)

The daily bulk analysis will handle strategy lifecycle:

```javascript
// During bulk analysis (4:00 PM)
for (const stock of user.watchlist) {
    const existingAnalysis = await StockAnalysis.findByInstrument(stock.instrument_key);

    if (existingAnalysis) {
        // Pass to AI for validation
        const result = await aiAnalyzeService.validateExistingStrategy(
            existingAnalysis,
            currentMarketData
        );

        // Handle AI decision
        switch (result.action) {
            case 'KEEP':   // Strategy still valid
            case 'UPDATE': // Adjust entry/SL/target
            case 'REPLACE': // Generate new strategy
        }
    }
}
```

## 📊 Database Impact

### Storage
- **Before:** Strategies deleted daily (~100 docs/day × 30 days = 3K docs)
- **After:** Strategies persist (~100 docs/day × 365 days = 36K docs/year)

### Indexes
- **Before:** 2 indexes (compound + TTL)
- **After:** 1 index (compound only)

### Performance
- **Reads:** Slightly faster (no TTL overhead)
- **Writes:** Same performance
- **Disk:** ~10MB additional storage per year (negligible)

## 🧹 Manual Cleanup (Optional)

If you want to manually clean up old strategies:

```javascript
// Delete strategies older than 90 days (optional)
db.stockanalyses.deleteMany({
    created_at: { $lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }
})
```

## ⚠️ Rollback (If Needed)

If you need to rollback the changes:

### 1. Restore TTL Index
```javascript
// In MongoDB shell
db.stockanalyses.createIndex(
    { expires_at: 1 },
    { expireAfterSeconds: 0 }
)
```

### 2. Revert Code Changes
```bash
git revert <commit-hash>
```

### 3. Update Expires_At
```javascript
// Set all expires_at to next trading day 3:59 PM
// Use previous getExpiryTime() logic
```

## 📝 Notes

- Migration is **idempotent** - safe to run multiple times
- Existing strategies will NOT be deleted during migration
- New strategies will automatically use far future expiry
- Bulk analysis validation logic needs to be implemented separately

## 🐛 Troubleshooting

### Error: "Index not found"
```
✅ This is fine! Index was already removed or never existed.
```

### Error: "Cannot connect to MongoDB"
```
Check your .env file:
- MONGODB_URI should be set correctly
- MongoDB should be running
```

### Migration says "0 analyses updated"
```
Check if you're connected to the correct database:
- Verify MONGODB_URI in .env
- Check database name in connection string
```

## 📞 Support

If you encounter issues during migration:
1. Check the error logs in console output
2. Verify MongoDB connection
3. Ensure you have backup of database before running migration
4. Contact dev team if issues persist

---

**Last Updated:** 2025-01-13
**Author:** AI Migration Assistant
**Version:** 1.0.0
