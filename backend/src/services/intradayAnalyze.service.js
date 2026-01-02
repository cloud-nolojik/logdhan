/**
 * Intraday Analysis Service
 *
 * Generates pre-market intraday analysis based on:
 * - News headlines and AI-analyzed sentiment
 * - Previous day's close and ATR(14)
 * - ATR-based levels (not pivot-based entry/SL/target)
 */

import OpenAI from 'openai';
import StockAnalysis from '../models/stockAnalysis.js';
import DailyNewsStock from '../models/dailyNewsStock.js';
import candleFetcherService from './candleFetcher.service.js';
import intradayEngine from '../engine/intradayEngine.js';
import {
  buildIntradayExplanationPrompt,
  buildIntradayAnalysisResult
} from '../prompts/intradayPrompts.js';
import { getExactStock } from '../utils/stockDb.js';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

class IntradayAnalyzeService {
  constructor() {
    this.model = 'gpt-4o-mini'; // Fast and cost-effective for explanations
  }

  /**
   * Get or generate intraday analysis for a stock
   * @param {Object} params
   * @param {string} params.instrumentKey - Upstox instrument key
   * @param {string} [params.symbol] - Stock symbol (optional, will be looked up)
   * @param {boolean} [params.forceRefresh] - Force regenerate even if cached
   * @returns {Promise<Object>} Intraday analysis result
   */
  async getOrGenerateAnalysis({ instrumentKey, symbol = null, forceRefresh = false }) {
    console.log(`\n========== [INTRADAY] START ==========`);
    console.log(`[INTRADAY] Step 0: Starting analysis`);
    console.log(`[INTRADAY]   - instrumentKey: ${instrumentKey}`);
    console.log(`[INTRADAY]   - symbol: ${symbol || 'not provided'}`);
    console.log(`[INTRADAY]   - forceRefresh: ${forceRefresh}`);

    try {
      // 1. Check for existing valid analysis
      console.log(`\n[INTRADAY] Step 1: Checking cache...`);
      if (!forceRefresh) {
        const existing = await StockAnalysis.findValidAnalysis(instrumentKey, 'intraday');
        if (existing) {
          console.log(`[INTRADAY]   ✓ Cache HIT - returning existing analysis`);
          console.log(`[INTRADAY]   - analysis_id: ${existing._id}`);
          console.log(`[INTRADAY]   - valid_until: ${existing.valid_until}`);
          return {
            success: true,
            analysis: existing,
            from_cache: true
          };
        }
        console.log(`[INTRADAY]   ✗ Cache MISS - no valid analysis found`);
      } else {
        console.log(`[INTRADAY]   ⊘ Cache SKIPPED (forceRefresh=true)`);
      }

      // 2. Get stock info if not provided
      console.log(`\n[INTRADAY] Step 2: Getting stock info...`);
      let stockInfo = { trading_symbol: symbol, name: null };
      if (!symbol) {
        console.log(`[INTRADAY]   - Symbol not provided, looking up from DB...`);
        const stockData = await getExactStock(instrumentKey);
        if (stockData) {
          stockInfo = {
            trading_symbol: stockData.trading_symbol,
            name: stockData.name
          };
          console.log(`[INTRADAY]   ✓ Found: ${stockInfo.trading_symbol} (${stockInfo.name})`);
        } else {
          console.log(`[INTRADAY]   ✗ Stock not found in DB for ${instrumentKey}`);
        }
      } else {
        console.log(`[INTRADAY]   - Using provided symbol: ${symbol}`);
      }

      // 3. Get latest news for this stock (today or most recent)
      console.log(`\n[INTRADAY] Step 3: Getting news data...`);
      const newsStock = await DailyNewsStock.findOne({
        instrument_key: instrumentKey
      }).sort({ scrape_date: -1 }); // Get most recent

      if (!newsStock) {
        console.log(`[INTRADAY]   ✗ NO NEWS FOUND for ${instrumentKey}`);
        console.log(`========== [INTRADAY] END (FAILED) ==========\n`);
        return {
          success: false,
          error: 'No news data available for this stock',
          message: 'This stock is not in the news. Intraday plan is only available for stocks with news.'
        };
      }

      console.log(`[INTRADAY]   ✓ News found:`);
      console.log(`[INTRADAY]   - symbol: ${newsStock.symbol}`);
      console.log(`[INTRADAY]   - scrape_date: ${newsStock.scrape_date}`);
      console.log(`[INTRADAY]   - news_items count: ${newsStock.news_items?.length || 0}`);
      console.log(`[INTRADAY]   - aggregate_sentiment: ${newsStock.aggregate_sentiment}`);
      console.log(`[INTRADAY]   - aggregate_impact: ${newsStock.aggregate_impact}`);
      console.log(`[INTRADAY]   - confidence_score: ${newsStock.confidence_score}`);

      // Check if news is stale (more than 2 days old)
      const today = DailyNewsStock.getISTDateAsUTC();
      const daysDiff = Math.floor((today.getTime() - newsStock.scrape_date.getTime()) / (1000 * 60 * 60 * 24));
      console.log(`[INTRADAY]   - days_old: ${daysDiff}`);

      if (daysDiff > 2) {
        console.log(`[INTRADAY]   ✗ NEWS TOO OLD (${daysDiff} days > 2 days limit)`);
        console.log(`========== [INTRADAY] END (FAILED) ==========\n`);
        return {
          success: false,
          error: 'News data is too old',
          message: `News for this stock is ${daysDiff} days old. Please wait for fresh news data.`
        };
      }

      // 4. Generate the analysis
      console.log(`\n[INTRADAY] Step 4: Generating analysis...`);
      const analysis = await this.generateIntradayAnalysis({
        instrumentKey,
        symbol: stockInfo.trading_symbol || newsStock.symbol,
        companyName: stockInfo.name || newsStock.company_name,
        newsStock
      });

      console.log(`========== [INTRADAY] END ==========\n`);
      return analysis;

    } catch (error) {
      console.error(`[INTRADAY] ❌ EXCEPTION in getOrGenerateAnalysis:`);
      console.error(`[INTRADAY]   - message: ${error.message}`);
      console.error(`[INTRADAY]   - stack: ${error.stack}`);
      console.log(`========== [INTRADAY] END (EXCEPTION) ==========\n`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Generate intraday analysis for a stock with news
   * @param {Object} params
   * @param {string} params.instrumentKey
   * @param {string} params.symbol
   * @param {string} params.companyName
   * @param {Object} params.newsStock - DailyNewsStock document
   * @returns {Promise<Object>}
   */
  async generateIntradayAnalysis({ instrumentKey, symbol, companyName, newsStock }) {
    console.log(`\n[INTRADAY] === generateIntradayAnalysis START ===`);
    console.log(`[INTRADAY] Input params:`);
    console.log(`[INTRADAY]   - instrumentKey: ${instrumentKey}`);
    console.log(`[INTRADAY]   - symbol: ${symbol}`);
    console.log(`[INTRADAY]   - companyName: ${companyName}`);

    try {
      // 1. Fetch daily candles for ATR calculation (need 15+ days)
      console.log(`\n[INTRADAY] Step 4.1: Fetching daily candles...`);
      const toDate = new Date();
      toDate.setDate(toDate.getDate() - 1); // Yesterday
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 30); // 30 days ago

      console.log(`[INTRADAY]   - fromDate: ${fromDate.toISOString()}`);
      console.log(`[INTRADAY]   - toDate: ${toDate.toISOString()}`);

      let rawCandles;
      try {
        rawCandles = await candleFetcherService.fetchCandlesFromAPI(
          instrumentKey,
          'day', // Upstox API uses 'day' not '1d'
          fromDate,
          toDate,
          true // skipIntraday - we only need daily data
        );
        console.log(`[INTRADAY]   ✓ fetchCandlesFromAPI returned: ${rawCandles?.length || 0} candles`);
      } catch (candleError) {
        console.error(`[INTRADAY]   ✗ fetchCandlesFromAPI FAILED: ${candleError.message}`);
        throw candleError;
      }

      if (!rawCandles || rawCandles.length === 0) {
        console.log(`[INTRADAY]   ✗ NO CANDLES RETURNED`);
        return {
          success: false,
          error: `No candle data returned for ${symbol}`
        };
      }

      if (rawCandles.length < 15) {
        console.log(`[INTRADAY]   ✗ INSUFFICIENT CANDLES: ${rawCandles.length} < 15`);
        return {
          success: false,
          error: `Insufficient candle data: ${rawCandles.length} days (need 15+)`
        };
      }

      // Log raw candle sample
      console.log(`\n[INTRADAY] Step 4.2: Raw candle data sample...`);
      console.log(`[INTRADAY]   - First raw candle: ${JSON.stringify(rawCandles[0])}`);
      console.log(`[INTRADAY]   - Last raw candle: ${JSON.stringify(rawCandles[rawCandles.length - 1])}`);

      // Transform raw candles - handle both array format and object format
      // Array format: [timestamp, open, high, low, close, volume, oi]
      // Object format: { timestamp, open, high, low, close, volume }
      console.log(`\n[INTRADAY] Step 4.3: Transforming candles...`);
      const isArrayFormat = Array.isArray(rawCandles[0]);
      console.log(`[INTRADAY]   - Candle format detected: ${isArrayFormat ? 'ARRAY' : 'OBJECT'}`);

      const candleData = rawCandles
        .map((candle, idx) => {
          let obj;
          if (isArrayFormat) {
            // Array format from some APIs
            obj = {
              timestamp: candle[0],
              open: candle[1],
              high: candle[2],
              low: candle[3],
              close: candle[4],
              volume: candle[5]
            };
          } else {
            // Object format (already has named properties)
            obj = {
              timestamp: candle.timestamp,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume
            };
          }
          // Log first 3 transformations for debugging
          if (idx < 3) {
            console.log(`[INTRADAY]   - Candle ${idx}: ${JSON.stringify(obj)}`);
          }
          return obj;
        })
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); // Sort ascending (oldest first)

      console.log(`[INTRADAY]   ✓ Transformed and sorted ${candleData.length} candles`);

      // Debug: Log first and last candles to verify order and data
      if (candleData.length > 0) {
        const first = candleData[0];
        const last = candleData[candleData.length - 1];
        console.log(`[INTRADAY]   - First (oldest): ${first.timestamp} - O:${first.open} H:${first.high} L:${first.low} C:${first.close}`);
        console.log(`[INTRADAY]   - Last (newest): ${last.timestamp} - O:${last.open} H:${last.high} L:${last.low} C:${last.close}`);

        // Check for any invalid values
        const hasNaN = candleData.some(c =>
          isNaN(c.open) || isNaN(c.high) || isNaN(c.low) || isNaN(c.close) ||
          c.open === null || c.high === null || c.low === null || c.close === null ||
          c.open === undefined || c.high === undefined || c.low === undefined || c.close === undefined
        );
        if (hasNaN) {
          console.log(`[INTRADAY]   ⚠️ WARNING: Some candles have NaN/null/undefined values!`);
        }
      }

      // 2. Get previous day candle (most recent)
      console.log(`\n[INTRADAY] Step 4.4: Getting previous day candle...`);
      const prevDayCandle = candleData[candleData.length - 1];
      console.log(`[INTRADAY]   - prevDayCandle: ${JSON.stringify(prevDayCandle)}`);

      // 3. Calculate ATR(14)
      console.log(`\n[INTRADAY] Step 4.5: Calculating ATR(14)...`);
      console.log(`[INTRADAY]   - Candle count: ${candleData.length}`);
      console.log(`[INTRADAY]   - Required for ATR(14): 15 candles (14 + 1)`);

      let atr14;
      try {
        atr14 = intradayEngine.calculateATR(candleData, 14);
        console.log(`[INTRADAY]   - ATR(14) result: ${atr14}`);
      } catch (atrError) {
        console.error(`[INTRADAY]   ✗ calculateATR EXCEPTION: ${atrError.message}`);
        throw atrError;
      }

      if (!atr14) {
        console.log(`[INTRADAY]   ✗ ATR CALCULATION RETURNED NULL/UNDEFINED`);
        return {
          success: false,
          error: 'Could not calculate ATR'
        };
      }

      console.log(`[INTRADAY]   ✓ ATR(14) = ${atr14}`);

      // 4. Get aggregate sentiment and impact from news
      console.log(`\n[INTRADAY] Step 4.6: Getting sentiment data...`);
      const sentiment = newsStock.aggregate_sentiment || 'NEUTRAL';
      const impact = newsStock.aggregate_impact || 'LOW';
      const confidenceScore = newsStock.confidence_score || 0.5;
      console.log(`[INTRADAY]   - sentiment: ${sentiment}`);
      console.log(`[INTRADAY]   - impact: ${impact}`);
      console.log(`[INTRADAY]   - confidenceScore: ${confidenceScore}`);

      // 5. Calculate intraday levels
      console.log(`\n[INTRADAY] Step 4.7: Calculating intraday levels...`);
      let levels;
      try {
        levels = intradayEngine.calculateIntradayLevels({
          prevDayCandle,
          atr14,
          sentiment,
          newsImpact: impact
        });
        console.log(`[INTRADAY]   ✓ Levels calculated: ${JSON.stringify(levels)}`);
      } catch (levelsError) {
        console.error(`[INTRADAY]   ✗ calculateIntradayLevels EXCEPTION: ${levelsError.message}`);
        throw levelsError;
      }

      // 6. Calculate valid_until (next market open)
      console.log(`\n[INTRADAY] Step 4.8: Calculating valid_until...`);
      let validUntil;
      try {
        validUntil = intradayEngine.calculateValidUntil(newsStock.scrape_date);
        console.log(`[INTRADAY]   ✓ valid_until: ${validUntil}`);
      } catch (validError) {
        console.error(`[INTRADAY]   ✗ calculateValidUntil EXCEPTION: ${validError.message}`);
        throw validError;
      }

      // 7. Generate AI explanation
      console.log(`\n[INTRADAY] Step 4.9: Generating AI explanation...`);
      let aiReasoning = '';
      try {
        aiReasoning = await this.generateAIExplanation({
          symbol,
          companyName,
          headlines: newsStock.news_items,
          aggregateSentiment: sentiment,
          aggregateImpact: impact,
          levels,
          prevDayCandle
        });
        console.log(`[INTRADAY]   ✓ AI explanation generated (${aiReasoning.length} chars)`);
      } catch (aiError) {
        console.error(`[INTRADAY]   ⚠️ AI explanation FAILED (using fallback): ${aiError.message}`);
        aiReasoning = 'AI explanation unavailable. Trade levels calculated based on ATR and news sentiment.';
      }

      // 8. Build analysis result
      console.log(`\n[INTRADAY] Step 4.10: Building analysis result...`);
      let analysisResult;
      try {
        analysisResult = buildIntradayAnalysisResult({
          symbol,
          instrumentKey,
          companyName,
          headlines: newsStock.news_items,
          sentiment,
          impact,
          confidenceScore,
          levels,
          prevDayCandle,
          aiReasoning,
          validUntil
        });
        console.log(`[INTRADAY]   ✓ Analysis result built`);
      } catch (buildError) {
        console.error(`[INTRADAY]   ✗ buildIntradayAnalysisResult EXCEPTION: ${buildError.message}`);
        throw buildError;
      }

      // 9. Save to StockAnalysis collection
      console.log(`\n[INTRADAY] Step 4.11: Saving to database...`);
      let savedAnalysis;
      try {
        savedAnalysis = await this.saveAnalysis({
          instrumentKey,
          symbol,
          companyName,
          currentPrice: prevDayCandle.close,
          analysisResult,
          validUntil
        });
        console.log(`[INTRADAY]   ✓ Saved with _id: ${savedAnalysis._id}`);
      } catch (saveError) {
        console.error(`[INTRADAY]   ✗ saveAnalysis EXCEPTION: ${saveError.message}`);
        throw saveError;
      }

      // 10. Link analysis to DailyNewsStock
      console.log(`\n[INTRADAY] Step 4.12: Linking to DailyNewsStock...`);
      try {
        await DailyNewsStock.linkAnalysis(
          newsStock.symbol,
          newsStock.scrape_date,
          savedAnalysis._id
        );
        console.log(`[INTRADAY]   ✓ Linked analysis to news stock`);
      } catch (linkError) {
        console.error(`[INTRADAY]   ⚠️ linkAnalysis FAILED (non-critical): ${linkError.message}`);
        // Don't throw - this is non-critical
      }

      console.log(`\n[INTRADAY] === generateIntradayAnalysis SUCCESS ===`);
      console.log(`[INTRADAY] Final result: direction=${levels.direction}, entry=${levels.entry}, sl=${levels.stop_loss}, t1=${levels.target_1}`);

      return {
        success: true,
        analysis: savedAnalysis,
        from_cache: false
      };

    } catch (error) {
      console.error(`\n[INTRADAY] ❌ EXCEPTION in generateIntradayAnalysis:`);
      console.error(`[INTRADAY]   - message: ${error.message}`);
      console.error(`[INTRADAY]   - stack: ${error.stack}`);
      console.log(`[INTRADAY] === generateIntradayAnalysis FAILED ===\n`);
      throw error;
    }
  }

  /**
   * Generate AI explanation for the trade
   */
  async generateAIExplanation({
    symbol,
    companyName,
    headlines,
    aggregateSentiment,
    aggregateImpact,
    levels,
    prevDayCandle
  }) {
    console.log(`[INTRADAY] AI: Building prompt for ${symbol}...`);

    const prompt = buildIntradayExplanationPrompt({
      symbol,
      companyName,
      headlines: headlines.map(h => ({
        text: h.headline,
        sentiment: h.sentiment,
        impact: h.impact
      })),
      aggregateSentiment,
      aggregateImpact,
      levels,
      prevDayCandle
    });

    console.log(`[INTRADAY] AI: Calling OpenAI (model: ${this.model})...`);
    const response = await openai.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.7
    });

    console.log(`[INTRADAY] AI: Response received`);
    return response.choices[0].message.content.trim();
  }

  /**
   * Save analysis to database
   */
  async saveAnalysis({ instrumentKey, symbol, companyName, currentPrice, analysisResult, validUntil }) {
    console.log(`[INTRADAY] DB: Creating StockAnalysis document...`);

    // Create new StockAnalysis document
    const analysis = new StockAnalysis({
      instrument_key: instrumentKey,
      stock_name: companyName || symbol,
      stock_symbol: symbol,
      analysis_type: 'intraday',
      current_price: currentPrice,
      status: 'completed',
      valid_until: validUntil,
      progress: {
        percentage: 100,
        current_step: 'Analysis completed',
        steps_completed: 4,
        total_steps: 4,
        estimated_time_remaining: 0
      },
      // Store intraday-specific data in analysis_data
      analysis_data: {
        schema_version: analysisResult.schema_version,
        intraday: analysisResult  // Store full intraday result
      }
    });

    console.log(`[INTRADAY] DB: Saving document...`);
    await analysis.save();
    console.log(`[INTRADAY] DB: Document saved with _id: ${analysis._id}`);

    return analysis;
  }

  /**
   * Get analysis status for a stock
   */
  async getAnalysisStatus(instrumentKey) {
    const existing = await StockAnalysis.findValidAnalysis(instrumentKey, 'intraday');

    if (!existing) {
      // Check if in recent news (up to 2 days)
      const newsStock = await DailyNewsStock.findOne({
        instrument_key: instrumentKey
      }).sort({ scrape_date: -1 });

      const today = DailyNewsStock.getISTDateAsUTC();
      let isRecent = false;
      if (newsStock) {
        const daysDiff = Math.floor((today.getTime() - newsStock.scrape_date.getTime()) / (1000 * 60 * 60 * 24));
        isRecent = daysDiff <= 2;
      }

      return {
        has_analysis: false,
        in_news_today: !!newsStock && isRecent,
        can_analyze: !!newsStock && isRecent
      };
    }

    return {
      has_analysis: true,
      analysis_id: existing._id,
      direction: existing.analysis_data?.intraday?.direction,
      valid_until: existing.valid_until,
      is_valid: intradayEngine.isIntradayAnalysisValid(existing)
    };
  }
}

// Export singleton
const intradayAnalyzeService = new IntradayAnalyzeService();
export default intradayAnalyzeService;
