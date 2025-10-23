#!/usr/bin/env node

/**
 * Comprehensive Bulk Analysis Flow Test Script
 * 
 * Tests different users at different times with various scenarios:
 * - Market timing restrictions
 * - Cache behavior (cross-user and user-specific)
 * - Session management and cancellation
 * - Restart behavior with selective deletion
 * - Error handling and recovery
 * 
 * Usage: node src/scripts/testBulkAnalysisFlow.js
 */

import './loadEnv.js';
import mongoose from 'mongoose';
import axios from 'axios';
import { User } from '../models/user.js';
import StockAnalysis from '../models/stockAnalysis.js';
import AnalysisSession from '../models/analysisSession.js';
import MarketTiming from '../models/marketTiming.js';

// Test configuration
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const TEST_USERS = [
    { id: 'user1', name: 'Alice (Morning Trader)', watchlist: ['RELIANCE', 'TCS', 'INFY', 'HDFC', 'ICICIBANK'] },
    { id: 'user2', name: 'Bob (Evening Trader)', watchlist: ['RELIANCE', 'TCS', 'WIPRO', 'LT', 'SBIN'] },
    { id: 'user3', name: 'Charlie (Weekend Planner)', watchlist: ['RELIANCE', 'MARUTI', 'BHARTIARTL', 'ASIANPAINT', 'NESTLEIND'] },
    { id: 'user4', name: 'Diana (Power User)', watchlist: ['RELIANCE', 'TCS', 'INFY', 'HDFC', 'ICICIBANK', 'WIPRO', 'LT', 'SBIN', 'MARUTI', 'BHARTIARTL'] }
];

// Mock stock data
const MOCK_STOCKS = {
    'RELIANCE': { instrument_key: 'NSE_EQ|INE002A01018', name: 'Reliance Industries Ltd', price: 2850.75 },
    'TCS': { instrument_key: 'NSE_EQ|INE467B01029', name: 'Tata Consultancy Services Ltd', price: 4125.30 },
    'INFY': { instrument_key: 'NSE_EQ|INE009A01021', name: 'Infosys Ltd', price: 1456.20 },
    'HDFC': { instrument_key: 'NSE_EQ|INE040A01034', name: 'HDFC Bank Ltd', price: 1685.45 },
    'ICICIBANK': { instrument_key: 'NSE_EQ|INE090A01013', name: 'ICICI Bank Ltd', price: 1195.60 },
    'WIPRO': { instrument_key: 'NSE_EQ|INE075A01022', name: 'Wipro Ltd', price: 542.85 },
    'LT': { instrument_key: 'NSE_EQ|INE018A01030', name: 'Larsen & Toubro Ltd', price: 3654.20 },
    'SBIN': { instrument_key: 'NSE_EQ|INE062A01020', name: 'State Bank of India', price: 845.75 },
    'MARUTI': { instrument_key: 'NSE_EQ|INE585B01010', name: 'Maruti Suzuki India Ltd', price: 11245.30 },
    'BHARTIARTL': { instrument_key: 'NSE_EQ|INE397D01024', name: 'Bharti Airtel Ltd', price: 1598.45 },
    'ASIANPAINT': { instrument_key: 'NSE_EQ|INE021A01026', name: 'Asian Paints Ltd', price: 2945.80 },
    'NESTLEIND': { instrument_key: 'NSE_EQ|INE239A01016', name: 'Nestle India Ltd', price: 2156.90 }
};

// Test results storage
const testResults = {
    passed: 0,
    failed: 0,
    total: 0,
    details: []
};

// Helper functions
function log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    const emoji = type === 'PASS' ? '✅' : type === 'FAIL' ? '❌' : type === 'WARN' ? '⚠️' : 'ℹ️';
    console.log(`${timestamp} ${emoji} [${type}] ${message}`);
}

function assert(condition, message) {
    testResults.total++;
    if (condition) {
        testResults.passed++;
        log(`PASS: ${message}`, 'PASS');
    } else {
        testResults.failed++;
        log(`FAIL: ${message}`, 'FAIL');
        testResults.details.push({ type: 'FAIL', message, timestamp: new Date() });
    }
}

async function makeRequest(method, endpoint, data = null, headers = {}) {
    try {
        const config = {
            method,
            url: `${BASE_URL}${endpoint}`,
            headers: { 'Content-Type': 'application/json', ...headers },
            timeout: 30000
        };
        
        if (data) {
            config.data = data;
        }
        
        const response = await axios(config);
        return { success: true, data: response.data, status: response.status };
    } catch (error) {
        return { 
            success: false, 
            error: error.response?.data || error.message, 
            status: error.response?.status 
        };
    }
}

async function createTestUser(userData) {
    const user = new User({
        _id: new mongoose.Types.ObjectId(),
        name: userData.name,
        email: `${userData.id}@test.com`,
        mobile: `+91${Math.floor(Math.random() * 9000000000) + 1000000000}`,
        watchlist: userData.watchlist.map(symbol => ({
            instrument_key: MOCK_STOCKS[symbol].instrument_key,
            name: MOCK_STOCKS[symbol].name,
            trading_symbol: symbol
        }))
    });
    
    await user.save();
    return user;
}

async function simulateMarketTiming(scenario) {
    log(`🕐 Setting up market timing: ${scenario}`);
    
    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];
    
    // Create or update market timing for today
    await MarketTiming.findOneAndUpdate(
        { date: dateStr },
        { 
            date: dateStr,
            isMarketOpen: scenario !== 'holiday',
            openTime: '09:15',
            closeTime: '15:30',
            isPreMarket: false,
            isPostMarket: false
        },
        { upsert: true }
    );
}

async function cleanupTestData() {
    log('🧹 Cleaning up test data...');
    await User.deleteMany({ email: /test\.com$/ });
    await StockAnalysis.deleteMany({ user_id: /user[1-4]/ });
    await AnalysisSession.deleteMany({ user_id: /user[1-4]/ });
    await AIAnalysisCache.deleteMany({});
}

// Test Cases
async function testMarketTimingRestrictions() {
    log('\n📊 TEST SUITE 1: Market Timing Restrictions');
    
    const user = await createTestUser(TEST_USERS[0]);
    const authHeader = { 'Authorization': `Bearer mock_token_${user._id}` };
    
    // Test 1: Before market hours (should be blocked)
    await simulateMarketTiming('before_session');
    const response1 = await makeRequest('POST', '/api/bulk-analysis/analyze-all', 
        { analysis_type: 'swing' }, authHeader);
    
    assert(response1.status === 423, 'Analysis blocked before market session');
    assert(response1.error?.error === 'bulk_analysis_not_allowed', 'Correct error code for timing restriction');
    
    // Test 2: During allowed window (should succeed)
    await simulateMarketTiming('weekday_session');
    const response2 = await makeRequest('POST', '/api/bulk-analysis/analyze-all', 
        { analysis_type: 'swing' }, authHeader);
    
    assert(response2.success === true, 'Analysis allowed during permitted hours');
    assert(response2.data?.session_id !== undefined, 'Session ID returned on successful start');
    
    // Test 3: Holiday (should be blocked)
    await simulateMarketTiming('holiday');
    const response3 = await makeRequest('POST', '/api/bulk-analysis/analyze-all', 
        { analysis_type: 'swing' }, authHeader);
    
    assert(response3.status === 423, 'Analysis blocked on holidays');
}

async function testCrosUserCacheBehavior() {
    log('\n🔄 TEST SUITE 2: Cross-User Cache Behavior');
    
    // Reset market timing for testing
    await simulateMarketTiming('weekday_session');
    
    const user1 = await createTestUser(TEST_USERS[0]);
    const user2 = await createTestUser(TEST_USERS[1]);
    
    const auth1 = { 'Authorization': `Bearer mock_token_${user1._id}` };
    const auth2 = { 'Authorization': `Bearer mock_token_${user2._id}` };
    
    // Test 1: User 1 starts analysis
    log('👤 User 1 (Alice) starts bulk analysis...');
    const response1 = await makeRequest('POST', '/api/bulk-analysis/analyze-all', 
        { analysis_type: 'swing' }, auth1);
    
    assert(response1.success === true, 'User 1 analysis started successfully');
    
    // Wait for some analysis to complete (simulate)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Create mock completed analysis for User 1
    const completedAnalysis = new StockAnalysis({
        instrument_key: MOCK_STOCKS['RELIANCE'].instrument_key,
        stock_name: 'Reliance Industries Ltd',
        stock_symbol: 'RELIANCE',
        analysis_type: 'swing',
        current_price: 2850.75,
        user_id: user1._id,
        status: 'completed',
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // Tomorrow
        analysis_data: {
            strategies: [{
                id: 'strat_1',
                type: 'BUY',
                confidence: 0.85,
                entry: 2850,
                target: 3100,
                stopLoss: 2700
            }]
        }
    });
    await completedAnalysis.save();
    
    // Create cross-user cache entry
    const cacheEntry = new AIAnalysisCache({
        cache_key: 'NSE_EQ|INE002A01018_swing_' + new Date().toISOString().split('T')[0],
        instrument_key: MOCK_STOCKS['RELIANCE'].instrument_key,
        stock_symbol: 'RELIANCE',
        analysis_type: 'swing',
        trading_date: new Date(),
        analysis_result: completedAnalysis.analysis_data,
        ai_request_payload: { test: true },
        market_data_used: { sources: ['test'] },
        current_price: 2850.75,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        usage_count: 1,
        users_served: [{ user_id: user1._id, accessed_at: new Date() }]
    });
    await cacheEntry.save();
    
    // Test 2: User 2 requests analysis for same stock (should hit cache)
    log('👤 User 2 (Bob) starts bulk analysis with overlapping stocks...');
    const response2 = await makeRequest('POST', '/api/bulk-analysis/analyze-all', 
        { analysis_type: 'swing' }, auth2);
    
    assert(response2.success === true, 'User 2 analysis started successfully');
    
    // Check if cache was utilized (this would need more sophisticated monitoring in real test)
    const updatedCache = await AIAnalysisCache.findById(cacheEntry._id);
    log(`Cache usage count: ${updatedCache?.usage_count || 0}`);
}

async function testSessionManagementAndCancellation() {
    log('\n🛑 TEST SUITE 3: Session Management and Cancellation');
    
    await simulateMarketTiming('weekday_session');
    const user = await createTestUser(TEST_USERS[2]);
    const authHeader = { 'Authorization': `Bearer mock_token_${user._id}` };
    
    // Test 1: Start analysis
    const response1 = await makeRequest('POST', '/api/bulk-analysis/analyze-all', 
        { analysis_type: 'swing' }, authHeader);
    
    assert(response1.success === true, 'Analysis session started');
    const sessionId = response1.data?.session_id;
    assert(sessionId !== undefined, 'Session ID returned');
    
    // Test 2: Check status immediately
    const response2 = await makeRequest('GET', '/api/bulk-analysis/status?analysis_type=swing', 
        null, authHeader);
    
    assert(response2.success === true, 'Status check successful');
    assert(response2.data?.session_id === sessionId, 'Correct session ID in status');
    assert(response2.data?.status === 'running', 'Session status is running');
    
    // Test 3: Cancel analysis
    const response3 = await makeRequest('POST', '/api/bulk-analysis/cancel', 
        { analysis_type: 'swing' }, authHeader);
    
    assert(response3.success === true, 'Analysis cancelled successfully');
    assert(response3.data?.status === 'cancelled', 'Session marked as cancelled');
    
    // Test 4: Check status after cancellation
    const response4 = await makeRequest('GET', '/api/bulk-analysis/status?analysis_type=swing', 
        null, authHeader);
    
    assert(response4.success === true, 'Status check after cancellation successful');
    assert(response4.data?.status === 'cancelled', 'Status shows cancelled');
}

async function testRestartBehaviorWithSelectiveDeletion() {
    log('\n🔄 TEST SUITE 4: Restart Behavior with Selective Deletion');
    
    await simulateMarketTiming('weekday_session');
    const user = await createTestUser(TEST_USERS[3]);
    const authHeader = { 'Authorization': `Bearer mock_token_${user._id}` };
    
    // Create mock analyses in different states
    const analyses = [
        // Completed analysis (should be preserved)
        new StockAnalysis({
            instrument_key: MOCK_STOCKS['RELIANCE'].instrument_key,
            stock_symbol: 'RELIANCE',
            user_id: user._id,
            analysis_type: 'swing',
            status: 'completed',
            current_price: 2850.75,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
            analysis_data: { strategies: [{ type: 'BUY', confidence: 0.85 }] }
        }),
        // Failed analysis (should be deleted)
        new StockAnalysis({
            instrument_key: MOCK_STOCKS['TCS'].instrument_key,
            stock_symbol: 'TCS',
            user_id: user._id,
            analysis_type: 'swing',
            status: 'failed',
            current_price: 4125.30,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
            analysis_data: { error_reason: 'Price fetch failed' }
        }),
        // Pending analysis (should be deleted)
        new StockAnalysis({
            instrument_key: MOCK_STOCKS['INFY'].instrument_key,
            stock_symbol: 'INFY',
            user_id: user._id,
            analysis_type: 'swing',
            status: 'pending',
            current_price: 1456.20,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
        }),
        // In-progress analysis (should be deleted)
        new StockAnalysis({
            instrument_key: MOCK_STOCKS['HDFC'].instrument_key,
            stock_symbol: 'HDFC',
            user_id: user._id,
            analysis_type: 'swing',
            status: 'in_progress',
            current_price: 1685.45,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000)
        })
    ];
    
    await StockAnalysis.insertMany(analyses);
    
    // Count analyses before restart
    const beforeCount = await StockAnalysis.countDocuments({ user_id: user._id });
    log(`📊 Analyses before restart: ${beforeCount}`);
    
    // Test 1: Start analysis (should trigger selective deletion)
    const response1 = await makeRequest('POST', '/api/bulk-analysis/analyze-all', 
        { analysis_type: 'swing' }, authHeader);
    
    assert(response1.success === true, 'Restart analysis successful');
    
    // Count analyses after restart
    const afterCount = await StockAnalysis.countDocuments({ user_id: user._id });
    const completedCount = await StockAnalysis.countDocuments({ 
        user_id: user._id, 
        status: 'completed' 
    });
    
    log(`📊 Analyses after restart: ${afterCount} (${completedCount} completed)`);
    
    assert(completedCount === 1, 'Completed analysis preserved during restart');
    assert(afterCount < beforeCount, 'Some analyses were deleted during restart');
    
    // Test 2: Verify the preserved analysis is accessible
    const response2 = await makeRequest('GET', '/api/bulk-analysis/strategies?analysis_type=swing', 
        null, authHeader);
    
    assert(response2.success === true, 'Strategies endpoint accessible');
    assert(response2.data?.strategies?.length >= 1, 'At least one strategy available from preserved analysis');
}

async function testErrorHandlingAndRecovery() {
    log('\n❌ TEST SUITE 5: Error Handling and Recovery');
    
    await simulateMarketTiming('weekday_session');
    const user = await createTestUser(TEST_USERS[0]);
    const authHeader = { 'Authorization': `Bearer mock_token_${user._id}` };
    
    // Test 1: Empty watchlist (should return error)
    await User.findByIdAndUpdate(user._id, { watchlist: [] });
    
    const response1 = await makeRequest('POST', '/api/bulk-analysis/analyze-all', 
        { analysis_type: 'swing' }, authHeader);
    
    assert(response1.success === false, 'Empty watchlist returns error');
    assert(response1.status === 400, 'Correct error status for empty watchlist');
    
    // Test 2: Invalid analysis type
    await User.findByIdAndUpdate(user._id, { 
        watchlist: [{ 
            instrument_key: MOCK_STOCKS['RELIANCE'].instrument_key,
            name: 'Reliance Industries Ltd',
            trading_symbol: 'RELIANCE'
        }] 
    });
    
    const response2 = await makeRequest('POST', '/api/bulk-analysis/analyze-all', 
        { analysis_type: 'invalid_type' }, authHeader);
    
    // The API might accept this or reject it based on validation
    log(`Invalid analysis type response: ${response2.success ? 'accepted' : 'rejected'}`);
    
    // Test 3: Timing check endpoint
    const response3 = await makeRequest('GET', '/api/bulk-analysis/timing-check', 
        null, authHeader);
    
    assert(response3.success === true, 'Timing check endpoint accessible');
    assert(response3.data?.allowed !== undefined, 'Timing check returns allowed status');
}

async function testConcurrentUsers() {
    log('\n👥 TEST SUITE 6: Concurrent Users Simulation');
    
    await simulateMarketTiming('weekday_session');
    
    const users = await Promise.all(TEST_USERS.map(userData => createTestUser(userData)));
    
    // Simulate concurrent analysis starts
    const concurrentPromises = users.map(async (user, index) => {
        const authHeader = { 'Authorization': `Bearer mock_token_${user._id}` };
        
        // Stagger the requests slightly
        await new Promise(resolve => setTimeout(resolve, index * 100));
        
        const response = await makeRequest('POST', '/api/bulk-analysis/analyze-all', 
            { analysis_type: 'swing' }, authHeader);
        
        return { user: user.name, success: response.success, sessionId: response.data?.session_id };
    });
    
    const results = await Promise.all(concurrentPromises);
    
    log('👥 Concurrent user results:');
    results.forEach(result => {
        log(`  ${result.user}: ${result.success ? '✅ Success' : '❌ Failed'} (Session: ${result.sessionId || 'N/A'})`);
        assert(result.success === true, `Concurrent analysis for ${result.user}`);
    });
    
    // Check that all sessions are independent
    const uniqueSessions = new Set(results.map(r => r.sessionId).filter(Boolean));
    assert(uniqueSessions.size === results.length, 'All users have unique session IDs');
}

async function generatePerformanceReport() {
    log('\n📈 PERFORMANCE REPORT');
    
    // Count cache entries
    const cacheCount = await AIAnalysisCache.countDocuments({});
    const analysisCount = await StockAnalysis.countDocuments({});
    const sessionCount = await AnalysisSession.countDocuments({});
    
    log(`📊 Database Statistics:`);
    log(`  Cross-user cache entries: ${cacheCount}`);
    log(`  Total analyses: ${analysisCount}`);
    log(`  Total sessions: ${sessionCount}`);
    
    // Simulate cache hit rate calculation
    const completedAnalyses = await StockAnalysis.countDocuments({ status: 'completed' });
    const cacheHitRate = cacheCount > 0 ? ((completedAnalyses / Math.max(cacheCount, 1)) * 100).toFixed(2) : 0;
    
    log(`📈 Performance Metrics:`);
    log(`  Estimated cache hit rate: ${cacheHitRate}%`);
    log(`  Successful analyses: ${completedAnalyses}`);
    
    if (cacheCount > 0) {
        const avgCacheUsage = await AIAnalysisCache.aggregate([
            { $group: { _id: null, avgUsage: { $avg: '$usage_count' } } }
        ]);
        log(`  Average cache usage: ${avgCacheUsage[0]?.avgUsage?.toFixed(2) || 0} hits per analysis`);
    }
}

// Main test runner
async function runAllTests() {
    console.log('🚀 Starting Comprehensive Bulk Analysis Flow Tests\n');
    console.log('=' .repeat(80));
    
    try {
        // Connect to database
        await mongoose.connect(process.env.MONGODB_URI);
        log('✅ Connected to MongoDB');
        
        // Clean up any existing test data
        await cleanupTestData();
        
        // Run all test suites
        await testMarketTimingRestrictions();
        await testCrosUserCacheBehavior();
        await testSessionManagementAndCancellation();
        await testRestartBehaviorWithSelectiveDeletion();
        await testErrorHandlingAndRecovery();
        await testConcurrentUsers();
        
        // Generate performance report
        await generatePerformanceReport();
        
        // Final cleanup
        await cleanupTestData();
        
    } catch (error) {
        log(`❌ Test execution failed: ${error.message}`, 'FAIL');
        testResults.failed++;
    } finally {
        await mongoose.connection.close();
        log('🔌 Disconnected from MongoDB');
    }
    
    // Print final results
    console.log('\n' + '=' .repeat(80));
    console.log('📊 FINAL TEST RESULTS');
    console.log('=' .repeat(80));
    console.log(`Total Tests: ${testResults.total}`);
    console.log(`✅ Passed: ${testResults.passed}`);
    console.log(`❌ Failed: ${testResults.failed}`);
    console.log(`Success Rate: ${((testResults.passed / testResults.total) * 100).toFixed(2)}%`);
    
    if (testResults.details.length > 0) {
        console.log('\n❌ Failed Test Details:');
        testResults.details.forEach(detail => {
            console.log(`  - ${detail.message} (${detail.timestamp.toISOString()})`);
        });
    }
    
    console.log('\n🎯 Test Scenarios Covered:');
    console.log('  ✓ Market timing restrictions at different hours');
    console.log('  ✓ Cross-user cache sharing and efficiency');
    console.log('  ✓ Session lifecycle management and cancellation');
    console.log('  ✓ Restart behavior with selective deletion logic');
    console.log('  ✓ Error handling for edge cases');
    console.log('  ✓ Concurrent user simulation');
    console.log('  ✓ Performance metrics and cache utilization');
    
    process.exit(testResults.failed > 0 ? 1 : 0);
}

// Run tests if script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests().catch(console.error);
}

export default runAllTests;