/**
 * Global Market Intelligence — Step 5.5 of Daily Picks Pipeline
 *
 * Runs at ~6:35 AM IST (AFTER ChartInk scans + enrichment + scoring + levels)
 * using Claude web search to fetch LIVE global events, sector outlook,
 * and market-moving news. Receives viable candidate symbols for stock-specific analysis.
 * Supports historical date override for backtesting.
 *
 * Why this exists:
 * - streetGainsScraper runs at 8:30 AM — 2 hours AFTER picks are selected
 * - By 8:30 AM, AMO orders are already placed based on stale/no data
 * - This fetches REAL-TIME intelligence at the moment of selection
 *
 * What it fetches:
 * 1. Global events: US Fed, RBI policy, budget, wars, sanctions, etc.
 * 2. Overnight market moves: US markets, Asian markets, SGX Nifty
 * 3. Sector outlook: which sectors likely to do well/poorly today
 * 4. FII/DII flows: institutional activity from previous session
 * 5. Stock-specific news: earnings, results, SEBI actions for candidates
 *
 * How it's used:
 * - Market mood → affects regime interpretation
 * - Sector outlook → boosts/penalizes picks in hot/cold sectors (+5/-5)
 * - Stock-specific news → score adjustments per candidate (+10/-15)
 * - Global risk events → can halt trading entirely (STAY_OUT)
 *
 * Fail-open: if web search fails, pipeline continues without intel
 */

import Anthropic from '@anthropic-ai/sdk';
import ApiUsage from '../../models/apiUsage.js';
import { v4 as uuidv4 } from 'uuid';
import { mapSectorToIntelKey } from '../../utils/sectorMapping.js';

const LOG = '[GLOBAL-INTEL]';

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// Cache for today's intel (avoid re-fetching if pipeline retries)
// TTL: 2 hours — stale intel can mislead afternoon decisions
const INTEL_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
let _intelCache = null;
let _intelCacheDate = null;
let _intelCacheTime = null;

/**
 * Fetch global market intelligence using Claude web search.
 * Called as Step 5.5 of runDailyPicks(), AFTER viable candidates are identified.
 *
 * @param {string} [dateOverride] - Optional date string (YYYY-MM-DD) for historical backtest.
 *                                  If omitted, fetches for today (live mode).
 * @param {string[]} [candidateSymbols] - Optional list of stock symbols (from ChartInk scans)
 *                                         so Claude can give stock-specific impact analysis.
 * @returns {Object} Global market intelligence data
 */
async function fetchGlobalMarketIntel(dateOverride, candidateSymbols) {
  const todayStr = dateOverride || getISTDateStr();
  const isHistorical = !!dateOverride && dateOverride !== getISTDateStr();

  // Return cache if same date and not expired (TTL: 2 hours)
  if (_intelCache && _intelCacheDate === todayStr) {
    const cacheAge = Date.now() - (_intelCacheTime || 0);
    if (cacheAge < INTEL_CACHE_TTL_MS) {
      console.log(`${LOG} Using cached intel for ${todayStr} (age: ${Math.round(cacheAge / 60000)}min)`);
      return _intelCache;
    }
    console.log(`${LOG} Intel cache expired (age: ${Math.round(cacheAge / 60000)}min > ${INTEL_CACHE_TTL_MS / 60000}min) — re-fetching`);
  }

  const startTime = Date.now();
  const requestId = uuidv4().substring(0, 8);

  try {
    console.log(`${LOG} Fetching ${isHistorical ? 'HISTORICAL' : 'LIVE'} global market intelligence via Claude web search for ${todayStr}...`);

    const anthropic = getAnthropicClient();
    if (!anthropic) {
      console.log(`${LOG} Anthropic not configured — skipping`);
      return getEmptyIntel();
    }

    const symbols = candidateSymbols || [];
    const searchPrompt = isHistorical
      ? buildHistoricalIntelPrompt(todayStr, symbols)
      : buildIntelPrompt(todayStr, symbols);

    // 90-second timeout — Claude web search can take 30-60s normally.
    // Without this, a hung request blocks the entire pipeline indefinitely.
    const INTEL_TIMEOUT_MS = 90000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INTEL_TIMEOUT_MS);

    let response;
    try {
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: searchPrompt }]
      }, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    const responseTime = Date.now() - startTime;
    const usage = response.usage || {};

    // Log API usage
    try {
      await ApiUsage.logUsage({
        provider: 'ANTHROPIC',
        model: 'claude-sonnet-4-20250514',
        feature: 'GLOBAL_MARKET_INTEL',
        tokens: {
          input: usage.input_tokens || 0,
          output: usage.output_tokens || 0
        },
        request_id: requestId,
        response_time_ms: responseTime,
        success: true,
        context: { description: `${isHistorical ? 'Historical' : 'Pre-scan'} global market intelligence for ${todayStr}` }
      });
    } catch { /* non-fatal */ }

    // Extract text from Claude response content blocks
    const outputText = response.content
      ?.filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n') || '';
    console.log(`${LOG} Web search completed (${responseTime}ms, tokens: ${usage.input_tokens || 0}+${usage.output_tokens || 0})`);

    // Parse JSON from response
    const intel = parseIntelResponse(outputText);

    // Log summary
    console.log(`${LOG} ═══════════════════════════════════════`);
    console.log(`${LOG} GLOBAL MARKET INTELLIGENCE — ${todayStr}`);
    console.log(`${LOG} ═══════════════════════════════════════`);
    console.log(`${LOG} Market mood: ${intel.market_mood}`);
    console.log(`${LOG} Risk level: ${intel.risk_level}`);

    if (intel.sgx_nifty) {
      console.log(`${LOG} SGX Nifty: ${intel.sgx_nifty.indication} (${intel.sgx_nifty.status})`);
    }

    if (intel.global_cues) {
      console.log(`${LOG} US markets: ${intel.global_cues.us_markets} | Asia: ${intel.global_cues.asian_markets}`);
      console.log(`${LOG} Dollar: ${intel.global_cues.dollar_index} | Crude: ${intel.global_cues.crude_oil}`);
    }

    if (intel.sectors && Object.keys(intel.sectors).length > 0) {
      const hot = Object.entries(intel.sectors).filter(([, s]) => s.sentiment === 'BULLISH').map(([k]) => k);
      const cold = Object.entries(intel.sectors).filter(([, s]) => s.sentiment === 'BEARISH').map(([k]) => k);
      if (hot.length) console.log(`${LOG} Hot sectors: ${hot.join(', ')}`);
      if (cold.length) console.log(`${LOG} Cold sectors: ${cold.join(', ')}`);
    }

    if (intel.major_events && intel.major_events.length > 0) {
      for (const evt of intel.major_events) {
        console.log(`${LOG} ⚡ EVENT: ${evt.event} (${evt.impact})`);
      }
    }

    if (intel.stock_specific && Object.keys(intel.stock_specific).length > 0) {
      console.log(`${LOG} ─── Stock-Specific News ───`);
      for (const [sym, news] of Object.entries(intel.stock_specific)) {
        console.log(`${LOG}   ${sym}: ${news.sentiment} (${news.impact}) — "${news.headline || 'no headline'}"`);
      }
    }

    console.log(`${LOG} Trading recommendation: ${intel.trading_recommendation}${intel.recommendation_reason ? ` — ${intel.recommendation_reason}` : ''}`);
    console.log(`${LOG} ═══════════════════════════════════════`);

    // Cache for today (with TTL tracking)
    _intelCache = intel;
    _intelCacheDate = todayStr;
    _intelCacheTime = Date.now();

    return intel;

  } catch (err) {
    console.error(`${LOG} ❌ Web search failed (fail-open, continuing without intel):`, err.message);

    try {
      await ApiUsage.logUsage({
        provider: 'ANTHROPIC',
        model: 'claude-sonnet-4-20250514',
        feature: 'GLOBAL_MARKET_INTEL',
        tokens: { input: 0, output: 0 },
        request_id: requestId,
        response_time_ms: Date.now() - startTime,
        success: false,
        context: { error: err.message }
      });
    } catch { /* non-fatal */ }

    return getEmptyIntel();
  }
}

/**
 * Build a web search prompt for HISTORICAL market intelligence (backtest mode).
 * India-focused, stock-aware — tells us how global events impact these specific Indian stocks.
 */
function buildHistoricalIntelPrompt(dateStr, candidateSymbols) {
  const stockList = candidateSymbols.length > 0
    ? `\n\nCANDIDATE STOCKS FOR THIS DAY (from ChartInk scans):\n${candidateSymbols.join(', ')}\n\nFor stock_specific: search for news/events on ${dateStr} that specifically affect these stocks (earnings, results, SEBI actions, sector-specific events, M&A, management changes). Only include stocks with ACTUAL news.`
    : '';

  return `I run an intraday trading system on the Indian stock market (NSE). I need to reconstruct what global and domestic conditions looked like at 6:30 AM IST on ${dateStr} — a PAST date. This is for backtesting.

Search for news from ${dateStr} and tell me HOW it impacts Indian stocks specifically:

1. **SGX/GIFT Nifty futures** — what was the pre-market indication? This is the #1 signal for Indian market open direction.
2. **US markets overnight** — how did S&P 500, Nasdaq, Dow close? More importantly: which Indian sectors does this affect? (e.g., Nasdaq rally → Indian IT stocks up, US banking stress → Indian bank stocks affected)
3. **Asian markets** — Nikkei, Hang Seng, SGX at the time. Impact on Indian market sentiment.
4. **Dollar/Rupee** — DXY strength/weakness. Strong dollar = FII outflows from India = bearish. Weak dollar = FII inflows = bullish.
5. **Crude oil** — Price direction. High crude = bearish for India (import dependent). Oil up = OMC stocks down, ONGC up.
6. **FII/DII flows** — Were FIIs buying or selling Indian equities in the previous session? This drives next-day sentiment.
7. **Major events** — RBI policy, Union Budget, elections, global crises, tariffs, sanctions that impact Indian markets.
8. **Indian sector outlook** — Based on all the above, which NSE sectors are likely bullish/bearish on ${dateStr}? Be specific about WHY (e.g., "BANKING bearish because RBI kept rates high" not just "BANKING bearish").${stockList}

Return a JSON object:
{
  "market_mood": "BULLISH" | "BEARISH" | "CAUTIOUS" | "NEUTRAL",
  "risk_level": "LOW" | "MEDIUM" | "HIGH" | "EXTREME",
  "risk_reason": "How this specifically affects Indian market trading",
  "sgx_nifty": { "indication": "+0.5%", "status": "POSITIVE" | "NEGATIVE" | "FLAT", "points": number },
  "global_cues": {
    "us_markets": "POSITIVE" | "NEGATIVE" | "MIXED" | "CLOSED",
    "us_detail": "S&P +0.5%, Nasdaq +0.8%",
    "indian_impact": "IT stocks likely gap up, metal stocks neutral",
    "asian_markets": "POSITIVE" | "NEGATIVE" | "MIXED",
    "asian_detail": "Nikkei +0.3%, Hang Seng -0.2%",
    "dollar_index": "STRONG" | "WEAK" | "STABLE",
    "rupee_impact": "FII outflow pressure" | "FII inflow likely" | "Neutral",
    "crude_oil": "UP" | "DOWN" | "STABLE",
    "crude_price": number,
    "crude_indian_impact": "OMCs under pressure, ONGC benefits"
  },
  "institutional": { "fii_trend": "BUYING" | "SELLING" | "NEUTRAL", "fii_value_cr": number, "dii_trend": "BUYING" | "SELLING" | "NEUTRAL", "dii_value_cr": number },
  "sectors": {
    "IT": { "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH", "reason": "why, linked to global cue" },
    "BANKING": { "sentiment": "...", "reason": "why" },
    "PHARMA": { "sentiment": "...", "reason": "why" },
    "AUTO": { "sentiment": "...", "reason": "why" },
    "METAL": { "sentiment": "...", "reason": "why" },
    "REALTY": { "sentiment": "...", "reason": "why" },
    "ENERGY": { "sentiment": "...", "reason": "why" },
    "FMCG": { "sentiment": "...", "reason": "why" },
    "INFRA": { "sentiment": "...", "reason": "why" }
  },
  "major_events": [{ "event": "description", "impact": "HIGH" | "MEDIUM" | "LOW", "affected_sectors": ["BANKING"], "sentiment_effect": "BEARISH", "indian_impact": "how this event hits Indian stocks" }],
  "stock_specific": {
    "SYMBOL": { "sentiment": "BULLISH" | "BEARISH", "headline": "actual news", "impact": "HIGH" | "MEDIUM" | "LOW" }
  },
  "trading_recommendation": "NORMAL" | "REDUCE_SIZE" | "AVOID_SHORTS" | "AVOID_LONGS" | "STAY_OUT",
  "recommendation_reason": "Why this recommendation, in Indian market context"
}

**CRITICAL:** This is for ${dateStr} specifically. Every sector reason and every recommendation must explain the Indian stock market impact, not just state the global fact. "US Nasdaq up 1%" is useless — "US Nasdaq up 1% → Indian IT stocks (TCS, INFY, WIPRO) likely to gap up" is useful.`;
}

/**
 * Build the web search prompt for LIVE global market intelligence.
 * India-focused, stock-aware — tells us how global events impact these specific Indian stocks.
 */
function buildIntelPrompt(dateStr, candidateSymbols) {
  const symbols = candidateSymbols || [];
  const stockList = symbols.length > 0
    ? `\n\nCANDIDATE STOCKS FOR TODAY (from ChartInk scans):\n${symbols.join(', ')}\n\nFor stock_specific: search for news/events TODAY that specifically affect these stocks (earnings, results, SEBI actions, sector-specific events, M&A, management changes). Only include stocks with ACTUAL news.`
    : '';

  return `I run an intraday trading system on the Indian stock market (NSE). I need REAL-TIME intelligence for trading decisions at 6:30 AM IST on ${dateStr}.

Search for the LATEST news and tell me HOW it impacts Indian stocks specifically:

1. **SGX/GIFT Nifty futures** — what is the pre-market indication RIGHT NOW? This is the #1 signal for Indian market open direction.
2. **US markets overnight** — how did S&P 500, Nasdaq, Dow close? More importantly: which Indian sectors does this affect? (e.g., Nasdaq rally → Indian IT stocks up, US banking stress → Indian bank stocks affected)
3. **Asian markets** — Nikkei, Hang Seng, SGX live. Impact on Indian market sentiment.
4. **Dollar/Rupee** — DXY strength/weakness. Strong dollar = FII outflows from India = bearish. Weak dollar = FII inflows = bullish.
5. **Crude oil** — Price direction. High crude = bearish for India (import dependent). Oil up = OMC stocks down, ONGC up.
6. **FII/DII flows** — Were FIIs buying or selling Indian equities in the previous session? This drives today's sentiment.
7. **Major events** — RBI policy, Union Budget, elections, global crises, tariffs, sanctions that impact Indian markets TODAY.
8. **Indian sector outlook** — Based on all the above, which NSE sectors are likely bullish/bearish today? Be specific about WHY (e.g., "BANKING bearish because RBI kept rates high" not just "BANKING bearish").${stockList}

Return a JSON object:
{
  "market_mood": "BULLISH" | "BEARISH" | "CAUTIOUS" | "NEUTRAL",
  "risk_level": "LOW" | "MEDIUM" | "HIGH" | "EXTREME",
  "risk_reason": "How this specifically affects Indian market trading",
  "sgx_nifty": { "indication": "+0.5%", "status": "POSITIVE" | "NEGATIVE" | "FLAT", "points": number },
  "global_cues": {
    "us_markets": "POSITIVE" | "NEGATIVE" | "MIXED" | "CLOSED",
    "us_detail": "S&P +0.5%, Nasdaq +0.8%",
    "indian_impact": "IT stocks likely gap up, metal stocks neutral",
    "asian_markets": "POSITIVE" | "NEGATIVE" | "MIXED",
    "asian_detail": "Nikkei +0.3%, Hang Seng -0.2%",
    "dollar_index": "STRONG" | "WEAK" | "STABLE",
    "rupee_impact": "FII outflow pressure" | "FII inflow likely" | "Neutral",
    "crude_oil": "UP" | "DOWN" | "STABLE",
    "crude_price": number,
    "crude_indian_impact": "OMCs under pressure, ONGC benefits"
  },
  "institutional": { "fii_trend": "BUYING" | "SELLING" | "NEUTRAL", "fii_value_cr": number, "dii_trend": "BUYING" | "SELLING" | "NEUTRAL", "dii_value_cr": number },
  "sectors": {
    "IT": { "sentiment": "BULLISH" | "NEUTRAL" | "BEARISH", "reason": "why, linked to global cue" },
    "BANKING": { "sentiment": "...", "reason": "why" },
    "PHARMA": { "sentiment": "...", "reason": "why" },
    "AUTO": { "sentiment": "...", "reason": "why" },
    "METAL": { "sentiment": "...", "reason": "why" },
    "REALTY": { "sentiment": "...", "reason": "why" },
    "ENERGY": { "sentiment": "...", "reason": "why" },
    "FMCG": { "sentiment": "...", "reason": "why" },
    "INFRA": { "sentiment": "...", "reason": "why" }
  },
  "major_events": [{ "event": "description", "impact": "HIGH" | "MEDIUM" | "LOW", "affected_sectors": ["BANKING"], "sentiment_effect": "BEARISH", "indian_impact": "how this event hits Indian stocks" }],
  "stock_specific": {
    "SYMBOL": { "sentiment": "BULLISH" | "BEARISH", "headline": "actual news", "impact": "HIGH" | "MEDIUM" | "LOW" }
  },
  "trading_recommendation": "NORMAL" | "REDUCE_SIZE" | "AVOID_SHORTS" | "AVOID_LONGS" | "STAY_OUT",
  "recommendation_reason": "Why this recommendation, in Indian market context"
}

**CRITICAL:** Every sector reason and every recommendation must explain the Indian stock market impact, not just state the global fact. "US Nasdaq up 1%" is useless — "US Nasdaq up 1% → Indian IT stocks (TCS, INFY, WIPRO) likely to gap up" is useful.
SGX/GIFT Nifty futures are the most important pre-market signal. Be specific with numbers — don't say "positive", say "+0.5%".
For risk_level: EXTREME = black swan/crisis, HIGH = major event day, MEDIUM = some headwinds, LOW = normal.
trading_recommendation: "STAY_OUT" only for extreme events (budget day, RBI policy day).`;
}

/**
 * Parse the JSON response from Claude web search.
 */
function parseIntelResponse(text) {
  try {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      console.error(`${LOG} parseIntelResponse: empty or non-string input`);
      return getEmptyIntel();
    }

    // Try to extract JSON from markdown code blocks or raw text
    let jsonStr = text;

    // Strategy 1: code block extraction (most common)
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    } else {
      // Strategy 2: find first { to last } (handles prose wrapping JSON)
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        jsonStr = text.substring(start, end + 1);
      }
    }

    // Clean common JSON issues from LLM output
    // Remove trailing commas before } or ] (invalid JSON but common LLM mistake)
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr);

    // Validate required fields with defaults
    return {
      market_mood: parsed.market_mood || 'NEUTRAL',
      risk_level: parsed.risk_level || 'MEDIUM',
      risk_reason: parsed.risk_reason || null,
      recommendation_reason: parsed.recommendation_reason || null,
      sgx_nifty: parsed.sgx_nifty || null,
      global_cues: parsed.global_cues || null,
      institutional: parsed.institutional || null,
      sectors: parsed.sectors || {},
      major_events: parsed.major_events || [],
      stock_specific: parsed.stock_specific || {},
      trading_recommendation: parsed.trading_recommendation || 'NORMAL',
      fetched_at: new Date().toISOString(),
      source: 'claude_websearch'
    };

  } catch (err) {
    console.error(`${LOG} Failed to parse intel response: ${err.message}`);
    console.error(`${LOG} Raw response (first 500 chars): ${text.substring(0, 500)}`);
    return getEmptyIntel();
  }
}

/**
 * Get sector sentiment for a specific stock symbol.
 * Uses SECTOR_MAPPING to find which sector a stock belongs to,
 * then maps to intel key and returns the intel for that sector.
 *
 * @param {string} symbol - Stock symbol (e.g. 'TCS', 'HDFCBANK')
 * @param {Object} sectorMappingObj - SECTOR_MAPPING from sectorMapping.js
 *   Format: { TECH: { companies: ['TCS', ...], name: '...', ... }, ... }
 * @returns {{ sentiment: string, reason: string, sectorName: string } | null}
 */
function getSectorSentimentForStock(symbol, sectorMappingObj) {
  if (!_intelCache || !_intelCache.sectors) return null;

  // Find which sector this stock belongs to via SECTOR_MAPPING
  for (const [sectorCode, sectorInfo] of Object.entries(sectorMappingObj)) {
    if (sectorInfo.companies && sectorInfo.companies.includes(symbol)) {
      // Use the shared canonical mapper (SECTOR_MAPPING key → intel key)
      const intelKey = mapSectorToIntelKey(sectorCode);
      const sectorData = _intelCache.sectors[intelKey];
      if (sectorData) {
        return {
          sentiment: sectorData.sentiment,
          reason: sectorData.reason,
          sectorName: intelKey
        };
      }
    }
  }

  return null;
}

// mapSectorName() REMOVED — was the 3rd duplicate mapper.
// Now using shared mapSectorToIntelKey() from sectorMapping.js everywhere.

/**
 * Get stock-specific news for a candidate symbol.
 */
function getStockSpecificNews(symbol) {
  if (!_intelCache || !_intelCache.stock_specific) return null;
  return _intelCache.stock_specific[symbol] || _intelCache.stock_specific[symbol.toUpperCase()] || null;
}

/**
 * Check if today is a high-risk event day where trading should be avoided.
 */
function shouldAvoidTrading() {
  if (!_intelCache) {
    console.log(`${LOG} shouldAvoidTrading: no intel cache — allowing (fail-open)`);
    return { avoid: false, reason: null };
  }

  if (_intelCache.trading_recommendation === 'STAY_OUT') {
    console.log(`${LOG} ⛔ shouldAvoidTrading: STAY_OUT — ${_intelCache.risk_reason || 'Major event day'}`);
    return { avoid: true, reason: `STAY_OUT: ${_intelCache.risk_reason || 'Major event day'}` };
  }

  if (_intelCache.risk_level === 'EXTREME') {
    console.log(`${LOG} ⛔ shouldAvoidTrading: EXTREME risk — ${_intelCache.risk_reason || 'Global crisis'}`);
    return { avoid: true, reason: `EXTREME risk: ${_intelCache.risk_reason || 'Global crisis'}` };
  }

  console.log(`${LOG} shouldAvoidTrading: risk=${_intelCache.risk_level} rec=${_intelCache.trading_recommendation} — trading allowed`);
  return { avoid: false, reason: null };
}

/**
 * Get trading recommendation adjustments.
 */
function getTradingAdjustment() {
  if (!_intelCache) {
    console.log(`${LOG} getTradingAdjustment: no intel cache — normal trading`);
    return { sizeMultiplier: 1.0, avoidDirection: null };
  }

  const rec = _intelCache.trading_recommendation;
  let result;
  switch (rec) {
    case 'REDUCE_SIZE':
      result = { sizeMultiplier: 0.5, avoidDirection: null };
      break;
    case 'AVOID_SHORTS':
      result = { sizeMultiplier: 1.0, avoidDirection: 'SHORT' };
      break;
    case 'AVOID_LONGS':
      result = { sizeMultiplier: 1.0, avoidDirection: 'LONG' };
      break;
    case 'STAY_OUT':
      result = { sizeMultiplier: 0, avoidDirection: 'ALL' };
      break;
    default:
      result = { sizeMultiplier: 1.0, avoidDirection: null };
  }
  console.log(`${LOG} getTradingAdjustment: rec=${rec} → size=${result.sizeMultiplier}x avoid=${result.avoidDirection || 'none'}`);
  return result;
}

/**
 * Clear intel cache (call for new day or manual refresh).
 */
function clearIntelCache() {
  _intelCache = null;
  _intelCacheDate = null;
  _intelCacheTime = null;
}

function getEmptyIntel() {
  return {
    market_mood: 'NEUTRAL',
    risk_level: 'MEDIUM',
    risk_reason: null,
    sgx_nifty: null,
    global_cues: null,
    institutional: null,
    sectors: {},
    major_events: [],
    stock_specific: {},
    trading_recommendation: 'NORMAL',
    recommendation_reason: null,
    fetched_at: new Date().toISOString(),
    source: 'empty_fallback'
  };
}

function getISTDateStr() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  return ist.toISOString().split('T')[0];
}

export {
  fetchGlobalMarketIntel,
  getSectorSentimentForStock,
  getStockSpecificNews,
  shouldAvoidTrading,
  getTradingAdjustment,
  clearIntelCache
};
