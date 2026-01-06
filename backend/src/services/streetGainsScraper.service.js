/**
 * Stock News Scraper Service
 *
 * Fetches Indian stock market news from:
 * 1. Economic Times RSS (primary - free, reliable)
 * 2. OpenAI web search (fallback - when RSS fails)
 *
 * Sections scraped:
 * - Pre-Market News
 * - Stocks to Watch
 * - Market Sentiment (Nifty 50 outlook)
 */

import { v4 as uuidv4 } from 'uuid';
import Parser from 'rss-parser';
import Stock from '../models/stock.js';
import DailyNewsStock from '../models/dailyNewsStock.js';
import SentimentCache from '../models/sentimentCache.js';
import MarketSentiment from '../models/marketSentiment.js';
import ApiUsage from '../models/apiUsage.js';
import OpenAI from 'openai';

const SCRAPE_VERSION = 'v5-openai-primary';

// Initialize RSS parser
const rssParser = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; StockNewsBot/1.0)'
  }
});

// RSS feeds from multiple sources for better coverage and redundancy
const RSS_FEEDS = [
  { name: 'Economic Times Markets', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { name: 'Economic Times Stocks', url: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms' },
  { name: 'Moneycontrol', url: 'https://www.moneycontrol.com/rss/latestnews.xml' },
  { name: 'Business Standard Markets', url: 'https://www.business-standard.com/rss/markets-106.rss' },
  { name: 'Livemint Markets', url: 'https://www.livemint.com/rss/markets' }
];

// Legacy reference (for backward compatibility)
const ET_RSS_FEEDS = {
  markets: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
  stocks: 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms'
};

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
 * Map company name to stock details using regex search on name field
 * OpenAI returns company names as they appear in news headlines
 * @param {string} companyName - Company name from OpenAI (e.g., "Indian Bank", "Ola Electric", "TCS")
 * @returns {Promise<{ instrument_key: string|null, trading_symbol: string, company_name: string|null }>}
 */
async function mapSymbolToInstrumentKey(companyName) {
  const cleanName = companyName.trim();
  console.log(`[NewsSearch] Mapping company name: "${cleanName}"`);

  try {
    // 1. Exact match on name (case-insensitive)
    let stock = await Stock.findOne({
      name: { $regex: `^${escapeRegex(cleanName)}`, $options: 'i' },
      segment: 'NSE_EQ',
      is_active: true
    }).lean();

    if (stock) {
      console.log(`[NewsSearch] ✅ Exact name match: "${cleanName}" -> ${stock.trading_symbol} (${stock.name})`);
      return {
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        company_name: stock.name
      };
    }

    // 2. Try exact match on trading_symbol (for cases like "TCS", "HDFC", "ITC")
    const upperName = cleanName.toUpperCase();
    stock = await Stock.findOne({
      trading_symbol: upperName,
      segment: 'NSE_EQ',
      is_active: true
    }).lean();

    if (stock) {
      console.log(`[NewsSearch] ✅ Trading symbol match: "${cleanName}" -> ${stock.trading_symbol} (${stock.name})`);
      return {
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        company_name: stock.name
      };
    }

    // 3. Fuzzy match - search name containing all words from input
    // Split input into words and create regex that matches all words in order
    const words = cleanName.split(/[\s,&-]+/).filter(w => w.length >= 2);
    if (words.length > 0) {
      // Create pattern: word1.*word2.*word3 (words in order)
      const pattern = words.map(w => escapeRegex(w)).join('.*');
      stock = await Stock.findOne({
        name: { $regex: pattern, $options: 'i' },
        segment: 'NSE_EQ',
        is_active: true
      }).lean();

      if (stock) {
        console.log(`[NewsSearch] ✅ Fuzzy name match: "${cleanName}" -> ${stock.trading_symbol} (${stock.name})`);
        return {
          instrument_key: stock.instrument_key,
          trading_symbol: stock.trading_symbol,
          company_name: stock.name
        };
      }
    }

    // 4. Try first significant word only (for cases like "Reliance" -> "Reliance Industries")
    if (words.length > 0) {
      const firstWord = words[0];
      if (firstWord.length >= 3) {
        stock = await Stock.findOne({
          name: { $regex: `^${escapeRegex(firstWord)}`, $options: 'i' },
          segment: 'NSE_EQ',
          is_active: true
        }).lean();

        if (stock) {
          console.log(`[NewsSearch] ✅ First word match: "${cleanName}" -> ${stock.trading_symbol} (${stock.name})`);
          return {
            instrument_key: stock.instrument_key,
            trading_symbol: stock.trading_symbol,
            company_name: stock.name
          };
        }
      }
    }

    // 5. Try contains match (looser search)
    if (words.length > 0) {
      const firstWord = words[0];
      if (firstWord.length >= 4) {
        stock = await Stock.findOne({
          name: { $regex: escapeRegex(firstWord), $options: 'i' },
          segment: 'NSE_EQ',
          is_active: true
        }).lean();

        if (stock) {
          console.log(`[NewsSearch] ✅ Contains match: "${cleanName}" -> ${stock.trading_symbol} (${stock.name})`);
          return {
            instrument_key: stock.instrument_key,
            trading_symbol: stock.trading_symbol,
            company_name: stock.name
          };
        }
      }
    }

    // 6. Try BSE as fallback
    stock = await Stock.findOne({
      name: { $regex: `^${escapeRegex(cleanName)}`, $options: 'i' },
      segment: 'BSE_EQ',
      is_active: true
    }).lean();

    if (stock) {
      console.log(`[NewsSearch] ✅ BSE match: "${cleanName}" -> ${stock.trading_symbol} (${stock.name})`);
      return {
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        company_name: stock.name
      };
    }

    // Not found
    console.warn(`[NewsSearch] ❌ Could not map: "${cleanName}"`);
    return {
      instrument_key: null,
      trading_symbol: upperName,
      company_name: cleanName
    };
  } catch (error) {
    console.error(`[NewsSearch] Error mapping "${companyName}":`, error.message);
    return {
      instrument_key: null,
      trading_symbol: cleanName.toUpperCase(),
      company_name: cleanName
    };
  }
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Clean up malformed stocks data from OpenAI response
 * Fixes issues like: "text": "actual headline" becoming the headline text
 * Also ensures description is properly extracted
 * @param {Object} stocksData - Raw stocks data from OpenAI
 * @returns {Object} Cleaned stocks data
 */
function cleanupStocksData(stocksData) {
  const cleaned = {};

  for (const [companyName, headlines] of Object.entries(stocksData)) {
    if (!Array.isArray(headlines)) continue;

    cleaned[companyName] = headlines.map(h => {
      let text = h.text || '';
      let description = h.description || null;

      // Fix malformed text that contains JSON key prefix like: "text": "actual headline"
      // Pattern 1: "text": "actual headline",
      const textMatch = text.match(/^["']?text["']?\s*:\s*["'](.+?)["'],?\s*$/i);
      if (textMatch) {
        text = textMatch[1];
      }

      // Pattern 2: {"text": "headline", "description": "..."}
      if (text.startsWith('{') || text.includes('"text"')) {
        try {
          const parsed = JSON.parse(text.replace(/,\s*$/, ''));
          if (parsed.text) text = parsed.text;
          if (parsed.description && !description) description = parsed.description;
        } catch (e) {
          // Try regex extraction
          const innerMatch = text.match(/"text"\s*:\s*"([^"]+)"/);
          if (innerMatch) text = innerMatch[1];
          const descMatch = text.match(/"description"\s*:\s*"([^"]+)"/);
          if (descMatch && !description) description = descMatch[1];
        }
      }

      // Remove leading/trailing quotes and commas
      text = text.replace(/^["',\s]+|["',\s]+$/g, '').trim();

      // Validate: headline should be at least 10 chars and not look like JSON
      if (text.length < 10 || text.startsWith('{') || text.startsWith('[')) {
        console.warn(`[NewsSearch] Skipping invalid headline for ${companyName}: "${text.substring(0, 50)}..."`);
        return null;
      }

      return {
        text,
        description,
        category: h.category || 'PRE_MARKET_NEWS'
      };
    }).filter(Boolean); // Remove nulls
  }

  // Remove companies with no valid headlines
  for (const [companyName, headlines] of Object.entries(cleaned)) {
    if (headlines.length === 0) {
      delete cleaned[companyName];
    }
  }

  return cleaned;
}

/**
 * Extract company name from a headline
 * Patterns: "X shares...", "X stock...", "X reports...", "X posts..."
 * @param {string} headline - The headline text
 * @returns {string|null} - Extracted company name or null
 */
function extractCompanyFromHeadline(headline) {
  if (!headline) return null;

  // Common patterns for stock news headlines
  const patterns = [
    // "HDFC Bank shares rally 5%", "Tata Motors stock gains"
    /^([A-Z][A-Za-z&\s]+?)(?:\s+(?:shares?|stock|scrip))\s+/i,
    // "HDFC Bank reports Q3 profit", "TCS posts strong results"
    /^([A-Z][A-Za-z&\s]+?)(?:\s+(?:reports?|posts?|announces?|logs?|sees?|records?))\s+/i,
    // "HDFC Bank Q3 profit rises", "Tata Motors December sales"
    /^([A-Z][A-Za-z&\s]+?)(?:\s+(?:Q[1-4]|FY\d{2}|January|February|March|April|May|June|July|August|September|October|November|December))\s+/i,
    // "Multibagger largecap stock that rose..." - skip these
    /^(?:Multibagger|This|These|Top|Best|Worst)\s+/i,
    // "Buy HDFC Bank; target Rs 1850"
    /^(?:Buy|Sell|Hold|Accumulate|Reduce)\s+([A-Z][A-Za-z&\s]+?)(?:;|\s+target|\s+at)/i,
  ];

  // Skip generic headlines and non-Indian market news
  const skipPatterns = [
    /^(?:Sensex|Nifty|Market|Markets|Stock|Stocks|Share|Shares|Trade|Trading)\s+/i,
    /^(?:Wall Street|US market|Global|Asian|European)\s+/i,
    /^(?:FII|DII|Institutional|Retail)\s+/i,
    /among\s+\d+\s+stocks?/i,
    /\d+\s+stocks?\s+(?:to|that|which)/i,
    // Skip foreign market news (not Indian stocks)
    /^(?:South Korean|Korean|Chinese|Japanese|US|UK|European|German|French)\s+/i,
    /(?:Korea|China|Japan|Taiwan|Hong Kong|Singapore|Thailand|Indonesia)\s+(?:shares?|stocks?|market)/i,
    /(?:Samsung|Hyundai|Toyota|Sony|Alibaba|Tencent|TSMC)\s+/i,
  ];

  for (const skipPattern of skipPatterns) {
    if (skipPattern.test(headline)) return null;
  }

  // Try each pattern
  for (const pattern of patterns) {
    const match = headline.match(pattern);
    if (match && match[1]) {
      let company = match[1].trim();
      // Clean up: remove trailing "and", "Ltd", etc.
      company = company.replace(/\s+(?:and|Ltd|Limited|Inc|Corp|PV|CV)\.?$/i, '').trim();
      // Must be at least 2 chars and not a common word
      if (company.length >= 2 && !/^(?:The|A|An|In|On|At|By|For|To)$/i.test(company)) {
        return company;
      }
    }
  }

  return null;
}

/**
 * Sleep utility for retry delays
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch RSS feed with retry logic and exponential backoff
 * @param {string} feedUrl - RSS feed URL
 * @param {string} feedName - Feed name for logging
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<object|null>} - Parsed feed or null if failed
 */
async function fetchRSSFeedWithRetry(feedUrl, feedName, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const feed = await rssParser.parseURL(feedUrl);
      if (feed.items && feed.items.length > 0) {
        console.log(`[NewsRSS] ✓ ${feedName}: ${feed.items.length} items`);
        return { feed, source: feedName };
      }
      console.log(`[NewsRSS] ⚠️ ${feedName}: No items returned`);
      return null;
    } catch (error) {
      if (attempt < maxRetries) {
        const delay = 1000 * Math.pow(2, attempt); // Exponential backoff: 1s, 2s
        console.log(`[NewsRSS] ⚠️ ${feedName} failed (attempt ${attempt + 1}), retrying in ${delay}ms...`);
        await sleep(delay);
      } else {
        console.log(`[NewsRSS] ✗ ${feedName}: Failed after ${maxRetries + 1} attempts - ${error.message}`);
        return null;
      }
    }
  }
  return null;
}

/**
 * Fetch stock news from multiple RSS feeds in parallel
 * @param {string} scrapeRunId - UUID for this scrape run
 * @returns {Promise<{ stocks: Object, metadata: object }>}
 */
async function fetchStockNewsWithRSS(scrapeRunId = null) {
  const startTime = Date.now();

  try {
    console.log('[NewsRSS] Fetching stock news from multiple RSS sources...');

    // Get today's date in IST
    const today = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(today.getTime() + istOffset);
    const dateStr = istDate.toISOString().split('T')[0];

    // Fetch from all RSS feeds in parallel
    const feedPromises = RSS_FEEDS.map(feed =>
      fetchRSSFeedWithRetry(feed.url, feed.name)
    );

    const feedResults = await Promise.allSettled(feedPromises);
    const successfulFeeds = feedResults
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

    const responseTime = Date.now() - startTime;
    console.log(`[NewsRSS] Fetched ${successfulFeeds.length}/${RSS_FEEDS.length} feeds in ${responseTime}ms`);

    if (successfulFeeds.length === 0) {
      throw new Error('All RSS feeds failed');
    }

    // Merge all feed items and extract stock-specific headlines
    const stocksData = {};
    const sourcesUsed = [];
    let processedCount = 0;
    let skippedCount = 0;
    const seenHeadlines = new Set(); // Track headlines across all sources to avoid duplicates

    for (const { feed, source } of successfulFeeds) {
      if (!sourcesUsed.includes(source)) {
        sourcesUsed.push(source);
      }

      for (const item of feed.items) {
        // Check if it's from today (based on pubDate)
        const pubDate = item.pubDate ? new Date(item.pubDate) : null;
        if (pubDate) {
          const pubDateIST = new Date(pubDate.getTime() + istOffset);
          // Skip if older than today (allow some buffer for timezone)
          const hoursDiff = (istDate - pubDateIST) / (1000 * 60 * 60);
          if (hoursDiff > 24) {
            skippedCount++;
            continue;
          }
        }

        // Extract company name from headline
        const headline = item.title?.trim();
        if (!headline) continue;

        // Skip if we've already seen this headline from another source
        if (seenHeadlines.has(headline.toLowerCase())) {
          continue;
        }
        seenHeadlines.add(headline.toLowerCase());

        const companyName = extractCompanyFromHeadline(headline);
        if (!companyName) {
          skippedCount++;
          continue;
        }

        // Clean up description - remove HTML tags
        let description = item.contentSnippet || item.description || '';
        description = description.replace(/<[^>]*>/g, '').trim();
        // Truncate if too long
        if (description.length > 500) {
          description = description.substring(0, 497) + '...';
        }

        // Add to stocks data
        if (!stocksData[companyName]) {
          stocksData[companyName] = [];
        }

        // Avoid duplicate headlines for same company (limit to 3 per company)
        const exists = stocksData[companyName].some(h => h.text === headline);
        if (!exists && stocksData[companyName].length < 3) {
          stocksData[companyName].push({
            text: headline,
            description: description || null,
            category: 'PRE_MARKET_NEWS',
            source: source // Track which source this headline came from
          });
          processedCount++;
        }
      }
    }

    const stockCount = Object.keys(stocksData).length;
    console.log(`[NewsRSS] Extracted ${stockCount} stocks with ${processedCount} headlines from ${sourcesUsed.length} sources (skipped ${skippedCount} non-stock items)`);

    return {
      stocks: stocksData,
      metadata: {
        sources_used: sourcesUsed,
        news_date: dateStr,
        foundHeadlines: processedCount,
        source_type: 'rss'
      }
    };

  } catch (error) {
    const responseTime = Date.now() - startTime;
    console.error(`[NewsRSS] RSS fetch failed after ${responseTime}ms:`, error.message);
    throw error;
  }
}

/**
 * Fetch stock news - uses OpenAI web search as primary source for better accuracy
 * RSS feeds were picking up irrelevant foreign market news (e.g., South Korean markets)
 * @param {string} scrapeRunId - UUID for this scrape run
 * @returns {Promise<{ stocks: Object, metadata: object }>}
 */
async function fetchStockNews(scrapeRunId = null) {
  // Use OpenAI web search as primary source (more accurate, Indian stocks only)
  console.log('[NewsSearch] Using OpenAI web search for Indian stock news...');
  return await fetchStockNewsWithWebSearch(scrapeRunId);
}

/**
 * List of known company name patterns to detect multi-stock headlines
 * Used to filter out headlines that mention multiple companies
 */
const COMPANY_DETECTION_PATTERNS = [
  // Short trading symbols (3-5 chars) - case insensitive whole word match
  'TCS', 'ITC', 'HDFC', 'ICICI', 'SBI', 'ONGC', 'NTPC', 'BPCL', 'HPCL', 'IOC',
  'L&T', 'M&M', 'HUL', 'JSW', 'TATA', 'ADANI', 'CIPLA', 'WIPRO',
  // Common company name patterns
  'Reliance', 'Infosys', 'Bharti', 'Airtel', 'Maruti', 'Suzuki',
  'Hero', 'MotoCorp', 'TVS', 'Motor', 'Bajaj', 'Auto', 'Finance',
  'Asian Paints', 'Titan', 'Nestle', 'Britannia',
  'Sun Pharma', 'Dr Reddy', "Reddy's", 'Lupin', 'Divi',
  'Coal India', 'Power Grid', 'Hindalco', 'Vedanta',
  'Tech Mahindra', 'HCL', 'Mindtree', 'Mphasis',
  'Kotak', 'Axis', 'IndusInd', 'Yes Bank', 'IDFC', 'Bandhan',
  'Zomato', 'Paytm', 'Nykaa', 'Delhivery', 'PolicyBazaar',
  'Ola Electric', 'Tata Motors', 'Tata Steel', 'Tata Power',
  'Adani Enterprises', 'Adani Ports', 'Adani Green', 'Adani Power',
  'ITC Hotels', 'Indian Hotels', 'EIH', 'Lemon Tree',
  'GAIL', 'SAIL', 'BHEL', 'BEL', 'HAL',
  'UltraTech', 'Shree Cement', 'ACC', 'Ambuja',
  'IndianOil', 'BPCL', 'HPCL', 'RIL', 'ONGC'
];

/**
 * Check if a headline mentions multiple companies
 * @param {string} headline - The headline text
 * @param {string} assignedCompany - The company this headline is assigned to
 * @returns {{ isValid: boolean, mentionedCompanies: string[] }}
 */
function validateHeadlineAssignment(headline, assignedCompany) {
  const headlineLower = headline.toLowerCase();
  const assignedLower = assignedCompany.toLowerCase();

  // Find all company mentions in the headline
  const mentionedCompanies = [];

  for (const pattern of COMPANY_DETECTION_PATTERNS) {
    const patternLower = pattern.toLowerCase();

    // Skip if this pattern is part of the assigned company name
    if (assignedLower.includes(patternLower)) {
      continue;
    }

    // Check if pattern exists in headline as a word boundary match
    // This prevents "ITC" matching inside "ITCHOTELS"
    const regex = new RegExp(`\\b${escapeRegex(patternLower)}\\b`, 'i');
    if (regex.test(headlineLower)) {
      // Additional check: don't count if it's a substring of the assigned company
      const assignedWords = assignedCompany.split(/[\s,&-]+/).map(w => w.toLowerCase());
      if (!assignedWords.includes(patternLower)) {
        mentionedCompanies.push(pattern);
      }
    }
  }

  // Also check for common multi-stock indicators
  const multiStockIndicators = [
    /\b(?:and|,)\s+(?:while|as|but)\b/i,  // "X jumped, while Y fell"
    /\bgainers?\b.*\blosers?\b/i,          // Mentions both gainers and losers
    /\b(?:including|such as|like)\s+\w+,\s*\w+/i,  // Lists multiple stocks
    /\b(?:IT|auto|pharma|banking|metal)\s+(?:stocks?|sector)\b/i  // Sector news
  ];

  const hasMultiStockIndicator = multiStockIndicators.some(regex => regex.test(headline));

  // Invalid if mentions other companies OR has multi-stock indicators
  const isValid = mentionedCompanies.length === 0 && !hasMultiStockIndicator;

  if (!isValid) {
    console.log(`[NewsSearch] ⚠️ Filtering out headline for "${assignedCompany}": mentions other companies [${mentionedCompanies.join(', ')}] or is multi-stock news`);
  }

  return {
    isValid,
    mentionedCompanies,
    hasMultiStockIndicator
  };
}

/**
 * Filter headlines to only include those specifically about the assigned company
 * @param {Object} stocksData - Map of company name to headlines array
 * @returns {Object} Filtered stocks data
 */
function filterMultiStockHeadlines(stocksData) {
  const filteredStocks = {};
  let removedCount = 0;

  for (const [companyName, headlines] of Object.entries(stocksData)) {
    const validHeadlines = headlines.filter(headline => {
      const { isValid } = validateHeadlineAssignment(headline.text, companyName);
      if (!isValid) {
        removedCount++;
      }
      return isValid;
    });

    // Only include stocks that still have valid headlines
    if (validHeadlines.length > 0) {
      filteredStocks[companyName] = validHeadlines;
    }
  }

  if (removedCount > 0) {
    console.log(`[NewsSearch] Filtered out ${removedCount} multi-stock headlines`);
  }

  return filteredStocks;
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
    "COMPANY_NAME": [
      {
        "text": "Clean headline text (no quotes or JSON formatting)",
        "description": "REQUIRED: 1-2 sentence summary with SPECIFIC numbers and details from the news",
        "category": "PRE_MARKET_NEWS" or "STOCKS_TO_WATCH"
      }
    ]
  },
  "sources_used": ["list of news sources"],
  "news_date": "${dateStr}"
}

**CRITICAL JSON FORMAT RULES:**
- The "text" field must contain ONLY the headline text, NOT JSON like "text": "headline"
- The "description" field is MANDATORY - never set it to null or empty
- Example CORRECT format: {"text": "HDFC Bank Q3 profit rises 15%", "description": "HDFC Bank reported Q3 net profit of Rs 16,372 crore, up 15% YoY. NII grew 10% to Rs 30,650 crore.", "category": "PRE_MARKET_NEWS"}
- Example WRONG format: {"text": "\\"text\\": \\"HDFC Bank Q3 profit rises 15%\\"", ...} ❌

**IMPORTANT: The "description" field must contain SPECIFIC DETAILS from the news:**
- For results: "Q3 profit rose 15% to Rs 500 crore, revenue grew 12% YoY"
- For orders: "Won Rs 200 crore order from Tata Motors for EV buses"
- For SEBI: "SEBI imposed Rs 10 lakh fine for delayed disclosure"
- For management: "CEO resigned citing personal reasons, CFO appointed interim CEO"
- DO NOT write vague descriptions like "positive developments" or "significant news"

**CRITICAL RULES - MUST FOLLOW:**
1. Each headline MUST be SPECIFICALLY and PRIMARILY about ONLY ONE company
2. DO NOT include headlines that mention multiple stocks (e.g., "TCS, Infosys, Wipro gain" should NOT be included)
3. DO NOT include market roundup headlines that list multiple gainers/losers
4. The company MUST be the PRIMARY SUBJECT of the headline, not just mentioned in passing
5. Use the company name EXACTLY as it appears in news (e.g., "Indian Bank", "Ola Electric", "Reliance Industries", "TCS", "HDFC Bank")
6. DO NOT use stock symbols or ISIN codes - just use the company name
7. CRITICAL: "ITC" and "ITC Hotels" are DIFFERENT companies - DO NOT mix them up!

**EXAMPLES OF CORRECT HEADLINES:**
- "Indian Bank reports 15% rise in Q3 profit" → assign to "Indian Bank" ✅
- "TCS wins $500M deal from European bank" → assign to "TCS" ✅
- "Reliance Jio adds 5M subscribers in December" → assign to "Reliance Industries" ✅

**EXAMPLES OF INCORRECT HEADLINES (DO NOT INCLUDE):**
- "Hero MotoCorp and TVS Motor jumped, while ITC tumbled 3%" → mentions 3 stocks, SKIP ❌
- "IT stocks including TCS, Infosys rise on weak rupee" → mentions multiple stocks, SKIP ❌
- "Nifty 50 sees mixed trading with auto and pharma up" → sector news, SKIP ❌

Return ONLY headlines where ONE specific company is the PRIMARY subject.

Rules:
1. Only include NSE listed Indian stocks
2. Use the company name as it appears in the news headline
3. Each headline should be the actual news headline, not a summary
4. The headline MUST be ONLY about ONE company (the one you assign it to)
5. Focus on company-specific news (results, deals, SEBI orders, management, etc.)
6. Include 10-20 stocks with the most significant company-specific news
7. Categorize as PRE_MARKET_NEWS for breaking news or STOCKS_TO_WATCH for stocks with potential movement`;

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

        // Clean up any malformed headline data (e.g., "text": "actual headline")
        stocksData = cleanupStocksData(stocksData);
      } catch (parseError) {
        console.error('[NewsSearch] JSON parse error, trying fallback extraction...');
        // Fallback: Extract stock mentions from text
        stocksData = extractStocksFromText(outputText);
      }
    } else {
      // Fallback: Extract stock mentions from text
      stocksData = extractStocksFromText(outputText);
    }

    // IMPORTANT: Filter out headlines that mention multiple companies
    // This is a safety net in case OpenAI still returns multi-stock headlines
    const beforeFilterCount = Object.keys(stocksData).length;
    stocksData = filterMultiStockHeadlines(stocksData);
    const afterFilterCount = Object.keys(stocksData).length;

    if (beforeFilterCount !== afterFilterCount) {
      console.log(`[NewsSearch] Stocks reduced from ${beforeFilterCount} to ${afterFilterCount} after filtering multi-stock headlines`);
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
    console.log(`[NewsSearch] Found news for ${stockCount} stocks (after filtering)`);

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
 * Fallback: Extract company names and news from plain text
 * Returns stock data keyed by company name (to be mapped via mapSymbolToInstrumentKey)
 * @param {string} text - Response text
 * @returns {Object} Stocks map keyed by company name
 */
function extractStocksFromText(text) {
  const stocks = {};

  // Known major Indian stocks - map company name variations to canonical name
  // The canonical name will be used as key and mapped via mapSymbolToInstrumentKey
  const knownCompanyPatterns = [
    // Bank/Financial stocks
    { patterns: ['reliance industries', 'reliance', 'ril'], name: 'Reliance Industries' },
    { patterns: ['tcs', 'tata consultancy'], name: 'TCS' },
    { patterns: ['infosys', 'infy'], name: 'Infosys' },
    { patterns: ['hdfc bank', 'hdfcbank'], name: 'HDFC Bank' },
    { patterns: ['icici bank', 'icicibank'], name: 'ICICI Bank' },
    { patterns: ['kotak mahindra', 'kotak bank', 'kotakbank'], name: 'Kotak Mahindra Bank' },
    { patterns: ['state bank of india', 'sbi', 'state bank'], name: 'State Bank of India' },
    { patterns: ['axis bank', 'axisbank'], name: 'Axis Bank' },
    { patterns: ['bajaj finance', 'bajfinance'], name: 'Bajaj Finance' },
    { patterns: ['bharti airtel', 'airtel', 'bhartiartl'], name: 'Bharti Airtel' },
    { patterns: ['itc ltd', 'itc limited', 'itc'], name: 'ITC' },
    { patterns: ['hindustan unilever', 'hul', 'hindunilvr'], name: 'Hindustan Unilever' },
    { patterns: ['asian paints', 'asianpaint'], name: 'Asian Paints' },
    { patterns: ['maruti suzuki', 'maruti'], name: 'Maruti Suzuki' },
    { patterns: ['tata motors', 'tatamotors'], name: 'Tata Motors' },
    { patterns: ['tata steel', 'tatasteel'], name: 'Tata Steel' },
    { patterns: ['wipro'], name: 'Wipro' },
    { patterns: ['hcl tech', 'hcltech', 'hcl technologies'], name: 'HCL Technologies' },
    { patterns: ['sun pharma', 'sun pharmaceutical', 'sunpharma'], name: 'Sun Pharmaceutical' },
    { patterns: ["dr reddy's", 'dr reddy', 'drreddy'], name: "Dr. Reddy's Laboratories" },
    { patterns: ['cipla'], name: 'Cipla' },
    { patterns: ['adani enterprises', 'adanient'], name: 'Adani Enterprises' },
    { patterns: ['adani ports', 'adaniports'], name: 'Adani Ports' },
    { patterns: ['power grid', 'powergrid'], name: 'Power Grid Corporation' },
    { patterns: ['ntpc'], name: 'NTPC' },
    { patterns: ['ongc', 'oil and natural gas'], name: 'ONGC' },
    { patterns: ['coal india', 'coalindia'], name: 'Coal India' },
    { patterns: ['titan company', 'titan'], name: 'Titan Company' },
    { patterns: ['larsen & toubro', 'l&t', 'larsen and toubro'], name: 'Larsen & Toubro' },
    { patterns: ['ultratech cement', 'ultracemco'], name: 'UltraTech Cement' },
    { patterns: ['indusind bank', 'indusindbk'], name: 'IndusInd Bank' },
    { patterns: ['tech mahindra', 'techm'], name: 'Tech Mahindra' },
    { patterns: ['nestle india', 'nestleind'], name: 'Nestle India' },
    { patterns: ['britannia', 'britannia industries'], name: 'Britannia Industries' },
    { patterns: ['mahindra & mahindra', 'm&m', 'mahindra'], name: 'Mahindra & Mahindra' },
    // Additional frequently mentioned stocks
    { patterns: ['indian bank'], name: 'Indian Bank' },
    { patterns: ['ola electric', 'ola'], name: 'Ola Electric' },
    { patterns: ['zomato'], name: 'Zomato' },
    { patterns: ['paytm', 'one97'], name: 'Paytm' },
    { patterns: ['nykaa', 'fsl'], name: 'Nykaa' },
    { patterns: ['delhivery'], name: 'Delhivery' },
    { patterns: ['policybazaar', 'pb fintech'], name: 'PB Fintech' },
    { patterns: ['vedanta'], name: 'Vedanta' },
    { patterns: ['hindalco'], name: 'Hindalco Industries' },
    { patterns: ['jsw steel', 'jswsteel'], name: 'JSW Steel' },
    { patterns: ['bajaj auto'], name: 'Bajaj Auto' },
    { patterns: ['hero motocorp', 'hero moto'], name: 'Hero MotoCorp' },
    { patterns: ['eicher motors', 'eicher'], name: 'Eicher Motors' }
  ];

  // Split into sentences
  const sentences = text.split(/[.!?\n]+/);

  for (const sentence of sentences) {
    const lowerSentence = sentence.toLowerCase();
    const trimmedSentence = sentence.trim();

    // Skip short sentences
    if (trimmedSentence.length < 20) continue;

    // Check for known company patterns
    for (const company of knownCompanyPatterns) {
      const matched = company.patterns.some(pattern => lowerSentence.includes(pattern));

      if (matched) {
        const companyName = company.name;

        if (!stocks[companyName]) {
          stocks[companyName] = [];
        }

        const exists = stocks[companyName].some(s => s.text === trimmedSentence);
        if (!exists && stocks[companyName].length < 3) {
          stocks[companyName].push({
            text: trimmedSentence,
            category: 'PRE_MARKET_NEWS'
          });
        }
      }
    }
  }

  return stocks;
}

/**
 * Fetch market sentiment for Nifty 50, Bank Nifty, and sectors using OpenAI web search
 * @param {string} scrapeRunId - UUID for this scrape run
 * @returns {Promise<Object>} Market sentiment data including Nifty 50, Bank Nifty, and sectors
 */
async function fetchMarketSentiment(scrapeRunId) {
  const startTime = Date.now();
  const requestId = uuidv4();

  try {
    console.log('[NewsSearch] Fetching market sentiment (Nifty 50, Bank Nifty, Sectors)...');

    // Get today's date in IST
    const today = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istDate = new Date(today.getTime() + istOffset);
    const dateStr = istDate.toISOString().split('T')[0];

    const searchPrompt = `Search for today's (${dateStr}) pre-market outlook and market sentiment for Indian stock markets.

I need COMPREHENSIVE data for:
1. **Nifty 50** - Main index sentiment
2. **Bank Nifty** - Banking sector index sentiment
3. **SGX Nifty / GIFT Nifty futures** - Pre-market indication with percentage change
4. **Sector-wise outlook** - IT, Pharma, Auto, Metal sectors

Look for:
- SGX Nifty / GIFT Nifty futures indication (exact percentage if available)
- US market overnight performance (Dow Jones, S&P 500, Nasdaq)
- Asian markets trend (Nikkei, Hang Seng, SGX)
- FII/DII activity from previous session
- Key support and resistance levels for both Nifty 50 and Bank Nifty
- Sector-specific news affecting IT, Pharma, Auto, Metal stocks

Return a JSON object with this exact structure:
{
  "nifty_50": {
    "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH",
    "confidence": 0.0 to 1.0,
    "summary": "One paragraph summary of Nifty 50 outlook",
    "levels": {
      "support_1": number,
      "support_2": number,
      "resistance_1": number,
      "resistance_2": number,
      "pivot": number
    }
  },
  "bank_nifty": {
    "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH",
    "confidence": 0.0 to 1.0,
    "summary": "One paragraph summary of Bank Nifty outlook",
    "levels": {
      "support_1": number,
      "support_2": number,
      "resistance_1": number,
      "resistance_2": number,
      "pivot": number
    }
  },
  "sgx_nifty": {
    "indication": "+0.5%" or "-0.3%" (percentage string),
    "status": "POSITIVE" | "NEGATIVE" | "FLAT",
    "points": number (if available)
  },
  "sectors": {
    "IT": { "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH", "reason": "brief reason" },
    "PHARMA": { "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH", "reason": "brief reason" },
    "AUTO": { "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH", "reason": "brief reason" },
    "METAL": { "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH", "reason": "brief reason" },
    "BANKING": { "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH", "reason": "brief reason" },
    "REALTY": { "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH", "reason": "brief reason" }
  },
  "key_factors": [
    { "factor": "Description of factor", "impact": "POSITIVE" | "NEGATIVE" | "NEUTRAL" }
  ],
  "global_cues": {
    "us_markets": "POSITIVE" | "NEGATIVE" | "MIXED" | "FLAT",
    "asian_markets": "POSITIVE" | "NEGATIVE" | "MIXED" | "FLAT",
    "dollar_index": "STRONG" | "WEAK" | "STABLE",
    "crude_oil": "UP" | "DOWN" | "STABLE"
  },
  "institutional_activity": {
    "fii_trend": "BUYING" | "SELLING" | "NEUTRAL",
    "dii_trend": "BUYING" | "SELLING" | "NEUTRAL",
    "fii_value_cr": number (if available, in crores),
    "dii_value_cr": number (if available, in crores)
  }
}

Be specific about sentiment - BULLISH means expecting 0.5%+ gains, BEARISH means expecting 0.5%+ losses, NEUTRAL means flat/rangebound.
For SGX Nifty, provide the exact percentage indication if available.`;

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
        description: 'Market sentiment (Nifty 50, Bank Nifty, Sectors) web search'
      }
    });

    console.log(`[NewsSearch] Market sentiment search completed (${responseTime}ms, tokens: ${usage.input_tokens || 0}+${usage.output_tokens || 0})`);

    // Try to extract JSON
    let sentimentData = null;
    const jsonMatch = outputText.match(/\{[\s\S]*"nifty_50"[\s\S]*\}|\{[\s\S]*"sentiment"[\s\S]*\}/);

    if (jsonMatch) {
      try {
        sentimentData = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error('[NewsSearch] Market sentiment JSON parse error');
      }
    }

    // Fallback: Extract sentiment from text (legacy format)
    if (!sentimentData || !sentimentData.nifty_50) {
      const lowerText = outputText.toLowerCase();
      let sentiment = 'NEUTRAL';

      if (lowerText.includes('bullish') || lowerText.includes('positive opening') || lowerText.includes('gap up')) {
        sentiment = 'BULLISH';
      } else if (lowerText.includes('bearish') || lowerText.includes('negative opening') || lowerText.includes('gap down')) {
        sentiment = 'BEARISH';
      }

      // Convert legacy format to new format if needed
      if (sentimentData && sentimentData.sentiment && !sentimentData.nifty_50) {
        sentimentData = {
          nifty_50: {
            sentiment: sentimentData.sentiment,
            confidence: sentimentData.confidence || 0.5,
            summary: sentimentData.summary,
            levels: sentimentData.levels || {}
          },
          bank_nifty: {
            sentiment: sentiment,
            confidence: 0.5,
            summary: 'Bank Nifty outlook aligned with Nifty 50',
            levels: {}
          },
          sgx_nifty: sentimentData.global_cues?.sgx_nifty ? {
            indication: sentimentData.global_cues.sgx_nifty === 'POSITIVE' ? '+0.3%' : sentimentData.global_cues.sgx_nifty === 'NEGATIVE' ? '-0.3%' : '0%',
            status: sentimentData.global_cues.sgx_nifty
          } : { indication: '0%', status: 'FLAT' },
          sectors: {},
          key_factors: sentimentData.key_factors || [],
          global_cues: sentimentData.global_cues || {},
          institutional_activity: sentimentData.institutional_activity || {}
        };
      } else if (!sentimentData) {
        sentimentData = {
          nifty_50: {
            sentiment,
            confidence: 0.5,
            summary: outputText.substring(0, 500),
            levels: {}
          },
          bank_nifty: {
            sentiment,
            confidence: 0.5,
            summary: 'Bank Nifty outlook aligned with Nifty 50',
            levels: {}
          },
          sgx_nifty: { indication: '0%', status: 'FLAT' },
          sectors: {},
          key_factors: [],
          global_cues: {},
          institutional_activity: {}
        };
      }
    }

    // Save Nifty 50 sentiment to database
    const nifty50Data = {
      index_name: 'NIFTY_50',
      sentiment: sentimentData.nifty_50?.sentiment || 'NEUTRAL',
      confidence: sentimentData.nifty_50?.confidence || 0.5,
      summary: sentimentData.nifty_50?.summary,
      key_factors: sentimentData.key_factors || [],
      levels: sentimentData.nifty_50?.levels || {},
      global_cues: sentimentData.global_cues || {},
      institutional_activity: sentimentData.institutional_activity || {},
      sgx_nifty: sentimentData.sgx_nifty || {},
      sectors: sentimentData.sectors || {},
      source: {
        name: 'Web Search',
        scraped_at: new Date()
      },
      scrape_run_id: scrapeRunId
    };

    const savedNifty50 = await MarketSentiment.upsertTodaySentiment(nifty50Data);
    console.log(`[NewsSearch] Nifty 50 sentiment saved: ${savedNifty50.sentiment} (confidence: ${savedNifty50.confidence})`);

    // Save Bank Nifty sentiment to database
    const bankNiftyData = {
      index_name: 'BANK_NIFTY',
      sentiment: sentimentData.bank_nifty?.sentiment || 'NEUTRAL',
      confidence: sentimentData.bank_nifty?.confidence || 0.5,
      summary: sentimentData.bank_nifty?.summary,
      key_factors: [],
      levels: sentimentData.bank_nifty?.levels || {},
      global_cues: {},
      institutional_activity: {},
      source: {
        name: 'Web Search',
        scraped_at: new Date()
      },
      scrape_run_id: scrapeRunId
    };

    const savedBankNifty = await MarketSentiment.upsertTodaySentiment(bankNiftyData);
    console.log(`[NewsSearch] Bank Nifty sentiment saved: ${savedBankNifty.sentiment} (confidence: ${savedBankNifty.confidence})`);

    // Return combined data for API response
    return {
      nifty_50: savedNifty50,
      bank_nifty: savedBankNifty,
      sgx_nifty: sentimentData.sgx_nifty || {},
      sectors: sentimentData.sectors || {},
      global_cues: sentimentData.global_cues || {},
      institutional_activity: sentimentData.institutional_activity || {}
    };

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

    // Fetch news (RSS primary, web search fallback)
    const { stocks: scrapedStocks, metadata } = await fetchStockNews(scrapeRunId);

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
        description: h.description || null,  // Include description from web search
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
        description: h.description || null,  // Detailed news description
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
  // Fetch both Nifty 50 and Bank Nifty sentiment
  const [nifty50Result, bankNiftyResult] = await Promise.all([
    MarketSentiment.getTodayOrLatest('NIFTY_50'),
    MarketSentiment.getTodayOrLatest('BANK_NIFTY')
  ]);

  const nifty50 = nifty50Result.sentiment;
  const bankNifty = bankNiftyResult.sentiment;
  const is_today = nifty50Result.is_today || bankNiftyResult.is_today;

  if (!nifty50) {
    return {
      sentiment: null,
      is_today: false,
      message: 'No market sentiment available'
    };
  }

  // Format Nifty 50 data
  const nifty50Data = {
    index_name: nifty50.index_name,
    sentiment: nifty50.sentiment,
    confidence: nifty50.confidence,
    summary: nifty50.summary,
    key_factors: nifty50.key_factors,
    levels: nifty50.levels,
    global_cues: nifty50.global_cues,
    institutional_activity: nifty50.institutional_activity,
    analysis_date: nifty50.analysis_date
  };

  // Format Bank Nifty data
  const bankNiftyData = bankNifty ? {
    index_name: bankNifty.index_name,
    sentiment: bankNifty.sentiment,
    confidence: bankNifty.confidence,
    summary: bankNifty.summary,
    levels: bankNifty.levels,
    analysis_date: bankNifty.analysis_date
  } : null;

  // Extract SGX Nifty and sectors from Nifty 50 document (stored together)
  const sgxNifty = nifty50.sgx_nifty || null;
  const sectors = nifty50.sectors || null;

  return {
    sentiment: nifty50Data,
    bank_nifty: bankNiftyData,
    sgx_nifty: sgxNifty,
    sectors: sectors,
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
