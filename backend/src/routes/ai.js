import express from 'express';
import aiReviewService from '../services/aiAnalyze.service.js';
import candleFetcherService from '../services/candleFetcher.service.js';
import StockAnalysis from '../models/stockAnalysis.js';
import Stock from '../models/stock.js';
import { Subscription } from '../models/subscription.js';
import MonitoringSubscription from '../models/monitoringSubscription.js';
import { auth as authenticateToken } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';
import upstoxMarketTimingService from '../services/upstoxMarketTiming.service.js';
import { User } from '../models/user.js';

const router = express.Router();

// Initialize cached AI analysis service

// Rate limiting disabled for testing
// const analysisRateLimit = rateLimit({
//     windowMs: 5 * 60 * 1000, // 5 minutes
//     max: 3, // limit each user to 3 requests per windowMs
//     keyGenerator: (req) => req.user.id, // rate limit per user
//     message: {
//         success: false,
//         error: 'Too many analysis requests',
//         message: 'Please wait 5 minutes before requesting another analysis'
//     },
//     standardHeaders: true,
//     legacyHeaders: false,
// });

/**
 * @route POST /api/ai/analyze-stock
 * @desc Analyze stock for trading strategies
 * @access Private
 */
router.post('/analyze-stock', authenticateToken, /* analysisRateLimit, */async (req, res) => {
  try {
    const {
      instrument_key,
      analysis_type = 'swing',
      isFromRewardedAd = false,
      creditType = 'regular'
    } = req.body;

    // Check for force_fresh parameter to bypass cache
    const forceFresh = req.query.force_fresh === 'true' || req.body.force_fresh === 'true';

    // Validate required fields
    if (!instrument_key) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'instrument_key is required'
      });
    }

    // Get user ID first to check subscription and watchlist
    const userId = req.user.id;

    // ⚡ NEW: Check if we're in downtime (4:00-5:00 PM IST)
    // During downtime, NO manual analysis is allowed - bulk processing is running
    const MarketHoursUtil = (await import('../utils/marketHours.js')).default;
    const now = new Date();
    const downtimeCheck = await MarketHoursUtil.isDowntimeWindow(now);

    if (downtimeCheck.isDowntime) {

      return res.status(423).json({
        success: false,
        error: 'downtime_window',
        message: downtimeCheck.message,
        reason: 'downtime_window',
        nextAllowed: downtimeCheck.nextAllowed
      });
    }

    // Lookup stock details from database
    const stockInfo = await Stock.getByInstrumentKey(instrument_key);

    if (!stockInfo) {
      return res.status(404).json({
        success: false,
        error: 'Stock not found',
        message: `No stock found with instrument_key: ${instrument_key}`
      });
    }

    const stock_name = stockInfo.name;
    const stock_symbol = stockInfo.trading_symbol;

    // ⚡ Check user limits using service method (watchlist quota + daily limit)
    const limitsCheck = await aiReviewService.checkAnalysisLimits(userId, instrument_key);

    if (!limitsCheck.allowed) {

      return res.status(200).json({
        success: false,
        status: 'limit_reached',
        error: limitsCheck.reason,
        message: limitsCheck.message,
        limitInfo: limitsCheck.limitInfo
      });
    }

    // Get current price from cache (faster than API call)
    let current_price = null;
    try {
      const priceCacheService = (await import('../services/priceCache.service.js')).default;
      current_price = priceCacheService.getPrice(instrument_key);

      if (current_price) {

      } else {

      }
    } catch (error) {
      console.warn(`⚠️ [PRICE CACHE] Error fetching from cache: ${error.message}`);
    }

    // Return immediate response - analysis will happen in background

    // Start analysis in background (don't await)
    aiReviewService.analyzeStock({
      instrument_key,
      stock_name,
      stock_symbol,
      current_price,
      analysis_type,
      userId,
      forceFresh: forceFresh,
      sendNotification: true // Send notification when complete
    }).catch((error) => {
      console.error(`❌ [BACKGROUND ANALYSIS] Failed for ${stock_symbol}:`, error.message);
    });

    // Return immediate response
    return res.status(200).json({
      success: true,
      status: 'background_processing',
      message: 'Analysis is happening in the background. We will notify you once it\'s complete.',
      instrument_key,
      stock_symbol,
      stock_name,
      estimated_time: '5-10 minutes',
      notification_enabled: true
    });

  } catch (error) {
    console.error('❌ AI Analysis API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to process analysis request'
    });
  }
});

/**
 * @route GET /api/ai/analysis-history
 * @desc Get user's analysis history
 * @access Private
 */
router.get('/analysis-history', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 10;

    const history = await aiReviewService.getUserAnalysisHistory(userId, limit);

    res.json({
      success: true,
      data: history,
      count: history.length
    });

  } catch (error) {
    console.error('❌ Analysis History API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to fetch analysis history'
    });
  }
});

/**
 * @route GET /api/ai/analysis/:analysisId
 * @desc Get specific analysis by ID
 * @access Private
 */
router.get('/analysis/:analysisId', authenticateToken, async (req, res) => {
  try {
    const { analysisId } = req.params;
    const userId = req.user.id;

    const analysis = await StockAnalysis.findOne({
      _id: analysisId,
      user_id: userId
    });

    if (!analysis) {
      return res.status(404).json({
        success: false,
        error: 'Analysis not found',
        message: 'The requested analysis was not found or you do not have access to it'
      });
    }

    res.json({
      success: true,
      data: analysis
    });

  } catch (error) {
    console.error('❌ Get Analysis API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to fetch analysis'
    });
  }
});

/**
 * @route GET /api/ai/analysis/by-instrument/:instrumentKey
 * @desc Get analysis by instrument key
 * @access Private
    */
router.get('/analysis/by-instrument/:instrumentKey', authenticateToken, async (req, res) => {
  try {
    const { instrumentKey } = req.params;
    const { analysis_type = 'swing' } = req.query;
    const userId = req.user.id;

    const analysisPermission = await StockAnalysis.isBulkAnalysisAllowed();

    // ⚡ Check user limits using service method (watchlist quota + daily limit)
    const limitsCheck = await aiReviewService.checkAnalysisLimits(userId, instrumentKey);

    if (!limitsCheck.allowed) {

      return res.status(200).json({
        success: true,
        status: 'limit_reached',
        error: limitsCheck.reason,
        message: limitsCheck.message,
        limitInfo: limitsCheck.limitInfo,
        can_analyze_manually: false
      });
    }

    // First check for any analysis (completed or in progress)
    const anyAnalysis = await StockAnalysis.findOne({
      instrument_key: instrumentKey,
      analysis_type: analysis_type
    }).sort({ created_at: -1 }); // Get most recent analysis

    if (!anyAnalysis) {
      const messageToUser = 'This stock has not been analyzed yet';
      const callToActionToUser = 'Click "Analyze This Stock" to get AI strategies';

      return res.status(200).json({
        success: true,
        status: 'not_analyzed',
        error: 'not_analyzed',
        message: messageToUser,
        call_to_action: callToActionToUser,
        can_analyze_manually: true
      });
    }

    // If analysis is not completed, return in_progress status (unless failed)
    if (anyAnalysis.status !== 'completed') {
      // If analysis failed, return 404 to stop polling
      if (anyAnalysis.status === 'failed') {

        return res.status(404).json({
          success: false,
          error: 'Analysis failed',
          message: 'Analysis failed or timed out'
        });
      }

      // Get progress information for user feedback
      const progressInfo = anyAnalysis.progress || {
        current_step: 'Starting analysis...',
        percentage: 0,
        steps_completed: 0,
        total_steps: 6,
        estimated_time_remaining: 300 // 5 minutes default
      };

      // Calculate estimated completion time
      const createdAt = new Date(anyAnalysis.created_at);
      const now = new Date();
      const elapsedSeconds = Math.floor((now - createdAt) / 1000);
      const estimatedTotalTime = 300; // 5 minutes average
      const remainingSeconds = Math.max(0, estimatedTotalTime - elapsedSeconds);
      const estimatedMinutes = Math.ceil(remainingSeconds / 60);

      // Return background processing message
      return res.status(202).json({
        success: true,
        status: 'background_processing',
        message: 'Analysis is happening in the background. We will notify you once it\'s complete.',
        stock_name: anyAnalysis.stock_name,
        stock_symbol: anyAnalysis.stock_symbol,
        instrument_key: anyAnalysis.instrument_key,
        progress: {
          current_step: progressInfo.current_step,
          percentage: progressInfo.percentage,
          steps_completed: progressInfo.steps_completed,
          total_steps: progressInfo.total_steps,
          estimated_time_remaining: `~${estimatedMinutes} min`
        },
        notification_enabled: true,
        created_at: anyAnalysis.created_at
      });
    }

    // Validate required fields exist for completed analysis
    if (!anyAnalysis.analysis_data?.market_summary?.last ||
      !anyAnalysis.analysis_data?.market_summary?.trend ||
      !anyAnalysis.analysis_data?.market_summary?.volatility ||
      !anyAnalysis.analysis_data?.market_summary?.volume) {

      // Create minimal analysis_data structure with required fields for incomplete analysis
      const defaultAnalysisData = {
        ...anyAnalysis.analysis_data,
        generated_at_ist: new Date().toISOString(), // Required field
        market_summary: {
          last: anyAnalysis.current_price || 0,
          trend: "NEUTRAL",
          volatility: "MEDIUM",
          volume: "AVERAGE"
        },
        overall_sentiment: "NEUTRAL",
        strategies: [],
        disclaimer: "Analysis data incomplete - still processing..."
      };

      return res.status(200).json({
        success: true,
        data: {
          _id: anyAnalysis._id,
          instrument_key: anyAnalysis.instrument_key,
          stock_name: anyAnalysis.stock_name,
          stock_symbol: anyAnalysis.stock_symbol,
          analysis_type: anyAnalysis.analysis_type,
          current_price: anyAnalysis.current_price || 0,
          analysis_data: defaultAnalysisData,
          status: 'in_progress', // Treat incomplete as in_progress
          progress: anyAnalysis.progress,
          created_at: anyAnalysis.created_at,
          expires_at: anyAnalysis.expires_at
        },
        cached: false,
        analysis_id: anyAnalysis._id.toString(),
        error: null,
        message: 'Analysis data incomplete - still processing'
      });
    }

    const analysis = anyAnalysis; // Use the found analysis

    // Check monitoring status for all strategies in this analysis
    const monitoringStatus = {};
    let globalCanStartMonitoring = true;
    let globalMonitoringMessage = null;
    let globalConditionsMetAt = null;

    if (analysis.analysis_data?.strategies) {
      for (const strategy of analysis.analysis_data.strategies) {
        const canMonitor = await MonitoringSubscription.canUserStartMonitoring(
          analysis._id,
          strategy.id
        );

        monitoringStatus[strategy.id] = {
          can_start_monitoring: canMonitor.can_start,
          reason: canMonitor.reason,
          conditions_met_at: canMonitor.conditions_met_at
        };

        // If any strategy cannot be monitored, disable global monitoring
        if (!canMonitor.can_start) {
          globalCanStartMonitoring = false;
          globalMonitoringMessage = canMonitor.reason;
          globalConditionsMetAt = canMonitor.conditions_met_at;
        }
      }
    }

    // Format response to match AnalysisApiResponse structure
    const formattedResponse = {
      _id: analysis._id,
      instrument_key: analysis.instrument_key,
      stock_name: analysis.stock_name,
      stock_symbol: analysis.stock_symbol,
      analysis_type: analysis.analysis_type,
      current_price: analysis.current_price,
      analysis_data: analysis.analysis_data,
      status: analysis.status,
      created_at: analysis.created_at,
      expires_at: analysis.expires_at,
      // NEW: Monitoring flags
      can_start_monitoring: globalCanStartMonitoring,
      monitoring_status: !globalCanStartMonitoring ? 'conditions_met' : null,
      conditions_met_at: globalConditionsMetAt,
      monitoring_message: globalMonitoringMessage,
      strategy_monitoring_status: monitoringStatus // Per-strategy monitoring status
      // user_id removed - not needed in frontend
    };

    res.json({
      success: true,
      data: formattedResponse,
      cached: true, // This is from DB, so it's cached
      analysis_id: analysis._id.toString(),
      error: null,
      message: null
    });

  } catch (error) {
    console.error('❌ Get Analysis by Instrument API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to fetch analysis by instrument'
    });
  }
});

/**
 * @route GET /api/ai/stats
 * @desc Get user's analysis statistics
 * @access Private
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const stats = await StockAnalysis.getAnalysisStats();
    const recentAnalyses = await StockAnalysis.findActive(5);

    res.json({
      success: true,
      data: {
        stats,
        recent_count: recentAnalyses.length,
        recent_analyses: recentAnalyses.map((analysis) => ({
          _id: analysis._id,
          stock_symbol: analysis.stock_symbol,
          analysis_type: analysis.analysis_type,
          created_at: analysis.created_at,
          top_strategy: analysis.analysis_data.strategies.find((s) => s.isTopPick) || analysis.analysis_data.strategies[0]
        }))
      }
    });

  } catch (error) {
    console.error('❌ Stats API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to fetch analysis statistics'
    });
  }
});

/**
 * @route DELETE /api/ai/analysis/:analysisId
 * @desc Delete a specific analysis
 * @access Private
 */
router.delete('/analysis/:analysisId', authenticateToken, async (req, res) => {
  try {
    const { analysisId } = req.params;
    const userId = req.user.id;

    const analysis = await StockAnalysis.findOne({
      _id: analysisId,
      user_id: userId
    });

    if (!analysis) {
      return res.status(404).json({
        success: false,
        error: 'Analysis not found',
        message: 'The requested analysis was not found or you do not have access to it'
      });
    }

    await StockAnalysis.deleteOne({ _id: analysisId });

    res.json({
      success: true,
      message: 'Analysis deleted successfully'
    });

  } catch (error) {
    console.error('❌ Delete Analysis API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to delete analysis'
    });
  }
});

/**
 * @route GET /api/ai/analysis/:analysisId/progress
 * @desc Get analysis progress status
 * @access Private
 */
router.get('/analysis/:analysisId/progress', authenticateToken, async (req, res) => {
  try {
    const { analysisId } = req.params;
    const userId = req.user.id;

    const analysis = await StockAnalysis.findOne({
      _id: analysisId,
      user_id: userId
    });

    if (!analysis) {
      return res.status(404).json({
        success: false,
        error: 'analysis_not_found',
        message: 'Analysis not found or access denied'
      });
    }

    res.json({
      success: true,
      data: {
        analysis_id: analysis._id,
        status: analysis.status,
        progress: analysis.progress,
        stock_symbol: analysis.stock_symbol,
        analysis_type: analysis.analysis_type,
        created_at: analysis.created_at,
        expires_at: analysis.expires_at,
        // Include partial results if available
        partial_data: analysis.status === 'in_progress' ? {
          market_summary: analysis.analysis_data?.market_summary,
          overall_sentiment: analysis.analysis_data?.overall_sentiment
        } : null
      }
    });

  } catch (error) {
    console.error('❌ Analysis progress error:', error);
    res.status(500).json({
      success: false,
      error: 'progress_fetch_failed',
      message: 'Failed to fetch analysis progress'
    });
  }
});

/**
 * @route GET /api/ai/cache/stats
 * @desc Get AI analysis cache statistics
 * @access Private (Admin only recommended)
 */
router.get('/cache/stats', authenticateToken, async (req, res) => {
  try {
    // Get analysis statistics directly from StockAnalysis collection (no cache)
    const tradingDate = req.query.date ? new Date(req.query.date) : new Date();
    const startOfDay = new Date(tradingDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(tradingDate);
    endOfDay.setHours(23, 59, 59, 999);

    const stats = await StockAnalysis.aggregate([
      {
        $match: {
          created_at: { $gte: startOfDay, $lte: endOfDay }
        }
      },
      {
        $group: {
          _id: '$analysis_type',
          count: { $sum: 1 },
          active_orders: {
            $sum: {
              $cond: [
                { $gt: [{ $size: { $ifNull: ['$placed_orders', []] } }, 0] },
                1,
                0]

            }
          },
          expired: {
            $sum: {
              $cond: [
                { $lt: ['$expires_at', new Date()] },
                1,
                0]

            }
          }
        }
      }]
    );

    res.json({
      success: true,
      data: {
        date: tradingDate.toISOString().split('T')[0],
        statistics: stats,
        total_analyses: stats.reduce((sum, stat) => sum + stat.count, 0),
        note: 'Direct analysis storage (no cache system)'
      }
    });

  } catch (error) {
    console.error('❌ Cache Stats API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to fetch cache statistics'
    });
  }
});

/**
 * @route POST /api/ai/analysis/delete
 * @desc Manually delete analysis for a specific stock (no longer using cache)
 * @access Private (Admin only recommended)
 */
router.post('/analysis/delete', authenticateToken, async (req, res) => {
  try {
    const { instrument_key, analysis_type } = req.body;

    if (!instrument_key || !analysis_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'instrument_key and analysis_type are required'
      });
    }

    // Delete analysis directly from StockAnalysis collection
    const result = await StockAnalysis.findOneAndDelete({
      instrument_key,
      analysis_type
    });

    if (result) {
      res.json({
        success: true,
        message: 'Analysis deleted successfully',
        data: {
          instrument_key,
          analysis_type,
          deleted_analysis: {
            id: result._id,
            stock_symbol: result.stock_symbol,
            created_at: result.created_at,
            expires_at: result.expires_at
          }
        }
      });
    } else {
      res.json({
        success: false,
        message: 'No analysis found to delete',
        data: {
          instrument_key,
          analysis_type
        }
      });
    }

  } catch (error) {
    console.error('❌ Analysis Delete API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to delete analysis'
    });
  }
});

/**
 * @route GET /api/ai/cache/info/:instrument_key
 * @desc Get cache information for a specific stock
 * @access Private
 */
router.get('/cache/info/:instrument_key', authenticateToken, async (req, res) => {
  try {
    const { instrument_key } = req.params;
    const { analysis_type = 'swing' } = req.query;

    // Get existing analysis directly from StockAnalysis collection (no cache)
    const analysis = await StockAnalysis.findByInstrument(instrument_key, analysis_type);

    if (analysis) {
      const now = new Date();
      const isExpired = analysis.expires_at <= now;
      const timeToExpiry = analysis.expires_at.getTime() - now.getTime();

      res.json({
        success: true,
        data: {
          exists: true,
          expired: isExpired,
          expires_at: analysis.expires_at,
          created_at: analysis.created_at,
          updated_at: analysis.updated_at,
          time_to_expiry_ms: timeToExpiry,
          time_to_expiry_hours: Math.round(timeToExpiry / (1000 * 60 * 60) * 10) / 10,
          stock_symbol: analysis.stock_symbol,
          analysis_type: analysis.analysis_type,
          current_price: analysis.current_price,
          has_orders: analysis.hasActiveOrders(),
          total_strategies: analysis.analysis_data?.strategies?.length || 0
        }
      });
    } else {
      res.json({
        success: true,
        data: {
          exists: false,
          message: 'No analysis found for this stock and analysis type'
        }
      });
    }

  } catch (error) {
    console.error('❌ Cache Info API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to fetch cache information'
    });
  }
});

/**
 * @route GET /api/ai/health
 * @desc Check AI service health
 * @access Public
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'AI service is running',
    timestamp: new Date().toISOString(),
    openai_configured: !!process.env.OPENAI_API_KEY,
    cache_enabled: true
  });
});

/**
 * @route POST /api/ai/add-to-watchlist
 * @desc Add stock to watchlist with 'order' source (Sticky)
 * @access Private
 */
router.post('/add-to-watchlist', authenticateToken, async (req, res) => {
  try {
    const { instrument_key } = req.body;

    if (!instrument_key) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'instrument_key is required'
      });
    }

    // Get stock details
    const stockInfo = await Stock.getByInstrumentKey(instrument_key);
    if (!stockInfo) {
      return res.status(404).json({
        success: false,
        error: 'Stock not found',
        message: `No stock found with instrument_key: ${instrument_key}`
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Check if stock is already in watchlist
    const existingItemIndex = user.watchlist.findIndex((item) =>
      item.instrument_key === instrument_key
    );

    if (existingItemIndex !== -1) {
      // Stock exists - update source to 'order' if it's not already
      const currentSource = user.watchlist[existingItemIndex].added_source;

      if (currentSource !== 'order') {
        user.watchlist[existingItemIndex].added_source = 'order';
        await user.save();

        return res.status(200).json({
          success: true,
          message: 'Stock updated in watchlist (marked as order)',
          data: {
            instrument_key: stockInfo.instrument_key,
            trading_symbol: stockInfo.trading_symbol,
            added_source: 'order'
          }
        });
      }

      return res.status(200).json({
        success: true,
        message: 'Stock already in watchlist as order',
        data: {
          instrument_key: stockInfo.instrument_key,
          trading_symbol: stockInfo.trading_symbol,
          added_source: 'order'
        }
      });
    }

    // Check stock limit based on subscription
    const currentStockCount = user.watchlist.length;

    try {
      const stockLimitCheck = await Subscription.canUserAddStock(req.user.id, currentStockCount);

      if (!stockLimitCheck.canAdd) {
        return res.status(403).json({
          success: false,
          error: 'Stock limit reached',
          message: `You can add maximum ${stockLimitCheck.stockLimit} stocks to your watchlist. Current: ${stockLimitCheck.currentCount}`,
          data: {
            stockLimit: stockLimitCheck.stockLimit,
            currentCount: stockLimitCheck.currentCount,
            canAdd: false,
            needsUpgrade: true
          }
        });
      }
    } catch (subscriptionError) {
      console.error('Error checking subscription limits:', subscriptionError);
      return res.status(400).json({
        success: false,
        error: 'Subscription check failed',
        message: subscriptionError.message
      });
    }

    // Add to watchlist
    user.watchlist.push({
      instrument_key: stockInfo.instrument_key,
      trading_symbol: stockInfo.trading_symbol,
      name: stockInfo.name,
      exchange: stockInfo.exchange,
      addedAt: new Date(),
      added_source: 'order' // Explicitly mark as order
    });
    await user.save();

    res.status(201).json({
      success: true,
      message: 'Stock added to watchlist as order',
      data: {
        instrument_key: stockInfo.instrument_key,
        trading_symbol: stockInfo.trading_symbol,
        name: stockInfo.name,
        exchange: stockInfo.exchange,
        addedAt: user.watchlist[user.watchlist.length - 1].addedAt,
        added_source: 'order'
      }
    });

  } catch (error) {
    console.error('❌ Add to Watchlist API Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to add stock to watchlist'
    });
  }
});

export default router;