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

    try {
      const batches = await batchManager.createOptimalBatches();

      batches.forEach((batch, idx) => {

      });

      return batches;
    } catch (error) {
      console.error('❌ [TEST 1] Failed:', error.message);
      return [];
    }
  }

  async testBatchStatistics() {

    try {
      const stats = await batchManager.getBatchStatistics();

      if (stats) {

      } else {

      }

      return stats;
    } catch (error) {
      console.error('❌ [TEST 2] Failed:', error.message);
      return null;
    }
  }

  async testAgendaServiceBatchMode() {

    try {
      // Test getting batch monitoring stats
      const stats = await agendaMonitoringService.getBatchMonitoringStats();

      // Test batch mode switching

      const switchResult = await agendaMonitoringService.setBatchMode(true);

      return stats;
    } catch (error) {
      console.error('❌ [TEST 3] Failed:', error.message);
      return null;
    }
  }

  async testBatchInitialization() {

    try {
      const result = await agendaMonitoringService.initializeBatchMonitoring();

      if (result && result.success) {

      } else {

      }

      return result;
    } catch (error) {
      console.error('❌ [TEST 4] Failed:', error.message);
      return null;
    }
  }

  async analyzeCurrentSubscriptions() {

    try {
      const activeSubscriptions = await MonitoringSubscription.find({
        monitoring_status: 'active',
        expires_at: { $gt: new Date() }
      });

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

      let idx = 1;
      for (const [analysisId, group] of analysisGroups) {

        idx++;
      }

      for (const [strategyId, count] of strategyCounts) {

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

    try {
      // Get a sample analysis ID from active subscriptions
      const sampleSubscription = await MonitoringSubscription.findOne({
        monitoring_status: 'active',
        expires_at: { $gt: new Date() }
      });

      if (!sampleSubscription) {

        return null;
      }

      const analysisId = sampleSubscription.analysis_id.toString();

      // Test the processAnalysisAllStrategies method
      const result = await agendaMonitoringService.processAnalysisAllStrategies(analysisId, 'test-batch');

      return result;
    } catch (error) {
      console.error('❌ [TEST 5] Failed:', error.message);
      return null;
    }
  }

  async runAllTests() {

    try {
      // Connect to MongoDB
      await mongoose.connect(process.env.MONGODB_URI);

      // Initialize the agenda monitoring service
      await agendaMonitoringService.initialize();

      // Run all tests
      const analysisResult = await this.analyzeCurrentSubscriptions();
      const batchesResult = await this.testBatchManagerOptimalBatches();
      const statsResult = await this.testBatchStatistics();
      const agendaResult = await this.testAgendaServiceBatchMode();
      const initResult = await this.testBatchInitialization();
      const processResult = await this.testProcessAnalysisAllStrategies();

      // Summary

      // Architecture validation

      if (analysisResult?.strategyCounts) {
        const hasMultipleStrategies = Object.keys(analysisResult.strategyCounts).length > 1;

      }

      const batchCoverage = batchesResult?.reduce((sum, b) => sum + b.analysisIds.length, 0) || 0;

      if (analysisResult?.totalSubscriptions === 0) {

      } else if (batchesResult?.length === 0) {

      } else {

      }

    } catch (error) {
      console.error('❌ Test suite failed:', error);
    } finally {
      // Cleanup
      await agendaMonitoringService.shutdown();
      await mongoose.disconnect();

      process.exit(0);
    }
  }
}

// Run the tests
const tester = new HybridBatchTester();
tester.runAllTests();