/**
 * Framework Context Builder
 * 
 * Builds rich context for AI analysis explaining WHY a stock was selected
 * over other candidates - similar to the BANKINDIA vs PNB vs SBIN analysis
 * 
 * This context allows the AI to explain the selection in plain English
 */

/**
 * Build comparative analysis context for AI
 * 
 * @param {Object} selectedStock - The stock that was selected
 * @param {Array} allCandidates - All stocks that were considered (including eliminated)
 * @param {Object} options - Additional context options
 * @returns {Object} Rich context for AI prompt
 */
export function buildFrameworkContext(selectedStock, allCandidates = [], options = {}) {
  const context = {
    selected: null,
    eliminated: [],
    runners_up: [],
    comparison_summary: null,
    selection_reasons: [],
    framework_explanation: null
  };

  if (!selectedStock) {
    return context;
  }

  // Build selected stock context
  context.selected = {
    symbol: selectedStock.symbol,
    score: selectedStock.setup_score,
    grade: selectedStock.grade,
    price: selectedStock.current_price,
    rsi: selectedStock.indicators?.rsi,
    volume_ratio: selectedStock.indicators?.volume_vs_avg,
    risk_reward: selectedStock.levels?.riskReward,
    weekly_change: selectedStock.indicators?.weekly_change_pct,
    upside_pct: selectedStock.levels?.rewardPercent,
    score_breakdown: selectedStock.score_breakdown
  };

  // Process all candidates
  const validCandidates = allCandidates.filter(c => c && c.symbol);
  
  // Separate eliminated vs qualified
  const eliminated = validCandidates.filter(c => c.eliminated);
  const qualified = validCandidates.filter(c => !c.eliminated && c.symbol !== selectedStock.symbol);

  // Build eliminated stocks context (like PNB/SBIN in our analysis)
  context.eliminated = eliminated.map(stock => ({
    symbol: stock.symbol,
    reason: stock.eliminationReason || 'Unknown',
    rsi: stock.indicators?.rsi,
    volume_ratio: stock.indicators?.volume_vs_avg,
    // What was good about it (so AI can explain the tradeoff)
    strengths: getStockStrengths(stock),
    // Why it was eliminated
    fatal_flaw: stock.eliminationReason
  }));

  // Build runners-up context (stocks that qualified but ranked lower)
  context.runners_up = qualified
    .sort((a, b) => (b.setup_score || 0) - (a.setup_score || 0))
    .slice(0, 3)
    .map(stock => ({
      symbol: stock.symbol,
      score: stock.setup_score,
      grade: stock.grade,
      rsi: stock.indicators?.rsi,
      volume_ratio: stock.indicators?.volume_vs_avg,
      risk_reward: stock.levels?.riskReward,
      // Why it ranked lower
      gap_vs_selected: (selectedStock.setup_score || 0) - (stock.setup_score || 0),
      weaker_factors: getWeakerFactors(stock, selectedStock)
    }));

  // Build comparison summary (like the table I showed you)
  context.comparison_summary = buildComparisonTable(selectedStock, eliminated, qualified);

  // Build selection reasons (plain English)
  context.selection_reasons = buildSelectionReasons(selectedStock, eliminated, qualified);

  // Build full framework explanation
  context.framework_explanation = buildFrameworkExplanation(selectedStock, context);

  return context;
}

/**
 * Identify what was strong about a stock (even if eliminated)
 */
function getStockStrengths(stock) {
  const strengths = [];
  
  if (stock.indicators?.volume_vs_avg >= 2.0) {
    strengths.push(`High volume (${stock.indicators.volume_vs_avg.toFixed(1)}x) - strong conviction`);
  }
  if (stock.indicators?.weekly_change_pct >= 5) {
    strengths.push(`Strong weekly move (+${stock.indicators.weekly_change_pct.toFixed(1)}%)`);
  }
  if (stock.levels?.riskReward >= 2.5) {
    strengths.push(`Good R:R (1:${stock.levels.riskReward.toFixed(1)})`);
  }
  
  return strengths;
}

/**
 * Identify why a stock ranked lower than the selected one
 */
function getWeakerFactors(stock, selectedStock) {
  const weakerFactors = [];
  
  const stockRSI = stock.indicators?.rsi || 0;
  const selectedRSI = selectedStock.indicators?.rsi || 0;
  
  if (stockRSI > selectedRSI && stockRSI > 65) {
    weakerFactors.push(`RSI higher (${stockRSI.toFixed(0)} vs ${selectedRSI.toFixed(0)}) - more extended`);
  }
  
  const stockRR = stock.levels?.riskReward || 0;
  const selectedRR = selectedStock.levels?.riskReward || 0;
  
  if (stockRR < selectedRR) {
    weakerFactors.push(`Lower R:R (1:${stockRR.toFixed(1)} vs 1:${selectedRR.toFixed(1)})`);
  }
  
  const stockVolume = stock.indicators?.volume_vs_avg || 0;
  const selectedVolume = selectedStock.indicators?.volume_vs_avg || 0;
  
  if (stockVolume < selectedVolume * 0.7) {
    weakerFactors.push(`Lower volume conviction (${stockVolume.toFixed(1)}x vs ${selectedVolume.toFixed(1)}x)`);
  }
  
  return weakerFactors;
}

/**
 * Build comparison table like:
 * | Stock | RSI | Volume | R:R | Verdict |
 */
function buildComparisonTable(selected, eliminated, qualified) {
  const rows = [];
  
  // Selected stock (winner)
  rows.push({
    symbol: selected.symbol,
    rsi: selected.indicators?.rsi,
    rsi_status: getRSIStatus(selected.indicators?.rsi),
    volume: selected.indicators?.volume_vs_avg,
    risk_reward: selected.levels?.riskReward,
    score: selected.setup_score,
    grade: selected.grade,
    verdict: '🏆 SELECTED - Best entry NOW',
    rank: 1
  });
  
  // Runners-up
  qualified.slice(0, 2).forEach((stock, idx) => {
    rows.push({
      symbol: stock.symbol,
      rsi: stock.indicators?.rsi,
      rsi_status: getRSIStatus(stock.indicators?.rsi),
      volume: stock.indicators?.volume_vs_avg,
      risk_reward: stock.levels?.riskReward,
      score: stock.setup_score,
      grade: stock.grade,
      verdict: `#${idx + 2} - ${getShortVerdict(stock, selected)}`,
      rank: idx + 2
    });
  });
  
  // Eliminated stocks
  eliminated.slice(0, 2).forEach(stock => {
    rows.push({
      symbol: stock.symbol,
      rsi: stock.indicators?.rsi,
      rsi_status: getRSIStatus(stock.indicators?.rsi),
      volume: stock.indicators?.volume_vs_avg,
      risk_reward: stock.levels?.riskReward,
      score: 0,
      grade: 'X',
      verdict: `❌ ELIMINATED - ${stock.eliminationReason || 'Did not qualify'}`,
      rank: null
    });
  });
  
  return rows;
}

function getRSIStatus(rsi) {
  if (!rsi) return 'Unknown';
  if (rsi > 72) return '🔴 Overbought';
  if (rsi > 65) return '⚠️ Extended';
  if (rsi >= 55) return '✅ Sweet spot';
  if (rsi >= 45) return '⚠️ Neutral';
  return '🔵 Oversold';
}

function getShortVerdict(stock, selected) {
  const rsiDiff = (stock.indicators?.rsi || 0) - (selected.indicators?.rsi || 0);
  if (rsiDiff > 5) return 'RSI higher - wait for pullback';
  
  const rrDiff = (selected.levels?.riskReward || 0) - (stock.levels?.riskReward || 0);
  if (rrDiff > 0.5) return 'Lower R:R';
  
  return 'Good but not best entry NOW';
}

/**
 * Build plain English selection reasons
 */
function buildSelectionReasons(selected, eliminated, qualified) {
  const reasons = [];
  
  // RSI advantage
  const selectedRSI = selected.indicators?.rsi;
  if (selectedRSI && selectedRSI >= 55 && selectedRSI <= 65) {
    reasons.push({
      factor: 'RSI Position',
      explanation: `RSI at ${selectedRSI.toFixed(0)} is in the sweet spot (55-65) - showing momentum without being overbought`,
      comparison: eliminated.length > 0 
        ? `Unlike ${eliminated.map(e => `${e.symbol} (RSI ${e.indicators?.rsi?.toFixed(0) || '?'})`).join(', ')} which are too extended`
        : null
    });
  }
  
  // Volume advantage
  const selectedVolume = selected.indicators?.volume_vs_avg;
  if (selectedVolume && selectedVolume >= 1.5) {
    reasons.push({
      factor: 'Volume Conviction',
      explanation: `Volume at ${selectedVolume.toFixed(1)}x average shows institutional buying, not just retail noise`,
      comparison: null
    });
  }
  
  // R:R advantage
  const selectedRR = selected.levels?.riskReward;
  if (selectedRR && selectedRR >= 2.0) {
    reasons.push({
      factor: 'Risk:Reward',
      explanation: `R:R of 1:${selectedRR.toFixed(1)} means you're risking ₹1 to potentially make ₹${selectedRR.toFixed(1)}`,
      comparison: null
    });
  }
  
  // Best entry NOW (the tiebreaker)
  reasons.push({
    factor: 'Entry Timing',
    explanation: `This stock offers the best entry RIGHT NOW - not already extended, not waiting for pullback`,
    comparison: qualified.length > 0
      ? `${qualified[0]?.symbol || 'Others'} may be good stocks but need pullback or are higher risk entry`
      : null
  });
  
  return reasons;
}

/**
 * Build complete framework explanation for AI
 */
function buildFrameworkExplanation(selected, context) {
  const breakdown = selected.score_breakdown || [];
  
  return {
    headline: `${selected.symbol} selected with score ${selected.setup_score}/100 (Grade ${selected.grade})`,
    
    factor_breakdown: breakdown.map(f => ({
      factor: f.factor,
      points: `${f.points}/${f.max}`,
      percentage: Math.round((f.points / f.max) * 100),
      status: f.points >= (f.max * 0.7) ? 'STRONG' : f.points >= (f.max * 0.4) ? 'ADEQUATE' : 'WEAK',
      value: f.value,
      plain_english: getFactorExplanation(f)
    })),
    
    vs_eliminated: context.eliminated.map(e => ({
      symbol: e.symbol,
      why_not: e.fatal_flaw,
      what_was_good: e.strengths.join('; ') || 'Some positive factors but disqualified',
      lesson: `Even with ${e.strengths[0] || 'some strengths'}, ${e.fatal_flaw} makes it too risky to enter NOW`
    })),
    
    vs_runners_up: context.runners_up.map(r => ({
      symbol: r.symbol,
      score_gap: r.gap_vs_selected,
      why_lower: r.weaker_factors.join('; ') || 'Slightly weaker overall profile'
    })),
    
    bottom_line: `${selected.symbol} wins because it has the best combination of factors for entry RIGHT NOW - ${getBottomLineReason(selected, context)}`
  };
}

function getFactorExplanation(factor) {
  const pct = Math.round((factor.points / factor.max) * 100);
  
  switch (factor.factor) {
    case 'Volume Conviction':
      if (pct >= 70) return `Strong institutional buying (${factor.value}) - smart money is in`;
      if (pct >= 40) return `Decent volume (${factor.value}) - some conviction`;
      return `Low volume (${factor.value}) - lacks conviction`;
      
    case 'Risk:Reward':
      if (pct >= 70) return `Excellent R:R (${factor.value}) - risking little to gain a lot`;
      if (pct >= 40) return `Acceptable R:R (${factor.value}) - worth the risk`;
      return `Poor R:R (${factor.value}) - too much risk for potential gain`;
      
    case 'RSI Position':
      if (pct >= 70) return `RSI ${factor.value} is perfect - momentum without exhaustion`;
      if (pct >= 40) return `RSI ${factor.value} is acceptable but not ideal`;
      return `RSI ${factor.value} is concerning - either extended or weak`;
      
    case 'Weekly Move':
      if (pct >= 70) return `+${factor.value} weekly confirms strong momentum`;
      if (pct >= 40) return `+${factor.value} weekly shows decent momentum`;
      return `${factor.value} weekly is weak momentum`;
      
    case 'Upside to Target':
      if (pct >= 70) return `${factor.value} upside makes this trade worth the effort`;
      if (pct >= 40) return `${factor.value} upside is acceptable`;
      return `${factor.value} upside is limited`;
      
    case 'Relative Strength':
      if (pct >= 70) return `Outperforming market (${factor.value}) - stock-specific strength`;
      if (pct >= 40) return `In line with market (${factor.value})`;
      return `Underperforming market (${factor.value})`;
      
    case 'Price Accessibility':
      return `At ${factor.value}, easy to size positions`;
      
    default:
      return factor.reason || 'N/A';
  }
}

function getBottomLineReason(selected, context) {
  const reasons = [];
  
  const rsi = selected.indicators?.rsi;
  if (rsi && rsi >= 55 && rsi <= 65) {
    reasons.push('RSI in sweet spot');
  }
  
  const rr = selected.levels?.riskReward;
  if (rr && rr >= 2.0) {
    reasons.push(`strong ${rr.toFixed(1)}:1 R:R`);
  }
  
  const volume = selected.indicators?.volume_vs_avg;
  if (volume && volume >= 1.5) {
    reasons.push('institutional volume');
  }
  
  if (context.eliminated.length > 0) {
    reasons.push(`not overbought like ${context.eliminated[0].symbol}`);
  }
  
  return reasons.join(', ') || 'best overall combination of factors';
}

/**
 * Format context for AI prompt insertion
 */
export function formatContextForPrompt(context) {
  if (!context || !context.selected) {
    return '';
  }
  
  let prompt = `
═══════════════════════════════════════════════════════════════════════════
WHY ${context.selected.symbol} WAS SELECTED (COMPARATIVE ANALYSIS)
═══════════════════════════════════════════════════════════════════════════

WINNER: ${context.selected.symbol}
Score: ${context.selected.score}/100 | Grade: ${context.selected.grade}
RSI: ${context.selected.rsi?.toFixed(1) || 'N/A'} | Volume: ${context.selected.volume_ratio?.toFixed(1) || 'N/A'}x | R:R: 1:${context.selected.risk_reward?.toFixed(1) || 'N/A'}

`;

  // Add comparison table
  if (context.comparison_summary?.length > 0) {
    prompt += `COMPARISON TABLE:
| Stock | RSI | Status | Volume | R:R | Score | Verdict |
|-------|-----|--------|--------|-----|-------|---------|
`;
    context.comparison_summary.forEach(row => {
      prompt += `| ${row.symbol} | ${row.rsi?.toFixed(0) || '?'} | ${row.rsi_status} | ${row.volume?.toFixed(1) || '?'}x | 1:${row.risk_reward?.toFixed(1) || '?'} | ${row.score || 0} | ${row.verdict} |
`;
    });
    prompt += '\n';
  }

  // Add eliminated stocks context
  if (context.eliminated?.length > 0) {
    prompt += `ELIMINATED STOCKS (Why They Were Rejected):
`;
    context.eliminated.forEach(e => {
      prompt += `❌ ${e.symbol}: ${e.reason}
   - RSI: ${e.rsi?.toFixed(0) || '?'} | Volume: ${e.volume_ratio?.toFixed(1) || '?'}x
   - What was good: ${e.strengths.join(', ') || 'Some positives but disqualified'}
   - Fatal flaw: ${e.fatal_flaw}
`;
    });
    prompt += '\n';
  }

  // Add selection reasons
  if (context.selection_reasons?.length > 0) {
    prompt += `WHY ${context.selected.symbol} WINS (Plain English):
`;
    context.selection_reasons.forEach((r, i) => {
      prompt += `${i + 1}. ${r.factor}: ${r.explanation}
`;
      if (r.comparison) {
        prompt += `   ↳ ${r.comparison}
`;
      }
    });
    prompt += '\n';
  }

  // Add framework explanation
  if (context.framework_explanation) {
    prompt += `BOTTOM LINE:
${context.framework_explanation.bottom_line}

`;
  }

  prompt += `═══════════════════════════════════════════════════════════════════════════
⚠️ USE THIS CONTEXT to explain the selection in framework_analysis and why_in_plain_words
═══════════════════════════════════════════════════════════════════════════
`;

  return prompt;
}

export default {
  buildFrameworkContext,
  formatContextForPrompt
};
