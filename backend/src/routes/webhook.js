import express from 'express';
import UpstoxUser from '../models/upstoxUser.js';
import StockAnalysis from '../models/stockAnalysis.js';
import * as upstoxService from '../services/upstox.service.js';
import { decrypt } from '../utils/encryption.js';

const router = express.Router();

// Store pending bracket orders (in production, use Redis or database)
const pendingBracketOrders = new Map();

// Helper function to place SL and target orders
async function placeBracketOrders(orderUpdate, originalOrderData) {
    try {
        console.log('📊 Placing bracket orders for executed order:', orderUpdate.order_id);
        
        const { userId, accessToken, stopLoss, target, instrumentToken } = originalOrderData;
        
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
                originalOrderData.analysisType
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
                originalOrderData.analysisType
            );
            
            if (analysis) {
                await analysis.addPlacedOrders({
                    ...targetResult.data,
                    tag: targetOrder.tag,
                    parent_order_id: orderUpdate.order_id
                });
            }
        }
        
        // Remove from pending orders
        pendingBracketOrders.delete(orderUpdate.order_id);
        
        return true;
    } catch (error) {
        console.error('❌ Error placing bracket orders:', error);
        return false;
    }
}

// Webhook endpoint for Upstox order updates
router.post('/upstox/orders', async (req, res) => {
    try {
        console.log('🔔 Webhook received:', JSON.stringify(req.body, null, 2));
        
        const orderUpdate = req.body;
        
        // Immediately respond to Upstox
        res.status(200).json({ received: true });
        
        // Process the order update asynchronously
        if (orderUpdate.update_type === 'order') {
            const { order_id, status, filled_quantity, user_id, tag } = orderUpdate;
            
            // Check if this is a primary order (has BRC_ tag) that just got executed
            if (status === 'complete' && filled_quantity > 0 && tag && tag.startsWith('BRC_')) {
                console.log(`✅ Primary order ${order_id} executed with tag ${tag}`);
                
                // Check if we have pending bracket orders for this order
                const pendingData = pendingBracketOrders.get(order_id);
                
                if (pendingData) {
                    console.log('📋 Found pending bracket orders for:', order_id);
                    await placeBracketOrders(orderUpdate, pendingData);
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
                                const accessToken = decrypt(upstoxUser.access_token);
                                
                                await placeBracketOrders(orderUpdate, {
                                    userId: upstoxUser.user_id,
                                    accessToken,
                                    stopLoss: orderData.stopLoss,
                                    target: orderData.target,
                                    instrumentToken: orderUpdate.instrument_token,
                                    analysisType: analysis.analysis_type
                                });
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
        const { orderId, userId, accessToken, stopLoss, target, instrumentToken, analysisType } = req.body;
        
        pendingBracketOrders.set(orderId, {
            userId,
            accessToken,
            stopLoss,
            target,
            instrumentToken,
            analysisType
        });
        
        console.log(`📝 Registered pending bracket order for ${orderId}`);
        
        res.json({ success: true, message: 'Pending bracket order registered' });
    } catch (error) {
        console.error('❌ Error registering pending bracket:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;