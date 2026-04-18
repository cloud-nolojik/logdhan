/**
 * testFullSequence.js — fire the whole 08:30 → 10:00 trading-day sequence
 * right now, back-to-back, no clock waits. For testing the complete flow.
 *
 *   Step 1: 08:30 daily-pick-scan          (shortlist + Step-0..6)
 *   Step 2: 09:08 preopen-depth-check      (Kite /quote, prune + promote)
 *   Step 3: 09:30 ORB Pass 1                (15-min ORB, validate + place entry)
 *   Step 4: 09:45 ORB Pass 2                (30-min ORB retry)
 *   Step 5: 10:00 ORB Pass 3                (45-min ORB final)
 *
 * WARNING — this runs the LIVE pipeline. That means:
 *   • It WILL write to DailyPick, ShortlistWatchlist, DailyPerformance.
 *   • It WILL call Upstox + Kite + ChartInk + NSE endpoints.
 *   • It WILL place real Kite orders UNLESS you set PAPER_TRADE=true.
 *
 * Usage:
 *   node src/scripts/testFullSequence.js                 # live, full pipeline
 *   PAPER_TRADE=true node src/scripts/testFullSequence.js   # dry-run, no kite orders
 *   node src/scripts/testFullSequence.js --yes           # skip the 5s confirmation pause
 *
 * Designed for weekend testing or dev verification. If you run this during
 * market hours (09:15–15:30 IST) and PAPER_TRADE is NOT set, you are placing
 * real orders.
 */

import '../loadEnv.js';
import mongoose from 'mongoose';
import { runTradingDaySequence } from '../services/jobs/tradingDaySequenceJob.js';

const LOG = '[TEST-SEQ]';

function istTime() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(11, 19);
}

async function main() {
  const skipConfirm = process.argv.includes('--yes');
  const allowOutdated = process.argv.includes('--allow-outdated');
  const isPaper = String(process.env.PAPER_TRADE || '').toLowerCase() === 'true';

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║  TRADING DAY SEQUENCE — FULL FLOW TEST                         ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log(`║  Mode:          ${isPaper ? 'PAPER_TRADE (no Kite orders)     ' : 'LIVE (WILL place Kite orders)   '}               ║`);
  console.log(`║  IST now:       ${istTime()}                                         ║`);
  console.log(`║  Allow outdated:${allowOutdated ? ' YES (accept yesterday\'s candle)' : ' NO (strict: today\'s candle required)'}        ║`);
  console.log(`║  Runs:          Step 1 → Step 2 → Step 3 → Step 4 → Step 5     ║`);
  console.log('║  Clock waits:   NONE (back-to-back)                            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');

  if (!isPaper && !skipConfirm) {
    console.log(`${LOG} ⚠️  LIVE mode. Starting in 5 s (Ctrl-C to abort, or pass --yes to skip)...`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // Connect to Mongo
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error(`${LOG} ❌ MONGODB_URI not set in env`);
    process.exit(1);
  }
  console.log(`${LOG} Connecting to Mongo...`);
  await mongoose.connect(uri);
  console.log(`${LOG} Connected`);

  const t0 = Date.now();
  let summary;
  try {
    summary = await runTradingDaySequence({
      skipWait: true,
      allowOutdatedCandle: allowOutdated,
    });
  } catch (err) {
    console.error(`${LOG} ❌ Sequence threw: ${err.message}`);
    console.error(err.stack || err);
  } finally {
    await mongoose.disconnect();
    console.log(`${LOG} Disconnected from Mongo`);
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`Test run complete in ${totalSec}s`);
  if (summary) {
    console.log(`all_ok:          ${summary.all_ok}`);
    console.log(`picks_generated: ${summary.picks_generated || 0}`);
    console.log(`halted:          ${summary.halted || false}${summary.halt_reason ? ` (${summary.halt_reason})` : ''}`);
    if (summary.warnings && summary.warnings.length) {
      console.log('Warnings:');
      summary.warnings.forEach(w => console.log(`  ⚠️  ${w}`));
    }
    console.log('Steps:');
    for (const s of summary.steps) {
      const mark = s.ok ? '✓' : '✗';
      console.log(`  ${mark}  ${s.name}  (${s.ms}ms)${s.error ? '  — ' + s.error : ''}`);
    }
  } else {
    console.log('(no summary — sequence aborted before completion)');
  }
  console.log('═══════════════════════════════════════════════');

  process.exit(summary?.all_ok ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
