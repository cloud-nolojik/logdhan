import axios from 'axios';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Plan } from '../../models/plan.js';
import { Subscription } from '../../models/subscription.js';
import { User } from '../../models/user.js';
import { cashfreeSubscriptionService } from './cashfreeSubscriptionService.js';

class SubscriptionService {
  constructor() {
    this.cashfreeClientId = process.env.CASHFREE_CLIENT_ID;
    this.cashfreeClientSecret = process.env.CASHFREE_CLIENT_SECRET;
    this.cashfreeBaseUrl = process.env.NODE_ENV === 'production' 
      ? 'https://api.cashfree.com/pg' 
      : 'https://sandbox.cashfree.com/pg';
    this.webhookSecret = process.env.CASHFREE_WEBHOOK_SECRET;
  }

  /**
   * Initialize default subscription plans
   */
  async initializeDefaultPlans() {
    const defaultPlans = [
      {
        planId: 'trial_free',
        name: '1 Month Free Trial',
        description: '30-day free trial with up to 3 stocks',
        type: 'TRIAL',
        price: 0,
        stockLimit: 3,
        features: [
          '30-day free trial',
          'Add up to 3 stocks to watchlist',
          'AI stock analysis',
          'Basic insights and recommendations',
          'WhatsApp alerts'
        ],
        recurringType: 'ONE_TIME',
        billingCycle: 'ONE_TIME',
        maxAmount: 0,
        recurringAmount: 0,
        costCap: 0,
        grossMargin: 0,
        pipelineAccess: 'FULL',
        // showAds: false, // COMMENTED OUT - No ads concept
        analysisLevel: 'advanced',
        // creditRollover: { enabled: false }, // COMMENTED OUT - No credits concept
        restrictions: {
          stockLimit: 3,
          trialDurationDays: 30
          // dailyReviewLimit: 0,    // COMMENTED OUT - No credits concept
          // weeklyReviewLimit: 0    // COMMENTED OUT - No credits concept
        },
        sortOrder: 0
      },
      {
        planId: 'basic_monthly',
        cashfreePlanId: 'basic_monthly',
        name: 'Basic Plan',
        description: '30-day plan for up to 10 stocks',
        type: 'MONTHLY',
        price: 999,
        stockLimit: 10,
        features: [
          'Add up to 10 stocks to watchlist',
          'Advanced AI analysis',
          'Real-time WhatsApp alerts',
          'Priority support',
          'Unlimited stock analysis'
        ],
        recurringType: 'PERIODIC',
        billingCycle: 'MONTHLY',
        maxAmount: 999,
        recurringAmount: 999,
        costCap: 699,
        grossMargin: 300,
        pipelineAccess: 'FULL',
        // showAds: false, // COMMENTED OUT - No ads concept
        analysisLevel: 'advanced',
        // creditRollover: { enabled: false }, // COMMENTED OUT - No credits concept
        restrictions: {
          stockLimit: 10
          // dailyReviewLimit: 0,   // COMMENTED OUT - No credits concept
          // weeklyReviewLimit: 0   // COMMENTED OUT - No credits concept
        },
        sortOrder: 1
      },
      {
        planId: 'pro_monthly',
        cashfreePlanId: 'pro_monthly',
        name: 'Pro Plan',
        description: '30-day plan for up to 20 stocks',
        type: 'MONTHLY',
        price: 1999,
        stockLimit: 20,
        features: [
          'Add up to 20 stocks to watchlist',
          'Advanced AI analysis',
          'Real-time WhatsApp alerts',
          'Priority support',
          'Unlimited stock analysis',
          'Portfolio insights'
        ],
        recurringType: 'PERIODIC',
        billingCycle: 'MONTHLY',
        maxAmount: 1999,
        recurringAmount: 1999,
        costCap: 1399,
        grossMargin: 600,
        pipelineAccess: 'FULL',
        // showAds: false, // COMMENTED OUT - No ads concept
        analysisLevel: 'advanced',
        // creditRollover: { enabled: false }, // COMMENTED OUT - No credits concept
        restrictions: {
          stockLimit: 20
          // dailyReviewLimit: 0,    // COMMENTED OUT - No credits concept
          // weeklyReviewLimit: 0    // COMMENTED OUT - No credits concept
        },
        sortOrder: 2
      },
      {
        planId: 'premium_monthly',
        cashfreePlanId: 'premium_monthly',
        name: 'Premium Plan',
        description: '30-day plan for up to 30 stocks',
        type: 'MONTHLY',
        price: 2999,
        stockLimit: 30,
        features: [
          'Add up to 30 stocks to watchlist',
          'Advanced AI analysis',
          'Real-time WhatsApp alerts',
          'Priority support',
          'Unlimited stock analysis',
          'Portfolio insights',
          'Custom alerts and strategies'
        ],
        recurringType: 'PERIODIC',
        billingCycle: 'MONTHLY',
        maxAmount: 2999,
        recurringAmount: 2999,
        costCap: 2099,
        grossMargin: 900,
        pipelineAccess: 'FULL',
        // showAds: false, // COMMENTED OUT - No ads concept
        analysisLevel: 'advanced',
        // creditRollover: { enabled: false }, // COMMENTED OUT - No credits concept
        restrictions: {
          stockLimit: 30
          // dailyReviewLimit: 0,    // COMMENTED OUT - No credits concept
          // weeklyReviewLimit: 0    // COMMENTED OUT - No credits concept
        },
        sortOrder: 3
      }
    ];

    for (const planData of defaultPlans) {
      const updatedPlan = await Plan.findOneAndUpdate(
        { planId: planData.planId },
        planData,
        { upsert: true, new: true }
      );
      //console.log(`✅ Plan ${planData.planId} initialized/updated with restrictions:`, updatedPlan.restrictions);
    }

    //console.log('✅ Default subscription plans initialized');
  }

  /**
   * Get all active subscription plans
   */
  async getActivePlans() {
    return await Plan.getActivePlans();
  }

  /**
   * Get plan by ID
   */
  async getPlanById(planId) {
    return await Plan.getPlanById(planId);
  }

  /**
   * Create Cashfree subscription plan
   */
  async createCashfreePlan(plan) {
    try {
      const cashfreePlanData = await cashfreeSubscriptionService.createSubscriptionPlan(plan);
      
      // Update local plan with Cashfree plan ID
      await Plan.findOneAndUpdate(
        { planId: plan.planId },
        { cashfreePlanId: cashfreePlanData.plan_id }
      );

      return cashfreePlanData;
    } catch (error) {
      console.error('Error creating Cashfree plan:', error);
      throw error;
    }
  }

  /**
   * Create subscription for user
   */
  async createSubscription(userId, planId, paymentDetails = {}) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const plan = await this.getPlanById(planId);
      if (!plan) {
        throw new Error('Plan not found');
      }

      // // Check if user already has an active subscription
      const existingSubscription = await Subscription.findActiveForUser(userId);
      if (existingSubscription) {
        throw new Error('User already has an active subscription');
      }

      // Generate unique subscription ID
      const subscriptionId = `sub_${userId}_${planId}_${Date.now()}`;
    
      let cashfreeResponse = null;
      let paymentUrl = null;
      let sessionId = null;

      //console.log(`Creating trial subscription for ${planId} - no Cashfree integration needed`);
      

      // Set expiry based on plan type
      const now = new Date();
      let endDate;
      
      // Calculate endDate based on plan type
      if (plan.type === 'FREE_LIFETIME' || planId === 'basic_ads') {
        // For lifetime/free plans, set to 100 years (effectively lifetime)
        endDate = new Date(now.getFullYear() + 100, now.getMonth(), now.getDate());
      } else if (planId === 'pro_monthly') {
        // Monthly plan: add 30 days
        endDate = new Date(now);
        endDate.setDate(endDate.getDate() + 30);
      } else if (planId === 'pro_annual') {
        // Annual plan: add 365 days
        endDate = new Date(now);
        endDate.setDate(endDate.getDate() + 365);
      } else {
        // Default fallback: 30 days
        endDate = new Date(now);
        endDate.setDate(endDate.getDate() + 30);
      }


      
     
      const subscription = new Subscription({
        userId,
        subscriptionId, // Required unique ID
        planId: plan.planId, // Required field
        planName: plan.name, // Required field
        nextResetAt: endDate, // Required field - when credits reset next
        planCredits: 0, // Legacy field - not used in stockLimit-based model
        status: 'ACTIVE', // Free plans start active
        pricing: {
          amount: plan.price,
          stockLimit: plan.stockLimit,
          billingCycle: plan.billingCycle
        },
        stockLimit: plan.stockLimit,
        // Cashfree fields are now optional and null for free plans
        cashfreeSubscriptionId: null,
        cashfreeSessionId: null,
        credits: {
          total: 0, // Legacy field - using stockLimit instead
          used: 0,
          remaining: 0,
          rollover: 0,
          earnedCredits: 0,
          bonusCredits: 0,
          bonusCreditsExpiry: null,
          rewardedCredits: 0,
          dailyRewardedCount: 0,
          lastRewardedDate: null
        },
        restrictions: {
          firstWeekUsed: 0,
          firstWeekCap: plan.restrictions?.firstWeekCap || null,
          pipelineAccess: plan.pipelineAccess || 'FULL'
        },
        billing: {
          startDate: now,
          endDate: endDate,
          nextBillingDate: plan.type === 'FREE_LIFETIME' ? null : endDate,
          lastBillingDate: null
        },
        paymentMethod: {
          type: null,
          details: null
        },
        notifications: {
          emailReminders: true,
          pushNotifications: true,
          lowCreditWarning: true
        },
        dailyUsage: {
          date: new Date().toDateString(),
          reviewCount: 0,
          rewardedAdCount: 0
        },
        metadata: {
          source: paymentDetails.source || 'web',
          campaignId: paymentDetails.campaignId || null,
          referralCode: paymentDetails.referralCode || null
        }
      });

      await subscription.save();

      // For trial and lifetime free plans, activate immediately  
      if (plan.type === 'TRIAL' || plan.type === 'FREE_LIFETIME') {
        await this.activateSubscription(subscription._id);
      }

      return {
        subscription
      };

    } catch (error) {
      console.error('Error creating subscription:', error);
      throw error;
    }
  }

  /**
   * Activate subscription
   */
  async activateSubscription(subscriptionId) {
    try {
      const subscription = await Subscription.findById(subscriptionId);
      if (!subscription) {
        throw new Error('Subscription not found');
      }

      subscription.status = 'ACTIVE';
      await subscription.save();

      //console.log(`✅ Subscription activated: ${subscription.subscriptionId}`);
      return subscription;

    } catch (error) {
      console.error('Error activating subscription:', error);
      throw error;
    }
  }


  /**
   * Upgrade user's subscription plan with pro-rated credit carry-over
   */
  async upgradePlan(userId, newPlanId) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const subscription = await Subscription.findOne({ 
        userId, 
        status: 'ACTIVE' 
      }).session(session);
      
      if (!subscription) {
        throw new Error('No active subscription found');
      }

      const newPlan = await this.getPlanById(newPlanId);
      if (!newPlan) {
        throw new Error('New plan not found');
      }

      const oldPlan = await this.getPlanById(subscription.planId);
      if (!oldPlan) {
        throw new Error('Current plan not found');
      }

      // Validate upgrade/downgrade rules
      const currentPlan = subscription.planId;
      const targetPlan = newPlanId;
      
      // Rule 1: Can't "upgrade" to same plan
      if (currentPlan === targetPlan) {
        throw new Error('Already subscribed to this plan');
      }
      
      // Rule 2: Can't go back to basic once you've had paid subscription
      if (targetPlan === 'basic_ads' && currentPlan !== 'basic_ads') {
        throw new Error('Cannot downgrade to free plan from paid subscription');
      }
      
      // Rule 3: Can't downgrade from yearly to monthly (must wait for expiry)
      if (currentPlan === 'pro_annual' && targetPlan === 'pro_monthly') {
        const now = new Date();
        const timeRemaining = subscription.billing.endDate - now;
        const daysRemaining = Math.ceil(timeRemaining / (1000 * 60 * 60 * 24));
        throw new Error(`Cannot downgrade to monthly plan. Your annual plan expires in ${daysRemaining} days. Please wait for expiry.`);
      }
      
      // Rule 4: Valid upgrade paths
      const validUpgrades = {
        'basic_ads': ['pro_monthly', 'pro_annual'],
        'pro_monthly': ['pro_annual'], // Monthly can upgrade to yearly
        'pro_annual': [] // Yearly cannot downgrade
      };
      
      if (!validUpgrades[currentPlan]?.includes(targetPlan)) {
        throw new Error(`Invalid upgrade path from ${oldPlan.name} to ${newPlan.name}`);
      }

      // Determine upgrade/downgrade behavior
      const isUpgrade = newPlan.credits > oldPlan.credits;
      const isSidegrade = newPlan.credits === oldPlan.credits;
      
      // Calculate unused credits
      const unused = Math.max(0, subscription.credits.remaining + subscription.credits.rollover);
      
      // Calculate rollover cap (50% of new plan's credits)
      const rolloverCap = Math.floor(newPlan.credits * 0.5);
      
      let carryCredits = 0;
      let behavior = '';

      if (subscription.planId === 'basic_ads') {
        // Basic free to paid plan: no credits carry over
        carryCredits = 0;
        behavior = 'free_to_paid_no_rollover';
      } else if (currentPlan === 'pro_monthly' && targetPlan === 'pro_annual') {
        // Special case: Monthly to Yearly upgrade with pro-rating
        const now = new Date();
        const timeRemaining = subscription.billing.endDate - now;
        const daysRemaining = Math.ceil(timeRemaining / (1000 * 60 * 60 * 24));
        
        // Pro-rate unused monthly credits to yearly equivalent
        const monthlyProgress = (30 - daysRemaining) / 30; // How much of monthly period used
        const proratedCredits = Math.floor(unused * (365/30)); // Convert monthly unused to yearly scale
        
        carryCredits = Math.min(proratedCredits, rolloverCap);
        behavior = 'monthly_to_yearly_prorated';
        
        //console.log(`📊 Pro-rating: ${daysRemaining} days remaining, ${unused} unused monthly credits → ${proratedCredits} yearly equivalent, carrying ${carryCredits}`);
      } else {
        // Regular upgrade: carry unused up to rollover limit
        carryCredits = Math.min(unused, rolloverCap);
        behavior = 'carry_credits';
      }

      // Update subscription
      subscription.planId = newPlanId;
      subscription.planName = newPlan.name; // Update plan name
      subscription.planCredits = newPlan.credits;
      subscription.credits.total = newPlan.credits + carryCredits;
      subscription.credits.remaining = newPlan.credits + carryCredits;
      subscription.credits.used = 0; // Reset usage for new cycle
      subscription.credits.rollover = 0; // Clear old rollover
      subscription.credits.rolloverBuffer = carryCredits;
      subscription.pricing.amount = newPlan.price;
      subscription.pricing.credits = newPlan.credits;
      subscription.pricing.billingCycle = newPlan.billingCycle;
      
      // Update Cashfree subscription ID if upgrading to paid plan
      if (newPlan.price > 0 && !subscription.cashfreeSubscriptionId) {
        // For upgrades to paid plans, Cashfree subscription will be set during payment flow
        subscription.cashfreeSubscriptionId = null;
        subscription.cashfreeSessionId = null;
      }

      // Update billing dates
      const now = new Date();
      subscription.billing.startDate = now;
      
      if (newPlan.billingCycle === 'MONTHLY') {
        subscription.billing.endDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
        subscription.nextResetAt = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
      } else if (newPlan.billingCycle === 'YEARLY') {
        subscription.billing.endDate = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
        subscription.nextResetAt = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
      }

      await subscription.save({ session });

      // Record the upgrade event

      await session.commitTransaction();

      //console.log(`✅ Plan upgraded: ${oldPlan.name} → ${newPlan.name} for user ${userId}. Carried ${carryCredits}/${unused} credits.`);
      
      return {
        subscription,
        carryCredits,
        unusedCredits: unused,
        behavior,
        message: `Upgraded to ${newPlan.name}. ${carryCredits} credits carried over.`
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('Error upgrading plan:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Add monthly credit reset to existing job
   */
  async processMonthlyReset() {
    try {
      const now = new Date();
      const subscriptionsToReset = await Subscription.find({
        status: 'ACTIVE',
        nextResetAt: { $lte: now }
      });

      let resetCount = 0;

      for (const subscription of subscriptionsToReset) {
        try {
          const rolloverCap = Math.floor(subscription.planCredits * 0.5);
          const currentRemaining = subscription.credits.remaining;
          const rollover = Math.min(currentRemaining, rolloverCap);

          // Reset credits with rollover
          subscription.credits.total = subscription.planCredits + rollover;
          subscription.credits.remaining = subscription.planCredits + rollover;
          subscription.credits.used = 0;
          subscription.credits.rollover = rollover;
          subscription.credits.rolloverBuffer = rollover;

          // Update next reset date
          if (subscription.pricing.billingCycle === 'MONTHLY') {
            subscription.nextResetAt = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
          }

          await subscription.save();

          // Record credit reset

          resetCount++;
          //console.log(`Monthly reset for user ${subscription.userId}: ${subscription.planCredits} + ${rollover} rollover`);

        } catch (error) {
          console.error(`Error resetting subscription ${subscription._id}:`, error);
        }
      }

      return resetCount;
    } catch (error) {
      console.error('Error in processMonthlyReset:', error);
      throw error;
    }
  }

  /**
   * Handle Cashfree webhook with idempotency and signature verification
   */
  async handleWebhook(payload, signature, idempotencyKey) {
    try {
      // Verify webhook signature
      if (!this.verifyWebhookSignature(payload, signature)) {
        throw new Error('Invalid webhook signature');
      }

      // Check idempotency to prevent duplicate processing
      if (idempotencyKey) {
        const existingProcess = await this.checkWebhookIdempotency(idempotencyKey);
        if (existingProcess) {
          //console.log(`Webhook already processed: ${idempotencyKey}`);
          return existingProcess;
        }
      }

      const event = payload.data;
      const subscriptionId = event.subscription?.subscription_id;
      const paymentId = event.payment?.cf_payment_id;

      if (!subscriptionId) {
        //console.log('No subscription ID in webhook payload');
        return;
      }

      const subscription = await Subscription.findOne({
        cashfreeSubscriptionId: subscriptionId
      });

      if (!subscription) {
        //console.log(`Subscription not found for ID: ${subscriptionId}`);
        return;
      }

      let result;
      
      // Handle different event types
      switch (payload.type) {
        case 'SUBSCRIPTION_AUTHENTICATION_SUCCESSFUL':
          result = await this.activateSubscription(subscription._id);
          break;

        case 'SUBSCRIPTION_CHARGED_SUCCESSFULLY':
          result = await this.handleSuccessfulCharge(subscription, event, paymentId);
          break;

        case 'PAYMENT_AUTHORIZED': // Handle authorization but not captured
          result = await this.handlePaymentAuthorized(subscription, event, paymentId);
          break;

        case 'SUBSCRIPTION_CHARGE_FAILED':
          result = await this.handleFailedCharge(subscription, event);
          break;

        case 'SUBSCRIPTION_CANCELLED':
          subscription.status = 'CUSTOMER_CANCELLED';
          result = await subscription.save();
          break;

        case 'SUBSCRIPTION_PAUSED':
          subscription.status = 'CUSTOMER_PAUSED';
          result = await subscription.save();
          break;

        default:
          //console.log(`Unhandled webhook event type: ${payload.type}`);
          result = { message: 'Event type not handled' };
      }

      // Store idempotency record
      if (idempotencyKey) {
        await this.storeWebhookIdempotency(idempotencyKey, result);
      }

      return result;

    } catch (error) {
      console.error('Error handling webhook:', error);
      throw error;
    }
  }

  /**
   * Check webhook idempotency
   */
  async checkWebhookIdempotency(idempotencyKey) {
    try {
      // TODO: Implement Redis or MongoDB collection for idempotency tracking
      // For now, log the check
      //console.log(`Checking idempotency for key: ${idempotencyKey}`);
      return null; // No previous processing found
    } catch (error) {
      console.error('Error checking webhook idempotency:', error);
      return null;
    }
  }

  /**
   * Store webhook idempotency record
   */
  async storeWebhookIdempotency(idempotencyKey, result) {
    try {
      // TODO: Store in Redis with 24h TTL or MongoDB collection
      //console.log(`Storing idempotency record: ${idempotencyKey}`);
    } catch (error) {
      console.error('Error storing webhook idempotency:', error);
    }
  }

  /**
   * Handle payment authorized but not captured edge case
   */
  async handlePaymentAuthorized(subscription, event, paymentId) {
    try {
      //console.log(`Payment authorized but not captured: ${paymentId} for subscription: ${subscription.cashfreeSubscriptionId}`);
      
      // Mark as pending capture
      subscription.status = 'BANK_APPROVAL_PENDING';
      subscription.metadata.lastPaymentId = paymentId;
      subscription.metadata.paymentStatus = 'AUTHORIZED';
      
      await subscription.save();
      
      // TODO: Set up a job to check capture status after some time
      // or trigger manual capture if needed
      
      return subscription;
    } catch (error) {
      console.error('Error handling authorized payment:', error);
      throw error;
    }
  }

  /**
   * Make authenticated request to Cashfree API
   */
  async makeCashfreeRequest(method, endpoint, data = null) {
    try {
      const config = {
        method,
        url: `${this.cashfreeBaseUrl}${endpoint}`,
        headers: {
          'Content-Type': 'application/json',
          'x-api-version': '2023-08-01',
          'x-client-id': this.cashfreeClientId,
          'x-client-secret': this.cashfreeClientSecret
        }
      };

      if (data) {
        config.data = data;
      }

      const response = await axios(config);
      return response.data;

    } catch (error) {
      console.error('Cashfree API error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Verify Cashfree webhook signature
   */
  verifyWebhookSignature(payload, signature) {
    if (!this.webhookSecret) {
      console.warn('Webhook secret not configured, skipping signature verification');
      return true;
    }

    const expectedSignature = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(JSON.stringify(payload))
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }

  /**
   * Handle successful charge
   */
  async handleSuccessfulCharge(subscription, event) {
    try {
      // For recurring subscriptions, reset credits for new billing cycle
      const plan = await this.getPlanById(subscription.planId);
      if (!plan) return;

      // Calculate rollover credits (up to 50% for paid plans, 0% for free plans)
      let rolloverCredits = 0;
      if (plan.creditRollover.enabled && subscription.credits.remaining > 0 && subscription.planId !== 'basic_ads') {
        const maxRollover = Math.floor(plan.credits * (plan.creditRollover.maxPercentage / 100));
        rolloverCredits = Math.min(subscription.credits.remaining, maxRollover);
      } else if (subscription.planId === 'basic_ads') {
        // Free plan credits never roll over to paid plans
        rolloverCredits = 0;
        //console.log(`Free plan credits (${subscription.credits.remaining}) will not roll over to ${plan.name}`);
      }

      // Reset credits for new billing cycle
      subscription.credits.total = plan.credits;
      subscription.credits.used = 0;
      subscription.credits.remaining = plan.credits;
      subscription.credits.rollover = rolloverCredits;

      // Reset first week usage for annual plans
      if (plan.billingCycle === 'YEARLY') {
        subscription.restrictions.firstWeekUsed = 0;
      }

      // Update billing dates
      const nextBillingDate = new Date(subscription.billing.nextBillingDate);
      subscription.billing.lastBillingDate = new Date();
      
      if (plan.billingCycle === 'MONTHLY') {
        nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
      } else if (plan.billingCycle === 'YEARLY') {
        nextBillingDate.setFullYear(nextBillingDate.getFullYear() + 1);
      }
      
      subscription.billing.nextBillingDate = nextBillingDate;
      subscription.billing.endDate = nextBillingDate;

      await subscription.save();

      // Update user credits
      const user = await User.findById(subscription.userId);
      if (user) {
        user.credits = (user.credits || 0) + plan.credits + rolloverCredits;
        await user.save();

        // Record credit history
      }

      //console.log(`✅ Subscription renewed: ${subscription.subscriptionId}`);

    } catch (error) {
      console.error('Error handling successful charge:', error);
      throw error;
    }
  }

  /**
   * Handle failed charge
   */
  async handleFailedCharge(subscription, event) {
    try {
      subscription.status = 'ON_HOLD';
      await subscription.save();
      
      //console.log(`⚠️ Subscription payment failed: ${subscription.subscriptionId}`);
      
      // TODO: Send notification to user about failed payment
      
    } catch (error) {
      console.error('Error handling failed charge:', error);
      throw error;
    }
  }

  /**
   * Get user's active subscription (with expiry handling)
   */
  async getUserActiveSubscription(userId) {
    const subscription = await Subscription.findOne({
      userId,
      status: { $in: ['ACTIVE', 'EXPIRED', 'GRACE_PERIOD'] },
    }).sort({ createdAt: -1 });

    if (!subscription) return null;

    // Check if subscription needs status update
    await this.checkAndUpdateSubscriptionStatus(subscription);
    
    return subscription;
  }

  /**
   * Check and update subscription status based on expiry
   */
  async checkAndUpdateSubscriptionStatus(subscription) {
    const now = new Date();
    const endDate = subscription.billing.endDate;
    const gracePeriodDays = 3; // 3 days grace period
    const gracePeriodEnd = new Date(endDate.getTime() + (gracePeriodDays * 24 * 60 * 60 * 1000));

    // Skip status updates for lifetime free plans
    if (subscription.planId === 'basic_ads') {
      return subscription;
    }

    if (now > gracePeriodEnd && subscription.status !== 'EXPIRED') {
      // Grace period over - downgrade to basic
      //console.log(`⬇️ Downgrading expired subscription ${subscription.subscriptionId} to basic plan`);
      
      await this.downgradeToBasicPlan(subscription);
      
    } else if (now > endDate && now <= gracePeriodEnd && subscription.status === 'ACTIVE') {
      // Just expired - enter grace period
      //console.log(`⏰ Moving subscription ${subscription.subscriptionId} to grace period`);
      
      subscription.status = 'GRACE_PERIOD';
      subscription.metadata = {
        ...subscription.metadata,
        gracePeriodStart: now,
        gracePeriodEnd: gracePeriodEnd,
        originalPlan: subscription.planId
      };
      await subscription.save();
    }

    return subscription;
  }

  /**
   * Downgrade expired subscription to basic plan
   */
  async downgradeToBasicPlan(subscription) {
    const basicPlan = await this.getPlanById('basic_ads');
    
    // Store original plan info for potential reactivation
    subscription.metadata = {
      ...subscription.metadata,
      expiredPlan: subscription.planId,
      expiredPlanName: subscription.planName,
      expiredAt: new Date(),
      canReactivate: true
    };
    
    // Update to basic plan
    subscription.planId = 'basic_ads';
    subscription.planName = basicPlan.name;
    subscription.planCredits = basicPlan.credits;
    subscription.status = 'ACTIVE'; // Basic is always active
    subscription.cashfreeSubscriptionId = null; // Clear Cashfree reference
    subscription.cashfreeSessionId = null;
    
    // Reset credits to basic plan limits
    subscription.credits = {
      total: basicPlan.credits,
      used: 0,
      remaining: basicPlan.credits,
      rollover: 0,
      earnedCredits: subscription.credits.earnedCredits || 0, // Keep earned credits
      bonusCredits: 0,
      bonusCreditsExpiry: null,
      rewardedCredits: 0,
      dailyRewardedCount: 0,
      lastRewardedDate: null
    };
    
    // Update pricing and billing for basic plan (lifetime)
    subscription.pricing = {
      amount: 0,
      credits: basicPlan.credits,
      billingCycle: 'ONE_TIME'
    };
    
    const now = new Date();
    subscription.billing = {
      startDate: now,
      endDate: new Date(now.getFullYear() + 100, now.getMonth(), now.getDate()), // 100 years
      nextBillingDate: null,
      lastBillingDate: null
    };
    subscription.nextResetAt = new Date(now.getFullYear() + 100, now.getMonth(), now.getDate());
    
    await subscription.save();
    
    //console.log(`✅ Subscription downgraded to basic plan: ${subscription.subscriptionId}`);
    return subscription;
  }

  /**
   * Reactivate expired subscription to previous paid plan
   */
  async reactivateExpiredSubscription(userId, planId) {
    try {
      const subscription = await Subscription.findOne({
        userId,
        status: 'ACTIVE',
        planId: 'basic_ads',
        'metadata.canReactivate': true
      });

      if (!subscription || !subscription.metadata.expiredPlan) {
        throw new Error('No reactivatable subscription found');
      }

      // Validate the planId matches expired plan or is a valid upgrade
      const expiredPlan = subscription.metadata.expiredPlan;
      const validReactivationPlans = [expiredPlan];
      
      // Allow upgrading during reactivation (monthly→yearly)
      if (expiredPlan === 'pro_monthly') {
        validReactivationPlans.push('pro_annual');
      }
      
      if (!validReactivationPlans.includes(planId)) {
        throw new Error(`Cannot reactivate to ${planId}. Can only reactivate to: ${validReactivationPlans.join(', ')}`);
      }

      // Use regular upgrade flow which will handle payment
      return await this.upgradePlan(userId, planId);

    } catch (error) {
      console.error('Error reactivating subscription:', error);
      throw error;
    }
  }

  /**
   * Check if user can use credits
   */
  async canUserUseCredits(userId, creditsNeeded = 1, isFromRewardedAd = false) {
    const subscription = await this.getUserActiveSubscription(userId);
    
    if (!subscription) {
      return { canUse: false, reason: 'No active subscription' };
    }

   // //console.log(`canUserUseCredits called for user ${userId}, planId: ${subscription.planId}`);

    // Get plan to check daily/weekly restrictions
    const plan = await this.getPlanById(subscription.planId);
    if (plan && plan.restrictions) {
      const now = new Date();
      const today = now.toDateString();
      
      // Initialize daily tracking if needed
      if (!subscription.dailyUsage) {
        subscription.dailyUsage = {
          date: today,
          reviewCount: 0,
          rewardedAdCount: 0
        };
      }
      
      // Reset counter if new day
      if (subscription.dailyUsage.date !== today) {
        subscription.dailyUsage = {
          date: today,
          reviewCount: 0,
          rewardedAdCount: 0
        };
      }
      
      // Special handling for basic_ads plan
      if (subscription.planId === 'basic_ads') {
        const totalReviewsToday = subscription.dailyUsage.reviewCount + subscription.dailyUsage.rewardedAdCount;
        const dailyLimit = plan.restrictions.dailyReviewLimit || 7;
        
        if (isFromRewardedAd) {
          // Allow unlimited ad reviews for basic plan
          //console.log(`Ad-based review allowed - no limits on ad reviews for basic plan`);
          // Remove daily ad limit restriction - users can watch unlimited ads
          
          // No total daily limit for basic plan with ads - allow unlimited
          //console.log(`Total reviews today: ${totalReviewsToday} - no limit enforced for basic plan with ads`);
        } else {
          // For non-ad reviews on basic plan, allow unlimited reviews
          // Users can always watch ads to get more reviews - no daily limits
          //console.log(`Basic plan non-ad review allowed - no daily restrictions, user can watch ads anytime`);
        }
      } else {
        // For paid plans (pro_monthly, pro_yearly) - no daily limits, only check credit pool
        // Skip daily limit checks - let them use their monthly/yearly credits freely
        //console.log(`Paid plan ${subscription.planId} - checking credit pool only, no daily restrictions`);
      }
    }

    if (!subscription.canUseCredits(creditsNeeded)) {
      // Different messages based on plan type
      if (subscription.planId === 'basic_ads') {
        return { 
          canUse: false, 
          reason: 'Daily free review limit reached. Watch an ad to unlock more reviews.',
          showAdOption: true 
        };
      } else {
        return { 
          canUse: false, 
          reason: 'Monthly/Yearly credits exhausted. Watch an ad for more reviews or wait for next billing cycle.',
          showAdOption: true 
        };
      }
    }

    // Always return daily usage stats for dashboard display
    let dailyUsageStats = {};
    
    // Initialize daily usage if not present
    if (!subscription.dailyUsage) {
      const today = new Date().toDateString();
      subscription.dailyUsage = {
        date: today,
        reviewCount: 0,
        rewardedAdCount: 0
      };
    }
    
    if (plan && plan.restrictions) {
      if (subscription.planId === 'basic_ads') {
        const totalReviewsToday = subscription.dailyUsage.reviewCount + subscription.dailyUsage.rewardedAdCount;
        const dailyLimit = plan.restrictions.dailyReviewLimit || 7;
        dailyUsageStats = {
          limit: dailyLimit,
          used: totalReviewsToday
        };
      } else {
        // Pro plans - show total credit pool instead of daily limits
        const totalCredits = subscription.getTotalAvailableCredits();
        const planCredits = subscription.planId === 'pro_monthly' ? 125 : 2000;
        dailyUsageStats = {
          limit: 0, // 0 indicates no daily limit
          used: subscription.dailyUsage.reviewCount,
          totalCredits: totalCredits,
          planCredits: planCredits,
          unlimited: true
        };
      }
    } else {
      // Fallback if plan or restrictions missing
      //console.log('Warning: Plan or restrictions missing for subscription:', subscription.planId);
      if (subscription.planId === 'basic_ads') {
        dailyUsageStats = {
          limit: 7,
          used: (subscription.dailyUsage?.reviewCount || 0) + (subscription.dailyUsage?.rewardedAdCount || 0)
        };
      } else {
        dailyUsageStats = {
          limit: 5,
          used: subscription.dailyUsage?.reviewCount || 0
        };
      }
    }

    const result = { canUse: true, subscription, ...dailyUsageStats };
    //console.log(`canUserUseCredits returning:`, { 
    //   canUse: result.canUse, 
    //   limit: result.limit, 
    //   used: result.used,
    //   planId: subscription.planId,
    //   dailyUsage: subscription.dailyUsage
    // });
    return result;
  }

  /**
   * Deduct credits from subscription
   */
  async deductCredits(userId, creditsNeeded, description, serviceType = 'ai_review', isFromRewardedAd = false, creditType = 'regular') {
    try {
      //console.log(`\n=== deductCredits called ===`);
      //console.log(`userId: ${userId}, creditsNeeded: ${creditsNeeded}, serviceType: ${serviceType}, isFromRewardedAd: ${isFromRewardedAd}, creditType: ${creditType}`);
      
      const checkResult = await this.canUserUseCredits(userId, creditsNeeded, isFromRewardedAd);
      if (!checkResult.canUse) {
        throw new Error(checkResult.reason);
      }

      // Get fresh subscription to ensure we have the Mongoose document
      const subscription = await this.getUserActiveSubscription(userId);
      if (!subscription) {
        throw new Error('Subscription not found');
      }
      
      //console.log(`Subscription found: planId=${subscription.planId}, dailyUsage before:`, subscription.dailyUsage);
      
      // Use the proper subscription model method for credit deduction
      const { Subscription } = await import('../../models/subscription.js');
      const deductionResult = await Subscription.deductCreditsAtomic(userId, creditsNeeded, creditType);
      
      //console.log(`Credit deduction result:`, deductionResult.deductedFrom);
      
      // Get the fresh subscription after deduction
      const updatedSubscription = await this.getUserActiveSubscription(userId);
      //console.log(`Credits remaining after deduction: ${updatedSubscription.getTotalAvailableCredits()}`);
      
      // Get plan for daily usage tracking
      const plan = await this.getPlanById(subscription.planId);

      // Update daily usage tracking for all plans with restrictions
      if (plan && plan.restrictions) {
        const now = new Date();
        const today = now.toDateString();
        
        // Initialize daily usage if it doesn't exist
        if (!updatedSubscription.dailyUsage) {
          updatedSubscription.dailyUsage = {
            date: today,
            reviewCount: 0,
            rewardedAdCount: 0
          };
        }
        
        // Reset if it's a new day
        if (updatedSubscription.dailyUsage.date !== today) {
          updatedSubscription.dailyUsage = {
            date: today,
            reviewCount: 0,
            rewardedAdCount: 0
          };
        }
        
        // Increment the appropriate counter
        if (isFromRewardedAd && updatedSubscription.planId === 'basic_ads') {
          updatedSubscription.dailyUsage.rewardedAdCount += 1;
          //console.log(`Incremented rewardedAdCount to ${updatedSubscription.dailyUsage.rewardedAdCount} for user ${userId}`);
        } else if (!isFromRewardedAd) {
          updatedSubscription.dailyUsage.reviewCount += 1;
          //console.log(`Incremented reviewCount to ${updatedSubscription.dailyUsage.reviewCount} for user ${userId}`);
        }
        
        //console.log(`dailyUsage after increment:`, updatedSubscription.dailyUsage);
      } else {
        //console.log(`WARNING: Plan or restrictions not found for planId: ${updatedSubscription.planId}`);
      }

      await updatedSubscription.save();
      //console.log(`Subscription saved successfully`);

      // Update user credits
      const user = await User.findById(userId);
      if (user) {
        user.credits = Math.max(0, (user.credits || 0) - creditsNeeded);
        await user.save();

        // Record credit history
      }

      return {
        success: true,
        creditsDeducted: creditsNeeded,
        remainingCredits: updatedSubscription.getTotalAvailableCredits(),
        subscription: updatedSubscription
      };

    } catch (error) {
      console.error('Error deducting credits:', error);
      throw error;
    }
  }

  /**
   * Process subscription webhook from Cashfree
   */
  async processSubscriptionWebhook(webhookData, signature) {
    try {
      // Process webhook through Cashfree service
      const webhookResult = await cashfreeSubscriptionService.processSubscriptionWebhook(webhookData, signature);
      
      if (!webhookResult.processed) {
        return webhookResult;
      }

      // Handle different subscription events
      const { action, subscriptionId } = webhookResult;
      
      // Find local subscription record
      const subscription = await Subscription.findOne({
        cashfreeSubscriptionId: subscriptionId
      });

      if (!subscription) {
        console.warn(`⚠️ Subscription not found for Cashfree ID: ${subscriptionId}`);
        return webhookResult;
      }

      switch (action) {
        case 'mandate_authenticated':
          await this.handleMandateAuthenticated(subscription, webhookResult);
          break;
          
        case 'subscription_activated':
          await this.handleSubscriptionActivated(subscription, webhookResult);
          break;
          
        case 'payment_successful':
          await this.handleSuccessfulCharge(subscription, webhookResult);
          break;
          
        case 'payment_failed':
          await this.handleFailedCharge(subscription, webhookResult);
          break;
          
        case 'subscription_cancelled':
          await this.handleSubscriptionCancelled(subscription, webhookResult);
          break;
          
        case 'subscription_paused':
          await this.handleSubscriptionPaused(subscription, webhookResult);
          break;
          
        case 'subscription_resumed':
          await this.handleSubscriptionResumed(subscription, webhookResult);
          break;
      }

      return webhookResult;

    } catch (error) {
      console.error('Error processing subscription webhook:', error);
      throw error;
    }
  }

  /**
   * Handle mandate authentication success
   */
  async handleMandateAuthenticated(subscription, event) {
    subscription.status = 'AUTHENTICATED';
    subscription.authenticatedAt = new Date();
    await subscription.save();
    
    //console.log(`✅ Subscription mandate authenticated: ${subscription.subscriptionId}`);
  }

  /**
   * Handle subscription activation
   */
  async handleSubscriptionActivated(subscription, event) {
    subscription.status = 'ACTIVE';
    subscription.activatedAt = new Date(event.activatedAt) || new Date();
    await subscription.save();

    // Add initial credits to user
    await this.activateSubscription(subscription._id);
    
    //console.log(`✅ Subscription activated: ${subscription.subscriptionId}`);
  }

  /**
   * Handle subscription cancellation
   */
  async handleSubscriptionCancelled(subscription, event) {
    subscription.status = 'CANCELLED';
    subscription.cancelledAt = new Date(event.cancelledAt) || new Date();
    await subscription.save();
    
    //console.log(`✅ Subscription cancelled: ${subscription.subscriptionId}`);
  }

  /**
   * Handle subscription pause
   */
  async handleSubscriptionPaused(subscription, event) {
    subscription.status = 'PAUSED';
    subscription.pausedAt = new Date(event.pausedAt) || new Date();
    await subscription.save();
    
    //console.log(`✅ Subscription paused: ${subscription.subscriptionId}`);
  }

  /**
   * Handle subscription resume
   */
  async handleSubscriptionResumed(subscription, event) {
    subscription.status = 'ACTIVE';
    subscription.resumedAt = new Date(event.resumedAt) || new Date();
    await subscription.save();
    
    //console.log(`✅ Subscription resumed: ${subscription.subscriptionId}`);
  }

  /**
   * Handle failed payment
   */
  async handleFailedCharge(subscription, event) {
    // Mark as payment failed but don't deactivate immediately
    subscription.lastFailedPayment = {
      paymentId: event.paymentId,
      failureReason: event.failureReason,
      failedAt: new Date()
    };
    
    // If multiple failures, mark as suspended
    subscription.failedPaymentCount = (subscription.failedPaymentCount || 0) + 1;
    if (subscription.failedPaymentCount >= 3) {
      subscription.status = 'SUSPENDED';
      subscription.suspendedAt = new Date();
    }
    
    await subscription.save();
    
    //console.log(`❌ Subscription payment failed: ${subscription.subscriptionId} (${event.failureReason})`);
  }

  /**
   * Cancel subscription with Cashfree
   */
  async cancelSubscriptionWithCashfree(subscriptionId, reason = 'User requested cancellation') {
    try {
      const subscription = await Subscription.findById(subscriptionId);
      if (!subscription) {
        throw new Error('Subscription not found');
      }

      // Cancel with Cashfree
      await cashfreeSubscriptionService.cancelSubscription(
        subscription.cashfreeSubscriptionId,
        reason
      );

      // Update local record
      subscription.status = 'CANCELLED';
      subscription.cancelledAt = new Date();
      subscription.cancellationReason = reason;
      await subscription.save();

      //console.log(`✅ Subscription cancelled: ${subscription.subscriptionId}`);
      return subscription;

    } catch (error) {
      console.error('Error cancelling subscription:', error);
      throw error;
    }
  }

  /**
   * Pause subscription with Cashfree
   */
  async pauseSubscriptionWithCashfree(subscriptionId, reason = 'User requested pause') {
    try {
      const subscription = await Subscription.findById(subscriptionId);
      if (!subscription) {
        throw new Error('Subscription not found');
      }

      // Pause with Cashfree
      await cashfreeSubscriptionService.pauseSubscription(
        subscription.cashfreeSubscriptionId,
        reason
      );

      // Update local record
      subscription.status = 'PAUSED';
      subscription.pausedAt = new Date();
      await subscription.save();

      //console.log(`✅ Subscription paused: ${subscription.subscriptionId}`);
      return subscription;

    } catch (error) {
      console.error('Error pausing subscription:', error);
      throw error;
    }
  }

  /**
   * Resume subscription with Cashfree
   */
  async resumeSubscriptionWithCashfree(subscriptionId, reason = 'User requested resume') {
    try {
      const subscription = await Subscription.findById(subscriptionId);
      if (!subscription) {
        throw new Error('Subscription not found');
      }

      // Resume with Cashfree
      await cashfreeSubscriptionService.resumeSubscription(
        subscription.cashfreeSubscriptionId,
        reason
      );

      // Update local record
      subscription.status = 'ACTIVE';
      subscription.resumedAt = new Date();
      await subscription.save();

      //console.log(`✅ Subscription resumed: ${subscription.subscriptionId}`);
      return subscription;

    } catch (error) {
      console.error('Error resuming subscription:', error);
      throw error;
    }
  }

  /**
   * Process rewarded ad and award credits
   */
  async processRewardedAd(userId, adDetails = {}) {
    try {
      const subscription = await Subscription.findActiveForUser(userId);
      if (!subscription) {
        throw new Error('No active subscription found');
      }

      // Clean up expired credits first
      subscription.cleanupExpiredCredits();

      const now = new Date();
      const isToday = subscription.credits.lastRewardedDate && 
                     subscription.credits.lastRewardedDate.toDateString() === now.toDateString();

      // Get daily ad limit from plan restrictions (0 means unlimited)
      const plan = await this.getPlanById(subscription.planId);
      const dailyLimit = plan?.restrictions?.rewardedAdLimit || 0;
      const adsWatchedToday = isToday ? subscription.credits.dailyRewardedCount : 0;

      //console.log(`🔍 ProcessRewardedAd Debug - planId: ${subscription.planId}, dailyLimit: ${dailyLimit}, adsWatchedToday: ${adsWatchedToday}`);

      // Only check limit if dailyLimit > 0 (0 means unlimited)
      if (dailyLimit > 0 && adsWatchedToday >= dailyLimit) {
        throw new Error(`Daily ad limit reached. You can watch ${dailyLimit} ads per day.`);
      }

      // Award 1 credit per ad (expires at end of day)
      const creditsAwarded = 1;
      subscription.credits.rewardedCredits += creditsAwarded;
      
      // Update daily tracking
      if (isToday) {
        subscription.credits.dailyRewardedCount += 1;
      } else {
        // Reset for new day
        subscription.credits.dailyRewardedCount = 1;
      }
      subscription.credits.lastRewardedDate = now;

      await subscription.save();

      // If dailyLimit is 0 (unlimited), return a high number for UI display
      const adsRemainingToday = dailyLimit === 0 ? 999 : Math.max(0, dailyLimit - subscription.credits.dailyRewardedCount);

      //console.log(`✅ Rewarded ad processed for user ${userId}: +${creditsAwarded} credits (${adsRemainingToday} remaining today)`);

      return {
        creditsAwarded,
        totalRewardedCredits: subscription.credits.rewardedCredits,
        adsWatchedToday: subscription.credits.dailyRewardedCount,
        adsRemainingToday,
        dailyLimit,
        expiryTime: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0) // End of today (start of tomorrow)
      };

    } catch (error) {
      console.error('Error processing rewarded ad:', error);
      throw error;
    }
  }

  /**
   * Generate payment URL for subscription upgrade (don't create subscription record)
   */
  async generatePaymentUrl(userId, planId, customerDetails = {}) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const plan = await this.getPlanById(planId);
      if (!plan) {
        throw new Error('Plan not found');
      }

      // Only generate payment URLs for paid plans
      if (plan.price <= 0) {
        throw new Error('Cannot generate payment URL for free plans');
      }

      // Use customer details from request or fallback to user data
      const customerName = customerDetails.name || 
        user.firstName || user.lastName || user.name || 
        (user.email ? user.email.split('@')[0] : `User_${user.mobileNumber?.slice(-4) || 'Unknown'}`);
      
      const customerEmail = customerDetails.email || 
        user.email || `${user.mobileNumber}@logdhan.app`;
      
      const customerPhone = customerDetails.phone || 
        user.mobileNumber || user.phone || '9999999999';

      // Create Cashfree subscription mandate for payment
      const mandateData = {
        userId: userId,
        cashfreePlanId: plan.cashfreePlanId,
        planName: plan.name,
        customerName,
        customerEmail,
        customerPhone,
        amount: plan.price
      };

      // Ensure plan exists in Cashfree first
      if (!plan.cashfreePlanId) {
        //console.log(`Creating missing Cashfree plan for: ${planId}`);
        throw 'Cashfree plan not found. Please contact support to resolve this issue.';
        // const cashfreePlan = await this.createCashfreePlan(plan);
        // mandateData.cashfreePlanId = cashfreePlan.plan_id;
      }

      //console.log(`🔄 Generating payment URL for user ${userId}, plan ${planId}, amount ₹${plan.price}`);
      
      const cashfreeResponse = await cashfreeSubscriptionService.createSubscriptionMandate(mandateData);
      
      //console.log('📦 Cashfree response received:', {
      //   subscriptionId: cashfreeResponse.subscriptionId,
      //   subscriptionSessionId: cashfreeResponse.subscriptionSessionId,
      //   subscriptionStatus: cashfreeResponse.subscriptionStatus
      // });

      // Generate checkout URL pointing to nolojik-webapp
      const checkoutParams = new URLSearchParams({
        subscriptionSessionId: cashfreeResponse.subscriptionSessionId,
        type: 'subscription',
        amount: plan.price,
        planName: plan.name,
        environment: process.env.ENVIRONMENT || 'PRODUCTION'
      });

      const paymentUrl = `https://nolojik.com/logdhan/checkout?${checkoutParams.toString()}`;

      //console.log(`✅ Payment URL generated: ${paymentUrl}`);

      return {
        paymentUrl,
        planName: plan.name,
        amount: plan.price,
        credits: plan.credits,
        subscriptionSessionId: cashfreeResponse.subscriptionSessionId,
        planType: plan.type === 'TOPUP' ? 'ON_DEMAND' : 'PERIODIC',
        isRecurring: plan.type !== 'TOPUP'
      };

    } catch (error) {
      console.error('Error generating payment URL:', error);
      throw error;
    }
  }

  /**
   * Validate that userId exists and cf_subscription_id belongs to them
   */
  async validateUserSubscription(userId, cf_subscription_id) {
    try {
      // Check if user exists
      const user = await User.findById(userId);
      if (!user) {
        return { isValid: false, reason: 'User not found' };
      }

      // For security, we should query Cashfree to verify the subscription belongs to this user
      try {
        const cashfreeStatus = await cashfreeSubscriptionService.getSubscriptionStatus(cf_subscription_id);
        
        // Check if the subscription was created for this user
        // We can match by userId in the subscription_id pattern or customer email
        const isValidSubscription = cashfreeStatus.subscription_id && 
          (cashfreeStatus.subscription_id.includes(userId) || 
           cashfreeStatus.customer_details?.customer_email === user.email);
           
        if (!isValidSubscription) {
          return { isValid: false, reason: 'Subscription does not belong to this user' };
        }

        return { isValid: true, user, cashfreeData: cashfreeStatus };
      } catch (error) {
        console.warn('Could not validate subscription with Cashfree:', error.message);
        // Fallback: check our database for existing subscription
        const existingSubscription = await Subscription.findOne({ 
          userId: userId,
          cashfreeSubscriptionId: cf_subscription_id 
        });
        
        if (existingSubscription) {
          return { isValid: true, user };
        }
        
        return { isValid: false, reason: 'Could not validate subscription ownership' };
      }
    } catch (error) {
      console.error('Error validating user subscription:', error);
      return { isValid: false, reason: 'Validation failed' };
    }
  }

  /**
   * Process subscription status from Cashfree return URL
   */
  async processSubscriptionStatus(statusData) {
    try {
      const { cf_subscription_id } = statusData;
      
      //console.log('🔄 Processing subscription status from Cashfree:', statusData);

      // First, query Cashfree to get the actual subscription status and details
      let cashfreeData = null;
      if (cf_subscription_id) {
        try {
          //console.log('🔍 Querying Cashfree for subscription status:', cf_subscription_id);
          cashfreeData = await cashfreeSubscriptionService.getSubscriptionStatus(cf_subscription_id);
          //console.log('📊 Cashfree subscription data:', JSON.stringify(cashfreeData));
        } catch (error) {
          console.warn('⚠️ Failed to get Cashfree status, using provided status:', error.message);
        }
      }


      let userId = null;
        if (cf_subscription_id && cf_subscription_id.startsWith('logdhan_sub_')) {
          const parts = cf_subscription_id.split('_');
          if (parts.length >= 3) {
            userId = parts[2]; // Extract userId from middle part
            //console.log('🔍 Extracted userId from cf_subscriptionId:', userId);
          }
        }

      if (!userId) {
        throw new Error('Invalid cf_subscription_id format. Could not extract userId.');
      }
      // Find the user
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

     
      // IMPORTANT: Find the SINGLE subscription for this user (there should only be ONE)
      let subscription = await Subscription.findOne({ 
        userId: userId 
      }).sort({ createdAt: -1 }); // Get the most recent if somehow there are multiple

      if (!subscription) {
        console.error('❌ No subscription found for user - this should not happen');
        throw new Error('No subscription found for user. Please contact support.');
      }

      // Find the plan based on planName
      const plan = await Plan.findOne({ cashfreePlanId: cashfreeData.plan_details?.plan_id });

      if (!plan) {
        console.warn(`⚠️ Plan not found for planName: ${planName}. Will not update plan details.`);
      }

      let isNewSubscription = false;

      // Process based on status
      if (cashfreeData && cashfreeData.subscription_status == "ACTIVE") {
        // UPDATE the existing subscription with new plan details
        //console.log('✅ Updating existing subscription with new plan:', plan?.planId);
        
        if (plan) {
          // Update all plan-related fields
          subscription.planId = plan.planId;
          subscription.planName = plan.name;
          subscription.planCredits = plan.credits;
          
          // Update pricing
          subscription.pricing = {
            amount: plan.price,
            credits: plan.credits,
            billingCycle: plan.billingCycle
          };
          
          // Use billing dates from Cashfree for consistency
          const now = new Date();
          let endDate;
          let nextResetAt;
          
          // If we have Cashfree data, use their next_schedule_date
          if (cashfreeData && cashfreeData.next_schedule_date) {
            // Parse Cashfree's date format (e.g., "2025-09-16T12:58:53+05:30")
            endDate = new Date(cashfreeData.next_schedule_date);
            nextResetAt = endDate;
            //console.log(`📅 Using Cashfree next_schedule_date: ${cashfreeData.next_schedule_date}`);
          } else {
            // Fallback to calculating based on plan type
            if (plan.billingCycle === 'MONTHLY') {
              endDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
              nextResetAt = endDate;
            } else if (plan.billingCycle === 'YEARLY') {
              endDate = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
              nextResetAt = endDate;
            } else {
              // Lifetime/One-time
              endDate = new Date(now.getFullYear() + 100, now.getMonth(), now.getDate());
              nextResetAt = endDate;
            }
            //console.log(`📅 Calculated endDate (no Cashfree data): ${endDate.toISOString()}`);
          }
          
          subscription.billing = {
            startDate: now,
            endDate: endDate,
            nextBillingDate: plan.billingCycle === 'ONE_TIME' ? null : endDate,
            lastBillingDate: null
          };
          subscription.nextResetAt = nextResetAt;
          
        }

        subscription.credits = {
          "total" : plan.credits,
          "used" : 0,
          "remaining" : plan.credits,
          "rollover" : 0,
      }
        
        // ALWAYS update the Cashfree subscription ID with the latest one
        subscription.status = cashfreeData.subscription_status;
        subscription.cashfreeSubscriptionId = cf_subscription_id;
        subscription.cashfreeSessionId = null; // Clear session ID
        subscription.subscriptionId= cf_subscription_id
        
        // Store Cashfree details in metadata for reference
        subscription.metadata = {
          ...subscription.metadata,
          cashfreeStatus: cashfreeData.subscription_status,
          lastUpdated: new Date(),
          previousPlan: subscription.metadata?.currentPlan || subscription.planId,
          currentPlan: plan?.planId,
          cashfreeDetails: cashfreeData ? {
            nextScheduleDate: cashfreeData.next_schedule_date,
            planIntervalType: cashfreeData.plan_details?.plan_interval_type,
            planIntervals: cashfreeData.plan_details?.plan_intervals,
            authorizationStatus: cashfreeData.authorization_details?.authorization_status,
            paymentMethod: cashfreeData.authorization_details?.payment_method,
            customerEmail: cashfreeData.customer_details?.customer_email,
            cfSubscriptionId: cashfreeData.cf_subscription_id
          } : null
        };       
      } 
      else {
        //console.log('❌ Payment failed - NOT updating subscription plan');
        // Don't change the plan, just log the failure
        subscription.metadata = {
          ...subscription.metadata,
          lastFailedPayment: {
            cashfreeSubscriptionId: cf_subscription_id,
            planAttempted: planName,
            failedAt: new Date(),
            status:  cashfreeData.subscription_status
          },
         
        };
      } 
       await subscription.save();
      //console.log(`✅ Updated subscription ${subscription._id} with new Cashfree ID: ${subscription.cashfreeSubscriptionId}`);

     
      return {
        success: true,
        subscription
      };

    } catch (error) {
      console.error('Error processing subscription status:', error);
      throw error;
    }
  }

  /**
   * Check if user can add stock to watchlist
   */
  async canUserAddStock(userId, currentStockCount) {
    try {
      return await Subscription.canUserAddStock(userId, currentStockCount);
    } catch (error) {
      console.error('Error checking user stock limit:', error);
      throw new Error('Failed to check stock limit. Please try again.');
    }
  }

  /**
   * Check if user can analyze stocks
   */
  async canUserAnalyzeStock(userId) {
    try {
      return await Subscription.canUserAnalyzeStock(userId);
    } catch (error) {
      console.error('Error checking user analysis permission:', error);
      throw new Error('Failed to check analysis permission. Please try again.');
    }
  }
}

export const subscriptionService = new SubscriptionService();