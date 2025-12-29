/**
 * Alerts Module
 *
 * Single source of truth for:
 * - Exit condition alerts
 * - Entry zone proximity checks
 * - Position status alerts
 */

import { round2, isNum } from './helpers.js';

/**
 * Alert severity levels
 */
export const SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info'
};

/**
 * Alert types
 */
export const ALERT_TYPES = {
  // Exit alerts
  STOP_HIT: 'STOP_HIT',
  NEAR_STOP: 'NEAR_STOP',
  TARGET_HIT: 'TARGET_HIT',
  NEAR_TARGET: 'NEAR_TARGET',
  BEYOND_TARGET: 'BEYOND_TARGET',
  HIGH_VOLATILITY: 'HIGH_VOLATILITY',

  // Entry alerts
  IN_ENTRY_ZONE: 'IN_ENTRY_ZONE',
  APPROACHING_ZONE: 'APPROACHING_ZONE',
  ZONE_TRIGGERED: 'ZONE_TRIGGERED',

  // Position alerts
  DRAWDOWN: 'DRAWDOWN',
  PROFIT_MILESTONE: 'PROFIT_MILESTONE'
};

/**
 * Check exit conditions for an open position
 *
 * @param {Object} params
 * @param {Object} params.position - { actual_entry, current_sl, current_target }
 * @param {number} params.current_price - Current market price
 * @param {number} [params.atr] - ATR for volatility assessment
 * @returns {Array<Object>} Array of alerts
 */
export function checkExitConditions({
  position,
  current_price,
  atr
}) {
  const { actual_entry, current_sl, current_target } = position;
  const alerts = [];

  if (!isNum(current_price)) {
    return alerts;
  }

  // Stop loss hit
  if (isNum(current_sl) && current_price <= current_sl) {
    alerts.push({
      type: ALERT_TYPES.STOP_HIT,
      severity: SEVERITY.CRITICAL,
      message: `Price ₹${current_price} has hit stop loss ₹${current_sl}`,
      suggestion: 'Exit position',
      action_required: true
    });
  }

  // Near stop loss (within 1%)
  if (isNum(current_sl) && current_price > current_sl) {
    const distance_to_sl_pct = ((current_price - current_sl) / current_price) * 100;
    if (distance_to_sl_pct <= 1) {
      alerts.push({
        type: ALERT_TYPES.NEAR_STOP,
        severity: SEVERITY.HIGH,
        message: `Price ₹${current_price} is ${round2(distance_to_sl_pct)}% from stop ₹${current_sl}`,
        suggestion: 'Prepare for possible exit',
        distance_pct: round2(distance_to_sl_pct)
      });
    }
  }

  // Target hit
  if (isNum(current_target) && current_price >= current_target) {
    alerts.push({
      type: ALERT_TYPES.TARGET_HIT,
      severity: SEVERITY.CRITICAL,
      message: `Price ₹${current_price} has hit target ₹${current_target}`,
      suggestion: 'Book profit or trail stop aggressively',
      action_required: true
    });
  }

  // Near target (within 1%)
  if (isNum(current_target) && current_price < current_target) {
    const distance_to_target_pct = ((current_target - current_price) / current_price) * 100;
    if (distance_to_target_pct <= 1 && distance_to_target_pct > 0) {
      alerts.push({
        type: ALERT_TYPES.NEAR_TARGET,
        severity: SEVERITY.HIGH,
        message: `Price ₹${current_price} is ${round2(distance_to_target_pct)}% from target ₹${current_target}`,
        suggestion: 'Consider booking partial or full profit',
        distance_pct: round2(distance_to_target_pct)
      });
    }
  }

  // Extended beyond target
  if (isNum(current_target) && current_price > current_target) {
    const extension_pct = ((current_price - current_target) / current_target) * 100;
    alerts.push({
      type: ALERT_TYPES.BEYOND_TARGET,
      severity: SEVERITY.MEDIUM,
      message: `Price ₹${current_price} has exceeded target ₹${current_target} by ${round2(extension_pct)}%`,
      suggestion: 'Trail stop aggressively or book profit'
    });
  }

  // High volatility warning
  if (isNum(atr) && isNum(current_price)) {
    const atr_pct = (atr / current_price) * 100;
    if (atr_pct > 3) {
      alerts.push({
        type: ALERT_TYPES.HIGH_VOLATILITY,
        severity: SEVERITY.MEDIUM,
        message: `Daily volatility (ATR) is ${round2(atr_pct)}% - elevated risk`,
        suggestion: 'Consider wider stops or reduced position size',
        atr_pct: round2(atr_pct)
      });
    }
  }

  return alerts;
}

/**
 * Check entry zone proximity
 *
 * @param {number} currentPrice - Current market price
 * @param {Object} entryZone - { low, high, center }
 * @returns {Object} Zone status with alert if applicable
 */
export function checkEntryZoneProximity(currentPrice, entryZone) {
  if (!isNum(currentPrice) || !entryZone || !isNum(entryZone.low) || !isNum(entryZone.high)) {
    return {
      inZone: false,
      approaching: false,
      distancePct: null,
      direction: 'unknown',
      alert: null
    };
  }

  const { low, high, center } = entryZone;

  // In zone
  if (currentPrice >= low && currentPrice <= high) {
    return {
      inZone: true,
      approaching: false,
      distancePct: 0,
      direction: 'in_zone',
      alert: {
        type: ALERT_TYPES.IN_ENTRY_ZONE,
        severity: SEVERITY.HIGH,
        message: `Price ₹${currentPrice} is in entry zone (₹${low} - ₹${high})`,
        suggestion: 'Good entry opportunity',
        urgency: 'high'
      }
    };
  }

  // Calculate distance
  let distancePct;
  let direction;

  if (currentPrice > high) {
    distancePct = round2(((currentPrice - high) / currentPrice) * 100);
    direction = 'above';
  } else {
    distancePct = round2(((low - currentPrice) / currentPrice) * 100);
    direction = 'below';
  }

  // Check if approaching (within 2%)
  const approaching = distancePct <= 2;

  let alert = null;
  if (approaching) {
    alert = {
      type: ALERT_TYPES.APPROACHING_ZONE,
      severity: SEVERITY.MEDIUM,
      message: `Price ₹${currentPrice} is ${distancePct}% ${direction} entry zone`,
      suggestion: direction === 'above' ? 'Wait for pullback to entry zone' : 'Monitor for zone entry',
      urgency: 'medium'
    };
  }

  return {
    inZone: false,
    approaching,
    distancePct,
    direction,
    alert
  };
}

/**
 * Generate position status alerts
 *
 * @param {Object} params
 * @param {number} params.current_price - Current price
 * @param {number} params.actual_entry - Entry price
 * @param {number} params.qty - Position quantity
 * @returns {Object} Position status with alerts
 */
export function checkPositionStatus({
  current_price,
  actual_entry,
  qty = 1
}) {
  if (!isNum(current_price) || !isNum(actual_entry)) {
    return { error: 'Invalid inputs' };
  }

  const pnl = (current_price - actual_entry) * qty;
  const pnl_pct = ((current_price - actual_entry) / actual_entry) * 100;

  const alerts = [];
  let status;
  let emoji;

  // Drawdown alert
  if (pnl_pct <= -5) {
    status = 'SIGNIFICANT_LOSS';
    emoji = '🔴';
    alerts.push({
      type: ALERT_TYPES.DRAWDOWN,
      severity: SEVERITY.CRITICAL,
      message: `Position down ${round2(Math.abs(pnl_pct))}%`,
      suggestion: 'Review stop loss or consider exit'
    });
  } else if (pnl_pct <= -2) {
    status = 'IN_DRAWDOWN';
    emoji = '⚠️';
    alerts.push({
      type: ALERT_TYPES.DRAWDOWN,
      severity: SEVERITY.MEDIUM,
      message: `Position down ${round2(Math.abs(pnl_pct))}%`,
      suggestion: 'Monitor closely'
    });
  } else if (pnl_pct >= 10) {
    status = 'STRONG_PROFIT';
    emoji = '🚀';
    alerts.push({
      type: ALERT_TYPES.PROFIT_MILESTONE,
      severity: SEVERITY.INFO,
      message: `Position up ${round2(pnl_pct)}%`,
      suggestion: 'Consider trailing stop or partial booking'
    });
  } else if (pnl_pct >= 5) {
    status = 'GOOD_PROFIT';
    emoji = '📈';
    alerts.push({
      type: ALERT_TYPES.PROFIT_MILESTONE,
      severity: SEVERITY.INFO,
      message: `Position up ${round2(pnl_pct)}%`,
      suggestion: 'Consider moving stop to breakeven'
    });
  } else if (pnl_pct >= 2) {
    status = 'IN_PROFIT';
    emoji = '📈';
  } else if (pnl_pct >= -2) {
    status = 'FLAT';
    emoji = '➖';
  } else {
    status = 'MINOR_LOSS';
    emoji = '📉';
  }

  return {
    pnl: round2(pnl),
    pnl_pct: round2(pnl_pct),
    status,
    emoji,
    alerts,
    needs_attention: alerts.some(a => a.severity === SEVERITY.CRITICAL || a.severity === SEVERITY.HIGH)
  };
}

/**
 * Generate morning glance summary for positions
 *
 * @param {Array<Object>} positions - Array of position data
 * @param {Object} priceMap - Map of instrument_key to current price
 * @returns {Object} Morning glance summary
 */
export function generateMorningGlance(positions, priceMap = {}) {
  if (!Array.isArray(positions) || positions.length === 0) {
    return {
      total_positions: 0,
      total_pnl: 0,
      attention_count: 0,
      positions: [],
      summary: 'No open positions'
    };
  }

  const enrichedPositions = positions.map(pos => {
    const current_price = priceMap[pos.instrument_key] || pos.current_price;

    const exitAlerts = checkExitConditions({
      position: {
        actual_entry: pos.actual_entry,
        current_sl: pos.current_sl,
        current_target: pos.current_target
      },
      current_price
    });

    const status = checkPositionStatus({
      current_price,
      actual_entry: pos.actual_entry,
      qty: pos.qty || 1
    });

    return {
      ...pos,
      current_price,
      ...status,
      exit_alerts: exitAlerts,
      all_alerts: [...(status.alerts || []), ...exitAlerts]
    };
  });

  const total_pnl = enrichedPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);
  const attention_count = enrichedPositions.filter(p => p.needs_attention).length;

  let summary;
  if (attention_count > 0) {
    summary = `${attention_count} position(s) need attention`;
  } else if (total_pnl > 0) {
    summary = 'Positions looking good, stay patient';
  } else if (total_pnl < 0) {
    summary = 'Some drawdown, but structure intact';
  } else {
    summary = 'Positions are flat';
  }

  return {
    total_positions: positions.length,
    total_pnl: round2(total_pnl),
    attention_count,
    positions: enrichedPositions,
    summary
  };
}

/**
 * Check watchlist for entry zone triggers
 *
 * @param {Array<Object>} watchlist - Array of watchlist items with entry_zone
 * @param {Object} priceMap - Map of symbol to current price
 * @returns {Array<Object>} Triggered or approaching entries
 */
export function checkWatchlistZones(watchlist, priceMap = {}) {
  if (!Array.isArray(watchlist)) return [];

  const triggered = [];

  for (const item of watchlist) {
    const currentPrice = priceMap[item.symbol] || priceMap[item.instrument_key];
    if (!isNum(currentPrice) || !item.entry_zone) continue;

    const zoneStatus = checkEntryZoneProximity(currentPrice, item.entry_zone);

    if (zoneStatus.inZone || zoneStatus.approaching) {
      triggered.push({
        symbol: item.symbol,
        name: item.name,
        current_price: currentPrice,
        entry_zone: item.entry_zone,
        ...zoneStatus
      });
    }
  }

  // Sort by urgency (in zone first, then by distance)
  return triggered.sort((a, b) => {
    if (a.inZone && !b.inZone) return -1;
    if (!a.inZone && b.inZone) return 1;
    return a.distancePct - b.distancePct;
  });
}

export default {
  checkExitConditions,
  checkEntryZoneProximity,
  checkPositionStatus,
  generateMorningGlance,
  checkWatchlistZones,
  SEVERITY,
  ALERT_TYPES
};
