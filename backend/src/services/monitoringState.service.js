import MonitoringSubscription from '../models/monitoringSubscription.js';
import MonitoringHistory from '../models/monitoringHistory.js';

/**
 * Get monitoring state for a user/analysis/strategy, with history fallback when no active subscription exists.
 * @param {Object} params
 * @param {Object} params.analysis - Analysis document (lean or full)
 * @param {string|ObjectId} params.userId - User ID
 * @returns {Promise<{state: string, conditions_met_at: Date|null, strategy_id: string|null, is_monitoring: boolean}>}
 */
export async function getMonitoringState({ analysis, userId }) {
  if (!analysis || !analysis._id || !analysis.analysis_data?.strategies?.length) {
    return {
      state: 'inactive',
      conditions_met_at: null,
      strategy_id: null,
      analysis_id: null,
      is_monitoring: false
    };
  }

  const strategyId = analysis.analysis_data.strategies[0].id;

  // Check active subscription first
  const activeMonitoring = await MonitoringSubscription.findOne({
    analysis_id: analysis._id,
    strategy_id: strategyId,
    monitoring_status: 'active',
    'subscribed_users.user_id': userId
  }).lean();

  if (activeMonitoring) {
    return {
      state: 'active',
      conditions_met_at: null,
      strategy_id: activeMonitoring.strategy_id,
      analysis_id: analysis._id,
      is_monitoring: true
    };
  }

  // Fallback to latest history for this user/strategy
  const latestHistory = await MonitoringHistory.findOne({
    analysis_id: analysis._id,
    strategy_id: strategyId,
    user_id: userId
  }).sort({ check_timestamp: -1 }).lean();

  if (!latestHistory) {
    return {
      state: 'inactive',
      conditions_met_at: null,
      strategy_id: strategyId,
      analysis_id: analysis._id,
      is_monitoring: false
    };
  }

  let state = latestHistory.status;
  if (latestHistory.status === 'conditions_met') {
    state = 'conditions_met';
  } else if (latestHistory.status === 'market_closed') {
    state = 'paused';
  } else if (latestHistory.status === 'triggers_not_met') {
    state = 'inactive';
  } else if (latestHistory.status === 'stopped') {
    state = 'finished';
  } else if (latestHistory.status === 'expired') {
    state = 'expired';
  }

  return {
    state,
    conditions_met_at: latestHistory.status === 'conditions_met' ? latestHistory.check_timestamp : null,
    strategy_id: strategyId,
    analysis_id: analysis._id,
    is_monitoring: false
  };
}
