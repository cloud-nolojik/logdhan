/**
 * Kite Trade Integration Service
 *
 * This service handles the integration between the daily tracking simulation
 * and actual Kite order placement. It should be called after Phase 1 of
 * daily tracking to place real orders based on simulation events.
 *
 * IMPORTANT: Orders are only placed for the admin user (KITE_ADMIN_USER_ID).
 */

import kiteOrderService from './kiteOrder.service.js';
import kiteAutoLoginService from './kiteAutoLogin.service.js';
import KiteAuditLog from '../models/kiteAuditLog.js';
import kiteConfig from '../config/kite.config.js';
import { firebaseService } from './firebase/firebase.service.js';

/**
 * Process simulation events and place Kite orders accordingly
 *
 * @param {Array} phase1Results - Results from Phase 1 of daily tracking
 * @param {Map} stocksMap - Map of stock symbol to stock document
 * @returns {Object} - { ordersPlaced: number, errors: [] }
 */
async function processSimulationForKiteOrders(phase1Results, stocksMap) {
  const results = {
    ordersPlaced: 0,
    ordersSkipped: 0,
    errors: [],
    orders: []
  };

  try {
    console.log('[KITE-INTEGRATION] ════════════════════════════════════════');
    console.log('[KITE-INTEGRATION] Processing simulation results for Kite orders...');
    console.log(`[KITE-INTEGRATION] phase1Results count: ${phase1Results?.length || 0}`);
    console.log(`[KITE-INTEGRATION] stocksMap size: ${stocksMap?.size || 0}`);

    // Check if we can place more orders today
    const canPlace = await kiteOrderService.canPlaceOrder();
    console.log(`[KITE-INTEGRATION] Can place orders today: ${canPlace}`);
    if (!canPlace) {
      console.log('[KITE-INTEGRATION] Daily order limit reached, skipping order placement');
      return { ...results, skipped: true, reason: 'daily_limit_reached' };
    }

    // Log all stocks and their simulation status
    console.log('[KITE-INTEGRATION] Checking all stocks for ENTRY_SIGNALED status:');
    for (const result of phase1Results) {
      const stock = stocksMap.get(result.symbol);
      const simStatus = stock?.trade_simulation?.status || 'NO_SIM';
      const latestEvent = stock?.trade_simulation?.events?.[stock?.trade_simulation?.events?.length - 1];
      console.log(`[KITE-INTEGRATION]   - ${result.symbol}: status=${simStatus}, latestEvent=${latestEvent?.type || 'none'}`);
    }

    // Filter stocks that have entry signals today
    const entrySignaledStocks = phase1Results.filter(result => {
      const stock = stocksMap.get(result.symbol);
      if (!stock?.trade_simulation) return false;

      // Check for ENTRY_SIGNALED status in simulation
      const simStatus = stock.trade_simulation.status;
      const latestEvent = stock.trade_simulation.events?.[stock.trade_simulation.events.length - 1];

      // We want stocks where the simulation just signaled entry today
      return simStatus === 'ENTRY_SIGNALED' && latestEvent?.type === 'ENTRY_SIGNAL';
    });

    console.log(`[KITE-INTEGRATION] Filtered ENTRY_SIGNALED stocks: ${entrySignaledStocks.length}`);

    if (entrySignaledStocks.length === 0) {
      console.log('[KITE-INTEGRATION] No entry signals detected today');
      console.log('[KITE-INTEGRATION] ════════════════════════════════════════');
      return results;
    }

    console.log(`[KITE-INTEGRATION] Found ${entrySignaledStocks.length} stocks with entry signals`);

    // Get available balance and calculate per-stock allocation
    const balance = await kiteOrderService.getAvailableBalance();
    const capitalPerStock = balance.usable / entrySignaledStocks.length;

    console.log(`[KITE-INTEGRATION] Balance: ₹${balance.available.toFixed(2)}, ` +
                `Usable: ₹${balance.usable.toFixed(2)}, ` +
                `Per stock: ₹${capitalPerStock.toFixed(2)}`);

    // Send notification before placing orders
    await sendOrderNotification(entrySignaledStocks, balance);

    // Process each entry signal
    for (const result of entrySignaledStocks) {
      try {
        const stock = stocksMap.get(result.symbol);
        const levels = stock.levels;
        const entryPrice = levels.entry;
        const currentPrice = result.ltp;

        // Calculate quantity
        const orderAmount = Math.min(capitalPerStock, kiteConfig.MAX_ORDER_VALUE);
        const quantity = Math.floor(orderAmount / entryPrice);

        if (quantity < 1) {
          console.log(`[KITE-INTEGRATION] ${result.symbol}: Insufficient quantity (${quantity}), skipping`);
          results.ordersSkipped++;
          continue;
        }

        // Get trading symbol - WeeklyWatchlist stores symbol directly on stock object
        const tradingSymbol = stock.symbol;
        console.log(`[KITE-INTEGRATION] ${result.symbol}: Placing entry GTT - ` +
                    `Symbol: ${tradingSymbol}, Qty: ${quantity}, Entry: ₹${entryPrice}, Current: ₹${currentPrice}`);

        // Place entry GTT
        const orderResult = await kiteOrderService.placeEntryGTT({
          tradingSymbol: tradingSymbol,
          entryPrice: entryPrice,
          currentPrice: currentPrice,
          quantity: quantity,
          stockId: stock._id,
          simulationId: stock.trade_simulation?._id || `sim_${stock._id}`
        });

        results.ordersPlaced++;
        results.orders.push({
          symbol: result.symbol,
          triggerId: orderResult.triggerId,
          quantity,
          entryPrice,
          orderValue: quantity * entryPrice
        });

        console.log(`[KITE-INTEGRATION] ${result.symbol}: Entry GTT placed - ID: ${orderResult.triggerId}`);

        // Place OCO GTT for SL + Target immediately after entry GTT
        const stopLoss = levels.stop;
        const target = levels.target1 || levels.target2;

        if (stopLoss && target) {
          console.log(`[KITE-INTEGRATION] ${result.symbol}: Placing OCO GTT - SL: ₹${stopLoss}, T1: ₹${target}, Qty: ${quantity}`);

          try {
            const ocoResult = await kiteOrderService.placeOCOGTT({
              tradingSymbol: tradingSymbol,
              currentPrice: currentPrice,
              stopLoss: stopLoss,
              target: target,
              quantity: quantity,
              stockId: stock._id,
              simulationId: stock.trade_simulation?._id || `sim_${stock._id}`,
              orderType: 'STOP_LOSS'
            });

            console.log(`[KITE-INTEGRATION] ${result.symbol}: OCO GTT placed - ID: ${ocoResult.triggerId}`);
            results.orders.push({
              symbol: result.symbol,
              triggerId: ocoResult.triggerId,
              type: 'OCO',
              stopLoss,
              target,
              quantity
            });
          } catch (ocoError) {
            console.error(`[KITE-INTEGRATION] ${result.symbol}: Failed to place OCO GTT:`, ocoError.message);
            results.errors.push({
              symbol: result.symbol,
              type: 'OCO',
              error: ocoError.message
            });
          }
        } else {
          console.log(`[KITE-INTEGRATION] ${result.symbol}: Skipping OCO GTT - missing levels: stop=${stopLoss}, target=${target}`);
        }

      } catch (stockError) {
        console.error(`[KITE-INTEGRATION] ${result.symbol}: Error placing order:`, stockError.message);
        results.errors.push({
          symbol: result.symbol,
          error: stockError.message
        });
      }
    }

    console.log(`[KITE-INTEGRATION] Completed: ${results.ordersPlaced} orders placed, ` +
                `${results.ordersSkipped} skipped, ${results.errors.length} errors`);

    return results;

  } catch (error) {
    console.error('[KITE-INTEGRATION] Error processing simulation:', error);
    results.errors.push({ global: error.message });
    return results;
  }
}

/**
 * Process simulation events after entry to manage SL/Target GTTs
 *
 * @param {Array} phase1Results - Results from Phase 1
 * @param {Map} stocksMap - Map of stock symbol to stock document
 */
async function processPostEntryOrders(phase1Results, stocksMap) {
  const results = {
    gttPlaced: 0,
    gttCancelled: 0,
    errors: []
  };

  try {
    for (const result of phase1Results) {
      const stock = stocksMap.get(result.symbol);
      if (!stock?.trade_simulation) continue;

      const sim = stock.trade_simulation;
      const latestEvent = sim.events?.[sim.events.length - 1];

      if (!latestEvent) continue;

      // Handle different simulation events
      switch (latestEvent.type) {
        case 'ENTRY':
          // Entry executed - place OCO GTT (SL + T1)
          await handleEntryExecuted(stock, results);
          break;

        case 'T1_HIT':
          // T1 hit - cancel old GTT, place new with SL at entry
          await handleT1Hit(stock, results);
          break;

        case 'T2_HIT':
          // T2 hit - if T3 exists, update GTT; else full exit
          await handleT2Hit(stock, results);
          break;

        case 'STOPPED_OUT':
        case 'TRAILING_STOP':
          // Stop hit - no action needed (GTT already triggered)
          console.log(`[KITE-INTEGRATION] ${result.symbol}: Stop triggered - no action needed`);
          break;
      }
    }

    return results;

  } catch (error) {
    console.error('[KITE-INTEGRATION] Error processing post-entry orders:', error);
    results.errors.push({ global: error.message });
    return results;
  }
}

/**
 * Handle entry executed - place OCO GTT for SL + Target
 */
async function handleEntryExecuted(stock, results) {
  try {
    const sim = stock.trade_simulation;
    const levels = stock.levels;
    const symbol = stock.symbol;

    const stopLoss = sim.trailing_stop || levels.stop;
    const target = levels.target1 || levels.target2;
    const quantity = sim.qty_remaining;

    if (!quantity || quantity < 1) {
      console.log(`[KITE-INTEGRATION] ${stock.symbol}: No remaining quantity for OCO GTT`);
      return;
    }

    console.log(`[KITE-INTEGRATION] ${stock.symbol}: Placing OCO GTT - ` +
                `SL: ₹${stopLoss}, T1: ₹${target}, Qty: ${quantity}`);

    const result = await kiteOrderService.placeOCOGTT({
      tradingSymbol: symbol,
      currentPrice: sim.entry_price,
      stopLoss: stopLoss,
      target: target,
      quantity: quantity,
      stockId: stock._id,
      simulationId: sim._id || `sim_${stock._id}`,
      orderType: 'STOP_LOSS'
    });

    results.gttPlaced++;
    console.log(`[KITE-INTEGRATION] ${stock.symbol}: OCO GTT placed - ID: ${result.triggerId}`);

  } catch (error) {
    console.error(`[KITE-INTEGRATION] ${stock.symbol}: Error placing OCO GTT:`, error);
    results.errors.push({ symbol: stock.symbol, error: error.message });
  }
}

/**
 * Handle T1 hit - cancel old GTT, place new with SL at entry (breakeven)
 */
async function handleT1Hit(stock, results) {
  try {
    const sim = stock.trade_simulation;
    const levels = stock.levels;
    const symbol = stock.symbol;

    // Cancel existing GTT
    // TODO: Need to track GTT ID in the order model to cancel it

    // Place new OCO GTT with SL at entry (breakeven)
    const stopLoss = sim.entry_price;  // Breakeven
    const target = levels.target2;
    const quantity = sim.qty_remaining;

    if (!quantity || quantity < 1) {
      console.log(`[KITE-INTEGRATION] ${stock.symbol}: No remaining quantity after T1`);
      return;
    }

    console.log(`[KITE-INTEGRATION] ${stock.symbol}: T1 hit - placing new OCO GTT - ` +
                `SL@breakeven: ₹${stopLoss}, T2: ₹${target}, Qty: ${quantity}`);

    const result = await kiteOrderService.placeOCOGTT({
      tradingSymbol: symbol,
      currentPrice: levels.target1,
      stopLoss: stopLoss,
      target: target,
      quantity: quantity,
      stockId: stock._id,
      simulationId: sim._id || `sim_${stock._id}`,
      orderType: 'TARGET1'
    });

    results.gttPlaced++;

  } catch (error) {
    console.error(`[KITE-INTEGRATION] ${stock.symbol}: Error handling T1:`, error);
    results.errors.push({ symbol: stock.symbol, error: error.message });
  }
}

/**
 * Handle T2 hit - if T3 exists, place new GTT; else trade complete
 */
async function handleT2Hit(stock, results) {
  try {
    const sim = stock.trade_simulation;
    const levels = stock.levels;
    const symbol = stock.symbol;

    if (!levels.target3) {
      console.log(`[KITE-INTEGRATION] ${stock.symbol}: T2 hit, no T3 - trade complete`);
      return;
    }

    // Place GTT for T3 with trailing stop
    const quantity = sim.qty_remaining;
    if (!quantity || quantity < 1) {
      console.log(`[KITE-INTEGRATION] ${stock.symbol}: No remaining quantity after T2`);
      return;
    }

    console.log(`[KITE-INTEGRATION] ${stock.symbol}: T2 hit - placing GTT for T3`);

    const result = await kiteOrderService.placeOCOGTT({
      tradingSymbol: symbol,
      currentPrice: levels.target2,
      stopLoss: sim.trailing_stop,
      target: levels.target3,
      quantity: quantity,
      stockId: stock._id,
      simulationId: sim._id || `sim_${stock._id}`,
      orderType: 'TARGET2'
    });

    results.gttPlaced++;

  } catch (error) {
    console.error(`[KITE-INTEGRATION] ${stock.symbol}: Error handling T2:`, error);
    results.errors.push({ symbol: stock.symbol, error: error.message });
  }
}

/**
 * Send push notification before placing orders
 */
async function sendOrderNotification(stocks, balance) {
  try {
    const stockSymbols = stocks.map(s => s.symbol).join(', ');

    // Send to admin user
    await firebaseService.sendToUser(kiteConfig.ADMIN_USER_ID, {
      title: 'Kite Order Alert',
      body: `Placing entry orders for: ${stockSymbols}. Balance: ₹${balance.usable.toFixed(0)}`,
      data: {
        type: 'kite_order',
        symbols: stockSymbols,
        balance: balance.usable.toString()
      }
    });

    console.log('[KITE-INTEGRATION] Notification sent to admin');

  } catch (error) {
    console.error('[KITE-INTEGRATION] Failed to send notification:', error);
    // Don't throw - notification failure shouldn't stop order placement
  }
}

/**
 * Check if Kite integration is enabled and configured
 */
function isKiteIntegrationEnabled() {
  return !!(
    kiteConfig.API_KEY &&
    kiteConfig.API_SECRET &&
    kiteConfig.USER_ID &&
    kiteConfig.PASSWORD &&
    kiteConfig.TOTP_SECRET &&
    kiteConfig.ADMIN_USER_ID
  );
}

export {
  processSimulationForKiteOrders,
  processPostEntryOrders,
  isKiteIntegrationEnabled
};

export default {
  processSimulationForKiteOrders,
  processPostEntryOrders,
  isKiteIntegrationEnabled
};
