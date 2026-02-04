/**
 * Test Script - Triggers intraday monitor job
 *
 * Usage:
 *   node src/tests/test-intraday-monitor.js [--dry-run] [--symbol SYMBOL]
 *
 * Options:
 *   --dry-run    Don't save to DB or send notifications
 *   --symbol     Test specific symbol only
 *
 * Price file: intraday_15mins_test.json (15-min candle format)
 *   Format: { data: { candles: [[ts, o, h, l, c, v], ...] } }
 *   - Uses candle HIGH for T1/T2 checks (catches intraday spikes)
 *   - Uses candle LOW for stop checks (catches intraday dips)
 *   - Uses candle CLOSE for current price display
 *
 * In production: Uses real-time Upstox intraday candle API
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import intradayMonitorJob from '../services/jobs/intradayMonitorJob.js';

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const symbolIdx = args.indexOf('--symbol');
const symbol = symbolIdx !== -1 ? args[symbolIdx + 1] : null;

// Price file path - 15-min candle format (uses H/L/C for proper intraday detection)
const priceFile = path.resolve(__dirname, '../../intraday_15mins_test.json');

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║       INTRADAY MONITOR JOB - TEST TRIGGER                  ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log(`║  Dry-run: ${dryRun ? 'YES' : 'NO'}                                              ║`);
  console.log(`║  Symbol:  ${symbol || 'ALL'}                                              ║`.slice(0, 65) + '║');
  console.log(`║  Price:   ${priceFile.split('/').pop()}                       ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  try {
    // Connect to MongoDB
    console.log('[TEST] Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('[TEST] Connected\n');

    // Run the job directly (not via Agenda)
    const result = await intradayMonitorJob.runMonitoring({
      dryRun,
      priceFile,
      symbol
    });

    // Summary
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('RESULT');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`  Stocks checked: ${result.stocksChecked}`);
    console.log(`  Alerts: ${result.alerts.length}`);
    console.log(`  Dry-run: ${result.dryRun ? 'YES' : 'NO'}`);

    if (result.alerts.length > 0) {
      console.log('\n  Alerts triggered:');
      result.alerts.forEach(a => {
        console.log(`    • ${a.symbol}: ${a.type} at ₹${a.price?.toFixed(2)}`);
      });
    }

    console.log('\n✅ Done\n');

  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
