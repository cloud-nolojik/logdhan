/**
 * ORB Validation Test Script
 *
 * Tests validatePicks() with mock OHLC + volume data across all 3 passes.
 * No API calls — directly feeds data to the internal functions.
 *
 * Run with: node src/tests/orb-validation-test.js
 */

import { validatePicks } from '../services/dailyPicks/orbValidationService.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const PASS_LABELS = { 1: '9:30 AM (Pass 1)', 2: '9:46 AM (Pass 2)', 3: '10:01 AM (Pass 3)' };

function makePick(overrides = {}) {
  return {
    symbol: 'RELIANCE',
    direction: 'LONG',
    scan_type: 'ema_pullback_bullish',
    regime_aligned: true,
    instrument_key: 'NSE_EQ|INE002A01018',
    _ohlcv: {
      close: 1250,
      avg_volume_50d: 5_000_000,
      consecutive_up_days: 1,
      consecutive_down_days: 0,
      ...overrides._ohlcv,
    },
    levels: {
      entry: 1250,   // prev close / pre-market entry
      stop: 1220,
      target: 1310,
      risk_reward: 2.0,
      ...overrides.levels,
    },
    orb: overrides.orb || undefined,
    ...overrides,
  };
}

function makeOrbData(symbol, overrides = {}) {
  return {
    [symbol]: {
      high: 1260,
      low: 1245,
      opening_price: 1255,
      ltp: 1258,
      gap_percent: 0.4,   // (1255 - 1250) / 1250 * 100
      orb_direction: 'UP',
      ...overrides,
    },
    _NIFTY: {
      high: 22500,
      low: 22350,
      opening_price: 22400,
      orb_direction: 'UP',
      nifty_change_pct: 0.2,
      ...overrides._NIFTY,
    },
  };
}

/**
 * Build orbVolumeMap manually — simulates what fetchOrbVolume() would return.
 * candles: array of volumes per 15m candle (e.g. [150000] for Pass 1, [150000, 220000] for Pass 2)
 */
function makeVolumeMap(symbol, candleVolumes, avgVol50d) {
  const candleCount = candleVolumes.length;
  const expectedPerCandle = Math.round(avgVol50d / 25); // TRADING_CANDLES_PER_DAY = 25
  const actualVol = candleVolumes.reduce((s, v) => s + v, 0);
  const expectedVol = expectedPerCandle * candleCount;
  const ratio = expectedVol > 0 ? Math.round((actualVol / expectedVol) * 100) / 100 : 0;
  return {
    [symbol]: { ratio, actual: actualVol, expected: expectedVol, candle_count: candleCount },
  };
}

function printHeader(title) {
  console.log('\n' + '═'.repeat(80));
  console.log(`  ${title}`);
  console.log('═'.repeat(80));
}

function printResult(pick) {
  const v = pick.validation;
  const status = v.passed ? '✅ ALL PASSED' : `❌ FAILED: ${v.skip_reason}`;
  console.log(`\n  >> ${pick.symbol} ${pick.direction}: ${status}`);
  for (const [name, check] of Object.entries(v.checks)) {
    const icon = check.passed ? '✅' : '❌';
    console.log(`     ${icon} ${name}: ${JSON.stringify(check)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════════

async function runTests() {
  let passed = 0;
  let failed = 0;

  function expect(label, actual, expected) {
    if (actual === expected) {
      console.log(`  ✅ ${label}`);
      passed++;
    } else {
      console.log(`  ❌ ${label} — expected ${expected}, got ${actual}`);
      failed++;
    }
  }

  // ─── Test 1: Happy path LONG — all checks pass across 3 passes ─────────
  printHeader('TEST 1: Happy Path LONG — All 3 Passes');

  for (const orbPass of [1, 2, 3]) {
    console.log(`\n  --- ${PASS_LABELS[orbPass]} ---`);
    const pick = makePick();

    // Simulate widening ORB range across passes (Kite returns cumulative day OHLC)
    const orbOverrides = orbPass === 1
      ? { high: 1260, low: 1245 }               // 15m range
      : orbPass === 2
        ? { high: 1265, low: 1243, ltp: 1262 }   // 30m range (widened)
        : { high: 1268, low: 1240, ltp: 1265 };   // 45m range (widened more)

    const orbData = makeOrbData('RELIANCE', orbOverrides);

    // Volume: thin opening, picks up later
    const candleVols = orbPass === 1 ? [150000] : orbPass === 2 ? [150000, 220000] : [150000, 220000, 280000];
    const volMap = makeVolumeMap('RELIANCE', candleVols, 5_000_000);

    const [result] = validatePicks([pick], orbData, 'STRONG_BULL', orbPass, volMap);
    printResult(result);
    expect(`Pass ${orbPass}: overall passed`, result.validation.passed, true);
    expect(`Pass ${orbPass}: volume candle_count`, result.validation.checks.volume_check.candle_count, orbPass);
  }

  // ─── Test 2: Adverse gap LONG (gap down -1.2%) — should PASS Check 1 ───
  printHeader('TEST 2: Adverse Gap LONG — Gap Down -1.2% (under 1.5% adverse threshold)');
  {
    const pick = makePick();
    const orbData = makeOrbData('RELIANCE', {
      opening_price: 1235,   // gapped down from 1250
      gap_percent: -1.2,     // adverse gap for LONG
      high: 1240, low: 1230, ltp: 1238,
    });
    const volMap = makeVolumeMap('RELIANCE', [200000], 5_000_000);
    const [result] = validatePicks([pick], orbData, 'STRONG_BULL', 1, volMap);
    printResult(result);
    expect('Check 1 gap_check passed (adverse -1.2% < 1.5%)', result.validation.checks.gap_check.passed, true);
    expect('gap_aligned = false (LONG + gap down)', result.validation.checks.gap_check.gap_aligned, false);
    expect('threshold = 1.5 (adverse)', result.validation.checks.gap_check.threshold, 1.5);
  }

  // ─── Test 3: Adverse gap LONG (gap down -1.8%) — should FAIL Check 1 ───
  printHeader('TEST 3: Adverse Gap LONG — Gap Down -1.8% (exceeds 1.5% adverse threshold)');
  {
    const pick = makePick();
    const orbData = makeOrbData('RELIANCE', {
      opening_price: 1227.5,
      gap_percent: -1.8,
      high: 1235, low: 1225, ltp: 1230,
    });
    const volMap = makeVolumeMap('RELIANCE', [200000], 5_000_000);
    const [result] = validatePicks([pick], orbData, 'STRONG_BULL', 1, volMap);
    printResult(result);
    expect('Check 1 gap_check FAILED (adverse -1.8% > 1.5%)', result.validation.checks.gap_check.passed, false);
  }

  // ─── Test 4: Aligned gap LONG (gap up +2.5%) — should PASS Check 1 (P3) ─
  printHeader('TEST 4: Aligned Gap LONG — Gap Up +2.5% (under 3% aligned threshold, Crabel continuation)');
  {
    const pick = makePick();
    const orbData = makeOrbData('RELIANCE', {
      opening_price: 1281.25,
      gap_percent: 2.5,     // aligned gap for LONG — Crabel continuation
      high: 1290, low: 1278, ltp: 1287,
    });
    const volMap = makeVolumeMap('RELIANCE', [300000], 5_000_000);
    const [result] = validatePicks([pick], orbData, 'STRONG_BULL', 1, volMap);
    printResult(result);
    expect('Check 1 gap_check PASSED (aligned 2.5% < 3.0%)', result.validation.checks.gap_check.passed, true);
    expect('gap_aligned = true', result.validation.checks.gap_check.gap_aligned, true);
    expect('threshold = 3.0 (aligned)', result.validation.checks.gap_check.threshold, 3);
  }

  // ─── Test 5: Aligned gap LONG (gap up +3.5%) — should FAIL Check 1 ─────
  printHeader('TEST 5: Aligned Gap LONG — Gap Up +3.5% (exceeds 3% aligned threshold)');
  {
    const pick = makePick();
    const orbData = makeOrbData('RELIANCE', {
      opening_price: 1293.75,
      gap_percent: 3.5,
      high: 1300, low: 1290, ltp: 1297,
    });
    const volMap = makeVolumeMap('RELIANCE', [300000], 5_000_000);
    const [result] = validatePicks([pick], orbData, 'STRONG_BULL', 1, volMap);
    printResult(result);
    expect('Check 1 gap_check FAILED (aligned 3.5% > 3.0%)', result.validation.checks.gap_check.passed, false);
  }

  // ─── Test 6: SHORT with aligned gap down — Crabel SHORT continuation ────
  printHeader('TEST 6: Aligned Gap SHORT — Gap Down -2.0% (Crabel SHORT continuation)');
  {
    const pick = makePick({
      symbol: 'TATAMOTORS',
      direction: 'SHORT',
      scan_type: 'ema_breakdown_bearish',
      levels: { entry: 800, stop: 825, target: 760, risk_reward: 1.6 },
      _ohlcv: { close: 800, avg_volume_50d: 8_000_000 },
    });
    const orbData = makeOrbData('TATAMOTORS', {
      opening_price: 784,
      gap_percent: -2.0,  // aligned for SHORT
      high: 788, low: 780, ltp: 783,
      _NIFTY: { high: 22500, low: 22350, opening_price: 22400, orb_direction: 'DOWN', nifty_change_pct: -0.15 },
    });
    const volMap = makeVolumeMap('TATAMOTORS', [350000], 8_000_000);
    const [result] = validatePicks([pick], orbData, 'STRONG_BEAR', 1, volMap);
    printResult(result);
    expect('Check 1 gap_check PASSED (aligned SHORT gap -2.0% < 3.0%)', result.validation.checks.gap_check.passed, true);
    expect('gap_aligned = true (SHORT + gap down)', result.validation.checks.gap_check.gap_aligned, true);
  }

  // ─── Test 7: Volume gate — thin volume fails ───────────────────────────
  printHeader('TEST 7: Volume Gate — Thin Volume (ratio < 0.8)');
  {
    const pick = makePick();
    const orbData = makeOrbData('RELIANCE');
    // avg_vol_50d = 5M, expected per candle = 200K, actual = 100K → ratio = 0.5
    const volMap = makeVolumeMap('RELIANCE', [100000], 5_000_000);
    const [result] = validatePicks([pick], orbData, 'STRONG_BULL', 1, volMap);
    printResult(result);
    expect('Check 6 volume_check FAILED (ratio 0.5 < 0.8)', result.validation.checks.volume_check.passed, false);
    expect('Volume ratio', result.validation.checks.volume_check.ratio, 0.5);
  }

  // ─── Test 8: Volume gate — thin opening but cumulative passes on Pass 2 ─
  printHeader('TEST 8: Volume Gate — Thin Opening, Cumulative Passes on Pass 2');
  {
    const pick = makePick();
    const orbData = makeOrbData('RELIANCE', { high: 1265, low: 1243, ltp: 1262 });
    // Pass 1: 100K / 200K = 0.5 → FAIL
    // Pass 2: (100K + 350K) / (200K * 2) = 450K / 400K = 1.12 → PASS
    const volMapPass1 = makeVolumeMap('RELIANCE', [100000], 5_000_000);
    const volMapPass2 = makeVolumeMap('RELIANCE', [100000, 350000], 5_000_000);

    const [r1] = validatePicks([makePick()], makeOrbData('RELIANCE'), 'STRONG_BULL', 1, volMapPass1);
    const [r2] = validatePicks([makePick()], orbData, 'STRONG_BULL', 2, volMapPass2);

    expect('Pass 1: volume FAILED (thin opening)', r1.validation.checks.volume_check.passed, false);
    expect('Pass 1: 1 candle', r1.validation.checks.volume_check.candle_count, 1);
    expect('Pass 2: volume PASSED (cumulative)', r2.validation.checks.volume_check.passed, true);
    expect('Pass 2: 2 candles', r2.validation.checks.volume_check.candle_count, 2);
  }

  // ─── Test 9: Volume gate — no data = auto-pass ─────────────────────────
  printHeader('TEST 9: Volume Gate — No Data (API failure) → Auto-Pass');
  {
    const pick = makePick();
    const orbData = makeOrbData('RELIANCE');
    const [result] = validatePicks([pick], orbData, 'STRONG_BULL', 1, null);
    printResult(result);
    expect('Check 6 volume_check auto-pass', result.validation.checks.volume_check.passed, true);
    expect('ratio is null', result.validation.checks.volume_check.ratio, null);
  }

  // ─── Test 10: Gap-fade override on Pass 2 ──────────────────────────────
  printHeader('TEST 10: Gap-Fade Override — Check 2 fails on Pass 1, fades back by Pass 2');
  {
    // Pass 1: LONG but gap down -2.5% → Check 2 fails
    const pick1 = makePick();
    const orbData1 = makeOrbData('RELIANCE', {
      opening_price: 1218.75,
      gap_percent: -2.5,
      high: 1225, low: 1215, ltp: 1220,
    });
    const [r1] = validatePicks([pick1], orbData1, 'STRONG_BULL', 1, null);
    expect('Pass 1: Check 2 gap_direction FAILED', r1.validation.checks.gap_direction.passed, false);

    // Pass 2: LTP has faded back above entry (1250) → gap-fade override
    const pick2 = makePick({ orb: { orb_pass: 2, orb_passes: [] } });
    const orbData2 = makeOrbData('RELIANCE', {
      opening_price: 1218.75,
      gap_percent: -2.5,
      high: 1255, low: 1215, ltp: 1253,  // LTP > entry(1250) = faded back
    });
    const [r2] = validatePicks([pick2], orbData2, 'STRONG_BULL', 2, null);
    expect('Pass 2: Check 2 gap_direction PASSED (gap-fade)', r2.validation.checks.gap_direction.passed, true);
    expect('Pass 2: gap_fade = true', r2.validation.checks.gap_direction.gap_fade, true);
  }

  // ─── Test 11: Nifty opposing — blocks trade ────────────────────────────
  printHeader('TEST 11: Nifty Opposing — LONG blocked by Nifty falling > 0.3%');
  {
    const pick = makePick({ regime_aligned: false });
    const orbData = makeOrbData('RELIANCE', {
      _NIFTY: { high: 22500, low: 22300, opening_price: 22400, orb_direction: 'DOWN', nifty_change_pct: -0.5 },
    });
    const [result] = validatePicks([pick], orbData, 'WEAK_BULL', 1, null);
    printResult(result);
    expect('Check 4 nifty_alignment FAILED', result.validation.checks.nifty_alignment.passed, false);
  }

  // ─── Test 12: Nifty opposing but regime-aligned gets wider threshold ────
  printHeader('TEST 12: Nifty — Regime-Aligned Gets 0.5% Threshold');
  {
    const pick = makePick({ regime_aligned: true });
    const orbData = makeOrbData('RELIANCE', {
      _NIFTY: { high: 22500, low: 22300, opening_price: 22400, orb_direction: 'DOWN', nifty_change_pct: -0.4 },
    });
    const [result] = validatePicks([pick], orbData, 'STRONG_BULL', 1, null);
    expect('Check 4 PASSED (regime-aligned: -0.4% within 0.5% threshold)', result.validation.checks.nifty_alignment.passed, true);
  }

  // ─── Test 13: ORB range too wide — fails Check 5 ──────────────────────
  printHeader('TEST 13: ORB Range Too Wide (>3%)');
  {
    const pick = makePick();
    const orbData = makeOrbData('RELIANCE', {
      high: 1300, low: 1258, // range = 42, 42/1258 * 100 = 3.34%
      opening_price: 1260, gap_percent: 0.8,
    });
    const [result] = validatePicks([pick], orbData, 'STRONG_BULL', 1, null);
    printResult(result);
    expect('Check 5 entry_still_valid FAILED (ORB range > 3%)', result.validation.checks.entry_still_valid.passed, false);
  }

  // ─── Test 14: Poor R:R — fails Check 3 ────────────────────────────────
  printHeader('TEST 14: Poor R:R — ORB Entry Too Far From Stop');
  {
    // LONG: entry=1250, stop=1220, target=1310
    // ORB high=1300 → orbEntry=1301.3, risk=|1301.3-1220|=81.3, reward=|1310-1301.3|=8.7, RR=0.11
    const pick = makePick();
    const orbData = makeOrbData('RELIANCE', {
      high: 1300, low: 1295,
      opening_price: 1296, gap_percent: 3.68, // will also fail Check 1 aligned
    });
    const [result] = validatePicks([pick], orbData, 'STRONG_BULL', 1, null);
    expect('Check 3 orb_alignment FAILED (poor R:R)', result.validation.checks.orb_alignment.passed, false);
  }

  // ─── Test 15: Multi-pick validation — 2 picks, 1 pass, 1 fail ─────────
  printHeader('TEST 15: Multi-Pick — RELIANCE passes, TCS fails (thin volume)');
  {
    const pickR = makePick();
    const pickT = makePick({
      symbol: 'TCS',
      instrument_key: 'NSE_EQ|INE467B01029',
      levels: { entry: 3500, stop: 3430, target: 3610, risk_reward: 1.57 },
      _ohlcv: { close: 3500, avg_volume_50d: 2_000_000 },
    });

    const orbData = {
      RELIANCE: { high: 1260, low: 1245, opening_price: 1255, ltp: 1258, gap_percent: 0.4, orb_direction: 'UP' },
      TCS: { high: 3520, low: 3490, opening_price: 3510, ltp: 3515, gap_percent: 0.29, orb_direction: 'UP' },
      _NIFTY: { high: 22500, low: 22350, opening_price: 22400, orb_direction: 'UP', nifty_change_pct: 0.2 },
    };

    const volMap = {
      RELIANCE: { ratio: 1.2, actual: 240000, expected: 200000, candle_count: 1 },
      TCS: { ratio: 0.4, actual: 32000, expected: 80000, candle_count: 1 },  // thin volume
    };

    const results = validatePicks([pickR, pickT], orbData, 'STRONG_BULL', 1, volMap);
    expect('RELIANCE passed', results[0].validation.passed, true);
    expect('TCS failed (thin volume)', results[1].validation.passed, false);
    expect('TCS failed reason includes volume_check', results[1].validation.skip_reason.includes('volume_check'), true);
  }

  // ─── Test 16: All regimes — different R:R thresholds ───────────────────
  printHeader('TEST 16: Regime R:R Thresholds');
  {
    const regimes = ['STRONG_BULL', 'STRONG_BEAR', 'WEAK_BULL', 'WEAK_BEAR', 'NEUTRAL'];
    const expectedMinRR = { STRONG_BULL: 1.5, STRONG_BEAR: 1.5, WEAK_BULL: 1.8, WEAK_BEAR: 1.8, NEUTRAL: 2.0 };

    for (const regime of regimes) {
      // Entry=1250, Stop=1220, Target=1310
      // ORB high=1260 → orbEntry=1261.26, risk=41.26, reward=48.74, RR=1.18
      // This should fail for all regimes (1.18 < 1.5)
      const pick = makePick();
      const orbData = makeOrbData('RELIANCE', { high: 1260, low: 1245 });
      // Need NIFTY to not oppose for SHORT-friendly regimes
      if (['STRONG_BEAR', 'WEAK_BEAR'].includes(regime)) {
        orbData._NIFTY.nifty_change_pct = 0.0;
      }
      const [result] = validatePicks([pick], orbData, regime, 1, null);
      expect(`${regime}: min_rr = ${expectedMinRR[regime]}`, result.validation.checks.orb_alignment.min_rr, expectedMinRR[regime]);
    }
  }

  // ─── Test 17: Volume cumulative across 3 passes (detailed) ─────────────
  printHeader('TEST 17: Volume Cumulative Scaling — Detailed Pass-by-Pass');
  {
    // avg_vol_50d = 5M → expected per candle = 200K
    // Candle volumes: [80K, 250K, 300K]
    // Pass 1: 80K / 200K = 0.40 → FAIL
    // Pass 2: (80K+250K) / (200K*2) = 330K/400K = 0.83 → PASS
    // Pass 3: (80K+250K+300K) / (200K*3) = 630K/600K = 1.05 → PASS

    const volPass1 = makeVolumeMap('RELIANCE', [80000], 5_000_000);
    const volPass2 = makeVolumeMap('RELIANCE', [80000, 250000], 5_000_000);
    const volPass3 = makeVolumeMap('RELIANCE', [80000, 250000, 300000], 5_000_000);

    const [r1] = validatePicks([makePick()], makeOrbData('RELIANCE'), 'STRONG_BULL', 1, volPass1);
    const [r2] = validatePicks([makePick()], makeOrbData('RELIANCE', { high: 1265, low: 1243 }), 'STRONG_BULL', 2, volPass2);
    const [r3] = validatePicks([makePick()], makeOrbData('RELIANCE', { high: 1268, low: 1240 }), 'STRONG_BULL', 3, volPass3);

    expect('Pass 1: ratio=0.4, FAIL', r1.validation.checks.volume_check.passed, false);
    expect('Pass 1: candle_count=1', r1.validation.checks.volume_check.candle_count, 1);
    expect('Pass 2: ratio=0.83, PASS', r2.validation.checks.volume_check.passed, true);
    expect('Pass 2: candle_count=2', r2.validation.checks.volume_check.candle_count, 2);
    expect('Pass 3: ratio=1.05, PASS', r3.validation.checks.volume_check.passed, true);
    expect('Pass 3: candle_count=3', r3.validation.checks.volume_check.candle_count, 3);
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  printHeader('SUMMARY');
  console.log(`  Total: ${passed + failed} assertions`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log('═'.repeat(80));

  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test script crashed:', err);
  process.exit(1);
});
