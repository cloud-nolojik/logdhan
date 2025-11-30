import MonitoringSubscription from '../models/monitoringSubscription.js';
import MonitoringHistory from '../models/monitoringHistory.js';

/**
 * Get monitoring state for a user/analysis/strategy, with history fallback when no active subscription exists.
 * @param {Object} params
 * @param {Object} params.analysis - Analysis document (lean or full)
 * @param {string|ObjectId} params.userId - User ID
 * @returns {Promise<{state: string, conditions_met_at: Date|null, strategy_id: string|null, is_monitoring: boolean, auto_order: boolean}>}
 */
export async function getMonitoringState({ analysis, userId }) {
  if (!analysis || !analysis._id || !analysis.analysis_data?.strategies?.length) {
    return {
      state: 'inactive',
      conditions_met_at: null,
      strategy_id: null,
      analysis_id: null,
      is_monitoring: false,
      auto_order: false
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
    // Find the user's subscription to get auto_order setting
    const userSub = activeMonitoring.subscribed_users.find(
      (sub) => sub.user_id.toString() === userId.toString()
    );

    return {
      state: 'active',
      conditions_met_at: null,
      strategy_id: activeMonitoring.strategy_id,
      analysis_id: analysis._id,
      is_monitoring: true,
      auto_order: userSub?.auto_order || false
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
      is_monitoring: false,
      auto_order: false
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

  // Check if there's auto_order info in the history details
  const autoOrderFromHistory = latestHistory.details?.auto_order_enabled || false;

  return {
    state,
    conditions_met_at: latestHistory.status === 'conditions_met' ? latestHistory.check_timestamp : null,
    strategy_id: strategyId,
    analysis_id: analysis._id,
    is_monitoring: false,
    auto_order: autoOrderFromHistory
  };
}
