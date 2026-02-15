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

import { DAILY_SCANS, SCAN_LABELS, SCAN_ORDER_BY_REGIME, SCAN_ARCHETYPE } from './dailyPicksScans.js';
import { runChartinkScan } from '../chartinkService.js';
import { getDailyAnalysisData } from '../technicalData.service.js';
import { fetchAndCheckRegime } from '../../engine/regime.js';
import DailyPick from '../../models/dailyPick.js';
import MarketSentiment from '../../models/marketSentiment.js';
import ApiUsage from '../../models/apiUsage.js';
import kiteOrderService from '../kiteOrder.service.js';
import kiteOrderEvents from '../kiteOrderEvents.js';
import { isKiteIntegrationEnabled } from '../kiteTradeIntegration.service.js';
import { firebaseService } from '../firebase/firebase.service.js';
import priceCacheService from '../priceCache.service.js';
import MarketHoursUtil from '../../utils/marketHours.js';
import kiteConfig from '../../config/kite.config.js';
import { getISTMidnight, calculatePnl, updateDailyResults, round2, delay } from './dailyPicksHelpers.js';
import { collectOpeningRange, validatePicks } from './orbValidationService.js';
import scanLevels from '../../engine/scanLevels.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_DAILY_PICKS = 3;
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

    // Step 4: Score candidates (sorted by score descending, filtered by MIN_SCORE)
    const scored = scoreCandidates(enriched);
    console.log(`${LOG} Scored: ${scored.length} candidates passed min (${MIN_SCORE})`);

    if (scored.length === 0) {
      console.log(`${LOG} No picks above minimum score.`);
      const doc = await saveToDB(marketContext, [], scanResult);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 5: Evaluate ALL scored candidates through the levels engine,
    // then select top MAX_DAILY_PICKS with scan-type diversity.
    console.log(`${LOG} [Step 5] Evaluating all ${scored.length} scored candidates through levels engine...`);
    const allViable = [];
    let rejectedCount = 0;
    const rejectionReasons = {};
    for (let i = 0; i < scored.length; i++) {
      const candidate = scored[i];
      console.log(`${LOG} [Step 5] --- Candidate ${i + 1}/${scored.length}: ${candidate.symbol} (${candidate.scan_type}, score=${candidate.rank_score}) ---`);
      const withLevels = calculateLevels(candidate);
      if (withLevels) {
        allViable.push(withLevels);
        console.log(`${LOG} [Step 5] ${candidate.symbol}: VIABLE (${allViable.length} viable so far)`);
      } else {
        rejectedCount++;
        const scanType = candidate.scan_type;
        rejectionReasons[scanType] = (rejectionReasons[scanType] || 0) + 1;
        console.log(`${LOG} [Step 5] ${candidate.symbol}: REJECTED (${rejectedCount} rejected so far)`);
      }
    }
    console.log(`${LOG} [Step 5] Engine results: ${allViable.length} viable, ${rejectedCount} rejected out of ${scored.length} scored`);
    if (rejectedCount > 0) {
      console.log(`${LOG} [Step 5] Rejections by scan type: ${Object.entries(rejectionReasons).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    if (allViable.length > 0) {
      console.log(`${LOG} [Step 5] Viable candidates: ${allViable.map(v => `${v.symbol}(${v.scan_type}:${v.rank_score})`).join(', ')}`);
    }

    // Select top picks with scan-type diversity:
    // Pick the best from each scan type first, then fill remaining slots by score.
    const picksWithLevels = selectDiversePicks(allViable, MAX_DAILY_PICKS);
    console.log(`${LOG} Selected ${picksWithLevels.length} picks (diversity-weighted) from ${allViable.length} viable`);

    if (picksWithLevels.length === 0) {
      console.log(`${LOG} All ${scored.length} candidates rejected by engine (no viable R:R). Saving empty doc.`);
      const doc = await saveToDB(marketContext, [], scanResult);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 6: Generate AI insights (non-fatal)
    console.log(`${LOG} [Step 6] Generating AI insights for ${picksWithLevels.length} picks: ${picksWithLevels.map(p => p.symbol).join(', ')}`);
    const picksWithInsights = await generatePickInsights(picksWithLevels, marketContext);
    console.log(`${LOG} [Step 6] AI insights done: ${picksWithInsights.filter(p => p.ai_generated).length}/${picksWithInsights.length} generated`);

    // Step 7: Save to DB
    console.log(`${LOG} [Step 7] Saving to DB: ${picksWithInsights.length} picks`);
    const doc = await saveToDB(marketContext, picksWithInsights, scanResult);
    console.log(`${LOG} [Step 7] Saved DailyPick doc: ${doc._id}`);

    // Step 8: Send notification
    console.log(`${LOG} [Step 8] Sending notification...`);
    await sendNotification(marketContext, picksWithInsights, doc);

    const elapsed = Date.now() - startTime;
    console.log(`${LOG} ════════════════════════════════════════`);
    console.log(`${LOG} ✅ PIPELINE COMPLETE in ${elapsed}ms`);
    console.log(`${LOG} Pipeline summary: ${scanResult.candidates.length} scanned → ${enriched.length} enriched → ${scored.length} scored → ${allViable.length} viable → ${picksWithInsights.length} final picks`);
    for (const p of picksWithInsights) {
      console.log(`${LOG} FINAL PICK: ${p.symbol} | ${p.scan_type} | ${p.direction} | score=${p.rank_score} | entry=₹${p.levels.entry} stop=₹${p.levels.stop} target=₹${p.levels.target} R:R=${p.levels.risk_reward}`);
    }
    console.log(`${LOG} ════════════════════════════════════════`);

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

      let addedFromScan = 0;
      let dupsFromScan = 0;
      for (const stock of results) {
        if (seen.has(stock.nsecode)) {
          dupsFromScan++;
          continue;
        }
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

        addedFromScan++;
        if (scan.type === 'bullish') bullishCount++;
        else bearishCount++;
      }
      console.log(`${LOG} ${scanName}: ${addedFromScan} added, ${dupsFromScan} dupes skipped (running total: ${candidates.length})`);

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

  console.log(`${LOG} [Step 3] Requesting enrichment for symbols: ${symbols.join(', ')}`);

  let analysisData;
  try {
    analysisData = await getDailyAnalysisData(symbols);
  } catch (err) {
    console.error(`${LOG} getDailyAnalysisData failed:`, err.message);
    return [];
  }

  console.log(`${LOG} [Step 3] getDailyAnalysisData returned ${analysisData.stocks?.length || 0} stocks`);

  const stockMap = {};
  for (const stock of analysisData.stocks) {
    stockMap[stock.symbol] = stock;
  }

  // Log which symbols are missing from enrichment
  const missingSymbols = symbols.filter(s => !stockMap[s]);
  if (missingSymbols.length > 0) {
    console.log(`${LOG} [Step 3] Missing from enrichment (${missingSymbols.length}): ${missingSymbols.join(', ')}`);
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
    console.log(`${LOG} [Enrich] ${candidate.symbol} (${candidate.scan_type}): O=${open} H=${high} L=${low} C=${close} prevClose=${prevClose} lastDailyClose=${lastDailyClose} ltp=${stock.ltp} vol=${stock.todays_volume} avgVol50=${stock.avg_volume_50d} rsi=${stock.daily_rsi} latestCandle=${stock.latest_candle_date || 'N/A'} prevCandle=${stock.prev_candle_date || 'N/A'} source=${stock.data_source || 'N/A'}`);
    console.log(`${LOG} [Enrich] ${candidate.symbol} indicators: ema20=${stock.ema20 || 0} ema50=${stock.ema50 || 0} atr=${stock.atr || 0} h20D=${stock.high_20d || 0} l20D=${stock.low_20d || 0} h52W=${stock.high_52w || 0} wR1=${stock.weekly_r1 || 'null'} wR2=${stock.weekly_r2 || 'null'} dR1=${stock.daily_pivot_levels?.r1 || 'null'}`);
    console.log(`${LOG} [Enrich] ${candidate.symbol} pivots: dP=${stock.daily_pivot_levels?.pivot || 'null'} dR1=${stock.daily_pivot_levels?.r1 || 'null'} dS1=${stock.daily_pivot_levels?.s1 || 'null'} | 1H_R1=${stock.hourly_1h_pivots?.r1 || 'null'} 1H_S1=${stock.hourly_1h_pivots?.s1 || 'null'} | 4H_R1=${stock.hourly_4h_pivots?.r1 || 'null'} 4H_S1=${stock.hourly_4h_pivots?.s1 || 'null'}`);

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
        avg_volume_50d: stock.avg_volume_50d || 0,
        // Indicators for scan-type-specific levels (from engine)
        ema20: stock.ema20 || 0,
        ema50: stock.ema50 || 0,
        atr: stock.atr || 0,
        // Swing levels (5D/10D for breakdown stops, 20D for momentum)
        high_5d: stock.high_5d || 0,
        low_5d: stock.low_5d || 0,
        high_10d: stock.high_10d || 0,
        low_10d: stock.low_10d || 0,
        high_20d: stock.high_20d || 0,
        low_20d: stock.low_20d || 0,
        high_52w: stock.high_52w || 0,
        // Pivot levels for targets
        daily_pivot_levels: stock.daily_pivot_levels || null,
        weekly_pivot_levels: {
          r1: stock.weekly_r1 || null,
          r2: stock.weekly_r2 || null,
          s1: stock.weekly_s1 || null,
          s2: stock.weekly_s2 || null
        },
        // Hourly pivots for multi-timeframe confluence scoring
        hourly_1h_pivots: stock.hourly_1h_pivots || null,
        hourly_4h_pivots: stock.hourly_4h_pivots || null
      }
    });
  }

  return enriched;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: SCORE CANDIDATES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Multi-timeframe pivot confluence bonus.
 * Checks if 1H and/or 4H pivot levels cluster near daily pivot levels.
 * LONG: compares 1H_R1 / 4H_R1 against Daily_R1
 * SHORT: compares 1H_S1 / 4H_S1 against Daily_S1
 *
 * @returns {{ bonus: number, detail: string }}
 */
function calculateConfluence(candidate) {
  const THRESHOLD = 0.005; // 0.5% cluster distance
  const PTS_PER_TF = 7.5;
  const sym = candidate.symbol;

  const ohlcv = candidate._ohlcv;
  if (!ohlcv) return { bonus: 0, detail: 'no ohlcv' };

  const dailyPivots = ohlcv.daily_pivot_levels;
  const h1 = ohlcv.hourly_1h_pivots;
  const h4 = ohlcv.hourly_4h_pivots;

  if (!dailyPivots) {
    console.log(`${LOG} [Confluence] ${sym}: skip — no daily pivots`);
    return { bonus: 0, detail: 'no daily pivots' };
  }
  if (!h1 && !h4) {
    console.log(`${LOG} [Confluence] ${sym}: skip — no hourly pivots (1H=${h1 ? 'yes' : 'null'} 4H=${h4 ? 'yes' : 'null'})`);
    return { bonus: 0, detail: 'no hourly pivots' };
  }

  const isLong = candidate.direction === 'LONG';
  const dailyLevel = isLong ? dailyPivots.r1 : dailyPivots.s1;
  const levelLabel = isLong ? 'R1' : 'S1';

  if (!dailyLevel || dailyLevel <= 0) return { bonus: 0, detail: `no daily ${levelLabel}` };

  let bonus = 0;
  const matches = [];

  // Check 1H pivot proximity
  const h1Level = isLong ? h1?.r1 : h1?.s1;
  if (h1Level && h1Level > 0) {
    const dist = Math.abs(h1Level - dailyLevel) / dailyLevel;
    console.log(`${LOG} [Confluence] ${sym}: 1H ${levelLabel}=${round2(h1Level)} vs Daily ${levelLabel}=${round2(dailyLevel)} → dist=${round2(dist * 100)}% (threshold=0.5%)`);
    if (dist <= THRESHOLD) {
      bonus += PTS_PER_TF;
      matches.push(`1H ${levelLabel} ${round2(dist * 100)}%`);
    }
  }

  // Check 4H pivot proximity
  const h4Level = isLong ? h4?.r1 : h4?.s1;
  if (h4Level && h4Level > 0) {
    const dist = Math.abs(h4Level - dailyLevel) / dailyLevel;
    console.log(`${LOG} [Confluence] ${sym}: 4H ${levelLabel}=${round2(h4Level)} vs Daily ${levelLabel}=${round2(dailyLevel)} → dist=${round2(dist * 100)}% (threshold=0.5%)`);
    if (dist <= THRESHOLD) {
      bonus += PTS_PER_TF;
      matches.push(`4H ${levelLabel} ${round2(dist * 100)}%`);
    }
  }

  if (bonus === 0) {
    console.log(`${LOG} [Confluence] ${sym}: no confluence — distances exceed 0.5% threshold`);
    return { bonus: 0, detail: 'no confluence' };
  }

  const detail = `${matches.join('+')} cluster near Daily ${levelLabel}=${round2(dailyLevel)}`;
  console.log(`${LOG} [Confluence] ${sym}: ✅ +${round2(bonus)} pts — ${detail}`);
  return { bonus: round2(bonus), detail };
}

function scoreCandidates(enrichedCandidates) {
  console.log(`${LOG} [Step 4] Scoring ${enrichedCandidates.length} candidates...`);

  const scored = [];

  for (const c of enrichedCandidates) {
    const s = c.scan_scores;
    let score = 0;
    let cirPts = 0, volPts = 0, rsiPts = 0, atrPts = 0, candlePts = 0;

    // Close in range (25 pts) — higher = closed near high (bullish) / near low (bearish)
    const cir = c.direction === 'LONG' ? s.close_in_range_pct : (100 - s.close_in_range_pct);
    if (cir > 90) cirPts = 25;
    else if (cir > 80) cirPts = 20;
    else if (cir > 70) cirPts = 15;
    else if (cir > 60) cirPts = 10;
    else cirPts = 5;
    score += cirPts;

    // Volume ratio (25 pts)
    if (s.volume_ratio > 3) volPts = 25;
    else if (s.volume_ratio > 2) volPts = 20;
    else if (s.volume_ratio > 1.5) volPts = 15;
    else if (s.volume_ratio > 1.2) volPts = 10;
    else volPts = 5;
    score += volPts;

    // RSI positioning (20 pts)
    if (c.direction === 'LONG') {
      if (s.rsi >= 55 && s.rsi <= 65) rsiPts = 20;
      else if (s.rsi > 65 && s.rsi <= 72) rsiPts = 15;
      else if (s.rsi >= 50 && s.rsi < 55) rsiPts = 10;
      else rsiPts = 5;
    } else {
      // Bearish — mirror RSI logic
      if (s.rsi >= 35 && s.rsi <= 45) rsiPts = 20;
      else if (s.rsi >= 28 && s.rsi < 35) rsiPts = 15;
      else if (s.rsi > 45 && s.rsi <= 50) rsiPts = 10;
      else rsiPts = 5;
    }
    score += rsiPts;

    // ATR tradability (15 pts)
    if (s.atr_pct > 2.5) atrPts = 15;
    else if (s.atr_pct > 2.0) atrPts = 10;
    else if (s.atr_pct > 1.5) atrPts = 5;
    else atrPts = 0;
    score += atrPts;

    // Candle confirmation (15 pts)
    if (s.candle_pattern?.includes('engulfing')) candlePts = 15;
    else if (s.candle_pattern === 'hammer') candlePts = 12;
    else if (s.candle_pattern === 'bullish_candle' || s.candle_pattern === 'bearish_candle') candlePts = 10;
    else candlePts = 5;
    score += candlePts;

    if (score >= MIN_SCORE) {
      scored.push({ ...c, rank_score: score });
      console.log(`${LOG} ✅ ${c.symbol} (${c.scan_type}/${c.direction}): score=${score} [CIR:${cirPts}/25(${round2(cir)}%) VOL:${volPts}/25(${s.volume_ratio}x) RSI:${rsiPts}/20(${s.rsi}) ATR:${atrPts}/15(${s.atr_pct}%) CANDLE:${candlePts}/15(${s.candle_pattern})]`);

      // Confluence bonus: cluster detection across Daily / 1H / 4H pivots
      // Applied AFTER MIN_SCORE check — additive only (never reduces score)
      const confluenceResult = calculateConfluence(c);
      if (confluenceResult.bonus > 0) {
        scored[scored.length - 1].rank_score += confluenceResult.bonus;
        scored[scored.length - 1].confluence_score = confluenceResult.bonus;
        scored[scored.length - 1].confluence_detail = confluenceResult.detail;
        console.log(`${LOG}   ↳ Confluence: +${confluenceResult.bonus} pts (${confluenceResult.detail})`);
      }
    } else {
      console.log(`${LOG} ❌ ${c.symbol} (${c.scan_type}/${c.direction}): score=${score} < ${MIN_SCORE} [CIR:${cirPts} VOL:${volPts} RSI:${rsiPts} ATR:${atrPts} CANDLE:${candlePts}]`);
    }
  }

  // Sort descending by score
  scored.sort((a, b) => b.rank_score - a.rank_score);

  // Log sorted order with scan-type distribution
  if (scored.length > 0) {
    const scanTypeDist = {};
    for (const s of scored) {
      scanTypeDist[s.scan_type] = (scanTypeDist[s.scan_type] || 0) + 1;
    }
    console.log(`${LOG} [Step 4] Scored list (sorted): ${scored.map(s => `${s.symbol}(${s.scan_type}:${s.rank_score})`).join(', ')}`);
    console.log(`${LOG} [Step 4] Scan type distribution: ${Object.entries(scanTypeDist).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }

  return scored;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 5: CALCULATE LEVELS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate entry/stop/target levels using scan-type-aware scanLevels engine.
 *
 * NOW USES scanLevels.js:
 * - LONG picks: breakout, pullback, momentum, consolidation_breakout
 * - SHORT picks: breakdown_setup, momentum_carry_bearish, failed_at_resistance, compression_bearish
 *
 * Returns null if the engine rejects the setup (enforces discipline).
 */
function calculateLevels(pick) {
  const { _ohlcv, direction, scan_type, symbol } = pick;

  console.log(`${LOG} [Levels] ${symbol}: direction=${direction} scan=${scan_type} score=${pick.rank_score}`);
  console.log(`${LOG} [Levels] ${symbol}: OHLCV={O:${_ohlcv.open} H:${_ohlcv.high} L:${_ohlcv.low} C:${_ohlcv.close} prevC:${_ohlcv.prev_close}}`);
  console.log(`${LOG} [Levels] ${symbol}: ema20=${_ohlcv.ema20} ema50=${_ohlcv.ema50} atr=${_ohlcv.atr}`);
  console.log(`${LOG} [Levels] ${symbol}: h5D=${_ohlcv.high_5d} l5D=${_ohlcv.low_5d} h10D=${_ohlcv.high_10d} l10D=${_ohlcv.low_10d} h20D=${_ohlcv.high_20d} l20D=${_ohlcv.low_20d} h52W=${_ohlcv.high_52w}`);
  console.log(`${LOG} [Levels] ${symbol}: pivots wR1=${_ohlcv.weekly_pivot_levels?.r1} wR2=${_ohlcv.weekly_pivot_levels?.r2} wS1=${_ohlcv.weekly_pivot_levels?.s1} wS2=${_ohlcv.weekly_pivot_levels?.s2} dP=${_ohlcv.daily_pivot_levels?.pivot} dR1=${_ohlcv.daily_pivot_levels?.r1} dR2=${_ohlcv.daily_pivot_levels?.r2} dS1=${_ohlcv.daily_pivot_levels?.s1} dS2=${_ohlcv.daily_pivot_levels?.s2}`);

  // Prepare data for scanLevels engine
  const scanData = {
    // Core price levels
    fridayHigh: _ohlcv.high,
    fridayLow: _ohlcv.low,
    fridayClose: _ohlcv.close,

    // Indicators
    ema20: _ohlcv.ema20,
    atr: _ohlcv.atr || 0,

    // 20-day levels (for stops/targets)
    high20D: _ohlcv.high_20d,
    low20D: _ohlcv.low_20d,

    // 10-day/5-day levels (for consolidation/breakdown stops)
    high10D: _ohlcv.high_10d || null,
    low10D: _ohlcv.low_10d || null,
    high5D: _ohlcv.high_5d || null,

    // 52-week levels
    high52W: _ohlcv.high_52w || null,

    // Weekly pivot levels (for structural targets)
    weeklyR1: _ohlcv.weekly_pivot_levels?.r1 || null,
    weeklyR2: _ohlcv.weekly_pivot_levels?.r2 || null,
    weeklyS1: _ohlcv.weekly_pivot_levels?.s1 || null,
    weeklyS2: _ohlcv.weekly_pivot_levels?.s2 || null,

    // Daily pivot levels (primary targets for intraday MIS trades)
    dailyR1: _ohlcv.daily_pivot_levels?.r1 || null,
    dailyR2: _ohlcv.daily_pivot_levels?.r2 || null,
    dailyS1: _ohlcv.daily_pivot_levels?.s1 || null,
    dailyS2: _ohlcv.daily_pivot_levels?.s2 || null,
    dailyPivot: _ohlcv.daily_pivot_levels?.pivot || null,

    // Previous day high/low — explicit names for intraday target fallback
    // (fridayHigh/fridayLow are the same values but named for swing context)
    previousDayHigh: _ohlcv.high,
    previousDayLow: _ohlcv.low,

    // Intraday flag — signals scanLevels to use daily pivots instead of weekly
    isIntraday: true,

    // Daily picks use relaxed R:R (1.2:1 vs swing's 1.5:1 for multi-day holds)
    minRR: 1.2
  };

  // Map daily picks scan type to engine archetype (e.g. breakout_setup → breakout)
  const archetype = SCAN_ARCHETYPE[scan_type] || scan_type;
  console.log(`${LOG} [Levels] ${symbol}: scan_type="${scan_type}" → archetype="${archetype}"`);

  // Call scanLevels engine with the mapped archetype
  console.log(`${LOG} [Levels] ${symbol}: calling scanLevels.calculateTradingLevels("${archetype}", scanData)`);
  const result = scanLevels.calculateTradingLevels(archetype, scanData);
  console.log(`${LOG} [Levels] ${symbol}: engine returned valid=${result.valid} mode=${result.mode || 'N/A'} reason=${result.reason || 'N/A'}`);

  if (!result.valid) {
    console.log(`${LOG} [Levels] ${symbol}: REJECTED by scanLevels — ${result.reason}`);
    if (result.currentRR) console.log(`${LOG} [Levels] ${symbol}: currentRR=${result.currentRR} suggestedTarget=${result.suggestedTarget || 'N/A'}`);
    if (result.noData) console.log(`${LOG} [Levels] ${symbol}: noData=${result.noData} (missing indicator data)`);
    return null;
  }

  // Extract levels from scanLevels result
  const { entry, stop, target2: target, riskReward, riskPercent, rewardPercent, mode, reason } = result;

  // ═══════════════════════════════════════════════════════════════════════════
  // DAILY PICKS RISK CAP: 4% (stricter than swing's 8%)
  // ═══════════════════════════════════════════════════════════════════════════
  // Daily picks are intraday MIS positions that force-close at 3 PM.
  // No time to recover from 5%+ stops. Cap at 4% for safety.
  const DAILY_PICKS_MAX_RISK = 4.0;

  if (riskPercent > DAILY_PICKS_MAX_RISK) {
    console.log(`${LOG} [Levels] ${symbol}: REJECTED — Risk ${round2(riskPercent)}% exceeds daily picks cap (${DAILY_PICKS_MAX_RISK}%)`);
    return null;
  }

  console.log(`${LOG} [Levels] ${symbol}: ACCEPTED ${mode} entry=${round2(entry)} stop=${round2(stop)} target=${round2(target)} R:R=${round2(riskReward)} risk=${round2(riskPercent)}% reward=${round2(rewardPercent)}%`);
  console.log(`${LOG} [Levels] ${symbol}: entryType=${result.entryType || 'N/A'} target1=${result.target1 ? round2(result.target1) : 'N/A'} target3=${result.target3 ? round2(result.target3) : 'N/A'}`);

  return {
    ...pick,
    levels: {
      entry: round2(entry),
      stop: round2(stop),
      target: round2(target),
      risk_pct: round2(riskPercent),
      reward_pct: round2(rewardPercent),
      risk_reward: round2(riskReward),
      mode,
      reason,
      // Additional context from scanLevels
      entry_type: result.entryType,
      target1: result.target1 ? round2(result.target1) : null,
      target3: result.target3 ? round2(result.target3) : null
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
  // Determine scan_date and trading_date based on when we're running:
  // - 8:45 AM scheduled run: scan_date = yesterday, trading_date = today
  // - Manual evening run:    scan_date = today,     trading_date = next trading day
  const now = new Date();
  const istHour = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours();
  const todayMidnight = getISTMidnight();

  let scanDate, tradingDate;
  if (istHour < 15) {
    // Before market close (scheduled 8:45 AM run or manual pre-market)
    // ChartInk "latest" = yesterday's candle, we trade today
    scanDate = new Date(todayMidnight);
    scanDate.setDate(scanDate.getDate() - 1);
    tradingDate = todayMidnight;
  } else {
    // After market close (manual evening run)
    // ChartInk "latest" = today's completed candle, we trade next trading day
    scanDate = todayMidnight;
    tradingDate = await MarketHoursUtil.getNextTradingDay(todayMidnight);
  }

  console.log(`${LOG} [Step 7] Run at ${istHour}:xx IST → scanDate=${scanDate.toISOString()} tradingDate=${tradingDate.toISOString()}`);

  const pickDocs = picks.map(p => ({
    symbol: p.symbol,
    instrument_key: p.instrument_key,
    stock_name: p.stock_name,
    scan_type: p.scan_type,
    direction: p.direction,
    scan_scores: p.scan_scores,
    rank_score: p.rank_score,
    confluence_score: p.confluence_score || 0,
    confluence_detail: p.confluence_detail || null,
    levels: p.levels,
    trade: { status: 'PENDING' },
    kite: { kite_status: 'pending' },
    ai_insight: p.ai_insight || null,
    ai_generated: p.ai_generated || false
  }));

  // Upsert: one document per trading day
  const doc = await DailyPick.findOneAndUpdate(
    { trading_date: tradingDate },
    {
      $set: {
        trading_date: tradingDate,
        scan_date: scanDate,
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
// v2: ORB COLLECTION — 9:15 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Start ORB (Opening Range Breakout) data collection.
 * Called at 9:15 AM — polls LTP every 8s for 15 min (until 9:30 AM).
 * Stores ORB data on each pick's `orb` field and marks status as COLLECTING_ORB.
 */
async function startOrbCollection(options = {}) {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Starting ORB collection`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG} Kite not enabled — skipping ORB collection`);
    return { success: true, message: 'Kite not enabled' };
  }

  const doc = await DailyPick.findToday();
  if (!doc) {
    console.log(`${LOG} No DailyPick doc for today — nothing to collect`);
    return { success: true, message: 'No picks today' };
  }

  const pendingPicks = doc.picks.filter(p => p.trade.status === 'PENDING');
  if (pendingPicks.length === 0) {
    console.log(`${LOG} No PENDING picks — skipping ORB collection`);
    return { success: true, message: 'No pending picks' };
  }

  // Mark picks as COLLECTING_ORB
  for (const pick of pendingPicks) {
    pick.trade.status = 'COLLECTING_ORB';
    pick.kite.kite_status = 'collecting_orb';
  }
  await doc.save();

  // Collect ORB data (blocks for ~15 min)
  const symbols = pendingPicks.map(p => p.symbol);
  console.log(`${LOG} Collecting ORB for: ${symbols.join(', ')}`);

  const orbData = await collectOpeningRange(symbols, pendingPicks);

  // Store ORB data on each pick
  for (const pick of pendingPicks) {
    const orb = orbData[pick.symbol];
    if (orb) {
      pick.orb = {
        high: orb.high,
        low: orb.low,
        opening_price: orb.opening_price,
        gap_percent: orb.gap_percent,
        orb_direction: orb.orb_direction,
        nifty_orb_direction: orbData['_NIFTY']?.orb_direction || 'NEUTRAL'
      };
    }
  }
  await doc.save();

  console.log(`${LOG} ORB collection complete — data stored for ${Object.keys(orbData).filter(k => k !== '_NIFTY').length} symbols`);
  return { success: true, symbolsCollected: Object.keys(orbData).length };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: VALIDATE + PLACE ENTRIES — 9:30 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate picks against ORB data and place entries for validated picks.
 * Called at 9:30 AM after ORB collection completes.
 */
async function validateAndPlaceEntries(options = {}) {
  const { dryRun = false } = options;

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Validating picks + placing entries${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG} Kite not enabled — skipping`);
    return { success: true, message: 'Kite not enabled', orders: 0 };
  }

  const doc = await DailyPick.findToday();
  if (!doc) {
    console.log(`${LOG} No DailyPick doc for today — nothing to place`);
    return { success: true, message: 'No picks today', orders: 0 };
  }

  // Accept both COLLECTING_ORB (normal flow) and PENDING (if ORB collection was skipped/manual)
  const eligiblePicks = doc.picks.filter(p =>
    p.trade.status === 'COLLECTING_ORB' || p.trade.status === 'PENDING'
  );
  if (eligiblePicks.length === 0) {
    console.log(`${LOG} No eligible picks for validation — skipping`);
    return { success: true, message: 'No eligible picks', orders: 0 };
  }

  // Step 1: Validate against ORB data
  // Build orbData from stored pick.orb fields (already collected by startOrbCollection)
  const orbData = {};
  for (const pick of eligiblePicks) {
    if (pick.orb?.high) {
      orbData[pick.symbol] = {
        high: pick.orb.high,
        low: pick.orb.low,
        opening_price: pick.orb.opening_price,
        gap_percent: pick.orb.gap_percent,
        orb_direction: pick.orb.orb_direction
      };
    }
  }
  // Reconstruct NIFTY ORB from first pick that has it
  const niftyDir = eligiblePicks.find(p => p.orb?.nifty_orb_direction)?.orb?.nifty_orb_direction;
  if (niftyDir) {
    orbData['_NIFTY'] = { orb_direction: niftyDir };
  }

  validatePicks(eligiblePicks, orbData);

  // Step 2: Separate validated vs skipped
  const validatedPicks = eligiblePicks.filter(p => p.validation?.passed);
  const skippedPicks = eligiblePicks.filter(p => !p.validation?.passed);

  for (const pick of skippedPicks) {
    pick.trade.status = 'SKIPPED';
    pick.trade.exit_reason = `validation_failed: ${pick.validation?.skip_reason || 'unknown'}`;
    pick.kite.kite_status = 'skipped';
    console.log(`${LOG} ${pick.symbol}: SKIPPED — ${pick.validation?.skip_reason}`);
  }

  if (validatedPicks.length === 0) {
    console.log(`${LOG} All picks failed validation — no orders to place`);
    await doc.save();
    return { success: true, message: 'All picks failed validation', orders: 0 };
  }

  // Mark as VALIDATED
  for (const pick of validatedPicks) {
    pick.trade.status = 'VALIDATED';
    pick.kite.kite_status = 'validated';
  }

  // Step 3: Capital allocation + order placement (same logic as v1)
  const MAX_WEIGHT = 0.45;
  const balance = await kiteOrderService.getAvailableBalance();
  console.log(`${LOG} Balance: ₹${balance.available}, Usable: ₹${balance.usable}`);

  const totalScore = validatedPicks.reduce((sum, p) => sum + p.rank_score, 0);
  const rawWeights = validatedPicks.map(p => Math.min(p.rank_score / totalScore, MAX_WEIGHT));
  const weightSum = rawWeights.reduce((s, w) => s + w, 0);
  const allocations = validatedPicks.map((pick, i) => ({
    pick,
    capital: Math.floor(balance.usable * (rawWeights[i] / weightSum))
  }));

  console.log(`${LOG} Capital allocation: totalScore=${totalScore} usable=₹${balance.usable}`);
  for (const { pick, capital } of allocations) {
    const cappedAmount = Math.min(capital, kiteConfig.MAX_ORDER_VALUE);
    const estQty = Math.floor(cappedAmount / pick.levels.entry);
    console.log(`${LOG}   ${pick.symbol}: weight=${round2(rawWeights[validatedPicks.indexOf(pick)] / weightSum * 100)}% capital=₹${capital} capped=₹${cappedAmount} estQty=${estQty} entry=₹${pick.levels.entry}`);
  }

  let ordersPlaced = 0;

  for (const { pick, capital } of allocations) {
    const orderAmount = Math.min(capital, kiteConfig.MAX_ORDER_VALUE);
    const qty = Math.floor(orderAmount / pick.levels.entry);
    if (qty <= 0) {
      console.log(`${LOG} ${pick.symbol}: qty=0 (price ₹${pick.levels.entry} > capital ₹${orderAmount}) — skipping`);
      pick.trade.status = 'SKIPPED';
      pick.kite.kite_status = 'skipped';
      continue;
    }

    const entryType = pick.levels.entry_type || 'limit';
    let orderType, triggerPrice, limitPrice;

    if (entryType === 'buy_above') {
      orderType = 'SL';
      triggerPrice = pick.levels.entry;
      limitPrice = round2(pick.levels.entry * 1.002);
    } else if (entryType === 'sell_below') {
      orderType = 'SL-M';
      triggerPrice = pick.levels.entry;
      limitPrice = 0;
    } else {
      orderType = 'LIMIT';
      triggerPrice = 0;
      limitPrice = pick.levels.entry;
    }

    console.log(`${LOG} ${pick.symbol}: ${orderType} ${pick.direction} qty=${qty} entry=₹${pick.levels.entry} (validated, ${pick.validation?.levels_recalculated ? 'recalculated' : 'original'} levels)`);

    if (dryRun) {
      console.log(`${LOG} [DRY RUN] Would place ${orderType} order for ${pick.symbol}`);
      continue;
    }

    try {
      const orderParams = {
        tradingsymbol: pick.symbol,
        exchange: 'NSE',
        transaction_type: pick.direction === 'LONG' ? 'BUY' : 'SELL',
        order_type: orderType,
        product: 'MIS',
        quantity: qty,
        price: limitPrice,
        simulationId: `daily_pick_${pick.symbol}`,
        orderType: 'ENTRY',
        source: 'DAILY_PICKS'
      };

      if (orderType === 'SL' || orderType === 'SL-M') {
        orderParams.trigger_price = triggerPrice;
      }

      const result = await kiteOrderService.placeOrder(orderParams);

      if (result.success && result.orderId) {
        pick.trade.status = 'ORDER_PLACED';
        pick.trade.qty = qty;
        pick.kite.entry_order_id = result.orderId;
        pick.kite.kite_status = 'order_placed';
        ordersPlaced++;

        // ── TRADE CARD: Entry Order Placed ──
        const riskPerShare = Math.abs(pick.levels.entry - pick.levels.stop);
        const maxLoss = round2(riskPerShare * qty);
        const rewardPerShare = Math.abs(pick.levels.target - pick.levels.entry);
        const maxProfit = round2(rewardPerShare * qty);
        console.log(`${LOG} ┌── TRADE: ${pick.symbol} ──────────────────────────────`);
        console.log(`${LOG} │ Direction: ${pick.direction} | Scan: ${pick.scan_type} | Mode: ${pick.levels.mode}`);
        console.log(`${LOG} │ Analysis → Entry: ₹${pick.levels.entry} | Stop: ₹${pick.levels.stop} | Target: ₹${pick.levels.target}`);
        console.log(`${LOG} │ T1 (partial): ${pick.levels.target1 ? '₹' + pick.levels.target1 : 'N/A'} | T3 (stretch): ${pick.levels.target3 ? '₹' + pick.levels.target3 : 'N/A'}`);
        console.log(`${LOG} │ R:R=${pick.levels.risk_reward} | Risk=${pick.levels.risk_pct}% | Reward=${pick.levels.reward_pct}%`);
        console.log(`${LOG} │ Order → ${orderType} qty=${qty} price=₹${limitPrice || triggerPrice} orderId=${result.orderId}`);
        console.log(`${LOG} │ Capital: ₹${orderAmount} | Max Loss: ₹${maxLoss} | Max Profit: ₹${maxProfit}`);
        console.log(`${LOG} │ Reason: ${pick.levels.reason}`);
        console.log(`${LOG} └─────────────────────────────────────────────────────`);
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
  console.log(`${LOG} Validation+entry: ${validatedPicks.length} validated, ${skippedPicks.length} skipped, ${ordersPlaced} orders placed`);

  return { success: true, validated: validatedPicks.length, skipped: skippedPicks.length, orders: ordersPlaced };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: FILL LISTENER — Instant SL+Target on postback fill
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Place SL-M stop + LIMIT target immediately after entry fill.
 * Shared by both postback listener and polling fallback.
 * Idempotency: checks kite_status !== 'sl_target_placed' before acting.
 */
async function placeSLAndTarget(pick, doc, entryPrice) {
  // Idempotency guard — prevent double-placement
  if (pick.kite.kite_status === 'sl_target_placed' || pick.trade.status !== 'ORDER_PLACED') {
    console.log(`${LOG} ${pick.symbol}: SL+target already placed or status changed — skipping`);
    return;
  }

  pick.trade.status = 'ENTERED';
  pick.trade.entry_price = entryPrice;
  pick.trade.entry_time = new Date();

  // Recalculate target from actual fill
  const target = pick.direction === 'LONG'
    ? round2(entryPrice * (1 + TARGET_PCT / 100))
    : round2(entryPrice * (1 - TARGET_PCT / 100));
  pick.levels.target = target;

  console.log(`${LOG} ✅ ${pick.symbol}: Filled @ ₹${entryPrice} — placing SL @ ₹${pick.levels.stop} + target @ ₹${target}`);

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
      simulationId: `daily_pick_sl_${pick.symbol}`,
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

  // Place LIMIT target order
  try {
    const tgtResult = await kiteOrderService.placeOrder({
      tradingsymbol: pick.symbol,
      exchange: 'NSE',
      transaction_type: pick.direction === 'LONG' ? 'SELL' : 'BUY',
      order_type: 'LIMIT',
      price: target,
      product: 'MIS',
      quantity: pick.trade.qty,
      simulationId: `daily_pick_tgt_${pick.symbol}`,
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

    // ── TRADE CARD: Position Live ──
    const riskPerShare = Math.abs(entryPrice - pick.levels.stop);
    const maxLoss = round2(riskPerShare * pick.trade.qty);
    const rewardPerShare = Math.abs(target - entryPrice);
    const maxProfit = round2(rewardPerShare * pick.trade.qty);
    const capital = round2(entryPrice * pick.trade.qty);
    const slippage = round2(entryPrice - pick.levels.entry);
    console.log(`${LOG} ┌── POSITION LIVE: ${pick.symbol} ────────────────────────`);
    console.log(`${LOG} │ Direction: ${pick.direction} | Scan: ${pick.scan_type}`);
    console.log(`${LOG} │ Planned Entry: ₹${pick.levels.entry} → Actual Fill: ₹${entryPrice} (slippage: ${slippage >= 0 ? '+' : ''}₹${slippage})`);
    console.log(`${LOG} │ Stop: ₹${pick.levels.stop} (SL-M orderId=${pick.kite.stop_order_id})`);
    console.log(`${LOG} │ Target: ₹${target} (LIMIT orderId=${pick.kite.target_order_id})`);
    console.log(`${LOG} │ Qty: ${pick.trade.qty} | Capital Deployed: ₹${capital}`);
    console.log(`${LOG} │ Max Loss: ₹${maxLoss} (${round2((riskPerShare / entryPrice) * 100)}%) | Max Profit: ₹${maxProfit} (${round2((rewardPerShare / entryPrice) * 100)}%)`);
    console.log(`${LOG} └─────────────────────────────────────────────────────`);
  } else if (!slPlaced) {
    // CRITICAL: No stop-loss — emergency market exit
    console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} SL-M failed — emergency market exit`);
    try {
      await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
        'CRITICAL: SL Failed — Emergency Exit',
        `${pick.symbol} SL-M placement failed. Emergency market exit attempted.`,
        { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
      );
    } catch (_) { /* ignore */ }

    try {
      if (tgtPlaced && pick.kite.target_order_id) {
        await kiteOrderService.cancelOrder(pick.kite.target_order_id);
      }
      const exitResult = await kiteOrderService.placeOrder({
        tradingsymbol: pick.symbol,
        exchange: 'NSE',
        transaction_type: pick.direction === 'LONG' ? 'SELL' : 'BUY',
        order_type: 'MARKET',
        product: 'MIS',
        quantity: pick.trade.qty,
        simulationId: `daily_pick_emergency_${pick.symbol}`,
        orderType: 'EMERGENCY_EXIT',
        source: 'DAILY_PICKS'
      });
      if (exitResult.success) {
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
    pick.trade.status = 'FAILED';
    pick.trade.exit_time = new Date();
    pick.trade.exit_reason = 'sl_placement_failed_emergency_exit';
    calculatePnl(pick);
    pick.kite.kite_status = 'failed';
  } else {
    // Target failed but SL is in place — acceptable
    console.error(`${LOG} ⚠️ ${pick.symbol}: Target placement failed — SL active, will rely on stop or 3 PM exit`);
    pick.kite.kite_status = 'sl_target_placed';
  }

  await doc.save();
}

/**
 * Initialize fill listener — subscribes to postback events for instant SL+target.
 * Called once on server startup.
 */
function initFillListener() {
  console.log(`${LOG} Initializing fill listener (postback → instant SL+target)`);

  kiteOrderEvents.on('order:complete', async (postback) => {
    try {
      console.log(`${LOG} [FILL-LISTENER] Received order:complete — orderId=${postback.order_id} symbol=${postback.tradingsymbol} avg_price=${postback.average_price}`);

      const doc = await DailyPick.findToday();
      if (!doc) {
        console.log(`${LOG} [FILL-LISTENER] No DailyPick doc today — ignoring postback`);
        return;
      }

      const pick = doc.picks.find(p =>
        p.kite.entry_order_id === postback.order_id &&
        p.trade.status === 'ORDER_PLACED' &&
        p.kite.kite_status !== 'sl_target_placed'
      );
      if (!pick) {
        console.log(`${LOG} [FILL-LISTENER] orderId=${postback.order_id} not matched to any ORDER_PLACED daily pick — ignoring (may be swing/manual order)`);
        return;
      }

      console.log(`${LOG} [FILL-LISTENER] ${pick.symbol}: Entry fill detected via postback — orderId=${postback.order_id} price=₹${postback.average_price} qty=${postback.filled_quantity}`);
      await placeSLAndTarget(pick, doc, parseFloat(postback.average_price));
      console.log(`${LOG} [FILL-LISTENER] ${pick.symbol}: SL+target placement complete — kite_status=${pick.kite.kite_status}`);
    } catch (err) {
      console.error(`${LOG} [FILL-LISTENER] Error processing fill:`, err.message, err.stack);
    }
  });

  console.log(`${LOG} Fill listener active`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: FILL CHECK FALLBACK — Polling backup (every 2 min, 9:30-10:30)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Polling fallback for fill detection. Postback handles most fills instantly,
 * but this catches any that slip through (e.g. postback delayed or missed).
 * Idempotency: skips picks where SL+target already placed by postback listener.
 */
async function checkFillsFallback(options = {}) {
  if (!isKiteIntegrationEnabled()) return { success: true, message: 'Kite not enabled' };

  const doc = await DailyPick.findToday();
  if (!doc) return { success: true, message: 'No picks today' };

  const orderPlacedPicks = doc.picks.filter(p =>
    p.trade.status === 'ORDER_PLACED' && p.kite.kite_status !== 'sl_target_placed'
  );
  if (orderPlacedPicks.length === 0) return { success: true, message: 'No pending fills' };

  console.log(`${LOG} [FILL-FALLBACK] Checking ${orderPlacedPicks.length} picks: ${orderPlacedPicks.map(p => p.symbol).join(', ')}`);

  let filled = 0;

  for (const pick of orderPlacedPicks) {
    try {
      console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Checking entry order ${pick.kite.entry_order_id}...`);
      const order = await kiteOrderService.getOrderDetails(pick.kite.entry_order_id);
      if (!order) {
        console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Order not found — skipping`);
        continue;
      }

      const status = order.status?.toUpperCase();
      console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Order status=${status} avg_price=${order.average_price} filled_qty=${order.filled_quantity}`);

      if (status === 'COMPLETE') {
        console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Fill detected via polling @ ₹${order.average_price} — placing SL+target`);
        await placeSLAndTarget(pick, doc, order.average_price || pick.levels.entry);
        filled++;
      } else if (status === 'CANCELLED' || status === 'REJECTED') {
        console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Order ${status} — marking as SKIPPED`);
        pick.trade.status = 'SKIPPED';
        pick.kite.kite_status = 'skipped';
        await doc.save();
      } else {
        console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Still pending (status=${status}) — will check next poll`);
      }
    } catch (err) {
      console.error(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Error —`, err.message);
    }
  }

  return { success: true, filled };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: CANCEL EXPIRED ENTRIES — 10:30 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cancel unfilled entry orders at 10:30 AM. Setup has expired.
 */
async function cancelExpiredEntries(options = {}) {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Cancelling expired entry orders (10:30 AM cutoff)`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) return { success: true, message: 'Kite not enabled' };

  const doc = await DailyPick.findToday();
  if (!doc) return { success: true, message: 'No picks today' };

  const orderPlacedPicks = doc.picks.filter(p => p.trade.status === 'ORDER_PLACED');
  if (orderPlacedPicks.length === 0) {
    console.log(`${LOG} No ORDER_PLACED picks to cancel`);
    return { success: true, cancelled: 0 };
  }

  let cancelled = 0;
  for (const pick of orderPlacedPicks) {
    try {
      console.log(`${LOG} ${pick.symbol}: Cancelling expired entry order ${pick.kite.entry_order_id}`);
      await kiteOrderService.cancelOrder(pick.kite.entry_order_id);
    } catch (err) {
      console.error(`${LOG} ${pick.symbol}: Cancel failed:`, err.message);
    }
    pick.trade.status = 'SKIPPED';
    pick.trade.exit_reason = 'setup_expired_1030';
    pick.kite.kite_status = 'skipped';
    cancelled++;
  }

  await doc.save();
  console.log(`${LOG} Cancelled ${cancelled} expired entries`);
  return { success: true, cancelled };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: ORDER MONITORING — Every 3 min (10:00 AM - 2:59 PM) + Trailing Stops
// ═══════════════════════════════════════════════════════════════════════════════

// Trailing stop config
const TRAIL_MIN_PROFIT_PCT = 1.5; // Start trailing after 1.5% profit
const TRAIL_LOCK_RATIO = 0.4;     // Lock 40% of profit as new stop
const TRAIL_START_HOUR = 12;       // Only trail after 12:00 PM IST

/**
 * Monitor entered picks for stop/target fills + trailing stops.
 * When one fills, cancel the counterpart order.
 * After 12 PM, trail stops upward for profitable positions.
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

  console.log(`${LOG} Monitoring ${enteredPicks.length} ENTERED picks`);

  let statusChanged = false;

  for (const pick of enteredPicks) {
    if (!pick.kite.stop_order_id && !pick.kite.target_order_id) {
      console.log(`${LOG} ${pick.symbol}: No protective orders — will be handled by 3 PM exit`);
      continue;
    }

    try {
      console.log(`${LOG} ${pick.symbol}: Checking SL=${pick.kite.stop_order_id || 'none'} TGT=${pick.kite.target_order_id || 'none'} (entry=₹${pick.trade.entry_price} stop=₹${pick.levels.stop} target=₹${pick.levels.target})`);

      const [stopOrder, targetOrder] = await Promise.all([
        pick.kite.stop_order_id ? kiteOrderService.getOrderDetails(pick.kite.stop_order_id) : null,
        pick.kite.target_order_id ? kiteOrderService.getOrderDetails(pick.kite.target_order_id) : null
      ]);

      const stopStatus = stopOrder?.status?.toUpperCase();
      const targetStatus = targetOrder?.status?.toUpperCase();
      console.log(`${LOG} ${pick.symbol}: SL status=${stopStatus || 'N/A'} TGT status=${targetStatus || 'N/A'}`);

      if (stopStatus === 'COMPLETE' && targetStatus === 'COMPLETE') {
        // Both filled — race condition
        console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} — BOTH stop and target filled!`);

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
              simulationId: `daily_pick_corrective_${pick.symbol}`,
              orderType: 'CORRECTIVE',
              source: 'DAILY_PICKS'
            });
            if (correctiveResult.success) {
              console.log(`${LOG} ✅ ${pick.symbol}: Corrective ${correctiveSide} placed`);
            }
          } catch (corrErr) {
            console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} corrective order error:`, corrErr.message);
          }

          try {
            await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
              'CRITICAL: Both SL+Target Filled',
              `${pick.symbol}: Race condition. Corrective order placed.`,
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
        console.log(`${LOG} ${pick.symbol}: PnL: ₹${pick.trade.pnl} (${pick.trade.return_pct}%)`);

      } else if (targetStatus === 'COMPLETE') {
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
        console.log(`${LOG} ${pick.symbol}: PnL: ₹${pick.trade.pnl} (${pick.trade.return_pct}%)`);
      }
    } catch (err) {
      console.error(`${LOG} ${pick.symbol}: Monitor error —`, err.message);
    }
  }

  // Trailing stops — only after 12:00 PM IST, only for picks still ENTERED
  const istHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours();
  const stillEnteredPicks = doc.picks.filter(p => p.trade.status === 'ENTERED' && p.kite.stop_order_id);

  if (istHour >= TRAIL_START_HOUR && stillEnteredPicks.length > 0 && !dryRun) {
    console.log(`${LOG} [TRAILING] Checking trailing stops for ${stillEnteredPicks.length} positions (after 12 PM)`);

    // Fetch fresh LTP via Kite API (NOT priceCacheService — 5-min cache too stale for SL decisions)
    const symbols = stillEnteredPicks.map(p => `NSE:${p.symbol}`);
    try {
      const ltpData = await kiteOrderService.getLTP(symbols);

      for (const pick of stillEnteredPicks) {
        const currentPrice = ltpData[`NSE:${pick.symbol}`]?.last_price;
        if (!currentPrice || !pick.trade.entry_price) continue;

        const profitPct = ((currentPrice - pick.trade.entry_price) / pick.trade.entry_price) * 100 *
          (pick.direction === 'LONG' ? 1 : -1);

        if (profitPct >= TRAIL_MIN_PROFIT_PCT) {
          const profitPerShare = Math.abs(currentPrice - pick.trade.entry_price);
          const newStop = pick.direction === 'LONG'
            ? round2(pick.trade.entry_price + profitPerShare * TRAIL_LOCK_RATIO)
            : round2(pick.trade.entry_price - profitPerShare * TRAIL_LOCK_RATIO);

          // Get current stop level
          const currentStop = pick.levels.stop;
          const shouldTrail = pick.direction === 'LONG' ? newStop > currentStop : newStop < currentStop;

          if (shouldTrail) {
            try {
              await kiteOrderService.modifyOrder(pick.kite.stop_order_id, {
                trigger_price: newStop
              });

              // Log trail history
              if (!pick.trailing_history) pick.trailing_history = [];
              pick.trailing_history.push({
                timestamp: new Date(),
                old_stop: currentStop,
                new_stop: newStop,
                price_at_trail: currentPrice
              });
              pick.levels.stop = newStop;
              statusChanged = true;

              console.log(`${LOG} [TRAILING] ${pick.symbol}: Stop trailed ₹${currentStop} → ₹${newStop} (price=₹${currentPrice}, profit=${round2(profitPct)}%)`);
            } catch (err) {
              console.error(`${LOG} [TRAILING] ${pick.symbol}: modifyOrder failed:`, err.message);
            }
          }
        }
      }
    } catch (err) {
      console.error(`${LOG} [TRAILING] LTP fetch failed:`, err.message);
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
          `Monitor detected status changes but doc.save() failed.`,
          { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
        );
      } catch (_) { /* ignore */ }
    }
  }

  const stillEntered = enteredPicks.filter(p => p.trade.status === 'ENTERED').length;
  const exited = enteredPicks.length - stillEntered;
  console.log(`${LOG} Monitor complete: ${stillEntered} active, ${exited} exited`);

  return { success: true, active: stillEntered };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: 2:00 PM STOP TIGHTENING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tighten stops to breakeven for profitable positions at 2:00 PM.
 * For positions in profit → move stop to entry price (breakeven).
 * For positions at loss → keep original SL.
 */
async function tightenStops(options = {}) {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} 2:00 PM stop tightening`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) return { success: true, message: 'Kite not enabled' };

  const doc = await DailyPick.findToday();
  if (!doc) return { success: true, message: 'No picks today' };

  const enteredPicks = doc.picks.filter(p => p.trade.status === 'ENTERED' && p.kite.stop_order_id);
  if (enteredPicks.length === 0) {
    console.log(`${LOG} No ENTERED picks with stops to tighten`);
    return { success: true, tightened: 0 };
  }

  // Fetch fresh LTP via Kite API (NOT priceCacheService — 5-min cache too stale for SL decisions)
  const symbols = enteredPicks.map(p => `NSE:${p.symbol}`);
  let ltpData;
  try {
    ltpData = await kiteOrderService.getLTP(symbols);
  } catch (err) {
    console.error(`${LOG} LTP fetch failed for tightening:`, err.message);
    return { success: false, error: err.message };
  }

  let tightened = 0;

  for (const pick of enteredPicks) {
    const currentPrice = ltpData[`NSE:${pick.symbol}`]?.last_price;
    if (!currentPrice || !pick.trade.entry_price) continue;

    const profitPct = ((currentPrice - pick.trade.entry_price) / pick.trade.entry_price) * 100 *
      (pick.direction === 'LONG' ? 1 : -1);

    if (profitPct > 0) {
      // In profit → tighten to breakeven
      const newStop = pick.trade.entry_price;
      const currentStop = pick.levels.stop;
      const shouldTighten = pick.direction === 'LONG' ? newStop > currentStop : newStop < currentStop;

      if (shouldTighten) {
        try {
          await kiteOrderService.modifyOrder(pick.kite.stop_order_id, {
            trigger_price: newStop
          });

          if (!pick.trailing_history) pick.trailing_history = [];
          pick.trailing_history.push({
            timestamp: new Date(),
            old_stop: currentStop,
            new_stop: newStop,
            price_at_trail: currentPrice
          });
          pick.levels.stop = newStop;
          tightened++;

          console.log(`${LOG} ${pick.symbol}: Stop tightened to breakeven ₹${newStop} (was ₹${currentStop}, profit=${round2(profitPct)}%)`);
        } catch (err) {
          console.error(`${LOG} ${pick.symbol}: modifyOrder failed for tightening:`, err.message);
        }
      } else {
        console.log(`${LOG} ${pick.symbol}: Stop already at/above breakeven (₹${currentStop} vs entry ₹${pick.trade.entry_price})`);
      }
    } else {
      console.log(`${LOG} ${pick.symbol}: At loss (${round2(profitPct)}%) — keeping original SL ₹${pick.levels.stop}`);
    }
  }

  if (tightened > 0) {
    await doc.save();
  }

  console.log(`${LOG} Tightened ${tightened}/${enteredPicks.length} stops to breakeven`);
  return { success: true, tightened };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Select up to maxPicks from viable candidates with scan-type diversity.
 * Round-robin: pick the best (highest score) from each scan type first,
 * then fill remaining slots by score across all types.
 */
function selectDiversePicks(viable, maxPicks) {
  console.log(`${LOG} [Diversity] Selecting ${maxPicks} from ${viable.length} viable candidates`);

  if (viable.length <= maxPicks) {
    console.log(`${LOG} [Diversity] Viable (${viable.length}) <= maxPicks (${maxPicks}), returning all`);
    return viable;
  }

  // Group by scan_type, each group already sorted by rank_score (inherited from scored)
  const byType = {};
  for (const pick of viable) {
    const key = pick.scan_type;
    if (!byType[key]) byType[key] = [];
    byType[key].push(pick);
  }

  console.log(`${LOG} [Diversity] Groups: ${Object.entries(byType).map(([k, v]) => `${k}(${v.length}): [${v.map(p => `${p.symbol}:${p.rank_score}`).join(', ')}]`).join(' | ')}`);

  const selected = [];
  const usedSymbols = new Set();

  // Round 1: Best candidate from each scan type (ordered by highest top-score)
  const typesByBest = Object.entries(byType)
    .sort((a, b) => b[1][0].rank_score - a[1][0].rank_score);

  console.log(`${LOG} [Diversity] Round 1 — one per scan type (${typesByBest.length} types, picking up to ${maxPicks}):`);
  for (const [typeName, picks] of typesByBest) {
    if (selected.length >= maxPicks) {
      console.log(`${LOG} [Diversity] Round 1: slots full, skipping ${typeName}`);
      break;
    }
    const best = picks.find(p => !usedSymbols.has(p.symbol));
    if (best) {
      selected.push(best);
      usedSymbols.add(best.symbol);
      console.log(`${LOG} [Diversity] Round 1: picked ${best.symbol} from ${typeName} (score=${best.rank_score}, slot ${selected.length}/${maxPicks})`);
    }
  }

  // Round 2: Fill remaining slots by score across all types
  if (selected.length < maxPicks) {
    const remaining = viable.filter(p => !usedSymbols.has(p.symbol));
    console.log(`${LOG} [Diversity] Round 2 — filling ${maxPicks - selected.length} remaining slots from ${remaining.length} candidates by score`);
    for (const pick of remaining) {
      if (selected.length >= maxPicks) break;
      selected.push(pick);
      usedSymbols.add(pick.symbol);
      console.log(`${LOG} [Diversity] Round 2: picked ${pick.symbol} (${pick.scan_type}, score=${pick.rank_score}, slot ${selected.length}/${maxPicks})`);
    }
  }

  // Log diversity breakdown
  const typeCounts = {};
  for (const p of selected) {
    typeCounts[p.scan_type] = (typeCounts[p.scan_type] || 0) + 1;
  }
  console.log(`${LOG} [Diversity] Final picks: ${selected.map(s => `${s.symbol}(${s.scan_type}:${s.rank_score})`).join(', ')}`);
  console.log(`${LOG} [Diversity] Type distribution: ${Object.entries(typeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  return selected;
}

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
  startOrbCollection,
  validateAndPlaceEntries,
  checkFillsFallback,
  cancelExpiredEntries,
  initFillListener,
  monitorDailyPickOrders,
  tightenStops,
  getMarketContext,
  detectCandlePattern
};

export default {
  runDailyPicks,
  startOrbCollection,
  validateAndPlaceEntries,
  checkFillsFallback,
  cancelExpiredEntries,
  initFillListener,
  monitorDailyPickOrders,
  tightenStops,
  getMarketContext,
  detectCandlePattern
};