# Migration Scripts

This directory contains migration scripts for the strategy validity system.

---

## 🚀 Quick Start

Run all migrations in order:

```bash
cd backend

# 1. Remove old expires_at field
node scripts/migrate-remove-expiry.js

# 2. Drop TTL index
node scripts/drop-ttl-index.js

# 3. Add new valid_until field
node scripts/migrate-add-valid-until.js

# 4. Restart application
pm2 restart all
```

See [QUICK-START-MIGRATION.md](QUICK-START-MIGRATION.md) for quick reference.
See [MIGRATION-GUIDE.md](MIGRATION-GUIDE.md) for detailed guide.

---

## 📋 Available Scripts

### 1. `migrate-remove-expiry.js`
**Purpose**: Remove the old `expires_at` field from all StockAnalysis documents

**Usage**:
```bash
node scripts/migrate-remove-expiry.js
```

**What it does**:
- Finds all documents with `expires_at` field
- Removes the field using MongoDB `$unset`
- Reports progress and summary

---

### 2. `drop-ttl-index.js`
**Purpose**: Drop the MongoDB TTL index that auto-deletes documents

**Usage**:
```bash
node scripts/drop-ttl-index.js
```

**What it does**:
- Checks for `expires_at_1` index
- Drops the index if it exists
- Prevents auto-deletion of strategies

---

### 3. `migrate-add-valid-until.js`
**Purpose**: Add the new `valid_until` field to all existing analyses

**Usage**:
```bash
node scripts/migrate-add-valid-until.js
```

**What it does**:
- Finds all documents without `valid_until` field
- Calculates `valid_until` based on `created_at` timestamp:
  - Before 3:59:59 PM on trading day → today 3:59:59 PM IST
  - After 3:59:59 PM or non-trading day → next trading day 3:59:59 PM IST
- Sets `last_validated_at` to `null`
- Stores as UTC: 3:59:59 PM IST = 10:29:59 AM UTC

---

## 🧪 Verification

After running all migrations, verify in MongoDB:

```javascript
// 1. Check expires_at removed
db.stockanalyses.find({ expires_at: { $exists: true } }).count()
// Expected: 0

// 2. Check valid_until added
db.stockanalyses.find({ valid_until: { $exists: false } }).count()
// Expected: 0

// 3. Check TTL index dropped
db.stockanalyses.getIndexes()
// Should NOT contain "expires_at_1"

// 4. Sample document
db.stockanalyses.findOne(
  { status: 'completed' },
  {
    stock_symbol: 1,
    created_at: 1,
    valid_until: 1,
    last_validated_at: 1
  }
)
// Expected output:
// {
//   stock_symbol: "RELIANCE",
//   created_at: ISODate("2025-01-10T10:30:00.000Z"),
//   valid_until: ISODate("2025-01-10T10:29:59.000Z"),  // 3:59:59 PM IST
//   last_validated_at: null
// }
```

---

## ⚠️ Important Notes

1. **Run in Order**: Execute scripts in the order listed above
2. **Idempotent**: Safe to run multiple times (won't duplicate changes)
3. **No Downtime**: Can run while app is running (recommended during off-hours)
4. **Backup**: Always backup database before running migrations
5. **Environment**: Make sure `.env` file has correct `MONGODB_URI`

---

## 📊 Time Reference

| Time IST | Time UTC | Description |
|----------|----------|-------------|
| 3:59:59 PM | 10:29:59 AM | Market close cutoff |
| 4:00 PM | 10:30 AM | Bulk analysis runs |
| 5:00 PM | 11:30 AM | Users see results |

---

## 🔗 Related Documentation

- [MIGRATION-GUIDE.md](MIGRATION-GUIDE.md) - Detailed migration instructions
- [QUICK-START-MIGRATION.md](QUICK-START-MIGRATION.md) - Quick reference
- [../../IMPLEMENTATION-SUMMARY.md](../../IMPLEMENTATION-SUMMARY.md) - Complete implementation overview
- [../../STRATEGY-VALIDITY-LOGIC.md](../../STRATEGY-VALIDITY-LOGIC.md) - How the validity logic works
- [../../VALID-UNTIL-IMPLEMENTATION.md](../../VALID-UNTIL-IMPLEMENTATION.md) - Technical implementation details

---

## 🆘 Troubleshooting

### Script fails with connection error
**Solution**: Check `MONGODB_URI` in `.env` file

### Script hangs or takes too long
**Solution**: Check database connection and network latency

### Some documents not updated
**Solution**: Re-run the script (it's idempotent)

### Need to rollback
**Solution**: See "Rollback" section in [MIGRATION-GUIDE.md](MIGRATION-GUIDE.md)

---

**Questions?** Check the detailed guides or review the implementation docs!
