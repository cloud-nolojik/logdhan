/**
 * Upstox News Scraper — "Stocks to Watch" Daily Article
 *
 * Scrapes https://upstox.com/news/market-news/stocks/ to find today's
 * "stocks to watch" article, extracts stock mentions, determines
 * direction (LONG/SHORT) from article sentiment + technical confirmation,
 * and returns candidates in the same format as ChartInk scan results.
 *
 * Flow:
 *   1. Fetch listing page → find today's article URL (slug contains "stocks-to-watch")
 *   2. Fetch article → extract per-stock text sections
 *   3. Claude AI parses sentiment per stock (bullish/bearish/neutral)
 *   4. Map company names → NSE trading symbols via Stock collection
 *   5. Return candidates compatible with dailyPicksService pipeline
 *
 * Integrated into dailyPicksService.js at Step 2 — news candidates are
 * merged with ChartInk candidates and flow through Steps 2.5→3→4→5 unchanged.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';
import Stock from '../../models/Stock.js';

const LOG = '[NEWS-SCRAPER]';
const LISTING_URL = 'https://upstox.com/news/market-news/stocks/';
const BASE_URL = 'https://upstox.com';

// Reuse a single Anthropic client (lazy init)
let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scrape today's "Stocks to Watch" article and return candidates.
 *
 * @returns {Object} { candidates: [...], article_url, article_title, raw_stocks }
 *   candidates: Array of { symbol, stock_name, scan_type, direction, scan_matches, scan_count, chartink_data, news_context }
 *   — same shape as ChartInk scan output, ready for injection into Step 2 merge.
 */
export async function scrapeUpstoxNewsForCandidates() {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Starting Upstox "Stocks to Watch" scrape`);
  console.log(`${LOG} ════════════════════════════════════════`);

  try {
    // Step 1: Find today's article URL
    const articleUrl = await findTodaysArticleUrl();
    if (!articleUrl) {
      console.log(`${LOG} No "stocks to watch" article found for today. Skipping.`);
      return { candidates: [], article_url: null, article_title: null, raw_stocks: [] };
    }
    console.log(`${LOG} Found article: ${articleUrl}`);

    // Step 2: Scrape article content
    const articleContent = await scrapeArticle(articleUrl);
    if (!articleContent || !articleContent.body) {
      console.log(`${LOG} Failed to extract article content. Skipping.`);
      return { candidates: [], article_url: articleUrl, article_title: null, raw_stocks: [] };
    }
    console.log(`${LOG} Article: "${articleContent.title}" (${articleContent.body.length} chars)`);

    // Step 3: Use Claude to parse stocks + sentiment
    const parsedStocks = await parseStocksWithAI(articleContent.body, articleContent.title);
    if (!parsedStocks || parsedStocks.length === 0) {
      console.log(`${LOG} AI could not extract any stocks from article. Skipping.`);
      return { candidates: [], article_url: articleUrl, article_title: articleContent.title, raw_stocks: [] };
    }
    console.log(`${LOG} AI extracted ${parsedStocks.length} stocks: ${parsedStocks.map(s => `${s.name}(${s.sentiment})`).join(', ')}`);

    // Step 4: Map to NSE trading symbols
    const candidates = await mapToCandidates(parsedStocks);
    console.log(`${LOG} Mapped ${candidates.length}/${parsedStocks.length} stocks to NSE symbols`);

    return {
      candidates,
      article_url: articleUrl,
      article_title: articleContent.title,
      raw_stocks: parsedStocks
    };

  } catch (err) {
    console.error(`${LOG} Scraper failed:`, err.message);
    return { candidates: [], article_url: null, article_title: null, raw_stocks: [], error: err.message };
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: FIND TODAY'S ARTICLE URL
// ═══════════════════════════════════════════════════════════════════════════════

async function findTodaysArticleUrl() {
  console.log(`${LOG} [Step 1] Fetching listing page: ${LISTING_URL}`);

  const { data: html } = await axios.get(LISTING_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
    timeout: 15000,
  });

  const $ = cheerio.load(html);

  // Build today's date slug patterns (e.g., "stocks-to-watch-april-10", "stocks-to-watch-10-april")
  const today = new Date();
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];
  const month = monthNames[today.getMonth()];
  const day = today.getDate();

  // Possible slug patterns (Upstox has used both formats)
  const patterns = [
    `stocks-to-watch-${month}-${day}`,       // stocks-to-watch-april-10
    `stocks-to-watch-${day}-${month}`,       // stocks-to-watch-10-april
    `stocks-to-watch-${month}${day}`,        // stocks-to-watch-april10
  ];

  console.log(`${LOG} [Step 1] Looking for slug patterns: ${patterns.join(', ')}`);

  // Search all links on page for matching slug
  let matchedUrl = null;

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const hrefLower = href.toLowerCase();
    for (const pattern of patterns) {
      if (hrefLower.includes(pattern)) {
        matchedUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        return false; // break .each()
      }
    }
  });

  // Fallback: check for any "stocks-to-watch" link (most recent = first match)
  if (!matchedUrl) {
    console.log(`${LOG} [Step 1] No exact date match. Trying generic "stocks-to-watch" fallback...`);
    $('a[href*="stocks-to-watch"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      matchedUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
      return false; // take first match (most recent)
    });
  }

  // Also check for JSON-LD structured data or embedded script data
  if (!matchedUrl) {
    console.log(`${LOG} [Step 1] No link match. Checking embedded data...`);
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const url = data?.url || data?.mainEntityOfPage;
        if (url && url.toLowerCase().includes('stocks-to-watch')) {
          matchedUrl = url;
          return false;
        }
      } catch { /* ignore parse errors */ }
    });
  }

  if (matchedUrl) {
    console.log(`${LOG} [Step 1] Found article URL: ${matchedUrl}`);
  } else {
    console.log(`${LOG} [Step 1] No "stocks to watch" article found for today.`);
  }

  return matchedUrl;
}


// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: SCRAPE ARTICLE CONTENT
// ═══════════════════════════════════════════════════════════════════════════════

async function scrapeArticle(url) {
  console.log(`${LOG} [Step 2] Fetching article: ${url}`);

  const { data: html } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
    timeout: 15000,
  });

  const $ = cheerio.load(html);

  // Extract article title
  const title = $('h1').first().text().trim()
    || $('meta[property="og:title"]').attr('content')
    || '';

  // Extract article body — try common article selectors
  let body = '';
  const articleSelectors = [
    'article',
    '.article-body',
    '.article-content',
    '.post-content',
    '.entry-content',
    '[itemprop="articleBody"]',
    '.story-content',
    'main',
  ];

  for (const selector of articleSelectors) {
    const el = $(selector);
    if (el.length > 0) {
      body = el.text().trim();
      if (body.length > 200) {
        console.log(`${LOG} [Step 2] Extracted body from "${selector}" (${body.length} chars)`);
        break;
      }
    }
  }

  // Fallback: extract all paragraph text
  if (body.length < 200) {
    const paragraphs = [];
    $('p').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 30) paragraphs.push(text);
    });
    body = paragraphs.join('\n\n');
    console.log(`${LOG} [Step 2] Fallback: extracted ${paragraphs.length} paragraphs (${body.length} chars)`);
  }

  // Also extract any structured data with stock info
  let structuredStocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      // Upstox articles sometimes embed security data
      if (data?.about) {
        const about = Array.isArray(data.about) ? data.about : [data.about];
        for (const item of about) {
          if (item?.tickerSymbol || item?.name) {
            structuredStocks.push({
              symbol: item.tickerSymbol || '',
              name: item.name || '',
              exchange: item.exchange || 'NSE',
            });
          }
        }
      }
    } catch { /* ignore parse errors */ }
  });

  if (structuredStocks.length > 0) {
    console.log(`${LOG} [Step 2] Found ${structuredStocks.length} stocks in structured data: ${structuredStocks.map(s => s.symbol || s.name).join(', ')}`);
  }

  return { title, body, structuredStocks };
}


// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: AI-POWERED STOCK + SENTIMENT EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

async function parseStocksWithAI(articleBody, articleTitle) {
  console.log(`${LOG} [Step 3] Sending article to Claude for stock extraction...`);

  const client = getAnthropicClient();

  const prompt = `You are an Indian stock market analyst. Analyze this "Stocks to Watch" article and extract EVERY stock mentioned.

For each stock, determine:
1. The exact company name as used in the article
2. The most likely NSE trading symbol (e.g., TCS, WIPRO, INFY, GODREJPROP, BLUESTARCO, EICHERMOT)
3. The sentiment: BULLISH, BEARISH, or NEUTRAL based on what the article says about this specific stock
4. A brief reason (1 sentence) for the sentiment classification
5. Key data points from the article (earnings, growth %, news catalyst)

IMPORTANT RULES for sentiment classification:
- BULLISH: Article mentions positive earnings, revenue growth, expansion, upgrades, strong demand, record performance, buyback, stock rally
- BEARISH: Article mentions profit decline, revenue miss, downgrades, weak guidance, regulatory issues, debt concerns
- NEUTRAL: Article mentions event without clear direction (board meeting scheduled, awaiting results, mixed signals)
- If the article only mentions a stock briefly without clear positive/negative context, classify as NEUTRAL

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "stocks": [
    {
      "name": "Company Name",
      "likely_nse_symbol": "SYMBOL",
      "sentiment": "BULLISH|BEARISH|NEUTRAL",
      "reason": "Brief explanation",
      "key_data": "Key numbers/facts from article"
    }
  ]
}`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Article Title: ${articleTitle}\n\nArticle Content:\n${articleBody.substring(0, 6000)}`
      }],
      system: prompt,
    });

    const text = response.content[0]?.text || '';

    // Parse JSON from response (handle potential markdown wrapping)
    let jsonStr = text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);
    return (parsed.stocks || []).filter(s => s.sentiment !== 'NEUTRAL');

  } catch (err) {
    console.error(`${LOG} [Step 3] AI parsing failed:`, err.message);
    return [];
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: MAP TO NSE CANDIDATES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Map AI-extracted stocks to Stock collection and create candidate objects
 * in the same shape as ChartInk scan output.
 */
async function mapToCandidates(parsedStocks) {
  const candidates = [];

  for (const stock of parsedStocks) {
    const { name, likely_nse_symbol, sentiment, reason, key_data } = stock;

    // Try to find in Stock collection by trading_symbol first, then by name
    let dbStock = await Stock.findOne({
      trading_symbol: likely_nse_symbol.toUpperCase(),
      segment: 'NSE_EQ',
    }).lean();

    // Fallback: search by name (partial match)
    if (!dbStock) {
      dbStock = await Stock.findOne({
        name: { $regex: new RegExp(escapeRegex(name), 'i') },
        segment: 'NSE_EQ',
      }).lean();
    }

    // Fallback: search by short_name
    if (!dbStock) {
      dbStock = await Stock.findOne({
        short_name: { $regex: new RegExp(escapeRegex(likely_nse_symbol), 'i') },
        segment: 'NSE_EQ',
      }).lean();
    }

    if (!dbStock) {
      console.log(`${LOG} [Step 4] ${name} (${likely_nse_symbol}): NOT FOUND in Stock collection. Skipping.`);
      continue;
    }

    const symbol = dbStock.trading_symbol;
    const direction = sentiment === 'BULLISH' ? 'LONG' : 'SHORT';
    const scanType = sentiment === 'BULLISH' ? 'news_upstox_bullish' : 'news_upstox_bearish';

    console.log(`${LOG} [Step 4] ${name} → ${symbol} (${direction}) — ${reason}`);

    candidates.push({
      symbol,
      stock_name: dbStock.name || name,
      scan_type: scanType,
      direction,
      scan_matches: [scanType],
      scan_count: 1,
      chartink_data: {
        per_change: 0,   // not available from news
        close: 0,        // will be filled by enrichment
        volume: 0,       // will be filled by enrichment
      },
      // Set news_sentiment for existing pipeline compatibility (persisted in DailyPick.picks)
      news_sentiment: sentiment,
      // Extra context for scoring/logging — carries through pipeline via spread operators
      news_context: {
        source: 'upstox_stocks_to_watch',
        sentiment,
        reason,
        key_data,
        article_name: name,
        ai_symbol_guess: likely_nse_symbol,
      },
    });
  }

  return candidates;
}


// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default { scrapeUpstoxNewsForCandidates };
