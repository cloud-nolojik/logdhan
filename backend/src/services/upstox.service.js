import axios from 'axios';
import crypto from 'crypto';

class UpstoxService {
  constructor() {
    this.baseURL = 'https://api.upstox.com/v2';
    this.hftBaseURL = 'https://api-hft.upstox.com/v2';
    this.clientId = process.env.UPSTOX_CLIENT_ID;
    this.clientSecret = process.env.UPSTOX_CLIENT_SECRET;
    this.redirectUri = process.env.UPSTOX_REDIRECT_URI || 'https://logdhan.com/api/v1/upstox/callback';
  }

  /**
   * Get tick size for a given price based on NSE rules
   * NSE tick size rules:
   * - Price < ₹1: tick size = ₹0.01
   * - Price ₹1 to ₹5: tick size = ₹0.01
   * - Price ₹5 to ₹10: tick size = ₹0.01
   * - Price ₹10 to ₹100: tick size = ₹0.05
   * - Price > ₹100: tick size = ₹0.05
   *
   * Note: Most stocks > ₹100 use ₹0.05 tick size
   */
  getTickSize(price) {
    if (price < 1) return 0.01;
    if (price < 5) return 0.01;
    if (price < 10) return 0.01;
    // For prices >= ₹10, NSE uses ₹0.05 tick size
    return 0.05;
  }

  /**
   * Round price to valid NSE tick size
   * @param {number} price - The price to round
   * @param {string} direction - 'nearest', 'up', or 'down'
   * @returns {number} - Price rounded to valid tick size
   */
  roundToTickSize(price, direction = 'nearest') {
    const tickSize = this.getTickSize(price);

    let rounded;
    switch (direction) {
      case 'up':
        rounded = Math.ceil(price / tickSize) * tickSize;
        break;
      case 'down':
        rounded = Math.floor(price / tickSize) * tickSize;
        break;
      case 'nearest':
      default:
        rounded = Math.round(price / tickSize) * tickSize;
        break;
    }

    // Fix floating point precision issues
    const decimalPlaces = tickSize === 0.05 ? 2 : 2;
    rounded = parseFloat(rounded.toFixed(decimalPlaces));

    console.log(`[TICK SIZE] Price ₹${price} -> Tick: ₹${tickSize} -> Rounded (${direction}): ₹${rounded}`);
    return rounded;
  }

  /**
   * Validate and correct all prices for an order
   * Entry price rounded to nearest, StopLoss down (more protective), Target up (more optimistic)
   */
  correctOrderPrices(entryPrice, stopLossPrice = null, targetPrice = null, transactionType = 'BUY') {
    const corrected = {
      entry: this.roundToTickSize(entryPrice, 'nearest'),
      stopLoss: null,
      target: null
    };

    if (stopLossPrice) {
      // For BUY: round SL down (lower = more protective)
      // For SELL: round SL up (higher = more protective)
      const slDirection = transactionType === 'BUY' ? 'down' : 'up';
      corrected.stopLoss = this.roundToTickSize(stopLossPrice, slDirection);
    }

    if (targetPrice) {
      // For BUY: round target up (higher = more optimistic)
      // For SELL: round target down (lower = more optimistic)
      const targetDirection = transactionType === 'BUY' ? 'up' : 'down';
      corrected.target = this.roundToTickSize(targetPrice, targetDirection);
    }

    console.log(`[TICK SIZE] Order prices corrected:
      Entry: ₹${entryPrice} -> ₹${corrected.entry}
      StopLoss: ₹${stopLossPrice} -> ₹${corrected.stopLoss}
      Target: ₹${targetPrice} -> ₹${corrected.target}`);

    return corrected;
  }

  /**
   * Generate authorization URL for Upstox login
   */
  generateAuthUrl(state = null) {
    if (!this.clientId) {
      throw new Error('UPSTOX_CLIENT_ID not configured');
    }

    // Generate random state for security if not provided
    const authState = state || crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state: authState
    });

    return {
      url: `${this.baseURL}/login/authorization/dialog?${params.toString()}`,
      state: authState
    };
  }

  /**
   * Exchange authorization code for access token
   */
  async getAccessToken(code, state = null) {
    try {
      const response = await axios.post(
        `${this.baseURL}/login/authorization/token`,
        new URLSearchParams({
          code,
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri,
          grant_type: 'authorization_code'
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json'
          }
        }
      );

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error('❌ Upstox token exchange error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'token_exchange_failed',
        message: error.response?.data?.message || 'Failed to exchange code for token'
      };
    }
  }

  /**
   * Get user profile using access token
   */
  async getUserProfile(accessToken) {
    try {
      const response = await axios.get(`${this.baseURL}/user/profile`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error('❌ Upstox profile fetch error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'profile_fetch_failed',
        message: error.response?.data?.message || 'Failed to fetch user profile'
      };
    }
  }

  /**
   * Place Multi Order bracket orders (main + stop-loss + target)
   * COMMENTED OUT - Using only placeOrder for now
   */
  /* async placeMultiOrderBracket(accessToken, orderData) {
      try {
          const {
              instrumentToken,
              quantity,
              price,
              transactionType,
              product,
              validity = 'DAY',
              tag,
              disclosedQuantity = 0,
              isAmo = false,
              stopLoss,
              target
          } = orderData;
           const entryPrice = parseFloat(price);
          const stopLossPrice = parseFloat(stopLoss);
          const targetPrice = parseFloat(target);
          
          console.log(`📋 Multi Order Bracket Parameters:
              Entry: ₹${entryPrice}
              Stop Loss: ₹${stopLossPrice}
              Target: ₹${targetPrice}`);
           // Build multi-order array
          const orders = [];
          // Use the tag provided from convertAIStrategyToOrder instead of generating new one
          const correlationBase = tag;
          
          // 1. Main order (entry)
          orders.push({
              correlation_id: `${correlationBase}_M`, // M for Main
              quantity: parseInt(quantity),
              product: product,
              validity,
              price: entryPrice,
              tag: correlationBase, // Same tag for all orders in bracket
              instrument_token: instrumentToken,
              order_type: 'LIMIT',
              transaction_type: transactionType.toUpperCase(),
              disclosed_quantity: parseInt(disclosedQuantity),
              trigger_price: 0,
              is_amo: Boolean(isAmo),
              slice: true
          });
           // Opposite transaction type for SL and target
          const oppositeTransactionType = transactionType.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
           // 2. Stop-loss order (if provided)
          if (stopLoss && stopLoss > 0) {
              // For SL orders, trigger should be slightly adjusted
              const triggerPrice = transactionType.toUpperCase() === 'BUY' 
                  ? stopLossPrice * 1.001  // BUY->SELL SL: trigger slightly above limit
                  : stopLossPrice * 0.999; // SELL->BUY SL: trigger slightly below limit
               orders.push({
                  correlation_id: `${correlationBase}_S`, // S for Stop Loss
                  quantity: parseInt(quantity),
                  product: product,
                  validity,
                  price: stopLossPrice,
                  tag: correlationBase, // Same tag for all orders in bracket
                  instrument_token: instrumentToken,
                  order_type: 'SL',
                  transaction_type: oppositeTransactionType,
                  disclosed_quantity: parseInt(disclosedQuantity),
                  trigger_price: triggerPrice,
                  is_amo: Boolean(isAmo),
                  slice: true
              });
          }
           // 3. Target order (if provided)
          if (target && target > 0) {
              orders.push({
                  correlation_id: `${correlationBase}_T`, // T for Target
                  quantity: parseInt(quantity),
                  product: product,
                  validity,
                  price: targetPrice,
                  tag: correlationBase, // Same tag for all orders in bracket
                  instrument_token: instrumentToken,
                  order_type: 'LIMIT',
                  transaction_type: oppositeTransactionType,
                  disclosed_quantity: parseInt(disclosedQuantity),
                  trigger_price: 0,
                  is_amo: Boolean(isAmo),
                  slice: true
              });
          }
           console.log(`📋 Placing ${orders.length} orders via Multi Order API:`, orders);
           const response = await axios.post(
              `${this.baseURL}/order/multi/place`, // Multi Order API endpoint
              orders,
              {
                  headers: {
                      'Content-Type': 'application/json',
                      'Accept': 'application/json',
                      'Authorization': `Bearer ${accessToken}`
                  }
              }
          );
           console.log('✅ Multi Order response:', response.data);
           // Process the response
          const { status, data, summary } = response.data;
          
          if (status === 'success' || status === 'partial_success') {
              const mainOrder = data.find(order => order.correlation_id.includes('_M'));
              const slOrder = data.find(order => order.correlation_id.includes('_S'));
              const targetOrder = data.find(order => order.correlation_id.includes('_T'));
               // Transform to match mobile app's expected response format
              return {
                  success: true,
                  data: {
                      order_id: mainOrder?.order_id || correlationBase, // Main field mobile app expects
                      status: 'success',
                      message: `Bracket order placed successfully. Main: ${mainOrder?.order_id}, SL: ${slOrder?.order_id || 'N/A'}, Target: ${targetOrder?.order_id || 'N/A'}`,
                      // Additional details for debugging
                      bracket_details: {
                          main_order_id: mainOrder?.order_id,
                          stop_loss_order_id: slOrder?.order_id,
                          target_order_id: targetOrder?.order_id,
                          total_orders: data.length,
                          summary: summary
                      }
                  }
              };
          } else {
              throw new Error(`Multi order failed: ${JSON.stringify(response.data)}`);
          }
       } catch (error) {
          console.error('❌ Multi Order Bracket error:', error.response?.data || error.message);
          
          // Fallback to separate orders if multi order fails
          console.log('⚠️ Falling back to separate individual orders...');
          return this.placeSeparateOrders(accessToken, orderData);
      }
  } */

  /**
   * Place separate orders (fallback for bracket orders)
   * COMMENTED OUT - Using only placeOrder for now
   */
  /* async placeSeparateOrders(accessToken, orderData) {
      try {
          const orders = [];
          const {
              instrumentToken,
              quantity,
              price,
              triggerPrice,
              orderType,
              transactionType,
              product,
              validity,
              tag,
              disclosedQuantity = 0,
              isAmo = false,
              stopLoss,
              target
          } = orderData;
           // 1. Place main order
          const mainOrder = {
              instrument_token: instrumentToken,
              quantity: parseInt(quantity),
              product,
              validity,
              price: orderType === 'MARKET' ? 0 : parseFloat(price || 0),
              tag: `${tag}-MAIN`,
              order_type: orderType,
              transaction_type: transactionType.toUpperCase(),
              disclosed_quantity: parseInt(disclosedQuantity),
              trigger_price: parseFloat(triggerPrice || 0),
              is_amo: Boolean(isAmo),
              slice: true
          };
           console.log(`📋 Placing main order:`, mainOrder);
           const mainResponse = await axios.post(
              `${this.hftBaseURL}/order/place`,
              mainOrder,
              {
                  headers: {
                      'Content-Type': 'application/json',
                      'Accept': 'application/json',
                      'Authorization': `Bearer ${accessToken}`
                  }
              }
          );
           console.log('✅ Main order placed:', mainResponse.data);
          orders.push({ type: 'MAIN', ...mainResponse.data });
           // Determine opposite transaction type for SL and target
          const oppositeTransactionType = transactionType.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
           // 2. Place stop-loss order (if provided)
          if (stopLoss && stopLoss > 0) {
              // For SL orders, trigger_price should be slightly above the limit price
              // to ensure order triggers correctly
              const stopLossPrice = parseFloat(stopLoss);
              const triggerPrice = transactionType.toUpperCase() === 'BUY' 
                  ? stopLossPrice * 1.001  // For BUY->SELL SL: trigger slightly above limit
                  : stopLossPrice * 0.999; // For SELL->BUY SL: trigger slightly below limit
              
              const stopLossOrder = {
                  instrument_token: instrumentToken,
                  quantity: parseInt(quantity),
                  product,
                  validity,
                  price: stopLossPrice,
                  tag: `${tag}-SL`,
                  order_type: 'SL', // Stop Loss order
                  transaction_type: oppositeTransactionType,
                  disclosed_quantity: parseInt(disclosedQuantity),
                  trigger_price: triggerPrice,
                  is_amo: Boolean(isAmo),
                  slice: true
              };
               console.log(`📋 Placing stop-loss order:`, stopLossOrder);
               const slResponse = await axios.post(
                  `${this.hftBaseURL}/order/place`,
                  stopLossOrder,
                  {
                      headers: {
                          'Content-Type': 'application/json',
                          'Accept': 'application/json',
                          'Authorization': `Bearer ${accessToken}`
                      }
                  }
              );
               console.log('✅ Stop-loss order placed:', slResponse.data);
              orders.push({ type: 'STOP_LOSS', ...slResponse.data });
          }
           // 3. Place target order (if provided)
          if (target && target > 0) {
              const targetOrder = {
                  instrument_token: instrumentToken,
                  quantity: parseInt(quantity),
                  product,
                  validity,
                  price: parseFloat(target),
                  tag: `${tag}-TARGET`,
                  order_type: 'LIMIT', // Limit order for target
                  transaction_type: oppositeTransactionType,
                  disclosed_quantity: parseInt(disclosedQuantity),
                  trigger_price: 0,
                  is_amo: Boolean(isAmo),
                  slice: true
              };
               console.log(`📋 Placing target order:`, targetOrder);
               const targetResponse = await axios.post(
                  `${this.hftBaseURL}/order/place`,
                  targetOrder,
                  {
                      headers: {
                          'Content-Type': 'application/json',
                          'Accept': 'application/json',
                          'Authorization': `Bearer ${accessToken}`
                      }
                  }
              );
               console.log('✅ Target order placed:', targetResponse.data);
              orders.push({ type: 'TARGET', ...targetResponse.data });
          }
           return {
              success: true,
              data: {
                  bracket_order_id: mainResponse.data.data?.order_ids?.[0] || 'BRACKET_' + Date.now(),
                  orders: orders,
                  main_order_id: mainResponse.data.data?.order_ids?.[0],
                  total_orders: orders.length
              }
          };
       } catch (error) {
          console.error('❌ Bracket order placement error:', error.response?.data || error.message);
          return {
              success: false,
              error: 'bracket_order_failed',
              message: error.response?.data?.message || 'Failed to place bracket order',
              details: error.response?.data
          };
      }
  } */

  /**
   * Place order on Upstox (single order)
   */
  async placeOrder(accessToken, orderData) {
    try {
      const {
        instrumentToken,
        quantity,
        price,
        triggerPrice,
        orderType, // MARKET, LIMIT, SL, SL-M
        transactionType, // BUY, SELL
        product, // D (Delivery), I (Intraday), CO (Cover Order), MTF (Margin Trade Funding)
        validity = 'DAY',
        disclosedQuantity = 0,
        isAmo = false
      } = orderData;

      // Validate required fields
      if (!instrumentToken || !quantity || !orderType || !transactionType || !product) {
        throw new Error('Missing required order parameters');
      }

      // Apply tick size correction for LIMIT and SL orders
      let correctedPrice = orderType === 'MARKET' ? 0 : parseFloat(price || 0);
      let correctedTriggerPrice = parseFloat(triggerPrice || 0);

      if (orderType !== 'MARKET' && price) {
        correctedPrice = this.roundToTickSize(parseFloat(price), 'nearest');
        console.log(`[ORDER] Price tick corrected: ₹${price} -> ₹${correctedPrice}`);
      }

      if (triggerPrice && triggerPrice > 0) {
        correctedTriggerPrice = this.roundToTickSize(parseFloat(triggerPrice), 'nearest');
        console.log(`[ORDER] Trigger price tick corrected: ₹${triggerPrice} -> ₹${correctedTriggerPrice}`);
      }

      const orderPayload = {
        instrument_token: instrumentToken,
        quantity: parseInt(quantity),
        product,
        validity,
        price: correctedPrice,
        tag: orderData.tag || `ORDER_${Date.now()}`,
        order_type: orderType,
        transaction_type: transactionType.toUpperCase(),
        disclosed_quantity: parseInt(disclosedQuantity),
        trigger_price: correctedTriggerPrice,
        is_amo: Boolean(isAmo)
      };

      const response = await axios.post(
        `${this.hftBaseURL}/order/place`,
        orderPayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          }
        }
      );

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error('❌ Upstox order placement error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'order_placement_failed',
        message: error.response?.data?.message || 'Failed to place order',
        details: error.response?.data
      };
    }
  }

  /**
   * Place multiple orders using Multi Order API
   */
  async placeMultiOrder(accessToken, orderArray) {
    try {
      // Validate input
      if (!Array.isArray(orderArray) || orderArray.length === 0) {
        throw new Error('orderArray must be a non-empty array');
      }

      if (orderArray.length > 25) {
        throw new Error('Maximum 25 orders allowed in single request');
      }

      // Validate each order structure matches Upstox API requirements
      orderArray.forEach((order, index) => {
        const required = ['correlation_id', 'quantity', 'product', 'validity', 'price', 'instrument_token', 'order_type', 'transaction_type'];
        const missing = required.filter((field) => order[field] === undefined || order[field] === null);

        if (missing.length > 0) {
          throw new Error(`Order ${index}: Missing required fields: ${missing.join(', ')}`);
        }

        // Validate correlation_id length (max 20 characters)
        if (order.correlation_id.length > 20) {
          throw new Error(`Order ${index}: correlation_id must not exceed 20 characters`);
        }

        // Validate tag length (max 40 characters)  
        if (order.tag && order.tag.length > 40) {
          throw new Error(`Order ${index}: tag must not exceed 40 characters`);
        }
      });

      console.log('[UPSTOX] 📤 Sending multi-order request:', JSON.stringify(orderArray, null, 2));

      const response = await axios.post(
        `${this.baseURL}/order/multi/place`,
        orderArray,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          }
        }
      );

      console.log('[UPSTOX] ✅ Multi-order response:', JSON.stringify(response.data, null, 2));

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error('❌ Upstox multi-order placement error:');
      console.error('   Status:', error.response?.status);
      console.error('   Data:', JSON.stringify(error.response?.data, null, 2));
      console.error('   Message:', error.message);
      return {
        success: false,
        error: 'multi_order_placement_failed',
        message: error.response?.data?.message || error.response?.data?.errors?.[0]?.message || 'Failed to place multi orders',
        details: error.response?.data
      };
    }
  }

  /**
   * Get order book - all orders for current day
   */
  async getOrderHistory(accessToken) {
    try {

      const response = await axios.get(`${this.baseURL}/order/retrieve-all`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      // The response is directly an array of orders, not wrapped in a data object
      const orders = Array.isArray(response.data) ? response.data : response.data?.data || [];

      // Log summary of all orders
      const statusCounts = {};
      orders.forEach((order) => {
        const status = order.status || 'unknown';
        statusCounts[status] = (statusCounts[status] || 0) + 1;

      });

      return {
        success: true,
        data: {
          data: orders // Wrap in data object for consistency with other APIs
        }
      };
    } catch (error) {
      console.error('❌ Upstox order book error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'order_book_failed',
        message: error.response?.data?.message || 'Failed to fetch order book'
      };
    }
  }

  /**
   * Get positions
   */
  async getPositions(accessToken) {
    try {
      const response = await axios.get(`${this.baseURL}/portfolio/long-term-positions`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      console.error('❌ Upstox positions error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'positions_fetch_failed',
        message: error.response?.data?.message || 'Failed to fetch positions'
      };
    }
  }

  /**
   * Check if markets are open using Upstox Market Timings API
   */
  async isMarketOpen(accessToken, exchange = 'NSE') {
    try {
      // Get today's date in YYYY-MM-DD format
      const today = new Date().toISOString().split('T')[0];

      const response = await axios.get(`${this.baseURL}/market/timings/${today}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      if (response.data.status === 'success') {
        const marketData = response.data.data.find((market) => market.exchange === exchange);

        if (marketData) {
          const now = Date.now();
          const isOpen = now >= marketData.start_time && now <= marketData.end_time;

          return isOpen;
        }
      }

      // Fallback: assume market is closed if API fails

      return false;

    } catch (error) {
      console.error('❌ Market timings check error:', error.response?.data || error.message);
      // Fallback: assume market is closed if API fails
      return false;
    }
  }

  /**
   * Convert AI strategy to Upstox order parameters
   */
  async convertAIStrategyToOrder(strategy, instrumentToken, analysisType = 'swing', accessToken = null) {
    const {
      type,
      entry,
      target,
      stopLoss,
      entryType = 'limit',
      suggested_qty = 1
    } = strategy;

    // Determine product type based on analysis type
    const product = analysisType === 'intraday' ? 'I' : 'D';

    // Convert strategy type to transaction type
    let transactionType;
    if (type === 'BUY') {
      transactionType = 'BUY';
    } else if (type === 'SELL') {
      transactionType = 'SELL';
    } else {
      throw new Error(`Invalid strategy type: ${type}. Only BUY/SELL supported for order placement.`);
    }

    // Convert entryType to Upstox order type
    let orderType;
    let price = 0;
    let triggerPrice = 0;

    switch (entryType.toLowerCase()) {
      case 'market':
        orderType = 'MARKET';
        price = 0;
        break;
      case 'limit':
        orderType = 'LIMIT';
        price = entry;
        break;
      case 'stop':
      case 'stop-limit':
        orderType = 'SL';
        price = entry;
        triggerPrice = entry * 0.995; // Slightly below entry for buy orders
        break;
      default:
        orderType = 'LIMIT';
        price = entry;
    }

    // Check if market is open to determine if this should be an AMO
    const isMarketCurrentlyOpen = accessToken ? await this.isMarketOpen(accessToken) : false;
    const isAmo = !isMarketCurrentlyOpen;

    // Generate consistent BRC_ tag for bracket orders
    const shortTimestamp = Date.now().toString().slice(-8);
    const correlationBase = `BRC_${shortTimestamp}`;

    return {
      instrumentToken,
      quantity: Math.max(1, Math.floor(suggested_qty || 1)),
      price,
      triggerPrice,
      orderType,
      transactionType,
      product,
      validity: 'DAY',
      tag: correlationBase, // Use BRC_ tag format consistently
      disclosedQuantity: 0,
      isAmo: isAmo,
      stopLoss: stopLoss, // From AI strategy
      target: target // From AI strategy
    };
  }

  /**
   * Cancel multiple orders using Cancel Multi Order API
   */
  async cancelMultipleOrders(accessToken, orderIds = null, segment = null, tag = null) {
    try {
      const params = new URLSearchParams();

      if (segment) {
        params.append('segment', segment);
      }

      if (tag) {
        params.append('tag', tag);
      }

      const url = `${this.baseURL}/order/multi/cancel${params.toString() ? '?' + params.toString() : ''}`;

      const response = await axios.delete(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

      const { status, data, summary, errors } = response.data;

      // Handle different status responses
      if (status === 'success' || status === 'partial_success') {
        const successCount = summary?.success || data?.order_ids?.length || 0;
        const errorCount = summary?.error || 0;

        if (status === 'partial_success' && errors?.length > 0) {

        }

        return {
          success: true,
          data: response.data
        };
      } else {
        // Status is 'error'
        console.error('❌ All cancellation requests failed:', JSON.stringify(errors, null, 2));
        throw new Error(`All cancellation requests failed: ${errors?.[0]?.message || 'Unknown error'}`);
      }

    } catch (error) {
      console.error('❌ Cancel Multi Order error:', error.response?.data || error.message);
      console.error('❌ Cancel Multi Order full error details:', JSON.stringify(error.response?.data, null, 2));
      console.error('❌ Cancel Multi Order status:', error.response?.status);
      console.error('❌ Cancel Multi Order headers:', JSON.stringify(error.response?.headers, null, 2));

      // Log specific error details from Upstox API
      if (error.response?.data?.errors) {
        console.error('❌ Upstox API errors:', JSON.stringify(error.response.data.errors, null, 2));
      }
      if (error.response?.data?.message) {
        console.error('❌ Upstox API message:', error.response.data.message);
      }

      return {
        success: false,
        error: 'cancel_orders_failed',
        message: error.response?.data?.message || 'Failed to cancel orders',
        details: error.response?.data,
        upstox_errors: error.response?.data?.errors
      };
    }
  }

  /**
   * Cancel orders by tag (useful for cancelling all orders for a specific analysis)
   */
  async cancelOrdersByTag(accessToken, tag) {
    return this.cancelMultipleOrders(accessToken, null, null, tag);
  }

  /**
   * Cancel bracket order - cancels all related orders (main, stop-loss, target)
   * using the correlation base from any order ID
   */
  async cancelBracketOrder(accessToken, correlationIdOrTag) {
    try {
      // Extract the base correlation ID (remove _M, _S, _T suffixes)
      const correlationBase = correlationIdOrTag.replace(/_(M|S|T)$/, '');
      const tag = correlationBase.startsWith('BRC_') ? correlationBase : correlationIdOrTag;

      // First, let's check what orders exist by getting order history

      try {
        const ordersResult = await this.getOrderHistory(accessToken);
        if (ordersResult.success && ordersResult.data && ordersResult.data.data) {
          const allOrders = ordersResult.data.data;

          // Filter orders by tag OR correlation_id pattern
          const matchingOrders = allOrders.filter((order) => {
            const matchesByTag = order.tag && order.tag === tag;
            const matchesByCorrelation = order.correlation_id && order.correlation_id.startsWith(correlationBase);
            return matchesByTag || matchesByCorrelation;
          });

          // Separate orders by status (using correct Upstox order statuses)
          const activeOrders = matchingOrders.filter((order) =>
          order.status === 'open' ||
          order.status === 'pending' ||
          order.status === 'trigger pending' ||
          order.status === 'put order req received' ||
          order.status === 'validation pending' ||
          order.status === 'modify validation pending' ||
          order.status === 'after market order req received' || // AMO orders
          order.status === 'modify after market order req received' // Modified AMO orders
          );
          const cancelledOrders = matchingOrders.filter((order) =>
          order.status === 'cancelled' ||
          order.status === 'rejected' ||
          order.status === 'cancelled after market order' // Cancelled AMO orders
          );
          const executedOrders = matchingOrders.filter((order) =>
          order.status === 'complete' ||
          order.status === 'executed'
          );

          // Log each order in detail
          matchingOrders.forEach((order) => {

          });

          if (activeOrders.length === 0) {
            if (matchingOrders.length === 0) {

            } else {

            }
            return {
              success: true,
              data: {
                message: `No active orders found with tag '${tag}' - ${cancelledOrders.length} cancelled, ${executedOrders.length} executed`,
                cancelled_count: 0,
                total_orders: matchingOrders.length,
                already_cancelled: cancelledOrders.length,
                already_executed: executedOrders.length,
                orders_detail: matchingOrders.map((order) => ({
                  order_id: order.order_id,
                  status: order.status,
                  tag: order.tag,
                  correlation_id: order.correlation_id
                }))
              }
            };
          }

        }
      } catch (orderCheckError) {
        console.error('⚠️ Failed to check existing orders:', orderCheckError.message);
        // Continue with cancellation attempt anyway
      }

      // Try tag-based cancellation first

      const tagResult = await this.cancelOrdersByTag(accessToken, tag);

      if (tagResult.success) {

        // Extract details from Upstox Multi Order Cancel API response
        const responseData = tagResult.data?.data || tagResult.data;
        const orderIds = responseData?.order_ids || [];
        const summary = responseData?.summary || {};
        const errors = responseData?.errors || [];

        if (errors.length > 0) {

        }

        return {
          success: true,
          data: {
            bracket_cancelled: true,
            correlation_base: correlationBase,
            cancelled_count: summary.success || orderIds.length,
            total_orders: summary.total || 0,
            cancelled_order_ids: orderIds,
            errors: errors,
            summary: summary,
            message: `${summary.success || orderIds.length} orders cancelled successfully for bracket ${correlationBase}`
          }
        };
      }

      // If tag-based cancellation fails, try individual order cancellation

      const ordersResult = await this.getOrderHistory(accessToken);
      if (!ordersResult.success) {
        throw new Error(`Failed to get order history: ${ordersResult.message}`);
      }

      const allOrders = ordersResult.data?.data || [];
      const matchingOrders = allOrders.filter((order) => {
        // Match by tag or by correlation_id pattern
        return order.tag && order.tag === tag ||
        order.correlation_id && order.correlation_id.startsWith(correlationBase);
      });

      if (matchingOrders.length === 0) {

        return {
          success: true,
          data: {
            message: `No orders found with tag '${tag}' - they might already be cancelled`,
            cancelled_count: 0
          }
        };
      }

      // Cancel each order individually
      const cancelResults = [];
      let successCount = 0;
      let failCount = 0;

      for (const order of matchingOrders) {
        if (order.status === 'cancelled' || order.status === 'rejected' || order.status === 'complete') {

          continue;
        }

        try {

          const cancelResult = await this.cancelIndividualOrder(accessToken, order.order_id);

          if (cancelResult.success) {
            successCount++;

          } else {
            failCount++;

          }

          cancelResults.push({
            order_id: order.order_id,
            success: cancelResult.success,
            message: cancelResult.message
          });
        } catch (err) {
          failCount++;

          cancelResults.push({
            order_id: order.order_id,
            success: false,
            message: err.message
          });
        }
      }

      return {
        success: successCount > 0,
        data: {
          bracket_cancelled: successCount > 0,
          correlation_base: correlationBase,
          cancelled_count: successCount,
          failed_count: failCount,
          results: cancelResults,
          message: `Cancelled ${successCount} orders individually (${failCount} failed)`
        }
      };

    } catch (error) {
      console.error('❌ Cancel bracket order error:', error.message);
      return {
        success: false,
        error: 'cancel_bracket_failed',
        message: `Failed to cancel bracket order: ${error.message}`,
        details: error
      };
    }
  }

  /**
   * Cancel an individual order by order ID
   */
  async cancelIndividualOrder(accessToken, orderId) {
    try {
      const response = await axios.delete(`${this.baseURL}/order/cancel`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        },
        params: {
          order_id: orderId
        }
      });

      return {
        success: true,
        data: response.data,
        message: `Order ${orderId} cancelled successfully`
      };

    } catch (error) {
      console.error(`❌ Cancel individual order ${orderId} error:`, error.response?.data || error.message);
      return {
        success: false,
        error: 'cancel_individual_order_failed',
        message: error.response?.data?.message || `Failed to cancel order ${orderId}`,
        details: error.response?.data
      };
    }
  }

  /**
   * Get order details for a specific order ID
   */
  async getOrderDetails(accessToken, orderId) {
    try {
      const response = await axios.get(`${this.baseURL}/order/details`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        },
        params: {
          order_id: orderId
        }
      });

      return {
        success: true,
        data: response.data
      };

    } catch (error) {
      console.error('❌ Get order details error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'get_order_details_failed',
        message: error.response?.data?.message || 'Failed to get order details',
        details: error.response?.data
      };
    }
  }

  /**
   * Get order history by tag (useful for checking all orders in a bracket)
   */
  async getOrderHistoryByTag(accessToken, tag) {
    try {
      const response = await axios.get(`${this.baseURL}/order/history`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        },
        params: {
          tag: tag
        }
      });

      return {
        success: true,
        data: response.data
      };

    } catch (error) {
      console.error('❌ Get order history error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'get_order_history_failed',
        message: error.response?.data?.message || 'Failed to get order history',
        details: error.response?.data
      };
    }
  }

  /**
   * Validate access token
   */
  async validateToken(accessToken) {
    try {
      const profileResult = await this.getUserProfile(accessToken);
      return profileResult.success;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get candle data for technical analysis
   */
  async getCandleData(instrumentToken, interval, accessToken, count = 100) {
    try {

      const response = await axios.get(
        `${this.baseURL}/historical-candle/${instrumentToken}/${interval}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          },
          params: {
            count: count
          }
        }
      );

      return {
        success: true,
        data: response.data?.data?.candles || []
      };

    } catch (error) {
      console.error(`❌ Get candle data error for ${interval}:`, error.response?.data || error.message);
      return {
        success: false,
        error: 'get_candle_data_failed',
        message: error.response?.data?.message || 'Failed to get candle data',
        details: error.response?.data,
        data: []
      };
    }
  }

  /**
   * Get market depth (order book) data
   */
  async getMarketDepth(instrumentToken, accessToken) {
    try {

      const response = await axios.get(
        `${this.baseURL}/market-quote/quotes`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          },
          params: {
            instrument_key: instrumentToken
          }
        }
      );

      return {
        success: true,
        data: response.data?.data?.[instrumentToken]
      };

    } catch (error) {
      console.error('❌ Get market depth error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'get_market_depth_failed',
        message: error.response?.data?.message || 'Failed to get market depth',
        details: error.response?.data,
        data: null
      };
    }
  }

  /**
   * Get live market data (LTP, volume, etc.)
   */
  async getLiveMarketData(instrumentTokens, accessToken) {
    try {

      const response = await axios.get(
        `${this.baseURL}/market-quote/ltp`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          },
          params: {
            instrument_key: instrumentTokens.join(',')
          }
        }
      );

      return {
        success: true,
        data: response.data?.data || {}
      };

    } catch (error) {
      console.error('❌ Get live market data error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'get_live_market_data_failed',
        message: error.response?.data?.message || 'Failed to get live market data',
        details: error.response?.data,
        data: {}
      };
    }
  }

  /**
   * Place GTT (Good Till Triggered) Order - V3 API
   * MULTI-LEG ONLY with Target + StopLoss + Optional Trailing Stop Loss
   *
   * @param {string} accessToken - Upstox access token
   * @param {Object} gttOrderData - GTT order parameters
   * @param {string} gttOrderData.instrumentToken - Instrument key (e.g., "NSE_EQ|INE001A01036")
   * @param {string} gttOrderData.transactionType - BUY or SELL
   * @param {number} gttOrderData.quantity - Order quantity
   * @param {string} gttOrderData.product - D (Delivery), I (Intraday), MTF (default: I for swing)
   * @param {number} gttOrderData.entryTriggerPrice - Price at which to trigger entry
   * @param {string} gttOrderData.entryTriggerType - ABOVE, BELOW, or IMMEDIATE
   * @param {number} gttOrderData.targetPrice - Target exit price (REQUIRED for multi-leg)
   * @param {number} gttOrderData.stopLossPrice - Stop loss price (REQUIRED for multi-leg)
   * @param {number} [gttOrderData.trailingGap] - Trailing stop loss gap (optional)
   * @returns {Object} - GTT order result with gtt_order_ids
   */
  async placeGTTOrder(accessToken, gttOrderData) {
    try {
      console.log('[GTT ORDER] ========== GTT ORDER REQUEST START ==========');
      console.log('[GTT ORDER] Raw input gttOrderData:', JSON.stringify(gttOrderData, null, 2));
      console.log('[GTT ORDER] Access token present:', !!accessToken);
      console.log('[GTT ORDER] Access token length:', accessToken?.length || 0);

      const {
        instrumentToken,
        transactionType,
        quantity,
        product = 'I', // Default to Intraday for swing trading
        entryTriggerPrice,
        entryTriggerType = 'ABOVE', // ABOVE, BELOW, IMMEDIATE
        targetPrice,
        stopLossPrice,
        trailingGap
      } = gttOrderData;

      console.log('[GTT ORDER] Extracted parameters:');
      console.log(`  - instrumentToken: ${instrumentToken} (type: ${typeof instrumentToken})`);
      console.log(`  - transactionType: ${transactionType} (type: ${typeof transactionType})`);
      console.log(`  - quantity: ${quantity} (type: ${typeof quantity})`);
      console.log(`  - product: ${product} (type: ${typeof product})`);
      console.log(`  - entryTriggerPrice: ${entryTriggerPrice} (type: ${typeof entryTriggerPrice})`);
      console.log(`  - entryTriggerType: ${entryTriggerType} (type: ${typeof entryTriggerType})`);
      console.log(`  - targetPrice: ${targetPrice} (type: ${typeof targetPrice})`);
      console.log(`  - stopLossPrice: ${stopLossPrice} (type: ${typeof stopLossPrice})`);
      console.log(`  - trailingGap: ${trailingGap} (type: ${typeof trailingGap})`);

      // Validate required fields
      if (!instrumentToken || !transactionType || !quantity || !entryTriggerPrice) {
        const missing = [];
        if (!instrumentToken) missing.push('instrumentToken');
        if (!transactionType) missing.push('transactionType');
        if (!quantity) missing.push('quantity');
        if (!entryTriggerPrice) missing.push('entryTriggerPrice');
        console.error(`[GTT ORDER] ❌ Missing required fields: ${missing.join(', ')}`);
        throw new Error(`Missing required GTT order parameters: ${missing.join(', ')}`);
      }

      // ENFORCE MULTI-LEG ONLY: Both target and stop loss are required
      if (!targetPrice || targetPrice <= 0) {
        throw new Error('targetPrice is required for multi-leg GTT order');
      }
      if (!stopLossPrice || stopLossPrice <= 0) {
        throw new Error('stopLossPrice is required for multi-leg GTT order');
      }

      // Validate price logic based on transaction type
      const txnType = transactionType.toUpperCase();
      if (txnType === 'BUY') {
        // For BUY: Target > Entry > StopLoss
        if (targetPrice <= entryTriggerPrice) {
          throw new Error(`Invalid prices for BUY: Target (${targetPrice}) must be greater than Entry (${entryTriggerPrice})`);
        }
        if (stopLossPrice >= entryTriggerPrice) {
          throw new Error(`Invalid prices for BUY: StopLoss (${stopLossPrice}) must be less than Entry (${entryTriggerPrice})`);
        }
      } else if (txnType === 'SELL') {
        // For SELL: StopLoss > Entry > Target
        if (targetPrice >= entryTriggerPrice) {
          throw new Error(`Invalid prices for SELL: Target (${targetPrice}) must be less than Entry (${entryTriggerPrice})`);
        }
        if (stopLossPrice <= entryTriggerPrice) {
          throw new Error(`Invalid prices for SELL: StopLoss (${stopLossPrice}) must be greater than Entry (${entryTriggerPrice})`);
        }
      } else {
        throw new Error(`Invalid transactionType: ${transactionType}. Must be BUY or SELL`);
      }

      // ========== TICK SIZE CORRECTION ==========
      // NSE requires prices to be in valid tick size multiples
      // Round prices to valid tick sizes before placing order
      console.log('[GTT ORDER] ========== TICK SIZE CORRECTION ==========');
      const correctedPrices = this.correctOrderPrices(
        entryTriggerPrice,
        stopLossPrice,
        targetPrice,
        txnType
      );

      const correctedEntry = correctedPrices.entry;
      const correctedTarget = correctedPrices.target;
      const correctedStopLoss = correctedPrices.stopLoss;

      // Re-validate after correction (prices might have shifted)
      if (txnType === 'BUY') {
        if (correctedTarget <= correctedEntry) {
          console.log(`[GTT ORDER] ⚠️ After tick correction, adjusting target from ₹${correctedTarget} to ₹${correctedEntry + 0.05}`);
          correctedPrices.target = correctedEntry + 0.05;
        }
        if (correctedStopLoss >= correctedEntry) {
          console.log(`[GTT ORDER] ⚠️ After tick correction, adjusting stopLoss from ₹${correctedStopLoss} to ₹${correctedEntry - 0.05}`);
          correctedPrices.stopLoss = correctedEntry - 0.05;
        }
      }

      // Build rules array for multi-leg order
      const rules = [];

      // Entry rule (mandatory)
      rules.push({
        strategy: 'ENTRY',
        trigger_type: entryTriggerType,
        trigger_price: correctedPrices.entry
      });

      // Target rule (mandatory for multi-leg)
      rules.push({
        strategy: 'TARGET',
        trigger_type: 'IMMEDIATE',
        trigger_price: correctedPrices.target
      });

      // Stop Loss rule with optional trailing (mandatory for multi-leg)
      const slRule = {
        strategy: 'STOPLOSS',
        trigger_type: 'IMMEDIATE',
        trigger_price: correctedPrices.stopLoss
      };

      // Add trailing gap for TSL orders
      if (trailingGap && trailingGap > 0) {
        slRule.trailing_gap = parseFloat(trailingGap);
        console.log(`[GTT ORDER] Trailing Stop Loss enabled with gap: ₹${trailingGap}`);
      }

      rules.push(slRule);

      // Build GTT order payload - always MULTIPLE for multi-leg
      const gttPayload = {
        type: 'MULTIPLE',
        quantity: parseInt(quantity),
        product: product,
        instrument_token: instrumentToken,
        transaction_type: txnType,
        rules: rules
      };

      console.log('[GTT ORDER] ========== PAYLOAD CONSTRUCTION ==========');
      console.log('[GTT ORDER] Final payload to send:', JSON.stringify(gttPayload, null, 2));
      console.log(`[GTT ORDER] Summary (with tick size correction):
        Instrument: ${instrumentToken}
        Type: ${txnType}
        Quantity: ${quantity} -> parsed: ${parseInt(quantity)}
        Entry: ₹${entryTriggerPrice} -> CORRECTED: ₹${correctedPrices.entry} (${entryTriggerType})
        Target: ₹${targetPrice} -> CORRECTED: ₹${correctedPrices.target}
        StopLoss: ₹${stopLossPrice} -> CORRECTED: ₹${correctedPrices.stopLoss}${trailingGap ? ` (Trailing: ₹${trailingGap})` : ''}
        Product: ${product}`);

      // Use V3 API for GTT orders
      const apiUrl = 'https://api.upstox.com/v3/order/gtt/place';
      console.log('[GTT ORDER] ========== API CALL ==========');
      console.log(`[GTT ORDER] Making POST request to: ${apiUrl}`);
      console.log('[GTT ORDER] Request headers:', {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken?.substring(0, 20)}...`
      });

      const response = await axios.post(
        apiUrl,
        gttPayload,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          }
        }
      );

      console.log('[GTT ORDER] ========== API RESPONSE ==========');
      console.log('[GTT ORDER] Response status code:', response.status);
      console.log('[GTT ORDER] Response headers:', JSON.stringify(response.headers, null, 2));
      console.log('[GTT ORDER] Response data:', JSON.stringify(response.data, null, 2));

      const { status, data, metadata } = response.data;
      console.log(`[GTT ORDER] Parsed response - status: ${status}, data:`, data, ', metadata:', metadata);

      if (status === 'success') {
        const result = {
          success: true,
          data: {
            gtt_order_ids: data.gtt_order_ids,
            order_id: data.gtt_order_ids?.[0], // Primary GTT order ID
            type: 'MULTIPLE',
            has_trailing_sl: trailingGap && trailingGap > 0,
            latency: metadata?.latency
          },
          gttOrderIds: data.gtt_order_ids, // Also add at top level for compatibility
          message: `GTT multi-leg order placed successfully${trailingGap ? ' with trailing stop loss' : ''}`
        };
        console.log('[GTT ORDER] ✅ SUCCESS! Returning:', JSON.stringify(result, null, 2));
        console.log('[GTT ORDER] ========== GTT ORDER REQUEST END ==========');
        return result;
      } else {
        console.error(`[GTT ORDER] ❌ Unexpected status: ${status}`);
        throw new Error(`GTT order failed with status: ${status}`);
      }

    } catch (error) {
      console.log('[GTT ORDER] ========== ERROR HANDLING ==========');
      console.error('[GTT ORDER] ❌ Error caught:', error.message);
      console.error('[GTT ORDER] ❌ Error name:', error.name);
      console.error('[GTT ORDER] ❌ Error stack:', error.stack);

      if (error.response) {
        console.error('[GTT ORDER] ❌ HTTP Status:', error.response.status);
        console.error('[GTT ORDER] ❌ HTTP Status Text:', error.response.statusText);
        console.error('[GTT ORDER] ❌ Response headers:', JSON.stringify(error.response.headers, null, 2));
        console.error('[GTT ORDER] ❌ Response data:', JSON.stringify(error.response.data, null, 2));
      }

      const errorData = error.response?.data;
      if (errorData?.errors) {
        console.error('[GTT ORDER] ❌ Upstox errors array:', JSON.stringify(errorData.errors, null, 2));
      }

      const result = {
        success: false,
        error: 'gtt_order_failed',
        message: errorData?.errors?.[0]?.message || errorData?.message || error.message || 'Failed to place GTT order',
        details: errorData
      };
      console.error('[GTT ORDER] ❌ Returning error result:', JSON.stringify(result, null, 2));
      console.log('[GTT ORDER] ========== GTT ORDER REQUEST END ==========');
      return result;
    }
  }

  /**
   * Place GTT Order from AI Strategy
   * Converts AI analysis strategy to GTT multi-leg order format
   * REQUIRES: entry, target, and stopLoss for multi-leg order
   *
   * @param {string} accessToken - Upstox access token
   * @param {Object} strategy - AI strategy object with entry, target, stopLoss
   * @param {string} instrumentToken - Instrument key
   * @param {number} currentPrice - Current market price (for trigger direction)
   * @returns {Object} - GTT order result
   */
  async placeGTTOrderFromStrategy(accessToken, strategy, instrumentToken, currentPrice = null) {
    try {
      const {
        type: strategyType, // BUY, SELL
        entry,
        stopLoss,
        target,
        positionType = 'INTRADAY', // Default to INTRADAY for swing trading
        trailingStopLoss // Optional trailing gap
      } = strategy;

      // Validate required strategy fields for multi-leg
      if (!entry || !strategyType) {
        throw new Error('Strategy must have entry price and type (BUY/SELL)');
      }

      // ENFORCE MULTI-LEG: Both target and stopLoss required
      if (!target || target <= 0) {
        throw new Error('Strategy must have target price for multi-leg GTT order');
      }
      if (!stopLoss || stopLoss <= 0) {
        throw new Error('Strategy must have stopLoss price for multi-leg GTT order');
      }

      // Determine trigger type based on entry vs current price
      let entryTriggerType = 'ABOVE';
      if (currentPrice) {
        // For BUY: ABOVE if entry > current, BELOW if entry < current
        // For SELL: Opposite logic
        if (strategyType.toUpperCase() === 'BUY') {
          entryTriggerType = entry > currentPrice ? 'ABOVE' : 'BELOW';
        } else {
          entryTriggerType = entry < currentPrice ? 'BELOW' : 'ABOVE';
        }
      }

      // Map position type to Upstox product (default to I for swing)
      const product = positionType === 'DELIVERY' ? 'D' : 'I';

      // Calculate quantity based on strategy (default to 1 if not specified)
      const quantity = strategy.quantity || strategy.suggested_qty || 1;

      // Build GTT order data
      const gttOrderData = {
        instrumentToken,
        transactionType: strategyType.toUpperCase(),
        quantity,
        product,
        entryTriggerPrice: entry,
        entryTriggerType,
        targetPrice: target,
        stopLossPrice: stopLoss,
        trailingGap: trailingStopLoss || null
      };

      console.log(`[GTT ORDER] Converting strategy to multi-leg GTT order:
        Strategy Type: ${strategyType}
        Entry: ₹${entry} (${entryTriggerType})
        Target: ₹${target}
        Stop Loss: ₹${stopLoss}${trailingStopLoss ? ` (Trailing: ₹${trailingStopLoss})` : ''}
        Product: ${product}
        Quantity: ${quantity}`);

      return await this.placeGTTOrder(accessToken, gttOrderData);

    } catch (error) {
      console.error('[GTT ORDER] ❌ Strategy to GTT conversion error:', error.message);
      return {
        success: false,
        error: 'strategy_to_gtt_failed',
        message: error.message
      };
    }
  }

  /**
   * Get GTT Order Details
   */
  async getGTTOrderDetails(accessToken, gttOrderId) {
    try {
      const response = await axios.get(
        `https://api.upstox.com/v3/order/gtt/${gttOrderId}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      return {
        success: true,
        data: response.data?.data
      };

    } catch (error) {
      console.error('[GTT ORDER] ❌ Get GTT order details error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'get_gtt_order_failed',
        message: error.response?.data?.message || 'Failed to get GTT order details'
      };
    }
  }

  /**
   * Cancel GTT Order
   */
  async cancelGTTOrder(accessToken, gttOrderId) {
    try {
      const response = await axios.delete(
        `https://api.upstox.com/v3/order/gtt/${gttOrderId}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      return {
        success: true,
        data: response.data
      };

    } catch (error) {
      console.error('[GTT ORDER] ❌ Cancel GTT order error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'cancel_gtt_order_failed',
        message: error.response?.data?.message || 'Failed to cancel GTT order'
      };
    }
  }

  /**
   * Get all GTT Orders
   */
  async getAllGTTOrders(accessToken) {
    try {
      const response = await axios.get(
        'https://api.upstox.com/v3/order/gtt',
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      return {
        success: true,
        data: response.data?.data || []
      };

    } catch (error) {
      console.error('[GTT ORDER] ❌ Get all GTT orders error:', error.response?.data || error.message);
      return {
        success: false,
        error: 'get_all_gtt_orders_failed',
        message: error.response?.data?.message || 'Failed to get GTT orders'
      };
    }
  }

}

export default new UpstoxService();