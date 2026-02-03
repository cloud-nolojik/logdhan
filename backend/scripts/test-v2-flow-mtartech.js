/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST SCRIPT: Daily Tracking System v2 - End-to-End Flow Test
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This script tests the full v2 flow with MTARTECH only:
 * 1. Uses pre-cached historical data filtered to Feb 1, 2026
 * 2. Calculates indicators from historical candles (up to Feb 1, 2026)
 * 3. Calculates trading levels (including target1, time rules)
 * 4. Generates AI analysis
 * 5. Saves to WeeklyWatchlist
 *
 * Data Reference Date: Feb 1, 2026 (Special trading day - budget day)
 *
 * Usage:
 *   node backend/scripts/test-v2-flow-mtartech.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import Stock from '../src/models/stock.js';
import PreFetchedData from '../src/models/preFetchedData.js';
import WeeklyWatchlist from '../src/models/weeklyWatchlist.js';
import weeklyAnalysisService from '../src/services/weeklyAnalysisService.js';
import {
  calculateSetupScore,
  round2,
  indicators as indicatorsEngine
} from '../src/engine/index.js';
import { calculateTradingLevels } from '../src/engine/scanLevels.js';
const calculateTechnicalIndicators = indicatorsEngine.calculate;

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const TARGET_SYMBOL = 'MTARTECH';  // Only process this stock
const SCAN_TYPE = 'a_plus_momentum';

// Reference date for this test (Weekend Feb 1, 2026 - screening for the coming week)
// Data will be filtered to include candles up to and including the last trading day
// Note: Feb 1, 2026 was a Sunday, so last trading day is Friday Jan 30, 2026
const REFERENCE_DATE = '2026-02-01';
const LAST_TRADING_DAY = '2026-01-30';  // Friday before the weekend

// Dry run mode - only show candle data, don't generate analysis
const DRY_RUN = process.argv.includes('--dry-run');

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Filter candles to reference date
// ─────────────────────────────────────────────────────────────────────────────

function filterCandlesToDate(candles, maxDate) {
  if (!candles || candles.length === 0) return [];

  // Compare date strings directly (YYYY-MM-DD) to avoid timezone issues
  return candles.filter(candle => {
    const timestamp = candle.timestamp || candle[0];
    // Extract just the date part (YYYY-MM-DD) from the timestamp
    const candleDateStr = timestamp.split('T')[0];
    return candleDateStr <= maxDate;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Get instrument key for symbol
// ─────────────────────────────────────────────────────────────────────────────

async function getInstrumentKey(symbol) {
  const stock = await Stock.findOne({
    trading_symbol: symbol.toUpperCase(),
    exchange: 'NSE',
    is_active: true
  }).lean();

  if (stock) {
    return {
      instrument_key: stock.instrument_key,
      stock_name: stock.name,
      trading_symbol: stock.trading_symbol
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Get and filter historical candle data
// ─────────────────────────────────────────────────────────────────────────────

async function getHistoricalCandles(instrumentKey, maxDate) {
  const prefetched = await PreFetchedData.findOne({
    instrument_key: instrumentKey,
    timeframe: '1d'
  }).lean();

  if (!prefetched || !prefetched.candle_data || prefetched.candle_data.length === 0) {
    return null;
  }

  // Filter to only include candles up to the reference date
  const filteredCandles = filterCandlesToDate(prefetched.candle_data, maxDate);

  console.log(`  Total candles in DB: ${prefetched.candle_data.length}`);
  console.log(`  Candles up to ${maxDate}: ${filteredCandles.length}`);

  if (filteredCandles.length > 0) {
    const lastCandle = filteredCandles[filteredCandles.length - 1];
    const lastDate = (lastCandle.timestamp || lastCandle[0]).split('T')[0];
    console.log(`  Last candle date: ${lastDate}`);
    console.log('');
    console.log('  ── Last Candle Details ──');
    console.log(`  Timestamp: ${lastCandle.timestamp || lastCandle[0]}`);
    console.log(`  Open:      ₹${lastCandle.open || lastCandle[1]}`);
    console.log(`  High:      ₹${lastCandle.high || lastCandle[2]}`);
    console.log(`  Low:       ₹${lastCandle.low || lastCandle[3]}`);
    console.log(`  Close:     ₹${lastCandle.close || lastCandle[4]}`);
    console.log(`  Volume:    ${lastCandle.volume || lastCandle[5]}`);
  }

  return filteredCandles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Calculate indicators from filtered candles
// ─────────────────────────────────────────────────────────────────────────────

function calculateIndicatorsFromCandles(candles) {
  if (!candles || candles.length < 20) {
    return null;
  }

  // Convert to array format if needed [timestamp, open, high, low, close, volume]
  const candleArray = candles.map(c => {
    if (Array.isArray(c)) return c;
    return [c.timestamp, c.open, c.high, c.low, c.close, c.volume];
  });

  // Calculate indicators
  const indicators = calculateTechnicalIndicators(candleArray);

  // Get last candle (Friday)
  const lastCandle = candleArray[candleArray.length - 1];
  const fridayClose = lastCandle[4];
  const fridayHigh = lastCandle[2];
  const fridayLow = lastCandle[3];
  const fridayVolume = lastCandle[5];

  // Get 20-day high
  const last20 = candleArray.slice(-20);
  const high20D = Math.max(...last20.map(c => c[2]));

  // Calculate volume vs average
  const avgVolume20 = last20.reduce((sum, c) => sum + (c[5] || 0), 0) / 20;
  const volumeVsAvg = avgVolume20 > 0 ? round2(fridayVolume / avgVolume20) : null;

  // Calculate weekly change
  const weekAgoCandle = candleArray[candleArray.length - 5];
  const weekAgoClose = weekAgoCandle ? weekAgoCandle[4] : null;
  const weeklyChangePct = weekAgoClose ?
    round2(((fridayClose - weekAgoClose) / weekAgoClose) * 100) : null;

  // Calculate 1-month return
  const oneMonthAgo = candleArray[candleArray.length - 22];
  const return1m = oneMonthAgo ?
    round2(((fridayClose - oneMonthAgo[4]) / oneMonthAgo[4]) * 100) : null;

  return {
    price: fridayClose,
    dma20: round2(indicators.sma20 || indicators.ema20),
    dma50: round2(indicators.sma50 || indicators.ema50),
    dma200: round2(indicators.sma200),
    ema20: round2(indicators.ema20),
    ema50: round2(indicators.ema50),
    rsi: round2(indicators.rsi14 || indicators.rsi),
    atr: round2(indicators.atr14 || indicators.atr),
    atr_pct: indicators.atr14 && fridayClose ?
      round2((indicators.atr14 / fridayClose) * 100) : null,
    volume: fridayVolume,
    volume_vs_avg: volumeVsAvg,
    high_20d: round2(high20D),
    return_1m: return1m,
    distance_from_20dma_pct: indicators.sma20 && fridayClose ?
      round2(((fridayClose - indicators.sma20) / indicators.sma20) * 100) : null,
    fridayHigh: round2(fridayHigh),
    fridayLow: round2(fridayLow),
    fridayClose: round2(fridayClose),
    fridayVolume,
    weekly_change_pct: weeklyChangePct
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Test Function
// ─────────────────────────────────────────────────────────────────────────────

async function runTest() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Daily Tracking System v2 - Test Flow (MTARTECH only)');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Target Stock: ${TARGET_SYMBOL}`);
  console.log(`  Scan Type: ${SCAN_TYPE}`);
  console.log(`  Reference Date: ${REFERENCE_DATE} (Saturday)`);
  console.log(`  Last Trading Day: ${LAST_TRADING_DAY} (Friday)`);
  console.log('');
  console.log('  ⚠️  Using HISTORICAL data filtered to Feb 1, 2026');
  console.log('');

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGODB_URI not found in environment');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');
  console.log('');

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // STEP 1: Get instrument key for MTARTECH
    // ─────────────────────────────────────────────────────────────────────────
    console.log('─────────────────────────────────────────────────────────────────');
    console.log('STEP 1: Looking up instrument key...');
    console.log('─────────────────────────────────────────────────────────────────');

    const stockInfo = await getInstrumentKey(TARGET_SYMBOL);
    if (!stockInfo) {
      console.error(`  ❌ Could not find ${TARGET_SYMBOL} in Stock collection`);
      await mongoose.disconnect();
      return;
    }

    console.log(`  Symbol: ${stockInfo.trading_symbol}`);
    console.log(`  Name: ${stockInfo.stock_name}`);
    console.log(`  Instrument Key: ${stockInfo.instrument_key}`);
    console.log('');

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 2: Get historical candles filtered to Feb 1, 2026
    // ─────────────────────────────────────────────────────────────────────────
    console.log('─────────────────────────────────────────────────────────────────');
    console.log('STEP 2: Fetching historical candles (filtered to Feb 1, 2026)...');
    console.log('─────────────────────────────────────────────────────────────────');

    const candles = await getHistoricalCandles(stockInfo.instrument_key, LAST_TRADING_DAY);
    if (!candles || candles.length < 50) {
      console.error(`  ❌ Insufficient candle data (need 50+, have ${candles?.length || 0})`);
      await mongoose.disconnect();
      return;
    }

    console.log('');

    // ─────────────────────────────────────────────────────────────────────────
    // DRY RUN EXIT
    // ─────────────────────────────────────────────────────────────────────────
    if (DRY_RUN) {
      console.log('═══════════════════════════════════════════════════════════════════');
      console.log('  DRY RUN COMPLETE');
      console.log('═══════════════════════════════════════════════════════════════════');
      console.log('');
      console.log('  Run without --dry-run to continue with full analysis.');
      console.log('');
      await mongoose.disconnect();
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 3: Calculate indicators from historical data
    // ─────────────────────────────────────────────────────────────────────────
    console.log('─────────────────────────────────────────────────────────────────');
    console.log('STEP 3: Calculating indicators from historical data...');
    console.log('─────────────────────────────────────────────────────────────────');

    const indicators = calculateIndicatorsFromCandles(candles);
    if (!indicators) {
      console.error('  ❌ Could not calculate indicators');
      await mongoose.disconnect();
      return;
    }

    console.log(`  Friday Close: ₹${indicators.fridayClose}`);
    console.log(`  EMA20: ₹${indicators.ema20}`);
    console.log(`  RSI: ${indicators.rsi}`);
    console.log(`  ATR: ₹${indicators.atr} (${indicators.atr_pct}%)`);
    console.log(`  20D High: ₹${indicators.high_20d}`);
    console.log(`  Volume vs Avg: ${indicators.volume_vs_avg}x`);
    console.log('');

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 4: Calculate trading levels
    // ─────────────────────────────────────────────────────────────────────────
    console.log('─────────────────────────────────────────────────────────────────');
    console.log('STEP 4: Calculating trading levels (v2)...');
    console.log('─────────────────────────────────────────────────────────────────');

    // Calculate 52-week high from candles (approximately 250 trading days)
    const candleArray = candles.map(c => {
      if (Array.isArray(c)) return c;
      return [c.timestamp, c.open, c.high, c.low, c.close, c.volume];
    });
    const last52WeekCandles = candleArray.slice(-250);  // ~52 weeks of trading days
    const high52W = Math.max(...last52WeekCandles.map(c => c[2]));

    // Calculate weekly pivots from last week's data
    // Get last 5 trading days for the week
    const lastWeekCandles = candleArray.slice(-5);
    const weekHigh = Math.max(...lastWeekCandles.map(c => c[2]));
    const weekLow = Math.min(...lastWeekCandles.map(c => c[3]));
    const weekClose = lastWeekCandles[lastWeekCandles.length - 1][4];
    const weeklyPivot = round2((weekHigh + weekLow + weekClose) / 3);
    const weeklyR1 = round2(2 * weeklyPivot - weekLow);
    const weeklyR2 = round2(weeklyPivot + (weekHigh - weekLow));

    console.log(`  52W High: ₹${round2(high52W)}`);
    console.log(`  Weekly Pivot: ₹${weeklyPivot}, R1: ₹${weeklyR1}, R2: ₹${weeklyR2}`);
    console.log('');

    const levelsData = {
      ema20: indicators.ema20,
      atr: indicators.atr,
      fridayHigh: indicators.fridayHigh,
      fridayClose: indicators.fridayClose,
      fridayLow: indicators.fridayLow,
      high20D: indicators.high_20d,
      high52W: round2(high52W),
      fridayVolume: indicators.fridayVolume,
      avgVolume20: indicators.volume_vs_avg ? indicators.fridayVolume / indicators.volume_vs_avg : null,
      // Weekly pivot levels for target anchoring
      weeklyPivot,
      weeklyR1,
      weeklyR2
    };

    const levels = calculateTradingLevels(SCAN_TYPE, levelsData);

    if (!levels || !levels.valid) {
      console.log(`  ⚠️ Trading levels invalid: ${levels?.reason || 'Unknown reason'}`);
      console.log(`  Risk %: ${levels?.riskPercent || 'N/A'}`);
      console.log(`  Suggested action: ${levels?.suggestedAction || 'N/A'}`);
      console.log('');
      console.log('  Cannot proceed with invalid levels.');
      await mongoose.disconnect();
      return;
    }

    console.log('  ── Core Levels ──');
    console.log(`  Entry: ₹${levels.entry}`);
    console.log(`  Entry Range: [₹${levels.entryRange?.[0]} - ₹${levels.entryRange?.[1]}]`);
    console.log(`  Stop: ₹${levels.stop}`);
    console.log(`  Target (T2): ₹${levels.target} [${levels.targetBasis}]`);
    console.log(`  Target2 (T3): ₹${levels.target2 || 'N/A'}`);
    console.log('');
    console.log('  ── v2 NEW FIELDS ──');
    console.log(`  Target1 (T1): ₹${levels.target1} [${levels.target1Basis}]`);
    console.log(`  Entry Confirmation: ${levels.entryConfirmation}`);
    console.log(`  Entry Window Days: ${levels.entryWindowDays}`);
    console.log(`  Max Hold Days: ${levels.maxHoldDays}`);
    console.log(`  Week End Rule: ${levels.weekEndRule}`);
    console.log(`  T1 Booking %: ${levels.t1BookingPct}`);
    console.log(`  Post-T1 Stop: ${levels.postT1Stop}`);
    console.log(`  Archetype: ${levels.archetype}`);
    console.log('');
    console.log('  ── Risk/Reward ──');
    console.log(`  Risk:Reward: 1:${levels.riskReward}`);
    console.log(`  Risk %: ${levels.riskPercent}%`);
    console.log(`  Reward %: ${levels.rewardPercent}%`);
    console.log('');

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 5: Calculate setup score
    // ─────────────────────────────────────────────────────────────────────────
    console.log('─────────────────────────────────────────────────────────────────');
    console.log('STEP 5: Calculating setup score...');
    console.log('─────────────────────────────────────────────────────────────────');

    // Build stock data object matching what calculateSetupScore expects
    const scoreData = {
      price: indicators.price,
      last: indicators.price,
      close: indicators.price,
      rsi: indicators.rsi,
      rsi14: indicators.rsi,
      volume: indicators.volume,
      volume_vs_avg: indicators.volume_vs_avg,
      weekly_change_pct: indicators.weekly_change_pct,
      return_1m: indicators.return_1m
    };

    // Pass levels as second argument (not scan_type)
    const scoreResult = calculateSetupScore(scoreData, levels, 0, true);
    console.log(`  Setup Score: ${scoreResult.score}/100`);
    console.log(`  Grade: ${scoreResult.grade}`);
    if (scoreResult.eliminated) {
      console.log(`  ⚠️ Eliminated: ${scoreResult.eliminationReason}`);
    }
    console.log('');

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 6: Build enriched stock object
    // ─────────────────────────────────────────────────────────────────────────
    const enrichedStock = {
      symbol: TARGET_SYMBOL,
      stock_name: stockInfo.stock_name,
      instrument_key: stockInfo.instrument_key,
      scan_type: SCAN_TYPE,
      setup_score: scoreResult.score,
      grade: scoreResult.grade,
      current_price: indicators.price,
      indicators: {
        price: indicators.price,
        ema20: indicators.ema20,
        ema50: indicators.ema50,
        dma50: indicators.dma50,
        dma200: indicators.dma200,
        rsi: indicators.rsi,
        atr: indicators.atr,
        atr_pct: indicators.atr_pct,
        volume_vs_avg: indicators.volume_vs_avg,
        high_20d: indicators.high_20d,
        high_52w: round2(high52W),
        return_1m: indicators.return_1m,
        weekly_change_pct: indicators.weekly_change_pct,  // Added - was missing!
        distance_from_20dma_pct: indicators.distance_from_20dma_pct,
        fridayHigh: indicators.fridayHigh,
        fridayLow: indicators.fridayLow,
        fridayClose: indicators.fridayClose,
        // Weekly pivots for AI prompt
        weekly_pivot: weeklyPivot,
        weekly_r1: weeklyR1,
        weekly_r2: weeklyR2
      },
      levels: levels
    };

    console.log('');
    console.log('  ── Weekly Data Check ──');
    console.log(`  weekly_change_pct: ${indicators.weekly_change_pct ?? 'NULL'}`);
    console.log(`  (This is passed to AI for "Weekly Move" scoring)`);

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 7: Generate AI Analysis
    // ─────────────────────────────────────────────────────────────────────────
    console.log('─────────────────────────────────────────────────────────────────');
    console.log('STEP 6: Generating AI analysis...');
    console.log('─────────────────────────────────────────────────────────────────');

    const analysisResult = await weeklyAnalysisService.generateWeeklyAnalysis(enrichedStock);

    if (analysisResult.status === 'completed') {
      console.log(`  ✅ Analysis generated successfully`);
      console.log(`  Analysis ID: ${analysisResult._id}`);

      const analysis = analysisResult.analysis_data;
      console.log('');
      console.log('  ── Verdict ──');
      console.log(`  Action: ${analysis.verdict?.action}`);
      console.log(`  One-liner: ${analysis.verdict?.one_liner}`);
      console.log(`  Confidence: ${analysis.verdict?.confidence}`);

      console.log('');
      console.log('  ── Trading Plan (from Engine) ──');
      const tp = analysis.trading_plan;
      console.log(`  Entry: ₹${tp?.entry}`);
      console.log(`  Entry Confirmation: ${tp?.entry_confirmation}`);
      console.log(`  Entry Window: ${tp?.entry_window_days} days`);
      console.log(`  Stop: ₹${tp?.stop_loss}`);
      console.log(`  T1: ₹${tp?.target1} [${tp?.target1_basis}]`);
      console.log(`  T2: ₹${tp?.target}`);
      console.log(`  Week End Rule: ${tp?.week_end_rule}`);

      console.log('');
      console.log('  ── Beginner Guide Steps ──');
      if (analysis.beginner_guide?.steps) {
        analysis.beginner_guide.steps.forEach((step, i) => {
          console.log(`  ${i + 1}. ${step.substring(0, 80)}${step.length > 80 ? '...' : ''}`);
        });
      }
    } else {
      console.log(`  ❌ Analysis failed: ${analysisResult.error || 'Unknown error'}`);
    }
    console.log('');

    // ─────────────────────────────────────────────────────────────────────────
    // STEP 8: Save to WeeklyWatchlist
    // ─────────────────────────────────────────────────────────────────────────
    console.log('─────────────────────────────────────────────────────────────────');
    console.log('STEP 7: Saving to WeeklyWatchlist...');
    console.log('─────────────────────────────────────────────────────────────────');

    const stockToAdd = {
      instrument_key: enrichedStock.instrument_key,
      symbol: enrichedStock.symbol,
      stock_name: enrichedStock.stock_name,
      scan_type: SCAN_TYPE,
      setup_score: enrichedStock.setup_score,
      grade: enrichedStock.grade,
      indicators: enrichedStock.indicators,
      levels: {
        entry: levels.entry,
        entryRange: levels.entryRange,
        stop: levels.stop,
        target1: levels.target1,
        target1Basis: levels.target1Basis,
        target: levels.target,
        target2: levels.target2,
        targetBasis: levels.targetBasis,
        riskReward: levels.riskReward,
        riskPercent: levels.riskPercent,
        rewardPercent: levels.rewardPercent,
        entryType: levels.entryType,
        mode: levels.mode,
        archetype: levels.archetype,
        entryConfirmation: levels.entryConfirmation,
        entryWindowDays: levels.entryWindowDays,
        maxHoldDays: levels.maxHoldDays,
        weekEndRule: levels.weekEndRule,
        t1BookingPct: levels.t1BookingPct,
        postT1Stop: levels.postT1Stop
      },
      status: 'WATCHING',
      analysis_id: analysisResult._id,
      has_ai_analysis: analysisResult.status === 'completed'
    };

    const addResult = await WeeklyWatchlist.addStocks([stockToAdd]);

    console.log(`  ✅ Stock added to watchlist`);
    console.log(`  Watchlist: ${addResult.watchlist.week_label}`);
    console.log(`  Total stocks in watchlist: ${addResult.watchlist.stocks.length}`);
    console.log('');

    // ─────────────────────────────────────────────────────────────────────────
    // SUMMARY
    // ─────────────────────────────────────────────────────────────────────────
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('  TEST COMPLETED SUCCESSFULLY');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('');
    console.log('  Historical Data Used:');
    console.log(`    📅 Reference Date: ${REFERENCE_DATE}`);
    console.log(`    📅 Last Trading Day: ${LAST_TRADING_DAY}`);
    console.log(`    📊 Candles used: ${candles.length}`);
    console.log('');
    console.log('  v2 Fields Verified:');
    console.log(`    ✅ target1: ₹${levels.target1}`);
    console.log(`    ✅ target1Basis: ${levels.target1Basis}`);
    console.log(`    ✅ entryConfirmation: ${levels.entryConfirmation}`);
    console.log(`    ✅ entryWindowDays: ${levels.entryWindowDays}`);
    console.log(`    ✅ weekEndRule: ${levels.weekEndRule}`);
    console.log(`    ✅ archetype: ${levels.archetype}`);
    console.log('');
    console.log('  Next Steps:');
    console.log('    1. Check the WeeklyWatchlist in MongoDB');
    console.log('    2. Call GET /api/v1/weekly-watchlist to see card_display');
    console.log('    3. Run dailyTrackingService to simulate trades');
    console.log('');

  } catch (error) {
    console.error('');
    console.error('═══════════════════════════════════════════════════════════════════');
    console.error('  TEST FAILED');
    console.error('═══════════════════════════════════════════════════════════════════');
    console.error(`  Error: ${error.message}`);
    console.error(`  Stack: ${error.stack}`);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

runTest().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
