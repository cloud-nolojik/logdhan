#!/usr/bin/env node

/**
 * Quick AI Model Testing Script
 * 
 * Tests a few key model combinations to find optimal setups
 */

import axios from 'axios';

// Configuration - UPDATE THESE VALUES
const API_BASE_URL = 'http://localhost:3000'; // Your backend URL
const AUTH_TOKEN = 'your_jwt_token_here'; // Get from login response

// Cost-efficient model combinations to test
const TEST_COMBINATIONS = [
  // Ultra low cost
  { sentiment: 'gpt-5-nano', analysis: 'gpt-5-nano', name: 'Ultra Low Cost' },
  { sentiment: 'gpt-4.1-nano', analysis: 'gpt-4.1-mini', name: 'Low Cost' },
  
  // Balanced cost/performance
  { sentiment: 'gpt-4o-mini', analysis: 'o1-mini', name: 'Balanced' },
  { sentiment: 'gpt-4o-mini', analysis: 'o3-mini', name: 'Balanced Alt' },
  
  // Higher performance
  { sentiment: 'gpt-4o-mini', analysis: 'o4-mini', name: 'Performance' },
  { sentiment: 'gpt-5-mini', analysis: 'gpt-5', name: 'High Performance' },
];

// Test trades
const TEST_TRADES = {
  intraday: {
    instrument_key: "NSE_EQ|INE002A01018",
    direction: "BUY",
    quantity: 100,
    term: "intraday",
    entryPrice: 1370,
    targetPrice: 1395,
    stopLoss: 1350,
    note: "Test intraday trade",
    needsReview: true
  },
  short: {
    instrument_key: "NSE_EQ|INE002A01018", 
    direction: "BUY",
    quantity: 100,
    term: "short",
    entryPrice: 1370,
    targetPrice: 1450,
    stopLoss: 1330,
    note: "Test short-term trade",
    needsReview: true
  },
  medium: {
    instrument_key: "NSE_EQ|INE002A01018",
    direction: "BUY", 
    quantity: 100,
    term: "medium",
    entryPrice: 1370,
    targetPrice: 1480,
    stopLoss: 1310,
    note: "Test medium-term trade",
    needsReview: true
  }
};

class QuickTester {
  constructor() {
    this.results = [];
  }

  async testCombination(combo, tradeTerm) {
    console.log(`\n🔬 Testing: ${combo.name} on ${tradeTerm} trade`);
    console.log(`   Sentiment: ${combo.sentiment}`);
    console.log(`   Analysis: ${combo.analysis}`);

    const tradeData = {
      ...TEST_TRADES[tradeTerm],
      sentimentModel: combo.sentiment,
      analysisModel: combo.analysis
    };

    try {
      // Create trade
      console.log('📡 Creating trade...');
      const response = await axios.post(`${API_BASE_URL}/api/stockLog`, tradeData, {
        headers: {
          'Authorization': `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      if (!response.data.success) {
        throw new Error('Trade creation failed');
      }

      const logId = response.data.data._id;
      console.log(`✅ Trade created: ${logId}`);

      // Wait for review
      console.log('⏳ Waiting for AI review...');
      const reviewResult = await this.waitForReview(logId);

      const result = {
        combination: combo.name,
        tradeTerm,
        sentimentModel: combo.sentiment,
        analysisModel: combo.analysis,
        success: reviewResult.success,
        logId,
        reviewData: reviewResult.data,
        timestamp: new Date().toISOString()
      };

      if (reviewResult.success) {
        console.log(`✅ Review completed:`);
        console.log(`   Status: ${reviewResult.data.reviewStatus || 'N/A'}`);
        console.log(`   Verdict: ${reviewResult.data.verdict || 'N/A'}`);
        console.log(`   Recommendation: ${reviewResult.data.recommendation || 'N/A'}`);
        console.log(`   Confidence: ${reviewResult.data.confidence || 'N/A'}`);
        console.log(`   Risk Level: ${reviewResult.data.riskLevel || 'N/A'}`);
        console.log(`   Analysis Valid: ${reviewResult.data.isAnalysisCorrect || 'N/A'}`);
      } else {
        console.log(`❌ Review failed: ${reviewResult.error}`);
      }

      this.results.push(result);
      return result;

    } catch (error) {
      console.log(`❌ Test failed: ${error.message}`);
      const result = {
        combination: combo.name,
        tradeTerm,
        sentimentModel: combo.sentiment,
        analysisModel: combo.analysis,
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
      this.results.push(result);
      return result;
    }
  }

  async waitForReview(logId, timeout = 120000) {
    const startTime = Date.now();
    const pollInterval = 5000;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await axios.get(`${API_BASE_URL}/api/stockLog/${logId}/review-status`, {
          headers: {
            'Authorization': `Bearer ${AUTH_TOKEN}`
          }
        });

        if (response.data?.data?.isReviewCompleted) {
          return {
            success: true,
            data: response.data.data
          };
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error) {
        console.log(`⚠️ Error checking status: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    return {
      success: false,
      error: 'Timeout waiting for review'
    };
  }

  async runAllTests() {
    console.log('🚀 Starting quick model tests...\n');
    
    const totalTests = TEST_COMBINATIONS.length * Object.keys(TEST_TRADES).length;
    console.log(`📊 Running ${totalTests} tests total`);

    let testCount = 0;
    for (const combo of TEST_COMBINATIONS) {
      for (const tradeTerm of Object.keys(TEST_TRADES)) {
        testCount++;
        console.log(`\n📈 Progress: ${testCount}/${totalTests} (${((testCount/totalTests) * 100).toFixed(1)}%)`);
        
        await this.testCombination(combo, tradeTerm);
        
        // Short delay between tests
        if (testCount < totalTests) {
          console.log('⏸️ Waiting 3 seconds before next test...');
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
    }

    console.log('\n🏁 All tests completed!');
    this.showResults();
  }

  showResults() {
    console.log('\n📊 TEST RESULTS SUMMARY\n');
    console.log('='.repeat(60));

    const successful = this.results.filter(r => r.success);
    const failed = this.results.filter(r => !r.success);

    console.log(`✅ Successful: ${successful.length}`);
    console.log(`❌ Failed: ${failed.length}`);
    console.log(`📈 Success Rate: ${((successful.length / this.results.length) * 100).toFixed(1)}%\n`);

    // Group by combination
    const byCombo = {};
    successful.forEach(result => {
      if (!byCombo[result.combination]) {
        byCombo[result.combination] = [];
      }
      byCombo[result.combination].push(result);
    });

    console.log('🏆 PERFORMANCE BY COMBINATION:\n');
    Object.entries(byCombo).forEach(([combo, results]) => {
      console.log(`${combo}:`);
      console.log(`  Models: ${results[0].sentimentModel} + ${results[0].analysisModel}`);
      console.log(`  Tests: ${results.length}/3`);
      
      if (results.length > 0) {
        const avgConfidence = results
          .filter(r => r.reviewData?.confidence)
          .reduce((sum, r) => sum + r.reviewData.confidence, 0) / 
          results.filter(r => r.reviewData?.confidence).length;
        
        if (!isNaN(avgConfidence)) {
          console.log(`  Avg Confidence: ${avgConfidence.toFixed(2)}`);
        }

        console.log(`  Results:`);
        results.forEach(r => {
          const verdict = r.reviewData?.verdict || 'N/A';
          const confidence = r.reviewData?.confidence || 'N/A';
          const riskLevel = r.reviewData?.riskLevel || 'N/A';
          const valid = r.reviewData?.isAnalysisCorrect || 'N/A';
          console.log(`    ${r.tradeTerm}: ${verdict} | Conf:${confidence} | Risk:${riskLevel} | Valid:${valid}`);
        });
      }
      console.log('');
    });

    // Show failed tests
    if (failed.length > 0) {
      console.log('❌ FAILED TESTS:\n');
      failed.forEach(result => {
        console.log(`${result.combination} - ${result.tradeTerm}: ${result.error}`);
      });
      console.log('');
    }

    console.log('💡 RECOMMENDATIONS:\n');
    
    // Find best combination by success rate and confidence
    const bestCombos = Object.entries(byCombo)
      .filter(([, results]) => results.length === 3) // All tests passed
      .sort(([,a], [,b]) => {
        const avgConfA = a.reduce((sum, r) => sum + (r.reviewData?.confidence || 0), 0) / a.length;
        const avgConfB = b.reduce((sum, r) => sum + (r.reviewData?.confidence || 0), 0) / b.length;
        return avgConfB - avgConfA;
      });

    if (bestCombos.length > 0) {
      const [bestName, bestResults] = bestCombos[0];
      console.log(`🥇 Best Overall: ${bestName}`);
      console.log(`   Sentiment Model: ${bestResults[0].sentimentModel}`);
      console.log(`   Analysis Model: ${bestResults[0].analysisModel}`);
      
      const avgConf = bestResults.reduce((sum, r) => sum + (r.reviewData?.confidence || 0), 0) / bestResults.length;
      console.log(`   Average Confidence: ${avgConf.toFixed(2)}`);
    } else {
      console.log('No combination passed all tests. Check failed tests above.');
    }

    console.log('\n📋 Next Steps:');
    console.log('1. Analyze the results above');
    console.log('2. Check your database for detailed cost information in apiCosts field');
    console.log('3. Update your service configuration with the best models');
    console.log('4. Run focused tests on promising combinations');
  }
}

// Validation function
function validateConfig() {
  if (AUTH_TOKEN === 'your_jwt_token_here') {
    console.error('❌ Error: Please update AUTH_TOKEN with your actual JWT token');
    console.log('\n📝 To get your JWT token:');
    console.log('1. Login to your app');
    console.log('2. Check the login response for the token');
    console.log('3. Update AUTH_TOKEN in this script');
    process.exit(1);
  }

  if (API_BASE_URL.includes('localhost') && !process.env.NODE_ENV) {
    console.log('🔍 Using localhost - make sure your backend is running on port 3000');
  }
}

// Main execution
async function main() {
  validateConfig();
  
  const tester = new QuickTester();
  await tester.runAllTests();
}

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\n🛑 Tests interrupted by user');
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('💥 Script failed:', error.message);
    process.exit(1);
  });
}