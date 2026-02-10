/**
 * Test Script: Run Weekend Screening for specific stocks
 *
 * This script calls the actual weekend screening job with filters:
 * - Only process specified stocks
 * - Skip ChartInk scan, use stock list directly
 * - Skip archiving previous week
 * - Optional: Filter candle data up to a reference date
 * - Optional: Specify scan type (default: auto-detect from existing watchlist or 'pullback')
 *
 * Usage:
 *   node backend/scripts/test-screening-mtartech.js ALKEM
 *   node backend/scripts/test-screening-mtartech.js ALKEM --date=2026-02-06
 *   node backend/scripts/test-screening-mtartech.js RELIANCE TATAPOWER --date=2026-01-30
 *   node backend/scripts/test-screening-mtartech.js MTARTECH --scan=a_plus_momentum
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import weekendScreeningJob from '../src/services/weeklyPicks/weekendScreeningJob.js';

// Parse command line args
const allArgs = process.argv.slice(2);
const dateArg = allArgs.find(arg => arg.startsWith('--date='));
const REFERENCE_DATE = dateArg ? dateArg.split('=')[1] : null;

const scanArg = allArgs.find(arg => arg.startsWith('--scan='));
const SCAN_TYPE = scanArg ? scanArg.split('=')[1] : null;

const symbolArgs = allArgs.filter(arg => !arg.startsWith('--'));
if (symbolArgs.length === 0) {
  console.error('Usage: node backend/scripts/test-screening-mtartech.js SYMBOL [--date=YYYY-MM-DD] [--scan=scan_type]');
  process.exit(1);
}
const SYMBOLS = symbolArgs.map(s => s.toUpperCase());

async function run() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  TEST: Weekend Screening');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Stocks: ${SYMBOLS.join(', ')}`);
  console.log(`  Mode: Skip ChartInk, use symbols directly`);
  if (REFERENCE_DATE) {
    console.log(`  Reference Date: ${REFERENCE_DATE} (candles filtered to this date)`);
  } else {
    console.log(`  Reference Date: None (using latest data)`);
  }
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

  try {
    // Run the screening job with filters
    const scanTypes = SCAN_TYPE ? [SCAN_TYPE] : ['pullback', 'breakout', 'momentum', 'consolidation_breakout', 'a_plus_momentum'];
    console.log(`  Scan Types: ${SCAN_TYPE || 'all (auto-detect)'}`);
    console.log('');

    const result = await weekendScreeningJob.runWeekendScreening({
      filterSymbols: SYMBOLS,
      skipArchive: true,
      skipChartink: true,  // Don't run ChartInk, use symbols directly
      scanTypes,
      referenceDate: REFERENCE_DATE  // Filter candles up to this date (null = use latest)
    });

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('  RESULT');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Stocks Added: ${result.totalStocksAdded}`);
    console.log(`  Stocks Updated: ${result.totalStocksUpdated || 0}`);
    console.log(`  Stocks Eliminated: ${result.totalStocksEliminated}`);
    console.log(`  Errors: ${result.errors?.length || 0}`);
    if (result.errors?.length > 0) {
      result.errors.forEach(e => console.log(`    - ${JSON.stringify(e)}`));
    }
    console.log('');

  } catch (error) {
    console.error('Test failed:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

run();
