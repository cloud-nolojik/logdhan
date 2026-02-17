/**
 * ORB (Opening Range Breakout) Validation Service
 *
 * 1. collectOpeningRange() — Called at 9:30 AM: Single OHLC call to get the 15-min opening range
 * 2. validatePicks()       — 9:30 AM: Check 5 validation conditions per pick before entry
 *
 * Uses Kite Connect API getOHLC() — at 9:30 the day's OHLC IS the 15-min opening candle.
 */

import kiteOrderService from '../kiteOrder.service.js';
import { round2 } from './dailyPicksHelpers.js';

const LOG = '[ORB]';

/**
 * Collect Opening Range data by fetching OHLC at 9:30 AM.
 *
 * At 9:30 AM, the day's OHLC represents the first 15-minute candle (9:15-9:30).
 * Single API call instead of 112 polls.
 *
 * @param {string[]} symbols — Trading symbols (e.g. ['RELIANCE', 'TCS'])
 * @param {Object} picks — Array of pick objects (for prev close to calculate gap)
 * @returns {Object} — { 'RELIANCE': { high, low, opening_price, gap_percent, orb_direction }, ..., '_NIFTY': { ... } }
 */
async function collectOpeningRange(symbols, picks) {
  console.log(`${LOG} Fetching opening range OHLC for ${symbols.length} symbols + NIFTY`);

  // Build Kite instrument list: NSE:SYMBOL format
  const instruments = symbols.map(s => `NSE:${s}`);
  instruments.push('NSE:NIFTY 50');

  console.log(`${LOG} Instruments: ${instruments.join(', ')}`);

  // Single OHLC call — at 9:30 AM, day OHLC = 15-min opening range
  const ohlcData = await kiteOrderService.getOHLC(instruments);

  // Prev close map for gap calculation
  const prevCloseMap = {};
  for (const pick of picks) {
    prevCloseMap[pick.symbol] = pick.levels.entry;
  }

  // Build result map from OHLC data
  const resultMap = {};

  for (const sym of symbols) {
    const key = `NSE:${sym}`;
    const data = ohlcData[key];

    if (!data?.ohlc) {
      console.warn(`${LOG} ${sym}: No OHLC data — skipping`);
      continue;
    }

    const { open, high, low, close } = data.ohlc;
    const ltp = data.last_price;

    const prevClose = prevCloseMap[sym];
    const gapPct = prevClose ? round2(((open - prevClose) / prevClose) * 100) : 0;

    // ORB direction: close of 15-min candle vs open
    let orbDirection = 'NEUTRAL';
    if (close > open * 1.001) orbDirection = 'UP';
    else if (close < open * 0.999) orbDirection = 'DOWN';

    resultMap[sym] = {
      high: round2(high),
      low: round2(low),
      opening_price: round2(open),
      gap_percent: gapPct,
      orb_direction: orbDirection
    };

    console.log(`${LOG} ${sym}: O=${open} H=${high} L=${low} C=${close} LTP=${ltp} gap=${gapPct}% dir=${orbDirection}`);
  }

  // NIFTY ORB
  const niftyData = ohlcData['NSE:NIFTY 50'];
  if (niftyData?.ohlc) {
    const { open, high, low, close } = niftyData.ohlc;

    let niftyDir = 'NEUTRAL';
    if (close > open * 1.001) niftyDir = 'UP';
    else if (close < open * 0.999) niftyDir = 'DOWN';

    resultMap['_NIFTY'] = {
      high: round2(high),
      low: round2(low),
      opening_price: round2(open),
      orb_direction: niftyDir
    };

    console.log(`${LOG} NIFTY: O=${open} H=${high} L=${low} C=${close} dir=${niftyDir}`);
  }

  console.log(`${LOG} ORB data collected for ${Object.keys(resultMap).filter(k => k !== '_NIFTY').length} symbols`);
  return resultMap;
}

/**
 * Validate picks against ORB data. Called at 9:30 AM after OHLC fetch.
 *
 * 5 checks per pick:
 * 1. Gap check       — abs(gap_percent) < 1.5%
 * 2. ORB alignment   — Bullish scan → UP ORB, bearish → DOWN ORB
 * 3. Nifty alignment — Nifty ORB doesn't oppose scan bias
 * 4. Entry still valid — Entry price within 1% of pre-calculated level
 * 5. Volume check    — Auto-pass (OHLC doesn't provide volume)
 *
 * @param {Array} picks — Array of pick sub-documents from DailyPick
 * @param {Object} orbData — Output from collectOpeningRange()
 * @returns {Array} — Same picks array with orb + validation fields populated
 */
function validatePicks(picks, orbData) {
  const niftyOrb = orbData['_NIFTY'];
  const niftyDir = niftyOrb?.orb_direction || 'NEUTRAL';

  console.log(`${LOG} Validating ${picks.length} picks (NIFTY dir: ${niftyDir})`);

  for (const pick of picks) {
    const orb = orbData[pick.symbol];
    if (!orb) {
      pick.validation = {
        passed: false,
        checks: {},
        skip_reason: 'no_orb_data'
      };
      console.log(`${LOG} ${pick.symbol}: SKIP — no ORB data`);
      continue;
    }

    // Populate ORB data on the pick
    pick.orb = {
      high: orb.high,
      low: orb.low,
      opening_price: orb.opening_price,
      gap_percent: orb.gap_percent,
      orb_direction: orb.orb_direction,
      nifty_orb_direction: niftyDir
    };

    const isBullish = pick.direction === 'LONG';
    const checks = {};

    // Check 1: Gap < 1.5%
    checks.gap_check = {
      passed: Math.abs(orb.gap_percent) < 1.5,
      value: orb.gap_percent
    };

    // Check 2: ORB direction alignment
    const expectedDir = isBullish ? 'UP' : 'DOWN';
    checks.orb_alignment = {
      passed: orb.orb_direction === expectedDir || orb.orb_direction === 'NEUTRAL',
      scan_bias: pick.direction,
      orb_dir: orb.orb_direction
    };

    // Check 3: Nifty alignment (doesn't oppose)
    const niftyOpposes = (isBullish && niftyDir === 'DOWN') || (!isBullish && niftyDir === 'UP');
    checks.nifty_alignment = {
      passed: !niftyOpposes,
      nifty_dir: niftyDir
    };

    // Check 4: Entry still valid — current price within 1% of pre-calculated entry
    const currentPrice = orb.opening_price;
    const distPct = pick.levels.entry
      ? round2(Math.abs((currentPrice - pick.levels.entry) / pick.levels.entry) * 100)
      : 0;
    checks.entry_still_valid = {
      passed: distPct < 1.0,
      distance_percent: distPct
    };

    // Check 5: Volume — auto-pass (OHLC doesn't provide volume data)
    checks.volume_check = {
      passed: true,
      ratio: null
    };

    // Determine overall pass/fail
    const allPassed = Object.values(checks).every(c => c.passed);
    let levelsRecalculated = false;
    let originalLevels = null;

    // Gap recalculation: if gap > 1.5% but ORB direction aligns, try recalculating
    if (!checks.gap_check.passed && checks.orb_alignment.passed) {
      originalLevels = {
        entry: pick.levels.entry,
        stop: pick.levels.stop,
        target: pick.levels.target
      };

      const newEntry = isBullish ? orb.high : orb.low;
      const newStop = isBullish ? orb.low : orb.high;
      const newTarget = round2(newEntry * (isBullish ? 1.02 : 0.98));
      const newRiskPct = round2(Math.abs((newEntry - newStop) / newEntry) * 100);
      const newRR = newRiskPct > 0 ? round2(2.0 / newRiskPct) : 0;

      if (newRiskPct <= 4.0 && newRR >= 1.2) {
        pick.levels.entry = round2(newEntry);
        pick.levels.stop = round2(newStop);
        pick.levels.target = newTarget;
        pick.levels.risk_pct = newRiskPct;
        pick.levels.risk_reward = newRR;
        levelsRecalculated = true;

        checks.gap_check.passed = true;
        checks.entry_still_valid.passed = true;
        checks.entry_still_valid.distance_percent = 0;

        console.log(`${LOG} ${pick.symbol}: Levels recalculated — entry=${newEntry} stop=${newStop} target=${newTarget} risk=${newRiskPct}% RR=${newRR}`);
      } else {
        console.log(`${LOG} ${pick.symbol}: Gap recalc rejected — risk=${newRiskPct}% RR=${newRR} (limits: risk<=4%, RR>=1.2)`);
      }
    }

    const finalPassed = Object.values(checks).every(c => c.passed);
    const skipReason = finalPassed ? null : Object.entries(checks)
      .filter(([, c]) => !c.passed)
      .map(([k]) => k)
      .join(', ');

    pick.validation = {
      passed: finalPassed,
      checks,
      skip_reason: skipReason,
      levels_recalculated: levelsRecalculated,
      original_levels: originalLevels
    };

    console.log(`${LOG} ${pick.symbol}: ${finalPassed ? 'PASSED' : 'FAILED'} — gap=${checks.gap_check.passed ? 'OK' : 'FAIL'}(${orb.gap_percent}%) orb=${checks.orb_alignment.passed ? 'OK' : 'FAIL'}(${orb.orb_direction}) nifty=${checks.nifty_alignment.passed ? 'OK' : 'FAIL'}(${niftyDir}) entry=${checks.entry_still_valid.passed ? 'OK' : 'FAIL'}(${distPct}%) vol=AUTO${levelsRecalculated ? ' [RECALCULATED]' : ''}`);
    if (!finalPassed) console.log(`${LOG} ${pick.symbol}: skip_reason=${skipReason}`);
  }

  return picks;
}

export { collectOpeningRange, validatePicks };

export default { collectOpeningRange, validatePicks };
