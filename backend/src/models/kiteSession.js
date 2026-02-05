import mongoose from 'mongoose';

/**
 * KiteSession Model
 * Stores Kite Connect session/token for the admin user.
 * Only one session exists at a time (for the admin account).
 */
const kiteSessionSchema = new mongoose.Schema({
  // Kite user ID (e.g., 'NP6483')
  kite_user_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },

  // Access token for API calls
  access_token: {
    type: String,
    required: false
  },

  // Public token (for WebSocket)
  public_token: {
    type: String,
    required: false
  },

  // User details from Kite
  user_name: {
    type: String,
    required: false
  },
  email: {
    type: String,
    required: false
  },
  user_type: {
    type: String,
    required: false
  },
  broker: {
    type: String,
    default: 'ZERODHA'
  },

  // Token validity
  token_created_at: {
    type: Date,
    required: false
  },
  token_expiry: {
    type: Date,
    required: false
  },
  is_valid: {
    type: Boolean,
    default: false
  },

  // Validation tracking
  last_validated_at: {
    type: Date,
    required: false
  },
  validation_count: {
    type: Number,
    default: 0
  },

  // Login tracking
  last_login_at: {
    type: Date,
    required: false
  },
  login_count: {
    type: Number,
    default: 0
  },
  last_login_error: {
    type: String,
    required: false
  },

  // Connection status
  connection_status: {
    type: String,
    enum: ['pending', 'connected', 'disconnected', 'expired', 'error'],
    default: 'pending'
  },

  created_at: {
    type: Date,
    default: Date.now
  },
  updated_at: {
    type: Date,
    default: Date.now
  }
});

// Update the updated_at field on save
kiteSessionSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

// Static methods
kiteSessionSchema.statics.findByKiteUserId = function(kiteUserId) {
  return this.findOne({ kite_user_id: kiteUserId });
};

kiteSessionSchema.statics.getActiveSession = function() {
  return this.findOne({
    is_valid: true,
    connection_status: 'connected'
  });
};

// Instance methods
kiteSessionSchema.methods.isTokenValid = function() {
  return this.access_token &&
         this.is_valid &&
         this.token_expiry &&
         this.token_expiry > new Date() &&
         this.connection_status === 'connected';
};

kiteSessionSchema.methods.markAsValidated = function() {
  this.last_validated_at = new Date();
  this.validation_count += 1;
  return this.save();
};

kiteSessionSchema.methods.markAsExpired = function() {
  this.is_valid = false;
  this.connection_status = 'expired';
  return this.save();
};

kiteSessionSchema.methods.updateSession = function(sessionData) {
  this.access_token = sessionData.access_token;
  this.public_token = sessionData.public_token;
  this.user_name = sessionData.user_name;
  this.email = sessionData.email;
  this.user_type = sessionData.user_type;
  this.is_valid = true;
  this.connection_status = 'connected';
  this.token_created_at = new Date();
  this.token_expiry = this.getNextExpiry();
  this.last_login_at = new Date();
  this.login_count += 1;
  this.last_login_error = null;
  return this.save();
};

kiteSessionSchema.methods.setLoginError = function(error) {
  this.last_login_error = error;
  this.connection_status = 'error';
  this.is_valid = false;
  return this.save();
};

// Get next token expiry (6 AM IST next day)
kiteSessionSchema.methods.getNextExpiry = function() {
  const now = new Date();
  // Convert to IST (UTC+5:30)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);

  const expiry = new Date(istNow);
  expiry.setHours(6, 0, 0, 0); // 6 AM IST

  // If current IST time is past 6 AM, set to next day
  if (istNow.getHours() >= 6) {
    expiry.setDate(expiry.getDate() + 1);
  }

  // Convert back to UTC for storage
  return new Date(expiry.getTime() - istOffset);
};

const KiteSession = mongoose.model('KiteSession', kiteSessionSchema);

export default KiteSession;
