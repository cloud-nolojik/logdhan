/**
 * Test suite for NSE intraday trading window and time-to-target validation
 * 
 * Run with: node src/tests/intraday-validation-test.js
 */

import { aiReviewService } from '../services/ai/aiReview.service.js';

class IntradayValidationTest {
  constructor() {
    this.aiService = aiReviewService;
    this.testResults = [];
  }

  async runAllTests() {

    try {
      await this.testTradingWindowUpdate();
      await this.testMedianMoveCalculation();
      await this.testTimeToTargetValidation();
      await this.testMomentumCheck();

      this.printResults();

    } catch (error) {
      console.error('❌ Test suite failed:', error);
      process.exit(1);
    }
  }

  async testTradingWindowUpdate() {

    try {
      const termRule = this.aiService.TERM_RULES.intraday;

      const correctStart = termRule.tradeWindow.start === '09:15';
      const correctEnd = termRule.tradeWindow.end === '15:20';
      const correctTimezone = termRule.tradeWindow.timezone === 'IST';

      const success = correctStart && correctEnd && correctTimezone;

      this.logTestResult('NSE Trading Window', success,
      success ? `Updated to ${termRule.tradeWindow.start}-${termRule.tradeWindow.end} ${termRule.tradeWindow.timezone}` :
      `Still using old window: ${termRule.tradeWindow.start}-${termRule.tradeWindow.end}`);

    } catch (error) {
      this.logTestResult('NSE Trading Window', false, error.message);
    }
  }

  async testMedianMoveCalculation() {

    try {
      // Mock 1-minute candles (OHLC format)
      const mockCandles1m = [];
      for (let i = 0; i < 150; i++) {
        const basePrice = 100;
        const move = (Math.random() - 0.5) * 2; // Random move between -1 to +1
        mockCandles1m.push({
          open: basePrice,
          high: basePrice + Math.abs(move),
          low: basePrice - Math.abs(move),
          close: basePrice + move,
          volume: 1000
        });
      }

      const medianMove = this.aiService.calculateMedianMove1m(mockCandles1m, 120);

      const success = medianMove !== null && medianMove >= 0;

      this.logTestResult('Median Move Calculation', success,
      success ? `Calculated median move: ₹${medianMove.toFixed(4)} per minute` : 'Failed to calculate median move');

    } catch (error) {
      this.logTestResult('Median Move Calculation', false, error.message);
    }
  }

  async testTimeToTargetValidation() {

    try {
      // Mock trade data for late-day intraday trade
      const tradeData = {
        term: 'intraday',
        entryprice: '100.00',
        target: '105.00', // 5% target - likely unrealistic for late day
        stoploss: '98.00',
        direction: 'buy'
      };

      // Mock sentiment
      const sentiment = {
        shortTermSentiment: { score: 0.5 }
      };

      // Mock candle data with 1-minute interval - match the expected structure
      const candleData = {
        data: [
        {
          interval: '1minute', // Use the exact format the code looks for
          candles: []
        }]

      };

      // Generate mock 1-minute candles with low volatility  
      for (let i = 0; i < 150; i++) {
        candleData.data[0].candles.push([
        Date.now() - (150 - i) * 60000, // timestamp
        100 + (Math.random() - 0.5) * 0.02, // open - very small moves
        100.01 + (Math.random() - 0.5) * 0.02, // high  
        99.99 + (Math.random() - 0.5) * 0.02, // low
        100 + (Math.random() - 0.5) * 0.02, // close - very small moves
        1000 // volume
        ]);
      }

      const result = this.aiService.calculateConfidence(tradeData, sentiment, candleData);

      // Check if time-to-target validation is working
      const hasTimeValidation = result.validationIssues?.some((reason) =>
      reason.includes('Target unlikely') || reason.includes('median volatility')
      );

      this.logTestResult('Time-to-Target Validation', hasTimeValidation,
      hasTimeValidation ? 'Time-to-target validation working - detected unrealistic late-day target' :
      'Time-to-target validation not triggered (may be due to time window violation)');

    } catch (error) {
      this.logTestResult('Time-to-Target Validation', false, error.message);
    }
  }

  async testMomentumCheck() {

    try {
      // Mock flat market conditions
      const flatCandles = [];
      const basePrice = 100;

      for (let i = 0; i < 120; i++) {
        // Very narrow range - simulate flat market
        flatCandles.push([
        Date.now() - (120 - i) * 60000,
        basePrice,
        basePrice + 0.05, // tiny range
        basePrice - 0.05,
        basePrice + (Math.random() - 0.5) * 0.02,
        1000]
        );
      }

      const tradeData = {
        term: 'intraday',
        entryprice: '100.00',
        target: '101.00',
        stoploss: '99.50',
        direction: 'buy'
      };

      const sentiment = { shortTermSentiment: { score: 0.3 } };
      const candleData = {
        data: [{ interval: '1minute', candles: flatCandles }]
      };

      const result = this.aiService.calculateConfidence(tradeData, sentiment, candleData);

      const hasMomentumCheck = result.validationIssues?.some((reason) =>
      reason.includes('momentum absent') || reason.includes('Last 2h range')
      );

      this.logTestResult('Momentum Check', hasMomentumCheck,
      hasMomentumCheck ? 'Momentum check working - detected flat market conditions' :
      'Momentum check not triggered for flat market');

    } catch (error) {
      this.logTestResult('Momentum Check', false, error.message);
    }
  }

  logTestResult(testName, success, details) {
    const result = {
      test: testName,
      success,
      details,
      timestamp: new Date().toISOString()
    };

    this.testResults.push(result);

  }

  printResults() {

    const passed = this.testResults.filter((r) => r.success).length;
    const total = this.testResults.length;

    if (passed === total) {

    } else {

    }
  }
}

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const testSuite = new IntradayValidationTest();
  testSuite.runAllTests();
}

export { IntradayValidationTest };