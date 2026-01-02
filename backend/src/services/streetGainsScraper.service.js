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
import ApiUsage from '../models/apiUsage.js';
import OpenAI from 'openai';

const SCRAPE_VERSION = 'v3-web-search';

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
 * Map symbol/instrument_key to stock details
 * OpenAI now returns instrument_keys (NSE_EQ|ISIN) or company names as fallback
 * @param {string} rawKey - Key from OpenAI (instrument_key like NSE_EQ|INE... or company name)
 * @returns {Promise<{ instrument_key: string|null, trading_symbol: string, company_name: string|null }>}
 */
async function mapSymbolToInstrumentKey(rawKey) {
  const cleanKey = rawKey.trim();

  try {
    // 1. Check if it's already an instrument_key format (NSE_EQ|INE...)
    if (cleanKey.match(/^NSE_EQ\|INE[A-Z0-9]+$/i)) {
      const stock = await Stock.findOne({
        instrument_key: cleanKey,
        is_active: true
      }).lean();

      if (stock) {
        console.log(`[NewsSearch] Direct instrument_key match: ${cleanKey} -> ${stock.trading_symbol}`);
        return {
          instrument_key: stock.instrument_key,
          trading_symbol: stock.trading_symbol,
          company_name: stock.name
        };
      }

      // Try case-insensitive search on ISIN part
      const isinPart = cleanKey.split('|')[1];
      if (isinPart) {
        const stockByIsin = await Stock.findOne({
          instrument_key: { $regex: `NSE_EQ\\|${isinPart}`, $options: 'i' },
          is_active: true
        }).lean();

        if (stockByIsin) {
          console.log(`[NewsSearch] ISIN match: ${isinPart} -> ${stockByIsin.trading_symbol}`);
          return {
            instrument_key: stockByIsin.instrument_key,
            trading_symbol: stockByIsin.trading_symbol,
            company_name: stockByIsin.name
          };
        }
      }

      console.warn(`[NewsSearch] Invalid instrument_key, not found: ${cleanKey}`);
    }

    // 2. Check if it's a BSE instrument_key format (BSE_EQ|INE...)
    if (cleanKey.match(/^BSE_EQ\|INE[A-Z0-9]+$/i)) {
      const stock = await Stock.findOne({
        instrument_key: cleanKey,
        is_active: true
      }).lean();

      if (stock) {
        console.log(`[NewsSearch] BSE instrument_key match: ${cleanKey} -> ${stock.trading_symbol}`);
        return {
          instrument_key: stock.instrument_key,
          trading_symbol: stock.trading_symbol,
          company_name: stock.name
        };
      }
    }

    // From here, treat as trading symbol or company name (fallback)
    const cleanSymbol = cleanKey.toUpperCase();

    // 3. Direct match on NSE trading_symbol
    let stock = await Stock.findOne({
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

    // 4. Try without underscores (fallback for any edge cases)
    const normalizedSymbol = cleanSymbol.replace(/_/g, '');
    if (normalizedSymbol !== cleanSymbol) {
      stock = await Stock.findOne({
        trading_symbol: normalizedSymbol,
        segment: 'NSE_EQ',
        is_active: true
      }).lean();

      if (stock) {
        console.log(`[NewsSearch] Mapped ${rawKey} -> ${stock.trading_symbol} (normalized)`);
        return {
          instrument_key: stock.instrument_key,
          trading_symbol: stock.trading_symbol,
          company_name: stock.name
        };
      }
    }

    // 5. Try trading_symbol regex match (handles cases like MAHINDRA&M -> M&M)
    const symbolParts = cleanSymbol.split(/[_\s&-]/).filter(p => p.length > 0);
    if (symbolParts.length > 0) {
      const firstPart = symbolParts[0];
      stock = await Stock.findOne({
        trading_symbol: { $regex: firstPart.substring(0, 3), $options: 'i' },
        name: { $regex: firstPart, $options: 'i' },
        segment: 'NSE_EQ',
        is_active: true
      }).lean();

      if (stock) {
        console.log(`[NewsSearch] Mapped ${rawKey} -> ${stock.trading_symbol} (partial match)`);
        return {
          instrument_key: stock.instrument_key,
          trading_symbol: stock.trading_symbol,
          company_name: stock.name
        };
      }
    }

    // 6. Regex search on company name
    const nameParts = cleanSymbol.split(/[_\s&-]/).filter(p => p.length > 2);
    if (nameParts.length > 0) {
      const regexPattern = '^' + nameParts.join('.*');
      stock = await Stock.findOne({
        name: { $regex: regexPattern, $options: 'i' },
        segment: 'NSE_EQ',
        is_active: true
      }).lean();

      if (stock) {
        console.log(`[NewsSearch] Mapped ${rawKey} -> ${stock.trading_symbol} (name regex)`);
        return {
          instrument_key: stock.instrument_key,
          trading_symbol: stock.trading_symbol,
          company_name: stock.name
        };
      }
    }

    // 7. First word match fallback
    if (nameParts.length > 0) {
      const firstWord = nameParts[0];
      if (firstWord.length >= 4) {
        stock = await Stock.findOne({
          name: { $regex: `^${firstWord}`, $options: 'i' },
          segment: 'NSE_EQ',
          is_active: true
        }).sort({ trading_symbol: 1 }).lean();

        if (stock) {
          console.log(`[NewsSearch] Mapped ${rawKey} -> ${stock.trading_symbol} (first word match)`);
          return {
            instrument_key: stock.instrument_key,
            trading_symbol: stock.trading_symbol,
            company_name: stock.name
          };
        }
      }
    }

    // 8. Fallback: Try BSE
    stock = await Stock.findOne({
      trading_symbol: cleanSymbol,
      segment: 'BSE_EQ',
      is_active: true
    }).lean();

    if (stock) {
      console.log(`[NewsSearch] Mapped ${rawKey} -> ${stock.trading_symbol} (BSE)`);
      return {
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        company_name: stock.name
      };
    }

    // Not found
    console.warn(`[NewsSearch] Could not map key: ${rawKey}`);
    return {
      instrument_key: null,
      trading_symbol: cleanSymbol,
      company_name: null
    };
  } catch (error) {
    console.error(`[NewsSearch] Error mapping key ${rawKey}:`, error.message);
    return {
      instrument_key: null,
      trading_symbol: cleanKey.toUpperCase(),
      company_name: null
    };
  }
}

/**
 * Analyze headlines sentiment using AI (batch per stock)
 * @param {string} symbol - Stock symbol
 * @param {{ text: string, hash: string }[]} headlines - Headlines to analyze
 * @param {string} scrapeRunId - UUID for this scrape run
 * @returns {Promise<{ sentiment: string, impact: string, reason: string }[]>}
 */
async function analyzeHeadlinesSentiment(symbol, headlines, scrapeRunId = null) {
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
  const startTime = Date.now();
  const requestId = uuidv4();

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

    const responseTime = Date.now() - startTime;
    const usage = response.usage || {};

    // Log API usage
    await ApiUsage.logUsage({
      provider: 'OPENAI',
      model: 'gpt-4o-mini',
      feature: 'HEADLINE_SENTIMENT',
      tokens: {
        input: usage.prompt_tokens || 0,
        output: usage.completion_tokens || 0
      },
      request_id: requestId,
      scrape_run_id: scrapeRunId,
      response_time_ms: responseTime,
      success: true,
      context: {
        symbol: symbol,
        headlines_count: uncached.length,
        description: `Sentiment analysis for ${symbol} headlines`
      }
    });

    console.log(`[NewsSearch] Sentiment analysis for ${symbol} completed (${responseTime}ms, tokens: ${usage.prompt_tokens || 0}+${usage.completion_tokens || 0})`);

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
    const responseTime = Date.now() - startTime;

    // Log failed API usage
    await ApiUsage.logUsage({
      provider: 'OPENAI',
      model: 'gpt-4o-mini',
      feature: 'HEADLINE_SENTIMENT',
      tokens: { input: 0, output: 0 },
      request_id: requestId,
      scrape_run_id: scrapeRunId,
      response_time_ms: responseTime,
      success: false,
      error_message: error.message,
      context: {
        symbol: symbol,
        headlines_count: uncached.length,
        description: `Failed sentiment analysis for ${symbol}`
      }
    });

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
 * @param {string} scrapeRunId - UUID for this scrape run
 * @returns {Promise<{ stocks: Object, metadata: object }>}
 */
async function fetchStockNewsWithWebSearch(scrapeRunId = null) {
  const startTime = Date.now();
  const requestId = uuidv4();

  try {
    console.log('[NewsSearch] Fetching Indian stock market news via web search...');

    // Get today's date in IST
    const today = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(today.getTime() + istOffset);
    const dateStr = istDate.toISOString().split('T')[0];

    const searchPrompt = `Search for today's (${dateStr}) Indian stock market pre-market news and stocks to watch.

Find news about specific NSE listed stocks that have important announcements, results, SEBI orders, management changes, order wins, or significant corporate actions.

Return a JSON object with this exact structure:
{
  "stocks": {
    "NSE_EQ|ISIN_CODE": [
      {
        "text": "Full headline text mentioning the stock",
        "category": "PRE_MARKET_NEWS" or "STOCKS_TO_WATCH"
      }
    ]
  },
  "sources_used": ["list of news sources"],
  "news_date": "${dateStr}"
}

CRITICAL - Use the Upstox INSTRUMENT_KEY format as the key (NSE_EQ|ISIN). Examples:
- Reliance Industries → "NSE_EQ|INE002A01018"
- TCS → "NSE_EQ|INE467B01029"
- HDFC Bank → "NSE_EQ|INE040A01034"
- Infosys → "NSE_EQ|INE009A01021"
- ICICI Bank → "NSE_EQ|INE090A01021"
- State Bank of India → "NSE_EQ|INE062A01020"
- Kotak Mahindra Bank → "NSE_EQ|INE237A01028"
- Hindustan Unilever → "NSE_EQ|INE030A01027"
- ITC Ltd → "NSE_EQ|INE154A01025"
- Larsen & Toubro → "NSE_EQ|INE018A01030"
- Bharti Airtel → "NSE_EQ|INE397D01024"
- Asian Paints → "NSE_EQ|INE021A01026"
- Maruti Suzuki → "NSE_EQ|INE585B01010"
- Sun Pharma → "NSE_EQ|INE044A01036"
- Titan Company → "NSE_EQ|INE280A01028"
- Bajaj Finance → "NSE_EQ|INE296A01024"
- Wipro → "NSE_EQ|INE075A01022"
- HCL Technologies → "NSE_EQ|INE860A01027"
- Tata Motors → "NSE_EQ|INE155A01022"
- Tata Steel → "NSE_EQ|INE081A01020"
- Mahindra & Mahindra → "NSE_EQ|INE101A01026"
- Power Grid → "NSE_EQ|INE752E01010"
- NTPC → "NSE_EQ|INE733E01010"
- UltraTech Cement → "NSE_EQ|INE481G01011"
- Tech Mahindra → "NSE_EQ|INE669C01036"
- Adani Enterprises → "NSE_EQ|INE423A01024"
- Adani Ports → "NSE_EQ|INE742F01042"
- IndusInd Bank → "NSE_EQ|INE095A01012"
- Axis Bank → "NSE_EQ|INE238A01034"
- Dr Reddy's Labs → "NSE_EQ|INE089A01023"

Rules:
1. Only include NSE listed Indian stocks
2. Use the EXACT instrument_key format: NSE_EQ|ISIN_CODE (12 character ISIN starting with INE)
3. Each headline should be the actual news headline, not a summary
4. Focus on actionable news that could affect stock prices today
5. Include 10-20 stocks with the most significant news
6. Categorize as PRE_MARKET_NEWS for breaking news or STOCKS_TO_WATCH for stocks with potential movement
7. If you don't know the exact ISIN, use the company name as fallback key`;

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

    const responseTime = Date.now() - startTime;
    const usage = response.usage || {};

    // Log API usage
    await ApiUsage.logUsage({
      provider: 'OPENAI',
      model: 'gpt-4o',
      feature: 'DAILY_NEWS_STOCKS',
      tokens: {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0
      },
      request_id: requestId,
      scrape_run_id: scrapeRunId,
      response_time_ms: responseTime,
      success: true,
      context: {
        description: 'Daily stock news web search'
      }
    });

    // Extract the text response
    const outputText = response.output_text || '';

    console.log(`[NewsSearch] Web search completed (${responseTime}ms, tokens: ${usage.input_tokens || 0}+${usage.output_tokens || 0}), parsing results...`);

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
    const responseTime = Date.now() - startTime;

    // Log failed API usage
    await ApiUsage.logUsage({
      provider: 'OPENAI',
      model: 'gpt-4o',
      feature: 'DAILY_NEWS_STOCKS',
      tokens: { input: 0, output: 0 },
      request_id: requestId,
      scrape_run_id: scrapeRunId,
      response_time_ms: responseTime,
      success: false,
      error_message: error.message,
      context: {
        description: 'Failed daily stock news web search'
      }
    });

    console.error('[NewsSearch] Web search error:', error.message);
    throw error;
  }
}

/**
 * Fallback: Extract stock symbols and news from plain text
 * @param {string} text - Response text
 * @returns {Object} Stocks map (keyed by instrument_key or symbol)
 */
function extractStocksFromText(text) {
  const stocks = {};

  // First, try to extract instrument_keys from text
  const instrumentKeyPattern = /NSE_EQ\|INE[A-Z0-9]+/gi;
  const instrumentKeyMatches = text.match(instrumentKeyPattern) || [];

  // Known major stocks with their instrument_keys (symbol -> instrument_key mapping)
  const knownStocksMap = {
    'RELIANCE': 'NSE_EQ|INE002A01018',
    'TCS': 'NSE_EQ|INE467B01029',
    'INFY': 'NSE_EQ|INE009A01021',
    'HDFCBANK': 'NSE_EQ|INE040A01034',
    'ICICIBANK': 'NSE_EQ|INE090A01021',
    'KOTAKBANK': 'NSE_EQ|INE237A01028',
    'SBIN': 'NSE_EQ|INE062A01020',
    'AXISBANK': 'NSE_EQ|INE238A01034',
    'BAJFINANCE': 'NSE_EQ|INE296A01024',
    'BHARTIARTL': 'NSE_EQ|INE397D01024',
    'ITC': 'NSE_EQ|INE154A01025',
    'HINDUNILVR': 'NSE_EQ|INE030A01027',
    'ASIANPAINT': 'NSE_EQ|INE021A01026',
    'MARUTI': 'NSE_EQ|INE585B01010',
    'TATAMOTORS': 'NSE_EQ|INE155A01022',
    'TATASTEEL': 'NSE_EQ|INE081A01020',
    'WIPRO': 'NSE_EQ|INE075A01022',
    'HCLTECH': 'NSE_EQ|INE860A01027',
    'SUNPHARMA': 'NSE_EQ|INE044A01036',
    'DRREDDY': 'NSE_EQ|INE089A01023',
    'CIPLA': 'NSE_EQ|INE059A01026',
    'ADANIENT': 'NSE_EQ|INE423A01024',
    'ADANIPORTS': 'NSE_EQ|INE742F01042',
    'POWERGRID': 'NSE_EQ|INE752E01010',
    'NTPC': 'NSE_EQ|INE733E01010',
    'ONGC': 'NSE_EQ|INE213A01029',
    'COALINDIA': 'NSE_EQ|INE522F01014',
    'TITAN': 'NSE_EQ|INE280A01028',
    'LT': 'NSE_EQ|INE018A01030',
    'ULTRACEMCO': 'NSE_EQ|INE481G01011',
    'INDUSINDBK': 'NSE_EQ|INE095A01012',
    'TECHM': 'NSE_EQ|INE669C01036',
    'NESTLEIND': 'NSE_EQ|INE239A01016',
    'BRITANNIA': 'NSE_EQ|INE216A01030',
    'M&M': 'NSE_EQ|INE101A01026'
  };

  // Split into sentences
  const sentences = text.split(/[.!?\n]+/);

  for (const sentence of sentences) {
    const upperSentence = sentence.toUpperCase();

    // Check for instrument_keys in sentence
    for (const instrumentKey of instrumentKeyMatches) {
      if (sentence.includes(instrumentKey) && sentence.trim().length > 20) {
        if (!stocks[instrumentKey]) {
          stocks[instrumentKey] = [];
        }
        const exists = stocks[instrumentKey].some(s => s.text === sentence.trim());
        if (!exists && stocks[instrumentKey].length < 3) {
          stocks[instrumentKey].push({
            text: sentence.trim(),
            category: 'PRE_MARKET_NEWS'
          });
        }
      }
    }

    // Check for known symbols and convert to instrument_key
    for (const [symbol, instrumentKey] of Object.entries(knownStocksMap)) {
      if (upperSentence.includes(symbol) && sentence.trim().length > 20) {
        if (!stocks[instrumentKey]) {
          stocks[instrumentKey] = [];
        }
        const exists = stocks[instrumentKey].some(s => s.text === sentence.trim());
        if (!exists && stocks[instrumentKey].length < 3) {
          stocks[instrumentKey].push({
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
  const startTime = Date.now();
  const requestId = uuidv4();

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

    const responseTime = Date.now() - startTime;
    const outputText = response.output_text || '';

    // Log API usage
    const usage = response.usage || {};
    await ApiUsage.logUsage({
      provider: 'OPENAI',
      model: 'gpt-4o',
      feature: 'MARKET_SENTIMENT',
      tokens: {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0
      },
      request_id: requestId,
      scrape_run_id: scrapeRunId,
      response_time_ms: responseTime,
      success: true,
      context: {
        description: 'Nifty 50 market sentiment web search'
      }
    });

    console.log(`[NewsSearch] Market sentiment search completed (${responseTime}ms, tokens: ${usage.input_tokens || 0}+${usage.output_tokens || 0})`);

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
    const { stocks: scrapedStocks, metadata } = await fetchStockNewsWithWebSearch(scrapeRunId);

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
      const analyzedHeadlines = await analyzeHeadlinesSentiment(trading_symbol, headlinesWithHash, scrapeRunId);

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
