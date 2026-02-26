/**
 * Force Entry Signal — Test Kite GTT Order Placement
 *
 * Runs daily tracking with forceEntrySignaled=true which sets all
 * eligible stocks to ENTRY_SIGNALED and triggers Kite GTT placement.
 *
 * Usage: node src/scripts/forceEntrySignal.js [--dry-run]
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

// Dynamic imports AFTER dotenv so env vars are available to kite.config.js
const mongoose = (await import('mongoose')).default;
const { runDailyTracking } = await import('../services/dailyTrackingService.js');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');

    const result = await runDailyTracking({ dryRun, forceEntrySignaled: true });

    console.log('\nRESULT:');
    if (result.kite) {
      console.log(`  Orders placed: ${result.kite.ordersPlaced}`);
      console.log(`  Orders skipped: ${result.kite.ordersSkipped}`);
      console.log(`  Errors: ${result.kite.errors}`);
    } else {
      console.log('  Kite integration did not run');
    }

  } catch (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

main();
