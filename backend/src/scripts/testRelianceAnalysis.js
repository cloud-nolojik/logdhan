/**
 * Test script for RELIANCE - Deterministic On-Demand Analysis
 *
 * Tests the full deterministic flow:
 * 1. Fetch technical indicators
 * 2. Classify the stock
 * 3. Run deterministic analysis (no AI, no market hours blocking)
 * 4. Verify card output matches v1.5 schema
 * 5. Test dataAsOf cache hit on second call
 *
 * Usage: node src/scripts/testRelianceAnalysis.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

import onDemandAnalysisService from '../services/onDemandAnalysisService.js';
import technicalDataService from '../services/technicalData.service.js';
import Stock from '../models/stock.js';
import StockAnalysis from '../models/stockAnalysis.js';
import MarketHoursUtil from '../utils/marketHours.js';

const { classifyForAnalysis, buildAnalysisCard } = onDemandAnalysisService;

async function testReliance() {
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('TESTING RELIANCE - DETERMINISTIC ON-DEMAND ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');

    // ─── Step 1: Find RELIANCE ─────────────────────────────────────────
    console.log('Step 1: Looking up RELIANCE...');
    const stock = await Stock.findOne({
      trading_symbol: { $regex: /^RELIANCE$/i },
      is_active: true
    }).lean();

    if (!stock) {
      console.log('RELIANCE not found. Searching alternatives...');
      const matches = await Stock.find({ trading_symbol: { $regex: /RELIANCE/i } }).lean();
      matches.forEach(s => console.log(`  - ${s.trading_symbol} (${s.name}) [${s.instrument_key}]`));
      await mongoose.disconnect();
      return;
    }

    const { instrument_key: instrumentKey, trading_symbol: symbol, name: stockName } = stock;
    console.log(`Found: ${stockName} (${symbol})`);
    console.log(`Instrument Key: ${instrumentKey}\n`);

    // ─── Step 2: dataAsOf + market context ─────────────────────────────
    console.log('Step 2: Checking data context...');
    const dataAsOf = await MarketHoursUtil.getLastCompletedTradingDay();
    const session = await MarketHoursUtil.getTradingSession();
    console.log(`  dataAsOf: ${dataAsOf}`);
    console.log(`  Session: ${session.session}`);
    console.log(`  Note: Analysis works anytime (no blocking)\n`);

    // ─── Step 3: Clear any existing analysis for clean test ────────────
    console.log('Step 3: Clearing existing RELIANCE swing analysis...');
    const deleteResult = await StockAnalysis.deleteMany({
      instrument_key: instrumentKey,
      analysis_type: 'swing'
    });
    console.log(`  Deleted ${deleteResult.deletedCount} existing record(s)\n`);

    // ─── Step 4: Fetch indicators ──────────────────────────────────────
    console.log('Step 4: Fetching technical indicators...');
    const indicators = await technicalDataService.getClassificationData(symbol, instrumentKey);

    if (indicators.error) {
      console.log(`Failed to fetch indicators: ${indicators.error}`);
      await mongoose.disconnect();
      return;
    }

    console.log('  Indicators:');
    console.log(`    Price:      ${indicators.price}`);
    console.log(`    EMA20:      ${indicators.ema20}`);
    console.log(`    EMA50:      ${indicators.ema50}`);
    console.log(`    SMA200:     ${indicators.sma200}`);
    console.log(`    RSI:        ${indicators.rsi}`);
    console.log(`    Weekly RSI: ${indicators.weeklyRsi}`);
    console.log(`    52W High:   ${indicators.high52W}`);
    console.log(`    ATR:        ${indicators.atr}`);
    console.log(`    Vol vs Avg: ${indicators.volumeVsAvg}x\n`);

    // ─── Step 5: Classify ──────────────────────────────────────────────
    console.log('Step 5: Classifying stock...');
    const classification = classifyForAnalysis(indicators);
    console.log(`  isSetup: ${classification.isSetup}`);
    if (classification.isSetup) {
      console.log(`  scanType: ${classification.scanType}`);
    } else {
      console.log(`  reason: ${classification.reason}`);
    }
    console.log(`  message: ${classification.message}\n`);

    // ─── Step 6: Run full on-demand analysis (first call) ──────────────
    console.log('Step 6: Running on-demand analysis (FIRST CALL - should compute)...');
    const t1 = Date.now();
    const result1 = await onDemandAnalysisService.analyze(instrumentKey, 'test-user', {
      stock_name: stockName,
      stock_symbol: symbol
    });
    const duration1 = Date.now() - t1;

    console.log(`  Duration: ${duration1}ms`);
    console.log(`  Success: ${result1.success}`);
    console.log(`  Cached: ${result1.cached}`);
    console.log(`  fromQuickReject: ${result1.fromQuickReject}\n`);

    if (!result1.success) {
      console.log(`FAILED: ${result1.error}`);
      await mongoose.disconnect();
      return;
    }

    // ─── Step 7: Print the analysis card ───────────────────────────────
    const data = result1.data?.analysis_data;
    if (data) {
      console.log('═══════════════════════════════════════════════════════════════════');
      console.log('ANALYSIS CARD');
      console.log('═══════════════════════════════════════════════════════════════════\n');

      // Verdict
      if (data.verdict) {
        console.log(`  VERDICT: ${data.verdict.action}`);
        console.log(`  Confidence: ${data.verdict.confidence}`);
        console.log(`  ${data.verdict.one_liner}\n`);
      }

      // Quick reject
      if (data.quick_reject) {
        console.log('  QUICK REJECT:');
        console.log(`  Reason: ${data.quick_reject.reason}`);
        console.log(`  Price: ${data.quick_reject.current_price}`);
        console.log(`  ${data.quick_reject.key_message}`);
        if (data.quick_reject.levels_to_watch) {
          console.log('  Levels to Watch:');
          Object.entries(data.quick_reject.levels_to_watch).forEach(([k, v]) => {
            console.log(`    ${k}: ${v}`);
          });
        }
        console.log('');
      }

      // Score
      if (data.setup_score) {
        console.log(`  SCORE: ${data.setup_score.total}/100  Grade: ${data.setup_score.grade}`);
        if (data.setup_score.factors?.length > 0) {
          console.log('  Factors:');
          data.setup_score.factors.forEach(f => {
            console.log(`    [${f.status}] ${f.name}: ${f.score} — ${f.explanation}`);
          });
        }
        if (data.setup_score.strengths?.length > 0) {
          console.log(`  Strengths: ${data.setup_score.strengths.join('; ')}`);
        }
        if (data.setup_score.watch_factors?.length > 0) {
          console.log(`  Watch: ${data.setup_score.watch_factors.join('; ')}`);
        }
        console.log('');
      }

      // Trading plan
      if (data.trading_plan) {
        const tp = data.trading_plan;
        console.log('  TRADING PLAN:');
        console.log(`    Entry: ${tp.entry}${tp.entry_range ? ` (range: ${tp.entry_range})` : ''}`);
        console.log(`    Stop Loss: ${tp.stop_loss}`);
        console.log(`    T1: ${tp.target1}${tp.target1_basis ? ` (${tp.target1_basis})` : ''}`);
        console.log(`    T2: ${tp.target2}${tp.target2_basis ? ` (${tp.target2_basis})` : ''}`);
        if (tp.target3) console.log(`    T3: ${tp.target3}`);
        console.log(`    R:R: 1:${tp.risk_reward}`);
        console.log(`    Risk: ${tp.risk_percent}%  Reward: ${tp.reward_percent}%\n`);
      }

      // Beginner guide
      if (data.beginner_guide) {
        const bg = data.beginner_guide;
        console.log('  BEGINNER GUIDE:');
        console.log(`    What: ${bg.what_stock_is_doing}`);
        console.log(`    Why: ${bg.why_this_is_interesting}`);
        if (bg.steps_to_trade?.length > 0) {
          console.log('    Steps:');
          bg.steps_to_trade.forEach((s, i) => console.log(`      ${i + 1}. ${s}`));
        }
        if (bg.if_it_fails) {
          console.log(`    If fails: Max loss ${bg.if_it_fails.max_loss} (${bg.if_it_fails.loss_percent})`);
        }
        console.log('');
      }

      // What to watch
      if (data.what_to_watch) {
        console.log('  WHAT TO WATCH:');
        if (data.what_to_watch.if_bought) console.log(`    If bought: ${data.what_to_watch.if_bought}`);
        if (data.what_to_watch.if_waiting) console.log(`    If waiting: ${data.what_to_watch.if_waiting}`);
        console.log('');
      }

      // Warnings
      if (data.warnings?.length > 0) {
        console.log('  WARNINGS:');
        data.warnings.forEach(w => {
          console.log(`    [${w.severity}] ${w.code}: ${w.message}`);
          console.log(`      Mitigation: ${w.mitigation}`);
        });
        console.log('');
      }

      // Schema validation
      console.log('═══════════════════════════════════════════════════════════════════');
      console.log('SCHEMA VALIDATION (v1.5 fields)');
      console.log('═══════════════════════════════════════════════════════════════════\n');

      const checks = [
        ['schema_version', data.schema_version === '1.5'],
        ['symbol', typeof data.symbol === 'string'],
        ['analysis_type', data.analysis_type === 'swing'],
        ['verdict', data.verdict != null],
        ['verdict.action', ['BUY', 'WAIT', 'SKIP', 'NO_TRADE'].includes(data.verdict?.action)],
        ['setup_score', data.setup_score != null],
        ['setup_score.factors (array)', Array.isArray(data.setup_score?.factors)],
        ['warnings (array)', Array.isArray(data.warnings)],
        ['strategies (array)', Array.isArray(data.strategies)],
        ['trading_plan', data.trading_plan === null || typeof data.trading_plan === 'object'],
        ['beginner_guide', data.beginner_guide == null || typeof data.beginner_guide === 'object'],
        ['beginner_guide.steps_to_trade (array)', !data.beginner_guide || Array.isArray(data.beginner_guide?.steps_to_trade)],
      ];

      let passed = 0;
      checks.forEach(([name, ok]) => {
        console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}`);
        if (ok) passed++;
      });
      console.log(`\n  Result: ${passed}/${checks.length} passed\n`);
    }

    // ─── Step 8: Test cache hit (second call) ──────────────────────────
    console.log('Step 8: Running on-demand analysis (SECOND CALL - should cache hit)...');
    const t2 = Date.now();
    const result2 = await onDemandAnalysisService.analyze(instrumentKey, 'test-user', {
      stock_name: stockName,
      stock_symbol: symbol
    });
    const duration2 = Date.now() - t2;

    console.log(`  Duration: ${duration2}ms`);
    console.log(`  Cached: ${result2.cached}`);
    console.log(`  ${result2.cached ? 'PASS - Cache hit as expected' : 'FAIL - Should have been cached'}\n`);

    // ─── Step 9: Verify DB record ──────────────────────────────────────
    console.log('Step 9: Verifying DB record...');
    const dbRecord = await StockAnalysis.findOne({
      instrument_key: instrumentKey,
      analysis_type: 'swing'
    }).lean();

    if (dbRecord) {
      console.log(`  Status: ${dbRecord.status}`);
      console.log(`  dataAsOf: ${dbRecord.analysis_meta?.data_as_of_ist}`);
      console.log(`  Source: ${dbRecord.analysis_meta?.source}`);
      console.log(`  valid_until: ${dbRecord.valid_until} (should be null)`);
      console.log(`  ${dbRecord.analysis_meta?.source === 'on_demand_deterministic' ? 'PASS' : 'FAIL'} - Source is deterministic`);
      console.log(`  ${dbRecord.valid_until === null ? 'PASS' : 'FAIL'} - valid_until is null\n`);
    } else {
      console.log('  FAIL - No DB record found\n');
    }

    // ─── Summary ───────────────────────────────────────────────────────
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Stock: ${stockName} (${symbol})`);
    console.log(`  dataAsOf: ${dataAsOf}`);
    console.log(`  First call: ${duration1}ms (computed)`);
    console.log(`  Second call: ${duration2}ms (${result2.cached ? 'cached' : 'recomputed'})`);
    console.log(`  Verdict: ${data?.verdict?.action || 'N/A'}`);
    console.log(`  Score: ${data?.setup_score?.total || 0}/100 ${data?.setup_score?.grade || ''}`);
    console.log('═══════════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('Test failed:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

testReliance();
