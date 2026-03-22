/**
 * Morning Brief Service
 *
 * Runs Monday 8:00 AM IST before market open.
 * Simply picks ALL weekly setup stocks and places entry GTTs.
 * No condition checks — every stock with valid levels gets an order.
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

/**
 * Main orchestrator — simple: get stocks, place GTTs, notify
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

    // 2. Filter only stocks with valid levels (entry + stop + target2)
    const eligible = watchlist.stocks.filter(stock => {
      if (!stock.levels?.entry || !stock.levels?.stop || !stock.levels?.target2) {
        console.log(`${LOG_PREFIX}   ${stock.symbol}: Skip — missing entry/stop/target2 levels`);
        return false;
      }
      return true;
    });

    console.log(`${LOG_PREFIX} Eligible stocks with valid levels: ${eligible.length}`);

    if (eligible.length === 0) {
      console.log(`${LOG_PREFIX} No stocks with valid levels`);
      return { success: true, reason: 'no_eligible_stocks', duration_ms: Date.now() - startTime };
    }

    // 3. Build stock items for GTT placement
    const stocks = eligible.map(stock => {
      const levels = stock.levels;
      const lastPrice = stock.screening_data?.price_at_screening || levels.entry;
      return {
        symbol: stock.symbol,
        instrumentKey: stock.instrument_key,
        stockId: stock._id,
        entry: levels.entry,
        stop: levels.stop,
        target1: levels.target1,
        target2: levels.target2,
        mode: levels.mode,
        grade: stock.grade,
        setupScore: stock.setup_score,
        lastPrice,
        entryConfirmation: levels.entryConfirmation || 'close_above',
      };
    });

    // Log all stocks being placed
    for (const s of stocks) {
      console.log(`${LOG_PREFIX}   ${s.symbol}: Entry ₹${s.entry}, Stop ₹${s.stop}, Target ₹${s.target2}, Grade ${s.grade || 'N/A'}`);
    }

    // 4. Place entry GTTs for ALL stocks
    const gttResults = await placeEntryGTTs(stocks, dryRun);

    // 5. Send push notification
    const notifBody = `Monday Brief: ${gttResults.placed} order${gttResults.placed !== 1 ? 's' : ''} placed for ${stocks.length} stocks`;
    if (!dryRun) {
      try {
        await firebaseService.sendAnalysisCompleteToAllUsers(
          'Monday Morning Brief',
          notifBody,
          {
            type: 'morning_brief',
            route: '/weekly-watchlist',
            gttsPlaced: String(gttResults.placed),
            totalStocks: String(stocks.length),
            timestamp: new Date().toISOString()
          }
        );
        console.log(`${LOG_PREFIX} Push notification sent`);
      } catch (notifError) {
        console.warn(`${LOG_PREFIX} Push notification failed:`, notifError.message);
      }
    } else {
      console.log(`${LOG_PREFIX} [DRY RUN] Would send notification: ${notifBody}`);
    }

    const duration_ms = Date.now() - startTime;

    console.log(`\n${LOG_PREFIX} ${'─'.repeat(40)}`);
    console.log(`${LOG_PREFIX} BRIEF COMPLETE (${duration_ms}ms)`);
    console.log(`${LOG_PREFIX} GTTs placed: ${gttResults.placed}, skipped: ${gttResults.skipped}, errors: ${gttResults.errors.length}`);
    console.log(`${LOG_PREFIX} ${'═'.repeat(60)}\n`);

    return {
      success: true,
      totalStocks: stocks.length,
      gttResults,
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
 * Place entry GTT for ALL weekly setup stocks. NO OCO.
 * OCO is placed later by kiteOrderSyncJob after confirmed fill.
 *
 * @param {Array} stocks - All stocks from weekly setup with valid levels
 * @param {boolean} dryRun
 * @returns {Object} - { placed, skipped, errors, details }
 */
async function placeEntryGTTs(stocks, dryRun = false) {
  const results = { placed: 0, skipped: 0, errors: [], details: [] };

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG_PREFIX} Kite integration disabled — skipping GTT placement`);
    results.skipped = stocks.length;
    results.details = stocks.map(s => ({ symbol: s.symbol, reason: 'kite_disabled' }));
    return results;
  }

  if (dryRun) {
    console.log(`${LOG_PREFIX} [DRY RUN] Would place ${stocks.length} entry GTTs`);
    results.skipped = stocks.length;
    results.details = stocks.map(s => ({
      symbol: s.symbol,
      entry: s.entry,
      grade: s.grade,
      reason: 'dry_run'
    }));
    return results;
  }

  const canPlace = await kiteOrderService.canPlaceOrder();
  if (!canPlace) {
    console.log(`${LOG_PREFIX} Daily order limit reached — skipping GTT placement`);
    results.skipped = stocks.length;
    results.details = stocks.map(s => ({ symbol: s.symbol, reason: 'daily_limit' }));
    return results;
  }

  console.log(`${LOG_PREFIX} Placing entry GTTs for ${stocks.length} stocks`);

  const balance = await kiteOrderService.getAvailableBalance();

  // Score-weighted allocation for swing capital
  const MAX_WEIGHT = 0.45;
  const totalScore = stocks.reduce((sum, s) => sum + (s.setupScore || 50), 0);
  const rawWeights = stocks.map(s => Math.min((s.setupScore || 50) / totalScore, MAX_WEIGHT));
  const weightSum = rawWeights.reduce((s, w) => s + w, 0);
  const allocations = stocks.map((stock, i) => ({
    stock,
    capital: Math.floor(balance.usableSwing * (rawWeights[i] / weightSum))
  }));

  console.log(`${LOG_PREFIX} Balance: ₹${balance.available.toFixed(2)}, Swing budget: ₹${balance.usableSwing.toFixed(2)}, Score-weighted across ${stocks.length} stocks (totalScore=${totalScore})`);

  for (const { stock, capital } of allocations) {
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

      // Calculate quantity (score-weighted capital allocation)
      const orderAmount = Math.min(capital, kiteConfig.MAX_ORDER_VALUE);
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

export { runMorningBrief, placeEntryGTTs };
export default { runMorningBrief };
