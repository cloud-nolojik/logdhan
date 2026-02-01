/**
 * Daily Track Prompts
 *
 * Prompts for Phase 2 of daily tracking - AI analysis for stocks with status changes.
 * These are focused, short prompts that carry forward weekend context.
 */

/**
 * Build the daily track prompt for Claude
 * @param {Object} params
 * @param {Object} params.stock - Stock from WeeklyWatchlist
 * @param {Object|null} params.weekendAnalysis - Original swing analysis from weekend
 * @param {Object} params.dailyData - Today's market data from getDailyAnalysisData
 * @param {string} params.triggerReason - Why Phase 2 was triggered
 * @param {Object} params.snapshot - Today's daily snapshot
 * @returns {{ system: string, user: string }}
 */
function buildDailyTrackPrompt({ stock, weekendAnalysis, dailyData, triggerReason, snapshot }) {
  const levels = stock.levels || {};
  const screeningData = stock.screening_data || {};

  // Extract weekend verdict if available
  const weekendVerdict = weekendAnalysis?.analysis_data?.verdict
    || weekendAnalysis?.analysis_data?.trading_plan?.verdict
    || 'N/A';

  const weekendGrade = weekendAnalysis?.analysis_data?.setup_score?.grade
    || stock.grade
    || 'N/A';

  // Format volume ratio
  const volumeRatio = snapshot.volume_vs_avg
    ? `${snapshot.volume_vs_avg.toFixed(1)}x avg`
    : 'N/A';

  // IST timestamp
  const generatedAtIst = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const system = `You are a swing trading position management assistant for the Indian stock market (NSE/BSE).

CONTEXT: This stock was identified in the weekend screening. You're providing a FOCUSED daily update based on today's price action. Keep your response concise and actionable.

WEEKEND ANALYSIS CONTEXT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Symbol: ${stock.symbol}
Name: ${stock.stock_name || stock.symbol}
Grade: ${weekendGrade}
Archetype: ${levels.archetype || 'standard'}
Mode: ${levels.mode || 'N/A'}
Target Basis: ${levels.targetBasis || 'N/A'}

LEVELS (from weekend screening):
• Entry: ₹${levels.entry?.toFixed(2) || 'N/A'}${levels.entryRange ? ` (range: ₹${levels.entryRange[0]?.toFixed(2)} - ₹${levels.entryRange[1]?.toFixed(2)})` : ''}
• Stop: ₹${levels.stop?.toFixed(2) || 'N/A'}
• Target 1: ₹${levels.target?.toFixed(2) || 'N/A'}
${levels.target2 ? `• Target 2: ₹${levels.target2.toFixed(2)}` : ''}
• Risk:Reward: ${levels.riskReward ? `1:${levels.riskReward.toFixed(1)}` : 'N/A'}

Weekend Verdict: ${weekendVerdict}
${levels.archetype === '52w_breakout' ? '\n⚠️ 52W BREAKOUT STOCK: The old 52W high is now support for retest entries. A pullback to this level is healthy if it holds.' : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TODAY'S DATA (${generatedAtIst}):
• Open: ₹${dailyData.open?.toFixed(2) || 'N/A'}
• High: ₹${dailyData.high?.toFixed(2) || 'N/A'}
• Low: ₹${dailyData.low?.toFixed(2) || 'N/A'}
• Close/LTP: ₹${dailyData.ltp?.toFixed(2) || 'N/A'}
• Daily RSI: ${dailyData.daily_rsi?.toFixed(1) || 'N/A'}
• Volume: ${dailyData.todays_volume?.toLocaleString('en-IN') || 'N/A'} (${volumeRatio})
• Nifty Change: ${snapshot.nifty_change_pct !== null ? `${snapshot.nifty_change_pct > 0 ? '+' : ''}${snapshot.nifty_change_pct.toFixed(2)}%` : 'N/A'}

DISTANCE FROM LEVELS:
• From Entry: ${snapshot.distance_from_entry_pct > 0 ? '+' : ''}${snapshot.distance_from_entry_pct?.toFixed(2) || 'N/A'}%
• From Stop: +${snapshot.distance_from_stop_pct?.toFixed(2) || 'N/A'}% (above stop)
• From Target: ${snapshot.distance_from_target_pct?.toFixed(2) || 'N/A'}%

CURRENT STATUS: ${snapshot.tracking_status}
FLAGS: ${snapshot.tracking_flags?.length > 0 ? snapshot.tracking_flags.join(', ') : 'None'}

TRIGGER REASON: ${triggerReason}

INSTRUCTIONS:
1. Assess today's price action in context of the weekend setup
2. Provide specific guidance for BOTH holders AND watchers
3. If stop needs adjustment, provide exact new stop price
4. Keep response under 400 words
5. Return ONLY valid JSON (no markdown, no explanation outside JSON)`;

  const user = `Analyze today's action for ${stock.symbol} and respond with this exact JSON structure:

{
  "date": "${new Date().toISOString().split('T')[0]}",
  "symbol": "${stock.symbol}",
  "trigger": "${triggerReason}",

  "status_assessment": "One sentence: what happened today and why it matters for this setup",

  "if_holding": {
    "action": "HOLD | TRAIL_STOP | BOOK_PARTIAL | EXIT",
    "reason": "Brief explanation (1-2 sentences)",
    "adjusted_stop": null,
    "notes": "Any additional context or warning"
  },

  "if_watching": {
    "action": "ENTER_NOW | WAIT | SKIP",
    "reason": "Brief explanation (1-2 sentences)",
    "ideal_entry": null,
    "notes": "Any additional context or conditions"
  },

  "risk_alert": null,
  "confidence": 0.0,
  "next_check": "What to watch for tomorrow (one sentence)"
}

FIELD GUIDELINES:
- if_holding.action: HOLD (stay in), TRAIL_STOP (move stop higher), BOOK_PARTIAL (take partial profits), EXIT (close position)
- if_holding.adjusted_stop: Only provide if action is TRAIL_STOP, use exact price like 1234.50
- if_watching.action: ENTER_NOW (buy today/tomorrow open), WAIT (setup intact but not optimal), SKIP (setup invalidated)
- if_watching.ideal_entry: Only provide if action is WAIT, use exact price
- risk_alert: Only if there's a genuine risk (RSI overextension, stop close, volume concerns)
- confidence: 0.0-1.0 based on how clear the setup is today

Respond with ONLY the JSON, no other text.`;

  return { system, user };
}

export { buildDailyTrackPrompt };

export default {
  buildDailyTrackPrompt
};
