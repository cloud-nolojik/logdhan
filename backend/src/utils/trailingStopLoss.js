/**
 * Trailing Stop Loss Utility
 *
 * Deterministic (code-first, not AI) logic for calculating trailing stop levels.
 * RULE: Stop loss can ONLY move UP, never down.
 */

/**
 * Round to 2 decimal places
 */
function round2(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  return Math.round(x * 100) / 100;
}

/**
 * Calculate if and where to trail stop loss
 *
 * @param {Object} params
 * @param {Object} params.position - { actual_entry, current_sl, current_target }
 * @param {number} params.current_price
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
  if (typeof current_price !== 'number' || !Number.isFinite(current_price)) {
    return {
      should_trail: false,
      reason: 'Invalid current price'
    };
  }

  // Not in profit = no trailing
  if (current_price <= actual_entry) {
    return {
      should_trail: false,
      reason: "Position not in profit yet",
      current_profit_pct: round2(((current_price - actual_entry) / actual_entry) * 100)
    };
  }

  const profit_pct = ((current_price - actual_entry) / actual_entry) * 100;
  const candidates = [];

  // Method 1: ATR-based trailing (1.5 ATR below current price)
  if (atr && atr > 0) {
    const atr_stop = round2(current_price - (1.5 * atr));
    if (atr_stop > current_sl && atr_stop < current_price) {
      candidates.push({
        method: "ATR_TRAIL",
        new_sl: atr_stop,
        reason: `1.5x ATR (₹${round2(atr)}) below current price ₹${current_price}`,
        protection_pct: round2(((current_price - atr_stop) / current_price) * 100)
      });
    }
  }

  // Method 2: Swing low trailing
  if (swing_low && swing_low > current_sl && swing_low < current_price) {
    const buffer = atr ? atr * 0.1 : 1;
    const swing_stop = round2(swing_low - buffer);
    if (swing_stop > current_sl) {
      candidates.push({
        method: "SWING_LOW",
        new_sl: swing_stop,
        reason: `Recent swing low ₹${swing_low} minus buffer`,
        protection_pct: round2(((current_price - swing_stop) / current_price) * 100)
      });
    }
  }

  // Method 3: EMA20 trailing
  if (ema20 && ema20 > current_sl && ema20 < current_price) {
    const buffer = atr ? atr * 0.2 : 2;
    const ema_stop = round2(ema20 - buffer);
    if (ema_stop > current_sl) {
      candidates.push({
        method: "EMA_TRAIL",
        new_sl: ema_stop,
        reason: `Below 20-day average ₹${round2(ema20)} minus buffer`,
        protection_pct: round2(((current_price - ema_stop) / current_price) * 100)
      });
    }
  }

  // Method 4: Breakeven stop (move to entry price)
  if (profit_pct >= 2 && actual_entry > current_sl) {
    candidates.push({
      method: "BREAKEVEN",
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
        method: "LOCK_PROFIT",
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
        method: "LOCK_PROFIT",
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
      reason: "No trailing level found above current SL",
      current_sl,
      current_profit_pct: round2(profit_pct)
    };
  }

  // Sort by new_sl descending (highest = most protective)
  candidates.sort((a, b) => b.new_sl - a.new_sl);
  const best = candidates[0];

  // Ensure best doesn't exceed target
  if (best.new_sl >= current_target) {
    return {
      should_trail: false,
      reason: "Best trailing stop would exceed target",
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
 * Check if position should trigger exit alert
 */
export function checkExitConditions({
  position,
  current_price,
  atr
}) {
  const { actual_entry, current_sl, current_target } = position;
  const alerts = [];

  if (typeof current_price !== 'number' || !Number.isFinite(current_price)) {
    return alerts;
  }

  // Near target (within 1%)
  const distance_to_target_pct = ((current_target - current_price) / current_price) * 100;
  if (distance_to_target_pct <= 1 && distance_to_target_pct > 0) {
    alerts.push({
      type: "NEAR_TARGET",
      severity: "high",
      message: `Price ₹${current_price} is ${round2(distance_to_target_pct)}% from target ₹${current_target}`,
      suggestion: "Consider booking partial or full profit"
    });
  }

  // Target hit
  if (current_price >= current_target) {
    alerts.push({
      type: "TARGET_HIT",
      severity: "critical",
      message: `Price ₹${current_price} has hit target ₹${current_target}`,
      suggestion: "Book profit or trail stop aggressively"
    });
  }

  // Near stop loss (within 1%)
  const distance_to_sl_pct = ((current_price - current_sl) / current_price) * 100;
  if (distance_to_sl_pct <= 1 && distance_to_sl_pct > 0) {
    alerts.push({
      type: "NEAR_STOP",
      severity: "high",
      message: `Price ₹${current_price} is ${round2(distance_to_sl_pct)}% from stop ₹${current_sl}`,
      suggestion: "Prepare for possible exit"
    });
  }

  // Extended beyond target
  if (current_price > current_target) {
    alerts.push({
      type: "BEYOND_TARGET",
      severity: "medium",
      message: `Price ₹${current_price} has exceeded target ₹${current_target}`,
      suggestion: "Trail stop aggressively or book profit"
    });
  }

  // Stop loss hit
  if (current_price <= current_sl) {
    alerts.push({
      type: "STOP_HIT",
      severity: "critical",
      message: `Price ₹${current_price} has hit stop loss ₹${current_sl}`,
      suggestion: "Exit position"
    });
  }

  // High volatility warning (if ATR provided)
  if (atr && atr > 0) {
    const atr_pct = (atr / current_price) * 100;
    if (atr_pct > 3) {
      alerts.push({
        type: "HIGH_VOLATILITY",
        severity: "medium",
        message: `Daily volatility (ATR) is ${round2(atr_pct)}% - elevated risk`,
        suggestion: "Consider wider stops or reduced position size"
      });
    }
  }

  return alerts;
}

/**
 * Recommend trailing strategy based on market conditions
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
 * Calculate position risk after potential trailing
 */
export function calculateRiskReduction({
  current_price,
  old_sl,
  new_sl,
  qty
}) {
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

export default {
  calculateTrailingStop,
  checkExitConditions,
  recommendTrailingStrategy,
  calculateRiskReduction
};
