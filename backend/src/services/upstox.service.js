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

            const orderPayload = {
                instrument_token: instrumentToken,
                quantity: parseInt(quantity),
                product,
                validity,
                price: orderType === 'MARKET' ? 0 : parseFloat(price || 0),
                tag: orderData.tag || `ORDER_${Date.now()}`,
                order_type: orderType,
                transaction_type: transactionType.toUpperCase(),
                disclosed_quantity: parseInt(disclosedQuantity),
                trigger_price: parseFloat(triggerPrice || 0),
                is_amo: Boolean(isAmo)
            };

            console.log(`📋 Placing Upstox order:`, orderPayload);

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

            console.log('✅ Upstox order placed successfully:', response.data);

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
     * Get order book - all orders for current day
     */
    async getOrderHistory(accessToken) {
        try {
            console.log(`📋 Fetching order book from Upstox...`);
            const response = await axios.get(`${this.baseURL}/order/retrieve-all`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json'
                }
            });

            console.log(`📋 Order book response status: ${response.status}`);
            console.log(`📋 Raw order book data:`, JSON.stringify(response.data, null, 2));
            
            // The response is directly an array of orders, not wrapped in a data object
            const orders = Array.isArray(response.data) ? response.data : (response.data?.data || []);
            
            console.log(`📋 Found ${orders.length} total orders in order book`);
            
            // Log summary of all orders
            const statusCounts = {};
            orders.forEach(order => {
                const status = order.status || 'unknown';
                statusCounts[status] = (statusCounts[status] || 0) + 1;
                console.log(`📋 Order ${order.order_id}: ${order.trading_symbol}, status='${status}', tag='${order.tag}', price=${order.price}, qty=${order.quantity}`);
            });
            
            console.log(`📋 Order status summary:`, statusCounts);

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
                const marketData = response.data.data.find(market => market.exchange === exchange);
                
                if (marketData) {
                    const now = Date.now();
                    const isOpen = now >= marketData.start_time && now <= marketData.end_time;
                    
                    console.log(`🕒 Market check for ${exchange} - Open: ${isOpen}`);
                    console.log(`🕒 Current: ${now}, Start: ${marketData.start_time}, End: ${marketData.end_time}`);
                    
                    return isOpen;
                }
            }
            
            // Fallback: assume market is closed if API fails
            console.log('⚠️ Market timings API failed, assuming market is closed');
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
        
        console.log(`📋 Order config - Market Open: ${isMarketCurrentlyOpen}, AMO: ${isAmo}`);

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
            target: target      // From AI strategy
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
            
            console.log(`📋 Cancelling orders - URL: ${url}, OrderIds: ${orderIds?.join(', ') || 'ALL'}`);

            const response = await axios.delete(url, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json'
                }
            });

            console.log('✅ Cancel Multi Order response:', JSON.stringify(response.data, null, 2));
            
            const { status, data, summary, errors } = response.data;
            
            // Handle different status responses
            if (status === 'success' || status === 'partial_success') {
                const successCount = summary?.success || data?.order_ids?.length || 0;
                const errorCount = summary?.error || 0;
                
                console.log(`✅ Cancellation completed - Status: ${status}, Success: ${successCount}, Errors: ${errorCount}`);
                
                if (status === 'partial_success' && errors?.length > 0) {
                    console.log('⚠️ Some orders failed to cancel:', JSON.stringify(errors, null, 2));
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
            
            console.log(`📋 Cancelling bracket order with tag: ${tag}`);
            
            // First, let's check what orders exist by getting order history
            console.log(`📋 Checking existing orders before cancellation...`);
            try {
                const ordersResult = await this.getOrderHistory(accessToken);
                if (ordersResult.success && ordersResult.data && ordersResult.data.data) {
                    const allOrders = ordersResult.data.data;
                    
                    // Filter orders by tag OR correlation_id pattern
                    const matchingOrders = allOrders.filter(order => {
                        const matchesByTag = order.tag && order.tag === tag;
                        const matchesByCorrelation = order.correlation_id && order.correlation_id.startsWith(correlationBase);
                        return matchesByTag || matchesByCorrelation;
                    });
                    
                    console.log(`📋 Found ${matchingOrders.length} total orders matching tag '${tag}' or correlation '${correlationBase}'`);
                    
                    // Separate orders by status (using correct Upstox order statuses)
                    const activeOrders = matchingOrders.filter(order => 
                        order.status === 'open' || 
                        order.status === 'pending' || 
                        order.status === 'trigger pending' ||
                        order.status === 'put order req received' ||
                        order.status === 'validation pending' ||
                        order.status === 'modify validation pending' ||
                        order.status === 'after market order req received' || // AMO orders
                        order.status === 'modify after market order req received' // Modified AMO orders
                    );
                    const cancelledOrders = matchingOrders.filter(order => 
                        order.status === 'cancelled' || 
                        order.status === 'rejected' ||
                        order.status === 'cancelled after market order' // Cancelled AMO orders
                    );
                    const executedOrders = matchingOrders.filter(order => 
                        order.status === 'complete' || 
                        order.status === 'executed'
                    );
                    
                    console.log(`📋 Order status breakdown:`);
                    console.log(`📋   Active orders: ${activeOrders.length}`);
                    console.log(`📋   Cancelled orders: ${cancelledOrders.length}`);
                    console.log(`📋   Executed orders: ${executedOrders.length}`);
                    
                    // Log each order in detail
                    matchingOrders.forEach(order => {
                        console.log(`📋 Order ${order.order_id}: status='${order.status}', tag='${order.tag}', correlation='${order.correlation_id}'`);
                    });
                    
                    if (activeOrders.length === 0) {
                        if (matchingOrders.length === 0) {
                            console.log(`⚠️ No orders found with tag '${tag}' or correlation '${correlationBase}' - they might never have been placed`);
                        } else {
                            console.log(`⚠️ No active orders found - all ${matchingOrders.length} orders are already cancelled or executed`);
                        }
                        return {
                            success: true,
                            data: {
                                message: `No active orders found with tag '${tag}' - ${cancelledOrders.length} cancelled, ${executedOrders.length} executed`,
                                cancelled_count: 0,
                                total_orders: matchingOrders.length,
                                already_cancelled: cancelledOrders.length,
                                already_executed: executedOrders.length,
                                orders_detail: matchingOrders.map(order => ({
                                    order_id: order.order_id,
                                    status: order.status,
                                    tag: order.tag,
                                    correlation_id: order.correlation_id
                                }))
                            }
                        };
                    }
                    
                    console.log(`📋 Found ${activeOrders.length} active orders that can be cancelled`);
                }
            } catch (orderCheckError) {
                console.error('⚠️ Failed to check existing orders:', orderCheckError.message);
                // Continue with cancellation attempt anyway
            }
            
            // Try tag-based cancellation first
            console.log(`📋 Attempting tag-based cancellation for tag: ${tag}...`);
            const tagResult = await this.cancelOrdersByTag(accessToken, tag);
            
            console.log(`📋 Tag cancellation result:`, JSON.stringify(tagResult, null, 2));
            
            if (tagResult.success) {
                console.log(`✅ Tag-based cancellation successful!`);
                
                // Extract details from Upstox Multi Order Cancel API response
                const responseData = tagResult.data?.data || tagResult.data;
                const orderIds = responseData?.order_ids || [];
                const summary = responseData?.summary || {};
                const errors = responseData?.errors || [];
                
                console.log(`📋 Cancellation summary: Total=${summary.total || 0}, Success=${summary.success || 0}, Errors=${summary.error || 0}`);
                console.log(`📋 Cancelled order IDs: ${orderIds.join(', ')}`);
                
                if (errors.length > 0) {
                    console.log(`⚠️ Some cancellation errors occurred:`, JSON.stringify(errors, null, 2));
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
            console.log(`⚠️ Tag-based cancellation failed, trying individual order cancellation...`);
            console.log(`📋 Getting order history to find individual orders...`);
            
            const ordersResult = await this.getOrderHistory(accessToken);
            if (!ordersResult.success) {
                throw new Error(`Failed to get order history: ${ordersResult.message}`);
            }
            
            const allOrders = ordersResult.data?.data || [];
            const matchingOrders = allOrders.filter(order => {
                // Match by tag or by correlation_id pattern
                return (order.tag && order.tag === tag) || 
                       (order.correlation_id && order.correlation_id.startsWith(correlationBase));
            });
            
            console.log(`📋 Found ${matchingOrders.length} orders to cancel individually`);
            
            if (matchingOrders.length === 0) {
                console.log(`⚠️ No orders found to cancel`);
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
                    console.log(`📋 Skipping order ${order.order_id} - already ${order.status}`);
                    continue;
                }
                
                try {
                    console.log(`📋 Cancelling individual order: ${order.order_id}`);
                    const cancelResult = await this.cancelIndividualOrder(accessToken, order.order_id);
                    
                    if (cancelResult.success) {
                        successCount++;
                        console.log(`✅ Successfully cancelled order ${order.order_id}`);
                    } else {
                        failCount++;
                        console.log(`❌ Failed to cancel order ${order.order_id}: ${cancelResult.message}`);
                    }
                    
                    cancelResults.push({
                        order_id: order.order_id,
                        success: cancelResult.success,
                        message: cancelResult.message
                    });
                } catch (err) {
                    failCount++;
                    console.log(`❌ Error cancelling order ${order.order_id}: ${err.message}`);
                    cancelResults.push({
                        order_id: order.order_id,
                        success: false,
                        message: err.message
                    });
                }
            }
            
            console.log(`📋 Individual cancellation results: ${successCount} success, ${failCount} failed`);
            
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
            console.log(`📊 Fetching ${interval} candles for ${instrumentToken}`);
            
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
            console.log(`📊 Fetching market depth for ${instrumentToken}`);
            
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
            console.log(`📊 Fetching live market data for ${instrumentTokens.length} instruments`);
            
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

}

export default new UpstoxService();