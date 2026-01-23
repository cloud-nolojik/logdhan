/**
 * Swing Prompts - Weekly Discovery Analysis
 * 
 * Purpose: Generate AI analysis for weekend stock picks
 * Focus: "Should I buy this stock next week?"
 * 
 * Uses:
 * - scanLevels.js for trading levels (entry, stop, target)
 * - scoring.js for 6-factor framework
 * - AI for plain English explanations
 */

import { round2, isNum } from "../engine/helpers.js";
import scanLevels from "../engine/scanLevels.js";

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function get(obj, path, fallback = undefined) {
  try {
    return path.split(".").reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Plain English explanation for each scoring factor
 */
function getFactorPlainEnglish(factor, points, max, value) {
  const pct = Math.round((points / max) * 100);
  
  const explanations = {
    'Volume Conviction': {
      strong: `Volume ${value} shows institutions are buying - smart money is in`,
      okay: `Volume ${value} is decent - some conviction behind the move`,
      weak: `Volume ${value} is low - move lacks conviction`
    },
    'Risk:Reward': {
      strong: `R:R of ${value} is excellent - risking little to gain a lot`,
      okay: `R:R of ${value} is acceptable - worth considering`,
      weak: `R:R of ${value} is poor - too much risk for the potential gain`
    },
    'RSI Position': {
      strong: `RSI ${value} is perfect - momentum without being overbought`,
      okay: `RSI ${value} is acceptable but watch for extension`,
      weak: `RSI ${value} is risky - either overbought or no momentum`
    },
    'Weekly Move': {
      strong: `+${value} this week confirms real momentum, not just a spike`,
      okay: `+${value} this week shows decent momentum`,
      weak: `${value} weekly move is weak`
    },
    'Upside to Target': {
      strong: `${value} upside makes this trade worth the effort`,
      okay: `${value} upside is reasonable`,
      weak: `${value} upside is limited`
    },
    'Relative Strength': {
      strong: `Beating the market by ${value} - stock-specific strength`,
      okay: `Roughly in line with market (${value})`,
      weak: `Lagging market by ${value}`
    },
    'Price Accessibility': {
      strong: `At ₹${value}, easy to size positions`,
      okay: `At ₹${value}, manageable position sizing`,
      weak: `At ₹${value}, may need larger capital`
    }
  };

  const factorExplanations = explanations[factor];
  if (!factorExplanations) return `${factor}: ${value}`;

  if (pct >= 70) return factorExplanations.strong;
  if (pct >= 40) return factorExplanations.okay;
  return factorExplanations.weak;
}

// ============================================================================
// STAGE 1: Market Context
// ============================================================================

/**
 * Build Stage 1 - Basic market context
 */
export function buildStage1({
  stock_name,
  stock_symbol,
  current_price,
  marketPayload,
  sectorInfo,
}) {
  const priceContext = marketPayload?.priceContext ?? {};
  const trendMomentum = marketPayload?.trendMomentum ?? {};
  const volumeContext = marketPayload?.volumeContext ?? {};

  const last = typeof priceContext.last === "number" ? priceContext.last : current_price;
  const ema20_1D = typeof trendMomentum.ema20_1D === "number" ? trendMomentum.ema20_1D : null;
  const ema50_1D = typeof trendMomentum.ema50_1D === "number" ? trendMomentum.ema50_1D : null;
  const sma200_1D = typeof trendMomentum.sma200_1D === "number" ? trendMomentum.sma200_1D : null;
  const atr14_1D = typeof trendMomentum.atr14_1D === "number" ? trendMomentum.atr14_1D : null;

  // Trend detection
  let trend = "NEUTRAL";
  if (ema20_1D != null && ema50_1D != null && sma200_1D != null) {
    if (last > sma200_1D && ema20_1D > ema50_1D) {
      trend = "BULLISH";
    } else if (last < sma200_1D && ema20_1D < ema50_1D) {
      trend = "BEARISH";
    }
  }

  // Volatility from ATR%
  let volatility = "MEDIUM";
  if (atr14_1D != null && last > 0) {
    const atrPct = (atr14_1D / last) * 100;
    if (atrPct < 1) volatility = "LOW";
    else if (atrPct > 2) volatility = "HIGH";
  }

  // Volume band
  let volume = "UNKNOWN";
  const volClass = volumeContext.classification || volumeContext.band;
  if (typeof volClass === "string") {
    const cls = volClass.toUpperCase();
    if (["ABOVE_AVERAGE", "AVERAGE", "BELOW_AVERAGE"].includes(cls)) {
      volume = cls;
    }
  }

  // Data health
  const have_last = typeof last === "number" && !Number.isNaN(last);
  const have_atr14_1D = atr14_1D != null;
  const insufficientData = !have_last || !have_atr14_1D || !ema20_1D || !ema50_1D;

  return {
    schema_version: "1.5",
    symbol: stock_symbol,
    insufficientData,
    market_summary: { last, trend, volatility, volume },
    sector: sectorInfo?.name || "Unknown",
  };
}

// ============================================================================
// STAGE 3: Weekly Discovery Prompt (Main Function)
// ============================================================================

/**
 * Build Stage 3 Prompt - Weekly Discovery Analysis
 * 
 * This is for weekend analysis: "Should I buy this stock next week?"
 * NOT for position management (that's a separate file)
 */
export async function buildWeeklyDiscoveryPrompt({
  stock_name,
  stock_symbol,
  current_price,
  marketPayload,
  sectorInfo,
  s1,
  generatedAtIst,
  // ChartInk screening context
  scan_type,
  // Framework scoring (from scoring.js)
  setup_score,
  grade,
  score_breakdown,
  // Trading levels (from scanLevels.js)
  trading_levels,
  // Market regime
  regimeCheck = null
}) {
  
  const system = `You are a swing trading analysis engine for Indian equities.
Return STRICT, VALID JSON matching the schema exactly.
No markdown. No extra text.
Use only provided data - never hallucinate values.`;

  const user = `
=== WEEKLY DISCOVERY ANALYSIS ===
Purpose: Help user decide "Should I BUY this stock next week?"

=== STOCK CONTEXT ===
Stock: ${stock_name} (${stock_symbol})
Current Price: ₹${current_price}
Scan Type: ${scan_type}
Analysis Date: ${generatedAtIst}

=== SETUP SCORE: ${setup_score}/100 | GRADE: ${grade} ===

FACTOR-BY-FACTOR BREAKDOWN:
${score_breakdown ? score_breakdown.map(f => {
  const pct = Math.round((f.points / f.max) * 100);
  const status = pct >= 70 ? '✅' : pct >= 40 ? '⚠️' : '❌';
  const plainEnglish = getFactorPlainEnglish(f.factor, f.points, f.max, f.value);
  return `${status} ${f.factor}: ${f.points}/${f.max} pts
   Value: ${f.value || 'N/A'}
   → ${plainEnglish}`;
}).join('\n\n') : 'No breakdown available'}

STRENGTHS: ${score_breakdown ? score_breakdown.filter(f => f.points >= f.max * 0.7).map(f => f.factor).join(', ') || 'None' : 'N/A'}
WATCH: ${score_breakdown ? score_breakdown.filter(f => f.points < f.max * 0.4).map(f => f.factor).join(', ') || 'None' : 'N/A'}

=== TRADING LEVELS (Pre-Calculated) ===
${trading_levels ? `
Entry: ₹${trading_levels.entry}
Entry Range: ₹${trading_levels.entryRange?.[0]} - ₹${trading_levels.entryRange?.[1]}
Stop Loss: ₹${trading_levels.stop}
Target: ₹${trading_levels.target}
Risk:Reward: 1:${trading_levels.riskReward}
Risk %: ${trading_levels.riskPercent}%
Reward %: ${trading_levels.rewardPercent}%
Mode: ${trading_levels.mode}
` : 'No levels calculated'}

⚠️ USE THESE LEVELS - they are pre-calculated based on ${scan_type} formula.

=== MARKET CONTEXT ===
Trend: ${s1?.market_summary?.trend || 'NEUTRAL'}
Volatility: ${s1?.market_summary?.volatility || 'MEDIUM'}
Volume: ${s1?.market_summary?.volume || 'UNKNOWN'}
Sector: ${sectorInfo?.name || 'Unknown'}
${regimeCheck ? `
Market Regime: ${regimeCheck.regime}
Nifty vs 50 EMA: ${regimeCheck.distancePct?.toFixed(2)}%
${regimeCheck.regime === 'BEARISH' ? '⚠️ BEARISH REGIME - Add warning to output' : ''}
` : ''}

=== MARKET DATA ===
${JSON.stringify(marketPayload, null, 2)}

=== OUTPUT SCHEMA ===

Return ONLY this JSON structure:

{
  "schema_version": "1.5",
  "symbol": "${stock_symbol}",
  "analysis_type": "swing",
  "generated_at_ist": "${generatedAtIst}",
  
  "verdict": {
    "action": "BUY" | "WAIT" | "SKIP",
    "confidence": <0.0 to 1.0>,
    "one_liner": "Single sentence: what to do and why"
  },
  
  "setup_score": {
    "total": ${setup_score},
    "grade": "${grade}",
    "factors": [
      {
        "name": "<factor name>",
        "score": "<points>/<max>",
        "status": "✅" | "⚠️" | "❌",
        "value": "<actual value>",
        "explanation": "Plain English explanation"
      }
    ],
    "strengths": ["factor names scoring >=70%"],
    "watch_factors": ["factor names scoring <40%"]
  },
  
  "trading_plan": {
    "entry": ${trading_levels?.entry || 'null'},
    "entry_range": [${trading_levels?.entryRange?.[0] || 'null'}, ${trading_levels?.entryRange?.[1] || 'null'}],
    "stop_loss": ${trading_levels?.stop || 'null'},
    "target": ${trading_levels?.target || 'null'},
    "risk_reward": ${trading_levels?.riskReward || 'null'},
    "risk_percent": ${trading_levels?.riskPercent || 'null'},
    "reward_percent": ${trading_levels?.rewardPercent || 'null'}
  },
  
  "beginner_guide": {
    "what_stock_is_doing": "Plain English: describe the setup",
    "why_this_is_interesting": "Plain English: why it scored well",
    "steps_to_trade": [
      "Step 1: Wait for price to reach ₹XXX",
      "Step 2: Place order with stop at ₹XXX",
      "Step 3: Target is ₹XXX"
    ],
    "if_it_fails": {
      "max_loss": "₹XXX per 100 shares",
      "loss_percent": "X.X%",
      "why_okay": "This is normal - part of trading"
    }
  },
  
  "warnings": [
    {
      "code": "GAP_RISK" | "HIGH_RSI" | "LOW_VOLUME" | "BEARISH_REGIME",
      "severity": "low" | "medium" | "high",
      "message": "Short factual warning",
      "mitigation": "What to do about it"
    }
  ],
  
  "what_to_watch": {
    "if_bought": "What to monitor if you enter the trade",
    "if_waiting": "What would make this setup better/worse"
  },
  
  "disclaimer": "Educational analysis only. Not investment advice."
}

=== RULES ===
1. Use the PRE-CALCULATED trading_levels - don't recalculate
2. Copy the score_breakdown into setup_score.factors
3. verdict.action should be:
   - "BUY" if score >= 70 and setup is valid
   - "WAIT" if score >= 60 but needs pullback or confirmation
   - "SKIP" if score < 60 or setup is invalid
4. Add BEARISH_REGIME warning if regimeCheck.regime === "BEARISH"
5. beginner_guide must use actual ₹ values from trading_levels

=== OUTPUT ===
Return ONLY the JSON object. No markdown, no explanation.
`;

  return { system, user };
}

// ============================================================================
// EXPORTS
// ============================================================================

// Keep buildStage3Prompt as alias for backward compatibility
export const buildStage3Prompt = buildWeeklyDiscoveryPrompt;

export default {
  buildStage1,
  buildWeeklyDiscoveryPrompt,
  buildStage3Prompt,
  getFactorPlainEnglish
};