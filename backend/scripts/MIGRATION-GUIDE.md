# Complete Migration Guide: Strategy Validity System

This guide covers the complete migration from the old expires_at system to the new valid_until system.

---

## 🎯 What We're Doing

**Old System**: Strategies auto-deleted at 3:59 PM next trading day (TTL-based)

**New System**: Strategies validated at 3:59:59 PM IST and kept/updated/replaced by AI

---

## 📋 Migration Steps

### Step 1: Remove expires_at Field

Remove the old auto-expiry field from all existing documents.

```bash
cd backend
node scripts/migrate-remove-expiry.js
```

**What it does**:
- Finds all documents with `expires_at` field
- Removes the field using `$unset`

**Expected output**:
```
🚀 Starting migration: Remove expires_at field
📡 Connecting to MongoDB...
✅ Connected to MongoDB
🔍 Finding documents with expires_at field...
📊 Found X documents to update
  ✅ [1/X] Removed expires_at from RELIANCE (NSE_EQ|INE002A01018)
  ✅ [2/X] Removed expires_at from TCS (NSE_EQ|INE467B01029)
  ...
📊 Migration Summary:
   Total Documents: X
   ✅ Successfully Updated: X
   ❌ Failed: 0
✅ Migration completed successfully!
```

---

### Step 2: Drop TTL Index

Remove the MongoDB TTL index that auto-deletes documents.

```bash
node scripts/drop-ttl-index.js
```

**What it does**:
- Drops the `expires_at_1` index
- Prevents auto-deletion of strategies

**Expected output**:
```
🚀 Starting: Drop TTL index on expires_at
📡 Connecting to MongoDB...
✅ Connected to MongoDB
🔍 Checking for TTL index...
✅ Found TTL index: expires_at_1
🗑️  Dropping index...
✅ TTL index dropped successfully!
```

---

### Step 3: Add valid_until Field

Add the new market close-based validity field to all existing documents.

```bash
node scripts/migrate-add-valid-until.js
```

**What it does**:
- Finds all documents without `valid_until` field
- Calculates `valid_until` based on document's `created_at`:
  - If created before 3:59:59 PM on a trading day → valid until that day 3:59:59 PM
  - If created after 3:59:59 PM or on non-trading day → valid until next trading day 3:59:59 PM
- Sets `last_validated_at` to `null` (not yet validated with new system)

**Expected output**:
```
🚀 Starting migration: Add valid_until to existing analyses

📡 Connecting to MongoDB...
✅ Connected to MongoDB

🔍 Finding documents without valid_until field...
📊 Found X documents to update

  ✅ [1/X] Updated RELIANCE (NSE_EQ|INE002A01018)
     Created: 2025-01-10T10:30:00.000Z
     Valid Until: 2025-01-10T10:29:59.000Z (3:59:59 PM IST)

  ✅ [2/X] Updated TCS (NSE_EQ|INE467B01029)
     Created: 2025-01-10T12:00:00.000Z
     Valid Until: 2025-01-13T10:29:59.000Z (next trading day 3:59:59 PM IST)

  ...

==========================================================
📊 Migration Summary:
   Total Documents: X
   ✅ Successfully Updated: X
   ❌ Failed: 0
==========================================================

🔍 Verifying migration...
✅ All documents now have valid_until field!

✅ Migration completed successfully!
```

---

### Step 4: Restart Application

Restart your application to use the new code.

```bash
pm2 restart all
# or for development
npm run dev
```

---

## 🧪 Verification

### 1. Check expires_at Removal

```javascript
// In MongoDB shell or Compass
db.stockanalyses.find({ expires_at: { $exists: true } }).count()
// Should return: 0
```

### 2. Check valid_until Addition

```javascript
// All documents should have valid_until
db.stockanalyses.find({ valid_until: { $exists: false } }).count()
// Should return: 0

// Check a sample document
db.stockanalyses.findOne(
  { status: 'completed' },
  { stock_symbol: 1, created_at: 1, valid_until: 1, last_validated_at: 1 }
)
// Should show:
// {
//   stock_symbol: "RELIANCE",
//   created_at: ISODate("2025-01-10T10:30:00.000Z"),
//   valid_until: ISODate("2025-01-10T10:29:59.000Z"),  // 3:59:59 PM IST in UTC
//   last_validated_at: null
// }
```

### 3. Check TTL Index Removal

```javascript
// List all indexes
db.stockanalyses.getIndexes()
// Should NOT contain an index named "expires_at_1"
```

### 4. Test Strategy Validation

After migration, test the validation flow:

**Test 1: Before Market Close (e.g., 2:00 PM IST)**
```bash
# Request analysis for any stock
# Should return cached strategy with message: "Strategy valid until 3:59:59 PM"
```

**Test 2: After Market Close (e.g., 4:30 PM IST)**
```bash
# Request analysis for any stock
# Should trigger AI validation
# Check logs for:
# "⚠️ [VALIDATION] Strategy expired (valid_until: ...)"
# "🔍 [VALIDATION] Starting validation for SYMBOL"
# "✅ [VALIDATION] Strategy validated - keeping as is" (or UPDATE/REPLACE)
```

**Test 3: Bulk Analysis (4:00 PM IST)**
```bash
# Trigger manual bulk analysis or wait for scheduled run
# Check logs for:
# "📝 [SCHEDULED BULK] Checking existing strategies for X stocks..."
# "✅ [X] SYMBOL - strategy still valid until 2025-XX-XXT10:29:59.000Z"
# "🔄 [X] SYMBOL - expired strategy will be validated"
```

---

## 📊 Time Conversion Reference

**Market Close Time**: 3:59:59 PM IST

**UTC Equivalent**: 10:29:59 AM UTC (IST = UTC+5:30)

**Examples**:
```
IST: 2025-01-10 15:59:59 → UTC: 2025-01-10 10:29:59
IST: 2025-01-13 15:59:59 → UTC: 2025-01-13 10:29:59
```

---

## ⚠️ Important Notes

### 1. No Downtime Required
Migration can be run while the application is running, but for best results:
- Run during off-hours (after market close)
- Or pause bulk analysis temporarily

### 2. Legacy Data Handling
- Documents without `valid_until` are treated as valid (backward compatible)
- Once validated, they'll get the `valid_until` field

### 3. Validation Behavior
- **KEEP**: AI keeps strategy as-is, updates `valid_until` to next market close
- **UPDATE**: AI adjusts entry/target/stop levels, updates `valid_until`
- **REPLACE**: AI creates new strategy from scratch, sets new `valid_until`

### 4. Error Handling
- If validation fails, existing strategy is kept (fail-safe)
- Error is logged, and `valid_until` is extended to next market close

---

## 🔄 Rollback (If Needed)

If something goes wrong, you can rollback:

### 1. Restore expires_at (Not Recommended)
```javascript
// In MongoDB shell - calculate expires_at for all documents
db.stockanalyses.updateMany(
  { expires_at: { $exists: false } },
  { $set: { expires_at: new Date(Date.now() + 24*60*60*1000) } }
)
```

### 2. Recreate TTL Index
```javascript
db.stockanalyses.createIndex(
  { expires_at: 1 },
  { expireAfterSeconds: 0 }
)
```

**However**, it's better to fix issues forward rather than rollback!

---

## 📝 Post-Migration Checklist

- [ ] Run all 3 migration scripts
- [ ] Restart application
- [ ] Verify expires_at removed
- [ ] Verify valid_until added
- [ ] Verify TTL index dropped
- [ ] Test before market close (cached strategy)
- [ ] Test after market close (AI validation)
- [ ] Test bulk analysis flow
- [ ] Monitor logs for validation behavior
- [ ] Check database for correct timestamps

---

## 📞 Troubleshooting

### Issue: Migration script fails with connection error
**Solution**: Check MongoDB connection string in `.env` file

### Issue: Some documents still have expires_at
**Solution**: Run migrate-remove-expiry.js again

### Issue: valid_until timestamps look wrong
**Solution**: Check timezone conversion (should be 10:29:59 AM UTC for 3:59:59 PM IST)

### Issue: Strategies not validating after market close
**Solution**: Check `getValidUntilTime()` method in [marketHours.js](../src/utils/marketHours.js:327-378)

---

## 🎉 Success!

After successful migration:
- ✅ Strategies no longer auto-delete
- ✅ Strategies validated intelligently at market close
- ✅ AI decides KEEP/UPDATE/REPLACE based on fresh data
- ✅ Users always see relevant strategies
- ✅ Token usage optimized (cache valid all day)

**Your strategy validity system is now market-aware!** 🚀
