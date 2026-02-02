/**
 * Test script for GESHIP stock using On-Demand Analysis Service
 *
 * Tests the full flow:
 * 1. Fetch technical indicators
 * 2. Classify the stock
 * 3. Run analysis (quick reject or full analysis depending on market hours)
 *
 * Usage: node src/scripts/testGESHIP.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

import onDemandAnalysisService from '../services/onDemandAnalysisService.js';
import technicalDataService from '../services/technicalData.service.js';
import Stock from '../models/stock.js';
import MarketHoursUtil from '../utils/marketHours.js';

const { classifyForAnalysis, shouldBlockFullAnalysis } = onDemandAnalysisService;

async function testGESHIP() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('🚢 TESTING GESHIP STOCK - ON-DEMAND ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  try {
    // Connect to MongoDB
    console.log('📡 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Step 1: Find GESHIP stock info
    console.log('🔍 Step 1: Looking up GESHIP stock info...');
    const stock = await Stock.findOne({
      trading_symbol: { $regex: /^GESHIP/i },
      is_active: true
    }).lean();

    if (!stock) {
      console.log('❌ GESHIP stock not found in database');
      console.log('   Trying alternative search...');

      // Try alternative search
      const allStocks = await Stock.find({
        trading_symbol: { $regex: /GESHIP/i }
      }).lean();

      if (allStocks.length > 0) {
        console.log(`   Found ${allStocks.length} matches:`);
        allStocks.forEach(s => console.log(`   - ${s.trading_symbol} (${s.name})`));
      } else {
        console.log('   No stocks found matching GESHIP');
        await mongoose.disconnect();
        return;
      }
    }

    const instrumentKey = stock?.instrument_key;
    const symbol = stock?.trading_symbol;
    const stockName = stock?.name;

    console.log(`✅ Found: ${stockName} (${symbol})`);
    console.log(`   Instrument Key: ${instrumentKey}\n`);

    // Step 2: Check market hours
    console.log('⏰ Step 2: Checking market hours...');
    const session = await MarketHoursUtil.getTradingSession();
    const blockCheck = await shouldBlockFullAnalysis();
    console.log(`   Current session: ${session.session}`);
    console.log(`   Full analysis blocked: ${blockCheck.blocked}`);
    if (blockCheck.blocked) {
      console.log(`   Reason: ${blockCheck.message}`);
    }
    console.log('');

    // Step 3: Fetch technical indicators
    console.log('📊 Step 3: Fetching technical indicators...');
    const indicators = await technicalDataService.getClassificationData(symbol, instrumentKey);

    if (indicators.error) {
      console.log(`❌ Failed to fetch indicators: ${indicators.error}`);
      await mongoose.disconnect();
      return;
    }

    console.log('✅ Technical indicators:');
    console.log(`   Price:      ₹${indicators.price}`);
    console.log(`   EMA20:      ₹${indicators.ema20}`);
    console.log(`   EMA50:      ₹${indicators.ema50}`);
    console.log(`   SMA200:     ₹${indicators.sma200}`);
    console.log(`   RSI:        ${indicators.rsi}`);
    console.log(`   Weekly RSI: ${indicators.weeklyRsi}`);
    console.log(`   52W High:   ₹${indicators.high52W}`);
    console.log(`   ATR:        ₹${indicators.atr}`);
    console.log(`   Vol vs Avg: ${indicators.volumeVsAvg}x`);
    console.log('');

    // Step 4: Classify the stock
    console.log('🎯 Step 4: Classifying stock...');
    const classification = classifyForAnalysis(indicators);

    console.log(`   Is Setup: ${classification.isSetup}`);
    if (classification.isSetup) {
      console.log(`   Scan Type: ${classification.scanType}`);
      console.log(`   Message: ${classification.message}`);
    } else {
      console.log(`   Reason: ${classification.reason}`);
      console.log(`   Message: ${classification.message}`);
    }
    console.log('');

    // Step 5: Run full analysis (or show what would happen)
    console.log('🚀 Step 5: Running on-demand analysis...');
    console.log('   (This may take a while if full analysis is triggered...)\n');

    const result = await onDemandAnalysisService.analyze(instrumentKey, 'test-user', {
      stock_name: stockName,
      stock_symbol: symbol,
      forceFresh: true // Force fresh analysis for testing
    });

    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('📋 ANALYSIS RESULT');
    console.log('═══════════════════════════════════════════════════════════════════\n');

    if (!result.success) {
      console.log(`❌ Analysis failed: ${result.error}`);
    } else if (result.blocked) {
      console.log('⏳ PENDING FULL ANALYSIS (Bullish setup during market hours)');
      console.log(`   Message: ${result.message}`);
      console.log(`   Classification: ${result.classification?.scanType || 'N/A'}`);
      console.log('');

      // Show saved data
      if (result.data) {
        const data = result.data.analysis_data;
        console.log('   📦 SAVED TO DATABASE:');
        console.log(`      Status: ${result.data.status}`);
        console.log(`      Valid Until: ${result.data.valid_until}`);
        if (data?.verdict) {
          console.log(`      Verdict: ${data.verdict.action}`);
          console.log(`      One-liner: ${data.verdict.one_liner}`);
        }
        if (data?.indicators_snapshot) {
          console.log('      Indicators Snapshot:');
          console.log(`         Price: ₹${data.indicators_snapshot.price}`);
          console.log(`         RSI: ${data.indicators_snapshot.rsi}`);
          console.log(`         Weekly RSI: ${data.indicators_snapshot.weekly_rsi}`);
          console.log(`         52W High: ₹${data.indicators_snapshot.high_52w}`);
        }
      }
    } else if (result.fromQuickReject) {
      console.log('⚡ QUICK REJECT (No AI call, instant response)');
      console.log('');
      const qr = result.data.analysis_data?.quick_reject;
      if (qr) {
        console.log(`   Reason: ${qr.reason}`);
        console.log(`   Current Price: ₹${qr.current_price}`);
        console.log(`   Key Message: ${qr.key_message}`);
        console.log('');
        console.log('   Levels to Watch:');
        if (qr.levels_to_watch) {
          Object.entries(qr.levels_to_watch).forEach(([key, value]) => {
            console.log(`     ${key}: ${typeof value === 'number' ? '₹' + value : value}`);
          });
        }
      }
      console.log('');
      console.log(`   Valid Until: ${result.data.valid_until}`);
    } else {
      console.log('✅ FULL ANALYSIS (Claude AI)');
      console.log('');
      const data = result.data.analysis_data;
      if (data) {
        console.log(`   Schema Version: ${data.schema_version}`);
        console.log(`   Status: ${result.data.status}`);

        if (data.verdict) {
          console.log(`   Verdict: ${data.verdict.action}`);
          console.log(`   Confidence: ${data.verdict.confidence}`);
          console.log(`   One-liner: ${data.verdict.one_liner}`);
        }

        if (data.setup_score) {
          console.log(`   Score: ${data.setup_score.total}/100`);
          console.log(`   Grade: ${data.setup_score.grade}`);
        }

        if (data.strategies && data.strategies.length > 0) {
          console.log(`   Strategies: ${data.strategies.length}`);
          data.strategies.forEach((s, i) => {
            console.log(`     [${i + 1}] ${s.title} (${s.type})`);
            console.log(`         Entry: ₹${s.entry}, Target: ₹${s.target}, Stop: ₹${s.stopLoss}`);
            console.log(`         R:R = 1:${s.riskReward}`);
          });
        }
      }
      console.log('');
      console.log(`   Valid Until: ${result.data.valid_until}`);
      console.log(`   Cached: ${result.cached}`);
    }

    console.log('\n═══════════════════════════════════════════════════════════════════');
    console.log('✅ TEST COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('📡 Disconnected from MongoDB');
  }
}

// Run the test
testGESHIP();
