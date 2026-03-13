/**
 * Simulate ORB validation for SUDARSCHEM using real OHLC + volume data.
 *
 * Loads today's SUDARSCHEM pick from MongoDB, then runs validatePicks()
 * with the provided Kite OHLC and Upstox volume data — no API calls.
 *
 * Usage: node src/scripts/simulateOrbSudarschem.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

import DailyPick from '../models/dailyPick.js';
import { validatePicks, computeVolumeRatio } from '../services/dailyPicks/orbValidationService.js';

// ─── Mock OHLC data from Kite (provided by user) ────────────────────────────
// At 9:30 AM, the day's OHLC = first 15-min candle (9:15–9:30)
const MOCK_OHLC = {
  SUDARSCHEM: {
    high: 848.4,
    low: 828.25,
    opening_price: 848.4,
    ltp: 832.35,
    gap_percent: 0,   // will be computed below from pick's prev close (entry)
    orb_direction: 'DOWN',  // close(832.35) < open(848.4) * 0.999 → DOWN
  },
  _NIFTY: {
    high: 23487.9,
    low: 23415.25,
    opening_price: 23462.5,
    orb_direction: 'NEUTRAL', // close ≈ open → neutral (LTP 23469.5 vs O 23462.5)
    nifty_change_pct: ((23469.5 - 23462.5) / 23462.5 * 100),  // +0.03%
  },
};

// ─── Mock volume data from Upstox 15-min candles (provided by user) ──────────
// At 9:30 AM (Pass 1), only the first candle exists: 9:15 candle
const UPSTOX_CANDLES = [
  // [timestamp, open, high, low, close, volume, oi]
  ["2026-03-13T09:15:00+05:30", 848.4, 848.4, 828.25, 832.35, 2936, 0],
  ["2026-03-13T09:30:00+05:30", 830.9, 832.95, 828.35, 829.0, 5852, 0],
  ["2026-03-13T09:45:00+05:30", 828.1, 828.1, 820.45, 820.45, 2351, 0],
];

function printResult(pick, orbPass) {
  const v = pick.validation;
  const status = v.passed ? 'ALL PASSED' : `FAILED: ${v.skip_reason}`;
  console.log(`\n  >> ${pick.symbol} ${pick.direction}: ${status}`);
  for (const [name, check] of Object.entries(v.checks)) {
    const icon = check.passed ? 'PASS' : 'FAIL';
    console.log(`     [${icon}] ${name}: ${JSON.stringify(check)}`);
  }
}

async function simulate() {
  console.log('\n' + '='.repeat(80));
  console.log('  SUDARSCHEM ORB SIMULATION — Using Real OHLC + Volume Data');
  console.log('='.repeat(80));

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  const doc = await DailyPick.findToday();
  if (!doc) {
    console.log('No DailyPick document for today');
    await mongoose.connection.close();
    return;
  }

  const pick = doc.picks.find(p => p.symbol === 'SUDARSCHEM');
  if (!pick) {
    console.log('SUDARSCHEM not found in today\'s picks');
    console.log('Available symbols:', doc.picks.map(p => p.symbol).join(', '));
    await mongoose.connection.close();
    return;
  }

  // Fix missing avg_volume_50d (calculated from 50 daily candles)
  if (!pick._ohlcv) pick._ohlcv = {};
  if (!pick._ohlcv.avg_volume_50d) pick._ohlcv.avg_volume_50d = 71157;

  // Compute gap percent from pick's entry (prev close)
  const prevClose = pick.levels.entry;
  const gapPct = prevClose ? Math.round(((848.4 - prevClose) / prevClose) * 100 * 100) / 100 : 0;
  MOCK_OHLC.SUDARSCHEM.gap_percent = gapPct;

  console.log('\n--- Pick Details ---');
  console.log(`  Symbol:     ${pick.symbol}`);
  console.log(`  Direction:  ${pick.direction}`);
  console.log(`  Scan Type:  ${pick.scan_type}`);
  console.log(`  Entry:      ${pick.levels.entry}`);
  console.log(`  Stop:       ${pick.levels.stop}`);
  console.log(`  Target:     ${pick.levels.target}`);
  console.log(`  R:R:        ${pick.levels.risk_reward}`);
  console.log(`  Status:     ${pick.trade.status}`);
  console.log(`  Regime:     ${pick.regime_aligned}`);
  console.log(`  AvgVol50d:  ${pick._ohlcv?.avg_volume_50d}`);

  console.log('\n--- ORB Data (Kite OHLC) ---');
  console.log(`  SUDARSCHEM: O=${MOCK_OHLC.SUDARSCHEM.opening_price} H=${MOCK_OHLC.SUDARSCHEM.high} L=${MOCK_OHLC.SUDARSCHEM.low} LTP=${MOCK_OHLC.SUDARSCHEM.ltp} Gap=${gapPct}%`);
  console.log(`  NIFTY:      O=${MOCK_OHLC._NIFTY.opening_price} change=${MOCK_OHLC._NIFTY.nifty_change_pct.toFixed(2)}%`);

  // Determine regime from doc's market_context
  const regime = doc.market_context?.regime || 'NEUTRAL';
  console.log(`  Regime:     ${regime}`);

  const avgVol50d = pick._ohlcv?.avg_volume_50d || 0;

  // ─── Pass 1: 9:30 AM (15-min ORB) ─────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('  PASS 1 — 9:30 AM (15-min ORB)');
  console.log('='.repeat(80));

  const pick1 = JSON.parse(JSON.stringify(pick));  // deep clone
  const volMap1 = { SUDARSCHEM: computeVolumeRatio(UPSTOX_CANDLES.slice(0, 1).reduce((s, c) => s + c[5], 0), 1, avgVol50d) };
  console.log(`  Volume: ${JSON.stringify(volMap1.SUDARSCHEM)}`);

  const [result1] = validatePicks([pick1], MOCK_OHLC, regime, 1, volMap1);
  printResult(result1, 1);

  // ─── Pass 2: 9:46 AM (30-min ORB) ─────────────────────────────────────────
  // At 9:46, the day's OHLC would include 9:15 + 9:30 candles
  console.log('\n' + '='.repeat(80));
  console.log('  PASS 2 — 9:46 AM (30-min ORB)');
  console.log('='.repeat(80));

  // Widen ORB range to include 9:30 candle data
  const orbPass2 = {
    ...MOCK_OHLC,
    SUDARSCHEM: {
      ...MOCK_OHLC.SUDARSCHEM,
      high: Math.max(848.4, 832.95),   // max of 9:15 H and 9:30 H
      low: Math.min(828.25, 828.35),    // min of 9:15 L and 9:30 L
      ltp: 829.0,                        // 9:30 close as proxy LTP
    },
  };

  const pick2 = JSON.parse(JSON.stringify(pick));
  const volMap2 = { SUDARSCHEM: computeVolumeRatio(UPSTOX_CANDLES.slice(0, 2).reduce((s, c) => s + c[5], 0), 2, avgVol50d) };
  console.log(`  Volume: ${JSON.stringify(volMap2.SUDARSCHEM)}`);
  console.log(`  ORB range: H=${orbPass2.SUDARSCHEM.high} L=${orbPass2.SUDARSCHEM.low}`);

  const [result2] = validatePicks([pick2], orbPass2, regime, 2, volMap2);
  printResult(result2, 2);

  // ─── Pass 3: 10:01 AM (45-min ORB, FINAL) ─────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('  PASS 3 — 10:01 AM (45-min ORB, FINAL)');
  console.log('='.repeat(80));

  // Widen to include 9:45 candle
  const orbPass3 = {
    ...MOCK_OHLC,
    SUDARSCHEM: {
      ...MOCK_OHLC.SUDARSCHEM,
      high: Math.max(848.4, 832.95, 828.1),
      low: Math.min(828.25, 828.35, 820.45),
      ltp: 820.45,
    },
  };

  const pick3 = JSON.parse(JSON.stringify(pick));
  const volMap3 = { SUDARSCHEM: computeVolumeRatio(UPSTOX_CANDLES.slice(0, 3).reduce((s, c) => s + c[5], 0), 3, avgVol50d) };
  console.log(`  Volume: ${JSON.stringify(volMap3.SUDARSCHEM)}`);
  console.log(`  ORB range: H=${orbPass3.SUDARSCHEM.high} L=${orbPass3.SUDARSCHEM.low}`);

  const [result3] = validatePicks([pick3], orbPass3, regime, 3, volMap3);
  printResult(result3, 3);

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(80));
  console.log('  SUMMARY');
  console.log('='.repeat(80));
  console.log(`  Pass 1 (9:30):  ${result1.validation.passed ? 'PASSED' : 'FAILED — ' + result1.validation.skip_reason}`);
  console.log(`  Pass 2 (9:46):  ${result2.validation.passed ? 'PASSED' : 'FAILED — ' + result2.validation.skip_reason}`);
  console.log(`  Pass 3 (10:01): ${result3.validation.passed ? 'PASSED' : 'FAILED — ' + result3.validation.skip_reason}`);

  if (result1.validation.passed) {
    const orbEntry = result1.validation.checks.orb_alignment?.new_entry;
    console.log(`\n  ORB Entry: ${orbEntry}`);
    console.log(`  New R:R:   ${result1.validation.checks.orb_alignment?.new_rr}`);
  }

  console.log('='.repeat(80) + '\n');

  await mongoose.connection.close();
}

simulate().catch(err => {
  console.error('Simulation failed:', err);
  mongoose.connection.close();
  process.exit(1);
});
