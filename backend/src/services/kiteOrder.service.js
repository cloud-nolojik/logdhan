import kiteAutoLoginService from './kiteAutoLogin.service.js';
import KiteOrder from '../models/kiteOrder.js';
import KiteAuditLog from '../models/kiteAuditLog.js';
import kiteConfig from '../config/kite.config.js';

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
      // Apply MIS leverage factor (2x) to reflect intraday buying power.
      const availableMargin = equity.net || 0;
      const availableCash = equity.available?.cash || 0;
      const leveragedMargin = availableMargin * (kiteConfig.MIS_LEVERAGE_FACTOR || 1);
      const usableAmount = leveragedMargin * kiteConfig.CAPITAL_USAGE_PERCENT;
      const rawSwing = usableAmount * kiteConfig.SWING_CAPITAL_PERCENT;
      const rawIntraday = usableAmount * kiteConfig.INTRADAY_CAPITAL_PERCENT;

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

      console.log(`[KITE ORDER] Balance: net=₹${availableMargin} cash=₹${availableCash} leveraged=₹${leveragedMargin} (${kiteConfig.MIS_LEVERAGE_FACTOR}x) usable=₹${usableAmount} (${kiteConfig.CAPITAL_USAGE_PERCENT * 100}%)`);
      console.log(`[KITE ORDER] Swing: raw=₹${rawSwing} pending=₹${pendingSwingValue} available=₹${usableSwing} | Intraday: raw=₹${rawIntraday} pending=₹${pendingIntradayValue} available=₹${usableIntraday}`);

      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.BALANCE_CHECK, {
        status: 'SUCCESS',
        response: { availableMargin, availableCash, leveragedMargin, usableAmount, rawSwing, rawIntraday, pendingSwingValue, pendingIntradayValue, usableSwing, usableIntraday },
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

      // Log failed order
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

      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.ORDER_CANCELLED, {
        orderId,
        status: 'FAILED',
        error: error.message,
        durationMs,
        source: options.source || 'AUTO'
      });

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

      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.ORDER_MODIFIED, {
        orderId,
        modifications: params,
        status: 'FAILED',
        error: error.message,
        durationMs,
        source: params.source || 'AUTO'
      });

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
          transaction_type: kiteConfig.TRANSACTION_TYPES.SELL,
          quantity: quantity,
          order_type: kiteConfig.ORDER_TYPES.LIMIT,
          product: kiteConfig.PRODUCT_TYPES.CNC,
          price: stopLoss * 0.99 // Slightly below trigger for execution
        },
        // Target leg
        {
          transaction_type: kiteConfig.TRANSACTION_TYPES.SELL,
          quantity: quantity,
          order_type: kiteConfig.ORDER_TYPES.LIMIT,
          product: kiteConfig.PRODUCT_TYPES.CNC,
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
