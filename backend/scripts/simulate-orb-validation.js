#!/usr/bin/env node

/**
 * Simulate ORB Validation — runs the REAL validatePicks() with candle data
 *
 * Two modes:
 *   1. Auto mode (Kite):  node backend/scripts/simulate-orb-validation.js
 *   2. Manual mode (CLI):  node backend/scripts/simulate-orb-validation.js \
 *        --SYMBOL open,high,low,close --NIFTY open,high,low,close
 *
 * Manual mode bypasses Kite login — useful when Kite auth fails.
 * Candle data should be the 9:15-9:30 AM (15-min opening range) OHLC.
 *
 * What it does:
 *   1. Connects to MongoDB, loads today's DailyPick document
 *   2. Builds orbData from CLI args OR fetches from Kite API
 *   3. Calls the REAL validatePicks() from orbValidationService.js
 *   4. Prints pass/fail for each check per stock (does NOT modify DB)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

import DailyPick from '../src/models/dailyPick.js';
import { collectOpeningRange, validatePicks } from '../src/services/dailyPicks/orbValidationService.js';
import { round2 } from '../src/services/dailyPicks/dailyPicksHelpers.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI not set in .env');
  process.exit(1);
}

/**
 * Parse --SYMBOL open,high,low,close args from CLI
 */
function parseCLICandles() {
  const args = process.argv.slice(2);
  if (args.length === 0) return null; // no CLI args = auto mode

  const candles = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1]) {
      const symbol = args[i].replace('--', '').toUpperCase();
      const parts = args[i + 1].split(',').map(Number);

      if (parts.length !== 4 || parts.some(isNaN)) {
        console.error(`Invalid candle for ${symbol}: expected open,high,low,close — got "${args[i + 1]}"`);
        process.exit(1);
      }

      candles[symbol] = { open: parts[0], high: parts[1], low: parts[2], close: parts[3] };
      i++;
    }
  }

  return Object.keys(candles).length > 0 ? candles : null;
}

/**
 * Build orbData from CLI candles (same format as collectOpeningRange returns)
 */
function buildOrbDataFromCLI(candles, picks) {
  const orbData = {};

  for (const pick of picks) {
    const c = candles[pick.symbol];
    if (!c) continue;

    const prevClose = pick.levels.entry;
    const gapPct = prevClose ? round2(((c.open - prevClose) / prevClose) * 100) : 0;

    let orbDirection = 'NEUTRAL';
    if (c.close > c.open * 1.001) orbDirection = 'UP';
    else if (c.close < c.open * 0.999) orbDirection = 'DOWN';

    orbData[pick.symbol] = {
      high: round2(c.high),
      low: round2(c.low),
      opening_price: round2(c.open),
      gap_percent: gapPct,
      orb_direction: orbDirection
    };
  }

  // NIFTY
  const niftyCandle = candles['NIFTY'] || candles['NIFTY 50'] || candles['NIFTY50'];
  if (niftyCandle) {
    let niftyDir = 'NEUTRAL';
    if (niftyCandle.close > niftyCandle.open * 1.001) niftyDir = 'UP';
    else if (niftyCandle.close < niftyCandle.open * 0.999) niftyDir = 'DOWN';
    const niftyChangePct = niftyCandle.open > 0
      ? round2(((niftyCandle.close - niftyCandle.open) / niftyCandle.open) * 100)
      : 0;

    orbData['_NIFTY'] = {
      high: round2(niftyCandle.high),
      low: round2(niftyCandle.low),
      opening_price: round2(niftyCandle.open),
      orb_direction: niftyDir,
      nifty_change_pct: niftyChangePct
    };
  } else {
    // Default neutral NIFTY if not provided
    console.log('⚠️  No NIFTY candle provided — defaulting to NEUTRAL (0% change)');
    orbData['_NIFTY'] = {
      high: 0, low: 0, opening_price: 0,
      orb_direction: 'NEUTRAL',
      nifty_change_pct: 0
    };
  }

  return orbData;
}

function printUsage(picks) {
  console.log('\nUsage (manual mode — bypasses Kite):');
  console.log('  node backend/scripts/simulate-orb-validation.js \\');
  console.log('    --NIFTY open,high,low,close \\');
  for (const p of picks) {
    console.log(`    --${p.symbol} open,high,low,close \\`);
  }
}

async function main() {
  await mongoose.connect(MONGODB_URI);

  const doc = await DailyPick.findToday();
  if (!doc || doc.picks.length === 0) {
    console.log('No DailyPick document or no picks for today.');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`\nFound ${doc.picks.length} picks for today:`);
  console.log('────────────────────────────────────────');
  for (const p of doc.picks) {
    console.log(`  ${p.symbol} | ${p.direction} | ${p.scan_type} | entry=₹${p.levels.entry} stop=₹${p.levels.stop} target=₹${p.levels.target} | status=${p.trade.status}`);
  }

  const symbols = doc.picks.map(p => p.symbol);
  const cliCandles = parseCLICandles();
  let orbData;
  let dataSource;

  if (cliCandles) {
    // ── Manual mode: build orbData from CLI candles ──
    dataSource = 'CLI (manual)';

    // Check all pick symbols have candle data
    const missing = symbols.filter(s => !cliCandles[s]);
    if (missing.length > 0) {
      console.error(`\nMissing candle data for: ${missing.join(', ')}`);
      printUsage(doc.picks);
      await mongoose.disconnect();
      process.exit(1);
    }

    orbData = buildOrbDataFromCLI(cliCandles, doc.picks);

  } else {
    // ── Auto mode: fetch from Kite API ──
    dataSource = 'Kite API (live)';

    console.log('\n════════════════════════════════════════');
    console.log('Fetching OHLC via collectOpeningRange()...');
    console.log('════════════════════════════════════════\n');

    try {
      orbData = await collectOpeningRange(symbols, doc.picks);
    } catch (err) {
      console.error(`\ncollectOpeningRange() failed: ${err.message}`);
      console.log('\nFalling back to manual mode. Provide candle data as CLI args:');
      printUsage(doc.picks);
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  // ── Print OHLC data ──
  const fetchTimeIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  console.log(`\n⏰ Time: ${fetchTimeIST} IST | Data source: ${dataSource}`);

  console.log('\n────────────────────────────────────────');
  console.log('OHLC data used for validation:');
  console.log('────────────────────────────────────────');
  for (const [sym, data] of Object.entries(orbData)) {
    if (sym === '_NIFTY') {
      console.log(`  NIFTY 50  | O=${data.opening_price} H=${data.high} L=${data.low} | dir=${data.orb_direction} change=${data.nifty_change_pct}%`);
    } else {
      console.log(`  ${sym.padEnd(12)} | O=${data.opening_price} H=${data.high} L=${data.low} | gap=${data.gap_percent}% dir=${data.orb_direction}`);
    }
  }
  console.log('────────────────────────────────────────');

  // ── Deep-clone picks so we don't mutate the DB doc ──
  const pickClones = doc.picks.map(p => p.toObject());

  // Populate ORB on clones (same as startOrbCollection does on real picks)
  for (const pick of pickClones) {
    const orb = orbData[pick.symbol];
    if (orb) {
      pick.orb = {
        high: orb.high,
        low: orb.low,
        opening_price: orb.opening_price,
        gap_percent: orb.gap_percent,
        orb_direction: orb.orb_direction,
        nifty_orb_direction: orbData['_NIFTY']?.orb_direction || 'NEUTRAL',
        nifty_change_pct: orbData['_NIFTY']?.nifty_change_pct ?? 0
      };
    }
  }

  // ── Run the REAL validatePicks() ──
  console.log('\n════════════════════════════════════════');
  console.log('Running REAL validatePicks()...');
  console.log('════════════════════════════════════════\n');

  const regime = doc.market_context?.regime || 'STRONG_BULL';
  validatePicks(pickClones, orbData, regime);

  // ── Print results ──
  console.log('\n════════════════════════════════════════');
  console.log('RESULTS');
  console.log('════════════════════════════════════════\n');

  let passCount = 0;
  let failCount = 0;

  for (const pick of pickClones) {
    const v = pick.validation;
    const passed = v?.passed;
    if (passed) passCount++;
    else failCount++;

    console.log(`${passed ? '✅' : '❌'} ${pick.symbol} (${pick.direction} ${pick.scan_type}) — ${passed ? 'PASSED' : 'FAILED'}`);

    if (v?.checks) {
      const checks = v.checks;

      const gc = checks.gap_check;
      console.log(`   ${gc?.passed ? '✓' : '✗'} Gap size: ${gc?.value}% (limit: ±1.5%)`);

      const gd = checks.gap_direction;
      console.log(`   ${gd?.passed ? '✓' : '✗'} Gap direction: ${gd?.value}% vs ${gd?.direction} bias`);

      const oa = checks.orb_alignment;
      console.log(`   ${oa?.passed ? '✓' : '✗'} ORB R:R: ${oa?.new_rr}:1 (min: ${oa?.min_rr}:1) | ORB entry=₹${oa?.new_entry} | ORB H=${oa?.orb_high} L=${oa?.orb_low}`);

      const na = checks.nifty_alignment;
      console.log(`   ${na?.passed ? '✓' : '✗'} Nifty: ${na?.nifty_dir} (${na?.nifty_change_pct}%) vs ${pick.direction} (threshold: ±${na?.threshold}%)`);

      const ev = checks.entry_still_valid;
      console.log(`   ${ev?.passed ? '✓' : '✗'} ORB range: ${ev?.orb_range_pct}% (max: ${ev?.max_allowed}%)`);

      const vc = checks.volume_check;
      console.log(`   ${vc?.passed ? '✓' : '✗'} Volume: auto-pass`);
    }

    if (v?.skip_reason) {
      console.log(`   Skip reason: ${v.skip_reason}`);
    }

    console.log('');
  }

  console.log('════════════════════════════════════════');
  console.log(`Summary: ${passCount} passed, ${failCount} failed out of ${pickClones.length} picks`);
  console.log('════════════════════════════════════════');
  console.log('\n(DB not modified — this was a simulation)');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Error:', err.message);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
