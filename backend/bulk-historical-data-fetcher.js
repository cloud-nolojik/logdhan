/**
 * Bulk Historical Data Fetcher Script
 * 
 * Fetches historical data for ALL stocks in the Stock schema using candleFetcher.service.js
 * Adheres to Upstox API rate limits:
 * - Per second: 50 requests
 * - Per minute: 500 requests  
 * - Per 30 minutes: 2000 requests
 * 
 * Features:
 * - Rate limiting with intelligent throttling
 * - Deletes existing data and adds fresh records
 * - Progress tracking and error handling
 * - Resume capability for large datasets
 * - Comprehensive logging
 */

import mongoose from 'mongoose';
import Stock from './src/models/stock.js';
import PreFetchedData from './src/models/preFetchedData.js';
import candleFetcherService from './src/services/candleFetcher.service.js';
import './src/loadEnv.js';

class BulkHistoricalDataFetcher {
    constructor() {
        // Rate limiting configuration
        this.rateLimits = {
            perSecond: 50,
            perMinute: 500,
            per30Minutes: 2000
        };
        
        // Tracking counters
        this.requestCounters = {
            currentSecond: 0,
            currentMinute: 0,
            current30Minutes: 0,
            lastSecondReset: Date.now(),
            lastMinuteReset: Date.now(),
            last30MinuteReset: Date.now()
        };
        
        // Progress tracking
        this.progress = {
            totalStocks: 0,
            processedStocks: 0,
            successfulFetches: 0,
            failedFetches: 0,
            skippedStocks: 0,
            startTime: Date.now(),
            errors: []
        };
        
        // Timeframes to fetch
        this.timeframes = [
            { name: '15m', upstoxInterval: '15minute', bars: 400 },
            { name: '1h', upstoxInterval: '1hour', bars: 900 },
            { name: '1d', upstoxInterval: 'day', bars: 250 }
        ];
        
        // Resume capability
        this.resumeFromStock = null;
        this.batchSize = 10; // Process stocks in batches
    }
    
    /**
     * Reset rate limit counters based on time windows
     */
    resetRateLimitCounters() {
        const now = Date.now();
        
        // Reset per-second counter
        if (now - this.requestCounters.lastSecondReset >= 1000) {
            this.requestCounters.currentSecond = 0;
            this.requestCounters.lastSecondReset = now;
        }
        
        // Reset per-minute counter
        if (now - this.requestCounters.lastMinuteReset >= 60000) {
            this.requestCounters.currentMinute = 0;
            this.requestCounters.lastMinuteReset = now;
        }
        
        // Reset per-30-minute counter
        if (now - this.requestCounters.last30MinuteReset >= 1800000) {
            this.requestCounters.current30Minutes = 0;
            this.requestCounters.last30MinuteReset = now;
        }
    }
    
    /**
     * Check if we can make a request without exceeding rate limits
     */
    canMakeRequest() {
        this.resetRateLimitCounters();
        
        return (
            this.requestCounters.currentSecond < this.rateLimits.perSecond &&
            this.requestCounters.currentMinute < this.rateLimits.perMinute &&
            this.requestCounters.current30Minutes < this.rateLimits.per30Minutes
        );
    }
    
    /**
     * Increment request counters
     */
    incrementRequestCounters() {
        this.requestCounters.currentSecond++;
        this.requestCounters.currentMinute++;
        this.requestCounters.current30Minutes++;
    }
    
    /**
     * Calculate how long to wait before next request
     */
    calculateWaitTime() {
        this.resetRateLimitCounters();
        
        // Check each rate limit and return the longest wait time needed
        let waitTime = 0;
        
        if (this.requestCounters.currentSecond >= this.rateLimits.perSecond) {
            const timeToNextSecond = 1000 - (Date.now() - this.requestCounters.lastSecondReset);
            waitTime = Math.max(waitTime, timeToNextSecond);
        }
        
        if (this.requestCounters.currentMinute >= this.rateLimits.perMinute) {
            const timeToNextMinute = 60000 - (Date.now() - this.requestCounters.lastMinuteReset);
            waitTime = Math.max(waitTime, timeToNextMinute);
        }
        
        if (this.requestCounters.current30Minutes >= this.rateLimits.per30Minutes) {
            const timeToNext30Minutes = 1800000 - (Date.now() - this.requestCounters.last30MinuteReset);
            waitTime = Math.max(waitTime, timeToNext30Minutes);
        }
        
        return Math.max(waitTime, 100); // Minimum 100ms between requests
    }
    
    /**
     * Wait with rate limiting
     */
    async waitForRateLimit() {
        while (!this.canMakeRequest()) {
            const waitTime = this.calculateWaitTime();
            console.log(`⏳ [RATE LIMIT] Waiting ${waitTime}ms (${this.requestCounters.currentSecond}/s, ${this.requestCounters.currentMinute}/min, ${this.requestCounters.current30Minutes}/30min)`);
            await this.sleep(waitTime);
        }
    }
    
    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Get all stocks from database
     */
    async getAllStocks() {
        try {
            console.log('📊 [STOCK FETCH] Getting all stocks from database...');
            
            const stocks = await Stock.find({
                segment: { $in: ['NSE_EQ', 'BSE_EQ'] },
                instrument_key: { $exists: true, $ne: null }
            })
            .select('segment name exchange trading_symbol instrument_key short_name')
            .lean();
            
            console.log(`✅ [STOCK FETCH] Found ${stocks.length} stocks with valid instrument_key`);
            
            // Group by exchange for better organization
            const stocksByExchange = stocks.reduce((acc, stock) => {
                if (!acc[stock.exchange]) acc[stock.exchange] = [];
                acc[stock.exchange].push(stock);
                return acc;
            }, {});
            
            console.log('📋 [STOCK BREAKDOWN]:');
            Object.entries(stocksByExchange).forEach(([exchange, stockList]) => {
                console.log(`   ${exchange}: ${stockList.length} stocks`);
            });
            
            return stocks;
        } catch (error) {
            console.error('❌ [STOCK FETCH] Error getting stocks:', error);
            throw error;
        }
    }
    
    /**
     * Delete existing data for a stock
     */
    async deleteExistingData(instrumentKey) {
        try {
            console.log(`🗑️ [CLEANUP] Deleting existing data for ${instrumentKey}...`);
            
            const result = await PreFetchedData.deleteMany({
                instrument_key: instrumentKey
            });
            
            console.log(`✅ [CLEANUP] Deleted ${result.deletedCount} existing records for ${instrumentKey}`);
            return result.deletedCount;
        } catch (error) {
            console.error(`❌ [CLEANUP] Error deleting data for ${instrumentKey}:`, error);
            return 0;
        }
    }
    
    /**
     * Fetch historical data for a single stock
     */
    async fetchStockData(stock) {
        const stockId = `${stock.trading_symbol} (${stock.instrument_key})`;
        
        try {
            console.log(`\\n${'='.repeat(80)}`);
            console.log(`🎯 [PROCESSING] ${stockId}`);
            console.log(`${'='.repeat(80)}`);
            
            // Delete existing data first
            const deletedCount = await this.deleteExistingData(stock.instrument_key);
            
            let successCount = 0;
            let errorCount = 0;
            
            // Fetch data for each timeframe
            for (const timeframe of this.timeframes) {
                try {
                    console.log(`\\n📈 [TIMEFRAME] Fetching ${timeframe.name} data for ${stockId}...`);
                    
                    // Wait for rate limit
                    await this.waitForRateLimit();
                    
                    // Increment counters before request
                    this.incrementRequestCounters();
                    
                    // Make the API call through candleFetcher service
                    const result = await candleFetcherService.getCandleDataForAnalysis(
                        stock.instrument_key,
                        'swing' // Use swing analysis type
                    );
                    
                    if (result && result.success !== false) {
                        console.log(`✅ [TIMEFRAME] ${timeframe.name} data fetched successfully for ${stockId}`);
                        successCount++;
                    } else {
                        console.log(`⚠️ [TIMEFRAME] ${timeframe.name} data fetch failed for ${stockId}: ${result?.message || 'Unknown error'}`);
                        errorCount++;
                    }
                    
                    // Small delay between timeframes
                    await this.sleep(100);
                    
                } catch (timeframeError) {
                    console.error(`❌ [TIMEFRAME] Error fetching ${timeframe.name} for ${stockId}:`, timeframeError.message);
                    errorCount++;
                }
            }
            
            console.log(`\\n📊 [SUMMARY] ${stockId}: ${successCount} successful, ${errorCount} failed`);
            
            return {
                success: successCount > 0,
                successCount,
                errorCount,
                deletedCount
            };
            
        } catch (error) {
            console.error(`❌ [PROCESSING] Error processing ${stockId}:`, error);
            return {
                success: false,
                successCount: 0,
                errorCount: this.timeframes.length,
                deletedCount: 0,
                error: error.message
            };
        }
    }
    
    /**
     * Process stocks in batches
     */
    async processBatch(stocks, batchIndex) {
        console.log(`\\n${'='.repeat(100)}`);
        console.log(`🚀 [BATCH ${batchIndex + 1}] Processing ${stocks.length} stocks`);
        console.log(`${'='.repeat(100)}`);
        
        const batchResults = [];
        
        for (let i = 0; i < stocks.length; i++) {
            const stock = stocks[i];
            
            console.log(`\\n📍 [PROGRESS] Stock ${this.progress.processedStocks + 1}/${this.progress.totalStocks} (${((this.progress.processedStocks / this.progress.totalStocks) * 100).toFixed(1)}%)`);
            
            const result = await this.fetchStockData(stock);
            batchResults.push(result);
            
            // Update progress
            this.progress.processedStocks++;
            
            if (result.success) {
                this.progress.successfulFetches++;
            } else {
                this.progress.failedFetches++;
                this.progress.errors.push({
                    stock: stock.trading_symbol,
                    instrument_key: stock.instrument_key,
                    error: result.error
                });
            }
            
            // Progress update every 10 stocks
            if (this.progress.processedStocks % 10 === 0) {
                this.printProgress();
            }
        }
        
        return batchResults;
    }
    
    /**
     * Print current progress
     */
    printProgress() {
        const elapsed = (Date.now() - this.progress.startTime) / 1000;
        const rate = this.progress.processedStocks / elapsed;
        const eta = this.progress.totalStocks > this.progress.processedStocks ? 
            (this.progress.totalStocks - this.progress.processedStocks) / rate : 0;
        
        console.log(`\\n${'='.repeat(100)}`);
        console.log(`📊 [PROGRESS REPORT]`);
        console.log(`${'='.repeat(100)}`);
        console.log(`📈 Processed: ${this.progress.processedStocks}/${this.progress.totalStocks} (${((this.progress.processedStocks / this.progress.totalStocks) * 100).toFixed(1)}%)`);
        console.log(`✅ Successful: ${this.progress.successfulFetches}`);
        console.log(`❌ Failed: ${this.progress.failedFetches}`);
        console.log(`⏱️ Elapsed: ${Math.round(elapsed)}s`);
        console.log(`🚀 Rate: ${rate.toFixed(2)} stocks/sec`);
        console.log(`⏰ ETA: ${Math.round(eta)}s`);
        console.log(`📊 Rate Limits: ${this.requestCounters.currentSecond}/50 per sec, ${this.requestCounters.currentMinute}/500 per min, ${this.requestCounters.current30Minutes}/2000 per 30min`);
        console.log(`${'='.repeat(100)}`);
    }
    
    /**
     * Main execution method
     */
    async run() {
        try {
            console.log('🚀 [BULK FETCH] Starting bulk historical data fetcher...');
            console.log(`📋 [CONFIG] Rate limits: ${this.rateLimits.perSecond}/s, ${this.rateLimits.perMinute}/min, ${this.rateLimits.per30Minutes}/30min`);
            console.log(`📋 [CONFIG] Timeframes: ${this.timeframes.map(t => t.name).join(', ')}`);
            console.log(`📋 [CONFIG] Batch size: ${this.batchSize} stocks`);
            
            // Connect to MongoDB
            await mongoose.connect(process.env.MONGODB_URI);
            console.log('✅ [DATABASE] Connected to MongoDB');
            
            // Get all stocks
            const allStocks = await this.getAllStocks();
            this.progress.totalStocks = allStocks.length;
            
            if (allStocks.length === 0) {
                console.log('⚠️ [BULK FETCH] No stocks found to process');
                return;
            }
            
            // Find resume point if specified
            let startIndex = 0;
            if (this.resumeFromStock) {
                startIndex = allStocks.findIndex(stock => 
                    stock.trading_symbol === this.resumeFromStock ||
                    stock.instrument_key === this.resumeFromStock
                );
                if (startIndex === -1) {
                    console.log(`⚠️ [RESUME] Stock '${this.resumeFromStock}' not found, starting from beginning`);
                    startIndex = 0;
                } else {
                    console.log(`🔄 [RESUME] Starting from stock: ${allStocks[startIndex].trading_symbol}`);
                    this.progress.processedStocks = startIndex;
                }
            }
            
            // Process stocks in batches
            const stocksToProcess = allStocks.slice(startIndex);
            const batches = [];
            
            for (let i = 0; i < stocksToProcess.length; i += this.batchSize) {
                batches.push(stocksToProcess.slice(i, i + this.batchSize));
            }
            
            console.log(`\\n🎯 [EXECUTION PLAN]`);
            console.log(`   Total stocks: ${this.progress.totalStocks}`);
            console.log(`   Starting from: ${startIndex}`);
            console.log(`   Stocks to process: ${stocksToProcess.length}`);
            console.log(`   Batches: ${batches.length}`);
            console.log(`   Estimated time: ${Math.round((stocksToProcess.length * this.timeframes.length * 0.5) / 60)} minutes`);
            
            // Process each batch
            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                await this.processBatch(batches[batchIndex], batchIndex);
                
                // Longer pause between batches
                if (batchIndex < batches.length - 1) {
                    console.log(`\\n⏸️ [BATCH PAUSE] Waiting 5 seconds before next batch...`);
                    await this.sleep(5000);
                }
            }
            
            // Final summary
            this.printFinalSummary();
            
        } catch (error) {
            console.error('❌ [BULK FETCH] Critical error:', error);
        } finally {
            await mongoose.disconnect();
            console.log('\\n🔌 [DATABASE] Disconnected from MongoDB');
            process.exit(0);
        }
    }
    
    /**
     * Print final summary
     */
    printFinalSummary() {
        const elapsed = (Date.now() - this.progress.startTime) / 1000;
        
        console.log(`\\n${'='.repeat(120)}`);
        console.log(`🎉 [FINAL SUMMARY] Bulk Historical Data Fetch Complete`);
        console.log(`${'='.repeat(120)}`);
        console.log(`📊 Total Stocks Processed: ${this.progress.processedStocks}/${this.progress.totalStocks}`);
        console.log(`✅ Successful Fetches: ${this.progress.successfulFetches}`);
        console.log(`❌ Failed Fetches: ${this.progress.failedFetches}`);
        console.log(`⏱️ Total Duration: ${Math.round(elapsed / 60)} minutes ${Math.round(elapsed % 60)} seconds`);
        console.log(`🚀 Average Rate: ${(this.progress.processedStocks / elapsed).toFixed(2)} stocks/second`);
        console.log(`📈 Success Rate: ${((this.progress.successfulFetches / this.progress.processedStocks) * 100).toFixed(1)}%`);
        
        if (this.progress.errors.length > 0) {
            console.log(`\\n❌ [ERRORS] ${this.progress.errors.length} stocks failed:`);
            this.progress.errors.slice(0, 10).forEach(error => {
                console.log(`   • ${error.stock}: ${error.error}`);
            });
            if (this.progress.errors.length > 10) {
                console.log(`   ... and ${this.progress.errors.length - 10} more`);
            }
        }
        
        console.log(`\\n🎯 [RATE LIMIT USAGE]`);
        console.log(`   Final: ${this.requestCounters.currentSecond}/50 per sec, ${this.requestCounters.currentMinute}/500 per min, ${this.requestCounters.current30Minutes}/2000 per 30min`);
        console.log(`${'='.repeat(120)}`);
        
        console.log(`\\n✅ All historical data fetching completed!`);
        console.log(`📁 Data stored in PreFetchedData collection with fresh timestamps`);
        console.log(`🔄 Ready for monitoring and analysis operations`);
    }
}

// Usage examples:
// Basic usage: node bulk-historical-data-fetcher.js
// Resume from specific stock: node bulk-historical-data-fetcher.js --resume RELIANCE
// Custom batch size: node bulk-historical-data-fetcher.js --batch-size 5

// Parse command line arguments
const args = process.argv.slice(2);
const resumeIndex = args.indexOf('--resume');
const batchSizeIndex = args.indexOf('--batch-size');

// Create and configure fetcher
const fetcher = new BulkHistoricalDataFetcher();

if (resumeIndex !== -1 && args[resumeIndex + 1]) {
    fetcher.resumeFromStock = args[resumeIndex + 1];
}

if (batchSizeIndex !== -1 && args[batchSizeIndex + 1]) {
    fetcher.batchSize = parseInt(args[batchSizeIndex + 1]) || 10;
}

// Run the bulk fetcher
fetcher.run().catch(error => {
    console.error('💥 [FATAL ERROR]:', error);
    process.exit(1);
});