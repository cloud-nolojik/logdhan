/**
 * On-Demand Analysis Service
 *
 * Provides instant deterministic stock analysis:
 * 1. Fetches technical indicators
 * 2. Classifies stock as BULLISH SETUP vs NOT A SETUP (pure math)
 * 3. For bullish setups: enriches with levels/scoring → builds deterministic card
 * 4. For non-setups: returns instant quick reject
 *
 * No AI. No validity period. Caches by dataAsOf (last completed trading day).
 * Recomputes when new closing data is available.
 */

import { v4 as uuidv4 } from 'uuid';
import Stock from '../models/stock.js';
import StockAnalysis from '../models/stockAnalysis.js';
import Notification from '../models/notification.js';
import technicalDataService from './technicalData.service.js';
import { enrichStock } from './stockEnrichmentService.js';
import { firebaseService } from './firebase/firebase.service.js';
import MarketHoursUtil from '../utils/marketHours.js';
import { round2 } from '../engine/helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CLASSIFICATION LOGIC (Pure Math)
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
  if (ema20 && ema50 && sma200 && rsi &&
      price > ema20 && price > ema50 && price > sma200 && rsi >= 55) {
    return {
      isSetup: true,
      scanType: 'momentum',
      message: 'Stock above all key MAs with healthy RSI - momentum setup.'
    };
  }

  // Pullback to EMA20 (price within 3% of EMA20, above EMA50)
  if (ema20 && ema50 && price > ema50) {
    const distFromEma20 = ((price - ema20) / ema20) * 100;
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
// QUICK REJECT RESPONSE BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a quick reject response for non-setup stocks
 * Returns a StockAnalysis-compatible structure without AI call
 */
function buildQuickRejectResponse(classification, indicators, stockInfo) {
  const { reason, message, details } = classification;

  const levelsToWatch = buildLevelsToWatch(reason, indicators);
  const keyMessage = buildKeyMessage(reason, message, indicators);

  return {
    verdict: {
      action: 'NO_TRADE',
      confidence: 0.9,
      one_liner: message
    },

    setup_score: {
      total: 0,
      grade: 'F',
      breakdown: []
    },

    trading_plan: null,

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
// DETERMINISTIC ANALYSIS CARD BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

const SCAN_LABELS = {
  a_plus_momentum: 'A+ Momentum',
  momentum: 'Momentum',
  breakout: 'Breakout',
  pullback: 'Pullback',
  consolidation_breakout: 'Consolidation Breakout'
};

/**
 * Build deterministic analysis card from enriched stock data.
 * Replaces AI-generated analysis with pure math/template output.
 * Output matches v1.5 AnalysisData schema (ApiService.kt:604-716).
 *
 * @param {Object} enrichedStock - from enrichStock() with debug=true
 * @param {Object} classification - from classifyForAnalysis()
 * @param {string} dataAsOf - "YYYY-MM-DD" date of the closing data used
 * @returns {Object} analysis_data matching v1.5 schema
 */
function buildAnalysisCard(enrichedStock, classification, dataAsOf) {
  const {
    symbol, stock_name, current_price, scan_type,
    setup_score, grade, score_breakdown, levels, indicators
  } = enrichedStock;

  const hasValidLevels = levels && levels.entry && !levels.noData;

  // Verdict action from grade
  let action;
  if (!hasValidLevels) {
    action = 'WAIT';
  } else if (grade === 'A+' || grade === 'A' || grade === 'B+') {
    action = 'BUY';
  } else if (grade === 'B') {
    action = 'WAIT';
  } else {
    action = 'SKIP';
  }

  const scanLabel = SCAN_LABELS[scan_type] || scan_type;

  return {
    schema_version: '1.5',
    symbol,
    analysis_type: 'swing',
    generated_at_ist: new Date().toISOString(),

    verdict: {
      action,
      confidence: round2(setup_score / 100),
      one_liner: `${scanLabel} setup | Grade ${grade} | ${classification.message}`
    },

    setup_score: {
      total: setup_score,
      grade,
      factors: (score_breakdown || []).map(b => ({
        name: b.factor,
        score: `${b.points}/${b.max}`,
        status: b.points >= b.max * 0.7 ? '✅'
             : b.points >= b.max * 0.4 ? '⚠'
             : '❌',
        value: b.value != null ? String(b.value) : null,
        explanation: b.reason
      })),
      strengths: (score_breakdown || [])
        .filter(b => b.points >= b.max * 0.7)
        .map(b => b.reason),
      watch_factors: (score_breakdown || [])
        .filter(b => b.points < b.max * 0.4)
        .map(b => b.reason)
    },

    trading_plan: hasValidLevels ? {
      entry: levels.entry,
      entry_range: levels.entryRange || null,
      stop_loss: levels.stop,
      target1: levels.target1,
      target1_basis: levels.target1_basis || null,
      target2: levels.target2,
      target2_basis: levels.target2_basis || null,
      target3: levels.target3 || null,
      target: levels.target2,  // backward compat
      risk_reward: levels.riskReward,
      risk_percent: levels.riskPercent,
      reward_percent: levels.rewardPercent
    } : null,

    beginner_guide: {
      what_stock_is_doing: buildWhatStockIsDoing(scan_type, indicators, current_price),
      why_this_is_interesting: classification.message,
      steps_to_trade: hasValidLevels ? [
        `Set buy order at ₹${round2(levels.entry)}`,
        `Place stop loss at ₹${round2(levels.stop)} (${round2(levels.riskPercent)}% risk)`,
        `Book 50% at T1 ₹${round2(levels.target1)}`,
        `Trail rest to T2 ₹${round2(levels.target2)}`,
        levels.weekEndRule === 'exit_if_no_t1'
          ? 'Exit by Friday if T1 not hit'
          : 'Hold through week-end if T1 hit'
      ] : ['Wait for clearer setup before entering'],
      if_it_fails: hasValidLevels ? {
        max_loss: `₹${round2(levels.entry - levels.stop)} per share`,
        loss_percent: `${round2(levels.riskPercent)}%`,
        why_okay: `Risk:Reward is 1:${round2(levels.riskReward)} — you risk ${round2(levels.riskPercent)}% to gain ${round2(levels.rewardPercent)}%`
      } : null
    },

    what_to_watch: {
      if_bought: hasValidLevels
        ? `Book 50% at T1 (₹${round2(levels.target1)}). Move stop to entry after T1 hit. Final target ₹${round2(levels.target2)}.`
        : null,
      if_waiting: `Watch for price near ₹${round2(levels?.entry || current_price)}. ` +
        `${indicators?.rsi ? `RSI is ${round2(indicators.rsi)} — ` : ''}` +
        `${scan_type === 'pullback' ? 'look for bounce off EMA20 support.' : 'look for breakout confirmation with volume.'}`
    },

    warnings: buildWarnings(indicators, levels),

    strategies: []  // always empty array for backward compat
  };
}

function buildWhatStockIsDoing(scanType, indicators, price) {
  switch (scanType) {
    case 'a_plus_momentum':
      return `Stock is at 52-week highs with strong momentum. Trading at ₹${round2(price)}.`;
    case 'breakout':
      return `Stock is near 52-week highs, setting up for a breakout. RSI ${round2(indicators?.rsi || 0)}.`;
    case 'pullback':
      return `Stock in uptrend has pulled back to EMA20 support (₹${round2(indicators?.ema20 || 0)}). This is a buy-the-dip zone.`;
    case 'momentum':
      return `Stock is trending above all key moving averages with healthy RSI (${round2(indicators?.rsi || 0)}).`;
    case 'consolidation_breakout':
      return `Stock is above 200-day MA and consolidating. Potential breakout developing.`;
    default:
      return `Stock setup detected at ₹${round2(price)}.`;
  }
}

function buildWarnings(indicators, levels) {
  const warnings = [];

  if (indicators?.volume_vs_avg && indicators.volume_vs_avg < 0.8) {
    warnings.push({
      code: 'LOW_VOLUME',
      severity: 'medium',
      message: `Volume is ${round2(indicators.volume_vs_avg)}x average — below normal conviction`,
      mitigation: 'Wait for volume confirmation before entering'
    });
  }

  if (indicators?.rsi && indicators.rsi > 65) {
    warnings.push({
      code: 'RSI_ELEVATED',
      severity: 'low',
      message: `RSI at ${round2(indicators.rsi)} is elevated — stock is running hot`,
      mitigation: 'Consider smaller position size or wait for pullback'
    });
  }

  if (indicators?.atr_pct && indicators.atr_pct > 4) {
    warnings.push({
      code: 'HIGH_VOLATILITY',
      severity: 'medium',
      message: `ATR% is ${round2(indicators.atr_pct)}% — high volatility means wider swings`,
      mitigation: 'Use smaller position size to manage risk'
    });
  }

  if (levels?.riskReward && levels.riskReward < 1.5) {
    warnings.push({
      code: 'LOW_RR',
      severity: 'high',
      message: `Risk:Reward is 1:${round2(levels.riskReward)} — below ideal 1:2 threshold`,
      mitigation: 'Consider skipping this setup or waiting for better entry'
    });
  }

  return warnings; // always array, never null
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send in-app notification + Firebase push when analysis completes.
 * Mirrors aiAnalyze.service.js sendAnalysisCompleteNotification() behavior.
 * Failures are swallowed — notification should never break analysis.
 */
async function sendAnalysisNotification(userId, analysisRecord) {
  try {
    if (!userId) return;

    const stockName = analysisRecord.stock_name || analysisRecord.stock_symbol;
    const verdict = analysisRecord.analysis_data?.verdict?.action || 'DONE';
    const grade = analysisRecord.analysis_data?.setup_score?.grade || '';

    const message = verdict === 'NO_TRADE'
      ? `${stockName} — Not a swing setup right now.`
      : `${stockName} analysis ready! Verdict: ${verdict}${grade ? ` (Grade ${grade})` : ''}`;

    // In-app notification
    await Notification.createNotification({
      userId,
      title: 'Analysis Complete',
      message,
      type: 'ai_review',
      relatedStock: {
        trading_symbol: analysisRecord.stock_symbol,
        instrument_key: analysisRecord.instrument_key
      },
      metadata: {
        analysisId: analysisRecord._id.toString(),
        analysisType: analysisRecord.analysis_type
      }
    });

    // Firebase push
    await firebaseService.sendToUser(
      userId,
      'Analysis Complete',
      message,
      {
        type: 'AI_ANALYSIS_COMPLETE',
        stockSymbol: analysisRecord.stock_symbol,
        analysisId: analysisRecord._id.toString(),
        route: '/analysis'
      }
    );
  } catch (error) {
    console.error(`[ON-DEMAND] Error sending notification:`, error.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Main entry point for on-demand stock analysis.
 * Fully deterministic — no AI, no market hours blocking.
 * Caches by dataAsOf: same closing data = same result.
 *
 * @param {string} instrumentKey - Stock instrument key
 * @param {string} userId - User ID for tracking
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Analysis result or quick reject
 */
export async function analyze(instrumentKey, userId, options = {}) {
  const requestId = uuidv4().slice(0, 8);
  const startTime = Date.now();
  const { stock_name, stock_symbol, sendNotification } = options;

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
    // STEP 2: dataAsOf freshness check (replaces old valid_until cache)
    // Same closing data = same result, return cached
    // ═══════════════════════════════════════════════════════════════════════════
    const dataAsOf = await MarketHoursUtil.getLastCompletedTradingDay();
    const existing = await StockAnalysis.findOne({
      instrument_key: instrumentKey,
      analysis_type: 'swing',
      status: 'completed',
      'analysis_meta.data_as_of_ist': dataAsOf
    }).lean();

    if (existing) {
      console.log(`[ON-DEMAND] [${requestId}] ✅ Returning cached analysis (dataAsOf=${dataAsOf})`);
      return {
        success: true,
        data: existing,
        cached: true,
        fromQuickReject: !!existing.analysis_data?.quick_reject
      };
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
    // STEP 5: NOT A SETUP → Quick reject, save to DB, return
    // ═══════════════════════════════════════════════════════════════════════════
    if (!classification.isSetup) {
      console.log(`[ON-DEMAND] [${requestId}] ⚡ Quick reject: ${classification.reason}`);

      const quickRejectData = buildQuickRejectResponse(classification, indicators, stockInfo);

      const analysis = await StockAnalysis.findOneAndUpdate(
        { instrument_key: instrumentKey, analysis_type: 'swing' },
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
            warnings: [],
            strategies: []
          },
          analysis_meta: { data_as_of_ist: dataAsOf, source: 'on_demand_deterministic' },
          valid_until: null,
          last_validated_at: new Date(),
          progress: {
            percentage: 100,
            current_step: 'Quick classification complete',
            steps_completed: 1,
            total_steps: 1,
            estimated_time_remaining: 0,
            last_updated: new Date()
          }
        },
        { upsert: true, new: true, runValidators: false }
      );

      const duration = Date.now() - startTime;
      console.log(`[ON-DEMAND] [${requestId}] ✅ Quick reject complete in ${duration}ms`);

      if (sendNotification && userId) {
        sendAnalysisNotification(userId, analysis).catch(() => {});
      }

      return {
        success: true,
        data: analysis,
        cached: false,
        fromQuickReject: true,
        classification
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // STEP 6: BULLISH SETUP → Enrich + deterministic card
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`[ON-DEMAND] [${requestId}] Running deterministic analysis pipeline...`);

    // Enrich stock with full technical data + levels + score (debug=true for score_breakdown)
    const chartinkStock = {
      nsecode: stockInfo.trading_symbol,
      name: stockInfo.stock_name,
      close: indicators.price,
      volume: 0,
      scan_type: classification.scanType
    };

    const enrichedStock = await enrichStock(chartinkStock, 0, true);

    if (!enrichedStock || enrichedStock.eliminated) {
      console.log(`[ON-DEMAND] [${requestId}] ❌ Stock eliminated during enrichment: ${enrichedStock?.eliminationReason || 'Unknown'}`);

      // Save elimination as a reject
      const eliminationData = {
        schema_version: '1.5',
        symbol: stockInfo.trading_symbol,
        analysis_type: 'swing',
        verdict: {
          action: 'NO_TRADE',
          confidence: 0.9,
          one_liner: enrichedStock?.eliminationReason || 'Failed quality checks during enrichment'
        },
        setup_score: { total: 0, grade: 'F', factors: [], strengths: [], watch_factors: [] },
        trading_plan: null,
        warnings: [],
        strategies: []
      };

      const analysis = await StockAnalysis.findOneAndUpdate(
        { instrument_key: instrumentKey, analysis_type: 'swing' },
        {
          instrument_key: instrumentKey,
          stock_name: stockInfo.stock_name,
          stock_symbol: stockInfo.trading_symbol,
          analysis_type: 'swing',
          current_price: indicators.price,
          status: 'completed',
          analysis_data: eliminationData,
          analysis_meta: { data_as_of_ist: dataAsOf, source: 'on_demand_deterministic' },
          valid_until: null,
          last_validated_at: new Date(),
          progress: {
            percentage: 100,
            current_step: 'Complete',
            steps_completed: 1,
            total_steps: 1,
            estimated_time_remaining: 0,
            last_updated: new Date()
          }
        },
        { upsert: true, new: true, runValidators: false }
      );

      if (sendNotification && userId) {
        sendAnalysisNotification(userId, analysis).catch(() => {});
      }

      return {
        success: true,
        data: analysis,
        cached: false,
        eliminated: true,
        reason: enrichedStock?.eliminationReason || 'Failed enrichment',
        classification
      };
    }

    // Build deterministic analysis card
    const analysisData = buildAnalysisCard(enrichedStock, classification, dataAsOf);

    // Save to DB (single atomic write)
    const analysis = await StockAnalysis.findOneAndUpdate(
      { instrument_key: instrumentKey, analysis_type: 'swing' },
      {
        instrument_key: instrumentKey,
        stock_name: stockInfo.stock_name,
        stock_symbol: stockInfo.trading_symbol,
        analysis_type: 'swing',
        current_price: enrichedStock.current_price,
        status: 'completed',
        analysis_data: analysisData,
        analysis_meta: { data_as_of_ist: dataAsOf, source: 'on_demand_deterministic' },
        valid_until: null,
        last_validated_at: new Date(),
        progress: {
          percentage: 100,
          current_step: 'Complete',
          steps_completed: 1,
          total_steps: 1,
          estimated_time_remaining: 0,
          last_updated: new Date()
        }
      },
      { upsert: true, new: true, runValidators: false }
    );

    const duration = Date.now() - startTime;
    console.log(`[ON-DEMAND] [${requestId}] ✅ Deterministic analysis complete in ${duration}ms`);

    if (sendNotification && userId) {
      sendAnalysisNotification(userId, analysis).catch(() => {});
    }

    return {
      success: true,
      data: analysis,
      cached: false,
      fromQuickReject: false,
      classification
    };

  } catch (error) {
    console.error(`[ON-DEMAND] [${requestId}] ❌ Error:`, error.message);

    // Mark as failed if there's an in-progress analysis
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
  buildAnalysisCard
};
