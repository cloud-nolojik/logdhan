/**
 * Daily Track Prompts
 *
 * Prompts for Phase 2 of daily tracking - AI analysis for stocks with status changes.
 * These prompts carry forward full weekend context AND simulation state.
 *
 * IMPORTANT: Phase 2 should NOT run for terminal states (FULL_EXIT, STOPPED_OUT, EXPIRED).
 * The simulation is the source of truth — Claude should never suggest actions that already happened.
 */

/**
 * Format news context for inclusion in the prompt
 * @param {Object|null} newsData - News data from DailyNewsStock
 * @returns {string|null} Formatted news context or null
 */
function formatNewsContext(newsData) {
  if (!newsData || !newsData.news_items || newsData.news_items.length === 0) {
    return null;
  }

  const headlines = newsData.news_items.map(item => {
    const sentiment = item.sentiment ? `[${item.sentiment}]` : '';
    const impact = item.impact ? `[${item.impact}]` : '';
    return `  • ${item.headline} ${sentiment} ${impact}`.trim();
  }).join('\n');

  return `
TODAY'S NEWS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Aggregate Sentiment: ${newsData.aggregate_sentiment || 'N/A'}
Impact: ${newsData.aggregate_impact || 'N/A'}

Headlines:
${headlines}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ Factor this news into your assessment. Positive earnings or deals may strengthen the setup; negative news may warrant caution.
`.trim();
}

/**
 * Build simulation context block based on current trade state
 * @param {Object} sim - trade_simulation object from WeeklyWatchlist stock
 * @returns {string} Formatted simulation context for the prompt
 */
function buildSimContextBlock(sim) {
  if (!sim || sim.status === 'WAITING') {
    return `Status: WAITING — entry has NOT triggered yet.
No position. Watching for entry confirmation.`;
  }

  const events = (sim.events || []).map(e => {
    const dateStr = new Date(e.date).toLocaleDateString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
    const pnlStr = e.pnl ? ` (${e.pnl >= 0 ? '+' : ''}₹${e.pnl.toLocaleString('en-IN')})` : '';
    return `  ${e.type}: ${dateStr} at ₹${e.price?.toFixed(2)}${pnlStr}`;
  }).join('\n');

  let statusLine = '';
  switch (sim.status) {
    case 'ENTERED':
      statusLine = `Status: ENTERED — position is LIVE
  Entry: ₹${sim.entry_price?.toFixed(2)} | ${sim.qty_total} shares | Stop: ₹${sim.trailing_stop?.toFixed(2)}
  Current P&L: ${sim.total_pnl >= 0 ? '+' : ''}₹${sim.total_pnl?.toLocaleString('en-IN')} (${sim.total_return_pct}%)
  Peak: ₹${sim.peak_price?.toFixed(2)} (+${sim.peak_gain_pct?.toFixed(1)}%)`;
      break;

    case 'PARTIAL_EXIT':
      statusLine = `Status: PARTIAL_EXIT — T1 hit, 50% booked, remaining position running
  Entry: ₹${sim.entry_price?.toFixed(2)} | Remaining: ${sim.qty_remaining} shares
  Stop: moved to entry ₹${sim.trailing_stop?.toFixed(2)} (RISK-FREE)
  Realized: +₹${sim.realized_pnl?.toLocaleString('en-IN')} | Unrealized: ${sim.unrealized_pnl >= 0 ? '+' : ''}₹${sim.unrealized_pnl?.toLocaleString('en-IN')}
  Total P&L: ${sim.total_pnl >= 0 ? '+' : ''}₹${sim.total_pnl?.toLocaleString('en-IN')} (${sim.total_return_pct}%)`;
      break;

    case 'FULL_EXIT':
      statusLine = `Status: FULL_EXIT — trade is COMPLETE, all shares exited
  Entry: ₹${sim.entry_price?.toFixed(2)} | All ${sim.qty_total} shares exited
  Total realized P&L: ${sim.total_pnl >= 0 ? '+' : ''}₹${sim.total_pnl?.toLocaleString('en-IN')} (${sim.total_return_pct}%)
  ⚠️ Trade is DONE. Do NOT recommend any trading actions.`;
      break;

    case 'STOPPED_OUT':
      statusLine = `Status: STOPPED_OUT — stop loss hit, position closed
  Entry: ₹${sim.entry_price?.toFixed(2)} → Stop: ₹${sim.trailing_stop?.toFixed(2)}
  Total P&L: ${sim.total_pnl >= 0 ? '+' : ''}₹${sim.total_pnl?.toLocaleString('en-IN')} (${sim.total_return_pct}%)
  ⚠️ Trade is DONE. Do NOT recommend any trading actions.`;
      break;

    case 'EXPIRED':
      statusLine = `Status: EXPIRED — entry never triggered within the entry window
  No position was taken. No P&L.`;
      break;

    default:
      statusLine = `Status: ${sim.status}`;
  }

  return `${statusLine}

Timeline:
${events}`;
}

/**
 * Determine current beginner guide step based on simulation state
 * @param {Object} sim - trade_simulation object
 * @returns {number} Current step number (1-6)
 */
function getCurrentStep(sim) {
  if (!sim || sim.status === 'WAITING') return 1;  // Waiting for entry
  if (sim.status === 'ENTERED') return 3;          // Entry confirmed, watching stop/T1
  if (sim.status === 'PARTIAL_EXIT') return 5;     // T1 hit, trailing to T2
  if (sim.status === 'FULL_EXIT') return 6;        // Complete
  if (sim.status === 'STOPPED_OUT') return 3;      // Stopped at stop loss step
  if (sim.status === 'EXPIRED') return 1;          // Never got past step 1
  return 1;
}

/**
 * Build the daily track prompt for Claude
 * @param {Object} params
 * @param {Object} params.stock - Stock from WeeklyWatchlist
 * @param {Object|null} params.weekendAnalysis - Original swing analysis from weekend
 * @param {Object} params.dailyData - Today's market data from getDailyAnalysisData
 * @param {string} params.triggerReason - Why Phase 2 was triggered
 * @param {Object} params.snapshot - Today's daily snapshot
 * @param {Object|null} params.recentNews - Today's news for this stock (if any)
 * @param {Object|null} params.tradeSimulation - Current trade simulation state
 * @returns {{ system: string, user: string }}
 */
function buildDailyTrackPrompt({
  stock,
  weekendAnalysis,
  dailyData,
  triggerReason,
  snapshot,
  recentNews,
  tradeSimulation
}) {
  const levels = stock.levels || {};

  // Format news context if available
  const newsContext = formatNewsContext(recentNews);

  // Extract weekend analysis details
  const weekendData = weekendAnalysis?.analysis_data || {};

  // Verdict details
  const weekendVerdictAction = weekendData.verdict?.action || 'N/A';
  const weekendConfidence = weekendData.verdict?.confidence
    ? `${(weekendData.verdict.confidence * 100).toFixed(0)}%`
    : null;
  const weekendOneLiner = weekendData.verdict?.one_liner || null;

  // Weekend grade (from analysis or stock)
  const weekendGrade = weekendData.setup_score?.grade
    || weekendData.grade
    || stock.grade
    || 'N/A';

  // Beginner guide steps (formatted as numbered list)
  const weekendBeginnerSteps = weekendData.beginner_guide?.steps
    ? weekendData.beginner_guide.steps.map((step, i) => `  Step ${i + 1}: ${step}`).join('\n')
    : null;

  // What to watch
  const weekendWhatToWatch = weekendData.what_to_watch || null;

  // Warnings/risk factors (formatted as list)
  const weekendWarnings = weekendData.risk_factors
    ? weekendData.risk_factors.map(w => `  [${w.severity || 'INFO'}] ${w.title || w}: ${w.description || ''}`).join('\n')
    : null;

  // Format volume ratio
  const volumeRatio = snapshot.volume_vs_avg
    ? `${snapshot.volume_vs_avg.toFixed(1)}x avg`
    : 'N/A';

  // IST timestamp
  const generatedAtIst = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  // Build simulation context block
  const simContextBlock = buildSimContextBlock(tradeSimulation);

  // Get current step for beginner guide
  const simCurrentStep = getCurrentStep(tradeSimulation);

  // Check if trade is in terminal state
  const simTerminal = ['FULL_EXIT', 'STOPPED_OUT', 'EXPIRED'].includes(tradeSimulation?.status);

  const system = `You are a swing trading position management assistant for the Indian stock market (NSE/BSE).

You are providing a DAILY UPDATE for a stock that was analyzed over the weekend. The user has already seen the weekend analysis with a beginner guide. Your job is to UPDATE that guidance based on what happened today. Your response must be CONSISTENT with the weekend plan.

WEEKEND ANALYSIS CONTEXT:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Symbol: ${stock.symbol} | Grade: ${weekendGrade} | Archetype: ${levels.archetype || 'standard'}

LEVELS (engine-calculated, final):
  Entry: ₹${levels.entry?.toFixed(2) || 'N/A'} (confirmation: ${levels.entryConfirmation === 'touch' ? 'limit order touch' : 'daily CLOSE above'})
  Stop: ₹${levels.stop?.toFixed(2) || 'N/A'}
  T1 (50% booking): ₹${levels.target1?.toFixed(2) || levels.target?.toFixed(2) || 'N/A'} [${levels.target1Basis || 'N/A'}]
  T2 (full exit): ₹${levels.target?.toFixed(2) || 'N/A'} [${levels.targetBasis || 'N/A'}]
  ${levels.target2 ? `T3 (trail): ₹${levels.target2.toFixed(2)}` : ''}
  R:R ${levels.riskReward ? `1:${levels.riskReward.toFixed(1)}` : 'N/A'}
  Entry window: ${levels.entryWindowDays || 3} trading days
  Week-end rule: ${levels.weekEndRule || 'exit_if_no_t1'}

Weekend Verdict: ${weekendVerdictAction} (${weekendConfidence || 'N/A'} confidence)
One-liner: ${weekendOneLiner || 'N/A'}

${weekendBeginnerSteps ? `BEGINNER GUIDE STEPS (what the user was told):
${weekendBeginnerSteps}` : ''}

${weekendWhatToWatch ? `WHAT TO WATCH (from weekend):
  IF HOLDING: ${weekendWhatToWatch.if_holding || 'N/A'}
  IF WATCHING: ${weekendWhatToWatch.if_watching || 'N/A'}` : ''}

${weekendWarnings ? `WARNINGS (from weekend):
${weekendWarnings}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TRADE SIMULATION STATE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${simContextBlock}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TODAY'S DATA (${generatedAtIst}):
  Open: ₹${dailyData.open?.toFixed(2) || 'N/A'} | High: ₹${dailyData.high?.toFixed(2) || 'N/A'} | Low: ₹${dailyData.low?.toFixed(2) || 'N/A'} | Close: ₹${dailyData.ltp?.toFixed(2) || 'N/A'}
  RSI: ${dailyData.daily_rsi?.toFixed(1) || 'N/A'} | Volume: ${volumeRatio}
  Nifty: ${snapshot.nifty_change_pct !== null ? `${snapshot.nifty_change_pct > 0 ? '+' : ''}${snapshot.nifty_change_pct.toFixed(2)}%` : 'N/A'}

DISTANCES:
  From Entry: ${snapshot.distance_from_entry_pct > 0 ? '+' : ''}${snapshot.distance_from_entry_pct?.toFixed(2) || 'N/A'}%
  From Stop: +${snapshot.distance_from_stop_pct?.toFixed(2) || 'N/A'}%
  From T1: ${snapshot.distance_from_target_pct?.toFixed(2) || 'N/A'}%

STATUS: ${snapshot.tracking_status} | FLAGS: ${snapshot.tracking_flags?.length > 0 ? snapshot.tracking_flags.join(', ') : 'None'}
TRIGGER: ${triggerReason}

${newsContext || ''}
RULES:
1. Your guidance must be CONSISTENT with the weekend analysis and beginner guide steps.
2. Reference beginner guide steps by number when relevant ("Step 4 is now complete").
3. Account for the simulation state — DO NOT recommend actions that already happened.
   - If T1 already hit, don't say "book partial profits"
   - If trade is FULL_EXIT, say the trade is complete
   - If WAITING, focus on whether entry conditions are met
4. If intraday range (high-low)/open exceeds 10%, action must be WAIT for watchers.
5. If gap down exceeds 5%, set confidence ≤ 0.5.
6. Keep response under 300 words.
7. Return ONLY valid JSON.`;

  const user = `Analyze today's action for ${stock.symbol} and respond with this exact JSON structure:

{
  "date": "${new Date().toISOString().split('T')[0]}",
  "symbol": "${stock.symbol}",
  "trigger": "${triggerReason}",

  "headline": "One sentence summary for the card banner (e.g. 'Full target hit — trade complete' or 'Entry confirmed, running toward T1')",

  "status_assessment": "2-3 sentences: what happened today, how it relates to the weekend plan, and what it means",

  "current_step": ${simCurrentStep},
  "step_update": "Which beginner guide steps are done, in progress, or upcoming (e.g. 'Steps 1-4 complete. Step 5 in progress — trailing to T2.')",

  "if_holding": {
    "action": "${simTerminal ? 'TRADE_COMPLETE' : 'HOLD | TRAIL_STOP | BOOK_PARTIAL | EXIT'}",
    "reason": "1-2 sentences. Must account for simulation state.",
    "adjusted_stop": null,
    "notes": "Additional context"
  },

  "if_watching": {
    "action": "${simTerminal ? 'MISSED' : 'ENTER_NOW | WAIT | SKIP'}",
    "reason": "1-2 sentences",
    "ideal_entry": null,
    "notes": "Additional context"
  },

  "risk_note": null,
  "confidence": 0.0,
  "next_check": "What to watch for tomorrow (one sentence)"
}

IMPORTANT:
- headline is shown as the TOP BANNER on the stock page. Make it count.
- current_step is a number matching the beginner guide step the user should focus on NOW.
  If trade is complete, use the last step number.
- if simulation status is FULL_EXIT or STOPPED_OUT:
  - if_holding.action MUST be "TRADE_COMPLETE"
  - if_watching.action MUST be "MISSED" (setup already played out)
  - Do NOT suggest new entries or exits
- if simulation status is WAITING:
  - if_holding section is N/A (no position yet)
  - Focus on if_watching: is entry likely to trigger?
- Keep total response under 400 tokens.

Respond with ONLY the JSON.`;

  return { system, user };
}

export { buildDailyTrackPrompt, buildSimContextBlock, getCurrentStep };

export default {
  buildDailyTrackPrompt,
  buildSimContextBlock,
  getCurrentStep
};
