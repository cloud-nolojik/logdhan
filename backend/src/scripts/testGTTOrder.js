/**
 * Test Script for GTT Multi-Leg Order Placement
 *
 * This script tests the GTT (Good Till Triggered) order placement with:
 * - Multi-leg orders (Entry + Target + StopLoss)
 * - Trailing Stop Loss support
 *
 * Usage:
 *   node src/scripts/testGTTOrder.js
 *
 * Requirements:
 *   - Valid Upstox access token (from connected user)
 *   - MongoDB connection for fetching user tokens
 */

import '../loadEnv.js';
import mongoose from 'mongoose';
import connectDB from '../config/database.js';
import upstoxService from '../services/upstox.service.js';
import UpstoxUser from '../models/upstoxUser.js';
import { decrypt } from '../utils/encryption.js';

// Test configuration - modify these values for your test
const TEST_CONFIG = {
  // OPTION 1: Specify a user ID to use their Upstox token
  // Each user has their OWN Upstox token stored in UpstoxUser collection
  userId: null, // Set to a specific user's MongoDB ObjectId string, or leave null to find first available

  // Stock to test with (use a liquid stock)
  instrumentToken: 'NSE_EQ|INE002A01018', // Reliance Industries

  // Test order parameters (BUY example)
  testBuyOrder: {
    transactionType: 'BUY',
    quantity: 1,
    product: 'I', // Intraday
    entryTriggerPrice: 1250,    // Entry price
    entryTriggerType: 'BELOW',   // Trigger when price goes BELOW this
    targetPrice: 1280,           // Target (higher than entry for BUY)
    stopLossPrice: 1230,         // Stop loss (lower than entry for BUY)
    trailingGap: 5               // Trailing SL gap of ₹5
  },

  // Test order parameters (SELL example)
  testSellOrder: {
    transactionType: 'SELL',
    quantity: 1,
    product: 'I', // Intraday
    entryTriggerPrice: 1280,    // Entry price
    entryTriggerType: 'ABOVE',   // Trigger when price goes ABOVE this
    targetPrice: 1250,           // Target (lower than entry for SELL)
    stopLossPrice: 1300,         // Stop loss (higher than entry for SELL)
    trailingGap: 5               // Trailing SL gap of ₹5
  },

  // Test with AI strategy format
  testStrategy: {
    type: 'BUY',
    entry: 1250,
    target: 1280,
    stopLoss: 1230,
    quantity: 1,
    positionType: 'INTRADAY',
    trailingStopLoss: 5 // Optional trailing gap
  },

  // Set to true to actually place orders (use with caution!)
  actuallyPlaceOrders: false,

  // Set to true to cancel test orders after placing
  cancelAfterPlace: true
};

async function getAccessToken() {
  let upstoxUser;

  // If userId is specified, find that specific user's Upstox token
  if (TEST_CONFIG.userId) {
    console.log(`🔍 Looking for Upstox token for user ID: ${TEST_CONFIG.userId}`);
    upstoxUser = await UpstoxUser.findByUserId(TEST_CONFIG.userId);

    if (!upstoxUser) {
      throw new Error(`No Upstox connection found for user ${TEST_CONFIG.userId}. User needs to connect Upstox first.`);
    }

    if (!upstoxUser.isTokenValid()) {
      throw new Error(`Upstox token expired for user ${TEST_CONFIG.userId}. User needs to re-authenticate.`);
    }
  } else {
    // Find first user with valid Upstox connection
    console.log('🔍 No userId specified, finding first available Upstox user...');
    upstoxUser = await UpstoxUser.findOne({
      token_expiry: { $gt: new Date() }
    });

    if (!upstoxUser) {
      throw new Error('No Upstox user with valid token found. Please connect an Upstox account first.');
    }
  }

  console.log(`✅ Found Upstox user: ${upstoxUser.upstox_user_id} (App User ID: ${upstoxUser.user_id})`);
  console.log(`   Token expires: ${upstoxUser.token_expiry}`);
  return decrypt(upstoxUser.access_token);
}

async function testValidation() {
  console.log('\n📋 TEST 1: Validation Tests\n');

  // Test 1.1: Missing target price
  console.log('1.1 Testing missing targetPrice...');
  const result1 = await upstoxService.placeGTTOrder('dummy_token', {
    instrumentToken: TEST_CONFIG.instrumentToken,
    transactionType: 'BUY',
    quantity: 1,
    entryTriggerPrice: 100,
    stopLossPrice: 95
    // targetPrice missing
  });
  console.log(`   Result: ${result1.success ? '❌ FAILED (should have rejected)' : '✅ PASSED'}`);
  console.log(`   Message: ${result1.message}\n`);

  // Test 1.2: Missing stopLoss price
  console.log('1.2 Testing missing stopLossPrice...');
  const result2 = await upstoxService.placeGTTOrder('dummy_token', {
    instrumentToken: TEST_CONFIG.instrumentToken,
    transactionType: 'BUY',
    quantity: 1,
    entryTriggerPrice: 100,
    targetPrice: 110
    // stopLossPrice missing
  });
  console.log(`   Result: ${result2.success ? '❌ FAILED (should have rejected)' : '✅ PASSED'}`);
  console.log(`   Message: ${result2.message}\n`);

  // Test 1.3: Invalid price logic for BUY (target < entry)
  console.log('1.3 Testing invalid BUY price logic (target < entry)...');
  const result3 = await upstoxService.placeGTTOrder('dummy_token', {
    instrumentToken: TEST_CONFIG.instrumentToken,
    transactionType: 'BUY',
    quantity: 1,
    entryTriggerPrice: 100,
    targetPrice: 90,  // Invalid: should be > entry for BUY
    stopLossPrice: 95
  });
  console.log(`   Result: ${result3.success ? '❌ FAILED (should have rejected)' : '✅ PASSED'}`);
  console.log(`   Message: ${result3.message}\n`);

  // Test 1.4: Invalid price logic for BUY (stopLoss > entry)
  console.log('1.4 Testing invalid BUY price logic (stopLoss > entry)...');
  const result4 = await upstoxService.placeGTTOrder('dummy_token', {
    instrumentToken: TEST_CONFIG.instrumentToken,
    transactionType: 'BUY',
    quantity: 1,
    entryTriggerPrice: 100,
    targetPrice: 110,
    stopLossPrice: 105  // Invalid: should be < entry for BUY
  });
  console.log(`   Result: ${result4.success ? '❌ FAILED (should have rejected)' : '✅ PASSED'}`);
  console.log(`   Message: ${result4.message}\n`);

  // Test 1.5: Invalid price logic for SELL
  console.log('1.5 Testing invalid SELL price logic (target > entry)...');
  const result5 = await upstoxService.placeGTTOrder('dummy_token', {
    instrumentToken: TEST_CONFIG.instrumentToken,
    transactionType: 'SELL',
    quantity: 1,
    entryTriggerPrice: 100,
    targetPrice: 110,  // Invalid: should be < entry for SELL
    stopLossPrice: 105
  });
  console.log(`   Result: ${result5.success ? '❌ FAILED (should have rejected)' : '✅ PASSED'}`);
  console.log(`   Message: ${result5.message}\n`);

  console.log('✅ Validation tests completed!\n');
}

async function testStrategyConversion() {
  console.log('\n📋 TEST 2: Strategy Conversion Tests\n');

  // Test 2.1: Strategy without target
  console.log('2.1 Testing strategy without target...');
  const result1 = await upstoxService.placeGTTOrderFromStrategy('dummy_token', {
    type: 'BUY',
    entry: 100,
    stopLoss: 95
    // target missing
  }, TEST_CONFIG.instrumentToken);
  console.log(`   Result: ${result1.success ? '❌ FAILED (should have rejected)' : '✅ PASSED'}`);
  console.log(`   Message: ${result1.message}\n`);

  // Test 2.2: Strategy without stopLoss
  console.log('2.2 Testing strategy without stopLoss...');
  const result2 = await upstoxService.placeGTTOrderFromStrategy('dummy_token', {
    type: 'BUY',
    entry: 100,
    target: 110
    // stopLoss missing
  }, TEST_CONFIG.instrumentToken);
  console.log(`   Result: ${result2.success ? '❌ FAILED (should have rejected)' : '✅ PASSED'}`);
  console.log(`   Message: ${result2.message}\n`);

  console.log('✅ Strategy conversion tests completed!\n');
}

async function testActualOrderPlacement(accessToken) {
  console.log('\n📋 TEST 3: Actual GTT Order Placement\n');

  if (!TEST_CONFIG.actuallyPlaceOrders) {
    console.log('⚠️  Skipping actual order placement (actuallyPlaceOrders = false)');
    console.log('   Set TEST_CONFIG.actuallyPlaceOrders = true to test real orders\n');
    return;
  }

  console.log('🚀 Placing real GTT order...');
  console.log('   Order Details:');
  console.log(`   - Instrument: ${TEST_CONFIG.instrumentToken}`);
  console.log(`   - Type: ${TEST_CONFIG.testBuyOrder.transactionType}`);
  console.log(`   - Entry: ₹${TEST_CONFIG.testBuyOrder.entryTriggerPrice}`);
  console.log(`   - Target: ₹${TEST_CONFIG.testBuyOrder.targetPrice}`);
  console.log(`   - StopLoss: ₹${TEST_CONFIG.testBuyOrder.stopLossPrice}`);
  console.log(`   - Trailing Gap: ₹${TEST_CONFIG.testBuyOrder.trailingGap}`);

  const result = await upstoxService.placeGTTOrder(accessToken, {
    instrumentToken: TEST_CONFIG.instrumentToken,
    ...TEST_CONFIG.testBuyOrder
  });

  if (result.success) {
    console.log('\n✅ GTT Order placed successfully!');
    console.log(`   GTT Order IDs: ${result.data.gtt_order_ids?.join(', ')}`);
    console.log(`   Type: ${result.data.type}`);
    console.log(`   Has Trailing SL: ${result.data.has_trailing_sl}`);

    // Cancel if configured
    if (TEST_CONFIG.cancelAfterPlace && result.data.gtt_order_ids?.[0]) {
      console.log('\n🗑️  Cancelling test order...');
      const cancelResult = await upstoxService.cancelGTTOrder(accessToken, result.data.gtt_order_ids[0]);
      console.log(`   Cancel Result: ${cancelResult.success ? '✅ Cancelled' : '❌ Failed'}`);
    }
  } else {
    console.log('\n❌ GTT Order failed!');
    console.log(`   Error: ${result.error}`);
    console.log(`   Message: ${result.message}`);
    if (result.details) {
      console.log(`   Details: ${JSON.stringify(result.details, null, 2)}`);
    }
  }
}

async function testStrategyOrderPlacement(accessToken) {
  console.log('\n📋 TEST 4: GTT Order from AI Strategy\n');

  if (!TEST_CONFIG.actuallyPlaceOrders) {
    console.log('⚠️  Skipping actual order placement (actuallyPlaceOrders = false)');
    console.log('   Set TEST_CONFIG.actuallyPlaceOrders = true to test real orders\n');
    return;
  }

  console.log('🚀 Placing GTT order from strategy...');
  console.log('   Strategy:');
  console.log(`   - Type: ${TEST_CONFIG.testStrategy.type}`);
  console.log(`   - Entry: ₹${TEST_CONFIG.testStrategy.entry}`);
  console.log(`   - Target: ₹${TEST_CONFIG.testStrategy.target}`);
  console.log(`   - StopLoss: ₹${TEST_CONFIG.testStrategy.stopLoss}`);
  console.log(`   - Trailing SL: ₹${TEST_CONFIG.testStrategy.trailingStopLoss || 'N/A'}`);

  const currentPrice = 1260; // Simulated current price

  const result = await upstoxService.placeGTTOrderFromStrategy(
    accessToken,
    TEST_CONFIG.testStrategy,
    TEST_CONFIG.instrumentToken,
    currentPrice
  );

  if (result.success) {
    console.log('\n✅ GTT Order from strategy placed successfully!');
    console.log(`   GTT Order IDs: ${result.data.gtt_order_ids?.join(', ')}`);

    // Cancel if configured
    if (TEST_CONFIG.cancelAfterPlace && result.data.gtt_order_ids?.[0]) {
      console.log('\n🗑️  Cancelling test order...');
      const cancelResult = await upstoxService.cancelGTTOrder(accessToken, result.data.gtt_order_ids[0]);
      console.log(`   Cancel Result: ${cancelResult.success ? '✅ Cancelled' : '❌ Failed'}`);
    }
  } else {
    console.log('\n❌ GTT Order from strategy failed!');
    console.log(`   Error: ${result.error}`);
    console.log(`   Message: ${result.message}`);
  }
}

async function testGetAllGTTOrders(accessToken) {
  console.log('\n📋 TEST 5: Get All GTT Orders\n');

  const result = await upstoxService.getAllGTTOrders(accessToken);

  if (result.success) {
    console.log('✅ Retrieved GTT orders successfully!');
    console.log(`   Total Orders: ${result.data?.length || 0}`);

    if (result.data && result.data.length > 0) {
      console.log('\n   Recent Orders:');
      result.data.slice(0, 5).forEach((order, i) => {
        console.log(`   ${i + 1}. ID: ${order.gtt_order_id} | Type: ${order.type} | Status: ${order.status}`);
      });
    }
  } else {
    console.log('❌ Failed to get GTT orders');
    console.log(`   Error: ${result.message}`);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   GTT Multi-Leg Order Test Script');
  console.log('   Testing: Entry + Target + StopLoss + Trailing SL');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await connectDB();
    console.log('✅ MongoDB connected\n');

    // Run validation tests (no token needed)
    await testValidation();

    // Run strategy conversion tests (no token needed)
    await testStrategyConversion();

    // Get access token for real API tests
    let accessToken = null;
    try {
      accessToken = await getAccessToken();
      console.log('✅ Access token retrieved\n');
    } catch (err) {
      console.log(`⚠️  ${err.message}`);
      console.log('   Skipping real API tests...\n');
    }

    if (accessToken) {
      // Test actual order placement
      await testActualOrderPlacement(accessToken);

      // Test strategy-based order placement
      await testStrategyOrderPlacement(accessToken);

      // Get all GTT orders
      await testGetAllGTTOrders(accessToken);
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('   All tests completed!');
    console.log('═══════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Test script error:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
    process.exit(0);
  }
}

main();
