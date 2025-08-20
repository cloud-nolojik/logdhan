import mongoose from 'mongoose';

const tokenBlacklistSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true,
    unique: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  expiresAt: {
    type: Date,
    required: true
  }
}, {
  timestamps: true
});

// Create index for automatic cleanup of expired tokens
tokenBlacklistSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Static method to check if token is blacklisted
tokenBlacklistSchema.statics.isTokenBlacklisted = async function(token) {
  const blacklistedToken = await this.findOne({ token });
  return !!blacklistedToken;
};

// Static method to blacklist a token
tokenBlacklistSchema.statics.blacklistToken = async function(token, userId, expiresAt) {
  try {
    await this.create({
      token,
      userId,
      expiresAt
    });
    return true;
  } catch (error) {
    // Token might already be blacklisted
    if (error.code === 11000) {
      return true;
    }
    throw error;
  }
};

const TokenBlacklist = mongoose.model('TokenBlacklist', tokenBlacklistSchema);
export default TokenBlacklist;