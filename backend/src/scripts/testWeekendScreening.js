/**
 * Test Script: Weekend Screening Job
 *
 * Manually triggers the Saturday 6 PM screening job for testing.
 * This will:
 * 1. Run ChartInk scans (breakout, pullback)
 * 2. Enrich stocks with technical indicators
 * 3. Filter for Grade A (80+) stocks only
 * 4. Add to WeeklyWatchlist for all active users
 * 5. Trigger bulk AI analysis
 *
 * Usage:
 *   node src/scripts/testWeekendScreening.js
 *   node src/scripts/testWeekendScreening.js --dry-run     # Preview without saving
 *   node src/scripts/testWeekendScreening.js --skip-bulk   # Skip AI analysis trigger
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import weekendScreeningJob from '../services/jobs/weekendScreeningJob.js';

// Load environment variables from backend/.env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Parse command line args
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const skipBulk = args.includes('--skip-bulk');
const isDebug = args.includes('--debug');

async function testWeekendScreening() {
  console.log('='.repeat(60));
  console.log('🧪 TEST: Weekend Screening Job');
  console.log('='.repeat(60));
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes saved)' : 'LIVE'}`);
  console.log(`Skip Bulk Analysis: ${skipBulk ? 'YES' : 'NO'}`);
  console.log(`Debug Mode: ${isDebug ? 'YES' : 'NO'}`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  try {
    // Connect to MongoDB
    console.log('\n📦 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected');

    // Initialize the screening job (sets up Agenda)
    console.log('\n🔧 Initializing weekend screening job...');
    await weekendScreeningJob.initialize();
    console.log('✅ Job initialized');

    if (isDryRun) {
      // Dry run: Just run the screening logic without saving
      console.log('\n🔍 DRY RUN: Running screening logic (no changes will be saved)...');

      // Import services directly for dry run
      const chartinkService = (await import('../services/chartinkService.js')).default;
      const stockEnrichmentService = (await import('../services/stockEnrichmentService.js')).default;

      // Run ChartInk scans
      console.log('\n📊 Running ChartInk scans...');
      const scanTypes = ['a_plus_momentum'];
      const allResults = [];

      for (const scanType of scanTypes) {
        try {
          let scanResults = [];
          switch (scanType) {
            case 'a_plus_momentum':
              scanResults = await chartinkService.runAPlusNextWeekScan();
              break;
            // Legacy scans - commented out
            // case 'breakout':
            //   scanResults = await chartinkService.runBreakoutScan();
            //   break;
            // case 'pullback':
            //   scanResults = await chartinkService.runPullbackScan();
            //   break;
            // case 'momentum':
            //   scanResults = await chartinkService.runMomentumScan();
            //   break;
            // case 'consolidation_breakout':
            //   scanResults = await chartinkService.runConsolidationScan();
            //   break;
          }
          console.log(`   ${scanType}: ${scanResults.length} results`);
          allResults.push(...scanResults.map(s => ({ ...s, scan_type: scanType })));
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          console.error(`   ❌ ${scanType} scan failed:`, error.message);
        }
      }

      console.log(`\n📈 Total scan results: ${allResults.length}`);

      if (allResults.length > 0) {
        // Enrich stocks
        console.log('\n🔬 Enriching stocks with technical indicators...');
        const { stocks: enrichedStocks, metadata } = await stockEnrichmentService.runEnrichmentPipeline(
          allResults,
          { minScore: 0, maxResults: 100, debug: isDebug, debugCount: 5 }
        );

        console.log(`   Enriched: ${enrichedStocks.length} stocks`);
        console.log(`   Grade distribution: A=${metadata.grade_distribution.A}, B=${metadata.grade_distribution.B}, C=${metadata.grade_distribution.C}`);

        // Filter Grade A
        const gradeAStocks = enrichedStocks
          .filter(s => s.setup_score >= 80)
          .sort((a, b) => b.setup_score - a.setup_score)
          .slice(0, 15);

        console.log(`\n🏆 Grade A stocks (80+): ${gradeAStocks.length}`);

        if (gradeAStocks.length > 0) {
          console.log('\n📋 Top Grade A Stocks:');
          console.log('-'.repeat(60));
          gradeAStocks.forEach((stock, i) => {
            console.log(`   ${i + 1}. ${stock.symbol} - Score: ${stock.setup_score} (${stock.grade}) - ${stock.scan_type}`);
            console.log(`      Price: ₹${stock.current_price}, ATR%: ${stock.indicators?.atr_pct?.toFixed(2)}%`);
          });
        } else {
          console.log('   ⚠️ No Grade A stocks found');
        }
      }

      console.log('\n✅ DRY RUN complete - no changes were saved');

    } else {
      // Live run: Trigger the actual job
      console.log('\n🚀 Triggering weekend screening job...');

      const options = {
        scanTypes: ['a_plus_momentum']
      };

      // If skip-bulk flag, we need to modify the job behavior
      // For now, just run the screening directly
      const result = await weekendScreeningJob.runWeekendScreening(options);

      console.log('\n📊 Screening Results:');
      console.log('-'.repeat(60));
      console.log(`   Users processed: ${result.usersProcessed}`);
      console.log(`   Total stocks added: ${result.totalStocksAdded}`);
      console.log(`   Errors: ${result.errors?.length || 0}`);

      if (result.scanResults) {
        console.log('\n   Scan breakdown:');
        Object.entries(result.scanResults).forEach(([type, count]) => {
          console.log(`      ${type}: ${count} results`);
        });
      }

      if (result.errors?.length > 0) {
        console.log('\n   ⚠️ Errors encountered:');
        result.errors.forEach(err => {
          console.log(`      - ${err.scanType || err.userId}: ${err.error}`);
        });
      }

      // Trigger bulk analysis unless skipped
      if (!skipBulk && result.totalStocksAdded > 0) {
        console.log('\n🤖 Running bulk AI analysis (this may take a few minutes)...');
        try {
          const agendaScheduledBulkAnalysisService = (await import('../services/agendaScheduledBulkAnalysis.service.js')).default;
          await agendaScheduledBulkAnalysisService.initialize();

          // Run the analysis directly instead of scheduling it (so we wait for completion)
          console.log('[BULK ANALYSIS] Starting synchronous analysis run...');
          await agendaScheduledBulkAnalysisService.runScheduledAnalysis({
            source: 'chartink',
            skipTradingDayCheck: true
          });
          console.log('✅ Bulk analysis completed!');
        } catch (bulkError) {
          console.error('❌ Bulk analysis failed:', bulkError.message);
          console.error(bulkError.stack);
        }
      } else if (skipBulk) {
        console.log('\n⏭️ Skipping bulk AI analysis (--skip-bulk flag)');
      } else if (result.totalStocksAdded === 0) {
        console.log('\n⏭️ Skipping bulk AI analysis (no stocks added)');
      }

      console.log('\n✅ Weekend screening completed successfully');
    }

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error(error.stack);
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');

    try {
      await weekendScreeningJob.shutdown();
    } catch (e) {
      // Ignore shutdown errors
    }

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');

    console.log('\n' + '='.repeat(60));
    console.log(`Finished at: ${new Date().toISOString()}`);
    console.log('='.repeat(60));

    process.exit(0);
  }
}

// Run the test
testWeekendScreening();
