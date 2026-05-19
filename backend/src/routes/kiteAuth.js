import express from 'express';
import kiteAutoLoginService from '../services/kiteAutoLogin.service.js';
import { manualRefresh, isRunning } from '../services/jobs/kiteTokenRefreshJob.js';
import KiteSession from '../models/kiteSession.js';
import KiteAuditLog from '../models/kiteAuditLog.js';
import kiteConfig from '../config/kite.config.js';
import kiteOrderEvents from '../services/kiteOrderEvents.js';
import { simpleAdminAuth } from '../middleware/simpleAdminAuth.js';

const router = express.Router();

/**
 * GET /api/kite/auth/status
 * Check Kite connection status
 */
router.get('/status', simpleAdminAuth, async (req, res) => {
  try {
    const session = await KiteSession.findOne({ kite_user_id: kiteConfig.USER_ID });

    if (!session) {
      return res.json({
        success: true,
        connected: false,
        status: 'not_initialized',
        message: 'Kite session not initialized. Please trigger a login.'
      });
    }

    // Check if token is still valid
    const isValid = session.isTokenValid();

    res.json({
      success: true,
      connected: isValid,
      status: session.connection_status,
      data: {
        kiteUserId: session.kite_user_id,
        userName: session.user_name,
        email: session.email,
        tokenCreatedAt: session.token_created_at,
        tokenExpiry: session.token_expiry,
        isValid: session.is_valid,
        lastValidatedAt: session.last_validated_at,
        lastLoginAt: session.last_login_at,
        loginCount: session.login_count,
        validationCount: session.validation_count,
        lastError: session.last_login_error
      }
    });

  } catch (error) {
    console.error('[KITE AUTH] Status check error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/kite/auth/refresh
 * Manually trigger token refresh (admin only)
 */
router.post('/refresh', simpleAdminAuth, async (req, res) => {
  try {
    // Check if job is already running
    if (isRunning()) {
      return res.status(409).json({
        success: false,
        error: 'Token refresh already in progress'
      });
    }

    console.log('[KITE AUTH] Manual token refresh requested');

    const session = await manualRefresh();

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      data: {
        userName: session.user_name,
        email: session.email,
        tokenExpiry: session.token_expiry
      }
    });

  } catch (error) {
    console.error('[KITE AUTH] Manual refresh error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kite/auth/profile
 * Get Kite user profile (validates token)
 */
router.get('/profile', simpleAdminAuth, async (req, res) => {
  try {
    const profile = await kiteAutoLoginService.getProfile();

    // Log profile fetch
    await KiteAuditLog.logAction('PROFILE_FETCH', {
      kiteUserId: kiteConfig.USER_ID,
      status: 'SUCCESS',
      response: profile.data,
      source: 'MANUAL'
    });

    res.json({
      success: true,
      data: profile.data
    });

  } catch (error) {
    console.error('[KITE AUTH] Profile fetch error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kite/auth/balance
 * Get account balance/margins
 */
router.get('/balance', simpleAdminAuth, async (req, res) => {
  try {
    const margins = await kiteAutoLoginService.getMargins();

    const equity = margins.data?.equity || {};

    res.json({
      success: true,
      data: {
        net: equity.net,
        available: equity.available,
        utilised: equity.utilised,
        cash: equity.available?.cash,
        usableForTrading: (equity.available?.cash || 0) * kiteConfig.CAPITAL_USAGE_PERCENT
      }
    });

  } catch (error) {
    console.error('[KITE AUTH] Balance fetch error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kite/auth/holdings
 * Get current holdings
 */
router.get('/holdings', simpleAdminAuth, async (req, res) => {
  try {
    const holdings = await kiteAutoLoginService.getHoldings();

    await KiteAuditLog.logAction('HOLDINGS_FETCH', {
      kiteUserId: kiteConfig.USER_ID,
      status: 'SUCCESS',
      notes: `${holdings.data?.length || 0} holdings`,
      source: 'MANUAL'
    });

    res.json({
      success: true,
      count: holdings.data?.length || 0,
      data: holdings.data
    });

  } catch (error) {
    console.error('[KITE AUTH] Holdings fetch error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kite/auth/positions
 * Get current positions
 */
router.get('/positions', simpleAdminAuth, async (req, res) => {
  try {
    const positions = await kiteAutoLoginService.getPositions();

    await KiteAuditLog.logAction('POSITIONS_FETCH', {
      kiteUserId: kiteConfig.USER_ID,
      status: 'SUCCESS',
      notes: `${positions.data?.net?.length || 0} positions`,
      source: 'MANUAL'
    });

    res.json({
      success: true,
      data: positions.data
    });

  } catch (error) {
    console.error('[KITE AUTH] Positions fetch error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kite/auth/orders
 * Get today's orders
 */
router.get('/orders', simpleAdminAuth, async (req, res) => {
  try {
    const orders = await kiteAutoLoginService.getOrders();

    res.json({
      success: true,
      count: orders.data?.length || 0,
      data: orders.data
    });

  } catch (error) {
    console.error('[KITE AUTH] Orders fetch error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/kite/auth/callback
 * OAuth callback handler - exchanges request_token for access_token
 * This handles the redirect from Kite after user authorization
 */
router.get('/callback', async (req, res) => {
  try {
    const { request_token, status, action } = req.query;

    console.log('[KITE AUTH] Callback received:', { request_token: request_token ? 'present' : 'missing', status, action });

    if (status !== 'success' || !request_token) {
      return res.status(400).send(`
        <html>
          <head><title>Kite Authorization Failed</title></head>
          <body style="font-family: Arial; padding: 40px; text-align: center;">
            <h1 style="color: #e74c3c;">❌ Authorization Failed</h1>
            <p>Status: ${status || 'unknown'}</p>
            <p>Please try again.</p>
          </body>
        </html>
      `);
    }

    // Exchange request_token for access_token
    const session = await kiteAutoLoginService.exchangeToken(request_token);

    // Log successful callback
    await KiteAuditLog.logAction('OAUTH_CALLBACK', {
      kiteUserId: kiteConfig.USER_ID,
      status: 'SUCCESS',
      response: { user_name: session.user_name, token_expiry: session.token_expiry },
      source: 'OAUTH'
    });

    // Return success page
    res.send(`
      <html>
        <head><title>Kite Authorization Successful</title></head>
        <body style="font-family: Arial; padding: 40px; text-align: center;">
          <h1 style="color: #27ae60;">✅ Kite Connected Successfully!</h1>
          <p><strong>User:</strong> ${session.user_name}</p>
          <p><strong>Email:</strong> ${session.email}</p>
          <p><strong>Token Expiry:</strong> ${session.token_expiry}</p>
          <p style="margin-top: 20px; color: #666;">You can close this window now.</p>
        </body>
      </html>
    `);

  } catch (error) {
    console.error('[KITE AUTH] Callback error:', error);

    await KiteAuditLog.logAction('OAUTH_CALLBACK', {
      kiteUserId: kiteConfig.USER_ID,
      status: 'FAILED',
      error: error.message,
      source: 'OAUTH'
    });

    res.status(500).send(`
      <html>
        <head><title>Kite Authorization Error</title></head>
        <body style="font-family: Arial; padding: 40px; text-align: center;">
          <h1 style="color: #e74c3c;">❌ Error</h1>
          <p>${error.message}</p>
          <p style="margin-top: 20px; color: #666;">Please try again or contact support.</p>
        </body>
      </html>
    `);
  }
});

/**
 * POST /api/kite/auth/test-login
 * Test the automated login (for debugging)
 */
router.post('/test-login', simpleAdminAuth, async (req, res) => {
  try {
    console.log('[KITE AUTH] Test login requested');

    const startTime = Date.now();
    const session = await kiteAutoLoginService.performAutoLogin();
    const duration = Date.now() - startTime;

    res.json({
      success: true,
      message: 'Login successful',
      durationMs: duration,
      data: {
        userName: session.user_name,
        email: session.email,
        tokenExpiry: session.token_expiry,
        connectionStatus: session.connection_status
      }
    });

  } catch (error) {
    console.error('[KITE AUTH] Test login error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data
    });
  }
});

/**
 * POST /api/kite/auth/postback
 * Kite Connect order postback handler.
 * Kite sends order status updates here as application/x-www-form-urlencoded.
 * Postback URL must be configured in the Kite Connect developer console.
 *
 * Kite postback fields:
 *   order_id, exchange_order_id, placed_by, status, status_message,
 *   tradingsymbol, exchange, order_type, transaction_type, validity,
 *   product, quantity, price, trigger_price, average_price,
 *   filled_quantity, pending_quantity, cancelled_quantity,
 *   tag, guid, checksum
 */
router.post('/postback', async (req, res) => {
  try {
    // Kite sends postback as application/x-www-form-urlencoded with a raw JSON blob as body.
    // We register express.text({type:'*/*'}) for this route in index.js BEFORE the global
    // json/urlencoded parsers, so req.body arrives here as a plain string. Parse it directly.
    // Fallback paths handle legacy cases or if Kite ever switches to individual url-encoded fields.
    let postback = req.body;

    if (typeof postback === 'string') {
      // Normal path: express.text() captured the raw body
      try {
        postback = JSON.parse(postback);
      } catch (_jsonErr) {
        // Maybe Kite sent individual key=value pairs instead of a JSON blob
        try {
          postback = Object.fromEntries(new URLSearchParams(postback));
        } catch (urlErr) {
          console.error('[KITE POSTBACK] Failed to parse body as JSON or URL-encoded:', urlErr.message);
          postback = {};
        }
      }
    } else if (typeof postback === 'object' && !postback?.order_id) {
      // Legacy fallback: qs put the JSON blob as a single key { "{...}": "" }
      // (only fires if express.text somehow didn't run)
      const keys = Object.keys(postback);
      if (keys.length > 0 && keys[0].startsWith('{')) {
        try {
          postback = JSON.parse(keys[0]);
        } catch (e) {
          console.error('[KITE POSTBACK] Legacy fallback: failed to parse JSON from key:', e.message);
        }
      }
    }

    console.log(`[KITE POSTBACK] Received: order_id=${postback.order_id} symbol=${postback.tradingsymbol} status=${postback.status} avg_price=${postback.average_price} filled_qty=${postback.filled_quantity} type=${postback.order_type} txn=${postback.transaction_type} tag=${postback.tag || 'none'}`);

    // Acknowledge immediately (Kite expects 200 within 5 seconds)
    res.status(200).json({ received: true });

    // Log to audit trail for visibility
    if (postback.order_id) {
      await KiteAuditLog.logAction('ORDER_POSTBACK', {
        orderId: postback.order_id,
        symbol: postback.tradingsymbol,
        exchange: postback.exchange,
        status: postback.status,
        statusMessage: postback.status_message,
        averagePrice: postback.average_price,
        filledQuantity: postback.filled_quantity,
        pendingQuantity: postback.pending_quantity,
        orderType: postback.order_type,
        transactionType: postback.transaction_type,
        product: postback.product,
        tag: postback.tag,
        source: 'KITE_POSTBACK'
      });

      // Emit event for listeners (daily picks fill listener, etc.)
      const status = postback.status?.toUpperCase();
      if (status === 'COMPLETE') {
        console.log(`[KITE POSTBACK] Emitting order:complete for ${postback.tradingsymbol} orderId=${postback.order_id} avg_price=${postback.average_price}`);
        kiteOrderEvents.emit('order:complete', postback);
      } else if (status === 'REJECTED') {
        console.log(`[KITE POSTBACK] Emitting order:rejected for ${postback.tradingsymbol} orderId=${postback.order_id} reason=${postback.status_message}`);
        kiteOrderEvents.emit('order:rejected', postback);
      } else if (status === 'CANCELLED') {
        console.log(`[KITE POSTBACK] Emitting order:cancelled for ${postback.tradingsymbol} orderId=${postback.order_id}`);
        kiteOrderEvents.emit('order:cancelled', postback);
      } else {
        console.log(`[KITE POSTBACK] Non-terminal status=${status} for ${postback.tradingsymbol} orderId=${postback.order_id} — no event emitted`);
      }
    }
  } catch (error) {
    console.error('[KITE POSTBACK] Error processing postback:', error.message);
    // Always return 200 to prevent Kite from retrying
    if (!res.headersSent) {
      res.status(200).json({ received: true, error: true });
    }
  }
});

export default router;
