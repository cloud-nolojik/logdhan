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
    this.cashfreeBaseUrl = process.env.NODE_ENV === 'production' ?
    'https://api.cashfree.com/pg' :
    'https://sandbox.cashfree.com/pg';
    this.webhookSecret = process.env.CASHFREE_WEBHOOK_SECRET;
  }

  /**
   * Initialize default subscription plans
   */
  async initializeDefaultPlans() {
    const defaultPlans = [
    {
      planId: 'trial_3_stocks',
      name: '3 Stock Trial',
      description: '3 stocks watchlist with AI swing analysis',
      type: 'TRIAL',
      price: 0,
      stockLimit: 3,
      features: [
      '3 stocks watchlist',
      'AI swing analysis & setups',
      'WhatsApp alerts (4 types)',
      'Entry/exit signals with confidence',
      'Risk management education',
      'Broker-independent'],

      recurringType: 'ONE_TIME',
      billingCycle: 'ONE_TIME',
      maxAmount: 0,
      recurringAmount: 0,
      costCap: 0,
      grossMargin: 0,
      pipelineAccess: 'FULL',
      analysisLevel: 'advanced',
      restrictions: {
        stockLimit: 3,
        trialDurationDays: 30
      },
      sortOrder: 0
    },
    {
      planId: '1_stock_plan',
      cashfreePlanId: '1_stock_plan',
      name: '1 Stock Plan',
      description: '1 stocks watchlist with advanced AI analysis',
      type: 'MONTHLY',
      price: 99,
      stockLimit: 20,
      features: [
      '20 stocks watchlist',
      'Advanced AI analysis',
      'Priority WhatsApp alerts',
      'Technical pattern recognition',
      'Market timing education',
      'Comprehensive setup details'],

      recurringType: 'PERIODIC',
      billingCycle: 'MONTHLY',
      maxAmount: 99,
      recurringAmount: 99,
      costCap: 69,
      grossMargin: 30,
      pipelineAccess: 'FULL',
      analysisLevel: 'advanced',
      restrictions: {
        stockLimit: 1
      },
      sortOrder: 1
    },
    {
      planId: '10_stock_plan',
      cashfreePlanId: '10_stock_plan',
      name: '10 Stock Plan',
      description: '10 stocks watchlist with full AI analysis',
      type: 'MONTHLY',
      price: 999,
      stockLimit: 10,
      features: [
      '10 stocks watchlist',
      'Full AI swing analysis',
      'Real-time WhatsApp alerts',
      'Entry/SL/target recommendations',
      'Risk-reward calculations',
      'Educational content only'],

      recurringType: 'PERIODIC',
      billingCycle: 'MONTHLY',
      maxAmount: 999,
      recurringAmount: 999,
      costCap: 699,
      grossMargin: 300,
      pipelineAccess: 'FULL',
      analysisLevel: 'advanced',
      restrictions: {
        stockLimit: 10
      },
      sortOrder: 2
    },
    {
      planId: '20_stock_plan',
      cashfreePlanId: '20_stock_plan',
      name: '20 Stock Plan',
      description: '20 stocks watchlist with advanced AI analysis',
      type: 'MONTHLY',
      price: 1999,
      stockLimit: 20,
      features: [
      '20 stocks watchlist',
      'Advanced AI analysis',
      'Priority WhatsApp alerts',
      'Technical pattern recognition',
      'Market timing education',
      'Comprehensive setup details'],

      recurringType: 'PERIODIC',
      billingCycle: 'MONTHLY',
      maxAmount: 1999,
      recurringAmount: 1999,
      costCap: 1399,
      grossMargin: 600,
      pipelineAccess: 'FULL',
      analysisLevel: 'advanced',
      restrictions: {
        stockLimit: 20
      },
      sortOrder: 3
    },
    {
      planId: '30_stock_plan',
      cashfreePlanId: '30_stock_plan',
      name: '30 Stock Plan',
      description: '30 stocks watchlist with premium AI insights',
      type: 'MONTHLY',
      price: 2999,
      stockLimit: 30,
      features: [
      '30 stocks watchlist',
      'Premium AI insights',
      'Instant WhatsApp notifications',
      'Advanced market analysis',
      'Maximum learning capacity',
      'Professional education tools'],

      recurringType: 'PERIODIC',
      billingCycle: 'MONTHLY',
      maxAmount: 2999,
      recurringAmount: 2999,
      costCap: 2099,
      grossMargin: 900,
      pipelineAccess: 'FULL',
      analysisLevel: 'advanced',
      restrictions: {
        stockLimit: 30
      },
      sortOrder: 4
    }];

    for (const planData of defaultPlans) {
      await Plan.findOneAndUpdate(
        { planId: planData.planId },
        planData,
        { upsert: true, new: true }
      );
    }

  }

  /**
   * Get all active plans
   */
  async getActivePlans() {
    return await Plan.find({ status: { $ne: 'INACTIVE' } }).sort({ sortOrder: 1 });
  }

  /**
   * Get plan by ID
   */
  async getPlanById(planId) {
    return await Plan.findOne({ planId });
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
        throw new Error(`Plan not found for planId: ${planId}`);
      }

      // Check if user already has an active subscription
      const existingSubscription = await this.getUserActiveSubscription(userId);
      if (existingSubscription) {
        throw new Error('User already has an active subscription');
      }

      const now = new Date();
      let endDate;

      // Calculate endDate based on plan type
      if (plan.type === 'TRIAL') {
        const trialDays = plan.restrictions?.trialDurationDays;
        if (trialDays === null || trialDays === undefined) {
          // Free forever plan (no expiry) - set to 100 years
          endDate = new Date(now.getFullYear() + 100, now.getMonth(), now.getDate());
        } else {
          // Trial plans with specified duration
          endDate = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
        }
      } else if (plan.billingCycle === 'MONTHLY') {
        // Monthly plans
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
      } else if (plan.billingCycle === 'YEARLY') {
        // Yearly plans
        endDate = new Date(now.getFullYear() + 1, now.getMonth(), now.getDate());
      } else {
        // One-time or lifetime plans
        endDate = new Date(now.getFullYear() + 100, now.getMonth(), now.getDate());
      }

      // Generate subscription ID
      const subscriptionId = `sub_${userId}_${planId}_${Date.now()}`;

      const subscriptionData = {
        userId: new mongoose.Types.ObjectId(userId),
        subscriptionId: subscriptionId,
        planId: plan.planId,
        planName: plan.name,
        status: 'ACTIVE',
        pricing: {
          amount: plan.price,
          stockLimit: plan.stockLimit,
          billingCycle: plan.billingCycle
        },
        stockLimit: plan.stockLimit,
        billing: {
          startDate: now,
          endDate: endDate,
          nextBillingDate: endDate
        },
        // trialExpiryDate is null for free forever plans (no expiry)
        trialExpiryDate: (plan.type === 'TRIAL' && plan.restrictions?.trialDurationDays) ? endDate : null,
        isTrialExpired: false,
        restrictions: plan.restrictions || {},
        paymentMethod: {
          type: paymentDetails.type || null,
          details: paymentDetails.details || null
        },
        notifications: {
          emailReminders: true,
          pushNotifications: true,
          lowCreditWarning: true
        },
        dailyUsage: {
          date: now.toDateString(),
          reviewCount: 0,
          rewardedAdCount: 0
        },
        metadata: {
          source: paymentDetails.source || 'direct_subscription',
          campaignId: paymentDetails.campaignId || null,
          referralCode: paymentDetails.referralCode || null
        },
        cashfreeSubscriptionId: null,
        cashfreeSessionId: null
      };

      const subscription = new Subscription(subscriptionData);
      await subscription.save();

      return subscription;

    } catch (error) {
      console.error('Error creating subscription:', error);
      throw error;
    }
  }

  /**
   * Get user's active subscription
   */
  async getUserActiveSubscription(userId) {
    const subscription = await Subscription.findOne({
      userId,
      status: { $in: ['ACTIVE', 'EXPIRED', 'GRACE_PERIOD'] }
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
    if (!subscription) return subscription;

    // Free plan never expires - skip all checks
    if (subscription.planId === 'free_plan') {
      return subscription;
    }

    const now = new Date();
    const endDate = new Date(subscription.billing.endDate);

    // Skip status updates for legacy trial plans that are already expired
    if ((subscription.planId === 'trial_3_stocks' || subscription.planId === 'trial_free') && subscription.status === 'EXPIRED') {
      return subscription;
    }

    if (now > endDate && subscription.status === 'ACTIVE') {
      if (subscription.planId === 'trial_3_stocks' || subscription.planId === 'trial_free') {
        // Legacy trial expired - keep as expired
        subscription.status = 'EXPIRED';
        subscription.isTrialExpired = true;
        await subscription.save();

      } else {
        // Paid subscription expired - handle based on your business logic
        subscription.status = 'EXPIRED';
        await subscription.save();

      }
    }

    return subscription;
  }

  /**
   * Generate payment URL for subscription
   */
  async generatePaymentUrl(userId, planId, customerDetails = {}) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const plan = await this.getPlanById(planId);
      if (!plan) {
        throw new Error(`Plan not found for planId: ${planId}`);
      }

      // Only generate payment URLs for paid plans
      if (plan.price <= 0) {
        throw new Error('Cannot generate payment URL for free plans');
      }

      // Ensure customerDetails is not null
      const safeCustomerDetails = customerDetails || {};

      // Use customer details from request or fallback to user data
      const customerName = safeCustomerDetails.name ||
      user.firstName || user.lastName || user.name || (
      user.email ? user.email.split('@')[0] : `User_${user.mobileNumber?.slice(-4) || 'Unknown'}`);

      const customerEmail = safeCustomerDetails.email ||
      user.email || `${user.mobileNumber}@logdhan.app`;

      const customerPhone = safeCustomerDetails.phone ||
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
        throw 'Cashfree plan not found. Please contact support to resolve this issue.';
      }

      const cashfreeResponse = await cashfreeSubscriptionService.createSubscriptionMandate(mandateData);

      // ✅ CRITICAL FIX: Save cf_subscription_id to user's existing subscription record
      const existingSubscription = await this.getUserActiveSubscription(userId);
      if (existingSubscription && cashfreeResponse.subscriptionId) {
        existingSubscription.cashfreeSubscriptionId = cashfreeResponse.subscriptionId;
        existingSubscription.cashfreeSessionId = cashfreeResponse.subscriptionSessionId;
        await existingSubscription.save();

      }

      // Generate checkout URL pointing to nolojik-webapp
      const checkoutParams = new URLSearchParams({
        subscriptionSessionId: cashfreeResponse.subscriptionSessionId,
        type: 'subscription',
        amount: plan.price,
        planName: plan.name,
        environment: process.env.ENVIRONMENT || 'PRODUCTION'
      });

      const paymentUrl = `https://nolojik.com/logdhan/checkout?${checkoutParams.toString()}`;

      return {
        paymentUrl,
        planName: plan.name,
        amount: plan.price,
        stockLimit: plan.stockLimit,
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

      // Find local subscription record using cf_subscription_id
      const subscription = await Subscription.findOne({
        cashfreeSubscriptionId: subscriptionId
      });

      if (!subscription) {
        console.warn(`⚠️ Subscription not found for Cashfree ID: ${subscriptionId}`);
        return { processed: true, message: 'Subscription not found in local database' };
      }

      // Handle different webhook events
      switch (action) {
        case 'SUBSCRIPTION_ACTIVATED':
          await this.handleSubscriptionActivated(subscription, webhookResult.eventData);
          break;
        case 'SUBSCRIPTION_CANCELLED':
          await this.handleSubscriptionCancelled(subscription, webhookResult.eventData);
          break;
        case 'PAYMENT_SUCCESS':
          await this.handlePaymentSuccess(subscription, webhookResult.eventData);
          break;
        case 'PAYMENT_FAILED':
          await this.handlePaymentFailed(subscription, webhookResult.eventData);
          break;
        default:

      }

      return { processed: true, action, subscriptionId };

    } catch (error) {
      console.error('Error processing subscription webhook:', error);
      throw error;
    }
  }

  /**
   * Handle subscription activated event
   */
  async handleSubscriptionActivated(subscription, eventData) {
    try {

      // Use the subscription update service to handle the activation
      const { subscriptionUpdateService } = await import('./subscriptionUpdateService.js');

      // Get current Cashfree status to update subscription properly
      const cashfreeStatus = await cashfreeSubscriptionService.getSubscriptionStatus(subscription.cashfreeSubscriptionId);

      // Update subscription using the centralized service
      const updateResult = await subscriptionUpdateService.updateSubscriptionFromCashfree(
        subscription.subscriptionId,
        cashfreeStatus
      );

      if (updateResult.updated) {
        // Move cashfree IDs to oldTransactionIds after successful activation
        await subscriptionUpdateService.moveToOldTransactionIds(subscription, 'ACTIVATED_SUCCESSFULLY');

      } else {

      }

    } catch (error) {
      console.error('Error handling subscription activation:', error);
      throw error;
    }
  }

  /**
   * Handle subscription cancelled event
   */
  async handleSubscriptionCancelled(subscription, eventData) {
    try {
      subscription.status = 'CANCELLED';
      subscription.metadata.cancellationReason = eventData.reason || 'User cancelled';
      subscription.metadata.cancelledAt = new Date();

      await subscription.save();

    } catch (error) {
      console.error('Error handling subscription cancellation:', error);
      throw error;
    }
  }

  /**
   * Handle payment success event
   */
  async handlePaymentSuccess(subscription, eventData) {
    try {

      // Use the subscription update service to handle the payment success
      const { subscriptionUpdateService } = await import('./subscriptionUpdateService.js');

      // Get current Cashfree status to update subscription properly
      const cashfreeStatus = await cashfreeSubscriptionService.getSubscriptionStatus(subscription.cashfreeSubscriptionId);

      // Update subscription using the centralized service
      const updateResult = await subscriptionUpdateService.updateSubscriptionFromCashfree(
        subscription.subscriptionId,
        cashfreeStatus
      );

      if (updateResult.updated) {

      } else {
        // Still update last billing date even if no other changes
        subscription.billing.lastBillingDate = new Date();
        await subscription.save();

      }

    } catch (error) {
      console.error('Error handling payment success:', error);
      throw error;
    }
  }

  /**
   * Handle payment failed event
   */
  async handlePaymentFailed(subscription, eventData) {
    try {
      // Log payment failure but don't immediately cancel subscription
      console.warn(`💳 Payment failed for subscription ${subscription.subscriptionId}: ${eventData.reason}`);

      // You might want to set a grace period or retry logic here
      // For now, just log the failure

    } catch (error) {
      console.error('Error handling payment failure:', error);
      throw error;
    }
  }
}

export const subscriptionService = new SubscriptionService();