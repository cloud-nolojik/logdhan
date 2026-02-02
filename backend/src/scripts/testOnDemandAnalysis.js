/**
 * Test script for On-Demand Analysis Service
 *
 * Tests the classification logic with various stock scenarios:
 * 1. Bullish setup (near 52W high) → should get scanType
 * 2. Downtrend (below 200 SMA) → should get quick reject
 * 3. Overbought (RSI > 72) → should get quick reject
 * 4. Pullback setup (at EMA20) → should get scanType
 *
 * Usage: node src/scripts/testOnDemandAnalysis.js
 */

import onDemandAnalysisService from '../services/onDemandAnalysisService.js';

const { classifyForAnalysis } = onDemandAnalysisService;

// Test scenarios
const testCases = [
  {
    name: 'Bullish - 52W Breakout',
    indicators: {
      price: 1000,
      ema20: 980,
      ema50: 950,
      sma200: 850,
      rsi: 65,
      weeklyRsi: 62,
      high52W: 1005 // Price within 0.5% of 52W high
    },
    expected: { isSetup: true, scanType: 'a_plus_momentum' }
  },
  {
    name: 'Bullish - Near 52W High',
    indicators: {
      price: 950,
      ema20: 930,
      ema50: 900,
      sma200: 800,
      rsi: 58,
      weeklyRsi: 55,
      high52W: 1000 // Price within 7% of 52W high
    },
    expected: { isSetup: true, scanType: 'breakout' }
  },
  {
    name: 'Bullish - Pullback to EMA20',
    indicators: {
      price: 500,
      ema20: 498, // Within 3%
      ema50: 480,
      sma200: 420,
      rsi: 52,
      weeklyRsi: 50,
      high52W: 600
    },
    expected: { isSetup: true, scanType: 'pullback' }
  },
  {
    name: 'Bullish - Momentum',
    indicators: {
      price: 800,
      ema20: 780,
      ema50: 750,
      sma200: 650,
      rsi: 60, // RSI >= 55
      weeklyRsi: 55,
      high52W: 950 // Not near 52W high, not at EMA20
    },
    expected: { isSetup: true, scanType: 'momentum' }
  },
  {
    name: 'NOT SETUP - Below 200 SMA (Downtrend)',
    indicators: {
      price: 400,
      ema20: 420,
      ema50: 450,
      sma200: 500, // Price below 200 SMA
      rsi: 45,
      weeklyRsi: 42,
      high52W: 600
    },
    expected: { isSetup: false, reason: 'below_200sma' }
  },
  {
    name: 'NOT SETUP - Weak Momentum (RSI < 35)',
    indicators: {
      price: 300,
      ema20: 310,
      ema50: 320,
      sma200: 280, // Above 200 SMA
      rsi: 28, // RSI < 35
      weeklyRsi: 32,
      high52W: 400
    },
    expected: { isSetup: false, reason: 'weak_momentum' }
  },
  {
    name: 'NOT SETUP - Trend Broken (Below both EMAs)',
    indicators: {
      price: 450,
      ema20: 480, // Price below EMA20
      ema50: 490, // Price below EMA50
      sma200: 400, // But above 200 SMA
      rsi: 45,
      weeklyRsi: 42,
      high52W: 550
    },
    expected: { isSetup: false, reason: 'trend_broken' }
  },
  {
    name: 'NOT SETUP - Weekly RSI Overbought',
    indicators: {
      price: 1000,
      ema20: 980,
      ema50: 950,
      sma200: 850,
      rsi: 68,
      weeklyRsi: 75, // Weekly RSI > 72
      high52W: 1010
    },
    expected: { isSetup: false, reason: 'overbought' }
  },
  {
    name: 'NOT SETUP - Daily RSI Overbought',
    indicators: {
      price: 1000,
      ema20: 980,
      ema50: 950,
      sma200: 850,
      rsi: 76, // Daily RSI > 72
      weeklyRsi: 65,
      high52W: 1010
    },
    expected: { isSetup: false, reason: 'overbought_daily' }
  },
  {
    name: 'Edge - Price exactly at 200 SMA',
    indicators: {
      price: 500,
      ema20: 510,
      ema50: 520,
      sma200: 500, // Price == 200 SMA
      rsi: 50,
      weeklyRsi: 48,
      high52W: 600
    },
    // Price is NOT below 200 SMA, but below both EMAs → trend_broken
    expected: { isSetup: false, reason: 'trend_broken' }
  },
  {
    name: 'Fallback - Consolidation Breakout',
    indicators: {
      price: 550,
      ema20: 600, // Price is 8% below EMA20 (outside pullback range)
      ema50: 520, // Price above EMA50
      sma200: 500, // Above 200 SMA
      rsi: 52, // RSI below 55
      weeklyRsi: 50,
      high52W: 700 // Not near 52W high (78%)
    },
    // Above 200 SMA and EMA50, but too far from EMA20 for pullback, RSI too low for momentum
    expected: { isSetup: true, scanType: 'consolidation_breakout' }
  }
];

// Run tests
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('🧪 ON-DEMAND ANALYSIS SERVICE - CLASSIFICATION TESTS');
console.log('═══════════════════════════════════════════════════════════════════\n');

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const result = classifyForAnalysis(testCase.indicators);

  const isSetupMatch = result.isSetup === testCase.expected.isSetup;
  const detailMatch = testCase.expected.isSetup
    ? result.scanType === testCase.expected.scanType
    : result.reason === testCase.expected.reason;

  const success = isSetupMatch && detailMatch;

  if (success) {
    passed++;
    console.log(`✅ ${testCase.name}`);
    if (result.isSetup) {
      console.log(`   → Bullish setup: ${result.scanType}`);
    } else {
      console.log(`   → Not a setup: ${result.reason}`);
    }
  } else {
    failed++;
    console.log(`❌ ${testCase.name}`);
    console.log(`   Expected: isSetup=${testCase.expected.isSetup}, ${testCase.expected.isSetup ? `scanType=${testCase.expected.scanType}` : `reason=${testCase.expected.reason}`}`);
    console.log(`   Got:      isSetup=${result.isSetup}, ${result.isSetup ? `scanType=${result.scanType}` : `reason=${result.reason}`}`);
    console.log(`   Message: ${result.message}`);
  }
  console.log('');
}

console.log('═══════════════════════════════════════════════════════════════════');
console.log(`📊 RESULTS: ${passed}/${testCases.length} passed, ${failed} failed`);
console.log('═══════════════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
