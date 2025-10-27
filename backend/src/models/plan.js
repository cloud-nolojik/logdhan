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
  // credits: { // COMMENTED OUT - No credits concept
  //   type: Number,
  //   required: true,
  //   min: 0
  // },
  stockLimit: {
    type: Number,
    required: true,
    min: 1,
    default: 3
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
  // showAds: { // COMMENTED OUT - No ads concept
  //   type: Boolean,
  //   default: false
  // },
  analysisLevel: {
    type: String,
    enum: ['basic', 'advanced'],
    required: true
  },
  // creditRollover: { // COMMENTED OUT - No credits concept
  //   enabled: {
  //     type: Boolean,
  //     default: false
  //   },
  //   maxPercentage: {
  //     type: Number,
  //     default: 0,
  //     min: 0,
  //     max: 100
  //   }
  // },
  restrictions: {
    stockLimit: {
      type: Number,
      default: 3
    },
    trialDurationDays: {
      type: Number,
      default: null
    }
    // dailyCredits: { // COMMENTED OUT - No credits concept
    //   type: Number,
    //   default: null
    // },
    // firstWeekCap: { // COMMENTED OUT - No credits concept
    //   type: Number,
    //   default: null
    // },
    // expiryDays: { // COMMENTED OUT - No credits concept
    //   type: Number,
    //   default: null
    // },
    // dailyReviewLimit: { // COMMENTED OUT - No credits concept
    //   type: Number,
    //   default: null
    // },
    // rewardedAdLimit: { // COMMENTED OUT - No ads concept
    //   type: Number,
    //   default: null
    // },
    // weeklyReviewLimit: { // COMMENTED OUT - No credits concept
    //   type: Number,
    //   default: null
    // },
    // rateLimited: { // COMMENTED OUT - No credits concept
    //   type: Boolean,
    //   default: false
    // }
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

// Method to calculate stocks per rupee (replaces credits per rupee)
planSchema.methods.getStocksPerRupee = function() {
  return this.price > 0 ? this.stockLimit / this.price : 0;
};

export const Plan = mongoose.model('Plan', planSchema);