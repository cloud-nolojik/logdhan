/**
 * Intraday Analysis Prompts
 *
 * Prompts for AI to explain pre-market intraday trade plans.
 * AI explains the trade AFTER levels are code-calculated.
 */

import { round2 } from "../engine/helpers.js";

/**
 * Build prompt for AI to explain the intraday trade
 * @param {Object} params
 * @param {string} params.symbol - Stock symbol
 * @param {string} params.companyName - Company name
 * @param {Array<{ text: string, sentiment: string, impact: string }>} params.headlines - News headlines
 * @param {string} params.aggregateSentiment - 'BULLISH' | 'BEARISH' | 'NEUTRAL'
 * @param {string} params.aggregateImpact - 'HIGH' | 'MEDIUM' | 'LOW'
 * @param {Object} params.levels - Calculated levels from intradayEngine
 * @param {Object} params.prevDayCandle - Previous day OHLC
 * @returns {string} Prompt for AI
 */
export function buildIntradayExplanationPrompt({
  symbol,
  companyName,
  headlines,
  aggregateSentiment,
  aggregateImpact,
  levels,
  prevDayCandle
}) {
  const headlinesText = headlines
    .map((h, i) => `${i + 1}. "${h.text}" [${h.sentiment}, ${h.impact}]`)
    .join('\n');

  const direction = levels.direction;
  const prevClose = levels.base_price;

  let levelsText = '';

  if (direction === 'BUY') {
    levelsText = `
Direction: BUY
Entry Zone: ₹${levels.entry_zone.low} - ₹${levels.entry_zone.high}
Stop Loss: ₹${levels.stop_loss} (1× ATR below entry)
Target 1: ₹${levels.target_1} (1.2× ATR)
Target 2: ₹${levels.target_2} (2× ATR)
Risk:Reward = ${levels.risk_reward}`;
  } else if (direction === 'SELL') {
    levelsText = `
Direction: SELL
Entry Zone: ₹${levels.entry_zone.low} - ₹${levels.entry_zone.high}
Stop Loss: ₹${levels.stop_loss} (1× ATR above entry)
Target 1: ₹${levels.target_1} (1.2× ATR below)
Target 2: ₹${levels.target_2} (2× ATR below)
Risk:Reward = ${levels.risk_reward}`;
  } else if (direction === 'AVOID') {
    levelsText = `
Direction: AVOID TRADE
Reason: ${levels.reason}
Gap: ${levels.gap_pct}% (${levels.gap_vs_atr}× adjusted ATR)`;
  } else {
    levelsText = `
Direction: NO TRADE (Neutral sentiment)
Previous Close: ₹${prevClose}
Observation Zone: ₹${levels.entry_zone?.low} - ₹${levels.entry_zone?.high}`;
  }

  return `
You are explaining a pre-market intraday trade plan for Indian stock traders.

Stock: ${symbol} (${companyName || 'N/A'})

Today's News Headlines:
${headlinesText}

Overall Sentiment: ${aggregateSentiment} (${aggregateImpact} impact)

Previous Day Data:
- Close: ₹${prevClose}
- High: ₹${prevDayCandle.high}
- Low: ₹${prevDayCandle.low}
- ATR(14): ₹${levels.atr} → Adjusted ATR: ₹${levels.adjusted_atr} (${aggregateImpact} news multiplier: ${levels.atr_multiplier}×)

Calculated Levels:
${levelsText}

${levels.pivots ? `
Pivot Points (reference only):
- Pivot: ₹${levels.pivots.P}
- R1: ₹${levels.pivots.R1}, R2: ₹${levels.pivots.R2}
- S1: ₹${levels.pivots.S1}, S2: ₹${levels.pivots.S2}
` : ''}

Instructions:
1. Explain in 3-4 sentences why this news is ${aggregateSentiment.toLowerCase()} for the stock
2. Explain why the calculated levels make sense for intraday trading
3. If any pivot levels align with targets/stops, mention the confluence
4. Keep language simple and actionable for retail traders

Important:
- Do NOT suggest different price levels
- Focus on explaining the rationale
- Mention any key risks or caveats
- Use ₹ for Indian Rupee prices

Provide your explanation:
`.trim();
}

/**
 * Build response structure for intraday analysis
 * @param {Object} params
 * @param {string} params.symbol
 * @param {string} params.instrumentKey
 * @param {Array} params.headlines
 * @param {string} params.sentiment
 * @param {string} params.impact
 * @param {number} params.confidenceScore
 * @param {Object} params.levels - From intradayEngine
 * @param {Object} params.prevDayCandle
 * @param {string} params.aiReasoning - AI-generated explanation
 * @param {Date} params.validUntil
 * @returns {Object} Formatted analysis result
 */
export function buildIntradayAnalysisResult({
  symbol,
  instrumentKey,
  companyName,
  headlines,
  sentiment,
  impact,
  confidenceScore,
  levels,
  prevDayCandle,
  aiReasoning,
  validUntil
}) {
  return {
    schema_version: '1.0-intraday',
    analysis_type: 'intraday',
    symbol,
    instrument_key: instrumentKey,
    company_name: companyName,

    // News context
    news_headlines: headlines.map(h => ({
      text: h.text,
      category: h.category,
      sentiment: h.sentiment,
      impact: h.impact
    })),
    aggregate_sentiment: sentiment,
    aggregate_impact: impact,
    confidence_score: confidenceScore,

    // Pre-market data
    prev_day: {
      open: prevDayCandle.open,
      high: prevDayCandle.high,
      low: prevDayCandle.low,
      close: prevDayCandle.close
    },

    // ATR calculations
    atr_14: levels.atr,
    adjusted_atr: levels.adjusted_atr,
    atr_multiplier: levels.atr_multiplier,

    // Trade recommendation
    direction: levels.direction,
    entry: levels.entry,
    entry_zone: levels.entry_zone,
    stop_loss: levels.stop_loss,
    target_1: levels.target_1,
    target_2: levels.target_2,
    risk_reward: levels.risk_reward,

    // Avoid trade info (if applicable)
    avoid_reason: levels.direction === 'AVOID' ? levels.reason : null,
    gap_info: levels.direction === 'AVOID' ? {
      gap_amount: levels.gap_amount,
      gap_pct: levels.gap_pct,
      gap_vs_atr: levels.gap_vs_atr
    } : null,

    // Pivot reference
    pivots: levels.pivots,

    // AI explanation
    reasoning: aiReasoning,

    // Validity
    valid_until: validUntil,
    generated_at: new Date()
  };
}

/**
 * Format headlines for display
 * @param {Array} headlines
 * @returns {string}
 */
export function formatHeadlinesForDisplay(headlines) {
  if (!headlines || headlines.length === 0) return 'No headlines available';

  return headlines
    .map(h => {
      const badge = h.sentiment === 'BULLISH' ? '📈' :
                    h.sentiment === 'BEARISH' ? '📉' : '➖';
      return `${badge} ${h.text}`;
    })
    .join('\n');
}

/**
 * Format levels for display
 * @param {Object} levels
 * @returns {string}
 */
export function formatLevelsForDisplay(levels) {
  if (levels.direction === 'AVOID') {
    return `⚠️ AVOID TRADE\n${levels.reason}\nGap: ${levels.gap_pct}%`;
  }

  if (levels.direction === 'NEUTRAL') {
    return `➖ NO TRADE\n${levels.message || 'Sentiment unclear'}`;
  }

  const arrow = levels.direction === 'BUY' ? '📈 BUY' : '📉 SELL';

  return `${arrow}
Entry Zone: ₹${levels.entry_zone.low} - ₹${levels.entry_zone.high}
Stop Loss: ₹${levels.stop_loss}
Target 1: ₹${levels.target_1}
Target 2: ₹${levels.target_2}
R:R = ${levels.risk_reward}`;
}

export default {
  buildIntradayExplanationPrompt,
  buildIntradayAnalysisResult,
  formatHeadlinesForDisplay,
  formatLevelsForDisplay
};
