/**
 * Position Management Service
 *
 * Handles position-aware analysis routing and management decisions.
 * Routes to either "Discovery Mode" or "Position Management Mode" based on
 * whether the user has an open position in the stock.
 */

import UserPosition from "../../models/userPosition.js";
import {
  calculateTrailingStop,
  checkExitConditions,
  recommendTrailingStrategy,
  calculateRiskReduction
} from "../../engine/index.js";

/**
 * Check if user has an open position for a given instrument
 * @param {string} userId
 * @param {string} instrumentKey
 * @returns {Promise<Object|null>} Position or null
 */
export async function getOpenPosition(userId, instrumentKey) {
  return UserPosition.findOpenPosition(userId, instrumentKey);
}

/**
 * Get all open positions for a user
 * @param {string} userId
 * @returns {Promise<Array>}
 */
export async function getAllOpenPositions(userId) {
  return UserPosition.findAllOpenPositions(userId);
}

/**
 * Determine analysis mode based on position state
 * @param {string} userId
 * @param {string} instrumentKey
 * @returns {Promise<Object>} { mode: "DISCOVERY" | "POSITION_MANAGEMENT", position?: Object }
 */
export async function determineAnalysisMode(userId, instrumentKey) {
  const position = await getOpenPosition(userId, instrumentKey);

  if (!position) {
    return {
      mode: "DISCOVERY",
      position: null
    };
  }

  return {
    mode: "POSITION_MANAGEMENT",
    position: {
      id: position._id,
      symbol: position.symbol,
      actual_entry: position.actual_entry,
      qty: position.qty,
      current_sl: position.current_sl,
      current_target: position.current_target,
      days_in_trade: position.days_in_trade,
      original_analysis: position.original_analysis,
      sl_trail_history: position.sl_trail_history
    }
  };
}

/**
 * Generate position management context for AI prompt
 * @param {Object} position - User position object
 * @param {number} currentPrice - Current market price
 * @param {Object} technicals - { atr, swing_low, ema20, volatility, trend }
 * @returns {Object} Context for position management prompt
 */
export function generatePositionContext(position, currentPrice, technicals = {}) {
  const { atr, swing_low, ema20, volatility, trend } = technicals;

  // Calculate trailing stop recommendation
  const trailResult = calculateTrailingStop({
    position: {
      actual_entry: position.actual_entry,
      current_sl: position.current_sl,
      current_target: position.current_target
    },
    current_price: currentPrice,
    atr,
    swing_low,
    ema20
  });

  // Check exit conditions
  const alerts = checkExitConditions({
    position: {
      actual_entry: position.actual_entry,
      current_sl: position.current_sl,
      current_target: position.current_target
    },
    current_price: currentPrice,
    atr
  });

  // Get strategy recommendation
  const strategyRec = recommendTrailingStrategy({
    volatility: volatility || "NORMAL",
    trend: trend || "NEUTRAL",
    days_in_trade: position.days_in_trade,
    profit_pct: trailResult.current_profit_pct || 0
  });

  // Calculate risk reduction if trailing is recommended
  let riskReduction = null;
  if (trailResult.should_trail) {
    riskReduction = calculateRiskReduction({
      current_price: currentPrice,
      old_sl: position.current_sl,
      new_sl: trailResult.new_sl,
      qty: position.qty
    });
  }

  // Calculate unrealized P&L
  const unrealizedPnl = (currentPrice - position.actual_entry) * position.qty;
  const unrealizedPnlPct = ((currentPrice - position.actual_entry) / position.actual_entry) * 100;

  return {
    position: {
      symbol: position.symbol,
      actual_entry: position.actual_entry,
      qty: position.qty,
      current_sl: position.current_sl,
      current_target: position.current_target,
      days_in_trade: position.days_in_trade,
      trail_count: position.sl_trail_history?.length || 0
    },
    current_price: currentPrice,
    unrealized_pnl: {
      amount: Math.round(unrealizedPnl * 100) / 100,
      percentage: Math.round(unrealizedPnlPct * 100) / 100
    },
    distance_metrics: {
      to_target: Math.round((position.current_target - currentPrice) * 100) / 100,
      to_target_pct: Math.round(((position.current_target - currentPrice) / currentPrice) * 100 * 100) / 100,
      to_sl: Math.round((currentPrice - position.current_sl) * 100) / 100,
      to_sl_pct: Math.round(((currentPrice - position.current_sl) / currentPrice) * 100 * 100) / 100
    },
    trail_recommendation: trailResult,
    risk_reduction: riskReduction,
    strategy_recommendation: strategyRec,
    alerts,
    original_analysis: position.original_analysis
  };
}

/**
 * Apply trailing stop to a position
 * @param {string} positionId
 * @param {number} newSl
 * @param {string} reason
 * @param {string} method
 * @returns {Promise<Object>}
 */
export async function applyTrailingStop(positionId, newSl, reason, method) {
  const position = await UserPosition.findById(positionId);

  if (!position) {
    throw new Error("Position not found");
  }

  if (position.status !== "OPEN") {
    throw new Error("Position is not open");
  }

  return position.trailStopLoss(newSl, reason, method);
}

/**
 * Close a position
 * @param {string} positionId
 * @param {string} reason
 * @param {number} exitPrice
 * @returns {Promise<Object>}
 */
export async function closePosition(positionId, reason, exitPrice) {
  const position = await UserPosition.findById(positionId);

  if (!position) {
    throw new Error("Position not found");
  }

  return position.closePosition(reason, exitPrice);
}

/**
 * Create a new position from an analysis
 * @param {string} userId
 * @param {Object} stockAnalysis
 * @param {number} actualEntry
 * @param {number} qty
 * @param {Object} linkedOrders
 * @returns {Promise<Object>}
 */
export async function createPosition(userId, stockAnalysis, actualEntry, qty, linkedOrders = {}) {
  return UserPosition.createFromAnalysis(userId, stockAnalysis, actualEntry, qty, linkedOrders);
}

/**
 * Get position statistics for a user
 * @param {string} userId
 * @returns {Promise<Object>}
 */
export async function getPositionStats(userId) {
  const [openPositions, closedPositions] = await Promise.all([
    UserPosition.find({ user_id: userId, status: "OPEN" }),
    UserPosition.find({ user_id: userId, status: "CLOSED" })
  ]);

  const totalPnl = closedPositions.reduce((sum, p) => sum + (p.realized_pnl || 0), 0);
  const winners = closedPositions.filter(p => p.realized_pnl > 0);
  const losers = closedPositions.filter(p => p.realized_pnl < 0);

  return {
    open_count: openPositions.length,
    closed_count: closedPositions.length,
    total_realized_pnl: Math.round(totalPnl * 100) / 100,
    win_count: winners.length,
    loss_count: losers.length,
    win_rate: closedPositions.length > 0
      ? Math.round((winners.length / closedPositions.length) * 100 * 100) / 100
      : 0,
    avg_winner: winners.length > 0
      ? Math.round((winners.reduce((s, p) => s + p.realized_pnl, 0) / winners.length) * 100) / 100
      : 0,
    avg_loser: losers.length > 0
      ? Math.round((losers.reduce((s, p) => s + p.realized_pnl, 0) / losers.length) * 100) / 100
      : 0
  };
}

/**
 * Format user trade state for AI prompt context
 * @param {Object} position - Position from determineAnalysisMode
 * @param {number} currentPrice
 * @returns {Object} Formatted state for prompt injection
 */
export function formatUserTradeState(position, currentPrice) {
  if (!position) {
    return {
      has_position: false,
      mode: "DISCOVERY"
    };
  }

  const unrealizedPnlPct = ((currentPrice - position.actual_entry) / position.actual_entry) * 100;

  return {
    has_position: true,
    mode: "POSITION_MANAGEMENT",
    position_summary: {
      entry: position.actual_entry,
      current_sl: position.current_sl,
      current_target: position.current_target,
      qty: position.qty,
      days_held: position.days_in_trade,
      unrealized_pnl_pct: Math.round(unrealizedPnlPct * 100) / 100,
      original_archetype: position.original_analysis?.archetype,
      trail_count: position.sl_trail_history?.length || 0
    },
    instruction: `User has an OPEN position. DO NOT generate new entry/target/stopLoss.
Focus ONLY on position management: should they trail SL, hold, or exit?`
  };
}

export default {
  getOpenPosition,
  getAllOpenPositions,
  determineAnalysisMode,
  generatePositionContext,
  applyTrailingStop,
  closePosition,
  createPosition,
  getPositionStats,
  formatUserTradeState
};
