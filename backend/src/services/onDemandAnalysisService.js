/**
 * On-Demand Analysis Service
 *
 * Provides instant stock classification and analysis routing:
 * 1. Fetches technical indicators
 * 2. Classifies stock as BULLISH SETUP vs NOT A SETUP (pure math, no AI)
 * 3. Routes bullish setups through full Claude analysis pipeline
 * 4. Returns instant "quick reject" for non-setups (no AI cost)
 *
 * Market Hours Logic:
 * - Quick reject: Always allowed (pure math, ~3 seconds)
 * - Full analysis: Only after market hours (3:30 PM onwards)
 */

import { v4 as uuidv4 } from 'uuid';
import Stock from '../models/stock.js';
import StockAnalysis from '../models/stockAnalysis.js';
import technicalDataService from './technicalData.service.js';
import { enrichStock, mapToInstrumentKey } from './stockEnrichmentService.js';
import { generateWeeklyAnalysis } from './weeklyAnalysisService.js';
import fundamentalDataService from './fundamentalDataService.js';
import MarketHoursUtil from '../utils/marketHours.js';
import { round2 } from '../engine/helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CLASSIFICATION LOGIC (Pure Math - No AI)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify a stock for analysis based on technical indicators
 * Returns whether it's a bullish setup and which scan_type to use
 *
 * @param {Object} indicators - Technical indicators from getClassificationData()
 * @returns {Object} { isSetup: boolean, scanType?: string, reason?: string, message?: string }
 */
function classifyForAnalysis(indicators) {
  const { price, ema20, ema50, sma200, rsi, weeklyRsi, high52W } = indicators;

  // Validate required data
  if (!price || price <= 0) {
    return {
      isSetup: false,
      reason: 'insufficient_data',
      message: 'Unable to fetch current price data for this stock.'
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REJECTION GATES (NOT A SETUP)
  // ═══════════════════════════════════════════════════════════════════════════

  // Gate 1: Below 200 SMA → NOT A SETUP (long-term downtrend)
  if (sma200 && price < sma200) {
    const distanceBelow = round2(((sma200 - price) / sma200) * 100);
    return {
      isSetup: false,
      reason: 'below_200sma',
      message: `Stock is trading ${distanceBelow}% below its 200-day MA (₹${round2(sma200)}). Not a swing buy setup.`,
      details: { sma200: round2(sma200), distanceBelow }
    };
  }

  // Gate 2: RSI too low (< 35) → weak momentum, not a buy setup
  if (rsi && rsi < 35) {
    return {
      isSetup: false,
      reason: 'weak_momentum',
      message: `Daily RSI at ${round2(rsi)} indicates weak momentum. Wait for recovery above 45 before considering entry.`,
      details: { rsi: round2(rsi) }
    };
  }

  // Gate 3: Price below both EMAs → short-term trend broken
  if (ema50 && ema20 && price < ema50 && price < ema20) {
    return {
      isSetup: false,
      reason: 'trend_broken',
      message: `Stock is below both 20-day (₹${round2(ema20)}) and 50-day (₹${round2(ema50)}) MAs. Short-term trend is down.`,
      details: { ema20: round2(ema20), ema50: round2(ema50) }
    };
  }

  // Gate 4: Weekly RSI overbought (> 72) → too extended for new entry
  if (weeklyRsi && weeklyRsi > 72) {
    return {
      isSetup: false,
      reason: 'overbought',
      message: `Weekly RSI at ${round2(weeklyRsi)} indicates stock is overextended. Wait for pullback before considering entry.`,
      details: { weeklyRsi: round2(weeklyRsi) }
    };
  }

  // Gate 5: Daily RSI overbought (> 72) → too extended for new entry
  if (rsi && rsi > 72) {
    return {
      isSetup: false,
      reason: 'overbought_daily',
      message: `Daily RSI at ${round2(rsi)} indicates stock is overextended. Wait for pullback to EMA20 before considering entry.`,
      details: { rsi: round2(rsi) }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BULLISH CLASSIFICATION (Determine scan_type)
  // Order matters: most specific patterns first, fallback last
  // ═══════════════════════════════════════════════════════════════════════════

  // 52W breakout (within 0.5% of high) → A+ Momentum
  if (high52W && price >= high52W * 0.995) {
    return {
      isSetup: true,
      scanType: 'a_plus_momentum',
      message: 'Stock is at 52-week high - strong breakout setup.'
    };
  }

  // Near 52W high (within 7%) → Breakout
  if (high52W && price >= high52W * 0.93) {
    return {
      isSetup: true,
      scanType: 'breakout',
      message: 'Stock is near 52-week high - breakout setup.'
    };
  }

  // Strong momentum (above all MAs, RSI 55+) - check BEFORE pullback
  // This catches stocks that are trending strongly above all MAs
  if (ema20 && ema50 && sma200 && rsi &&
      price > ema20 && price > ema50 && price > sma200 && rsi >= 55) {
    return {
      isSetup: true,
      scanType: 'momentum',
      message: 'Stock above all key MAs with healthy RSI - momentum setup.'
    };
  }

  // Pullback to EMA20 (price within 3% of EMA20, above EMA50, but NOT above EMA20)
  // This is a stock that has pulled back TO the EMA20 support zone
  if (ema20 && ema50 && price > ema50) {
    const distFromEma20 = ((price - ema20) / ema20) * 100;
    // Pullback: price is AT or BELOW EMA20 (within 3% below), still above EMA50
    if (distFromEma20 <= 3 && distFromEma20 >= -5) {
      return {
        isSetup: true,
        scanType: 'pullback',
        message: 'Stock at EMA20 support - pullback buy setup.'
      };
    }
  }

  // Fallback: Above 200 SMA but no clear pattern → Consolidation breakout
  if (sma200 && price > sma200) {
    return {
      isSetup: true,
      scanType: 'consolidation_breakout',
      message: 'Stock above 200-day MA - potential consolidation breakout.'
    };
  }

  // Should not reach here given Gate 1, but safety net
  return {
    isSetup: false,
    reason: 'unclear',
    message: 'No clear setup pattern detected. Monitor for better entry conditions.'
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKET HOURS & VALIDITY LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if full analysis should be blocked (during market hours)
 * Quick reject is always allowed
 */
async function shouldBlockFullAnalysis() {
  const session = await MarketHoursUtil.getTradingSession();

  // Block full analysis during regular/pre-market/post-market hours on trading days
  // Market: 9:00 AM - 4:00 PM IST (including post-market)
  if (session.session === 'regular' || session.session === 'pre-market' || session.session === 'post-market') {
    return {
      blocked: true,
      message: 'Full analysis available after 4 PM IST when closing data is finalized. Quick classification still works.',
      session: session.session
    };
  }

  return { blocked: false };
}

/**
 * Calculate valid_until time based on analysis type and market hours
 *
 * @param {boolean} isQuickReject - Whether this is a quick reject (vs full analysis)
 * @returns {Promise<Date>} UTC date for valid_until
 */
async function getValidUntil(isQuickReject) {
  const now = new Date();
  const istNow = MarketHoursUtil.toIST(now);
  const session = await MarketHoursUtil.getTradingSession();
  const duringMarketHours = session.session === 'regular' || session.session === 'pre-market';

  if (isQuickReject && duringMarketHours) {
    // During market hours: quick reject valid until today 4 PM only
    // (stock status could change by close)
    return MarketHoursUtil.getUtcForIstTime({
      baseDate: istNow,
      hour: 16,
      minute: 0,
      second: 0
    });
  }

  if (isQuickReject) {
    // After market hours: quick reject valid until next trading day 9 AM
    // (pre-market could shift conditions)
    const nextTradingDay = await MarketHoursUtil.getNextTradingDay(istNow);
    return MarketHoursUtil.getUtcForIstTime({
      baseDate: nextTradingDay,
      hour: 9,
      minute: 0,
      second: 0
    });
  }

  // Full analysis: use existing getValidUntilTime() (next market close)
  return await MarketHoursUtil.getValidUntilTime(now);
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUICK REJECT RESPONSE BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a quick reject response for non-setup stocks
 * Returns a StockAnalysis-compatible structure without AI call
 */
function buildQuickRejectResponse(classification, indicators, stockInfo) {
  const { reason, message, details } = classification;

  // Build levels to watch based on rejection reason
  const levelsToWatch = buildLevelsToWatch(reason, indicators);

  // Build key message with actionable insight
  const keyMessage = buildKeyMessage(reason, message, indicators);

  return {
    // Verdict (compatible with existing UI)
    verdict: {
      action: 'NO_TRADE',
      confidence: 0.9,
      one_liner: message
    },

    // Setup score (F grade for non-setups)
    setup_score: {
      total: 0,
      grade: 'F',
      breakdown: []
    },

    // No trading plan for non-setups
    trading_plan: null,

    // Quick reject details
    quick_reject: {
      reason,
      current_price: round2(indicators.price),
      key_message: keyMessage,
      levels_to_watch: levelsToWatch,
      indicators: {
        rsi: indicators.rsi ? round2(indicators.rsi) : null,
        weekly_rsi: indicators.weeklyRsi ? round2(indicators.weeklyRsi) : null,
        ema20: indicators.ema20 ? round2(indicators.ema20) : null,
        ema50: indicators.ema50 ? round2(indicators.ema50) : null,
        sma200: indicators.sma200 ? round2(indicators.sma200) : null,
        high_52w: indicators.high52W ? round2(indicators.high52W) : null
      },
      ...details
    },

    // Stock info
    stock_info: stockInfo
  };
}

/**
 * Build levels to watch based on rejection reason
 */
function buildLevelsToWatch(reason, indicators) {
  const { price, ema20, ema50, sma200, weeklyR1, weeklyS1, dailyR1, dailyS1, todaysLow } = indicators;

  switch (reason) {
    case 'below_200sma':
      return {
        resistance: ema20 ? round2(ema20) : null,
        support: dailyS1 || (todaysLow ? round2(todaysLow * 0.98) : null),
        trend_change: sma200 ? round2(sma200) : null,
        watch_for: `Price to reclaim ₹${sma200 ? round2(sma200) : 'N/A'} (200-day MA)`
      };

    case 'weak_momentum':
      return {
        resistance: ema20 ? round2(ema20) : null,
        support: dailyS1 || weeklyS1 || null,
        recovery_signal: 'RSI crossing above 45',
        watch_for: 'RSI recovery above 45 with price holding support'
      };

    case 'trend_broken':
      return {
        resistance: ema20 ? round2(ema20) : null,
        major_resistance: ema50 ? round2(ema50) : null,
        support: dailyS1 || weeklyS1 || null,
        watch_for: `Price to reclaim ₹${ema20 ? round2(ema20) : 'N/A'} (20-day MA)`
      };

    case 'overbought':
    case 'overbought_daily':
      return {
        pullback_zone: ema20 ? round2(ema20) : null,
        deeper_support: ema50 ? round2(ema50) : null,
        current_resistance: dailyR1 || weeklyR1 || null,
        watch_for: `Pullback to ₹${ema20 ? round2(ema20) : 'N/A'} (EMA20) for better entry`
      };

    default:
      return {
        resistance: dailyR1 || weeklyR1 || null,
        support: dailyS1 || weeklyS1 || null,
        watch_for: 'Clear setup pattern to emerge'
      };
  }
}

/**
 * Build actionable key message based on rejection reason
 */
function buildKeyMessage(reason, baseMessage, indicators) {
  const { sma200, ema20, rsi, weeklyRsi } = indicators;

  switch (reason) {
    case 'below_200sma':
      return `${baseMessage} Watch for price to reclaim ₹${sma200 ? round2(sma200) : 'the 200-day MA'} before considering entry.`;

    case 'weak_momentum':
      return `${baseMessage} Current RSI: ${rsi ? round2(rsi) : 'N/A'}. Wait for bullish momentum to return.`;

    case 'trend_broken':
      return `${baseMessage} Wait for price to reclaim the 20-day MA (₹${ema20 ? round2(ema20) : 'N/A'}) before considering entry.`;

    case 'overbought':
      return `${baseMessage} Current weekly RSI: ${weeklyRsi ? round2(weeklyRsi) : 'N/A'}. ` +
             `Wait for pullback to EMA20 (₹${ema20 ? round2(ema20) : 'N/A'}) for better risk/reward.`;

    case 'overbought_daily':
      return `${baseMessage} Wait for pullback to EMA20 (₹${ema20 ? round2(ema20) : 'N/A'}) for better entry.`;

    default:
      return baseMessage;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Main entry point for on-demand stock analysis
 *
 * @param {string} instrumentKey - Stock instrument key
 * @param {string} userId - User ID for tracking
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Analysis result or quick reject
 */
export async function analyze(instrumentKey, userId, options = {}) {
  const requestId = uuidv4().slice(0, 8);
  const startTime = Date.now();
  const {
    stock_name,
    stock_symbol,
    forceFresh = false,
    sendNotification = true,
    skipNotification = false
  } = options;

  console.log(`\n[ON-DEMAND] [${requestId}] ═══════════════════════════════════════════════`);
  console.log(`[ON-DEMAND] [${requestId}] Analyzing: ${stock_symbol || instrumentKey}`);

  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 1: Get stock info
    // ═══════════════════════════════════════════════════════════════════════════
    let stockInfo;
    if (stock_name && stock_symbol) {
      stockInfo = { instrument_key: instrumentKey, stock_name, trading_symbol: stock_symbol };
    } else {
      const stock = await Stock.findOne({ instrument_key: instrumentKey }).lean();
      if (!stock) {
        console.log(`[ON-DEMAND] [${requestId}] ❌ Stock not found: ${instrumentKey}`);
        return { success: false, error: 'Stock not found' };
      }
      stockInfo = {
        instrument_key: instrumentKey,
        stock_name: stock.name,
        trading_symbol: stock.trading_symbol
      };
    }

    console.log(`[ON-DEMAND] [${requestId}] Stock: ${stockInfo.stock_name} (${stockInfo.trading_symbol})`);

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 2: Check for existing valid analysis (cache)
    // ═══════════════════════════════════════════════════════════════════════════
    if (!forceFresh) {
      const existingAnalysis = await StockAnalysis.findValidAnalysis(instrumentKey, 'swing');
      if (existingAnalysis) {
        console.log(`[ON-DEMAND] [${requestId}] ✅ Returning cached analysis (valid until ${existingAnalysis.valid_until})`);
        return {
          success: true,
          data: existingAnalysis,
          cached: true,
          fromQuickReject: !!existingAnalysis.analysis_data?.quick_reject
        };
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 3: Fetch technical indicators for classification
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`[ON-DEMAND] [${requestId}] Fetching technical indicators...`);
    const indicators = await technicalDataService.getClassificationData(
      stockInfo.trading_symbol,
      instrumentKey
    );

    if (indicators.error) {
      console.log(`[ON-DEMAND] [${requestId}] ❌ Failed to fetch indicators: ${indicators.error}`);
      return { success: false, error: `Failed to fetch technical data: ${indicators.error}` };
    }

    console.log(`[ON-DEMAND] [${requestId}] Indicators: Price=₹${indicators.price}, RSI=${indicators.rsi}, WeeklyRSI=${indicators.weeklyRsi}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 4: Classify the stock
    // ═══════════════════════════════════════════════════════════════════════════
    const classification = classifyForAnalysis(indicators);
    console.log(`[ON-DEMAND] [${requestId}] Classification: isSetup=${classification.isSetup}, ` +
      `${classification.isSetup ? `scanType=${classification.scanType}` : `reason=${classification.reason}`}`);

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5A: NOT A SETUP → Return quick reject (instant, no AI)
    // ═══════════════════════════════════════════════════════════════════════════
    if (!classification.isSetup) {
      console.log(`[ON-DEMAND] [${requestId}] ⚡ Quick reject: ${classification.reason}`);

      const quickRejectData = buildQuickRejectResponse(classification, indicators, stockInfo);
      const validUntil = await getValidUntil(true);

      // Save to StockAnalysis for caching
      const analysis = await StockAnalysis.findOneAndUpdate(
        {
          instrument_key: instrumentKey,
          analysis_type: 'swing'
        },
        {
          instrument_key: instrumentKey,
          stock_name: stockInfo.stock_name,
          stock_symbol: stockInfo.trading_symbol,
          analysis_type: 'swing',
          current_price: indicators.price,
          status: 'completed',
          analysis_data: {
            schema_version: '1.5',
            symbol: stockInfo.trading_symbol,
            analysis_type: 'swing',
            quick_reject: quickRejectData.quick_reject,
            verdict: quickRejectData.verdict,
            setup_score: quickRejectData.setup_score,
            strategies: [] // No strategies for quick reject
          },
          valid_until: validUntil,
          last_validated_at: new Date(),
          progress: {
            percentage: 100,
            current_step: 'Quick classification complete',
            steps_completed: 2,
            total_steps: 2,
            estimated_time_remaining: 0,
            last_updated: new Date()
          }
        },
        { upsert: true, new: true, runValidators: false }
      );

      const duration = Date.now() - startTime;
      console.log(`[ON-DEMAND] [${requestId}] ✅ Quick reject complete in ${duration}ms`);

      return {
        success: true,
        data: analysis,
        cached: false,
        fromQuickReject: true,
        classification
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 5B: BULLISH SETUP → Check if full analysis is allowed
    // ═══════════════════════════════════════════════════════════════════════════
    const blockCheck = await shouldBlockFullAnalysis();
    if (blockCheck.blocked) {
      console.log(`[ON-DEMAND] [${requestId}] ⏳ Full analysis blocked: ${blockCheck.message}`);

      // Return classification info + blocking message
      return {
        success: true,
        blocked: true,
        message: blockCheck.message,
        classification,
        stockInfo,
        indicators: {
          price: indicators.price,
          rsi: indicators.rsi,
          weeklyRsi: indicators.weeklyRsi
        }
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: Run full analysis pipeline (enrich → fundamentals → Claude)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`[ON-DEMAND] [${requestId}] Running full analysis pipeline...`);

    // Create pending analysis record
    await StockAnalysis.findOneAndUpdate(
      { instrument_key: instrumentKey, analysis_type: 'swing' },
      {
        instrument_key: instrumentKey,
        stock_name: stockInfo.stock_name,
        stock_symbol: stockInfo.trading_symbol,
        analysis_type: 'swing',
        status: 'in_progress',
        progress: {
          percentage: 10,
          current_step: 'Enriching stock data',
          steps_completed: 1,
          total_steps: 8,
          estimated_time_remaining: 45,
          last_updated: new Date()
        }
      },
      { upsert: true, new: true }
    );

    // Enrich stock with full technical data + levels + score
    const chartinkStock = {
      nsecode: stockInfo.trading_symbol,
      name: stockInfo.stock_name,
      close: indicators.price,
      volume: 0, // Will be fetched by enrichStock
      scan_type: classification.scanType
    };

    const enrichedStock = await enrichStock(chartinkStock, 0, false);

    if (!enrichedStock || enrichedStock.eliminated) {
      console.log(`[ON-DEMAND] [${requestId}] ❌ Stock eliminated during enrichment: ${enrichedStock?.eliminationReason || 'Unknown'}`);

      // Return as quick reject
      return {
        success: true,
        eliminated: true,
        reason: enrichedStock?.eliminationReason || 'Failed enrichment',
        stockInfo
      };
    }

    // Update progress
    await StockAnalysis.updateOne(
      { instrument_key: instrumentKey, analysis_type: 'swing' },
      {
        'progress.percentage': 30,
        'progress.current_step': 'Fetching fundamental data',
        'progress.steps_completed': 3,
        'progress.last_updated': new Date()
      }
    );

    // Fetch fundamental data
    let fundamentals = null;
    try {
      fundamentals = await fundamentalDataService.fetchFundamentalData(stockInfo.trading_symbol);
    } catch (err) {
      console.warn(`[ON-DEMAND] [${requestId}] ⚠️ Failed to fetch fundamentals: ${err.message}`);
    }

    // Update progress
    await StockAnalysis.updateOne(
      { instrument_key: instrumentKey, analysis_type: 'swing' },
      {
        'progress.percentage': 50,
        'progress.current_step': 'Generating AI analysis',
        'progress.steps_completed': 5,
        'progress.last_updated': new Date()
      }
    );

    // Generate Claude analysis
    const analysis = await generateWeeklyAnalysis(enrichedStock, {
      fundamentals,
      marketContext: null // Will be generated by weeklyAnalysisService
    });

    const duration = Date.now() - startTime;
    console.log(`[ON-DEMAND] [${requestId}] ✅ Full analysis complete in ${duration}ms`);

    return {
      success: true,
      data: analysis,
      cached: false,
      fromQuickReject: false,
      classification
    };

  } catch (error) {
    console.error(`[ON-DEMAND] [${requestId}] ❌ Error:`, error.message);

    // Mark as failed if there's a pending analysis
    await StockAnalysis.updateOne(
      { instrument_key: instrumentKey, analysis_type: 'swing', status: 'in_progress' },
      {
        status: 'failed',
        'progress.current_step': `Failed: ${error.message}`,
        'progress.last_updated': new Date()
      }
    );

    return {
      success: false,
      error: error.message
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  analyze,
  classifyForAnalysis,
  shouldBlockFullAnalysis,
  getValidUntil
};
