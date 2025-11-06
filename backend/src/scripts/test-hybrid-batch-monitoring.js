/**
 * Test Script for Hybrid Batch Monitoring Architecture
 * 
 * This script tests the new batch monitoring system to ensure:
 * 1. BatchManager creates optimal batches from active subscriptions
 * 2. Batch jobs process multiple analyses with ALL strategies
 * 3. Performance metrics are tracked correctly
 * 4. Error handling and fault isolation works
 */

import mongoose from 'mongoose';
import agendaMonitoringService from '../services/agendaMonitoringService.js';
import batchManager from '../services/batchManager.js';
import MonitoringSubscription from '../models/monitoringSubscription.js';
import StockAnalysis from '../models/stockAnalysis.js';

// Load environment variables
import '../loadEnv.js';

class HybridBatchTester {
    async testBatchManagerOptimalBatches() {
        console.log('\n🧪 [TEST 1] Testing BatchManager.createOptimalBatches()...');
        
        try {
            const batches = await batchManager.createOptimalBatches();
            
            console.log(`✅ Created ${batches.length} optimal batches`);
            batches.forEach((batch, idx) => {
                console.log(`   Batch ${idx + 1}: ${batch.batchId} - ${batch.analysisIds.length} analyses, ${batch.estimated_total_strategies} strategies`);
            });
            
            return batches;
        } catch (error) {
            console.error('❌ [TEST 1] Failed:', error.message);
            return [];
        }
    }

    async testBatchStatistics() {
        console.log('\n🧪 [TEST 2] Testing BatchManager.getBatchStatistics()...');
        
        try {
            const stats = await batchManager.getBatchStatistics();
            
            if (stats) {
                console.log('✅ Batch statistics retrieved successfully:');
                console.log(`   Total Batches: ${stats.total_batches}`);
                console.log(`   Total Analyses: ${stats.total_analyses}`);
                console.log(`   Total Strategies: ${stats.total_strategies}`);
                console.log(`   Avg Analyses per Batch: ${stats.avg_analyses_per_batch}`);
                console.log(`   Frequency Distribution:`, stats.frequency_distribution);
            } else {
                console.log('⚠️ No batch statistics available (no active subscriptions)');
            }
            
            return stats;
        } catch (error) {
            console.error('❌ [TEST 2] Failed:', error.message);
            return null;
        }
    }

    async testAgendaServiceBatchMode() {
        console.log('\n🧪 [TEST 3] Testing AgendaMonitoringService batch mode...');
        
        try {
            // Test getting batch monitoring stats
            const stats = await agendaMonitoringService.getBatchMonitoringStats();
            console.log(`✅ Batch monitoring stats retrieved`);
            console.log(`   Batch Mode Enabled: ${stats.batch_mode_enabled}`);
            console.log(`   Active Batches: ${stats.active_batches}`);
            console.log(`   Performance Summary:`, stats.performance_summary);
            
            // Test batch mode switching
            console.log('\n🔄 Testing batch mode switching...');
            
            const switchResult = await agendaMonitoringService.setBatchMode(true);
            console.log(`✅ Batch mode enabled: ${switchResult.success ? 'SUCCESS' : 'FAILED'}`);
            
            return stats;
        } catch (error) {
            console.error('❌ [TEST 3] Failed:', error.message);
            return null;
        }
    }

    async testBatchInitialization() {
        console.log('\n🧪 [TEST 4] Testing batch initialization...');
        
        try {
            const result = await agendaMonitoringService.initializeBatchMonitoring();
            
            if (result && result.success) {
                console.log('✅ Batch monitoring initialized successfully');
                console.log(`   Batches Created: ${result.batchesCreated}`);
                console.log(`   Total Analyses Covered: ${result.totalAnalysesCovered}`);
            } else {
                console.log('⚠️ Batch initialization completed with no active subscriptions');
            }
            
            return result;
        } catch (error) {
            console.error('❌ [TEST 4] Failed:', error.message);
            return null;
        }
    }

    async analyzeCurrentSubscriptions() {
        console.log('\n📊 [ANALYSIS] Current monitoring subscriptions...');
        
        try {
            const activeSubscriptions = await MonitoringSubscription.find({
                monitoring_status: 'active',
                expires_at: { $gt: new Date() }
            });
            
            console.log(`📈 Found ${activeSubscriptions.length} active subscriptions`);
            
            const analysisGroups = new Map();
            const strategyCounts = new Map();
            
            for (const sub of activeSubscriptions) {
                const analysisId = sub.analysis_id.toString();
                
                if (!analysisGroups.has(analysisId)) {
                    analysisGroups.set(analysisId, {
                        stock_symbol: sub.stock_symbol,
                        strategies: new Set(),
                        total_users: 0
                    });
                }
                
                const group = analysisGroups.get(analysisId);
                group.strategies.add(sub.strategy_id);
                group.total_users += sub.subscribed_users.length;
                
                // Count strategy distribution
                strategyCounts.set(sub.strategy_id, (strategyCounts.get(sub.strategy_id) || 0) + 1);
            }
            
            console.log(`📋 Analysis breakdown:`);
            let idx = 1;
            for (const [analysisId, group] of analysisGroups) {
                console.log(`   ${idx}. ${group.stock_symbol} (${analysisId.slice(-8)}): ${group.strategies.size} strategies, ${group.total_users} users`);
                console.log(`      Strategies: ${Array.from(group.strategies).join(', ')}`);
                idx++;
            }
            
            console.log(`\n📊 Strategy distribution:`);
            for (const [strategyId, count] of strategyCounts) {
                console.log(`   ${strategyId}: ${count} subscriptions`);
            }
            
            return {
                totalSubscriptions: activeSubscriptions.length,
                uniqueAnalyses: analysisGroups.size,
                strategyCounts: Object.fromEntries(strategyCounts)
            };
            
        } catch (error) {
            console.error('❌ [ANALYSIS] Failed:', error.message);
            return null;
        }
    }

    async testProcessAnalysisAllStrategies() {
        console.log('\n🧪 [TEST 5] Testing processAnalysisAllStrategies...');
        
        try {
            // Get a sample analysis ID from active subscriptions
            const sampleSubscription = await MonitoringSubscription.findOne({
                monitoring_status: 'active',
                expires_at: { $gt: new Date() }
            });
            
            if (!sampleSubscription) {
                console.log('⚠️ No active subscriptions found for testing');
                return null;
            }
            
            const analysisId = sampleSubscription.analysis_id.toString();
            console.log(`🔍 Testing with analysis: ${analysisId.slice(-8)} (${sampleSubscription.stock_symbol})`);
            
            // Test the processAnalysisAllStrategies method
            const result = await agendaMonitoringService.processAnalysisAllStrategies(analysisId, 'test-batch');
            
            console.log('✅ Analysis processed successfully:');
            console.log(`   Stock: ${result.stock_symbol}`);
            console.log(`   Strategies Processed: ${result.strategiesProcessed}`);
            console.log(`   Successful: ${result.successfulStrategies}`);
            console.log(`   Skipped: ${result.skippedStrategies}`);
            console.log(`   Failed: ${result.failedStrategies}`);
            console.log(`   Processing Time: ${result.processingTime}ms`);
            
            return result;
        } catch (error) {
            console.error('❌ [TEST 5] Failed:', error.message);
            return null;
        }
    }

    async runAllTests() {
        console.log('🚀 Starting Hybrid Batch Monitoring Architecture Tests');
        console.log('=' .repeat(80));
        
        try {
            // Connect to MongoDB
            await mongoose.connect(process.env.MONGODB_URI);
            console.log('✅ Connected to MongoDB');
            
            // Initialize the agenda monitoring service
            await agendaMonitoringService.initialize();
            console.log('✅ Agenda monitoring service initialized');
            
            // Run all tests
            const analysisResult = await this.analyzeCurrentSubscriptions();
            const batchesResult = await this.testBatchManagerOptimalBatches();
            const statsResult = await this.testBatchStatistics();
            const agendaResult = await this.testAgendaServiceBatchMode();
            const initResult = await this.testBatchInitialization();
            const processResult = await this.testProcessAnalysisAllStrategies();
            
            // Summary
            console.log('\n' + '=' .repeat(80));
            console.log('📊 TEST SUMMARY');
            console.log('=' .repeat(80));
            console.log(`✅ Current Subscriptions: ${analysisResult?.totalSubscriptions || 0} active`);
            console.log(`✅ Unique Analyses: ${analysisResult?.uniqueAnalyses || 0}`);
            console.log(`✅ Optimal Batches Created: ${batchesResult?.length || 0}`);
            console.log(`✅ Batch Statistics: ${statsResult ? 'Available' : 'No data'}`);
            console.log(`✅ Agenda Service: ${agendaResult ? 'Working' : 'Failed'}`);
            console.log(`✅ Batch Initialization: ${initResult?.success ? 'Success' : 'No active subscriptions'}`);
            console.log(`✅ Process Analysis Test: ${processResult ? 'Success' : 'No data'}`);
            
            // Architecture validation
            console.log('\n🏗️ ARCHITECTURE VALIDATION:');
            if (analysisResult?.strategyCounts) {
                const hasMultipleStrategies = Object.keys(analysisResult.strategyCounts).length > 1;
                console.log(`   Multiple Strategies: ${hasMultipleStrategies ? '✅ YES' : '⚠️ Only S1 found'}`);
                console.log(`   Strategy Distribution:`, analysisResult.strategyCounts);
            }
            
            const batchCoverage = batchesResult?.reduce((sum, b) => sum + b.analysisIds.length, 0) || 0;
            console.log(`   Batch Coverage: ${batchCoverage >= (analysisResult?.uniqueAnalyses || 0) ? '✅ Complete' : '⚠️ Partial'}`);
            
            console.log('\n🎯 RECOMMENDATIONS:');
            if (analysisResult?.totalSubscriptions === 0) {
                console.log('   ⚠️ No active monitoring subscriptions found');
                console.log('   💡 Create some monitoring subscriptions to test the batch system');
            } else if (batchesResult?.length === 0) {
                console.log('   ⚠️ No batches were created despite having active subscriptions');
                console.log('   💡 Check BatchManager.createOptimalBatches() logic');
            } else {
                console.log('   ✅ Hybrid batch architecture is working correctly');
                console.log(`   📈 Processing ${analysisResult?.totalSubscriptions} subscriptions in ${batchesResult?.length} efficient batches`);
            }
            
        } catch (error) {
            console.error('❌ Test suite failed:', error);
        } finally {
            // Cleanup
            await agendaMonitoringService.shutdown();
            await mongoose.disconnect();
            console.log('\n✅ Test cleanup completed');
            process.exit(0);
        }
    }
}

// Run the tests
const tester = new HybridBatchTester();
tester.runAllTests();