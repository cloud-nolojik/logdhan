/**
 * Stock Enrichment Service
 *
 * Enriches ChartInk scan results with:
 * - Upstox instrument keys
 * - Technical indicators (RSI, ATR, DMAs)
 * - Trading levels (Entry, Target, StopLoss)
 * - Setup scores for ranking (Framework-based)
 *
 * UPDATED: Now calculates trading levels BEFORE scoring
 * to include R:R and upside % in the framework score.
 */

import Stock from '../models/stock.js';
import LatestPrice from '../models/latestPrice.js';
import PreFetchedData from '../models/preFetchedData.js';
import {
  calculateSetupScore,
  getEntryZone,
  round2,
  indicators as indicatorsEngine
} from '../engine/index.js';

// Import scanLevels for calculating trading levels
import scanLevels from '../engine/scanLevels.js';
const { calculateTradingLevels } = scanLevels;

// Import technicalData service as data layer (provides richer data + API fallback)
import technicalDataService from './technicalData.service.js';

// Alias for backward compatibility
const calculateTechnicalIndicators = indicatorsEngine.calculate;

/**
 * Map ChartInk symbol to Upstox instrument_key
 * @param {string} nsecode - NSE symbol from ChartInk
 * @returns {Promise<{ instrument_key: string, stock_name: string } | null>}
 */
export async function mapToInstrumentKey(nsecode) {
  if (!nsecode) return null;

  try {
    // Look up in Stock collection by trading_symbol
    const stock = await Stock.findOne({
      trading_symbol: nsecode.toUpperCase(),
      exchange: 'NSE',
      is_active: true
    }).lean();

    if (stock) {
      return {
        instrument_key: stock.instrument_key,
        stock_name: stock.name,
        trading_symbol: stock.trading_symbol
      };
    }

    // Fallback: Try with common suffixes
    const variations = [
      nsecode.toUpperCase(),
      `${nsecode.toUpperCase()}-EQ`,
      `${nsecode.toUpperCase()}-BE`
    ];

    for (const variation of variations) {
      const stockVar = await Stock.findOne({
        trading_symbol: variation,
        is_active: true
      }).lean();

      if (stockVar) {
        return {
          instrument_key: stockVar.instrument_key,
          stock_name: stockVar.name,
          trading_symbol: stockVar.trading_symbol
        };
      }
    }

    return null;
  } catch (error) {
    console.error(`Error mapping ${nsecode} to instrument_key:`, error.message);
    return null;
  }
}

/**
 * Get technical indicators for a stock
 * @param {string} instrument_key
 * @param {boolean} [debug=false] - Enable debug logging
 * @returns {Promise<Object>}
 */
export async function getStockIndicators(instrument_key, debug = false) {
  try {
    // First try LatestPrice (has recent data)
    const priceDoc = await LatestPrice.findOne({ instrument_key }).lean();

    if (debug) {
      console.log(`[ENRICH DEBUG] ${instrument_key} - LatestPrice found:`, !!priceDoc);
    }

    // Then try PreFetchedData for daily candles with indicators
    const prefetched = await PreFetchedData.findOne({
      instrument_key,
      timeframe: '1d'
    }).lean();

    if (debug) {
      console.log(`[ENRICH DEBUG] ${instrument_key} - PreFetchedData found:`, !!prefetched, 'candle_data length:', prefetched?.candle_data?.length || 0);
    }

    // Use candle_data field (not candles)
    const candles = prefetched?.candle_data;
    let indicators = {};

    if (candles?.length >= 20) {
      // Calculate indicators from daily candles
      indicators = calculateTechnicalIndicators(candles);
      if (debug) {
        console.log(`[ENRICH DEBUG] ${instrument_key} - Calculated indicators:`, {
          sma20: indicators.sma20,
          ema20: indicators.ema20,
          sma50: indicators.sma50,
          sma200: indicators.sma200,
          rsi14: indicators.rsi14,
          atr14: indicators.atr14
        });
      }
    } else if (debug) {
      console.log(`[ENRICH DEBUG] ${instrument_key} - Not enough candles for indicators (need 20, have ${candles?.length || 0})`);
    }

    // Get current price - use last candle close if no LatestPrice
    const lastCandle = candles?.[candles.length - 1];
    const currentPrice = priceDoc?.last_traded_price || priceDoc?.close || lastCandle?.close;

    // Calculate volume vs average
    let volume_vs_avg = null;
    const currentVolume = priceDoc?.volume || lastCandle?.volume;
    if (currentVolume && candles?.length >= 20) {
      const recentCandles = candles.slice(-20);
      const avgVolume = recentCandles.reduce((sum, c) => {
        const vol = Array.isArray(c) ? c[5] : c.volume;
        return sum + (vol || 0);
      }, 0) / 20;

      if (avgVolume > 0) {
        volume_vs_avg = round2(currentVolume / avgVolume);
      }
    }

    // Get 20-day high
    let high_20d = null;
    if (candles?.length >= 20) {
      const last20 = candles.slice(-20);
      high_20d = Math.max(...last20.map(c => Array.isArray(c) ? c[2] : c.high));
    }

    // Calculate 1-month return
    let return_1m = null;
    if (candles?.length >= 22 && currentPrice) {
      const oneMonthAgo = candles[candles.length - 22];
      const oldClose = Array.isArray(oneMonthAgo) ? oneMonthAgo[4] : oneMonthAgo.close;
      if (oldClose) {
        return_1m = round2(((currentPrice - oldClose) / oldClose) * 100);
      }
    }

    // Get Friday (last trading day) data for levels calculation
    let fridayHigh = null;
    let fridayLow = null;
    let fridayClose = null;
    let fridayVolume = null;

    if (lastCandle) {
      fridayHigh = Array.isArray(lastCandle) ? lastCandle[2] : lastCandle.high;
      fridayLow = Array.isArray(lastCandle) ? lastCandle[3] : lastCandle.low;
      fridayClose = Array.isArray(lastCandle) ? lastCandle[4] : lastCandle.close;
      fridayVolume = Array.isArray(lastCandle) ? lastCandle[5] : lastCandle.volume;
    }

    // Calculate weekly change (for A+ momentum scoring)
    let weekly_change_pct = null;
    if (candles?.length >= 5 && currentPrice) {
      const weekAgoCandle = candles[candles.length - 5];
      const weekAgoClose = Array.isArray(weekAgoCandle) ? weekAgoCandle[4] : weekAgoCandle.close;
      if (weekAgoClose) {
        weekly_change_pct = round2(((currentPrice - weekAgoClose) / weekAgoClose) * 100);
      }
    }

    return {
      price: currentPrice,
      dma20: round2(indicators.sma20 || indicators.ema20),
      dma50: round2(indicators.sma50 || indicators.ema50),
      dma200: round2(indicators.sma200),
      ema20: round2(indicators.ema20),
      ema50: round2(indicators.ema50),
      rsi: round2(indicators.rsi14 || indicators.rsi),
      atr: round2(indicators.atr14 || indicators.atr),
      atr_pct: indicators.atr && currentPrice ?
        round2((indicators.atr / currentPrice) * 100) : null,
      volume: currentVolume,
      volume_20avg: volume_vs_avg ? round2(currentVolume / volume_vs_avg) : null,
      volume_vs_avg,
      high_20d: round2(high_20d),
      return_1m,
      distance_from_20dma_pct: indicators.sma20 && currentPrice ?
        round2(((currentPrice - indicators.sma20) / indicators.sma20) * 100) : null,
      // Additional fields for levels calculation
      fridayHigh: round2(fridayHigh),
      fridayLow: round2(fridayLow),
      fridayClose: round2(fridayClose),
      fridayVolume,
      weekly_change_pct
    };
  } catch (error) {
    console.error(`Error getting indicators for ${instrument_key}:`, error.message);
    return null;
  }
}

/**
 * Calculate trading levels for a stock based on scan type
 * @param {Object} stockData - Stock data with indicators
 * @param {string} scanType - Scan type (e.g., 'a_plus_momentum')
 * @returns {Object} Trading levels { entry, stop, target, riskReward, ... }
 */
function calculateLevelsForStock(stockData, scanType) {
  const {
    ema20, atr, fridayHigh, fridayClose, fridayLow, high_20d, high_52w, fridayVolume, volume_20avg,
    // Pivot levels for target anchoring (NEW)
    weekly_r1, weekly_r2, weekly_s1, weekly_pivot,
    daily_r1, daily_r2, daily_s1, daily_pivot
  } = stockData;

  // Build data object for scanLevels
  const levelsData = {
    ema20,
    atr,
    fridayHigh,
    fridayClose,
    fridayLow,
    high20D: high_20d,
    high52W: high_52w,     // NEW: For structural ladder (last resort before rejection)
    fridayVolume,
    avgVolume20: volume_20avg,  // Named to match scanLevels.js expectation
    // Pivot levels for target anchoring (STRUCTURAL LADDER)
    // Priority: Weekly R1 → Weekly R2 → 52W High → REJECT
    weeklyR1: weekly_r1,
    weeklyR2: weekly_r2,   // NEW: Second level in structural ladder
    weeklyS1: weekly_s1,
    weeklyPivot: weekly_pivot,
    dailyR1: daily_r1,
    dailyR2: daily_r2,     // NEW: For pullback targets
    dailyS1: daily_s1,
    dailyPivot: daily_pivot
  };

  try {
    const levels = calculateTradingLevels(scanType || 'a_plus_momentum', levelsData);
    return levels;
  } catch (error) {
    console.error(`Error calculating levels:`, error.message);
    return { valid: false, reason: error.message };
  }
}

/**
 * Enrich a single ChartInk result
 *
 * REFACTORED: Now uses technicalDataService.calculateStockData() as the data layer
 * This provides:
 * - Weekly RSI (for dual-timeframe elimination - catches BAJAJCON-like cases)
 * - 52W high (instead of just 20D high)
 * - EMA stack bullish check
 * - Weekly pivot levels
 * - API fallback if DB data is missing
 *
 * @param {Object} chartinkStock - Stock from ChartInk
 * @param {number} [niftyReturn1M=0] - Nifty 1-month return
 * @param {boolean} [debug=false] - Enable debug logging
 * @returns {Promise<Object | null>}
 */
export async function enrichStock(chartinkStock, niftyReturn1M = 0, debug = false, referenceDate = null) {
  const { nsecode, name, per_change, close, volume, scan_type } = chartinkStock;

  // Map to instrument_key
  const mapping = await mapToInstrumentKey(nsecode);
  if (!mapping) {
    console.warn(`Could not map ${nsecode} to instrument_key`);
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA LAYER: Use technicalDataService for richer data + API fallback
  // ═══════════════════════════════════════════════════════════════════════════
  const techData = await technicalDataService.calculateStockData(
    mapping.trading_symbol,
    mapping.instrument_key,
    referenceDate  // Pass reference date to filter candles
  );

  if (debug) {
    console.log(`[ENRICH DEBUG] ${nsecode} - TechData from service:`, {
      cmp: techData.cmp,
      daily_rsi: techData.daily_rsi,
      weekly_rsi: techData.weekly_rsi,
      high_52w: techData.high_52w,
      ema_stack_bullish: techData.ema_stack_bullish,
      error: techData.error
    });
  }

  // If technicalDataService failed, fall back to legacy getStockIndicators
  let stockData;
  let dataSource;
  if (techData.error) {
    console.warn(`[ENRICH] TechData failed for ${nsecode}, falling back to legacy method`);
    const legacyIndicators = await getStockIndicators(mapping.instrument_key, debug);
    stockData = buildStockDataFromLegacy(legacyIndicators, close, volume);
    dataSource = 'LEGACY';
  } else {
    // Map technicalDataService output to stockData format
    stockData = buildStockDataFromTechService(techData, close, volume);
    dataSource = 'TECH_SERVICE';
  }

  if (debug) {
    console.log(`[ENRICH DEBUG] ${nsecode} - Data source: ${dataSource}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Calculate trading levels FIRST (for framework scoring)
  // ═══════════════════════════════════════════════════════════════════════════
  const scanTypeForLevels = scan_type || 'a_plus_momentum';
  const levels = calculateLevelsForStock(stockData, scanTypeForLevels);

  if (debug) {
    console.log(`[ENRICH DEBUG] ${nsecode} - Levels calculated:`, {
      valid: levels.valid,
      entry: levels.entry,
      stop: levels.stop,
      target1: levels.target1,
      target2: levels.target2,
      target3: levels.target3,
      riskReward: levels.riskReward,
      reason: levels.reason
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Calculate setup score WITH levels (Framework-based scoring)
  // Now includes weekly_rsi for dual-timeframe elimination
  // ═══════════════════════════════════════════════════════════════════════════
  const scoreResult = calculateSetupScore(stockData, levels, niftyReturn1M, debug);

  if (debug) {
    console.log(`[ENRICH DEBUG] ${nsecode} - Score result:`, {
      score: scoreResult.score,
      grade: scoreResult.grade,
      eliminated: scoreResult.eliminated,
      eliminationReason: scoreResult.eliminationReason
    });
  }

  // Check if stock was eliminated (e.g., RSI > 72 on daily OR weekly)
  if (scoreResult.eliminated) {
    console.log(`[ENRICH] ${nsecode} ELIMINATED: ${scoreResult.eliminationReason}`);
    return {
      instrument_key: mapping.instrument_key,
      symbol: mapping.trading_symbol,
      stock_name: mapping.stock_name || name,
      eliminated: true,
      eliminationReason: scoreResult.eliminationReason,
      setup_score: 0,
      grade: 'X'
    };
  }

  // Calculate entry zone (for backward compatibility)
  const entryZone = getEntryZone(stockData);

  return {
    // Core identifiers
    instrument_key: mapping.instrument_key,
    symbol: mapping.trading_symbol,
    stock_name: mapping.stock_name || name,

    // ChartInk data
    chartink_close: close,
    chartink_change_pct: per_change,
    scan_type,

    // Current data
    current_price: stockData.price,

    // Technical indicators (enriched with new fields)
    indicators: {
      dma20: stockData.dma20,
      dma50: stockData.dma50,
      dma200: stockData.dma200,
      ema20: stockData.ema20,
      ema50: stockData.ema50,
      rsi: stockData.rsi,
      weekly_rsi: stockData.weekly_rsi,           // NEW: For dual-timeframe analysis
      atr: stockData.atr,
      atr_pct: stockData.atr_pct,
      volume_vs_avg: stockData.volume_vs_avg,
      distance_from_20dma_pct: stockData.distance_from_20dma_pct,
      high_20d: stockData.high_20d,
      high_52w: stockData.high_52w,               // NEW: For breakout detection
      return_1m: stockData.return_1m,
      weekly_change_pct: stockData.weekly_change_pct,
      ema_stack_bullish: stockData.ema_stack_bullish,  // NEW: Trend confirmation
      // Weekly pivot levels (NEW)
      weekly_pivot: stockData.weekly_pivot,
      weekly_s1: stockData.weekly_s1,
      weekly_r1: stockData.weekly_r1,
      weekly_r2: stockData.weekly_r2             // NEW: For structural ladder visibility
    },

    // ═══════════════════════════════════════════════════════════════════════════
    // Trading Levels (from scanLevels)
    // STRUCTURAL LADDER: Weekly R1 → R2 → 52W High → REJECT
    // ═══════════════════════════════════════════════════════════════════════════
    levels: levels.valid ? {
      entry: levels.entry,
      entryRange: levels.entryRange,
      stop: levels.stop,
      // ── Targets (consistent naming: T1, T2, T3) ──
      target1: levels.target1,                         // T1: Partial profit booking (50%)
      target1_basis: levels.target1_basis,             // 'weekly_r1', 'daily_r1', or 'midpoint'
      target2: levels.target2,                         // T2: Main target
      target2_basis: levels.target2_basis,             // 'weekly_r1', 'weekly_r2', 'daily_r1', 'daily_r2', '52w_high', 'atr_extension_52w_breakout'
      target3: levels.target3 || null,                 // T3: Extension target (optional, may be null)
      dailyR1Check: levels.dailyR1Check || null,       // Momentum checkpoint (not a target)
      // ── Risk/Reward ──
      riskReward: levels.riskReward,
      riskPercent: levels.riskPercent,
      rewardPercent: levels.rewardPercent,
      // ── Entry/Exit Rules ──
      entryType: levels.entryType,
      mode: levels.mode,
      archetype: levels.archetype || null,             // '52w_breakout', 'trend-follow', 'breakout', 'pullback'
      reason: levels.reason,
      // ── Time Rules (v2) ──
      entryConfirmation: levels.entryConfirmation || 'close_above',
      entryWindowDays: levels.entryWindowDays || 3,
      maxHoldDays: levels.maxHoldDays || 5,
      weekEndRule: levels.weekEndRule || 'exit_if_no_t1',
      t1BookingPct: levels.t1BookingPct || 50,
      postT1Stop: levels.postT1Stop || 'move_to_entry'
    } : {
      valid: false,
      reason: levels.reason,
      noData: levels.noData || false                   // NEW: Distinguishes missing data from bad setup
    },

    // ═══════════════════════════════════════════════════════════════════════════
    // Scoring (Framework-based)
    // ═══════════════════════════════════════════════════════════════════════════
    setup_score: scoreResult.score,
    score_breakdown: scoreResult.breakdown,
    grade: scoreResult.grade,
    eliminated: false,
    eliminationReason: null,

    // Entry zone suggestion (backward compatibility)
    entry_zone: entryZone,

    // Metadata
    enriched_at: new Date()
  };
}

/**
 * Build stockData from technicalDataService output
 * Maps the richer techData to the format expected by scoring and levels
 */
function buildStockDataFromTechService(techData, chartinkClose, chartinkVolume) {
  const currentPrice = techData.cmp || chartinkClose;
  const currentVolume = techData.todays_volume || chartinkVolume;
  const avgVolume = techData.avg_volume_50d || 1;

  return {
    // Price data
    price: currentPrice,
    last: currentPrice,
    close: currentPrice,

    // RSI - both timeframes for dual-timeframe elimination
    rsi: techData.daily_rsi,
    rsi14: techData.daily_rsi,
    weekly_rsi: techData.weekly_rsi,  // NEW: Catches extended stocks like BAJAJCON

    // Moving averages (now properly exposed from techData)
    // Note: dma50 prefers SMA50 with EMA50 fallback (matches legacy behavior)
    dma20: techData.sma_20,
    dma50: techData.sma_50 || techData.ema_50,  // SMA preferred, EMA fallback
    dma200: techData.sma_200,
    ema20: techData.ema_20,
    ema50: techData.ema_50,
    ema_stack_bullish: techData.ema_stack_bullish,  // NEW: Trend confirmation

    // Volatility
    atr: techData.atr_14,
    atr_pct: techData.atr_pct,  // Now returned directly from technicalDataService

    // Volume
    volume: currentVolume,
    volume_20avg: avgVolume,  // Using 50d avg from techData
    volume_vs_avg: avgVolume > 0 ? round2(currentVolume / avgVolume) : null,

    // Highs
    high_20d: techData.high_20d,  // Now properly available
    high_52w: techData.high_52w,  // NEW: For breakout detection

    // Returns (now available from techData)
    return_1m: techData.return_1m,
    distance_from_20dma_pct: techData.distance_from_20dma_pct,

    // For level calculations (using today's data as "Friday" data)
    fridayHigh: techData.todays_high,
    fridayLow: techData.todays_low,
    fridayClose: currentPrice,
    fridayVolume: currentVolume,

    // Weekly change (now available from techData)
    weekly_change_pct: techData.weekly_change_pct,
    // Log if weekly data is missing (helps debug AI "missing weekly momentum" messages)
    ...(techData.weekly_change_pct == null && console.warn(`[ENRICH] ${techData.symbol} - weekly_change_pct is NULL from techData`), {}),
    ...(techData.weekly_rsi == null && console.warn(`[ENRICH] ${techData.symbol} - weekly_rsi is NULL from techData`), {}),

    // Pivot levels for target anchoring (NEW)
    // Weekly pivots
    weekly_pivot: techData.weekly_pivot,
    weekly_s1: techData.weekly_s1,
    weekly_r1: techData.weekly_r1,
    weekly_r2: techData.weekly_r2,     // NEW: For structural ladder
    // Daily pivots
    daily_pivot: techData.daily_pivot,
    daily_s1: techData.daily_s1,
    daily_r1: techData.daily_r1,
    daily_r2: techData.daily_r2        // NEW: For structural ladder
  };
}

/**
 * Build stockData from legacy getStockIndicators output (fallback)
 */
function buildStockDataFromLegacy(indicators, chartinkClose, chartinkVolume) {
  return {
    price: indicators?.price || chartinkClose,
    last: indicators?.price || chartinkClose,
    close: indicators?.price || chartinkClose,
    dma20: indicators?.dma20,
    dma50: indicators?.dma50,
    dma200: indicators?.dma200,
    ema20: indicators?.ema20,
    ema50: indicators?.ema50,
    rsi: indicators?.rsi,
    rsi14: indicators?.rsi,
    weekly_rsi: null,  // Not available in legacy
    atr: indicators?.atr,
    atr_pct: indicators?.atr_pct,
    volume: indicators?.volume || chartinkVolume,
    volume_20avg: indicators?.volume_20avg,
    volume_vs_avg: indicators?.volume_vs_avg,
    high_20d: indicators?.high_20d,
    high_52w: null,  // Not available in legacy
    return_1m: indicators?.return_1m,
    distance_from_20dma_pct: indicators?.distance_from_20dma_pct,
    fridayHigh: indicators?.fridayHigh,
    fridayLow: indicators?.fridayLow,
    fridayClose: indicators?.fridayClose,
    fridayVolume: indicators?.fridayVolume,
    weekly_change_pct: indicators?.weekly_change_pct,
    ema_stack_bullish: null,  // Not available in legacy
    // Pivots not available in legacy
    weekly_pivot: null,
    weekly_s1: null,
    weekly_r1: null,
    weekly_r2: null,    // Not available in legacy
    daily_pivot: null,
    daily_s1: null,
    daily_r1: null,
    daily_r2: null      // Not available in legacy
  };
}

/**
 * Enrich multiple stocks from ChartInk
 * @param {Array} chartinkResults - Array of ChartInk stock results
 * @param {Object} [options={}]
 * @param {number} [options.niftyReturn1M=0] - Nifty 1-month return
 * @param {number} [options.minScore=0] - Minimum setup score to include
 * @param {number} [options.maxResults=20] - Maximum results to return
 * @param {boolean} [options.debug=false] - Enable debug logging for first N stocks
 * @param {number} [options.debugCount=3] - Number of stocks to debug
 * @returns {Promise<Array>}
 */
export async function enrichStocks(chartinkResults, options = {}) {
  const {
    niftyReturn1M = 0,
    minScore = 0,
    maxResults = 20,
    debug = false,
    debugCount = 3,
    referenceDate = null  // Filter candles up to this date (YYYY-MM-DD)
  } = options;

  if (referenceDate) {
    console.log(`[ENRICH] Using reference date: ${referenceDate} (candles will be filtered)`);
  }

  const enrichedResults = [];
  const eliminatedResults = [];
  let debuggedCount = 0;

  for (const stock of chartinkResults) {
    try {
      // Debug first few stocks to see what's happening
      const shouldDebug = debug && debuggedCount < debugCount;
      if (shouldDebug) {
        console.log(`\n[ENRICH DEBUG] ===== Stock ${debuggedCount + 1}: ${stock.nsecode} (${stock.scan_type}) =====`);
        debuggedCount++;
      }

      const enriched = await enrichStock(stock, niftyReturn1M, shouldDebug, referenceDate);

      if (!enriched) {
        continue;
      }

      // Track eliminated stocks separately
      if (enriched.eliminated) {
        eliminatedResults.push(enriched);
        continue;
      }

      if (enriched.setup_score >= minScore) {
        enrichedResults.push(enriched);
        if (shouldDebug) {
          console.log(`[ENRICH DEBUG] ${stock.nsecode} - Final score: ${enriched.setup_score}, Grade: ${enriched.grade}`);
        }
      }
    } catch (error) {
      console.error(`Error enriching ${stock.nsecode}:`, error.message);
    }

    // Small delay to avoid overwhelming the database
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  // Log elimination stats
  if (eliminatedResults.length > 0) {
    console.log(`\n[ENRICH] Eliminated ${eliminatedResults.length} stocks:`);
    eliminatedResults.forEach(s => {
      console.log(`  - ${s.symbol}: ${s.eliminationReason}`);
    });
  }

  // Log score distribution
  if (debug) {
    const scores = enrichedResults.map(s => s.setup_score).sort((a, b) => b - a);
    console.log(`\n[ENRICH DEBUG] Score distribution (top 10):`, scores.slice(0, 10));
    console.log(`[ENRICH DEBUG] Score distribution (bottom 10):`, scores.slice(-10));
    console.log(`[ENRICH DEBUG] Max score: ${Math.max(...scores)}, Min score: ${Math.min(...scores)}`);
  }

  // Sort by setup score (highest first) and limit results
  const sortedResults = enrichedResults
    .sort((a, b) => b.setup_score - a.setup_score)
    .slice(0, maxResults);

  // Return stocks AND eliminated count (for metadata tracking)
  return {
    stocks: sortedResults,
    eliminatedCount: eliminatedResults.length,
    eliminatedStocks: eliminatedResults
  };
}

/**
 * Get Nifty 1-month return for relative strength calculation
 * Fetches from Upstox API if not available in PreFetchedData
 * @returns {Promise<number>}
 */
export async function getNiftyReturn1M() {
  const NIFTY_50_INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';

  try {
    // First try PreFetchedData (in case Nifty is prefetched)
    const niftyPrefetch = await PreFetchedData.findOne({
      instrument_key: NIFTY_50_INSTRUMENT_KEY,
      timeframe: '1d'
    }).lean();

    if (niftyPrefetch?.candle_data?.length >= 22) {
      const candles = niftyPrefetch.candle_data;
      const currentClose = Array.isArray(candles[candles.length - 1])
        ? candles[candles.length - 1][4]
        : candles[candles.length - 1].close;

      const monthAgoClose = Array.isArray(candles[candles.length - 22])
        ? candles[candles.length - 22][4]
        : candles[candles.length - 22].close;

      if (currentClose && monthAgoClose) {
        return round2(((currentClose - monthAgoClose) / monthAgoClose) * 100);
      }
    }

    // Fallback: Fetch from Upstox API directly
    const { default: candleFetcherService } = await import('./candleFetcher.service.js');

    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 45);

    const formatDate = (d) => d.toISOString().split('T')[0];

    const candles = await candleFetcherService.fetchCandlesFromAPI(
      NIFTY_50_INSTRUMENT_KEY,
      'day',
      formatDate(fromDate),
      formatDate(toDate),
      true
    );

    if (candles && candles.length >= 22) {
      const currentClose = candles[candles.length - 1].close;
      const monthAgoClose = candles[candles.length - 22].close;

      if (currentClose && monthAgoClose) {
        const niftyReturn = round2(((currentClose - monthAgoClose) / monthAgoClose) * 100);
        console.log(`[NIFTY] Fetched from API: ${niftyReturn}% (1M return)`);
        return niftyReturn;
      }
    }

    console.warn('[NIFTY] Could not calculate 1M return - insufficient data');
    return 0;
  } catch (error) {
    console.error('Error getting Nifty return:', error.message);
    return 0;
  }
}

/**
 * Full enrichment pipeline: ChartInk results -> Scored & Ranked stocks
 * @param {Array} chartinkResults
 * @param {Object} [options={}]
 * @returns {Promise<{ stocks: Array, metadata: Object }>}
 */
export async function runEnrichmentPipeline(chartinkResults, options = {}) {
  const startTime = Date.now();

  // Get Nifty return for relative strength
  const niftyReturn1M = await getNiftyReturn1M();

  // Enrich all stocks (now includes levels calculation)
  // Returns { stocks, eliminatedCount, eliminatedStocks }
  const enrichResult = await enrichStocks(chartinkResults, {
    ...options,
    niftyReturn1M
  });
  const enrichedStocks = enrichResult.stocks;
  const eliminatedCount = enrichResult.eliminatedCount;

  // Categorize by grade
  const gradeDistribution = {
    'A+': enrichedStocks.filter(s => s.grade === 'A+').length,
    A: enrichedStocks.filter(s => s.grade === 'A').length,
    'B+': enrichedStocks.filter(s => s.grade === 'B+').length,
    B: enrichedStocks.filter(s => s.grade === 'B').length,
    C: enrichedStocks.filter(s => s.grade === 'C').length,
    D: enrichedStocks.filter(s => s.grade === 'D').length
  };

  // Categorize by scan type
  const scanTypeDistribution = {};
  for (const stock of enrichedStocks) {
    const type = stock.scan_type || 'unknown';
    scanTypeDistribution[type] = (scanTypeDistribution[type] || 0) + 1;
  }

  // Count stocks with valid levels
  const levelsStats = {
    with_levels: enrichedStocks.filter(s => s.levels?.entry).length,
    without_levels: enrichedStocks.filter(s => !s.levels?.entry).length
  };

  return {
    stocks: enrichedStocks,
    metadata: {
      total_input: chartinkResults.length,
      total_enriched: enrichedStocks.length,
      total_eliminated: eliminatedCount,  // NEW: Track eliminated stocks
      nifty_return_1m: niftyReturn1M,
      grade_distribution: gradeDistribution,
      scan_type_distribution: scanTypeDistribution,
      levels_stats: levelsStats,
      processing_time_ms: Date.now() - startTime,
      enriched_at: new Date()
    }
  };
}

export default {
  mapToInstrumentKey,
  getStockIndicators,
  enrichStock,
  enrichStocks,
  getNiftyReturn1M,
  runEnrichmentPipeline
};
