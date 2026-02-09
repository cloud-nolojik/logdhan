/**
 * Daily Picks Exit Service — 3:00 PM Force-Exit
 *
 * Cancels remaining protective orders and market-sells any open positions.
 * MIS auto-squareoff at 3:20 PM by exchange as safety net.
 */

import DailyPick from '../../models/dailyPick.js';
import kiteOrderService from '../kiteOrder.service.js';
import { isKiteIntegrationEnabled } from '../kiteTradeIntegration.service.js';
import { firebaseService } from '../firebase/firebase.service.js';
import priceCacheService from '../priceCache.service.js';
import kiteConfig from '../../config/kite.config.js';
import { calculatePnl, updateDailyResults, delay } from './dailyPicksHelpers.js';

const LOG = '[DAILY-EXIT]';

/**
 * Force-exit all open daily pick positions at 3:00 PM.
 * Steps: cancel protective orders → market sell → record results → notify.
 */
async function runDailyExit(options = {}) {
  const { dryRun = false } = options;

  console.log(`${LOG} ════════════════════════════════════════`);
  console.log(`${LOG} Running 3 PM exit${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`${LOG} ════════════════════════════════════════`);

  if (!isKiteIntegrationEnabled()) {
    console.log(`${LOG} Kite not enabled — skipping exit`);
    return { success: true, message: 'Kite not enabled', exited: 0 };
  }

  // Step 1: Find open positions
  const doc = await DailyPick.findToday();
  if (!doc) {
    console.log(`${LOG} No DailyPick doc for today`);
    return { success: true, message: 'No picks today', exited: 0 };
  }

  const enteredPicks = doc.picks.filter(p => p.trade.status === 'ENTERED');
  if (enteredPicks.length === 0) {
    console.log(`${LOG} No ENTERED positions to exit`);
    // Still update results if some picks were already closed by monitor
    updateDailyResults(doc);
    await doc.save();
    await sendExitNotification(doc);
    return { success: true, message: 'No open positions', exited: 0 };
  }

  console.log(`${LOG} ${enteredPicks.length} open position(s) to exit`);
  let exited = 0;

  for (const pick of enteredPicks) {
    try {
      // Step 2: Check if protective orders already triggered
      let alreadyExited = false;

      if (pick.kite.stop_order_id) {
        try {
          const stopOrder = await kiteOrderService.getOrderDetails(pick.kite.stop_order_id);
          if (stopOrder?.status?.toUpperCase() === 'COMPLETE') {
            console.log(`${LOG} ${pick.symbol}: Stop already triggered @ ₹${stopOrder.average_price}`);
            pick.trade.status = 'STOPPED_OUT';
            pick.trade.exit_price = stopOrder.average_price;
            pick.trade.exit_time = new Date();
            pick.trade.exit_reason = 'stop_hit';
            pick.trade.exit_price_source = 'order_fill';
            calculatePnl(pick);
            pick.kite.kite_status = 'completed';
            alreadyExited = true;

            // Cancel target if still open
            if (pick.kite.target_order_id) {
              try { await kiteOrderService.cancelOrder(pick.kite.target_order_id); } catch (e) { /* ignore */ }
            }
          }
        } catch (err) {
          console.error(`${LOG} ${pick.symbol}: Stop order check failed:`, err.message);
        }
      }

      if (!alreadyExited && pick.kite.target_order_id) {
        try {
          const targetOrder = await kiteOrderService.getOrderDetails(pick.kite.target_order_id);
          if (targetOrder?.status?.toUpperCase() === 'COMPLETE') {
            console.log(`${LOG} ${pick.symbol}: Target already hit @ ₹${targetOrder.average_price}`);
            pick.trade.status = 'TARGET_HIT';
            pick.trade.exit_price = targetOrder.average_price;
            pick.trade.exit_time = new Date();
            pick.trade.exit_reason = 'target_hit';
            pick.trade.exit_price_source = 'order_fill';
            calculatePnl(pick);
            pick.kite.kite_status = 'completed';
            alreadyExited = true;

            // Cancel stop if still open
            if (pick.kite.stop_order_id) {
              try { await kiteOrderService.cancelOrder(pick.kite.stop_order_id); } catch (e) { /* ignore */ }
            }
          }
        } catch (err) {
          console.error(`${LOG} ${pick.symbol}: Target order check failed:`, err.message);
        }
      }

      if (alreadyExited) {
        exited++;
        continue;
      }

      // Step 3: Cancel active protective orders
      console.log(`${LOG} ${pick.symbol}: Cancelling protective orders...`);
      if (!dryRun) {
        if (pick.kite.stop_order_id) {
          try { await kiteOrderService.cancelOrder(pick.kite.stop_order_id); }
          catch (e) { console.error(`${LOG} ${pick.symbol}: SL cancel failed:`, e.message); }
        }
        if (pick.kite.target_order_id) {
          try { await kiteOrderService.cancelOrder(pick.kite.target_order_id); }
          catch (e) { console.error(`${LOG} ${pick.symbol}: Target cancel failed:`, e.message); }
        }

        // Wait for cancellation to propagate
        await delay(2000);
      }

      // Re-check trade status (stop might have triggered during cancel)
      if (pick.trade.status !== 'ENTERED') {
        console.log(`${LOG} ${pick.symbol}: Status changed to ${pick.trade.status} during cancel — skipping market sell`);
        exited++;
        continue;
      }

      // Step 4: Place MARKET SELL to close position
      console.log(`${LOG} ${pick.symbol}: Placing MARKET ${pick.direction === 'LONG' ? 'SELL' : 'BUY'} — qty=${pick.trade.qty}`);

      if (dryRun) {
        console.log(`${LOG} [DRY RUN] Would market-exit ${pick.symbol}`);
        continue;
      }

      let exitOrderId = null;
      try {
        const result = await kiteOrderService.placeOrder({
          tradingsymbol: pick.symbol,
          exchange: 'NSE',
          transaction_type: pick.direction === 'LONG' ? 'SELL' : 'BUY',
          order_type: 'MARKET',
          product: 'MIS',
          quantity: pick.trade.qty,
          simulation_id: `daily_pick_exit_${pick.symbol}`,
          orderType: 'TIME_EXIT',
          source: 'DAILY_PICKS'
        });

        if (result.success) {
          exitOrderId = result.orderId;
          console.log(`${LOG} ✅ ${pick.symbol}: Market exit placed — orderId=${exitOrderId}`);
        } else {
          throw new Error(`Market sell failed: ${JSON.stringify(result)}`);
        }
      } catch (err) {
        console.error(`${LOG} ❌ ${pick.symbol}: Market sell FAILED — retrying in 5s...`);

        // Retry once
        await delay(5000);
        try {
          const retryResult = await kiteOrderService.placeOrder({
            tradingsymbol: pick.symbol,
            exchange: 'NSE',
            transaction_type: pick.direction === 'LONG' ? 'SELL' : 'BUY',
            order_type: 'MARKET',
            product: 'MIS',
            quantity: pick.trade.qty,
            simulation_id: `daily_pick_exit_retry_${pick.symbol}`,
            orderType: 'TIME_EXIT',
            source: 'DAILY_PICKS'
          });

          if (retryResult.success) {
            exitOrderId = retryResult.orderId;
            console.log(`${LOG} ✅ ${pick.symbol}: Retry market exit succeeded — orderId=${exitOrderId}`);
          } else {
            throw new Error('Retry also failed');
          }
        } catch (retryErr) {
          console.error(`${LOG} ⚠️ CRITICAL: ${pick.symbol} — FAILED TO EXIT. Manual exit required. Exchange auto-exit at 3:20 PM (MIS).`);
          // Send admin alert
          try {
            await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID,
              'CRITICAL: Daily Pick Exit Failed',
              `Failed to exit ${pick.symbol}. Manual exit required. Exchange auto-exit at 3:20 PM.`,
              { type: 'DAILY_PICKS_ALERT', route: '/daily-picks' }
            );
          } catch (notifErr) { /* ignore */ }
          pick.trade.status = 'ENTERED'; // Keep as ENTERED — exchange will handle
          continue;
        }
      }

      // Step 5: Get actual fill price
      await delay(3000);
      let exitPrice = null;
      let exitPriceSource = 'ltp_approximate';

      if (exitOrderId) {
        try {
          const exitOrder = await kiteOrderService.getOrderDetails(exitOrderId);
          if (exitOrder?.average_price) {
            exitPrice = exitOrder.average_price;
            exitPriceSource = 'order_fill';
            console.log(`${LOG} ${pick.symbol}: Exit fill price = ₹${exitPrice}`);
          }
        } catch (err) {
          console.error(`${LOG} ${pick.symbol}: getOrderDetails failed for exit:`, err.message);
        }
      }

      // Fallback to LTP
      if (!exitPrice && pick.instrument_key) {
        try {
          exitPrice = priceCacheService.getPrice(pick.instrument_key);
          exitPriceSource = 'ltp_approximate';
          console.log(`${LOG} ${pick.symbol}: Using LTP as exit price = ₹${exitPrice}`);
        } catch (err) {
          exitPrice = pick.trade.entry_price; // Last resort
          exitPriceSource = 'ltp_approximate';
        }
      }

      // Step 6: Update pick
      pick.trade.status = 'TIME_EXIT';
      pick.trade.exit_price = exitPrice;
      pick.trade.exit_time = new Date();
      pick.trade.exit_reason = 'time_exit_3pm';
      pick.trade.exit_price_source = exitPriceSource;
      calculatePnl(pick);
      pick.kite.kite_status = 'completed';

      exited++;
      console.log(`${LOG} ${pick.symbol}: Time exit — PnL: ₹${pick.trade.pnl} (${pick.trade.return_pct}%)`);

    } catch (err) {
      console.error(`${LOG} ${pick.symbol}: Exit error —`, err.message);
    }
  }

  // Step 7: Update daily results and save
  updateDailyResults(doc);
  await doc.save();

  // Step 8: Send notification
  await sendExitNotification(doc);

  console.log(`${LOG} ✅ Exit complete — ${exited} positions closed`);
  return { success: true, exited };
}

/**
 * Send exit summary notification
 */
async function sendExitNotification(doc) {
  const adminUserId = kiteConfig.ADMIN_USER_ID;
  if (!adminUserId || !doc.results) return;

  const completedPicks = doc.picks.filter(p =>
    ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT'].includes(p.trade.status)
  );

  if (completedPicks.length === 0) return;

  const r = doc.results;
  const title = `Daily Picks Closed: ${r.winners}W/${r.losers}L`;
  const body = `${r.total_pnl >= 0 ? '+' : ''}₹${r.total_pnl} (${r.avg_return_pct >= 0 ? '+' : ''}${r.avg_return_pct}% avg)${r.best_pick ? ` | Best: ${r.best_pick}` : ''}`;

  try {
    await firebaseService.sendToUser(adminUserId, title, body, {
      type: 'DAILY_PICKS_RESULTS',
      route: '/daily-picks'
    });
    console.log(`${LOG} Exit notification sent: ${title}`);
  } catch (err) {
    console.error(`${LOG} Exit notification failed:`, err.message);
  }
}

export { runDailyExit };

export default { runDailyExit };
