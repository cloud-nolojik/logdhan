import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const watchlistItemSchema = new mongoose.Schema({
  instrument_key: {
    type: String,

  },
  trading_symbol: {
    type: String,

  },
  name: {
    type: String,

  },
  exchange: {
    type: String,

    enum: ['NSE', 'BSE']
  },
  addedAt: {
    type: Date,
    default: Date.now
  },
  added_source: {
    type: String,
    enum: ['manual', 'weekly_track'],
    default: 'manual'
  }
});

const userSchema = new mongoose.Schema({
  firstName: {
    type: String,
    trim: true,
    minlength: 2,
    maxlength: 50
  },
  lastName: {
    type: String,
    trim: true,
    minlength: 2,
    maxlength: 50
  },
  favorite_sport: {
    type: String,
    enum: ['cricket', 'football', 'kabaddi', 'badminton', 'chess', 'racing', 'battle_royale', 'basketball', 'tennis', 'boxing', 'carrom', 'hockey', 'volleyball', 'none'],
    default: null
  },
  mobileNumber: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    validate: {
      validator: function (v) {
        return /^\d{12}$/.test(v);
      },
      message: props => `${props.value} is not a valid 12-digit mobile number!`
    }
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email address']
  },
  otp: {
    type: String,
    select: false
  },
  otpExpiry: {
    type: Date,
    select: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isOnboarded: {
    type: Boolean,
    default: false
  },
  isVerified: {
    type: Boolean,
    default: false // Required for referral bonus
  },
  referral: {
    referredBy: {
      type: mongoose.Types.ObjectId,
      ref: 'User',
      default: null
    },
    referralCode: {
      type: String,
      default: null // Code used during signup
    },
    bonusReceived: {
      type: Boolean,
      default: false
    },
    bonusAmount: {
      type: Number,
      default: 0
    },
    referredAt: {
      type: Date,
      default: null
    }
  },
  // Enhanced experience system with scoring and confidence
  experience: {
    level: {
      type: String,
      enum: ['beginner', 'intermediate', 'advanced'],
      default: null
    },
    score: {
      type: Number,
      min: 0,
      max: 6,
      default: null // Will be set after quiz
    },
    confidence: {
      type: Number,
      min: 0,
      max: 1,
      default: 0.2 // Low confidence until assessed
    },
    lastUpdated: {
      type: Date,
      default: Date.now
    },
    assessmentMethod: {
      type: String,
      enum: ['quick_quiz', 'deep_diagnostic', 'behavioral_adjustment', 'self_reported'],
      default: null
    }
  },

  // Quiz results and badges
  assessmentHistory: {
    quickQuiz: {
      completed: { type: Boolean, default: false },
      score: { type: Number, min: 0, max: 6 },
      completedAt: Date,
      answers: [{ questionId: String, selectedScore: Number }]
    },
    deepDiagnostic: {
      completed: { type: Boolean, default: false },
      score: { type: Number, min: 0, max: 12 },
      completedAt: Date,
      answers: [{ questionId: String, selectedScore: Number }],
      badge: String // "Pro Verified" or null
    }
  },

  // Behavioral signals for experience adjustment
  experienceSignals: [{
    type: String, // 'simplify_click', 'glossary_tap', etc.
    value: { type: Number, default: 1 },
    timestamp: { type: Date, default: Date.now },
    metadata: { type: Map, of: String }
  }],

  // Signal processing batches  
  signalBatches: [{
    processedAt: { type: Date, default: Date.now },
    signalCount: Number,
    scoreAdjustment: Number,
    previousScore: Number,
    newScore: Number
  }],

  // Legacy fields (keep for backward compatibility)
  tradingExperience: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced'],
    default: null
  },
  onboardingCompleted: {
    type: Boolean,
    default: false
  },
  preferredQuestionStyle: {
    type: String,
    enum: ['simple', 'standard', 'advanced'],
    default: null
  },
  onboardingProgress: {
    currentStep: {
      type: Number,
      default: 0
    },
    stepsCompleted: [{
      stepId: String,
      completedAt: {
        type: Date,
        default: Date.now
      }
    }],
    conceptsLearned: [{
      type: String,
      enum: ['stopLoss', 'targetPrice', 'buyPrice', 'intraday', 'shortTerm']
    }]
  },
  watchlist: [watchlistItemSchema],
  dailyAddTracker: {
    date: { type: String, default: '' },   // IST date string "YYYY-MM-DD"
    keys: [{ type: String }]                // unique instrument_keys added that day
  },
  // Auto trading feature
  enableAutoTrade: {
    type: Boolean,
    default: false
  },
  hasConsented: {
    type: Boolean,
    default: false
  },
  consentedAt: {
    type: Date,
    default: null
  },
  consentTextHash: {
    type: String,
    default: null
  },
  consentText: {
    type: String,
    default: null
  },
  consentVersion: {
    type: String,
    default: null
  },
  verificationToken: String,
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  fcmTokens: [{
    type: String,
    trim: true
  }]
}, {
  timestamps: true
});

// Update timestamps on save
userSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Add index for faster watchlist queries
userSchema.index({ 'watchlist.stock': 1 });

// Generate JWT token
userSchema.methods.generateAuthToken = function () {
  return jwt.sign(
    { id: this.id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// Hash password before saving
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password for login
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Add index for email lookups
userSchema.index({ email: 1 });

export const User = mongoose.model('User', userSchema); 