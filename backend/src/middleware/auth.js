import jwt from 'jsonwebtoken';
import { User } from '../models/user.js';
import TokenBlacklist from '../models/tokenBlacklist.js';

export const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if token is blacklisted
    const isBlacklisted = await TokenBlacklist.isTokenBlacklisted(token);
    if (isBlacklisted) {
      return res.status(401).json({ error: 'Token has been invalidated' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.token = token;
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Convert _id to id for consistency
    user.id = user._id;
    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};

/**
 * Optional authentication middleware
 * Sets req.user if valid token, but doesn't block if no token
 */
export const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      // No token, continue without user
      req.user = null;
      return next();
    }

    // Check if token is blacklisted
    const isBlacklisted = await TokenBlacklist.isTokenBlacklisted(token);
    if (isBlacklisted) {
      req.user = null;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.token = token;
    const user = await User.findById(decoded.id);

    if (user) {
      user.id = user._id;
      req.user = user;
    } else {
      req.user = null;
    }
    next();
  } catch (error) {
    // Invalid token, continue without user
    req.user = null;
    next();
  }
};

/**
 * Admin authentication middleware
 * Requires valid token AND admin role
 */
export const adminAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if token is blacklisted
    const isBlacklisted = await TokenBlacklist.isTokenBlacklisted(token);
    if (isBlacklisted) {
      return res.status(401).json({ error: 'Token has been invalidated' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.token = token;
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Check for admin role
    if (!user.isAdmin && user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    user.id = user._id;
    req.user = user;
    next();
  } catch (error) {
    console.error('Admin auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};