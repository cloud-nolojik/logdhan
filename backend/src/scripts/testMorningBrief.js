/**
 * Test Script for Monday Morning Brief
 *
 * Connects to MongoDB, runs the morning brief service directly (no Agenda scheduler),
 * and prints categorization results, GTT placement details, and notification summary.
 *
 * Usage:
 *   node src/scripts/testMorningBrief.js              # dry run (default, no real GTTs)
 *   node src/scripts/testMorningBrief.js --live        # live run (places real entry GTTs on Kite)
 */

import '../loadEnv.js';
import mongoose from 'mongoose';
import connectDB from '../config/database.js';
import { runMorningBrief } from '../services/morningBriefService.js';

const isLive = process.argv.includes('--live');
const dryRun = !isLive;

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   Morning Brief Test Script');
  console.log(`   Mode: ${dryRun ? 'DRY RUN (no real orders)' : 'LIVE (will place real GTTs!)'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    console.log('Connecting to MongoDB...');
    await connectDB();
    console.log('MongoDB connected\n');

    console.log('Running morning brief...\n');
    const result = await runMorningBrief({ dryRun });

    console.log('\n───────────────────────────────────────────────────────────');
    console.log('RESULT SUMMARY');
    console.log('───────────────────────────────────────────────────────────');
    console.log(`Success: ${result.success}`);
    console.log(`Duration: ${result.duration_ms}ms`);

    if (result.reason) {
      console.log(`Reason: ${result.reason}`);
    }

    if (result.error) {
      console.log(`Error: ${result.error}`);
    }

    if (result.brief) {
      const b = result.brief;
      console.log(`\nCategories:`);
      console.log(`  Pullback (touch):   ${b.pullback.length}`);
      b.pullback.forEach(s => {
        console.log(`    - ${s.symbol} | Entry: ${s.entry} | Grade: ${s.grade || '-'} | Dist: ${s.distancePct?.toFixed(1)}% | R:R ${s.riskReward}`);
      });

      console.log(`  Breakout (close_above): ${b.breakout.length}`);
      b.breakout.forEach(s => {
        console.log(`    - ${s.symbol} | Entry: ${s.entry} | Grade: ${s.grade || '-'} | Dist: ${s.distancePct?.toFixed(1)}% | R:R ${s.riskReward}`);
      });

      console.log(`  Too far (>4%):      ${b.tooFar.length}`);
      b.tooFar.forEach(s => {
        console.log(`    - ${s.symbol} | Entry: ${s.entry} | Grade: ${s.grade || '-'} | Dist: ${s.distancePct?.toFixed(1)}%`);
      });

      console.log(`  Already active:     ${b.alreadyActive.length}`);
      b.alreadyActive.forEach(s => {
        console.log(`    - ${s.symbol} | Entry: ${s.entry} | Grade: ${s.grade || '-'}`);
      });
    }

    if (result.gttResults) {
      const g = result.gttResults;
      console.log(`\nGTT Results:`);
      console.log(`  Placed:  ${g.placed}`);
      console.log(`  Skipped: ${g.skipped}`);
      console.log(`  Errors:  ${g.errors.length}`);
      if (g.details.length > 0) {
        console.log(`  Details:`);
        g.details.forEach(d => {
          if (d.reason) {
            console.log(`    - ${d.symbol}: ${d.reason}${d.grade ? ` (grade: ${d.grade})` : ''}`);
          } else {
            console.log(`    - ${d.symbol}: GTT placed | ID: ${d.triggerId} | Qty: ${d.quantity} | Value: ${d.orderValue}`);
          }
        });
      }
      if (g.errors.length > 0) {
        console.log(`  Error details:`);
        g.errors.forEach(e => console.log(`    - ${e.symbol}: ${e.error}`));
      }
    }

    if (result.notification) {
      console.log(`\nNotification:`);
      console.log(`  Title: ${result.notification.title}`);
      console.log(`  Body:  ${result.notification.body}`);
      console.log(`  Data:  ${JSON.stringify(result.notification.data, null, 4)}`);
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('   Test completed');
    console.log('═══════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\nTest script error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
    process.exit(0);
  }
}

main();
