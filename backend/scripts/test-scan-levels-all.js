/**
 * Comprehensive test for all daily scan archetypes in scanLevels.js
 *
 * Covers:
 *  - All 11 archetypes (LONG: breakout, pullback×2, momentum, consolidation,
 *    a_plus_momentum, fiftytwoweek_high / SHORT: breakdown, momentum_bearish,
 *    compression, failed_resistance, fiftytwoweek_low)
 *  - Target chain cascade (1H swing → hourlyR1/R2 → dailyR1/R2 → PDH/PDL → REJECT)
 *  - Guardrail rejections (risk >3%, reward <2%, R:R <1.2)
 *
 * Run: node --experimental-vm-modules backend/scripts/test-scan-levels-all.js
 */

import { calculateTradingLevels } from '../src/engine/scanLevels.js';
import { round2 } from '../src/engine/helpers.js';

const PASS = '✅';
const FAIL = '❌';

// ─────────────────────────────────────────────────────────────────────────────
// TEST CASE DEFINITIONS
// Each test specifies:
//   scan_type  — archetype passed to calculateTradingLevels
//   data       — scanData object (isIntraday: true always)
//   expect     — assertions to check on result
// ─────────────────────────────────────────────────────────────────────────────

const TESTS = [

  // ═══════════════════════════════════════════════════════════════════════════
  // BULLISH SCANS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'breakout — uses 1H swing resistance as target',
    scan_type: 'breakout',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 500,
      ema20: 495, ema50: 475,
      atr: 12,
      high20D: 520, low20D: 455,
      dailyR1: 540, dailyR2: 558,
      previousDayHigh: 510, previousDayLow: 490,
      weeklyR1: 570, weeklyR2: 595,
      hourlyR1: 530, hourlyR2: 545,
      // Swing zone well above entry (522.4) with >=2% reward
      resistanceZones: [{ midpoint: 536, strength: 3 }],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      // entry = 520 + 0.2×12 = 522.4, stop = 520 - 0.1×12 = 518.8
      entryAbove: 520,
      stopBelow: 522,
      targetAbove: 536,
      targetBasis: '1h_swing_resistance',
      minRR: 1.2
    }
  },

  {
    name: 'breakout — falls through to hourlyR1 when swing zone too close (<2% reward)',
    scan_type: 'breakout',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 500,
      ema20: 495, ema50: 475,
      atr: 12,
      high20D: 520, low20D: 455,
      dailyR1: 540, dailyR2: 558,
      previousDayHigh: 510, previousDayLow: 490,
      weeklyR1: 570, weeklyR2: 595,
      hourlyR1: 534, hourlyR2: 548,
      // Swing zone within 5% but too close for 2% reward
      resistanceZones: [{ midpoint: 524, strength: 3 }],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      targetBasis: 'hourly_r1',
      minRR: 1.2
    }
  },

  {
    name: 'breakout — falls to dailyR1 when no swing/hourly levels pass',
    scan_type: 'breakout',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 500,
      ema20: 495, ema50: 475,
      atr: 12,
      high20D: 520, low20D: 455,
      dailyR1: 545, dailyR2: 560,
      previousDayHigh: 510, previousDayLow: 490,
      weeklyR1: 570, weeklyR2: 595,
      hourlyR1: null, hourlyR2: null,
      resistanceZones: [],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      targetBasis: 'daily_r1',
      minRR: 1.2
    }
  },

  {
    name: 'breakout — REJECTED when no targets above entry pass guardrails',
    scan_type: 'breakout',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 500,
      ema20: 495, ema50: 475,
      atr: 12,
      high20D: 520, low20D: 455,
      // All pivots below entry or too close
      dailyR1: 521, dailyR2: 523,
      previousDayHigh: 510, previousDayLow: 490,
      weeklyR1: 522, weeklyR2: 524,
      hourlyR1: null, hourlyR2: null,
      resistanceZones: [],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: { valid: false }
  },

  {
    name: 'pullback (aggressive) — uses hourlyR1 when swing zone R:R too low',
    scan_type: 'pullback',
    data: {
      // Aggressive mode: prevClose == ema20, low volume, rsi healthy
      prevHigh: 500, prevLow: 490, prevClose: 495,
      ema20: 495, ema50: 485,
      atr: 12, rsi: 50,
      high20D: 520, low20D: 455, high52W: 580,
      dailyR1: 520, dailyR2: 538,
      previousDayHigh: 500, previousDayLow: 490,
      weeklyR1: 555, weeklyR2: 580,
      hourlyR1: 518, hourlyR2: 530,
      // Swing zone present but too close for 1.2:1 with entry ~493.8
      resistanceZones: [{ midpoint: 502, strength: 2 }],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      mode: 'PULLBACK_AGGRESSIVE',
      targetBasis: 'hourly_r1',
      minRR: 1.2
    }
  },

  {
    name: 'pullback (conservative) — closes below EMA20 triggers BUY_ABOVE',
    scan_type: 'pullback',
    data: {
      // Conservative: prevClose < ema20
      prevHigh: 490, prevLow: 482, prevClose: 484,
      ema20: 490, ema50: 485,
      atr: 4, rsi: 42,
      high20D: 510, low20D: 455, high52W: 560,
      dailyR1: 510, dailyR2: 525,
      previousDayHigh: 490, previousDayLow: 482,
      weeklyR1: 535, weeklyR2: 555,
      hourlyR1: 505, hourlyR2: 515,
      resistanceZones: [],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      mode: 'PULLBACK_CONSERVATIVE',
      minRR: 1.2
    }
  },

  {
    name: 'momentum — midpoint stop when PDL too far, 1H swing target',
    scan_type: 'momentum',
    data: {
      // Stock running 6.5% above EMA20, NOT near 20D high
      prevHigh: 495, prevLow: 472, prevClose: 490,
      ema20: 460, ema50: 445,
      atr: 12,
      high20D: 530, low20D: 440, high52W: 580,
      dailyR1: 525, dailyR2: 545,
      previousDayHigh: 495, previousDayLow: 472,
      weeklyR1: 555, weeklyR2: 580,
      hourlyR1: 510, hourlyR2: 522,
      // swing zone within 5% of entry (~496.8), >=2% reward
      resistanceZones: [{ midpoint: 516, strength: 3 }],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      mode: 'MOMENTUM',
      targetBasis: '1h_swing_resistance',
      minRR: 1.2
    }
  },

  {
    name: 'momentum — redirects to BREAKOUT when within 2% of 20D high',
    scan_type: 'momentum',
    data: {
      // prevClose within 2% of high20D → should redirect
      prevHigh: 512, prevLow: 490, prevClose: 504,
      ema20: 490, ema50: 475,
      atr: 12,
      high20D: 510, low20D: 455, high52W: 580,
      dailyR1: 540, dailyR2: 558,
      previousDayHigh: 512, previousDayLow: 490,
      weeklyR1: 570, weeklyR2: 595,
      hourlyR1: 534, hourlyR2: 548,
      resistanceZones: [{ midpoint: 536, strength: 3 }],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      mode: 'MOMENTUM_NEAR_BREAKOUT',
      minRR: 1.2
    }
  },

  {
    name: 'consolidation_breakout — narrow candle (NR7-style), 1H swing target',
    scan_type: 'consolidation_breakout',
    data: {
      // Tight range: prevHigh-prevLow = 10 (2% of 500), ATR=12 so range < ATR
      prevHigh: 506, prevLow: 496, prevClose: 501,
      ema20: 495, ema50: 480,
      atr: 12,
      high10D: 520, low10D: 480,
      high20D: 525, low20D: 460, high52W: 580,
      dailyR1: 528, dailyR2: 545,
      previousDayHigh: 506, previousDayLow: 496,
      weeklyR1: 560, weeklyR2: 585,
      hourlyR1: 520, hourlyR2: 534,
      resistanceZones: [{ midpoint: 526, strength: 3 }],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      mode: 'CONSOLIDATION_BREAKOUT',
      minRR: 1.2
    }
  },

  {
    name: 'a_plus_momentum — EMA20 stop fallback when PDL too far',
    scan_type: 'a_plus_momentum',
    data: {
      // Near 52W high, strong momentum
      prevHigh: 510, prevLow: 472, prevClose: 505,
      ema20: 505, ema50: 490,
      atr: 12,
      high20D: 510, low20D: 450, high52W: 515,
      dailyR1: 535, dailyR2: 555,
      previousDayHigh: 510, previousDayLow: 472,
      weeklyR1: 560, weeklyR2: 585,
      hourlyR1: 530, hourlyR2: 545,
      resistanceZones: [{ midpoint: 536, strength: 3 }],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      minRR: 1.2
    }
  },

  {
    name: 'fiftytwoweek_high — own target logic (dailyR1 → dailyR2 → 2.5×ATR)',
    scan_type: 'fiftytwoweek_high',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 500,
      ema20: 490, ema50: 475,
      atr: 12,
      high52W: 515,
      dailyR1: 518, dailyR2: 534,
      previousDayHigh: 510, previousDayLow: 490,
      weeklyR1: 545, weeklyR2: 565,
      hourlyR1: null, hourlyR2: null,
      resistanceZones: [],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      // entry = prevClose = 500, stop = prevLow×0.9985 ≈ 489.3, risk ≈ 10.7 (2.1%)
      // dailyR1=518: reward=18 (3.6%), rr=1.68 ✓
      minRR: 1.2
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // BEARISH SCANS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'breakdown_setup — uses 1H swing support as target',
    scan_type: 'breakdown_setup',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 492,
      ema20: 510, ema50: 525,
      atr: 12,
      low20D: 455, high5D: 505, high10D: 512,
      dailyS1: 472, dailyS2: 456,
      previousDayHigh: 510, previousDayLow: 490,
      weeklyS1: 465, weeklyS2: 448,
      hourlyS1: 482, hourlyS2: 470,
      supportZones: [{ midpoint: 474, strength: 3 }],
      resistanceZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'SHORT',
      // entry = 490 - 0.15×12 = 488.2, stop = 490 + 0.1×12 = 491.2
      // risk = 3.0 (0.61%), swing at 474: rr=4.73, reward=2.9% ✓
      targetBasis: '1h_swing_support',
      minRR: 1.2
    }
  },

  {
    name: 'breakdown_setup — stop uses prevLow (not low20D) — R:R sanity check',
    scan_type: 'breakdown_setup',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 492,
      ema20: 510, ema50: 525,
      atr: 12,
      // low20D << prevLow — old bug would use this as stop reference (stop < entry)
      low20D: 420, high5D: 505, high10D: 512,
      dailyS1: 472, dailyS2: 456,
      previousDayHigh: 510, previousDayLow: 490,
      weeklyS1: 465, weeklyS2: 448,
      hourlyS1: 482, hourlyS2: 470,
      supportZones: [{ midpoint: 474, strength: 3 }],
      resistanceZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'SHORT',
      // stop must be > entry (stop = prevLow + 0.1×ATR = 491.2, not low20D + ATR)
      stopAboveEntry: true,
      minRR: 1.2
    }
  },

  {
    name: 'momentum_carry_bearish — midpoint stop when PDH too far, 1H swing target',
    scan_type: 'momentum_carry_bearish',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 493,
      ema20: 520, ema50: 535,
      atr: 12,
      low20D: 460,
      dailyS1: 476, dailyS2: 460,
      previousDayHigh: 510, previousDayLow: 490,
      weeklyS1: 465, weeklyS2: 445,
      hourlyS1: 480, hourlyS2: 468,
      supportZones: [{ midpoint: 475, strength: 3 }],
      resistanceZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'SHORT',
      mode: 'MOMENTUM_BEARISH',
      minRR: 1.2
    }
  },

  {
    name: 'compression_bearish — narrow bearish candle, 1H swing target',
    scan_type: 'compression_bearish',
    data: {
      // Narrow range: prevHigh-prevLow = 10
      prevHigh: 506, prevLow: 496, prevClose: 498,
      ema20: 510, ema50: 520,
      atr: 12,
      high10D: 520, low10D: 480, low20D: 462,
      dailyS1: 478, dailyS2: 462,
      previousDayHigh: 506, previousDayLow: 496,
      weeklyS1: 468, weeklyS2: 450,
      hourlyS1: 484, hourlyS2: 472,
      // swing zone within 5% of entry (~494.8), >=2% reward
      supportZones: [{ midpoint: 474, strength: 3 }],
      resistanceZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'SHORT',
      minRR: 1.2
    }
  },

  {
    name: 'failed_at_resistance — uses 1H swing support as target',
    scan_type: 'failed_at_resistance',
    data: {
      // Rejected at resistance, stop = prevHigh × 1.0015
      prevHigh: 505, prevLow: 496, prevClose: 497,
      ema20: 505, ema50: 515,
      atr: 12,
      high20D: 520, low20D: 460,
      weeklyR1: 525, weeklyS1: 472, weeklyS2: 455,
      dailyS1: 476, dailyS2: 460,
      previousDayHigh: 505, previousDayLow: 496,
      weeklyR2: 545,
      hourlyS1: 484, hourlyS2: 470,
      // entry = 496-1.2=494.8, stop = 505×1.0015=505.76, risk=10.96 (2.2%)
      supportZones: [{ midpoint: 474, strength: 3 }],
      resistanceZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'SHORT',
      targetBasis: '1h_swing_support',
      minRR: 1.2
    }
  },

  {
    name: 'fiftytwoweek_low — own target logic (dailyS1 → dailyS2 → 2.5×ATR)',
    scan_type: 'fiftytwoweek_low',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 500,
      ema20: 510, ema50: 520,
      atr: 12,
      dailyS1: 480, dailyS2: 464,
      previousDayHigh: 510, previousDayLow: 490,
      weeklyS1: 468, weeklyS2: 450,
      hourlyS1: null, hourlyS2: null,
      supportZones: [],
      resistanceZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'SHORT',
      // entry = prevClose = 500, stop = prevHigh×1.0015 = 510.77, risk = 10.77 (2.15%)
      // dailyS1=480: reward=20 (4%), rr=1.86 ✓
      minRR: 1.2
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET CHAIN CASCADE TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'target chain — LONG: swing → hourlyR1 → hourlyR2 → dailyR1 cascade',
    scan_type: 'breakout',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 500,
      ema20: 495, ema50: 475,
      atr: 12,
      high20D: 520, low20D: 455,
      previousDayHigh: 510, previousDayLow: 490,
      weeklyR1: 570, weeklyR2: 595,
      // Put each level just barely too close to verify cascade
      hourlyR1: 523,    // just above entry 522.4, rr=0.17 < 1.2 → skip
      hourlyR2: 524,    // rr=0.44 < 1.2 → skip
      dailyR1: 545,     // rr=6.28 ✓, reward=4.4% ✓ → should land here
      dailyR2: 560,
      resistanceZones: [{ midpoint: 524, strength: 2 }],  // too close for 2% reward
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      targetBasis: 'daily_r1',
      minRR: 1.2
    }
  },

  {
    name: 'target chain — SHORT: swing → hourlyS1 → hourlyS2 → dailyS1 cascade',
    scan_type: 'breakdown_setup',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 492,
      ema20: 510, ema50: 525,
      atr: 12,
      low20D: 455, high5D: 505, high10D: 512,
      previousDayHigh: 510, previousDayLow: 490,
      weeklyS1: 465, weeklyS2: 448,
      // entry≈488.2: each level just inside entry but R:R fails
      hourlyS1: 487,   // 487 < entry 488.2 ✓, rr=1/3=0.33 < 1.2 → skip
      hourlyS2: 486,   // rr=0.67 < 1.2 → skip
      dailyS1: 472,    // rr=(488.2-472)/3=5.4 ✓, reward=3.3% ✓ → lands here
      dailyS2: 458,
      supportZones: [{ midpoint: 487, strength: 2 }],  // too close, rr fails
      resistanceZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'SHORT',
      targetBasis: 'daily_s1',
      minRR: 1.2
    }
  },

  {
    name: 'target chain — LONG: falls to PDH when all pivots fail R:R',
    scan_type: 'breakout',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 500,
      ema20: 495, ema50: 475,
      atr: 12,
      high20D: 520, low20D: 455,
      previousDayHigh: 548,  // far enough for reward ≥2%
      weeklyR1: 570, weeklyR2: 595,
      hourlyR1: null, hourlyR2: null,
      // Daily pivots below entry
      dailyR1: 510, dailyR2: 512,
      resistanceZones: [],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: {
      valid: true,
      direction: 'LONG',
      targetBasis: 'previous_day_high',
      minRR: 1.2
    }
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // GUARDRAIL REJECTION TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: 'guardrail — REJECTED: risk > 3% (consolidation wide candle)',
    scan_type: 'consolidation_breakout',
    data: {
      // Wide candle: range = 40 (8%), ATR = 12 → stop = prevLow - 1.2 = 458.8
      // entry = 505 + 1.2 = 506.2, risk = 47.4 (9.4%) → guardrail D rejects
      prevHigh: 505, prevLow: 460, prevClose: 483,
      ema20: 490, ema50: 475,
      atr: 12,
      high10D: 520, low10D: 455,
      dailyR1: 530, dailyR2: 548,
      previousDayHigh: 505, previousDayLow: 460,
      weeklyR1: 555, weeklyR2: 580,
      hourlyR1: 525, hourlyR2: 538,
      resistanceZones: [{ midpoint: 535, strength: 3 }],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: { valid: false }
  },

  {
    name: 'guardrail — REJECTED: R:R < 1.2 (target too close to entry)',
    scan_type: 'breakdown_setup',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 492,
      ema20: 510, ema50: 525,
      atr: 12,
      low20D: 455, high5D: 505, high10D: 512,
      // All targets very close to entry — R:R will fail even if reward% ok
      dailyS1: 487, dailyS2: 485,
      previousDayHigh: 510, previousDayLow: 487,
      weeklyS1: 486, weeklyS2: 484,
      hourlyS1: null, hourlyS2: null,
      supportZones: [],
      resistanceZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: { valid: false }
  },

  {
    name: 'guardrail — REJECTED: reward < 2% (target too close, below min reward)',
    scan_type: 'breakout',
    data: {
      prevHigh: 510, prevLow: 490, prevClose: 500,
      ema20: 495, ema50: 475,
      atr: 12,
      high20D: 520, low20D: 455,
      // All targets within 2% of entry (~522)
      dailyR1: 523, dailyR2: 528,
      previousDayHigh: 524,
      weeklyR1: 525, weeklyR2: 527,
      hourlyR1: 523, hourlyR2: 525,
      resistanceZones: [{ midpoint: 524, strength: 3 }],
      supportZones: [],
      isIntraday: true, minRR: 1.2
    },
    expect: { valid: false }
  },

];

// ─────────────────────────────────────────────────────────────────────────────
// TEST RUNNER
// ─────────────────────────────────────────────────────────────────────────────

function isShortScan(scanType) {
  return ['breakdown_setup', 'momentum_carry_bearish', 'failed_at_resistance',
          'compression_bearish', 'fiftytwoweek_low'].includes(scanType);
}

function runTest(test) {
  const result = calculateTradingLevels(test.scan_type, test.data);
  const { expect: ex } = test;
  const checks = [];

  // valid / rejected
  checks.push({
    name: 'valid',
    pass: result.valid === ex.valid,
    detail: `expected valid=${ex.valid}, got valid=${result.valid}${!result.valid ? ` (${result.reason})` : ''}`
  });

  if (!ex.valid) {
    // Rejection test — no further checks needed
    return { name: test.name, pass: checks.every(c => c.pass), checks, result };
  }

  if (!result.valid) {
    // Expected pass but got rejection — mark all remaining as failed
    return { name: test.name, pass: false, checks, result };
  }

  const short = isShortScan(test.scan_type);
  const { entry, stop, target2: target } = result;

  // stop direction
  if (short) {
    checks.push({
      name: 'stop > entry (SHORT)',
      pass: stop > entry,
      detail: `stop=${round2(stop)}, entry=${round2(entry)}`
    });
  } else {
    checks.push({
      name: 'stop < entry (LONG)',
      pass: stop < entry,
      detail: `stop=${round2(stop)}, entry=${round2(entry)}`
    });
  }

  // target direction
  if (short) {
    checks.push({
      name: 'target < entry (SHORT)',
      pass: target < entry,
      detail: `target=${round2(target)}, entry=${round2(entry)}`
    });
  } else {
    checks.push({
      name: 'target > entry (LONG)',
      pass: target > entry,
      detail: `target=${round2(target)}, entry=${round2(entry)}`
    });
  }

  // R:R
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  const rr = risk > 0 ? reward / risk : 0;
  checks.push({
    name: `R:R >= ${ex.minRR || 1.2}`,
    pass: rr >= (ex.minRR || 1.2),
    detail: `R:R=${round2(rr)}:1`
  });

  // mode
  if (ex.mode) {
    checks.push({
      name: `mode == ${ex.mode}`,
      pass: result.mode === ex.mode,
      detail: `got mode=${result.mode}`
    });
  }

  // target basis
  if (ex.targetBasis) {
    checks.push({
      name: `targetBasis == ${ex.targetBasis}`,
      pass: result.target2_basis === ex.targetBasis,
      detail: `got target2_basis=${result.target2_basis}`
    });
  }

  // entry above threshold
  if (ex.entryAbove !== undefined) {
    checks.push({
      name: `entry > ${ex.entryAbove}`,
      pass: entry > ex.entryAbove,
      detail: `entry=${round2(entry)}`
    });
  }

  // stop below threshold
  if (ex.stopBelow !== undefined) {
    checks.push({
      name: `stop < ${ex.stopBelow}`,
      pass: stop < ex.stopBelow,
      detail: `stop=${round2(stop)}`
    });
  }

  // stop above entry (SHORT specific sanity)
  if (ex.stopAboveEntry) {
    checks.push({
      name: 'stop > entry (breakdown stop fix)',
      pass: stop > entry,
      detail: `stop=${round2(stop)}, entry=${round2(entry)}`
    });
  }

  return {
    name: test.name,
    pass: checks.every(c => c.pass),
    checks,
    result
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '█'.repeat(80));
console.log('  SCAN LEVELS — FULL DAILY PICKS TEST SUITE');
console.log('█'.repeat(80));

const results = [];
for (const test of TESTS) {
  const r = runTest(test);
  results.push(r);

  const icon = r.pass ? PASS : FAIL;
  console.log(`\n${icon} ${r.name}`);

  if (!r.pass || process.env.VERBOSE) {
    r.checks.forEach(c => {
      const ci = c.pass ? '  ✓' : '  ✗';
      console.log(`${ci} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    });
    if (r.result.valid) {
      const { entry, stop, target, target2_basis, mode, riskPercent, riskReward } = r.result;
      console.log(`    entry=${round2(entry)} stop=${round2(stop)} target=${round2(target)} basis=${target2_basis} mode=${mode} risk=${riskPercent}% R:R=${riskReward}`);
    } else {
      console.log(`    rejected: ${r.result.reason}`);
    }
  }
}

// summary
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;

console.log('\n' + '─'.repeat(80));
console.log(`  ${passed}/${results.length} passed   ${failed} failed`);
console.log('─'.repeat(80));

if (failed > 0) {
  console.log('\nFailed tests:');
  results.filter(r => !r.pass).forEach(r => console.log(`  ${FAIL} ${r.name}`));
  process.exit(1);
} else {
  console.log('\n  All tests passed.');
}
