#!/usr/bin/env node

/**
 * Prefetch Candle Data for All Stocks
 *
 * This script fetches and stores candle data for all stocks in the database
 * using the candleFetcher service. Processes stocks one by one to avoid
 * overwhelming the API.
 *
 * Usage: node src/scripts/prefetchAllStockData.js
 */

import '../loadEnv.js';
import mongoose from 'mongoose';
import Stock from '../models/stock.js';
import PreFetchedData from '../models/preFetchedData.js';
import candleFetcherService from '../services/candleFetcher.service.js';

// Configuration
const BATCH_SIZE = 10; // Process 10 stocks at a time
const DELAY_BETWEEN_STOCKS = 5000; // 5 seconds delay between stocks (increased to avoid API rate limits)
const DELAY_BETWEEN_BATCHES = 15000; // 15 seconds delay between batches

// Statistics
const stats = {
    total: 0,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    errors: []
};

// Helper: Delay function
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: Format time
function formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

// Check if stock already has all 3 timeframes in DB
async function hasCompleteData(instrumentKey) {
    try {
        const existingRecords = await PreFetchedData.find({
            instrument_key: instrumentKey,
            timeframe: { $in: ['15m', '1h', '1d'] }
        }).lean();

        // Should have exactly 3 records (one for each timeframe)
        return existingRecords.length === 3;
    } catch (error) {
        console.error(`Error checking existing data: ${error.message}`);
        return false;
    }
}

// Process a single stock
// Returns true if skipped, false if processed
async function processStock(stock, index, total) {
    const startTime = Date.now();

    try {
        console.log(`\n[${'='.repeat(80)}]`);
        console.log(`[${index + 1}/${total}] Processing: ${stock.trading_symbol} (${stock.name})`);
        console.log(`[Instrument Key: ${stock.instrument_key}]`);
        console.log(`[${'='.repeat(80)}]\n`);

        // Check if data already exists
        const hasData = await hasCompleteData(stock.instrument_key);
        if (hasData) {
            stats.skipped++;
            stats.processed++;
            console.log(`⏭️  [SKIPPED] ${stock.trading_symbol} - Data already exists (3/3 timeframes)`);
            console.log(`📊 Progress: ${stats.processed}/${total} (${((stats.processed / total) * 100).toFixed(1)}%) | ✅ ${stats.success} | ❌ ${stats.failed} | ⏭️ ${stats.skipped}\n`);
            return true; // Skipped
        }

        // Call candleFetcher service to get and store data
        const result = await candleFetcherService.getCandleDataForAnalysis(
            stock.instrument_key,
            'swing' // Using 'swing' term to get 15m, 1h, 1d timeframes
        );

        const duration = Date.now() - startTime;

        if (result.success) {
            stats.success++;
            console.log(`✅ [SUCCESS] ${stock.trading_symbol} - Data fetched and stored`);
            console.log(`   Source: ${result.source}`);
            console.log(`   Timeframes: ${Object.keys(result.data).join(', ')}`);
            Object.keys(result.data).forEach(tf => {
                console.log(`   ${tf}: ${result.data[tf]?.length || 0} candles`);
            });
            console.log(`   Duration: ${formatTime(duration)}\n`);
        } else {
            stats.failed++;
            const errorMsg = result.reason || result.error || 'Unknown error';
            stats.errors.push({ stock: stock.trading_symbol, error: errorMsg });
            console.log(`❌ [FAILED] ${stock.trading_symbol} - ${errorMsg}`);
            console.log(`   Duration: ${formatTime(duration)}\n`);
        }

        stats.processed++;

        // Print progress summary
        const progressPercent = ((stats.processed / total) * 100).toFixed(1);
        console.log(`📊 Progress: ${stats.processed}/${total} (${progressPercent}%) | ✅ ${stats.success} | ❌ ${stats.failed} | ⏭️ ${stats.skipped}`);

        return false; // Processed

    } catch (error) {
        stats.failed++;
        stats.processed++;
        const errorMsg = error.message || 'Unknown exception';
        stats.errors.push({ stock: stock.trading_symbol, error: errorMsg });
        console.log(`❌ [EXCEPTION] ${stock.trading_symbol} - ${errorMsg}\n`);
        return false; // Processed (even if failed)
    }
}

// Main function
async function main() {
    const scriptStartTime = Date.now();

    console.log('\n' + '='.repeat(100));
    console.log('🚀 PREFETCH CANDLE DATA FOR ALL STOCKS');
    console.log('='.repeat(100) + '\n');

    try {
        // Connect to MongoDB
        console.log('📡 Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB\n');

        // Fetch all active stocks from database
        console.log('📊 Fetching stocks from database...');
        const stocks = await Stock.find({
            is_active: true,
            segment: { $in: ['NSE_EQ', 'BSE_EQ'] } // Only equity stocks
        })
        .select('instrument_key trading_symbol name exchange segment')
        .lean();

        stats.total = stocks.length;

        console.log(`✅ Found ${stats.total} active stocks to process\n`);
        console.log(`⚙️  Configuration:`);
        console.log(`   - Batch size: ${BATCH_SIZE} stocks`);
        console.log(`   - Delay between stocks: ${DELAY_BETWEEN_STOCKS}ms`);
        console.log(`   - Delay between batches: ${DELAY_BETWEEN_BATCHES}ms\n`);

        // Estimate time
        const estimatedTime = (stats.total * DELAY_BETWEEN_STOCKS) +
                             (Math.ceil(stats.total / BATCH_SIZE) * DELAY_BETWEEN_BATCHES);
        console.log(`⏱️  Estimated time: ${formatTime(estimatedTime)}\n`);

        console.log('🔄 Starting processing...\n');

        // Process stocks in batches
        for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
            const batch = stocks.slice(i, Math.min(i + BATCH_SIZE, stocks.length));
            const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(stocks.length / BATCH_SIZE);

            console.log(`\n🔷 BATCH ${batchNumber}/${totalBatches} (Stocks ${i + 1}-${Math.min(i + BATCH_SIZE, stocks.length)})\n`);

            // Track if any stock in batch was actually processed
            let batchHadProcessing = false;

            // Process each stock in the batch one by one
            for (let j = 0; j < batch.length; j++) {
                const stock = batch[j];
                const globalIndex = i + j;

                const wasSkipped = await processStock(stock, globalIndex, stocks.length);

                if (!wasSkipped) {
                    batchHadProcessing = true;
                }

                // Only delay if stock was actually processed (not skipped)
                // Skip delay for last stock in batch
                if (!wasSkipped && j < batch.length - 1) {
                    await delay(DELAY_BETWEEN_STOCKS);
                }
            }

            // Only delay between batches if we actually processed stocks in this batch
            // Skip delay for last batch
            if (batchHadProcessing && i + BATCH_SIZE < stocks.length) {
                console.log(`\n⏸️  Waiting ${DELAY_BETWEEN_BATCHES}ms before next batch...\n`);
                await delay(DELAY_BETWEEN_BATCHES);
            }
        }

        // Final summary
        const totalDuration = Date.now() - scriptStartTime;

        console.log('\n' + '='.repeat(100));
        console.log('📊 FINAL SUMMARY');
        console.log('='.repeat(100));
        console.log(`\nTotal stocks: ${stats.total}`);
        console.log(`Processed: ${stats.processed}`);
        console.log(`✅ Success: ${stats.success}`);
        console.log(`❌ Failed: ${stats.failed}`);
        console.log(`⏭️  Skipped: ${stats.skipped}`);
        console.log(`\n⏱️  Total duration: ${formatTime(totalDuration)}`);
        console.log(`⚡ Average per stock: ${formatTime(totalDuration / stats.processed)}`);

        if (stats.errors.length > 0) {
            console.log(`\n❌ Failed stocks (${stats.errors.length}):`);
            stats.errors.forEach((err, idx) => {
                console.log(`   ${idx + 1}. ${err.stock}: ${err.error}`);
            });
        }

        console.log('\n' + '='.repeat(100));
        console.log('✅ Script completed successfully!');
        console.log('='.repeat(100) + '\n');

    } catch (error) {
        console.error('\n❌ Script failed with error:', error);
        console.error(error.stack);
        process.exit(1);
    } finally {
        // Close MongoDB connection
        await mongoose.connection.close();
        console.log('📡 MongoDB connection closed\n');
        process.exit(0);
    }
}

// Run the script
main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
