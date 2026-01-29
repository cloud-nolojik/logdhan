import express from 'express';
import jwt from 'jsonwebtoken';
import { User } from '../models/user.js';
import BulkAlertLog from '../models/bulkAlertLog.js';
import WeeklyWatchlist from '../models/weeklyWatchlist.js';
import { simpleAdminAuth } from '../middleware/simpleAdminAuth.js';
import { messagingService } from '../services/messaging/messaging.service.js';
import { firebaseService } from '../services/firebase/firebase.service.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

/**
 * POST /api/v1/admin/login
 * Admin login with password
 */
router.post('/login', async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        success: false,
        error: 'Password is required'
      });
    }

    // Validate against ADMIN_PASSWORD env var
    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({
        success: false,
        error: 'Invalid password'
      });
    }

    // Generate admin session token (expires in 24 hours)
    const token = jwt.sign(
      { type: 'admin_session', createdAt: Date.now() },
      process.env.ADMIN_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      token
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed'
    });
  }
});

/**
 * GET /api/v1/admin/users
 * Get list of users with mobile numbers for bulk alerts
 */
router.get('/users', simpleAdminAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';

    // Build query
    const query = {
      mobileNumber: { $exists: true, $ne: null }
    };

    // Add search filter if provided
    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { mobileNumber: { $regex: search, $options: 'i' } }
      ];
    }

    // Get total count
    const total = await User.countDocuments(query);

    // Get users with pagination
    const users = await User.find(query)
      .select('_id firstName lastName mobileNumber fcmTokens createdAt')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Transform users to add hasApp flag
    const usersWithAppStatus = users.map(user => ({
      _id: user._id,
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      mobileNumber: user.mobileNumber,
      hasApp: user.fcmTokens && user.fcmTokens.length > 0,
      fcmTokenCount: user.fcmTokens?.length || 0,
      createdAt: user.createdAt
    }));

    // Calculate summary
    const totalWithApp = usersWithAppStatus.filter(u => u.hasApp).length;

    res.json({
      success: true,
      data: {
        users: usersWithAppStatus,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit)
        },
        summary: {
          totalUsers: total,
          usersWithApp: totalWithApp,
          usersWithoutApp: usersWithAppStatus.length - totalWithApp
        }
      }
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch users'
    });
  }
});

/**
 * GET /api/v1/admin/weekly-watchlist
 * Get current week's watchlist summary for alert preview
 */
router.get('/weekly-watchlist', simpleAdminAuth, async (req, res) => {
  try {
    const watchlist = await WeeklyWatchlist.getCurrentWeek();

    if (!watchlist || !watchlist.stocks || watchlist.stocks.length === 0) {
      return res.json({
        success: true,
        data: {
          stockCount: 0,
          weekLabel: watchlist?.week_label || 'No active week',
          topPick: null,
          runnerUp: null,
          stocks: []
        }
      });
    }

    // Sort stocks by setup_score (highest first) to get top picks
    const sortedStocks = [...watchlist.stocks].sort((a, b) =>
      (b.setup_score || 0) - (a.setup_score || 0)
    );

    const topPick = sortedStocks[0];
    const runnerUp = sortedStocks[1];

    res.json({
      success: true,
      data: {
        stockCount: watchlist.stocks.length,
        weekLabel: watchlist.week_label,
        topPick: topPick ? {
          symbol: topPick.symbol,
          reason: topPick.selection_reason || topPick.ai_notes || `${topPick.scan_type} setup`
        } : null,
        runnerUp: runnerUp ? {
          symbol: runnerUp.symbol,
          reason: runnerUp.selection_reason || runnerUp.ai_notes || `${runnerUp.scan_type} setup`
        } : null,
        stocks: watchlist.stocks.map(s => ({
          symbol: s.symbol,
          scan_type: s.scan_type,
          setup_score: s.setup_score,
          grade: s.grade
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching weekly watchlist:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch weekly watchlist'
    });
  }
});

/**
 * POST /api/v1/admin/whatsapp/bulk-send
 * Send bulk WhatsApp alerts to selected users
 */
router.post('/whatsapp/bulk-send', simpleAdminAuth, async (req, res) => {
  try {
    const { userIds, alertType, watchlistData } = req.body;

    // Validate input
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No users selected for alert'
      });
    }

    if (!alertType || !['weekly', 'daily'].includes(alertType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid alert type. Must be "weekly" or "daily"'
      });
    }

    if (userIds.length > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Cannot send to more than 1000 users at once'
      });
    }

    // If weekly alert, fetch watchlist data if not provided
    let alertData = watchlistData;
    if (alertType === 'weekly' && !alertData) {
      const watchlist = await WeeklyWatchlist.getCurrentWeek();
      if (watchlist && watchlist.stocks && watchlist.stocks.length > 0) {
        const sortedStocks = [...watchlist.stocks].sort((a, b) =>
          (b.setup_score || 0) - (a.setup_score || 0)
        );
        alertData = {
          stockCount: watchlist.stocks.length,
          topPick: sortedStocks[0]?.symbol,
          topPickReason: sortedStocks[0]?.selection_reason || sortedStocks[0]?.ai_notes,
          runnerUp: sortedStocks[1]?.symbol,
          runnerUpReason: sortedStocks[1]?.selection_reason || sortedStocks[1]?.ai_notes
        };
      }
    }

    // Fetch selected users
    const users = await User.find({
      _id: { $in: userIds },
      mobileNumber: { $exists: true, $ne: null }
    })
      .select('_id firstName mobileNumber')
      .lean();

    if (users.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid users found with mobile numbers'
      });
    }

    // Create job record
    const jobId = uuidv4();
    const bulkAlertLog = new BulkAlertLog({
      jobId,
      alertType,
      totalUsers: users.length,
      status: 'processing',
      startedAt: new Date()
    });
    await bulkAlertLog.save();

    // Start batch processing in background
    processBulkAlerts(jobId, users, alertType, alertData);

    // Return immediately with job info
    res.json({
      success: true,
      data: {
        jobId,
        totalUsers: users.length,
        status: 'processing',
        message: `Sending ${alertType} alerts to ${users.length} users`,
        watchlistData: alertData
      }
    });
  } catch (error) {
    console.error('Error starting bulk send:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start bulk send'
    });
  }
});

/**
 * POST /api/v1/admin/push/bulk-send
 * Send bulk push notifications to selected users (for weekly alerts)
 */
router.post('/push/bulk-send', simpleAdminAuth, async (req, res) => {
  try {
    const { userIds, alertType, watchlistData } = req.body;

    // Validate input
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No users selected for alert'
      });
    }

    if (!alertType || !['weekly', 'daily'].includes(alertType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid alert type. Must be "weekly" or "daily"'
      });
    }

    if (userIds.length > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Cannot send to more than 1000 users at once'
      });
    }

    // If weekly alert, fetch watchlist data if not provided
    let alertData = watchlistData;
    if (alertType === 'weekly' && !alertData) {
      const watchlist = await WeeklyWatchlist.getCurrentWeek();
      if (watchlist && watchlist.stocks && watchlist.stocks.length > 0) {
        const sortedStocks = [...watchlist.stocks].sort((a, b) =>
          (b.setup_score || 0) - (a.setup_score || 0)
        );
        alertData = {
          stockCount: watchlist.stocks.length,
          topPick: sortedStocks[0]?.symbol,
          topPickReason: sortedStocks[0]?.selection_reason || sortedStocks[0]?.ai_notes,
          runnerUp: sortedStocks[1]?.symbol,
          runnerUpReason: sortedStocks[1]?.selection_reason || sortedStocks[1]?.ai_notes
        };
      }
    }

    // Fetch selected users with FCM tokens
    const users = await User.find({
      _id: { $in: userIds },
      fcmTokens: { $exists: true, $ne: [] }
    })
      .select('_id firstName fcmTokens')
      .lean();

    if (users.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid users found with push notification tokens'
      });
    }

    // Create job record
    const jobId = uuidv4();
    const bulkAlertLog = new BulkAlertLog({
      jobId,
      alertType: `${alertType}_push`,
      totalUsers: users.length,
      status: 'processing',
      startedAt: new Date()
    });
    await bulkAlertLog.save();

    // Start batch processing in background
    processBulkPushAlerts(jobId, users, alertType, alertData);

    // Return immediately with job info
    res.json({
      success: true,
      data: {
        jobId,
        totalUsers: users.length,
        status: 'processing',
        message: `Sending ${alertType} push notifications to ${users.length} users`,
        watchlistData: alertData
      }
    });
  } catch (error) {
    console.error('Error starting bulk push send:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start bulk push send'
    });
  }
});

/**
 * GET /api/v1/admin/whatsapp/job/:jobId
 * Get status of a bulk send job
 */
router.get('/whatsapp/job/:jobId', simpleAdminAuth, async (req, res) => {
  try {
    const { jobId } = req.params;

    const job = await BulkAlertLog.findOne({ jobId }).lean();

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    res.json({
      success: true,
      data: job
    });
  } catch (error) {
    console.error('Error fetching job status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch job status'
    });
  }
});

/**
 * GET /api/v1/admin/whatsapp/history
 * Get history of bulk send jobs
 */
router.get('/whatsapp/history', simpleAdminAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;

    const jobs = await BulkAlertLog.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      data: jobs
    });
  } catch (error) {
    console.error('Error fetching job history:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch job history'
    });
  }
});

/**
 * Process bulk alerts in batches
 */
async function processBulkAlerts(jobId, users, alertType, watchlistData) {
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 2000;

  let successCount = 0;
  let failureCount = 0;
  const failures = [];

  const totalBatches = Math.ceil(users.length / BATCH_SIZE);

  for (let i = 0; i < totalBatches; i++) {
    const batchStart = i * BATCH_SIZE;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, users.length);
    const batch = users.slice(batchStart, batchEnd);

    // Process batch in parallel
    const batchPromises = batch.map(async (user) => {
      try {
        await messagingService.sendBulkAlert(user.mobileNumber, {
          alertType,
          userName: user.firstName || 'User',
          stockCount: watchlistData?.stockCount,
          topPick: watchlistData?.topPick,
          topPickReason: watchlistData?.topPickReason,
          runnerUp: watchlistData?.runnerUp,
          runnerUpReason: watchlistData?.runnerUpReason
        });
        successCount++;
      } catch (error) {
        failureCount++;
        failures.push({
          userId: user._id,
          mobileNumber: user.mobileNumber,
          error: error.message
        });
        console.error(`Failed to send alert to ${user.mobileNumber}:`, error.message);
      }
    });

    await Promise.all(batchPromises);

    // Update job progress
    await BulkAlertLog.findOneAndUpdate(
      { jobId },
      {
        'results.successCount': successCount,
        'results.failureCount': failureCount
      }
    );

    // Delay between batches (except for last batch)
    if (i < totalBatches - 1) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  // Mark job as completed
  const finalStatus = failureCount === 0 ? 'completed' : (successCount === 0 ? 'failed' : 'partial');

  await BulkAlertLog.findOneAndUpdate(
    { jobId },
    {
      status: finalStatus,
      completedAt: new Date(),
      results: {
        successCount,
        failureCount,
        failures: failures.slice(0, 100) // Store only first 100 failures
      }
    }
  );

  console.log(`Bulk alert job ${jobId} completed: ${successCount} success, ${failureCount} failures`);
}

/**
 * Process bulk push notifications in batches
 */
async function processBulkPushAlerts(jobId, users, alertType, watchlistData) {
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 500; // Faster than WhatsApp since FCM is more efficient

  let successCount = 0;
  let failureCount = 0;
  const failures = [];

  const totalBatches = Math.ceil(users.length / BATCH_SIZE);

  for (let i = 0; i < totalBatches; i++) {
    const batchStart = i * BATCH_SIZE;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, users.length);
    const batch = users.slice(batchStart, batchEnd);

    // Process batch in parallel
    const batchPromises = batch.map(async (user) => {
      try {
        const result = await firebaseService.sendWeeklySetupsAlert(user._id, {
          stockCount: watchlistData?.stockCount || 0,
          topPick: watchlistData?.topPick || '',
          topPickReason: watchlistData?.topPickReason || '',
          runnerUp: watchlistData?.runnerUp || '',
          runnerUpReason: watchlistData?.runnerUpReason || ''
        });

        if (result.success) {
          successCount++;
        } else {
          failureCount++;
          failures.push({
            userId: user._id,
            error: result.error || 'Unknown error'
          });
        }
      } catch (error) {
        failureCount++;
        failures.push({
          userId: user._id,
          error: error.message
        });
        console.error(`Failed to send push to user ${user._id}:`, error.message);
      }
    });

    await Promise.all(batchPromises);

    // Update job progress
    await BulkAlertLog.findOneAndUpdate(
      { jobId },
      {
        'results.successCount': successCount,
        'results.failureCount': failureCount
      }
    );

    // Delay between batches (except for last batch)
    if (i < totalBatches - 1) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  // Mark job as completed
  const finalStatus = failureCount === 0 ? 'completed' : (successCount === 0 ? 'failed' : 'partial');

  await BulkAlertLog.findOneAndUpdate(
    { jobId },
    {
      status: finalStatus,
      completedAt: new Date(),
      results: {
        successCount,
        failureCount,
        failures: failures.slice(0, 100)
      }
    }
  );

  console.log(`Bulk push alert job ${jobId} completed: ${successCount} success, ${failureCount} failures`);
}

export default router;
