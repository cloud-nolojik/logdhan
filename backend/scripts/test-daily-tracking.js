#!/usr/bin/env node

/**
 * Test Daily Tracking Job
 *
 * This script tests the two-phase daily tracking flow:
 *
 * PHASE 1: Status Update (every stock, NO AI)
 *   - Fetches daily data via getDailyAnalysisData()
 *   - Calculates tracking_status and tracking_flags
 *   - Saves daily_snapshot to WeeklyWatchlist
 *
 * PHASE 2: AI Analysis (only if status changed)
 *   - Claude with weekend context
 *   - Saves to StockAnalysis (analysis_type: 'daily_track')
 *
 * Usage:
 *   node scripts/test-daily-tracking.js                      # Full test (Phase 1 + Phase 2)
 *   node scripts/test-daily-tracking.js --phase1-only        # Phase 1 only (no AI)
 *   node scripts/test-daily-tracking.js --stock MTARTECH     # Test specific stock
 *   node scripts/test-daily-tracking.js --dry-run            # No DB writes, just show what would happen
 *
 * Examples:
 *   node scripts/test-daily-tracking.js --stock MTARTECH --phase1-only
 *   node scripts/test-daily-tracking.js --dry-run
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Parse command line arguments
const args = process.argv.slice(2);
const PHASE1_ONLY = args.includes('--phase1-only');
const DRY_RUN = args.includes('--dry-run');
const STOCK_ARG = args.find(a => a.startsWith('--stock='));
const FILTER_STOCK = STOCK_ARG ? STOCK_ARG.split('=')[1] : null;

console.log('');
console.log('='.repeat(80));
console.log('  DAILY TRACKING JOB TEST');
console.log('='.repeat(80));
console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE'}`);
console.log(`  Phase 2 (AI): ${PHASE1_ONLY ? 'SKIPPED' : 'ENABLED'}`);
console.log(`  Filter Stock: ${FILTER_STOCK || 'None (all stocks in WeeklyWatchlist)'}`);
console.log('='.repeat(80));
console.log('');

async function runTest() {
  try {
    // Connect to MongoDB
    console.log('[TEST] Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('[TEST] Connected to MongoDB');

    // Import after DB connection
    const WeeklyWatchlist = (await import('../src/models/weeklyWatchlist.js')).default;
    const { getDailyAnalysisData } = await import('../src/services/technicalData.service.js');
    const {
      runDailyTracking,
      runPhase1,
      runPhase2,
      calculateStatus,
      calculateFlags,
      shouldTriggerPhase2
    } = await import('../src/services/dailyTrackingService.js');

    // Get current week's watchlist
    console.log('\n[TEST] Fetching current week watchlist...');
    const watchlist = await WeeklyWatchlist.getCurrentWeek();

    if (!watchlist || watchlist.stocks.length === 0) {
      console.log('[TEST] No active watchlist or no stocks found.');
      console.log('[TEST] Make sure weekend screening has run first.');
      return;
    }

    console.log(`[TEST] Found watchlist: ${watchlist.week_label}`);
    console.log(`[TEST] Total stocks: ${watchlist.stocks.length}`);

    // Filter to stocks with valid levels
    let validStocks = watchlist.stocks.filter(s => s.levels?.entry && s.levels?.stop && s.levels?.target);
    console.log(`[TEST] Stocks with valid levels: ${validStocks.length}`);

    // Filter by specific stock if requested
    if (FILTER_STOCK) {
      validStocks = validStocks.filter(s =>
        s.symbol.toUpperCase() === FILTER_STOCK.toUpperCase()
      );
      if (validStocks.length === 0) {
        console.log(`[TEST] Stock ${FILTER_STOCK} not found in watchlist.`);
        console.log('[TEST] Available stocks:', watchlist.stocks.map(s => s.symbol).join(', '));
        return;
      }
      console.log(`[TEST] Filtered to: ${validStocks[0].symbol}`);
    }

    // Show stocks to be processed
    console.log('\n[TEST] Stocks to process:');
    console.log('-'.repeat(80));
    validStocks.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.symbol.padEnd(15)} | Entry: ${s.levels.entry?.toFixed(2)} | Stop: ${s.levels.stop?.toFixed(2)} | Target: ${s.levels.target?.toFixed(2)} | Archetype: ${s.levels.archetype || 'standard'}`);
    });
    console.log('-'.repeat(80));

    // Fetch daily data for all stocks
    const symbols = validStocks.map(s => s.symbol);
    console.log(`\n[TEST] Fetching daily data for ${symbols.length} symbols...`);

    const dailyDataResponse = await getDailyAnalysisData(symbols);
    console.log(`[TEST] Daily data fetched. Nifty: ${dailyDataResponse.nifty_level} (${dailyDataResponse.nifty_change_pct > 0 ? '+' : ''}${dailyDataResponse.nifty_change_pct}%)`);

    // Create lookup map
    const dailyDataMap = new Map(dailyDataResponse.stocks.map(d => [d.symbol, d]));

    // Process each stock manually (to show detailed output)
    console.log('\n[TEST] Processing stocks...');
    console.log('='.repeat(80));

    const phase2Queue = [];

    for (const stock of validStocks) {
      const dailyData = dailyDataMap.get(stock.symbol);

      console.log(`\n[${stock.symbol}]`);
      console.log('-'.repeat(40));

      if (!dailyData || !dailyData.ltp || dailyData.ltp <= 0) {
        console.log(`  SKIP: No valid price data`);
        continue;
      }

      // Show daily data
      console.log(`  LTP: ${dailyData.ltp?.toFixed(2)} | Open: ${dailyData.open?.toFixed(2)} | High: ${dailyData.high?.toFixed(2)} | Low: ${dailyData.low?.toFixed(2)}`);
      console.log(`  RSI: ${dailyData.daily_rsi?.toFixed(1)} | Volume: ${dailyData.todays_volume?.toLocaleString()} (Avg: ${dailyData.avg_volume_50d?.toLocaleString()})`);

      // Show levels
      console.log(`  Entry: ${stock.levels.entry?.toFixed(2)} | Stop: ${stock.levels.stop?.toFixed(2)} | Target: ${stock.levels.target?.toFixed(2)}`);
      if (stock.levels.entryRange) {
        console.log(`  Entry Range: ${stock.levels.entryRange[0]?.toFixed(2)} - ${stock.levels.entryRange[1]?.toFixed(2)}`);
      }

      // Get previous state
      const oldStatus = stock.tracking_status || 'WATCHING';
      const oldFlags = stock.tracking_flags || [];
      const prevSnapshot = stock.daily_snapshots?.length > 0
        ? stock.daily_snapshots[stock.daily_snapshots.length - 1]
        : null;

      // Calculate new status and flags
      const newStatus = calculateStatus(dailyData, stock.levels, stock.symbol);
      const newFlags = calculateFlags(dailyData, stock.levels, stock.symbol);

      // Calculate distances
      const distFromEntry = ((dailyData.ltp - stock.levels.entry) / stock.levels.entry) * 100;
      const distFromStop = ((dailyData.ltp - stock.levels.stop) / stock.levels.stop) * 100;
      const distFromTarget = ((dailyData.ltp - stock.levels.target) / stock.levels.target) * 100;

      console.log(`  Distance from Entry: ${distFromEntry > 0 ? '+' : ''}${distFromEntry.toFixed(2)}%`);
      console.log(`  Distance from Stop: +${distFromStop.toFixed(2)}%`);
      console.log(`  Distance from Target: ${distFromTarget.toFixed(2)}%`);

      // Show status change
      const statusChanged = newStatus !== oldStatus;
      if (statusChanged) {
        console.log(`  STATUS: ${oldStatus} -> ${newStatus} [CHANGED]`);
      } else {
        console.log(`  STATUS: ${newStatus} (no change)`);
      }

      // Show flags
      if (newFlags.length > 0) {
        const brandNewFlags = newFlags.filter(f => !oldFlags.includes(f));
        console.log(`  FLAGS: ${newFlags.join(', ')}${brandNewFlags.length > 0 ? ` [NEW: ${brandNewFlags.join(', ')}]` : ''}`);
      }

      // Check Phase 2 trigger
      const { trigger, reason } = shouldTriggerPhase2(newStatus, oldStatus, newFlags, oldFlags);
      if (trigger) {
        console.log(`  PHASE 2 TRIGGER: ${reason}`);
        phase2Queue.push({
          stock,
          dailyData,
          triggerReason: reason,
          snapshot: {
            tracking_status: newStatus,
            tracking_flags: newFlags,
            nifty_change_pct: dailyDataResponse.nifty_change_pct
          }
        });
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('[TEST] PHASE 1 COMPLETE');
    console.log(`[TEST] Stocks processed: ${validStocks.length}`);
    console.log(`[TEST] Phase 2 queue: ${phase2Queue.length}`);

    if (phase2Queue.length > 0) {
      console.log('[TEST] Stocks queued for Phase 2:');
      phase2Queue.forEach(item => {
        console.log(`  - ${item.stock.symbol}: ${item.triggerReason}`);
      });
    }

    // Run Phase 2 if not skipped and not dry run
    if (!PHASE1_ONLY && !DRY_RUN && phase2Queue.length > 0) {
      console.log('\n' + '='.repeat(80));
      console.log('[TEST] RUNNING PHASE 2 (AI Analysis)...');
      console.log('='.repeat(80));

      const phase2Results = await runPhase2(phase2Queue);

      console.log('\n[TEST] PHASE 2 RESULTS:');
      phase2Results.forEach(result => {
        if (result.success) {
          console.log(`  ${result.symbol}: SUCCESS (${result.duration}ms)`);
          console.log(`    Status: ${result.status}`);
        } else {
          console.log(`  ${result.symbol}: FAILED - ${result.error}`);
        }
      });
    } else if (PHASE1_ONLY) {
      console.log('\n[TEST] Phase 2 skipped (--phase1-only flag)');
    } else if (DRY_RUN) {
      console.log('\n[TEST] Phase 2 skipped (--dry-run flag)');
    } else {
      console.log('\n[TEST] No stocks triggered Phase 2');
    }

    // If not dry run, save the Phase 1 results
    if (!DRY_RUN) {
      console.log('\n[TEST] Saving Phase 1 results to WeeklyWatchlist...');

      // Re-run Phase 1 through the service to actually save
      const { phase1Results } = await runPhase1();
      console.log(`[TEST] Saved ${phase1Results.length} stock updates`);
    }

    console.log('\n' + '='.repeat(80));
    console.log('[TEST] DAILY TRACKING TEST COMPLETE');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('\n[TEST] ERROR:', error);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n[TEST] MongoDB connection closed');
    process.exit(0);
  }
}

// Run the test
runTest();
