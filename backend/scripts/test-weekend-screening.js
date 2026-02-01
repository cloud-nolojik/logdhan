#!/usr/bin/env node

/**
 * Test Weekend Screening Job
 *
 * This script tests the complete weekend screening flow:
 * 1. ChartInk scans (a_plus_momentum)
 * 2. Price prefetch
 * 3. Stock enrichment with technical data & levels
 * 4. Add to WeeklyWatchlist
 * 5. AI analysis with Claude
 *
 * Usage:
 *   node scripts/test-weekend-screening.js                    # Full test (all 5 steps)
 *   node scripts/test-weekend-screening.js --skip-ai          # Skip AI analysis (steps 1-4 only)
 *   node scripts/test-weekend-screening.js --dry-run          # Scan only, no DB writes
 *   node scripts/test-weekend-screening.js --stock RELIANCE   # Test with specific stock (mock)
 *
 * Run: node scripts/test-weekend-screening.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Parse command line arguments
const args = process.argv.slice(2);
const SKIP_AI = args.includes('--skip-ai');
const DRY_RUN = args.includes('--dry-run');
const MOCK_STOCK_ARG = args.find(a => a.startsWith('--stock='));
const MOCK_STOCK = MOCK_STOCK_ARG ? MOCK_STOCK_ARG.split('=')[1] : null;

console.log('');
console.log('═'.repeat(80));
console.log('  WEEKEND SCREENING JOB TEST');
console.log('═'.repeat(80));
console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE'}`);
console.log(`  AI Analysis: ${SKIP_AI ? 'SKIPPED' : 'ENABLED'}`);
console.log(`  Mock Stock: ${MOCK_STOCK || 'None (using real ChartInk scan)'}`);
console.log('═'.repeat(80));
console.log('');

async function runTest() {
  let db;

  try {
    // Step 0: Connect to MongoDB
    console.log('[TEST] Step 0: Connecting to MongoDB...');
    db = await mongoose.connect(process.env.MONGODB_URI);
    console.log('[TEST] ✅ Connected to MongoDB');
    console.log('');

    // Import services after connection
    const { WeekendScreeningJob } = await import('../src/services/jobs/weekendScreeningJob.js');
    const chartinkService = (await import('../src/services/chartinkService.js')).default;
    const stockEnrichmentService = (await import('../src/services/stockEnrichmentService.js')).default;
    const WeeklyWatchlist = (await import('../src/models/weeklyWatchlist.js')).default;
    const weeklyAnalysisService = (await import('../src/services/weeklyAnalysisService.js')).default;

    // Create instance (don't initialize agenda - we'll call methods directly)
    const job = new WeekendScreeningJob();

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Run ChartInk Scan
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('─'.repeat(80));
    console.log('[TEST] STEP 1/5: Running ChartInk A+ Momentum Scan...');
    console.log('─'.repeat(80));

    let scanResults;
    if (MOCK_STOCK) {
      // Use mock data for testing
      console.log(`[TEST] Using mock data for ${MOCK_STOCK}`);
      scanResults = [{
        nsecode: MOCK_STOCK,
        name: `${MOCK_STOCK} Industries Ltd`,
        bsecode: '500325',
        close: 2850.50,
        per_chg: 2.35,
        volume: 15000000,
        scan_type: 'a_plus_momentum'
      }];
    } else {
      scanResults = await chartinkService.runAPlusNextWeekScan();
    }

    console.log(`[TEST] ✅ Scan returned ${scanResults.length} stocks`);

    if (scanResults.length > 0) {
      console.log('[TEST] Sample results:');
      scanResults.slice(0, 5).forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.nsecode} - ₹${s.close} (${s.per_chg > 0 ? '+' : ''}${s.per_chg}%)`);
      });
    }
    console.log('');

    if (scanResults.length === 0) {
      console.log('[TEST] ⚠️ No stocks found in scan. Exiting.');
      return;
    }

    // Tag with scan type
    const taggedResults = scanResults.map(s => ({ ...s, scan_type: 'a_plus_momentum' }));

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Price Prefetch
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('─'.repeat(80));
    console.log('[TEST] STEP 2/5: Mapping to instrument keys...');
    console.log('─'.repeat(80));

    const instrumentKeyMap = new Map();
    for (const stock of taggedResults) {
      const mapped = await stockEnrichmentService.mapToInstrumentKey(stock.nsecode);
      if (mapped?.instrument_key) {
        instrumentKeyMap.set(stock.nsecode, mapped.instrument_key);
        console.log(`  ✅ ${stock.nsecode} → ${mapped.instrument_key}`);
      } else {
        console.log(`  ❌ ${stock.nsecode} → NOT FOUND`);
      }
    }

    console.log(`[TEST] ✅ Mapped ${instrumentKeyMap.size}/${taggedResults.length} instrument keys`);
    console.log('');

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Enrichment Pipeline
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('─'.repeat(80));
    console.log('[TEST] STEP 3/5: Running enrichment pipeline...');
    console.log('─'.repeat(80));

    const { stocks: enrichedStocks, metadata } = await stockEnrichmentService.runEnrichmentPipeline(
      taggedResults,
      { minScore: 0, maxResults: 20 }
    );

    console.log('[TEST] Enrichment metadata:');
    console.log(`  Total input: ${metadata.total_input}`);
    console.log(`  Total enriched: ${metadata.total_enriched}`);
    console.log(`  Total eliminated: ${metadata.total_eliminated}`);
    console.log(`  Grade distribution: ${JSON.stringify(metadata.grade_distribution)}`);
    console.log(`  Levels stats: ${JSON.stringify(metadata.levels_stats)}`);
    console.log('');

    // Filter qualified stocks
    const MIN_SCORE = 60;
    const qualifiedStocks = enrichedStocks
      .filter(s => !s.eliminated && s.setup_score >= MIN_SCORE && s.levels?.entry)
      .sort((a, b) => b.setup_score - a.setup_score);

    console.log(`[TEST] Qualified stocks (score >= ${MIN_SCORE}, not eliminated, has levels): ${qualifiedStocks.length}`);
    console.log('');

    if (qualifiedStocks.length > 0) {
      console.log('[TEST] Top qualified stocks:');
      qualifiedStocks.slice(0, 10).forEach((s, i) => {
        const arch = s.levels?.archetype || 'N/A';
        const basis = s.levels?.targetBasis || 'N/A';
        console.log(`  ${i + 1}. ${s.symbol} | Score: ${s.setup_score} | Grade: ${s.grade} | Archetype: ${arch} | Target Basis: ${basis}`);
        if (s.levels) {
          console.log(`     Entry: ₹${s.levels.entry} | Stop: ₹${s.levels.stop} | Target: ₹${s.levels.target} | R:R 1:${s.levels.riskReward}`);
        }
      });
      console.log('');
    }

    // Check for 52W breakout stocks
    const breakoutStocks = qualifiedStocks.filter(s => s.levels?.archetype === '52w_breakout');
    console.log(`[TEST] 52W Breakout stocks: ${breakoutStocks.length}`);
    breakoutStocks.forEach(s => {
      console.log(`  - ${s.symbol}: targetBasis=${s.levels.targetBasis}, high_52w=₹${s.indicators?.high_52w || 'N/A'}`);
    });
    console.log('');

    if (qualifiedStocks.length === 0) {
      console.log('[TEST] ⚠️ No qualified stocks after filtering. Exiting.');
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: Add to WeeklyWatchlist
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('─'.repeat(80));
    console.log('[TEST] STEP 4/5: Adding stocks to WeeklyWatchlist...');
    console.log('─'.repeat(80));

    if (DRY_RUN) {
      console.log('[TEST] DRY RUN - Skipping database writes');
      console.log('[TEST] Would add the following stocks:');
      qualifiedStocks.slice(0, 15).forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.symbol} (${s.grade})`);
      });
    } else {
      const stocksToAdd = qualifiedStocks.slice(0, 15).map(stock => ({
        instrument_key: stock.instrument_key,
        symbol: stock.symbol,
        stock_name: stock.stock_name,
        scan_type: stock.scan_type,
        setup_score: stock.setup_score,
        grade: stock.grade,
        score_breakdown: stock.score_breakdown,
        screening_data: {
          price_at_screening: stock.current_price,
          dma20: stock.indicators.dma20,
          dma50: stock.indicators.dma50,
          dma200: stock.indicators.dma200,
          ema20: stock.indicators.ema20,
          ema50: stock.indicators.ema50,
          rsi: stock.indicators.rsi,
          weekly_rsi: stock.indicators.weekly_rsi,
          atr: stock.indicators.atr,
          atr_pct: stock.indicators.atr_pct,
          volume_vs_avg: stock.indicators.volume_vs_avg,
          distance_from_20dma_pct: stock.indicators.distance_from_20dma_pct,
          weekly_change_pct: stock.indicators.weekly_change_pct,
          high_52w: stock.indicators.high_52w,
          ema_stack_bullish: stock.indicators.ema_stack_bullish,
          weekly_pivot: stock.indicators.weekly_pivot,
          weekly_r1: stock.indicators.weekly_r1,
          weekly_r2: stock.indicators.weekly_r2,
          weekly_s1: stock.indicators.weekly_s1
        },
        levels: stock.levels ? {
          entry: stock.levels.entry,
          entryRange: stock.levels.entryRange,
          stop: stock.levels.stop,
          target: stock.levels.target,
          target2: stock.levels.target2 || null,
          targetBasis: stock.levels.targetBasis,
          dailyR1Check: stock.levels.dailyR1Check || null,
          riskReward: stock.levels.riskReward,
          riskPercent: stock.levels.riskPercent,
          rewardPercent: stock.levels.rewardPercent,
          entryType: stock.levels.entryType,
          mode: stock.levels.mode,
          archetype: stock.levels.archetype || null,
          reason: stock.levels.reason
        } : null,
        status: 'WATCHING'
      }));

      const addResult = await WeeklyWatchlist.addStocks(stocksToAdd);
      console.log(`[TEST] ✅ Added ${addResult.added} new stocks, updated ${addResult.updated} existing`);

      // Verify persisted data
      const watchlist = await WeeklyWatchlist.getOrCreateCurrentWeek();
      console.log(`[TEST] Watchlist now has ${watchlist.stocks.length} stocks`);

      // Check a sample stock's persisted data
      if (watchlist.stocks.length > 0) {
        const sample = watchlist.stocks[0];
        console.log('[TEST] Sample persisted stock:');
        console.log(`  Symbol: ${sample.symbol}`);
        console.log(`  Archetype: ${sample.levels?.archetype || 'N/A'}`);
        console.log(`  Target Basis: ${sample.levels?.targetBasis || 'N/A'}`);
        console.log(`  Weekly RSI: ${sample.screening_data?.weekly_rsi || 'N/A'}`);
        console.log(`  52W High: ${sample.screening_data?.high_52w || 'N/A'}`);
      }
    }
    console.log('');

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5: AI Analysis
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('─'.repeat(80));
    console.log('[TEST] STEP 5/5: Generating AI analysis...');
    console.log('─'.repeat(80));

    if (SKIP_AI) {
      console.log('[TEST] AI analysis SKIPPED (--skip-ai flag)');
    } else if (DRY_RUN) {
      console.log('[TEST] DRY RUN - Skipping AI analysis');
      console.log('[TEST] Would analyze the following stocks:');
      qualifiedStocks.slice(0, 4).forEach((s, i) => {
        console.log(`  ${i + 1}. ${s.symbol} (${s.grade}) - archetype: ${s.levels?.archetype || 'N/A'}`);
      });
    } else {
      const stocksForAI = qualifiedStocks.slice(0, 4);
      console.log(`[TEST] Generating Claude analysis for ${stocksForAI.length} stocks: ${stocksForAI.map(s => s.symbol).join(', ')}`);
      console.log('');

      if (!process.env.ANTHROPIC_API_KEY) {
        console.log('[TEST] ⚠️ ANTHROPIC_API_KEY not set - skipping AI analysis');
      } else {
        try {
          const analysisResults = await weeklyAnalysisService.generateMultipleAnalyses(stocksForAI, 4);
          const successCount = analysisResults.filter(a => a?.status === 'completed').length;

          console.log(`[TEST] ✅ Generated ${successCount}/${stocksForAI.length} AI analyses`);

          // Show sample analysis
          const successfulAnalysis = analysisResults.find(a => a?.status === 'completed');
          if (successfulAnalysis) {
            console.log('[TEST] Sample analysis output:');
            console.log(`  Symbol: ${successfulAnalysis.stock_symbol}`);
            console.log(`  Status: ${successfulAnalysis.status}`);
            console.log(`  Verdict: ${successfulAnalysis.analysis_data?.verdict?.action || 'N/A'}`);
            console.log(`  Confidence: ${successfulAnalysis.analysis_data?.verdict?.confidence || 'N/A'}`);
            console.log(`  One-liner: ${successfulAnalysis.analysis_data?.verdict?.one_liner || 'N/A'}`);

            // Check for ATH_NO_RESISTANCE warning
            const athWarning = successfulAnalysis.analysis_data?.warnings?.find(w => w.code === 'ATH_NO_RESISTANCE');
            if (athWarning) {
              console.log(`  ⚠️ ATH_NO_RESISTANCE warning: ${athWarning.message}`);
            }
          }
        } catch (aiError) {
          console.error(`[TEST] ❌ AI analysis failed: ${aiError.message}`);
        }
      }
    }
    console.log('');

    // ═══════════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('═'.repeat(80));
    console.log('  TEST COMPLETE');
    console.log('═'.repeat(80));
    console.log(`  Scan results: ${scanResults.length} stocks`);
    console.log(`  Enriched: ${metadata.total_enriched} stocks`);
    console.log(`  Eliminated (RSI > 72): ${metadata.total_eliminated} stocks`);
    console.log(`  Qualified (score >= ${MIN_SCORE}): ${qualifiedStocks.length} stocks`);
    console.log(`  52W Breakout stocks: ${breakoutStocks.length}`);
    console.log('═'.repeat(80));
    console.log('');

  } catch (error) {
    console.error('');
    console.error('[TEST] ❌ TEST FAILED');
    console.error(`[TEST] Error: ${error.message}`);
    console.error(`[TEST] Stack: ${error.stack}`);
    process.exit(1);

  } finally {
    if (db) {
      await mongoose.disconnect();
      console.log('[TEST] Disconnected from MongoDB');
    }
  }
}

// Run the test
runTest();
