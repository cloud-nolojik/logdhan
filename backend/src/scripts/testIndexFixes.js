#!/usr/bin/env node

/**
 * Test script to verify index duplicate warnings are fixed
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import PreFetchedData from '../models/preFetchedData.js';
import DailyJobStatus from '../models/dailyJobStatus.js';

dotenv.config();

class IndexTestRunner {
    constructor() {
        this.testResults = [];
    }

    async runTests() {
        console.log('🧪 Testing Index Duplicate Fixes\n');
        
        try {
            await this.connectToDatabase();
            
            // Test each model
            await this.testPreFetchedDataIndexes();
            await this.testDailyJobStatusIndexes();
            // await this.testAIAnalysisCacheIndexes(); // Removed - AIAnalysisCache no longer exists
            
            await this.printResults();
            
        } catch (error) {
            console.error('❌ Test execution failed:', error);
        } finally {
            await this.cleanup();
        }
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

    async testPreFetchedDataIndexes() {
        console.log('🔍 Testing PreFetchedData indexes...');
        
        try {
            const indexes = await PreFetchedData.listIndexes();
            console.log('📊 PreFetchedData indexes:', indexes.map(idx => idx.key));
            
            // Check for duplicate trading_date indexes
            const tradingDateIndexes = indexes.filter(idx => 
                idx.key.trading_date || JSON.stringify(idx.key).includes('trading_date')
            );
            
            this.testResults.push({
                model: 'PreFetchedData',
                test: 'trading_date duplicate check',
                passed: tradingDateIndexes.length <= 2, // One compound, one TTL
                details: `Found ${tradingDateIndexes.length} trading_date indexes`
            });
            
            console.log('✅ PreFetchedData index test completed\n');
            
        } catch (error) {
            console.error('❌ PreFetchedData index test failed:', error);
            this.testResults.push({
                model: 'PreFetchedData',
                test: 'index check',
                passed: false,
                details: error.message
            });
        }
    }

    async testDailyJobStatusIndexes() {
        console.log('🔍 Testing DailyJobStatus indexes...');
        
        try {
            const indexes = await DailyJobStatus.listIndexes();
            console.log('📊 DailyJobStatus indexes:', indexes.map(idx => idx.key));
            
            // Check for duplicate job_date indexes
            const jobDateIndexes = indexes.filter(idx => 
                idx.key.job_date || JSON.stringify(idx.key).includes('job_date')
            );
            
            this.testResults.push({
                model: 'DailyJobStatus',
                test: 'job_date duplicate check',
                passed: jobDateIndexes.length <= 2, // One compound, one TTL
                details: `Found ${jobDateIndexes.length} job_date indexes`
            });

            // Test that errors field is renamed to job_errors
            const testDoc = new DailyJobStatus({
                job_date: new Date(),
                job_type: 'data_prefetch',
                total_stocks: 10
            });

            testDoc.addError('TEST', 'TESTSTOCK', '15m', 'Test error message');
            
            this.testResults.push({
                model: 'DailyJobStatus',
                test: 'errors field renamed to job_errors',
                passed: testDoc.job_errors.length === 1,
                details: `job_errors array has ${testDoc.job_errors.length} items`
            });

            // Test that nested errors field is renamed to error_count
            testDoc.updateProgress(1, '15m', 100);
            const timeframeStatus = testDoc.timeframes_processed[0];
            
            this.testResults.push({
                model: 'DailyJobStatus',
                test: 'nested errors field renamed to error_count',
                passed: timeframeStatus.error_count === 0,
                details: `timeframes_processed uses error_count: ${timeframeStatus.error_count !== undefined}`
            });
            
            console.log('✅ DailyJobStatus index test completed\n');
            
        } catch (error) {
            console.error('❌ DailyJobStatus index test failed:', error);
            this.testResults.push({
                model: 'DailyJobStatus',
                test: 'index check',
                passed: false,
                details: error.message
            });
        }
    }

    async testAIAnalysisCacheIndexes() {
        console.log('🔍 Testing AIAnalysisCache indexes...');
        
        try {
            const indexes = await AIAnalysisCache.listIndexes();
            console.log('📊 AIAnalysisCache indexes:', indexes.map(idx => idx.key));
            
            // Check for duplicate expires_at indexes
            const expiresAtIndexes = indexes.filter(idx => 
                idx.key.expires_at || JSON.stringify(idx.key).includes('expires_at')
            );
            
            this.testResults.push({
                model: 'AIAnalysisCache',
                test: 'expires_at duplicate check',
                passed: expiresAtIndexes.length === 1, // Only TTL index should remain
                details: `Found ${expiresAtIndexes.length} expires_at indexes`
            });
            
            console.log('✅ AIAnalysisCache index test completed\n');
            
        } catch (error) {
            console.error('❌ AIAnalysisCache index test failed:', error);
            this.testResults.push({
                model: 'AIAnalysisCache',
                test: 'index check',
                passed: false,
                details: error.message
            });
        }
    }

    async printResults() {
        console.log('='.repeat(80));
        console.log('📊 INDEX DUPLICATE FIX TEST RESULTS');
        console.log('='.repeat(80));
        
        const totalTests = this.testResults.length;
        const passedTests = this.testResults.filter(r => r.passed).length;
        const failedTests = totalTests - passedTests;
        
        console.log(`Total Tests: ${totalTests}`);
        console.log(`✅ Passed: ${passedTests}`);
        console.log(`❌ Failed: ${failedTests}`);
        console.log(`Success Rate: ${((passedTests / totalTests) * 100).toFixed(2)}%\n`);
        
        this.testResults.forEach(result => {
            const status = result.passed ? '✅ PASS' : '❌ FAIL';
            console.log(`${status} [${result.model}] ${result.test}`);
            console.log(`   Details: ${result.details}\n`);
        });
        
        if (failedTests === 0) {
            console.log('🎉 All index duplicate issues have been resolved!');
        } else {
            console.log('⚠️ Some issues remain. Check the failed tests above.');
        }
        
        console.log('='.repeat(80));
    }

    async cleanup() {
        try {
            await mongoose.disconnect();
            console.log('🧹 Cleanup completed');
        } catch (error) {
            console.error('⚠️ Cleanup failed:', error);
        }
    }
}

// Run tests if this script is executed directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
    const tester = new IndexTestRunner();
    tester.runTests().catch(error => {
        console.error('💥 Test execution failed:', error);
        process.exit(1);
    });
}

export default IndexTestRunner;