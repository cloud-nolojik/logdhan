/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MIGRATION SCRIPT: Daily Tracking System v2 - Levels Migration
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This script migrates existing WeeklyWatchlist stocks to the v2 levels format:
 * 1. Adds target1, target1Basis (from engine calculation)
 * 2. Adds time rules: entryConfirmation, entryWindowDays, maxHoldDays, weekEndRule, etc.
 * 3. Re-runs trade simulation with new rules
 *
 * Usage:
 *   node backend/scripts/migrate-v2-levels.js [--dry-run]
 *
 * Options:
 *   --dry-run   Show what would be changed without actually saving
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup path resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import WeeklyWatchlist from '../src/models/weeklyWatchlist.js';
import { simulateTrade } from '../src/services/dailyTrackingService.js';

// ─────────────────────────────────────────────────────────────────────────────
// Inline functions from scanLevels.js (to avoid circular dependency issues)
// ─────────────────────────────────────────────────────────────────────────────

function isNum(v) {
  return typeof v === 'number' && !Number.isNaN(v) && Number.isFinite(v);
}

function roundToTick(price, tick = 0.05) {
  if (!isNum(price)) return 0;
  return Math.round(price / tick) * tick;
}

/**
 * Calculate partial profit booking level (target1)
 * Priority: weekly R1 -> daily R1 -> midpoint
 */
function calculatePartialBookingLevel(entry, target, data) {
  const { weeklyR1, dailyR1 } = data;
  const minLevel = entry * 1.02;   // At least 2% above entry
  const maxLevel = target * 0.95;  // At least 5% below main target

  // Weekly R1 - most common for momentum/breakout scans
  if (isNum(weeklyR1) && weeklyR1 > minLevel && weeklyR1 < maxLevel) {
    return { target1: roundToTick(weeklyR1), target1Basis: 'weekly_r1' };
  }

  // Daily R1 - fallback
  if (isNum(dailyR1) && dailyR1 > minLevel && dailyR1 < maxLevel) {
    return { target1: roundToTick(dailyR1), target1Basis: 'daily_r1' };
  }

  // Midpoint - always works
  const mid = entry + (target - entry) * 0.5;
  return { target1: roundToTick(mid), target1Basis: 'midpoint' };
}

/**
 * Get time-based trading rules for a scan type
 */
function getTimeRules(archetype, entryType) {
  // 52W Breakout - needs close confirmation, patient entry
  if (archetype === '52w_breakout') {
    return {
      entryConfirmation: 'close_above',
      entryWindowDays: 3,
      maxHoldDays: 5,
      weekEndRule: 'trail_or_exit',
      t1BookingPct: 50,
      postT1Stop: 'move_to_entry'
    };
  }

  // Momentum / Breakout - close confirmation, shorter entry window
  if (entryType === 'buy_above') {
    return {
      entryConfirmation: 'close_above',
      entryWindowDays: 2,
      maxHoldDays: 5,
      weekEndRule: 'exit_if_no_t1',
      t1BookingPct: 50,
      postT1Stop: 'move_to_entry'
    };
  }

  // Pullback - limit order fills on touch, more patient
  if (entryType === 'limit') {
    return {
      entryConfirmation: 'touch',
      entryWindowDays: 4,
      maxHoldDays: 5,
      weekEndRule: 'hold_if_above_entry',
      t1BookingPct: 50,
      postT1Stop: 'move_to_entry'
    };
  }

  // Default fallback
  return {
    entryConfirmation: 'close_above',
    entryWindowDays: 3,
    maxHoldDays: 5,
    weekEndRule: 'exit_if_no_t1',
    t1BookingPct: 50,
    postT1Stop: 'move_to_entry'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Migration Logic
// ─────────────────────────────────────────────────────────────────────────────

async function migrate(dryRun = false) {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Daily Tracking System v2 - Levels Migration');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Mode: ${dryRun ? 'DRY RUN (no changes will be saved)' : 'LIVE (changes will be saved)'}`);
  console.log('');

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not found in environment');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');
  console.log('');

  // Find all watchlists (current and historical)
  const watchlists = await WeeklyWatchlist.find({});
  console.log(`Found ${watchlists.length} watchlists to process`);
  console.log('');

  let totalStocks = 0;
  let migratedStocks = 0;
  let skippedStocks = 0;
  let errorStocks = 0;

  for (const watchlist of watchlists) {
    console.log(`─────────────────────────────────────────────────────────────────`);
    console.log(`Watchlist: ${watchlist.week_label} (${watchlist.stocks.length} stocks)`);

    let watchlistModified = false;

    for (const stock of watchlist.stocks) {
      totalStocks++;
      const symbol = stock.symbol;

      // Check if stock has existing levels
      const levels = stock.levels;
      if (!levels || !levels.entry || !levels.target) {
        console.log(`  [SKIP] ${symbol}: No levels object or missing entry/target`);
        skippedStocks++;
        continue;
      }

      // Check if already migrated (has target1)
      if (levels.target1 && levels.entryConfirmation) {
        console.log(`  [SKIP] ${symbol}: Already has v2 fields`);
        skippedStocks++;
        continue;
      }

      try {
        // Get pivot data from analysis_meta or enrichment_data
        const analysisMeta = stock.analysis_meta || {};
        const enrichment = analysisMeta.enrichment_data || {};
        const pivotData = {
          weeklyR1: enrichment.weeklyR1 || null,
          dailyR1: enrichment.dailyR1 || null
        };

        // Calculate target1
        const { target1, target1Basis } = calculatePartialBookingLevel(
          levels.entry,
          levels.target,
          pivotData
        );

        // Determine archetype from mode or scan_type
        const mode = levels.mode || analysisMeta.scan_type || 'momentum';
        let archetype = 'trend-follow';  // default
        if (mode.toLowerCase().includes('52w') || mode.toLowerCase().includes('a_plus')) {
          archetype = '52w_breakout';
        } else if (mode.toLowerCase().includes('pullback')) {
          archetype = 'pullback';
        } else if (mode.toLowerCase().includes('breakout') || mode.toLowerCase().includes('consolidation')) {
          archetype = 'breakout';
        }

        // Get time rules
        const entryType = levels.entryType || 'buy_above';
        const timeRules = getTimeRules(archetype, entryType);

        // Update levels
        levels.target1 = target1;
        levels.target1Basis = target1Basis;
        levels.entryConfirmation = timeRules.entryConfirmation;
        levels.entryWindowDays = timeRules.entryWindowDays;
        levels.maxHoldDays = timeRules.maxHoldDays;
        levels.weekEndRule = timeRules.weekEndRule;
        levels.t1BookingPct = timeRules.t1BookingPct;
        levels.postT1Stop = timeRules.postT1Stop;
        levels.archetype = archetype;

        console.log(`  [MIGRATE] ${symbol}:`);
        console.log(`            target1=${target1} (${target1Basis})`);
        console.log(`            entryConfirmation=${timeRules.entryConfirmation}, window=${timeRules.entryWindowDays}d`);
        console.log(`            weekEndRule=${timeRules.weekEndRule}`);

        // Re-run trade simulation if there are daily snapshots
        if (stock.daily_snapshots && stock.daily_snapshots.length > 0) {
          const snapshots = stock.daily_snapshots.map(s => ({
            date: s.date,
            open: s.open,
            high: s.high,
            low: s.low,
            close: s.close
          }));

          const lastSnapshot = snapshots[snapshots.length - 1];
          const livePrice = lastSnapshot.close;

          stock.trade_simulation = simulateTrade(stock, snapshots, livePrice);
          console.log(`            Re-simulated: status=${stock.trade_simulation?.status || 'N/A'}`);
        }

        watchlistModified = true;
        migratedStocks++;

      } catch (err) {
        console.log(`  [ERROR] ${symbol}: ${err.message}`);
        errorStocks++;
      }
    }

    // Save watchlist if modified and not dry run
    if (watchlistModified && !dryRun) {
      await watchlist.save();
      console.log(`  [SAVED] ${watchlist.week_label}`);
    } else if (watchlistModified && dryRun) {
      console.log(`  [DRY-RUN] Would save ${watchlist.week_label}`);
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Migration Summary');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Total stocks processed: ${totalStocks}`);
  console.log(`  Migrated:              ${migratedStocks}`);
  console.log(`  Skipped (already ok):  ${skippedStocks}`);
  console.log(`  Errors:                ${errorStocks}`);
  console.log('');

  if (dryRun) {
    console.log('  This was a DRY RUN. No changes were saved.');
    console.log('  Run without --dry-run to apply changes.');
  }

  await mongoose.disconnect();
  console.log('Disconnected from MongoDB');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Entry Point
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

migrate(dryRun).catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
