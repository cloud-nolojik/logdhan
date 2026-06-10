import kiteAutoLoginService from './kiteAutoLogin.service.js';
import KiteOrder from '../models/kiteOrder.js';
import KiteAuditLog from '../models/kiteAuditLog.js';
import kiteConfig from '../config/kite.config.js';

/**
 * runWithConcurrency(tasks, limit)
 *
 * Run `tasks` (an array of async-thunks) with at most `limit` running at any
 * time. Resolves to an array of results in the same order as `tasks`. Errors
 * in individual tasks are caught and stored as `{ _error: Error }` so a single
 * failure doesn't reject the whole pool — callers can inspect per-result.
 *
 * 2026-06-05: Born from the historical-data 429 storm — getIntradayMultiCandles
 * was firing all 20 symbol requests in parallel against Kite's 3 req/sec
 * historical-data limit. 98 of 215 stocks silently got 0 bars (45% of the
 * scan universe). Capping at 3 keeps us at the rate limit ceiling.
 *
 * Why not a library: zero dependencies in this file, and the implementation
 * is 15 lines. p-limit / @hapi/cron would be overkill.
 */
// Concurrency cap for Kite historical-data calls. Kite's documented rate is
// 3 req/sec on /instruments/historical/*. Anything higher gets 429 NetworkException.
export const KITE_HISTORICAL_CONCURRENCY = 3;

export async function runWithConcurrency(tasks, limit) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      try {
        results[idx] = await tasks[idx]();
      } catch (err) {
        results[idx] = { _error: err };
      }
    }
  }
  const poolSize = Math.max(1, Math.min(limit | 0, tasks.length));
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
  return results;
}

/**
 * KiteOrderService
 * Handles order placement, modification, and GTT operations via Kite Connect API.
 */
class KiteOrderService {
  constructor() {
    this.kiteService = kiteAutoLoginService;
    this.adminUserId = kiteConfig.ADMIN_USER_ID;
  }

  /**
   * Check if user is authorized for order placement
   */
  isAuthorized(userId) {
    return userId === this.adminUserId || String(userId) === String(this.adminUserId);
  }

  /**
   * Get available balance for trading
   */
  async getAvailableBalance() {
    try {
      console.log('[KITE ORDER] Fetching available balance...');
      const margins = await this.kiteService.getMargins();
      const equity = margins.data?.equity || {};

      // Use equity.net — real available margin after all utilisation.
      // Split into swing (CNC, no leverage) and intraday (MIS, 2x leverage) pools.
      const availableMargin = equity.net || 0;
      const availableCash = equity.available?.cash || 0;
      const usableAmount = availableMargin * kiteConfig.CAPITAL_USAGE_PERCENT;
      const rawSwing = usableAmount * kiteConfig.SWING_CAPITAL_PERCENT;           // 60% of usable — CNC, no leverage
      const rawIntraday = usableAmount * kiteConfig.INTRADAY_CAPITAL_PERCENT      // 40% of usable — MIS base
                          * (kiteConfig.MIS_LEVERAGE_FACTOR || 1);                // then apply 2x leverage

      // Subtract capital already committed to active GTTs and open orders (not yet executed)
      // GTTs don't block margin on Kite until triggered, so we must track this ourselves.
      const [pendingSwingValue, pendingIntradayValue] = await Promise.all([
        KiteOrder.aggregate([
          { $match: {
            user_id: kiteConfig.ADMIN_USER_ID,
            product: 'CNC',
            $or: [
              { is_gtt: true, gtt_status: 'active' },
              { status: { $in: ['PLACED', 'OPEN', 'TRIGGER_PENDING'] } }
            ]
          }},
          { $group: { _id: null, total: { $sum: '$order_value' } } }
        ]).then(r => r[0]?.total || 0),
        KiteOrder.aggregate([
          { $match: {
            user_id: kiteConfig.ADMIN_USER_ID,
            product: 'MIS',
            $or: [
              { is_gtt: true, gtt_status: 'active' },
              { status: { $in: ['PLACED', 'OPEN', 'TRIGGER_PENDING'] } }
            ]
          }},
          { $group: { _id: null, total: { $sum: '$order_value' } } }
        ]).then(r => r[0]?.total || 0)
      ]);

      const usableSwing = Math.max(0, rawSwing - pendingSwingValue);
      const usableIntraday = Math.max(0, rawIntraday - pendingIntradayValue);

      console.log(`[KITE ORDER] Balance: net=₹${availableMargin} cash=₹${availableCash} usable=₹${usableAmount} (${kiteConfig.CAPITAL_USAGE_PERCENT * 100}%) | Swing(CNC): ₹${rawSwing} (no leverage) | Intraday(MIS): ₹${rawIntraday} (${kiteConfig.MIS_LEVERAGE_FACTOR}x leverage)`);
      console.log(`[KITE ORDER] Swing: raw=₹${rawSwing} pending=₹${pendingSwingValue} available=₹${usableSwing} | Intraday: raw=₹${rawIntraday} pending=₹${pendingIntradayValue} available=₹${usableIntraday}`);

      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.BALANCE_CHECK, {
        status: 'SUCCESS',
        response: { availableMargin, availableCash, usableAmount, rawSwing, rawIntraday, misLeverage: kiteConfig.MIS_LEVERAGE_FACTOR, pendingSwingValue, pendingIntradayValue, usableSwing, usableIntraday },
        source: 'AUTO'
      });

      return {
        total: equity.net || 0,
        available: availableMargin,
        usable: usableAmount,
        usableSwing,
        usableIntraday,
        pendingSwing: pendingSwingValue,
        pendingIntraday: pendingIntradayValue,
        used: equity.utilised?.debits || 0
      };
    } catch (error) {
      console.error('[KITE ORDER] Balance fetch failed:', error.message);
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.BALANCE_CHECK, {
        status: 'FAILED',
        error: error.message,
        source: 'AUTO'
      });
      throw error;
    }
  }

  /**
   * Calculate order quantity based on available balance and entry price
   */
  async calculateQuantity(entryPrice, stockCount = 1) {
    const balance = await this.getAvailableBalance();

    // Split capital equally among stocks
    const capitalPerStock = balance.usable / stockCount;

    // Cap at max order value
    const orderAmount = Math.min(capitalPerStock, kiteConfig.MAX_ORDER_VALUE);

    // Calculate quantity
    const quantity = Math.floor(orderAmount / entryPrice);

    return {
      quantity,
      orderAmount: quantity * entryPrice,
      availableBalance: balance.available,
      usableBalance: balance.usable,
      capitalPerStock
    };
  }

  /**
   * Place a regular order
   */
  async placeOrder(orderParams) {
    const startTime = Date.now();

    try {
      // Validate required params
      if (!orderParams.tradingsymbol || !orderParams.quantity || !orderParams.transaction_type) {
        throw new Error('Missing required order parameters');
      }

      const params = {
        tradingsymbol: orderParams.tradingsymbol,
        exchange: orderParams.exchange || kiteConfig.DEFAULT_EXCHANGE,
        transaction_type: orderParams.transaction_type,
        order_type: orderParams.order_type || kiteConfig.ORDER_TYPES.LIMIT,
        quantity: orderParams.quantity,
        product: orderParams.product || kiteConfig.DEFAULT_PRODUCT,
        validity: orderParams.validity || kiteConfig.ORDER_VALIDITY
      };

      // Add price for LIMIT and SL orders (SL requires both trigger_price and limit price)
      if ((params.order_type === 'LIMIT' || params.order_type === 'SL') && orderParams.price) {
        params.price = orderParams.price;
      }

      // Add trigger price for SL orders
      if ((params.order_type === 'SL' || params.order_type === 'SL-M') && orderParams.trigger_price) {
        params.trigger_price = orderParams.trigger_price;
      }

      // Market protection: required by Kite for MARKET and SL-M orders
      // (SEBI retail-algo rules, effective 2026-04-01). Without it the API
      // rejects with: "Market orders without market protection are not allowed".
      // SL-M uses a tighter default (1%) than MARKET (10%) because NSE error
      // 16448 fires when trigger × (1 - mp%) goes below the day's circuit band.
      if (params.order_type === 'MARKET') {
        params.market_protection = orderParams.market_protection
          ?? kiteConfig.DEFAULT_MARKET_PROTECTION;
      } else if (params.order_type === 'SL-M') {
        params.market_protection = orderParams.market_protection
          ?? kiteConfig.DEFAULT_SLM_MARKET_PROTECTION;
      }

      console.log('[KITE ORDER] Placing order:', params);

      const response = await this.kiteService.makeRequest(
        'POST',
        kiteConfig.ENDPOINTS.REGULAR_ORDER,
        params
      );

      const durationMs = Date.now() - startTime;
      const orderId = response.data?.order_id;

      console.log(`[KITE ORDER] Order placed successfully. Order ID: ${orderId}`);

      // Create order record in database (non-blocking — don't let DB failure hide a placed order)
      let kiteOrder = null;
      try {
        kiteOrder = await KiteOrder.create({
          user_id: this.adminUserId,
          stock_id: orderParams.stockId,
          simulation_id: orderParams.simulationId,
          order_id: orderId,
          order_type: orderParams.orderType || 'MANUAL',
          trading_symbol: params.tradingsymbol,
          exchange: params.exchange,
          transaction_type: params.transaction_type,
          quantity: params.quantity,
          price: params.price || 0,
          trigger_price: params.trigger_price,
          product: params.product,
          kite_order_type: params.order_type,
          status: 'PLACED',
          placed_at: new Date(),
          order_value: params.quantity * (params.price || 0),
          kite_response: response,
          is_gtt: false
        });
      } catch (dbErr) {
        console.error(`[KITE ORDER] DB save failed for order ${orderId}:`, dbErr.message);
      }

      // Log to audit
      try {
        await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.ORDER_PLACED, {
          orderId,
          symbol: params.tradingsymbol,
          exchange: params.exchange,
          orderType: orderParams.orderType,
          transactionType: params.transaction_type,
          quantity: params.quantity,
          price: params.price,
          triggerPrice: params.trigger_price,
          status: 'SUCCESS',
          response,
          orderValue: params.quantity * (params.price || 0),
          simulationId: orderParams.simulationId,
          stockId: orderParams.stockId,
          kiteOrderRef: kiteOrder?._id,
          durationMs,
          source: orderParams.source || 'AUTO'
        });
      } catch (auditErr) {
        console.error(`[KITE ORDER] Audit log failed for order ${orderId}:`, auditErr.message);
      }

      return {
        success: true,
        orderId,
        kiteOrder,
        response
      };

    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Log failed order — MUST be guarded. If logAction throws (DB error,
      // schema mismatch, validation, etc.) it would replace the original
      // axios error with the audit error, destroying error.response.data.message
      // which contains Kite's "Tick size for this script is 0.10" message that
      // parseKiteTickError in orbService relies on for the SL-M retry path.
      //
      // Bug observed 2026-05-29 on PRESTIGE/OFSS/BLUESTARCO: attempt 1 failed
      // with tick error, audit log threw, audit error propagated up, tick
      // parser saw the wrong error, returned null, attempt 2 used SAME trigger,
      // emergency exit fired. Mirror of the success-path guard at lines 211-232.
      try {
        await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.ORDER_PLACED, {
          symbol: orderParams.tradingsymbol,
          orderType: orderParams.orderType,
          transactionType: orderParams.transaction_type,
          quantity: orderParams.quantity,
          price: orderParams.price,
          status: 'FAILED',
          error: error.message,
          request: orderParams,
          simulationId: orderParams.simulationId,
          durationMs,
          source: orderParams.source || 'AUTO'
        });
      } catch (auditErr) {
        // Audit log failure must NOT swallow the original Kite error.
        console.error('[KITE ORDER] Failure-path audit log save failed:', auditErr.message);
      }

      console.error('[KITE ORDER] Order placement failed:', error.message);
      throw error;
    }
  }

  /**
   * Place an AMO (After Market Order) — same as regular order but via /orders/amo endpoint.
   * Used for SHORT intraday picks placed before market open.
   */
  async placeAMOOrder(orderParams) {
    const startTime = Date.now();

    try {
      if (!orderParams.tradingsymbol || !orderParams.quantity || !orderParams.transaction_type) {
        throw new Error('Missing required AMO order parameters');
      }

      const params = {
        tradingsymbol: orderParams.tradingsymbol,
        exchange: orderParams.exchange || kiteConfig.DEFAULT_EXCHANGE,
        transaction_type: orderParams.transaction_type,
        order_type: orderParams.order_type || kiteConfig.ORDER_TYPES.LIMIT,
        quantity: orderParams.quantity,
        product: orderParams.product || kiteConfig.DEFAULT_PRODUCT,
        validity: orderParams.validity || kiteConfig.ORDER_VALIDITY
      };

      if ((params.order_type === 'LIMIT' || params.order_type === 'SL') && orderParams.price) {
        params.price = orderParams.price;
      }

      if ((params.order_type === 'SL' || params.order_type === 'SL-M') && orderParams.trigger_price) {
        params.trigger_price = orderParams.trigger_price;
      }

      // Market protection — required for MARKET and SL-M (see placeOrder for context).
      if (params.order_type === 'MARKET') {
        params.market_protection = orderParams.market_protection
          ?? kiteConfig.DEFAULT_MARKET_PROTECTION;
      } else if (params.order_type === 'SL-M') {
        params.market_protection = orderParams.market_protection
          ?? kiteConfig.DEFAULT_SLM_MARKET_PROTECTION;
      }

      console.log('[KITE AMO] Placing AMO order:', params);

      const response = await this.kiteService.makeRequest(
        'POST',
        kiteConfig.ENDPOINTS.AMO_ORDER,
        params
      );

      const durationMs = Date.now() - startTime;
      const orderId = response.data?.order_id;

      console.log(`[KITE AMO] AMO order placed successfully. Order ID: ${orderId}`);

      let kiteOrder = null;
      try {
        kiteOrder = await KiteOrder.create({
          user_id: this.adminUserId,
          stock_id: orderParams.stockId,
          simulation_id: orderParams.simulationId,
          order_id: orderId,
          order_type: orderParams.orderType || 'MANUAL',
          trading_symbol: params.tradingsymbol,
          exchange: params.exchange,
          transaction_type: params.transaction_type,
          quantity: params.quantity,
          price: params.price || 0,
          trigger_price: params.trigger_price,
          product: params.product,
          kite_order_type: params.order_type,
          status: 'PLACED',
          placed_at: new Date(),
          order_value: params.quantity * (params.price || 0),
          kite_response: response,
          is_gtt: false
        });
      } catch (dbErr) {
        console.error(`[KITE AMO] DB save failed for AMO order ${orderId}:`, dbErr.message);
      }

      try {
        await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.ORDER_PLACED, {
          orderId,
          symbol: params.tradingsymbol,
          exchange: params.exchange,
          orderType: orderParams.orderType,
          transactionType: params.transaction_type,
          quantity: params.quantity,
          price: params.price,
          triggerPrice: params.trigger_price,
          status: 'SUCCESS',
          response,
          orderValue: params.quantity * (params.price || 0),
          simulationId: orderParams.simulationId,
          stockId: orderParams.stockId,
          kiteOrderRef: kiteOrder?._id,
          durationMs,
          source: orderParams.source || 'AUTO',
          variety: 'amo'
        });
      } catch (auditErr) {
        console.error(`[KITE AMO] Audit log failed for AMO order ${orderId}:`, auditErr.message);
      }

      return {
        success: true,
        orderId,
        kiteOrder,
        response
      };

    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Same audit-log guard as placeOrder() failure path — don't let a
      // logAction throw corrupt the original axios error which downstream
      // callers (parseKiteTickError etc.) rely on.
      try {
        await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.ORDER_PLACED, {
          symbol: orderParams.tradingsymbol,
          orderType: orderParams.orderType,
          transactionType: orderParams.transaction_type,
          quantity: orderParams.quantity,
          price: orderParams.price,
          status: 'FAILED',
          error: error.message,
          request: orderParams,
          simulationId: orderParams.simulationId,
          durationMs,
          source: orderParams.source || 'AUTO',
          variety: 'amo'
        });
      } catch (auditErr) {
        console.error('[KITE AMO] Failure-path audit log save failed:', auditErr.message);
      }

      console.error('[KITE AMO] AMO order placement failed:', error.message);
      throw error;
    }
  }

  /**
   * Place a GTT (Good Till Triggered) order
   */
  async placeGTT(gttParams) {
    const startTime = Date.now();

    try {
      const exchange = gttParams.exchange || kiteConfig.DEFAULT_EXCHANGE;

      // Kite API expects 'type' and 'condition' as JSON object
      const params = {
        type: gttParams.type || kiteConfig.GTT_TYPES.SINGLE,
        condition: JSON.stringify({
          exchange: exchange,
          tradingsymbol: gttParams.tradingsymbol,
          trigger_values: gttParams.trigger_values,
          last_price: gttParams.last_price
        }),
        orders: JSON.stringify(gttParams.orders.map(order => ({
          exchange: exchange,
          tradingsymbol: gttParams.tradingsymbol,
          transaction_type: order.transaction_type,
          quantity: order.quantity,
          order_type: order.order_type || kiteConfig.ORDER_TYPES.LIMIT,
          product: order.product || kiteConfig.DEFAULT_PRODUCT,
          price: order.price
        })))
      };

      console.log('[KITE GTT] Placing GTT:', JSON.stringify({
        type: params.type,
        symbol: gttParams.tradingsymbol,
        exchange: exchange,
        triggers: gttParams.trigger_values,
        last_price: gttParams.last_price,
        orders: gttParams.orders
      }, null, 2));
      console.log('[KITE GTT] Full params:', JSON.stringify(params, null, 2));

      const response = await this.kiteService.makeRequest(
        'POST',
        kiteConfig.ENDPOINTS.GTT_TRIGGERS,
        params
      );

      const durationMs = Date.now() - startTime;

      // Create order record for GTT
      const kiteOrder = await KiteOrder.create({
        user_id: this.adminUserId,
        stock_id: gttParams.stockId,
        simulation_id: gttParams.simulationId,
        gtt_id: response.data?.trigger_id,
        order_type: gttParams.orderType || 'ENTRY',
        trading_symbol: gttParams.tradingsymbol,
        exchange: params.exchange,
        transaction_type: gttParams.orders[0]?.transaction_type,
        quantity: gttParams.orders[0]?.quantity,
        price: gttParams.orders[0]?.price,
        trigger_price: gttParams.trigger_values[0],
        product: kiteConfig.DEFAULT_PRODUCT,
        status: 'TRIGGER_PENDING',
        is_gtt: true,
        gtt_type: gttParams.type,
        gtt_status: 'active',
        gtt_condition: {
          trigger_values: gttParams.trigger_values,
          last_price: gttParams.last_price,
          orders: gttParams.orders
        },
        kite_response: response
      });

      // Log to audit
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.GTT_PLACED, {
        gttId: response.data?.trigger_id,
        symbol: gttParams.tradingsymbol,
        orderType: gttParams.orderType,
        transactionType: gttParams.orders[0]?.transaction_type,
        quantity: gttParams.orders[0]?.quantity,
        price: gttParams.orders[0]?.price,
        triggerPrice: gttParams.trigger_values[0],
        status: 'SUCCESS',
        response,
        simulationId: gttParams.simulationId,
        stockId: gttParams.stockId,
        kiteOrderRef: kiteOrder._id,
        durationMs,
        source: gttParams.source || 'AUTO'
      });

      console.log(`[KITE GTT] GTT placed successfully. Trigger ID: ${response.data?.trigger_id}`);

      return {
        success: true,
        triggerId: response.data?.trigger_id,
        kiteOrder,
        response
      };

    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Log failed GTT
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.GTT_PLACED, {
        symbol: gttParams.tradingsymbol,
        orderType: gttParams.orderType,
        status: 'FAILED',
        error: error.message,
        request: gttParams,
        simulationId: gttParams.simulationId,
        durationMs,
        source: gttParams.source || 'AUTO'
      });

      console.error('[KITE GTT] GTT placement failed:', error.message);
      if (error.response) {
        console.error('[KITE GTT] Error status:', error.response.status);
        console.error('[KITE GTT] Error data:', JSON.stringify(error.response.data));
      }
      throw error;
    }
  }

  /**
   * Cancel a GTT order
   */
  async cancelGTT(triggerId, options = {}) {
    const startTime = Date.now();

    try {
      console.log(`[KITE GTT] Cancelling GTT: ${triggerId}`);

      const response = await this.kiteService.makeRequest(
        'DELETE',
        `${kiteConfig.ENDPOINTS.GTT_TRIGGERS}/${triggerId}`
      );

      const durationMs = Date.now() - startTime;

      // Update order record
      await KiteOrder.findOneAndUpdate(
        { gtt_id: triggerId },
        {
          gtt_status: 'cancelled',
          status: 'CANCELLED',
          cancelled_at: new Date(),
          notes: options.reason || 'GTT cancelled'
        }
      );

      // Log to audit
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.GTT_CANCELLED, {
        gttId: triggerId,
        status: 'SUCCESS',
        response,
        notes: options.reason,
        durationMs,
        source: options.source || 'AUTO'
      });

      console.log(`[KITE GTT] GTT cancelled successfully: ${triggerId}`);

      return { success: true, response };

    } catch (error) {
      const durationMs = Date.now() - startTime;

      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.GTT_CANCELLED, {
        gttId: triggerId,
        status: 'FAILED',
        error: error.message,
        durationMs,
        source: options.source || 'AUTO'
      });

      console.error('[KITE GTT] GTT cancellation failed:', error.message);
      throw error;
    }
  }

  /**
   * Get all active GTT orders
   */
  async getGTTs() {
    const response = await this.kiteService.makeRequest('GET', kiteConfig.ENDPOINTS.GTT_TRIGGERS);
    return response.data || [];
  }

  /**
   * Cancel a regular order
   */
  async cancelOrder(orderId, options = {}) {
    const startTime = Date.now();

    try {
      console.log(`[KITE ORDER] Cancelling order: ${orderId}`);

      const response = await this.kiteService.makeRequest(
        'DELETE',
        `${kiteConfig.ENDPOINTS.REGULAR_ORDER}/${orderId}`
      );

      const durationMs = Date.now() - startTime;

      // Update order record
      await KiteOrder.findOneAndUpdate(
        { order_id: orderId },
        {
          status: 'CANCELLED',
          cancelled_at: new Date(),
          notes: options.reason || 'Order cancelled'
        }
      );

      // Log to audit
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.ORDER_CANCELLED, {
        orderId,
        status: 'SUCCESS',
        response,
        notes: options.reason,
        durationMs,
        source: options.source || 'AUTO'
      });

      console.log(`[KITE ORDER] Order cancelled successfully: ${orderId}`);

      return { success: true, response };

    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Audit-log guard — same reason as placeOrder() failure path.
      try {
        await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.ORDER_CANCELLED, {
          orderId,
          status: 'FAILED',
          error: error.message,
          durationMs,
          source: options.source || 'AUTO'
        });
      } catch (auditErr) {
        console.error('[KITE ORDER] Failure-path audit log save failed (cancelOrder):', auditErr.message);
      }

      console.error('[KITE ORDER] Order cancellation failed:', error.message);
      throw error;
    }
  }

  /**
   * Modify a regular order (e.g. trailing stop — update trigger_price)
   * Kite API: PUT /orders/regular/{orderId}
   *
   * @param {string} orderId — Kite order ID to modify
   * @param {Object} params — Fields to update: { order_type, quantity, price, trigger_price, validity }
   */
  async modifyOrder(orderId, params = {}) {
    const startTime = Date.now();

    try {
      console.log(`[KITE ORDER] Modifying order ${orderId}:`, params);

      const response = await this.kiteService.makeRequest(
        'PUT',
        `${kiteConfig.ENDPOINTS.REGULAR_ORDER}/${orderId}`,
        params
      );

      const durationMs = Date.now() - startTime;

      // Update order record in DB
      const updateFields = { modified_at: new Date() };
      if (params.trigger_price) updateFields.trigger_price = params.trigger_price;
      if (params.price) updateFields.price = params.price;
      if (params.quantity) updateFields.quantity = params.quantity;

      await KiteOrder.findOneAndUpdate(
        { order_id: orderId },
        updateFields
      );

      // Log to audit
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.ORDER_MODIFIED, {
        orderId,
        modifications: params,
        status: 'SUCCESS',
        response,
        durationMs,
        source: params.source || 'AUTO'
      });

      console.log(`[KITE ORDER] Order modified successfully: ${orderId}`);

      return { success: true, orderId, response };

    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Audit-log guard — same reason as placeOrder() failure path.
      try {
        await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.ORDER_MODIFIED, {
          orderId,
          modifications: params,
          status: 'FAILED',
          error: error.message,
          durationMs,
          source: params.source || 'AUTO'
        });
      } catch (auditErr) {
        console.error('[KITE ORDER] Failure-path audit log save failed (modifyOrder):', auditErr.message);
      }

      console.error(`[KITE ORDER] Order modification failed for ${orderId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get LTP (Last Traded Price) for one or more instruments.
   * Kite API: GET /quote/ltp?i=NSE:SYMBOL1&i=NSE:SYMBOL2
   *
   * @param {string[]} instruments — Array of "EXCHANGE:SYMBOL" strings (e.g. ["NSE:RELIANCE", "NSE:TCS"])
   * @returns {Object} — { "NSE:RELIANCE": { instrument_token, last_price }, ... }
   */
  async getLTP(instruments) {
    try {
      console.log(`[KITE ORDER] Fetching LTP for ${instruments.length} instruments: ${instruments.join(', ')}`);
      // Kite expects repeated 'i' query params: ?i=NSE:INFY&i=NSE:NIFTY+50
      // Colon must NOT be encoded (%3A breaks it), spaces encoded as +
      const queryString = instruments
        .map(i => `i=${i.replace(/ /g, '+')}`)
        .join('&');
      console.log(`[KITE ORDER] LTP query string: ${queryString}`);
      const response = await this.kiteService.makeRequest(
        'GET',
        `${kiteConfig.ENDPOINTS.QUOTE_LTP}?${queryString}`
      );

      const data = response.data || {};
      const prices = Object.entries(data).map(([k, v]) => `${k}=${v.last_price}`).join(', ');
      console.log(`[KITE ORDER] LTP response: ${prices || 'empty'}`);

      return data;

    } catch (error) {
      console.error('[KITE ORDER] LTP fetch failed:', error.message);
      throw error;
    }
  }

  /**
   * Get OHLC (Open/High/Low/Close) for one or more instruments.
   * Kite API: GET /quote/ohlc?i=NSE:SYMBOL1&i=NSE:SYMBOL2
   *
   * @param {string[]} instruments — Array of "EXCHANGE:SYMBOL" strings
   * @returns {Object} — { "NSE:RELIANCE": { last_price, ohlc: { open, high, low, close } }, ... }
   */
  async getOHLC(instruments) {
    try {
      console.log(`[KITE ORDER] Fetching OHLC for ${instruments.length} instruments: ${instruments.join(', ')}`);
      const queryString = instruments
        .map(i => `i=${i.replace(/ /g, '+')}`)
        .join('&');

      const response = await this.kiteService.makeRequest(
        'GET',
        `${kiteConfig.ENDPOINTS.QUOTE_OHLC}?${queryString}`
      );

      const data = response.data || {};
      const summary = Object.entries(data).map(([k, v]) =>
        `${k}: O=${v.ohlc?.open} H=${v.ohlc?.high} L=${v.ohlc?.low} C=${v.ohlc?.close} LTP=${v.last_price}`
      ).join(' | ');
      console.log(`[KITE ORDER] OHLC response: ${summary || 'empty'}`);

      return data;

    } catch (error) {
      console.error('[KITE ORDER] OHLC fetch failed:', error.message);
      throw error;
    }
  }

  /**
   * Fetch intraday OHLCV candles for multiple symbols.
   *
   * Uses instrument_token from a getLTP call (avoiding a separate instrument lookup).
   * Returns the last `numCandles` completed candles — the currently-forming candle
   * is excluded by fetching up to 1 minute ago.
   *
   * @param {string[]} symbols   - e.g. ['SAIL', 'IIFL']
   * @param {string}   interval  - '5minute' | '15minute' | 'minute' etc.
   * @param {number}   numCandles - how many completed candles to return (default 5)
   * @returns {Object} { SAIL: [{date,open,high,low,close,volume}, ...], ... }
   */
  async getIntradayCandles(symbols, interval, numCandles = 5) {
    try {
      // Step 1: get instrument tokens via LTP (cheapest call, already used by monitor)
      const instruments = symbols.map(s => `NSE:${s}`);
      const ltpData = await this.getLTP(instruments);

      // Step 2: compute from/to window — start of session to 1 min ago (exclude forming candle)
      // We add IST offset manually so toISOString() yields an IST-looking string
      // without depending on the machine's local timezone setting.
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istNow    = new Date(now.getTime() + istOffset);
      const toDate    = new Date(istNow.getTime() - 60_000); // 1 min ago — exclude forming candle

      const fmt = d => d.toISOString().replace('T', ' ').slice(0, 19);
      // Build "from" as today's session open (9:15 AM IST) — use date from istNow,
      // then hardcode the time so it's never affected by machine local time.
      const istDateStr = istNow.toISOString().slice(0, 10); // YYYY-MM-DD in IST
      const from = `${istDateStr} 09:15:00`;
      const to   = fmt(toDate);

      console.log(`[KITE ORDER] getIntradayCandles: interval=${interval} from=${from} to=${to} symbols=${symbols.join(',')}`);

      // Step 3: fetch candles per symbol in parallel
      const result = {};
      await Promise.all(symbols.map(async symbol => {
        const token = ltpData[`NSE:${symbol}`]?.instrument_token;
        if (!token) {
          console.warn(`[KITE ORDER] getIntradayCandles: no instrument_token for ${symbol} — LTP keys=${Object.keys(ltpData).join(',')}`);
          return;
        }
        try {
          const candles = await this.kiteService.getHistoricalData(token, interval, from, to);
          const sliced = candles.slice(-numCandles);
          result[symbol] = sliced;

          // Debug: log last candle so we can verify data is correct
          if (sliced.length > 0) {
            const last = sliced[sliced.length - 1];
            console.log(`[KITE ORDER] ${symbol} ${interval}: ${sliced.length} candles — last: ${last.date} O=${last.open} H=${last.high} L=${last.low} C=${last.close} V=${last.volume}`);
          } else {
            console.warn(`[KITE ORDER] ${symbol} ${interval}: 0 candles returned (token=${token} from=${from} to=${to})`);
          }
        } catch (err) {
          console.error(`[KITE ORDER] getIntradayCandles ${symbol} ${interval} (token=${token}): ${err.message}`);
          result[symbol] = [];
        }
      }));

      return result;
    } catch (err) {
      console.error('[KITE ORDER] getIntradayCandles failed:', err.message);
      return {};
    }
  }

  /**
   * Fetch intraday candles for multiple symbols AND multiple intervals in one shot.
   * Single LTP call for instrument tokens, then all symbol×interval fetches in parallel.
   *
   * @param {string[]} symbols         - e.g. ['SAIL', 'IIFL']
   * @param {Array}    intervalsConfig  - [{interval:'5minute', count:6}, {interval:'15minute', count:4}]
   * @returns {Object} { '5minute': { SAIL: [...], IIFL: [...] }, '15minute': { ... } }
   */
  async getIntradayMultiCandles(symbols, intervalsConfig) {
    // Initialise empty result structure
    const result = {};
    for (const { interval } of intervalsConfig) result[interval] = {};

    try {
      // ── Single LTP call — gets instrument_token for every symbol ──
      const instruments = symbols.map(s => `NSE:${s}`);
      const ltpData = await this.getLTP(instruments);

      // ── Time window (shared across all intervals) ──
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istNow    = new Date(now.getTime() + istOffset);
      const toDate    = new Date(istNow.getTime() - 60_000);     // 1 min ago — exclude forming candle
      const fmt       = d => d.toISOString().replace('T', ' ').slice(0, 19);
      const istDateStr = istNow.toISOString().slice(0, 10);      // YYYY-MM-DD in IST
      const from      = `${istDateStr} 09:15:00`;
      const to        = fmt(toDate);

      // Guard: if market hasn't opened yet (or exactly at 9:15), `to` < `from` — Kite returns 400.
      // Return empty shells immediately; caller handles 0 bars gracefully.
      const marketOpenMs = new Date(`${istDateStr}T09:15:00+05:30`).getTime();
      if (toDate.getTime() <= marketOpenMs) {
        console.log(`[KITE ORDER] getIntradayMultiCandles: too early (to=${to} <= market open 09:15) — returning empty`);
        return result;
      }

      console.log(`[KITE ORDER] getIntradayMultiCandles: from=${from} to=${to} symbols=${symbols.join(',')} intervals=${intervalsConfig.map(c => `${c.interval}(${c.count})`).join(',')}`);

      // ── Build tasks for every symbol × interval combo ──────────────────
      const tasks = [];
      for (const symbol of symbols) {
        const token = ltpData[`NSE:${symbol}`]?.instrument_token;
        if (!token) {
          console.warn(`[KITE ORDER] getIntradayMultiCandles: no token for ${symbol} — ltpKeys=${Object.keys(ltpData).join(',')}`);
          for (const { interval } of intervalsConfig) result[interval][symbol] = [];
          continue;
        }
        for (const { interval, count } of intervalsConfig) {
          tasks.push(async () => {
            try {
              const candles = await this.kiteService.getHistoricalData(token, interval, from, to);
              const sliced  = candles.slice(-count);
              result[interval][symbol] = sliced;
              if (sliced.length > 0) {
                const last = sliced[sliced.length - 1];
                console.log(`[KITE ORDER] ${symbol} ${interval}: ${sliced.length} bars — last: ${last.date} O=${last.open} H=${last.high} L=${last.low} C=${last.close} V=${last.volume}`);
              } else {
                console.warn(`[KITE ORDER] ${symbol} ${interval}: 0 bars returned (token=${token} from=${from} to=${to})`);
              }
            } catch (err) {
              console.error(`[KITE ORDER] ${symbol} ${interval} (token=${token}): ${err.message}`);
              result[interval][symbol] = [];
            }
          });
        }
      }

      // ── Rate-limited execution (2026-06-05) ─────────────────────────────
      // Kite's historical-data endpoint allows 3 req/sec. Prior code did
      // Promise.all(tasks) which burst 40+ requests in parallel, producing
      // 98 × 429 "Too many requests" errors on 2026-06-05 — silently dropping
      // 45% of the breakout-scan universe to zero bars. Cap concurrency at 3.
      console.log(`[KITE ORDER] getIntradayMultiCandles: dispatching ${tasks.length} tasks with concurrency=${KITE_HISTORICAL_CONCURRENCY}`);
      await runWithConcurrency(tasks, KITE_HISTORICAL_CONCURRENCY);
      return result;

    } catch (err) {
      console.error('[KITE ORDER] getIntradayMultiCandles failed:', err.message);
      return result; // return empty shells — caller handles missing data gracefully
    }
  }

  /**
   * Fetch historical candles for arbitrary date ranges (for backtest archival).
   *
   * Unlike getIntradayMultiCandles (which is hard-wired to today 09:15→now), this
   * accepts explicit `from`/`to` so it can backfill past days. Resolves instrument
   * tokens via getLTP (chunked), then calls kiteService.getHistoricalData per symbol.
   *
   * Kite historical limits: 1-min data is available ~3 years back but only 60 days
   * per request — the caller (candleArchive) backfills one day at a time, so we're
   * always well within that. Historical API is rate-limited (~3 req/s), so symbols
   * are fetched in small batches with a pause between.
   *
   * @param {string[]} symbols  - e.g. ['SBIN','NIFTY 50']
   * @param {string}   interval - 'minute' | '5minute' | '15minute' | 'day'
   * @param {string}   from     - 'YYYY-MM-DD HH:MM:SS' (IST)
   * @param {string}   to       - 'YYYY-MM-DD HH:MM:SS' (IST)
   * @returns {Object} { SBIN: [{date,open,high,low,close,volume}, ...], ... }
   */
  async getHistoricalCandles(symbols, interval, from, to, { batch = 3, delayMs = 400 } = {}) {
    const result = {};

    // ── Resolve instrument tokens via LTP (chunked at 100) ──
    const tokenMap = {};
    for (let i = 0; i < symbols.length; i += 100) {
      const slice = symbols.slice(i, i + 100).map(s => `NSE:${s}`);
      try {
        const ltp = await this.getLTP(slice);
        for (const [k, v] of Object.entries(ltp || {})) {
          const sym = k.replace(/^NSE:/, '');
          if (v?.instrument_token) tokenMap[sym] = v.instrument_token;
        }
      } catch (err) {
        console.error(`[KITE ORDER] getHistoricalCandles token batch ${i} failed: ${err.message}`);
      }
    }

    const resolvable = symbols.filter(s => tokenMap[s]);
    const missing    = symbols.filter(s => !tokenMap[s]);
    if (missing.length) console.warn(`[KITE ORDER] getHistoricalCandles: no token for ${missing.length} symbols: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? '…' : ''}`);

    // ── Fetch candles in small rate-limit-friendly batches ──
    for (let i = 0; i < resolvable.length; i += batch) {
      const group = resolvable.slice(i, i + batch);
      await Promise.all(group.map(async (sym) => {
        try {
          const candles = await this.kiteService.getHistoricalData(tokenMap[sym], interval, from, to);
          result[sym] = candles || [];
        } catch (err) {
          console.error(`[KITE ORDER] getHistoricalCandles ${sym} (${interval} ${from}→${to}): ${err.message}`);
          result[sym] = [];
        }
      }));
      if (i + batch < resolvable.length) await new Promise(r => setTimeout(r, delayMs));
    }
    return result;
  }

  /**
   * Get open positions from Kite (for reconciliation on startup)
   */
  async getPositions() {
    try {
      console.log('[KITE ORDER] Fetching positions...');
      const positions = await this.kiteService.getPositions();
      const dayPositions = positions?.data?.day || [];
      const openCount = dayPositions.filter(p => p.quantity !== 0).length;
      console.log(`[KITE ORDER] Positions: ${dayPositions.length} day entries, ${openCount} open`);
      return positions;
    } catch (error) {
      console.error('[KITE ORDER] Positions fetch failed:', error.message);
      throw error;
    }
  }

  /**
   * Get order details from Kite
   */
  async getOrderDetails(orderId) {
    console.log(`[KITE ORDER] Fetching order details for orderId=${orderId}`);
    const orders = await this.kiteService.getOrders();
    const order = orders.data?.find(o => o.order_id === orderId);
    if (order) {
      console.log(`[KITE ORDER] Order ${orderId}: status=${order.status} symbol=${order.tradingsymbol} avg_price=${order.average_price} filled_qty=${order.filled_quantity}`);
    } else {
      console.log(`[KITE ORDER] Order ${orderId}: NOT FOUND in ${orders.data?.length || 0} orders`);
    }
    return order;
  }

  /**
   * Place entry GTT for a stock
   */
  async placeEntryGTT(stockData) {
    const { tradingSymbol, entryPrice, currentPrice, quantity, stockId, simulationId } = stockData;

    return this.placeGTT({
      type: kiteConfig.GTT_TYPES.SINGLE,
      tradingsymbol: tradingSymbol,
      trigger_values: [entryPrice],
      last_price: currentPrice,
      orders: [{
        transaction_type: kiteConfig.TRANSACTION_TYPES.BUY,
        quantity: quantity,
        order_type: kiteConfig.ORDER_TYPES.LIMIT,
        product: kiteConfig.PRODUCT_TYPES.CNC,
        price: entryPrice
      }],
      orderType: 'ENTRY',
      stockId,
      simulationId
    });
  }

  /**
   * Place OCO GTT (Stop Loss + Target)
   */
  async placeOCOGTT(ocoData) {
    const {
      tradingSymbol,
      currentPrice,
      stopLoss,
      target,
      quantity,
      stockId,
      simulationId,
      transactionType = kiteConfig.TRANSACTION_TYPES.SELL,
      product = kiteConfig.PRODUCT_TYPES.CNC,
      orderType = 'STOP_LOSS'
    } = ocoData;

    return this.placeGTT({
      type: kiteConfig.GTT_TYPES.TWO_LEG,
      tradingsymbol: tradingSymbol,
      trigger_values: [stopLoss, target],
      last_price: currentPrice,
      orders: [
        // Stop Loss leg
        {
          transaction_type: transactionType,
          quantity: quantity,
          order_type: kiteConfig.ORDER_TYPES.LIMIT,
          product: product,
          price: stopLoss * 0.99 // Slightly below trigger for execution
        },
        // Target leg
        {
          transaction_type: transactionType,
          quantity: quantity,
          order_type: kiteConfig.ORDER_TYPES.LIMIT,
          product: product,
          price: target
        }
      ],
      orderType,
      stockId,
      simulationId
    });
  }

  /**
   * Get today's order count
   */
  async getTodayOrderCount() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const count = await KiteOrder.countDocuments({
      user_id: this.adminUserId,
      created_at: { $gte: today }
    });

    return count;
  }

  /**
   * Check if we can place more orders today
   */
  async canPlaceOrder() {
    const count = await this.getTodayOrderCount();
    return count < kiteConfig.MAX_DAILY_ORDERS;
  }
}

// Export singleton instance
const kiteOrderService = new KiteOrderService();
export default kiteOrderService;
