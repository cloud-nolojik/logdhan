/**
 * Morning Brief Service
 *
 * Runs Monday 8:00 AM IST before market open. Categorizes weekly watchlist stocks
 * into actionable buckets and places entry GTTs for pullback (touch) stocks.
 *
 * CRITICAL: Entry GTT ONLY — no OCO at this stage. OCO is placed by kiteOrderSyncJob
 * after confirmed entry fill, to avoid accidental short-sell on unfilled entries.
 */

import WeeklyWatchlist from '../models/weeklyWatchlist.js';
import KiteOrder from '../models/kiteOrder.js';
import kiteOrderService from './kiteOrder.service.js';
import kiteConfig from '../config/kite.config.js';
import { isKiteIntegrationEnabled } from './kiteTradeIntegration.service.js';
import { firebaseService } from './firebase/firebase.service.js';

const LOG_PREFIX = '[MORNING-BRIEF]';

// Statuses that mean the stock is done / irrelevant
const EXCLUDED_TRACKING_STATUSES = ['SKIPPED', 'FULL_EXIT', 'STOPPED_OUT', 'EXPIRED'];

// Statuses that mean the stock is already in an active trade
const ACTIVE_SIM_STATUSES = ['ENTERED', 'PARTIAL_EXIT', 'ENTRY_SIGNALED'];
const ACTIVE_TRACKING_STATUSES = ['ABOVE_ENTRY', 'TARGET1_HIT', 'TARGET_HIT', 'TARGET2_HIT', 'ENTRY_ZONE'];

// tooFar threshold: 4% not 5% — screening price is Friday close, stale by Monday
const TOO_FAR_THRESHOLD_PCT = 4;

// Only place Kite GTTs for top-confidence stocks (A+ or A, i.e. setup_score >= 70)
const KITE_MIN_GRADES = ['A+', 'A'];

/**
 * Main orchestrator
 * @param {Object} options - { dryRun: boolean }
 */
async function runMorningBrief(options = {}) {
  const { dryRun = false } = options;
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`${LOG_PREFIX} MONDAY MORNING BRIEF ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`${LOG_PREFIX} Time: ${new Date().toISOString()}`);

  try {
    // 1. Get current week's watchlist
    const watchlist = await WeeklyWatchlist.getCurrentWeek();
    if (!watchlist || !watchlist.stocks || watchlist.stocks.length === 0) {
      console.log(`${LOG_PREFIX} No watchlist or no stocks for current week`);
      return { success: true, reason: 'no_watchlist', duration_ms: Date.now() - startTime };
    }

    console.log(`${LOG_PREFIX} Watchlist: ${watchlist.stocks.length} total stocks`);

    // 2. Filter active stocks (remove excluded statuses + those missing key levels)
    const activeStocks = watchlist.stocks.filter(stock => {
      if (EXCLUDED_TRACKING_STATUSES.includes(stock.tracking_status)) {
        console.log(`${LOG_PREFIX}   ${stock.symbol}: Skip — ${stock.tracking_status}`);
        return false;
      }
      if (!stock.levels?.entry || !stock.levels?.stop || !stock.levels?.target2) {
        console.log(`${LOG_PREFIX}   ${stock.symbol}: Skip — missing entry/stop/target2 levels`);
        return false;
      }
      return true;
    });

    console.log(`${LOG_PREFIX} Active stocks after filtering: ${activeStocks.length}`);

    if (activeStocks.length === 0) {
      console.log(`${LOG_PREFIX} No active stocks to process`);
      return { success: true, reason: 'no_active_stocks', duration_ms: Date.now() - startTime };
    }

    // 3. Categorize
    const categories = categorizeStocks(activeStocks);

    console.log(`${LOG_PREFIX} Categories:`);
    console.log(`${LOG_PREFIX}   Pullback (touch): ${categories.pullback.length}`);
    console.log(`${LOG_PREFIX}   Breakout (close_above): ${categories.breakout.length}`);
    console.log(`${LOG_PREFIX}   Too far (>4%): ${categories.tooFar.length}`);
    console.log(`${LOG_PREFIX}   Already active: ${categories.alreadyActive.length}`);

    // 4. Place entry GTTs for pullback stocks
    let gttResults = { placed: 0, skipped: 0, errors: [], details: [] };
    if (categories.pullback.length > 0) {
      gttResults = await placePullbackGTTs(categories.pullback, dryRun);
    }

    // 5. Build notification
    const notification = buildNotificationSummary(categories, gttResults);

    // 6. Send push notification
    if (!dryRun) {
      try {
        await firebaseService.sendAnalysisCompleteToAllUsers(
          notification.title,
          notification.body,
          notification.data
        );
        console.log(`${LOG_PREFIX} Push notification sent`);
      } catch (notifError) {
        console.warn(`${LOG_PREFIX} Push notification failed:`, notifError.message);
      }
    } else {
      console.log(`${LOG_PREFIX} [DRY RUN] Would send notification: ${notification.body}`);
    }

    const duration_ms = Date.now() - startTime;

    console.log(`\n${LOG_PREFIX} ${'─'.repeat(40)}`);
    console.log(`${LOG_PREFIX} BRIEF COMPLETE (${duration_ms}ms)`);
    console.log(`${LOG_PREFIX} GTTs placed: ${gttResults.placed}, skipped: ${gttResults.skipped}, errors: ${gttResults.errors.length}`);
    console.log(`${LOG_PREFIX} ${'═'.repeat(60)}\n`);

    return {
      success: true,
      brief: categories,
      gttResults,
      notification,
      duration_ms
    };

  } catch (error) {
    console.error(`${LOG_PREFIX} Morning brief failed:`, error);
    return {
      success: false,
      error: error.message,
      duration_ms: Date.now() - startTime
    };
  }
}

/**
 * Categorize stocks into actionable buckets
 * @param {Array} stocks - Active stocks from watchlist
 * @returns {Object} - { pullback, breakout, tooFar, alreadyActive }
 */
function categorizeStocks(stocks) {
  const categories = {
    pullback: [],
    breakout: [],
    tooFar: [],
    alreadyActive: []
  };

  for (const stock of stocks) {
    const levels = stock.levels;
    const sim = stock.trade_simulation;
    const entry = levels.entry;
    const lastPrice = stock.screening_data?.price_at_screening || entry;

    // Build item for bucket
    const item = {
      symbol: stock.symbol,
      instrumentKey: stock.instrument_key,
      stockId: stock._id,
      entry,
      stop: levels.stop,
      target1: levels.target1,
      target2: levels.target2,
      mode: levels.mode,
      archetype: levels.archetype,
      entryConfirmation: levels.entryConfirmation || 'close_above',
      grade: stock.grade,
      setupScore: stock.setup_score,
      lastPrice,
      distancePct: ((lastPrice - entry) / entry) * 100,
      riskReward: levels.stop && entry ? ((levels.target2 - entry) / (entry - levels.stop)).toFixed(2) : null,
      screeningData: stock.screening_data
    };

    // 1. Already in active trade?
    const simStatus = sim?.status;
    const trackingStatus = stock.tracking_status;

    if (ACTIVE_SIM_STATUSES.includes(simStatus) || ACTIVE_TRACKING_STATUSES.includes(trackingStatus)) {
      item.action = 'already_active';
      categories.alreadyActive.push(item);
      console.log(`${LOG_PREFIX}   ${stock.symbol}: Already active (sim=${simStatus}, tracking=${trackingStatus})`);
      continue;
    }

    // 2. Too far from entry? (uses Friday close — stale by Monday)
    const absDist = Math.abs(item.distancePct);
    if (absDist > TOO_FAR_THRESHOLD_PCT) {
      item.action = 'too_far';
      categories.tooFar.push(item);
      console.log(`${LOG_PREFIX}   ${stock.symbol}: Too far (${item.distancePct.toFixed(1)}% from entry, threshold ${TOO_FAR_THRESHOLD_PCT}%)`);
      continue;
    }

    // 3. Entry type
    if (item.entryConfirmation === 'touch') {
      item.action = 'pullback_gtt';
      categories.pullback.push(item);
      console.log(`${LOG_PREFIX}   ${stock.symbol}: Pullback (touch) — entry ₹${entry}, dist ${item.distancePct.toFixed(1)}%`);
    } else {
      item.action = 'watch_breakout';
      categories.breakout.push(item);
      const confirmLabel = item.entryConfirmation === 'touch_bounce' ? 'touch_bounce' : 'close_above';
      console.log(`${LOG_PREFIX}   ${stock.symbol}: Watch (${confirmLabel}) — entry ₹${entry}, dist ${item.distancePct.toFixed(1)}%`);
    }
  }

  return categories;
}

/**
 * Place entry GTT ONLY for each pullback stock. NO OCO.
 * OCO is placed later by kiteOrderSyncJob after confirmed fill.
 *
 * @param {Array} pullbackStocks - Stocks with entryConfirmation === 'touch'
 * @param {boolean} dryRun
 * @returns {Object} - { placed, skipped, errors, details }
 */
async function placePullbackGTTs(pullbackStocks, dryRun = false) {
  const results = { placed: 0, skipped: 0, errors: [], details: [] };

  // Pre-checks
  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG_PREFIX} Kite integration disabled — skipping GTT placement`);
    results.skipped = pullbackStocks.length;
    results.details = pullbackStocks.map(s => ({ symbol: s.symbol, reason: 'kite_disabled' }));
    return results;
  }

  if (dryRun) {
    console.log(`${LOG_PREFIX} [DRY RUN] Would place ${pullbackStocks.length} entry GTTs`);
    results.skipped = pullbackStocks.length;
    results.details = pullbackStocks.map(s => ({
      symbol: s.symbol,
      entry: s.entry,
      reason: 'dry_run'
    }));
    return results;
  }

  const canPlace = await kiteOrderService.canPlaceOrder();
  if (!canPlace) {
    console.log(`${LOG_PREFIX} Daily order limit reached — skipping GTT placement`);
    results.skipped = pullbackStocks.length;
    results.details = pullbackStocks.map(s => ({ symbol: s.symbol, reason: 'daily_limit' }));
    return results;
  }

  // Filter to top-confidence stocks only (A+ or A)
  const highConfidenceStocks = pullbackStocks.filter(s => {
    if (KITE_MIN_GRADES.includes(s.grade)) return true;
    console.log(`${LOG_PREFIX} ${s.symbol}: Skipping GTT — grade ${s.grade || 'ungraded'} below threshold (need A+ or A)`);
    return false;
  });

  if (highConfidenceStocks.length === 0) {
    console.log(`${LOG_PREFIX} No pullback stocks meet grade threshold for Kite GTTs`);
    results.skipped = pullbackStocks.length;
    results.details = pullbackStocks.map(s => ({ symbol: s.symbol, reason: 'below_grade_threshold', grade: s.grade }));
    return results;
  }

  console.log(`${LOG_PREFIX} ${highConfidenceStocks.length}/${pullbackStocks.length} pullback stocks meet grade threshold`);

  const balance = await kiteOrderService.getAvailableBalance();
  const capitalPerStock = balance.usable / highConfidenceStocks.length;

  console.log(`${LOG_PREFIX} Balance: ₹${balance.available.toFixed(2)}, Usable: ₹${balance.usable.toFixed(2)}, Per stock: ₹${capitalPerStock.toFixed(2)}`);

  for (const stock of highConfidenceStocks) {
    try {
      // Idempotency: skip if active entry GTT already exists
      const existingGTT = await KiteOrder.findOne({
        trading_symbol: stock.symbol,
        order_type: 'ENTRY',
        is_gtt: true,
        gtt_status: 'active'
      });

      if (existingGTT) {
        console.log(`${LOG_PREFIX} ${stock.symbol}: Active entry GTT already exists (ID: ${existingGTT.gtt_id}) — skipping`);
        results.skipped++;
        results.details.push({ symbol: stock.symbol, reason: 'existing_gtt', gtt_id: existingGTT.gtt_id });
        continue;
      }

      // Calculate quantity
      const orderAmount = Math.min(capitalPerStock, kiteConfig.MAX_ORDER_VALUE);
      const quantity = Math.floor(orderAmount / stock.entry);

      if (quantity < 1) {
        console.log(`${LOG_PREFIX} ${stock.symbol}: Insufficient quantity (₹${orderAmount.toFixed(0)} / ₹${stock.entry} = ${quantity})`);
        results.skipped++;
        results.details.push({ symbol: stock.symbol, reason: 'insufficient_quantity' });
        continue;
      }

      console.log(`${LOG_PREFIX} ${stock.symbol}: Placing entry GTT — Qty: ${quantity}, Entry: ₹${stock.entry}, Value: ₹${(quantity * stock.entry).toFixed(0)}`);

      // Place ENTRY GTT only — NO OCO
      const orderResult = await kiteOrderService.placeEntryGTT({
        tradingSymbol: stock.symbol,
        entryPrice: stock.entry,
        currentPrice: stock.lastPrice,
        quantity,
        stockId: stock.stockId,
        simulationId: `morning_brief_${stock.stockId}`
      });

      results.placed++;
      results.details.push({
        symbol: stock.symbol,
        triggerId: orderResult.triggerId,
        quantity,
        entryPrice: stock.entry,
        orderValue: quantity * stock.entry
      });

      console.log(`${LOG_PREFIX} ${stock.symbol}: Entry GTT placed — ID: ${orderResult.triggerId}`);

    } catch (stockError) {
      console.error(`${LOG_PREFIX} ${stock.symbol}: GTT placement failed:`, stockError.message);
      results.errors.push({ symbol: stock.symbol, error: stockError.message });
    }
  }

  console.log(`${LOG_PREFIX} GTT placement complete: ${results.placed} placed, ${results.skipped} skipped, ${results.errors.length} errors`);
  return results;
}

/**
 * Build push notification summary
 * @param {Object} categories - { pullback, breakout, tooFar, alreadyActive }
 * @param {Object} gttResults - { placed, skipped, errors, details }
 * @returns {Object} - { title, body, data }
 */
function buildNotificationSummary(categories, gttResults) {
  const parts = [];

  if (gttResults.placed > 0) {
    parts.push(`${gttResults.placed} limit order${gttResults.placed > 1 ? 's' : ''} placed`);
  }

  if (categories.breakout.length > 0) {
    parts.push(`watch ${categories.breakout.length} breakout${categories.breakout.length > 1 ? 's' : ''}`);
  }

  if (categories.tooFar.length > 0) {
    parts.push(`${categories.tooFar.length} too far (Fri close)`);
  }

  const body = parts.length > 0
    ? `Monday Brief: ${parts.join(', ')}`
    : 'Monday Brief: No actionable setups this week';

  return {
    title: 'Monday Morning Brief',
    body,
    data: {
      type: 'morning_brief',
      route: '/weekly-watchlist',
      pullbackCount: String(categories.pullback.length),
      breakoutCount: String(categories.breakout.length),
      tooFarCount: String(categories.tooFar.length),
      gttsPlaced: String(gttResults.placed),
      timestamp: new Date().toISOString()
    }
  };
}

export { runMorningBrief, categorizeStocks, placePullbackGTTs, buildNotificationSummary };
export default { runMorningBrief };
