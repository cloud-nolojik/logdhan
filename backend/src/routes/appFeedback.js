import express from 'express';
import { auth } from '../middleware/auth.js';
import { simpleAdminAuth } from '../middleware/simpleAdminAuth.js';
import AppFeedback from '../models/appFeedback.js';
import { User } from '../models/user.js';

const router = express.Router();

/**
 * POST /api/v1/app-feedback
 * Submit app feedback (authenticated users)
 */
router.post('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { rating, comment, feedback_type, app_version, device_info } = req.body;

    // Validate rating
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        error: 'Rating must be between 1 and 5'
      });
    }

    // Get user info
    const user = await User.findById(userId).select('firstName lastName mobileNumber').lean();
    const userName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '';
    const userMobile = user?.mobileNumber || '';

    // Create feedback
    const feedback = await AppFeedback.create({
      user_id: userId,
      user_name: userName,
      user_mobile: userMobile,
      rating,
      comment: comment || '',
      feedback_type: feedback_type || 'feedback',
      app_version: app_version || '',
      device_info: device_info || ''
    });

    res.status(201).json({
      success: true,
      message: 'Thank you for your feedback!',
      data: {
        id: feedback._id,
        rating: feedback.rating,
        created_at: feedback.created_at
      }
    });

  } catch (error) {
    console.error('Error submitting app feedback:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit feedback'
    });
  }
});

/**
 * GET /api/v1/app-feedback/admin/list
 * Get all feedback (admin only)
 */
router.get('/admin/list', simpleAdminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const feedbackType = req.query.type;
    const isRead = req.query.is_read;

    // Build query
    const query = {};
    if (feedbackType) {
      query.feedback_type = feedbackType;
    }
    if (isRead !== undefined) {
      query.is_read = isRead === 'true';
    }

    // Get total count
    const total = await AppFeedback.countDocuments(query);

    // Get feedback with pagination
    const feedbacks = await AppFeedback.find(query)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Calculate summary stats
    const stats = await AppFeedback.aggregate([
      {
        $group: {
          _id: null,
          avgRating: { $avg: '$rating' },
          totalCount: { $sum: 1 },
          unreadCount: {
            $sum: { $cond: [{ $eq: ['$is_read', false] }, 1, 0] }
          },
          fiveStarCount: {
            $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] }
          },
          fourStarCount: {
            $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] }
          },
          threeStarCount: {
            $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] }
          },
          twoStarCount: {
            $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] }
          },
          oneStarCount: {
            $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] }
          }
        }
      }
    ]);

    const summary = stats[0] || {
      avgRating: 0,
      totalCount: 0,
      unreadCount: 0,
      fiveStarCount: 0,
      fourStarCount: 0,
      threeStarCount: 0,
      twoStarCount: 0,
      oneStarCount: 0
    };

    res.json({
      success: true,
      data: {
        feedbacks,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit)
        },
        summary: {
          average_rating: summary.avgRating ? summary.avgRating.toFixed(1) : '0.0',
          total_count: summary.totalCount,
          unread_count: summary.unreadCount,
          rating_breakdown: {
            five_star: summary.fiveStarCount,
            four_star: summary.fourStarCount,
            three_star: summary.threeStarCount,
            two_star: summary.twoStarCount,
            one_star: summary.oneStarCount
          }
        }
      }
    });

  } catch (error) {
    console.error('Error fetching app feedback list:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch feedback'
    });
  }
});

/**
 * GET /api/v1/app-feedback/admin/:id
 * Get specific feedback details (admin only)
 */
router.get('/admin/:id', simpleAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const feedback = await AppFeedback.findById(id).lean();

    if (!feedback) {
      return res.status(404).json({
        success: false,
        error: 'Feedback not found'
      });
    }

    res.json({
      success: true,
      data: feedback
    });

  } catch (error) {
    console.error('Error fetching feedback details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch feedback details'
    });
  }
});

/**
 * PATCH /api/v1/app-feedback/admin/:id/read
 * Mark feedback as read (admin only)
 */
router.patch('/admin/:id/read', simpleAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const feedback = await AppFeedback.findByIdAndUpdate(
      id,
      { is_read: true },
      { new: true }
    );

    if (!feedback) {
      return res.status(404).json({
        success: false,
        error: 'Feedback not found'
      });
    }

    res.json({
      success: true,
      message: 'Feedback marked as read'
    });

  } catch (error) {
    console.error('Error marking feedback as read:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update feedback'
    });
  }
});

/**
 * PATCH /api/v1/app-feedback/admin/:id/notes
 * Add admin notes to feedback (admin only)
 */
router.patch('/admin/:id/notes', simpleAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const feedback = await AppFeedback.findByIdAndUpdate(
      id,
      { admin_notes: notes || '' },
      { new: true }
    );

    if (!feedback) {
      return res.status(404).json({
        success: false,
        error: 'Feedback not found'
      });
    }

    res.json({
      success: true,
      message: 'Notes updated'
    });

  } catch (error) {
    console.error('Error updating admin notes:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update notes'
    });
  }
});

export default router;
