/**
 * Daily Picks Service — Core Orchestrator
 *
 * Handles: scan → enrich → score → save → notify (8:45 AM)
 *          entry placement (9:15 AM)
 *          fill check + SL/target placement (9:45 AM)
 *          order monitoring every 15 min (10:00 AM - 2:45 PM)
 *
 * Standalone from swing trading. Shared infra: ChartInk, Upstox, Kite orders.
 */

import Anthropic from '@anthropic-ai/sdk';
import { v4 as uuidv4 } from 'uuid';

import { DAILY_SCANS, SCAN_LABELS, SCAN_ORDER_BY_REGIME } from './dailyPicksScans.js';
import { runChartinkScan } from '../chartinkService.js';
import { getDailyAnalysisData } from '../technicalData.service.js';
import { fetchAndCheckRegime } from '../../engine/regime.js';
import DailyPick from '../../models/dailyPick.js';
import MarketSentiment from '../../models/marketSentiment.js';
import ApiUsage from '../../models/apiUsage.js';
import kiteOrderService from '../kiteOrder.service.js';
import { isKiteIntegrationEnabled } from '../kiteTradeIntegration.service.js';
import { firebaseService } from '../firebase/firebase.service.js';
import priceCacheService from '../priceCache.service.js';
import MarketHoursUtil from '../../utils/marketHours.js';
import kiteConfig from '../../config/kite.config.js';
import { getISTMidnight, calculatePnl, updateDailyResults, round2, delay } from './dailyPicksHelpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_DAILY_PICKS = 3;
const CAPITAL_PER_SESSION = 100000;
const TARGET_PCT = 2.0;
const SCAN_DELAY_MS = 2000;
const MIN_SCORE = 60;
const LOG = '[DAILY-PICKS]';

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_OUTPUT_TOKENS = 5000;

let anthropic = null;
function getAnthropicClient() {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR — 8:45 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run daily picks scan, enrich, score, save, and notify.
 * Called at 8:45 AM IST before market open.
 */
async function runDailyPicks(options = {}) {
  const { dryRun = false } = options;
  const startTime = Date.now();

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Starting daily picks scan${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`${LOG} ════════════════════════════════════════`);

  try {
    // Step 1: Market context
    const marketContext = await getMarketContext();
    console.log(`${LOG} Market regime: ${marketContext.regime}`);
    console.log(`${LOG} GIFT Nifty: ${marketContext.gift_nifty_pct}% (${marketContext.gift_nifty_status})`);

    // Step 2: Run scans based on regime
    const scanResult = await runScans(marketContext);
    console.log(`${LOG} Total candidates: ${scanResult.candidates.length} (${scanResult.bullish_count}B / ${scanResult.bearish_count}Be)`);

    if (scanResult.candidates.length === 0) {
      console.log(`${LOG} No candidates found. Saving empty doc and notifying.`);
      const doc = await saveToDB(marketContext, [], scanResult);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 3: Enrich with OHLCV + indicators
    const enriched = await enrichCandidates(scanResult.candidates);
    console.log(`${LOG} Enriched ${enriched.length}/${scanResult.candidates.length} candidates`);

    if (enriched.length === 0) {
      console.log(`${LOG} All candidates failed enrichment. Saving empty doc.`);
      const doc = await saveToDB(marketContext, [], scanResult);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 4: Score and select top picks
    const scored = scoreCandidates(enriched);
    const topPicks = scored.slice(0, MAX_DAILY_PICKS);
    console.log(`${LOG} Scored: ${scored.length} passed min (${MIN_SCORE}), selected top ${topPicks.length}`);

    if (topPicks.length === 0) {
      console.log(`${LOG} No picks above minimum score.`);
      const doc = await saveToDB(marketContext, [], scanResult);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 5: Calculate levels for each pick
    const picksWithLevels = topPicks.map(p => calculateLevels(p));

    // Step 6: Generate AI insights (non-fatal)
    const picksWithInsights = await generatePickInsights(picksWithLevels, marketContext);

    // Step 7: Save to DB
    const doc = await saveToDB(marketContext, picksWithInsights, scanResult);
    console.log(`${LOG} Saved DailyPick doc: ${doc._id}`);

    // Step 8: Send notification
    await sendNotification(marketContext, picksWithInsights, doc);

    const elapsed = Date.now() - startTime;
    console.log(`${LOG} ✅ Complete in ${elapsed}ms — ${picksWithInsights.length} picks saved`);

    return { success: true, picks: picksWithInsights.length, doc };

  } catch (error) {
    console.error(`${LOG} ❌ Fatal error in runDailyPicks:`, error.message);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: MARKET CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════

async function getMarketContext() {
  console.log(`${LOG} [Step 1] Fetching market context...`);

  // Regime from Nifty candles
  let regime = 'UNKNOWN';
  let niftyPrevClose = null;
  try {
    const regimeResult = await fetchAndCheckRegime();
    regime = regimeResult.regime;
    niftyPrevClose = regimeResult.niftyLast;
    console.log(`${LOG} Regime: ${regime} (Nifty: ${niftyPrevClose}, EMA50: ${regimeResult.ema50}, dist: ${regimeResult.distancePct}%)`);
  } catch (err) {
    console.error(`${LOG} Regime check failed, defaulting to UNKNOWN:`, err.message);
  }

  // GIFT Nifty from MarketSentiment
  let giftNiftyPct = null;
  let giftNiftyStatus = null;
  try {
    const sentimentResult = await MarketSentiment.getTodayOrLatest('NIFTY_50');
    const sentiment = sentimentResult?.sentiment;
    if (sentiment?.sgx_nifty) {
      const indication = sentiment.sgx_nifty.indication;
      giftNiftyPct = indication ? parseFloat(indication.replace('%', '')) : null;
      giftNiftyStatus = sentiment.sgx_nifty.status || null;
    }
  } catch (err) {
    console.error(`${LOG} GIFT Nifty fetch failed:`, err.message);
  }

  return {
    regime,
    gift_nifty_pct: giftNiftyPct,
    gift_nifty_status: giftNiftyStatus,
    nifty_prev_close: niftyPrevClose,
    decided_at: new Date()
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: RUN CHARTINK SCANS
// ═══════════════════════════════════════════════════════════════════════════════

async function runScans(marketContext) {
  const { regime } = marketContext;
  const scanOrder = SCAN_ORDER_BY_REGIME[regime] || SCAN_ORDER_BY_REGIME.UNKNOWN;

  console.log(`${LOG} [Step 2] Running ${scanOrder.length} scans for ${regime} regime: ${scanOrder.join(', ')}`);

  const seen = new Set();
  const candidates = [];
  let bullishCount = 0;
  let bearishCount = 0;

  for (const scanName of scanOrder) {
    const scan = DAILY_SCANS[scanName];
    if (!scan) continue;

    try {
      console.log(`${LOG} Running scan: ${scanName} (${scan.type})...`);
      const results = await runChartinkScan(scan.query);
      console.log(`${LOG} ${scanName}: ${results.length} results`);

      for (const stock of results) {
        if (seen.has(stock.nsecode)) continue;
        seen.add(stock.nsecode);

        candidates.push({
          symbol: stock.nsecode,
          stock_name: stock.name,
          scan_type: scanName,
          direction: scan.type === 'bullish' ? 'LONG' : 'SHORT',
          chartink_data: {
            per_change: stock.per_change,
            close: stock.close,
            volume: stock.volume
          }
        });

        if (scan.type === 'bullish') bullishCount++;
        else bearishCount++;
      }

      // Delay between scans to avoid rate-limiting
      if (scanOrder.indexOf(scanName) < scanOrder.length - 1) {
        await delay(SCAN_DELAY_MS);
      }
    } catch (err) {
      console.error(`${LOG} Scan ${scanName} failed:`, err.message);
      // Continue with remaining scans
    }
  }

  return {
    candidates,
    bullish_count: bullishCount,
    bearish_count: bearishCount
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: ENRICH CANDIDATES
// ═══════════════════════════════════════════════════════════════════════════════

async function enrichCandidates(candidates) {
  console.log(`${LOG} [Step 3] Enriching ${candidates.length} candidates via Upstox...`);

  const symbols = candidates.map(c => c.symbol);

  let analysisData;
  try {
    analysisData = await getDailyAnalysisData(symbols);
  } catch (err) {
    console.error(`${LOG} getDailyAnalysisData failed:`, err.message);
    return [];
  }

  const stockMap = {};
  for (const stock of analysisData.stocks) {
    stockMap[stock.symbol] = stock;
  }

  const enriched = [];
  for (const candidate of candidates) {
    const stock = stockMap[candidate.symbol];
    if (!stock || !stock.instrument_key) {
      console.log(`${LOG} Skipping ${candidate.symbol} — no enrichment data`);
      continue;
    }

    // Calculate scan scores
    const high = stock.high || 0;
    const low = stock.low || 0;
    const close = stock.ltp || stock.prev_close || 0;
    const open = stock.open || 0;
    const range = high - low;

    const closeInRangePct = range > 0 ? ((close - low) / range) * 100 : 50;
    const volumeRatio = stock.avg_volume_50d > 0
      ? stock.todays_volume / stock.avg_volume_50d
      : 1;
    const atrPct = close > 0 ? (range / close) * 100 : 0;

    // Candle pattern from latest candle (today or last trading day)
    const prevClose = stock.prev_close || 0;
    const prevHigh = high; // We only have current day from getDailyAnalysisData
    const prevLow = low;
    const candlePattern = detectCandlePattern(open, high, low, close, 0, prevHigh, prevLow, prevClose);

    const lastDailyClose = stock.last_daily_close || close;
    console.log(`${LOG} [Enrich] ${candidate.symbol}: O=${open} H=${high} L=${low} C=${close} prevClose=${prevClose} lastDailyClose=${lastDailyClose} ltp=${stock.ltp} vol=${stock.todays_volume} avgVol50=${stock.avg_volume_50d} rsi=${stock.daily_rsi} latestCandle=${stock.latest_candle_date || 'N/A'} prevCandle=${stock.prev_candle_date || 'N/A'} source=${stock.data_source || 'N/A'}`);

    enriched.push({
      ...candidate,
      instrument_key: stock.instrument_key,
      scan_scores: {
        close_in_range_pct: round2(closeInRangePct),
        volume_ratio: round2(volumeRatio),
        rsi: stock.daily_rsi || 0,
        atr_pct: round2(atrPct),
        candle_pattern: candlePattern
      },
      // Raw data for level calculation
      _ohlcv: {
        open,
        high,
        low,
        close,
        prev_close: prevClose,
        last_daily_close: lastDailyClose,
        volume: stock.todays_volume || 0,
        avg_volume_50d: stock.avg_volume_50d || 0
      }
    });
  }

  return enriched;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: SCORE CANDIDATES
// ═══════════════════════════════════════════════════════════════════════════════

function scoreCandidates(enrichedCandidates) {
  console.log(`${LOG} [Step 4] Scoring ${enrichedCandidates.length} candidates...`);

  const scored = [];

  for (const c of enrichedCandidates) {
    const s = c.scan_scores;
    let score = 0;

    // Close in range (25 pts) — higher = closed near high (bullish) / near low (bearish)
    const cir = c.direction === 'LONG' ? s.close_in_range_pct : (100 - s.close_in_range_pct);
    if (cir > 90) score += 25;
    else if (cir > 80) score += 20;
    else if (cir > 70) score += 15;
    else if (cir > 60) score += 10;
    else score += 5;

    // Volume ratio (25 pts)
    if (s.volume_ratio > 3) score += 25;
    else if (s.volume_ratio > 2) score += 20;
    else if (s.volume_ratio > 1.5) score += 15;
    else if (s.volume_ratio > 1.2) score += 10;
    else score += 5;

    // RSI positioning (20 pts)
    if (c.direction === 'LONG') {
      if (s.rsi >= 55 && s.rsi <= 65) score += 20;
      else if (s.rsi > 65 && s.rsi <= 72) score += 15;
      else if (s.rsi >= 50 && s.rsi < 55) score += 10;
      else score += 5;
    } else {
      // Bearish — mirror RSI logic
      if (s.rsi >= 35 && s.rsi <= 45) score += 20;
      else if (s.rsi >= 28 && s.rsi < 35) score += 15;
      else if (s.rsi > 45 && s.rsi <= 50) score += 10;
      else score += 5;
    }

    // ATR tradability (15 pts)
    if (s.atr_pct > 2.5) score += 15;
    else if (s.atr_pct > 2.0) score += 10;
    else if (s.atr_pct > 1.5) score += 5;
    // else 0

    // Candle confirmation (15 pts)
    if (s.candle_pattern?.includes('engulfing')) score += 15;
    else if (s.candle_pattern === 'hammer') score += 12;
    else if (s.candle_pattern === 'bullish_candle' || s.candle_pattern === 'bearish_candle') score += 10;
    else score += 5;

    if (score >= MIN_SCORE) {
      scored.push({ ...c, rank_score: score });
      console.log(`${LOG} ✅ ${c.symbol}: score=${score} (CIR:${round2(cir)} Vol:${s.volume_ratio}x RSI:${s.rsi} ATR:${s.atr_pct}% ${s.candle_pattern})`);
    } else {
      console.log(`${LOG} ❌ ${c.symbol}: score=${score} < ${MIN_SCORE} — filtered out`);
    }
  }

  // Sort descending by score
  scored.sort((a, b) => b.rank_score - a.rank_score);
  return scored;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: CALCULATE LEVELS
// ═══════════════════════════════════════════════════════════════════════════════

function calculateLevels(pick) {
  const { _ohlcv, direction } = pick;
  // Use last completed daily candle close for entry (not prev_close which is 2 days ago)
  const lastClose = _ohlcv.last_daily_close || _ohlcv.close;

  console.log(`${LOG} [Levels] ${pick.symbol}: direction=${direction} OHLCV={O:${_ohlcv.open} H:${_ohlcv.high} L:${_ohlcv.low} C:${_ohlcv.close} prevClose:${_ohlcv.prev_close} lastDailyClose:${_ohlcv.last_daily_close}} → entry will be lastDailyClose=${lastClose}`);

  let entry, stop, target;

  if (direction === 'LONG') {
    entry = lastClose;                    // Last trading day's close (open estimate)
    stop = _ohlcv.low;                    // Previous day's low
    target = round2(entry * (1 + TARGET_PCT / 100));
  } else {
    entry = lastClose;                    // Last trading day's close (open estimate)
    stop = _ohlcv.high;                   // Previous day's high
    target = round2(entry * (1 - TARGET_PCT / 100));
  }

  console.log(`${LOG} [Levels] ${pick.symbol}: entry=${round2(entry)} stop=${round2(stop)} target=${round2(target)}`);

  const riskPct = direction === 'LONG'
    ? round2(((entry - stop) / entry) * 100)
    : round2(((stop - entry) / entry) * 100);

  const rewardPct = TARGET_PCT;
  const riskReward = riskPct > 0 ? round2(rewardPct / riskPct) : 0;

  return {
    ...pick,
    levels: {
      entry: round2(entry),
      stop: round2(stop),
      target: round2(target),
      risk_pct: riskPct,
      reward_pct: rewardPct,
      risk_reward: riskReward
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 6: AI INSIGHTS (NON-FATAL)
// ═══════════════════════════════════════════════════════════════════════════════

async function generatePickInsights(picks, marketContext) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`${LOG} [Step 6] No ANTHROPIC_API_KEY — skipping AI insights`);
    return picks.map(p => ({ ...p, ai_insight: null, ai_generated: false }));
  }

  console.log(`${LOG} [Step 6] Generating AI insights for ${picks.length} picks...`);
  const requestId = uuidv4();
  const startTime = Date.now();

  try {
    const client = getAnthropicClient();

    const picksData = picks.map((p, i) => ({
      rank: i + 1,
      symbol: p.symbol,
      direction: p.direction,
      scan_type: SCAN_LABELS[p.scan_type] || p.scan_type,
      score: p.rank_score,
      ohlcv: {
        open: p._ohlcv.open,
        high: p._ohlcv.high,
        low: p._ohlcv.low,
        close: p._ohlcv.close,
        prev_close: p._ohlcv.prev_close,
        volume_ratio: p.scan_scores.volume_ratio
      },
      rsi: p.scan_scores.rsi,
      candle: p.scan_scores.candle_pattern,
      levels: p.levels
    }));

    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      system: `You are an ultra-brief Indian equity technical analyst. For each stock, write exactly 1-2 sentences explaining WHY this is a good intraday trade candidate based on the technical data. Focus on the setup (candle pattern, volume confirmation, key levels). Be specific with numbers. Respond in JSON: { "insights": [{ "symbol": "...", "insight": "..." }] }`,
      messages: [{
        role: 'user',
        content: `Market regime: ${marketContext.regime}. GIFT Nifty: ${marketContext.gift_nifty_pct || 'N/A'}%.

Today's picks:
${JSON.stringify(picksData, null, 2)}

Generate 1-2 sentence insights for each pick.`
      }]
    });

    const responseTime = Date.now() - startTime;
    const text = response.content?.[0]?.text || '';

    // Parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const insightMap = {};
      for (const item of (parsed.insights || [])) {
        insightMap[item.symbol] = item.insight;
      }

      // Log API usage
      await logApiUsage(requestId, response, responseTime, true, picks.map(p => p.symbol).join(','));

      console.log(`${LOG} AI insights generated in ${responseTime}ms`);

      return picks.map(p => ({
        ...p,
        ai_insight: insightMap[p.symbol] || null,
        ai_generated: !!insightMap[p.symbol]
      }));
    }

    console.log(`${LOG} AI response not parseable as JSON — skipping insights`);
    await logApiUsage(requestId, response, responseTime, true, 'parse_failed');
    return picks.map(p => ({ ...p, ai_insight: null, ai_generated: false }));

  } catch (err) {
    console.error(`${LOG} AI insight generation failed (non-fatal):`, err.message);
    await logApiUsage(requestId, null, Date.now() - startTime, false, err.message).catch(() => {});
    return picks.map(p => ({ ...p, ai_insight: null, ai_generated: false }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 7: SAVE TO DB
// ═══════════════════════════════════════════════════════════════════════════════

async function saveToDB(marketContext, picks, scanResult) {
  const today = getISTMidnight();

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const pickDocs = picks.map(p => ({
    symbol: p.symbol,
    instrument_key: p.instrument_key,
    stock_name: p.stock_name,
    scan_type: p.scan_type,
    direction: p.direction,
    scan_scores: p.scan_scores,
    rank_score: p.rank_score,
    levels: p.levels,
    trade: { status: 'PENDING' },
    kite: { kite_status: 'pending' },
    ai_insight: p.ai_insight || null,
    ai_generated: p.ai_generated || false
  }));

  // Upsert: one document per trading day
  const doc = await DailyPick.findOneAndUpdate(
    { trading_date: today },
    {
      $set: {
        trading_date: today,
        scan_date: yesterday,
        market_context: marketContext,
        picks: pickDocs,
        summary: {
          total_candidates: scanResult.candidates?.length || 0,
          bullish_count: scanResult.bullish_count || 0,
          bearish_count: scanResult.bearish_count || 0,
          selected_count: picks.length
        }
      }
    },
    { upsert: true, new: true }
  );

  return doc;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 8: SEND NOTIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

async function sendNotification(marketContext, picks, doc) {
  const adminUserId = kiteConfig.ADMIN_USER_ID;
  if (!adminUserId) {
    console.log(`${LOG} [Step 8] No ADMIN_USER_ID — skipping notification`);
    return;
  }

  let title, body;

  if (picks.length > 0) {
    const pickSummary = picks
      .map(p => `${p.symbol} ₹${p.levels.entry}`)
      .join(', ');
    title = `Daily Picks: ${picks[0].direction === 'LONG' ? 'BUY' : 'SELL'} ${picks.length} stocks`;
    body = pickSummary;
  } else if (marketContext.regime === 'BEARISH') {
    title = 'Daily Picks: No setups';
    body = 'Market weak today. No daily picks. Protect capital.';
  } else {
    title = 'Daily Picks: No setups';
    body = 'No quality setups found today. Sitting out.';
  }

  try {
    await firebaseService.sendToUser(adminUserId, title, body, {
      type: 'DAILY_PICKS',
      route: '/daily-picks'
    });

    // Update notification in doc
    await DailyPick.findByIdAndUpdate(doc._id, {
      $set: {
        'summary.notification_sent': true,
        'summary.notification_body': body
      }
    });

    console.log(`${LOG} Notification sent: ${title}`);
  } catch (err) {
    console.error(`${LOG} Notification failed:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY PLACEMENT — 9:15 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Place MIS LIMIT BUY orders for today's picks.
 * Called at 9:15 AM (market open).
 */
async function placeEntryOrders(options = {}) {
  const { dryRun = false } = options;

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Placing entry orders${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG} Kite not enabled — skipping order placement`);
    return { success: true, message: 'Kite not enabled', orders: 0 };
  }

  const doc = await DailyPick.findToday();
  if (!doc) {
    console.log(`${LOG} No DailyPick doc for today — nothing to place`);
    return { success: true, message: 'No picks today', orders: 0 };
  }

  const pendingPicks = doc.picks.filter(p => p.trade.status === 'PENDING');
  if (pendingPicks.length === 0) {
    console.log(`${LOG} No PENDING picks — skipping`);
    return { success: true, message: 'No pending picks', orders: 0 };
  }

  const capitalPerPick = Math.floor(CAPITAL_PER_SESSION / pendingPicks.length);
  let ordersPlaced = 0;

  for (const pick of pendingPicks) {
    const qty = Math.floor(capitalPerPick / pick.levels.entry);
    if (qty <= 0) {
      console.log(`${LOG} ${pick.symbol}: qty=0 (price ₹${pick.levels.entry} > capital ₹${capitalPerPick}) — skipping`);
      pick.trade.status = 'SKIPPED';
      pick.kite.kite_status = 'failed';
      continue;
    }

    console.log(`${LOG} ${pick.symbol}: Placing MIS LIMIT ${pick.direction === 'LONG' ? 'BUY' : 'SELL'} — qty=${qty} @ ₹${pick.levels.entry}`);

    if (dryRun) {
      console.log(`${LOG} [DRY RUN] Would place order for ${pick.symbol}`);
      continue;
    }

    try {
      const result = await kiteOrderService.placeOrder({
        tradingsymbol: pick.symbol,
        exchange: 'NSE',
        transaction_type: pick.direction === 'LONG' ? 'BUY' : 'SELL',
        order_type: 'LIMIT',
        product: 'MIS',
        quantity: qty,
        price: pick.levels.entry,
        simulation_id: `daily_pick_${pick.symbol}`,
        orderType: 'ENTRY',
        source: 'DAILY_PICKS'
      });

      if (result.success && result.orderId) {
        pick.trade.status = 'ORDER_PLACED';
        pick.trade.qty = qty;
        pick.kite.entry_order_id = result.orderId;
        pick.kite.kite_status = 'order_placed';
        ordersPlaced++;
        console.log(`${LOG} ✅ ${pick.symbol}: Entry order placed — orderId=${result.orderId}`);
      } else {
        pick.trade.status = 'FAILED';
        pick.kite.kite_status = 'failed';
        console.error(`${LOG} ❌ ${pick.symbol}: Order placement failed — ${JSON.stringify(result)}`);
      }
    } catch (err) {
      pick.trade.status = 'FAILED';
      pick.kite.kite_status = 'failed';
      console.error(`${LOG} ❌ ${pick.symbol}: Order error —`, err.message);
    }
  }

  await doc.save();
  console.log(`${LOG} Entry orders: ${ordersPlaced}/${pendingPicks.length} placed`);

  return { success: true, orders: ordersPlaced };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILL CHECK + SL + TARGET — 9:45 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if entry orders filled, place SL-M stop + LIMIT SELL target.
 * Cancel unfilled entries. Called at 9:45 AM.
 */
async function checkFillsAndPlaceProtection(options = {}) {
  const { dryRun = false } = options;

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Checking fills + placing protection${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG} Kite not enabled — skipping`);
    return { success: true, message: 'Kite not enabled' };
  }

  const doc = await DailyPick.findToday();
  if (!doc) return { success: true, message: 'No picks today' };

  const orderPlacedPicks = doc.picks.filter(p => p.trade.status === 'ORDER_PLACED');
  if (orderPlacedPicks.length === 0) {
    console.log(`${LOG} No ORDER_PLACED picks — skipping`);
    return { success: true, message: 'No orders to check' };
  }

  let filled = 0, skipped = 0;

  for (const pick of orderPlacedPicks) {
    try {
      const order = await kiteOrderService.getOrderDetails(pick.kite.entry_order_id);

      if (!order) {
        console.log(`${LOG} ${pick.symbol}: Order not found — marking SKIPPED`);
        pick.trade.status = 'SKIPPED';
        pick.kite.kite_status = 'failed';
        skipped++;
        continue;
      }

      const status = order.status?.toUpperCase();

      if (status === 'COMPLETE') {
        // Entry filled
        const entryPrice = order.average_price || pick.levels.entry;
        pick.trade.status = 'ENTERED';
        pick.trade.entry_price = entryPrice;
        pick.trade.entry_time = new Date();

        // Recalculate target from actual fill
        const target = pick.direction === 'LONG'
          ? round2(entryPrice * (1 + TARGET_PCT / 100))
          : round2(entryPrice * (1 - TARGET_PCT / 100));
        pick.levels.target = target;

        console.log(`${LOG} ✅ ${pick.symbol}: Filled @ ₹${entryPrice} — placing SL + Target`);

        if (!dryRun) {
          let slPlaced = false;
          let tgtPlaced = false;

          // Place SL-M stop order
          try {
            const slResult = await kiteOrderService.placeOrder({
              tradingsymbol: pick.symbol,
              exchange: 'NSE',
              transaction_type: pick.direction === 'LONG' ? 'SELL' : 'BUY',
              order_type: 'SL-M',
              trigger_price: pick.levels.stop,
              product: 'MIS',
              quantity: pick.trade.qty,
              simulation_id: `daily_pick_sl_${pick.symbol}`,
              orderType: 'STOP_LOSS',
              source: 'DAILY_PICKS'
            });
            if (slResult.success) {
              pick.kite.stop_order_id = slResult.orderId;
              slPlaced = true;
              console.log(`${LOG} ${pick.symbol}: SL-M placed @ ₹${pick.levels.stop} — orderId=${slResult.orderId}`);
            }
          } catch (err) {
            console.error(`${LOG} ${pick.symbol}: SL-M error:`, err.message);
          }

          // Place LIMIT SELL target order
          try {
            const tgtResult = await kiteOrderService.placeOrder({
              tradingsymbol: pick.symbol,
              exchange: 'NSE',
              transaction_type: pick.direction === 'LONG' ? 'SELL' : 'BUY',
              order_type: 'LIMIT',
              price: target,
              product: 'MIS',
              quantity: pick.trade.qty,
              simulation_id: `daily_pick_tgt_${pick.symbol}`,
              orderType: 'TARGET',
              source: 'DAILY_PICKS'
            });
            if (tgtResult.success) {
              pick.kite.target_order_id = tgtResult.orderId;
              tgtPlaced = true;
              console.log(`${LOG} ${pick.symbol}: Target LIMIT placed @ ₹${target} — orderId=${tgtResult.orderId}`);
            }
          } catch (err) {
            console.error(`${LOG} ${pick.symbol}: Target error:`, err.message);
          }

          if (slPlaced && tgtPlaced) {
            pick.kite.kite_status = 'sl_target_placed';
          } else if (!slPlaced) {
            // CRITICAL: No stop-loss — market-exit immediately for safety
            console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} SL-M failed — market-exiting position for safety`);
            try {
              await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
                'CRITICAL: SL Failed — Emergency Exit',
                `${pick.symbol} SL-M placement failed. Emergency market exit attempted.`,
                { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
              );
            } catch (notifErr) { /* ignore */ }

            try {
              // Cancel the target order if it was placed
              if (tgtPlaced && pick.kite.target_order_id) {
                await kiteOrderService.cancelOrder(pick.kite.target_order_id);
              }
              // Market-exit the position
              const exitResult = await kiteOrderService.placeOrder({
                tradingsymbol: pick.symbol,
                exchange: 'NSE',
                transaction_type: pick.direction === 'LONG' ? 'SELL' : 'BUY',
                order_type: 'MARKET',
                product: 'MIS',
                quantity: pick.trade.qty,
                simulation_id: `daily_pick_emergency_exit_${pick.symbol}`,
                orderType: 'EMERGENCY_EXIT',
                source: 'DAILY_PICKS'
              });
              if (exitResult.success) {
                console.log(`${LOG} ${pick.symbol}: Emergency market exit placed — orderId=${exitResult.orderId}`);
                await delay(3000);
                try {
                  const exitOrder = await kiteOrderService.getOrderDetails(exitResult.orderId);
                  pick.trade.exit_price = exitOrder?.average_price || pick.trade.entry_price;
                  pick.trade.exit_price_source = exitOrder?.average_price ? 'order_fill' : 'ltp_approximate';
                } catch (_) {
                  pick.trade.exit_price = pick.trade.entry_price;
                  pick.trade.exit_price_source = 'ltp_approximate';
                }
              } else {
                pick.trade.exit_price = pick.trade.entry_price;
                pick.trade.exit_price_source = 'ltp_approximate';
              }
            } catch (exitErr) {
              console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} emergency exit also failed:`, exitErr.message);
              pick.trade.exit_price = pick.trade.entry_price;
              pick.trade.exit_price_source = 'ltp_approximate';
            }
            pick.trade.status = 'STOPPED_OUT';
            pick.trade.exit_time = new Date();
            pick.trade.exit_reason = 'sl_placement_failed_emergency_exit';
            calculatePnl(pick);
            pick.kite.kite_status = 'completed';
          } else {
            // Target failed but SL is in place — acceptable, will exit at stop or 3 PM
            console.error(`${LOG} ⚠️ ${pick.symbol}: Target placement failed — SL active, will rely on stop or 3 PM exit`);
            pick.kite.kite_status = 'sl_target_placed'; // SL is the critical one
          }
        }

        filled++;

      } else if (status === 'CANCELLED' || status === 'REJECTED') {
        pick.trade.status = 'SKIPPED';
        pick.kite.kite_status = 'failed';
        skipped++;
        console.log(`${LOG} ${pick.symbol}: Entry ${status} — marking SKIPPED`);

      } else {
        // Still OPEN — not filled by 9:45 AM, cancel it
        console.log(`${LOG} ${pick.symbol}: Entry not filled (status=${status}) — cancelling`);
        if (!dryRun) {
          try {
            await kiteOrderService.cancelOrder(pick.kite.entry_order_id);
          } catch (err) {
            console.error(`${LOG} ${pick.symbol}: Cancel failed:`, err.message);
          }
        }
        pick.trade.status = 'SKIPPED';
        pick.kite.kite_status = 'failed';
        skipped++;
      }
    } catch (err) {
      console.error(`${LOG} ${pick.symbol}: Fill check error —`, err.message);
      pick.trade.status = 'SKIPPED';
      pick.kite.kite_status = 'failed';
      skipped++;
    }
  }

  await doc.save();
  console.log(`${LOG} Fill check: ${filled} filled, ${skipped} skipped`);

  return { success: true, filled, skipped };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER MONITORING — Every 15 min (10:00 AM - 2:45 PM)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Monitor entered picks for stop/target fills.
 * When one fills, cancel the counterpart order.
 */
async function monitorDailyPickOrders(options = {}) {
  const { dryRun = false } = options;

  console.log(`${LOG} Monitoring daily pick orders${dryRun ? ' [DRY RUN]' : ''}...`);

  if (!isKiteIntegrationEnabled()) return { success: true, message: 'Kite not enabled' };

  const doc = await DailyPick.findToday();
  if (!doc) return { success: true, message: 'No picks today' };

  const enteredPicks = doc.picks.filter(p => p.trade.status === 'ENTERED');
  if (enteredPicks.length === 0) {
    console.log(`${LOG} No ENTERED picks to monitor`);
    return { success: true, message: 'No active positions' };
  }

  let statusChanged = false;

  for (const pick of enteredPicks) {
    if (!pick.kite.stop_order_id && !pick.kite.target_order_id) {
      console.log(`${LOG} ${pick.symbol}: No protective orders — will be handled by 3 PM exit`);
      continue;
    }

    try {
      const [stopOrder, targetOrder] = await Promise.all([
        pick.kite.stop_order_id ? kiteOrderService.getOrderDetails(pick.kite.stop_order_id) : null,
        pick.kite.target_order_id ? kiteOrderService.getOrderDetails(pick.kite.target_order_id) : null
      ]);

      const stopStatus = stopOrder?.status?.toUpperCase();
      const targetStatus = targetOrder?.status?.toUpperCase();

      if (stopStatus === 'COMPLETE' && targetStatus === 'COMPLETE') {
        // Both filled — race condition: position is over-sold, place corrective order
        console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} — BOTH stop and target filled (over-sold)!`);

        // Place corrective order to neutralize the extra position
        // If LONG: entry BUY X, stop SELL X, target SELL X → net SHORT X → need BUY X
        // If SHORT: entry SELL X, stop BUY X, target BUY X → net LONG X → need SELL X
        const correctiveSide = pick.direction === 'LONG' ? 'BUY' : 'SELL';
        if (!dryRun) {
          try {
            const correctiveResult = await kiteOrderService.placeOrder({
              tradingsymbol: pick.symbol,
              exchange: 'NSE',
              transaction_type: correctiveSide,
              order_type: 'MARKET',
              product: 'MIS',
              quantity: pick.trade.qty,
              simulation_id: `daily_pick_corrective_${pick.symbol}`,
              orderType: 'CORRECTIVE',
              source: 'DAILY_PICKS'
            });
            if (correctiveResult.success) {
              console.log(`${LOG} ✅ ${pick.symbol}: Corrective ${correctiveSide} placed — orderId=${correctiveResult.orderId}`);
            } else {
              console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} corrective order FAILED — manual fix needed!`);
            }
          } catch (corrErr) {
            console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} corrective order error:`, corrErr.message);
          }

          // Send admin alert
          try {
            await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
              'CRITICAL: Both SL+Target Filled',
              `${pick.symbol}: Both stop and target filled (over-sold). Corrective ${correctiveSide} order placed. Verify position.`,
              { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
            );
          } catch (_) { /* ignore */ }
        }

        pick.trade.status = 'STOPPED_OUT';
        pick.trade.exit_price = stopOrder.average_price;
        pick.trade.exit_time = new Date();
        pick.trade.exit_reason = 'stop_hit_race_condition';
        pick.trade.exit_price_source = 'order_fill';
        calculatePnl(pick);
        pick.kite.kite_status = 'completed';
        statusChanged = true;

      } else if (stopStatus === 'COMPLETE') {
        // Stop hit — cancel target
        console.log(`${LOG} ${pick.symbol}: STOP HIT @ ₹${stopOrder.average_price}`);
        if (!dryRun && pick.kite.target_order_id) {
          try { await kiteOrderService.cancelOrder(pick.kite.target_order_id); }
          catch (e) { console.error(`${LOG} ${pick.symbol}: Cancel target failed:`, e.message); }
        }
        pick.trade.status = 'STOPPED_OUT';
        pick.trade.exit_price = stopOrder.average_price;
        pick.trade.exit_time = new Date();
        pick.trade.exit_reason = 'stop_hit';
        pick.trade.exit_price_source = 'order_fill';
        calculatePnl(pick);
        pick.kite.kite_status = 'completed';
        statusChanged = true;
        console.log(`${LOG} ${pick.symbol}: Stopped out — PnL: ₹${pick.trade.pnl} (${pick.trade.return_pct}%)`);

      } else if (targetStatus === 'COMPLETE') {
        // Target hit — cancel stop
        console.log(`${LOG} ${pick.symbol}: TARGET HIT @ ₹${targetOrder.average_price}`);
        if (!dryRun && pick.kite.stop_order_id) {
          try { await kiteOrderService.cancelOrder(pick.kite.stop_order_id); }
          catch (e) { console.error(`${LOG} ${pick.symbol}: Cancel stop failed:`, e.message); }
        }
        pick.trade.status = 'TARGET_HIT';
        pick.trade.exit_price = targetOrder.average_price;
        pick.trade.exit_time = new Date();
        pick.trade.exit_reason = 'target_hit';
        pick.trade.exit_price_source = 'order_fill';
        calculatePnl(pick);
        pick.kite.kite_status = 'completed';
        statusChanged = true;
        console.log(`${LOG} ${pick.symbol}: Target hit — PnL: ₹${pick.trade.pnl} (${pick.trade.return_pct}%)`);

      } else {
        console.log(`${LOG} ${pick.symbol}: Both orders open (SL:${stopStatus}, TGT:${targetStatus}) — continuing to monitor`);
      }
    } catch (err) {
      console.error(`${LOG} ${pick.symbol}: Monitor error —`, err.message);
    }
  }

  if (statusChanged) {
    updateDailyResults(doc);
    try {
      await doc.save();
      console.log(`${LOG} Updated results after status changes`);
    } catch (saveErr) {
      console.error(`${LOG} ⚠️ CRITICAL: Failed to save trade state changes:`, saveErr.message);
      try {
        await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
          'CRITICAL: Trade State Save Failed',
          `Monitor detected status changes but doc.save() failed. Trade state may be inconsistent.`,
          { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
        );
      } catch (_) { /* ignore */ }
    }
  }

  return { success: true, active: enteredPicks.filter(p => p.trade.status === 'ENTERED').length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect candle pattern from OHLC data
 */
function detectCandlePattern(open, high, low, close, prevOpen, prevHigh, prevLow, prevClose) {
  if (!open || !close || !high || !low) return 'unknown';

  const body = Math.abs(close - open);
  const upperShadow = high - Math.max(open, close);
  const lowerShadow = Math.min(open, close) - low;

  // Bullish engulfing
  if (prevClose && prevOpen && close > open && close > prevHigh && open < prevLow) {
    return 'bullish_engulfing';
  }

  // Bearish engulfing
  if (prevClose && prevOpen && close < open && close < prevLow && open > prevHigh) {
    return 'bearish_engulfing';
  }

  // Hammer (bullish reversal)
  if (body > 0 && lowerShadow > 2 * body && upperShadow < body * 0.3) {
    return 'hammer';
  }

  // Simple candle direction
  if (close > open) return 'bullish_candle';
  if (close < open) return 'bearish_candle';

  return 'doji';
}

/**
 * Log API usage for Anthropic calls
 */
async function logApiUsage(requestId, response, responseTime, success, context) {
  try {
    await ApiUsage.logUsage({
      provider: 'ANTHROPIC',
      model: CLAUDE_MODEL,
      feature: 'DAILY_PICKS_INSIGHT',
      tokens: {
        input: response?.usage?.input_tokens || 0,
        output: response?.usage?.output_tokens || 0
      },
      request_id: requestId,
      response_time_ms: responseTime,
      success,
      error_message: success ? undefined : context,
      context: {
        description: `Daily pick insights`,
        source: 'daily_picks'
      }
    });
  } catch (err) {
    console.error(`${LOG} ApiUsage log failed:`, err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export {
  runDailyPicks,
  placeEntryOrders,
  checkFillsAndPlaceProtection,
  monitorDailyPickOrders,
  getMarketContext,
  detectCandlePattern
};

export default {
  runDailyPicks,
  placeEntryOrders,
  checkFillsAndPlaceProtection,
  monitorDailyPickOrders,
  getMarketContext,
  detectCandlePattern
};
