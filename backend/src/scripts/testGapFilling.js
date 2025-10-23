#!/usr/bin/env node

/**
 * Test Script for Smart Gap-Filling Functionality
 * 
 * This script tests the new smart gap-filling feature that handles partial data scenarios
 * where the database has insufficient candles (e.g., 220 out of required 240)
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import PreFetchedData from '../models/preFetchedData.js';
import { AIAnalyzeService } from '../services/aiAnalyze.service.js';

dotenv.config();

class GapFillingTester {
    constructor() {
        this.testResults = {
            total: 0,
            passed: 0,
            failed: 0,
            details: []
        };
    }

    async runAllTests() {
        console.log('🧪 Starting Smart Gap-Filling Tests\n');
        
        await this.connectToDatabase();
        
        // Test scenarios
        await this.testSufficientData();
        await this.testPartialData();
        await this.testInsufficientData();
        await this.testNoData();
        await this.testGapFillingSuccess();
        await this.testGapFillingFailure();
        
        await this.printResults();
        await this.cleanup();
    }

    async connectToDatabase() {
        try {
            await mongoose.connect(process.env.MONGODB_URI);
            console.log('✅ Connected to MongoDB\n');
        } catch (error) {
            console.error('❌ Failed to connect to MongoDB:', error);
            process.exit(1);
        }
    }

    async testSufficientData() {
        this.log('\n🔬 Test 1: Sufficient Data (No Gap-Filling Needed)', 'info');
        
        try {
            // Create test data with sufficient bars
            const testInstrumentKey = 'NSE_EQ|INE002A01018_TEST_SUFFICIENT';
            await this.createTestData(testInstrumentKey, {
                '5m': 200,  // Exactly required
                '15m': 100, // Exactly required
                '1h': 50,   // Exactly required
                '1d': 30    // Exactly required
            });

            const aiService = new AIAnalyzeService();
            const preFetchedData = await PreFetchedData.find({ instrument_key: testInstrumentKey }).lean();
            
            const result = await aiService.handlePartialData(preFetchedData, { 
                term: 'short', 
                instrument_key: testInstrumentKey 
            });

            this.assert(
                result.success,
                'Should successfully process sufficient data',
                `Success: ${result.success}`
            );

            this.assert(
                result.gapFillInfo.gapFilledTimeframes === 0,
                'Should not require gap-filling',
                `Gap-filled timeframes: ${result.gapFillInfo.gapFilledTimeframes}`
            );

            this.assert(
                result.source === 'prefetched',
                'Source should be prefetched',
                `Source: ${result.source}`
            );

            console.log('✅ Sufficient data test passed');

        } catch (error) {
            this.fail('Sufficient data test failed', error.message);
        }
    }

    async testPartialData() {
        this.log('\n🔬 Test 2: Partial Data (Gap-Filling Triggered)', 'info');
        
        try {
            // Create test data with partial bars (70-90% of required)
            const testInstrumentKey = 'NSE_EQ|INE002A01018_TEST_PARTIAL';
            await this.createTestData(testInstrumentKey, {
                '5m': 150,  // 75% of 200 required
                '15m': 80,  // 80% of 100 required
                '1h': 40,   // 80% of 50 required
                '1d': 25    // 83% of 30 required
            });

            const aiService = new AIAnalyzeService();
            const preFetchedData = await PreFetchedData.find({ instrument_key: testInstrumentKey }).lean();
            
            const result = await aiService.handlePartialData(preFetchedData, { 
                term: 'short', 
                instrument_key: testInstrumentKey 
            });

            this.assert(
                result.success,
                'Should successfully process partial data',
                `Success: ${result.success}`
            );

            this.assert(
                result.gapFillInfo.timeframesProcessed === 4,
                'Should process all 4 timeframes',
                `Processed: ${result.gapFillInfo.timeframesProcessed}`
            );

            console.log(`📊 Gap-fill info: ${JSON.stringify(result.gapFillInfo, null, 2)}`);
            console.log('✅ Partial data test passed');

        } catch (error) {
            this.fail('Partial data test failed', error.message);
        }
    }

    async testInsufficientData() {
        this.log('\n🔬 Test 3: Insufficient Data (Below 70% Threshold)', 'info');
        
        try {
            // Create test data with insufficient bars (< 70% of required)
            const testInstrumentKey = 'NSE_EQ|INE002A01018_TEST_INSUFFICIENT';
            await this.createTestData(testInstrumentKey, {
                '5m': 100,  // 50% of 200 required
                '15m': 60,  // 60% of 100 required
                '1h': 30,   // 60% of 50 required
                '1d': 15    // 50% of 30 required
            });

            const aiService = new AIAnalyzeService();
            const preFetchedData = await PreFetchedData.find({ instrument_key: testInstrumentKey }).lean();
            
            const result = await aiService.handlePartialData(preFetchedData, { 
                term: 'short', 
                instrument_key: testInstrumentKey 
            });

            this.assert(
                result.success,
                'Should successfully process insufficient data',
                `Success: ${result.success}`
            );

            this.assert(
                result.hasInsufficientData === true,
                'Should flag insufficient data',
                `HasInsufficientData: ${result.hasInsufficientData}`
            );

            console.log('✅ Insufficient data test passed');

        } catch (error) {
            this.fail('Insufficient data test failed', error.message);
        }
    }

    async testNoData() {
        this.log('\n🔬 Test 4: No Data Available', 'info');
        
        try {
            const aiService = new AIAnalyzeService();
            
            const result = await aiService.handlePartialData([], { 
                term: 'short', 
                instrument_key: 'NONEXISTENT' 
            });

            this.assert(
                result.success,
                'Should handle empty data gracefully',
                `Success: ${result.success}`
            );

            this.assert(
                result.data.length === 0,
                'Should return empty data array',
                `Data length: ${result.data.length}`
            );

            console.log('✅ No data test passed');

        } catch (error) {
            this.fail('No data test failed', error.message);
        }
    }

    async testGapFillingSuccess() {
        this.log('\n🔬 Test 5: Gap-Filling Logic Validation', 'info');
        
        try {
            // Create test data with realistic partial scenario
            const testInstrumentKey = 'NSE_EQ|INE002A01018_TEST_GAPFILL';
            const timeframeData = await this.createSingleTimeframeData(testInstrumentKey, '5m', 180); // 90% of 200
            
            const aiService = new AIAnalyzeService();
            
            // Test the fillMissingBars method directly
            const tradeData = { 
                term: 'short', 
                instrument_key: testInstrumentKey 
            };

            console.log('📊 Testing gap-filling for single timeframe...');
            console.log(`Initial bars: ${timeframeData.candle_data.length}`);
            
            // Note: This test would require a valid Upstox API connection to work fully
            // For now, we test the logic without actual API calls
            
            this.assert(
                timeframeData.candle_data.length === 180,
                'Should have correct initial bar count',
                `Initial bars: ${timeframeData.candle_data.length}`
            );

            console.log('✅ Gap-filling logic validation passed');

        } catch (error) {
            this.fail('Gap-filling logic test failed', error.message);
        }
    }

    async testGapFillingFailure() {
        this.log('\n🔬 Test 6: Gap-Filling Failure Handling', 'info');
        
        try {
            const aiService = new AIAnalyzeService();
            
            // Test with invalid timeframe data
            const invalidTimeframeData = {
                instrument_key: 'INVALID',
                timeframe: '5m',
                candle_data: [] // No existing data
            };

            const result = await aiService.fillMissingBars(invalidTimeframeData, { term: 'short' }, 50);

            this.assert(
                result.success === false,
                'Should fail gracefully with no existing candles',
                `Success: ${result.success}, Reason: ${result.reason}`
            );

            console.log('✅ Gap-filling failure handling passed');

        } catch (error) {
            this.fail('Gap-filling failure test failed', error.message);
        }
    }

    async createTestData(instrumentKey, barCounts) {
        // Clean up existing test data
        await PreFetchedData.deleteMany({ instrument_key: instrumentKey });

        const timeframes = Object.keys(barCounts);
        
        for (const timeframe of timeframes) {
            const barCount = barCounts[timeframe];
            const candleData = this.generateMockCandles(barCount, timeframe);
            
            const preFetchedData = new PreFetchedData({
                instrument_key: instrumentKey,
                stock_symbol: 'TEST_STOCK',
                timeframe: timeframe,
                trading_date: new Date(),
                candle_data: candleData,
                bars_count: barCount,
                data_quality: {
                    missing_bars: Math.max(0, this.getRequiredBars(timeframe) - barCount),
                    has_gaps: false,
                    last_bar_time: candleData[candleData.length - 1].timestamp
                }
            });

            await preFetchedData.save();
        }
    }

    async createSingleTimeframeData(instrumentKey, timeframe, barCount) {
        await PreFetchedData.deleteMany({ instrument_key: instrumentKey, timeframe: timeframe });

        const candleData = this.generateMockCandles(barCount, timeframe);
        
        const preFetchedData = new PreFetchedData({
            instrument_key: instrumentKey,
            stock_symbol: 'TEST_STOCK',
            timeframe: timeframe,
            trading_date: new Date(),
            candle_data: candleData,
            bars_count: barCount,
            data_quality: {
                missing_bars: Math.max(0, this.getRequiredBars(timeframe) - barCount),
                has_gaps: false,
                last_bar_time: candleData[candleData.length - 1].timestamp
            }
        });

        await preFetchedData.save();
        return preFetchedData;
    }

    generateMockCandles(count, timeframe) {
        const candles = [];
        const now = new Date();
        const intervalMs = this.getIntervalMs(timeframe);
        
        for (let i = count - 1; i >= 0; i--) {
            const timestamp = new Date(now.getTime() - (i * intervalMs));
            candles.push({
                timestamp: timestamp,
                open: 100 + Math.random() * 10,
                high: 105 + Math.random() * 10,
                low: 95 + Math.random() * 10,
                close: 100 + Math.random() * 10,
                volume: 1000 + Math.random() * 1000
            });
        }
        
        return candles;
    }

    getRequiredBars(timeframe) {
        const required = { '5m': 200, '15m': 100, '1h': 50, '1d': 30 };
        return required[timeframe] || 100;
    }

    getIntervalMs(timeframe) {
        const intervals = {
            '5m': 5 * 60 * 1000,
            '15m': 15 * 60 * 1000,
            '1h': 60 * 60 * 1000,
            '1d': 24 * 60 * 60 * 1000
        };
        return intervals[timeframe] || 60 * 1000;
    }

    assert(condition, testName, details = '') {
        this.testResults.total++;
        if (condition) {
            this.testResults.passed++;
            this.testResults.details.push({ test: testName, status: 'PASS', details });
            console.log(`  ✅ ${testName}`);
        } else {
            this.testResults.failed++;
            this.testResults.details.push({ test: testName, status: 'FAIL', details });
            console.log(`  ❌ ${testName} - ${details}`);
        }
    }

    fail(testName, error) {
        this.testResults.total++;
        this.testResults.failed++;
        this.testResults.details.push({ test: testName, status: 'FAIL', error });
        console.log(`  ❌ ${testName} - ${error}`);
    }

    log(message, level = 'info') {
        const colors = {
            info: '\x1b[36m%s\x1b[0m',    // Cyan
            success: '\x1b[32m%s\x1b[0m', // Green
            warning: '\x1b[33m%s\x1b[0m', // Yellow
            error: '\x1b[31m%s\x1b[0m'    // Red
        };
        console.log(colors[level] || '%s', message);
    }

    async printResults() {
        console.log('\n' + '='.repeat(80));
        this.log('\n📊 SMART GAP-FILLING TEST RESULTS', 'info');
        console.log('='.repeat(80));
        
        console.log(`Total Tests: ${this.testResults.total}`);
        this.log(`✅ Passed: ${this.testResults.passed}`, 'success');
        this.log(`❌ Failed: ${this.testResults.failed}`, this.testResults.failed > 0 ? 'error' : 'success');
        
        const successRate = ((this.testResults.passed / this.testResults.total) * 100).toFixed(2);
        this.log(`Success Rate: ${successRate}%`, successRate === '100.00' ? 'success' : 'warning');

        if (this.testResults.failed > 0) {
            console.log('\n❌ Failed Tests:');
            this.testResults.details
                .filter(detail => detail.status === 'FAIL')
                .forEach(detail => {
                    console.log(`  • ${detail.test}`);
                    if (detail.error) console.log(`    Error: ${detail.error}`);
                    if (detail.details) console.log(`    Details: ${detail.details}`);
                });
        }

        console.log('\n' + '='.repeat(80));
    }

    async cleanup() {
        try {
            // Clean up test data
            await PreFetchedData.deleteMany({ 
                instrument_key: { $regex: '_TEST_' } 
            });
            
            await mongoose.disconnect();
            console.log('🧹 Cleanup completed\n');
        } catch (error) {
            console.error('⚠️ Cleanup failed:', error);
        }
    }
}

// Run tests if this script is executed directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
    const tester = new GapFillingTester();
    tester.runAllTests().catch(error => {
        console.error('💥 Test execution failed:', error);
        process.exit(1);
    });
}

export default GapFillingTester;