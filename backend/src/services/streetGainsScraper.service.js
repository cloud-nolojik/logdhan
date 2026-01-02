/**
 * Stock News Scraper Service
 *
 * Fetches Indian stock market news using OpenAI's web search API.
 * Sources: MoneyControl, Economic Times, Business Standard, LiveMint
 *
 * Sections scraped:
 * - Pre-Market News
 * - Stocks to Watch
 * - Market Sentiment (Nifty 50 outlook)
 */

import { v4 as uuidv4 } from 'uuid';
import Stock from '../models/stock.js';
import DailyNewsStock from '../models/dailyNewsStock.js';
import SentimentCache from '../models/sentimentCache.js';
import MarketSentiment from '../models/marketSentiment.js';
import OpenAI from 'openai';

const SCRAPE_VERSION = 'v2-web-search';

// News sources to search (Indian stock market)
const NEWS_DOMAINS = [
  'moneycontrol.com',
  'economictimes.indiatimes.com',
  'business-standard.com',
  'livemint.com',
  'ndtvprofit.com',
  'zeebiz.com'
];

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Map raw symbol to Upstox instrument_key
 * @param {string} rawSymbol - Symbol from news
 * @returns {Promise<{ instrument_key: string|null, trading_symbol: string, company_name: string|null }>}
 */
async function mapSymbolToInstrumentKey(rawSymbol) {
  const cleanSymbol = rawSymbol.trim().toUpperCase();

  try {
    // Lookup in Stock collection (NSE equity first)
    const stock = await Stock.findOne({
      trading_symbol: cleanSymbol,
      segment: 'NSE_EQ',
      is_active: true
    }).lean();

    if (stock) {
      return {
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        company_name: stock.name
      };
    }

    // Fallback: Try BSE
    const bseStock = await Stock.findOne({
      trading_symbol: cleanSymbol,
      segment: 'BSE_EQ',
      is_active: true
    }).lean();

    if (bseStock) {
      return {
        instrument_key: bseStock.instrument_key,
        trading_symbol: bseStock.trading_symbol,
        company_name: bseStock.name
      };
    }

    // Not found
    return {
      instrument_key: null,
      trading_symbol: cleanSymbol,
      company_name: null
    };
  } catch (error) {
    console.error(`[NewsSearch] Error mapping symbol ${rawSymbol}:`, error.message);
    return {
      instrument_key: null,
      trading_symbol: cleanSymbol,
      company_name: null
    };
  }
}

/**
 * Analyze headlines sentiment using AI (batch per stock)
 * @param {string} symbol - Stock symbol
 * @param {{ text: string, hash: string }[]} headlines - Headlines to analyze
 * @returns {Promise<{ sentiment: string, impact: string, reason: string }[]>}
 */
async function analyzeHeadlinesSentiment(symbol, headlines) {
  if (!headlines || headlines.length === 0) return [];

  // Check cache first
  const hashes = headlines.map(h => h.hash);
  const cachedResults = await SentimentCache.getByHashes(hashes);

  // Separate cached and uncached
  const results = [];
  const uncached = [];

  for (const headline of headlines) {
    if (cachedResults[headline.hash]) {
      results.push({
        ...headline,
        ...cachedResults[headline.hash]
      });
    } else {
      uncached.push(headline);
    }
  }

  // If all cached, return early
  if (uncached.length === 0) {
    console.log(`[NewsSearch] All ${headlines.length} headlines cached for ${symbol}`);
    return results;
  }

  // Analyze uncached headlines via AI
  try {
    console.log(`[NewsSearch] Analyzing ${uncached.length} uncached headlines for ${symbol}`);

    const prompt = `
Analyze these news headlines for ${symbol}:
${uncached.map((h, i) => `${i + 1}. "${h.text}"`).join('\n')}

Return JSON object with "items" array:
{
  "items": [
    {
      "index": 1,
      "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
      "impact": "HIGH" | "MEDIUM" | "LOW",
      "reason": "one sentence explanation"
    }
  ]
}

Impact guide:
- HIGH: Results, SEBI, fraud, major deals, management changes
- MEDIUM: Order wins, contracts, routine announcements
- LOW: General mentions, sector news
`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_tokens: 1000
    });

    const parsed = JSON.parse(response.choices[0].message.content);
    const items = parsed.items || [];

    // Cache and add to results
    const cacheItems = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const headline = uncached[i];

      if (headline) {
        const result = {
          ...headline,
          sentiment: item.sentiment,
          impact: item.impact,
          reason: item.reason
        };
        results.push(result);

        cacheItems.push({
          hash: headline.hash,
          headline: headline.text,
          sentiment: item.sentiment,
          impact: item.impact,
          reason: item.reason
        });
      }
    }

    // Bulk cache
    if (cacheItems.length > 0) {
      await SentimentCache.bulkCacheSentiments(cacheItems);
    }

    return results;
  } catch (error) {
    console.error(`[NewsSearch] AI sentiment analysis error for ${symbol}:`, error.message);

    // Return uncached without sentiment (will be analyzed later)
    return [
      ...results,
      ...uncached.map(h => ({
        ...h,
        sentiment: null,
        impact: null,
        reason: null
      }))
    ];
  }
}

/**
 * Fetch Indian stock market news using OpenAI web search
 * @returns {Promise<{ stocks: Object, metadata: object }>}
 */
async function fetchStockNewsWithWebSearch() {
  try {
    console.log('[NewsSearch] Fetching Indian stock market news via web search...');

    // Get today's date in IST
    const today = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(today.getTime() + istOffset);
    const dateStr = istDate.toISOString().split('T')[0];

    const searchPrompt = `Search for today's (${dateStr}) Indian stock market pre-market news and stocks to watch.

Find news about specific NSE/BSE listed stocks that have important announcements, results, SEBI orders, management changes, order wins, or significant corporate actions.

Return a JSON object with this exact structure:
{
  "stocks": {
    "SYMBOL": [
      {
        "text": "Full headline text mentioning the stock",
        "category": "PRE_MARKET_NEWS" or "STOCKS_TO_WATCH"
      }
    ]
  },
  "sources_used": ["list of news sources"],
  "news_date": "${dateStr}"
}

Rules:
1. Only include NSE/BSE listed Indian stocks
2. Use official trading symbols (e.g., RELIANCE, TCS, INFY, HDFCBANK)
3. Each headline should be the actual news headline, not a summary
4. Focus on actionable news that could affect stock prices today
5. Include 10-20 stocks with the most significant news
6. Categorize as PRE_MARKET_NEWS for breaking news or STOCKS_TO_WATCH for stocks with potential movement`;

    const response = await openai.responses.create({
      model: 'gpt-4o',
      tools: [{
        type: 'web_search',
        user_location: {
          type: 'approximate',
          country: 'IN',
          city: 'Mumbai',
          region: 'Maharashtra'
        }
      }],
      input: searchPrompt
    });

    // Extract the text response
    const outputText = response.output_text || '';

    console.log('[NewsSearch] Web search completed, parsing results...');

    // Try to extract JSON from the response
    let stocksData = {};
    let metadata = {
      sources_used: [],
      news_date: dateStr
    };

    // Look for JSON in the response
    const jsonMatch = outputText.match(/\{[\s\S]*"stocks"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        stocksData = parsed.stocks || {};
        metadata.sources_used = parsed.sources_used || [];
        metadata.news_date = parsed.news_date || dateStr;
      } catch (parseError) {
        console.error('[NewsSearch] JSON parse error, trying fallback extraction...');
        // Fallback: Extract stock mentions from text
        stocksData = extractStocksFromText(outputText);
      }
    } else {
      // Fallback: Extract stock mentions from text
      stocksData = extractStocksFromText(outputText);
    }

    // Get sources from annotations if available
    if (response.output && Array.isArray(response.output)) {
      const messageOutput = response.output.find(o => o.type === 'message');
      if (messageOutput?.content?.[0]?.annotations) {
        const urls = messageOutput.content[0].annotations
          .filter(a => a.type === 'url_citation')
          .map(a => a.url);
        metadata.sources_used = [...new Set(urls)].slice(0, 10);
      }
    }

    const stockCount = Object.keys(stocksData).length;
    console.log(`[NewsSearch] Found news for ${stockCount} stocks`);

    return {
      stocks: stocksData,
      metadata: {
        ...metadata,
        foundHeadlines: Object.values(stocksData).flat().length
      }
    };

  } catch (error) {
    console.error('[NewsSearch] Web search error:', error.message);
    throw error;
  }
}

/**
 * Fallback: Extract stock symbols and news from plain text
 * @param {string} text - Response text
 * @returns {Object} Stocks map
 */
function extractStocksFromText(text) {
  const stocks = {};

  // Common Indian stock symbols pattern
  const symbolPattern = /\b([A-Z]{2,15}(?:BANK|LIFE|PHARMA|TECH|INFRA)?)\b/g;

  // Known major stocks to look for
  const knownSymbols = [
    'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'KOTAKBANK',
    'SBIN', 'AXISBANK', 'BAJFINANCE', 'BHARTIARTL', 'ITC', 'HINDUNILVR',
    'ASIANPAINT', 'MARUTI', 'TATAMOTORS', 'TATASTEEL', 'WIPRO', 'HCLTECH',
    'SUNPHARMA', 'DRREDDY', 'CIPLA', 'ADANIENT', 'ADANIPORTS', 'ADANIGREEN',
    'POWERGRID', 'NTPC', 'ONGC', 'COALINDIA', 'BPCL', 'IOC', 'GAIL',
    'TITAN', 'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT', 'M&M', 'LT',
    'ULTRACEMCO', 'GRASIM', 'INDUSINDBK', 'TECHM', 'NESTLEIND', 'BRITANNIA'
  ];

  // Split into sentences
  const sentences = text.split(/[.!?\n]+/);

  for (const sentence of sentences) {
    const upperSentence = sentence.toUpperCase();

    for (const symbol of knownSymbols) {
      if (upperSentence.includes(symbol) && sentence.trim().length > 20) {
        if (!stocks[symbol]) {
          stocks[symbol] = [];
        }
        // Avoid duplicates
        const exists = stocks[symbol].some(s => s.text === sentence.trim());
        if (!exists && stocks[symbol].length < 3) {
          stocks[symbol].push({
            text: sentence.trim(),
            category: 'PRE_MARKET_NEWS'
          });
        }
      }
    }
  }

  return stocks;
}

/**
 * Fetch Nifty 50 market sentiment using OpenAI web search
 * @param {string} scrapeRunId - UUID for this scrape run
 * @returns {Promise<Object>} Market sentiment data
 */
async function fetchMarketSentiment(scrapeRunId) {
  try {
    console.log('[NewsSearch] Fetching Nifty 50 market sentiment...');

    // Get today's date in IST
    const today = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(today.getTime() + istOffset);
    const dateStr = istDate.toISOString().split('T')[0];

    const searchPrompt = `Search for today's (${dateStr}) Nifty 50 pre-market outlook and market sentiment for Indian stock markets.

Look for:
1. SGX Nifty / GIFT Nifty futures indication
2. US market overnight performance (Dow Jones, S&P 500, Nasdaq)
3. Asian markets trend (Nikkei, Hang Seng, etc.)
4. FII/DII activity from previous session
5. Key support and resistance levels for Nifty 50
6. Any major global events affecting markets

Return a JSON object with this exact structure:
{
  "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH",
  "confidence": 0.0 to 1.0,
  "summary": "One paragraph summary of market outlook",
  "key_factors": [
    { "factor": "Description of factor", "impact": "POSITIVE" | "NEGATIVE" | "NEUTRAL" }
  ],
  "levels": {
    "support_1": number,
    "support_2": number,
    "resistance_1": number,
    "resistance_2": number
  },
  "global_cues": {
    "us_markets": "POSITIVE" | "NEGATIVE" | "MIXED" | "FLAT",
    "asian_markets": "POSITIVE" | "NEGATIVE" | "MIXED" | "FLAT",
    "sgx_nifty": "POSITIVE" | "NEGATIVE" | "FLAT"
  },
  "institutional_activity": {
    "fii_trend": "BUYING" | "SELLING" | "NEUTRAL",
    "dii_trend": "BUYING" | "SELLING" | "NEUTRAL"
  }
}

Be specific about the sentiment - BULLISH means expecting 0.5%+ gains, BEARISH means expecting 0.5%+ losses, NEUTRAL means flat/rangebound.`;

    const response = await openai.responses.create({
      model: 'gpt-4o',
      tools: [{
        type: 'web_search',
        user_location: {
          type: 'approximate',
          country: 'IN',
          city: 'Mumbai',
          region: 'Maharashtra'
        }
      }],
      input: searchPrompt
    });

    const outputText = response.output_text || '';

    console.log('[NewsSearch] Market sentiment search completed, parsing...');

    // Try to extract JSON
    let sentimentData = null;
    const jsonMatch = outputText.match(/\{[\s\S]*"sentiment"[\s\S]*\}/);

    if (jsonMatch) {
      try {
        sentimentData = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error('[NewsSearch] Market sentiment JSON parse error');
      }
    }

    // Fallback: Extract sentiment from text
    if (!sentimentData) {
      const lowerText = outputText.toLowerCase();
      let sentiment = 'NEUTRAL';

      if (lowerText.includes('bullish') || lowerText.includes('positive opening') || lowerText.includes('gap up')) {
        sentiment = 'BULLISH';
      } else if (lowerText.includes('bearish') || lowerText.includes('negative opening') || lowerText.includes('gap down')) {
        sentiment = 'BEARISH';
      }

      sentimentData = {
        sentiment,
        confidence: 0.5,
        summary: outputText.substring(0, 500),
        key_factors: [],
        global_cues: {},
        institutional_activity: {}
      };
    }

    // Save to database
    const marketSentimentData = {
      index_name: 'NIFTY_50',
      sentiment: sentimentData.sentiment || 'NEUTRAL',
      confidence: sentimentData.confidence || 0.5,
      summary: sentimentData.summary,
      key_factors: sentimentData.key_factors || [],
      levels: sentimentData.levels || {},
      global_cues: sentimentData.global_cues || {},
      institutional_activity: sentimentData.institutional_activity || {},
      source: {
        name: 'Web Search',
        scraped_at: new Date()
      },
      scrape_run_id: scrapeRunId
    };

    const saved = await MarketSentiment.upsertTodaySentiment(marketSentimentData);
    console.log(`[NewsSearch] Market sentiment saved: ${saved.sentiment} (confidence: ${saved.confidence})`);

    return saved;

  } catch (error) {
    console.error('[NewsSearch] Market sentiment fetch error:', error.message);
    return null;
  }
}

/**
 * Main scraper function - fetches and stores daily news stocks
 * @returns {Promise<{ success: boolean, stocks_count: number, scrape_run_id: string }>}
 */
export async function scrapeAndStoreDailyNewsStocks() {
  const scrapeRunId = uuidv4();
  const scrapeDate = DailyNewsStock.getISTDateAsUTC();

  console.log(`[NewsSearch] Starting news fetch run: ${scrapeRunId}`);
  console.log(`[NewsSearch] Scrape date (IST): ${scrapeDate.toISOString()}`);

  try {
    // Fetch market sentiment first (Nifty 50 outlook)
    const marketSentiment = await fetchMarketSentiment(scrapeRunId);

    // Fetch news via web search
    const { stocks: scrapedStocks, metadata } = await fetchStockNewsWithWebSearch();

    if (Object.keys(scrapedStocks).length === 0) {
      console.warn('[NewsSearch] No stocks found in search, checking for fallback...');

      // Check if we have existing data for today
      const existingData = await DailyNewsStock.getTodayStocks();
      if (existingData.length > 0) {
        console.log('[NewsSearch] Using existing data for today');
        return {
          success: true,
          stocks_count: existingData.length,
          scrape_run_id: existingData[0].scrape_run_id,
          is_fallback: true
        };
      }

      return {
        success: false,
        stocks_count: 0,
        scrape_run_id: scrapeRunId,
        error: 'No stocks found in news search'
      };
    }

    // Process each stock
    const processedStocks = [];

    for (const [rawSymbol, headlines] of Object.entries(scrapedStocks)) {
      // Map symbol to instrument_key
      const { instrument_key, trading_symbol, company_name } = await mapSymbolToInstrumentKey(rawSymbol);

      // Generate headline hashes
      const headlinesWithHash = headlines.map(h => ({
        text: h.text,
        category: h.category,
        hash: DailyNewsStock.generateHeadlineHash(h.text)
      }));

      // Analyze sentiment
      const analyzedHeadlines = await analyzeHeadlinesSentiment(trading_symbol, headlinesWithHash);

      // Calculate aggregates
      const { sentiment, impact } = DailyNewsStock.calculateAggregateSentiment(analyzedHeadlines);
      const confidenceScore = DailyNewsStock.calculateConfidenceScore(analyzedHeadlines);

      // Build news items
      const newsItems = analyzedHeadlines.map(h => ({
        headline: h.text,
        headline_hash: h.hash,
        category: h.category,
        sentiment: h.sentiment,
        impact: h.impact,
        sentiment_reason: h.reason
      }));

      // Upsert stock
      const stockData = {
        instrument_key,
        symbol: trading_symbol,
        company_name,
        source: {
          name: 'Web Search (Multiple Sources)',
          url: metadata.sources_used?.[0] || 'https://moneycontrol.com',
          scraped_at: new Date()
        },
        scrape_run_id: scrapeRunId,
        scrape_version: SCRAPE_VERSION,
        news_items: newsItems,
        aggregate_sentiment: sentiment,
        aggregate_impact: impact,
        confidence_score: confidenceScore
      };

      const saved = await DailyNewsStock.upsertTodayStock(stockData);
      processedStocks.push(saved);

      console.log(`[NewsSearch] Processed ${trading_symbol}: ${newsItems.length} headlines, sentiment=${sentiment}, confidence=${confidenceScore.toFixed(2)}`);
    }

    console.log(`[NewsSearch] News fetch complete: ${processedStocks.length} stocks processed`);

    return {
      success: true,
      stocks_count: processedStocks.length,
      scrape_run_id: scrapeRunId,
      market_sentiment: marketSentiment ? {
        sentiment: marketSentiment.sentiment,
        confidence: marketSentiment.confidence,
        summary: marketSentiment.summary
      } : null,
      metadata
    };

  } catch (error) {
    console.error('[NewsSearch] Fetch and store error:', error.message);

    return {
      success: false,
      stocks_count: 0,
      scrape_run_id: scrapeRunId,
      error: error.message
    };
  }
}

/**
 * Get today's news stocks (or fallback to latest)
 * @returns {Promise<{ stocks: Array, scrape_date: Date, is_today: boolean }>}
 */
export async function getTodayNewsStocks() {
  const { stocks, is_today } = await DailyNewsStock.getTodayOrLatest();

  if (stocks.length === 0) {
    return {
      stocks: [],
      scrape_date: null,
      is_today: false,
      message: 'No news stocks available'
    };
  }

  const scrapeDate = stocks[0].scrape_date;

  return {
    stocks,
    scrape_date: scrapeDate,
    is_today,
    source: stocks[0].source
  };
}

/**
 * Get today's market sentiment (Nifty 50)
 * @returns {Promise<Object>} Market sentiment data
 */
export async function getTodayMarketSentiment() {
  const { sentiment, is_today } = await MarketSentiment.getTodayOrLatest('NIFTY_50');

  if (!sentiment) {
    return {
      sentiment: null,
      is_today: false,
      message: 'No market sentiment available'
    };
  }

  return {
    sentiment: {
      index_name: sentiment.index_name,
      sentiment: sentiment.sentiment,
      confidence: sentiment.confidence,
      summary: sentiment.summary,
      key_factors: sentiment.key_factors,
      levels: sentiment.levels,
      global_cues: sentiment.global_cues,
      institutional_activity: sentiment.institutional_activity,
      analysis_date: sentiment.analysis_date
    },
    is_today
  };
}

export default {
  scrapeAndStoreDailyNewsStocks,
  getTodayNewsStocks,
  getTodayMarketSentiment,
  mapSymbolToInstrumentKey,
  analyzeHeadlinesSentiment
};
