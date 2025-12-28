import axios from 'axios';
import crypto from 'crypto';

/**
 * Cashfree Subscription API Service
 * Handles subscription mandates, recurring payments, and subscription management
 */
class CashfreeSubscriptionService {
  constructor() {
    const isProduction = process.env.ENVIRONMENT === 'PRODUCTION';

    this.baseURL = isProduction ?
    'https://api.cashfree.com/pg' :
    'https://sandbox.cashfree.com/pg';

    this.clientId = isProduction ?
    process.env.CASHFREE_APP_ID :
    process.env.CASHFREE_APP_ID_TEST;

    this.clientSecret = isProduction ?
    process.env.CASHFREE_SECRET_KEY :
    process.env.CASHFREE_SECRET_KEY_TEST;

    this.apiVersion = '2025-01-01';

  }

  /**
   * Generate headers for Cashfree API calls
   */
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-version': this.apiVersion,
      'x-client-id': this.clientId,
      'x-client-secret': this.clientSecret
    };
  }

  /**
   * Create paid subscription plan in Cashfree (only for paid plans)
   */
  async createSubscriptionPlan(planData) {
    try {
      // Validate required fields
      if (!planData.planId) {
        throw new Error('Missing planId in plan data');
      }
      if (!planData.planName) {
        throw new Error('Missing planName in plan data');
      }
      if (!planData.amount) {
        throw new Error('Missing amount in plan data');
      }

      const cashfreePlanData = {
        plan_id: planData.planId,
        plan_name: planData.planName,
        plan_type: "PERIODIC",
        plan_currency: "INR",
        plan_amount: planData.amount,
        plan_max_amount: planData.amount,
        plan_max_cycles: 0, // 0 means unlimited cycles
        plan_intervals: 1,
        plan_interval_type: planData.amount >= 999 ? "YEAR" : "MONTH", // Annual vs Monthly based on amount
        plan_note: `LogDhan ${planData.planName} subscription plan`
      };

      const response = await axios.post(
        `${this.baseURL}/plans`,
        cashfreePlanData,
        { headers: this.getHeaders() }
      );

      return {
        planId: response.data.plan_id,
        planName: response.data.plan_name,
        planType: response.data.plan_type,
        amount: response.data.plan_amount,
        currency: response.data.plan_currency,
        intervalType: response.data.plan_interval_type,
        intervals: response.data.plan_intervals,
        maxCycles: response.data.plan_max_cycles,
        status: response.data.plan_status
      };

    } catch (error) {
      console.error('❌ Cashfree Plan Creation Error:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message,
        headers: error.response?.headers
      });

      // If plan already exists, that's okay - return success
      if (error.response?.status === 409 || error.response?.data?.message?.includes('already exists')) {

        return {
          planId: planData.planId,
          planName: planData.planName,
          planType: "PERIODIC",
          amount: planData.amount,
          currency: "INR",
          intervalType: planData.amount >= 999 ? "YEAR" : "MONTH",
          intervals: 1,
          maxCycles: 0,
          status: 'ACTIVE'
        };
      }

      // Extract the actual error message from Cashfree response
      const errorMessage = error.response?.data?.message ||
      error.response?.data?.error ||
      error.response?.statusText ||
      error.message;

      throw new Error(`Failed to create Cashfree plan: ${errorMessage}`);
    }
  }

  /**
   * Get subscription status from Cashfree
   */
  async getSubscriptionStatus(cf_subscription_id) {
    try {
      const response = await axios.get(
        `${this.baseURL}/subscriptions/${cf_subscription_id}`,
        { headers: this.getHeaders() }
      );

      return response.data;
    } catch (error) {
      console.error('❌ Error fetching subscription status:', error.response?.data || error.message);
      throw new Error(`Failed to fetch subscription status: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Fetch subscription plan details
   */
  async fetchPlan(planId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/plans/${planId}`,
        { headers: this.getHeaders() }
      );

      return response.data;
    } catch (error) {
      console.error('Error fetching plan:', error.response?.data || error.message);
      throw new Error(`Failed to fetch plan: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Create subscription mandate for a user
   */
  async createSubscriptionMandate(subscriptionData) {
    try {
      // Validate required fields
      if (!subscriptionData.cashfreePlanId) {
        throw new Error('Missing cashfreePlanId in subscription data');
      }
      if (!subscriptionData.customerName) {
        throw new Error('Missing customerName in subscription data');
      }
      if (!subscriptionData.customerEmail) {
        throw new Error('Missing customerEmail in subscription data');
      }

      // Generate subscription ID first
      const subscriptionId = `logdhan_sub_${subscriptionData.userId}_${Date.now()}`;

      const mandateData = {
        subscription_id: subscriptionId,
        customer_details: {
          customer_email: subscriptionData.customerEmail,
          customer_phone: subscriptionData.customerPhone
        },
        plan_details: {
          plan_id: subscriptionData.cashfreePlanId,
          plan_name: subscriptionData.planName,
          plan_type: "PERIODIC",
          plan_currency: "INR",
          plan_amount: subscriptionData.amount,
          plan_max_amount: subscriptionData.amount,
          plan_max_cycles: 0, // 0 means unlimited cycles
          plan_intervals: 1,
          plan_interval_type: subscriptionData.amount >= 999 ? "YEAR" : "MONTH", // Annual vs Monthly
          plan_note: `LogDhan ${subscriptionData.planName} subscription`
        },
        authorization_details: {
          authorization_amount: subscriptionData.amount,
          authorization_amount_refund: true,
          payment_methods: ["upi"]
        },
        subscription_meta: {
          return_url: `https://www.nolojik.com/swingsetups/thankyou`,
          notification_url: `https://swingsetups.com/api/v1/subscriptions/webhook`
        },
        subscription_first_charge_time: null,
        subscription_expiry_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 1 day from now
      };

      const returnUrl = `https://www.nolojik.com/swingsetups/thankyou`;

      const response = await axios.post(
        `${this.baseURL}/subscriptions`,
        mandateData,
        { headers: this.getHeaders() }
      );

      return {
        subscriptionId: response.data.subscription_id,
        subscriptionSessionId: response.data.subscription_session_id,
        subscriptionPaymentUrl: response.data.subscription_payment_url,
        subscriptionStatus: response.data.subscription_status
      };

    } catch (error) {
      console.error('❌ Cashfree API Error:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message,
        headers: error.response?.headers
      });

      // Extract the actual error message from Cashfree response
      const errorMessage = error.response?.data?.message ||
      error.response?.data?.error ||
      error.response?.statusText ||
      error.message;

      throw new Error(`Failed to create subscription: ${errorMessage}`);
    }
  }

  /**
   * Fetch subscription details
   */
  async fetchSubscription(subscriptionId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/subscriptions/${subscriptionId}`,
        { headers: this.getHeaders() }
      );

      return {
        subscriptionId: response.data.subscription_id,
        planId: response.data.plan_details.plan_id,
        planName: response.data.plan_details.plan_name,
        status: response.data.subscription_status,
        currentCycle: response.data.subscription_current_cycle,
        nextBillingDate: response.data.subscription_next_scheduled_time,
        customerDetails: response.data.customer_details,
        authorizationDetails: response.data.authorization_details,
        createdAt: response.data.subscription_created_time,
        activatedAt: response.data.subscription_activated_time
      };

    } catch (error) {
      console.error('Error fetching subscription:', error.response?.data || error.message);
      throw new Error(`Failed to fetch subscription: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Cancel subscription
   */
  async cancelSubscription(subscriptionId, reason = 'User requested cancellation') {
    try {
      const cancelData = {
        subscription_note: reason
      };

      const response = await axios.post(
        `${this.baseURL}/subscriptions/${subscriptionId}/cancel`,
        cancelData,
        { headers: this.getHeaders() }
      );

      return {
        subscriptionId: response.data.subscription_id,
        status: response.data.subscription_status,
        cancelledAt: response.data.subscription_cancelled_time
      };

    } catch (error) {
      console.error('Error cancelling subscription:', error.response?.data || error.message);
      throw new Error(`Failed to cancel subscription: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Get subscription payments history
   */
  async getSubscriptionPayments(subscriptionId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/subscriptions/${subscriptionId}/payments`,
        { headers: this.getHeaders() }
      );

      return response.data.map((payment) => ({
        paymentId: payment.payment_id,
        subscriptionId: payment.subscription_id,
        amount: payment.payment_amount,
        status: payment.payment_status,
        paymentMethod: payment.payment_method,
        paymentTime: payment.payment_time,
        cycleNumber: payment.cycle_number
      }));

    } catch (error) {
      console.error('Error fetching subscription payments:', error.response?.data || error.message);
      throw new Error(`Failed to fetch payments: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Pause subscription
   */
  async pauseSubscription(subscriptionId, pauseNote = 'User requested pause') {
    try {
      const pauseData = {
        subscription_note: pauseNote
      };

      const response = await axios.post(
        `${this.baseURL}/subscriptions/${subscriptionId}/pause`,
        pauseData,
        { headers: this.getHeaders() }
      );

      return {
        subscriptionId: response.data.subscription_id,
        status: response.data.subscription_status,
        pausedAt: response.data.subscription_paused_time
      };

    } catch (error) {
      console.error('Error pausing subscription:', error.response?.data || error.message);
      throw new Error(`Failed to pause subscription: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Resume subscription
   */
  async resumeSubscription(subscriptionId, resumeNote = 'User requested resume') {
    try {
      const resumeData = {
        subscription_note: resumeNote
      };

      const response = await axios.post(
        `${this.baseURL}/subscriptions/${subscriptionId}/resume`,
        resumeData,
        { headers: this.getHeaders() }
      );

      return {
        subscriptionId: response.data.subscription_id,
        status: response.data.subscription_status,
        resumedAt: response.data.subscription_resumed_time
      };

    } catch (error) {
      console.error('Error resuming subscription:', error.response?.data || error.message);
      throw new Error(`Failed to resume subscription: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Verify subscription webhook signature
   */
  verifyWebhookSignature(payload, signature) {
    try {
      const expectedSignature = crypto.
      createHmac('sha256', this.clientSecret).
      update(payload).
      digest('hex');

      return signature === expectedSignature;
    } catch (error) {
      console.error('Error verifying webhook signature:', error);
      return false;
    }
  }

  /**
   * Process subscription webhook
   */
  async processSubscriptionWebhook(webhookData, signature) {
    try {
      // Verify webhook signature
      const payload = JSON.stringify(webhookData);
      if (!this.verifyWebhookSignature(payload, signature)) {
        throw new Error('Invalid webhook signature');
      }

      const eventType = webhookData.type;
      const subscriptionData = webhookData.data;

      const result = {
        processed: true,
        event: eventType,
        subscriptionId: subscriptionData.subscription_id,
        timestamp: new Date()
      };

      switch (eventType) {
        case 'SUBSCRIPTION_AUTHENTICATION':
          // Subscription mandate authenticated successfully
          result.action = 'mandate_authenticated';
          result.status = subscriptionData.subscription_status;
          break;

        case 'SUBSCRIPTION_ACTIVATED':
          // First payment successful, subscription active
          result.action = 'subscription_activated';
          result.status = 'ACTIVE';
          result.activatedAt = subscriptionData.subscription_activated_time;
          break;

        case 'SUBSCRIPTION_CHARGED':
          // Recurring payment successful
          result.action = 'payment_successful';
          result.paymentId = subscriptionData.payment_id;
          result.amount = subscriptionData.payment_amount;
          result.cycle = subscriptionData.cycle_number;
          break;

        case 'SUBSCRIPTION_CHARGE_FAILED':
          // Recurring payment failed
          result.action = 'payment_failed';
          result.paymentId = subscriptionData.payment_id;
          result.failureReason = subscriptionData.payment_message;
          break;

        case 'SUBSCRIPTION_CANCELLED':
          // Subscription cancelled
          result.action = 'subscription_cancelled';
          result.status = 'CANCELLED';
          result.cancelledAt = subscriptionData.subscription_cancelled_time;
          break;

        case 'SUBSCRIPTION_PAUSED':
          // Subscription paused
          result.action = 'subscription_paused';
          result.status = 'PAUSED';
          result.pausedAt = subscriptionData.subscription_paused_time;
          break;

        case 'SUBSCRIPTION_RESUMED':
          // Subscription resumed
          result.action = 'subscription_resumed';
          result.status = 'ACTIVE';
          result.resumedAt = subscriptionData.subscription_resumed_time;
          break;

        default:
          console.warn(`⚠️ Unhandled subscription webhook type: ${eventType}`);
          result.processed = false;
          result.action = 'unknown_event';
      }

      return result;

    } catch (error) {
      console.error('Error processing subscription webhook:', error);
      throw error;
    }
  }
}

export const cashfreeSubscriptionService = new CashfreeSubscriptionService();