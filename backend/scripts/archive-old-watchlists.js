/**
 * One-time script to archive old active watchlists
 *
 * This fixes the case where multiple watchlists are marked as ACTIVE
 * when only the most recent one should be active.
 *
 * Usage: node scripts/archive-old-watchlists.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../.env') });

async function archiveOldWatchlists() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  ARCHIVE OLD WATCHLISTS');
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI not found in environment');
    }

    console.log('\n📡 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Use native MongoDB collection to bypass Mongoose validation
    // (some old documents have corrupted data like string ObjectIds)
    const db = mongoose.connection.db;
    const collection = db.collection('weeklywatchlists');

    // Find ALL active watchlists sorted by week_start descending (newest first)
    const activeWatchlists = await collection.find({ status: 'ACTIVE' })
      .sort({ week_start: -1 })
      .toArray();

    console.log(`\n📋 Found ${activeWatchlists.length} active watchlist(s)`);

    if (activeWatchlists.length <= 1) {
      console.log('\n✅ Only one (or zero) active watchlist - nothing to archive');
      return;
    }

    // First one is the most recent - keep it active
    const keepActive = activeWatchlists[0];
    console.log(`\n🟢 Keeping ACTIVE: ${keepActive.week_label} (week_start: ${keepActive.week_start})`);
    console.log(`   Stocks: ${keepActive.stocks?.length || 0}`);

    // Archive all others
    const toArchive = activeWatchlists.slice(1);
    console.log(`\n🔶 Archiving ${toArchive.length} old watchlist(s):`);

    for (const watchlist of toArchive) {
      console.log(`\n─────────────────────────────────────────────────────────────────`);
      console.log(`📦 ${watchlist.week_label}`);
      console.log(`   week_start: ${watchlist.week_start}`);
      console.log(`   Stocks: ${watchlist.stocks?.length || 0}`);

      // Use updateOne to bypass validation - just set status to COMPLETED
      await collection.updateOne(
        { _id: watchlist._id },
        { $set: { status: 'COMPLETED' } }
      );

      console.log(`   ✅ Archived (status: COMPLETED)`);
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  ARCHIVE COMPLETE');
    console.log(`  Kept active: ${keepActive.week_label}`);
    console.log(`  Archived: ${toArchive.length} watchlist(s)`);
    console.log('═══════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Archive failed:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run archive
archiveOldWatchlists()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
