import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  subscriptionId: {
    type: String,
    required: true,
    unique: true
  },
  planId: {
    type: String,
    required: true
  },
  planName: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: [
      'INITIALISED',
      'BANK_APPROVAL_PENDING', 
      'ACTIVE',
      'ON_HOLD',
      'PAUSED',
      'COMPLETED',
      'CUSTOMER_CANCELLED',
      'CUSTOMER_PAUSED',
      'EXPIRED',
      'LINK_EXPIRED',
      'GRACE_PERIOD',
      'FAILED'
    ],
    default: 'INITIALISED'
  },
  cashfreeSubscriptionId: {
    type: String,
    required: false,
    default: null
  },
  cashfreeSessionId: {
    type: String,
    default: null
  },
  pricing: {
    amount: {
      type: Number,
      required: true
    },
    stockLimit: {
      type: Number,
      required: true
    },
    billingCycle: {
      type: String,
      required: true
    }
  },
  stockLimit: {
    type: Number,
    required: true,
    default: 3 // Base stock limit of plan
  },
  // Trial specific fields
  trialExpiryDate: {
    type: Date,
    default: null // When trial expires (null for paid plans)
  },
  isTrialExpired: {
    type: Boolean,
    default: false
  },
  // COMMENTED OUT - No credits concept
  // planCredits: {
  //   type: Number,
  //   required: true // Base monthly credits of plan
  // },
  // nextResetAt: {
  //   type: Date,
  //   required: true // When credits reset next
  // },
  // credits: {
  //   total: {
  //     type: Number,
  //     required: true,
  //     default: 0,
  //     min: 0
  //   },
  //   used: {
  //     type: Number,
  //     required: true,
  //     default: 0,
  //     min: 0
  //   },
  //   remaining: {
  //     type: Number,
  //     required: true,
  //     default: 0,
  //     min: 0
  //   },
  //   rollover: {
  //     type: Number,
  //     default: 0,
  //     min: 0,
  //     max: 150 // Cap absolute rollover to prevent hoarding
  //   },
  //   rolloverBuffer: {
  //     type: Number,
  //     default: 0,
  //     min: 0 // Credits carried into NEXT cycle
  //   },
  //   earnedCredits: {
  //     type: Number,
  //     default: 0,
  //     min: 0 // Credits earned from assessments, referrals etc (never expire)
  //   },
  //   bonusCredits: {
  //     type: Number,
  //     default: 0,
  //     min: 0 // Bonus credits from assessments (7-day expiry, premium analysis)
  //   },
  //   bonusCreditsExpiry: {
  //     type: Date,
  //     default: null // When bonus credits expire
  //   },
  //   rewardedCredits: {
  //     type: Number,
  //     default: 0,
  //     min: 0 // Credits from watching ads (24-hour expiry)
  //   },
  //   dailyRewardedCount: {
  //     type: Number,
  //     default: 0,
  //     min: 0 // Count of ads watched today (max 3)
  //   },
  //   lastRewardedDate: {
  //     type: Date,
  //     default: null // Last time user watched an ad
  //   }
  // },
  restrictions: {
    pipelineAccess: {
      type: String,
      enum: ['BASIC', 'FULL'],
      default: 'FULL'
    }
    // COMMENTED OUT - No credits concept
    // firstWeekUsed: {
    //   type: Number,
    //   default: 0
    // },
    // firstWeekCap: {
    //   type: Number,
    //   default: null
    // }
  },
  billing: {
    startDate: {
      type: Date,
      required: true
    },
    endDate: {
      type: Date,
      required: true
    },
    nextBillingDate: {
      type: Date,
      default: null
    },
    lastBillingDate: {
      type: Date,
      default: null
    }
  },
  paymentMethod: {
    type: {
      type: String,
      enum: ['CARD', 'UPI_AUTOPAY', 'ENACH', 'PHYSICAL_NACH'],
      default: null
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    }
  },
  notifications: {
    emailReminders: {
      type: Boolean,
      default: true
    },
    pushNotifications: {
      type: Boolean,
      default: true
    },
    lowCreditWarning: {
      type: Boolean,
      default: true
    }
  },
  dailyUsage: {
    date: {
      type: String,
      default: () => new Date().toDateString()
    },
    reviewCount: {
      type: Number,
      default: 0
    },
    rewardedAdCount: {
      type: Number,
      default: 0
    }
  },
  metadata: {
    source: {
      type: String,
      default: 'web'
    },
    campaignId: {
      type: String,
      default: null
    },
    referralCode: {
      type: String,
      default: null
    }
  }
}, {
  timestamps: true
});

// Indexes
subscriptionSchema.index({ userId: 1, status: 1 });
subscriptionSchema.index({ cashfreeSubscriptionId: 1 });
subscriptionSchema.index({ 'billing.nextBillingDate': 1 });

// Virtual for trial status
subscriptionSchema.virtual('isTrialActive').get(function() {
  if (!this.trialExpiryDate) return false;
  return new Date() < this.trialExpiryDate && !this.isTrialExpired;
});

// COMMENTED OUT - No credits concept
// Virtual for credit usage percentage
// subscriptionSchema.virtual('creditUsagePercentage').get(function() {
//   return this.credits.total > 0 ? (this.credits.used / this.credits.total) * 100 : 0;
// });

// Method to check if subscription is active (including trial)
subscriptionSchema.methods.isActive = function() {
  // For trial plans, check if trial is still active
  if (this.planId === 'trial_free') {
    return this.isTrialActive && !this.isTrialExpired;
  }
  // For paid plans, check status and end date
  return this.status === 'ACTIVE' && new Date() < this.billing.endDate;
};

// Method to check if user can add more stocks
subscriptionSchema.methods.canAddStock = function(currentStockCount) {
  return currentStockCount < this.stockLimit;
};

// Method to check if user can analyze stocks (trial expiry check)
subscriptionSchema.methods.canAnalyzeStock = function() {
  // For trial plans, check if trial is expired
  if (this.planId === 'trial_free') {
    return this.isTrialActive && !this.isTrialExpired;
  }
  // For paid plans, always allow if subscription is active
  return this.isActive();
};

// Method to check trial expiry and update status
subscriptionSchema.methods.checkAndUpdateTrialExpiry = function() {
  if (this.planId === 'trial_free' && this.trialExpiryDate) {
    const now = new Date();
    if (now >= this.trialExpiryDate && !this.isTrialExpired) {
      this.isTrialExpired = true;
      this.status = 'EXPIRED';
      return true; // Trial just expired
    }
  }
  return false; // No change
};

// COMMENTED OUT - No credits concept
// Method to check if user is in first week (for annual plan restrictions)
// subscriptionSchema.methods.isInFirstWeek = function() {
//   const oneWeek = 7 * 24 * 60 * 60 * 1000;
//   return (Date.now() - this.billing.startDate.getTime()) < oneWeek;
// };

// Method to calculate remaining credits including all types
// subscriptionSchema.methods.getTotalAvailableCredits = function() {
//   // Clean up expired bonus and rewarded credits first
//   this.cleanupExpiredCredits();
//   
//   // For basic_ads plan, credits are unlimited (but we track for ads)
//   if (this.planId === 'basic_ads') {
//     return 999999; // Unlimited for basic plan
//   }
//   
//   return this.credits.remaining + this.credits.rollover + this.credits.earnedCredits + 
//          this.credits.bonusCredits + this.credits.rewardedCredits;
// };

// Method to clean up expired credits
// subscriptionSchema.methods.cleanupExpiredCredits = function() {
//   const now = new Date();
//   
//   // Clean up expired bonus credits
//   if (this.credits.bonusCreditsExpiry && now > this.credits.bonusCreditsExpiry) {
//     this.credits.bonusCredits = 0;
//     this.credits.bonusCreditsExpiry = null;
//   }
//   
//   // Clean up expired rewarded credits (end of day)
//   if (this.credits.lastRewardedDate) {
//     const lastRewardedDate = new Date(this.credits.lastRewardedDate);
//     const nowDate = new Date(now);
//     
//     // Check if lastRewardedDate is from a previous day
//     if (lastRewardedDate.toDateString() !== nowDate.toDateString()) {
//       this.credits.rewardedCredits = 0;
//       this.credits.dailyRewardedCount = 0;
//     }
//   }
// };

// Method to check if user can use credits (considering first week cap)
// subscriptionSchema.methods.canUseCredits = function(creditsNeeded = 1) {
//   const totalAvailable = this.getTotalAvailableCredits();
//   
//   if (totalAvailable < creditsNeeded) {
//     return false;
//   }
//   
//   // Check first week cap for annual plans
//   if (this.restrictions.firstWeekCap && this.isInFirstWeek()) {
//     return (this.restrictions.firstWeekUsed + creditsNeeded) <= this.restrictions.firstWeekCap;
//   }
//   
//   return true;
// };

// Static method to find active subscription for user
subscriptionSchema.statics.findActiveForUser = function(userId) {
  return this.findOne({
    userId,
    status: 'ACTIVE',
    'billing.endDate': { $gt: new Date() }
  });
};

// Static method to find subscriptions needing renewal
subscriptionSchema.statics.findDueForRenewal = function() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  return this.find({
    status: 'ACTIVE',
    'billing.nextBillingDate': { $lte: tomorrow }
  });
};

// COMMENTED OUT - No credits concept
// Credit deduction with priority order and type tracking
// subscriptionSchema.statics.deductCreditsAtomic = async function(userId, creditsToDeduct = 1, creditType = 'regular') {
//   const subscription = await this.findOne({
//     userId,
//     status: 'ACTIVE',
//     'billing.endDate': { $gt: new Date() }
//   });
//   
//   if (!subscription) {
//     throw new Error('No active subscription found');
//   }
//   
//   // Clean up expired credits first
//   subscription.cleanupExpiredCredits();
//   
//   // For basic_ads plan, only deduct bonus credits (advanced analysis), regular credits are unlimited
//   if (subscription.planId === 'basic_ads' && creditType !== 'bonus') {
//     await subscription.save(); // Save cleanup changes
//     return {
//       subscription,
//       creditType: 'unlimited',
//       deductedFrom: 'basic_ads'
//     };
//   }
//   
//   // Check if sufficient credits available
//   const totalAvailable = subscription.getTotalAvailableCredits();
//   if (totalAvailable < creditsToDeduct) {
//     throw new Error('Insufficient credits');
//   }
//   
//   // Deduct in priority order and track which type was used
//   let remaining = creditsToDeduct;
//   let deductedFrom = [];
//   
//   // Priority 1: Bonus credits (if specified or available)
//   if (creditType === 'bonus' && subscription.credits.bonusCredits > 0) {
//     const deduct = Math.min(remaining, subscription.credits.bonusCredits);
//     subscription.credits.bonusCredits -= deduct;
//     subscription.credits.used += deduct;
//     remaining -= deduct;
//     deductedFrom.push(`bonus:${deduct}`);
//   }
//   
//   // Priority 2: Rewarded credits
//   if (remaining > 0 && subscription.credits.rewardedCredits > 0) {
//     const deduct = Math.min(remaining, subscription.credits.rewardedCredits);
//     subscription.credits.rewardedCredits -= deduct;
//     subscription.credits.used += deduct;
//     remaining -= deduct;
//     deductedFrom.push(`rewarded:${deduct}`);
//   }
//   
//   // Priority 3: Regular plan credits
//   if (remaining > 0 && subscription.credits.remaining > 0) {
//     const deduct = Math.min(remaining, subscription.credits.remaining);
//     subscription.credits.remaining -= deduct;
//     subscription.credits.used += deduct;
//     remaining -= deduct;
//     deductedFrom.push(`regular:${deduct}`);
//   }
//   
//   // Priority 4: Rollover credits
//   if (remaining > 0 && subscription.credits.rollover > 0) {
//     const deduct = Math.min(remaining, subscription.credits.rollover);
//     subscription.credits.rollover -= deduct;
//     subscription.credits.used += deduct;
//     remaining -= deduct;
//     deductedFrom.push(`rollover:${deduct}`);
//   }
//   
//   // Priority 5: Earned credits (last resort)
//   if (remaining > 0 && subscription.credits.earnedCredits > 0) {
//     const deduct = Math.min(remaining, subscription.credits.earnedCredits);
//     subscription.credits.earnedCredits -= deduct;
//     subscription.credits.used += deduct;
//     remaining -= deduct;
//     deductedFrom.push(`earned:${deduct}`);
//   }
//   
//   await subscription.save();
//   
//   return {
//     subscription,
//     creditType: creditType,
//     deductedFrom: deductedFrom.join(', ')
//   };
// };

// Static method to check if user can add stock to watchlist
subscriptionSchema.statics.canUserAddStock = async function(userId, currentStockCount) {
  const subscription = await this.findActiveForUser(userId);
  
  if (!subscription) {
    throw new Error('No active subscription found');
  }
  
  // Check and update trial expiry
  subscription.checkAndUpdateTrialExpiry();
  
  return {
    canAdd: subscription.canAddStock(currentStockCount),
    stockLimit: subscription.stockLimit,
    currentCount: currentStockCount,
    remaining: Math.max(0, subscription.stockLimit - currentStockCount)
  };
};

// Static method to check if user can analyze stocks
subscriptionSchema.statics.canUserAnalyzeStock = async function(userId) {
  const subscription = await this.findActiveForUser(userId);
  
  if (!subscription) {
    throw new Error('No active subscription found');
  }
  
  // Check and update trial expiry
  const trialJustExpired = subscription.checkAndUpdateTrialExpiry();
  if (trialJustExpired) {
    await subscription.save();
  }
  
  return {
    canAnalyze: subscription.canAnalyzeStock(),
    planId: subscription.planId,
    isTrialExpired: subscription.isTrialExpired,
    trialExpiryDate: subscription.trialExpiryDate
  };
};

export const Subscription = mongoose.model('Subscription', subscriptionSchema);