import mongoose from 'mongoose';

const referralCodeSchema = new mongoose.Schema({
  code: {
    type: String,
    unique: true,
    required: true,
    uppercase: true,
    minlength: 8,
    maxlength: 10
  },
  referrer: {
    type: mongoose.Types.ObjectId,
    ref: 'User',
    required: true
  },
  redeemedBy: [{
    user: {
      type: mongoose.Types.ObjectId,
      ref: 'User',
      required: true
    },
    redeemedAt: {
      type: Date,
      default: Date.now
    },
    creditsBonusGiven: {
      type: Number,
      default: 20
    }
  }],
  maxUses: {
    type: Number,
    default: 20,
    min: 1,
    max: 100
  },
  isActive: {
    type: Boolean,
    default: true
  },
  bonusAmount: {
    type: Number,
    default: 20,
    min: 1,
    max: 100
  },
  analytics: {
    totalRedemptions: {
      type: Number,
      default: 0
    },
    totalCreditsEarned: {
      type: Number,
      default: 0
    },
    conversionRate: {
      type: Number,
      default: 0 // Percentage of referees who converted to paid
    },
    lastUsedAt: {
      type: Date,
      default: null
    }
  },
  metadata: {
    source: {
      type: String,
      default: 'app'
    },
    campaign: {
      type: String,
      default: null
    }
  }
}, {
  timestamps: true
});

// Indexes for performance (code index already created by unique: true)
referralCodeSchema.index({ referrer: 1 });
referralCodeSchema.index({ 'redeemedBy.user': 1 });
referralCodeSchema.index({ isActive: 1, maxUses: 1 });

// Virtual for remaining uses
referralCodeSchema.virtual('remainingUses').get(function() {
  return this.maxUses - this.redeemedBy.length;
});

// Method to check if code can be redeemed
referralCodeSchema.methods.canRedeem = function(userId) {
  if (!this.isActive) return { can: false, reason: 'Code is inactive' };
  if (this.redeemedBy.length >= this.maxUses) return { can: false, reason: 'Code exhausted' };
  if (String(this.referrer) === String(userId)) return { can: false, reason: 'Cannot refer yourself' };
  
  const alreadyUsed = this.redeemedBy.some(redemption => 
    String(redemption.user) === String(userId)
  );
  if (alreadyUsed) return { can: false, reason: 'Already used by this user' };
  
  return { can: true };
};

// Static method to generate unique code
referralCodeSchema.statics.generateUniqueCode = async function(userId) {
  const user = await mongoose.model('User').findById(userId);
  if (!user) throw new Error('User not found');
  
  // Generate code based on user's first name + random chars
  const baseCode = (user.firstName || 'LOG').substring(0, 3).toUpperCase();
  let attempts = 0;
  
  while (attempts < 10) {
    const randomSuffix = Math.random().toString(36).substring(2, 7).toUpperCase();
    const code = `${baseCode}${randomSuffix}`;
    
    const existing = await this.findOne({ code });
    if (!existing) return code;
    
    attempts++;
  }
  
  throw new Error('Unable to generate unique referral code');
};

// Static method to find or create user's referral code
referralCodeSchema.statics.findOrCreateForUser = async function(userId) {
  let referralCode = await this.findOne({ referrer: userId, isActive: true });
  
  if (!referralCode) {
    const code = await this.generateUniqueCode(userId);
    referralCode = await this.create({
      code,
      referrer: userId
    });
  }
  
  return referralCode;
};

export const ReferralCode = mongoose.model('ReferralCode', referralCodeSchema);