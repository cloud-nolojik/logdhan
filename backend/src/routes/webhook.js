import express from 'express';
// COMMENTED OUT: Upstox user model - using WhatsApp notifications instead
// import UpstoxUser from '../models/upstoxUser.js';
import StockAnalysis from '../models/stockAnalysis.js';
import PendingBracketOrder from '../models/pendingBracketOrder.js';
// COMMENTED OUT: Upstox service - using WhatsApp notifications instead
// import * as upstoxService from '../services/upstox.service.js';
import { decrypt, encrypt } from '../utils/encryption.js';

const router = express.Router();

// Helper function to place SL and target orders using persistent data
async function placeBracketOrders(orderUpdate, pendingBracketOrder) {
    try {
        console.log('📊 Placing bracket orders for executed order:', orderUpdate.order_id);
        
        const accessToken = decrypt(pendingBracketOrder.encrypted_access_token);
        const { user_id: userId, stop_loss: stopLoss, target, instrument_token: instrumentToken, analysis_type } = pendingBracketOrder;
        
        // Place stop-loss order
        if (stopLoss) {
            const slOrder = {
                quantity: orderUpdate.filled_quantity,
                product: orderUpdate.product,
                validity: 'DAY',
                price: 0, // Market order for SL
                tag: `SL_${orderUpdate.order_id}`,
                order_type: 'SL-M',
                transaction_type: orderUpdate.transaction_type === 'BUY' ? 'SELL' : 'BUY',
                disclosed_quantity: 0,
                trigger_price: stopLoss,
                is_amo: false,
                instrument_token: instrumentToken
            };
            
            const slResult = await upstoxService.placeOrder(accessToken, slOrder);
            console.log('✅ Stop-loss order placed:', slResult);
            
            // Update analysis with SL order
            const analysis = await StockAnalysis.findByInstrument(
                instrumentToken,
                analysis_type
            );
            
            if (analysis) {
                await analysis.addPlacedOrders({
                    ...slResult.data,
                    tag: slOrder.tag,
                    parent_order_id: orderUpdate.order_id
                });
            }
        }
        
        // Place target order
        if (target) {
            const targetOrder = {
                quantity: orderUpdate.filled_quantity,
                product: orderUpdate.product,
                validity: 'DAY',
                price: target,
                tag: `TGT_${orderUpdate.order_id}`,
                order_type: 'LIMIT',
                transaction_type: orderUpdate.transaction_type === 'BUY' ? 'SELL' : 'BUY',
                disclosed_quantity: 0,
                trigger_price: 0,
                is_amo: false,
                instrument_token: instrumentToken
            };
            
            const targetResult = await upstoxService.placeOrder(accessToken, targetOrder);
            console.log('✅ Target order placed:', targetResult);
            
            // Update analysis with target order
            const analysis = await StockAnalysis.findByInstrument(
                instrumentToken,
                analysis_type
            );
            
            if (analysis) {
                await analysis.addPlacedOrders({
                    ...targetResult.data,
                    tag: targetOrder.tag,
                    parent_order_id: orderUpdate.order_id
                });
            }
        }
        
        // Mark as processed in database and collect order IDs for tracking
        const bracketOrderIds = {
            stopLoss: slResult?.data?.order_id || null,
            target: targetResult?.data?.order_id || null
        };
        
        await PendingBracketOrder.markProcessed(orderUpdate.order_id, bracketOrderIds);
        
        return true;
    } catch (error) {
        console.error('❌ Error placing bracket orders:', error);
        
        // Mark as failed in database if we have the order ID
        if (pendingBracketOrder && pendingBracketOrder.order_id) {
            await PendingBracketOrder.markFailed(
                pendingBracketOrder.order_id, 
                error.message, 
                { stack: error.stack, timestamp: new Date().toISOString() }
            );
        }
        
        return false;
    }
}

// COMMENTED OUT: Upstox webhook endpoint - using WhatsApp notifications instead
// Webhook endpoint for Upstox order updates
router.post('/upstox/orders', async (req, res) => {
    // COMMENTED OUT: Upstox webhook processing - using WhatsApp notifications instead
    res.status(200).json({ 
        received: true, 
        message: 'Upstox webhooks disabled - using WhatsApp notifications instead' 
    });
    return;
    
    // ORIGINAL UPSTOX WEBHOOK CODE COMMENTED OUT BELOW:
    // try {
    //     console.log('🔔 Webhook received:', JSON.stringify(req.body, null, 2));
    //     
    //     const orderUpdate = req.body;
    //     
    //     // Immediately respond to Upstox
    //     res.status(200).json({ received: true });
        
        // Process the order update asynchronously
        if (orderUpdate.update_type === 'order') {
            const { order_id, status, filled_quantity, user_id, tag } = orderUpdate;
            
            // Check if this is a primary order (has BRC_ tag) that just got executed
            if (status === 'complete' && filled_quantity > 0 && tag && tag.startsWith('BRC_')) {
                console.log(`✅ Primary order ${order_id} executed with tag ${tag}`);
                
                // Find pending bracket order in database
                const pendingBracketOrder = await PendingBracketOrder.findAndMarkProcessing(order_id);
                
                if (pendingBracketOrder) {
                    console.log('📋 Found persistent pending bracket orders for:', order_id);
                    const success = await placeBracketOrders(orderUpdate, pendingBracketOrder);
                    
                    if (!success) {
                        // Mark as failed if bracket order placement failed
                        await PendingBracketOrder.markFailed(order_id, 'Failed to place bracket orders');
                    }
                } else {
                    // Try to find the order data from database
                    const upstoxUser = await UpstoxUser.findOne({ upstox_user_id: user_id });
                    
                    if (upstoxUser) {
                        // Find the analysis with this order
                        const analyses = await StockAnalysis.find({
                            user_id: upstoxUser.user_id,
                            'placed_orders.order_id': order_id
                        });
                        
                        if (analyses.length > 0) {
                            const analysis = analyses[0];
                            const orderData = analysis.placed_orders.find(o => o.order_id === order_id);
                            
                            if (orderData && orderData.stopLoss && orderData.target) {
                                // Create a temporary pending bracket order for fallback processing
                                const tempPendingOrder = {
                                    order_id: order_id,
                                    user_id: upstoxUser.user_id,
                                    encrypted_access_token: upstoxUser.access_token, // Already encrypted
                                    stop_loss: orderData.stopLoss,
                                    target: orderData.target,
                                    instrument_token: orderUpdate.instrument_token,
                                    analysis_type: analysis.analysis_type,
                                    stock_symbol: analysis.stock_symbol
                                };
                                
                                const success = await placeBracketOrders(orderUpdate, tempPendingOrder);
                                
                                if (!success) {
                                    console.error(`❌ Fallback bracket order placement failed for ${order_id}`);
                                }
                            }
                        }
                    }
                }
            }
            
            // Update order status in database
            if (user_id) {
                const upstoxUser = await UpstoxUser.findOne({ upstox_user_id: user_id });
                
                if (upstoxUser) {
                    // Update the order status in StockAnalysis
                    await StockAnalysis.updateMany(
                        {
                            user_id: upstoxUser.user_id,
                            'placed_orders.order_id': order_id
                        },
                        {
                            $set: {
                                'placed_orders.$.status': status,
                                'placed_orders.$.filled_quantity': filled_quantity,
                                'placed_orders.$.average_price': orderUpdate.average_price,
                                'placed_orders.$.exchange_order_id': orderUpdate.exchange_order_id,
                                'placed_orders.$.status_message': orderUpdate.status_message
                            }
                        }
                    );
                    
                    console.log(`📝 Updated order ${order_id} status to ${status}`);
                }
            }
        }
        
    } catch (error) {
        console.error('❌ Webhook processing error:', error);
        // Still return 200 to prevent Upstox from retrying
        if (!res.headersSent) {
            res.status(200).json({ received: true, error: true });
        }
    }
});

// Helper endpoint to register pending bracket orders
router.post('/register-pending-bracket', async (req, res) => {
    try {
        const { orderId, userId, accessToken, stopLoss, target, instrumentToken, analysisType, stockSymbol, strategyId, analysisId } = req.body;
        
        // Validate required fields
        if (!orderId || !userId || !accessToken || !stopLoss || !target || !instrumentToken || !analysisType) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields',
                required: ['orderId', 'userId', 'accessToken', 'stopLoss', 'target', 'instrumentToken', 'analysisType']
            });
        }
        
        // Create persistent pending bracket order
        const pendingOrder = await PendingBracketOrder.createPendingOrder({
            order_id: orderId,
            user_id: userId,
            analysis_id: analysisId,
            strategy_id: strategyId,
            stop_loss: parseFloat(stopLoss),
            target: parseFloat(target),
            instrument_token: instrumentToken,
            analysis_type: analysisType,
            stock_symbol: stockSymbol,
            encrypted_access_token: encrypt(accessToken) // Encrypt the access token
        });
        
        console.log(`📝 Registered persistent pending bracket order for ${orderId}`);
        
        res.json({ 
            success: true, 
            message: 'Pending bracket order registered in database',
            data: {
                order_id: orderId,
                expires_at: pendingOrder.expires_at,
                status: pendingOrder.status
            }
        });
    } catch (error) {
        console.error('❌ Error registering pending bracket:', error);
        
        // Handle duplicate order ID error
        if (error.code === 11000) {
            return res.status(409).json({ 
                success: false, 
                error: 'Duplicate order ID - pending bracket order already exists' 
            });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// Admin endpoint to get pending bracket order statistics
router.get('/pending-bracket-stats', async (req, res) => {
    try {
        const stats = await PendingBracketOrder.getStats();
        
        res.json({
            success: true,
            data: {
                statistics: stats,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('❌ Error getting pending bracket order stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Admin endpoint to manually clean up expired records
router.post('/cleanup-expired-brackets', async (req, res) => {
    try {
        const result = await PendingBracketOrder.cleanupExpired();
        
        res.json({
            success: true,
            message: `Cleaned up ${result?.deletedCount || 0} expired records`,
            data: {
                deletedCount: result?.deletedCount || 0,
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('❌ Error cleaning up expired brackets:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;