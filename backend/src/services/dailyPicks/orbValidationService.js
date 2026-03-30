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
import { rateLimitedGet } from '../../utils/upstoxRateLimiter.js';
import { round2 } from './dailyPicksHelpers.js';
import { MIN_ORB_RR_BY_REGIME, GAP_DIRECTION_THRESHOLD_PCT, GAP_FADE_MAX_PASS, GAP_SIZE_ADVERSE_MAX_PCT, GAP_SIZE_ALIGNED_MAX_PCT, MIN_ORB_VOLUME_RATIO, TRADING_CANDLES_PER_DAY } from './dailyPicksConstants.js';

const LOG = '[ORB]';

// Crabel-style ORB constants
const ORB_BUFFER_PCT = 0.001;       // 0.1% above ORB high (longs) / below ORB low (shorts)
const NIFTY_THRESHOLD_PCT = 0.3;    // >0.3% opposing NIFTY move blocks trade
const MAX_ORB_RANGE_PCT = 3.0;      // ORB range > 3% of stock price = too volatile

/**
 * Compute volume ratio from actual volume, candle count, and 50-day average.
 * Shared by fetchOrbVolume() and simulation scripts.
 *
 * @param {number} actualVol — Total volume across candles
 * @param {number} candleCount — Number of 15-min candles
 * @param {number} avgVol50d — 50-day average daily volume
 * @returns {{ ratio: number, actual: number, expected: number, candle_count: number }}
 */
function computeVolumeRatio(actualVol, candleCount, avgVol50d) {
  const expectedVolPerCandle = Math.round(avgVol50d / TRADING_CANDLES_PER_DAY);
  const expectedVol = expectedVolPerCandle * candleCount;
  const ratio = expectedVol > 0 ? round2(actualVol / expectedVol) : 0;
  return { ratio, actual: actualVol, expected: expectedVol, candle_count: candleCount };
}

/**
 * Fetch intraday volume from Upstox 15-minute candles.
 * Sums actual volume across ALL available candles (cumulative) and compares
 * against expected volume scaled by the same candle count.
 *
 * Pass 1 (9:30): 1 candle  → actual_1 / expected_1
 * Pass 2 (9:46): 2 candles → (actual_1 + actual_2) / (expected_1 * 2)
 * Pass 3 (10:01): 3 candles → (actual_1 + actual_2 + actual_3) / (expected_1 * 3)
 *
 * This avoids penalizing stocks with thin opening volume that pick up afterwards.
 *
 * @param {Array} picks — Pick objects with instrument_key and _ohlcv.avg_volume_50d
 * @returns {Object} — Map { symbol: { ratio, actual, expected, candle_count } } or null
 */
async function fetchOrbVolume(picks) {
  const volumeMap = {};

  for (const pick of picks) {
    const instrumentKey = pick.instrument_key;
    const avgVol50d = pick._ohlcv?.avg_volume_50d || 0;

    if (!instrumentKey || !avgVol50d) {
      console.log(`${LOG} [VOL] ${pick.symbol}: skipping volume fetch — no instrument_key or avg_volume`);
      continue;
    }

    try {
      const url = `https://api.upstox.com/v3/historical-candle/intraday/${instrumentKey}/minutes/15`;
      const response = await rateLimitedGet(url, {
        headers: { 'Accept': 'application/json' },
        timeout: 5000,
      }, { caller: 'orbValidation.fetchOrbVolume' });

      const candles = response?.data?.data?.candles;
      if (!candles || candles.length === 0) {
        console.log(`${LOG} [VOL] ${pick.symbol}: no intraday candles returned — auto-pass`);
        continue;
      }

      // Sum volume across all available candles (Upstox returns newest first, index 5 = volume)
      const candleCount = candles.length;
      const actualVol = candles.reduce((sum, c) => sum + (c[5] || 0), 0);

      const volResult = computeVolumeRatio(actualVol, candleCount, avgVol50d);
      volumeMap[pick.symbol] = volResult;
      console.log(`${LOG} [VOL] ${pick.symbol}: ${candleCount} candles, actualVol=${actualVol} expectedVol=${volResult.expected} ratio=${volResult.ratio}x (avgVol50d=${avgVol50d})`);
    } catch (err) {
      console.warn(`${LOG} [VOL] ${pick.symbol}: fetch failed (${err.message}) — auto-pass`);
    }
  }

  return Object.keys(volumeMap).length > 0 ? volumeMap : null;
}

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
  console.log(`${LOG} [DEBUG] Calling kiteOrderService.getOHLC() with ${instruments.length} instruments...`);
  const ohlcData = await kiteOrderService.getOHLC(instruments);
  const ohlcKeys = Object.keys(ohlcData || {});
  console.log(`${LOG} [DEBUG] getOHLC() returned ${ohlcKeys.length} keys: ${ohlcKeys.join(', ') || 'EMPTY'}`);
  if (ohlcKeys.length === 0) {
    console.error(`${LOG} [ERROR] getOHLC() returned empty data — no OHLC for any instrument`);
  }

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

    // ORB direction: LTP vs open (Kite's `close` = prev day close, not candle close)
    let orbDirection = 'NEUTRAL';
    if (ltp > open * 1.001) orbDirection = 'UP';
    else if (ltp < open * 0.999) orbDirection = 'DOWN';

    resultMap[sym] = {
      high: round2(high),
      low: round2(low),
      opening_price: round2(open),
      ltp: round2(ltp),
      gap_percent: gapPct,
      orb_direction: orbDirection
    };

    console.log(`${LOG} ${sym}: O=${open} H=${high} L=${low} LTP=${ltp} prevClose=${close} gap=${gapPct}% dir=${orbDirection}`);
  }

  // NIFTY ORB
  const niftyData = ohlcData['NSE:NIFTY 50'];
  if (niftyData?.ohlc) {
    const { open, high, low } = niftyData.ohlc;
    const niftyLtp = niftyData.last_price;

    let niftyDir = 'NEUTRAL';
    if (niftyLtp > open * 1.001) niftyDir = 'UP';
    else if (niftyLtp < open * 0.999) niftyDir = 'DOWN';

    const niftyChangePct = open > 0 ? round2(((niftyLtp - open) / open) * 100) : 0;

    resultMap['_NIFTY'] = {
      high: round2(high),
      low: round2(low),
      opening_price: round2(open),
      orb_direction: niftyDir,
      nifty_change_pct: niftyChangePct
    };

    console.log(`${LOG} NIFTY: O=${open} H=${high} L=${low} LTP=${niftyLtp} dir=${niftyDir} change=${niftyChangePct}%`);
  }

  const collectedSymbols = Object.keys(resultMap).filter(k => k !== '_NIFTY');
  const skippedSymbols = symbols.filter(s => !resultMap[s]);
  console.log(`${LOG} ORB data collected for ${collectedSymbols.length}/${symbols.length} symbols: ${collectedSymbols.join(', ') || 'NONE'}`);
  if (skippedSymbols.length > 0) {
    console.warn(`${LOG} [WARN] No OHLC data for ${skippedSymbols.length} symbols: ${skippedSymbols.join(', ')}`);
  }
  console.log(`${LOG} [DEBUG] NIFTY data: ${resultMap['_NIFTY'] ? 'present' : 'MISSING'}`);
  return resultMap;
}

/**
 * Validate picks against ORB data. Called at 9:30 AM after OHLC fetch.
 *
 * Crabel-style: 5 checks per pick, then SL-M orders at ORB breakout levels.
 * 1. Gap size        — asymmetric: aligned < 3%, adverse < 1.5%
 * 2. Gap direction   — gap must not oppose scan bias (LONG + gap < -1% = fail)
 * 3. ORB R:R check   — R:R >= 1.5 with ORB breakout entry vs original stop/target
 * 4. Nifty alignment — NIFTY opposing move > 0.3% blocks trade
 * 5. ORB range width — ORB range < 3% of stock price (too volatile = fail)
 * 6. Volume check    — 15m vol vs avg_50d/25 ratio >= 0.8 (Upstox intraday)
 *
 * @param {Array} picks — Array of pick sub-documents from DailyPick
 * @param {Object} orbData — Output from collectOpeningRange()
 * @param {string} regime — Market regime (STRONG_BULL, WEAK_BEAR, etc.)
 * @param {number} orbPass — Current ORB pass number (1, 2, or 3)
 * @returns {Array} — Same picks array with orb + validation fields populated
 */
function validatePicks(picks, orbData, regime, orbPass = 1, orbVolumeMap = null) {
  if (!MIN_ORB_RR_BY_REGIME[regime]) {
    throw new Error(`[ORB] validatePicks called with unknown regime "${regime}" — must be one of: ${Object.keys(MIN_ORB_RR_BY_REGIME).join(', ')}`);
  }
  const niftyOrb = orbData['_NIFTY'];
  const niftyDir = niftyOrb?.orb_direction || 'NEUTRAL';
  const niftyChangePct = niftyOrb?.nifty_change_pct ?? 0;
  const minRR = MIN_ORB_RR_BY_REGIME[regime];

  console.log(`${LOG} Validating ${picks.length} picks (NIFTY dir: ${niftyDir} change: ${niftyChangePct}% regime: ${regime} minRR: ${minRR})`);

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

    const orbDate = orb.date || '';
    console.log(`${LOG} │ ORB data: ${orbDate ? `[${orbDate}] ` : ''}O=${orb.opening_price} H=${orb.high} L=${orb.low} gap=${orb.gap_percent}% dir=${orb.orb_direction}`);
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

    // Check 1: Gap size — direction-aware threshold (P3 asymmetric)
    // Aligned gaps (LONG + gap up, SHORT + gap down) get wider door per Crabel continuation
    // Adverse gaps (LONG + gap down, SHORT + gap up) use tighter threshold
    const gapAligned = (isBullish && orb.gap_percent > 0) || (!isBullish && orb.gap_percent < 0);
    const gapThreshold = gapAligned ? GAP_SIZE_ALIGNED_MAX_PCT : GAP_SIZE_ADVERSE_MAX_PCT;
    checks.gap_check = {
      passed: Math.abs(orb.gap_percent) < gapThreshold,
      value: orb.gap_percent,
      threshold: gapThreshold,
      gap_aligned: gapAligned
    };
    console.log(`${LOG} │ Check 1 GAP SIZE: |${orb.gap_percent}%| < ${gapThreshold}% (${gapAligned ? 'aligned' : 'adverse'}) → ${checks.gap_check.passed ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`${LOG} │   gap = (open(${orb.opening_price}) - entry(${pick.levels.entry})) / entry × 100`);

    // Check 2: Gap direction must not oppose scan bias
    const gapOpposesDirection = (isBullish && orb.gap_percent < -GAP_DIRECTION_THRESHOLD_PCT) || (!isBullish && orb.gap_percent > GAP_DIRECTION_THRESHOLD_PCT);
    checks.gap_direction = {
      passed: !gapOpposesDirection,
      value: orb.gap_percent,
      direction: isBullish ? 'LONG' : 'SHORT'
    };
    console.log(`${LOG} │ Check 2 GAP DIR: ${isBullish ? 'LONG' : 'SHORT'} bias, gap=${orb.gap_percent}% (threshold: ±${GAP_DIRECTION_THRESHOLD_PCT}%) → ${checks.gap_direction.passed ? '✅ PASS' : '❌ FAIL (gap opposes direction)'}`);

    // Gap-fade override: on Pass 2+, if Check 2 failed but LTP has faded back
    // through the original entry price, the gap has reversed and thesis is alive.
    // Edge Case 1 gate: LTP < open alone isn't enough — require LTP past original entry.
    let gapFadeTriggered = false;
    if (!checks.gap_direction.passed && orbPass > 1 && orbPass <= GAP_FADE_MAX_PASS && orb.ltp) {
      const originalEntry = pick.levels.entry;
      const ltpPastEntry = (isBullish && orb.ltp > originalEntry) || (!isBullish && orb.ltp < originalEntry);

      if (ltpPastEntry) {
        checks.gap_direction.passed = true;
        checks.gap_direction.gap_fade = true;
        checks.gap_direction.ltp = orb.ltp;
        checks.gap_direction.original_entry = originalEntry;
        gapFadeTriggered = true;
        console.log(`${LOG} │ Check 2 GAP-FADE OVERRIDE: LTP=${orb.ltp} has faded past entry=${originalEntry} → ✅ PASS (gap_fade)`);
      } else {
        checks.gap_direction.gap_fade = false;
        checks.gap_direction.ltp = orb.ltp;
        checks.gap_direction.original_entry = originalEntry;
        console.log(`${LOG} │ Check 2 GAP-FADE: LTP=${orb.ltp} has NOT faded past entry=${originalEntry} — fade incomplete`);
      }
    }

    // Check 3: ORB breakout R:R check (Crabel-style SL-M entry)
    // Entry = ORB high + 0.1% buffer (LONG) or ORB low - 0.1% buffer (SHORT)
    // Stop  = ORB opposite end + buffer (the ORB range defines intraday risk)
    //         If ORB stop is wider than structural stop, use structural (tighter = better)
    const orbEntry = isBullish
      ? round2(orb.high * (1 + ORB_BUFFER_PCT))
      : round2(orb.low * (1 - ORB_BUFFER_PCT));

    // ORB-based stop: opposite end of the opening range + buffer
    const orbStop = isBullish
      ? round2(orb.low * (1 - ORB_BUFFER_PCT))    // LONG: stop below ORB low
      : round2(orb.high * (1 + ORB_BUFFER_PCT));   // SHORT: stop above ORB high

    const originalStop = pick.levels.stop;
    const originalTarget = pick.levels.target;

    // Use the TIGHTER stop: ORB-based or structural (whichever limits risk more)
    // For LONG: tighter = higher stop. For SHORT: tighter = lower stop.
    const useOrbStop = isBullish
      ? orbStop > originalStop   // LONG: ORB stop is higher (tighter) than structural
      : orbStop < originalStop;  // SHORT: ORB stop is lower (tighter) than structural
    const effectiveStop = useOrbStop ? orbStop : originalStop;
    const stopSource = useOrbStop ? 'orb' : 'structural';

    const risk = Math.abs(orbEntry - effectiveStop);
    const reward = Math.abs(originalTarget - orbEntry);
    const newRR = risk > 0 ? round2(reward / risk) : 0;

    checks.orb_alignment = {
      passed: newRR >= minRR,
      scan_bias: pick.direction,
      orb_dir: orb.orb_direction,
      new_entry: orbEntry,
      new_stop: effectiveStop,
      orb_stop: orbStop,
      structural_stop: originalStop,
      stop_source: stopSource,
      original_entry: pick.levels.entry,
      new_rr: newRR,
      min_rr: minRR,
      orb_high: orb.high,
      orb_low: orb.low
    };
    console.log(`${LOG} │ Check 3 ORB R:R:`);
    console.log(`${LOG} │   orbEntry = ${isBullish ? 'ORB_high' : 'ORB_low'}(${isBullish ? orb.high : orb.low}) × ${isBullish ? '1.001' : '0.999'} = ${orbEntry}`);
    console.log(`${LOG} │   orbStop = ${isBullish ? 'ORB_low' : 'ORB_high'}(${isBullish ? orb.low : orb.high}) × ${isBullish ? '0.999' : '1.001'} = ${orbStop} | structuralStop=${originalStop} → using ${stopSource} (${effectiveStop})`);
    console.log(`${LOG} │   originalTarget=${originalTarget}`);
    console.log(`${LOG} │   risk = |orbEntry(${orbEntry}) - stop(${effectiveStop})| = ${round2(risk)}`);
    console.log(`${LOG} │   reward = |target(${originalTarget}) - orbEntry(${orbEntry})| = ${round2(reward)}`);
    console.log(`${LOG} │   newRR = ${round2(reward)} / ${round2(risk)} = ${newRR} (min: ${minRR} [${regime}]) → ${checks.orb_alignment.passed ? '✅ PASS' : '❌ FAIL'}`);

    // Check 4: Nifty alignment — opposing move blocks trade
    // Regime-aligned trades get wider threshold to tolerate normal morning counter-moves:
    //   STRONG/EXTREME regimes → 0.75% (e.g. morning relief rally in EXTREME_BEAR is normal)
    //   WEAK regimes → 0.5%
    // Counter-regime trades keep strict 0.3% threshold
    const isStrongRegime = ['STRONG_BULL', 'STRONG_BEAR', 'EXTREME_BULL', 'EXTREME_BEAR'].includes(regime);
    const niftyThreshold = pick.regime_aligned
      ? (isStrongRegime ? 0.75 : 0.5)
      : NIFTY_THRESHOLD_PCT;
    const niftyOpposes = (isBullish && niftyChangePct < -niftyThreshold) ||
                         (!isBullish && niftyChangePct > niftyThreshold);
    checks.nifty_alignment = {
      passed: !niftyOpposes,
      nifty_dir: niftyDir,
      nifty_change_pct: niftyChangePct,
      threshold: niftyThreshold,
      regime_aligned: !!pick.regime_aligned
    };
    console.log(`${LOG} │ Check 4 NIFTY: dir=${niftyDir} change=${niftyChangePct}% vs ${isBullish ? 'LONG' : 'SHORT'} (threshold: ±${niftyThreshold}%${pick.regime_aligned ? ' regime-aligned' : ''}) → ${checks.nifty_alignment.passed ? '✅ PASS' : '❌ FAIL'}`);

    // Check 5: ORB range width — ensure ORB isn't too volatile for breakout entry
    const orbRange = orb.high - orb.low;
    const orbRangePct = orb.low > 0 ? round2((orbRange / orb.low) * 100) : 0;
    checks.entry_still_valid = {
      passed: orbRangePct <= MAX_ORB_RANGE_PCT,
      orb_range_pct: orbRangePct,
      max_allowed: MAX_ORB_RANGE_PCT
    };
    console.log(`${LOG} │ Check 5 ORB RANGE: (H(${orb.high}) - L(${orb.low})) / L × 100 = ${orbRangePct}% (max: ${MAX_ORB_RANGE_PCT}%) → ${checks.entry_still_valid.passed ? '✅ PASS' : '❌ FAIL'}`);

    // Check 6: Volume gate — compare 15m opening volume to expected daily average
    const volData = orbVolumeMap?.[pick.symbol];
    checks.volume_check = {
      passed: !volData ? true : volData.ratio >= MIN_ORB_VOLUME_RATIO,
      ratio: volData?.ratio || null,
      actual: volData?.actual || null,
      expected: volData?.expected || null,
      candle_count: volData?.candle_count || null,
      threshold: MIN_ORB_VOLUME_RATIO
    };
    if (!volData) {
      console.log(`${LOG} │ Check 6 VOLUME: auto-pass (no data) ✅`);
    } else {
      console.log(`${LOG} │ Check 6 VOLUME: ${volData.candle_count} candles, vol=${volData.actual} vs expected=${volData.expected} (ratio=${volData.ratio}x, min=${MIN_ORB_VOLUME_RATIO}) → ${checks.volume_check.passed ? '✅ PASS' : '❌ FAIL (thin volume)'}`);
    }

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
    console.log(`${LOG} │ RESULT: ${allPassed ? '✅ PASSED' : '❌ FAILED'}${gapFadeTriggered ? ' (via gap-fade)' : ''}${skipReason ? ` (failed: ${skipReason})` : ''}`);
    console.log(`${LOG} └────────────────────────────────────`);
  }

  return picks;
}

export { collectOpeningRange, validatePicks, fetchOrbVolume, computeVolumeRatio };

export default { collectOpeningRange, validatePicks, fetchOrbVolume, computeVolumeRatio };
