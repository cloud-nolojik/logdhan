/**
 * Manual Weekly Analysis Script
 *
 * Takes the existing weekly watchlist and runs analysis using last Friday's data.
 * Useful when weekend screening ran but analysis didn't complete, or when you
 * want to re-run analysis with fresh AI models.
 *
 * Usage:
 *   node src/scripts/runWeeklyAnalysis.js
 *   node src/scripts/runWeeklyAnalysis.js --dry-run    # Preview without running analysis
 *   node src/scripts/runWeeklyAnalysis.js --force      # Force re-analyze even if cached
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

// Load environment variables from backend/.env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Parse command line args
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const forceRevalidate = args.includes('--force');
const isSync = args.includes('--sync'); // Wait for completion

async function runWeeklyAnalysis() {
  console.log('\n' + '='.repeat(60));
  console.log('📊 MANUAL WEEKLY ANALYSIS');
  console.log('='.repeat(60));
  console.log(`Mode: ${isDryRun ? 'DRY RUN (preview only)' : 'LIVE'}`);
  console.log(`Force Revalidate: ${forceRevalidate ? 'YES (bypass cache)' : 'NO (use cache if valid)'}`);
  console.log(`Sync Mode: ${isSync ? 'YES (wait for completion)' : 'NO (trigger and exit)'}`);
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  try {
    // Connect to MongoDB
    console.log('\n🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Import models and services
    const WeeklyWatchlist = (await import('../models/weeklyWatchlist.js')).default;
    const MarketHoursUtil = (await import('../utils/marketHours.js')).default;

    // Get current week's watchlist
    console.log('\n📋 Fetching current week watchlist...');
    const watchlist = await WeeklyWatchlist.getCurrentWeek();

    if (!watchlist) {
      console.log('❌ No weekly watchlist found for current week');
      console.log('💡 Run weekend screening first: node src/scripts/testWeekendScreening.js');
      process.exit(1);
    }

    console.log(`✅ Found watchlist: ${watchlist.week_label}`);
    console.log(`   Week: ${watchlist.week_start?.toISOString().split('T')[0]} to ${watchlist.week_end?.toISOString().split('T')[0]}`);
    console.log(`   Total stocks: ${watchlist.stocks.length}`);
    console.log(`   Status: ${watchlist.status}`);
    console.log(`   Screened at: ${watchlist.screening_run_at?.toISOString() || 'N/A'}`);

    // Filter active stocks
    const activeStocks = watchlist.stocks.filter(s =>
      ['WATCHING', 'APPROACHING', 'TRIGGERED'].includes(s.status)
    );

    const stocksWithAnalysis = watchlist.stocks.filter(s => s.analysis_id);
    const stocksWithoutAnalysis = watchlist.stocks.filter(s => !s.analysis_id);

    console.log(`\n📈 Stock breakdown:`);
    console.log(`   Active stocks: ${activeStocks.length}`);
    console.log(`   With analysis: ${stocksWithAnalysis.length} ✅`);
    console.log(`   Without analysis: ${stocksWithoutAnalysis.length} ⏳`);

    if (activeStocks.length === 0) {
      console.log('\n❌ No active stocks to analyze');
      process.exit(0);
    }

    // Show stocks to be analyzed
    console.log('\n📋 Stocks to analyze:');
    console.log('-'.repeat(60));
    activeStocks.forEach((stock, i) => {
      const hasAnalysis = stock.analysis_id ? '✅' : '⏳';
      const scoreDisplay = stock.setup_score ? `Score: ${stock.setup_score}` : '';
      console.log(`   ${i + 1}. ${stock.symbol.padEnd(15)} ${stock.scan_type?.padEnd(20) || 'unknown'.padEnd(20)} Grade ${stock.grade || 'N/A'} ${hasAnalysis} ${scoreDisplay}`);
    });

    // Get Friday cutoff
    const fridayCutoff = MarketHoursUtil.getMostRecentFriday();
    console.log(`\n📅 Data cutoff: ${fridayCutoff.toISOString()}`);
    console.log(`   (Using only candle data up to last Friday's close)`);

    if (isDryRun) {
      console.log('\n🔍 DRY RUN - No analysis will be executed');
      console.log('   Remove --dry-run to run actual analysis');

      // Show what would happen
      console.log('\n📝 Would trigger bulk analysis with:');
      console.log(`   source: 'chartink'`);
      console.log(`   analyzeAllChartink: true`);
      console.log(`   useLastFridayData: true`);
      console.log(`   forceRevalidate: ${forceRevalidate}`);
      console.log(`   skipTradingDayCheck: true`);

      process.exit(0);
    }

    // Initialize the bulk analysis service
    console.log('\n🚀 Initializing bulk analysis service...');
    const agendaScheduledBulkAnalysisService = (await import('../services/agendaScheduledBulkAnalysis.service.js')).default;
    await agendaScheduledBulkAnalysisService.initialize();
    console.log('✅ Bulk analysis service initialized');

    if (isSync) {
      // Synchronous mode: Run analysis directly and wait for completion
      console.log('\n📊 Starting bulk analysis (synchronous mode)...');
      console.log('   This may take several minutes depending on stock count...\n');

      const result = await agendaScheduledBulkAnalysisService.runScheduledAnalysis({
        source: 'chartink',
        analyzeAllChartink: true,
        useLastFridayData: true,
        forceRevalidate: forceRevalidate,
        skipTradingDayCheck: true
      });

      console.log('\n' + '='.repeat(60));
      console.log('📊 ANALYSIS COMPLETE');
      console.log('='.repeat(60));
      console.log(`   Stocks analyzed: ${result?.summary?.stocksAnalyzed || 'N/A'}`);
      console.log(`   Successful: ${result?.summary?.successful || 'N/A'}`);
      console.log(`   Failed: ${result?.summary?.failed || 'N/A'}`);
      console.log(`   Cached: ${result?.summary?.cached || 'N/A'}`);

    } else {
      // Async mode: Trigger job and exit
      console.log('\n📊 Triggering bulk analysis job...');

      const result = await agendaScheduledBulkAnalysisService.triggerManually(
        'Manual weekly analysis script',
        {
          source: 'chartink',
          analyzeAllChartink: true,
          useLastFridayData: true,
          forceRevalidate: forceRevalidate,
          skipTradingDayCheck: true
        }
      );

      console.log('\n✅ Analysis job triggered successfully!');
      console.log(`   Job ID: ${result.jobId}`);
      console.log(`   Job Name: ${result.jobName}`);
      console.log(`   Scheduled at: ${result.scheduledAt}`);

      console.log('\n⏳ Analysis running in background...');
      console.log('   Check PM2 logs for progress: pm2 logs logdhan');
      console.log('   Or add --sync flag to wait for completion');

      // Give some time for job to start
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Weekly analysis completed successfully');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');

    try {
      // Stop agenda if running
      const agendaScheduledBulkAnalysisService = (await import('../services/agendaScheduledBulkAnalysis.service.js')).default;
      await agendaScheduledBulkAnalysisService.stop();
    } catch (e) {
      // Ignore shutdown errors
    }

    await mongoose.disconnect();
    console.log('✅ Disconnected from MongoDB');

    console.log(`\nFinished at: ${new Date().toISOString()}`);

    process.exit(0);
  }
}

// Run the script
runWeeklyAnalysis();
