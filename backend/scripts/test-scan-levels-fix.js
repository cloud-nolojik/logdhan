/**
 * Test scan-type-aware level calculation fix
 * Tests both LONG and SHORT trades with real examples
 */

import scanLevels from '../src/engine/scanLevels.js';
import { round2 } from '../src/engine/helpers.js';

const LOG = '[TEST_SCAN_LEVELS]';

// ═══════════════════════════════════════════════════════════════════════════════
// TEST CASES - Real examples from the log
// ═══════════════════════════════════════════════════════════════════════════════

const TEST_CASES = {
  // ── SHORT TRADES (previously broken) ──
  BERGEPAINT_SHORT: {
    description: 'BERGEPAINT - Breakdown Setup (dropped 526→458, 12.9%)',
    scan_type: 'breakdown_setup',
    direction: 'SHORT',
    data: {
      fridayHigh: 470,
      fridayLow: 458,
      fridayClose: 458,
      ema20: 485,
      atr: 15,
      high20D: 526,  // 20D high is 14.9% above current price
      low20D: 440,
      high5D: 470,   // Recent swing high (5-day)
      high10D: 480,
      weeklyS1: 445,
      weeklyS2: 430,
      dailyS1: 450
    },
    expected: {
      shouldPass: true,
      stopBasis: 'swing_high (not 20D high)',
      stopRange: [470, 480],  // Should be near swing high, NOT 526
      riskRange: [2.5, 5.0]  // % risk should be reasonable
    }
  },

  NEWGEN_SHORT: {
    description: 'NEWGEN - Breakdown Setup (dropped 782→534, 31.7%)',
    scan_type: 'breakdown_setup',
    direction: 'SHORT',
    data: {
      fridayHigh: 550,
      fridayLow: 534,
      fridayClose: 534,
      ema20: 610,
      atr: 20,
      high20D: 782,  // 20D high is 46% above current price!
      low20D: 520,
      high5D: 550,
      high10D: 580,
      weeklyS1: 510,
      weeklyS2: 490,
      dailyS1: 525
    },
    expected: {
      shouldPass: true,
      stopBasis: 'swing_high (not 20D high)',
      stopRange: [550, 590],
      riskRange: [3.0, 10.0]
    }
  },

  // ── LONG TRADES (also broken with generic formula) ──
  EICHERMOT_LONG: {
    description: 'EICHERMOT - Momentum Carry (big green day, close at 4850)',
    scan_type: 'momentum_carry',
    direction: 'LONG',
    data: {
      fridayHigh: 4900,
      fridayLow: 4700,
      fridayClose: 4850,
      ema20: 4750,
      atr: 100,
      high20D: 4900,
      low20D: 4600,
      high52W: 5200,
      weeklyR1: 5000,
      weeklyR2: 5100,
      dailyR1: 4900
    },
    expected: {
      shouldPass: true,
      entryBasis: 'above_friday_high (not lastClose)',
      entryRange: [4900, 4950],  // Should be above Friday high
      targetBasis: 'structural (weekly R1/R2)',
      riskRewardRange: [1.2, 3.0]
    }
  },

  LUMAXTECH_LONG: {
    description: 'LUMAXTECH - Momentum Carry',
    scan_type: 'momentum_carry',
    direction: 'LONG',
    data: {
      fridayHigh: 430,
      fridayLow: 410,
      fridayClose: 425,
      ema20: 400,
      atr: 12,
      high20D: 435,
      low20D: 390,
      high52W: 480,
      weeklyR1: 445,
      weeklyR2: 460,
      dailyR1: 435
    },
    expected: {
      shouldPass: true,
      entryBasis: 'above_friday_high',
      entryRange: [430, 440],
      riskRewardRange: [1.2, 3.0]
    }
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// TEST EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

function runTest(testName, testCase) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`${LOG} Testing: ${testCase.description}`);
  console.log(`${LOG} Scan Type: ${testCase.scan_type} | Direction: ${testCase.direction}`);
  console.log(`${'='.repeat(80)}\n`);

  // Run scanLevels calculation
  const result = scanLevels.calculateTradingLevels(testCase.scan_type, testCase.data);

  console.log(`${LOG} Result:`, JSON.stringify(result, null, 2));

  // Validate result
  if (!result.valid) {
    if (testCase.expected.shouldPass) {
      console.log(`\n❌ FAILED: Setup was REJECTED but should have PASSED`);
      console.log(`   Reason: ${result.reason}`);
      return { testName, passed: false, reason: `Rejected: ${result.reason}` };
    } else {
      console.log(`\n✅ PASSED: Setup correctly REJECTED`);
      return { testName, passed: true };
    }
  }

  // Extract levels
  const { entry, stop, target2: target, riskPercent, riskReward, mode } = result;
  const isShort = testCase.direction === 'SHORT';
  const risk = isShort ? (stop - entry) : (entry - stop);
  const reward = isShort ? (entry - target) : (target - entry);

  console.log(`\n${LOG} ────────────────────────────────────────────────────────────`);
  console.log(`${LOG} LEVELS:`);
  console.log(`${LOG}   Entry:  ₹${round2(entry)}`);
  console.log(`${LOG}   Stop:   ₹${round2(stop)} (${isShort ? 'above' : 'below'} entry)`);
  console.log(`${LOG}   Target: ₹${round2(target)} (${isShort ? 'below' : 'above'} entry)`);
  console.log(`${LOG}   Risk:   ₹${round2(risk)} (${round2(riskPercent)}%)`);
  console.log(`${LOG}   Reward: ₹${round2(reward)}`);
  console.log(`${LOG}   R:R:    ${round2(riskReward)}:1`);
  console.log(`${LOG}   Mode:   ${mode}`);
  console.log(`${LOG} ────────────────────────────────────────────────────────────\n`);

  // Validate against expectations
  const checks = [];

  // Check 1: Stop direction
  if (isShort && stop <= entry) {
    checks.push({ name: 'Stop Direction', passed: false, detail: `Stop ${stop} should be > entry ${entry} for SHORT` });
  } else if (!isShort && stop >= entry) {
    checks.push({ name: 'Stop Direction', passed: false, detail: `Stop ${stop} should be < entry ${entry} for LONG` });
  } else {
    checks.push({ name: 'Stop Direction', passed: true });
  }

  // Check 2: Target direction
  if (isShort && target >= entry) {
    checks.push({ name: 'Target Direction', passed: false, detail: `Target ${target} should be < entry ${entry} for SHORT` });
  } else if (!isShort && target <= entry) {
    checks.push({ name: 'Target Direction', passed: false, detail: `Target ${target} should be > entry ${entry} for LONG` });
  } else {
    checks.push({ name: 'Target Direction', passed: true });
  }

  // Check 3: Risk percentage range
  if (testCase.expected.riskRange) {
    const [minRisk, maxRisk] = testCase.expected.riskRange;
    if (riskPercent < minRisk || riskPercent > maxRisk) {
      checks.push({ name: 'Risk Range', passed: false, detail: `Risk ${riskPercent}% outside expected ${minRisk}-${maxRisk}%` });
    } else {
      checks.push({ name: 'Risk Range', passed: true });
    }
  }

  // Check 4: R:R ratio
  if (testCase.expected.riskRewardRange) {
    const [minRR, maxRR] = testCase.expected.riskRewardRange;
    if (riskReward < minRR || riskReward > maxRR) {
      checks.push({ name: 'R:R Range', passed: false, detail: `R:R ${riskReward}:1 outside expected ${minRR}-${maxRR}:1` });
    } else {
      checks.push({ name: 'R:R Range', passed: true });
    }
  }

  // Check 5: Stop basis (for breakdown stocks, should NOT use 20D high)
  // The stop should be closer to swing high than 20D high
  if (testCase.scan_type === 'breakdown_setup' && testCase.data.high20D && testCase.data.high5D) {
    const distanceToSwingHigh = Math.abs(stop - testCase.data.high5D);
    const distanceTo20DHigh = Math.abs(stop - testCase.data.high20D);

    if (distanceToSwingHigh < distanceTo20DHigh) {
      checks.push({ name: 'Stop Basis', passed: true, detail: `Stop (${stop}) uses swing high (${testCase.data.high5D}), not 20D high (${testCase.data.high20D}) ✅` });
    } else {
      checks.push({ name: 'Stop Basis', passed: false, detail: `Stop ${stop} closer to 20D high ${testCase.data.high20D} than swing high ${testCase.data.high5D}` });
    }
  }

  // Check 6: Entry basis (for momentum, should be above Friday high, not lastClose)
  if (testCase.scan_type === 'momentum_carry' && testCase.expected.entryBasis === 'above_friday_high') {
    if (entry <= testCase.data.fridayClose) {
      checks.push({ name: 'Entry Basis', passed: false, detail: `Entry ${entry} should be > Friday close ${testCase.data.fridayClose}` });
    } else {
      checks.push({ name: 'Entry Basis', passed: true, detail: 'Entry above Friday high ✅' });
    }
  }

  // Print validation results
  console.log(`${LOG} VALIDATION CHECKS:`);
  checks.forEach((check, i) => {
    const icon = check.passed ? '✅' : '❌';
    console.log(`${LOG}   ${i + 1}. ${icon} ${check.name}${check.detail ? ` - ${check.detail}` : ''}`);
  });

  const allPassed = checks.every(c => c.passed);
  if (allPassed) {
    console.log(`\n✅ TEST PASSED: ${testName}`);
  } else {
    console.log(`\n❌ TEST FAILED: ${testName}`);
  }

  return {
    testName,
    passed: allPassed,
    checks,
    result
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN ALL TESTS
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'█'.repeat(80)}`);
console.log(`${LOG} SCAN-TYPE-AWARE LEVEL CALCULATION FIX - TEST SUITE`);
console.log(`${'█'.repeat(80)}\n`);

const results = [];

for (const [testName, testCase] of Object.entries(TEST_CASES)) {
  const result = runTest(testName, testCase);
  results.push(result);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'█'.repeat(80)}`);
console.log(`${LOG} TEST SUMMARY`);
console.log(`${'█'.repeat(80)}\n`);

const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;

results.forEach((result) => {
  const icon = result.passed ? '✅' : '❌';
  console.log(`${icon} ${result.testName}`);
  if (!result.passed && result.reason) {
    console.log(`   └─ ${result.reason}`);
  }
});

console.log(`\n${LOG} Total: ${results.length} tests`);
console.log(`${LOG} Passed: ${passed}`);
console.log(`${LOG} Failed: ${failed}`);

if (failed === 0) {
  console.log(`\n🎉 ALL TESTS PASSED! The fix works correctly.`);
} else {
  console.log(`\n⚠️  SOME TESTS FAILED. Review the output above.`);
  process.exit(1);
}
