#!/usr/bin/env node

/**
 * AI Model Testing Script for Stock Analysis
 * 
 * This script tests different AI models against various trade scenarios
 * to find the optimal model combinations for different trading terms
 * and user experience levels.
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const API_BASE_URL = 'https://legislation-injection-tr-europe.trycloudflare.com'; // Update with your actual API URL
const AUTH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4NzYxODBhNjI1ODQ1YjliNDdkZDkxYyIsImlhdCI6MTc1NDU0Njk1MywiZXhwIjoxNzU1MTUxNzUzfQ.cjzG3zqnuOGReANCHcpkR_P6Z6iORddjkOpKQFeGG6s'; // Update with actual JWT token

// Test models to evaluate
const TEST_MODELS = {
  sentiment: [
    'gpt-5-mini',
    // 'o4-mini-deep-research'
  ],
  analysis: [
    //'gpt-5',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-4o',
    'gpt-4o-mini',
    'o3',
    'o4-mini',
    'o4-mini-deep-research',
    'o3-mini',
    'o1-mini'
  ]
};

// User experience levels to test
const USER_EXPERIENCE_LEVELS = ['beginner', 'intermediate', 'advanced'];

// Test trade scenarios
const TEST_TRADES = {
  intraday: {
    id: null,
    instrument_key: "NSE_EQ|INE002A01018",
    direction: "BUY",
    quantity: 100,
    term: "intraday",
    entryPrice: 1370,
    targetPrice: 1395,
    stopLoss: 1350,
    note: "Intraday momentum trade on breakout above resistance",
    tags: [],
    needsReview: true,
    createdAt: null,
    reviewStatus: null,
    reviewResult: null
  },
  short: {
    id: null,
    instrument_key: "NSE_EQ|INE002A01018",
    direction: "BUY",
    quantity: 100,
    term: "short",
    entryPrice: 1370,
    targetPrice: 1450,
    stopLoss: 1330,
    note: "Short-term swing trade expecting bullish momentum",
    tags: [],
    needsReview: true,
    createdAt: null,
    reviewStatus: null,
    reviewResult: null
  },
  medium: {
    id: null,
    instrument_key: "NSE_EQ|INE002A01018",
    direction: "BUY",
    quantity: 100,
    term: "medium",
    entryPrice: 1370,
    targetPrice: 1480,
    stopLoss: 1310,
    note: "Medium-term position trade based on fundamentals",
    tags: [],
    needsReview: true,
    createdAt: null,
    reviewStatus: null,
    reviewResult: null
  }
};

class ModelTester {
  constructor() {
    this.results = [];
    this.startTime = new Date();
    this.testCounter = 0;
    this.totalTests = 0;
  }

  /**
   * Calculate total number of tests
   */
  calculateTotalTests() {
    this.totalTests = Object.keys(TEST_TRADES).length * 
                     TEST_MODELS.sentiment.length * 
                     TEST_MODELS.analysis.length * 
                     USER_EXPERIENCE_LEVELS.length;
    console.log(`🧪 Total tests to run: ${this.totalTests}`);
  }

  /**
   * Make API request to create trade log with specific models
   */
  async makeTradeRequest(tradeData, sentimentModel, analysisModel, userLevel) {
    try {
      const requestPayload = {
        ...tradeData,
        sentimentModel,
        analysisModel,
        userExperienceLevel: userLevel // This might need to be handled differently based on your auth system
      };

      console.log(`📡 Testing: ${tradeData.term} | ${sentimentModel} + ${analysisModel} | ${userLevel} level`);

      const response = await axios.post(`${API_BASE_URL}/api/v1/stocklog`, requestPayload, {
        headers: {
          'Authorization': `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 120000 // 2 minutes timeout
      });

      return {
        success: true,
        data: response.data,
        logId: response.data?.data?._id
      };
    } catch (error) {
      console.error(`❌ API Error:`, error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data || error.message,
        logId: null
      };
    }
  }

  /**
   * Wait for review completion and fetch results
   */
  async waitForReviewCompletion(logId, timeout = 180000) { // 3 minutes timeout
    const startTime = Date.now();
    const pollInterval = 5000; // 5 seconds

    while (Date.now() - startTime < timeout) {
      try {
        const response = await axios.get(`${API_BASE_URL}/api/v1/stocklog/${logId}/review-status`, {
          headers: {
            'Authorization': `Bearer ${AUTH_TOKEN}`
          }
        });

        if (response.data?.data?.isReviewCompleted) {
          return {
            success: true,
            reviewData: response.data.data
          };
        }

        console.log(`⏳ Waiting for review completion... (${Math.round((Date.now() - startTime) / 1000)}s)`);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error) {
        console.warn(`⚠️ Error checking review status:`, error.message);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    return {
      success: false,
      error: 'Timeout waiting for review completion'
    };
  }

  /**
   * Run a single test combination
   */
  async runSingleTest(tradeTerm, sentimentModel, analysisModel, userLevel) {
    this.testCounter++;
    const testId = `${tradeTerm}_${sentimentModel}_${analysisModel}_${userLevel}`;
    
    console.log(`\n🔬 Test ${this.testCounter}/${this.totalTests}: ${testId}`);
    console.log(`📊 Progress: ${((this.testCounter / this.totalTests) * 100).toFixed(1)}%`);

    const startTime = Date.now();
    const tradeData = TEST_TRADES[tradeTerm];

    // Step 1: Create trade log
    const apiResult = await this.makeTradeRequest(tradeData, sentimentModel, analysisModel, userLevel);
    
    if (!apiResult.success) {
      const result = {
        testId,
        tradeTerm,
        sentimentModel,
        analysisModel,
        userLevel,
        success: false,
        error: apiResult.error,
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString()
      };
      this.results.push(result);
      return result;
    }

    // Step 2: Wait for review completion
    console.log(`⏳ Waiting for AI review completion for log: ${apiResult.logId}`);
    const reviewResult = await this.waitForReviewCompletion(apiResult.logId);

    const result = {
      testId,
      tradeTerm,
      sentimentModel,
      analysisModel,
      userLevel,
      success: reviewResult.success,
      logId: apiResult.logId,
      apiResponse: apiResult.data,
      reviewData: reviewResult.reviewData || null,
      error: reviewResult.error || null,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString()
    };

    this.results.push(result);
    
    console.log(`✅ Test completed in ${(result.duration / 1000).toFixed(1)}s`);
    if (reviewResult.success) {
      console.log(`📈 Review: ${reviewResult.reviewData?.recommendation || 'N/A'} | Confidence: ${reviewResult.reviewData?.confidence || 'N/A'}`);
    }

    return result;
  }

  /**
   * Run all test combinations
   */
  async runAllTests() {
    console.log('🚀 Starting comprehensive AI model testing...\n');
    this.calculateTotalTests();

    for (const tradeTerm of Object.keys(TEST_TRADES)) {
      for (const sentimentModel of TEST_MODELS.sentiment) {
        for (const analysisModel of TEST_MODELS.analysis) {
          for (const userLevel of USER_EXPERIENCE_LEVELS) {
            try {
              await this.runSingleTest(tradeTerm, sentimentModel, analysisModel, userLevel);
              
              // Add delay between tests to avoid overwhelming the API
              await new Promise(resolve => setTimeout(resolve, 2000));
            } catch (error) {
              console.error(`💥 Test failed:`, error.message);
              const errorResult = {
                testId: `${tradeTerm}_${sentimentModel}_${analysisModel}_${userLevel}`,
                tradeTerm,
                sentimentModel,
                analysisModel,
                userLevel,
                success: false,
                error: error.message,
                duration: 0,
                timestamp: new Date().toISOString()
              };
              this.results.push(errorResult);
            }
          }
        }
      }
    }

    console.log('\n🏁 All tests completed!');
    this.generateReport();
  }

  /**
   * Generate comprehensive test report
   */
  generateReport() {
    const endTime = new Date();
    const totalDuration = endTime - this.startTime;

    console.log('\n📊 GENERATING TEST REPORT...\n');

    // Basic statistics
    const successful = this.results.filter(r => r.success).length;
    const failed = this.results.filter(r => !r.success).length;

    console.log(`📈 Test Summary:`);
    console.log(`   Total Tests: ${this.results.length}`);
    console.log(`   Successful: ${successful}`);
    console.log(`   Failed: ${failed}`);
    console.log(`   Success Rate: ${((successful / this.results.length) * 100).toFixed(1)}%`);
    console.log(`   Total Duration: ${(totalDuration / 1000 / 60).toFixed(1)} minutes\n`);

    // Performance analysis
    this.analyzePerformance();

    // Cost analysis
    this.analyzeCosts();

    // Save detailed results
    this.saveResults();
  }

  /**
   * Analyze model performance
   */
  analyzePerformance() {
    console.log(`🎯 Performance Analysis:\n`);

    // Group by model combinations
    const modelCombinations = {};
    this.results.filter(r => r.success).forEach(result => {
      const key = `${result.sentimentModel} + ${result.analysisModel}`;
      if (!modelCombinations[key]) {
        modelCombinations[key] = {
          tests: 0,
          avgConfidence: 0,
          avgDuration: 0,
          recommendations: {}
        };
      }
      
      modelCombinations[key].tests++;
      modelCombinations[key].avgDuration += result.duration;
      
      if (result.reviewData?.confidence) {
        modelCombinations[key].avgConfidence += result.reviewData.confidence;
      }
      
      if (result.reviewData?.recommendation) {
        const rec = result.reviewData.recommendation;
        modelCombinations[key].recommendations[rec] = (modelCombinations[key].recommendations[rec] || 0) + 1;
      }
    });

    // Calculate averages and sort by performance
    Object.keys(modelCombinations).forEach(key => {
      const combo = modelCombinations[key];
      combo.avgConfidence = combo.avgConfidence / combo.tests;
      combo.avgDuration = combo.avgDuration / combo.tests;
    });

    // Sort by confidence
    const sortedCombos = Object.entries(modelCombinations)
      .sort(([,a], [,b]) => b.avgConfidence - a.avgConfidence)
      .slice(0, 10); // Top 10

    console.log(`🏆 Top 10 Model Combinations by Confidence:`);
    sortedCombos.forEach(([combo, stats], index) => {
      console.log(`   ${index + 1}. ${combo}`);
      console.log(`      Avg Confidence: ${stats.avgConfidence.toFixed(2)}`);
      console.log(`      Avg Duration: ${(stats.avgDuration / 1000).toFixed(1)}s`);
      console.log(`      Tests: ${stats.tests}\n`);
    });
  }

  /**
   * Analyze costs (placeholder - would need actual cost data)
   */
  analyzeCosts() {
    console.log(`💰 Cost Analysis:\n`);
    console.log(`   Note: Cost analysis requires actual API cost tracking data from logs.`);
    console.log(`   Check the database apiCosts field for detailed cost breakdowns.\n`);
  }

  /**
   * Save results to files
   */
  saveResults() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultsDir = path.join(__dirname, 'test-results');
    
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    // Save raw results as JSON
    const jsonFile = path.join(resultsDir, `model-test-results-${timestamp}.json`);
    fs.writeFileSync(jsonFile, JSON.stringify(this.results, null, 2));
    
    // Save summary as CSV
    const csvFile = path.join(resultsDir, `model-test-summary-${timestamp}.csv`);
    this.saveResultsAsCSV(csvFile);
    
    console.log(`💾 Results saved:`);
    console.log(`   JSON: ${jsonFile}`);
    console.log(`   CSV: ${csvFile}\n`);
  }

  /**
   * Save results as CSV
   */
  saveResultsAsCSV(filename) {
    const headers = [
      'TestID',
      'TradeTerm',
      'SentimentModel', 
      'AnalysisModel',
      'UserLevel',
      'Success',
      'Duration(ms)',
      'Confidence',
      'Recommendation',
      'RiskLevel',
      'Error',
      'Timestamp'
    ];

    const rows = this.results.map(result => [
      result.testId,
      result.tradeTerm,
      result.sentimentModel,
      result.analysisModel,
      result.userLevel,
      result.success,
      result.duration,
      result.reviewData?.confidence || '',
      result.reviewData?.recommendation || '',
      result.reviewData?.riskLevel || '',
      result.error || '',
      result.timestamp
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    fs.writeFileSync(filename, csvContent);
  }

  /**
   * Run focused tests on specific model combinations
   */
  async runFocusedTests(combinations) {
    console.log('🎯 Running focused tests on specific model combinations...\n');
    
    this.totalTests = combinations.length * Object.keys(TEST_TRADES).length * USER_EXPERIENCE_LEVELS.length;
    console.log(`🧪 Total focused tests: ${this.totalTests}`);

    for (const combo of combinations) {
      for (const tradeTerm of Object.keys(TEST_TRADES)) {
        for (const userLevel of USER_EXPERIENCE_LEVELS) {
          try {
            await this.runSingleTest(tradeTerm, combo.sentiment, combo.analysis, userLevel);
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (error) {
            console.error(`💥 Focused test failed:`, error.message);
          }
        }
      }
    }

    console.log('\n🏁 Focused tests completed!');
    this.generateReport();
  }
}

// Example focused test combinations (cost-efficient models)
const FOCUSED_COMBINATIONS = [
  { sentiment: 'gpt-4o-mini', analysis: 'o1-mini' },
  { sentiment: 'gpt-5-nano', analysis: 'o3-mini' },
  { sentiment: 'gpt-4.1-nano', analysis: 'gpt-4.1-mini' },
  { sentiment: 'o3-mini', analysis: 'o4-mini' }
];

// Main execution
async function main() {
  const tester = new ModelTester();
  
  // Check command line arguments
  const args = process.argv.slice(2);
  
  if (args.includes('--focused')) {
    await tester.runFocusedTests(FOCUSED_COMBINATIONS);
  } else if (args.includes('--help')) {
    console.log(`
AI Model Testing Script Usage:

node model-testing-script.js [options]

Options:
  --focused    Run focused tests on cost-efficient model combinations
  --help       Show this help message

Before running:
1. Update API_BASE_URL with your backend URL
2. Update AUTH_TOKEN with a valid JWT token
3. Ensure your backend is running
4. Make sure you have sufficient credits for AI reviews

The script will test different model combinations and generate:
- Detailed JSON results file
- CSV summary for analysis
- Console performance report
    `);
  } else {
    console.log(`
⚠️  WARNING: This will run ${tester.calculateTotalTests() || 'many'} API calls.
    This may consume significant credits and time.
    
    Use --focused for a smaller test set.
    Use --help for usage information.
    
    Press Ctrl+C to cancel, or wait 10 seconds to continue...
    `);
    
    await new Promise(resolve => setTimeout(resolve, 10000));
    await tester.runAllTests();
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n🛑 Test interrupted by user');
  process.exit(0);
});

// Run if called directly
if (process.argv[1] === __filename) {
  main().catch(console.error);
}

export default ModelTester;