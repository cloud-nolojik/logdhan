/**
 * Risk Management Module
 *
 * Single source of truth for:
 * - Trailing Stop Loss calculations
 * - Risk:Reward calculations
 * - Position sizing
 * - Risk reduction analysis
 */

import { round2, isNum } from './helpers.js';

/**
 * Calculate Risk:Reward for BUY trade
 */
export function rrBuy(entry, target, stopLoss) {
  if (!isNum(entry) || !isNum(target) || !isNum(stopLoss)) return 0;
  const risk = entry - stopLoss;
  const reward = target - entry;
  if (risk <= 0) return 0;
  return round2(reward / risk);
}

/**
 * Calculate Risk:Reward for SELL trade
 */
export function rrSell(entry, target, stopLoss) {
  if (!isNum(entry) || !isNum(target) || !isNum(stopLoss)) return 0;
  const risk = stopLoss - entry;
  const reward = entry - target;
  if (risk <= 0) return 0;
  return round2(reward / risk);
}

/**
 * Calculate trailing stop level
 *
 * RULE: Stop loss can ONLY move UP, never down.
 *
 * @param {Object} params
 * @param {Object} params.position - { actual_entry, current_sl, current_target }
 * @param {number} params.current_price - Current market price
 * @param {number} [params.atr] - ATR 14 daily
 * @param {number} [params.swing_low] - Recent swing low
 * @param {number} [params.ema20] - EMA 20 daily
 * @returns {Object} { should_trail, new_sl, method, reason, all_candidates }
 */
export function calculateTrailingStop({
  position,
  current_price,
  atr,
  swing_low,
  ema20
}) {
  const { actual_entry, current_sl, current_target } = position;

  // Validate inputs
  if (!isNum(current_price)) {
    return {
      should_trail: false,
      reason: 'Invalid current price'
    };
  }

  // Not in profit = no trailing
  if (current_price <= actual_entry) {
    return {
      should_trail: false,
      reason: 'Position not in profit yet',
      current_profit_pct: round2(((current_price - actual_entry) / actual_entry) * 100)
    };
  }

  const profit_pct = ((current_price - actual_entry) / actual_entry) * 100;
  const candidates = [];

  // Method 1: ATR-based trailing (1.5 ATR below current price)
  if (isNum(atr) && atr > 0) {
    const atr_stop = round2(current_price - (1.5 * atr));
    if (atr_stop > current_sl && atr_stop < current_price) {
      candidates.push({
        method: 'ATR_TRAIL',
        new_sl: atr_stop,
        reason: `1.5x ATR (₹${round2(atr)}) below current price ₹${current_price}`,
        protection_pct: round2(((current_price - atr_stop) / current_price) * 100)
      });
    }
  }

  // Method 2: Swing low trailing
  if (isNum(swing_low) && swing_low > current_sl && swing_low < current_price) {
    const buffer = atr ? atr * 0.1 : 1;
    const swing_stop = round2(swing_low - buffer);
    if (swing_stop > current_sl) {
      candidates.push({
        method: 'SWING_LOW',
        new_sl: swing_stop,
        reason: `Recent swing low ₹${swing_low} minus buffer`,
        protection_pct: round2(((current_price - swing_stop) / current_price) * 100)
      });
    }
  }

  // Method 3: EMA20 trailing
  if (isNum(ema20) && ema20 > current_sl && ema20 < current_price) {
    const buffer = atr ? atr * 0.2 : 2;
    const ema_stop = round2(ema20 - buffer);
    if (ema_stop > current_sl) {
      candidates.push({
        method: 'EMA_TRAIL',
        new_sl: ema_stop,
        reason: `Below 20-day average ₹${round2(ema20)} minus buffer`,
        protection_pct: round2(((current_price - ema_stop) / current_price) * 100)
      });
    }
  }

  // Method 4: Breakeven stop (move to entry price)
  if (profit_pct >= 2 && actual_entry > current_sl) {
    candidates.push({
      method: 'BREAKEVEN',
      new_sl: actual_entry,
      reason: `Move to breakeven after ${round2(profit_pct)}% gain`,
      protection_pct: round2(((current_price - actual_entry) / current_price) * 100)
    });
  }

  // Method 5: Lock minimum profit (when up 3%+, lock 1%)
  if (profit_pct >= 3) {
    const lock_1pct = round2(actual_entry * 1.01);
    if (lock_1pct > current_sl && lock_1pct < current_price) {
      candidates.push({
        method: 'LOCK_PROFIT',
        new_sl: lock_1pct,
        reason: `Lock 1% profit after ${round2(profit_pct)}% gain`,
        protection_pct: round2(((current_price - lock_1pct) / current_price) * 100)
      });
    }
  }

  // Method 6: Percentage-based trailing (for larger profits)
  // If profit > 5%, trail to lock in at least 50% of the gain
  if (profit_pct > 5) {
    const gain_per_share = current_price - actual_entry;
    const lock_50pct = round2(actual_entry + (gain_per_share * 0.5));

    if (lock_50pct > current_sl && lock_50pct < current_price) {
      candidates.push({
        method: 'LOCK_PROFIT',
        new_sl: lock_50pct,
        reason: `Lock 50% of ${round2(profit_pct)}% gain`,
        protection_pct: round2(((current_price - lock_50pct) / current_price) * 100)
      });
    }
  }

  // No valid candidates
  if (candidates.length === 0) {
    return {
      should_trail: false,
      reason: 'No trailing level found above current SL',
      current_sl,
      current_profit_pct: round2(profit_pct)
    };
  }

  // Sort by new_sl descending (highest = most protective)
  candidates.sort((a, b) => b.new_sl - a.new_sl);
  const best = candidates[0];

  // Ensure best doesn't exceed target
  if (isNum(current_target) && best.new_sl >= current_target) {
    return {
      should_trail: false,
      reason: 'Best trailing stop would exceed target',
      current_sl,
      current_target
    };
  }

  return {
    should_trail: true,
    new_sl: best.new_sl,
    method: best.method,
    reason: best.reason,
    protection_pct: best.protection_pct,
    current_profit_pct: round2(profit_pct),
    all_candidates: candidates
  };
}

/**
 * Recommend trailing strategy based on market conditions
 *
 * @param {Object} params
 * @param {string} params.volatility - "LOW" | "MEDIUM" | "HIGH"
 * @param {string} params.trend - "BULLISH" | "BEARISH" | "NEUTRAL"
 * @param {number} params.days_in_trade - Days position has been held
 * @param {number} params.profit_pct - Current profit percentage
 * @returns {Object} Strategy recommendation
 */
export function recommendTrailingStrategy({
  volatility,
  trend,
  days_in_trade,
  profit_pct
}) {
  // High volatility = use wider ATR-based stops
  if (volatility === 'HIGH') {
    return {
      primary_method: 'ATR_TRAIL',
      atr_multiplier: 2.0,
      reason: 'Higher volatility requires wider stops to avoid premature exit'
    };
  }

  // Strong trend = use EMA trailing to ride the trend
  if (trend === 'BULLISH' && days_in_trade > 3) {
    return {
      primary_method: 'EMA_TRAIL',
      reason: 'Bullish trend supports using moving average as dynamic support'
    };
  }

  // Early in trade = aim for breakeven first
  if (days_in_trade <= 2 && profit_pct >= 2) {
    return {
      primary_method: 'BREAKEVEN',
      reason: 'Early in trade - priority is protecting capital with breakeven stop'
    };
  }

  // Good profit = lock some gains
  if (profit_pct >= 5) {
    return {
      primary_method: 'LOCK_PROFIT',
      reason: 'Substantial profit - lock in gains with trailing stop'
    };
  }

  // Default: swing low based trailing
  return {
    primary_method: 'SWING_LOW',
    reason: 'Swing low provides natural support level for stop placement'
  };
}

/**
 * Calculate risk reduction from trailing stop
 *
 * @param {Object} params
 * @param {number} params.current_price - Current price
 * @param {number} params.old_sl - Old stop loss
 * @param {number} params.new_sl - New stop loss
 * @param {number} params.qty - Position quantity
 * @returns {Object} Risk reduction analysis
 */
export function calculateRiskReduction({
  current_price,
  old_sl,
  new_sl,
  qty
}) {
  if (!isNum(current_price) || !isNum(old_sl) || !isNum(new_sl) || !isNum(qty)) {
    return { error: 'Invalid inputs' };
  }

  const old_risk_per_share = current_price - old_sl;
  const new_risk_per_share = current_price - new_sl;

  const old_risk_total = old_risk_per_share * qty;
  const new_risk_total = new_risk_per_share * qty;

  const risk_reduction = old_risk_total - new_risk_total;
  const risk_reduction_pct = old_risk_total > 0 ? (risk_reduction / old_risk_total) * 100 : 0;

  return {
    old_risk: {
      per_share: round2(old_risk_per_share),
      total: round2(old_risk_total),
      pct: round2((old_risk_per_share / current_price) * 100)
    },
    new_risk: {
      per_share: round2(new_risk_per_share),
      total: round2(new_risk_total),
      pct: round2((new_risk_per_share / current_price) * 100)
    },
    reduction: {
      amount: round2(risk_reduction),
      percentage: round2(risk_reduction_pct)
    }
  };
}

/**
 * Calculate position size based on risk budget
 *
 * @param {Object} params
 * @param {number} params.risk_budget - Maximum amount willing to lose (in INR)
 * @param {number} params.entry - Entry price
 * @param {number} params.stopLoss - Stop loss price
 * @param {number} [params.max_position_value] - Maximum position value allowed
 * @returns {Object} Position sizing recommendation
 */
export function calculatePositionSize({
  risk_budget,
  entry,
  stopLoss,
  max_position_value
}) {
  if (!isNum(risk_budget) || !isNum(entry) || !isNum(stopLoss)) {
    return { error: 'Invalid inputs' };
  }

  const risk_per_share = Math.abs(entry - stopLoss);

  if (risk_per_share <= 0) {
    return { error: 'Invalid stop loss - no risk per share' };
  }

  // Calculate quantity based on risk budget
  let qty = Math.floor(risk_budget / risk_per_share);

  // Apply max position value constraint if provided
  if (isNum(max_position_value) && max_position_value > 0) {
    const max_qty_by_value = Math.floor(max_position_value / entry);
    qty = Math.min(qty, max_qty_by_value);
  }

  const position_value = qty * entry;
  const actual_risk = qty * risk_per_share;

  return {
    recommended_qty: qty,
    position_value: round2(position_value),
    risk_per_share: round2(risk_per_share),
    total_risk: round2(actual_risk),
    risk_pct: round2((risk_per_share / entry) * 100)
  };
}

/**
 * Assess trade risk quality
 *
 * @param {Object} params
 * @param {number} params.entry - Entry price
 * @param {number} params.stopLoss - Stop loss price
 * @param {number} params.target - Target price
 * @returns {Object} Risk assessment
 */
export function assessTradeRisk({
  entry,
  stopLoss,
  target
}) {
  if (!isNum(entry) || !isNum(stopLoss) || !isNum(target)) {
    return { error: 'Invalid inputs' };
  }

  const riskPct = round2(((entry - stopLoss) / entry) * 100);
  const rewardPct = round2(((target - entry) / entry) * 100);
  const rr = rrBuy(entry, target, stopLoss);

  let riskLevel;
  let recommendation;

  if (riskPct > 5) {
    riskLevel = 'HIGH';
    recommendation = 'Risk too high - consider tighter stop or smaller position';
  } else if (riskPct > 3) {
    riskLevel = 'MEDIUM';
    recommendation = 'Moderate risk - ensure position size is appropriate';
  } else {
    riskLevel = 'LOW';
    recommendation = 'Good risk control';
  }

  let rrQuality;
  if (rr >= 2.5) {
    rrQuality = 'EXCELLENT';
  } else if (rr >= 2.0) {
    rrQuality = 'GOOD';
  } else if (rr >= 1.5) {
    rrQuality = 'ACCEPTABLE';
  } else if (rr >= 1.0) {
    rrQuality = 'MARGINAL';
  } else {
    rrQuality = 'POOR';
  }

  return {
    risk_pct: riskPct,
    reward_pct: rewardPct,
    risk_reward: rr,
    risk_level: riskLevel,
    rr_quality: rrQuality,
    recommendation
  };
}

export default {
  rrBuy,
  rrSell,
  calculateTrailingStop,
  recommendTrailingStrategy,
  calculateRiskReduction,
  calculatePositionSize,
  assessTradeRisk
};
