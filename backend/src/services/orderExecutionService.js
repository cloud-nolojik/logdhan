import * as upstoxService from './upstox.service.js';
import triggerOrderService from './triggerOrderService.js';
import UpstoxUser from '../models/upstoxUser.js';
import { decrypt } from '../utils/encryption.js';

/**
 * Service to handle strategy validation and order execution
 * Separates the logic from the API route so it can be reused by monitoring jobs
 */

class OrderExecutionService {
    /**
     * Validate strategy conditions and place order if conditions are met
     * @param {Object} params - Parameters for order execution
     * @param {Object} params.analysis - The stock analysis document
     * @param {string} params.strategyId - Strategy ID to execute
     * @param {string} params.userId - User ID placing the order
     * @param {number} params.customQuantity - Custom quantity override (optional)
     * @param {boolean} params.bypassTriggers - Skip trigger validation (for monitoring)
     * @returns {Object} - Result of strategy validation and order placement
     */
    async validateAndExecuteStrategy({
        analysis,
        strategyId,
        userId,
        customQuantity = null,
        bypassTriggers = false
    }) {
        try {
            console.log(`🔍 Starting strategy validation for ${analysis.stock_symbol} (Strategy: ${strategyId})`);
            
            // 1. Extract strategy data
            const strategy = analysis.analysis_data.strategies.find(s => s.id === strategyId);
            if (!strategy) {
                return {
                    success: false,
                    error: 'strategy_not_found',
                    message: 'Strategy not found in analysis'
                };
            }
            
            const instrumentToken = analysis.instrument_key;
            const analysisType = analysis.analysis_type;
            const useBracketOrder = strategy.stopLoss && strategy.target ? true : false;
            
            console.log(`📋 Strategy details:`, {
                stockSymbol: analysis.stock_symbol,
                strategyType: strategy.type,
                entry: strategy.entry,
                target: strategy.target,
                stopLoss: strategy.stopLoss,
                useBracketOrder
            });
            
            // 2. Check if orders already placed
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
            
            // 3. Validate trigger conditions (unless bypassed)
            if (!bypassTriggers) {
                console.log(`🎯 Checking trigger conditions for analysis: ${analysis._id}`);
                const triggerResult = await triggerOrderService.checkTriggerConditions(analysis);
                
                // Handle missing or invalid trigger configurations
                if (!triggerResult.success && 
                    ['no_triggers', 'invalid_triggers', 'no_strategy', 'missing_entry_price', 'missing_stoploss', 'missing_target'].includes(triggerResult.reason)) {
                    console.log(`❌ Strategy configuration error for ${analysis.stock_symbol}: ${triggerResult.reason}`);
                    
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
                    console.log(`❌ Trigger conditions not met for ${analysis.stock_symbol}: ${triggerResult.reason}`);
                    
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
                
                console.log(`✅ Trigger conditions satisfied for ${analysis.stock_symbol} - proceeding to place order`);
            } else {
                console.log(`🚀 Bypassing trigger check - called from monitoring job`);
            }
            
            // 4. Execute the order
            const orderResult = await this.executeOrder({
                userId,
                strategy,
                instrumentToken,
                analysisType,
                customQuantity,
                useBracketOrder
            });
            
            if (!orderResult.success) {
                return orderResult;
            }
            
            // 5. Track the order in analysis
            await this.trackOrderInAnalysis(analysis, orderResult, strategy, strategyId);
            
            return {
                success: true,
                data: orderResult.data,
                message: orderResult.message,
                pendingBracket: orderResult.pendingBracket || false
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
        useBracketOrder
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
            
            // 3. Handle different order types
            if (useBracketOrder && orderData.orderType === 'LIMIT' && orderData.stopLoss && orderData.target) {
                return await this.placeLimitOrderWithDeferredBracket(
                    accessToken,
                    orderData,
                    userId,
                    instrumentToken,
                    analysisType,
                    upstoxUser
                );
            } else {
                return await this.placeStandardOrder(accessToken, orderData, upstoxUser);
            }
            
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
     * Place a limit order with deferred bracket orders (via webhook)
     */
    async placeLimitOrderWithDeferredBracket(accessToken, orderData, userId, instrumentToken, analysisType, upstoxUser) {
        console.log('📋 Placing LIMIT order with deferred bracket orders (via webhook)');
        
        const primaryOrderData = {
            ...orderData,
            tag: `BRC_${Date.now()}`
        };
        
        console.log('📋 Placing primary limit order:', primaryOrderData);
        const orderResult = await upstoxService.placeOrder(accessToken, primaryOrderData);
        
        if (orderResult.success) {
            const orderId = orderResult.data?.data?.order_id || orderResult.data?.order_id;
            
            // Register for webhook processing
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
            
            await upstoxUser.updateOrderStats(true);
            
            return {
                success: true,
                data: orderResult.data.data || orderResult.data,
                message: 'Limit order placed. Stop-loss and target orders will be placed automatically after execution.',
                pendingBracket: true,
                orderDetails: {
                    quantity: orderData.quantity,
                    price: orderData.price,
                    transaction_type: orderData.transactionType,
                    product: orderData.product,
                    tag: primaryOrderData.tag,
                    stopLoss: orderData.stopLoss,
                    target: orderData.target,
                    pending_bracket: true
                }
            };
        } else {
            await upstoxUser.updateOrderStats(false);
            return orderResult;
        }
    }
    
    /**
     * Place a standard order (market or non-bracket)
     */
    async placeStandardOrder(accessToken, orderData, upstoxUser) {
        console.log('📋 Using single order method');
        const orderResult = await upstoxService.placeOrder(accessToken, orderData);
        
        console.log('📋 Received orderResult:', orderResult);
        
        await upstoxUser.updateOrderStats(orderResult.success);
        
        if (orderResult.success) {
            console.log('🔍 Raw Upstox orderResult:', JSON.stringify(orderResult, null, 2));
            
            return {
                success: true,
                data: orderResult.data.data || orderResult.data,
                message: orderResult.data.message || 'Order placed successfully on Upstox',
                orderDetails: {
                    quantity: orderData.quantity,
                    price: orderData.price,
                    transaction_type: orderData.transactionType,
                    product: orderData.product,
                    tag: orderData.tag,
                    stopLoss: orderData.stopLoss,
                    target: orderData.target
                }
            };
        } else {
            console.log('❌ Raw Upstox orderResult (failed):', JSON.stringify(orderResult, null, 2));
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
                pending_bracket: orderDetails.pending_bracket || false
            });
            
            console.log('✅ Order tracking updated in analysis');
        } catch (trackingError) {
            console.error('⚠️ Failed to update order tracking:', trackingError);
            throw trackingError;
        }
    }
    
    /**
     * Execute strategy from monitoring job (simplified interface)
     * @param {string} analysisId - Analysis document ID
     * @param {string} strategyId - Strategy ID to execute
     * @param {string} userId - User ID
     * @returns {Object} - Execution result
     */
    async executeFromMonitoring(analysisId, strategyId, userId) {
        try {
            // Import StockAnalysis model
            const StockAnalysis = (await import('../models/stockAnalysis.js')).default;
            
            // Find the analysis
            const analysis = await StockAnalysis.findById(analysisId);
            if (!analysis || analysis.user_id.toString() !== userId) {
                return {
                    success: false,
                    error: 'analysis_not_found',
                    message: 'Analysis not found or access denied'
                };
            }
            
            // Execute with bypassed triggers (monitoring already validated them)
            return await this.validateAndExecuteStrategy({
                analysis,
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
}

export default new OrderExecutionService();