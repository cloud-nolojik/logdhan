import express from 'express';
import upstoxService from '../services/upstox.service.js';
import UpstoxUser from '../models/upstoxUser.js';
import { auth as authenticateToken } from '../middleware/auth.js';
import crypto from 'crypto';
// Removed condition validator - direct order placement only

const router = express.Router();

// COMMENTED OUT: Upstox order placement not in use
// import triggerOrderService from '../services/triggerOrderService.js';
// import orderExecutionService from '../services/orderExecutionService.js';

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

// COMMENTED OUT: Upstox order placement not in use
// /**
//  * @route POST /api/upstox/place-order
//  * @desc Place order on Upstox based on AI strategy
//  * @access Private
//  */
// router.post('/place-order', authenticateToken, async (req, res) => { ... });
// See git history for full implementation

// COMMENTED OUT: Upstox order placement not in use
// /**
//  * @route GET /api/upstox/orders
//  * @desc Get order history from Upstox
//  * @access Private
//  */
// router.get('/orders', authenticateToken, async (req, res) => { ... });
// See git history for full implementation

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

// COMMENTED OUT: Upstox order placement not in use
// /**
//  * Cancel bracket order - cancels all orders for a specific analysis
//  */
// router.post('/cancel-bracket-order', authenticateToken, async (req, res) => { ... });
// See git history for full implementation

// COMMENTED OUT: Upstox order placement not in use
// /**
//  * Get order status for analysis
//  */
// router.get('/analysis-orders/:analysisId', authenticateToken, async (req, res) => { ... });
// See git history for full implementation

export default router;