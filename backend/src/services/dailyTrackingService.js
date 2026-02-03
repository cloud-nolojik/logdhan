/**
 * Daily Tracking Service
 *
 * Two-phase daily tracking for WeeklyWatchlist stocks:
 *
 * PHASE 1: Status Update (every stock, NO AI, ~5-10 seconds total)
 *   - Uses getDailyAnalysisData() for all symbols at once
 *   - Compares closing data against weekend levels (pure math)
 *   - Sets tracking_status per stock
 *   - Saves daily_snapshot to WeeklyWatchlist
 *   - Detects status CHANGES → queue for Phase 2
 *
 * PHASE 2: AI Analysis (ONLY stocks with status change, 0-2 per day)
 *   - Claude with weekend context + trigger reason
 *   - Short focused output (500-800 tokens)
 *   - Save to StockAnalysis (analysis_type: 'daily_track')
 */

import WeeklyWatchlist from '../models/weeklyWatchlist.js';
import StockAnalysis from '../models/stockAnalysis.js';
import DailyNewsStock from '../models/dailyNewsStock.js';
import { getDailyAnalysisData } from './technicalData.service.js';
import { buildDailyTrackPrompt } from '../prompts/dailyTrackPrompts.js';
import Anthropic from '@anthropic-ai/sdk';
import ApiUsage from '../models/apiUsage.js';
import { firebaseService } from './firebase/firebase.service.js';

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 TRIGGERS - When to call AI
// ═══════════════════════════════════════════════════════════════════════════

const PHASE2_TRIGGERS = {
  // Status transitions that need AI guidance
  'WATCHING → ENTRY_ZONE':     'Stock entered buy zone. Should user enter now?',
  'WATCHING → RETEST_ZONE':    '52W breakout stock retesting old high. Is retest holding?',
  'APPROACHING → ENTRY_ZONE':  'Stock moved from approaching to entry zone.',
  'ENTRY_ZONE → ABOVE_ENTRY':  'Entry triggered. Confirm position or caution?',
  'ANY → STOPPED_OUT':         'Stop hit. Confirm exit or false break?',
  'ANY → TARGET1_HIT':         'T1 reached. Book profits or trail?',
  'ANY → TARGET2_HIT':         'T2 reached. Full exit recommended.',

  // Flags that need AI guidance (only if flag is NEW today)
  'NEW_FLAG: RSI_DANGER':      'RSI crossed 72. Risk of overextension.',
  'NEW_FLAG: RSI_EXIT':        'RSI crossed 75. Strong exit signal.',
  'NEW_FLAG: VOLUME_SPIKE':    'Unusual volume (2x+ average). Distribution or accumulation?',
  'NEW_FLAG: GAP_DOWN':        'Significant gap down (>3%). Reassess stop.'
};

// ═══════════════════════════════════════════════════════════════════════════
// STATUS CALCULATION (Pure Math, No AI)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate tracking status based on current price vs levels
 * @param {Object} dailyData - { ltp, daily_rsi, todays_volume, avg_volume_50d, ... }
 * @param {Object} levels - { entry, entryRange, stop, target, target2, archetype, ... }
 * @param {string} symbol - Stock symbol for logging
 * @returns {string} - New tracking status
 */
function calculateStatus(dailyData, levels, symbol = 'UNKNOWN') {
  const { ltp } = dailyData;
  const { entry, entryRange, stop, target, target2, archetype } = levels;

  // Use entryRange if available, otherwise ±1% of entry
  const entryLow = entryRange?.[0] || entry * 0.99;
  const entryHigh = entryRange?.[1] || entry * 1.01;

  console.log(`[STATUS-CALC] ${symbol}: LTP=${ltp}, Entry=${entry}, EntryRange=[${entryLow?.toFixed(2)}-${entryHigh?.toFixed(2)}]`);
  console.log(`[STATUS-CALC] ${symbol}: Stop=${stop}, Target=${target}, Target2=${target2 || 'N/A'}, Archetype=${archetype || 'standard'}`);

  // Priority order matters — check terminal states first

  // 1. Stop hit (terminal for the week)
  if (ltp < stop) {
    console.log(`[STATUS-CALC] ${symbol}: LTP ${ltp} < Stop ${stop} -> STOPPED_OUT`);
    return 'STOPPED_OUT';
  }

  // 2. Target2 hit (if exists)
  if (target2 && ltp >= target2) {
    console.log(`[STATUS-CALC] ${symbol}: LTP ${ltp} >= Target2 ${target2} -> TARGET2_HIT`);
    return 'TARGET2_HIT';
  }

  // 3. Target1 hit
  if (ltp >= target) {
    console.log(`[STATUS-CALC] ${symbol}: LTP ${ltp} >= Target ${target} -> TARGET1_HIT`);
    return 'TARGET1_HIT';
  }

  // 4. Entry zone (price within entry range)
  if (ltp >= entryLow && ltp <= entryHigh) {
    console.log(`[STATUS-CALC] ${symbol}: LTP ${ltp} in entry range [${entryLow.toFixed(2)}-${entryHigh.toFixed(2)}] -> ENTRY_ZONE`);
    return 'ENTRY_ZONE';
  }

  // 5. 52W breakout retest (archetype-aware)
  //    For 52W breakout stocks: if price pulls back to old 52W high area
  //    Retest zone: between stop+2% and entry low
  if (archetype === '52w_breakout') {
    const retestZoneBottom = stop * 1.02; // 2% above stop
    const retestZoneTop = entryLow;
    console.log(`[STATUS-CALC] ${symbol}: 52W breakout - checking retest zone [${retestZoneBottom.toFixed(2)}-${retestZoneTop.toFixed(2)}]`);
    if (ltp >= retestZoneBottom && ltp < retestZoneTop) {
      console.log(`[STATUS-CALC] ${symbol}: In retest zone -> RETEST_ZONE`);
      return 'RETEST_ZONE';
    }
  }

  // 6. Above entry but below target (running, no action needed)
  if (ltp > entryHigh && ltp < target) {
    console.log(`[STATUS-CALC] ${symbol}: LTP ${ltp} > EntryHigh ${entryHigh.toFixed(2)} and < Target ${target} -> ABOVE_ENTRY`);
    return 'ABOVE_ENTRY';
  }

  // 7. Approaching entry (within 2% above entry)
  const distanceFromEntry = ((ltp - entry) / entry) * 100;
  console.log(`[STATUS-CALC] ${symbol}: Distance from entry = ${distanceFromEntry.toFixed(2)}%`);
  if (distanceFromEntry > 0 && distanceFromEntry <= 2) {
    console.log(`[STATUS-CALC] ${symbol}: Within 2% above entry -> APPROACHING`);
    return 'APPROACHING';
  }

  // 8. Default — still watching
  console.log(`[STATUS-CALC] ${symbol}: No condition matched -> WATCHING`);
  return 'WATCHING';
}

/**
 * Calculate tracking flags based on daily data
 * @param {Object} dailyData - { daily_rsi, todays_volume, avg_volume_50d, open, prev_close, ... }
 * @param {Object} levels - { entry, ... }
 * @returns {string[]} - Array of flag strings
 */
function calculateFlags(dailyData, levels, symbol = 'UNKNOWN') {
  const flags = [];
  const { daily_rsi, todays_volume, avg_volume_50d, ltp, open, prev_close } = dailyData;
  const { entry } = levels;

  console.log(`[FLAGS-CALC] ${symbol}: RSI=${daily_rsi?.toFixed(1)}, LTP=${ltp}, Open=${open}, Entry=${entry}`);
  console.log(`[FLAGS-CALC] ${symbol}: Volume=${todays_volume}, AvgVol50d=${avg_volume_50d}`);
  console.log(`[FLAGS-CALC] ${symbol}: prev_close=${prev_close} (from daily data, previous day)`);

  // RSI flags
  if (daily_rsi >= 75) {
    console.log(`[FLAGS-CALC] ${symbol}: RSI ${daily_rsi} >= 75 -> RSI_EXIT`);
    flags.push('RSI_EXIT');
  } else if (daily_rsi >= 72) {
    console.log(`[FLAGS-CALC] ${symbol}: RSI ${daily_rsi} >= 72 -> RSI_DANGER`);
    flags.push('RSI_DANGER');
  }

  // Volume spike (2x or more above 50-day average)
  if (avg_volume_50d > 0 && todays_volume >= avg_volume_50d * 2) {
    const ratio = (todays_volume / avg_volume_50d).toFixed(1);
    console.log(`[FLAGS-CALC] ${symbol}: Volume ${todays_volume} is ${ratio}x avg -> VOLUME_SPIKE`);
    flags.push('VOLUME_SPIKE');
  }

  // Approaching entry (within 2% above entry) - also a flag
  const distFromEntry = ((ltp - entry) / entry) * 100;
  console.log(`[FLAGS-CALC] ${symbol}: Distance from entry = ${distFromEntry.toFixed(2)}%`);
  if (distFromEntry > 0 && distFromEntry <= 2) {
    console.log(`[FLAGS-CALC] ${symbol}: Within 2% above entry -> APPROACHING_ENTRY`);
    flags.push('APPROACHING_ENTRY');
  }

  // Gap down detection (today's open significantly below previous day's close)
  // Uses prev_close from daily candle data (NOT from saved snapshot)
  if (prev_close && prev_close > 0 && open && open > 0) {
    const gapPct = ((open - prev_close) / prev_close) * 100;
    console.log(`[FLAGS-CALC] ${symbol}: Today open=${open}, Prev day close=${prev_close}, Gap=${gapPct.toFixed(2)}%`);
    if (open < prev_close * 0.97) {
      console.log(`[FLAGS-CALC] ${symbol}: Gap down > 3% -> GAP_DOWN`);
      flags.push('GAP_DOWN');
    }
  } else {
    console.log(`[FLAGS-CALC] ${symbol}: No prev_close or open data - skipping gap detection`);
  }

  console.log(`[FLAGS-CALC] ${symbol}: Final flags = [${flags.join(', ')}]`);
  return flags;
}

/**
 * Determine if Phase 2 (AI analysis) should run
 * @param {string} newStatus - Current tracking status
 * @param {string} oldStatus - Previous tracking status
 * @param {string[]} newFlags - Current flags
 * @param {string[]} oldFlags - Previous flags
 * @returns {{ trigger: boolean, reason: string|null }}
 */
function shouldTriggerPhase2(newStatus, oldStatus, newFlags, oldFlags) {
  // Status change
  if (newStatus !== oldStatus) {
    const specificKey = `${oldStatus} → ${newStatus}`;
    const anyKey = `ANY → ${newStatus}`;

    if (PHASE2_TRIGGERS[specificKey]) {
      return { trigger: true, reason: PHASE2_TRIGGERS[specificKey] };
    }
    if (PHASE2_TRIGGERS[anyKey]) {
      return { trigger: true, reason: PHASE2_TRIGGERS[anyKey] };
    }
  }

  // New flags (only flags that weren't present before)
  const brandNewFlags = newFlags.filter(f => !oldFlags.includes(f));
  for (const flag of brandNewFlags) {
    const key = `NEW_FLAG: ${flag}`;
    if (PHASE2_TRIGGERS[key]) {
      return { trigger: true, reason: PHASE2_TRIGGERS[key] };
    }
  }

  return { trigger: false, reason: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SERVICE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run Phase 1: Status update for all stocks
 * @returns {{ phase1Results: Object[], phase2Queue: Object[] }}
 */
async function runPhase1() {
  const runLabel = '[DAILY-TRACK-P1]';
  console.log(`${runLabel} Starting Phase 1: Status Update...`);

  // Get current week's watchlist
  const watchlist = await WeeklyWatchlist.getCurrentWeek();
  if (!watchlist || watchlist.stocks.length === 0) {
    console.log(`${runLabel} No active watchlist or no stocks. Skipping.`);
    return { phase1Results: [], phase2Queue: [] };
  }

  console.log(`${runLabel} Found ${watchlist.stocks.length} stocks in watchlist: ${watchlist.week_label}`);

  // Filter to only stocks with valid levels
  const validStocks = watchlist.stocks.filter(s => s.levels?.entry && s.levels?.stop && s.levels?.target);
  console.log(`${runLabel} ${validStocks.length} stocks have valid levels`);

  if (validStocks.length === 0) {
    console.log(`${runLabel} No stocks with valid levels. Skipping.`);
    return { phase1Results: [], phase2Queue: [] };
  }

  // Extract symbols for batch fetch
  const symbols = validStocks.map(s => s.symbol);
  console.log(`${runLabel} Fetching daily data for: ${symbols.join(', ')}`);

  // Batch fetch daily data using existing service
  const dailyDataResponse = await getDailyAnalysisData(symbols);
  const { stocks: dailyDataArray, nifty_change_pct, date } = dailyDataResponse;

  // Create lookup map
  const dailyDataMap = new Map(dailyDataArray.map(d => [d.symbol, d]));

  const phase1Results = [];
  const phase2Queue = [];
  const todayDate = new Date();

  // Process each stock
  for (const stock of validStocks) {
    const dailyData = dailyDataMap.get(stock.symbol);

    if (!dailyData || !dailyData.ltp || dailyData.ltp <= 0) {
      console.log(`${runLabel} ⏭️ ${stock.symbol} - SKIP (no valid price data)`);
      continue;
    }

    // Get previous snapshot (if any)
    const prevSnapshot = stock.daily_snapshots?.length > 0
      ? stock.daily_snapshots[stock.daily_snapshots.length - 1]
      : null;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[DAILY-TRACK-P1] Processing: ${stock.symbol}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`[DAILY-TRACK-P1] ${stock.symbol}: Daily data received:`, {
      ltp: dailyData.ltp,
      open: dailyData.open,
      high: dailyData.high,
      low: dailyData.low,
      prev_close: dailyData.prev_close,
      daily_rsi: dailyData.daily_rsi,
      todays_volume: dailyData.todays_volume,
      avg_volume_50d: dailyData.avg_volume_50d
    });
    console.log(`[DAILY-TRACK-P1] ${stock.symbol}: Levels:`, {
      entry: stock.levels.entry,
      entryRange: stock.levels.entryRange,
      stop: stock.levels.stop,
      target: stock.levels.target,
      target2: stock.levels.target2,
      archetype: stock.levels.archetype
    });
    console.log(`[DAILY-TRACK-P1] ${stock.symbol}: Previous snapshot:`, prevSnapshot ? {
      date: prevSnapshot.date,
      close: prevSnapshot.close,
      tracking_status: prevSnapshot.tracking_status,
      tracking_flags: prevSnapshot.tracking_flags
    } : 'None');

    // Calculate new status and flags
    const oldStatus = stock.tracking_status || 'WATCHING';
    const oldFlags = stock.tracking_flags || [];

    console.log(`[DAILY-TRACK-P1] ${stock.symbol}: Old status=${oldStatus}, Old flags=[${oldFlags.join(', ')}]`);

    const newStatus = calculateStatus(dailyData, stock.levels, stock.symbol);
    const newFlags = calculateFlags(dailyData, stock.levels, stock.symbol);

    console.log(`[DAILY-TRACK-P1] ${stock.symbol}: NEW status=${newStatus}, NEW flags=[${newFlags.join(', ')}]`);
    console.log(`[DAILY-TRACK-P1] ${stock.symbol}: Status changed? ${newStatus !== oldStatus ? 'YES' : 'NO'}`);

    // Check if Phase 2 should trigger
    const { trigger, reason } = shouldTriggerPhase2(newStatus, oldStatus, newFlags, oldFlags);

    // Calculate distance percentages
    const distFromEntry = ((dailyData.ltp - stock.levels.entry) / stock.levels.entry) * 100;
    const distFromStop = ((dailyData.ltp - stock.levels.stop) / stock.levels.stop) * 100;
    const distFromTarget = ((dailyData.ltp - stock.levels.target) / stock.levels.target) * 100;

    // Build daily snapshot
    const snapshot = {
      date: todayDate,
      open: dailyData.open,
      high: dailyData.high,
      low: dailyData.low,
      close: dailyData.ltp,
      volume: dailyData.todays_volume,
      volume_vs_avg: dailyData.avg_volume_50d > 0
        ? parseFloat((dailyData.todays_volume / dailyData.avg_volume_50d).toFixed(2))
        : null,
      rsi: dailyData.daily_rsi,
      distance_from_entry_pct: parseFloat(distFromEntry.toFixed(2)),
      distance_from_stop_pct: parseFloat(distFromStop.toFixed(2)),
      distance_from_target_pct: parseFloat(distFromTarget.toFixed(2)),
      tracking_status: newStatus,
      tracking_flags: newFlags,
      nifty_change_pct: nifty_change_pct,
      phase2_triggered: trigger
    };

    // Update stock in watchlist
    stock.tracking_status = newStatus;
    stock.tracking_flags = newFlags;

    if (newStatus !== oldStatus) {
      stock.previous_status = oldStatus;
      stock.status_changed_at = todayDate;
    }

    // Add snapshot (avoid duplicates for same date)
    const todayDateStr = todayDate.toISOString().split('T')[0];
    const existingSnapshotIndex = stock.daily_snapshots?.findIndex(
      s => s.date.toISOString().split('T')[0] === todayDateStr
    );

    if (existingSnapshotIndex >= 0) {
      stock.daily_snapshots[existingSnapshotIndex] = snapshot;
    } else {
      if (!stock.daily_snapshots) stock.daily_snapshots = [];
      stock.daily_snapshots.push(snapshot);
    }

    const result = {
      symbol: stock.symbol,
      instrument_key: stock.instrument_key,
      oldStatus,
      newStatus,
      oldFlags,
      newFlags,
      ltp: dailyData.ltp,
      statusChanged: newStatus !== oldStatus,
      phase2Triggered: trigger,
      phase2Reason: reason
    };

    phase1Results.push(result);

    if (trigger) {
      phase2Queue.push({
        stock,
        dailyData,
        triggerReason: reason,
        snapshot
      });
      console.log(`${runLabel} 🎯 ${stock.symbol}: ${oldStatus} → ${newStatus} [PHASE 2 QUEUED: ${reason}]`);
    } else if (newStatus !== oldStatus) {
      console.log(`${runLabel} 📊 ${stock.symbol}: ${oldStatus} → ${newStatus}`);
    } else {
      console.log(`${runLabel} ✓ ${stock.symbol}: ${newStatus} (no change)`);
    }
  }

  // Save watchlist with all updates
  await watchlist.save();
  console.log(`${runLabel} ✅ Phase 1 complete. ${phase1Results.length} stocks processed, ${phase2Queue.length} queued for Phase 2`);

  return { phase1Results, phase2Queue };
}

/**
 * Run Phase 2: AI analysis for triggered stocks
 * @param {Object[]} phase2Queue - Array of { stock, dailyData, triggerReason, snapshot }
 * @returns {Object[]} - Results array
 */
async function runPhase2(phase2Queue) {
  const runLabel = '[DAILY-TRACK-P2]';

  if (phase2Queue.length === 0) {
    console.log(`${runLabel} No stocks queued for Phase 2. Skipping AI calls.`);
    return [];
  }

  console.log(`${runLabel} Starting Phase 2: AI Analysis for ${phase2Queue.length} stocks...`);

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
  });

  const results = [];

  for (const item of phase2Queue) {
    const { stock, dailyData, triggerReason, snapshot } = item;

    try {
      console.log(`${runLabel} 🤖 Analyzing ${stock.symbol}...`);

      // Get the weekend swing analysis for context
      const weekendAnalysis = await StockAnalysis.findOne({
        instrument_key: stock.instrument_key,
        analysis_type: 'swing',
        status: 'completed'
      }).sort({ created_at: -1 }).lean();

      // Fetch today's news for this stock (if any)
      const recentNews = await fetchRecentNewsForStock(stock.symbol, stock.instrument_key);

      // Build prompt
      const { system, user } = buildDailyTrackPrompt({
        stock,
        weekendAnalysis,
        dailyData,
        triggerReason,
        snapshot,
        recentNews
      });

      // Call Claude
      const startTime = Date.now();
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 800,
        temperature: 0.2,
        system,
        messages: [{ role: 'user', content: user }]
      });

      const duration = Date.now() - startTime;
      const content = response.content[0]?.text;

      if (!content) {
        throw new Error('Empty response from Claude');
      }

      // Parse JSON response
      let analysisData;
      try {
        // Extract JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in response');
        }
        analysisData = JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error(`${runLabel} JSON parse error for ${stock.symbol}:`, parseError.message);
        console.error(`${runLabel} Raw content:`, content.substring(0, 500));
        throw new Error(`JSON parse failed: ${parseError.message}`);
      }

      // Log API usage
      await ApiUsage.create({
        provider: 'ANTHROPIC',
        model: 'claude-sonnet-4-20250514',
        feature: 'DAILY_TRACK',
        tokens: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0,
          total: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
        },
        usage_date: getTodayStart(),
        context: {
          symbol: stock.symbol,
          description: `Daily track Phase 2: ${triggerReason}`
        }
      });

      // Calculate valid_until (next trading day 4 PM IST)
      const validUntil = getNextDay4PM();

      // Save to StockAnalysis
      const todayStart = getTodayStart();
      const savedAnalysis = await StockAnalysis.findOneAndUpdate(
        {
          instrument_key: stock.instrument_key,
          analysis_type: 'daily_track',
          created_at: { $gte: todayStart }
        },
        {
          instrument_key: stock.instrument_key,
          stock_name: stock.stock_name || stock.symbol,
          stock_symbol: stock.symbol,
          analysis_type: 'daily_track',
          current_price: dailyData.ltp,
          analysis_data: {
            schema_version: '2.0',
            daily_track: analysisData,
            trigger: {
              reason: triggerReason,
              old_status: snapshot.tracking_status,
              new_flags: snapshot.tracking_flags
            },
            weekend_analysis_id: weekendAnalysis?._id || null,
            original_levels: {
              entry: stock.levels.entry,
              stop: stock.levels.stop,
              target: stock.levels.target,
              target2: stock.levels.target2,
              archetype: stock.levels.archetype
            },
            daily_snapshot: {
              open: snapshot.open,
              high: snapshot.high,
              low: snapshot.low,
              close: snapshot.close,
              rsi: snapshot.rsi,
              volume: snapshot.volume,
              volume_vs_avg: snapshot.volume_vs_avg,
              nifty_change_pct: snapshot.nifty_change_pct
            }
          },
          status: 'completed',
          valid_until: validUntil,
          created_at: new Date()
        },
        { upsert: true, new: true }
      );

      // Update snapshot with analysis reference
      const watchlist = await WeeklyWatchlist.getCurrentWeek();
      const stockInWatchlist = watchlist.stocks.find(s => s.instrument_key === stock.instrument_key);
      if (stockInWatchlist) {
        const lastSnapshot = stockInWatchlist.daily_snapshots[stockInWatchlist.daily_snapshots.length - 1];
        if (lastSnapshot) {
          lastSnapshot.phase2_analysis_id = savedAnalysis._id;
          await watchlist.save();
        }
      }

      console.log(`${runLabel} ✅ ${stock.symbol}: AI analysis saved (${duration}ms)`);

      results.push({
        symbol: stock.symbol,
        success: true,
        analysisId: savedAnalysis._id,
        status: analysisData.status_assessment,
        duration
      });

    } catch (error) {
      console.error(`${runLabel} ❌ ${stock.symbol}: AI analysis failed:`, error.message);
      results.push({
        symbol: stock.symbol,
        success: false,
        error: error.message
      });
    }
  }

  console.log(`${runLabel} ✅ Phase 2 complete. ${results.filter(r => r.success).length}/${results.length} successful`);
  return results;
}

/**
 * Run full daily tracking (Phase 1 + Phase 2)
 * @param {Object} options - { forceReanalyze: boolean }
 * @returns {Object} - Full run results
 */
async function runDailyTracking(options = {}) {
  const runLabel = '[DAILY-TRACK]';
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`${runLabel} DAILY TRACKING STARTED`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`${runLabel} Time: ${new Date().toISOString()}`);

  try {
    // Phase 1: Status updates
    const { phase1Results, phase2Queue } = await runPhase1();

    // Phase 2: AI analysis (only for triggered stocks)
    const phase2Results = await runPhase2(phase2Queue);

    const totalDuration = Date.now() - startTime;

    const summary = {
      success: true,
      duration_ms: totalDuration,
      phase1: {
        stocks_processed: phase1Results.length,
        status_changes: phase1Results.filter(r => r.statusChanged).length,
        phase2_triggered: phase2Queue.length
      },
      phase2: {
        stocks_analyzed: phase2Results.length,
        successful: phase2Results.filter(r => r.success).length,
        failed: phase2Results.filter(r => !r.success).length
      }
    };

    console.log(`\n${runLabel} ${'─'.repeat(40)}`);
    console.log(`${runLabel} SUMMARY`);
    console.log(`${runLabel} Phase 1: ${summary.phase1.stocks_processed} stocks, ${summary.phase1.status_changes} changes`);
    console.log(`${runLabel} Phase 2: ${summary.phase2.successful}/${summary.phase2.stocks_analyzed} AI calls succeeded`);
    console.log(`${runLabel} Total time: ${totalDuration}ms`);
    console.log(`${'═'.repeat(60)}\n`);

    // Send push notification to all users if there were status changes or AI analysis
    if (summary.phase2.successful > 0) {
      try {
        await firebaseService.sendAnalysisCompleteToAllUsers(
          'Daily Analysis Complete',
          `${summary.phase2.successful} stock${summary.phase2.successful > 1 ? 's' : ''} analyzed with status updates`,
          { type: 'daily_analysis', route: '/weekly-watchlist' }
        );
        console.log(`${runLabel} 📱 Push notifications sent to all users`);
      } catch (notifError) {
        console.error(`${runLabel} ⚠️ Failed to send notifications:`, notifError.message);
      }
    }

    return summary;

  } catch (error) {
    console.error(`${runLabel} ❌ Daily tracking failed:`, error);
    return {
      success: false,
      error: error.message,
      duration_ms: Date.now() - startTime
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch today's news for a stock from DailyNewsStock collection
 * @param {string} symbol - Stock trading symbol
 * @param {string} instrumentKey - Stock instrument key
 * @returns {Promise<Object|null>} News data or null if none found
 */
async function fetchRecentNewsForStock(symbol, instrumentKey) {
  try {
    // Look for today's news (daily tracking runs same day as news scrape)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const news = await DailyNewsStock.findOne({
      $or: [
        { instrument_key: instrumentKey },
        { symbol: symbol.toUpperCase() }
      ],
      scrape_date: { $gte: today }
    }).sort({ scrape_date: -1 }).lean();

    if (!news || !news.news_items || news.news_items.length === 0) {
      return null;
    }

    console.log(`[DAILY-TRACK-P2] Found ${news.news_items.length} news items for ${symbol}`);
    return news;
  } catch (error) {
    console.error(`[DAILY-TRACK-P2] Error fetching news for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Get today at midnight IST (returns UTC Date for MongoDB queries)
 */
function getTodayStart() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const istMidnight = new Date(istNow);
  istMidnight.setUTCHours(0, 0, 0, 0);
  return new Date(istMidnight.getTime() - IST_OFFSET_MS);
}

/**
 * Get next trading day 4 PM IST (valid_until time)
 * Skips weekends: Fri 4PM → Mon 4PM, Sat/Sun → Mon 4PM
 */
function getNextDay4PM() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  const dayOfWeek = istNow.getUTCDay(); // 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat

  let daysToAdd = 1;
  if (dayOfWeek === 5) daysToAdd = 3;      // Fri → Mon
  else if (dayOfWeek === 6) daysToAdd = 2; // Sat → Mon
  else if (dayOfWeek === 0) daysToAdd = 1; // Sun → Mon

  const nextDay = new Date(istNow);
  nextDay.setUTCDate(nextDay.getUTCDate() + daysToAdd);
  nextDay.setUTCHours(16, 0, 0, 0); // 4 PM IST

  return new Date(nextDay.getTime() - IST_OFFSET_MS);
}

export {
  runDailyTracking,
  runPhase1,
  runPhase2,
  calculateStatus,
  calculateFlags,
  shouldTriggerPhase2
};

export default {
  runDailyTracking,
  runPhase1,
  runPhase2
};
