# Quick Start: Remove expires_at Field

## 🚀 3-Step Migration

### 1. Remove Field from Documents
```bash
cd backend
node scripts/migrate-remove-expiry.js
```

### 2. Drop TTL Index
```bash
node scripts/drop-ttl-index.js
```

### 3. Restart App
```bash
pm2 restart all
```

---

## ✅ That's it!

Your strategies will no longer auto-expire.

---

## 📝 What Changed?

- ❌ Removed `expires_at` field from StockAnalysis schema
- ❌ Removed TTL index (auto-deletion)
- ❌ Removed `getExpiryTime()` method
- ✅ Strategies persist indefinitely
- ✅ Validation handled by bulk analysis (to be implemented)

---

## 🧪 Verify

```bash
# In MongoDB shell or Compass
db.stockanalyses.find({ expires_at: { $exists: true } }).count()
# Should return: 0
```

---

## 📖 Full Documentation

See [EXPIRES_AT_FIELD_REMOVED.md](../../EXPIRES_AT_FIELD_REMOVED.md) for complete details.
