/**
 * One-time migration script to calculate trade_simulation from existing snapshots
 *
 * Run this after deploying simulateTrade code to fix stocks where:
 * - 4PM job ran before simulateTrade was implemented
 * - Snapshots exist but trade_simulation is missing
 *
 * Usage: node scripts/migrate-trade-simulations.js
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
import { simulateTrade } from '../src/services/dailyTrackingService.js';
import { findHistoricalLevelCrossTime } from '../src/utils/stockDb.js';

async function migrateTradeSimulations() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  TRADE SIMULATION MIGRATION');
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

    // Find ALL active watchlists (there might be multiple)
    const watchlists = await WeeklyWatchlist.find({ status: 'ACTIVE' });

    if (!watchlists || watchlists.length === 0) {
      console.log('\n⚠️ No active watchlists found');
      return;
    }

    console.log(`\n📋 Found ${watchlists.length} active watchlist(s)`);

    for (const watchlist of watchlists) {
      console.log(`\n\n${'═'.repeat(65)}`);
      console.log(`  PROCESSING: ${watchlist.week_label}`);
      console.log(`  Stocks: ${watchlist.stocks.length}`);
      console.log('═'.repeat(65));

      let migratedCount = 0;
      let skippedCount = 0;

      for (const stock of watchlist.stocks) {
      console.log(`\n─────────────────────────────────────────────────────────────────`);
      console.log(`📊 ${stock.symbol}`);

      // Check if simulation already exists and is not WAITING
      if (stock.trade_simulation && stock.trade_simulation.status !== 'WAITING') {
        console.log(`   ⏭️ Skipping - simulation already exists (status: ${stock.trade_simulation.status})`);
        skippedCount++;
        continue;
      }

      // Check if snapshots exist
      if (!stock.daily_snapshots || stock.daily_snapshots.length === 0) {
        console.log(`   ⏭️ Skipping - no daily snapshots`);
        skippedCount++;
        continue;
      }

      // Check if levels exist
      if (!stock.levels?.entry || !stock.levels?.stop || !stock.levels?.target) {
        console.log(`   ⏭️ Skipping - missing levels`);
        skippedCount++;
        continue;
      }

      console.log(`   📈 Snapshots: ${stock.daily_snapshots.length}`);
      console.log(`   📍 Entry level: ₹${stock.levels.entry?.toFixed(2)}`);
      console.log(`   🛑 Stop: ₹${stock.levels.stop?.toFixed(2)}`);
      console.log(`   🎯 Target: ₹${stock.levels.target?.toFixed(2)}`);

      // Map snapshots
      const snapshots = stock.daily_snapshots.map(s => ({
        date: s.date,
        open: s.open,
        high: s.high,
        low: s.low,
        close: s.close
      }));

      // Log each snapshot
      snapshots.forEach((s, i) => {
        console.log(`   Snapshot ${i + 1}: ${new Date(s.date).toISOString().split('T')[0]} O=${s.open} H=${s.high} L=${s.low} C=${s.close}`);
      });

      // Get latest close as current price for unrealized P&L calculation
      const lastClose = snapshots[snapshots.length - 1].close;

      // Run simulation
      stock.trade_simulation = simulateTrade(stock, snapshots, lastClose);

      // If entry was triggered, find the exact crossing time using historical intraday API
      if (stock.trade_simulation.status !== 'WAITING' && stock.trade_simulation.entry_date) {
        const entryLevel = stock.levels.entryRange?.[0] || stock.levels.entry;
        const entryDate = stock.trade_simulation.entry_date;
        const entryDateStr = new Date(entryDate).toISOString().split('T')[0];

        console.log(`\n   🔍 Fetching exact crossing time from historical intraday API...`);
        console.log(`      Date: ${entryDateStr}, Entry Level: ₹${entryLevel}`);

        try {
          const crossResult = await findHistoricalLevelCrossTime(
            stock.instrument_key,
            entryLevel,
            'above',
            entryDate
          );

          if (crossResult) {
            console.log(`      ✅ Found exact crossing time: ${crossResult.crossTime.toISOString()}`);
            console.log(`      ✅ Crossing price: ₹${crossResult.crossPrice.toFixed(2)}`);

            // Update the entry_date with the exact crossing time
            stock.trade_simulation.entry_date = crossResult.crossTime;

            // Also update entry event if it exists
            if (stock.trade_simulation.events?.length > 0) {
              const entryEvent = stock.trade_simulation.events.find(e => e.type === 'ENTRY');
              if (entryEvent) {
                entryEvent.date = crossResult.crossTime;
              }
            }
          } else {
            console.log(`      ⚠️ Could not find exact crossing time (API returned no match)`);
          }
        } catch (apiError) {
          console.log(`      ⚠️ Error fetching intraday data: ${apiError.message}`);
        }
      }

      console.log(`\n   ✅ SIMULATION RESULT:`);
      console.log(`      Status: ${stock.trade_simulation.status}`);
      console.log(`      Entry Price: ${stock.trade_simulation.entry_price ? '₹' + stock.trade_simulation.entry_price.toFixed(2) : 'N/A'}`);
      console.log(`      Entry Date: ${stock.trade_simulation.entry_date ? new Date(stock.trade_simulation.entry_date).toISOString() : 'N/A'}`);
      console.log(`      Qty Total: ${stock.trade_simulation.qty_total}`);
      console.log(`      Qty Remaining: ${stock.trade_simulation.qty_remaining}`);
      console.log(`      Trailing Stop: ${stock.trade_simulation.trailing_stop ? '₹' + stock.trade_simulation.trailing_stop.toFixed(2) : 'N/A'}`);
      console.log(`      Realized P&L: ₹${stock.trade_simulation.realized_pnl?.toLocaleString('en-IN') || 0}`);
      console.log(`      Unrealized P&L: ₹${stock.trade_simulation.unrealized_pnl?.toLocaleString('en-IN') || 0}`);
      console.log(`      Total P&L: ₹${stock.trade_simulation.total_pnl?.toLocaleString('en-IN') || 0}`);
      console.log(`      Total Return: ${stock.trade_simulation.total_return_pct?.toFixed(2) || 0}%`);

      if (stock.trade_simulation.events?.length > 0) {
        console.log(`\n      Events:`);
        stock.trade_simulation.events.forEach((e, i) => {
          const dateStr = new Date(e.date).toISOString();
          console.log(`        ${i + 1}. ${e.type} at ₹${e.price?.toFixed(2)} on ${dateStr}`);
          console.log(`           ${e.detail}`);
        });
      }

        migratedCount++;
      }

      // Save this watchlist
      if (migratedCount > 0) {
        console.log('\n\n💾 Saving watchlist...');
        await watchlist.save();
        console.log('✅ Watchlist saved successfully');
      }

      console.log(`\n  Watchlist Summary: Migrated ${migratedCount}, Skipped ${skippedCount}`);
    } // End of watchlists loop

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  MIGRATION COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    throw error;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run migration
migrateTradeSimulations()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
