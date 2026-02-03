/**
 * One-time script to find and update exact entry crossing times
 * for stocks that already have trade_simulation.status = ENTERED
 *
 * This uses the historical intraday API to find the exact minute
 * when the price first crossed the entry level.
 *
 * Usage: node scripts/fix-entry-times.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../.env') });

import WeeklyWatchlist from '../src/models/weeklyWatchlist.js';
import { findHistoricalLevelCrossTime } from '../src/utils/stockDb.js';

async function fixEntryTimes() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  FIX ENTRY TIMES - Find Exact Crossing Times');
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

    // Find the active watchlist
    const watchlist = await WeeklyWatchlist.findOne({ status: 'ACTIVE' });

    if (!watchlist) {
      console.log('\n⚠️ No active watchlist found');
      return;
    }

    console.log(`\n📋 Processing: ${watchlist.week_label}`);
    console.log(`   Stocks: ${watchlist.stocks.length}`);

    let updatedCount = 0;
    let skippedCount = 0;

    for (const stock of watchlist.stocks) {
      console.log(`\n─────────────────────────────────────────────────────────────────`);
      console.log(`📊 ${stock.symbol}`);

      const sim = stock.trade_simulation;

      // Skip if no simulation or not entered
      if (!sim || sim.status === 'WAITING') {
        console.log(`   ⏭️ Skipping - not entered yet (status: ${sim?.status || 'null'})`);
        skippedCount++;
        continue;
      }

      // Skip if no entry date
      if (!sim.entry_date) {
        console.log(`   ⏭️ Skipping - no entry_date`);
        skippedCount++;
        continue;
      }

      // Get entry level
      const entryLevel = stock.levels?.entryRange?.[0] || stock.levels?.entry;
      if (!entryLevel) {
        console.log(`   ⏭️ Skipping - no entry level defined`);
        skippedCount++;
        continue;
      }

      const entryDateStr = new Date(sim.entry_date).toISOString().split('T')[0];

      console.log(`   Current entry_date: ${sim.entry_date}`);
      console.log(`   Entry Level: ₹${entryLevel}`);
      console.log(`   Fetching historical intraday for ${entryDateStr}...`);

      try {
        const crossResult = await findHistoricalLevelCrossTime(
          stock.instrument_key,
          entryLevel,
          'above',
          sim.entry_date
        );

        if (crossResult) {
          const oldTime = new Date(sim.entry_date).toISOString();
          const newTime = crossResult.crossTime.toISOString();

          console.log(`\n   ✅ Found exact crossing:`);
          console.log(`      Old: ${oldTime}`);
          console.log(`      New: ${newTime}`);
          console.log(`      Price: ₹${crossResult.crossPrice.toFixed(2)}`);

          // Update entry_date
          sim.entry_date = crossResult.crossTime;

          // Update entry event if exists
          if (sim.events?.length > 0) {
            const entryEvent = sim.events.find(e => e.type === 'ENTRY');
            if (entryEvent) {
              entryEvent.date = crossResult.crossTime;
              console.log(`      Updated ENTRY event date`);
            }
          }

          updatedCount++;
        } else {
          console.log(`   ⚠️ Could not find crossing time from API`);
          skippedCount++;
        }
      } catch (apiError) {
        console.log(`   ⚠️ API Error: ${apiError.message}`);
        skippedCount++;
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Save if any updates were made
    if (updatedCount > 0) {
      console.log('\n\n💾 Saving watchlist...');
      await watchlist.save();
      console.log('✅ Watchlist saved successfully');
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  FIX ENTRY TIMES COMPLETE');
    console.log(`  Updated: ${updatedCount}`);
    console.log(`  Skipped: ${skippedCount}`);
    console.log('═══════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Failed:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run
fixEntryTimes()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
