import jwt from 'jsonwebtoken';

/**
 * Simple admin authentication middleware
 * Validates admin session token (JWT signed with ADMIN_SECRET)
 */
export const simpleAdminAuth = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Admin login required'
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.ADMIN_SECRET);
    req.adminSession = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired session'
    });
  }
};
