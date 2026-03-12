/**
 * Daily Picks Service — Core Orchestrator
 *
 * Handles: scan → enrich → score → levels → intel → select → save → notify (8:40 AM IST)
 *          ORB validation + entry placement (9:15 AM - 10:01 AM, multi-pass)
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
import { fetchAndCheckRegime, getRegimeWarning } from '../../engine/regime.js';
import DailyPick from '../../models/dailyPick.js';
import ApiUsage from '../../models/apiUsage.js';
import kiteOrderService from '../kiteOrder.service.js';
import kiteOrderEvents from '../kiteOrderEvents.js';
import { isKiteIntegrationEnabled } from '../kiteTradeIntegration.service.js';
import { firebaseService } from '../firebase/firebase.service.js';
import priceCacheService from '../priceCache.service.js';
import MarketHoursUtil from '../../utils/marketHours.js';
import kiteConfig from '../../config/kite.config.js';
import { getISTMidnight, calculatePnl, updateDailyResults, round2, roundToTick, getNseTickSize, delay } from './dailyPicksHelpers.js';
import { collectOpeningRange, validatePicks } from './orbValidationService.js';
import { checkCircuitBreaker, resetCircuitBreaker, reconcilePositionsOnStartup } from './dailyPicksRiskService.js';
import { filterEarningsStocks } from './earningsFilter.js';
// newsSentimentFilter.js is DEPRECATED — scoring now done inline at Step 5.5 using constants below
import { fetchGlobalMarketIntel, fetchSGXNiftyData, shouldAvoidTrading, getTradingAdjustment, clearIntelCache } from './globalMarketIntel.js';
import scanLevels from '../../engine/scanLevels.js';
import { SECTOR_MAPPING, mapSectorToIntelKey } from '../../utils/sectorMapping.js';
import {
  GAP_PROTECTION_MAX_PCT,
  SLIPPAGE_BUFFER_PCT,
  PARTIAL_BOOK_PCT,
  PARTIAL_BOOK_QTY_RATIO,
  TRAIL_MIN_PROFIT_PCT,
  TRAIL_LOCK_RATIO,
  TRAIL_MIN_MINUTES,
  TRAIL_START_HOUR,
  SIDEWAYS_EXIT_MINUTES,
  SIDEWAYS_THRESHOLD_PCT,
  BASELINE_ATR_PCT,
  MIN_ATR_MULT,
  MAX_ATR_MULT,
  MAX_PICKS,
  TRAIL_ATR_LOOKBACK,
  INTEL_STOCK_NEWS_ALIGNED_HIGH,
  INTEL_STOCK_NEWS_OPPOSING_HIGH,
  INTEL_SECTOR_ALIGNED,
  INTEL_SECTOR_OPPOSING,
} from './dailyPicksConstants.js';
import { computeDynamicTrail, checkPartialBooking, checkSidewaysExit } from './tradingDecisions.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_DAILY_PICKS = MAX_PICKS; // from shared constants (currently 3)
const TARGET_PCT = 2.0;
const SCAN_DELAY_MS = 2000;
const MIN_SCORE = 60;
const LOG = '[DAILY-PICKS]';

// Scan priority bonus — rewards stocks caught by higher-priority scans in strong regimes
// WEAK_BULL/WEAK_BEAR/NEUTRAL: all scans equal weight (0 bonus)
const SCAN_PRIORITY_BONUS = {
  STRONG_BULL: {
    breakout_setup: 10,
    fiftyTwoWeek_high: 8,
    bull_flag: 6,
    volume_shocker_bullish: 5,
    pullback_at_support: 3,
    compression_bullish: 2,
    nr7_bullish: 1,
    inside_day_bullish: 0,
  },
  STRONG_BEAR: {
    breakdown_setup: 10,
    fiftyTwoWeek_low: 8,
    bear_flag: 6,
    volume_shocker_bearish: 5,
    failed_at_resistance: 3,
    compression_bearish: 2,
    nr7_bearish: 1,
    inside_day_bearish: 0,
  }
};

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_OUTPUT_TOKENS = 5000;

// Multi-pass ORB constants
const MAX_ORB_PASS = 3;
const ORB_PASS_LABELS = { 1: '15-min (9:30)', 2: '30-min (9:46)', 3: '45-min (10:01)' };
// nifty_alignment removed from permanent — Nifty direction changes throughout morning,
// a 9:30 AM relief rally doesn't invalidate the thesis at 9:46 or 10:01
const PERMANENT_FAIL_CHECKS = ['gap_check', 'gap_direction', 'no_orb_data'];

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
// MAIN ORCHESTRATOR — 8:40 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run daily picks scan, enrich, score, save, and notify.
 * Called at 8:40 AM IST before market open.
 */
async function runDailyPicks(options = {}) {
  const { dryRun = false, allowOutdatedCandle = false } = options;
  const startTime = Date.now();

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Starting daily picks scan${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`${LOG} ════════════════════════════════════════`);

  // Reset circuit breaker and intel cache at start of new trading day
  resetCircuitBreaker();
  clearIntelCache();

  try {
    // NOTE: Global intel now runs AFTER ChartInk scans + enrichment + scoring + levels
    // so we can pass viable candidate symbols for stock-specific Indian market analysis.
    // See Step 5.5 below.

    // Step 1: Market context (regime + SGX Nifty combined)
    const marketContext = await getMarketContext({ allowOutdatedCandle });
    console.log(`${LOG} Market regime: ${marketContext.regime} (structure: ${marketContext.structure_regime})`);

    // CONFLICT regime = structure bearish + SGX green → SIT OUT entirely
    if (marketContext.regime === 'CONFLICT') {
      console.log(`${LOG} ⛔ CONFLICT REGIME — structure bearish but SGX bullish. Sitting out today.`);
      const doc = await saveToDB(marketContext, [], { candidates: [], bullish_count: 0, bearish_count: 0 });
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc, halted: true, reason: 'CONFLICT regime — mixed signals, sitting out' };
    }

    // Step 2: Run scans based on regime
    const scanResult = await runScans(marketContext);
    console.log(`${LOG} Total candidates: ${scanResult.candidates.length} (${scanResult.bullish_count}B / ${scanResult.bearish_count}Be)`);

    if (scanResult.candidates.length === 0) {
      console.log(`${LOG} No candidates found. Saving empty doc and notifying.`);
      const doc = await saveToDB(marketContext, [], scanResult);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 2.5: Earnings/event filter — remove stocks with upcoming board meetings
    // Runs BEFORE enrichment to avoid wasting Upstox API calls on stocks we'll discard
    const { filtered: earningsFiltered, removed: earningsRemoved } = await filterEarningsStocks(scanResult.candidates);
    if (earningsRemoved.length > 0) {
      console.log(`${LOG} [Step 2.5] Earnings filter: ${earningsRemoved.length} removed (${earningsRemoved.map(r => r.symbol).join(', ')}), ${earningsFiltered.length} remaining`);
    }

    if (earningsFiltered.length === 0) {
      console.log(`${LOG} All candidates removed by earnings filter. Saving empty doc.`);
      const doc = await saveToDB(marketContext, [], scanResult);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 3: Enrich with OHLCV + indicators
    const enriched = await enrichCandidates(earningsFiltered);
    console.log(`${LOG} Enriched ${enriched.length}/${earningsFiltered.length} candidates`);

    if (enriched.length === 0) {
      console.log(`${LOG} All candidates failed enrichment. Saving empty doc.`);
      const doc = await saveToDB(marketContext, [], scanResult);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 4: Score candidates (sorted by score descending, filtered by MIN_SCORE)
    // NOTE: News + sector sentiment from global intel is applied AFTER scoring at Step 5.5,
    // once we have viable candidates to pass to Claude for stock-specific analysis.
    const scored = scoreCandidates(enriched, marketContext.regime);
    console.log(`${LOG} Scored: ${scored.length} candidates passed min (${MIN_SCORE})`);

    if (scored.length === 0) {
      console.log(`${LOG} No picks above minimum score.`);
      const doc = await saveToDB(marketContext, [], scanResult, []);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 5: Evaluate ALL scored candidates through the levels engine,
    // then select top MAX_DAILY_PICKS with scan-type diversity.
    console.log(`${LOG} [Step 5] Evaluating all ${scored.length} scored candidates through levels engine...`);
    const allViable = [];
    const candidatesReview = [];
    let rejectedCount = 0;
    const rejectionReasons = {};
    for (let i = 0; i < scored.length; i++) {
      const candidate = scored[i];
      const _ohlcv = candidate._ohlcv;
      console.log(`${LOG} [Step 5] --- Candidate ${i + 1}/${scored.length}: ${candidate.symbol} (${candidate.scan_type}, score=${candidate.rank_score}) ---`);

      // Base review entry with candle + indicator data
      const reviewEntry = {
        symbol: candidate.symbol,
        scan_type: candidate.scan_type,
        direction: candidate.direction,
        rank_score: candidate.rank_score,
        candle: {
          open: _ohlcv.open,
          high: _ohlcv.high,
          low: _ohlcv.low,
          close: _ohlcv.close,
          prev_close: _ohlcv.prev_close,
          volume: _ohlcv.volume
        },
        indicators: {
          ema20: _ohlcv.ema20,
          atr: _ohlcv.atr,
          rsi: _ohlcv.rsi
        },
        levels: null,
        status: null,
        rejection_reason: null
      };

      // ═══════════════════════════════════════════════════════════════════════
      // CONFLICT CHECK GATE: Reject if 1H structure blocks the trade
      // LONG: reject if resistance zone within 2% above PDH (entry zone)
      // SHORT: reject if support zone within 2% below PDL (entry zone)
      // ═══════════════════════════════════════════════════════════════════════
      const conflictResult = check1HStructuralConflict(candidate);
      if (conflictResult.rejected) {
        rejectedCount++;
        const scanType = candidate.scan_type;
        rejectionReasons[scanType] = (rejectionReasons[scanType] || 0) + 1;
        reviewEntry.status = 'rejected_conflict';
        reviewEntry.rejection_reason = conflictResult.reason;
        candidatesReview.push(reviewEntry);
        console.log(`${LOG} [Step 5] ${candidate.symbol}: REJECTED by conflict check (${rejectedCount} rejected so far)`);
        continue;
      }

      const withLevels = calculateLevels(candidate);
      if (withLevels) {
        reviewEntry.status = 'viable';
        reviewEntry.levels = {
          entry: withLevels.levels.entry,
          stop: withLevels.levels.stop,
          target: withLevels.levels.target,
          risk_pct: withLevels.levels.risk_pct,
          risk_reward: withLevels.levels.risk_reward,
          target_basis: withLevels.levels.target2_basis || withLevels.levels.mode,
          mode: withLevels.levels.mode
        };
        candidatesReview.push(reviewEntry);
        allViable.push(withLevels);
        console.log(`${LOG} [Step 5] ${candidate.symbol}: VIABLE (${allViable.length} viable so far)`);
      } else {
        rejectedCount++;
        const scanType = candidate.scan_type;
        rejectionReasons[scanType] = (rejectionReasons[scanType] || 0) + 1;
        reviewEntry.status = 'rejected_levels';
        reviewEntry.rejection_reason = candidate._lastRejectionReason || 'Levels engine rejected';
        candidatesReview.push(reviewEntry);
        console.log(`${LOG} [Step 5] ${candidate.symbol}: REJECTED — ${candidate._lastRejectionReason || 'unknown reason'} (${rejectedCount} rejected so far)`);
      }
    }
    console.log(`${LOG} [Step 5] Engine results: ${allViable.length} viable, ${rejectedCount} rejected out of ${scored.length} scored`);
    if (rejectedCount > 0) {
      console.log(`${LOG} [Step 5] Rejections by scan type: ${Object.entries(rejectionReasons).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    if (allViable.length > 0) {
      console.log(`${LOG} [Step 5] Viable candidates: ${allViable.map(v => `${v.symbol}(${v.scan_type}:${v.rank_score})`).join(', ')}`);
    }

    // ── Step 5.5: Global Market Intelligence — NOW with viable candidate symbols ──
    // ChartInk scans → enrich → score → levels → VIABLE candidates → pass to intel
    // Claude gets the exact stock list and returns India-focused, stock-specific analysis.
    const viableSymbols = allViable.map(v => v.symbol);
    console.log(`${LOG} [Step 5.5] Fetching global intel with ${viableSymbols.length} viable candidate symbols...`);
    let globalIntel;
    try {
      globalIntel = await fetchGlobalMarketIntel(undefined, viableSymbols, marketContext.sgx_data);
    } catch (intelErr) {
      console.error(`${LOG} ❌ Global intel FAILED — stopping pipeline: ${intelErr.message}`);
      try {
        const adminUserId = kiteConfig.ADMIN_USER_ID;
        if (adminUserId) {
          await firebaseService.sendToUser(adminUserId,
            'Daily Picks: Global Intel FAILED',
            `Pipeline stopped — global market intel fetch failed: ${intelErr.message}`,
            { type: 'DAILY_PICKS', route: '/daily-picks' }
          );
        }
      } catch { /* notification failure is non-critical */ }
      const doc = await saveToDB(marketContext, [], scanResult, candidatesReview, null);
      return { success: false, picks: 0, doc, error: `Global intel failed: ${intelErr.message}` };
    }

    // Check if we should avoid trading entirely (budget day, RBI policy, global crisis)
    const avoidCheck = shouldAvoidTrading();
    if (avoidCheck.avoid) {
      console.log(`${LOG} ⛔ TRADING HALTED: ${avoidCheck.reason}`);
      console.log(`${LOG} Saving empty doc — no trades today.`);
      const emptyContext = { ...marketContext, intel_halt: avoidCheck.reason };
      const doc = await saveToDB(emptyContext, [], scanResult, candidatesReview, globalIntel);
      await sendNotification(emptyContext, [], doc);
      return { success: true, picks: 0, doc, halted: true };
    }

    // Attach global intel to market context for downstream use
    marketContext.global_intel = {
      market_mood: globalIntel.market_mood,
      risk_level: globalIntel.risk_level,
      sgx_indication: globalIntel.sgx_nifty?.indication || null,
      trading_recommendation: globalIntel.trading_recommendation,
      sectors: globalIntel.sectors,
      fetched_at: globalIntel.fetched_at
    };
    if (globalIntel.market_mood) {
      marketContext.news_mood = globalIntel.market_mood;
    }

    // Get trading adjustments (reduce size, avoid direction, etc.)
    const tradingAdj = getTradingAdjustment();
    if (tradingAdj.avoidDirection) {
      console.log(`${LOG} [Step 5.5] Trading adjustment: avoid ${tradingAdj.avoidDirection}, size: ${tradingAdj.sizeMultiplier}x`);
    }

    // Direction filter — if intel says AVOID_SHORTS or AVOID_LONGS, remove from viable
    if (tradingAdj.avoidDirection && tradingAdj.avoidDirection !== 'ALL') {
      const before = allViable.length;
      const removed = allViable.filter(c => c.direction === tradingAdj.avoidDirection);
      for (let i = allViable.length - 1; i >= 0; i--) {
        if (allViable[i].direction === tradingAdj.avoidDirection) allViable.splice(i, 1);
      }
      if (removed.length > 0) {
        console.log(`${LOG} [Step 5.5] Direction filter: removed ${removed.length} ${tradingAdj.avoidDirection} candidates (${removed.map(r => r.symbol).join(', ')})`);
      }
      if (allViable.length === 0) {
        console.log(`${LOG} [Step 5.5] ⚠️ Direction filter removed ALL viable candidates — no picks possible today`);
      }
    }

    // Sector sentiment score adjustments from intel (uses shared constants)
    if (globalIntel.sectors && Object.keys(globalIntel.sectors).length > 0) {
      let boosted = 0, penalized = 0;
      for (const pick of allViable) {
        const sector = getStockSector(pick.symbol);
        const sectorKey = mapSectorToIntelKey(sector);
        const sectorIntel = globalIntel.sectors[sectorKey];
        if (sectorIntel) {
          if (sectorIntel.sentiment === 'BULLISH' && pick.direction === 'LONG') { pick.rank_score += INTEL_SECTOR_ALIGNED; boosted++; }
          if (sectorIntel.sentiment === 'BEARISH' && pick.direction === 'SHORT') { pick.rank_score += INTEL_SECTOR_ALIGNED; boosted++; }
          if (sectorIntel.sentiment === 'BEARISH' && pick.direction === 'LONG') { pick.rank_score += INTEL_SECTOR_OPPOSING; penalized++; }
          if (sectorIntel.sentiment === 'BULLISH' && pick.direction === 'SHORT') { pick.rank_score += INTEL_SECTOR_OPPOSING; penalized++; }
        }
      }
      if (boosted > 0 || penalized > 0) {
        console.log(`${LOG} [Step 5.5] Sector intel adjustments: ${boosted} boosted (+${INTEL_SECTOR_ALIGNED}), ${penalized} penalized (${INTEL_SECTOR_OPPOSING})`);
      }
    }

    // Stock-specific news adjustments (uses shared constants)
    if (globalIntel.stock_specific && Object.keys(globalIntel.stock_specific).length > 0) {
      for (const pick of allViable) {
        const news = globalIntel.stock_specific[pick.symbol] || globalIntel.stock_specific[pick.symbol?.toUpperCase()];
        if (news) {
          const isBullish = pick.direction === 'LONG';
          const aligned = (isBullish && news.sentiment === 'BULLISH') || (!isBullish && news.sentiment === 'BEARISH');
          const opposing = (isBullish && news.sentiment === 'BEARISH') || (!isBullish && news.sentiment === 'BULLISH');
          if (news.impact === 'HIGH') {
            if (aligned) pick.rank_score += INTEL_STOCK_NEWS_ALIGNED_HIGH;
            else if (opposing) pick.rank_score += INTEL_STOCK_NEWS_OPPOSING_HIGH;
          }
          console.log(`${LOG} [Step 5.5] Stock news: ${pick.symbol} — ${news.headline} (${news.sentiment}, ${news.impact})${aligned ? ` → +${INTEL_STOCK_NEWS_ALIGNED_HIGH}` : opposing ? ` → ${INTEL_STOCK_NEWS_OPPOSING_HIGH}` : ''}`);
        }
      }
    }

    // Re-sort viable by adjusted score after intel adjustments
    allViable.sort((a, b) => b.rank_score - a.rank_score);
    console.log(`${LOG} [Step 5.5] Intel done: mood=${globalIntel.market_mood} risk=${globalIntel.risk_level} rec=${globalIntel.trading_recommendation}`);
    if (allViable.length > 0) {
      console.log(`${LOG} [Step 5.5] Adjusted viable: ${allViable.map(v => `${v.symbol}(${v.rank_score})`).join(', ')}`);
    }

    // Select top picks with scan-type diversity:
    // Pick the best from each scan type first, then fill remaining slots by score.
    // Use combined regime's maxTrades if available, otherwise fall back to MAX_DAILY_PICKS
    const maxPicksToday = marketContext.max_trades != null ? Math.min(marketContext.max_trades, MAX_DAILY_PICKS) : MAX_DAILY_PICKS;
    console.log(`${LOG} [Step 6] Max picks today: ${maxPicksToday} (regime=${marketContext.regime}, cap=${MAX_DAILY_PICKS})`);
    const picksWithLevels = selectDiversePicks(allViable, maxPicksToday);
    console.log(`${LOG} Selected ${picksWithLevels.length} picks (diversity-weighted) from ${allViable.length} viable`);

    // Sync candidatesReview with intel-adjusted scores and mark selected picks
    const selectedSymbols = new Set(picksWithLevels.map(p => p.symbol));
    const viableScoreMap = {};
    for (const v of allViable) viableScoreMap[v.symbol] = v.rank_score;
    for (const entry of candidatesReview) {
      // Update rank_score to reflect intel adjustments (sector/stock news ±)
      if (viableScoreMap[entry.symbol] !== undefined) {
        entry.rank_score = viableScoreMap[entry.symbol];
      }
      if (entry.status === 'viable' && selectedSymbols.has(entry.symbol)) {
        entry.status = 'selected';
      }
    }

    if (picksWithLevels.length === 0) {
      console.log(`${LOG} All ${scored.length} candidates rejected by engine (no viable R:R). Saving empty doc.`);
      const doc = await saveToDB(marketContext, [], scanResult, candidatesReview, globalIntel);
      await sendNotification(marketContext, [], doc);
      return { success: true, picks: 0, doc };
    }

    // Step 6: Generate AI insights (non-fatal)
    console.log(`${LOG} [Step 6] Generating AI insights for ${picksWithLevels.length} picks: ${picksWithLevels.map(p => p.symbol).join(', ')}`);
    const picksWithInsights = await generatePickInsights(picksWithLevels, marketContext);
    console.log(`${LOG} [Step 6] AI insights done: ${picksWithInsights.filter(p => p.ai_generated).length}/${picksWithInsights.length} generated`);

    // Step 7: Save to DB (includes full global intel snapshot)
    console.log(`${LOG} [Step 7] Saving to DB: ${picksWithInsights.length} picks`);
    const doc = await saveToDB(marketContext, picksWithInsights, scanResult, candidatesReview, globalIntel);
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

    // Send push notification on pipeline failure
    try {
      const adminUserId = kiteConfig.ADMIN_USER_ID;
      if (adminUserId) {
        await firebaseService.sendToUser(adminUserId,
          'Daily Picks: PIPELINE FAILED',
          error.message,
          { type: 'DAILY_PICKS_ERROR', route: '/daily-picks' }
        );
        console.log(`${LOG} Failure notification sent`);
      }
    } catch (notifErr) {
      console.error(`${LOG} Failure notification also failed:`, notifErr.message);
    }

    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: MARKET CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════

async function getMarketContext({ allowOutdatedCandle = false } = {}) {
  console.log(`${LOG} [Step 1] Fetching market context (regime + SGX Nifty)...`);

  // Fetch structure (Nifty vs 50 EMA) and sentiment (SGX/GIFT Nifty) in parallel
  // Both are critical — if either fails, pipeline halts
  const [regimeResult, sgxData] = await Promise.all([
    fetchAndCheckRegime({ allowOutdated: allowOutdatedCandle }),
    fetchSGXNiftyData()
  ]);

  const { regime: structureRegime, niftyLast, ema50, distancePct } = regimeResult;
  console.log(`${LOG} Structure: ${structureRegime} (Nifty: ${niftyLast}, EMA50: ${ema50}, dist: ${distancePct}%)`);
  console.log(`${LOG} Sentiment: SGX/GIFT Nifty change=${sgxData.change_pct}% price=${sgxData.last_price}`);

  // Combine structure + sentiment into a single regime
  const combined = getCombinedRegime(niftyLast, ema50, sgxData.change_pct);

  console.log(`${LOG} ═══════════════════════════════════════`);
  console.log(`${LOG} Combined Regime: ${combined.regime} (structure=${structureRegime}, sgx=${sgxData.change_pct}%)`);
  console.log(`${LOG} Size multiplier: ${combined.sizeMultiplier}x | Max trades: ${combined.maxTrades}`);
  console.log(`${LOG} ═══════════════════════════════════════`);

  return {
    regime: combined.regime,
    structure_regime: structureRegime,
    nifty_prev_close: niftyLast,
    distance_pct: distancePct,
    ema50,
    sgx_data: sgxData,
    size_multiplier: combined.sizeMultiplier,
    max_trades: combined.maxTrades,
    decided_at: new Date()
  };
}

/**
 * Combine structure (Nifty vs 50 EMA) + sentiment (GIFT Nifty change%)
 * into a single regime with position sizing guidance.
 *
 * Structure = GATE (which direction is allowed)
 * Sentiment = MODIFIER (confidence/sizing)
 *
 * 0.3% threshold for GIFT Nifty — Indian pre-market is less volatile.
 */
function getCombinedRegime(niftyClose, ema50, giftNiftyChangePct) {
  if (!niftyClose || !ema50) {
    throw new Error('Nifty structure data (close + EMA50) is critical — cannot determine regime');
  }

  const structureBull = niftyClose > ema50 * 1.003;
  const structureBear = niftyClose < ema50 * 0.997;
  const sentimentBull = giftNiftyChangePct > 0.3;
  const sentimentBear = giftNiftyChangePct < -0.3;

  if (structureBull && sentimentBull) {
    return { regime: 'STRONG_BULL', sizeMultiplier: 1.0, maxTrades: 3 };
  }
  if (structureBull && sentimentBear) {
    return { regime: 'WEAK_BULL', sizeMultiplier: 0.6, maxTrades: 2 };
  }
  if (structureBear && sentimentBear) {
    return { regime: 'STRONG_BEAR', sizeMultiplier: 1.0, maxTrades: 3 };
  }
  if (structureBear && sentimentBull) {
    return { regime: 'CONFLICT', sizeMultiplier: 0.0, maxTrades: 0 };
  }
  // Structure has direction but SGX is flat (between -0.3% and +0.3%)
  if (structureBull) {
    return { regime: 'WEAK_BULL', sizeMultiplier: 0.6, maxTrades: 2 };
  }
  if (structureBear) {
    return { regime: 'WEAK_BEAR', sizeMultiplier: 0.6, maxTrades: 2 };
  }
  // True NEUTRAL: structure near EMA + sentiment flat
  return { regime: 'NEUTRAL', sizeMultiplier: 0.5, maxTrades: 1 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: RUN CHARTINK SCANS
// ═══════════════════════════════════════════════════════════════════════════════

async function runScans(marketContext) {
  const { regime } = marketContext;
  const scanOrder = SCAN_ORDER_BY_REGIME[regime];

  console.log(`${LOG} [Step 2] Running ${scanOrder.length} scans for ${regime} regime: ${scanOrder.join(', ')}`);

  // DEBUG: Force specific stock for testing (enable via FORCE_CONDITIONS_MET=true)
  // if (process.env.FORCE_CONDITIONS_MET === 'true') {
  //   console.log(`${LOG} [DEBUG] FORCE_CONDITIONS_MET=true — returning EMUDHRA only`);
  //   return {
  //     candidates: [{
  //       symbol: 'EMUDHRA',
  //       stock_name: 'eMudhra Ltd',
  //       scan_type: 'fiftyTwoWeek_low',
  //       direction: 'SHORT',
  //       chartink_data: {
  //         per_change: -9.5,
  //         close: 443.6,
  //         volume: 1500000
  //       }
  //     }],
  //     bullish_count: 0,
  //     bearish_count: 1
  //   };
  // }

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

  // NEUTRAL cross-direction dedup: if same stock appears in both bullish and
  // bearish scans, it has no directional conviction — remove it
  if (regime === 'NEUTRAL' && candidates.length > 0) {
    const longSymbols = new Set(candidates.filter(c => c.direction === 'LONG').map(c => c.symbol));
    const shortSymbols = new Set(candidates.filter(c => c.direction === 'SHORT').map(c => c.symbol));
    const conflicted = [...longSymbols].filter(s => shortSymbols.has(s));
    if (conflicted.length > 0) {
      console.log(`${LOG} [Step 2] NEUTRAL cross-direction dedup: removing ${conflicted.length} conflicted stocks (${conflicted.join(', ')})`);
      const conflictedSet = new Set(conflicted);
      const before = candidates.length;
      for (let i = candidates.length - 1; i >= 0; i--) {
        if (conflictedSet.has(candidates[i].symbol)) {
          if (candidates[i].direction === 'LONG') bullishCount--;
          else bearishCount--;
          candidates.splice(i, 1);
        }
      }
      console.log(`${LOG} [Step 2] Removed ${before - candidates.length} candidates, ${candidates.length} remaining`);
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
  const symbols = candidates.map(c => c.symbol);
  console.log(`${LOG} [Step 3] Enriching ${symbols.length} candidates: ${symbols.join(', ')}`);

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

  const missingSymbols = symbols.filter(s => !stockMap[s]);
  if (missingSymbols.length > 0) {
    console.log(`${LOG} [Step 3] Missing from enrichment: ${missingSymbols.join(', ')}`);
  }

  const enriched = [];
  for (const candidate of candidates) {
    const stock = stockMap[candidate.symbol];
    if (!stock || !stock.instrument_key) {
      console.log(`${LOG} [Step 3] ${candidate.symbol}: SKIPPED — no enrichment data`);
      continue;
    }

    // Calculate scan scores
    const high = stock.high || 0;
    const low = stock.low || 0;
    const close = stock.ltp || stock.prev_close || 0;
    const open = stock.open || 0;
    const range = high - low;

    const closeInRangePct = range > 0 ? ((close - low) / range) * 100 : 50;
    const effectiveVolume = stock.todays_volume > 0 ? stock.todays_volume : (candidate.chartink_data?.volume || 0);
    const volumeRatio = stock.avg_volume_50d > 0
      ? effectiveVolume / stock.avg_volume_50d
      : 1;
    const atrPct = close > 0 ? (range / close) * 100 : 0;

    const prevClose = stock.prev_close || 0;
    const prevHigh = high;
    const prevLow = low;
    const candlePattern = detectCandlePattern(open, high, low, close, 0, prevHigh, prevLow, prevClose);
    const lastDailyClose = stock.last_daily_close || close;
    const volSource = stock.todays_volume > 0 ? 'live' : 'chartink';

    // Single compact debug line — compare across runs to spot divergence
    console.log(`${LOG} [ENRICH-DEBUG] ${candidate.symbol} (${candidate.scan_type}/${candidate.direction}): src=${stock.data_source || 'N/A'} O=${open} H=${high} L=${low} C=${close} prevC=${prevClose} | vol=${effectiveVolume}(${volSource}) avgVol50=${stock.avg_volume_50d} ratio=${round2(volumeRatio)}x | RSI=${stock.daily_rsi} EMA20=${stock.ema20 || 0} ATR=${round2(atrPct)}% CIR=${round2(closeInRangePct)}% candle=${candlePattern}`);

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
      _ohlcv: {
        open,
        high,
        low,
        close,
        prev_close: prevClose,
        last_daily_close: lastDailyClose,
        volume: stock.todays_volume || 0,
        avg_volume_50d: stock.avg_volume_50d || 0,
        ema20: stock.ema20 || 0,
        ema50: stock.ema50 || 0,
        atr: stock.atr || 0,
        high_5d: stock.high_5d || 0,
        low_5d: stock.low_5d || 0,
        high_10d: stock.high_10d || 0,
        low_10d: stock.low_10d || 0,
        high_20d: stock.high_20d || 0,
        low_20d: stock.low_20d || 0,
        high_52w: stock.high_52w || 0,
        daily_pivot_levels: stock.daily_pivot_levels || null,
        weekly_pivot_levels: {
          r1: stock.weekly_r1 || null,
          r2: stock.weekly_r2 || null,
          s1: stock.weekly_s1 || null,
          s2: stock.weekly_s2 || null
        },
        hourly_1h_pivots: stock.hourly_1h_pivots || null,
        hourly_4h_pivots: stock.hourly_4h_pivots || null,
        swing_levels_1h: stock.swing_levels_1h || null,
        // Multi-timeframe: weekly trend confirmation
        weekly_ema20: stock.weekly_ema20 || 0,
        weekly_close: stock.weekly_close || 0,
        weekly_trend_bullish: stock.weekly_trend_bullish
      }
    });
  }

  console.log(`${LOG} [Step 3] Enriched ${enriched.length}/${candidates.length} (${candidates.length - enriched.length} missing)`);

  return enriched;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1H STRUCTURAL CONFLICT CHECK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Hard gate: reject candidates where 1H structure blocks the trade direction.
 * LONG: reject if any resistance zone midpoint is within 1% above PDH (entry zone)
 * SHORT: reject if any support zone midpoint is within 1% below PDL (entry zone)
 *
 * Uses PDH/PDL as approximate entry (not close) since that's where entries trigger.
 *
 * @returns {{ rejected: boolean, reason?: string }}
 */
function check1HStructuralConflict(candidate) {
  const ohlcv = candidate._ohlcv;
  if (!ohlcv?.swing_levels_1h) return { rejected: false };

  const { resistanceZones = [], supportZones = [] } = ohlcv.swing_levels_1h;
  const sym = candidate.symbol;
  const isLong = candidate.direction === 'LONG';

  // ATR-aware conflict threshold: max(0.5×ATR, 1% of price) — adapts to volatility.
  // On high-ATR days, a fixed 2% can be within normal noise. Using 0.5×ATR
  // gives wider breathing room for volatile stocks while keeping tight for low-vol.
  const atr = ohlcv.atr || 0;

  if (isLong) {
    const pdh = ohlcv.high;
    const conflictBuffer = Math.max(0.5 * atr, pdh * 0.01);
    const conflictZone = resistanceZones.find(z => z.midpoint > pdh && z.midpoint <= pdh + conflictBuffer);
    if (conflictZone) {
      const distPct = round2(((conflictZone.midpoint - pdh) / pdh) * 100);
      const reason = `1H structural conflict: resistance at ₹${round2(conflictZone.midpoint)} within ${distPct}% above entry zone (PDH ₹${round2(pdh)}, threshold=0.5×ATR ₹${round2(conflictBuffer)})`;
      console.log(`${LOG} [ConflictCheck] ${sym}: REJECTED — ${reason}`);
      return { rejected: true, reason };
    }
  } else {
    const pdl = ohlcv.low;
    const conflictBuffer = Math.max(0.5 * atr, pdl * 0.01);
    const conflictZone = supportZones.find(z => z.midpoint < pdl && z.midpoint >= pdl - conflictBuffer);
    if (conflictZone) {
      const distPct = round2(((pdl - conflictZone.midpoint) / pdl) * 100);
      const reason = `1H structural conflict: support at ₹${round2(conflictZone.midpoint)} within ${distPct}% below entry zone (PDL ₹${round2(pdl)}, threshold=0.5×ATR ₹${round2(conflictBuffer)})`;
      console.log(`${LOG} [ConflictCheck] ${sym}: REJECTED — ${reason}`);
      return { rejected: true, reason };
    }
  }

  console.log(`${LOG} [ConflictCheck] ${sym}: PASSED — no 1H structural conflict`);
  return { rejected: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 4: SCORE CANDIDATES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 1H stop validation bonus.
 * Checks if any 1H swing level clusters within 0.5% of the PDH/PDL stop level.
 * If a 1H swing level confirms the stop zone, the setup gets +5 score bonus.
 *
 * LONG: checks if any swing low clusters near PDL (the stop zone)
 * SHORT: checks if any swing high clusters near PDH (the stop zone)
 *
 * @returns {{ bonus: number, detail: string }}
 */
function calculateConfluence(candidate) {
  const THRESHOLD = 0.005; // 0.5% cluster distance
  const BONUS_PTS = 5;
  const sym = candidate.symbol;

  const ohlcv = candidate._ohlcv;
  if (!ohlcv) return { bonus: 0, detail: 'no ohlcv' };

  const swingLevels = ohlcv.swing_levels_1h;
  if (!swingLevels) {
    console.log(`${LOG} [Confluence] ${sym}: skip — no 1H swing levels`);
    return { bonus: 0, detail: 'no 1H swing levels' };
  }

  const isLong = candidate.direction === 'LONG';

  if (isLong) {
    // LONG: check if any swing low clusters near PDL (stop zone)
    const pdl = ohlcv.low;
    const { supportZones = [] } = swingLevels;
    const match = supportZones.find(z => {
      const dist = Math.abs(z.midpoint - pdl) / pdl;
      return dist <= THRESHOLD;
    });
    if (match) {
      const dist = Math.abs(match.midpoint - pdl) / pdl;
      const detail = `1H swing low at ${round2(match.midpoint)} confirms PDL stop at ${round2(pdl)} (${round2(dist * 100)}%)`;
      console.log(`${LOG} [Confluence] ${sym}: +${BONUS_PTS} pts — ${detail}`);
      return { bonus: BONUS_PTS, detail };
    }
  } else {
    // SHORT: check if any swing high clusters near PDH (stop zone)
    const pdh = ohlcv.high;
    const { resistanceZones = [] } = swingLevels;
    const match = resistanceZones.find(z => {
      const dist = Math.abs(z.midpoint - pdh) / pdh;
      return dist <= THRESHOLD;
    });
    if (match) {
      const dist = Math.abs(match.midpoint - pdh) / pdh;
      const detail = `1H swing high at ${round2(match.midpoint)} confirms PDH stop at ${round2(pdh)} (${round2(dist * 100)}%)`;
      console.log(`${LOG} [Confluence] ${sym}: +${BONUS_PTS} pts — ${detail}`);
      return { bonus: BONUS_PTS, detail };
    }
  }

  console.log(`${LOG} [Confluence] ${sym}: no stop validation — no 1H swing near ${isLong ? 'PDL' : 'PDH'}`);
  return { bonus: 0, detail: 'no stop validation' };
}

/**
 * Check if a candidate's direction aligns with the current regime for score bonus.
 *
 * Only normal BULLISH/BEARISH qualify for the +5 bonus:
 * - STRONG_BULLISH/STRONG_BEARISH: no bonus needed — counter-regime scans are already
 *   hard-blocked at the scan selection level, so all surviving candidates are aligned.
 * - NEUTRAL/UNKNOWN: no directional bias, no bonus.
 */
function isRegimeAligned(direction, regime) {
  if (regime === 'BULLISH' && direction === 'LONG') return true;
  if (regime === 'BEARISH' && direction === 'SHORT') return true;
  // Combined regime types
  if (regime === 'STRONG_BULL' && direction === 'LONG') return true;
  if (regime === 'WEAK_BULL' && direction === 'LONG') return true;
  if (regime === 'WEAK_BEAR' && direction === 'SHORT') return true;
  if (regime === 'STRONG_BEAR' && direction === 'SHORT') return true;
  return false;
}

function scoreCandidates(enrichedCandidates, regime) {
  console.log(`${LOG} [Step 4] Scoring ${enrichedCandidates.length} candidates (regime: ${regime})...`);

  const scored = [];
  let ema20Skipped = 0, ema20Penalized = 0, belowMinScore = 0, passedCount = 0, regimeBonusCount = 0;
  let weeklyAlignedCount = 0, weeklyContraCount = 0;
  let vol5Count = 0, vol10Count = 0, vol15Count = 0, vol20Count = 0, vol25Count = 0;

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
    if (s.volume_ratio > 3) { volPts = 25; vol25Count++; }
    else if (s.volume_ratio > 2) { volPts = 20; vol20Count++; }
    else if (s.volume_ratio > 1.5) { volPts = 15; vol15Count++; }
    else if (s.volume_ratio > 1.2) { volPts = 10; vol10Count++; }
    else { volPts = 5; vol5Count++; }
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

    // EMA20 extension filter — directional: only penalize if chasing in trade direction
    // LONG 3%+ above EMA20 = chasing momentum → skip
    // SHORT 3%+ below EMA20 = chasing momentum → skip
    // LONG below EMA20 = pullback (fine), SHORT above EMA20 = bounce short (fine)
    // 52W scans exempt — they are inherently extended by definition
    const is52wScan = c.scan_type === 'fiftyTwoWeek_high' || c.scan_type === 'fiftyTwoWeek_low';
    const ema20 = c._ohlcv?.ema20;
    if (ema20 && ema20 > 0 && !is52wScan) {
      const rawDist = round2(((c._ohlcv.close - ema20) / ema20) * 100); // positive = above, negative = below
      const isChasing = (c.direction === 'LONG' && rawDist > 0) || (c.direction === 'SHORT' && rawDist < 0);
      const absDist = Math.abs(rawDist);

      if (isChasing && absDist >= 3.0) {
        ema20Skipped++;
        console.log(`${LOG} ❌ ${c.symbol} (${c.scan_type}/${c.direction}): SKIPPED — ${rawDist}% from EMA20 (chasing, >= 3%)`);
        continue;
      }
      if (isChasing && absDist >= 2.0) {
        ema20Penalized++;
        score -= 15;
        console.log(`${LOG} ⚠️ ${c.symbol}: -15 pts EMA20 chasing (${rawDist}% from EMA20)`);
      }
    }

    if (score >= MIN_SCORE) {
      passedCount++;
      const pick = { ...c, rank_score: score };
      console.log(`${LOG} ✅ ${c.symbol} (${c.scan_type}/${c.direction}): score=${score} [CIR:${cirPts}/25(${round2(cir)}%) VOL:${volPts}/25(${s.volume_ratio}x) RSI:${rsiPts}/20(${s.rsi}) ATR:${atrPts}/15(${s.atr_pct}%) CANDLE:${candlePts}/15(${s.candle_pattern})]`);

      // Confluence bonus: cluster detection across Daily / 1H / 4H pivots
      // Applied AFTER MIN_SCORE check — additive only (never reduces score)
      const confluenceResult = calculateConfluence(c);
      if (confluenceResult.bonus > 0) {
        pick.rank_score += confluenceResult.bonus;
        pick.confluence_score = confluenceResult.bonus;
        pick.confluence_detail = confluenceResult.detail;
        console.log(`${LOG}   ↳ Confluence: +${confluenceResult.bonus} pts (${confluenceResult.detail})`);
      }

      // Scan priority bonus: rewards stocks caught by higher-priority scans
      // Only applies in STRONG regimes where scan order encodes conviction
      const scanBonus = SCAN_PRIORITY_BONUS[regime]?.[c.scan_type] ?? 0;
      if (scanBonus > 0) {
        pick.rank_score += scanBonus;
        pick.scan_priority_bonus = scanBonus;
        console.log(`${LOG}   ↳ Scan priority: +${scanBonus} pts (${c.scan_type} in ${regime})`);
      }

      // Regime alignment bonus: +5 for direction matching regime
      if (isRegimeAligned(c.direction, regime)) {
        pick.rank_score += 5;
        pick.regime_bonus = 5;
        pick.regime_aligned = true;
        regimeBonusCount++;
        console.log(`${LOG}   ↳ Regime: +5 pts (${regime} regime, ${c.direction})`);
      } else if (regime && regime !== 'NEUTRAL' && regime !== 'UNKNOWN') {
        // Counter-regime trade — attach warning for position sizing
        // Map combined regime types back to structure regimes for warning lookup
        const warningRegime = regime === 'STRONG_BULL' ? 'STRONG_BULLISH'
          : regime === 'WEAK_BULL' ? 'BULLISH'
          : regime === 'WEAK_BEAR' ? 'BEARISH'
          : regime === 'STRONG_BEAR' ? 'STRONG_BEARISH'
          : regime;
        const setupType = c.direction === 'LONG' ? 'BUY' : 'SELL';
        const warning = getRegimeWarning(setupType, { regime: warningRegime, distancePct: 0 });
        if (warning) {
          pick.regime_warning = warning;
          pick.regime_aligned = false;
          console.log(`${LOG}   ↳ Regime WARNING: ${warning.code} (${warning.severity}) — ${c.direction} in ${regime} market`);
        }
      }

      // Multi-timeframe confirmation: weekly trend filter
      // LONG picks should have weekly close > weekly EMA20 (bullish weekly trend)
      // SHORT picks should have weekly close < weekly EMA20 (bearish weekly trend)
      const weeklyTrend = c._ohlcv?.weekly_trend_bullish;
      if (weeklyTrend !== null && weeklyTrend !== undefined) {
        const weeklyAligned = (c.direction === 'LONG' && weeklyTrend === true) ||
                              (c.direction === 'SHORT' && weeklyTrend === false);
        if (weeklyAligned) {
          pick.rank_score += 5;
          pick.weekly_trend_bonus = 5;
          weeklyAlignedCount++;
          console.log(`${LOG}   ↳ Weekly trend: +5 pts (${c.direction} aligned with weekly ${weeklyTrend ? 'bullish' : 'bearish'}, close=₹${c._ohlcv.weekly_close} vs EMA20=₹${c._ohlcv.weekly_ema20})`);
        } else {
          // Counter-weekly trade: penalize by 10 points — these have lower win rate
          pick.rank_score -= 10;
          pick.weekly_trend_penalty = -10;
          weeklyContraCount++;
          console.log(`${LOG}   ↳ Weekly trend: -10 pts (${c.direction} CONTRA weekly ${weeklyTrend ? 'bullish' : 'bearish'}, close=₹${c._ohlcv.weekly_close} vs EMA20=₹${c._ohlcv.weekly_ema20})`);
        }
      }

      // NOTE: News + sector sentiment adjustments are now applied at Step 5.5 (after intel fetch),
      // not here in scoring. This ensures intel has the candidate stock list for targeted search.

      scored.push(pick);
    } else {
      belowMinScore++;
      console.log(`${LOG} ❌ ${c.symbol} (${c.scan_type}/${c.direction}): score=${score} < ${MIN_SCORE} [CIR:${cirPts} VOL:${volPts} RSI:${rsiPts} ATR:${atrPts} CANDLE:${candlePts}]`);
    }
  }

  // Scoring reconciliation — every candidate must be accounted for
  const totalProcessed = passedCount + belowMinScore + ema20Skipped;
  console.log(`${LOG} [Step 4] RECONCILIATION: input=${enrichedCandidates.length} passed=${passedCount} belowMin=${belowMinScore} ema20Skip=${ema20Skipped} ema20Pen=${ema20Penalized} regimeBonus=${regimeBonusCount} weeklyAlign=${weeklyAlignedCount} weeklyContra=${weeklyContraCount} total=${totalProcessed}${totalProcessed !== enrichedCandidates.length ? ' ⚠️ MISMATCH' : ''}`);
  console.log(`${LOG} [Step 4] VOL distribution: 25pts=${vol25Count} 20pts=${vol20Count} 15pts=${vol15Count} 10pts=${vol10Count} 5pts=${vol5Count}`);

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

  console.log(`${LOG} [Levels] ┌─── ${symbol} LEVEL CALCULATION ───`);
  console.log(`${LOG} [Levels] │ direction=${direction} scan=${scan_type} score=${pick.rank_score}`);
  console.log(`${LOG} [Levels] │ _ohlcv: O=${_ohlcv.open} H=${_ohlcv.high} L=${_ohlcv.low} C=${_ohlcv.close} prevC=${_ohlcv.prev_close}`);
  console.log(`${LOG} [Levels] │ ⚠️ CRITICAL: _ohlcv.close (=${_ohlcv.close}) will become prevClose in scanLevels`);
  console.log(`${LOG} [Levels] │ ⚠️ For 52W scans: entry = prevClose = ${_ohlcv.close} — is this yesterday's close?`);
  console.log(`${LOG} [Levels] │ indicators: ema20=${_ohlcv.ema20} ema50=${_ohlcv.ema50} atr=${_ohlcv.atr}`);
  console.log(`${LOG} [Levels] │ swing: h5D=${_ohlcv.high_5d} l5D=${_ohlcv.low_5d} h10D=${_ohlcv.high_10d} l10D=${_ohlcv.low_10d} h20D=${_ohlcv.high_20d} l20D=${_ohlcv.low_20d} h52W=${_ohlcv.high_52w}`);
  console.log(`${LOG} [Levels] ${symbol}: pivots wR1=${_ohlcv.weekly_pivot_levels?.r1} wR2=${_ohlcv.weekly_pivot_levels?.r2} wS1=${_ohlcv.weekly_pivot_levels?.s1} wS2=${_ohlcv.weekly_pivot_levels?.s2} dP=${_ohlcv.daily_pivot_levels?.pivot} dR1=${_ohlcv.daily_pivot_levels?.r1} dR2=${_ohlcv.daily_pivot_levels?.r2} dS1=${_ohlcv.daily_pivot_levels?.s1} dS2=${_ohlcv.daily_pivot_levels?.s2}`);
  const swingLevels = _ohlcv.swing_levels_1h;
  console.log(`${LOG} [Levels] ${symbol}: 1H swings: resistanceZones=${swingLevels?.resistanceZones?.length || 0} [${(swingLevels?.resistanceZones || []).map(z => z.midpoint).join(',')}] supportZones=${swingLevels?.supportZones?.length || 0} [${(swingLevels?.supportZones || []).map(z => z.midpoint).join(',')}]`);

  // Prepare data for scanLevels engine
  const scanData = {
    // Core price levels (previous candle = last completed daily candle)
    prevHigh: _ohlcv.high,
    prevLow: _ohlcv.low,
    prevClose: _ohlcv.close,

    // Indicators
    ema20: _ohlcv.ema20,
    ema50: _ohlcv.ema50 || 0,
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
    previousDayHigh: _ohlcv.high,
    previousDayLow: _ohlcv.low,

    // Intraday flag — signals scanLevels to use daily pivots instead of weekly
    isIntraday: true,

    // Daily picks use relaxed R:R (1.2:1 vs swing's 1.5:1 for multi-day holds)
    minRR: 1.2,

    // 1H swing levels for structural targets
    resistanceZones: _ohlcv.swing_levels_1h?.resistanceZones || [],
    supportZones: _ohlcv.swing_levels_1h?.supportZones || [],

    // 1H pivot levels (R1/R2/S1/S2 from classic pivot formula on 1H candle)
    hourlyR1: _ohlcv.hourly_1h_pivots?.r1 || null,
    hourlyR2: _ohlcv.hourly_1h_pivots?.r2 || null,
    hourlyS1: _ohlcv.hourly_1h_pivots?.s1 || null,
    hourlyS2: _ohlcv.hourly_1h_pivots?.s2 || null
  };

  // Map daily picks scan type to engine archetype (e.g. breakout_setup → breakout)
  const archetype = SCAN_ARCHETYPE[scan_type] || scan_type;
  console.log(`${LOG} [Levels] │ scan_type="${scan_type}" → archetype="${archetype}"`);
  console.log(`${LOG} [Levels] │ scanData.prevClose=${scanData.prevClose} scanData.prevHigh=${scanData.prevHigh} scanData.prevLow=${scanData.prevLow}`);
  console.log(`${LOG} [Levels] │ scanData.atr=${scanData.atr} scanData.high52W=${scanData.high52W}`);

  // Call scanLevels engine with the mapped archetype
  console.log(`${LOG} [Levels] │ → calling scanLevels.calculateTradingLevels("${archetype}", scanData)...`);
  const result = scanLevels.calculateTradingLevels(archetype, scanData);
  console.log(`${LOG} [Levels] │ ← engine returned: valid=${result.valid} mode=${result.mode || 'N/A'}`);
  if (result.valid) {
    console.log(`${LOG} [Levels] │   entry=${result.entry} stop=${result.stop} target2=${result.target2} R:R=${result.riskReward} risk=${result.riskPercent}% reward=${result.rewardPercent}%`);
    console.log(`${LOG} [Levels] │   target1=${result.target1 || 'N/A'} target3=${result.target3 || 'N/A'} entryType=${result.entryType}`);
  } else {
    console.log(`${LOG} [Levels] │   REJECTED: ${result.reason}`);
  }
  console.log(`${LOG} [Levels] └────────────────────────────────────`);

  if (!result.valid) {
    console.log(`${LOG} [Levels] ${symbol}: REJECTED by scanLevels — ${result.reason}`);
    if (result.currentRR) console.log(`${LOG} [Levels] ${symbol}: currentRR=${result.currentRR} suggestedTarget=${result.suggestedTarget || 'N/A'}`);
    if (result.noData) console.log(`${LOG} [Levels] ${symbol}: noData=${result.noData} (missing indicator data)`);
    pick._lastRejectionReason = result.reason || 'Levels engine rejected';
    return null;
  }

  // Extract levels from scanLevels result
  const { entry, stop, target2: target, riskReward, riskPercent, rewardPercent, mode, reason } = result;

  // ═══════════════════════════════════════════════════════════════════════════
  // DAILY PICKS RISK CAP: 3% default, 5% for 52W scans
  // ═══════════════════════════════════════════════════════════════════════════
  // Daily picks are intraday MIS positions that force-close at 3 PM.
  // With PDH/PDL stops, risk should naturally stay under 3%.
  // 52W breakout/breakdown stocks are inherently volatile — 5% cap.
  const is52wScan = scan_type === 'fiftyTwoWeek_high' || scan_type === 'fiftyTwoWeek_low';
  const DAILY_PICKS_MAX_RISK = is52wScan ? 5.0 : 3.0;

  if (riskPercent > DAILY_PICKS_MAX_RISK) {
    console.log(`${LOG} [Levels] ${symbol}: REJECTED — Risk ${round2(riskPercent)}% exceeds daily picks cap (${DAILY_PICKS_MAX_RISK}%)`);
    pick._lastRejectionReason = `Risk ${round2(riskPercent)}% exceeds ${DAILY_PICKS_MAX_RISK}% cap`;
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
        content: `Market regime: ${marketContext.regime}.

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

async function saveToDB(marketContext, picks, scanResult, candidatesReview = [], globalIntel = null) {
  // Determine scan_date and trading_date based on when we're running:
  // - 8:40 AM scheduled run: scan_date = yesterday, trading_date = today
  // - Manual evening run:    scan_date = today,     trading_date = next trading day
  const now = new Date();
  const istHour = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getHours();
  const todayMidnight = getISTMidnight();

  let scanDate, tradingDate;
  if (istHour < 15) {
    // Before market close (scheduled 8:40 AM run or manual pre-market)
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

  console.log(`${LOG} [Step 7] Run at ${istHour}:xx IST → scanDate=${scanDate.toISOString()} tradingDate=${tradingDate.toISOString()} candidatesReview=${candidatesReview.length}`);

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
    regime_bonus: p.regime_bonus || 0,
    levels: p.levels,
    trade: { status: 'PENDING' },
    kite: { kite_status: 'pending' },
    ai_insight: p.ai_insight || null,
    ai_generated: p.ai_generated || false,
    news_sentiment: p.news_sentiment || null,
    news_adjustment: p.news_adjustment || 0
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
        },
        candidates_review: candidatesReview,
        ...(globalIntel ? {
          global_intel: {
            market_mood: globalIntel.market_mood,
            risk_level: globalIntel.risk_level,
            risk_reason: globalIntel.risk_reason || null,
            trading_recommendation: globalIntel.trading_recommendation,
            recommendation_reason: globalIntel.recommendation_reason || null,
            sgx_nifty: globalIntel.sgx_nifty || null,
            global_cues: globalIntel.global_cues || null,
            institutional: globalIntel.institutional || null,
            sectors: globalIntel.sectors || {},
            major_events: globalIntel.major_events || [],
            stock_specific: globalIntel.stock_specific || {},
            fetched_at: globalIntel.fetched_at ? new Date(globalIntel.fetched_at) : new Date(),
            source: globalIntel.source || 'claude_websearch'
          }
        } : {})
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
    const longCount = picks.filter(p => p.direction === 'LONG').length;
    const shortCount = picks.filter(p => p.direction === 'SHORT').length;
    if (longCount > 0 && shortCount > 0) {
      title = `Daily Picks: ${longCount} BUY + ${shortCount} SELL`;
    } else {
      title = `Daily Picks: ${picks[0].direction === 'LONG' ? 'BUY' : 'SELL'} ${picks.length} stocks`;
    }
    body = pickSummary;
  } else if (marketContext.regime === 'CONFLICT') {
    title = 'Daily Picks: CONFLICT — Sitting Out';
    body = 'Structure bearish but SGX bullish — mixed signals. No trades today.';
  } else if (marketContext.regime === 'BEARISH' || marketContext.regime === 'STRONG_BEARISH' || marketContext.regime === 'STRONG_BEAR' || marketContext.regime === 'WEAK_BEAR') {
    title = 'Daily Picks: No setups';
    body = 'Market weak today. No daily picks. Protect capital.';
  } else if (marketContext.regime === 'STRONG_BULLISH' || marketContext.regime === 'STRONG_BULL') {
    title = 'Daily Picks: No setups';
    body = 'Strong bullish regime — no bearish setups qualified. Watch for pullback entries.';
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
// STEP 7.5: PRE-MARKET ENTRY ORDERS (GTT for LONG, AMO for SHORT)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Place pre-market entry orders immediately after pick generation.
 * LONG picks → GTT single-leg + CNC (delivery), triggers at entry price.
 * SHORT picks → AMO SL-M + MIS (intraday), queued for market open.
 * Skips ORB validation — entries based on scan engine's levels.
 */
async function placePreMarketEntries(doc) {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} [Step 7.5] Placing pre-market entries`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG} [Step 7.5] Kite not enabled — skipping`);
    return { success: true, message: 'Kite not enabled', ordersPlaced: 0 };
  }

  if (process.env.ENABLE_PRE_MARKET_ENTRY === 'false') {
    console.log(`${LOG} [Step 7.5] Pre-market entry disabled — skipping`);
    return { success: true, message: 'Pre-market entry disabled', ordersPlaced: 0 };
  }

  const pendingPicks = doc.picks.filter(p => p.trade.status === 'PENDING' || p.trade.status === 'FAILED');
  if (pendingPicks.length === 0) {
    console.log(`${LOG} [Step 7.5] No PENDING/FAILED picks — skipping`);
    return { success: true, message: 'No pending picks', ordersPlaced: 0 };
  }

  // Capital allocation — all picks use MIS (intraday), single pool with leverage
  const MAX_WEIGHT = 0.45;
  let balance;
  const MAX_BALANCE_RETRIES = 2;
  for (let attempt = 1; attempt <= MAX_BALANCE_RETRIES; attempt++) {
    try {
      balance = await kiteOrderService.getAvailableBalance();
      console.log(`${LOG} [Step 7.5] Balance fetched on attempt ${attempt}`);
      break;
    } catch (err) {
      console.error(`${LOG} [Step 7.5] ❌ Balance fetch failed (attempt ${attempt}/${MAX_BALANCE_RETRIES}) — ${err.message}`);
      if (attempt < MAX_BALANCE_RETRIES) {
        // Token error → try auto-login refresh before retry
        const is403 = err.response?.status === 403 || err.message?.includes('403') || err.message?.includes('TokenException');
        if (is403) {
          console.log(`${LOG} [Step 7.5] Token error detected — triggering auto-login refresh`);
          try {
            const kiteAutoLogin = (await import('../kiteAutoLogin.service.js')).default;
            await kiteAutoLogin.refreshSession();
            console.log(`${LOG} [Step 7.5] Auto-login refresh successful — retrying`);
          } catch (loginErr) {
            console.error(`${LOG} [Step 7.5] Auto-login refresh failed: ${loginErr.message}`);
          }
        }
        await delay(2000);
      }
    }
  }

  // Fallback if all retries failed — use conservative balance so entries still proceed
  if (!balance) {
    console.warn(`${LOG} [Step 7.5] ⚠️ All balance attempts failed — using conservative fallback`);
    try {
      const prevDoc = await DailyPick.findOne({
        trading_date: { $lt: getISTMidnight(new Date()) }
      }).sort({ trading_date: -1 }).lean();
      const prevBalance = prevDoc?.execution_summary?.available_balance;
      if (prevBalance && prevBalance > 0) {
        const conservativeAmt = round2(prevBalance * 0.5);
        balance = {
          total: conservativeAmt, available: conservativeAmt,
          usableSwing: round2(conservativeAmt * 0.6),
          usableIntraday: round2(conservativeAmt * 0.4),
          pendingSwing: 0, pendingIntraday: 0, used: 0,
          is_fallback: true, fallback_source: 'previous_day'
        };
        console.warn(`${LOG} [Step 7.5] Fallback: 50% of prev day balance = ₹${conservativeAmt}`);
      }
    } catch (dbErr) {
      console.error(`${LOG} [Step 7.5] Fallback DB lookup failed: ${dbErr.message}`);
    }
    // Last resort hardcoded minimum
    if (!balance) {
      balance = {
        total: 50000, available: 50000,
        usableSwing: 30000, usableIntraday: 20000,
        pendingSwing: 0, pendingIntraday: 0, used: 0,
        is_fallback: true, fallback_source: 'hardcoded_minimum'
      };
      console.warn(`${LOG} [Step 7.5] Using hardcoded minimum fallback: ₹50,000`);
    }
    // Notify admin about fallback usage
    try {
      await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
        '⚠️ Balance Fallback Used',
        `Kite balance fetch failed after ${MAX_BALANCE_RETRIES} retries. Using ${balance.fallback_source} fallback (₹${balance.available}). Review trades carefully.`,
        { type: 'BALANCE_FALLBACK', route: '/daily-picks' }
      );
    } catch (_) { /* notification failure is non-critical */ }
  }
  console.log(`${LOG} [Step 7.5] Balance: ₹${balance.available}, Swing budget: ₹${balance.usableSwing}, Intraday budget: ₹${balance.usableIntraday}`);

  // ATR-based position sizing: higher ATR → smaller position (inverse volatility weighting)
  // BASELINE_ATR_PCT, MIN_ATR_MULT, MAX_ATR_MULT imported from dailyPicksConstants.js

  const totalScore = pendingPicks.reduce((sum, p) => sum + p.rank_score, 0);
  const rawWeights = pendingPicks.map(p => Math.min(p.rank_score / totalScore, MAX_WEIGHT));
  const weightSum = rawWeights.reduce((s, w) => s + w, 0);

  // Daily picks use only the intraday pool (40%) — swing pool (60%) reserved for weekly setups
  const totalPool = balance.usableIntraday;

  const allocations = pendingPicks.map((pick, i) => {
    let capital = weightSum > 0 ? Math.floor(totalPool * (rawWeights[i] / weightSum)) : 0;

    // ATR-based sizing: scale capital inversely with volatility
    const atrPct = pick._ohlcv?.atr && pick.levels?.entry
      ? (pick._ohlcv.atr / pick.levels.entry) * 100
      : null;
    if (atrPct && atrPct > 0) {
      const atrMultiplier = Math.max(MIN_ATR_MULT, Math.min(MAX_ATR_MULT, BASELINE_ATR_PCT / atrPct));
      const preSized = capital;
      capital = Math.floor(capital * atrMultiplier);
      console.log(`${LOG}   ${pick.symbol}: ATR=${round2(atrPct)}% → multiplier=${round2(atrMultiplier)}x (₹${preSized} → ₹${capital})`);
    }

    // Regime-based position size reduction for counter-regime trades
    if (pick.regime_warning) {
      const { severity } = pick.regime_warning;
      if (severity === 'critical') {
        // Critical counter-regime (e.g. LONG in STRONG_BEARISH): block entirely
        console.log(`${LOG}   ${pick.symbol}: ⛔ BLOCKED — critical regime conflict (${pick.regime_warning.code}), capital=₹0`);
        capital = 0;
        pick.position_size_reduction_pct = 100;
      } else if (severity === 'high' || severity === 'medium') {
        // High/medium conflict: reduce position by 50%
        const original = capital;
        capital = Math.floor(capital * 0.5);
        pick.position_size_reduction_pct = 50;
        console.log(`${LOG}   ${pick.symbol}: ⚠️ Regime risk (${pick.regime_warning.code}) — position halved ₹${original} → ₹${capital}`);
      }
    }

    return { pick, capital };
  });

  console.log(`${LOG} [Step 7.5] Capital allocation: totalScore=${totalScore} totalPool=₹${totalPool} (all MIS intraday)`);
  for (const { pick, capital } of allocations) {
    const cappedAmount = Math.min(capital, kiteConfig.MAX_ORDER_VALUE);
    const estQty = Math.floor(cappedAmount / pick.levels.entry);
    console.log(`${LOG}   ${pick.symbol}: ${pick.direction} weight=${round2(rawWeights[pendingPicks.indexOf(pick)] / weightSum * 100)}% capital=₹${capital} capped=₹${cappedAmount} estQty=${estQty} entry=₹${pick.levels.entry}`);
  }

  // Circuit breaker check — halt new entries if daily drawdown exceeded
  const cbCheck = await checkCircuitBreaker();
  if (!cbCheck.allowed) {
    console.log(`${LOG} [Step 7.5] ⛔ CIRCUIT BREAKER: ${cbCheck.reason} — skipping all entries`);
    return { success: true, message: `Circuit breaker: ${cbCheck.reason}`, ordersPlaced: 0 };
  }

  // Breakout/52W scans wait for ORB validation at 9:30 AM — entry ≈ current price, gap risk is high
  // Pullback/compression scans place pre-market — entry below current price, safe for LIMIT
  const ORB_WAIT_SCANS = ['fiftyTwoWeek_high', 'fiftyTwoWeek_low', 'breakout_setup', 'breakdown_setup'];

  let ordersPlaced = 0;

  for (const { pick, capital } of allocations) {
    // Defer breakout/52W scans to ORB validation — stays PENDING for 9:30 AM job
    if (ORB_WAIT_SCANS.includes(pick.scan_type)) {
      console.log(`${LOG} [Step 7.5] ${pick.symbol}: ${pick.scan_type} — deferred to ORB validation at 9:30 AM`);
      continue;
    }

    const orderAmount = Math.min(capital, kiteConfig.MAX_ORDER_VALUE);
    const qty = Math.floor(orderAmount / pick.levels.entry);
    if (qty <= 0) {
      console.log(`${LOG} [Step 7.5] ${pick.symbol}: qty=0 (price ₹${pick.levels.entry} > capital ₹${orderAmount}) — skipping`);
      continue;
    }

    // SLIPPAGE_BUFFER_PCT imported from dailyPicksConstants.js (0.15%)
    const rawTrigger = pick.direction === 'LONG'
      ? pick.levels.entry * (1 + SLIPPAGE_BUFFER_PCT)   // LONG: trigger slightly above entry
      : pick.levels.entry * (1 - SLIPPAGE_BUFFER_PCT);  // SHORT: trigger slightly below entry
    const triggerPrice = roundToTick(rawTrigger);

    try {
      // All daily picks use MIS (intraday) — no overnight holding
      // AMO SL-M for pre-market entry. For LONG: BUY trigger at entry + slippage buffer.
      // For SHORT: Kite requires SL-M SELL trigger_price < LTP, so nudge if needed.
      const txnType = pick.direction === 'LONG' ? 'BUY' : 'SELL';
      let amoTrigger = triggerPrice;

      if (pick.direction === 'SHORT') {
        try {
          const ltpData = await kiteOrderService.getLTP([`NSE:${pick.symbol}`]);
          const ltp = ltpData?.[`NSE:${pick.symbol}`]?.last_price;
          if (ltp && amoTrigger >= ltp) {
            const tick = getNseTickSize(ltp);
            amoTrigger = roundToTick(ltp - tick);
            console.log(`${LOG} [Step 7.5] ${pick.symbol}: Trigger ₹${triggerPrice} >= LTP ₹${ltp}, nudged to ₹${amoTrigger} (1 tick below LTP)`);
          }
        } catch (ltpErr) {
          const tick = getNseTickSize(triggerPrice);
          amoTrigger = roundToTick(triggerPrice - tick);
          console.log(`${LOG} [Step 7.5] ${pick.symbol}: LTP fetch failed, nudged trigger to ₹${amoTrigger} (1 tick below entry)`);
        }
      }

      console.log(`${LOG} [Step 7.5] ${pick.symbol}: AMO ${pick.direction} qty=${qty} trigger=₹${amoTrigger} product=MIS`);

      const result = await kiteOrderService.placeAMOOrder({
        tradingsymbol: pick.symbol,
        exchange: 'NSE',
        transaction_type: txnType,
        order_type: 'SL-M',
        product: 'MIS',
        quantity: qty,
        trigger_price: amoTrigger,
        simulationId: `daily_pick_${pick.symbol}`,
        orderType: 'ENTRY',
        source: 'DAILY_PICKS'
      });

      if (result.success && result.orderId) {
        pick.trade.status = 'ORDER_PLACED';
        pick.trade.qty = qty;
        pick.kite.entry_order_id = result.orderId;
        pick.kite.kite_status = 'amo_placed';
        ordersPlaced++;

        console.log(`${LOG} [Step 7.5] ┌── AMO ENTRY: ${pick.symbol} ──────────────────────`);
        console.log(`${LOG} [Step 7.5] │ Direction: ${pick.direction} | Scan: ${pick.scan_type} | Product: MIS`);
        console.log(`${LOG} [Step 7.5] │ Trigger: ₹${amoTrigger}${amoTrigger !== triggerPrice ? ` (nudged from ₹${triggerPrice})` : ''} | Qty: ${qty} | Capital: ₹${orderAmount}`);
        console.log(`${LOG} [Step 7.5] │ Stop: ₹${pick.levels.stop} | Target: ₹${pick.levels.target} | R:R=${pick.levels.risk_reward}`);
        console.log(`${LOG} [Step 7.5] │ Order ID: ${result.orderId}`);
        console.log(`${LOG} [Step 7.5] └─────────────────────────────────────────────────────`);
      } else {
        console.error(`${LOG} [Step 7.5] ❌ ${pick.symbol}: AMO placement failed — ${JSON.stringify(result)}`);
        pick.trade.status = 'FAILED';
        pick.kite.kite_status = 'failed';
      }
    } catch (err) {
      console.error(`${LOG} [Step 7.5] ❌ ${pick.symbol}: Order error — ${err.message}`, err.response?.data ? JSON.stringify(err.response.data) : '');
      pick.trade.status = 'FAILED';
      pick.kite.kite_status = 'failed';
    }
  }

  doc.markModified('picks');
  await doc.save();

  console.log(`${LOG} [Step 7.5] Pre-market entries: ${ordersPlaced}/${pendingPicks.length} placed`);
  return { success: true, ordersPlaced };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAP PROTECTION — Cancel AMO entries if stock gaps >2% past trigger
// Called at 9:16 AM (right after pre-open session closes)
// ═══════════════════════════════════════════════════════════════════════════════

// GAP_PROTECTION_MAX_PCT imported from dailyPicksConstants.js

/**
 * Cancel AMO SL-M entry orders that have gapped too far past the trigger price.
 * When a stock gaps 3%+ past the trigger, SL-M fills at market = massive slippage.
 * Better to cancel and let ORB validation handle it with fresh levels.
 */
async function gapProtectionCheck() {
  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Gap protection check (post-open)`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) return { success: true, message: 'Kite not enabled' };

  const doc = await DailyPick.findToday();
  if (!doc) return { success: true, message: 'No picks today' };

  // Only check AMO orders that haven't filled yet
  const amoPicks = doc.picks.filter(p =>
    p.trade.status === 'ORDER_PLACED' &&
    (p.kite.kite_status === 'amo_placed' || p.kite.kite_status === 'order_placed')
  );

  if (amoPicks.length === 0) {
    console.log(`${LOG} No AMO entries to check for gap protection`);
    return { success: true, cancelled: 0 };
  }

  // Fetch opening prices via Kite OHLC
  const symbols = amoPicks.map(p => `NSE:${p.symbol}`);
  let ltpData;
  try {
    ltpData = await kiteOrderService.getLTP(symbols);
  } catch (err) {
    console.error(`${LOG} [GAP-PROTECT] LTP fetch failed:`, err.message);
    return { success: false, error: err.message };
  }

  let cancelled = 0;

  for (const pick of amoPicks) {
    const currentPrice = ltpData[`NSE:${pick.symbol}`]?.last_price;
    if (!currentPrice) continue;

    const entryTrigger = pick.levels.entry;
    const gapPct = pick.direction === 'LONG'
      ? ((currentPrice - entryTrigger) / entryTrigger) * 100
      : ((entryTrigger - currentPrice) / entryTrigger) * 100;

    console.log(`${LOG} [GAP-PROTECT] ${pick.symbol}: trigger=₹${entryTrigger} open=₹${currentPrice} gap=${round2(gapPct)}%`);

    if (gapPct > GAP_PROTECTION_MAX_PCT) {
      // Gap too large — cancel AMO to avoid slippage
      console.log(`${LOG} [GAP-PROTECT] ⚠️ ${pick.symbol}: Gap ${round2(gapPct)}% > ${GAP_PROTECTION_MAX_PCT}% — cancelling AMO`);

      try {
        await kiteOrderService.cancelOrder(pick.kite.entry_order_id);
        pick.trade.status = 'PENDING';   // Reset to PENDING so ORB validation can retry with fresh levels
        pick.kite.kite_status = 'pending';
        pick.trade.exit_reason = `gap_protection_${round2(gapPct)}pct`;
        cancelled++;
        console.log(`${LOG} [GAP-PROTECT] ${pick.symbol}: AMO cancelled — deferred to ORB validation`);
      } catch (err) {
        console.error(`${LOG} [GAP-PROTECT] ${pick.symbol}: Cancel failed:`, err.message);
        // Check if it already filled
        try {
          const order = await kiteOrderService.getOrderDetails(pick.kite.entry_order_id);
          if (order?.status?.toUpperCase() === 'COMPLETE') {
            console.log(`${LOG} [GAP-PROTECT] ${pick.symbol}: Already filled @ ₹${order.average_price} — cannot cancel`);
          }
        } catch (_) { /* ignore */ }
      }
    } else if (gapPct < -1.0) {
      // Negative gap (gap in wrong direction) — also cancel
      console.log(`${LOG} [GAP-PROTECT] ⚠️ ${pick.symbol}: Adverse gap ${round2(gapPct)}% — cancelling AMO`);
      try {
        await kiteOrderService.cancelOrder(pick.kite.entry_order_id);
        pick.trade.status = 'PENDING';
        pick.kite.kite_status = 'pending';
        pick.trade.exit_reason = `adverse_gap_${round2(gapPct)}pct`;
        cancelled++;
      } catch (err) {
        console.error(`${LOG} [GAP-PROTECT] ${pick.symbol}: Cancel failed:`, err.message);
      }
    }
  }

  if (cancelled > 0) {
    doc.markModified('picks');
    await doc.save();

    try {
      await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
        `Gap Protection: ${cancelled} AMO cancelled`,
        `${cancelled} entry order(s) cancelled due to excessive gap at open. Deferred to ORB validation.`,
        { type: 'GAP_PROTECTION', route: '/daily-picks' }
      );
    } catch (_) { /* ignore */ }
  }

  console.log(`${LOG} [GAP-PROTECT] Cancelled ${cancelled}/${amoPicks.length} AMO entries`);
  return { success: true, cancelled };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: ORB COLLECTION — 9:15 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch ORB (Opening Range Breakout) data via single OHLC call.
 * Multi-pass: Pass 1 (9:30) = 15-min range, Pass 2 (9:46) = 30-min, Pass 3 (10:01) = 45-min.
 * At each time, the day's OHLC reflects the cumulative range since market open.
 * Only updates picks still in PENDING/COLLECTING_ORB status.
 */
async function startOrbCollection(options = {}) {
  const { orbPass = 1 } = options;

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Fetching ORB data — Pass ${orbPass}: ${ORB_PASS_LABELS[orbPass] || orbPass}`);
  console.log(`${LOG} ════════════════════════════════════════`);

  const kiteEnabled = isKiteIntegrationEnabled();
  if (!kiteEnabled) {
    console.log(`${LOG} Kite not enabled — skipping ORB`);
    return { success: true, message: 'Kite not enabled' };
  }

  const doc = await DailyPick.findToday();
  if (!doc) {
    console.log(`${LOG} No DailyPick doc for today — nothing to collect`);
    return { success: true, message: 'No picks today' };
  }

  // Only fetch for picks still PENDING or COLLECTING_ORB
  const pendingPicks = doc.picks.filter(p =>
    p.trade.status === 'PENDING' || p.trade.status === 'COLLECTING_ORB'
  );

  if (pendingPicks.length === 0) {
    console.log(`${LOG} No PENDING picks for pass ${orbPass} — skipping ORB`);
    return { success: true, message: 'No pending picks' };
  }

  console.log(`${LOG} Fetching ORB pass ${orbPass} for ${pendingPicks.length} picks: ${pendingPicks.map(p => p.symbol).join(', ')}`);

  const symbols = pendingPicks.map(p => p.symbol);

  let orbData;
  try {
    orbData = await collectOpeningRange(symbols, pendingPicks);
    console.log(`${LOG} ORB data received for: ${Object.keys(orbData).join(', ')}`);
  } catch (orbErr) {
    console.error(`${LOG} [ERROR] collectOpeningRange() THREW: ${orbErr.message}`);
    return { success: false, error: orbErr.message };
  }

  // Store ORB data on each pick — only update PENDING picks
  for (const pick of pendingPicks) {
    if (pick.trade.status !== 'PENDING' && pick.trade.status !== 'COLLECTING_ORB') continue;

    const orb = orbData[pick.symbol];
    if (orb) {
      const existingPasses = pick.orb?.orb_passes || [];
      pick.orb = {
        high: orb.high,
        low: orb.low,
        opening_price: orb.opening_price,
        gap_percent: orb.gap_percent,
        orb_direction: orb.orb_direction,
        nifty_orb_direction: orbData['_NIFTY']?.orb_direction || 'NEUTRAL',
        nifty_change_pct: orbData['_NIFTY']?.nifty_change_pct ?? 0,
        orb_pass: orbPass,
        orb_passes: existingPasses
      };
    }
  }
  doc.markModified('picks');
  await doc.save();

  console.log(`${LOG} ORB pass ${orbPass} complete — data stored for ${Object.keys(orbData).filter(k => k !== '_NIFTY').length} symbols`);
  return { success: true, symbolsCollected: Object.keys(orbData).length, orbPass };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2: VALIDATE + PLACE ENTRIES — 9:30 AM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate picks against ORB data and place entries for validated picks.
 * Multi-pass: orbPass 1 (9:30), 2 (9:46), 3 (10:01 FINAL).
 * Permanent failures (gap, nifty) are skipped immediately.
 * Retryable failures (R:R, range) stay PENDING for next pass.
 */
async function validateAndPlaceEntries(options = {}) {
  const { dryRun = false, orbPass = 1 } = options;
  const isFinalPass = orbPass >= MAX_ORB_PASS;

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Validating picks — Pass ${orbPass}: ${ORB_PASS_LABELS[orbPass]} ${isFinalPass ? '(FINAL)' : '(retry available)'}${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG} Kite not enabled — skipping`);
    return { success: true, message: 'Kite not enabled', orders: 0, validated: 0, skipped: 0 };
  }

  const doc = await DailyPick.findToday();
  if (!doc) {
    console.log(`${LOG} No DailyPick doc for today — nothing to place`);
    return { success: true, message: 'No picks today', orders: 0, validated: 0, skipped: 0 };
  }

  // Accept both COLLECTING_ORB (normal flow) and PENDING (if ORB collection was skipped/manual)
  const eligiblePicks = doc.picks.filter(p =>
    p.trade.status === 'COLLECTING_ORB' || p.trade.status === 'PENDING'
  );
  if (eligiblePicks.length === 0) {
    console.log(`${LOG} No eligible picks for validation — skipping`);
    return { success: true, message: 'No eligible picks', orders: 0, validated: 0, skipped: 0 };
  }

  // Step 1: Validate against ORB data
  // Pass 1: use stored ORB data. Pass 2+: RE-FETCH fresh OHLC (market has moved 15-30 min)
  let orbData = {};
  if (orbPass > 1) {
    // Fresh fetch — ORB high/low will now reflect the wider range (30-min or 45-min candle)
    console.log(`${LOG} Pass ${orbPass}: Re-fetching fresh OHLC for ${eligiblePicks.length} picks (stale data is ${orbPass === 2 ? '16' : '31'} min old)`);
    try {
      const freshSymbols = eligiblePicks.map(p => p.symbol);
      orbData = await collectOpeningRange(freshSymbols, eligiblePicks);
      // Update stored ORB data on picks with fresh values
      for (const pick of eligiblePicks) {
        const freshOrb = orbData[pick.symbol];
        if (freshOrb) {
          const existingPasses = pick.orb?.orb_passes || [];
          pick.orb = {
            high: freshOrb.high,
            low: freshOrb.low,
            opening_price: freshOrb.opening_price,
            gap_percent: freshOrb.gap_percent,
            orb_direction: freshOrb.orb_direction,
            nifty_orb_direction: orbData['_NIFTY']?.orb_direction || 'NEUTRAL',
            nifty_change_pct: orbData['_NIFTY']?.nifty_change_pct ?? 0,
            orb_pass: orbPass,
            orb_passes: existingPasses
          };
        }
      }
      console.log(`${LOG} Pass ${orbPass}: Fresh OHLC received for ${Object.keys(orbData).filter(k => k !== '_NIFTY').length} symbols`);
    } catch (freshErr) {
      console.error(`${LOG} Pass ${orbPass}: Fresh OHLC fetch failed, falling back to stored data: ${freshErr.message}`);
      // Fallback to stored data
      for (const pick of eligiblePicks) {
        if (pick.orb?.high) {
          orbData[pick.symbol] = {
            high: pick.orb.high, low: pick.orb.low,
            opening_price: pick.orb.opening_price,
            gap_percent: pick.orb.gap_percent,
            orb_direction: pick.orb.orb_direction
          };
        }
      }
      const firstWithNifty = eligiblePicks.find(p => p.orb?.nifty_orb_direction);
      if (firstWithNifty) {
        orbData['_NIFTY'] = { orb_direction: firstWithNifty.orb.nifty_orb_direction, nifty_change_pct: firstWithNifty.orb.nifty_change_pct ?? 0 };
      }
    }
  } else {
    // Pass 1: use stored ORB data from startOrbCollection
    for (const pick of eligiblePicks) {
      if (pick.orb?.high) {
        orbData[pick.symbol] = {
          high: pick.orb.high, low: pick.orb.low,
          opening_price: pick.orb.opening_price,
          gap_percent: pick.orb.gap_percent,
          orb_direction: pick.orb.orb_direction
        };
      }
    }
    const firstWithNifty = eligiblePicks.find(p => p.orb?.nifty_orb_direction);
    if (firstWithNifty) {
      orbData['_NIFTY'] = { orb_direction: firstWithNifty.orb.nifty_orb_direction, nifty_change_pct: firstWithNifty.orb.nifty_change_pct ?? 0 };
    }
  }

  // Pass regime alignment info so nifty_alignment can use wider threshold for regime-aligned trades
  const regime = doc.market_context?.regime || 'UNKNOWN';
  for (const pick of eligiblePicks) {
    pick.regime_aligned = isRegimeAligned(pick.direction, regime);
  }

  validatePicks(eligiblePicks, orbData, regime);

  // Record pass history on each pick for analytics
  for (const pick of eligiblePicks) {
    if (!pick.orb) pick.orb = {};
    if (!pick.orb.orb_passes) pick.orb.orb_passes = [];

    const failedChecks = pick.validation?.skip_reason || null;
    const isPermanentFail = failedChecks && failedChecks.split(', ').every(c => PERMANENT_FAIL_CHECKS.includes(c));

    pick.orb.orb_passes.push({
      pass: orbPass,
      timestamp: new Date(),
      orb_high: pick.orb?.high,
      orb_low: pick.orb?.low,
      result: pick.validation?.passed ? 'PASSED' : (isPermanentFail ? 'PERMANENT_FAIL' : 'FAILED'),
      reason: failedChecks
    });
  }

  // Step 2: Update validated picks' entry to ORB breakout level (Crabel-style SL-M)
  for (const pick of eligiblePicks) {
    if (pick.validation?.passed && pick.validation.checks.orb_alignment?.new_entry) {
      // Store original entry for audit trail before overwriting
      pick.validation.original_levels = {
        entry: pick.levels.entry,
        stop: pick.levels.stop,
        target: pick.levels.target
      };
      pick.validation.levels_recalculated = true;
      // Update entry to ORB breakout level
      pick.levels.entry = pick.validation.checks.orb_alignment.new_entry;
      pick.levels.entry_type = pick.direction === 'LONG' ? 'buy_above' : 'sell_below';
    }
  }
  // Mongoose needs a nudge to detect nested changes on subdocument arrays
  doc.markModified('picks');

  // Step 3: Separate validated vs skipped
  const validatedPicks = eligiblePicks.filter(p => p.validation?.passed);
  const skippedPicks = eligiblePicks.filter(p => !p.validation?.passed);

  for (const pick of skippedPicks) {
    const failedChecks = pick.validation?.skip_reason || '';
    const isPermanentFail = failedChecks && failedChecks.split(', ').every(c => PERMANENT_FAIL_CHECKS.includes(c));

    if (isFinalPass || isPermanentFail) {
      pick.trade.status = 'SKIPPED';
      pick.trade.exit_reason = `validation_failed_pass_${orbPass}: ${failedChecks}`;
      pick.kite.kite_status = 'skipped';
      const reason = isPermanentFail ? 'permanent' : 'final pass';
      console.log(`${LOG} ${pick.symbol}: SKIPPED (${reason}, pass ${orbPass}) — ${failedChecks}`);
    } else {
      // Retryable failure — keep PENDING for next pass
      pick.trade.status = 'PENDING';
      console.log(`${LOG} ${pick.symbol}: FAILED pass ${orbPass} (retryable: ${failedChecks}) — will retry at pass ${orbPass + 1} (${ORB_PASS_LABELS[orbPass + 1]})`);
    }
  }

  const retryingPicks = skippedPicks.filter(p => p.trade.status === 'PENDING');
  if (validatedPicks.length === 0) {
    console.log(`${LOG} All picks failed validation on pass ${orbPass} — ${retryingPicks.length} retrying, ${skippedPicks.length - retryingPicks.length} permanently skipped`);
    await doc.save();
    return { success: true, message: `All picks failed pass ${orbPass}`, orders: 0, validated: 0, skipped: skippedPicks.length - retryingPicks.length, retrying: retryingPicks.length, orbPass };
  }

  // Mark as VALIDATED
  for (const pick of validatedPicks) {
    pick.trade.status = 'VALIDATED';
    pick.kite.kite_status = 'validated';
  }

  // Circuit breaker check before placing ORB entries
  const cbCheck = await checkCircuitBreaker();
  if (!cbCheck.allowed) {
    console.log(`${LOG} ⛔ CIRCUIT BREAKER: ${cbCheck.reason} — skipping ORB entries`);
    for (const pick of validatedPicks) {
      pick.trade.status = 'SKIPPED';
      pick.trade.exit_reason = `circuit_breaker: ${cbCheck.reason}`;
      pick.kite.kite_status = 'skipped';
    }
    await doc.save();
    return { success: true, message: `Circuit breaker: ${cbCheck.reason}`, orders: 0, validated: validatedPicks.length, skipped: skippedPicks.length };
  }

  // Step 3: Capital allocation + order placement (with ATR-based sizing)
  const MAX_WEIGHT = 0.45;
  // ATR constants from dailyPicksConstants.js (same values for pre-market and ORB entries)
  const BASELINE_ATR_PCT_ORB = BASELINE_ATR_PCT;
  const MIN_ATR_MULT_ORB = MIN_ATR_MULT;
  const MAX_ATR_MULT_ORB = MAX_ATR_MULT;
  const balance = await kiteOrderService.getAvailableBalance();
  console.log(`${LOG} Balance: ₹${balance.available}, Intraday budget: ₹${balance.usableIntraday}`);

  const totalScore = validatedPicks.reduce((sum, p) => sum + p.rank_score, 0);
  const rawWeights = validatedPicks.map(p => Math.min(p.rank_score / totalScore, MAX_WEIGHT));
  const weightSum = rawWeights.reduce((s, w) => s + w, 0);
  const allocations = validatedPicks.map((pick, i) => {
    let capital = Math.floor(balance.usableIntraday * (rawWeights[i] / weightSum));
    // ATR-based sizing: scale inversely with volatility
    const atrPct = pick._ohlcv?.atr && pick.levels?.entry
      ? (pick._ohlcv.atr / pick.levels.entry) * 100
      : null;
    if (atrPct && atrPct > 0) {
      const atrMult = Math.max(MIN_ATR_MULT_ORB, Math.min(MAX_ATR_MULT_ORB, BASELINE_ATR_PCT_ORB / atrPct));
      capital = Math.floor(capital * atrMult);
      console.log(`${LOG}   ${pick.symbol}: ATR=${round2(atrPct)}% → mult=${round2(atrMult)}x → capital=₹${capital}`);
    }
    return { pick, capital };
  });

  console.log(`${LOG} Capital allocation: totalScore=${totalScore} intradayBudget=₹${balance.usableIntraday}`);
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

    // Crabel-style: SL-M at ORB breakout level + slippage buffer (0.15%)
    const ORB_SLIPPAGE_BUFFER = 0.0015;
    const orbRawTrigger = pick.direction === 'LONG'
      ? pick.levels.entry * (1 + ORB_SLIPPAGE_BUFFER)
      : pick.levels.entry * (1 - ORB_SLIPPAGE_BUFFER);
    const triggerPrice = roundToTick(orbRawTrigger);
    const originalEntry = pick.validation?.checks?.orb_alignment?.original_entry;

    console.log(`${LOG} ${pick.symbol}: SL-M ${pick.direction} qty=${qty} trigger=₹${triggerPrice} (original entry=₹${originalEntry || 'N/A'})`);

    if (dryRun) {
      console.log(`${LOG} [DRY RUN] Would place SL-M order for ${pick.symbol}`);
      continue;
    }

    try {
      const orderParams = {
        tradingsymbol: pick.symbol,
        exchange: 'NSE',
        transaction_type: pick.direction === 'LONG' ? 'BUY' : 'SELL',
        order_type: 'SL-M',
        product: 'MIS',
        quantity: qty,
        trigger_price: triggerPrice,
        simulationId: `daily_pick_${pick.symbol}`,
        orderType: 'ENTRY',
        source: 'DAILY_PICKS'
      };

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
        console.log(`${LOG} │ Original Entry: ₹${originalEntry || 'N/A'} → ORB Entry: ₹${pick.levels.entry} | Stop: ₹${pick.levels.stop} | Target: ₹${pick.levels.target}`);
        console.log(`${LOG} │ T1 (partial): ${pick.levels.target1 ? '₹' + pick.levels.target1 : 'N/A'} | T3 (stretch): ${pick.levels.target3 ? '₹' + pick.levels.target3 : 'N/A'}`);
        console.log(`${LOG} │ R:R=${pick.validation?.checks?.orb_alignment?.new_rr ?? pick.levels.risk_reward} | Risk=${pick.levels.risk_pct}% | Reward=${pick.levels.reward_pct}%`);
        console.log(`${LOG} │ Order → SL-M qty=${qty} trigger=₹${triggerPrice} orderId=${result.orderId}`);
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
  console.log(`${LOG} Pass ${orbPass} result: ${validatedPicks.length} validated, ${skippedPicks.length - retryingPicks.length} skipped, ${retryingPicks.length} retrying, ${ordersPlaced} orders placed`);

  return { success: true, validated: validatedPicks.length, skipped: skippedPicks.length - retryingPicks.length, retrying: retryingPicks.length, orders: ordersPlaced, orbPass };
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

  // Also handle deferred picks that are now ready (entered_awaiting_915)
  if (pick.kite.kite_status === 'entered_awaiting_915' && pick.trade.status === 'ENTERED') {
    // This is a deferred call from post-9:15 scheduler — proceed with stored entry price
    entryPrice = entryPrice || pick.trade.entry_price;
    console.log(`${LOG} ${pick.symbol}: Processing deferred SL+target (was awaiting 9:15 AM) — entry @ ₹${entryPrice}`);
  }

  // Pre-9:15 AM guard: defer SL/target placement if market hasn't opened yet
  // AMO fills during pre-open (~9:08 AM) but regular orders rejected before 9:15 AM
  const istNow = MarketHoursUtil.toIST(new Date());
  const istMinutes = istNow.getHours() * 60 + istNow.getMinutes();
  if (istMinutes < 9 * 60 + 15 && pick.kite.kite_status !== 'entered_awaiting_915') {
    console.log(`${LOG} ${pick.symbol}: Fill @ ₹${entryPrice} received at ${istNow.toTimeString().slice(0, 8)} IST (before 9:15 AM) — deferring SL+target`);
    pick.trade.status = 'ENTERED';
    pick.trade.entry_price = entryPrice;
    pick.trade.entry_time = new Date();
    pick.kite.kite_status = 'entered_awaiting_915';
    await doc.save();
    return; // Exit early — post-9:15 scheduler will call us again
  }

  pick.trade.status = 'ENTERED';
  pick.trade.entry_price = entryPrice;
  pick.trade.entry_time = new Date();

  // Preserve structural target from pre-market pipeline (Daily R1, 1H swing, etc.)
  // Only fall back to flat 2% if structural target is somehow missing
  const structuralTarget = pick.levels.target;
  const target = (structuralTarget && structuralTarget > 0)
    ? structuralTarget
    : (pick.direction === 'LONG'
        ? round2(entryPrice * (1 + TARGET_PCT / 100))
        : round2(entryPrice * (1 - TARGET_PCT / 100)));
  pick.levels.target = target;
  const targetSource = (structuralTarget && structuralTarget > 0) ? 'structural' : 'flat_2pct_fallback';

  // All daily picks use MIS (intraday) — separate SL-M + LIMIT orders
  const product = 'MIS';
  const exitSide = pick.direction === 'LONG' ? 'SELL' : 'BUY';

  console.log(`${LOG} ✅ ${pick.symbol}: Filled @ ₹${entryPrice} — placing SL @ ₹${pick.levels.stop} + target @ ₹${target} (${targetSource}) product=${product}`);

  let slPlaced = false;
  let tgtPlaced = false;

  // MIS allows multiple pending orders — place SL-M + LIMIT separately
  // Retry SL-M up to 2 attempts (critical — position must be protected)
  for (let slAttempt = 1; slAttempt <= 2 && !slPlaced; slAttempt++) {
    try {
      if (slAttempt > 1) {
        console.log(`${LOG} ${pick.symbol}: SL-M retry attempt ${slAttempt}/2 after ${slAttempt === 2 ? '3s' : '1s'} wait`);
        await delay(slAttempt === 2 ? 3000 : 1000);
      }
      const slResult = await kiteOrderService.placeOrder({
        tradingsymbol: pick.symbol, exchange: 'NSE',
        transaction_type: exitSide, order_type: 'SL-M',
        trigger_price: pick.levels.stop, product: 'MIS',
        quantity: pick.trade.qty,
        simulationId: `daily_pick_sl_${pick.symbol}`,
        orderType: 'STOP_LOSS', source: 'DAILY_PICKS'
      });
      if (slResult.success) {
        pick.kite.stop_order_id = slResult.orderId;
        slPlaced = true;
        console.log(`${LOG} ${pick.symbol}: SL-M placed @ ₹${pick.levels.stop} — orderId=${slResult.orderId}${slAttempt > 1 ? ` (attempt ${slAttempt})` : ''}`);
      }
    } catch (err) {
      console.error(`${LOG} ${pick.symbol}: SL-M error (attempt ${slAttempt}/2):`, err.message);
    }
  }

  try {
    const tgtResult = await kiteOrderService.placeOrder({
      tradingsymbol: pick.symbol, exchange: 'NSE',
      transaction_type: exitSide, order_type: 'LIMIT',
      price: target, product: 'MIS',
      quantity: pick.trade.qty,
      simulationId: `daily_pick_tgt_${pick.symbol}`,
      orderType: 'TARGET', source: 'DAILY_PICKS'
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
    console.log(`${LOG} │ Target: ₹${target} [${targetSource}] (LIMIT orderId=${pick.kite.target_order_id})`);
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
        product,
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

      // Match regular/AMO orders by order ID
      let pick = doc.picks.find(p =>
        p.kite.entry_order_id === postback.order_id &&
        p.trade.status === 'ORDER_PLACED' &&
        p.kite.kite_status !== 'sl_target_placed'
      );

      // Match GTT fills by tradingsymbol — GTT child orders have a different ID than the trigger ID
      if (!pick) {
        pick = doc.picks.find(p =>
          p.symbol === postback.tradingsymbol &&
          p.trade.status === 'ORDER_PLACED' &&
          p.kite.kite_status === 'gtt_placed'
        );
        if (pick) {
          console.log(`${LOG} [FILL-LISTENER] ${pick.symbol}: Matched GTT fill by tradingsymbol — child orderId=${postback.order_id} (GTT triggerId=${pick.kite.entry_order_id})`);
        }
      }

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

  // Handle deferred SL+target placements from pre-9:15 AM AMO fills
  const istNow = MarketHoursUtil.toIST(new Date());
  const istMinutes = istNow.getHours() * 60 + istNow.getMinutes();
  if (istMinutes >= 9 * 60 + 15) {
    const deferredPicks = doc.picks.filter(p =>
      p.kite.kite_status === 'entered_awaiting_915' && p.trade.status === 'ENTERED'
    );
    if (deferredPicks.length > 0) {
      console.log(`${LOG} [FILL-FALLBACK] Processing ${deferredPicks.length} deferred SL+target placements (post-9:15 AM)`);
      for (const pick of deferredPicks) {
        try {
          await placeSLAndTarget(pick, doc, pick.trade.entry_price);
        } catch (err) {
          console.error(`${LOG} [FILL-FALLBACK] Deferred SL+target failed for ${pick.symbol}:`, err.message);
        }
      }
    }
  }

  const orderPlacedPicks = doc.picks.filter(p =>
    p.trade.status === 'ORDER_PLACED' && p.kite.kite_status !== 'sl_target_placed'
  );
  if (orderPlacedPicks.length === 0) return { success: true, message: 'No pending fills' };

  console.log(`${LOG} [FILL-FALLBACK] Checking ${orderPlacedPicks.length} picks: ${orderPlacedPicks.map(p => p.symbol).join(', ')}`);

  let filled = 0;

  // Fetch all active GTTs once (for GTT fill detection)
  let activeGTTs = null;
  const hasGTTPicks = orderPlacedPicks.some(p => p.kite.kite_status === 'gtt_placed');
  if (hasGTTPicks) {
    try {
      activeGTTs = await kiteOrderService.getGTTs();
      console.log(`${LOG} [FILL-FALLBACK] Fetched ${activeGTTs.length} active GTTs for fill check`);
    } catch (err) {
      console.error(`${LOG} [FILL-FALLBACK] Failed to fetch GTTs:`, err.message);
    }
  }

  for (const pick of orderPlacedPicks) {
    try {
      if (pick.kite.kite_status === 'gtt_placed') {
        // GTT pick — check GTT status via API
        console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: Checking GTT trigger ${pick.kite.entry_order_id}...`);
        if (!activeGTTs) continue;

        const gtt = activeGTTs.find(g => String(g.id) === String(pick.kite.entry_order_id));
        if (!gtt) {
          // GTT not in active list — likely triggered and completed already.
          // The postback listener should have caught it, but check LTP as fallback.
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: GTT ${pick.kite.entry_order_id} not found in active GTTs — may have already triggered. Postback listener should handle fill.`);
          continue;
        }

        const gttStatus = gtt.status?.toLowerCase();
        console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: GTT status=${gttStatus}`);

        if (gttStatus === 'triggered') {
          // GTT triggered — find the child order's fill price from GTT response
          const fillPrice = gtt.orders?.[0]?.result?.average_price || pick.levels.entry;
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: GTT triggered — fill @ ₹${fillPrice} — placing SL+target`);
          await placeSLAndTarget(pick, doc, fillPrice);
          filled++;
        } else if (gttStatus === 'cancelled' || gttStatus === 'rejected' || gttStatus === 'disabled') {
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: GTT ${gttStatus} — marking as SKIPPED`);
          pick.trade.status = 'SKIPPED';
          pick.kite.kite_status = 'skipped';
          await doc.save();
        } else {
          console.log(`${LOG} [FILL-FALLBACK] ${pick.symbol}: GTT still active — will check next poll`);
        }

      } else {
        // Regular/AMO order — existing logic
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

// Trailing, partial booking, sideways constants — ALL imported from dailyPicksConstants.js
// TRAIL_MIN_PROFIT_PCT, TRAIL_LOCK_RATIO, TRAIL_MIN_MINUTES, TRAIL_START_HOUR
// PARTIAL_BOOK_PCT, PARTIAL_BOOK_QTY_RATIO
// SIDEWAYS_EXIT_MINUTES, SIDEWAYS_THRESHOLD_PCT

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

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} MONITOR RUN — ${enteredPicks.length} active positions`);
  for (const pick of enteredPicks) {
    const hasStop = !!pick.kite.stop_order_id;
    const hasTarget = !!pick.kite.target_order_id;
    const minSinceEntry = pick.trade.entry_time
      ? Math.round((Date.now() - new Date(pick.trade.entry_time).getTime()) / 60000)
      : '?';
    console.log(`${LOG}   ${pick.symbol}: ${pick.direction} entry=₹${pick.trade.entry_price} stop=₹${pick.levels.stop} target=₹${pick.levels.target} qty=${pick.trade.qty} SL=${hasStop ? 'YES' : 'NO'} TGT=${hasTarget ? 'YES' : 'NO'} age=${minSinceEntry}min partial=${pick._partial_booked ? 'YES' : 'NO'}`);
  }
  console.log(`${LOG} ════════════════════════════════════════`);

  // Midday intel re-check: at 12 PM, re-fetch global market intel for breaking events
  // If risk level escalates to EXTREME mid-day, tighten all stops to breakeven
  const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const istHourNow = istNow.getHours();
  const istMinNow = istNow.getMinutes();
  if (istHourNow === 12 && istMinNow < 20 && !doc._middayIntelChecked) {
    try {
      console.log(`${LOG} [MIDDAY-INTEL] 12 PM re-check — fetching fresh global intel...`);
      clearIntelCache(); // Force fresh fetch
      const middayIntel = await fetchGlobalMarketIntel();
      const middayAvoid = shouldAvoidTrading();

      if (middayAvoid.avoid) {
        console.log(`${LOG} [MIDDAY-INTEL] ⛔ EXTREME event detected mid-day: ${middayAvoid.reason}`);
        console.log(`${LOG} [MIDDAY-INTEL] Tightening all stops to breakeven or current price...`);

        for (const pick of enteredPicks) {
          if (!pick.trade.entry_price || !pick.kite.stop_order_id) continue;
          const breakeven = pick.trade.entry_price;
          const currentStop = pick.levels.stop;
          const shouldTighten = pick.direction === 'LONG' ? breakeven > currentStop : breakeven < currentStop;

          if (shouldTighten) {
            try {
              const newStop = roundToTick(breakeven);
              await kiteOrderService.modifyOrder(pick.kite.stop_order_id, { trigger_price: newStop });
              console.log(`${LOG} [MIDDAY-INTEL] ${pick.symbol}: Stop tightened ₹${currentStop} → ₹${newStop} (breakeven)`);
              pick.levels.stop = newStop;
              if (!pick.trailing_history) pick.trailing_history = [];
              pick.trailing_history.push({ timestamp: new Date(), old_stop: currentStop, new_stop: newStop, price_at_trail: breakeven, reason: 'midday_intel_extreme' });
            } catch (modErr) {
              console.error(`${LOG} [MIDDAY-INTEL] ${pick.symbol}: Stop modify failed: ${modErr.message}`);
            }
          }
        }

        try {
          await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
            '⛔ Midday Alert — Stops Tightened',
            `Midday intel re-check detected extreme risk: ${middayAvoid.reason}. All stops moved to breakeven.`,
            { type: 'MIDDAY_INTEL', route: '/daily-picks' }
          );
        } catch (_) { /* ignore */ }
      } else {
        console.log(`${LOG} [MIDDAY-INTEL] Risk level: ${middayIntel.risk_level} — no action needed`);
      }
      doc._middayIntelChecked = true;
    } catch (intelErr) {
      console.error(`${LOG} [MIDDAY-INTEL] Re-check failed (non-fatal): ${intelErr.message}`);
    }
  }

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

  // ═══════════════════════════════════════════════════════════════════════════
  // ENHANCED MONITORING: Trailing + Partial Profit Booking + Sideways Exit
  // ═══════════════════════════════════════════════════════════════════════════
  const istNow2 = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const istHour = istNow2.getHours();
  const istMinutes2 = istHour * 60 + istNow2.getMinutes();
  const stillEnteredPicks = doc.picks.filter(p => p.trade.status === 'ENTERED' && p.kite.stop_order_id);

  if (istHour >= TRAIL_START_HOUR && stillEnteredPicks.length > 0 && !dryRun) {
    console.log(`${LOG} [MONITOR+] Checking trailing/partial/sideways for ${stillEnteredPicks.length} positions`);

    // Fetch fresh LTP via Kite Connect API
    const symbols = stillEnteredPicks.map(p => `NSE:${p.symbol}`);
    try {
      const ltpData = await kiteOrderService.getLTP(symbols);

      for (const pick of stillEnteredPicks) {
        const currentPrice = ltpData[`NSE:${pick.symbol}`]?.last_price;
        if (!currentPrice || !pick.trade.entry_price) continue;

        const profitPct = ((currentPrice - pick.trade.entry_price) / pick.trade.entry_price) * 100 *
          (pick.direction === 'LONG' ? 1 : -1);
        const minutesSinceEntry = pick.trade.entry_time
          ? (Date.now() - new Date(pick.trade.entry_time).getTime()) / 60000
          : 999;

        // ── 1. PARTIAL PROFIT BOOKING (shared decision function) ──
        const partialDecision = checkPartialBooking({
          entryPrice: pick.trade.entry_price,
          currentPrice,
          targetPrice: pick.levels.target,
          direction: pick.direction,
          totalQty: pick.trade.qty,
          alreadyBooked: !!pick._partial_booked,
        });

        if (partialDecision.shouldBook) {
            {
              const partialQty = partialDecision.bookQty;
              console.log(`${LOG} [PARTIAL] ${pick.symbol}: Price ₹${currentPrice} reached book level ₹${round2(partialDecision.bookLevel)} — booking ${partialQty}/${pick.trade.qty} shares`);
              try {
                const exitSide = pick.direction === 'LONG' ? 'SELL' : 'BUY';
                const partialResult = await kiteOrderService.placeOrder({
                  tradingsymbol: pick.symbol, exchange: 'NSE',
                  transaction_type: exitSide, order_type: 'MARKET',
                  product: 'MIS', quantity: partialQty,
                  simulationId: `daily_pick_partial_${pick.symbol}`,
                  orderType: 'PARTIAL_EXIT', source: 'DAILY_PICKS'
                });

                if (partialResult.success) {
                  // Reduce remaining qty and update SL/target order quantities
                  const remainingQty = pick.trade.qty - partialQty;
                  pick._partial_booked = true;
                  pick.trade.partial_exit_qty = partialQty;
                  pick.trade.partial_exit_price = currentPrice;

                  // Modify SL and target orders to remaining qty
                  try {
                    if (pick.kite.stop_order_id) {
                      await kiteOrderService.modifyOrder(pick.kite.stop_order_id, { quantity: remainingQty });
                    }
                    if (pick.kite.target_order_id) {
                      await kiteOrderService.modifyOrder(pick.kite.target_order_id, { quantity: remainingQty });
                    }
                    pick.trade.qty = remainingQty;
                  } catch (modErr) {
                    console.error(`${LOG} [PARTIAL] ${pick.symbol}: Failed to modify SL/target qty:`, modErr.message);
                  }

                  // Move stop to breakeven after partial booking
                  const newStop = pick.trade.entry_price;
                  const currentStop = pick.levels.stop;
                  const shouldMove = pick.direction === 'LONG' ? newStop > currentStop : newStop < currentStop;
                  if (shouldMove) {
                    try {
                      await kiteOrderService.modifyOrder(pick.kite.stop_order_id, { trigger_price: newStop });
                      if (!pick.trailing_history) pick.trailing_history = [];
                      pick.trailing_history.push({ timestamp: new Date(), old_stop: currentStop, new_stop: newStop, price_at_trail: currentPrice });
                      pick.levels.stop = newStop;
                      console.log(`${LOG} [PARTIAL] ${pick.symbol}: Stop moved to breakeven ₹${newStop} after partial exit`);
                    } catch (_) { /* SL modify fail is non-fatal since we already booked profit */ }
                  }

                  statusChanged = true;
                  console.log(`${LOG} [PARTIAL] ✅ ${pick.symbol}: Booked ${partialQty} shares @ ₹${currentPrice}, remaining ${remainingQty}`);
                }
              } catch (err) {
                console.error(`${LOG} [PARTIAL] ${pick.symbol}: Partial exit failed:`, err.message);
              }
            }
        }

        // ── 1b. +1R BREAKEVEN (price-based, not time-based) ──
        // Move stop to breakeven as soon as profit reaches 1R (original risk distance)
        const isBullish = pick.direction === 'LONG';
        const originalRisk = Math.abs(pick.trade.entry_price - pick.levels.stop);
        const currentProfit = isBullish
          ? currentPrice - pick.trade.entry_price
          : pick.trade.entry_price - currentPrice;
        const profitR = originalRisk > 0 ? currentProfit / originalRisk : 0;

        if (profitR >= 1.0 && !pick._breakeven_moved) {
          const currentStop = pick.levels.stop;
          const beStop = pick.trade.entry_price;
          const shouldMove = isBullish ? beStop > currentStop : beStop < currentStop;

          if (shouldMove) {
            try {
              await kiteOrderService.modifyOrder(pick.kite.stop_order_id, { trigger_price: beStop });
              if (!pick.trailing_history) pick.trailing_history = [];
              pick.trailing_history.push({ timestamp: new Date(), old_stop: currentStop, new_stop: beStop, price_at_trail: currentPrice, reason: 'breakeven_1R' });
              pick.levels.stop = beStop;
              pick._breakeven_moved = true;
              statusChanged = true;
              console.log(`${LOG} [+1R BE] ${pick.symbol}: Profit ${round2(profitR)}R — stop moved to breakeven ₹${currentStop} → ₹${beStop}`);
            } catch (err) {
              console.error(`${LOG} [+1R BE] ${pick.symbol}: modifyOrder failed:`, err.message);
            }
          } else {
            pick._breakeven_moved = true; // Already at/above breakeven
          }
        }

        // ── 2. DYNAMIC TRAILING STOPS (Chandelier Exit via shared engine) ──
        // Tracks highest high since entry, trails using ATR-based multiplier
        // Falls back to fixed ratio if ATR not available

        // Track highest high / lowest low on the pick object (persists across monitor cycles)
        if (!pick._extreme_price) pick._extreme_price = pick.trade.entry_price;
        if (isBullish) {
          if (currentPrice > pick._extreme_price) pick._extreme_price = currentPrice;
        } else {
          if (currentPrice < pick._extreme_price) pick._extreme_price = currentPrice;
        }

        // Use ATR from enrichment step (stored on pick during scoring)
        const pickATR = pick._ohlcv?.atr || pick.indicators?.atr || 0;

        const currentStop = pick.levels.stop;
        const trail = computeDynamicTrail({
          entryPrice: pick.trade.entry_price,
          currentPrice,
          extremePrice: pick._extreme_price,
          currentStop,
          atr: pickATR,
          profitPct,
          minutesSinceEntry,
          istHour,
          isBullish,
          partialBooked: !!pick._partial_booked,
        });

        if (trail.shouldTrail) {
          try {
            await kiteOrderService.modifyOrder(pick.kite.stop_order_id, {
              trigger_price: trail.newStop
            });
            if (!pick.trailing_history) pick.trailing_history = [];
            pick.trailing_history.push({ timestamp: new Date(), old_stop: currentStop, new_stop: trail.newStop, price_at_trail: currentPrice, phase: trail.phase, method: trail.method });
            pick.levels.stop = trail.newStop;
            statusChanged = true;
            console.log(`${LOG} [TRAILING] ${pick.symbol}: Stop ₹${currentStop} → ₹${trail.newStop} [${trail.method} P${trail.phase}] (price=₹${currentPrice}, peak=₹${round2(pick._extreme_price)}, ${trail.reason})`);
          } catch (err) {
            console.error(`${LOG} [TRAILING] ${pick.symbol}: modifyOrder failed:`, err.message);
          }
        }

        // ── 3. SIDEWAYS EXIT (shared decision function) ──
        const sidewaysDecision = checkSidewaysExit(minutesSinceEntry, profitPct);
        if (sidewaysDecision.shouldExit) {
          console.log(`${LOG} [SIDEWAYS] ${pick.symbol}: ${sidewaysDecision.reason}, P&L=${round2(profitPct)}% — exiting dead position`);
          try {
            // Cancel protective orders
            if (pick.kite.stop_order_id) {
              try { await kiteOrderService.cancelOrder(pick.kite.stop_order_id); } catch (_) { /* ignore */ }
            }
            if (pick.kite.target_order_id) {
              try { await kiteOrderService.cancelOrder(pick.kite.target_order_id); } catch (_) { /* ignore */ }
            }
            await delay(1000);

            const exitSide = pick.direction === 'LONG' ? 'SELL' : 'BUY';
            const exitResult = await kiteOrderService.placeOrder({
              tradingsymbol: pick.symbol, exchange: 'NSE',
              transaction_type: exitSide, order_type: 'MARKET',
              product: 'MIS', quantity: pick.trade.qty,
              simulationId: `daily_pick_sideways_${pick.symbol}`,
              orderType: 'SIDEWAYS_EXIT', source: 'DAILY_PICKS'
            });

            if (exitResult.success) {
              await delay(2000);
              let exitPrice = currentPrice;
              try {
                const exitOrder = await kiteOrderService.getOrderDetails(exitResult.orderId);
                if (exitOrder?.average_price) exitPrice = exitOrder.average_price;
              } catch (_) { /* use LTP */ }

              pick.trade.status = 'TIME_EXIT';
              pick.trade.exit_price = exitPrice;
              pick.trade.exit_time = new Date();
              pick.trade.exit_reason = sidewaysDecision.reason;
              pick.trade.exit_price_source = 'order_fill';
              calculatePnl(pick);
              pick.kite.kite_status = 'completed';
              statusChanged = true;
              console.log(`${LOG} [SIDEWAYS] ✅ ${pick.symbol}: Exited @ ₹${exitPrice}, PnL: ₹${pick.trade.pnl}`);
            }
          } catch (err) {
            console.error(`${LOG} [SIDEWAYS] ${pick.symbol}: Exit failed:`, err.message);
          }
          continue; // Skip further checks (trailing etc.) for this pick after exit
        }
      }
    } catch (err) {
      console.error(`${LOG} [MONITOR+] LTP fetch failed:`, err.message);
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

  // Daily P&L dashboard — aggregate all completed + in-progress trades
  const allPicks = doc.picks;
  const completed = allPicks.filter(p => ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT'].includes(p.trade.status));
  const totalRealizedPnl = completed.reduce((sum, p) => sum + (p.trade.pnl || 0), 0);
  const winners = completed.filter(p => (p.trade.pnl || 0) > 0).length;
  const losers = completed.filter(p => (p.trade.pnl || 0) < 0).length;
  console.log(`${LOG} ┌── DAILY DASHBOARD ──────────────────────────`);
  console.log(`${LOG} │ Active: ${stillEntered} | Completed: ${completed.length} (W:${winners} L:${losers})`);
  console.log(`${LOG} │ Realized P&L: ₹${round2(totalRealizedPnl)}`);
  for (const p of completed) {
    console.log(`${LOG} │   ${p.symbol}: ${p.trade.status} P&L=₹${round2(p.trade.pnl || 0)} (${p.trade.exit_reason || 'N/A'})`);
  }
  console.log(`${LOG} └──────────────────────────────────────────────`);

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

  // Fetch fresh LTP via Kite Connect API
  const symbols = enteredPicks.map(p => `NSE:${p.symbol}`);
  let ltpData;
  try {
    console.log(`${LOG} [TIGHTEN] Fetching LTP for: ${symbols.join(', ')}`);
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
/**
 * Look up sector for a symbol using sectorMapping utility
 */
function getStockSector(symbol) {
  for (const [sectorKey, sectorData] of Object.entries(SECTOR_MAPPING)) {
    if (sectorData.companies && sectorData.companies.includes(symbol)) {
      return sectorKey;
    }
  }
  return 'UNKNOWN';
}

// mapSectorToIntelKey imported from ../../utils/sectorMapping.js — single source of truth


function selectDiversePicks(viable, maxPicks) {
  console.log(`${LOG} [Diversity] Selecting ${maxPicks} from ${viable.length} viable candidates`);

  // ── STEP 1: Sector cap on the full pool FIRST ──
  // Keep only the highest-scored stock per sector. This pre-cleans the pool
  // so Round 1 and Round 2 never select two correlated stocks.
  const sectorBest = {};
  const sectorDropped = [];
  // viable is already sorted by rank_score descending from Step 5.5 re-sort
  for (const pick of viable) {
    const sector = getStockSector(pick.symbol);
    if (sector === 'UNKNOWN' || !sectorBest[sector]) {
      sectorBest[`${sector}_${pick.symbol}`] = pick; // UNKNOWN can have multiple
      if (sector !== 'UNKNOWN') sectorBest[sector] = pick;
    } else {
      sectorDropped.push({ symbol: pick.symbol, sector, score: pick.rank_score, keptSymbol: sectorBest[sector].symbol });
    }
  }
  // Build sector-filtered pool (preserving score order)
  const keptSymbols = new Set();
  for (const key of Object.keys(sectorBest)) {
    keptSymbols.add(sectorBest[key].symbol);
  }
  const sectorFiltered = viable.filter(p => keptSymbols.has(p.symbol));

  if (sectorDropped.length > 0) {
    console.log(`${LOG} [Diversity] Sector cap: ${viable.length} → ${sectorFiltered.length} (dropped ${sectorDropped.length}: ${sectorDropped.map(d => `${d.symbol}[${d.sector}] kept ${d.keptSymbol}`).join(', ')})`);
  }

  if (sectorFiltered.length <= maxPicks) {
    console.log(`${LOG} [Diversity] ${sectorFiltered.length} ≤ ${maxPicks} slots — taking all`);
    logDiversityBreakdown(sectorFiltered);
    return sectorFiltered;
  }

  // ── STEP 2: Round 1 — One per scan type from clean pool ──
  const byType = {};
  for (const pick of sectorFiltered) {
    const key = pick.scan_type;
    if (!byType[key]) byType[key] = [];
    byType[key].push(pick);
  }

  console.log(`${LOG} [Diversity] Groups: ${Object.entries(byType).map(([k, v]) => `${k}(${v.length}): [${v.map(p => `${p.symbol}:${p.rank_score}`).join(', ')}]`).join(' | ')}`);

  const selected = [];
  const usedSymbols = new Set();

  // Sort scan type groups by their best candidate's score
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

  // ── STEP 3: Round 2 — Fill remaining slots by score ──
  if (selected.length < maxPicks) {
    const remaining = sectorFiltered.filter(p => !usedSymbols.has(p.symbol));
    console.log(`${LOG} [Diversity] Round 2 — filling ${maxPicks - selected.length} remaining slots from ${remaining.length} candidates by score`);
    for (const pick of remaining) {
      if (selected.length >= maxPicks) break;
      selected.push(pick);
      usedSymbols.add(pick.symbol);
      console.log(`${LOG} [Diversity] Round 2: picked ${pick.symbol} (${pick.scan_type}, score=${pick.rank_score}, slot ${selected.length}/${maxPicks})`);
    }
  }

  logDiversityBreakdown(selected);
  return selected;
}

function logDiversityBreakdown(picks) {
  const typeCounts = {};
  const sectorCounts = {};
  for (const p of picks) {
    typeCounts[p.scan_type] = (typeCounts[p.scan_type] || 0) + 1;
    const sector = getStockSector(p.symbol);
    sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
  }
  console.log(`${LOG} [Diversity] Final picks: ${picks.map(s => `${s.symbol}(${s.scan_type}:${s.rank_score}:${getStockSector(s.symbol)})`).join(', ')}`);
  console.log(`${LOG} [Diversity] Type distribution: ${Object.entries(typeCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`${LOG} [Diversity] Sector distribution: ${Object.entries(sectorCounts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
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
  placePreMarketEntries,
  gapProtectionCheck,
  startOrbCollection,
  validateAndPlaceEntries,
  checkFillsFallback,
  cancelExpiredEntries,
  initFillListener,
  monitorDailyPickOrders,
  tightenStops,
  getMarketContext,
  detectCandlePattern,
  selectDiversePicks,
  getStockSector,
  MAX_DAILY_PICKS
};

export default {
  runDailyPicks,
  placePreMarketEntries,
  gapProtectionCheck,
  startOrbCollection,
  validateAndPlaceEntries,
  checkFillsFallback,
  cancelExpiredEntries,
  initFillListener,
  monitorDailyPickOrders,
  tightenStops,
  getMarketContext,
  detectCandlePattern,
  selectDiversePicks,
  getStockSector,
  MAX_DAILY_PICKS
};