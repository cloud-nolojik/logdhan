import express from 'express';
import {auth} from '../middleware/auth.js';
import Notification from '../models/notification.js';
import {firebaseService} from '../services/firebase/firebase.service.js';

const router = express.Router();

// Notification types
const NOTIFICATION_TYPES = {
  TRADE_LOG: 'trade_log',
  AI_REVIEW: 'ai_review',
  CREDIT: 'credit',
  SYSTEM: 'system',
  ALERT: 'alert',
  SUBSCRIPTION: 'subscription'
};

// GET /notifications - Get user notifications with pagination
router.get('/', auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      unreadOnly = false,
      type = null
    } = req.query;

    const options = {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 50), // Max 50 per page
      unreadOnly: unreadOnly === 'true',
      type: type || null
    };

    const result = await Notification.getUserNotifications(req.user.id, options);

    res.json({
      success: true,
      data: {
        notifications: result.notifications.map(notification => ({
          id: notification._id,
          title: notification.title,
          message: notification.message,
          type: notification.type,
          isRead: notification.isRead,
          relatedTradeLog: notification.relatedTradeLog,
          relatedStock: notification.relatedStock,
          metadata: notification.metadata,
          createdAt: notification.createdAt,
          updatedAt: notification.updatedAt
        })),
        pagination: result.pagination,
        unreadCount: result.unreadCount
      }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch notifications'
    });
  }
});

// PUT /notifications/:id/read - Mark a notification as read
router.put('/:id/read', auth, async (req, res) => {
  try {
    const notification = await Notification.markAsRead(req.params.id, req.user.id);

    if (!notification) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }

    res.json({
      success: true,
      data: notification.toAPIResponse()
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark notification as read'
    });
  }
});

// POST /notifications - Create a new notification (for system use)
router.post('/', auth, async (req, res) => {
  try {
    const {
      title,
      message,
      type = 'system',
      relatedTradeLog,
      relatedStock,
      metadata = {}
    } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        error: 'Title and message are required'
      });
    }

    const notification = await Notification.createNotification({
      userId: req.user.id,
      title,
      message,
      type,
      relatedTradeLog,
      relatedStock,
      metadata
    });

    res.status(201).json({
      success: true,
      data: notification.toAPIResponse()
    });
  } catch (error) {
    console.error('Error creating notification:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create notification'
    });
  }
});

// GET /notifications/unread-count - Get count of unread notifications
router.get('/unread-count', auth, async (req, res) => {
  try {
    const unreadCount = await Notification.countDocuments({
      user: req.user.id,
      isRead: false
    });

    res.json({
      success: true,
      data: { unreadCount }
    });
  } catch (error) {
    console.error('Error getting unread count:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get unread count'
    });
  }
});

// PUT /notifications/mark-all-read - Mark all notifications as read
router.put('/mark-all-read', auth, async (req, res) => {
  try {
    const result = await Notification.markAllAsRead(req.user.id);

    res.json({
      success: true,
      data: {
        modifiedCount: result.modifiedCount,
        message: `${result.modifiedCount} notifications marked as read`
      }
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to mark all notifications as read'
    });
  }
});

// DELETE /notifications/:id - Delete a notification
router.delete('/:id', auth, async (req, res) => {
  try {
    const notification = await Notification.findOneAndDelete({
      _id: req.params.id,
      user: req.user.id
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        error: 'Notification not found'
      });
    }

    res.json({
      success: true,
      data: { message: 'Notification deleted successfully' }
    });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete notification'
    });
  }
});

router.post('/send-notification', auth, async (req, res) => {
  try {
    const result = await firebaseService.sendToUser(
      req.user.id,
      'Test Notification',
      'This is a test notification',
      { type: 'test' }
    );

    res.json({
      success: true,
      message: 'Notification sent successfully',
      result
    });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send notification',
      message: error.message
    });
  }
});

export default router;