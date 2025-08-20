import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { auth } from '../middleware/auth.js';
import { cashfreeService } from '../services/payment/cashfree.service.js';
import { Payment } from '../models/payment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// POST /payments/create-order - Create a new payment order
router.post('/create-order', auth, async (req, res) => {
  try {
    const { amount, packageType } = req.body;
    const userId = req.user.id;

    // Validate amount
    if (!amount || amount < 1) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount is required (minimum ₹1)',
        data: null
      });
    }

    // Check if amount is within limits (simple validation)
    if (amount < 10 || amount > 5000) {
      return res.status(400).json({
        success: false,
        message: `Amount must be between ₹10 and ₹5000`,
        data: null
      });
    }

    // Create order with Cashfree
    const result = await cashfreeService.createOrder(userId, amount, packageType);

    res.json({
      success: true,
      message: 'Payment order created successfully',
      data: result.data
    });

  } catch (error) {
    console.error('Error creating payment order:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create payment order',
      data: null
    });
  }
});

// POST /payments/webhook - Handle Cashfree webhook
router.post('/webhook', async (req, res) => {
  try {
    const webhookData = req.body;
    const signature = req.headers['x-webhook-signature'];

    if (!signature) {
      console.error('Webhook signature missing');
      return res.status(400).json({ error: 'Signature missing' });
    }

    // Process webhook
    const result = await cashfreeService.processWebhook(webhookData, signature);

    // Return success to Cashfree
    res.json({ 
      success: true, 
      message: 'Webhook processed successfully',
      data: result
    });

  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Webhook processing failed',
      error: error.message 
    });
  }
});

// GET /payments/status/:orderId - Get payment status
router.get('/status/:orderId', auth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    // Find payment record
    const payment = await Payment.findByOrderId(orderId);
    
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment order not found',
        data: null
      });
    }

    // Verify user owns this payment
    if (payment.user.toString() !== userId) {
      return res.status(403).json({
        success: false,
        message: 'Access denied',
        data: null
      });
    }

    // Get latest status from Cashfree
    const cashfreeStatus = await cashfreeService.getPaymentStatus(orderId);

    res.json({
      success: true,
      data: {
        orderId: payment.orderId,
        amount: payment.amount,
        credits: payment.credits,
        status: payment.status,
        paymentMethod: payment.paymentMethod,
        createdAt: payment.createdAt,
        completedAt: payment.paymentCompletedAt,
        cashfreeStatus: cashfreeStatus
      }
    });

  } catch (error) {
    console.error('Error getting payment status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get payment status',
      data: null
    });
  }
});

// GET /payments/history - Get user's payment history
router.get('/history', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const userId = req.user.id;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const payments = await cashfreeService.getUserPayments(userId, parseInt(limit), skip);
    const totalPayments = await Payment.countDocuments({ user: userId });

    res.json({
      success: true,
      data: {
        payments,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalPayments / parseInt(limit)),
          totalPayments,
          hasNext: (parseInt(page) * parseInt(limit)) < totalPayments,
          hasPrev: parseInt(page) > 1
        }
      },
      message: 'Payment history retrieved successfully'
    });

  } catch (error) {
    console.error('Error getting payment history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get payment history',
      data: null
    });
  }
});

// GET /payments/packages - Get available recharge packages (DEPRECATED - use /subscriptions/plans instead)
router.get('/packages', auth, async (req, res) => {
  try {
    res.json({
      success: true,
      data: [],
      message: 'This endpoint is deprecated. Please use /api/v1/subscriptions/plans instead.'
    });

  } catch (error) {
    console.error('Error getting recharge packages:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get recharge packages',
      data: null
    });
  }
});

// POST /payments/calculate - Calculate credits for amount
router.post('/calculate', auth, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({
        success: false,
        message: 'Valid amount is required',
        data: null
      });
    }

    // Simple credit calculation (deprecated - use subscription plans instead)
    const credits = Math.floor(amount / 0.5); // 1 credit = ₹0.5

    res.json({
      success: true,
      data: {
        amount: `₹${amount}`,
        credits,
        rate: `₹0.50 per credit`,
        deprecated: true,
        message: 'Please use subscription plans instead of credit recharge'
      },
      message: 'Credit calculation successful (deprecated)'
    });

  } catch (error) {
    console.error('Error calculating credits:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate credits',
      data: null
    });
  }
});

// GET /payments/checkout/:sessionId - Serve payment page with Cashfree SDK
router.get('/checkout/:sessionId', async (req, res) => {
  try {
    const { sessionId: rawSessionId } = req.params;
    const { returnUrl } = req.query;
    
    // Decode the session ID
    const sessionId = decodeURIComponent(rawSessionId);
    
    console.log('Payment checkout requested:', { rawSessionId, sessionId, returnUrl, env: process.env.NODE_ENV });
    console.log('Session ID length:', sessionId?.length);
    console.log('Session ID type:', typeof sessionId);
    
    if (!sessionId) {
      return res.status(400).send('Payment session ID is required');
    }
    
    // Read the payment template
    const templatePath = path.join(__dirname, '../../views/payment.html');
    let template = fs.readFileSync(templatePath, 'utf8');
    
    // Determine SDK URL and environment based on NODE_ENV
    const sdkUrl = process.env.NODE_ENV === 'production'
      ? 'https://sdk.cashfree.com/js/v3/cashfree.js'
      : 'https://sandbox.cashfree.com/js/v3/cashfree.js';
    
    const environment = process.env.NODE_ENV === 'production' ? 'production' : 'sandbox';
    
    console.log('Using SDK URL:', sdkUrl);
    console.log('Using environment:', environment);
    
    // Replace placeholders
    template = template
      .replace(/{{SDK_URL}}/g, sdkUrl)
      .replace(/{{PAYMENT_SESSION_ID}}/g, sessionId)
      .replace(/{{ENVIRONMENT}}/g, environment)
      .replace(/{{RETURN_URL}}/g, returnUrl || process.env.FRONTEND_URL || 'about:blank');
    
    // Debug: Check if replacement worked
    const hasSessionId = template.includes(sessionId);
    const hasPlaceholder = template.includes('{{PAYMENT_SESSION_ID}}');
    console.log('Template replacement check:', { hasSessionId, hasPlaceholder });
    
    // Debug: Show a snippet of the template around the session ID
    const sessionIdIndex = template.indexOf(sessionId);
    if (sessionIdIndex > -1) {
      const snippet = template.substring(sessionIdIndex - 50, sessionIdIndex + sessionId.length + 50);
      console.log('Session ID in template:', snippet);
    }
    
    res.setHeader('Content-Type', 'text/html');
    res.send(template);
    
  } catch (error) {
    console.error('Error serving payment page:', error);
    res.status(500).send('Internal server error');
  }
});


router.get('/cashfree-checkout/:sessionId', async (req, res) => {
  try {
    const { sessionId: rawSessionId } = req.params;
    const { returnUrl } = req.query;
    
    // Decode the session ID
    const sessionId = decodeURIComponent(rawSessionId);
    
    console.log('Payment checkout requested:', { rawSessionId, sessionId, returnUrl, env: process.env.NODE_ENV });
    console.log('Session ID length:', sessionId?.length);
    console.log('Session ID type:', typeof sessionId);
    
    if (!sessionId) {
      return res.status(400).send('Payment session ID is required');
    }
    
    // Read the payment template
    const templatePath = path.join(__dirname, '../../views/payment.html');
    let template = fs.readFileSync(templatePath, 'utf8');
    
    // Determine SDK URL and environment based on NODE_ENV
    const sdkUrl = process.env.NODE_ENV === 'production'
      ? 'https://sdk.cashfree.com/js/v3/cashfree.js'
      : 'https://sandbox.cashfree.com/js/v3/cashfree.js';
    
    const environment = process.env.NODE_ENV === 'production' ? 'production' : 'sandbox';
    
    console.log('Using SDK URL:', sdkUrl);
    console.log('Using environment:', environment);
    
    // Replace placeholders
    template = template
      .replace(/{{SDK_URL}}/g, sdkUrl)
      .replace(/{{PAYMENT_SESSION_ID}}/g, sessionId)
      .replace(/{{ENVIRONMENT}}/g, environment)
      .replace(/{{RETURN_URL}}/g, returnUrl || process.env.FRONTEND_URL || 'about:blank');
    
    // Debug: Check if replacement worked
    const hasSessionId = template.includes(sessionId);
    const hasPlaceholder = template.includes('{{PAYMENT_SESSION_ID}}');
    console.log('Template replacement check:', { hasSessionId, hasPlaceholder });
    
    // Debug: Show a snippet of the template around the session ID
    const sessionIdIndex = template.indexOf(sessionId);
    if (sessionIdIndex > -1) {
      const snippet = template.substring(sessionIdIndex - 50, sessionIdIndex + sessionId.length + 50);
      console.log('Session ID in template:', snippet);
    }
    
    res.setHeader('Content-Type', 'text/html');
    res.send(template);
    
  } catch (error) {
    console.error('Error serving payment page:', error);
    res.status(500).send('Internal server error');
  }
});

export default router; 