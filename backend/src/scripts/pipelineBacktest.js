#!/usr/bin/env node
/**
 * PIPELINE BACKTEST — Full Pipeline Replay
 *
 * Replays the entire morning trading pipeline for historical dates:
 * 1. Load stock candidates from DailyPick.candidates_review (ChartInk scan results)
 * 2. Fetch global market intel for that date via Claude web search
 * 3. Re-score candidates using real pipeline functions
 * 4. Select top picks via real selectDiversePicks()
 * 5. Run ORB validation + tick-by-tick simulation using real 5-min candles
 * 6. Save results to separate DailyPickBacktest collection
 * 7. Compare with what the real system picked
 *
 * ALL functions are imported from the real system — zero reimplementation.
 *
 * Usage:
 *   node pipelineBacktest.js                        # Last 30 days
 *   node pipelineBacktest.js --days 60              # Last 60 days
 *   node pipelineBacktest.js --from 2026-01-01      # From specific date
 *   node pipelineBacktest.js --capital 200000        # Custom capital
 *   node pipelineBacktest.js --max-picks 2           # Pick top 2 instead of 3
 *   node pipelineBacktest.js --verbose               # Full timeline per pick
 *   node pipelineBacktest.js --skip-intel            # Skip global intel fetch (use stored)
 *
 * MUST run on server with MongoDB + Upstox API + Anthropic API access.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../../.env') });

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORTS — ALL from real system, zero reimplementation
// ═══════════════════════════════════════════════════════════════════════════════

import { round2 } from '../services/dailyPicks/dailyPicksHelpers.js';
import {
  selectDiversePicks,
  getStockSector,
  MAX_DAILY_PICKS
} from '../services/dailyPicks/dailyPicksService.js';
import { mapSectorToIntelKey } from '../utils/sectorMapping.js';
import {
  INTEL_DIRECTION_PENALTY,
  INTEL_STOCK_NEWS_ALIGNED_HIGH,
  INTEL_STOCK_NEWS_OPPOSING_HIGH,
  INTEL_STOCK_NEWS_ALIGNED_LOW,
  INTEL_STOCK_NEWS_OPPOSING_LOW,
  INTEL_SECTOR_ALIGNED,
  INTEL_SECTOR_OPPOSING,
} from '../services/dailyPicks/dailyPicksConstants.js';
import {
  fetchGlobalMarketIntel,
  clearIntelCache
} from '../services/dailyPicks/globalMarketIntel.js';
import {
  SIM,
  getAccessToken,
  fetch5minCandles,
  sleep,
  simulatePick,
  loadInstrumentMap,
  getNiftyKey
} from './backtestUtils.js';

const LOG = '[PIPELINE-BT]';

/**
 * Convert a UTC Date to IST date string (YYYY-MM-DD).
 * MongoDB stores trading_date as IST midnight → e.g., 2026-03-05T18:30:00Z = 2026-03-06 IST.
 * Using toISOString().split('T')[0] gives the WRONG (UTC) date.
 */
function toISTDateStr(date) {
  if (!date) return 'UNKNOWN';
  const istOffset = 5.5 * 60 * 60 * 1000; // +5:30 in ms
  const istDate = new Date(new Date(date).getTime() + istOffset);
  return istDate.toISOString().split('T')[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI ARGS
// ═══════════════════════════════════════════════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    days: 30,
    from: null,
    capital: 100000,
    maxPicks: MAX_DAILY_PICKS,
    verbose: false,
    skipIntel: false
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[i + 1]);
    if (args[i] === '--from' && args[i + 1]) opts.from = args[i + 1];
    if (args[i] === '--capital' && args[i + 1]) opts.capital = parseFloat(args[i + 1]);
    if (args[i] === '--max-picks' && args[i + 1]) opts.maxPicks = Math.min(3, Math.max(1, parseInt(args[i + 1])));
    if (args[i] === '--verbose') opts.verbose = true;
    if (args[i] === '--skip-intel') opts.skipIntel = true;
  }
  return opts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CANDIDATE EXTRACTION — from DailyPick.candidates_review
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract viable candidates from DailyPick.candidates_review.
 * Only keeps stocks with status='viable' or 'selected' (passed all gates).
 * Returns them in a format compatible with selectDiversePicks().
 */
function extractViableCandidates(doc, intel) {
  const candidates = doc.candidates_review || [];
  if (candidates.length === 0) return { viable: [], allCandidates: candidates, realPicks: [] };

  const viable = [];
  const adjustmentLog = [];

  for (const c of candidates) {
    if (c.status !== 'viable' && c.status !== 'selected') continue;
    if (!c.levels || !c.levels.entry || !c.levels.stop || !c.levels.target) continue;

    // Build a pick object compatible with selectDiversePicks()
    // and simulatePick() — includes levels, indicators, scan_type, direction, rank_score
    const originalScore = c.rank_score || 0;
    let adjustedScore = originalScore;
    const reasons = [];

    // Apply global intel adjustments if available
    if (intel && intel.trading_recommendation) {
      if (intel.trading_recommendation === 'AVOID_SHORTS' && c.direction === 'SHORT') {
        adjustedScore += INTEL_DIRECTION_PENALTY;
        reasons.push(`rec=AVOID_SHORTS → ${INTEL_DIRECTION_PENALTY}`);
      }
      if (intel.trading_recommendation === 'AVOID_LONGS' && c.direction === 'LONG') {
        adjustedScore += INTEL_DIRECTION_PENALTY;
        reasons.push(`rec=AVOID_LONGS → ${INTEL_DIRECTION_PENALTY}`);
      }
      if (intel.trading_recommendation === 'STAY_OUT') {
        adjustmentLog.push(`  ⛔ ${c.symbol} (${c.direction}): BLOCKED — rec=STAY_OUT`);
        continue; // Skip all candidates
      }
      if (intel.trading_recommendation === 'REDUCE_SIZE') {
        reasons.push(`rec=REDUCE_SIZE (noted, no score change)`);
      }
    }

    // Stock-specific news from intel (highest priority)
    if (intel && intel.stock_specific && intel.stock_specific[c.symbol]) {
      const stockNews = intel.stock_specific[c.symbol];
      const isBullish = c.direction === 'LONG';
      const aligned = (isBullish && stockNews.sentiment === 'BULLISH') || (!isBullish && stockNews.sentiment === 'BEARISH');
      const opposing = (isBullish && stockNews.sentiment === 'BEARISH') || (!isBullish && stockNews.sentiment === 'BULLISH');

      if (aligned && stockNews.impact === 'HIGH') {
        adjustedScore += INTEL_STOCK_NEWS_ALIGNED_HIGH;
        reasons.push(`stock_news ALIGNED +${INTEL_STOCK_NEWS_ALIGNED_HIGH} (${stockNews.sentiment}, "${stockNews.headline || ''}")`);
      } else if (opposing && stockNews.impact === 'HIGH') {
        adjustedScore += INTEL_STOCK_NEWS_OPPOSING_HIGH;
        reasons.push(`stock_news OPPOSING ${INTEL_STOCK_NEWS_OPPOSING_HIGH} (${stockNews.sentiment}, "${stockNews.headline || ''}")`);
      } else if (aligned) {
        adjustedScore += INTEL_STOCK_NEWS_ALIGNED_LOW;
        reasons.push(`stock_news aligned +${INTEL_STOCK_NEWS_ALIGNED_LOW} (${stockNews.sentiment}, "${stockNews.headline || ''}")`);
      } else if (opposing) {
        adjustedScore += INTEL_STOCK_NEWS_OPPOSING_LOW;
        reasons.push(`stock_news opposing ${INTEL_STOCK_NEWS_OPPOSING_LOW} (${stockNews.sentiment}, "${stockNews.headline || ''}")`);
      }
    }

    // Sector sentiment from intel
    if (intel && intel.sectors) {
      const sector = getStockSector(c.symbol);
      const sectorKey = mapSectorToIntelKey(sector);
      const sectorIntel = intel.sectors[sectorKey];
      if (sectorIntel) {
        if (sectorIntel.sentiment === 'BULLISH' && c.direction === 'LONG') { adjustedScore += INTEL_SECTOR_ALIGNED; reasons.push(`sector ${sectorKey} BULLISH+LONG → +${INTEL_SECTOR_ALIGNED}`); }
        if (sectorIntel.sentiment === 'BEARISH' && c.direction === 'SHORT') { adjustedScore += INTEL_SECTOR_ALIGNED; reasons.push(`sector ${sectorKey} BEARISH+SHORT → +${INTEL_SECTOR_ALIGNED}`); }
        if (sectorIntel.sentiment === 'BEARISH' && c.direction === 'LONG') { adjustedScore += INTEL_SECTOR_OPPOSING; reasons.push(`sector ${sectorKey} BEARISH vs LONG → ${INTEL_SECTOR_OPPOSING}`); }
        if (sectorIntel.sentiment === 'BULLISH' && c.direction === 'SHORT') { adjustedScore += INTEL_SECTOR_OPPOSING; reasons.push(`sector ${sectorKey} BULLISH vs SHORT → ${INTEL_SECTOR_OPPOSING}`); }
      }
    }

    // Log the adjustment
    const delta = adjustedScore - originalScore;
    if (delta !== 0) {
      adjustmentLog.push(`  ${delta > 0 ? '📈' : '📉'} ${c.symbol} (${c.direction}): ${originalScore}→${adjustedScore} (${delta > 0 ? '+' : ''}${delta}) | ${reasons.join(' | ')}`);
    } else if (reasons.length > 0) {
      adjustmentLog.push(`  ➖ ${c.symbol} (${c.direction}): ${originalScore} unchanged | ${reasons.join(' | ')}`);
    }

    viable.push({
      symbol: c.symbol,
      scan_type: c.scan_type,
      direction: c.direction,
      rank_score: adjustedScore,
      original_score: c.rank_score,
      levels: { ...c.levels },
      indicators: c.indicators ? { ...c.indicators } : {},
      candle: c.candle ? { ...c.candle } : {},
      _ohlcv: c.indicators ? { atr: c.indicators.atr } : {}
    });
  }

  // Log all intel adjustments
  if (adjustmentLog.length > 0) {
    console.log(`${LOG}   [C] ─── Intel Score Adjustments ───`);
    for (const line of adjustmentLog) console.log(`${LOG}   ${line}`);
    console.log(`${LOG}   [C] ────────────────────────────────`);
  } else if (intel) {
    console.log(`${LOG}   [C] No intel score adjustments (no matching sectors/news)`);
  }

  // Sort by adjusted score descending
  viable.sort((a, b) => b.rank_score - a.rank_score);

  // Extract real system picks for comparison
  const realPicks = (doc.picks || []).map(p => ({
    symbol: p.symbol,
    direction: p.direction,
    rank_score: p.rank_score || 0
  }));

  return { viable, allCandidates: candidates, realPicks };
}

// mapSectorToIntelKey imported from ../utils/sectorMapping.js — single source of truth

// ═══════════════════════════════════════════════════════════════════════════════
// COMPARISON
// ═══════════════════════════════════════════════════════════════════════════════

function comparePickSets(realPicks, backtestPicks) {
  const realSymbols = new Set(realPicks.map(p => p.symbol));
  const btSymbols = new Set(backtestPicks.map(p => p.symbol));

  const overlap = [...realSymbols].filter(s => btSymbols.has(s));
  const realOnly = [...realSymbols].filter(s => !btSymbols.has(s));
  const btOnly = [...btSymbols].filter(s => !realSymbols.has(s));

  return {
    real_picks: realPicks,
    backtest_picks: backtestPicks.map(p => ({ symbol: p.symbol, direction: p.direction, rank_score: p.rank_score })),
    overlap_symbols: overlap,
    real_only_symbols: realOnly,
    backtest_only_symbols: btOnly
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const opts = parseArgs();

  console.log(`\n${LOG} ═══════════════════════════════════════════════════════`);
  console.log(`${LOG} PIPELINE BACKTEST — Full Pipeline Replay`);
  console.log(`${LOG} Period: ${opts.from || `last ${opts.days} days`} | Capital: ₹${opts.capital} | Max-picks: ${opts.maxPicks}`);
  console.log(`${LOG} Intel: ${opts.skipIntel ? 'SKIP (use stored)' : 'FETCH via Claude web search'} | Verbose: ${opts.verbose}`);
  console.log(`${LOG} ═══════════════════════════════════════════════════════\n`);

  // ── INIT ──
  console.log(`${LOG} [STEP 1/6] Connecting to MongoDB...`);
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`${LOG} [STEP 1/6] ✅ MongoDB connected`);
  } catch (err) {
    console.error(`${LOG} [STEP 1/6] ❌ MongoDB failed:`, err.message);
    process.exit(1);
  }

  console.log(`${LOG} [STEP 2/6] Loading Upstox access token...`);
  try {
    await getAccessToken();
    console.log(`${LOG} [STEP 2/6] ✅ Upstox token loaded`);
  } catch (err) {
    console.error(`${LOG} [STEP 2/6] ❌ Upstox token failed:`, err.message);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`${LOG} [STEP 3/6] Importing models...`);
  const DailyPick = (await import('../models/dailyPick.js')).default;
  const DailyPickBacktest = (await import('../models/dailyPickBacktest.js')).default;
  console.log(`${LOG} [STEP 3/6] ✅ Models imported`);

  console.log(`${LOG} [STEP 4/6] Loading instrument key map from DB...`);
  const instrumentMap = await loadInstrumentMap();
  console.log(`${LOG} [STEP 4/6] ✅ ${Object.keys(instrumentMap).length} instrument keys loaded`);

  console.log(`${LOG} [STEP 5/6] Resolving NIFTY instrument key...`);
  const niftyKey = getNiftyKey(instrumentMap);
  console.log(`${LOG} [STEP 5/6] ✅ NIFTY key: ${niftyKey || 'NOT FOUND'}`);

  console.log(`${LOG} [STEP 6/6] Querying DailyPick records...`);
  // trading_date in DB is IST midnight stored as UTC (e.g., March 6 IST = March 5 18:30 UTC)
  // So subtract an extra 5.5 hours from cutoff to ensure IST dates aren't missed
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const cutoff = opts.from
    ? new Date(new Date(opts.from).getTime() - IST_OFFSET_MS)
    : new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000 - IST_OFFSET_MS);
  console.log(`${LOG} [STEP 6/6] Cutoff date: ${toISTDateStr(cutoff)} IST / ${cutoff.toISOString()} UTC (--days ${opts.days})`);
  const docs = await DailyPick.find({ trading_date: { $gte: cutoff } }).sort({ trading_date: 1 }).lean();
  console.log(`${LOG} [STEP 6/6] ✅ ${docs.length} trading days found`);
  if (docs.length > 0) {
    console.log(`${LOG} [STEP 6/6] Dates (IST): ${docs.map(d => toISTDateStr(d.trading_date)).join(', ')}`);
  }
  console.log('');

  if (docs.length === 0) {
    console.log(`${LOG} No data to simulate.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── DAY-BY-DAY PIPELINE REPLAY ──
  let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0;
  let totalSkipped = 0, totalNoFill = 0, totalTargetHits = 0, totalStopOuts = 0, totalTimeExits = 0;
  let maxDrawdown = 0, peakPnl = 0;
  let daysAlgoBetter = 0, daysRealBetter = 0, daysSame = 0;
  const dailySummary = [];

  for (let di = 0; di < docs.length; di++) {
    const doc = docs[di];
    const dateStr = toISTDateStr(doc.trading_date);
    const regime = doc.market_context?.regime || 'UNKNOWN';
    const totalCandidates = doc.candidates_review?.length || 0;

    console.log(`${LOG} ── Day ${di + 1}/${docs.length}: ${dateStr} | Regime: ${regime} | Candidates: ${totalCandidates} ──`);

    if (totalCandidates === 0) {
      console.log(`${LOG} No candidates — skipping day`);
      dailySummary.push({ date: dateStr, regime, dayPnl: 0, trades: 0 });
      continue;
    }

    // ── STEP A: Extract candidate symbols FIRST, then fetch intel with them ──
    console.log(`${LOG}   [A] Extracting candidate symbols...`);
    const candidateSymbols = (doc.candidates_review || [])
      .filter(c => c.status === 'viable' || c.status === 'selected')
      .map(c => c.symbol);
    console.log(`${LOG}   [A] ✅ ${candidateSymbols.length} viable/selected symbols: ${candidateSymbols.join(', ')}`);

    let intel = null;
    if (!opts.skipIntel) {
      try {
        console.log(`${LOG}   [B] Fetching global intel via Claude web search for ${dateStr}...`);
        clearIntelCache(); // Clear cache so each day gets fresh intel
        intel = await fetchGlobalMarketIntel(dateStr, candidateSymbols);
        console.log(`${LOG}   [B] ✅ Intel: mood=${intel.market_mood} risk=${intel.risk_level} rec=${intel.trading_recommendation}`);
        // 60s inter-day pause is added at end of day loop for rate-limit cooldown
      } catch (err) {
        console.error(`${LOG}   [B] ❌ Intel fetch failed for ${dateStr}: ${err.message} — continuing without`);
      }
    } else {
      console.log(`${LOG}   [B] Skipping intel (--skip-intel), using stored context`);
      // Use stored market context as basic intel
      const mc = doc.market_context;
      if (mc?.news_mood) {
        intel = {
          market_mood: mc.news_mood === 'BULLISH' ? 'BULLISH' : mc.news_mood === 'BEARISH' ? 'BEARISH' : 'NEUTRAL',
          risk_level: 'MEDIUM',
          trading_recommendation: 'NORMAL',
          sectors: {},
          source: 'stored'
        };
        console.log(`${LOG}   [B] ✅ Stored context: mood=${mc.news_mood} regime=${regime}`);
      } else {
        console.log(`${LOG}   [B] ⚠️ No stored market context found`);
      }
    }

    // ── STEP C: Extract viable candidates ──
    console.log(`${LOG}   [C] Extracting viable candidates with intel adjustments...`);
    const { viable, allCandidates, realPicks } = extractViableCandidates(doc, intel);
    const bullishCount = allCandidates.filter(c => c.direction === 'LONG').length;
    const bearishCount = allCandidates.filter(c => c.direction === 'SHORT').length;

    console.log(`${LOG}   [C] ✅ Candidates: ${totalCandidates} total (${bullishCount}B/${bearishCount}S) → ${viable.length} viable`);
    console.log(`${LOG}   [C] Real system picked: ${realPicks.map(p => `${p.symbol}(${p.rank_score})`).join(', ') || 'none'}`);

    if (viable.length === 0) {
      console.log(`${LOG}   [C] No viable candidates — skipping day`);
      dailySummary.push({ date: dateStr, regime, dayPnl: 0, trades: 0 });

      // Save empty backtest result
      try {
        await DailyPickBacktest.findOneAndUpdate(
          { trading_date: doc.trading_date },
          {
            trading_date: doc.trading_date,
            scan_date: doc.scan_date,
            market_context: doc.market_context,
            global_intel: intel,
            picks: [],
            summary: { total_candidates: totalCandidates, viable_candidates: 0, bullish_count: bullishCount, bearish_count: bearishCount, selected_count: 0 },
            results: { winners: 0, losers: 0, total_pnl: 0 },
            comparison: comparePickSets(realPicks, []),
            candidates_review: doc.candidates_review,
            backtest_config: { capital: opts.capital, max_picks: opts.maxPicks }
          },
          { upsert: true, new: true }
        );
      } catch (err) { console.error(`${LOG} DB save error: ${err.message}`); }

      continue;
    }

    // ── STEP D: Select top picks using REAL selectDiversePicks() ──
    console.log(`${LOG}   [D] Running selectDiversePicks(${viable.length} viable, max=${opts.maxPicks})...`);
    const selectedPicks = selectDiversePicks(viable, opts.maxPicks);
    console.log(`${LOG}   [D] ✅ Algorithm selected: ${selectedPicks.map(p => `${p.symbol}(${p.scan_type}:${p.rank_score})`).join(', ')}`);

    // ── STEP E: Fetch NIFTY candles ──
    console.log(`${LOG}   [E] Fetching NIFTY 5-min candles for ${dateStr}...`);
    const niftyCandles = await fetch5minCandles(niftyKey, dateStr);
    console.log(`${LOG}   [E] ✅ NIFTY candles: ${niftyCandles.length} bars`);
    await sleep(200);

    let dayPnl = 0;
    let dayTrades = 0;
    let dayWins = 0;
    let dayLosses = 0;
    const pickResults = [];

    for (let pi = 0; pi < selectedPicks.length; pi++) {
      const pick = selectedPicks[pi];
      const instKey = instrumentMap[pick.symbol];
      if (!instKey) {
        console.log(`${LOG}   [F${pi+1}] ${pick.symbol}: ❌ No instrument key — SKIP`);
        totalSkipped++;
        pickResults.push({
          ...pick,
          trade: { status: 'SKIPPED', exit_reason: 'no_instrument_key' }
        });
        continue;
      }

      console.log(`${LOG}   [F${pi+1}] Fetching ${pick.symbol} candles (key: ${instKey})...`);
      const stockCandles = await fetch5minCandles(instKey, dateStr);
      console.log(`${LOG}   [F${pi+1}] ✅ ${pick.symbol}: ${stockCandles.length} bars loaded`);
      await sleep(200);

      console.log(`${LOG}   [F${pi+1}] Simulating ${pick.symbol} ${pick.direction} (entry=${pick.levels?.entry} stop=${pick.levels?.stop} target=${pick.levels?.target})...`);
      const sim = simulatePick(pick, stockCandles, niftyCandles, opts.capital, selectedPicks, regime);

      // Print timeline
      if (opts.verbose) {
        for (const line of sim.timeline) console.log(`${LOG}   ${line}`);
      } else {
        const statusIcon = { TARGET_HIT: '🎯', STOPPED_OUT: '🛑', TIME_EXIT: '⏰', SKIPPED: '⏭️', NO_FILL: '❌', NO_DATA: '❓' };
        const icon = statusIcon[sim.finalStatus] || '?';
        const pnlStr = sim.entered ? `₹${round2(sim.pnl)}` : '-';
        console.log(`${LOG}   ${pick.symbol} ${pick.direction} | ${icon} ${sim.finalStatus} | Entry ₹${round2(sim.entryPrice || 0)} Exit ₹${round2(sim.exitPrice || 0)} | P&L ${pnlStr} | ${sim.exitReason || '-'}`);
      }

      // Build pick result for DB
      const pickResult = {
        symbol: pick.symbol,
        instrument_key: instKey,
        scan_type: pick.scan_type,
        direction: pick.direction,
        rank_score: pick.rank_score,
        levels: pick.levels,
        indicators: pick.indicators,
        trade: {
          status: sim.finalStatus,
          entry_price: sim.entryPrice || null,
          entry_time: sim.entryTime ? new Date(sim.entryTime) : null,
          exit_price: sim.exitPrice || null,
          exit_time: sim.exitTime ? new Date(sim.exitTime) : null,
          exit_reason: sim.exitReason,
          qty: sim.qty,
          pnl: sim.pnl,
          return_pct: sim.returnPct,
          partial_exit_qty: sim.partialQty || null,
          partial_exit_price: sim.partialPrice || null
        },
        orb: {
          result: sim.orbResult,
          orb_pass: sim.orbEntry ? 1 : null
        },
        validation: {
          passed: sim.orbResult === 'PASSED',
          skip_reason: sim.orbResult === 'FAILED' ? sim.exitReason : null
        },
        trailing_history: sim.trailingHistory?.map(t => ({
          timestamp: t.time,
          old_stop: t.oldStop,
          new_stop: t.newStop,
          price_at_trail: t.price
        })) || []
      };
      pickResults.push(pickResult);

      // Aggregate stats
      if (sim.finalStatus === 'SKIPPED') totalSkipped++;
      else if (sim.finalStatus === 'NO_FILL' || sim.finalStatus === 'NO_DATA') totalNoFill++;
      else {
        totalTrades++; dayTrades++;
        dayPnl += sim.pnl;
        totalPnl += sim.pnl;
        if (sim.pnl > 0) { totalWins++; dayWins++; }
        else if (sim.pnl < 0) { totalLosses++; dayLosses++; }
        if (sim.finalStatus === 'TARGET_HIT') totalTargetHits++;
        else if (sim.finalStatus === 'STOPPED_OUT') totalStopOuts++;
        else if (sim.finalStatus === 'TIME_EXIT') totalTimeExits++;
        if (totalPnl > peakPnl) peakPnl = totalPnl;
        const dd = peakPnl - totalPnl;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }

    // ── STEP G: Compare with real system ──
    console.log(`${LOG}   [G] Comparing algorithm picks vs real system...`);
    const comparison = comparePickSets(realPicks, selectedPicks);
    comparison.backtest_pnl = round2(dayPnl);

    // Simulate real system picks too for P&L comparison
    let realDayPnl = 0;
    const realPickSymbols = realPicks.map(p => p.symbol);
    const realPickDocs = (doc.picks || []).filter(p => realPickSymbols.includes(p.symbol));
    for (const rp of realPickDocs) {
      if (rp.trade?.pnl != null) {
        realDayPnl += rp.trade.pnl;
      }
    }
    comparison.real_pnl = round2(realDayPnl);

    if (dayPnl > realDayPnl) { daysAlgoBetter++; comparison.verdict = 'BACKTEST_BETTER'; }
    else if (dayPnl < realDayPnl) { daysRealBetter++; comparison.verdict = 'REAL_BETTER'; }
    else { daysSame++; comparison.verdict = 'SAME'; }

    // ── STEP H: Save to DailyPickBacktest ──
    console.log(`${LOG}   [H] Saving backtest results to DB...`);
    try {
      const dayResults = {
        winners: dayWins,
        losers: dayLosses,
        avg_return_pct: dayTrades > 0 ? round2(dayPnl / dayTrades) : 0,
        total_pnl: round2(dayPnl),
        best_pick: pickResults.reduce((best, p) => (!best || (p.trade?.pnl || 0) > (best.trade?.pnl || 0)) ? p : best, null)?.symbol || null,
        worst_pick: pickResults.reduce((worst, p) => (!worst || (p.trade?.pnl || 0) < (worst.trade?.pnl || 0)) ? p : worst, null)?.symbol || null
      };

      await DailyPickBacktest.findOneAndUpdate(
        { trading_date: doc.trading_date },
        {
          trading_date: doc.trading_date,
          scan_date: doc.scan_date,
          market_context: doc.market_context,
          global_intel: intel,
          picks: pickResults,
          summary: {
            total_candidates: totalCandidates,
            viable_candidates: viable.length,
            bullish_count: bullishCount,
            bearish_count: bearishCount,
            selected_count: selectedPicks.length
          },
          results: dayResults,
          comparison,
          candidates_review: doc.candidates_review,
          backtest_config: { capital: opts.capital, max_picks: opts.maxPicks }
        },
        { upsert: true, new: true }
      );
      console.log(`${LOG}   [H] ✅ Saved to DB`);
    } catch (err) { console.error(`${LOG}   [H] ❌ DB save error: ${err.message}`); }

    // ── Day summary ──
    const dayIcon = dayPnl >= 0 ? '✅' : '❌';
    const overlapStr = comparison.overlap_symbols.length > 0 ? `overlap=[${comparison.overlap_symbols.join(',')}]` : 'no overlap';
    console.log(`${LOG} ${dayIcon} Day P&L: ₹${round2(dayPnl)} (real: ₹${round2(realDayPnl)}) | ${overlapStr} | Cum: ₹${round2(totalPnl)}\n`);
    dailySummary.push({ date: dateStr, regime, dayPnl: round2(dayPnl), realPnl: round2(realDayPnl), trades: dayTrades });

    // Rate-limit pause between days when using Claude web search for intel
    if (!opts.skipIntel && di < docs.length - 1) {
      console.log(`${LOG} ⏳ Waiting 60s before next day (API rate-limit cooldown)...`);
      await sleep(60000);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESULTS SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════

  const winRate = totalTrades > 0 ? round2((totalWins / totalTrades) * 100) : 0;
  const avgPnl = totalTrades > 0 ? round2(totalPnl / totalTrades) : 0;

  console.log(`\n${LOG} ═══════════════════════════════════════════════════════`);
  console.log(`${LOG} PIPELINE BACKTEST RESULTS`);
  console.log(`${LOG} ═══════════════════════════════════════════════════════`);
  console.log(`${LOG} Pipeline: ${docs.reduce((s, d) => s + (d.candidates_review?.length || 0), 0)} candidates → ${totalSkipped} skipped → ${totalNoFill} no-fill → ${totalTrades} executed`);
  console.log(`${LOG} Total P&L: ₹${round2(totalPnl)} | Win rate: ${winRate}% (${totalWins}W/${totalLosses}L) | Avg: ₹${avgPnl}/trade`);
  console.log(`${LOG} Exits: ${totalTargetHits} targets | ${totalStopOuts} stops | ${totalTimeExits} time`);
  console.log(`${LOG} Max drawdown: ₹${round2(maxDrawdown)}`);
  console.log(`${LOG} ───────────────────────────────────────────────────────`);
  console.log(`${LOG} COMPARISON: Algorithm vs Real System`);
  console.log(`${LOG} Days algo better: ${daysAlgoBetter} | Days real better: ${daysRealBetter} | Days same: ${daysSame}`);

  const totalRealPnl = dailySummary.reduce((s, d) => s + (d.realPnl || 0), 0);
  console.log(`${LOG} Cumulative P&L: Algorithm ₹${round2(totalPnl)} vs Real ₹${round2(totalRealPnl)}`);
  if (totalPnl > totalRealPnl) console.log(`${LOG} ✅ Algorithm outperformed real system by ₹${round2(totalPnl - totalRealPnl)}`);
  else if (totalPnl < totalRealPnl) console.log(`${LOG} ❌ Real system outperformed algorithm by ₹${round2(totalRealPnl - totalPnl)}`);
  else console.log(`${LOG} ➡️ Same performance`);

  console.log(`${LOG} ───────────────────────────────────────────────────────`);
  console.log(`${LOG} Daily timeline:`);

  let cum = 0;
  for (const day of dailySummary) {
    cum += day.dayPnl;
    const icon = day.dayPnl >= 0 ? '+' : '';
    const realIcon = day.dayPnl > (day.realPnl || 0) ? '▲' : day.dayPnl < (day.realPnl || 0) ? '▼' : '=';
    console.log(`${LOG}   ${day.date} | ${day.regime.padEnd(15)} | ${icon}₹${String(day.dayPnl).padStart(8)} | real ₹${String(day.realPnl || 0).padStart(8)} ${realIcon} | cum ₹${String(round2(cum)).padStart(10)} | ${day.trades}t`);
  }

  // Verdict
  console.log(`${LOG} ───────────────────────────────────────────────────────`);
  if (totalTrades < 5) {
    console.log(`${LOG} ⚠️ Only ${totalTrades} trades — not enough for statistical significance. Try --days 60`);
  } else {
    if (winRate > 55) console.log(`${LOG} ✅ Win rate ${winRate}% — strong edge`);
    else if (winRate > 45) console.log(`${LOG} ⚠️ Win rate ${winRate}% — marginal edge`);
    else console.log(`${LOG} ❌ Win rate ${winRate}% — needs improvement`);
  }
  console.log(`${LOG} Results saved to daily_picks_backtest collection`);
  console.log(`${LOG} ═══════════════════════════════════════════════════════\n`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(`${LOG} Fatal:`, err);
  process.exit(1);
});
