import express from 'express';
import { auth } from '../middleware/auth.js';
import { subscriptionService } from '../services/subscription/subscriptionService.js';
import { experienceAnalytics } from '../services/analytics/experienceAnalytics.js';
import Notification from '../models/notification.js';
import { firebaseService } from '../services/firebase/firebase.service.js';
import mongoose from 'mongoose';


const router = express.Router();

/**
 * Get all available subscription plans
 * GET /api/v1/subscriptions/plans
 */
router.get('/plans', async (req, res) => {
  try {
    const plans = await subscriptionService.getActivePlans();
    
    // Transform plans for frontend
    const formattedPlans = plans.map(plan => ({
      id: plan.planId,
      name: plan.name,
      description: plan.description,
      type: plan.type,
      price: plan.price,
      credits: plan.credits,
      features: plan.features,
      billingCycle: plan.billingCycle,
      creditsPerRupee: plan.getCreditsPerRupee(),
      savings: plan.type === 'ANNUAL' ? 
        Math.round(((12 * 99) - plan.price) / (12 * 99) * 100) : 0,
      isPopular: plan.planId === 'pro_monthly',
      isBestValue: plan.planId === 'pro_annual',
      restrictions: plan.restrictions,
      pipelineAccess: plan.pipelineAccess
    }));

    res.json({
      success: true,
      data: formattedPlans
    });
  } catch (error) {
    console.error('Error fetching subscription plans:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch subscription plans'
    });
  }
});

/**
 * Get user's current subscription
 * GET /api/v1/subscriptions/current
 */
router.get('/current', auth, async (req, res) => {
  try {
    const subscription = await subscriptionService.getUserActiveSubscription(req.user.id);
    
    if (!subscription) {
      return res.json({
        success: true,
        data: null,
        message: 'No active subscription found'
      });
    }

    const plan = await subscriptionService.getPlanById(subscription.planId);
    const daysRemaining = Math.ceil((subscription.billing.endDate - new Date()) / (1000 * 60 * 60 * 24));
    const isExpired = daysRemaining <= 0;
    const isExpiringSoon = daysRemaining <= 7 && daysRemaining > 0;
    
    // Basic ads plan never expires, others check expiry
    let subscriptionStatus = subscription.status;
    if (subscription.planId === 'basic_ads') {
      subscriptionStatus = 'ACTIVE'; // Always active for basic ads
    } else if (isExpired) {
      subscriptionStatus = 'EXPIRED';
    }
    
    res.json({
      success: true,
      data: {
        id: subscription.subscriptionId,
        planId: subscription.planId,
        planName: subscription.planName,
        status: subscriptionStatus,
        pricing: subscription.pricing,
        credits: {
          total: subscription.credits.total,
          used: subscription.credits.used,
          remaining: subscription.credits.remaining,
          rollover: subscription.credits.rollover,
          earnedCredits: subscription.credits.earnedCredits || 0,
          bonusCredits: subscription.credits.bonusCredits || 0,
          bonusCreditsExpiry: subscription.credits.bonusCreditsExpiry,
          rewardedCredits: subscription.credits.rewardedCredits || 0,
          available: subscription.getTotalAvailableCredits(),
          usagePercentage: subscription.creditUsagePercentage
        },
        billing: {
          startDate: subscription.billing.startDate,
          endDate: subscription.billing.endDate,
          nextBillingDate: subscription.billing.nextBillingDate,
          daysRemaining: Math.max(0, daysRemaining)
        },
        restrictions: subscription.restrictions,
        features: plan?.features || [],
        canUpgrade: subscription.planId !== 'pro_annual',
        canDowngrade: subscription.planId === 'pro_annual',
        isExpired: isExpired,
        isExpiringSoon: isExpiringSoon,
        needsUpgrade: subscription.planId === 'basic_ads' // Always suggest upgrade for basic ads users
      }
    });
  } catch (error) {
    console.error('Error fetching current subscription:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch subscription details'
    });
  }
});

/**
 * Generate payment URL for subscription upgrade (don't create subscription)
 * POST /api/v1/subscriptions/generate-payment-url
 */
router.post('/generate-payment-url', auth, async (req, res) => {
  try {
    const { planId, customerDetails } = req.body;

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: 'Plan ID is required'
      });
    }

    // Track payment URL generation attempt
    experienceAnalytics.trackFeatureUsage(
      req.user.id,
      'payment_url_generation_attempt',
      'unknown',
      { planId }
    );

    const result = await subscriptionService.generatePaymentUrl(
      req.user.id,
      planId,
      customerDetails
    );

    res.json({
      success: true,
      data: {
        paymentUrl: result.paymentUrl,
        planName: result.planName,
        amount: result.amount,
        credits: result.credits,
        subscriptionSessionId: result.subscriptionSessionId,
        planType: result.planType,
        isRecurring: result.isRecurring
      },
      message: 'Payment URL generated successfully'
    });
  } catch (error) {
    console.error('Error generating payment URL:', error);
    
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to generate payment URL'
    });
  }
});

/**
 * Create new subscription
 * POST /api/v1/subscriptions/create
 */
router.post('/create', auth, async (req, res) => {
  try {
    const { planId, paymentDetails = {} } = req.body;

    if (!planId) {
      return res.status(400).json({
        success: false,
        message: 'Plan ID is required'
      });
    }

    // Track subscription creation attempt
    experienceAnalytics.trackFeatureUsage(
      req.user.id,
      'subscription_creation_attempt',
      'unknown',
      { planId }
    );

    const result = await subscriptionService.createSubscription(
      req.user.id,
      planId,
      paymentDetails
    );

    res.json({
      success: true,
      data: {
        subscriptionId: result.subscription.subscriptionId,
        sessionId: result.sessionId,
        paymentUrl: result.paymentUrl,
        planName: result.subscription.planName,
        amount: result.subscription.pricing.amount,
        credits: result.subscription.pricing.credits
      },
      message: 'Subscription created successfully'
    });
  } catch (error) {
    console.error('Error creating subscription:', error);
    
    if (error.message === 'User already has an active subscription') {
      return res.status(409).json({
        success: false,
        message: error.message
      });
    }
    
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create subscription'
    });
  }
});

/**
 * Purchase top-up pack
 * POST /api/v1/subscriptions/topup
 */
router.post('/topup', auth, async (req, res) => {
  try {
    const { quantity = 1 } = req.body;

    if (quantity < 1 || quantity > 10) {
      return res.status(400).json({
        success: false,
        message: 'Quantity must be between 1 and 10'
      });
    }

    // Create multiple top-up subscriptions for quantity > 1
    const results = [];
    for (let i = 0; i < quantity; i++) {
      const result = await subscriptionService.createSubscription(
        req.user.id,
        'topup_pack',
        { source: 'topup_purchase' }
      );
      results.push(result);
    }

    const totalCredits = quantity * 100;
    const totalAmount = quantity * 75;

    res.json({
      success: true,
      data: {
        topupCount: quantity,
        totalCredits,
        totalAmount,
        paymentUrl: results[0].paymentUrl, // Use first payment URL
        sessionId: results[0].sessionId
      },
      message: `${quantity} top-up pack${quantity > 1 ? 's' : ''} created successfully`
    });
  } catch (error) {
    console.error('Error creating top-up:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create top-up pack'
    });
  }
});

/**
 * Check if user can use credits
 * GET /api/v1/subscriptions/can-use-credits
 */
router.get('/can-use-credits', auth, async (req, res) => {
  try {
    const { credits = 1 } = req.query;
    const creditsNeeded = parseInt(credits);

    const result = await subscriptionService.canUserUseCredits(req.user.id, creditsNeeded);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Error checking credit usage:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check credit availability'
    });
  }
});

/**
 * Get subscription usage analytics
 * GET /api/v1/subscriptions/analytics
 */
router.get('/analytics', auth, async (req, res) => {
  try {
    const subscription = await subscriptionService.getUserActiveSubscription(req.user.id);
    
    if (!subscription) {
      return res.json({
        success: true,
        data: null,
        message: 'No active subscription found'
      });
    }

    const now = new Date();
    const cycleStart = subscription.billing.lastBillingDate || subscription.billing.startDate;
    const daysSinceCycleStart = Math.ceil((now - cycleStart) / (1000 * 60 * 60 * 24));
    const daysInCycle = subscription.pricing.billingCycle === 'MONTHLY' ? 30 : 365;
    
    const analytics = {
      usage: {
        creditsUsed: subscription.credits.used,
        creditsTotal: subscription.credits.total,
        creditsRemaining: subscription.credits.remaining,
        rolloverCredits: subscription.credits.rollover,
        usagePercentage: subscription.creditUsagePercentage,
        averageCreditsPerDay: daysSinceCycleStart > 0 ? 
          Math.round(subscription.credits.used / daysSinceCycleStart * 10) / 10 : 0
      },
      billing: {
        currentCycle: {
          start: cycleStart,
          end: subscription.billing.endDate,
          daysElapsed: daysSinceCycleStart,
          daysRemaining: Math.max(0, daysInCycle - daysSinceCycleStart),
          progressPercentage: Math.min(100, (daysSinceCycleStart / daysInCycle) * 100)
        },
        nextBilling: subscription.billing.nextBillingDate,
        amount: subscription.pricing.amount,
        currency: 'INR'
      },
      restrictions: {
        pipelineAccess: subscription.restrictions.pipelineAccess,
        firstWeekCap: subscription.restrictions.firstWeekCap,
        firstWeekUsed: subscription.restrictions.firstWeekUsed,
        firstWeekRemaining: subscription.restrictions.firstWeekCap ? 
          Math.max(0, subscription.restrictions.firstWeekCap - subscription.restrictions.firstWeekUsed) : null
      },
      recommendations: []
    };

    // Add recommendations based on usage patterns
    if (analytics.usage.usagePercentage > 80) {
      analytics.recommendations.push({
        type: 'low_credits',
        message: 'You\'re running low on credits. Consider purchasing a top-up pack or upgrading your plan.',
        action: 'upgrade'
      });
    }

    if (subscription.planId === 'pro_monthly' && analytics.usage.averageCreditsPerDay > 5) {
      analytics.recommendations.push({
        type: 'upgrade_suggestion',
        message: 'Based on your usage, the Annual plan would save you money and provide more credits.',
        action: 'upgrade_annual',
        savings: 189
      });
    }

    res.json({
      success: true,
      data: analytics
    });
  } catch (error) {
    console.error('Error fetching subscription analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch analytics'
    });
  }
});

/**
 * Process subscription status from Cashfree return URL
 * POST /api/v1/subscriptions/process-status
 */
router.post('/process-status', async (req, res) => {
  try {
    const { cf_subscription_id } = req.body;
    
    console.log('🔄 Processing subscription status:', {
      cf_subscription_id,
    });

    if (!cf_subscription_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: cf_subscription_id'
      });
    }

    // Extract userId from cf_subscription_id format: logdhan_sub_{userId}_{timestamp}
    let userId = null;
    if (cf_subscription_id && cf_subscription_id.startsWith('logdhan_sub_')) {
      const parts = cf_subscription_id.split('_');
      if (parts.length >= 3) {
        userId = parts[2];
        console.log('✅ Extracted userId from subscription ID:', userId);
      }
    }

    if (!userId) {
      console.log('❌ Could not extract userId from cf_subscription_id:', cf_subscription_id);
      return res.status(400).json({
        success: false,
        message: 'Invalid cf_subscription_id format - could not extract userId'
      });
    }

    // Validate userId is a valid ObjectId
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      console.log('❌ Extracted userId is not a valid ObjectId:', userId);
      return res.status(400).json({
        success: false,
        message: 'Invalid userId format extracted from subscription ID'
      });
    }

    console.log('✅ Valid userId extracted:', userId);

    // Process the subscription status
    const result = await subscriptionService.processSubscriptionStatus({
      cf_subscription_id
    });
    
    console.log('🔄 Subscription processing result:', result);

    // Send notification to user about subscription processing result
    try {
      let notificationTitle, notificationMessage, notificationType = 'subscription';
      
      if (result.success) {
        notificationTitle = '🎉 Subscription Activated!';
        notificationMessage = `Your ${result.planName || 'premium'} subscription has been successfully activated. You now have access to all premium features.`;
        
        // Also send push notification
        try {
          await firebaseService.sendToUser(
            userId,
            notificationTitle,
            notificationMessage
          );
          console.log('✅ Push notification sent to user:', userId);
        } catch (pushError) {
          console.error('❌ Failed to send push notification:', pushError);
        }
      } else {
        notificationTitle = '❌ Subscription Processing Failed';
        notificationMessage = `There was an issue processing your subscription. Our team has been notified and will resolve this shortly. Contact support if you need immediate assistance.`;
      }

      // Create in-app notification
      const notification = await Notification.createNotification({
        userId: userId,
        title: notificationTitle,
        message: notificationMessage,
        type: notificationType,
        metadata: {
          cf_subscription_id: cf_subscription_id,
          planName: result.planName,
          processing_result: result.success ? 'success' : 'failed',
          processed_at: new Date().toISOString()
        }
      });

      console.log('✅ Notification created:', notification._id);
      
    } catch (notificationError) {
      console.error('❌ Failed to send subscription notification:', notificationError);
      // Don't fail the main request if notification fails
    }
    
    res.json({
      success: true,
      data: result,
      message: 'Subscription status processed successfully'
    });
  } catch (error) {
    console.error('❌ Error processing subscription status:', error);
    
    // Try to send error notification if we have userId
    try {
      const cf_subscription_id = req.body.cf_subscription_id;
      if (cf_subscription_id && cf_subscription_id.startsWith('logdhan_sub_')) {
        const parts = cf_subscription_id.split('_');
        if (parts.length >= 3) {
          const userId = parts[2];
          
          await Notification.createNotification({
            userId: userId,
            title: '⚠️ Subscription Processing Error',
            message: 'There was a technical error processing your subscription. Our team has been notified and will resolve this shortly.',
            type: 'subscription',
            metadata: {
              cf_subscription_id: cf_subscription_id,
              error_message: error.message,
              processed_at: new Date().toISOString()
            }
          });
          
          console.log('✅ Error notification sent to user:', userId);
        }
      }
    } catch (notificationError) {
      console.error('❌ Failed to send error notification:', notificationError);
    }
    
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to process subscription status'
    });
  }
});

/**
 * Handle Cashfree webhook
 * POST /api/v1/subscriptions/webhook
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const payload = JSON.parse(req.body.toString());

    // Process subscription webhook
    const result = await subscriptionService.processSubscriptionWebhook(payload, signature);
    
    res.status(200).json({ 
      success: true,
      processed: result.processed,
      event: result.event,
      action: result.action
    });
  } catch (error) {
    console.error('Subscription webhook error:', error);
    res.status(400).json({ 
      success: false, 
      message: error.message 
    });
  }
});

/**
 * Cancel subscription
 * POST /api/v1/subscriptions/cancel
 */
router.post('/cancel', auth, async (req, res) => {
  try {
    const { reason } = req.body;
    
    const subscription = await subscriptionService.getUserActiveSubscription(req.user.id);
    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'No active subscription found'
      });
    }

    // Update subscription status
    subscription.status = 'CANCELLED';
    subscription.metadata.cancellationReason = reason;
    subscription.metadata.cancelledAt = new Date();
    await subscription.save();

    // Track cancellation
    experienceAnalytics.trackFeatureUsage(
      req.user.id,
      'subscription_cancelled',
      subscription.planId,
      { reason, planId: subscription.planId }
    );

    res.json({
      success: true,
      message: 'Subscription cancelled successfully'
    });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel subscription'
    });
  }
});

/**
 * Pause subscription
 * POST /api/v1/subscriptions/pause
 */
router.post('/pause', auth, async (req, res) => {
  try {
    const subscription = await subscriptionService.getUserActiveSubscription(req.user.id);
    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'No active subscription found'
      });
    }

    subscription.status = 'PAUSED';
    subscription.metadata.pausedAt = new Date();
    await subscription.save();

    res.json({
      success: true,
      message: 'Subscription paused successfully'
    });
  } catch (error) {
    console.error('Error pausing subscription:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to pause subscription'
    });
  }
});

/**
 * POST /api/v1/subscriptions/upgrade
 * Upgrade user's subscription plan with credit carry-over
 */
router.post('/upgrade', auth, async (req, res) => {
  try {
    const { planId } = req.body;
    
    if (!planId) {
      return res.status(400).json({
        success: false,
        message: 'Plan ID is required'
      });
    }

    const result = await subscriptionService.upgradePlan(req.user.id, planId);
    
    res.json({
      success: true,
      data: result,
      message: result.message
    });
  } catch (error) {
    console.error('Error upgrading plan:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to upgrade plan'
    });
  }
});

/**
 * POST /api/v1/subscriptions/reactivate
 * Reactivate expired subscription to previous or upgraded plan
 */
router.post('/reactivate', auth, async (req, res) => {
  try {
    const { planId } = req.body;
    
    if (!planId) {
      return res.status(400).json({
        success: false,
        message: 'Plan ID is required'
      });
    }

    const result = await subscriptionService.reactivateExpiredSubscription(req.user.id, planId);
    
    res.json({
      success: true,
      data: result,
      message: 'Subscription reactivated successfully'
    });
  } catch (error) {
    console.error('Error reactivating subscription:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to reactivate subscription'
    });
  }
});

/**
 * POST /api/v1/subscriptions/watch-ad
 * Award credits for watching a rewarded ad
 */
router.post('/watch-ad', auth, async (req, res) => {
  try {
    const { adProvider, adUnitId, adReward } = req.body;
    
    const result = await subscriptionService.processRewardedAd(req.user.id, {
      adProvider,
      adUnitId,
      adReward
    });
    
    res.json({
      success: true,
      data: result,
      message: `Earned ${result.creditsAwarded} credits! Watch ${result.adsRemainingToday} more ads today.`
    });
  } catch (error) {
    console.error('Error processing rewarded ad:', error);
    res.status(400).json({
      success: false,
      message: error.message || 'Failed to process ad reward'
    });
  }
});

/**
 * GET /api/v1/subscriptions/ad-status
 * Get user's ad watching status and limits
 */
router.get('/ad-status', auth, async (req, res) => {
  try {
    const subscription = await subscriptionService.getUserActiveSubscription(req.user.id);
    
    if (!subscription) {
      return res.status(404).json({
        success: false,
        message: 'No active subscription found'
      });
    }

    // Clean up expired rewarded credits
    subscription.cleanupExpiredCredits();
    
    const now = new Date();
    const isToday = subscription.credits.lastRewardedDate && 
                   subscription.credits.lastRewardedDate.toDateString() === now.toDateString();
    
    // Get ad limit from plan restrictions
    const plan = await subscriptionService.getPlanById(subscription.planId);
    // console.log(`🔍 Ad Status Debug - planId: ${subscription.planId}`);
    // console.log(`🔍 Ad Status Debug - plan found: ${plan ? 'yes' : 'no'}`);
    // console.log(`🔍 Ad Status Debug - plan.restrictions:`, plan?.restrictions);
    // console.log(`🔍 Ad Status Debug - plan.restrictions.rewardedAdLimit:`, plan?.restrictions?.rewardedAdLimit);
    
    const dailyLimit = plan?.restrictions?.rewardedAdLimit || 0; // Default 0 for non-ad plans (0 means unlimited)
    const adsWatchedToday = isToday ? subscription.credits.dailyRewardedCount : 0;
    // If dailyLimit is 0 (unlimited), return 999 for UI, otherwise calculate remaining
    const adsRemainingToday = dailyLimit === 0 ? 999 : Math.max(0, dailyLimit - adsWatchedToday);
    const creditsPerAd = 1;
    
    console.log(`🔍 Ad Status Debug - dailyLimit: ${dailyLimit}, adsWatchedToday: ${adsWatchedToday}, adsRemainingToday: ${adsRemainingToday}`);
    console.log(`🔍 Ad Status Debug - isToday: ${isToday}, subscription.credits.dailyRewardedCount: ${subscription.credits.dailyRewardedCount}`);
    
    res.json({
      success: true,
      data: {
        canWatchAd: dailyLimit === 0 ? true : adsRemainingToday > 0,
        adsWatchedToday,
        adsRemainingToday,
        dailyLimit,
        creditsPerAd,
        currentRewardedCredits: subscription.credits.rewardedCredits,
        rewardedCreditsExpiry: subscription.credits.lastRewardedDate ? 
          new Date(subscription.credits.lastRewardedDate.getFullYear(), 
                   subscription.credits.lastRewardedDate.getMonth(), 
                   subscription.credits.lastRewardedDate.getDate() + 1, 0, 0, 0, 0) : null,
        showAds: true // All users can watch ads now - free users get them always, paid users when credits exhausted
      }
    });
  } catch (error) {
    console.error('Error fetching ad status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch ad status'
    });
  }
});

/**
 * Create test notification (for debugging)
 * POST /api/v1/subscriptions/test-notification
 */
router.post('/test-notification', auth, async (req, res) => {
  try {
    console.log('🧪 Creating test notification for user:', req.user.id);
    
    // Create test notification
    const notification = await Notification.createNotification({
      userId: req.user.id,
      title: '🧪 Test Notification',
      message: 'This is a test notification to verify the notification system is working correctly.',
      type: 'system',
      metadata: {
        test: true,
        created_at: new Date().toISOString()
      }
    });

    console.log('✅ Test notification created:', notification._id);
    
    // Also try to send push notification
    try {
      await firebaseService.sendToUser(
        req.user.id,
        '🧪 Test Notification',
        'This is a test push notification!'
      );
      console.log('✅ Test push notification sent');
    } catch (pushError) {
      console.error('❌ Test push notification failed:', pushError);
    }
    
    res.json({
      success: true,
      data: {
        notificationId: notification._id,
        message: 'Test notification created successfully'
      }
    });
  } catch (error) {
    console.error('❌ Error creating test notification:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create test notification'
    });
  }
});

export default router;