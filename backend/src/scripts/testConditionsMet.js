/**
 * Test Script: Simulate Conditions Met for Auto-Order GTT Testing
 *
 * This script manually triggers the "conditions met" flow to test:
 * 1. GTT order placement via placeGTTOrderFromStrategy
 * 2. User token retrieval
 * 3. Notification sending
 *
 * Usage:
 *   node src/scripts/testConditionsMet.js
 *
 * Options:
 *   - Set TEST_CONFIG.dryRun = true to simulate without placing real orders
 *   - Set TEST_CONFIG.analysisId to test a specific analysis
 */

import '../loadEnv.js';
import mongoose from 'mongoose';
import connectDB from '../config/database.js';
import StockAnalysis from '../models/stockAnalysis.js';
import MonitoringSubscription from '../models/monitoringSubscription.js';
import UpstoxUser from '../models/upstoxUser.js';
import upstoxService from '../services/upstox.service.js';
import { User } from '../models/user.js';
import { decrypt } from '../utils/encryption.js';

const TEST_CONFIG = {
  // Set a specific analysis ID to test, or leave null to find first available
  analysisId: null,

  // Set a specific user ID, or leave null to use analysis owner
  userId: null,

  // Dry run mode - simulates without placing real orders
  dryRun: true,

  // Simulate current price (for trigger direction)
  simulatedCurrentPrice: null, // Set to a number or leave null to use strategy entry
};

async function findTestAnalysis() {
  console.log('\n🔍 Finding test analysis...\n');

  let analysis;

  if (TEST_CONFIG.analysisId) {
    analysis = await StockAnalysis.findById(TEST_CONFIG.analysisId);
    if (!analysis) {
      throw new Error(`Analysis not found: ${TEST_CONFIG.analysisId}`);
    }
  } else {
    // Find an analysis with a valid strategy (has entry, target, stopLoss)
    analysis = await StockAnalysis.findOne({
      'analysis_data.strategies.0.entry': { $exists: true, $gt: 0 },
      'analysis_data.strategies.0.target': { $exists: true, $gt: 0 },
      'analysis_data.strategies.0.stopLoss': { $exists: true, $gt: 0 },
    }).sort({ createdAt: -1 });

    if (!analysis) {
      throw new Error('No analysis found with valid strategy (entry, target, stopLoss)');
    }
  }

  console.log(`✅ Found analysis: ${analysis._id}`);
  console.log(`   Stock: ${analysis.stock_symbol}`);
  console.log(`   Instrument: ${analysis.instrument_key}`);
  console.log(`   Created: ${analysis.createdAt}`);

  const strategy = analysis.analysis_data?.strategies?.[0];
  if (strategy) {
    console.log(`\n📊 Strategy Details:`);
    console.log(`   Type: ${strategy.type}`);
    console.log(`   Entry: ₹${strategy.entry}`);
    console.log(`   Target: ₹${strategy.target}`);
    console.log(`   StopLoss: ₹${strategy.stopLoss}`);
    console.log(`   Quantity: ${strategy.quantity || strategy.suggested_qty || 1}`);
  }

  return analysis;
}

async function findUpstoxUser(userId) {
  console.log(`\n🔍 Finding Upstox token for user: ${userId}...\n`);

  const upstoxUser = await UpstoxUser.findByUserId(userId);

  if (!upstoxUser) {
    throw new Error(`No Upstox connection for user ${userId}. Connect Upstox first.`);
  }

  if (!upstoxUser.isTokenValid()) {
    throw new Error(`Upstox token expired for user ${userId}. Re-authenticate.`);
  }

  console.log(`✅ Found Upstox user: ${upstoxUser.upstox_user_id}`);
  console.log(`   Token expires: ${upstoxUser.token_expiry}`);

  return upstoxUser;
}

async function simulateConditionsMet(analysis, upstoxUser) {
  console.log('\n🚀 Simulating CONDITIONS MET...\n');

  const strategy = analysis.analysis_data?.strategies?.[0];
  if (!strategy) {
    throw new Error('No strategy found in analysis');
  }

  const currentPrice = TEST_CONFIG.simulatedCurrentPrice || strategy.entry;

  console.log(`📋 Order Details:`);
  console.log(`   Stock: ${analysis.stock_symbol}`);
  console.log(`   Type: ${strategy.type}`);
  console.log(`   Entry: ₹${strategy.entry}`);
  console.log(`   Target: ₹${strategy.target}`);
  console.log(`   StopLoss: ₹${strategy.stopLoss}`);
  console.log(`   Current Price (simulated): ₹${currentPrice}`);
  console.log(`   Trailing SL: ${strategy.trailingStopLoss ? `₹${strategy.trailingStopLoss}` : 'None'}`);

  if (TEST_CONFIG.dryRun) {
    console.log('\n⚠️  DRY RUN MODE - Not placing real order\n');

    // Just validate the order data
    const triggerType = strategy.type.toUpperCase() === 'BUY'
      ? (strategy.entry > currentPrice ? 'ABOVE' : 'BELOW')
      : (strategy.entry < currentPrice ? 'BELOW' : 'ABOVE');

    console.log('📝 Would place GTT order with:');
    console.log(`   Instrument: ${analysis.instrument_key}`);
    console.log(`   Transaction: ${strategy.type}`);
    console.log(`   Entry Trigger: ₹${strategy.entry} (${triggerType})`);
    console.log(`   Target: ₹${strategy.target}`);
    console.log(`   StopLoss: ₹${strategy.stopLoss}`);
    console.log(`   Product: I (Intraday)`);

    // Validate price logic
    if (strategy.type.toUpperCase() === 'BUY') {
      if (strategy.target <= strategy.entry) {
        console.log('   ❌ INVALID: Target must be > Entry for BUY');
      } else if (strategy.stopLoss >= strategy.entry) {
        console.log('   ❌ INVALID: StopLoss must be < Entry for BUY');
      } else {
        console.log('   ✅ Price logic valid for BUY');
      }
    } else {
      if (strategy.target >= strategy.entry) {
        console.log('   ❌ INVALID: Target must be < Entry for SELL');
      } else if (strategy.stopLoss <= strategy.entry) {
        console.log('   ❌ INVALID: StopLoss must be > Entry for SELL');
      } else {
        console.log('   ✅ Price logic valid for SELL');
      }
    }

    return {
      success: true,
      dryRun: true,
      message: 'Dry run - order not placed'
    };
  }

  // REAL ORDER PLACEMENT
  console.log('\n🔴 PLACING REAL GTT ORDER...\n');

  const accessToken = decrypt(upstoxUser.access_token);

  const result = await upstoxService.placeGTTOrderFromStrategy(
    accessToken,
    strategy,
    analysis.instrument_key,
    currentPrice
  );

  if (result.success) {
    console.log('✅ GTT Order Placed Successfully!');
    console.log(`   GTT Order IDs: ${result.data?.gtt_order_ids?.join(', ')}`);
    console.log(`   Type: ${result.data?.type}`);
    console.log(`   Has Trailing SL: ${result.data?.has_trailing_sl}`);
  } else {
    console.log('❌ GTT Order Failed!');
    console.log(`   Error: ${result.error}`);
    console.log(`   Message: ${result.message}`);
  }

  return result;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   Test Script: Simulate Conditions Met for GTT Auto-Order');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Mode: ${TEST_CONFIG.dryRun ? '🔵 DRY RUN' : '🔴 REAL ORDERS'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    // Connect to MongoDB
    console.log('🔌 Connecting to MongoDB...');
    await connectDB();
    console.log('✅ MongoDB connected\n');

    // Find test analysis
    const analysis = await findTestAnalysis();

    // Determine user ID
    const userId = TEST_CONFIG.userId || analysis.user_id;
    console.log(`\n👤 User ID: ${userId}`);

    // Find Upstox token
    const upstoxUser = await findUpstoxUser(userId);

    // Simulate conditions met
    const result = await simulateConditionsMet(analysis, upstoxUser);

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('   Test Complete!');
    console.log(`   Result: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    if (result.dryRun) {
      console.log('   Note: This was a DRY RUN - no real order placed');
      console.log('   Set TEST_CONFIG.dryRun = false to place real orders');
    }
    console.log('═══════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 MongoDB connection closed');
    process.exit(0);
  }
}

main();
