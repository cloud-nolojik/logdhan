/**
 * Migration Script: Fix TARGET_HIT shares for current week
 *
 * Problem: Stocks with TARGET_HIT have wrong qty_remaining (still 50% instead of 30%)
 * Solution: Recalculate to book 70% at Target, keep only 30% for T2
 *
 * Usage:
 *   node src/scripts/fix-target-hit-shares.js [--dry-run]
 *
 * Options:
 *   --dry-run    Show what would be changed without saving
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import WeeklyWatchlist from '../models/WeeklyWatchlist.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║     FIX TARGET_HIT SHARES - Migration Script               ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Mode: ${dryRun ? 'DRY-RUN (no changes)' : 'LIVE (will update DB)'}                            ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    console.log('[MIGRATION] Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('[MIGRATION] Connected\n');

    // Get current week's watchlist
    const watchlist = await WeeklyWatchlist.getCurrentWeek();
    if (!watchlist) {
      console.log('[MIGRATION] No current week watchlist found. Exiting.');
      return;
    }

    console.log(`[MIGRATION] Found watchlist for week: ${watchlist.week_start_date?.toISOString().split('T')[0]}`);
    console.log(`[MIGRATION] Total stocks: ${watchlist.stocks.length}\n`);

    // Find stocks with TARGET_HIT that need fixing
    const stocksToFix = watchlist.stocks.filter(stock => {
      const sim = stock.trade_simulation;
      const hasTargetHitEvent = sim?.events?.some(e => e.type === 'TARGET_HIT');
      const isPartialExit = sim?.status === 'PARTIAL_EXIT';
      const trackingIsTargetHit = stock.tracking_status === 'TARGET_HIT';

      // Check if TARGET_HIT event has qty = 0 (old format - just notification)
      const targetHitEvent = sim?.events?.find(e => e.type === 'TARGET_HIT');
      const needsFix = targetHitEvent && targetHitEvent.qty === 0;

      return isPartialExit && trackingIsTargetHit && hasTargetHitEvent && needsFix;
    });

    if (stocksToFix.length === 0) {
      console.log('[MIGRATION] No stocks need fixing. All TARGET_HIT stocks already have correct shares.');
      return;
    }

    console.log(`[MIGRATION] Found ${stocksToFix.length} stock(s) needing fix:\n`);

    for (const stock of stocksToFix) {
      const sim = stock.trade_simulation;
      const levels = stock.levels;
      const mainTarget = levels.target;

      // Current state
      const currentQtyRemaining = sim.qty_remaining;
      const currentRealizedPnl = sim.realized_pnl || 0;

      // Find T1_HIT event to get qty after T1
      const t1Event = sim.events?.find(e => e.type === 'T1_HIT');
      const qtyAfterT1 = t1Event ? (sim.qty_total - t1Event.qty) : sim.qty_remaining;

      // Calculate correct values (70% booked at Target, 30% kept)
      const exitQty = Math.floor(qtyAfterT1 * 0.7);
      const keepQty = qtyAfterT1 - exitQty;
      const exitPnl = (mainTarget - sim.entry_price) * exitQty;

      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  ${stock.symbol}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`  Entry: ₹${sim.entry_price?.toFixed(2)} | Target: ₹${mainTarget?.toFixed(2)}`);
      console.log(`  Qty Total: ${sim.qty_total} | After T1: ${qtyAfterT1}`);
      console.log(`  `);
      console.log(`  BEFORE:`);
      console.log(`    qty_remaining: ${currentQtyRemaining}`);
      console.log(`    realized_pnl: ₹${currentRealizedPnl.toFixed(0)}`);
      console.log(`  `);
      console.log(`  AFTER (70/30 rule):`);
      console.log(`    Book at Target: ${exitQty} shares (70%)`);
      console.log(`    Keep for T2: ${keepQty} shares (30%)`);
      console.log(`    Additional realized P&L: +₹${exitPnl.toFixed(0)}`);
      console.log(`    New qty_remaining: ${keepQty}`);
      console.log(`    New realized_pnl: ₹${(currentRealizedPnl + exitPnl).toFixed(0)}`);
      console.log(``);

      if (!dryRun) {
        // Update the stock
        sim.qty_remaining = keepQty;
        sim.qty_exited = (sim.qty_exited || 0) + exitQty;
        sim.realized_pnl = currentRealizedPnl + exitPnl;

        // Update TARGET_HIT event with correct qty and pnl
        const targetEvent = sim.events.find(e => e.type === 'TARGET_HIT');
        if (targetEvent) {
          targetEvent.qty = exitQty;
          targetEvent.pnl = Math.round(exitPnl);
          targetEvent.detail = `Target hit! Booked 70% (${exitQty} shares) at ₹${mainTarget.toFixed(2)} | Holding ${keepQty} shares for T2 (₹${levels.target2?.toFixed(2) || 'N/A'}) [MIGRATED]`;
        }

        console.log(`  ✅ Updated ${stock.symbol}`);
      } else {
        console.log(`  [DRY-RUN] Would update ${stock.symbol}`);
      }
    }

    if (!dryRun && stocksToFix.length > 0) {
      console.log('\n[MIGRATION] Saving changes to database...');
      await watchlist.save();
      console.log('[MIGRATION] ✅ Changes saved successfully!');
    }

    console.log('\n════════════════════════════════════════════════════════════');
    console.log(`SUMMARY: ${stocksToFix.length} stock(s) ${dryRun ? 'would be' : 'were'} fixed`);
    console.log('════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('[MIGRATION] Disconnected from MongoDB');
  }
}

main();
