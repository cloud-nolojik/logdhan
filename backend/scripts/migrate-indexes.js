/**
 * Migration Script: Drop obsolete indexes and ensure new ones exist
 *
 * What this does:
 * 1. Drops old/broken indexes that were replaced by the performance audit
 * 2. Creates new optimized indexes
 * 3. Verifies final index state for each collection
 *
 * Safe to run multiple times — skips drops if index doesn't exist,
 * skips creates if index already exists.
 *
 * Usage:
 *   node scripts/migrate-indexes.js
 *   node scripts/migrate-indexes.js --dry-run   (preview only, no changes)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const DRY_RUN = process.argv.includes('--dry-run');

// ─── Index changes ───────────────────────────────────────────────────────────

const INDEXES_TO_DROP = [
  {
    collection: 'stockanalyses',
    name: 'instrument_key_1_analysis_type_1_created_at_1',
    description: 'Old compound without status field'
  },
  {
    collection: 'users',
    name: 'watchlist.stock_1',
    description: 'Broken index — field is watchlist.instrument_key, not watchlist.stock'
  },
  {
    collection: 'userpositions',
    name: 'user_id_1_status_1',
    description: 'Superseded by { user_id: 1, status: 1, closed_at: -1 }'
  }
];

const INDEXES_TO_CREATE = [
  {
    collection: 'stockanalyses',
    key: { instrument_key: 1, analysis_type: 1, status: 1, created_at: -1 },
    options: { background: true },
    description: 'Compound covering status filter + sort (replaces old 3-field index)'
  },
  {
    collection: 'stockanalyses',
    key: { stock_symbol: 1, created_at: -1 },
    options: { background: true },
    description: 'By-symbol lookups sorted by recency'
  },
  {
    collection: 'users',
    key: { 'watchlist.instrument_key': 1 },
    options: { background: true },
    description: 'Watchlist subdocument queries (fixed field name)'
  },
  {
    collection: 'userpositions',
    key: { user_id: 1, status: 1, closed_at: -1 },
    options: { background: true },
    description: 'Closed positions sorted by date (replaces { user_id, status })'
  },
  {
    collection: 'stocklogs',
    key: { user: 1, createdAt: -1 },
    options: { background: true },
    description: 'User trade log listing sorted by creation date'
  },
  {
    collection: 'stocklogs',
    key: { user: 1, executedAt: -1 },
    options: { background: true },
    description: 'User trade log listing sorted by execution date'
  }
];

// ─── Migration logic ─────────────────────────────────────────────────────────

async function getExistingIndexes(db, collectionName) {
  try {
    const indexes = await db.collection(collectionName).indexes();
    return indexes;
  } catch (err) {
    // Collection may not exist yet
    return [];
  }
}

async function dropIndex(db, collectionName, indexName) {
  try {
    const indexes = await getExistingIndexes(db, collectionName);
    const exists = indexes.some(idx => idx.name === indexName);

    if (!exists) {
      console.log(`  SKIP  ${collectionName}.${indexName} — does not exist`);
      return;
    }

    if (DRY_RUN) {
      console.log(`  [DRY] Would drop ${collectionName}.${indexName}`);
      return;
    }

    await db.collection(collectionName).dropIndex(indexName);
    console.log(`  DROP  ${collectionName}.${indexName} — done`);
  } catch (err) {
    console.error(`  ERR   ${collectionName}.${indexName} — ${err.message}`);
  }
}

function indexKeyToName(key) {
  return Object.entries(key).map(([k, v]) => `${k}_${v}`).join('_');
}

async function createIndex(db, collectionName, key, options) {
  const indexName = indexKeyToName(key);

  try {
    const indexes = await getExistingIndexes(db, collectionName);
    const exists = indexes.some(idx => idx.name === indexName);

    if (exists) {
      console.log(`  SKIP  ${collectionName}.${indexName} — already exists`);
      return;
    }

    if (DRY_RUN) {
      console.log(`  [DRY] Would create ${collectionName}.${indexName}`);
      return;
    }

    await db.collection(collectionName).createIndex(key, { ...options, name: indexName });
    console.log(`  ADD   ${collectionName}.${indexName} — done`);
  } catch (err) {
    console.error(`  ERR   ${collectionName}.${indexName} — ${err.message}`);
  }
}

async function printIndexes(db, collectionName) {
  const indexes = await getExistingIndexes(db, collectionName);
  if (indexes.length === 0) return;
  console.log(`\n  ${collectionName}:`);
  for (const idx of indexes) {
    const keyStr = JSON.stringify(idx.key);
    const flags = [];
    if (idx.unique) flags.push('unique');
    if (idx.expireAfterSeconds !== undefined) flags.push(`TTL:${idx.expireAfterSeconds}s`);
    const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
    console.log(`    ${idx.name}: ${keyStr}${flagStr}`);
  }
}

async function migrate() {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error('MONGODB_URI not set in .env');
      process.exit(1);
    }

    console.log(DRY_RUN ? '\n=== DRY RUN (no changes) ===' : '\n=== Index Migration ===');
    console.log(`Connecting to MongoDB...\n`);

    await mongoose.connect(uri);
    const db = mongoose.connection.db;

    // ── Step 1: Drop obsolete indexes ──
    console.log('Step 1: Dropping obsolete indexes\n');
    for (const { collection, name, description } of INDEXES_TO_DROP) {
      console.log(`  # ${description}`);
      await dropIndex(db, collection, name);
    }

    // ── Step 2: Create new indexes ──
    console.log('\nStep 2: Creating new indexes\n');
    for (const { collection, key, options, description } of INDEXES_TO_CREATE) {
      console.log(`  # ${description}`);
      await createIndex(db, collection, key, options);
    }

    // ── Step 3: Verify ──
    console.log('\n─── Final index state ───');
    const collections = [...new Set([
      ...INDEXES_TO_DROP.map(i => i.collection),
      ...INDEXES_TO_CREATE.map(i => i.collection)
    ])];
    for (const col of collections.sort()) {
      await printIndexes(db, col);
    }

    console.log('\n\nMigration complete.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

migrate();
