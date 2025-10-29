import { Subscription } from '../../models/subscription.js';
import { Plan } from '../../models/plan.js';
import { cashfreeSubscriptionService } from './cashfreeSubscriptionService.js';

/**
 * Service for updating subscription based on Cashfree status
 * Can be called from both manual refresh and webhook processing
 */
class SubscriptionUpdateService {
  
  /**
   * Update subscription based on Cashfree payment status
   * @param {string} subscriptionId - The local subscription ID
   * @param {Object} cashfreeStatus - The Cashfree subscription status response
   * @returns {Object} Update result with success status and details
   */
  async updateSubscriptionFromCashfree(subscriptionId, cashfreeStatus) {
    try {
      console.log('🔄 Starting subscription update from Cashfree status');
      
      // Get the local subscription
      const subscription = await Subscription.findOne({ subscriptionId });
      if (!subscription) {
        throw new Error(`Subscription not found: ${subscriptionId}`);
      }
      
      console.log(`📋 Current subscription:`, {
        subscriptionId: subscription.subscriptionId,
        planId: subscription.planId,
        status: subscription.status
      });
      
      // Extract plan information from Cashfree
      const cashfreePlanId = cashfreeStatus.plan_details?.plan_id;
      if (!cashfreePlanId) {
        throw new Error('No plan ID found in Cashfree status');
      }
      
      console.log(`🔍 Looking up plan details for: ${cashfreePlanId}`);
      
      // Fetch plan details from plans table
      const plan = await Plan.getPlanById(cashfreePlanId);
      if (!plan) {
        throw new Error(`Plan not found in database: ${cashfreePlanId}`);
      }
      
      console.log(`📦 Found plan:`, {
        planId: plan.planId,
        name: plan.name,
        price: plan.price,
        stockLimit: plan.stockLimit,
        billingCycle: plan.billingCycle
      });
      
      // Determine if update is needed
      const needsUpdate = (
        cashfreeStatus.subscription_status === 'ACTIVE' && subscription.status !== 'ACTIVE'
      ) || (
        cashfreeStatus.authorization_details?.authorization_status === 'ACTIVE' && 
        subscription.planId !== cashfreePlanId
      );
      
      if (!needsUpdate) {
        console.log('ℹ️ No update needed - status is already current');
        return {
          success: true,
          updated: false,
          message: 'Subscription status is already up to date',
          subscription
        };
      }
      
      console.log('✅ Update needed - proceeding with subscription update');
      
      // Extract payment timing information
      const paymentTime = new Date(cashfreeStatus.authorization_details?.authorization_time);
      const planAmount = cashfreeStatus.plan_details?.plan_recurring_amount || 
                        cashfreeStatus.plan_details?.plan_max_amount ||
                        plan.price;
      
      // Update subscription with plan details from database
      subscription.planId = plan.planId;
      subscription.planName = plan.name;
      subscription.status = 'ACTIVE';
      
      // Update pricing information
      subscription.pricing.amount = planAmount;
      subscription.pricing.stockLimit = plan.stockLimit;
      subscription.pricing.billingCycle = plan.billingCycle;
      
      // Update stock limit
      subscription.stockLimit = plan.stockLimit;
      
      // Update restrictions based on plan
      subscription.restrictions.pipelineAccess = plan.pipelineAccess || 'FULL';
      
      // Update billing dates
      subscription.billing.startDate = paymentTime;
      
      // Calculate end date based on billing cycle from plan
      const endDate = new Date(paymentTime);
      if (plan.billingCycle === 'MONTHLY') {
        endDate.setMonth(endDate.getMonth() + 1);
      } else if (plan.billingCycle === 'YEARLY') {
        endDate.setFullYear(endDate.getFullYear() + 1);
      } else {
        // For one-time payments, set end date far in future
        endDate.setFullYear(endDate.getFullYear() + 10);
      }
      subscription.billing.endDate = endDate;
      
      // Update next billing date if available from Cashfree
      if (cashfreeStatus.next_schedule_date) {
        subscription.billing.nextBillingDate = new Date(cashfreeStatus.next_schedule_date);
      } else if (plan.billingCycle === 'MONTHLY') {
        const nextBilling = new Date(paymentTime);
        nextBilling.setMonth(nextBilling.getMonth() + 1);
        subscription.billing.nextBillingDate = nextBilling;
      } else if (plan.billingCycle === 'YEARLY') {
        const nextBilling = new Date(paymentTime);
        nextBilling.setFullYear(nextBilling.getFullYear() + 1);
        subscription.billing.nextBillingDate = nextBilling;
      }
      
      // Clear trial fields if this was a trial subscription
      if (subscription.planId === 'trial_free' || subscription.planId.includes('trial')) {
        subscription.trialExpiryDate = null;
        subscription.isTrialExpired = false;
      }
      
      // Save the updated subscription
      await subscription.save();
      
      console.log('✅ Subscription updated successfully');
      console.log('📊 Updated subscription details:', {
        planId: subscription.planId,
        planName: subscription.planName,
        status: subscription.status,
        stockLimit: subscription.stockLimit,
        amount: subscription.pricing.amount,
        billingCycle: subscription.pricing.billingCycle,
        startDate: subscription.billing.startDate,
        endDate: subscription.billing.endDate
      });
      
      return {
        success: true,
        updated: true,
        message: 'Subscription updated successfully',
        subscription,
        previousPlanId: cashfreePlanId,
        newPlanId: plan.planId,
        planDetails: {
          name: plan.name,
          stockLimit: plan.stockLimit,
          amount: planAmount,
          billingCycle: plan.billingCycle
        }
      };
      
    } catch (error) {
      console.error('❌ Error updating subscription from Cashfree:', error);
      throw error;
    }
  }
  
  /**
   * Move processed Cashfree IDs to oldTransactionIds array
   * @param {Object} subscription - The subscription document
   * @param {string} status - The processing status
   */
  async moveToOldTransactionIds(subscription, status = 'PROCESSED_SUCCESSFULLY') {
    try {
      if (!subscription.cashfreeSubscriptionId) {
        console.log('ℹ️ No cashfreeSubscriptionId to move');
        return;
      }
      
      console.log('📝 Moving cashfree IDs to oldTransactionIds');
      
      // Initialize oldTransactionIds if it doesn't exist
      if (!subscription.oldTransactionIds) {
        subscription.oldTransactionIds = [];
      }
      
      // Add current cashfree ID to old transaction IDs
      subscription.oldTransactionIds.push({
        cashfreeSubscriptionId: subscription.cashfreeSubscriptionId,
        cashfreeSessionId: subscription.cashfreeSessionId,
        processedAt: new Date(),
        status: status
      });
      
      // Clear the current cashfreeSubscriptionId since it's been processed
      subscription.cashfreeSubscriptionId = null;
      subscription.cashfreeSessionId = null;
      
      await subscription.save();
      console.log('✅ Moved cashfree IDs to oldTransactionIds');
      
    } catch (error) {
      console.error('❌ Error moving to oldTransactionIds:', error);
      throw error;
    }
  }
  
  /**
   * Complete subscription update workflow
   * Combines updateSubscriptionFromCashfree and moveToOldTransactionIds
   * @param {string} cashfreeSubscriptionId - The Cashfree subscription ID
   * @returns {Object} Complete update result
   */
  async processSubscriptionUpdate(cashfreeSubscriptionId) {
    try {
      console.log('🔄 Starting complete subscription update process');
      
      // Find subscription by cashfreeSubscriptionId
      const subscription = await Subscription.findOne({ 
        cashfreeSubscriptionId: cashfreeSubscriptionId 
      });
      
      if (!subscription) {
        throw new Error(`Subscription not found for Cashfree ID: ${cashfreeSubscriptionId}`);
      }
      
      // Get Cashfree status
      const cashfreeStatus = await cashfreeSubscriptionService.getSubscriptionStatus(cashfreeSubscriptionId);
      
      // Update subscription based on Cashfree status
      const updateResult = await this.updateSubscriptionFromCashfree(
        subscription.subscriptionId, 
        cashfreeStatus
      );
      
      if (updateResult.updated) {
        // Move the cashfree IDs to oldTransactionIds
        await this.moveToOldTransactionIds(subscription, 'PROCESSED_SUCCESSFULLY');
        
        // Refresh subscription data
        const updatedSubscription = await Subscription.findOne({ 
          subscriptionId: subscription.subscriptionId 
        });
        updateResult.subscription = updatedSubscription;
      }
      
      return {
        ...updateResult,
        cashfreeStatus: {
          subscription_status: cashfreeStatus.subscription_status,
          authorization_status: cashfreeStatus.authorization_details?.authorization_status,
          payment_method: cashfreeStatus.authorization_details?.payment_method?.upi || 
                          cashfreeStatus.authorization_details?.payment_method,
          payment_time: cashfreeStatus.authorization_details?.authorization_time
        }
      };
      
    } catch (error) {
      console.error('❌ Error in complete subscription update process:', error);
      throw error;
    }
  }
}

export const subscriptionUpdateService = new SubscriptionUpdateService();