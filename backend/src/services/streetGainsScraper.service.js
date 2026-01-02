/**
 * StreetGains Scraper Service
 *
 * Scrapes stock news from StreetGains pre-market analysis page.
 * Uses Puppeteer for JavaScript-rendered content (Next.js site).
 *
 * Sections scraped:
 * - Pre-Market News
 * - Stocks to Watch
 */

import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';
import Stock from '../models/stock.js';
import DailyNewsStock from '../models/dailyNewsStock.js';
import SentimentCache from '../models/sentimentCache.js';
import OpenAI from 'openai';

const STREETGAINS_URL = 'https://streetgains.in/streetview-stock-market-news-analysis/stock-market-open';
const SCRAPE_VERSION = 'v1-dom-parser';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Map raw symbol to Upstox instrument_key
 * @param {string} rawSymbol - Symbol from StreetGains
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
    console.error(`[StreetGains] Error mapping symbol ${rawSymbol}:`, error.message);
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
    console.log(`[StreetGains] All ${headlines.length} headlines cached for ${symbol}`);
    return results;
  }

  // Analyze uncached headlines via AI
  try {
    console.log(`[StreetGains] Analyzing ${uncached.length} uncached headlines for ${symbol}`);

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
    console.error(`[StreetGains] AI sentiment analysis error for ${symbol}:`, error.message);

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
 * Scrape StreetGains page using Puppeteer
 * @returns {Promise<{ stocks: Map, metadata: object }>}
 */
async function scrapeStreetGainsPage() {
  let browser = null;

  try {
    console.log('[StreetGains] Launching browser...');

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();

    // Set user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate to page
    console.log('[StreetGains] Navigating to:', STREETGAINS_URL);
    await page.goto(STREETGAINS_URL, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait for content to load
    await page.waitForSelector('body', { timeout: 10000 });

    // Extract data from page
    const scrapedData = await page.evaluate(() => {
      const stocksMap = {};

      // Helper to extract stock symbol from headline
      const extractSymbol = (headline) => {
        // Common patterns: "SYMBOL:", "SYMBOL -", "(SYMBOL)", etc.
        const patterns = [
          /^([A-Z][A-Z0-9]{2,15})\s*[:|-]/,  // RELIANCE: or RELIANCE -
          /\(([A-Z][A-Z0-9]{2,15})\)/,        // (RELIANCE)
          /^([A-Z][A-Z0-9]{2,15})\s/          // RELIANCE at start
        ];

        for (const pattern of patterns) {
          const match = headline.match(pattern);
          if (match) return match[1];
        }

        return null;
      };

      // Find all section headers and their content
      const sections = document.querySelectorAll('h2, h3, .section-title');
      const headlines = [];

      sections.forEach(section => {
        const sectionText = section.textContent.toLowerCase();
        let category = null;

        if (sectionText.includes('pre-market') || sectionText.includes('premarket')) {
          category = 'PRE_MARKET_NEWS';
        } else if (sectionText.includes('stocks to watch') || sectionText.includes('watch')) {
          category = 'STOCKS_TO_WATCH';
        }

        if (category) {
          // Find list items after this section
          let sibling = section.nextElementSibling;
          while (sibling && !sibling.matches('h2, h3, .section-title')) {
            const items = sibling.querySelectorAll('li, p, .news-item');
            items.forEach(item => {
              const text = item.textContent.trim();
              if (text.length > 20 && text.length < 500) {
                const symbol = extractSymbol(text);
                if (symbol) {
                  headlines.push({ symbol, text, category });
                }
              }
            });
            sibling = sibling.nextElementSibling;
          }
        }
      });

      // Alternative: Look for common list structures
      if (headlines.length === 0) {
        // Try finding news list containers
        const newsContainers = document.querySelectorAll(
          '.news-list, .stock-news, .market-news, [class*="news"], ul, ol'
        );

        newsContainers.forEach(container => {
          const items = container.querySelectorAll('li');
          items.forEach(item => {
            const text = item.textContent.trim();
            if (text.length > 20 && text.length < 500) {
              const symbol = extractSymbol(text);
              if (symbol) {
                // Try to determine category from context
                const parentText = container.previousElementSibling?.textContent?.toLowerCase() || '';
                let category = 'PRE_MARKET_NEWS';
                if (parentText.includes('watch')) {
                  category = 'STOCKS_TO_WATCH';
                }
                headlines.push({ symbol, text, category });
              }
            }
          });
        });
      }

      // Group by symbol
      headlines.forEach(h => {
        if (!stocksMap[h.symbol]) {
          stocksMap[h.symbol] = [];
        }
        stocksMap[h.symbol].push({ text: h.text, category: h.category });
      });

      return {
        stocks: stocksMap,
        pageTitle: document.title,
        foundHeadlines: headlines.length
      };
    });

    console.log(`[StreetGains] Found ${scrapedData.foundHeadlines} headlines for ${Object.keys(scrapedData.stocks).length} stocks`);

    return {
      stocks: scrapedData.stocks,
      metadata: {
        pageTitle: scrapedData.pageTitle,
        foundHeadlines: scrapedData.foundHeadlines
      }
    };

  } catch (error) {
    console.error('[StreetGains] Scrape error:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Main scraper function - scrapes and stores daily news stocks
 * @returns {Promise<{ success: boolean, stocks_count: number, scrape_run_id: string }>}
 */
export async function scrapeAndStoreDailyNewsStocks() {
  const scrapeRunId = uuidv4();
  const scrapeDate = DailyNewsStock.getISTDateAsUTC();

  console.log(`[StreetGains] Starting scrape run: ${scrapeRunId}`);
  console.log(`[StreetGains] Scrape date (IST): ${scrapeDate.toISOString()}`);

  try {
    // Scrape the page
    const { stocks: scrapedStocks, metadata } = await scrapeStreetGainsPage();

    if (Object.keys(scrapedStocks).length === 0) {
      console.warn('[StreetGains] No stocks found in scrape, checking for fallback...');

      // Check if we have existing data for today
      const existingData = await DailyNewsStock.getTodayStocks();
      if (existingData.length > 0) {
        console.log('[StreetGains] Using existing data for today');
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
        error: 'No stocks found in scrape'
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
          name: 'StreetGains',
          url: STREETGAINS_URL,
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

      console.log(`[StreetGains] Processed ${trading_symbol}: ${newsItems.length} headlines, sentiment=${sentiment}, confidence=${confidenceScore.toFixed(2)}`);
    }

    console.log(`[StreetGains] Scrape complete: ${processedStocks.length} stocks processed`);

    return {
      success: true,
      stocks_count: processedStocks.length,
      scrape_run_id: scrapeRunId,
      metadata
    };

  } catch (error) {
    console.error('[StreetGains] Scrape and store error:', error.message);

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

export default {
  scrapeAndStoreDailyNewsStocks,
  getTodayNewsStocks,
  mapSymbolToInstrumentKey,
  analyzeHeadlinesSentiment
};
