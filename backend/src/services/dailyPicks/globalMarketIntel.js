/**
 * Global Market Intelligence — Step 5.5 of Daily Picks Pipeline
 *
 * Runs at ~8:40 AM IST (AFTER ChartInk scans + enrichment + scoring + levels)
 * using AI web search to fetch LIVE global events, sector outlook,
 * and market-moving news. Receives viable candidate symbols for stock-specific analysis.
 * Supports historical date override for backtesting.
 *
 * PROVIDER SWITCH: Set INTEL_PROVIDER below to choose between:
 *   'openai'    — GPT-4.1 with web search (cheaper: ~₹55/month)
 *   'claude'    — Claude Sonnet with web search (better quality: ~₹85/month)
 *
 * Why this exists:
 * - streetGainsScraper runs at 8:30 AM — 2 hours AFTER picks are selected
 * - By 8:30 AM, AMO orders are already placed based on stale/no data
 * - This fetches REAL-TIME intelligence at the moment of selection
 *
 * What it fetches:
 * 1. Global events: US Fed, RBI policy, budget, wars, sanctions, etc.
 * 2. Overnight market moves: US markets, Asian markets
 * 2b. SGX Nifty pre-market indication (scraped directly from sgxnifty.org)
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
 * Fail-closed: if web search fails, pipeline stops and sends a notification
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import axios from 'axios';
import ApiUsage from '../../models/apiUsage.js';
import { v4 as uuidv4 } from 'uuid';
import { mapSectorToIntelKey } from '../../utils/sectorMapping.js';

const LOG = '[GLOBAL-INTEL]';

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER SWITCH — Change this to swap between OpenAI and Claude for intel
// ═══════════════════════════════════════════════════════════════════════════════
// 'openai'  → GPT-4.1 + web search ($2/$8 per MTok + $10/1K searches)
// 'claude'  → Claude Sonnet + web search ($3/$15 per MTok + $10/1K searches)
const INTEL_PROVIDER = process.env.INTEL_PROVIDER || 'openai';
const OPENAI_INTEL_MODEL = 'gpt-5.4';

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

let _openai = null;
function getOpenAIClient() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) return null;
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SGX NIFTY SCRAPER — Direct web scrape from sgxnifty.org
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchSGXNiftyData() {
  try {
    console.log(`${LOG} Fetching SGX Nifty data from sgxnifty.org...`);
    const { data: html } = await axios.get('https://sgxnifty.org/', {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    // Extract chartIntradayData JSON from embedded script
    // Use a bracket-counting approach to find the exact end of the JSON array,
    // since the non-greedy regex can fail when the array contains nested objects
    let lastPrice = null;
    let lastTimestamp = null;
    const intradayStart = html.match(/var\s+chartIntradayData\s*=\s*\[/);
    if (intradayStart) {
      const startIdx = intradayStart.index + intradayStart[0].length - 1; // position of '['
      let depth = 0;
      let endIdx = -1;
      for (let i = startIdx; i < html.length; i++) {
        if (html[i] === '[') depth++;
        else if (html[i] === ']') {
          depth--;
          if (depth === 0) { endIdx = i + 1; break; }
        }
      }
      if (endIdx > startIdx) {
        const intradayData = JSON.parse(html.slice(startIdx, endIdx));
        if (intradayData.length > 0) {
          const latest = intradayData[intradayData.length - 1];
          lastPrice = parseFloat(latest.value);
          lastTimestamp = latest.date;
        }
      }
    }

    // Extract quote details from HTML table cells
    // The page uses <td class="main-change ..."> for Last Trade/Change/Change%
    // and <td class="main-sub"> for High/Low/Open
    const changeValues = [];
    const changeCellRegex = /<td\s+class="main-change[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
    let cellMatch;
    while ((cellMatch = changeCellRegex.exec(html)) !== null) {
      changeValues.push(cellMatch[1].replace(/<[^>]*>/g, '').trim());
    }
    const subValues = [];
    const subCellRegex = /<td\s+class="main-sub"[^>]*>([\s\S]*?)<\/td>/g;
    while ((cellMatch = subCellRegex.exec(html)) !== null) {
      subValues.push(cellMatch[1].replace(/<[^>]*>/g, '').trim());
    }

    // changeValues: [0]=Last Trade "24,306.0", [1]=Change "-59.0", [2]=Change% "-0.24%"
    // subValues:    [0]=High "24,472.0", [1]=Low "24,146.5", [2]=Open "24,300.5"
    let change = changeValues[1] ? parseFloat(changeValues[1].replace(/,/g, '')) : null;
    const changePctRaw = changeValues[2] ? changeValues[2].replace(/[^0-9.+-]/g, '') : null;
    let changePctNum = changePctRaw ? parseFloat(changePctRaw) : null;
    const highVal = subValues[0] ? parseFloat(subValues[0].replace(/,/g, '')) : null;
    const lowVal = subValues[1] ? parseFloat(subValues[1].replace(/,/g, '')) : null;
    const openVal = subValues[2] ? parseFloat(subValues[2].replace(/,/g, '')) : null;

    // Fallback: compute change from open + lastPrice if table parsing failed
    if (change === null && lastPrice !== null && openVal !== null && openVal > 0) {
      change = parseFloat((lastPrice - openVal).toFixed(2));
      changePctNum = parseFloat(((change / openVal) * 100).toFixed(2));
      console.log(`${LOG} SGX Change computed from open/last: ${openVal} → ${lastPrice} = ${change >= 0 ? '+' : ''}${change} (${changePctNum >= 0 ? '+' : ''}${changePctNum}%)`);
    }

    // Determine status
    let status = 'FLAT';
    if (changePctNum !== null) {
      if (changePctNum > 0.1) status = 'POSITIVE';
      else if (changePctNum < -0.1) status = 'NEGATIVE';
    } else if (change !== null) {
      if (change > 10) status = 'POSITIVE';
      else if (change < -10) status = 'NEGATIVE';
    }

    const indication = changePctNum !== null
      ? `${changePctNum >= 0 ? '+' : ''}${changePctNum.toFixed(2)}%`
      : (change !== null ? `${change >= 0 ? '+' : ''}${change}` : 'N/A');

    const result = {
      indication,
      status,
      points: change,
      change_pct: changePctNum ?? 0,
      last_price: lastPrice,
      high: highVal,
      low: lowVal,
      open: openVal,
      timestamp: lastTimestamp,
      source: 'sgxnifty.org'
    };

    // Validate that we got meaningful data — price is mandatory
    if (lastPrice === null) {
      throw new Error('Could not extract SGX Nifty price from page — HTML structure may have changed');
    }

    console.log(`${LOG} SGX Nifty scraped: ${result.last_price} (${result.indication}, ${result.status})`);
    return result;
  } catch (err) {
    console.error(`${LOG} ❌ SGX Nifty scrape FAILED: ${err.message}`);
    throw new Error(`SGX Nifty data is critical for trading decisions — scrape failed: ${err.message}`);
  }
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
async function fetchGlobalMarketIntel(dateOverride, candidateSymbols, prefetchedSGXData) {
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

  const provider = INTEL_PROVIDER;
  console.log(`${LOG} Using provider: ${provider.toUpperCase()}`);

  // Use pre-fetched SGX data from Step 1 if available, otherwise fetch fresh
  let sgxData = prefetchedSGXData || null;
  let intel;
  if (sgxData) {
    console.log(`${LOG} Using pre-fetched SGX Nifty data from Step 1 (price: ${sgxData.last_price})`);
    intel = await (provider === 'openai'
      ? fetchIntelViaOpenAI(todayStr, isHistorical, candidateSymbols)
      : fetchIntelViaClaude(todayStr, isHistorical, candidateSymbols));
  } else {
    // Fallback: fetch SGX + AI in parallel (for midday re-check or standalone calls)
    [sgxData, intel] = await Promise.all([
      isHistorical ? Promise.resolve(null) : fetchSGXNiftyData(),
      provider === 'openai'
        ? fetchIntelViaOpenAI(todayStr, isHistorical, candidateSymbols)
        : fetchIntelViaClaude(todayStr, isHistorical, candidateSymbols)
    ]);
  }

  // SGX Nifty is CRITICAL for live trading — pipeline must not proceed without it
  if (!isHistorical && !sgxData) {
    throw new Error('SGX Nifty data is critical — cannot proceed without pre-market indication');
  }
  intel.sgx_nifty = sgxData;

  // Log summary (shared between providers)
  logIntelSummary(intel, todayStr);

  // Cache for today (with TTL tracking)
  _intelCache = intel;
  _intelCacheDate = todayStr;
  _intelCacheTime = Date.now();

  return intel;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER: OpenAI (GPT-4.1 + web_search_preview)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchIntelViaOpenAI(todayStr, isHistorical, candidateSymbols) {
  const startTime = Date.now();
  const requestId = uuidv4().substring(0, 8);

  try {
    const openai = getOpenAIClient();
    if (!openai) {
      throw new Error('OpenAI API key not configured');
    }

    const symbols = candidateSymbols || [];
    const searchPrompt = isHistorical
      ? buildHistoricalIntelPrompt(todayStr, symbols)
      : buildIntelPrompt(todayStr, symbols);

    console.log(`${LOG} Fetching ${isHistorical ? 'HISTORICAL' : 'LIVE'} intel via OpenAI ${OPENAI_INTEL_MODEL} web search for ${todayStr}...`);
    console.log(`${LOG} Search prompt : ${searchPrompt}`);
    // 90-second timeout — web search can take 30-60s normally
    const INTEL_TIMEOUT_MS = 90000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INTEL_TIMEOUT_MS);

    let response;
    try {
      response = await openai.responses.create({
        model: OPENAI_INTEL_MODEL,
        tools: [{ type: 'web_search_preview' }],
        input: searchPrompt,
      }, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    const responseTime = Date.now() - startTime;
    const usage = response.usage || {};

    // Log API usage
    try {
      await ApiUsage.logUsage({
        provider: 'OPENAI',
        model: OPENAI_INTEL_MODEL,
        feature: 'GLOBAL_MARKET_INTEL',
        tokens: {
          input: usage.input_tokens || 0,
          output: usage.output_tokens || 0
        },
        request_id: requestId,
        response_time_ms: responseTime,
        success: true,
        context: { description: `${isHistorical ? 'Historical' : 'Pre-scan'} global market intelligence for ${todayStr} (OpenAI)` }
      });
    } catch { /* non-fatal */ }

    // Extract text from OpenAI response output items
    const outputText = (response.output || [])
      .filter(item => item.type === 'message')
      .flatMap(item => (item.content || []))
      .filter(block => block.type === 'output_text')
      .map(block => block.text)
      .join('\n') || '';

    console.log(`${LOG} OpenAI web search completed (${responseTime}ms, tokens: ${usage.input_tokens || 0}+${usage.output_tokens || 0})`);

    // Parse JSON from response (shared parser)
    const intel = parseIntelResponse(outputText);
    intel.source = `openai_${OPENAI_INTEL_MODEL}`;
    return intel;

  } catch (err) {
    console.error(`${LOG} ❌ OpenAI web search failed:`, err.message);

    try {
      await ApiUsage.logUsage({
        provider: 'OPENAI',
        model: OPENAI_INTEL_MODEL,
        feature: 'GLOBAL_MARKET_INTEL',
        tokens: { input: 0, output: 0 },
        request_id: requestId,
        response_time_ms: Date.now() - startTime,
        success: false,
        context: { error: err.message }
      });
    } catch { /* non-fatal */ }

    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER: Claude (Sonnet + web_search)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchIntelViaClaude(todayStr, isHistorical, candidateSymbols) {
  const startTime = Date.now();
  const requestId = uuidv4().substring(0, 8);

  try {
    const anthropic = getAnthropicClient();
    if (!anthropic) {
      throw new Error('Anthropic API key not configured');
    }

    const symbols = candidateSymbols || [];
    const searchPrompt = isHistorical
      ? buildHistoricalIntelPrompt(todayStr, symbols)
      : buildIntelPrompt(todayStr, symbols);

    console.log(`${LOG} Fetching ${isHistorical ? 'HISTORICAL' : 'LIVE'} intel via Claude Sonnet web search for ${todayStr}...`);

    // 90-second timeout — Claude web search can take 30-60s normally
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
    console.log(`${LOG} Claude web search completed (${responseTime}ms, tokens: ${usage.input_tokens || 0}+${usage.output_tokens || 0})`);

    // Parse JSON from response (shared parser)
    const intel = parseIntelResponse(outputText);
    intel.source = 'claude_websearch';
    return intel;

  } catch (err) {
    console.error(`${LOG} ❌ Claude web search failed:`, err.message);

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

    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED: Log intel summary (used by both providers)
// ═══════════════════════════════════════════════════════════════════════════════

function logIntelSummary(intel, todayStr) {
  console.log(`${LOG} ═══════════════════════════════════════`);
  console.log(`${LOG} GLOBAL MARKET INTELLIGENCE — ${todayStr} (via ${intel.source || 'unknown'})`);
  console.log(`${LOG} ═══════════════════════════════════════`);
  console.log(`${LOG} Market mood: ${intel.market_mood}`);
  console.log(`${LOG} Risk level: ${intel.risk_level}`);

  if (intel.sgx_nifty) {
    const sgx = intel.sgx_nifty;
    console.log(`${LOG} SGX Nifty: ${sgx.last_price || 'N/A'} ${sgx.indication} (${sgx.status})${sgx.source ? ` [${sgx.source}]` : ''}`);
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
}

/**
 * Build a web search prompt for HISTORICAL market intelligence (backtest mode).
 * India-focused, stock-aware — tells us how global events impact these specific Indian stocks.
 */
function buildHistoricalIntelPrompt(dateStr, candidateSymbols) {
  const stockList = candidateSymbols.length > 0
    ? `\n\nCANDIDATE STOCKS FOR THIS DAY (from ChartInk scans):\n${candidateSymbols.join(', ')}\n\nFor stock_specific: search for news/events on ${dateStr} that specifically affect these stocks (earnings, results, SEBI actions, sector-specific events, M&A, management changes). Only include stocks with ACTUAL news.`
    : '';

  return `I run an intraday trading system on the Indian stock market (NSE). I need to reconstruct what global and domestic conditions looked like at 8:40 AM IST on ${dateStr} — a PAST date. This is for backtesting.

Search for news from ${dateStr} and tell me HOW it impacts Indian stocks specifically:

1. **US markets overnight** — how did S&P 500, Nasdaq, Dow close? More importantly: which Indian sectors does this affect? (e.g., Nasdaq rally → Indian IT stocks up, US banking stress → Indian bank stocks affected)
2. **Asian markets** — Nikkei, Hang Seng at the time. Impact on Indian market sentiment.
3. **Dollar/Rupee** — DXY strength/weakness. Strong dollar = FII outflows from India = bearish. Weak dollar = FII inflows = bullish.
4. **Crude oil** — Price direction. High crude = bearish for India (import dependent). Oil up = OMC stocks down, ONGC up.
5. **FII/DII flows** — Were FIIs buying or selling Indian equities in the previous session? This drives next-day sentiment.
6. **Major events** — RBI policy, Union Budget, elections, global crises, tariffs, sanctions that impact Indian markets.
7. **Indian sector outlook** — Based on all the above, which NSE sectors are likely bullish/bearish on ${dateStr}? Be specific about WHY (e.g., "BANKING bearish because RBI kept rates high" not just "BANKING bearish").${stockList}

Return a JSON object:
{
  "market_mood": "BULLISH" | "BEARISH" | "CAUTIOUS" | "NEUTRAL",
  "risk_level": "LOW" | "MEDIUM" | "HIGH" | "EXTREME",
  "risk_reason": "How this specifically affects Indian market trading",
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

NOTE: Do NOT include sgx_nifty in the response — SGX Nifty data is fetched separately.

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

  return `I run an intraday trading system on the Indian stock market (NSE). I need REAL-TIME intelligence for trading decisions at 8:40 AM IST on ${dateStr}.

Search for the LATEST news and tell me HOW it impacts Indian stocks specifically:

1. **US markets overnight** — how did S&P 500, Nasdaq, Dow close? More importantly: which Indian sectors does this affect? (e.g., Nasdaq rally → Indian IT stocks up, US banking stress → Indian bank stocks affected)
2. **Asian markets** — Nikkei, Hang Seng live. Impact on Indian market sentiment.
3. **Dollar/Rupee** — DXY strength/weakness. Strong dollar = FII outflows from India = bearish. Weak dollar = FII inflows = bullish.
4. **Crude oil** — Price direction. High crude = bearish for India (import dependent). Oil up = OMC stocks down, ONGC up.
5. **FII/DII flows** — Were FIIs buying or selling Indian equities in the previous session? This drives today's sentiment.
6. **Major events** — RBI policy, Union Budget, elections, global crises, tariffs, sanctions that impact Indian markets TODAY.
7. **Indian sector outlook** — Based on all the above, which NSE sectors are likely bullish/bearish today? Be specific about WHY (e.g., "BANKING bearish because RBI kept rates high" not just "BANKING bearish").${stockList}

Return a JSON object:
{
  "market_mood": "BULLISH" | "BEARISH" | "CAUTIOUS" | "NEUTRAL",
  "risk_level": "LOW" | "MEDIUM" | "HIGH" | "EXTREME",
  "risk_reason": "How this specifically affects Indian market trading",
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

NOTE: Do NOT include sgx_nifty in the response — SGX Nifty data is fetched separately via direct scraping.

**CRITICAL:** Every sector reason and every recommendation must explain the Indian stock market impact, not just state the global fact. "US Nasdaq up 1%" is useless — "US Nasdaq up 1% → Indian IT stocks (TCS, INFY, WIPRO) likely to gap up" is useful.
Be specific with numbers — don't say "positive", say "+0.5%".
For risk_level: EXTREME = black swan/crisis, HIGH = major event day, MEDIUM = some headwinds, LOW = normal.
trading_recommendation: "STAY_OUT" only for extreme events (budget day, RBI policy day).`;
}

/**
 * Parse the JSON response from Claude web search.
 */
function parseIntelResponse(text) {
  try {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error('Intel response was empty or non-string');
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
    throw new Error(`Failed to parse intel response: ${err.message}`);
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


function getISTDateStr() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  return ist.toISOString().split('T')[0];
}

export {
  fetchGlobalMarketIntel,
  fetchSGXNiftyData,
  getSectorSentimentForStock,
  getStockSpecificNews,
  shouldAvoidTrading,
  getTradingAdjustment,
  clearIntelCache
};
