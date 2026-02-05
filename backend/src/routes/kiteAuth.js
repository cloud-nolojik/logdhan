import express from 'express';
import kiteAutoLoginService from '../services/kiteAutoLogin.service.js';
import { manualRefresh, isRunning } from '../services/jobs/kiteTokenRefreshJob.js';
import KiteSession from '../models/kiteSession.js';
import KiteAuditLog from '../models/kiteAuditLog.js';
import kiteConfig from '../config/kite.config.js';
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

export default router;
