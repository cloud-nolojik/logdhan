/**
 * Run Daily Tracking for a Specific Date or Live
 *
 * Usage:
 *   node src/scripts/runDailyTrackingForDate.js 2026-02-03           # Historical mode
 *   node src/scripts/runDailyTrackingForDate.js 2026-02-03 --dry-run # Historical + dry run
 *   node src/scripts/runDailyTrackingForDate.js --live               # Live mode (intraday API)
 *   node src/scripts/runDailyTrackingForDate.js --live --dry-run     # Live + dry run
 *
 * This script triggers the existing daily tracking job with:
 * - targetDate: Use historical candles instead of live data
 * - --live: Use live intraday API (same as scheduled 4 PM job)
 * - --dry-run: Don't save changes to DB (default: false)
 */

import '../loadEnv.js';
import mongoose from 'mongoose';
import { runDailyTracking } from '../services/dailyTrackingService.js';

const MONGODB_URI = process.env.MONGODB_URI;

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const targetDate = args.find(arg => /^\d{4}-\d{2}-\d{2}$/.test(arg));
  const dryRun = args.includes('--dry-run');
  const liveMode = args.includes('--live');

  // Must have either a date or --live flag
  if (!targetDate && !liveMode) {
    console.log('Usage:');
    console.log('  Historical mode: node src/scripts/runDailyTrackingForDate.js YYYY-MM-DD [--dry-run]');
    console.log('  Live mode:       node src/scripts/runDailyTrackingForDate.js --live [--dry-run]');
    console.log('');
    console.log('Examples:');
    console.log('  node src/scripts/runDailyTrackingForDate.js 2026-02-03');
    console.log('  node src/scripts/runDailyTrackingForDate.js 2026-02-03 --dry-run');
    console.log('  node src/scripts/runDailyTrackingForDate.js --live');
    console.log('  node src/scripts/runDailyTrackingForDate.js --live --dry-run');
    process.exit(1);
  }

  // Can't use both date and --live
  if (targetDate && liveMode) {
    console.log('Error: Cannot use both a date and --live flag. Choose one.');
    console.log('  - Use a date for historical mode (stockDb candles)');
    console.log('  - Use --live for live mode (intraday API)');
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(70));
  if (liveMode) {
    console.log('DAILY TRACKING: LIVE MODE (Intraday API)');
  } else {
    console.log(`DAILY TRACKING FOR DATE: ${targetDate}`);
  }
  console.log(dryRun ? '(DRY RUN - no changes will be saved)' : '(LIVE RUN - changes will be saved)');
  console.log('═'.repeat(70) + '\n');

  // Connect to MongoDB
  console.log('[DB] Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('[DB] Connected\n');

  try {
    // Run daily tracking with options
    // If liveMode, don't pass targetDate (service will use live API)
    const result = await runDailyTracking({
      targetDate: liveMode ? undefined : targetDate,
      dryRun
    });

    console.log('\n[RESULT]', JSON.stringify(result, null, 2));

  } finally {
    await mongoose.connection.close();
    console.log('\n[DB] Disconnected');
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
