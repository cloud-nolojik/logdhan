import rateLimit from 'express-rate-limit';
import { ipKeyGenerator } from 'express-rate-limit';
import { Subscription } from '../models/subscription.js';

/**
 * Safe key generator that handles IPv6 addresses properly
 */
export const safeKeyGenerator = (req) => {
  // Use user ID if authenticated, otherwise use proper IP key generator
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }
  return `ip:${ipKeyGenerator(req)}`;
};

/**
 * Rate limiter for subscription endpoints
 */
export const subscriptionRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use default key generator which properly handles IPv6
});

/**
 * Rate limiter for auth-less plan list endpoint
 */
export const planListRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per minute
  message: {
    error: 'Too many plan requests, please try again later.',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use default key generator which properly handles IPv6
});

/**
 * Rate limiter for AI review requests (per-user basis)
 */
export const aiReviewRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 reviews per minute per IP
  message: {
    error: 'Too many AI review requests. Maximum 5 per minute.',
    retryAfter: '1 minute'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: safeKeyGenerator
});

/**
 * Enhanced credit usage validation (server-side)
 */
export const validateCreditUsage = async (req, res, next) => {
  try {
    const { userId } = req.user;
    const creditsRequested = req.body.credits || 1;

    // Always re-calculate server-side to prevent client spoofing
    const subscription = await Subscription.findActiveForUser(userId);
    
    if (!subscription) {
      return res.status(402).json({
        success: false,
        message: 'No active subscription found',
        code: 'NO_SUBSCRIPTION'
      });
    }

    // Check first-week restrictions for trial users
    if (subscription.planId === 'starter_trial' && subscription.isInFirstWeek()) {
      const firstWeekUsed = subscription.restrictions?.firstWeekUsed || 0;
      const firstWeekCap = subscription.restrictions?.firstWeekCap || 25;
      
      if (firstWeekUsed + creditsRequested > firstWeekCap) {
        return res.status(402).json({
          success: false,
          message: `First week limit reached. Used ${firstWeekUsed}/${firstWeekCap} credits.`,
          code: 'FIRST_WEEK_LIMIT',
          limit: firstWeekCap,
          used: firstWeekUsed
        });
      }
    }

    // Check total available credits
    const availableCredits = subscription.getTotalAvailableCredits();
    if (availableCredits < creditsRequested) {
      return res.status(402).json({
        success: false,
        message: 'Insufficient credits',
        code: 'INSUFFICIENT_CREDITS',
        available: availableCredits,
        requested: creditsRequested
      });
    }

    // Attach subscription to request for use in route handler
    req.subscription = subscription;
    next();

  } catch (error) {
    console.error('Error validating credit usage:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating credit usage'
    });
  }
};

/**
 * Top-up pack guard - requires active paid plan
 */
export const requireActivePaidPlan = async (req, res, next) => {
  try {
    const { userId } = req.user;
    
    const subscription = await Subscription.findActiveForUser(userId);
    
    if (!subscription) {
      return res.status(400).json({
        success: false,
        message: 'Top-up packs require an active subscription',
        code: 'NO_ACTIVE_SUBSCRIPTION'
      });
    }

    if (subscription.planId === 'starter_trial') {
      return res.status(400).json({
        success: false,
        message: 'Top-up packs require a paid subscription plan',
        code: 'TRIAL_NO_TOPUP'
      });
    }

    next();
  } catch (error) {
    console.error('Error checking paid plan requirement:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating subscription'
    });
  }
};