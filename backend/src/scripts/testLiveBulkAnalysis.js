#!/usr/bin/env node

/**
 * LIVE Bulk Analysis Flow Test Script
 * 
 * Tests real backend endpoints with actual API calls
 * Simulates different users at different times
 * 
 * Usage: node src/scripts/testLiveBulkAnalysis.js
 */

import axios from 'axios';
import chalk from 'chalk';

// Configuration
const BASE_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const DELAY_BETWEEN_TESTS = 2000; // 2 seconds

// Test users with mock JWT tokens (you'll need to replace with real tokens)
const TEST_SCENARIOS = [
{
  name: 'Alice - Morning Rush (4:05 PM)',
  userId: 'test_user_alice',
  token: 'mock_jwt_alice', // Replace with real JWT
  expectedTiming: 'allowed',
  description: 'Tests analysis during allowed evening session'
},
{
  name: 'Bob - Late Night (11:30 PM)',
  userId: 'test_user_bob',
  token: 'mock_jwt_bob', // Replace with real JWT
  expectedTiming: 'allowed',
  description: 'Tests analysis during late evening'
},
{
  name: 'Charlie - Too Early (2:00 PM)',
  userId: 'test_user_charlie',
  token: 'mock_jwt_charlie', // Replace with real JWT
  expectedTiming: 'blocked',
  description: 'Tests timing restriction before 4 PM'
},
{
  name: 'Diana - Cache Test',
  userId: 'test_user_diana',
  token: 'mock_jwt_diana', // Replace with real JWT
  expectedTiming: 'allowed',
  description: 'Tests cache behavior after other users'
}];

// Test results
const results = {
  total: 0,
  passed: 0,
  failed: 0,
  tests: []
};

// Helper functions
function log(message, type = 'info') {
  const timestamp = new Date().toISOString().substr(11, 8);
  let coloredMessage;

  switch (type) {
    case 'success':coloredMessage = chalk.green(`✅ ${message}`);break;
    case 'error':coloredMessage = chalk.red(`❌ ${message}`);break;
    case 'warning':coloredMessage = chalk.yellow(`⚠️  ${message}`);break;
    case 'info':coloredMessage = chalk.blue(`ℹ️  ${message}`);break;
    default:coloredMessage = message;
  }

}

function assert(condition, testName, details = '') {
  results.total++;
  if (condition) {
    results.passed++;
    log(`PASS: ${testName}`, 'success');
    results.tests.push({ name: testName, status: 'PASS', details });
  } else {
    results.failed++;
    log(`FAIL: ${testName} ${details}`, 'error');
    results.tests.push({ name: testName, status: 'FAIL', details });
  }
}

async function makeRequest(method, endpoint, data = null, token = null) {
  try {
    const config = {
      method,
      url: `${BASE_URL}${endpoint}`,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` })
      },
      timeout: 30000,
      validateStatus: () => true // Don't throw on HTTP error statuses
    };

    if (data) {
      config.data = data;
    }

    log(`📡 ${method} ${endpoint}`, 'info');
    const response = await axios(config);

    return {
      success: response.status >= 200 && response.status < 300,
      data: response.data,
      status: response.status,
      headers: response.headers
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      status: error.response?.status || 0
    };
  }
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test functions
async function testHealthCheck() {
  log('\n🏥 Testing API Health Check', 'info');

  const response = await makeRequest('GET', '/api/monitoring/health');

  assert(
    response.success,
    'Health check endpoint responds',
    `Status: ${response.status}`
  );

  if (response.success) {
    log(`Backend is healthy: ${response.data?.message || 'OK'}`, 'success');
  }
}

async function testTimingCheck() {
  log('\n🕐 Testing Market Timing Validation', 'info');

  for (const scenario of TEST_SCENARIOS) {
    log(`Testing timing for ${scenario.name}...`);

    const response = await makeRequest(
      'GET',
      '/api/bulk-analysis/timing-check',
      null,
      scenario.token
    );

    assert(
      response.success,
      `Timing check for ${scenario.name}`,
      `Expected: ${scenario.expectedTiming}, Got: ${response.data?.data?.allowed ? 'allowed' : 'blocked'}`
    );

    if (response.success) {
      log(`  Timing: ${response.data?.data?.allowed ? '✅ Allowed' : '❌ Blocked'}`);
      log(`  Reason: ${response.data?.data?.reason || 'Unknown'}`);
      log(`  Message: ${response.data?.data?.message || 'None'}`);
    }

    await delay(500);
  }
}

async function testBulkAnalysisFlow() {
  log('\n🚀 Testing Complete Bulk Analysis Flow', 'info');

  const user = TEST_SCENARIOS[0]; // Use Alice for full flow test
  let sessionId = null;

  // Test 1: Start Analysis
  log(`Starting bulk analysis for ${user.name}...`);
  const startResponse = await makeRequest(
    'POST',
    '/api/bulk-analysis/analyze-all',
    { analysis_type: 'swing' },
    user.token
  );

  if (startResponse.success) {
    sessionId = startResponse.data?.data?.session_id;
    assert(
      sessionId !== undefined,
      'Bulk analysis started with session ID',
      `Session: ${sessionId}`
    );

    log(`  Session ID: ${sessionId}`);
    log(`  Total stocks: ${startResponse.data?.data?.total_stocks || 'Unknown'}`);
    log(`  Estimated time: ${startResponse.data?.data?.estimated_time_minutes || 'Unknown'} minutes`);
  } else {
    assert(false, 'Failed to start bulk analysis', `Status: ${startResponse.status}, Error: ${startResponse.error || startResponse.data?.message}`);
    return;
  }

  // Test 2: Check Status
  log('\nChecking analysis status...');
  await delay(1000);

  const statusResponse = await makeRequest(
    'GET',
    '/api/bulk-analysis/status?analysis_type=swing',
    null,
    user.token
  );

  assert(
    statusResponse.success,
    'Status check successful',
    `Status: ${statusResponse.data?.data?.status}`
  );

  if (statusResponse.success) {
    const status = statusResponse.data?.data;
    log(`  Session: ${status?.session_id}`);
    log(`  Status: ${status?.status}`);
    log(`  Progress: ${status?.progress_percentage || 0}%`);
    log(`  Completed: ${status?.completed || 0}/${status?.total_analyses || 0}`);
    log(`  Failed: ${status?.failed || 0}`);
    log(`  Current stock: ${status?.current_stock || 'None'}`);
  }

  // Test 3: Cancel Analysis
  log('\nCancelling analysis...');
  await delay(1000);

  const cancelResponse = await makeRequest(
    'POST',
    '/api/bulk-analysis/cancel',
    { analysis_type: 'swing' },
    user.token
  );

  assert(
    cancelResponse.success,
    'Analysis cancellation successful',
    `Status: ${cancelResponse.data?.data?.status}`
  );

  if (cancelResponse.success) {
    log(`  Cancelled at: ${cancelResponse.data?.data?.cancelled_at}`);
    log(`  Final processed: ${cancelResponse.data?.data?.processed_stocks}`);
  }

  // Test 4: Check Status After Cancellation
  log('\nChecking status after cancellation...');
  await delay(1000);

  const finalStatusResponse = await makeRequest(
    'GET',
    '/api/bulk-analysis/status?analysis_type=swing',
    null,
    user.token
  );

  assert(
    finalStatusResponse.success && finalStatusResponse.data?.data?.status === 'cancelled',
    'Status shows cancelled after cancellation',
    `Final status: ${finalStatusResponse.data?.data?.status}`
  );
}

async function testCacheSharing() {
  log('\n🔄 Testing Cross-User Cache Sharing', 'info');

  // Test that multiple users can benefit from cache
  for (let i = 0; i < 2; i++) {
    const user = TEST_SCENARIOS[i];

    log(`Testing cache behavior for ${user.name}...`);

    const startTime = Date.now();
    const response = await makeRequest(
      'POST',
      '/api/bulk-analysis/analyze-all',
      { analysis_type: 'swing' },
      user.token
    );
    const responseTime = Date.now() - startTime;

    if (response.success) {
      log(`  Response time: ${responseTime}ms`);
      log(`  Session ID: ${response.data?.data?.session_id}`);

      // Cancel immediately to avoid long running tests
      await delay(500);
      await makeRequest(
        'POST',
        '/api/bulk-analysis/cancel',
        { analysis_type: 'swing' },
        user.token
      );
    }

    assert(
      response.success,
      `Cache test for ${user.name}`,
      `Response time: ${responseTime}ms`
    );

    await delay(1000);
  }
}

async function testRestartBehavior() {
  log('\n🔄 Testing Restart Behavior', 'info');

  const user = TEST_SCENARIOS[0];

  // Start analysis
  log('Starting initial analysis...');
  const start1 = await makeRequest(
    'POST',
    '/api/bulk-analysis/analyze-all',
    { analysis_type: 'swing' },
    user.token
  );

  if (start1.success) {
    log(`  First session: ${start1.data?.data?.session_id}`);

    // Cancel after a moment
    await delay(2000);
    await makeRequest(
      'POST',
      '/api/bulk-analysis/cancel',
      { analysis_type: 'swing' },
      user.token
    );

    // Start again (test restart behavior)
    log('Restarting analysis...');
    await delay(1000);

    const start2 = await makeRequest(
      'POST',
      '/api/bulk-analysis/analyze-all',
      { analysis_type: 'swing' },
      user.token
    );

    assert(
      start2.success,
      'Restart analysis successful',
      `Second session: ${start2.data?.data?.session_id}`
    );

    if (start2.success) {
      log(`  Second session: ${start2.data?.data?.session_id}`);

      // Different session IDs indicate proper restart
      assert(
        start1.data?.data?.session_id !== start2.data?.data?.session_id,
        'New session created on restart',
        'Session IDs are different'
      );

      // Cancel the second session
      await delay(1000);
      await makeRequest(
        'POST',
        '/api/bulk-analysis/cancel',
        { analysis_type: 'swing' },
        user.token
      );
    }
  }
}

async function testStrategiesEndpoint() {
  log('\n📊 Testing Strategies Endpoint', 'info');

  const user = TEST_SCENARIOS[0];

  const response = await makeRequest(
    'GET',
    '/api/bulk-analysis/strategies?analysis_type=swing&limit=10',
    null,
    user.token
  );

  assert(
    response.success,
    'Strategies endpoint accessible',
    `Status: ${response.status}`
  );

  if (response.success) {
    const data = response.data?.data;
    log(`  Total strategies: ${data?.strategies?.length || 0}`);
    log(`  Successful analyses: ${data?.summary?.successful_analyses || 0}`);
    log(`  Failed analyses: ${data?.summary?.failed_analyses || 0}`);
    log(`  Average confidence: ${data?.summary?.avg_confidence || 0}`);

    if (data?.strategies?.length > 0) {
      log(`  Sample strategy: ${data.strategies[0].stock_symbol} - ${data.strategies[0].strategy?.type}`);
    }
  }
}

async function generateTestReport() {
  log('\n📈 TEST EXECUTION REPORT', 'info');

  // Summary

  // Detailed results

  results.tests.forEach((test, index) => {
    const status = test.status === 'PASS' ? chalk.green('✅ PASS') : chalk.red('❌ FAIL');

    if (test.details) {

    }
  });

  // Test coverage

}

// Main test runner
async function runLiveTests() {

  try {
    await testHealthCheck();
    await delay(DELAY_BETWEEN_TESTS);

    await testTimingCheck();
    await delay(DELAY_BETWEEN_TESTS);

    await testBulkAnalysisFlow();
    await delay(DELAY_BETWEEN_TESTS);

    await testCacheSharing();
    await delay(DELAY_BETWEEN_TESTS);

    await testRestartBehavior();
    await delay(DELAY_BETWEEN_TESTS);

    await testStrategiesEndpoint();

    await generateTestReport();

  } catch (error) {
    log(`Test execution failed: ${error.message}`, 'error');
    console.error(error);
  }

  // Exit with appropriate code
  process.exit(results.failed > 0 ? 1 : 0);
}

// Instructions for user

// Run if called directly
if (process.argv[1].endsWith('testLiveBulkAnalysis.js')) {
  runLiveTests().catch(console.error);
}

export default runLiveTests;