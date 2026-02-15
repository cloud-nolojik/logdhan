import jwt from 'jsonwebtoken';
import { User } from '../models/user.js';
import TokenBlacklist from '../models/tokenBlacklist.js';

export const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Parallel: blacklist check + user fetch
    const [isBlacklisted, user] = await Promise.all([
      TokenBlacklist.isTokenBlacklisted(token),
      User.findById(decoded.id).lean()
    ]);

    if (isBlacklisted) {
      return res.status(401).json({ error: 'Token has been invalidated' });
    }

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    req.token = token;
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
      req.user = null;
      return next();
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [isBlacklisted, user] = await Promise.all([
      TokenBlacklist.isTokenBlacklisted(token),
      User.findById(decoded.id).lean()
    ]);

    if (isBlacklisted || !user) {
      req.user = null;
      return next();
    }

    req.token = token;
    user.id = user._id;
    req.user = user;
    next();
  } catch (error) {
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

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const [isBlacklisted, user] = await Promise.all([
      TokenBlacklist.isTokenBlacklisted(token),
      User.findById(decoded.id).lean()
    ]);

    if (isBlacklisted) {
      return res.status(401).json({ error: 'Token has been invalidated' });
    }

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (!user.isAdmin && user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.token = token;
    user.id = user._id;
    req.user = user;
    next();
  } catch (error) {
    console.error('Admin auth middleware error:', error);
    res.status(401).json({ error: 'Authentication failed' });
  }
};