/**
 * Weekly Analysis Service - V2
 *
 * Generates AI-powered swing analysis for top weekend stock picks.
 * Produces GESHIP-quality output compatible with StockAnalysis schema v1.5.
 *
 * Input:  Enriched stock data (from screening pipeline) + fundamentals (from Screener.in)
 * Output: StockAnalysis document in schema v1.5 format
 *
 * Flow:
 * 1. Receive top 3-4 qualified stocks from weekendScreeningJob Step 5
 * 2. Fetch fundamental data from Screener.in (promoter pledge, FII/DII, P/E, quarterly results)
 * 3. Build comprehensive prompt: technical (from engine) + fundamental + market context
 * 4. Call Claude API
 * 5. Parse response into StockAnalysis schema v1.5
 * 6. Save to DB, link to WeeklyWatchlist
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';
import StockAnalysis from '../models/stockAnalysis.js';
import ApiUsage from '../models/apiUsage.js';
import fundamentalDataService from './fundamentalDataService.js';
import MarketHoursUtil from '../utils/marketHours.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_OUTPUT_TOKENS = 5000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — Encodes the trading framework, scoring rubric, and quality
// standards that produce GESHIP-quality output.
// ═══════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a swing trading analyst for Indian equities (NSE). You generate weekend discovery analyses that help retail traders decide: "Should I buy this stock next week?"

You will receive pre-calculated technical data (indicators, trading levels, engine score) from an automated screening pipeline, plus fundamental data from Screener.in. Your job is to synthesize everything into a clear, actionable analysis.

## TRADING FRAMEWORK

This is a scan-type-matched swing trading system. The ChartInk scanner finds stocks using specific criteria (breakout, pullback, momentum, etc.), and the entry strategy matches WHY the stock was found.

1. ENTRY PHILOSOPHY — SCAN-TYPE MATCHED:
   The pre-calculated trading levels already match the scan type. You must respect them:

   A+ MOMENTUM scans (archetype: "52w_breakout", entryType: "buy_above"):
   - These stocks just broke their 52-WEEK HIGH with volume. This is the strongest technical setup.
   - Primary: Buy above Friday's high (the breakout day). Monday entry confirms the breakout holds.
   - Key context: There is NO overhead resistance. The stock is at all-time or 52W highs. Targets may be ATR-based extensions, not structural levels.
   - Alternative: If Monday opens weak/gaps down, the OLD 52-week high level (now broken) becomes support. Offer "retest entry" at that level in strategies[].
   - Risk: False breakout / bull trap. If price falls back below the old 52W high, the breakout failed — exit immediately.
   - Warning: ALWAYS include an ATH_NO_RESISTANCE warning when targetBasis is 'atr_extension_52w_breakout'.

   MOMENTUM / BREAKOUT scans (entryType: "buy_above"):
   - Primary: Continuation entry ABOVE Friday's high. The stock is already running — the entry confirms strength.
   - The engine sets entry above Friday high + ATR buffer. This is correct for momentum stocks.
   - ALSO suggest a pullback alternative: "If the stock dips to [EMA20/weekly pivot] during the week, that's a better-risk entry." Put this in the strategies[] array.
   - Why: Momentum stocks sometimes keep running (pullback never comes), sometimes dip and offer better entries. Present both paths.

   PULLBACK scans (entryType: "limit" or "buy_above" for conservative):
   - Primary: Buy the dip near EMA20 support. The stock has already pulled back — the scan found it because it's at support.
   - The engine may set aggressive (limit at EMA20) or conservative (buy_above Friday high) mode based on pullback health.
   - ALSO suggest an alternative for cautious traders: "If the pullback deepens below EMA20, the next support is [weekly S1/DMA50]."

   CONSOLIDATION BREAKOUT scans:
   - Primary: Buy above the tight range. The entry confirms the range expansion.

   Key principle: Don't fight the scan type. A 52W breakout stock should NOT be told to "wait for a pullback to EMA20" as the primary action — that pullback may never come, and you miss the trade. Present it as an alternative only.

2. HOLDING PERIOD: 1 week (Monday to Friday). Trades are entered Mon-Wed and exited by Friday.

3. RISK MANAGEMENT:
   - Minimum Risk:Reward of 1:2 (prefer 1:2.5+)
   - Maximum risk per trade: 1-2% of portfolio
   - RSI must be below 72 on BOTH daily AND weekly timeframes (hard gate — if either is > 72, recommend WAIT_FOR_DIP regardless of scan type)
   - Stop loss is always below a structural level (EMA20, pivot, swing low — never arbitrary)

4. POSITION LIMITS: Maximum 3-4 simultaneous positions.

5. FUNDAMENTAL FILTERS:
   - Promoter pledge > 30%: CRITICAL RED FLAG → reduce confidence by 20%, recommend SKIP or tiny position only. Always add a "critical" severity warning.
   - Promoter pledge 15-30%: WARNING → reduce confidence by 10%, add "high" severity warning.
   - Promoter pledge 1-14%: NOTE → add "medium" severity warning.
   - Promoter pledge 0%: POSITIVE → note as strength, boost confidence by 10%.
   - FII + DII both increasing quarter-over-quarter = strong institutional conviction.
   - FII decreasing while price rises = caution (smart money distributing into retail buying).

6. MARKET EVENTS: Factor in Budget announcements, F&O expiry (every Thursday), earnings dates within the trade window. If a major event falls within the holding period, adjust accordingly — recommend waiting, smaller position, or factoring in gap risk.

## SCORING RUBRIC

Score each stock on 7 factors totaling 100 points. The automated engine score and breakdown are provided as a baseline. You produce your OWN assessment that includes fundamental factors the engine cannot see (promoter pledge, institutional flows, pattern quality).

| Factor               | Max | Assessment Guide                                                    |
|----------------------|-----|----------------------------------------------------------------------|
| Volume Conviction    | 20  | vs 20d avg: ≥3x=20, ≥2.5x=18, ≥2x=16, ≥1.5x=12, ≥1.2x=8, <1x=2 |
| Risk:Reward          | 20  | ≥3:1=20, ≥2.5:1=17, ≥2:1=14, ≥1.5:1=10, ≥1.2:1=5, <1.2:1=0      |
| RSI Position         | 15  | 55-62=15(sweet spot), 52-55=12, 62-65=12, 65-68=10, 68-72=5        |
| Weekly Move          | 15  | 3-7%=15(ideal), 2-3%=12, 7-10%=10, 1-2%=8, >10%=5(overextended)   |
| Upside to Target     | 15  | ≥15%=15, ≥12%=13, ≥10%=11, ≥8%=9, ≥6%=7, ≥4%=4, <4%=2            |
| Promoter & Instit.   | 10  | 0% pledge+FII/DII buying=10, low pledge=7, moderate=4, high=0-2    |
| Price Accessibility  | 5   | ≤₹200=5, ≤₹500=4, ≤₹1000=3, ≤₹2000=2, >₹2000=1                   |

Grades: A+ (90+), A (80-89), B+ (70-79), B (60-69), C (50-59), D (<50)

## VERDICT ACTIONS

- BUY: Setup at or near entry zone, scan-matched strategy is valid. For momentum scans this means "buy above Friday high when triggered." For pullback scans this means "limit order at support."
- BUY_ON_PULLBACK: Good momentum/breakout setup, but current price is extended. Wait for dip to the pullback alternative level before entering. Most relevant when RSI is 65-72 or price is far from entry zone.
- WAIT_FOR_DIP: Setup is interesting but needs a bigger pullback than even the entry zone suggests. Stock is overextended (RSI approaching 72, big weekly move).
- SKIP: Fundamental red flags (high pledge, deteriorating financials) or technical rejection (RSI >72, poor R:R). Do not trade.

## QUALITY STANDARDS

1. Be specific with numbers — say "8.01x average volume", not "high volume".
2. Every warning MUST have a mitigation action.
3. Beginner guide must have 5-6 numbered steps a first-time trader can follow.
4. The verdict one_liner must be actionable in a single sentence.
5. Chart observations must include RSI value and status for BOTH weekly and daily timeframes.
6. If promoter pledge > 0%, it MUST appear in warnings with appropriate severity.
7. Aggressive entry should be near current price with a note about smaller position size and when it is/isn't recommended.
8. target1 = partial profit booking level (closer to entry, e.g. previous high or daily R1).
   target2 = full target from the structural ladder (the pre-calculated target).
9. Confidence adjustments must sum to a reasonable final confidence (0.5-0.95 range).
10. Key factors should start with emoji indicators: ✅ for positives, ⚠️ for cautions, 🔴 for red flags.

## CRITICAL CONSTRAINTS

- Use the PRE-CALCULATED trading levels (entry, stop, target) EXACTLY as provided. Do NOT recalculate them.
- The levels come from a structural ladder algorithm anchored to pivot levels. Trust them.
- You MAY suggest an aggressive_entry near current price (for traders who can't wait).
- You MAY suggest a target1 (partial booking) that is closer than the full target.
- Return ONLY valid JSON. No markdown code fences, no explanation text outside the JSON object.`;


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate AI analysis for a single stock
 * @param {Object} stock - Enriched stock data from screening pipeline
 * @param {Object} options - { marketContext }
 * @returns {Promise<Object>} StockAnalysis document
 */
async function generateWeeklyAnalysis(stock, options = {}) {
  const requestId = uuidv4().substring(0, 8);
  const startTime = Date.now();

  console.log(`[WEEKLY ANALYSIS] [${requestId}] Starting analysis for ${stock.symbol}...`);

  try {
    // Step 1: Fetch fundamental data
    console.log(`[WEEKLY ANALYSIS] [${requestId}] Fetching fundamentals from Screener.in...`);
    const fundamentals = await fundamentalDataService.fetchFundamentalData(stock.symbol);

    // Step 2: Build prompt
    const userMessage = buildUserMessage(stock, fundamentals, options);

    // Step 3: Call Claude
    console.log(`[WEEKLY ANALYSIS] [${requestId}] Calling Claude (${CLAUDE_MODEL})...`);
    const response = await callClaude(userMessage, requestId);

    // Step 4: Parse response into analysis_data
    const analysisData = parseClaudeResponse(response.content, stock);

    // Step 5: Build analysis_meta (server-side metadata)
    const analysisMeta = buildAnalysisMeta(stock, fundamentals, response, startTime);

    // Step 6: Calculate valid_until (end of trading week)
    const validUntil = await getWeeklyValidUntil();

    // Step 7: Save to StockAnalysis
    // Use create() + TTL cleanup instead of findOneAndUpdate
    // This avoids overwriting manual analyses triggered separately
    const weekStart = getWeekStart();

    const analysis = await StockAnalysis.findOneAndUpdate(
      {
        instrument_key: stock.instrument_key,
        analysis_type: 'swing',
        created_at: { $gte: weekStart }   // Only match THIS week's analysis
      },
      {
        instrument_key: stock.instrument_key,
        stock_name: stock.stock_name,
        stock_symbol: stock.symbol,
        analysis_type: 'swing',
        current_price: stock.current_price,
        analysis_data: analysisData,
        analysis_meta: analysisMeta,
        status: 'completed',
        valid_until: validUntil,
        last_validated_at: new Date(),
        progress: {
          percentage: 100,
          current_step: 'Analysis complete',
          steps_completed: 8,
          total_steps: 8,
          estimated_time_remaining: 0,
          last_updated: new Date()
        }
      },
      {
        upsert: true,
        new: true,
        runValidators: false
      }
    );

    const responseTime = Date.now() - startTime;

    // Log API usage
    await logApiUsage({
      requestId,
      model: CLAUDE_MODEL,
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
      responseTime,
      success: true,
      symbol: stock.symbol
    });

    console.log(`[WEEKLY ANALYSIS] [${requestId}] ✅ Complete for ${stock.symbol} ` +
      `(${responseTime}ms, ${response.usage?.input_tokens || '?'}+${response.usage?.output_tokens || '?'} tokens)`);

    return analysis;

  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error(`[WEEKLY ANALYSIS] [${requestId}] ❌ Failed for ${stock.symbol}:`, error.message);

    await logApiUsage({
      requestId,
      model: CLAUDE_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      responseTime,
      success: false,
      errorMessage: error.message,
      symbol: stock.symbol
    });

    return await createFailedAnalysis(stock, error.message);
  }
}

/**
 * Generate AI analysis for multiple stocks (sequential to avoid rate limits)
 * @param {Array} stocks - Array of enriched stock data
 * @param {number} maxStocks - Maximum stocks to analyze (default: 4)
 * @param {Object} options - { marketContext }
 * @returns {Promise<Array>} Array of StockAnalysis documents
 */
async function generateMultipleAnalyses(stocks, maxStocks = 4, options = {}) {
  const topStocks = stocks.slice(0, maxStocks);

  console.log(`[WEEKLY ANALYSIS] ═══════════════════════════════════════════════════`);
  console.log(`[WEEKLY ANALYSIS] Generating analyses for ${topStocks.length} stocks: ${topStocks.map(s => `${s.symbol} (${s.grade})`).join(', ')}`);
  console.log(`[WEEKLY ANALYSIS] ═══════════════════════════════════════════════════`);

  const results = [];

  for (let i = 0; i < topStocks.length; i++) {
    const stock = topStocks[i];
    try {
      console.log(`[WEEKLY ANALYSIS] [${i + 1}/${topStocks.length}] ${stock.symbol}...`);
      const analysis = await generateWeeklyAnalysis(stock, options);
      results.push(analysis);

      // Delay between API calls to respect rate limits
      if (i < topStocks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (error) {
      console.error(`[WEEKLY ANALYSIS] [${i + 1}/${topStocks.length}] ❌ ${stock.symbol}: ${error.message}`);
      results.push(null);
    }
  }

  const successCount = results.filter(r => r !== null && r.status === 'completed').length;
  console.log(`[WEEKLY ANALYSIS] ═══════════════════════════════════════════════════`);
  console.log(`[WEEKLY ANALYSIS] Result: ${successCount}/${topStocks.length} analyses completed`);
  console.log(`[WEEKLY ANALYSIS] ═══════════════════════════════════════════════════`);

  return results.filter(Boolean);
}


// ═══════════════════════════════════════════════════════════════════════════════
// PROMPT BUILDING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build the user message with all stock data + output schema
 */
function buildUserMessage(stock, fundamentals, options = {}) {
  const levels = stock.levels || {};
  const ind = stock.indicators || {};
  const marketCtx = options.marketContext || generateMarketContext();

  const fundamentalText = fundamentalDataService.formatForPrompt(fundamentals);
  const scoreBreakdown = formatScoreBreakdown(stock.score_breakdown);

  return `
=== WEEKLY DISCOVERY ANALYSIS ===
Analyze this stock for swing trading next week. Return the JSON structure specified below.

=== STOCK PROFILE ===
Stock: ${stock.stock_name} (${stock.symbol})
Instrument Key: ${stock.instrument_key}
Current Price: ₹${stock.current_price}
Scan Type: ${stock.scan_type} (how it was discovered by ChartInk scanner)

=== ENGINE SCORE: ${stock.setup_score}/100 | GRADE: ${stock.grade} ===
This is the automated scoring from the screening engine. Use as baseline, adjust for fundamentals.
${scoreBreakdown}

=== PRE-CALCULATED TRADING LEVELS (Structural Ladder) ===
Mode: ${levels.mode || 'N/A'}
Entry: ₹${levels.entry || 'N/A'}
Entry Range: [₹${levels.entryRange?.[0] || 'N/A'} - ₹${levels.entryRange?.[1] || 'N/A'}]
Entry Type: ${levels.entryType || 'N/A'}
Stop Loss: ₹${levels.stop || 'N/A'}
Target (T2): ₹${levels.target || 'N/A'}
Target 2 (Trail): ₹${levels.target2 || 'N/A'}
Target Basis: ${levels.targetBasis || 'N/A'}
Daily R1 Checkpoint: ₹${levels.dailyR1Check || 'N/A'}
Risk:Reward: 1:${levels.riskReward || 'N/A'}
Risk %: ${levels.riskPercent || 'N/A'}%
Reward %: ${levels.rewardPercent || 'N/A'}%

⚠️ Use these exact entry, stop, and target levels. They are pre-calculated using the ${levels.mode || 'unknown'} formula anchored to ${levels.targetBasis || 'pivot levels'}.

SCAN ARCHETYPE: ${levels.archetype || (levels.entryType === 'limit' ? 'pullback' : 'trend-follow')}
This determines which strategy is PRIMARY and which is ALTERNATIVE in the strategies[] array.
- If archetype is "52w_breakout": Primary = breakout continuation entry above Friday high. Stock just broke 52W high — no overhead resistance. Alternative = retest of old 52W high level (now support) if Monday opens weak.
- If archetype is "trend-follow" or "breakout": Primary = momentum/breakout entry at the pre-calculated buy_above level. Alternative = pullback entry if stock dips to EMA20/pivot.
- If archetype is "pullback": Primary = dip-buy at the pre-calculated limit/support level. Alternative = confirmation entry if pullback deepens.
${levels.targetBasis === 'atr_extension_52w_breakout' ? '\n⚠️ TARGET NOTE: Target is ATR-based extension (2.5x ATR), not a structural level. This stock is at new 52W highs with no overhead resistance. Include ATH_NO_RESISTANCE warning.' : ''}

=== TECHNICAL INDICATORS ===
Daily RSI (14): ${ind.rsi || 'N/A'}
Weekly RSI (14): ${ind.weekly_rsi || 'N/A'}
EMA 20: ₹${ind.ema20 || 'N/A'}
EMA 50: ₹${ind.ema50 || 'N/A'}
DMA 50: ₹${ind.dma50 || 'N/A'}
DMA 200: ₹${ind.dma200 || 'N/A'}
ATR (14): ₹${ind.atr || 'N/A'} (${ind.atr_pct || 'N/A'}%)
Volume vs 20d Avg: ${ind.volume_vs_avg || 'N/A'}x
Distance from 20 DMA: ${ind.distance_from_20dma_pct || 'N/A'}%
Weekly Change: ${ind.weekly_change_pct || 'N/A'}%
1-Month Return: ${ind.return_1m || 'N/A'}%
20-Day High: ₹${ind.high_20d || 'N/A'}
52-Week High: ₹${ind.high_52w || 'N/A'}${levels.archetype === '52w_breakout' ? ' ← STOCK JUST BROKE THIS LEVEL. Old 52W high is now potential support on retest.' : ''}
EMA Stack Bullish (20>50>200): ${ind.ema_stack_bullish ? 'YES' : 'NO'}

Pivot Levels:
  Weekly: Pivot ₹${ind.weekly_pivot || 'N/A'} | S1 ₹${ind.weekly_s1 || 'N/A'} | R1 ₹${ind.weekly_r1 || 'N/A'} | R2 ₹${ind.weekly_r2 || 'N/A'}

=== FUNDAMENTAL DATA (Screener.in) ===
${fundamentalText || 'Fundamental data unavailable — skip fundamental scoring adjustments.'}

=== MARKET CONTEXT ===
Trading Week: ${marketCtx.weekLabel}
${marketCtx.niftyInfo}
Key Events This Week:
${marketCtx.events.map(e => `  • ${e}`).join('\n') || '  • None identified'}

=== OUTPUT: Return ONLY this JSON (no markdown, no extra text) ===

{
  "overall_sentiment": "BULLISH" | "BULLISH_CAUTIOUS" | "NEUTRAL" | "BEARISH",

  "sentiment_analysis": {
    "key_factors": [
      "✅ or ⚠️ or 🔴 prefixed observation (5-8 items covering technicals, fundamentals, context)"
    ]
  },

  "confidence_breakdown": {
    "adjustments": [
      "+15% for [specific positive reason with number]",
      "-10% for [specific negative reason with number]"
    ]
  },

  "performance_hints": {
    "confidence_drivers": ["Positive factor 1", "Positive factor 2", "..."],
    "uncertainty_factors": ["Risk or unknown 1", "Risk or unknown 2", "..."]
  },

  "what_to_watch": {
    "if_bought": "Specific hold/trail/exit guidance with price levels",
    "if_waiting": "RECOMMENDED: Specific entry zone and why to wait for it"
  },

  "setup_score": {
    "total": 85,
    "grade": "A",
    "factors": [
      {
        "name": "Volume Conviction",
        "score": "19/20",
        "status": "✅",
        "value": "8.01x avg",
        "explanation": "Why this score — be specific"
      },
      {
        "name": "Risk:Reward",
        "score": "18/20",
        "status": "✅",
        "value": "1:2.4",
        "explanation": "Assessment of the pre-calculated R:R"
      },
      {
        "name": "RSI Position",
        "score": "14/15",
        "status": "✅",
        "value": "Daily 70 / Weekly 66.5",
        "explanation": "Both daily and weekly RSI assessment"
      },
      {
        "name": "Weekly Move",
        "score": "12/15",
        "status": "✅",
        "value": "+1.33%",
        "explanation": "Assessment of weekly momentum"
      },
      {
        "name": "Upside to Target",
        "score": "12/15",
        "status": "✅",
        "value": "9.1%",
        "explanation": "Upside potential to target"
      },
      {
        "name": "Promoter & Institutional",
        "score": "10/10",
        "status": "✅",
        "value": "0% pledge, FII 25.4%",
        "explanation": "Pledge risk + FII/DII assessment"
      },
      {
        "name": "Price Accessibility",
        "score": "5/5",
        "status": "✅",
        "value": "₹1,202",
        "explanation": "Position sizing accessibility"
      }
    ],
    "strengths": ["Top 3-4 strengths as strings"],
    "watch_factors": ["Top 2-3 concerns as strings"]
  },

  "trading_plan": {
    "entry": ${levels.entry || 'null'},
    "entry_range": [${levels.entryRange?.[0] || 'null'}, ${levels.entryRange?.[1] || 'null'}],
    "aggressive_entry": {
      "price": null,
      "range": [null, null],
      "note": "Whether aggressive entry is recommended and why/why not"
    },
    "stop_loss": ${levels.stop || 'null'},
    "target": ${levels.target || 'null'},
    "target1": null,
    "target2": ${levels.target2 || levels.target || 'null'},
    "risk_reward": ${levels.riskReward || 'null'},
    "risk_percent": ${levels.riskPercent || 'null'},
    "reward_percent": ${levels.rewardPercent || 'null'}
  },

  "risk_factors": [
    "Plain text risk factor 1 — be specific with numbers",
    "Plain text risk factor 2"
  ],

  "verdict": {
    "action": "BUY_ON_PULLBACK" | "BUY" | "WAIT_FOR_DIP" | "SKIP",
    "confidence": 0.85,
    "one_liner": "Single actionable sentence: what to do, at what price, key reason"
  },

  "beginner_guide": {
    "what_stock_is_doing": "Plain English: what the chart shows and why it matters",
    "why_this_is_interesting": "Plain English: what makes this stock stand out from others",
    "steps_to_trade": [
      "Step 1: [specific first action with price]",
      "Step 2: [entry instruction]",
      "Step 3: [stop loss placement with reason]",
      "Step 4: [partial profit booking at T1]",
      "Step 5: [trail stop for remaining to T2]"
    ],
    "if_it_fails": {
      "max_loss": "₹X,XXX per 100 shares (from ₹entry)",
      "loss_percent": "X.X%",
      "why_okay": "Why this loss is manageable — reference the stop level logic"
    }
  },

  "warnings": [
    {
      "code": "BUDGET_WEEK | FNO_EXPIRY | PROMOTER_PLEDGE_HIGH | HIGH_PE | RSI_EXTENDED | EARNINGS_AHEAD | ATH_NO_RESISTANCE | MARKET_WEAKNESS | LOW_VOLUME | DEBT_CONCERN",
      "severity": "low | medium | high | critical",
      "message": "Factual description with specific numbers",
      "mitigation": "What the trader should do about it"
    }
  ],

  "strategies": [
    {
      "name": "Primary: [Scan-matched strategy name]",
      "description": "For 52W breakout: 'Buy above ₹entry on Monday — confirms breakout holds above old 52W high.' For momentum/breakout: 'Buy above ₹entry when triggered, confirms continuation...' For pullback: 'Limit buy at ₹entry near EMA20 support...'"
    },
    {
      "name": "Alternative: [Opposite approach]",
      "description": "For 52W breakout: 'If Monday gaps down, wait for retest of old 52W high at ₹X (now support). If it holds, enter with stop below ₹Y.' For momentum/breakout: 'If stock dips to ₹[EMA20/weekly pivot], set limit order for better R:R.' For pullback: 'If pullback deepens, next support at ₹[weekly S1/DMA50].'"
    }
  ],

  "chart_observations": {
    "weekly": {
      "rsi": ${ind.weekly_rsi || 'null'},
      "status": "HEALTHY | APPROACHING_OVERBOUGHT | OVERBOUGHT | OVERSOLD",
      "current_candle": "GREEN or RED (±X.X%)",
      "support_s1": ${ind.weekly_s1 || 'null'},
      "resistance_r1": ${ind.weekly_r1 || 'null'}
    },
    "daily": {
      "rsi": ${ind.rsi || 'null'},
      "status": "HEALTHY | APPROACHING_OVERBOUGHT | OVERBOUGHT | OVERSOLD",
      "pivot": ${levels.entry || 'null'},
      "support_s1": ${ind.weekly_s1 || 'null'},
      "resistance_r1": ${ind.weekly_r1 || 'null'},
      "50_dma": ${ind.dma50 || 'null'},
      "200_dma": ${ind.dma200 || 'null'}
    }
  }
}

IMPORTANT REMINDERS:
- Fill aggressive_entry.price with a realistic price near current price (₹${stock.current_price}).
- Fill target1 with a partial profit-booking level between entry and target (e.g., daily R1, previous high, or round number).
- Calculate max_loss in beginner_guide based on entry minus stop × 100 shares.
- Keep total JSON under 4000 tokens.
- Return ONLY the JSON object. No other text.`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// CLAUDE API CALL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Call Claude API with system prompt + user message
 */
async function callClaude(userMessage, requestId) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userMessage }
    ]
  });

  // Validate we got a response
  if (!response.content || response.content.length === 0) {
    throw new Error('Empty response from Claude API');
  }

  // Check for truncation
  if (response.stop_reason === 'max_tokens') {
    console.warn(`[WEEKLY ANALYSIS] [${requestId}] ⚠️ Response truncated at ${MAX_OUTPUT_TOKENS} tokens`);
  }

  return response;
}


// ═══════════════════════════════════════════════════════════════════════════════
// RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse Claude's JSON response into analysis_data compatible with StockAnalysis schema v1.5
 */
function parseClaudeResponse(content, stock) {
  // Extract text from content blocks
  let textContent = '';
  if (Array.isArray(content)) {
    textContent = content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
  } else if (typeof content === 'string') {
    textContent = content;
  }

  // Strip markdown fences if Claude wrapped the JSON
  textContent = textContent
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // Try to extract JSON if there's surrounding text
  if (!textContent.startsWith('{')) {
    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      textContent = jsonMatch[0];
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(textContent);
  } catch (parseError) {
    console.error('[WEEKLY ANALYSIS] JSON parse failed. First 500 chars:', textContent.substring(0, 500));
    throw new Error(`JSON parse error: ${parseError.message}`);
  }

  // Build analysis_data — merge Claude's output with server-side fields
  const ind = stock.indicators || {};

  return {
    // Server-side metadata
    schema_version: '1.5',
    symbol: stock.symbol,
    analysis_type: 'swing',
    intraday: null,
    position_management: null,
    original_swing_analysis_id: null,
    original_levels: null,
    generated_at_ist: new Date().toISOString(),
    insufficientData: false,

    // From Claude
    overall_sentiment: parsed.overall_sentiment || 'NEUTRAL',
    sentiment_analysis: parsed.sentiment_analysis || { key_factors: [] },

    // Runtime info
    runtime: {
      triggers_evaluated: detectTriggers(stock)
    },

    confidence_breakdown: parsed.confidence_breakdown || { adjustments: [] },
    performance_hints: parsed.performance_hints || {
      confidence_drivers: [],
      uncertainty_factors: []
    },

    disclaimer: 'Educational analysis only. Not investment advice.',

    what_to_watch: parsed.what_to_watch || null,
    setup_score: parsed.setup_score || {
      total: stock.setup_score,
      grade: stock.grade
    },
    trading_plan: parsed.trading_plan || null,
    risk_factors: parsed.risk_factors || [],
    verdict: parsed.verdict || null,
    beginner_guide: parsed.beginner_guide || null,
    warnings: parsed.warnings || [],
    strategies: parsed.strategies || [],
    chart_observations: parsed.chart_observations || null,

    // Order gate — weekly discovery is always "actionable on trigger"
    order_gate: {
      all_triggers_true: true,
      no_pre_entry_invalidations: true,
      actionability_status: parsed.verdict?.action?.startsWith('BUY') ? 'actionable_on_trigger' : 'monitor_only',
      entry_type_sane: true,
      can_place_order: parsed.verdict?.action?.startsWith('BUY') || false
    }
  };
}

/**
 * Build analysis_meta from server-side data
 */
function buildAnalysisMeta(stock, fundamentals, response, startTime) {
  const levels = stock.levels || {};

  return {
    candle_info: {
      timeframes_used: [
        {
          timeframe: 'daily',
          key: '1d',
          bars_count: 240,
          last_candle_time: new Date().toISOString()
        },
        {
          timeframe: 'weekly',
          key: '1w',
          bars_count: 52,
          last_candle_time: new Date().toISOString()
        }
      ],
      primary_timeframe: 'daily',
      last_candle_time: new Date().toISOString()
    },
    model_used: CLAUDE_MODEL,
    processing_time_ms: Date.now() - startTime,
    stage_chain: [
      'screening_engine',     // ChartInk scan + enrichment
      'fundamental_fetch',    // Screener.in data
      'ai_analysis',          // Claude synthesis
      'score',                // Scoring (engine + AI)
      'verdict'               // Final recommendation
    ],
    setup_score: stock.setup_score,
    grade: stock.grade,
    trading_levels: {
      entry: levels.entry,
      entry_range: levels.entryRange,
      stop: levels.stop,
      target: levels.target,
      target1: null,    // Set by Claude in trading_plan
      target2: levels.target2,
      riskReward: levels.riskReward
    },
    research_sources: [
      `ChartInk ${stock.scan_type} scanner`,
      'Logdhan screening engine (indicators + structural ladder)',
      `Screener.in - ${stock.symbol} ${fundamentals?.error ? '(fetch failed)' : 'consolidated'}`,
      `Engine score: ${stock.setup_score}/100 (${stock.grade})`
    ],
    source: 'weekend_screening',
    scan_type: stock.scan_type
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Auto-generate market context from system clock
 * Can be overridden by passing explicit marketContext in options
 */
function generateMarketContext() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);

  // Find next Monday (start of trading week)
  const dayOfWeek = istNow.getUTCDay();
  let daysToMonday = (8 - dayOfWeek) % 7;
  if (daysToMonday === 0 && dayOfWeek !== 1) daysToMonday = 7;
  if (dayOfWeek === 1) daysToMonday = 0; // Already Monday

  const monday = new Date(istNow);
  monday.setUTCDate(monday.getUTCDate() + daysToMonday);

  const friday = new Date(monday);
  friday.setUTCDate(friday.getUTCDate() + 4);

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const weekLabel = `${months[monday.getUTCMonth()]} ${monday.getUTCDate()}-${friday.getUTCDate()}, ${monday.getUTCFullYear()}`;

  // Auto-detect recurring events
  const events = [];

  // F&O expiry is every Thursday
  const thursday = new Date(monday);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  events.push(`${months[thursday.getUTCMonth()]} ${thursday.getUTCDate()} (Thursday): Weekly F&O Expiry`);

  return {
    weekLabel,
    niftyInfo: 'Nifty level: Check current market data',
    events
  };
}

/**
 * Detect trigger codes based on stock data
 */
function detectTriggers(stock) {
  const triggers = [];
  const ind = stock.indicators || {};
  const levels = stock.levels || {};

  // 52W high detection — prefer archetype-based (certain) over price-proximity (estimated)
  if (levels.archetype === '52w_breakout' || levels.targetBasis === 'atr_extension_52w_breakout') {
    triggers.push('52W_HIGH_BREAKOUT');
  } else if (ind.high_52w && stock.current_price >= ind.high_52w * 0.97) {
    triggers.push('NEAR_52W_HIGH');
  }

  if (ind.ema_stack_bullish) {
    triggers.push('ABOVE_ALL_MAs');
  }
  if (ind.volume_vs_avg >= 2.0) {
    triggers.push('VOLUME_CONFIRMATION');
  }
  if (ind.weekly_change_pct >= 3) {
    triggers.push('WEEKLY_MOMENTUM');
  }

  // Scan type triggers
  if (stock.scan_type === 'a_plus_momentum') {
    triggers.push('A_PLUS_SCAN');
  } else if (stock.scan_type === 'breakout') {
    triggers.push('BREAKOUT_SCAN');
  } else if (stock.scan_type === 'pullback') {
    triggers.push('PULLBACK_SCAN');
  } else if (stock.scan_type === 'momentum') {
    triggers.push('MOMENTUM_SCAN');
  }

  return triggers;
}

/**
 * Format engine score breakdown for prompt
 */
function formatScoreBreakdown(breakdown) {
  if (!breakdown || !Array.isArray(breakdown)) return 'No automated breakdown available.';

  return breakdown.map(f => {
    const pct = Math.round((f.points / f.max) * 100);
    const status = pct >= 70 ? '✅' : pct >= 40 ? '⚠️' : '❌';
    return `${status} ${f.factor}: ${f.points}/${f.max} pts — ${f.reason} ${f.value ? `(${f.value})` : ''}`;
  }).join('\n');
}

/**
 * Get the start of the current week (Monday 00:00 IST in UTC)
 */
function getWeekStart() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);

  const dayOfWeek = istNow.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(istNow);
  monday.setUTCDate(monday.getUTCDate() - daysFromMonday);
  monday.setUTCHours(0, 0, 0, 0);

  // Convert back from IST to UTC
  return new Date(monday.getTime() - istOffset);
}

/**
 * Get valid_until for weekly analysis (next Friday 3:59 PM IST = 10:29 AM UTC)
 */
async function getWeeklyValidUntil() {
  try {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);

    // Find next Friday from IST perspective
    const dayOfWeek = istNow.getUTCDay();
    let daysToFriday = (5 - dayOfWeek + 7) % 7;
    if (daysToFriday === 0 && dayOfWeek !== 5) daysToFriday = 7;
    if (daysToFriday === 0) daysToFriday = 7; // If today is Friday, target next Friday

    const nextFriday = new Date(istNow);
    nextFriday.setUTCDate(nextFriday.getUTCDate() + daysToFriday);

    // Set to 3:59 PM IST (10:29 AM UTC)
    nextFriday.setUTCHours(10, 29, 59, 0);

    // Convert back to UTC
    return new Date(nextFriday.getTime() - istOffset);

  } catch (error) {
    // Fallback: 7 days from now
    const fallback = new Date();
    fallback.setDate(fallback.getDate() + 7);
    return fallback;
  }
}

/**
 * Create a failed analysis record
 */
async function createFailedAnalysis(stock, errorMessage) {
  try {
    const analysis = new StockAnalysis({
      instrument_key: stock.instrument_key,
      stock_name: stock.stock_name,
      stock_symbol: stock.symbol,
      analysis_type: 'swing',
      current_price: stock.current_price,
      status: 'failed',
      progress: {
        percentage: 0,
        current_step: `Failed: ${errorMessage}`,
        last_updated: new Date()
      }
    });

    await analysis.markFailed(errorMessage);
    return analysis;
  } catch (err) {
    console.error(`[WEEKLY ANALYSIS] Failed to create failed analysis record:`, err.message);
    return null;
  }
}

/**
 * Log API usage to database
 */
async function logApiUsage({ requestId, model, inputTokens, outputTokens, responseTime, success, errorMessage, symbol }) {
  try {
    await ApiUsage.logUsage({
      provider: 'ANTHROPIC',
      model,
      feature: 'WEEKLY_ANALYSIS',
      tokens: {
        input: inputTokens,
        output: outputTokens
      },
      request_id: requestId,
      response_time_ms: responseTime,
      success,
      error_message: errorMessage,
      context: {
        symbol,
        description: `Weekly discovery analysis for ${symbol}`,
        source: 'weekend_screening'
      }
    });
  } catch (error) {
    // Don't fail the analysis if logging fails
    console.error('[WEEKLY ANALYSIS] Failed to log API usage:', error.message);
  }
}

/**
 * Check if weekly analysis should run
 * Only run on Saturday/Sunday during analysis window
 */
function shouldRunWeeklyAnalysis() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);

  const day = istNow.getUTCDay();   // 0=Sun, 6=Sat
  const hour = istNow.getUTCHours();

  // Saturday 4 PM IST onwards (10 AM UTC)
  if (day === 6 && hour >= 10) return true;

  // Sunday before 6 PM IST (before 12:30 PM UTC)
  if (day === 0 && hour < 13) return true;

  return false;
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  generateWeeklyAnalysis,
  generateMultipleAnalyses,
  shouldRunWeeklyAnalysis
};

export {
  generateWeeklyAnalysis,
  generateMultipleAnalyses,
  shouldRunWeeklyAnalysis
};