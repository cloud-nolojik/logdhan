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
      const margins = await this.kiteService.getMargins();
      const equity = margins.data?.equity || {};

      const availableCash = equity.available?.cash || 0;
      const usableAmount = availableCash * kiteConfig.CAPITAL_USAGE_PERCENT;

      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.BALANCE_CHECK, {
        status: 'SUCCESS',
        response: { availableCash, usableAmount },
        source: 'AUTO'
      });

      return {
        total: equity.net || 0,
        available: availableCash,
        usable: usableAmount,
        used: equity.utilised?.debits || 0
      };
    } catch (error) {
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

      // Add price for LIMIT orders
      if (params.order_type === 'LIMIT' && orderParams.price) {
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

      // Create order record in database
      const kiteOrder = await KiteOrder.create({
        user_id: this.adminUserId,
        stock_id: orderParams.stockId,
        simulation_id: orderParams.simulationId,
        order_id: response.data?.order_id,
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

      // Log to audit
      await KiteAuditLog.logAction(kiteConfig.AUDIT_ACTIONS.ORDER_PLACED, {
        orderId: response.data?.order_id,
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
        kiteOrderRef: kiteOrder._id,
        durationMs,
        source: orderParams.source || 'AUTO'
      });

      console.log(`[KITE ORDER] Order placed successfully. Order ID: ${response.data?.order_id}`);

      return {
        success: true,
        orderId: response.data?.order_id,
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
   * Place a GTT (Good Till Triggered) order
   */
  async placeGTT(gttParams) {
    const startTime = Date.now();

    try {
      const params = {
        trigger_type: gttParams.type || kiteConfig.GTT_TYPES.SINGLE,
        tradingsymbol: gttParams.tradingsymbol,
        exchange: gttParams.exchange || kiteConfig.DEFAULT_EXCHANGE,
        trigger_values: JSON.stringify(gttParams.trigger_values),
        last_price: gttParams.last_price,
        orders: JSON.stringify(gttParams.orders.map(order => ({
          transaction_type: order.transaction_type,
          quantity: order.quantity,
          order_type: order.order_type || kiteConfig.ORDER_TYPES.LIMIT,
          product: order.product || kiteConfig.DEFAULT_PRODUCT,
          price: order.price
        })))
      };

      console.log('[KITE GTT] Placing GTT:', {
        type: params.trigger_type,
        symbol: params.tradingsymbol,
        triggers: gttParams.trigger_values
      });

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
   * Get order details from Kite
   */
  async getOrderDetails(orderId) {
    const orders = await this.kiteService.getOrders();
    return orders.data?.find(o => o.order_id === orderId);
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
