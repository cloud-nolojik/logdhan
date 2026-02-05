/**
 * Migration Script: Fix daily_track valid_until to next trading day 9 AM IST
 *
 * This script recalculates valid_until for all daily_track analyses based on
 * their created_at date → next trading day 9 AM IST (3:30 AM UTC).
 *
 * Bug being fixed: Some daily_track analyses had valid_until set to Friday
 * (matching weekend analysis) instead of next trading day.
 *
 * Usage:
 *   node scripts/migrate-daily-track-valid-until.js
 *   node scripts/migrate-daily-track-valid-until.js --dry-run  (preview only)
 */

import '../src/loadEnv.js';
import mongoose from 'mongoose';
import StockAnalysis from '../src/models/stockAnalysis.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Calculate correct valid_until: next trading day 9 AM IST based on created_at
 */
function calculateNextDay9AM(createdAt) {
  const createdDate = new Date(createdAt);
  const istCreated = new Date(createdDate.getTime() + IST_OFFSET_MS);
  const dayOfWeek = istCreated.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat

  let daysToAdd = 1;
  // For weekends, skip to Monday 9 AM
  if (dayOfWeek === 5) daysToAdd = 3; // Fri → Mon (skip Sat/Sun)
  else if (dayOfWeek === 6) daysToAdd = 2; // Sat → Mon
  else if (dayOfWeek === 0) daysToAdd = 1; // Sun → Mon

  const nextDay = new Date(istCreated);
  nextDay.setUTCDate(nextDay.getUTCDate() + daysToAdd);
  nextDay.setUTCHours(9, 0, 0, 0); // 9 AM IST

  // Convert to UTC for storage
  return new Date(nextDay.getTime() - IST_OFFSET_MS);
}

/**
 * Format date for display in IST
 */
function formatIST(date) {
  const istDate = new Date(date.getTime() + IST_OFFSET_MS);
  return istDate.toISOString().replace('T', ' ').substring(0, 19) + ' IST';
}

async function migrate() {
  const isDryRun = process.argv.includes('--dry-run');

  console.log('='.repeat(60));
  console.log('Migration: daily_track valid_until → 9 AM IST');
  console.log('='.repeat(60));
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
  console.log('');

  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Find all daily_track analyses
    const analyses = await StockAnalysis.find({
      analysis_type: 'daily_track'
    }).sort({ created_at: -1 });

    console.log(`\n📊 Found ${analyses.length} daily_track analyses\n`);

    if (analyses.length === 0) {
      console.log('No analyses to migrate.');
      return;
    }

    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const analysis of analyses) {
      try {
        const oldValidUntil = analysis.valid_until;

        if (!oldValidUntil) {
          console.log(`⏭️  ${analysis.stock_symbol || analysis.instrument_key} - no valid_until, skipping`);
          skippedCount++;
          continue;
        }

        const newValidUntil = calculateNextDay9AM(analysis.created_at);

        // Check if already at 9 AM (3:30 UTC)
        const oldUTCHours = oldValidUntil ? new Date(oldValidUntil).getUTCHours() : null;
        const oldUTCMinutes = oldValidUntil ? new Date(oldValidUntil).getUTCMinutes() : null;

        // 9 AM IST = 3:30 AM UTC
        if (oldUTCHours === 3 && oldUTCMinutes === 30) {
          skippedCount++;
          continue; // Already migrated
        }

        console.log(`📝 ${analysis.stock_symbol || analysis.instrument_key}`);
        console.log(`   Created:    ${formatIST(analysis.created_at)}`);
        console.log(`   Old expiry: ${oldValidUntil ? formatIST(new Date(oldValidUntil)) : 'null'}`);
        console.log(`   New expiry: ${formatIST(newValidUntil)}`);

        if (!isDryRun) {
          await StockAnalysis.updateOne(
            { _id: analysis._id },
            { $set: { valid_until: newValidUntil } }
          );
          console.log(`   ✅ Updated`);
        } else {
          console.log(`   ⏭️  Would update (dry run)`);
        }

        updatedCount++;
        console.log('');
      } catch (error) {
        console.error(`   ❌ Error: ${error.message}`);
        errorCount++;
      }
    }

    console.log('='.repeat(60));
    console.log('Summary:');
    console.log(`  Total:   ${analyses.length}`);
    console.log(`  Updated: ${updatedCount}`);
    console.log(`  Skipped: ${skippedCount} (already migrated)`);
    console.log(`  Errors:  ${errorCount}`);
    console.log('='.repeat(60));

    if (isDryRun) {
      console.log('\n⚠️  This was a dry run. Run without --dry-run to apply changes.');
    }

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  }
}

migrate();
