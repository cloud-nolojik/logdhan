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
import StockAnalysis from '../../models/stockAnalysis.js';
import ApiUsage from '../../models/apiUsage.js';
import fundamentalDataService from '../fundamentalDataService.js';
import MarketHoursUtil from '../../utils/marketHours.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_OUTPUT_TOKENS = 5000;

// Lazy initialization - API key may not be available at module load time
let anthropic = null;

function getAnthropicClient() {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not configured in environment');
    }
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }
  return anthropic;
}

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

   ENTRY CONFIRMATION RULES (CRITICAL):
   - For buy_above entries (breakout, momentum, 52W): Entry is confirmed ONLY when the stock CLOSES
     above the entry level on a daily candle. An intraday touch that reverses is NOT a valid entry.
     Example: If entry is ₹3,099 and stock touches ₹3,188 intraday but closes at ₹3,035 — NO ENTRY.
     The next day if it closes at ₹3,234 above ₹3,099 — ENTRY CONFIRMED.
   - For limit entries (pullback): Entry is confirmed when price touches the entry level (limit fill).
   - Always communicate this rule clearly in the beginner_guide steps.

2. HOLDING PERIOD: 1 week (Monday to Friday). Trades are entered within the entry window and exited by Friday.

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

**Use the rubric that matches the scan type. The correct rubric will be specified in the user message.**

### MOMENTUM RUBRIC (for a_plus_momentum, breakout, consolidation scans):
| Factor               | Max | Assessment Guide                                                    |
|----------------------|-----|----------------------------------------------------------------------|
| Volume Conviction    | 20  | vs 20d avg: ≥3x=20, ≥2.5x=18, ≥2x=16, ≥1.5x=12, ≥1.2x=8, <1x=2 |
| Risk:Reward          | 20  | ≥3:1=20, ≥2.5:1=17, ≥2:1=14, ≥1.5:1=10, ≥1.2:1=5, <1.2:1=0      |
| RSI Position         | 15  | 55-62=15(sweet spot), 52-55=12, 62-65=12, 65-68=10, 68-72=5        |
| Weekly Move          | 15  | 3-7%=15(ideal), 2-3%=12, 7-10%=10, 1-2%=8, >10%=5(overextended)   |
| Upside to Target     | 15  | ≥15%=15, ≥12%=13, ≥10%=11, ≥8%=9, ≥6%=7, ≥4%=4, <4%=2            |
| Promoter & Instit.   | 10  | 0% pledge+FII/DII buying=10, low pledge=7, moderate=4, high=0-2    |
| Price Accessibility  | 5   | ≤₹200=5, ≤₹500=4, ≤₹1000=3, ≤₹2000=2, >₹2000=1                   |

### PULLBACK RUBRIC (for pullback scans — INVERTED priorities):
Pullback stocks were found BECAUSE they have low volume and cooled RSI near EMA20 support. These are FEATURES, not flaws. Score them using the pullback rubric:
| Factor                  | Max | Assessment Guide                                                          |
|-------------------------|-----|---------------------------------------------------------------------------|
| EMA20 Proximity         | 25  | ≤0.5%=25, ≤1%=22, ≤2%=18, ≤3%=12, ≤5%=6, >5%=2 (core pullback thesis)  |
| Volume Decline Quality  | 20  | INVERTED: ≤0.6x=20, ≤0.7x=18, ≤0.8x=16, ≤0.9x=13, ≤1x=10, >1.3x=0   |
| RSI Cooling             | 15  | 45-52=15(ideal), 52-58=12, 40-45=8, 58-65=6, 35-40=4                    |
| Trend Structure         | 15  | EMA20>EMA50=6, EMA50>SMA200=5, Price>SMA200=4 (sum components)           |
| Risk:Reward             | 15  | ≥2.5:1=15, ≥2:1=13, ≥1.5:1=10, ≥1.3:1=6, ≥1:1=3, <1:1=0              |
| Relative Strength       | 5   | vs Nifty 1M: ≥8%=5, ≥5%=4, ≥2%=3, ≥0%=2, <0%=0                        |
| ATR% Tradability        | 5   | 1.5-3.5%=5, 1-1.5%=3, 3.5-5%=3, extreme=1                              |

Grades: A+ (80+), A (70-79), B+ (60-69), B (50-59), C (40-49), D (<40)

## VERDICT ACTIONS

- BUY: Setup at or near entry zone, scan-matched strategy is valid. For momentum scans this means "buy above Friday high when triggered." For pullback scans this means "limit order at support."
- BUY_ON_PULLBACK: Good momentum/breakout setup, but current price is extended. Wait for dip to the pullback alternative level before entering. Most relevant when RSI is 65-72 or price is far from entry zone.
- WAIT_FOR_DIP: Setup is interesting but needs a bigger pullback than even the entry zone suggests. Stock is overextended (RSI approaching 72, big weekly move).
- SKIP: Fundamental red flags (high pledge, deteriorating financials) or technical rejection (RSI >72, poor R:R). Do not trade.

## QUALITY STANDARDS

1. Be specific with numbers — say "8.01x average volume", not "high volume".
2. Every warning MUST have a mitigation action.
3. Beginner guide must have 5-6 numbered steps a first-time trader can follow.
4. The verdict one_liner must be actionable in a single sentence. If Risk:Reward is below 2:1, the one_liner MUST acknowledge this (e.g., "...but R:R is tight at 1.4:1"). If any scoring factor scores ≤40% of its maximum, mention the weakest factor as a caveat.
5. Chart observations must include RSI value and status for BOTH weekly and daily timeframes.
6. If promoter pledge > 0%, it MUST appear in warnings with appropriate severity.
7. Do NOT fill aggressive_entry. This field is deprecated. If an alternative entry exists,
   describe it in strategies[] as the "Alternative" strategy with a text description.
8. target1, target2, and target3 are PRE-CALCULATED by the engine.
   Do NOT generate a trading_plan object. Use these levels in your text as:
   - T1 (₹target1): 50% partial booking — book 50% of position, move stop to entry (risk-free)
   - T2 (₹target2): Main target — book 70% of remaining (35% of original), hold 30% for T3
   - T3 (₹target3): Extension target (optional) — book final 30% (15% of original)
   If T3 does NOT exist, exit fully at T2 (book all remaining shares).
9. Confidence adjustments must sum to a reasonable final confidence (0.5-0.95 range).
   Risk:Reward MUST be included as a confidence adjustment: R:R < 1.5:1 → delta -0.10, R:R 1.5-2.0:1 → delta -0.05, R:R ≥ 2.5:1 → delta +0.05.
10. Key factors should start with emoji indicators: ✅ for positives, ⚠️ for cautions, 🔴 for red flags.

## CRITICAL CONSTRAINTS

- Use the PRE-CALCULATED trading levels (entry, stop, target1, target2, target3) EXACTLY as provided. Do NOT recalculate them.
- The levels come from a structural ladder algorithm anchored to pivot levels. Trust them.
- Do NOT output a trading_plan object — levels are 100% engine-calculated.
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
    const fundT0 = Date.now();
    const fundamentals = await fundamentalDataService.fetchFundamentalData(stock.symbol);
    const fundMs = Date.now() - fundT0;
    if (fundamentals?.error) {
      console.warn(`[WEEKLY ANALYSIS] [${requestId}] Fundamentals fetch FAILED for ${stock.symbol} in ${fundMs}ms: ${fundamentals.error}`);
    } else {
      console.log(`[WEEKLY ANALYSIS] [${requestId}] Fundamentals fetched for ${stock.symbol} in ${fundMs}ms (pledge=${fundamentals?.promoterPledge ?? '?'}% PE=${fundamentals?.pe ?? '?'})`);
    }

    // Step 1.5: News context (DailyNewsStock removed — globalMarketIntel handles news for daily picks)
    const recentNews = null;

    // Step 2: Build prompt
    const userMessage = buildUserMessage(stock, fundamentals, { ...options, recentNews });

    // Step 3: Call Claude
    console.log(`[WEEKLY ANALYSIS] [${requestId}] Calling Claude (${CLAUDE_MODEL})...`);
    const response = await callClaude(userMessage, requestId);

    // Step 4: Parse response into analysis_data
    console.log(`[WEEKLY ANALYSIS] [${requestId}] Parsing Claude response for ${stock.symbol} (stop_reason=${response.stop_reason}, tokens=${response.usage?.input_tokens || '?'}+${response.usage?.output_tokens || '?'})`);
    const analysisData = parseClaudeResponse(response.content, stock);

    // Step 5: Build analysis_meta (server-side metadata)
    const analysisMeta = buildAnalysisMeta(stock, fundamentals, response, startTime, recentNews);

    // Step 6: Calculate valid_until
    // - Weekend screening: Friday 3:59 PM IST (default)
    // - On-demand/manual: Next market open 9:00 AM IST (passed via options.validUntil)
    const validUntil = options.validUntil || await getWeeklyValidUntil();

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
    const stockT0 = Date.now();
    try {
      console.log(`[WEEKLY ANALYSIS] [${i + 1}/${topStocks.length}] ${stock.symbol} (score=${stock.setup_score} grade=${stock.grade} scan=${stock.scan_type})...`);
      const analysis = await generateWeeklyAnalysis(stock, options);
      results.push(analysis);
      console.log(`[WEEKLY ANALYSIS] [${i + 1}/${topStocks.length}] ${stock.symbol} done in ${Date.now() - stockT0}ms — status=${analysis?.status || '?'} verdict=${analysis?.analysis_data?.verdict?.action || '?'}`);

      // Delay between API calls to respect rate limits
      if (i < topStocks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (error) {
      console.error(`[WEEKLY ANALYSIS] [${i + 1}/${topStocks.length}] ❌ ${stock.symbol} failed in ${Date.now() - stockT0}ms: ${error.message}`);
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
  const newsContext = options.recentNews ? formatNewsForPrompt(options.recentNews) : null;

  const fundamentalText = fundamentalDataService.formatForPrompt(fundamentals);
  const scoreBreakdown = formatScoreBreakdown(stock.score_breakdown);

  // Log missing weekly data to help debug "Missing weekly momentum data" AI messages
  if (ind.weekly_change_pct == null) {
    console.warn(`[WEEKLY ANALYSIS] ${stock.symbol} - MISSING weekly_change_pct in indicators`);
  }
  if (ind.weekly_rsi == null) {
    console.warn(`[WEEKLY ANALYSIS] ${stock.symbol} - MISSING weekly_rsi in indicators`);
  }

  return `
=== WEEKLY DISCOVERY ANALYSIS ===
Analyze this stock for swing trading next week. Return the JSON structure specified below.

=== STOCK PROFILE ===
Stock: ${stock.stock_name} (${stock.symbol})
Instrument Key: ${stock.instrument_key}
Current Price: ₹${stock.current_price}
Scan Type: ${stock.scan_type} (how it was discovered by ChartInk scanner)
⚠️ SCORING RUBRIC TO USE: ${stock.scan_type === 'pullback' ? 'PULLBACK RUBRIC — use pullback factor names and inverted priorities (low volume = good, cooled RSI = good, EMA20 proximity is the primary factor)' : 'MOMENTUM RUBRIC — use momentum factor names and standard priorities'}

=== ENGINE SCORE: ${stock.setup_score}/100 | GRADE: ${stock.grade} ===
This is the automated scoring from the screening engine. Use as baseline, adjust for fundamentals.
${scoreBreakdown}

=== PRE-CALCULATED TRADING LEVELS (Structural Ladder) ===
Mode: ${levels.mode || 'N/A'}
Entry: ₹${levels.entry || 'N/A'} (basis: ${levels.entry_basis || 'N/A'}, confirmation: ${levels.entryConfirmation === 'touch' ? 'limit order fills on touch' : levels.entryConfirmation === 'touch_bounce' ? 'price must touch entry AND close above (touch + bounce)' : 'daily CLOSE must be above this level'})
Entry Range: [₹${levels.entryRange?.[0] || 'N/A'} - ₹${levels.entryRange?.[1] || 'N/A'}]
Entry Type: ${levels.entryType || 'N/A'}
⚠️ ENTRY BASIS: The entry price is derived from "${levels.entry_basis || 'N/A'}". When describing entry level, refer to this basis — do NOT attribute it to a different indicator (e.g., do not say "near daily pivot" if basis is "ema20").
Entry Window: ${levels.entryWindowDays || 3} trading days (${levels.entryWindowDays === 2 ? 'Mon-Tue' : levels.entryWindowDays === 3 ? 'Mon-Wed' : 'Mon-Thu'})
Stop Loss: ₹${levels.stop || 'N/A'}
Target 1 (50% Booking): ₹${levels.target1 || 'N/A'} [${levels.target1_basis || 'N/A'}]
Target 2 (Main Target): ₹${levels.target2 || 'N/A'} [${levels.target2_basis || 'N/A'}]
Target 3 (Trail Extension): ₹${levels.target3 || 'N/A'} (optional - may not exist)
Risk:Reward: 1:${levels.riskReward || 'N/A'}
Risk %: ${levels.riskPercent || 'N/A'}%
Reward %: ${levels.rewardPercent || 'N/A'}%
Max Hold: ${levels.maxHoldDays || 5} trading days
Week-End Rule: ${levels.weekEndRule === 'trail_or_exit' ? 'Tighten trailing stop on Friday' : levels.weekEndRule === 'hold_if_above_entry' ? 'Hold if above entry on Friday' : 'Exit if T1 not hit by Friday'}

⚠️ THESE LEVELS ARE FINAL. Do NOT recalculate or override any prices.
⚠️ ENTRY RULE: For buy_above entries, stock must CLOSE above entry level — intraday touch that reverses is NOT a valid entry.
⚠️ Use these exact prices in your beginner_guide steps and what_to_watch text.

SCAN ARCHETYPE: ${levels.archetype || (levels.entryType === 'limit' ? 'pullback' : 'trend-follow')}
This determines which strategy is PRIMARY and which is ALTERNATIVE in the strategies[] array.
- If archetype is "52w_breakout": Primary = breakout continuation entry above Friday high. Stock just broke 52W high — no overhead resistance. Alternative = retest of old 52W high level (now support) if Monday opens weak.
- If archetype is "trend-follow" or "breakout": Primary = momentum/breakout entry at the pre-calculated buy_above level. Alternative = pullback entry if stock dips to EMA20/pivot.
- If archetype is "pullback": Primary = dip-buy at the pre-calculated limit/support level. Alternative = confirmation entry if pullback deepens.
${levels.archetype === '52w_breakout' ? `\n⚠️ 52W BREAKOUT RETEST ZONE: For alternative/pullback entries on 52W breakout stocks, use the OLD 52W high level (₹${ind.high_52w || 'N/A'} ±2%) as the retest support zone, NOT the weekly pivot. The broken 52W resistance becomes new support.` : ''}
${levels.target2_basis === 'atr_extension_52w_breakout' ? '⚠️ TARGET NOTE: Target is ATR-based extension (2.5x ATR), not a structural level. This stock is at new 52W highs with no overhead resistance. Include ATH_NO_RESISTANCE warning.' : ''}

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
⚠️ IMPORTANT: If no "Promoter Pledge" line appears above, assume pledge is 0%. Do NOT infer pledge from promoter holding percentage — they are different metrics. Promoter holding is ownership %; pledge is collateral %.

=== MARKET CONTEXT ===
Trading Week: ${marketCtx.weekLabel}
${marketCtx.niftyInfo}
Key Events This Week:
${marketCtx.events.map(e => `  • ${e}`).join('\n') || '  • None identified'}

${newsContext ? newsContext : '=== RECENT NEWS ===\nNo recent news found for this stock.'}

=== OUTPUT: Return ONLY this JSON (no markdown, no extra text) ===

{
  "overall_sentiment": "BULLISH" | "BULLISH_CAUTIOUS" | "NEUTRAL" | "BEARISH",

  "sentiment_analysis": {
    "key_factors": [
      "✅ or ⚠️ or 🔴 prefixed observation (5-8 items covering technicals, fundamentals, context)"
    ]
  },

  "confidence_breakdown": {
    "base_score": 0.70,
    "adjustments": [
      { "code": "VOLUME_SURGE", "reason": "7.6x average volume confirms institutional buying", "delta": 0.10 },
      { "code": "RSI_EXTENDED", "reason": "RSI 70 approaching overbought", "delta": -0.05 }
    ],
    "final": 0.75
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
    "total": ${stock.setup_score || 'null'},
    "grade": "${stock.grade || 'N/A'}",
    "factors": ${stock.scan_type === 'pullback' ? `[
      {
        "name": "EMA20 Proximity",
        "score": "22/25",
        "status": "✅",
        "value": "0.7% from EMA20",
        "explanation": "How close price is to EMA20 support — the core pullback thesis"
      },
      {
        "name": "Volume Decline Quality",
        "score": "18/20",
        "status": "✅",
        "value": "0.6x avg",
        "explanation": "Low volume = controlled pullback, not panic selling. INVERTED: lower is better"
      },
      {
        "name": "RSI Cooling",
        "score": "15/15",
        "status": "✅",
        "value": "Daily 50.4 / Weekly 55.9",
        "explanation": "Cooled RSI in ideal pullback zone (45-52) — ready to bounce"
      },
      {
        "name": "Trend Structure",
        "score": "15/15",
        "status": "✅",
        "value": "EMA20>EMA50>SMA200",
        "explanation": "Full bullish EMA stack intact — pullback within a healthy uptrend"
      },
      {
        "name": "Risk:Reward",
        "score": "10/15",
        "status": "✅",
        "value": "1:1.5",
        "explanation": "Assessment of the pre-calculated R:R for pullback entry"
      },
      {
        "name": "Relative Strength",
        "score": "3/5",
        "status": "✅",
        "value": "+3.2% vs Nifty",
        "explanation": "Outperformer pulling back = strong candidate"
      },
      {
        "name": "ATR Tradability",
        "score": "5/5",
        "status": "✅",
        "value": "ATR 2.3%",
        "explanation": "Ideal ATR% range for swing trading"
      }
    ]` : `[
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
    ]`},
    "strengths": ["Top 3-4 strengths as strings"],
    "watch_factors": ["Top 2-3 concerns as strings"]
  },

  // NOTE: trading_plan is NOT generated by Claude — it comes from the engine.
  // The code will merge engine levels into the final analysis_data after parsing.

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
- DO NOT output a trading_plan object. Levels are handled by the engine.
- Use the pre-calculated levels EXACTLY in your beginner_guide steps and what_to_watch text.
- In beginner_guide steps:
  - For buy_above entries: "Buy only if the stock CLOSES above ₹${levels.entry} on a daily candle"
  - For limit entries: "Place limit buy order at ₹${levels.entry}"
  - Always mention: "If entry doesn't trigger by ${levels.entryWindowDays === 2 ? 'Tuesday' : levels.entryWindowDays === 3 ? 'Wednesday' : 'Thursday'} close, skip this trade"
  - Step for T1: "At T1 (₹${levels.target1}), book 50% of position. Move stop to entry price — you're now risk-free."
  - Step for T2: "At T2 (₹${levels.target2}), book 70% of remaining shares (35% of original)."
  - ${levels.target3 ? `Step for T3: "At T3 (₹${levels.target3}), book final 30% of remaining (15% of original) — FULL EXIT."` : 'If T3 is null, exit fully at T2 (book all remaining shares).'}
- Calculate max_loss in beginner_guide based on: (entry - stop) × Math.floor(100000 / entry)
- GRADE: Use the engine grade (${stock.grade}) exactly. Do NOT override.
- Keep total JSON under 3500 tokens.
- Return ONLY the JSON object. No other text.`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// CLAUDE API CALL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Call Claude API with system prompt + user message
 */
async function callClaude(userMessage, requestId) {
  const client = getAnthropicClient();

  const response = await client.messages.create({
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
    console.log(`[WEEKLY ANALYSIS] JSON parsed OK for ${stock.symbol}: verdict=${parsed.verdict?.action || '?'} confidence=${parsed.verdict?.confidence || '?'} sentiment=${parsed.overall_sentiment || '?'} factors=${parsed.sentiment_analysis?.key_factors?.length || 0}`);
  } catch (parseError) {
    console.error('[WEEKLY ANALYSIS] JSON parse failed. First 500 chars:', textContent.substring(0, 500));
    throw new Error(`JSON parse error: ${parseError.message}`);
  }

  // Build analysis_data — merge Claude's output with server-side fields
  const ind = stock.indicators || {};
  const levels = stock.levels || {};

  // Engine provides trading_plan — NOT Claude (v2)
  // Consistent naming: target1, target2, target3 (T3 is optional)
  const trading_plan = {
    entry: levels.entry,
    entry_range: levels.entryRange,
    entry_type: levels.entryType,
    entry_confirmation: levels.entryConfirmation || 'close_above',
    entry_window_days: levels.entryWindowDays || 3,
    stop_loss: levels.stop,
    target1: levels.target1,
    target1_basis: levels.target1_basis,
    target2: levels.target2,
    target2_basis: levels.target2_basis,
    target3: levels.target3 || null,  // Optional extension target
    risk_reward: levels.riskReward,
    risk_percent: levels.riskPercent,
    reward_percent: levels.rewardPercent,
    archetype: levels.archetype,
    mode: levels.mode,
    max_hold_days: levels.maxHoldDays || 5,
    week_end_rule: levels.weekEndRule || 'exit_if_no_t1',
    t1_booking_pct: levels.t1BookingPct || 50,
    post_t1_stop: levels.postT1Stop || 'move_to_entry'
  };

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
    setup_score: calculateSetupScoreTotal(parsed.setup_score, stock),
    trading_plan,  // Engine-calculated levels (v2)
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
function buildAnalysisMeta(stock, fundamentals, response, startTime, recentNews = null) {
  const levels = stock.levels || {};

  // Format news context for storage (if news exists)
  const newsContext = recentNews ? {
    scrape_date: recentNews.scrape_date,
    aggregate_sentiment: recentNews.aggregate_sentiment,
    aggregate_impact: recentNews.aggregate_impact,
    confidence_score: recentNews.confidence_score,
    headlines: recentNews.news_items?.map(item => ({
      text: item.headline,
      sentiment: item.sentiment,
      impact: item.impact
    })) || []
  } : null;

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
      // Consistent naming: target1, target2, target3 (T3 is optional)
      target1: levels.target1,                       // T1: Partial booking (50%)
      target1_basis: levels.target1_basis || null,   // 'weekly_r1', 'daily_r1', 'midpoint'
      target2: levels.target2,                       // T2: Main target
      target2_basis: levels.target2_basis || null,   // Which ladder level was used
      target3: levels.target3 || null,               // T3: Extension target (optional)
      riskReward: levels.riskReward,
      archetype: levels.archetype || null,           // '52w_breakout', 'trend-follow', etc.
      // Time rules (v2)
      entryConfirmation: levels.entryConfirmation || 'close_above',
      entryWindowDays: levels.entryWindowDays || 3,
      maxHoldDays: levels.maxHoldDays || 5,
      weekEndRule: levels.weekEndRule || 'exit_if_no_t1'
    },
    research_sources: [
      `ChartInk ${stock.scan_type} scanner`,
      'Logdhan screening engine (indicators + structural ladder)',
      `Screener.in - ${stock.symbol} ${fundamentals?.error ? '(fetch failed)' : 'consolidated'}`,
      `Engine score: ${stock.setup_score}/100 (${stock.grade})`
    ],
    source: 'weekend_screening',
    scan_type: stock.scan_type,
    // News context - null if no recent news found for this stock
    news_context: newsContext
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Format recent news for the prompt (stub — DailyNewsStock removed, globalMarketIntel handles news for daily picks)
 * @param {Object} newsData - News data (currently always null)
 * @returns {string|null} Always returns null
 */
function formatNewsForPrompt(newsData) {
  return null;
}

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
 * Calculate setup_score total from individual factor scores
 * Parses scores like "19/20" and sums them up
 */
function calculateSetupScoreTotal(parsedSetupScore, stock) {
  // If no setup_score from AI, return stock defaults
  if (!parsedSetupScore) {
    return {
      total: stock.setup_score || null,
      grade: stock.grade || 'N/A'
    };
  }

  // If factors exist, calculate total from them
  if (parsedSetupScore.factors && Array.isArray(parsedSetupScore.factors)) {
    let calculatedTotal = 0;

    for (const factor of parsedSetupScore.factors) {
      if (factor.score && typeof factor.score === 'string') {
        // Parse "19/20" format
        const match = factor.score.match(/^(\d+)\/\d+$/);
        if (match) {
          calculatedTotal += parseInt(match[1], 10);
        }
      }
    }

    // Calculate grade based on total
    let calculatedGrade = 'D';
    if (calculatedTotal >= 80) calculatedGrade = 'A+';
    else if (calculatedTotal >= 70) calculatedGrade = 'A';
    else if (calculatedTotal >= 60) calculatedGrade = 'B+';
    else if (calculatedTotal >= 50) calculatedGrade = 'B';
    else if (calculatedTotal >= 40) calculatedGrade = 'C';

    return {
      ...parsedSetupScore,
      total: calculatedTotal,
      grade: calculatedGrade
    };
  }

  // Fallback: use parsed total or stock default
  return {
    ...parsedSetupScore,
    total: parsedSetupScore.total ?? stock.setup_score ?? null,
    grade: parsedSetupScore.grade || stock.grade || 'N/A'
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
 * Get valid_until for weekly analysis (next Friday 3:29:59 PM IST = 09:59:59 AM UTC)
 * Weekend screening always targets NEXT Friday since trades are for the upcoming week.
 */
async function getWeeklyValidUntil() {
  try {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;

    // Shift to IST to read correct calendar day/day-of-week
    const istNow = new Date(now.getTime() + istOffset);

    // Find next Friday from IST perspective (always next, never current)
    const dayOfWeek = istNow.getUTCDay();
    let daysToFriday = (5 - dayOfWeek + 7) % 7;
    if (daysToFriday === 0) daysToFriday = 7; // If today is Friday, target next Friday

    const targetFriday = new Date(istNow);
    targetFriday.setUTCDate(targetFriday.getUTCDate() + daysToFriday);

    // Extract IST calendar date components from the shifted Date
    const year = targetFriday.getUTCFullYear();
    const month = targetFriday.getUTCMonth();
    const day = targetFriday.getUTCDate();

    // Build UTC timestamp for 3:29:59 PM IST on that calendar day
    // Date.UTC gives ms for the given components in UTC, then subtract IST offset
    const utcMs = Date.UTC(year, month, day, 15, 29, 59, 0) - istOffset;
    return new Date(utcMs);

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
  if (day === 6 && hour >= 10) {
    console.log(`[WEEKLY ANALYSIS] shouldRunWeeklyAnalysis: YES (Saturday ${hour}:xx IST)`);
    return true;
  }

  // Sunday before 6 PM IST (before 12:30 PM UTC)
  if (day === 0 && hour < 13) {
    console.log(`[WEEKLY ANALYSIS] shouldRunWeeklyAnalysis: YES (Sunday ${hour}:xx IST)`);
    return true;
  }

  console.log(`[WEEKLY ANALYSIS] shouldRunWeeklyAnalysis: NO (day=${day} hour=${hour} IST — outside Sat 4PM-Sun 6PM window)`);
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