import express from 'express';
import { referralService } from '../services/referralService.js';
import { auth } from '../middleware/auth.js';
import { subscriptionRateLimit } from '../middleware/rateLimiter.js';

const router = express.Router();

/**
 * GET /api/v1/referrals/code
 * Get or create user's referral code
 */
router.get('/code', auth, subscriptionRateLimit, async (req, res) => {
  try {
    const result = await referralService.getUserReferralCode(req.user.id);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error getting referral code:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * POST /api/v1/referrals/redeem
 * Redeem a referral code
 */
router.post('/redeem', auth, subscriptionRateLimit, async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code || typeof code !== 'string' || code.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Valid referral code is required'
      });
    }

    const metadata = {
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      source: req.body.source || 'app'
    };

    const result = await referralService.redeemReferralCode(req.user.id, code, metadata);
    
    // Track analytics event
    console.log('📊 Referral Analytics:', {
      event: 'referral_redeemed',
      userId: req.user.id,
      code,
      timestamp: new Date().toISOString()
    });
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error redeeming referral code:', error);
    
    // Return specific error messages for common failures
    const errorMessages = {
      'Invalid referral code': 'The referral code you entered is invalid.',
      'Already used by this user': 'You have already used this referral code.',
      'Code exhausted': 'This referral code has reached its usage limit.',
      'Cannot refer yourself': 'You cannot use your own referral code.',
      'Phone/email verification required': 'Please verify your phone or email first.',
      'User has already received a referral bonus': 'You have already received a referral bonus.',
      'Too many redemptions from this device': 'Too many referrals from this device today. Try again tomorrow.'
    };
    
    const message = errorMessages[error.message] || 'Failed to redeem referral code. Please try again.';
    
    res.status(400).json({
      success: false,
      message,
      code: error.message.replace(/\s+/g, '_').toLowerCase()
    });
  }
});

/**
 * GET /api/v1/referrals/stats
 * Get user's referral statistics
 */
router.get('/stats', auth, subscriptionRateLimit, async (req, res) => {
  try {
    const stats = await referralService.getReferralStats(req.user.id);
    
    // Add CAC calculation
    const cac = referralService.calculateReferralCAC(stats.conversionRate);
    
    res.json({
      success: true,
      data: {
        ...stats,
        analytics: {
          costPerAcquisition: Math.round(cac * 100) / 100,
          bonusCost: referralService.bonusAmount * 2 * 0.41,
          profitableAt: '25% conversion rate'
        }
      }
    });
  } catch (error) {
    console.error('Error getting referral stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load referral statistics'
    });
  }
});

/**
 * POST /api/v1/referrals/share
 * Track referral code sharing (for analytics)
 */
router.post('/share', auth, subscriptionRateLimit, async (req, res) => {
  try {
    const { channel, code } = req.body;
    
    // Track sharing analytics
    console.log('📊 Referral Share Analytics:', {
      event: 'referral_code_shared',
      userId: req.user.id,
      channel: channel || 'unknown',
      code,
      timestamp: new Date().toISOString()
    });
    
    res.json({
      success: true,
      message: 'Share tracked successfully'
    });
  } catch (error) {
    console.error('Error tracking referral share:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to track share'
    });
  }
});

/**
 * GET /api/v1/referrals/leaderboard
 * Get top referrers (optional feature)
 */
router.get('/leaderboard', auth, subscriptionRateLimit, async (req, res) => {
  try {
    // TODO: Implement leaderboard logic
    // For now, return empty
    res.json({
      success: true,
      data: {
        topReferrers: [],
        userRank: null,
        message: 'Leaderboard coming soon!'
      }
    });
  } catch (error) {
    console.error('Error getting leaderboard:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load leaderboard'
    });
  }
});

export default router;