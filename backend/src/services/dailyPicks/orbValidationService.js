/**
 * ORB (Opening Range Breakout) Validation Service
 *
 * 1. collectOpeningRange() — Called at 9:30 AM: Single OHLC call to get the 15-min opening range
 * 2. validatePicks()       — 9:30 AM: Validate picks + compute Crabel-style SL-M breakout entries
 *
 * Uses Kite Connect API getOHLC() — at 9:30 the day's OHLC IS the 15-min opening candle.
 *
 * Crabel-style approach: instead of checking candle direction, place SL-M orders at ORB
 * high/low + buffer. Market confirms the trade by triggering the breakout order.
 */

import kiteOrderService from '../kiteOrder.service.js';
import { round2 } from './dailyPicksHelpers.js';

const LOG = '[ORB]';

// Crabel-style ORB constants
const ORB_BUFFER_PCT = 0.001;       // 0.1% above ORB high (longs) / below ORB low (shorts)
const MIN_ORB_RR = 1.2;             // Minimum R:R with ORB-adjusted entry (matches pre-market gate)
const NIFTY_THRESHOLD_PCT = 0.3;    // >0.3% opposing NIFTY move blocks trade
const MAX_ORB_RANGE_PCT = 3.0;      // ORB range > 3% of stock price = too volatile

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

    // ORB direction: close of 15-min candle vs open (kept for audit/logging)
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

    const niftyChangePct = open > 0 ? round2(((close - open) / open) * 100) : 0;

    resultMap['_NIFTY'] = {
      high: round2(high),
      low: round2(low),
      opening_price: round2(open),
      orb_direction: niftyDir,
      nifty_change_pct: niftyChangePct
    };

    console.log(`${LOG} NIFTY: O=${open} H=${high} L=${low} C=${close} dir=${niftyDir} change=${niftyChangePct}%`);
  }

  console.log(`${LOG} ORB data collected for ${Object.keys(resultMap).filter(k => k !== '_NIFTY').length} symbols`);
  return resultMap;
}

/**
 * Validate picks against ORB data. Called at 9:30 AM after OHLC fetch.
 *
 * Crabel-style: 5 checks per pick, then SL-M orders at ORB breakout levels.
 * 1. Gap size        — abs(gap_percent) < 1.5%
 * 2. Gap direction   — gap must not oppose scan bias (LONG + gap < -1% = fail)
 * 3. ORB R:R check   — R:R >= 1.5 with ORB breakout entry vs original stop/target
 * 4. Nifty alignment — NIFTY opposing move > 0.3% blocks trade
 * 5. ORB range width — ORB range < 3% of stock price (too volatile = fail)
 * 6. Volume check    — Auto-pass (OHLC doesn't provide volume)
 *
 * @param {Array} picks — Array of pick sub-documents from DailyPick
 * @param {Object} orbData — Output from collectOpeningRange()
 * @returns {Array} — Same picks array with orb + validation fields populated
 */
function validatePicks(picks, orbData) {
  const niftyOrb = orbData['_NIFTY'];
  const niftyDir = niftyOrb?.orb_direction || 'NEUTRAL';
  const niftyChangePct = niftyOrb?.nifty_change_pct ?? 0;

  console.log(`${LOG} Validating ${picks.length} picks (NIFTY dir: ${niftyDir} change: ${niftyChangePct}%)`);

  // TEMPORARY: Skip all validation when FORCE_CONDITIONS_MET is true (for testing order placement)
  // if (process.env.FORCE_CONDITIONS_MET === 'true') {
  //   console.log(`${LOG} FORCE_CONDITIONS_MET=true — BYPASSING ALL VALIDATION`);
  //   for (const pick of picks) {
  //     const orb = orbData[pick.symbol];
  //     if (orb) {
  //       pick.orb = {
  //         high: orb.high,
  //         low: orb.low,
  //         opening_price: orb.opening_price,
  //         gap_percent: orb.gap_percent,
  //         orb_direction: orb.orb_direction,
  //         nifty_orb_direction: niftyDir,
  //         nifty_change_pct: niftyChangePct
  //       };
  //     }
  //     const isBullish = pick.direction === 'LONG';
  //     const orbEntry = isBullish
  //       ? round2((orb?.high || 0) * (1 + ORB_BUFFER_PCT))
  //       : round2((orb?.low || 0) * (1 - ORB_BUFFER_PCT));
  //     pick.validation = {
  //       passed: true,
  //       checks: {
  //         gap_check: { passed: true, value: orb?.gap_percent || 0 },
  //         gap_direction: { passed: true, value: orb?.gap_percent || 0, direction: 'FORCED' },
  //         orb_alignment: { passed: true, scan_bias: pick.direction, orb_dir: orb?.orb_direction || 'FORCED', new_entry: orbEntry, original_entry: pick.levels.entry, new_rr: 99, min_rr: MIN_ORB_RR, orb_high: orb?.high || 0, orb_low: orb?.low || 0 },
  //         nifty_alignment: { passed: true, nifty_dir: niftyDir, nifty_change_pct: niftyChangePct, threshold: NIFTY_THRESHOLD_PCT },
  //         entry_still_valid: { passed: true, orb_range_pct: 0, max_allowed: MAX_ORB_RANGE_PCT },
  //         volume_check: { passed: true, ratio: null }
  //       },
  //       skip_reason: null,
  //       forced: true
  //     };
  //     console.log(`${LOG} ${pick.symbol}: FORCED PASS (validation bypassed)`);
  //   }
  //   return picks;
  // }

  for (const pick of picks) {
    const orb = orbData[pick.symbol];
    console.log(`${LOG} ┌─── ${pick.symbol} (${pick.direction} ${pick.scan_type}) VALIDATION ───`);
    if (!orb) {
      pick.validation = {
        passed: false,
        checks: {},
        skip_reason: 'no_orb_data'
      };
      console.log(`${LOG} │ ❌ SKIP — no ORB data for ${pick.symbol}`);
      console.log(`${LOG} └────────────────────────────────────`);
      continue;
    }

    console.log(`${LOG} │ ORB data: O=${orb.opening_price} H=${orb.high} L=${orb.low} gap=${orb.gap_percent}% dir=${orb.orb_direction}`);
    console.log(`${LOG} │ Pre-market levels: entry=${pick.levels.entry} stop=${pick.levels.stop} target=${pick.levels.target} R:R=${pick.levels.risk_reward}`);

    // Populate ORB data on the pick — preserve orb_pass/orb_passes from multi-pass tracking
    pick.orb = {
      high: orb.high,
      low: orb.low,
      opening_price: orb.opening_price,
      gap_percent: orb.gap_percent,
      orb_direction: orb.orb_direction,
      nifty_orb_direction: niftyDir,
      nifty_change_pct: niftyChangePct,
      orb_pass: pick.orb?.orb_pass || 1,
      orb_passes: pick.orb?.orb_passes || []
    };

    const isBullish = pick.direction === 'LONG';
    const checks = {};

    // Check 1: Gap size < 1.5%
    checks.gap_check = {
      passed: Math.abs(orb.gap_percent) < 1.5,
      value: orb.gap_percent
    };
    console.log(`${LOG} │ Check 1 GAP SIZE: |${orb.gap_percent}%| < 1.5% → ${checks.gap_check.passed ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`${LOG} │   gap = (open(${orb.opening_price}) - entry(${pick.levels.entry})) / entry × 100`);

    // Check 2: Gap direction must not oppose scan bias
    const gapOpposesDirection = (isBullish && orb.gap_percent < -1.0) || (!isBullish && orb.gap_percent > 1.0);
    checks.gap_direction = {
      passed: !gapOpposesDirection,
      value: orb.gap_percent,
      direction: isBullish ? 'LONG' : 'SHORT'
    };
    console.log(`${LOG} │ Check 2 GAP DIR: ${isBullish ? 'LONG' : 'SHORT'} bias, gap=${orb.gap_percent}% → ${checks.gap_direction.passed ? '✅ PASS' : '❌ FAIL (gap opposes direction)'}`);

    // Check 3: ORB breakout R:R check (Crabel-style SL-M entry)
    // Entry = ORB high + 0.1% buffer (LONG) or ORB low - 0.1% buffer (SHORT)
    const orbEntry = isBullish
      ? round2(orb.high * (1 + ORB_BUFFER_PCT))
      : round2(orb.low * (1 - ORB_BUFFER_PCT));

    const originalStop = pick.levels.stop;
    const originalTarget = pick.levels.target;
    const risk = Math.abs(orbEntry - originalStop);
    const reward = Math.abs(originalTarget - orbEntry);
    const newRR = risk > 0 ? round2(reward / risk) : 0;

    checks.orb_alignment = {
      passed: newRR >= MIN_ORB_RR,
      scan_bias: pick.direction,
      orb_dir: orb.orb_direction,
      new_entry: orbEntry,
      original_entry: pick.levels.entry,
      new_rr: newRR,
      min_rr: MIN_ORB_RR,
      orb_high: orb.high,
      orb_low: orb.low
    };
    console.log(`${LOG} │ Check 3 ORB R:R:`);
    console.log(`${LOG} │   orbEntry = ${isBullish ? 'ORB_high' : 'ORB_low'}(${isBullish ? orb.high : orb.low}) × ${isBullish ? '1.001' : '0.999'} = ${orbEntry}`);
    console.log(`${LOG} │   originalStop=${originalStop} originalTarget=${originalTarget}`);
    console.log(`${LOG} │   risk = |orbEntry(${orbEntry}) - stop(${originalStop})| = ${round2(risk)}`);
    console.log(`${LOG} │   reward = |target(${originalTarget}) - orbEntry(${orbEntry})| = ${round2(reward)}`);
    console.log(`${LOG} │   newRR = ${round2(reward)} / ${round2(risk)} = ${newRR} (min: ${MIN_ORB_RR}) → ${checks.orb_alignment.passed ? '✅ PASS' : '❌ FAIL'}`);

    // Check 4: Nifty alignment — >0.3% opposing move blocks trade
    const niftyOpposes = (isBullish && niftyChangePct < -NIFTY_THRESHOLD_PCT) ||
                         (!isBullish && niftyChangePct > NIFTY_THRESHOLD_PCT);
    checks.nifty_alignment = {
      passed: !niftyOpposes,
      nifty_dir: niftyDir,
      nifty_change_pct: niftyChangePct,
      threshold: NIFTY_THRESHOLD_PCT
    };
    console.log(`${LOG} │ Check 4 NIFTY: dir=${niftyDir} change=${niftyChangePct}% vs ${isBullish ? 'LONG' : 'SHORT'} (threshold: ±${NIFTY_THRESHOLD_PCT}%) → ${checks.nifty_alignment.passed ? '✅ PASS' : '❌ FAIL'}`);

    // Check 5: ORB range width — ensure ORB isn't too volatile for breakout entry
    const orbRange = orb.high - orb.low;
    const orbRangePct = orb.low > 0 ? round2((orbRange / orb.low) * 100) : 0;
    checks.entry_still_valid = {
      passed: orbRangePct <= MAX_ORB_RANGE_PCT,
      orb_range_pct: orbRangePct,
      max_allowed: MAX_ORB_RANGE_PCT
    };
    console.log(`${LOG} │ Check 5 ORB RANGE: (H(${orb.high}) - L(${orb.low})) / L × 100 = ${orbRangePct}% (max: ${MAX_ORB_RANGE_PCT}%) → ${checks.entry_still_valid.passed ? '✅ PASS' : '❌ FAIL'}`);

    // Check 6: Volume — auto-pass (OHLC doesn't provide volume data)
    checks.volume_check = {
      passed: true,
      ratio: null
    };
    console.log(`${LOG} │ Check 6 VOLUME: auto-pass ✅`);

    // Determine overall pass/fail
    const allPassed = Object.values(checks).every(c => c.passed);
    const skipReason = allPassed ? null : Object.entries(checks)
      .filter(([, c]) => !c.passed)
      .map(([k]) => k)
      .join(', ');

    pick.validation = {
      passed: allPassed,
      checks,
      skip_reason: skipReason
    };

    console.log(`${LOG} │ ═══════════════════════════════════`);
    console.log(`${LOG} │ RESULT: ${allPassed ? '✅ PASSED' : '❌ FAILED'}${skipReason ? ` (failed: ${skipReason})` : ''}`);
    console.log(`${LOG} └────────────────────────────────────`);
  }

  return picks;
}

export { collectOpeningRange, validatePicks };

export default { collectOpeningRange, validatePicks };
