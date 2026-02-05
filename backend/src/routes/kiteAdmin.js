import express from 'express';
import kiteOrderService from '../services/kiteOrder.service.js';
import kiteAutoLoginService from '../services/kiteAutoLogin.service.js';
import KiteOrder from '../models/kiteOrder.js';
import KiteAuditLog from '../models/kiteAuditLog.js';
import KiteSession from '../models/kiteSession.js';
import kiteConfig from '../config/kite.config.js';
import { simpleAdminAuth } from '../middleware/simpleAdminAuth.js';

const router = express.Router();

/**
 * GET /api/admin/kite/audit-logs
 * Get audit logs with filtering
 */
router.get('/audit-logs', simpleAdminAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      action,
      status,
      symbol,
      startDate,
      endDate
    } = req.query;

    const query = {};

    if (action) query.action = action;
    if (status) query.status = status;
    if (symbol) query.stock_symbol = { $regex: symbol, $options: 'i' };

    if (startDate || endDate) {
      query.created_at = {};
      if (startDate) query.created_at.$gte = new Date(startDate);
      if (endDate) query.created_at.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [logs, total] = await Promise.all([
      KiteAuditLog.find(query)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      KiteAuditLog.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('[KITE ADMIN] Audit logs error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/kite/audit-logs/:id
 * Get single audit log details
 */
router.get('/audit-logs/:id', simpleAdminAuth, async (req, res) => {
  try {
    const log = await KiteAuditLog.findById(req.params.id);

    if (!log) {
      return res.status(404).json({
        success: false,
        error: 'Audit log not found'
      });
    }

    res.json({
      success: true,
      data: log
    });

  } catch (error) {
    console.error('[KITE ADMIN] Audit log detail error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/kite/orders
 * Get all orders from database
 */
router.get('/orders', simpleAdminAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      status,
      orderType,
      symbol,
      startDate,
      endDate
    } = req.query;

    const query = { user_id: kiteConfig.ADMIN_USER_ID };

    if (status) query.status = status;
    if (orderType) query.order_type = orderType;
    if (symbol) query.trading_symbol = { $regex: symbol, $options: 'i' };

    if (startDate || endDate) {
      query.created_at = {};
      if (startDate) query.created_at.$gte = new Date(startDate);
      if (endDate) query.created_at.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [orders, total] = await Promise.all([
      KiteOrder.find(query)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .populate('stock_id', 'stock.symbol stock.name')
        .lean(),
      KiteOrder.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });

  } catch (error) {
    console.error('[KITE ADMIN] Orders list error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/kite/orders/:id
 * Get single order details
 */
router.get('/orders/:id', simpleAdminAuth, async (req, res) => {
  try {
    const order = await KiteOrder.findById(req.params.id)
      .populate('stock_id')
      .populate('related_orders');

    if (!order) {
      return res.status(404).json({
        success: false,
        error: 'Order not found'
      });
    }

    // Get related audit logs
    const auditLogs = await KiteAuditLog.find({
      $or: [
        { order_id: order.order_id },
        { gtt_id: order.gtt_id },
        { kite_order_ref: order._id }
      ]
    }).sort({ created_at: -1 });

    res.json({
      success: true,
      data: {
        order,
        auditLogs
      }
    });

  } catch (error) {
    console.error('[KITE ADMIN] Order detail error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/kite/gtt
 * Get active GTT orders from Kite
 */
router.get('/gtt', simpleAdminAuth, async (req, res) => {
  try {
    const gtts = await kiteOrderService.getGTTs();

    res.json({
      success: true,
      count: gtts.length,
      data: gtts
    });

  } catch (error) {
    console.error('[KITE ADMIN] GTT list error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/kite/cancel-order/:orderId
 * Cancel a regular order
 */
router.post('/cancel-order/:orderId', simpleAdminAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    console.log(`[KITE ADMIN] Cancel order requested: ${orderId}`);

    const result = await kiteOrderService.cancelOrder(orderId, {
      reason: reason || 'Admin cancelled',
      source: 'MANUAL'
    });

    res.json({
      success: true,
      message: 'Order cancelled successfully',
      data: result
    });

  } catch (error) {
    console.error('[KITE ADMIN] Cancel order error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/kite/cancel-gtt/:gttId
 * Cancel a GTT order
 */
router.post('/cancel-gtt/:gttId', simpleAdminAuth, async (req, res) => {
  try {
    const { gttId } = req.params;
    const { reason } = req.body;

    console.log(`[KITE ADMIN] Cancel GTT requested: ${gttId}`);

    const result = await kiteOrderService.cancelGTT(gttId, {
      reason: reason || 'Admin cancelled',
      source: 'MANUAL'
    });

    res.json({
      success: true,
      message: 'GTT cancelled successfully',
      data: result
    });

  } catch (error) {
    console.error('[KITE ADMIN] Cancel GTT error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/kite/stats
 * Get dashboard statistics
 */
router.get('/stats', simpleAdminAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const dateFilter = {};
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    const orderQuery = { user_id: kiteConfig.ADMIN_USER_ID };
    if (startDate || endDate) orderQuery.created_at = dateFilter;

    // Get order statistics
    const [
      totalOrders,
      completedOrders,
      cancelledOrders,
      rejectedOrders,
      activeOrders,
      activeGTTs,
      auditStats,
      session
    ] = await Promise.all([
      KiteOrder.countDocuments(orderQuery),
      KiteOrder.countDocuments({ ...orderQuery, status: 'COMPLETE' }),
      KiteOrder.countDocuments({ ...orderQuery, status: 'CANCELLED' }),
      KiteOrder.countDocuments({ ...orderQuery, status: 'REJECTED' }),
      KiteOrder.countDocuments({ ...orderQuery, status: { $in: ['PLACED', 'OPEN', 'TRIGGER_PENDING'] } }),
      KiteOrder.countDocuments({ ...orderQuery, is_gtt: true, gtt_status: 'active' }),
      KiteAuditLog.getStats(startDate ? new Date(startDate) : null, endDate ? new Date(endDate) : null),
      KiteSession.findOne({ kite_user_id: kiteConfig.USER_ID })
    ]);

    // Calculate total order value
    const orderValues = await KiteOrder.aggregate([
      { $match: { ...orderQuery, status: 'COMPLETE' } },
      {
        $group: {
          _id: null,
          totalValue: { $sum: '$executed_value' },
          totalQuantity: { $sum: '$filled_quantity' }
        }
      }
    ]);

    // Get today's stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayOrders = await KiteOrder.countDocuments({
      ...orderQuery,
      created_at: { $gte: today }
    });

    res.json({
      success: true,
      data: {
        orders: {
          total: totalOrders,
          completed: completedOrders,
          cancelled: cancelledOrders,
          rejected: rejectedOrders,
          active: activeOrders,
          activeGTTs,
          today: todayOrders,
          successRate: totalOrders > 0 ? ((completedOrders / totalOrders) * 100).toFixed(2) : 0
        },
        value: {
          totalExecutedValue: orderValues[0]?.totalValue || 0,
          totalQuantity: orderValues[0]?.totalQuantity || 0
        },
        session: {
          connected: session?.isTokenValid() || false,
          status: session?.connection_status || 'not_initialized',
          lastLogin: session?.last_login_at,
          tokenExpiry: session?.token_expiry,
          loginCount: session?.login_count || 0
        },
        auditStats
      }
    });

  } catch (error) {
    console.error('[KITE ADMIN] Stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/kite/balance
 * Get current account balance
 */
router.get('/balance', simpleAdminAuth, async (req, res) => {
  try {
    const balance = await kiteOrderService.getAvailableBalance();

    res.json({
      success: true,
      data: balance
    });

  } catch (error) {
    console.error('[KITE ADMIN] Balance error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/kite/holdings
 * Get current holdings from Kite
 */
router.get('/holdings', simpleAdminAuth, async (req, res) => {
  try {
    const holdings = await kiteAutoLoginService.getHoldings();

    res.json({
      success: true,
      count: holdings.data?.length || 0,
      data: holdings.data
    });

  } catch (error) {
    console.error('[KITE ADMIN] Holdings error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/kite/test-order
 * Place a test order (for debugging - use with caution!)
 */
router.post('/test-order', simpleAdminAuth, async (req, res) => {
  try {
    const { tradingsymbol, quantity, price, transaction_type } = req.body;

    if (!tradingsymbol || !quantity || !price || !transaction_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: tradingsymbol, quantity, price, transaction_type'
      });
    }

    console.log(`[KITE ADMIN] Test order requested: ${transaction_type} ${quantity} ${tradingsymbol} @ ${price}`);

    const result = await kiteOrderService.placeOrder({
      tradingsymbol,
      quantity: parseInt(quantity),
      price: parseFloat(price),
      transaction_type,
      orderType: 'MANUAL',
      source: 'MANUAL'
    });

    res.json({
      success: true,
      message: 'Order placed successfully',
      data: result
    });

  } catch (error) {
    console.error('[KITE ADMIN] Test order error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/admin/kite/actions
 * Get list of available audit actions
 */
router.get('/actions', simpleAdminAuth, (req, res) => {
  res.json({
    success: true,
    data: kiteConfig.AUDIT_ACTIONS
  });
});

export default router;
