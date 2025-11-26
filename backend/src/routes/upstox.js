import express from 'express';
import upstoxService from '../services/upstox.service.js';
import UpstoxUser from '../models/upstoxUser.js';
import { auth as authenticateToken } from '../middleware/auth.js';
import crypto from 'crypto';
// Removed condition validator - direct order placement only

const router = express.Router();

// Import services
import triggerOrderService from '../services/triggerOrderService.js';
import orderExecutionService from '../services/orderExecutionService.js';
import agendaMonitoringService from '../services/agendaMonitoringService.js';

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
      strategyId,
      customQuantity = null,
      bypassTriggers = false // For monitoring jobs
    } = req.body;

    // Validate required fields
    if (!strategyId) {
      return res.status(400).json({
        success: false,
        error: 'invalid_request',
        message: 'Strategy ID is required'
      });
    }

    // Import StockAnalysis model
    const StockAnalysis = (await import('../models/stockAnalysis.js')).default;

    // Find the analysis that contains this strategy
    const existingAnalysis = await StockAnalysis.findOne({
      'analysis_data.strategies.id': strategyId,
      expires_at: { $gt: new Date() }
    });

    if (!existingAnalysis) {
      return res.status(404).json({
        success: false,
        error: 'strategy_not_found',
        message: 'Strategy not found. Please run analysis first.'
      });
    }

    // Extract the specific strategy from the analysis
    const strategy = existingAnalysis.analysis_data.strategies.find((s) => s.id === strategyId);

    // Use the new order execution service
    const executionResult = await orderExecutionService.validateAndExecuteStrategy({
      analysis: existingAnalysis,
      strategyId,
      userId,
      customQuantity,
      bypassTriggers
    });

    if (!executionResult.success) {
      // Check if the error is due to missing triggers
      if (executionResult.error === 'no_triggers' || executionResult.error === 'invalid_triggers') {
        return res.status(400).json({
          success: false,
          error: executionResult.error,
          message: 'Cannot place order - Entry conditions not configured. The system needs specific market conditions (triggers) to know when to buy/sell. Please run a new analysis with proper entry conditions.',
          data: {
            ...executionResult.data,
            user_friendly_explanation: 'Think of triggers as "IF-THEN" rules: IF price goes above ₹X, THEN place buy order',
            what_to_do: [
            '1. Run a fresh AI analysis for this stock',
            '2. Ensure the analysis includes entry conditions',
            '3. Try placing the order again'],

            why_important: 'Without triggers, placing orders immediately could result in bad entry prices and losses'
          }
        });
      }

      // Check if error is due to missing strategy parameters
      if (['missing_entry_price', 'missing_stoploss', 'missing_target'].includes(executionResult.error)) {
        return res.status(400).json({
          success: false,
          error: executionResult.error,
          message: executionResult.message,
          data: {
            ...executionResult.data,
            critical_for_trading: true,
            explanation: {
              entry_price: 'The price at which you want to buy/sell the stock',
              stop_loss: 'Maximum loss you are willing to take (protects capital)',
              target: 'Price at which you want to book profits'
            },
            what_to_do: 'Run a complete AI analysis that includes all three price levels'
          }
        });
      }

      // Show choice dialog instead of automatically starting monitoring
      if (executionResult.shouldMonitor && executionResult.monitoringFrequency) {

        // Return choice dialog response
        return res.status(200).json({
          success: false,
          error: 'conditions_not_ideal',
          message: '🕰️ Market conditions are not ideal for your order right now.',
          user_friendly_status: 'WAITING_FOR_BETTER_PRICE',
          data: {
            ...executionResult.data,
            should_monitor: true,
            monitoring_frequency: executionResult.monitoringFrequency,
            user_message: {
              title: 'Wait for Better Entry',
              description: `The current price of ₹${executionResult.data.current_price} is not optimal for your ${strategy.entryType || 'BUY'} order.`,
              recommendation: 'Start automatic monitoring to get the best price',
              what_monitoring_does: [
              '🎯 Watches the market continuously',
              '📈 Waits for your ideal entry conditions',
              '⚡ Places order instantly when conditions are perfect',
              '🔔 Sends you notification immediately'],

              why_wait: 'Entering at the right price can significantly improve your profits',
              action_button: 'Start Smart Monitoring',
              skip_button: 'Place Order Anyway (Not Recommended)',
              monitoring_details: {
                frequency: executionResult.monitoringFrequency.description || 'every 15 minutes',
                duration: 'Up to 5 trading days',
                stock_symbol: existingAnalysis.stock_symbol,
                target_entry: `₹${strategy.entry || 'calculated price'}`,
                current_price: `₹${executionResult.data.current_price}`,
                failed_conditions: executionResult.data.failed_triggers || []
              }
            },
            monitoring_available: true,
            manual_override_allowed: true,
            analysis_id: existingAnalysis._id,
            strategy_id: strategyId
          }
        });
      }

      // Return appropriate status code based on error type
      let statusCode = 400;
      if (executionResult.error === 'orders_already_placed') statusCode = 409;
      if (executionResult.error === 'upstox_not_connected') statusCode = 401;
      if (executionResult.error === 'strategy_not_found') statusCode = 404;

      // For triggers not met, provide user-friendly monitoring suggestion
      if (executionResult.error === 'triggers_not_met' && executionResult.shouldMonitor) {
        return res.status(200).json({
          success: false,
          error: 'conditions_not_ideal',
          message: '🕰️ Market conditions are not ideal for your order right now.',
          user_friendly_status: 'WAITING_FOR_BETTER_PRICE',
          data: {
            ...executionResult.data,
            should_monitor: true,
            monitoring_frequency: executionResult.monitoringFrequency,
            user_message: {
              title: 'Wait for Better Entry',
              description: `The current price of ₹${executionResult.data.current_price} is not optimal for your ${strategy.entryType || 'BUY'} order.`,
              recommendation: 'Start automatic monitoring to get the best price',
              what_monitoring_does: [
              '🎯 Watches the market continuously',
              '📈 Waits for your ideal entry conditions',
              '⚡ Places order instantly when conditions are perfect',
              '🔔 Sends you notification immediately'],

              why_wait: 'Entering at the right price can significantly improve your profits',
              action_button: 'Start Smart Monitoring',
              skip_button: 'Place Order Anyway (Not Recommended)'
            },
            monitoring_available: true,
            manual_override_allowed: true
          }
        });
      }

      return res.status(statusCode).json({
        success: false,
        error: executionResult.error,
        message: executionResult.message,
        data: {
          ...executionResult.data,
          should_monitor: executionResult.shouldMonitor,
          monitoring_frequency: executionResult.monitoringFrequency,
          suggestion: executionResult.shouldMonitor ? 'You can manually start monitoring using /api/monitoring/start' : undefined
        }
      });
    }

    // Success response - ensure data has required fields
    const responseData = {
      order_id: executionResult.data?.order_id || executionResult.data?.data?.order_id || null,
      status: executionResult.data?.status || 'PLACED',
      message: executionResult.message || 'Order placed successfully',
      ...executionResult.data
    };

    res.json({
      success: true,
      data: responseData,
      message: executionResult.message,
      pending_bracket: executionResult.pendingBracket
    });

  } catch (error) {
    console.error('❌ Order placement error:', error);

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

          // Find the bracket order with matching tag and mark as cancelled
          const bracketOrder = analysis.placed_orders.find((order) => order.tag === correlationBase);
          if (bracketOrder) {

            bracketOrder.status = 'CANCELLED';
            await analysis.save();

            // Log the current state after update
            const updatedAnalysis = await StockAnalysis.findById(analysisId);
            const hasActive = updatedAnalysis.hasActiveOrders();

          } else {
            console.error(`❌ Could not find bracket order with tag ${correlationBase} in analysis`);

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
    const activeOrders = analysis.placed_orders.filter((order) =>
    order.status === 'ACTIVE' || order.status === 'PARTIALLY_FILLED'
    );

    const canPlaceNewOrder = activeOrders.length === 0;

    // Filter out cancelled and failed orders, then flatten bracket orders for frontend compatibility
    const relevantOrders = analysis.placed_orders.filter((bracketOrder) =>
    bracketOrder.status !== 'CANCELLED' && bracketOrder.status !== 'FAILED'
    );

    const flattenedOrders = relevantOrders.flatMap((bracketOrder) => {
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
        live_status: liveOrderStatuses.find((ls) => ls.tag === bracketOrder.tag)?.live_status,
        filled_quantity: liveOrderStatuses.find((ls) => ls.tag === bracketOrder.tag)?.filled_quantity,
        average_price: liveOrderStatuses.find((ls) => ls.tag === bracketOrder.tag)?.average_price
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