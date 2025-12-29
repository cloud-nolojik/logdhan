/**
 * Unified Calculation Engine
 *
 * Single source of truth for ALL technical calculations in Logdhan.
 * This module orchestrates indicators, levels, zones, candidates, scoring, risk, and alerts.
 *
 * IMPORTANT: This engine fixes the Entry Zone inconsistency.
 * Both card display and analysis page now use the same unified logic.
 */

// Import all engine modules
import * as helpers from './helpers.js';
import * as indicators from './indicators.js';
import * as levels from './levels.js';
import * as zones from './zones.js';
import * as candidates from './candidates.js';
import * as scoring from './scoring.js';
import * as risk from './risk.js';
import * as alerts from './alerts.js';

// Re-export all modules for direct access
export { helpers, indicators, levels, zones, candidates, scoring, risk, alerts };

// Re-export commonly used functions at top level for convenience
export const { round2, isNum, clamp, get, normalizeCandles } = helpers;
export const { calculateSetupScore, pickBestCandidate, calculateConfidence, rankStocks, getGrade } = scoring;
export const { calculateEntryZone, checkEntryZoneStatus, generateEntryVerdict, checkGapCondition } = zones;
export const { calculateTrailingStop, recommendTrailingStrategy, calculateRiskReduction, calculatePositionSize, rrBuy, rrSell } = risk;
export const { checkExitConditions, checkEntryZoneProximity, checkPositionStatus, generateMorningGlance } = alerts;
export const { calcClassicPivots } = levels;

/**
 * Analyze a stock from candle data
 *
 * Complete analysis pipeline: candles → indicators → levels → zones → candidates → scoring
 *
 * @param {Array} candles - Raw candle data (any format)
 * @param {Object} options - Analysis options
 * @param {string} [options.scanType] - ChartInk scan type for candidate bonus
 * @param {number} [options.niftyReturn1M] - Nifty 1-month return for relative strength
 * @returns {Object} Complete analysis result
 */
export function analyzeStock(candles, options = {}) {
  const { scanType, niftyReturn1M = 0 } = options;

  // Step 1: Calculate technical indicators
  const ind = indicators.calculate(candles);

  if (ind.error) {
    return { error: ind.error, insufficientData: true };
  }

  // Step 2: Calculate pivot levels
  const lvl = levels.calculate(ind);

  // Step 3: Determine trend and volatility
  const trend = indicators.determineTrend(ind);
  const volatility = indicators.determineVolatility(ind);
  const volumeClass = indicators.determineVolumeClassification(ind);

  // Step 4: Calculate trading zones (UNIFIED ENTRY ZONE)
  const zon = zones.calculate(ind, lvl);

  // Step 5: Generate trade candidates
  const cand = candidates.generate(ind, lvl, { scanType, trend });

  // Step 6: Pick best candidate
  const selection = scoring.pickBestCandidate(cand);

  // Step 7: Calculate setup score
  const setupScore = scoring.calculateSetupScore(ind, niftyReturn1M, true);

  // Step 8: Check data health
  const dataHealth = indicators.checkDataHealth(ind);

  return {
    // Core data
    indicators: ind,
    levels: lvl,
    zones: zon,

    // Market context
    market: {
      trend,
      volatility,
      volume: volumeClass,
      current_price: ind.last
    },

    // Candidates and selection
    candidates: cand,
    selected: selection.best,
    selection_trace: selection.ranked,

    // Scoring
    setup_score: setupScore.score,
    grade: setupScore.grade,
    score_breakdown: setupScore.breakdown,

    // Data quality
    data_health: dataHealth,
    insufficientData: !dataHealth.ok || cand.insufficientData
  };
}

/**
 * Quick entry zone calculation for card display
 *
 * This uses the SAME logic as the full analysis, ensuring consistency.
 *
 * @param {Object} stockData - Stock data with ema20, atr, prev_high, prev_low, prev_close
 * @returns {Object} Entry zone { low, high, center, based_on }
 */
export function getEntryZone(stockData) {
  const { ema20, atr, prev_high, prev_low, prev_close, pivot: existingPivot } = stockData;

  // Calculate pivot if not provided
  let pivot = existingPivot;
  if (!pivot && prev_high && prev_low && prev_close) {
    const pivots = levels.calcClassicPivots(prev_high, prev_low, prev_close);
    pivot = pivots?.pivot;
  }

  return zones.calculateEntryZone({
    ema20,
    pivot,
    atr,
    currentPrice: stockData.last || stockData.price
  });
}

/**
 * Manage an open position
 *
 * Calculates trailing stop recommendations and exit alerts.
 *
 * @param {Object} position - { actual_entry, current_sl, current_target, qty }
 * @param {Object} currentData - { current_price, atr, swing_low, ema20 }
 * @returns {Object} Position management recommendations
 */
export function managePosition(position, currentData) {
  const { current_price, atr, swing_low, ema20 } = currentData;

  // Calculate trailing stop
  const trailResult = risk.calculateTrailingStop({
    position,
    current_price,
    atr,
    swing_low,
    ema20
  });

  // Check exit conditions
  const exitAlerts = alerts.checkExitConditions({
    position,
    current_price,
    atr
  });

  // Check position status
  const status = alerts.checkPositionStatus({
    current_price,
    actual_entry: position.actual_entry,
    qty: position.qty || 1
  });

  // Calculate risk reduction if trailing recommended
  let riskReduction = null;
  if (trailResult.should_trail) {
    riskReduction = risk.calculateRiskReduction({
      current_price,
      old_sl: position.current_sl,
      new_sl: trailResult.new_sl,
      qty: position.qty || 1
    });
  }

  return {
    trail: trailResult,
    exit_alerts: exitAlerts,
    status,
    risk_reduction: riskReduction,
    needs_attention: status.needs_attention || exitAlerts.some(a => a.severity === 'critical')
  };
}

/**
 * Enrich stock data with calculated indicators and scores
 *
 * @param {Object} stock - Raw stock data
 * @param {Array} candles - Candle data for the stock
 * @param {number} niftyReturn1M - Nifty 1-month return
 * @returns {Object} Enriched stock data
 */
export function enrichStock(stock, candles, niftyReturn1M = 0) {
  // Calculate indicators from candles
  const ind = indicators.calculate(candles);

  // Calculate setup score
  const { score, grade, breakdown } = scoring.calculateSetupScore(
    { ...stock, ...ind },
    niftyReturn1M,
    true
  );

  // Calculate entry zone
  const entryZone = getEntryZone({ ...stock, ...ind });

  return {
    ...stock,
    // Indicators
    ema20: ind.ema20,
    ema50: ind.ema50,
    sma200: ind.sma200,
    dma20: ind.dma20,
    dma50: ind.dma50,
    rsi: ind.rsi,
    atr: ind.atr,
    atr_pct: ind.atr_pct,
    volume_vs_avg: ind.volume_vs_avg,
    high_20d: ind.high_20d,
    low_20d: ind.low_20d,
    return_1m: ind.return_1m,
    distance_from_20dma_pct: ind.distance_from_20dma_pct,

    // Scoring
    setup_score: score,
    grade,
    score_breakdown: breakdown,

    // Entry zone (UNIFIED)
    entry_zone: entryZone
  };
}

/**
 * Generate Stage 2 candidates for AI analysis
 *
 * @param {Object} indicators - Calculated indicators
 * @param {Object} levels - Calculated levels
 * @param {Object} options - { scanType, trend }
 * @returns {Object} Stage 2 result for AI prompt
 */
export function generateStage2(ind, lvl, options = {}) {
  const trend = options.trend || indicators.determineTrend(ind);
  return candidates.generate(ind, lvl, { ...options, trend });
}

/**
 * Build complete market payload for AI analysis
 *
 * @param {Object} ind - Calculated indicators
 * @param {Object} lvl - Calculated levels
 * @returns {Object} Market payload
 */
export function buildMarketPayload(ind, lvl) {
  const trend = indicators.determineTrend(ind);
  const volatility = indicators.determineVolatility(ind);
  const volumeClass = indicators.determineVolumeClassification(ind);

  return {
    priceContext: {
      last: ind.last,
      open: ind.open,
      high: ind.high,
      low: ind.low,
      close: ind.close
    },
    trendMomentum: {
      ema20_1D: ind.ema20,
      ema50_1D: ind.ema50,
      sma200_1D: ind.sma200,
      atr14_1D: ind.atr,
      rsi14_1h: ind.rsi,
      trendBias: trend
    },
    volumeContext: {
      classification: volumeClass,
      volume_vs_avg: ind.volume_vs_avg
    },
    swingContext: {
      prevSession: {
        high: ind.prev_high,
        low: ind.prev_low,
        close: ind.prev_close
      },
      pivots: lvl,
      swingLevels: {
        recent20: {
          high: ind.high_20d,
          low: ind.low_20d
        }
      }
    },
    market_summary: {
      trend,
      volatility,
      volume: volumeClass
    }
  };
}

// Default export with all main functions
export default {
  // Main analysis
  analyzeStock,
  managePosition,
  enrichStock,
  getEntryZone,

  // Stage building
  generateStage2,
  buildMarketPayload,

  // Direct module access
  helpers,
  indicators,
  levels,
  zones,
  candidates,
  scoring,
  risk,
  alerts
};
