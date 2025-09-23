import express from 'express';
import upstoxService from '../services/upstox.service.js';
import UpstoxUser from '../models/upstoxUser.js';
import { auth as authenticateToken } from '../middleware/auth.js';
import crypto from 'crypto';
import conditionValidator from '../services/conditionValidator.service.js';

const router = express.Router();

// Encryption helpers for token storage
const ENCRYPTION_KEY = process.env.UPSTOX_ENCRYPTION_KEY ? 
    crypto.createHash('sha256').update(process.env.UPSTOX_ENCRYPTION_KEY).digest() : 
    crypto.randomBytes(32);
const IV_LENGTH = 16;

function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = textParts.join(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

/**
 * @route POST /api/upstox/auth/initiate
 * @desc Initiate Upstox authentication
 * @access Private
 */
router.post('/auth/initiate', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        console.log(`🔐 Initiating Upstox auth for user: ${userId}`);

        // Generate auth URL with random state
        const authData = upstoxService.generateAuthUrl();

        // Store auth state in database for validation
        const existingUpstoxUser = await UpstoxUser.findByUserId(userId);
        if (existingUpstoxUser) {
            existingUpstoxUser.auth_state = authData.state;
            existingUpstoxUser.connection_status = 'pending';
            await existingUpstoxUser.save();
        } else {
            await UpstoxUser.create({
                user_id: userId,
                // upstox_user_id, email, user_name will be filled after successful auth
                auth_state: authData.state,
                connection_status: 'pending'
            });
        }

        res.json({
            success: true,
            data: {
                auth_url: authData.url,
                state: authData.state
            },
            message: 'Authorization URL generated successfully'
        });

    } catch (error) {
        console.error('❌ Upstox auth initiation error:', error);
        res.status(500).json({
            success: false,
            error: 'auth_initiation_failed',
            message: 'Failed to initiate Upstox authentication'
        });
    }
});

/**
 * @route GET /api/upstox/callback
 * @desc Handle Upstox OAuth callback (redirect endpoint)
 * @access Public
 */
router.get('/callback', async (req, res) => {
    try {
        const { code, state, error } = req.query;

        console.log(`🔄 Upstox callback received: code=${!!code}, state=${state}, error=${error}`);

        if (error) {
            console.error('❌ Upstox auth error:', error);
            return res.redirect(`logdhan://upstox-auth-error?error=${encodeURIComponent(error)}`);
        }

        if (!code || !state) {
            console.error('❌ Missing code or state in callback');
            return res.redirect('logdhan://upstox-auth-error?error=missing_parameters');
        }

        // Find user by auth state
        const upstoxUser = await UpstoxUser.findOne({ 
            auth_state: state,
            connection_status: 'pending'
        });

        if (!upstoxUser) {
            console.error('❌ Invalid auth state or expired request');
            return res.redirect('logdhan://upstox-auth-error?error=invalid_state');
        }

        // Exchange code for token
        const tokenResult = await upstoxService.getAccessToken(code, state);

        if (!tokenResult.success) {
            console.error('❌ Token exchange failed:', tokenResult.message);
            return res.redirect(`logdhan://upstox-auth-error?error=${encodeURIComponent(tokenResult.message)}`);
        }

        const tokenData = tokenResult.data;

        // Calculate token expiry (3:30 AM next day)
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(3, 30, 0, 0); // 3:30 AM

        // Update user with token data
        upstoxUser.upstox_user_id = tokenData.user_id;
        upstoxUser.email = tokenData.email;
        upstoxUser.user_name = tokenData.user_name;
        upstoxUser.broker = tokenData.broker;
        upstoxUser.exchanges = tokenData.exchanges;
        upstoxUser.products = tokenData.products;
        upstoxUser.order_types = tokenData.order_types;
        upstoxUser.user_type = tokenData.user_type;
        upstoxUser.poa = tokenData.poa;
        upstoxUser.is_active = tokenData.is_active;
        upstoxUser.access_token = encrypt(tokenData.access_token);
        upstoxUser.extended_token = tokenData.extended_token ? encrypt(tokenData.extended_token) : null;
        upstoxUser.token_expires_at = tomorrow;
        upstoxUser.connection_status = 'connected';
        upstoxUser.connected_at = new Date();
        upstoxUser.auth_state = null; // Clear auth state

        await upstoxUser.save();

        console.log(`✅ Upstox connection successful for user: ${upstoxUser.user_id}`);

        // Redirect to mobile app with success
        res.redirect('logdhan://upstox-auth-success');

    } catch (error) {
        console.error('❌ Upstox callback error:', error);
        res.redirect(`logdhan://upstox-auth-error?error=${encodeURIComponent(error.message)}`);
    }
});

/**
 * @route GET /api/upstox/status
 * @desc Get Upstox connection status
 * @access Private
 */
router.get('/status', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const upstoxUser = await UpstoxUser.findByUserId(userId);

        if (!upstoxUser) {
            return res.json({
                success: true,
                data: {
                    connected: false,
                    connection_status: 'not_connected'
                }
            });
        }

        const isTokenValid = upstoxUser.isTokenValid();

        res.json({
            success: true,
            data: {
                connected: isTokenValid,
                connection_status: upstoxUser.connection_status,
                upstox_user_id: upstoxUser.upstox_user_id,
                user_name: upstoxUser.user_name,
                broker: upstoxUser.broker,
                exchanges: upstoxUser.exchanges,
                products: upstoxUser.products,
                order_types: upstoxUser.order_types,
                connected_at: upstoxUser.connected_at,
                token_expires_at: upstoxUser.token_expires_at,
                total_orders: upstoxUser.total_orders,
                successful_orders: upstoxUser.successful_orders,
                failed_orders: upstoxUser.failed_orders
            }
        });

    } catch (error) {
        console.error('❌ Upstox status error:', error);
        res.status(500).json({
            success: false,
            error: 'status_fetch_failed',
            message: 'Failed to fetch Upstox status'
        });
    }
});

/**
 * @route POST /api/upstox/place-order
 * @desc Place order on Upstox based on AI strategy
 * @access Private
 */
router.post('/place-order', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            strategy,
            instrumentToken,
            analysisType = 'swing',
            customQuantity = null,
            useBracketOrder = true // Enable bracket orders by default
        } = req.body;

        console.log(`📋 Order placement request for user ${userId}:`, {
            strategyId: strategy?.id,
            instrumentToken,
            analysisType,
            useBracketOrder
        });

        // Import StockAnalysis model
        const StockAnalysis = (await import('../models/stockAnalysis.js')).default;

        // Find the existing analysis for this user and stock
        const existingAnalysis = await StockAnalysis.findByInstrumentAndUser(
            instrumentToken,
            analysisType,
            userId
        );

        if (!existingAnalysis) {
            return res.status(404).json({
                success: false,
                error: 'analysis_not_found',
                message: 'No analysis found for this stock. Please run analysis first.'
            });
        }

        // Check if orders have already been placed for this analysis
        const hasActive = existingAnalysis.hasActiveOrders();
        console.log(`📋 Checking if can place order - hasActiveOrders: ${hasActive}`);
        if (existingAnalysis.placed_orders && existingAnalysis.placed_orders.length > 0) {
            console.log(`📋 Existing orders: ${existingAnalysis.placed_orders.map(o => `${o.tag}:${o.status}`).join(', ')}`);
        }
        
        if (hasActive) {
            const activeOrderIds = existingAnalysis.getPlacedOrderIds();
            return res.status(409).json({
                success: false,
                error: 'orders_already_placed',
                message: `Orders already placed for this analysis. Active orders: ${activeOrderIds.join(', ')}`,
                data: {
                    existing_orders: existingAnalysis.placed_orders,
                    analysis_id: existingAnalysis._id
                }
            });
        }

        // NEW: Real-time condition validation
        console.log(`🔍 Starting real-time condition validation for ${instrumentToken}`);
        
        // Use the existing decrypt function from this file
        const accessToken = decrypt(upstoxUser.access_token);
        
        // Validate conditions using real-time market data
        const realtimeValidation = await conditionValidator.validateConditionsRealTime(
            existingAnalysis,
            accessToken
        );
        
        console.log(`📊 Real-time validation result:`, {
            valid: realtimeValidation.valid,
            reason: realtimeValidation.reason,
            current_price: realtimeValidation.realtime_data?.current_price
        });
        
        if (!realtimeValidation.valid && !realtimeValidation.error) {
            return res.status(400).json({
                success: false,
                error: 'entry_conditions_not_met_realtime',
                message: realtimeValidation.reason,
                data: {
                    validation_details: realtimeValidation,
                    analysis_id: existingAnalysis._id,
                    current_market_data: realtimeValidation.realtime_data,
                    failed_triggers: realtimeValidation.triggers?.filter(t => !t.passed) || [],
                    suggestion: realtimeValidation.order_gate?.actionability_status === 'actionable_on_trigger' 
                        ? 'Use conditional orders (stop/stop-limit) to execute when conditions are met'
                        : 'Wait for market conditions to improve or use different strategy'
                }
            });
        }
        
        // Additional check for market orders - must be actionable now with real-time data
        if (strategy.entryType === 'market' && realtimeValidation.order_gate?.actionability_status !== 'actionable_now') {
            return res.status(400).json({
                success: false,
                error: 'market_order_not_suitable_realtime',
                message: 'Market orders can only be placed when real-time conditions are actionable now. Use limit/stop orders instead.',
                data: {
                    current_status: realtimeValidation.order_gate?.actionability_status,
                    current_price: realtimeValidation.realtime_data?.current_price,
                    suggested_entry_type: 'limit',
                    failed_triggers: realtimeValidation.triggers?.filter(t => !t.passed) || []
                }
            });
        }
        
        // Log successful validation
        if (realtimeValidation.valid) {
            console.log(`✅ All real-time conditions validated for order placement`);
        } else if (realtimeValidation.error) {
            console.warn(`⚠️ Real-time validation failed with error, proceeding with stored analysis data`);
        }

        // Validate request
        if (!strategy || !instrumentToken) {
            return res.status(400).json({
                success: false,
                error: 'invalid_request',
                message: 'Strategy and instrumentToken are required'
            });
        }

        // Get Upstox user data
        const upstoxUser = await UpstoxUser.findByUserId(userId);

        if (!upstoxUser || !upstoxUser.isTokenValid()) {
            return res.status(401).json({
                success: false,
                error: 'upstox_not_connected',
                message: 'Upstox account not connected or token expired'
            });
        }

        // accessToken already decrypted earlier for real-time validation

        // Convert AI strategy to Upstox order
        const orderData = await upstoxService.convertAIStrategyToOrder(
            strategy,
            instrumentToken,
            analysisType,
            accessToken
        );

        // Override quantity if custom quantity provided
        if (customQuantity) {
            orderData.quantity = Math.max(1, parseInt(customQuantity));
        }

        // NEW: For limit orders with bracket orders, place only the primary order first
        // SL and target will be placed via webhook when the limit order executes
        if (useBracketOrder && orderData.orderType === 'LIMIT' && orderData.stopLoss && orderData.target) {
            console.log('📋 Placing LIMIT order with deferred bracket orders (via webhook)');
            
            // Place only the primary limit order
            const primaryOrderData = {
                ...orderData,
                tag: `BRC_${Date.now()}` // Tag to identify this needs bracket orders
            };
            
            console.log('📋 Placing primary limit order:', primaryOrderData);
            const orderResult = await upstoxService.placeOrder(accessToken, primaryOrderData);
            
            if (orderResult.success) {
                const orderId = orderResult.data?.data?.order_id || orderResult.data?.order_id;
                
                // Register this order for webhook processing
                if (orderId) {
                    try {
                        const webhookRegistration = await fetch(`http://localhost:${process.env.PORT || 3000}/api/webhook/register-pending-bracket`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                orderId,
                                userId,
                                accessToken,
                                stopLoss: orderData.stopLoss,
                                target: orderData.target,
                                instrumentToken,
                                analysisType
                            })
                        });
                        
                        if (webhookRegistration.ok) {
                            console.log('✅ Registered pending bracket orders for webhook processing');
                        }
                    } catch (webhookError) {
                        console.error('⚠️ Failed to register webhook data:', webhookError);
                    }
                }
                
                // Track the primary order
                await existingAnalysis.addPlacedOrders({
                    ...orderResult.data,
                    strategy_id: strategy.id,
                    quantity: orderData.quantity,
                    price: orderData.price,
                    transaction_type: orderData.transactionType,
                    product: orderData.product,
                    tag: primaryOrderData.tag,
                    stopLoss: orderData.stopLoss,
                    target: orderData.target,
                    pending_bracket: true // Flag indicating bracket orders are pending
                });
                
                // Update order statistics
                await upstoxUser.updateOrderStats(true);
                
                res.json({
                    success: true,
                    data: orderResult.data.data || orderResult.data,
                    message: 'Limit order placed. Stop-loss and target orders will be placed automatically after execution.',
                    pending_bracket: true
                });
            } else {
                await upstoxUser.updateOrderStats(false);
                res.status(400).json(orderResult);
            }
            
        } else {
            // For MARKET orders or when bracket orders are disabled, use the existing logic
            console.log(`📋 Placing ${useBracketOrder ? 'bracket' : 'single'} order:`, orderData);
            
            let orderResult;
            if (useBracketOrder) {
                console.log('📋 Using bracket method for MARKET order or immediate execution');
                orderResult = await upstoxService.placeMultiOrderBracket(accessToken, orderData);
            } else {
                console.log('📋 Using single order method (useBracketOrder=false)');
                orderResult = await upstoxService.placeOrder(accessToken, orderData);
            }
            
            console.log('📋 Received orderResult:', orderResult);

            // Update order statistics
            await upstoxUser.updateOrderStats(orderResult.success);

            if (orderResult.success) {
                console.log('🔍 Raw Upstox orderResult:', JSON.stringify(orderResult, null, 2));
                
                // Track orders in the analysis
                try {
                    await existingAnalysis.addPlacedOrders({
                        ...orderResult.data,
                        strategy_id: strategy.id,
                        quantity: orderData.quantity,
                        price: orderData.price,
                        transaction_type: orderData.transactionType,
                        product: orderData.product,
                        tag: orderData.tag,
                        stopLoss: orderData.stopLoss,
                        target: orderData.target
                    });
                    console.log('✅ Order tracking updated in analysis');
                } catch (trackingError) {
                    console.error('⚠️ Failed to update order tracking:', trackingError);
                }
                
                const flattenedResponse = {
                    success: true,
                    data: orderResult.data.data || orderResult.data,
                    message: orderResult.data.message || 'Order placed successfully on Upstox'
                };
                
                res.json(flattenedResponse);
            } else {
                console.log('❌ Raw Upstox orderResult (failed):', JSON.stringify(orderResult, null, 2));
                res.status(400).json(orderResult);
            }
        }

    } catch (error) {
        console.error('❌ Order placement error:', error);
        
        // Try to update failed order stats
        try {
            const upstoxUser = await UpstoxUser.findByUserId(req.user.id);
            if (upstoxUser) {
                await upstoxUser.updateOrderStats(false);
            }
        } catch (statsError) {
            console.error('❌ Failed to update order stats:', statsError);
        }

        res.status(500).json({
            success: false,
            error: 'order_placement_failed',
            message: 'Failed to place order'
        });
    }
});

/**
 * @route GET /api/upstox/orders
 * @desc Get order history from Upstox
 * @access Private
 */
router.get('/orders', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const upstoxUser = await UpstoxUser.findByUserId(userId);

        if (!upstoxUser || !upstoxUser.isTokenValid()) {
            return res.status(401).json({
                success: false,
                error: 'upstox_not_connected',
                message: 'Upstox account not connected or token expired'
            });
        }

        const accessToken = decrypt(upstoxUser.access_token);
        const ordersResult = await upstoxService.getOrderHistory(accessToken);

        if (ordersResult.success) {
            res.json({
                success: true,
                data: ordersResult.data
            });
        } else {
            res.status(500).json({
                success: false,
                error: ordersResult.error,
                message: ordersResult.message
            });
        }

    } catch (error) {
        console.error('❌ Order history error:', error);
        res.status(500).json({
            success: false,
            error: 'order_history_failed',
            message: 'Failed to fetch order history'
        });
    }
});

/**
 * @route POST /api/upstox/disconnect
 * @desc Disconnect Upstox account
 * @access Private
 */
router.post('/disconnect', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const upstoxUser = await UpstoxUser.findByUserId(userId);

        if (!upstoxUser) {
            return res.status(404).json({
                success: false,
                error: 'upstox_not_found',
                message: 'Upstox account not found'
            });
        }

        await upstoxUser.disconnect();

        res.json({
            success: true,
            message: 'Upstox account disconnected successfully'
        });

    } catch (error) {
        console.error('❌ Upstox disconnect error:', error);
        res.status(500).json({
            success: false,
            error: 'disconnect_failed',
            message: 'Failed to disconnect Upstox account'
        });
    }
});

/**
 * @route GET /api/upstox/health
 * @desc Check Upstox service health
 * @access Public
 */
router.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Upstox service is running',
        timestamp: new Date().toISOString(),
        configured: !!(process.env.UPSTOX_CLIENT_ID && process.env.UPSTOX_CLIENT_SECRET)
    });
});

/**
 * Cancel bracket order - cancels all orders for a specific analysis
 */
router.post('/cancel-bracket-order', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId, correlationBase } = req.body;

        console.log(`📋 Cancel bracket order request for user ${userId}:`, {
            analysisId,
            correlationBase
        });

        // Get Upstox user
        const upstoxUser = await UpstoxUser.findByUserId(userId);
        if (!upstoxUser) {
            return res.status(404).json({
                success: false,
                error: 'upstox_not_connected',
                message: 'Please connect your Upstox account first'
            });
        }

        // Decrypt access token
        const accessToken = decrypt(upstoxUser.access_token);

        // Cancel the bracket order
        const cancelResult = await upstoxService.cancelBracketOrder(accessToken, correlationBase);
        
        if (cancelResult.success) {
            // Update analysis order status to cancelled
            try {
                const StockAnalysis = (await import('../models/stockAnalysis.js')).default;
                const analysis = await StockAnalysis.findById(analysisId);
                
                if (analysis && analysis.placed_orders) {
                    console.log(`📋 Found analysis with ${analysis.placed_orders.length} orders`);
                    
                    // Find the bracket order with matching tag and mark as cancelled
                    const bracketOrder = analysis.placed_orders.find(order => order.tag === correlationBase);
                    if (bracketOrder) {
                        console.log(`📋 Found bracket order to cancel - Current status: ${bracketOrder.status}`);
                        bracketOrder.status = 'CANCELLED';
                        await analysis.save();
                        console.log(`✅ Updated bracket order ${correlationBase} status to CANCELLED`);
                        
                        // Log the current state after update
                        const updatedAnalysis = await StockAnalysis.findById(analysisId);
                        const hasActive = updatedAnalysis.hasActiveOrders();
                        console.log(`📋 After cancellation - hasActiveOrders: ${hasActive}`);
                        console.log(`📋 Order statuses: ${updatedAnalysis.placed_orders.map(o => `${o.tag}:${o.status}`).join(', ')}`);
                    } else {
                        console.error(`❌ Could not find bracket order with tag ${correlationBase} in analysis`);
                        console.log(`📋 Available tags: ${analysis.placed_orders.map(o => o.tag).join(', ')}`);
                    }
                }
            } catch (trackingError) {
                console.error('⚠️ Failed to update order tracking after cancellation:', trackingError);
            }
            
            res.json({
                success: true,
                data: cancelResult.data,
                message: 'Bracket order cancelled successfully'
            });
        } else {
            res.status(400).json(cancelResult);
        }

    } catch (error) {
        console.error('❌ Cancel bracket order error:', error);
        res.status(500).json({
            success: false,
            error: 'cancel_bracket_order_failed',
            message: 'Failed to cancel bracket order'
        });
    }
});

/**
 * Get order status for analysis
 */
router.get('/analysis-orders/:analysisId', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysisId } = req.params;

        console.log(`📋 Get analysis orders for user ${userId}, analysis: ${analysisId}`);

        // Get the analysis
        const StockAnalysis = (await import('../models/stockAnalysis.js')).default;
        const analysis = await StockAnalysis.findById(analysisId);
        
        if (!analysis || analysis.user_id.toString() !== userId) {
            return res.status(404).json({
                success: false,
                error: 'analysis_not_found',
                message: 'Analysis not found'
            });
        }

        if (!analysis.placed_orders || analysis.placed_orders.length === 0) {
            return res.json({
                success: true,
                data: {
                    has_orders: false,
                    orders: [],
                    can_place_new_order: true
                }
            });
        }

        // Get Upstox user for live status checking
        const upstoxUser = await UpstoxUser.findByUserId(userId);
        let liveOrderStatuses = [];
        
        if (upstoxUser) {
            try {
                const accessToken = decrypt(upstoxUser.access_token);
                
                // Get live order status for each bracket order
                for (const bracketOrder of analysis.placed_orders) {
                    // For bracket orders, check status of all order IDs
                    if (bracketOrder.order_ids && bracketOrder.order_ids.all_order_ids) {
                        for (const orderId of bracketOrder.order_ids.all_order_ids) {
                            if (orderId) {
                                const orderDetails = await upstoxService.getOrderDetails(accessToken, orderId);
                                if (orderDetails.success) {
                                    liveOrderStatuses.push({
                                        order_id: orderId,
                                        tag: bracketOrder.tag,
                                        live_status: orderDetails.data.data?.status,
                                        filled_quantity: orderDetails.data.data?.filled_quantity,
                                        pending_quantity: orderDetails.data.data?.pending_quantity,
                                        average_price: orderDetails.data.data?.average_price
                                    });
                                }
                            }
                        }
                    }
                }
            } catch (statusError) {
                console.error('⚠️ Failed to get live order status:', statusError);
            }
        }

        // Determine if user can place new orders
        const activeOrders = analysis.placed_orders.filter(order => 
            order.status === 'ACTIVE' || order.status === 'PARTIALLY_FILLED'
        );

        const canPlaceNewOrder = activeOrders.length === 0;

        // Filter out cancelled and failed orders, then flatten bracket orders for frontend compatibility
        const relevantOrders = analysis.placed_orders.filter(bracketOrder => 
            bracketOrder.status !== 'CANCELLED' && bracketOrder.status !== 'FAILED'
        );
        
        const flattenedOrders = relevantOrders.flatMap(bracketOrder => {
            // Create a main order entry for the bracket
            return [{
                order_id: bracketOrder.order_ids?.main_order_id || 'unknown',
                order_type: bracketOrder.order_type || 'BRACKET',
                status: bracketOrder.status || 'ACTIVE',
                correlation_id: bracketOrder.tag, // Use tag as correlation_id
                placed_at: bracketOrder.placed_at,
                order_details: {
                    quantity: bracketOrder.order_details?.quantity || 0,
                    price: bracketOrder.order_details?.entry_price || 0,
                    transaction_type: bracketOrder.order_details?.transaction_type || 'BUY'
                },
                // Add live status from the matching live status entry
                live_status: liveOrderStatuses.find(ls => ls.tag === bracketOrder.tag)?.live_status,
                filled_quantity: liveOrderStatuses.find(ls => ls.tag === bracketOrder.tag)?.filled_quantity,
                average_price: liveOrderStatuses.find(ls => ls.tag === bracketOrder.tag)?.average_price
            }];
        });

        res.json({
            success: true,
            data: {
                has_orders: relevantOrders.length > 0,
                orders: flattenedOrders,
                live_statuses: liveOrderStatuses,
                can_place_new_order: canPlaceNewOrder,
                active_order_count: activeOrders.length,
                total_order_count: relevantOrders.length, // Count only relevant orders, not cancelled ones
                correlation_base: relevantOrders[0]?.tag // Use the tag from relevant orders only
            }
        });

    } catch (error) {
        console.error('❌ Get analysis orders error:', error);
        res.status(500).json({
            success: false,
            error: 'get_analysis_orders_failed',
            message: 'Failed to get analysis orders'
        });
    }
});

export default router;