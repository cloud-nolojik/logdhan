import { ReferralCode } from '../models/referralCode.js';
import { User } from '../models/user.js';
import { Subscription } from '../models/subscription.js';
import mongoose from 'mongoose';

class ReferralService {
  constructor() {
    this.bonusAmount = 20; // Credits bonus for both referrer and referee
    this.maxRedemptionsPerIP = 3; // Max redemptions per IP per day
    this.deviceHashes = new Map(); // In-memory device tracking (use Redis in production)
  }

  /**
   * Get or create referral code for user
   */
  async getUserReferralCode(userId) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const referralCode = await ReferralCode.findOrCreateForUser(userId);

      return {
        code: referralCode.code,
        totalRedemptions: referralCode.analytics.totalRedemptions,
        creditsEarned: referralCode.analytics.totalCreditsEarned,
        remainingUses: referralCode.remainingUses,
        conversionRate: referralCode.analytics.conversionRate
      };
    } catch (error) {
      console.error('Error getting user referral code:', error);
      throw error;
    }
  }

  /**
   * Redeem referral code with fraud guards
   */
  async redeemReferralCode(userId, code, metadata = {}) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Validate user
      const user = await User.findById(userId).session(session);
      if (!user) {
        throw new Error('User not found');
      }

      // Check if user is verified (fraud guard)
      if (!user.isVerified) {
        throw new Error('Phone/email verification required before referral bonus');
      }

      // Check if user already used a referral code
      if (user.referral.bonusReceived) {
        throw new Error('User has already received a referral bonus');
      }

      // Find referral code
      const referralCode = await ReferralCode.findOne({
        code: code.toUpperCase(),
        isActive: true
      }).session(session);

      if (!referralCode) {
        throw new Error('Invalid referral code');
      }

      // Check if code can be redeemed
      const canRedeem = referralCode.canRedeem(userId);
      if (!canRedeem.can) {
        throw new Error(canRedeem.reason);
      }

      // Fraud guards
      if (metadata.ip) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        // Check IP limit (implement with Redis in production)
        const ipRedemptions = await this.countRedemptionsByIP(metadata.ip, todayStart);
        if (ipRedemptions >= this.maxRedemptionsPerIP) {
          throw new Error('Too many redemptions from this device today');
        }
      }

      // Get referrer
      const referrer = await User.findById(referralCode.referrer).session(session);
      if (!referrer) {
        throw new Error('Referrer not found');
      }

      // Get active subscriptions for both users
      const refereeSubscription = await Subscription.findActiveForUser(userId);
      const referrerSubscription = await Subscription.findActiveForUser(referralCode.referrer);

      if (!refereeSubscription || !referrerSubscription) {
        throw new Error('Both users must have active subscriptions for referral bonus');
      }

      // Credit both accounts
      await Subscription.findByIdAndUpdate(
        referrerSubscription._id,
        { $inc: { 'credits.remaining': this.bonusAmount } },
        { session }
      );

      await Subscription.findByIdAndUpdate(
        refereeSubscription._id,
        { $inc: { 'credits.remaining': this.bonusAmount } },
        { session }
      );

      // Update user records
      user.referral.referredBy = referralCode.referrer;
      user.referral.referralCode = code.toUpperCase();
      user.referral.bonusReceived = true;
      user.referral.bonusAmount = this.bonusAmount;
      user.referral.referredAt = new Date();
      await user.save({ session });

      // Update referral code analytics
      referralCode.redeemedBy.push({
        user: userId,
        redeemedAt: new Date(),
        creditsBonusGiven: this.bonusAmount
      });
      referralCode.analytics.totalRedemptions += 1;
      referralCode.analytics.totalCreditsEarned += this.bonusAmount;
      referralCode.analytics.lastUsedAt = new Date();
      await referralCode.save({ session });

      // Create credit history records
      const now = new Date();

      await session.commitTransaction();

      return {
        success: true,
        message: `🎁 +${this.bonusAmount} credits added for you and your friend!`,
        bonusAmount: this.bonusAmount,
        referrerName: referrer.firstName || 'Friend',
        code
      };

    } catch (error) {
      await session.abortTransaction();
      console.error('Error redeeming referral code:', error);
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Get referral stats for user
   */
  async getReferralStats(userId) {
    try {
      const referralCode = await ReferralCode.findOne({
        referrer: userId,
        isActive: true
      }).populate('redeemedBy.user', 'firstName lastName createdAt');

      if (!referralCode) {
        return {
          code: null,
          totalRedemptions: 0,
          creditsEarned: 0,
          remainingUses: 20,
          conversionRate: 0,
          recentReferrals: []
        };
      }

      // Calculate conversion rate (referees who became paid users)
      let paidConversions = 0;
      for (const redemption of referralCode.redeemedBy) {
        const subscription = await Subscription.findOne({
          userId: redemption.user._id,
          planId: { $ne: 'basic_ads' }, // Exclude free plan
          status: 'ACTIVE'
        });
        if (subscription) paidConversions++;
      }

      const conversionRate = referralCode.redeemedBy.length > 0 ?
      paidConversions / referralCode.redeemedBy.length * 100 :
      0;

      return {
        code: referralCode.code,
        totalRedemptions: referralCode.analytics.totalRedemptions,
        creditsEarned: referralCode.analytics.totalCreditsEarned,
        remainingUses: referralCode.remainingUses,
        conversionRate: Math.round(conversionRate),
        recentReferrals: referralCode.redeemedBy.
        slice(-5).
        map((r) => ({
          name: r.user.firstName || 'Friend',
          date: r.redeemedAt,
          credits: r.creditsBonusGiven
        }))
      };
    } catch (error) {
      console.error('Error getting referral stats:', error);
      throw error;
    }
  }

  /**
   * Count redemptions by IP (implement with Redis in production)
   */
  async countRedemptionsByIP(ip, since) {
    // TODO: Implement with Redis
    // For now, return 0 (no limit)
    return 0;
  }

  /**
   * Analytics: Calculate referral CAC
   */
  calculateReferralCAC(conversionRate) {
    const bonusCost = this.bonusAmount * 2 * 0.41; // ₹16.4 for both users
    return conversionRate > 0 ? bonusCost / (conversionRate / 100) : bonusCost;
  }
}

export const referralService = new ReferralService();