/**
 * ORB (Opening Range Breakout) Validation Service
 *
 * 1. collectOpeningRange() — 9:15-9:30 AM: Poll LTP every 8s to build 15-min opening range
 * 2. validatePicks()       — 9:30 AM: Check 5 validation conditions per pick before entry
 *
 * Uses Kite Connect API getLTP() for price data.
 */

import kiteOrderService from '../kiteOrder.service.js';
import { round2 } from './dailyPicksHelpers.js';

const LOG = '[ORB]';
const POLL_INTERVAL_MS = 8000;   // 8 seconds between LTP polls
const COLLECTION_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Collect Opening Range data for given symbols during 9:15-9:30 AM.
 *
 * Polls Kite LTP API every 8 seconds, tracking high/low/open for each symbol + NIFTY.
 * Returns ORB data map keyed by symbol.
 *
 * @param {string[]} symbols — Trading symbols (e.g. ['RELIANCE', 'TCS'])
 * @param {Object} picks — Array of pick objects (for prev close to calculate gap)
 * @returns {Object} — { 'RELIANCE': { high, low, opening_price, gap_percent, orb_direction }, ..., '_NIFTY': { ... } }
 */
async function collectOpeningRange(symbols, picks) {
  console.log(`${LOG} Starting ORB collection for ${symbols.length} symbols + NIFTY`);

  // Build Kite instrument list: NSE:SYMBOL format
  const instruments = symbols.map(s => `NSE:${s}`);
  instruments.push('NSE:NIFTY 50');

  console.log(`${LOG} Kite instruments to poll: ${instruments.join(', ')}`);
  console.log(`${LOG} Poll interval: ${POLL_INTERVAL_MS}ms, Duration: ${COLLECTION_DURATION_MS / 1000}s`);

  // Prev close map for gap calculation
  const prevCloseMap = {};
  for (const pick of picks) {
    prevCloseMap[pick.symbol] = pick.levels.entry;
  }

  // Tracking state per symbol
  const orbData = {};
  for (const sym of [...symbols, '_NIFTY']) {
    orbData[sym] = {
      high: -Infinity,
      low: Infinity,
      opening_price: null,
      first_price: null,
      last_price: null
    };
  }

  const startTime = Date.now();
  let pollCount = 0;

  while (Date.now() - startTime < COLLECTION_DURATION_MS) {
    try {
      console.log(`${LOG} Poll #${pollCount + 1}: calling kiteOrderService.getLTP()...`);
      const ltpData = await kiteOrderService.getLTP(instruments);
      pollCount++;

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const prices = [];

      // Process each instrument's LTP
      for (const sym of symbols) {
        const key = `NSE:${sym}`;
        const ltp = ltpData[key]?.last_price;
        if (!ltp) {
          prices.push(`${sym}=N/A`);
          continue;
        }

        const d = orbData[sym];
        if (d.opening_price === null) d.opening_price = ltp;
        if (ltp > d.high) d.high = ltp;
        if (ltp < d.low) d.low = ltp;
        d.last_price = ltp;
        prices.push(`${sym}=${ltp}`);
      }

      // NIFTY
      const niftyLtp = ltpData['NSE:NIFTY 50']?.last_price;
      if (niftyLtp) {
        const nd = orbData['_NIFTY'];
        if (nd.opening_price === null) nd.opening_price = niftyLtp;
        if (niftyLtp > nd.high) nd.high = niftyLtp;
        if (niftyLtp < nd.low) nd.low = niftyLtp;
        nd.last_price = niftyLtp;
        prices.push(`NIFTY=${niftyLtp}`);
      }

      // Log every 5th poll to avoid spam, plus first and last
      if (pollCount === 1 || pollCount % 5 === 0 || Date.now() - startTime + POLL_INTERVAL_MS >= COLLECTION_DURATION_MS) {
        console.log(`${LOG} Poll #${pollCount} (${elapsed}s): ${prices.join(', ')}`);
      }

    } catch (err) {
      pollCount++;
      console.error(`${LOG} LTP poll #${pollCount} FAILED: ${err.message}`);
    }

    // Wait before next poll (unless collection period ended)
    if (Date.now() - startTime + POLL_INTERVAL_MS < COLLECTION_DURATION_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    } else {
      break;
    }
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  console.log(`${LOG} ORB collection done — ${pollCount} polls in ${totalDuration}s`);

  // Calculate derived fields
  const resultMap = {};
  for (const sym of symbols) {
    const d = orbData[sym];
    if (d.opening_price === null) {
      console.warn(`${LOG} ${sym}: No price data collected — skipping`);
      continue;
    }

    const prevClose = prevCloseMap[sym];
    const gapPct = prevClose ? round2(((d.opening_price - prevClose) / prevClose) * 100) : 0;

    // ORB direction: close of 15-min candle vs open
    let orbDirection = 'NEUTRAL';
    if (d.last_price > d.opening_price * 1.001) orbDirection = 'UP';
    else if (d.last_price < d.opening_price * 0.999) orbDirection = 'DOWN';

    resultMap[sym] = {
      high: round2(d.high),
      low: round2(d.low),
      opening_price: round2(d.opening_price),
      gap_percent: gapPct,
      orb_direction: orbDirection
    };

    console.log(`${LOG} ${sym}: ORB H=${d.high} L=${d.low} O=${d.opening_price} gap=${gapPct}% dir=${orbDirection}`);
  }

  // NIFTY ORB
  const nd = orbData['_NIFTY'];
  if (nd.opening_price !== null) {
    let niftyDir = 'NEUTRAL';
    if (nd.last_price > nd.opening_price * 1.001) niftyDir = 'UP';
    else if (nd.last_price < nd.opening_price * 0.999) niftyDir = 'DOWN';

    resultMap['_NIFTY'] = {
      high: round2(nd.high),
      low: round2(nd.low),
      opening_price: round2(nd.opening_price),
      orb_direction: niftyDir
    };

    console.log(`${LOG} NIFTY: ORB H=${nd.high} L=${nd.low} dir=${niftyDir}`);
  }

  return resultMap;
}

/**
 * Validate picks against ORB data. Called at 9:30 AM after collection.
 *
 * 5 checks per pick:
 * 1. Gap check       — abs(gap_percent) < 1.5%
 * 2. ORB alignment   — Bullish scan → UP ORB, bearish → DOWN ORB
 * 3. Nifty alignment — Nifty ORB doesn't oppose scan bias
 * 4. Entry still valid — Entry price within 1% of pre-calculated level
 * 5. Volume check    — Auto-pass (LTP polling doesn't provide volume)
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
    const currentPrice = orb.opening_price; // Use opening price as reference
    const distPct = pick.levels.entry
      ? round2(Math.abs((currentPrice - pick.levels.entry) / pick.levels.entry) * 100)
      : 0;
    checks.entry_still_valid = {
      passed: distPct < 1.0,
      distance_percent: distPct
    };

    // Check 5: Volume — auto-pass (LTP doesn't provide volume data)
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
        // Recalculate levels
        pick.levels.entry = round2(newEntry);
        pick.levels.stop = round2(newStop);
        pick.levels.target = newTarget;
        pick.levels.risk_pct = newRiskPct;
        pick.levels.risk_reward = newRR;
        levelsRecalculated = true;

        // Re-check entry validity with new entry
        checks.gap_check.passed = true; // Override — recalculated
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
