import upstoxService from './upstox.service.js';
import triggerOrderService from './triggerOrderService.js';
import UpstoxUser from '../models/upstoxUser.js';
import UserPosition from '../models/userPosition.js';
import { decrypt } from '../utils/encryption.js';
import mongoose from 'mongoose';

/**
 * Service to handle strategy validation and order execution
 * Separates the logic from the API route so it can be reused by monitoring jobs
 */

class OrderExecutionService {
  /**
   * Atomically check and place order using MongoDB transactions to prevent race conditions
   * @param {Object} params - Parameters for atomic order execution
   * @returns {Object} - Result of atomic order placement
   */
  async atomicOrderPlacement({
    analysisId,
    strategyId,
    userId,
    customQuantity = null,
    bypassTriggers = false
  }) {
    const session = await mongoose.startSession();

    try {
      let result = null;

      await session.withTransaction(async () => {

        // Import StockAnalysis model within transaction
        const StockAnalysis = (await import('../models/stockAnalysis.js')).default;

        // Find and lock the analysis document for update
        const analysis = await StockAnalysis.findById(analysisId).
        session(session).
        exec();

        if (!analysis) {
          throw new Error('Analysis not found');
        }

        if (analysis.user_id.toString() !== userId) {
          throw new Error('Access denied to analysis');
        }

        // Atomic check: if orders already exist, fail immediately
        if (analysis.hasActiveOrders()) {
          const activeOrderIds = analysis.getPlacedOrderIds();
          result = {
            success: false,
            error: 'orders_already_placed',
            message: `Orders already placed for this analysis. Active orders: ${activeOrderIds.join(', ')}`,
            data: {
              existing_orders: analysis.placed_orders,
              analysis_id: analysis._id
            }
          };
          return; // Exit transaction without placing order
        }

        // Mark analysis as "order_processing" to prevent other processes from placing orders
        analysis.order_processing = true;
        analysis.order_processing_started_at = new Date();
        await analysis.save({ session });

        // Continue with order execution outside of the initial lock
        // (we'll handle the actual order placement in a separate method)
        result = {
          success: true,
          action: 'proceed_with_order',
          analysis: analysis,
          locked: true
        };
      });

      // If we successfully locked the analysis, proceed with order placement
      if (result && result.success && result.action === 'proceed_with_order') {
        return await this.executeOrderWithLockedAnalysis({
          analysis: result.analysis,
          strategyId,
          userId,
          customQuantity,
          bypassTriggers
        });
      }

      return result;

    } catch (error) {
      console.error(`❌ Atomic order placement transaction failed for ${analysisId}_${strategyId}:`, error);
      return {
        success: false,
        error: 'atomic_placement_failed',
        message: error.message
      };
    } finally {
      await session.endSession();
    }
  }

  /**
   * Execute order with a pre-locked analysis document
   * @param {Object} params - Parameters for locked order execution
   * @returns {Object} - Result of order execution
   */
  async executeOrderWithLockedAnalysis({
    analysis,
    strategyId,
    userId,
    customQuantity = null,
    bypassTriggers = false
  }) {
    try {

      // Execute the standard validation and order flow
      const orderResult = await this.validateAndExecuteStrategy({
        analysis,
        strategyId,
        userId,
        customQuantity,
        bypassTriggers,
        skipOrderCheck: true // Skip order check since we already did it atomically
      });

      // Always unlock the analysis after order attempt
      await this.unlockAnalysis(analysis._id, orderResult.success);

      return orderResult;

    } catch (error) {
      console.error(`❌ Locked order execution failed for ${analysis._id}_${strategyId}:`, error);

      // Always unlock on error
      await this.unlockAnalysis(analysis._id, false);

      return {
        success: false,
        error: 'locked_execution_failed',
        message: error.message
      };
    }
  }

  /**
   * Unlock analysis after order processing
   * @param {string} analysisId - Analysis ID to unlock
   * @param {boolean} success - Whether order placement was successful
   */
  async unlockAnalysis(analysisId, success) {
    try {
      const StockAnalysis = (await import('../models/stockAnalysis.js')).default;

      await StockAnalysis.findByIdAndUpdate(analysisId, {
        $unset: {
          order_processing: 1,
          order_processing_started_at: 1
        },
        $set: {
          order_processing_completed_at: new Date(),
          last_order_processing_result: success ? 'success' : 'failed'
        }
      });

    } catch (error) {
      console.error(`❌ Failed to unlock analysis ${analysisId}:`, error);
    }
  }

  /**
   * Validate strategy conditions and place order if conditions are met
   * @param {Object} params - Parameters for order execution
   * @param {Object} params.analysis - The stock analysis document
   * @param {string} params.strategyId - Strategy ID to execute
   * @param {string} params.userId - User ID placing the order
   * @param {number} params.customQuantity - Custom quantity override (optional)
   * @param {boolean} params.bypassTriggers - Skip trigger validation (for monitoring)
   * @param {boolean} params.skipOrderCheck - Skip order existence check (for atomic operations)
   * @returns {Object} - Result of strategy validation and order placement
   */
  async validateAndExecuteStrategy({
    analysis,
    strategyId,
    userId,
    customQuantity = null,
    bypassTriggers = false,
    skipOrderCheck = false
  }) {
    try {

      // 1. Extract strategy data
      const strategy = analysis.analysis_data.strategies.find((s) => s.id === strategyId);
      if (!strategy) {
        return {
          success: false,
          error: 'strategy_not_found',
          message: 'Strategy not found in analysis'
        };
      }

      const instrumentToken = analysis.instrument_key;
      const analysisType = analysis.analysis_type;

      // 2. Check if orders already placed (skip if atomic operation already checked)
      if (!skipOrderCheck) {
        const hasActive = analysis.hasActiveOrders();
        if (hasActive) {
          const activeOrderIds = analysis.getPlacedOrderIds();
          return {
            success: false,
            error: 'orders_already_placed',
            message: `Orders already placed for this analysis. Active orders: ${activeOrderIds.join(', ')}`,
            data: {
              existing_orders: analysis.placed_orders,
              analysis_id: analysis._id
            }
          };
        }
      } else {

      }

      // 3. Validate trigger conditions (unless bypassed)
      if (!bypassTriggers) {

        const triggerResult = await triggerOrderService.checkTriggerConditions(analysis);

        // Handle missing or invalid trigger configurations
        if (!triggerResult.success &&
        ['no_triggers', 'invalid_triggers', 'no_strategy', 'missing_entry_price', 'missing_stoploss', 'missing_target'].includes(triggerResult.reason)) {

          return {
            success: false,
            error: triggerResult.reason,
            message: triggerResult.message,
            shouldMonitor: false, // Cannot monitor without proper triggers
            data: {
              ...triggerResult.data,
              analysis_id: analysis._id,
              stock_symbol: analysis.stock_symbol
            }
          };
        }

        if (!triggerResult.triggersConditionsMet) {

          return {
            success: false,
            error: triggerResult.reason,
            message: triggerResult.message,
            shouldMonitor: triggerResult.data?.should_monitor,
            monitoringFrequency: triggerResult.data?.monitoring_frequency,
            data: {
              analysis_id: analysis._id,
              stock_symbol: analysis.stock_symbol,
              current_price: triggerResult.data?.current_price,
              triggers_conditions_met: false,
              failed_triggers: triggerResult.data?.failed_triggers || [],
              invalidations: triggerResult.data?.invalidations || [],
              strategy_entry: strategy.entry,
              entry_type: strategy.entryType,
              user_action_required: triggerResult.data?.user_action_required
            }
          };
        }

      } else {

      }

      // 4. Execute the order
      const orderResult = await this.executeOrder({
        userId,
        strategy,
        instrumentToken,
        analysisType,
        customQuantity,
        analysisId: analysis._id,
        stockSymbol: analysis.stock_symbol
      });

      if (!orderResult.success) {
        return orderResult;
      }

      // 5. Track the order in analysis
      await this.trackOrderInAnalysis(analysis, orderResult, strategy, strategyId);

      return {
        success: true,
        data: orderResult.data,
        message: orderResult.message
      };

    } catch (error) {
      console.error(`❌ Strategy validation/execution error for ${analysis.stock_symbol}:`, error);
      return {
        success: false,
        error: 'strategy_execution_failed',
        message: error.message
      };
    }
  }

  /**
   * Execute the actual order placement
   * @param {Object} params - Order execution parameters
   * @returns {Object} - Order execution result
   */
  async executeOrder({
    userId,
    strategy,
    instrumentToken,
    analysisType,
    customQuantity,
    analysisId,
    stockSymbol
  }) {
    try {
      // 1. Get Upstox user data
      const upstoxUser = await UpstoxUser.findByUserId(userId);
      if (!upstoxUser || !upstoxUser.isTokenValid()) {
        return {
          success: false,
          error: 'upstox_not_connected',
          message: 'Upstox account not connected or token expired'
        };
      }

      const accessToken = decrypt(upstoxUser.access_token);

      // 2. Convert strategy to order data
      const orderData = await upstoxService.convertAIStrategyToOrder(
        strategy,
        instrumentToken,
        analysisType,
        accessToken
      );

      // Override quantity if provided
      if (customQuantity) {
        orderData.quantity = Math.max(1, parseInt(customQuantity));
      }

      // 3. Place order using Multi Order API with webhook support for stop-loss/target
      return await this.placeMultiOrder(
        accessToken,
        orderData,
        upstoxUser,
        strategy,
        userId,
        instrumentToken,
        analysisType,
        analysisId,
        stockSymbol
      );

    } catch (error) {
      console.error(`❌ Order execution error:`, error);
      return {
        success: false,
        error: 'order_execution_failed',
        message: error.message
      };
    }
  }

  /**
   * Place order using Multi Order API with webhook-based stop-loss/target support
   */
  async placeMultiOrder(accessToken, orderData, upstoxUser, strategy = null, userId = null, instrumentToken = null, analysisType = null, analysisId = null, stockSymbol = null) {

    // Add special tag if stop-loss and target are provided
    const hasStopLossAndTarget = strategy && strategy.stopLoss && strategy.target;
    if (hasStopLossAndTarget) {
      orderData.tag = `BRC_${Date.now()}`;

    }

    // Build multi-order array with proper sequence (BUY first, then SELL)
    const multiOrderPayload = [];
    const timestamp = Date.now();

    // Main entry order
    const mainOrder = {
      correlation_id: `M${timestamp}`.slice(-20),
      quantity: parseInt(orderData.quantity),
      product: orderData.product, // D, I, MTF
      validity: orderData.validity || "DAY", // DAY, IOC
      price: orderData.orderType === 'MARKET' ? 0 : parseFloat(orderData.price || 0),
      tag: orderData.tag || "string",
      instrument_token: instrumentToken,
      order_type: orderData.orderType, // MARKET, LIMIT, SL, SL-M
      transaction_type: orderData.transactionType.toUpperCase(), // BUY, SELL
      disclosed_quantity: parseInt(orderData.disclosed_quantity || 0),
      trigger_price: parseFloat(orderData.trigger_price || 0),
      is_amo: Boolean(orderData.is_amo || false),
      slice: Boolean(orderData.slice || false)
    };

    multiOrderPayload.push(mainOrder);

    // Optional: Add immediate stop-loss and target orders if strategy has them
    // and if we want to place them immediately instead of via webhook
    if (strategy && strategy.stopLoss && strategy.target && orderData.placeImmediateBracket) {
      const isLongPosition = orderData.transactionType.toUpperCase() === 'BUY';

      // Stop-loss order (opposite transaction type)
      const stopLossOrder = {
        correlation_id: `SL${timestamp}`.slice(-20),
        quantity: parseInt(orderData.quantity),
        product: orderData.product,
        validity: "DAY",
        price: 0, // Market order for stop-loss
        tag: `SL_${orderData.tag}`.slice(0, 40),
        instrument_token: instrumentToken,
        order_type: "SL-M", // Stop-Loss Market
        transaction_type: isLongPosition ? "SELL" : "BUY", // Opposite direction
        disclosed_quantity: 0,
        trigger_price: parseFloat(strategy.stopLoss),
        is_amo: false,
        slice: false
      };

      // Target order (opposite transaction type)
      const targetOrder = {
        correlation_id: `TG${timestamp}`.slice(-20),
        quantity: parseInt(orderData.quantity),
        product: orderData.product,
        validity: "DAY",
        price: parseFloat(strategy.target),
        tag: `TGT_${orderData.tag}`.slice(0, 40),
        instrument_token: instrumentToken,
        order_type: "LIMIT", // Limit order for target
        transaction_type: isLongPosition ? "SELL" : "BUY", // Opposite direction
        disclosed_quantity: 0,
        trigger_price: 0,
        is_amo: false,
        slice: false
      };

      // Add in correct sequence (BUY orders first, then SELL orders)
      if (isLongPosition) {
        // Long position: BUY entry already added, now add SELL stop-loss and target
        multiOrderPayload.push(stopLossOrder, targetOrder);
      } else {
        // Short position: Need to reorder - BUY orders (SL/target) first, then SELL entry
        const sellEntry = multiOrderPayload.pop(); // Remove SELL entry temporarily
        multiOrderPayload.push(stopLossOrder, targetOrder); // Add BUY orders first
        multiOrderPayload.push(sellEntry); // Add SELL entry back at end
      }

    }

    const orderResult = await upstoxService.placeMultiOrder(accessToken, multiOrderPayload);

    await upstoxUser.updateOrderStats(orderResult.success);

    if (orderResult.success) {
      // Extract the main order (first order) from multi-order response
      const orderResponse = orderResult.data?.data?.[0] || orderResult.data?.[0];
      const orderId = orderResponse?.order_id;
      const allOrders = orderResult.data?.data || orderResult.data || [];

      allOrders.forEach((order, index) => {
        // Orders logged for debugging
      });

      // Create UserPosition if this is an entry order with stop-loss and target
      if (hasStopLossAndTarget && orderId && userId && analysisId) {
        try {
          const StockAnalysis = (await import('../models/stockAnalysis.js')).default;
          const analysis = await StockAnalysis.findById(analysisId);

          if (analysis) {
            // Check if position already exists
            const existingPosition = await UserPosition.findOpenPosition(userId, instrumentToken);

            if (!existingPosition) {
              const entryPrice = orderData.orderType === 'MARKET'
                ? parseFloat(strategy.entry) // Use strategy entry for market orders
                : parseFloat(orderData.price);

              await UserPosition.createFromAnalysis(
                userId,
                analysis,
                entryPrice,
                parseInt(orderData.quantity),
                {
                  main_order_id: orderId,
                  sl_order_id: allOrders.find(o => o.correlation_id?.startsWith('SL'))?.order_id,
                  target_order_id: allOrders.find(o => o.correlation_id?.startsWith('TG'))?.order_id
                }
              );
              console.log(`📊 Position created for ${stockSymbol} - Entry: ₹${entryPrice}, Qty: ${orderData.quantity}`);
            } else {
              console.log(`📊 Position already exists for ${stockSymbol}, skipping creation`);
            }
          }
        } catch (positionError) {
          console.error('⚠️ Failed to create position (order still placed):', positionError.message);
          // Don't fail the order if position creation fails - order is already placed
        }
      }

      // Register for webhook processing if using webhook mode (not immediate bracket mode)
      if (hasStopLossAndTarget && !orderData.placeImmediateBracket && orderId && userId && instrumentToken && analysisType) {
        try {
          const webhookRegistration = await fetch(`http://localhost:${process.env.PORT || 5650}/api/webhook/register-pending-bracket`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              orderId,
              userId,
              accessToken,
              stopLoss: strategy.stopLoss,
              target: strategy.target,
              instrumentToken,
              analysisType,
              stockSymbol: stockSymbol || 'Unknown',
              strategyId: strategy.id,
              analysisId: analysisId
            })
          });

          if (webhookRegistration.ok) {

          } else {
            console.error('⚠️ Failed to register webhook data:', await webhookRegistration.text());
          }
        } catch (webhookError) {
          console.error('⚠️ Failed to register webhook data:', webhookError);
        }
      }

      const totalOrders = allOrders.length;
      let message = '';

      if (orderData.placeImmediateBracket && totalOrders > 1) {
        message = `${totalOrders} orders placed successfully: Entry + Stop-loss + Target orders executed immediately.`;
      } else if (hasStopLossAndTarget) {
        message = 'Order placed successfully using Multi Order API. Stop-loss and target orders will be placed automatically after execution.';
      } else {
        message = orderResult.data.message || 'Order placed successfully on Upstox using Multi Order API';
      }

      return {
        success: true,
        data: orderResponse,
        message: message,
        totalOrdersPlaced: totalOrders,
        allOrderIds: allOrders.map((o) => o.order_id),
        hasAutomaticStopLossTarget: hasStopLossAndTarget,
        hasImmediateBracket: orderData.placeImmediateBracket || false,
        orderDetails: {
          quantity: orderData.quantity,
          price: orderData.price,
          transaction_type: orderData.transactionType,
          product: orderData.product,
          tag: orderData.tag,
          stopLoss: strategy?.stopLoss,
          target: strategy?.target,
          correlation_id: mainOrder.correlation_id,
          allOrders: allOrders
        }
      };
    } else {

      return orderResult;
    }
  }

  /**
   * Track the placed order in the analysis document
   */
  async trackOrderInAnalysis(analysis, orderResult, strategy, strategyId) {
    try {
      const orderDetails = orderResult.orderDetails || {};

      await analysis.addPlacedOrders({
        ...orderResult.data,
        strategy_id: strategyId,
        quantity: orderDetails.quantity,
        price: orderDetails.price,
        transaction_type: orderDetails.transaction_type,
        product: orderDetails.product,
        tag: orderDetails.tag,
        stopLoss: orderDetails.stopLoss,
        target: orderDetails.target,
        hasAutomaticStopLossTarget: orderResult.hasAutomaticStopLossTarget || false,
        correlation_id: orderDetails.correlation_id
      });

    } catch (trackingError) {
      console.error('⚠️ Failed to update order tracking:', trackingError);
      throw trackingError;
    }
  }

  /**
   * Execute strategy from monitoring job using atomic operations (simplified interface)
   * @param {string} analysisId - Analysis document ID
   * @param {string} strategyId - Strategy ID to execute
   * @param {string} userId - User ID
   * @returns {Object} - Execution result
   */
  async executeFromMonitoring(analysisId, strategyId, userId) {
    try {

      // Use atomic order placement to prevent race conditions
      return await this.atomicOrderPlacement({
        analysisId,
        strategyId,
        userId,
        customQuantity: null,
        bypassTriggers: true // Skip trigger validation since monitoring already checked
      });

    } catch (error) {
      console.error(`❌ Monitoring execution error for analysis ${analysisId}:`, error);
      return {
        success: false,
        error: 'monitoring_execution_failed',
        message: error.message
      };
    }
  }

  /**
   * Execute strategy from API call using atomic operations (for manual order placement)
   * @param {string} analysisId - Analysis document ID
   * @param {string} strategyId - Strategy ID to execute
   * @param {string} userId - User ID
   * @param {number} customQuantity - Custom quantity override (optional)
   * @returns {Object} - Execution result
   */
  async executeFromAPI(analysisId, strategyId, userId, customQuantity = null) {
    try {

      // Use atomic order placement to prevent race conditions
      return await this.atomicOrderPlacement({
        analysisId,
        strategyId,
        userId,
        customQuantity,
        bypassTriggers: false // Validate triggers for manual API calls
      });

    } catch (error) {
      console.error(`❌ API execution error for analysis ${analysisId}:`, error);
      return {
        success: false,
        error: 'api_execution_failed',
        message: error.message
      };
    }
  }
}

export default new OrderExecutionService();