import MonitoringSubscription from '../models/monitoringSubscription.js';

/**
 * BatchManager - Manages optimal batching of monitoring jobs for scalability
 * 
 * Key Features:
 * - Groups active monitoring subscriptions into optimal batches
 * - Each batch processes 50 analyses with ALL their strategies in parallel
 * - Dynamic batch sizing based on load and performance
 * - Fault isolation per batch (one batch failure doesn't affect others)
 */
class BatchManager {
  constructor() {
    this.batchSize = 50; // Optimal batch size (50 analyses per batch)
    this.maxBatches = 20; // Maximum number of batches to prevent resource exhaustion
    this.minBatchSize = 10; // Minimum analyses per batch to maintain efficiency
  }

  /**
   * Create optimal batches from all active monitoring subscriptions
   * Returns array of batch configurations for Agenda jobs
   */
  async createOptimalBatches() {
    try {

      // Get all active monitoring subscriptions
      const activeSubscriptions = await MonitoringSubscription.find({
        monitoring_status: 'active',
        expires_at: { $gt: new Date() }
      }).select('analysis_id strategy_id stock_symbol subscribed_users monitoring_config');

      if (activeSubscriptions.length === 0) {

        return [];
      }

      // Group subscriptions by analysis_id (each analysis can have multiple strategies)
      const analysisGroups = new Map();
      const analysisMetadata = new Map();

      activeSubscriptions.forEach((sub) => {
        const analysisId = sub.analysis_id.toString();

        if (!analysisGroups.has(analysisId)) {
          analysisGroups.set(analysisId, new Set());
          analysisMetadata.set(analysisId, {
            stock_symbol: sub.stock_symbol,
            total_users: 0,
            strategies: []
          });
        }

        // Add strategy to this analysis
        analysisGroups.get(analysisId).add(sub.strategy_id);

        // Update metadata
        const metadata = analysisMetadata.get(analysisId);
        metadata.total_users += sub.subscribed_users.length;
        metadata.strategies.push({
          strategy_id: sub.strategy_id,
          users_count: sub.subscribed_users.length,
          frequency: sub.monitoring_config?.frequency_seconds || 900
        });
      });

      // Log analysis distribution
      const analysisDistribution = Array.from(analysisGroups.entries()).map(([analysisId, strategies]) => {
        const metadata = analysisMetadata.get(analysisId);
        return {
          analysisId,
          stock_symbol: metadata.stock_symbol,
          strategies_count: strategies.size,
          total_users: metadata.total_users,
          strategies: Array.from(strategies)
        };
      });

      analysisDistribution.forEach((item, idx) => {

      });

      // Create batches with optimal sizing
      const batches = this.createBatchesFromAnalyses(Array.from(analysisGroups.keys()), analysisMetadata);

      batches.forEach((batch, idx) => {

      });

      return batches;

    } catch (error) {
      console.error('❌ [BATCH MANAGER] Error creating optimal batches:', error);
      return [];
    }
  }

  /**
   * Create batches from array of analysis IDs with intelligent load balancing
   */
  createBatchesFromAnalyses(analysisIds, analysisMetadata) {
    const batches = [];
    let currentBatch = null;
    let batchNumber = 1;

    // Sort analyses by complexity (strategies count + users count) for better load distribution
    const sortedAnalyses = analysisIds.sort((a, b) => {
      const aMetadata = analysisMetadata.get(a);
      const bMetadata = analysisMetadata.get(b);
      const aComplexity = aMetadata.strategies.length + aMetadata.total_users;
      const bComplexity = bMetadata.strategies.length + bMetadata.total_users;
      return bComplexity - aComplexity; // Descending order (most complex first)
    });

    for (const analysisId of sortedAnalyses) {
      // Create new batch if needed
      if (!currentBatch || currentBatch.analysisIds.length >= this.batchSize) {
        if (currentBatch) {
          batches.push(currentBatch);
        }

        currentBatch = {
          batchId: `batch-${batchNumber}`,
          analysisIds: [],
          estimated_total_strategies: 0,
          estimated_total_users: 0,
          created_at: new Date(),
          max_frequency_seconds: 900 // Default to 15 minutes
        };
        batchNumber++;
      }

      // Add analysis to current batch
      const metadata = analysisMetadata.get(analysisId);
      currentBatch.analysisIds.push(analysisId);
      currentBatch.estimated_total_strategies += metadata.strategies.length;
      currentBatch.estimated_total_users += metadata.total_users;

      // Track the fastest frequency needed (minimum seconds)
      const minFrequency = Math.min(...metadata.strategies.map((s) => s.frequency));
      currentBatch.max_frequency_seconds = Math.min(currentBatch.max_frequency_seconds, minFrequency);
    }

    // Add the last batch
    if (currentBatch && currentBatch.analysisIds.length > 0) {
      batches.push(currentBatch);
    }

    // Validate batch sizes and merge small batches if needed
    return this.optimizeBatchSizes(batches);
  }

  /**
   * Optimize batch sizes - merge small batches, split overly large ones
   */
  optimizeBatchSizes(batches) {
    const optimizedBatches = [];
    let pendingMerge = null;

    for (const batch of batches) {
      // If batch is too small, try to merge with next
      if (batch.analysisIds.length < this.minBatchSize && batches.length > 1) {
        if (!pendingMerge) {
          pendingMerge = batch;
          continue;
        } else {
          // Merge with pending batch
          pendingMerge.analysisIds.push(...batch.analysisIds);
          pendingMerge.estimated_total_strategies += batch.estimated_total_strategies;
          pendingMerge.estimated_total_users += batch.estimated_total_users;
          pendingMerge.max_frequency_seconds = Math.min(pendingMerge.max_frequency_seconds, batch.max_frequency_seconds);
          pendingMerge.batchId = `merged-${pendingMerge.batchId}-${batch.batchId}`;

          optimizedBatches.push(pendingMerge);
          pendingMerge = null;
        }
      } else {
        // Add pending merge if exists
        if (pendingMerge) {
          optimizedBatches.push(pendingMerge);
          pendingMerge = null;
        }

        // Check if current batch is too large and needs splitting
        if (batch.analysisIds.length > this.batchSize * 1.5) {
          const splitBatches = this.splitLargeBatch(batch);
          optimizedBatches.push(...splitBatches);
        } else {
          optimizedBatches.push(batch);
        }
      }
    }

    // Add any remaining pending merge
    if (pendingMerge) {
      optimizedBatches.push(pendingMerge);
    }

    return optimizedBatches;
  }

  /**
   * Split overly large batch into smaller batches
   */
  splitLargeBatch(largeBatch) {
    const splitBatches = [];
    const chunkSize = this.batchSize;
    let chunkNumber = 1;

    for (let i = 0; i < largeBatch.analysisIds.length; i += chunkSize) {
      const chunk = largeBatch.analysisIds.slice(i, i + chunkSize);

      splitBatches.push({
        batchId: `${largeBatch.batchId}-part-${chunkNumber}`,
        analysisIds: chunk,
        estimated_total_strategies: Math.ceil(largeBatch.estimated_total_strategies * (chunk.length / largeBatch.analysisIds.length)),
        estimated_total_users: Math.ceil(largeBatch.estimated_total_users * (chunk.length / largeBatch.analysisIds.length)),
        created_at: new Date(),
        max_frequency_seconds: largeBatch.max_frequency_seconds
      });

      chunkNumber++;
    }

    return splitBatches;
  }

  /**
   * Get batch statistics for monitoring and debugging
   */
  async getBatchStatistics() {
    try {
      const batches = await this.createOptimalBatches();

      const stats = {
        total_batches: batches.length,
        total_analyses: batches.reduce((sum, batch) => sum + batch.analysisIds.length, 0),
        total_strategies: batches.reduce((sum, batch) => sum + batch.estimated_total_strategies, 0),
        total_users: batches.reduce((sum, batch) => sum + batch.estimated_total_users, 0),
        avg_analyses_per_batch: batches.length > 0 ? Math.round(batches.reduce((sum, batch) => sum + batch.analysisIds.length, 0) / batches.length) : 0,
        min_analyses_per_batch: batches.length > 0 ? Math.min(...batches.map((b) => b.analysisIds.length)) : 0,
        max_analyses_per_batch: batches.length > 0 ? Math.max(...batches.map((b) => b.analysisIds.length)) : 0,
        frequency_distribution: this.getFrequencyDistribution(batches),
        batch_details: batches.map((batch) => ({
          batchId: batch.batchId,
          analyses_count: batch.analysisIds.length,
          strategies_count: batch.estimated_total_strategies,
          users_count: batch.estimated_total_users,
          frequency_seconds: batch.max_frequency_seconds
        }))
      };

      return stats;
    } catch (error) {
      console.error('❌ [BATCH MANAGER] Error getting batch statistics:', error);
      return null;
    }
  }

  /**
   * Get frequency distribution across batches
   */
  getFrequencyDistribution(batches) {
    const distribution = {};

    batches.forEach((batch) => {
      const freq = batch.max_frequency_seconds;
      distribution[freq] = (distribution[freq] || 0) + 1;
    });

    return distribution;
  }

  /**
   * Update batch configuration based on performance metrics
   */
  updateBatchConfiguration(performanceMetrics) {
    const { avgProcessingTime, errorRate, memoryUsage } = performanceMetrics;

    // Adjust batch size based on performance
    if (avgProcessingTime > 45000) {// More than 45 seconds
      this.batchSize = Math.max(20, this.batchSize - 10);

    } else if (avgProcessingTime < 15000 && errorRate < 0.05) {// Less than 15 seconds and low error rate
      this.batchSize = Math.min(100, this.batchSize + 10);

    }

    // Adjust based on error rate
    if (errorRate > 0.1) {// More than 10% error rate
      this.batchSize = Math.max(10, this.batchSize - 5);

    }
  }
}

export default new BatchManager();