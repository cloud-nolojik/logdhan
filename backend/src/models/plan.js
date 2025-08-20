import mongoose from 'mongoose';

const planSchema = new mongoose.Schema({
  planId: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['TRIAL', 'MONTHLY', 'ANNUAL', 'TOPUP'],
    required: true
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  credits: {
    type: Number,
    required: true,
    min: 0
  },
  features: [{
    type: String
  }],
  recurringType: {
    type: String,
    enum: ['PERIODIC', 'ON_DEMAND'],
    default: 'PERIODIC'
  },
  billingCycle: {
    type: String,
    enum: ['MONTHLY', 'YEARLY', 'ONE_TIME'],
    required: true
  },
  maxAmount: {
    type: Number,
    required: true
  },
  recurringAmount: {
    type: Number,
    required: true
  },
  costCap: {
    type: Number,
    required: true
  },
  grossMargin: {
    type: Number,
    required: true
  },
  pipelineAccess: {
    type: String,
    enum: ['BASIC', 'FULL'],
    default: 'FULL'
  },
  showAds: {
    type: Boolean,
    default: false
  },
  analysisLevel: {
    type: String,
    enum: ['basic', 'advanced'],
    required: true
  },
  creditRollover: {
    enabled: {
      type: Boolean,
      default: false
    },
    maxPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    }
  },
  restrictions: {
    dailyCredits: {
      type: Number,
      default: null
    },
    firstWeekCap: {
      type: Number,
      default: null
    },
    expiryDays: {
      type: Number,
      default: null
    },
    dailyReviewLimit: {
      type: Number,
      default: null
    },
    rewardedAdLimit: {
      type: Number,
      default: null
    },
    weeklyReviewLimit: {
      type: Number,
      default: null
    },
    rateLimited: {
      type: Boolean,
      default: false
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  sortOrder: {
    type: Number,
    default: 0
  },
  cashfreePlanId: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Static method to get all active plans
planSchema.statics.getActivePlans = function() {
  return this.find({ isActive: true }).sort({ sortOrder: 1 });
};

// Static method to get plan by ID
planSchema.statics.getPlanById = function(planId) {
  return this.findOne({ planId, isActive: true });
};

// Method to calculate credits per rupee
planSchema.methods.getCreditsPerRupee = function() {
  return this.price > 0 ? this.credits / this.price : 0;
};

export const Plan = mongoose.model('Plan', planSchema);