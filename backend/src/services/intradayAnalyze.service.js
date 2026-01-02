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
    console.log(`[INTRADAY] Starting analysis for ${symbol || instrumentKey}`);

    try {
      // 1. Check for existing valid analysis
      if (!forceRefresh) {
        const existing = await StockAnalysis.findValidAnalysis(instrumentKey, 'intraday');
        if (existing) {
          console.log(`[INTRADAY] Cache hit for ${symbol || instrumentKey}`);
          return {
            success: true,
            analysis: existing,
            from_cache: true
          };
        }
      }

      // 2. Get stock info if not provided
      let stockInfo = { trading_symbol: symbol, name: null };
      if (!symbol) {
        const stockData = await getExactStock(instrumentKey);
        if (stockData) {
          stockInfo = {
            trading_symbol: stockData.trading_symbol,
            name: stockData.name
          };
        }
      }

      // 3. Get latest news for this stock (today or most recent)
      const newsStock = await DailyNewsStock.findOne({
        instrument_key: instrumentKey
      }).sort({ scrape_date: -1 }); // Get most recent

      if (!newsStock) {
        return {
          success: false,
          error: 'No news data available for this stock',
          message: 'This stock is not in the news. Intraday plan is only available for stocks with news.'
        };
      }

      // Check if news is stale (more than 2 days old)
      const today = DailyNewsStock.getISTDateAsUTC();
      const daysDiff = Math.floor((today.getTime() - newsStock.scrape_date.getTime()) / (1000 * 60 * 60 * 24));
      if (daysDiff > 2) {
        return {
          success: false,
          error: 'News data is too old',
          message: `News for this stock is ${daysDiff} days old. Please wait for fresh news data.`
        };
      }

      // 4. Generate the analysis
      const analysis = await this.generateIntradayAnalysis({
        instrumentKey,
        symbol: stockInfo.trading_symbol || newsStock.symbol,
        companyName: stockInfo.name || newsStock.company_name,
        newsStock
      });

      return analysis;

    } catch (error) {
      console.error(`[INTRADAY] Error analyzing ${symbol || instrumentKey}:`, error);
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
    console.log(`[INTRADAY] Generating analysis for ${symbol}`);

    try {
      // 1. Fetch daily candles for ATR calculation (need 15+ days)
      // Calculate date range: from 30 days ago to yesterday
      const toDate = new Date();
      toDate.setDate(toDate.getDate() - 1); // Yesterday
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 30); // 30 days ago

      console.log(`[INTRADAY] Fetching candles from ${fromDate.toISOString()} to ${toDate.toISOString()}`);

      const rawCandles = await candleFetcherService.fetchCandlesFromAPI(
        instrumentKey,
        'day', // Upstox API uses 'day' not '1d'
        fromDate,
        toDate,
        true // skipIntraday - we only need daily data
      );

      if (!rawCandles || rawCandles.length < 15) {
        return {
          success: false,
          error: `Insufficient candle data: ${rawCandles?.length || 0} days (need 15+)`
        };
      }

      // Transform raw candles from Upstox format [timestamp, open, high, low, close, volume, oi]
      // to object format for ATR calculation
      const candleData = rawCandles.map(candle => ({
        timestamp: candle[0],
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5]
      }));

      console.log(`[INTRADAY] Got ${candleData.length} daily candles for ${symbol}`);

      // 2. Get previous day candle (most recent)
      const prevDayCandle = candleData[candleData.length - 1];

      // 3. Calculate ATR(14)
      const atr14 = intradayEngine.calculateATR(candleData, 14);

      if (!atr14) {
        return {
          success: false,
          error: 'Could not calculate ATR'
        };
      }

      // 4. Get aggregate sentiment and impact from news
      const sentiment = newsStock.aggregate_sentiment || 'NEUTRAL';
      const impact = newsStock.aggregate_impact || 'LOW';
      const confidenceScore = newsStock.confidence_score || 0.5;

      // 5. Calculate intraday levels
      const levels = intradayEngine.calculateIntradayLevels({
        prevDayCandle,
        atr14,
        sentiment,
        newsImpact: impact
      });

      // 6. Calculate valid_until (next market open)
      const validUntil = intradayEngine.calculateValidUntil(newsStock.scrape_date);

      // 7. Generate AI explanation
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
      } catch (aiError) {
        console.error(`[INTRADAY] AI explanation failed for ${symbol}:`, aiError.message);
        aiReasoning = 'AI explanation unavailable. Trade levels calculated based on ATR and news sentiment.';
      }

      // 8. Build analysis result
      const analysisResult = buildIntradayAnalysisResult({
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

      // 9. Save to StockAnalysis collection
      const savedAnalysis = await this.saveAnalysis({
        instrumentKey,
        symbol,
        companyName,
        currentPrice: prevDayCandle.close,
        analysisResult,
        validUntil
      });

      // 10. Link analysis to DailyNewsStock
      await DailyNewsStock.linkAnalysis(
        newsStock.symbol,
        newsStock.scrape_date,
        savedAnalysis._id
      );

      console.log(`[INTRADAY] Analysis complete for ${symbol}: direction=${levels.direction}`);

      return {
        success: true,
        analysis: savedAnalysis,
        from_cache: false
      };

    } catch (error) {
      console.error(`[INTRADAY] Generation failed for ${symbol}:`, error);
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

    const response = await openai.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.7
    });

    return response.choices[0].message.content.trim();
  }

  /**
   * Save analysis to database
   */
  async saveAnalysis({ instrumentKey, symbol, companyName, currentPrice, analysisResult, validUntil }) {
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

    await analysis.save();

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
