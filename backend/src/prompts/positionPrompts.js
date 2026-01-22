/**
 * Position Prompts - Daily Watchlist Analysis
 * 
 * Purpose: Generate AI analysis for stocks users are tracking daily
 * Focus: "How is this stock doing today? What should I do?"
 * 
 * IMPORTANT: Analysis is GLOBAL (per-stock, not per-user)
 * - We don't know if user bought or not
 * - Always show BOTH "if holding" and "if watching" guidance
 * 
 * Uses:
 * - Original analysis levels (entry, stop, target)
 * - TODAY's price action
 */

import { round2, isNum } from "../engine/helpers.js";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate distance to key levels
 */
function calculateDistances(currentPrice, levels) {
  if (!currentPrice || !levels) return null;
  
  return {
    to_stop: round2(((currentPrice - levels.stop) / currentPrice) * 100),
    to_target: round2(((levels.target - currentPrice) / currentPrice) * 100),
    from_entry: round2(((currentPrice - levels.entry) / levels.entry) * 100)
  };
}

/**
 * Determine status based on price vs levels
 */
function determineStatus(currentPrice, levels, rsi) {
  const distances = calculateDistances(currentPrice, levels);
  if (!distances) return { status: "UNKNOWN", reason: "Missing data" };
  
  // Near stop loss (within 3%)
  if (distances.to_stop <= 3) {
    return { status: "NEAR_STOP", color: "RED", reason: "Price near stop loss" };
  }
  
  // Near target (within 3%)
  if (distances.to_target <= 3) {
    return { status: "NEAR_TARGET", color: "YELLOW", reason: "Price approaching target" };
  }
  
  // RSI overbought
  if (rsi && rsi > 75) {
    return { status: "EXTENDED", color: "YELLOW", reason: `RSI ${rsi} is overbought` };
  }
  
  // Above entry, stop is safe
  if (distances.from_entry > 0 && distances.to_stop > 5) {
    return { status: "ON_TRACK", color: "GREEN", reason: "Setup intact, above entry zone" };
  }
  
  // At or below entry
  if (distances.from_entry <= 0 && distances.to_stop > 3) {
    return { status: "AT_ENTRY", color: "GREEN", reason: "At entry zone" };
  }
  
  // Default
  return { status: "NEUTRAL", color: "GREEN", reason: "Setup intact" };
}

// ============================================================================
// MAIN PROMPT BUILDER
// ============================================================================

/**
 * Build Position Management Prompt
 * 
 * GLOBAL analysis - shared by all users tracking this stock
 * Always provides guidance for BOTH scenarios (holding / watching)
 */
export async function buildPositionManagementPrompt({
  stock_name,
  stock_symbol,
  current_price,
  generatedAtIst,
  
  // Original analysis (from weekly discovery)
  original_levels = null,      // { entry, stop, target, riskReward }
  original_score = null,       // { score, grade }
  
  // Today's candle data
  today_open = null,
  today_high = null,
  today_low = null,
  today_close = null,
  today_change_pct = null,
  today_volume = null,
  avg_volume = null,
  
  // Current indicators
  rsi = null,
  
  // Market context
  nifty_change_pct = null,
  sector_change_pct = null
}) {
  
  // Calculate derived values
  const distances = calculateDistances(current_price, original_levels);
  const autoStatus = determineStatus(current_price, original_levels, rsi);
  
  // Volume ratio
  const volumeRatio = (today_volume && avg_volume) ? round2(today_volume / avg_volume) : null;

  const system = `You are a swing trading coach for Indian equities.
Provide clear, actionable guidance based on today's price action.
Return STRICT, VALID JSON matching the schema exactly.
No markdown. No extra text.`;

  const user = `
=== DAILY POSITION ANALYSIS ===
Purpose: Help user decide "What should I do with this stock TODAY?"

NOTE: This is GLOBAL analysis. We don't know if user bought or not.
Always provide guidance for BOTH scenarios: "if holding" and "if watching"

=== STOCK INFO ===
Stock: ${stock_name} (${stock_symbol})
Current Price: ₹${current_price}
Analysis Time: ${generatedAtIst}

=== TODAY'S PRICE ACTION ===
Open: ₹${today_open || 'N/A'}
High: ₹${today_high || 'N/A'}
Low: ₹${today_low || 'N/A'}
Close: ₹${today_close || current_price}
Day Change: ${today_change_pct != null ? `${today_change_pct > 0 ? '+' : ''}${today_change_pct.toFixed(2)}%` : 'N/A'}
Volume: ${volumeRatio ? `${volumeRatio}x average` : 'N/A'}

=== CURRENT INDICATORS ===
RSI: ${rsi || 'N/A'} ${rsi && rsi > 70 ? '⚠️ Overbought' : rsi && rsi < 30 ? '⚠️ Oversold' : ''}

=== ORIGINAL SETUP (From Weekly Discovery) ===
Score: ${original_score?.score || 'N/A'}/100 | Grade: ${original_score?.grade || 'N/A'}
Entry Level: ₹${original_levels?.entry || 'N/A'}
Stop Loss: ₹${original_levels?.stop || 'N/A'}
Target: ₹${original_levels?.target || 'N/A'}
R:R: 1:${original_levels?.riskReward || 'N/A'}

=== DISTANCE TO LEVELS ===
From Entry: ${distances?.from_entry != null ? `${distances.from_entry > 0 ? '+' : ''}${distances.from_entry}%` : 'N/A'} ${distances?.from_entry > 0 ? '(Above entry)' : '(At/Below entry)'}
To Stop: ${distances?.to_stop != null ? `${distances.to_stop}%` : 'N/A'} ${distances?.to_stop <= 3 ? '⚠️ CLOSE TO STOP' : ''}
To Target: ${distances?.to_target != null ? `${distances.to_target}%` : 'N/A'} ${distances?.to_target <= 3 ? '🎯 NEAR TARGET' : ''}

=== MARKET CONTEXT ===
Nifty Change: ${nifty_change_pct != null ? `${nifty_change_pct > 0 ? '+' : ''}${nifty_change_pct.toFixed(2)}%` : 'N/A'}
Sector Change: ${sector_change_pct != null ? `${sector_change_pct > 0 ? '+' : ''}${sector_change_pct.toFixed(2)}%` : 'N/A'}
Relative Performance: ${today_change_pct != null && nifty_change_pct != null ? `${(today_change_pct - nifty_change_pct) > 0 ? 'Outperforming' : 'Underperforming'} Nifty by ${Math.abs(today_change_pct - nifty_change_pct).toFixed(1)}%` : 'N/A'}

=== AUTO-DETECTED STATUS ===
Status: ${autoStatus.status}
Color: ${autoStatus.color}
Reason: ${autoStatus.reason}

=== OUTPUT SCHEMA ===

Return ONLY this JSON structure:

{
  "schema_version": "1.0",
  "symbol": "${stock_symbol}",
  "analysis_type": "position_management",
  "generated_at_ist": "${generatedAtIst}",
  
  "status": {
    "color": "GREEN" | "YELLOW" | "RED",
    "label": "ON_TRACK" | "WATCH_CLOSELY" | "ACTION_NEEDED" | "NEAR_TARGET" | "NEAR_STOP" | "AT_ENTRY",
    "one_liner": "Single sentence summary of current situation"
  },
  
  "recommendation": {
    "for_holders": "HOLD" | "TRAIL_STOP" | "BOOK_PARTIAL" | "EXIT",
    "for_watchers": "BUY_NOW" | "WAIT" | "SKIP",
    "confidence": <0.0 to 1.0>,
    "reasoning": "Why this makes sense based on today's price action"
  },
  
  "levels_update": {
    "original_stop": ${original_levels?.stop || 'null'},
    "suggested_stop": <new stop if trailing recommended, else same as original>,
    "stop_trail_reason": "Why trail stop here" | null,
    "target_1": ${original_levels?.target || 'null'},
    "target_2": <extended target if momentum strong> | null
  },
  
  "todays_analysis": {
    "price_action": "What happened today in plain English",
    "volume_verdict": "HIGH_CONVICTION" | "NORMAL" | "LOW_CONVICTION" | "PROFIT_BOOKING",
    "rsi_verdict": "HEALTHY" | "EXTENDED" | "COOLING_OFF" | "OVERSOLD",
    "vs_market": "OUTPERFORMING" | "IN_LINE" | "UNDERPERFORMING"
  },
  
  "what_to_do": {
    "if_holding": "Specific action with ₹ prices for users who bought",
    "if_watching": "Specific action with ₹ prices for users still watching",
    "key_level_to_watch": "₹XXX - what happens here matters"
  },
  
  "scenarios": {
    "if_goes_up": "What to do if stock continues up tomorrow",
    "if_goes_down": "What to do if stock falls tomorrow",
    "if_sideways": "What to do if stock goes nowhere"
  },
  
  "alerts": [
    {
      "type": "NEAR_STOP" | "NEAR_TARGET" | "RSI_EXTENDED" | "VOLUME_SPIKE" | "BREAKDOWN" | "BREAKOUT",
      "severity": "low" | "medium" | "high",
      "message": "Plain English alert",
      "action": "What to do about it"
    }
  ],
  
  "disclaimer": "Daily update for educational purposes. Not investment advice."
}

=== RULES ===

1. status.color:
   - GREEN: Setup intact, price healthy relative to levels
   - YELLOW: Watch closely (RSI extended, near target, sideways too long)
   - RED: Action needed (near stop, breakdown risk)

2. recommendation:
   - for_holders: What should someone who BOUGHT do?
     - HOLD: Keep position, nothing to do
     - TRAIL_STOP: Move stop up (suggest specific price)
     - BOOK_PARTIAL: Take 50% profits
     - EXIT: Close position
   - for_watchers: What should someone STILL WATCHING do?
     - BUY_NOW: Entry conditions met, can buy
     - WAIT: Not at entry level yet, or need confirmation
     - SKIP: Setup no longer valid

3. Trail stop rules:
   - Only suggest TRAIL_STOP if price is above entry (in profit)
   - New stop must be > original stop (can only move UP)
   - Common: Move to breakeven after 3-5% gain

4. what_to_do MUST include specific ₹ prices

5. alerts array can be empty [] if nothing notable

=== OUTPUT ===
Return ONLY the JSON object. No markdown, no explanation.
`;

  return { system, user };
}

// ============================================================================
// QUICK STATUS CHECK (No AI - Rule Based)
// ============================================================================

/**
 * Quick status check - NO AI, pure rule-based
 * Use for real-time status during market hours (FREE)
 * 
 * Returns: { color, label, reason, alerts }
 */
export function quickPositionStatus({
  current_price,
  original_levels,
  rsi = null
}) {
  const distances = calculateDistances(current_price, original_levels);
  const alerts = [];
  
  if (!distances) {
    return {
      color: "YELLOW",
      label: "NO_DATA",
      reason: "Missing price or level data",
      alerts: []
    };
  }
  
  // RED conditions (Action Needed)
  // Check if stop loss has been breached (price below stop = negative distance)
  if (distances.to_stop <= 0) {
    return {
      color: "RED",
      label: "BELOW_STOP",
      reason: `Stop loss breached - price is ${Math.abs(distances.to_stop)}% below stop`,
      alerts: [{ type: "BREAKDOWN", severity: "high", message: "Stop loss breached - exit recommended" }]
    };
  }

  if (distances.to_stop <= 2) {
    return {
      color: "RED",
      label: "NEAR_STOP",
      reason: `Price within 2% of stop loss`,
      alerts: [{ type: "NEAR_STOP", severity: "high", message: "Stop loss at risk" }]
    };
  }
  
  // YELLOW conditions (Watch Closely)
  if (distances.to_target <= 3) {
    alerts.push({ type: "NEAR_TARGET", severity: "medium", message: "Approaching target - consider booking" });
  }
  
  if (rsi && rsi > 75) {
    alerts.push({ type: "RSI_EXTENDED", severity: "medium", message: `RSI at ${rsi} - overbought` });
  }
  
  if (distances.to_stop <= 5 && distances.to_stop > 2) {
    alerts.push({ type: "STOP_CLOSE", severity: "low", message: "Stop loss getting closer" });
  }
  
  if (alerts.length > 0) {
    return {
      color: "YELLOW",
      label: "WATCH_CLOSELY",
      reason: alerts[0].message,
      alerts
    };
  }
  
  // GREEN (On Track)
  if (distances.from_entry > 0) {
    return {
      color: "GREEN",
      label: "ON_TRACK",
      reason: `Up ${distances.from_entry}% from entry, setup intact`,
      alerts: []
    };
  }
  
  // At entry zone
  return {
    color: "GREEN",
    label: "AT_ENTRY",
    reason: "At entry zone, setup intact",
    alerts: []
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  buildPositionManagementPrompt,
  quickPositionStatus,
  calculateDistances
};
