/**
 * Stock Enrichment Service
 *
 * Enriches ChartInk scan results with:
 * - Upstox instrument keys
 * - Technical indicators (RSI, ATR, DMAs)
 * - Setup scores for ranking
 */

import Stock from '../models/stock.js';
import LatestPrice from '../models/latestPrice.js';
import PreFetchedData from '../models/preFetchedData.js';
import { calculateTechnicalIndicators } from '../utils/indicatorCalculator.js';
import { calculateSetupScore, suggestEntryZone } from '../utils/setupScoreCalculator.js';

/**
 * Round to 2 decimal places
 */
function round2(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  return Math.round(x * 100) / 100;
}

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
      timeframe: '1d'  // lowercase 'd'
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
        round2(((currentPrice - indicators.sma20) / indicators.sma20) * 100) : null
    };
  } catch (error) {
    console.error(`Error getting indicators for ${instrument_key}:`, error.message);
    return null;
  }
}

/**
 * Enrich a single ChartInk result
 * @param {Object} chartinkStock - Stock from ChartInk
 * @param {number} [niftyReturn1M=0] - Nifty 1-month return
 * @param {boolean} [debug=false] - Enable debug logging
 * @returns {Promise<Object | null>}
 */
export async function enrichStock(chartinkStock, niftyReturn1M = 0, debug = false) {
  const { nsecode, name, per_change, close, volume, scan_type } = chartinkStock;

  // Map to instrument_key
  const mapping = await mapToInstrumentKey(nsecode);
  if (!mapping) {
    console.warn(`Could not map ${nsecode} to instrument_key`);
    return null;
  }

  // Get indicators
  const indicators = await getStockIndicators(mapping.instrument_key, debug);

  // If no indicators available, use ChartInk data
  const stockData = {
    price: indicators?.price || close,
    dma20: indicators?.dma20,
    dma50: indicators?.dma50,
    dma200: indicators?.dma200,
    rsi: indicators?.rsi,
    atr: indicators?.atr,
    volume: indicators?.volume || volume,
    volume_20avg: indicators?.volume_20avg,
    high_20d: indicators?.high_20d,
    return_1m: indicators?.return_1m
  };

  // Calculate setup score
  const scoreResult = calculateSetupScore(stockData, niftyReturn1M, debug);
  const entryZone = suggestEntryZone(stockData);

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

    // Technical indicators
    indicators: {
      dma20: stockData.dma20,
      dma50: stockData.dma50,
      dma200: stockData.dma200,
      rsi: stockData.rsi,
      atr: stockData.atr,
      atr_pct: indicators?.atr_pct,
      volume_vs_avg: indicators?.volume_vs_avg,
      distance_from_20dma_pct: indicators?.distance_from_20dma_pct,
      high_20d: stockData.high_20d,
      return_1m: stockData.return_1m
    },

    // Scoring
    setup_score: scoreResult.score,
    score_breakdown: scoreResult.breakdown,
    grade: scoreResult.grade,

    // Entry zone suggestion
    entry_zone: entryZone,

    // Metadata
    enriched_at: new Date()
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
    debugCount = 3
  } = options;

  const enrichedResults = [];
  let debuggedCount = 0;

  for (const stock of chartinkResults) {
    try {
      // Debug first few stocks to see what's happening
      const shouldDebug = debug && debuggedCount < debugCount;
      if (shouldDebug) {
        console.log(`\n[ENRICH DEBUG] ===== Stock ${debuggedCount + 1}: ${stock.nsecode} (${stock.scan_type}) =====`);
        debuggedCount++;
      }

      const enriched = await enrichStock(stock, niftyReturn1M, shouldDebug);

      if (enriched && enriched.setup_score >= minScore) {
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

  // Log score distribution
  if (debug) {
    const scores = enrichedResults.map(s => s.setup_score).sort((a, b) => b - a);
    console.log(`\n[ENRICH DEBUG] Score distribution (top 10):`, scores.slice(0, 10));
    console.log(`[ENRICH DEBUG] Score distribution (bottom 10):`, scores.slice(-10));
    console.log(`[ENRICH DEBUG] Max score: ${Math.max(...scores)}, Min score: ${Math.min(...scores)}`);
  }

  // Sort by setup score (highest first) and limit results
  return enrichedResults
    .sort((a, b) => b.setup_score - a.setup_score)
    .slice(0, maxResults);
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

    // Calculate date range for ~1 month of daily data
    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 30); // 30 days back

    const formatDate = (d) => d.toISOString().split('T')[0];

    const candles = await candleFetcherService.fetchCandlesFromAPI(
      NIFTY_50_INSTRUMENT_KEY,
      'day',
      formatDate(fromDate),
      formatDate(toDate),
      true // skipIntraday
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

  // Enrich all stocks
  const enrichedStocks = await enrichStocks(chartinkResults, {
    ...options,
    niftyReturn1M
  });

  // Categorize by grade
  const gradeDistribution = {
    A: enrichedStocks.filter(s => s.grade === 'A').length,
    B: enrichedStocks.filter(s => s.grade === 'B').length,
    C: enrichedStocks.filter(s => s.grade === 'C').length,
    D: enrichedStocks.filter(s => s.grade === 'D').length,
    F: enrichedStocks.filter(s => s.grade === 'F').length
  };

  // Categorize by scan type
  const scanTypeDistribution = {};
  for (const stock of enrichedStocks) {
    const type = stock.scan_type || 'unknown';
    scanTypeDistribution[type] = (scanTypeDistribution[type] || 0) + 1;
  }

  return {
    stocks: enrichedStocks,
    metadata: {
      total_input: chartinkResults.length,
      total_enriched: enrichedStocks.length,
      nifty_return_1m: niftyReturn1M,
      grade_distribution: gradeDistribution,
      scan_type_distribution: scanTypeDistribution,
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
