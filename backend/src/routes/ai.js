import express from 'express';
import aiReviewService from '../services/aiAnalyze.service.js';
import intradayAnalyzeService from '../services/intradayAnalyze.service.js';
import onDemandAnalysisService from '../services/onDemandAnalysisService.js';
import candleFetcherService from '../services/candleFetcher.service.js';
import StockAnalysis from '../models/stockAnalysis.js';
import Stock from '../models/stock.js';
import { Subscription } from '../models/subscription.js';
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

    // Check if stock is weekly_track - if so, run position_management instead of swing
    const user = await User.findById(userId).select('watchlist').lean();
    const watchlistItem = user?.watchlist?.find(item => item.instrument_key === instrument_key);
    const isWeeklyTrack = watchlistItem?.added_source === 'weekly_track';

    // Route to appropriate service based on analysis type or stock source
    if (isWeeklyTrack && analysis_type === 'swing') {
      // Weekly track stock - run position_management analysis
      console.log(`[AI ROUTE] 🎯 Step 1: Stock is weekly_track, routing to position_management for ${stock_symbol}`);

      try {
        // If no cached price, try to fetch from candle data
        if (!current_price) {
          console.log(`[AI ROUTE] 🎯 Step 1.5: No cached price, fetching from candles...`);
          try {
            const candleFetcherService = (await import('../services/candleFetcher.service.js')).default;
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const candles = await candleFetcherService.fetchCandlesFromAPI(
              instrument_key,
              '1d',
              yesterday,
              new Date(),
              false
            );
            if (candles && candles.length > 0) {
              current_price = candles[candles.length - 1].close;
              console.log(`[AI ROUTE] 🎯 Step 1.5: Got price from candles: ${current_price}`);
            }
          } catch (priceError) {
            console.warn(`[AI ROUTE] ⚠️ Could not fetch price: ${priceError.message}`);
          }
        }

        console.log(`[AI ROUTE] 🎯 Step 2: Importing weeklyTrackAnalysisJob...`);
        const weeklyTrackAnalysisJob = (await import('../services/jobs/weeklyTrackAnalysisJob.js')).default;

        console.log(`[AI ROUTE] 🎯 Step 3: Calling analyzeStock with:`, {
          instrument_key,
          trading_symbol: stock_symbol,
          name: stock_name,
          current_price,
          forceReanalyze: forceFresh
        });

        const result = await weeklyTrackAnalysisJob.analyzeStock(
          { instrument_key, trading_symbol: stock_symbol, name: stock_name },
          current_price,
          { forceReanalyze: forceFresh }
        );

        console.log(`[AI ROUTE] 🎯 Step 4: analyzeStock result:`, JSON.stringify(result));

        if (!result.success) {
          console.log(`[AI ROUTE] ❌ Step 5: Analysis failed:`, result.error);
          return res.status(200).json({
            success: false,
            error: result.error || 'position_analysis_failed',
            message: result.error || 'Could not generate position analysis. Make sure this stock has a swing analysis first.',
            is_weekly_track: true
          });
        }

        console.log(`[AI ROUTE] 🎯 Step 6: Fetching saved analysis from DB...`);
        const analysis = await StockAnalysis.findOne({
          instrument_key,
          analysis_type: 'position_management',
          status: 'completed'
        }).sort({ created_at: -1 }).lean();

        console.log(`[AI ROUTE] 🎯 Step 7: Analysis fetched:`, analysis ? analysis._id : 'NOT FOUND');

        if (!analysis) {
          return res.status(200).json({
            success: false,
            error: 'analysis_not_saved',
            message: 'Analysis was generated but could not be retrieved.',
            is_weekly_track: true
          });
        }

        console.log(`[AI ROUTE] ✅ Step 8: Returning success response`);
        console.log(`[AI ROUTE] 🔍 DEBUG analysis_data keys:`, Object.keys(analysis.analysis_data || {}));
        console.log(`[AI ROUTE] 🔍 DEBUG position_management exists:`, !!analysis.analysis_data?.position_management);
        console.log(`[AI ROUTE] 🔍 DEBUG position_management.status:`, analysis.analysis_data?.position_management?.status);

        return res.status(200).json({
          success: true,
          status: 'completed',
          message: result.cached ? 'Position analysis retrieved from cache' : 'Position analysis generated successfully',
          data: {
            _id: analysis._id,
            instrument_key: analysis.instrument_key,
            stock_name: analysis.stock_name,
            stock_symbol: analysis.stock_symbol,
            analysis_type: 'position_management',
            current_price: analysis.current_price,
            analysis_data: analysis.analysis_data,
            status: analysis.status,
            valid_until: analysis.valid_until,
            created_at: analysis.created_at
          },
          is_weekly_track: true,
          from_cache: result.cached || false
        });

      } catch (positionError) {
        console.error(`[AI ROUTE] ❌ Position analysis error:`, positionError.message);
        console.error(`[AI ROUTE] ❌ Stack:`, positionError.stack);
        return res.status(200).json({
          success: false,
          error: 'position_analysis_error',
          message: positionError.message || 'Error generating position analysis',
          is_weekly_track: true
        });
      }
    }

    if (analysis_type === 'intraday') {
      // Use intradayAnalyzeService for news-based intraday analysis
      console.log(`[AI ROUTE] Routing to intradayAnalyzeService for ${stock_symbol}`);

      const result = await intradayAnalyzeService.getOrGenerateAnalysis({
        instrumentKey: instrument_key,
        symbol: stock_symbol,
        forceRefresh: forceFresh
      });

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error,
          message: result.message || 'Intraday analysis not available for this stock'
        });
      }

      // Return intraday analysis result
      const analysis = result.analysis;
      return res.status(200).json({
        success: true,
        status: 'completed',
        message: result.from_cache ? 'Intraday plan retrieved from cache' : 'Intraday plan generated successfully',
        data: {
          _id: analysis._id,
          instrument_key: analysis.instrument_key,
          stock_name: analysis.stock_name,
          stock_symbol: analysis.stock_symbol,
          analysis_type: 'intraday',
          current_price: analysis.current_price,
          analysis_data: analysis.analysis_data,
          status: analysis.status,
          valid_until: analysis.valid_until,
          created_at: analysis.created_at
        },
        from_cache: result.from_cache
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SWING ANALYSIS - Use on-demand analysis service
    // Quick reject (non-setups) returns instantly, full analysis runs in background
    // ═══════════════════════════════════════════════════════════════════════════
    console.log(`[AI ROUTE] Routing to onDemandAnalysisService for ${stock_symbol}`);

    // Run analysis (may be quick reject or full analysis)
    const result = await onDemandAnalysisService.analyze(instrument_key, userId, {
      stock_name,
      stock_symbol,
      forceFresh,
      sendNotification: true
    });

    // Handle blocked analysis (bullish stock during market hours)
    if (result.blocked) {
      return res.status(200).json({
        success: true,
        status: 'blocked',
        message: result.message,
        classification: result.classification,
        stock_info: result.stockInfo,
        indicators: result.indicators
      });
    }

    // Handle errors
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error || 'analysis_failed',
        message: result.error || 'Failed to analyze stock'
      });
    }

    // Handle eliminated stocks
    if (result.eliminated) {
      return res.status(200).json({
        success: true,
        status: 'eliminated',
        message: result.reason,
        stock_info: result.stockInfo
      });
    }

    // Return analysis result (quick reject or full analysis)
    const analysis = result.data;
    const isQuickReject = result.fromQuickReject;

    return res.status(200).json({
      success: true,
      status: 'completed',
      message: isQuickReject
        ? 'Quick classification complete - not a swing buy setup'
        : (result.cached ? 'Analysis retrieved from cache' : 'Analysis generated successfully'),
      data: {
        _id: analysis._id,
        instrument_key: analysis.instrument_key,
        stock_name: analysis.stock_name,
        stock_symbol: analysis.stock_symbol,
        analysis_type: analysis.analysis_type,
        current_price: analysis.current_price,
        analysis_data: analysis.analysis_data,
        status: analysis.status,
        valid_until: analysis.valid_until,
        created_at: analysis.created_at
      },
      from_cache: result.cached || false,
      quick_reject: isQuickReject,
      classification: result.classification
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
    }).lean();

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
    let { analysis_type = 'swing', force_type } = req.query;

    const userId = req.user.id;

    // If force_type is specified, use that regardless of watchlist status
    // This is used when opening from Weekly Discovery screen (always show swing)
    if (force_type) {
      analysis_type = force_type;
      console.log(`[BY-INSTRUMENT] force_type specified: ${force_type}`);
    } else {
      // Check if stock is in user's watchlist with weekly_track source
      // If so, return position_management analysis instead of swing
      const user = await User.findById(userId).select('watchlist').lean();
      const watchlistItem = user?.watchlist?.find(item => item.instrument_key === instrumentKey);
      const isWeeklyTrack = watchlistItem?.added_source === 'weekly_track';

      if (isWeeklyTrack && analysis_type === 'swing') {
        // For weekly_track stocks, return position_management analysis
        analysis_type = 'position_management';
        console.log(`[BY-INSTRUMENT] Stock is weekly_track, switching to position_management analysis`);
      }
    }

    console.log(`[BY-INSTRUMENT] Request for instrumentKey: "${instrumentKey}", analysis_type: "${analysis_type}"`);

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
    // Use .lean() to get plain JavaScript object without Mongoose internals
    const anyAnalysis = await StockAnalysis.findOne({
      instrument_key: instrumentKey,
      analysis_type: analysis_type
    }).sort({ created_at: -1 }).lean(); // Get most recent analysis as plain object

    if (!anyAnalysis) {
      console.log(`[BY-INSTRUMENT] ❌ No analysis found for instrumentKey: "${instrumentKey}", analysis_type: "${analysis_type}"`);

      // For position_management (weekly_track stocks) - always allow manual analysis
      if (analysis_type === 'position_management') {
        return res.status(200).json({
          success: true,
          status: 'not_analyzed',
          error: 'position_analysis_pending',
          message: 'No position analysis available yet.',
          call_to_action: 'Analyze Position',
          is_weekly_track: true,
          can_analyze_manually: true
        });
      }

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

    console.log(`[BY-INSTRUMENT] ✅ Found analysis: ${anyAnalysis._id}, status: ${anyAnalysis.status}, symbol: ${anyAnalysis.stock_symbol}`);

    // If analysis is not completed, return in_progress status (unless failed)
    // Valid completed statuses: 'completed', 'in_position', 'exited', 'expired'
    const completedStatuses = ['completed', 'in_position', 'exited', 'expired'];
    if (!completedStatuses.includes(anyAnalysis.status)) {
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

    // Handle intraday analysis separately (different schema)
    if (analysis_type === 'intraday') {
      const analysis = anyAnalysis;

      console.log(`\n========== [INTRADAY BY-INSTRUMENT] DEBUG ==========`);
      console.log(`[INTRADAY BY-INSTRUMENT] Found analysis for: ${instrumentKey}`);
      console.log(`[INTRADAY BY-INSTRUMENT] analysis._id: ${analysis._id}`);
      console.log(`[INTRADAY BY-INSTRUMENT] analysis.stock_symbol: ${analysis.stock_symbol}`);
      console.log(`[INTRADAY BY-INSTRUMENT] analysis.status: ${analysis.status}`);

      // Convert Mongoose document to plain object to properly access nested fields
      const rawAnalysisData = analysis.analysis_data?.toObject ? analysis.analysis_data.toObject() : (analysis.analysis_data || {});
      console.log(`[INTRADAY BY-INSTRUMENT] Raw analysis_data keys: ${Object.keys(rawAnalysisData).join(', ')}`);
      console.log(`[INTRADAY BY-INSTRUMENT] Raw analysis_data.symbol: ${rawAnalysisData.symbol}`);
      console.log(`[INTRADAY BY-INSTRUMENT] Raw analysis_data.analysis_type: ${rawAnalysisData.analysis_type}`);

      // Create a mutable copy for modifications
      const analysisData = { ...rawAnalysisData };

      // Add symbol and analysis_type to top level if missing (for old cached data)
      if (!analysisData.symbol) {
        console.log(`[INTRADAY BY-INSTRUMENT] FIXING: Adding missing symbol from stock_symbol`);
        analysisData.symbol = analysis.stock_symbol;
      }
      if (!analysisData.analysis_type) {
        console.log(`[INTRADAY BY-INSTRUMENT] FIXING: Adding missing analysis_type`);
        analysisData.analysis_type = 'intraday';
      }
      if (!analysisData.generated_at_ist) {
        console.log(`[INTRADAY BY-INSTRUMENT] FIXING: Adding missing generated_at_ist`);
        analysisData.generated_at_ist = analysis.created_at?.toISOString() || new Date().toISOString();
      }

      // For intraday, map intraday sentiment to overall_sentiment if missing
      if (!analysisData.overall_sentiment && analysisData.intraday?.aggregate_sentiment) {
        console.log(`[INTRADAY BY-INSTRUMENT] FIXING: Adding missing overall_sentiment from intraday`);
        analysisData.overall_sentiment = analysisData.intraday.aggregate_sentiment;
      }

      console.log(`[INTRADAY BY-INSTRUMENT] Final analysisData.symbol: ${analysisData.symbol}`);
      console.log(`[INTRADAY BY-INSTRUMENT] Final analysisData.analysis_type: ${analysisData.analysis_type}`);
      console.log(`[INTRADAY BY-INSTRUMENT] Final analysisData keys: ${Object.keys(analysisData).join(', ')}`);

      const responsePayload = {
        success: true,
        data: {
          _id: analysis._id,
          instrument_key: analysis.instrument_key,
          stock_name: analysis.stock_name,
          stock_symbol: analysis.stock_symbol,
          analysis_type: 'intraday',
          current_price: analysis.current_price,
          analysis_data: analysisData,
          status: analysis.status,
          valid_until: analysis.valid_until,
          created_at: analysis.created_at
        },
        cached: true,
        analysis_id: analysis._id.toString(),
        error: null,
        message: null
      };

      console.log(`[INTRADAY BY-INSTRUMENT] Response analysis_data.symbol: ${responsePayload.data.analysis_data.symbol}`);
      console.log(`[INTRADAY BY-INSTRUMENT] Response analysis_data.analysis_type: ${responsePayload.data.analysis_data.analysis_type}`);
      console.log(`========== [INTRADAY BY-INSTRUMENT] END ==========\n`);

      return res.json(responsePayload);
    }

    // Handle position_management analysis (for weekly_track stocks)
    if (analysis_type === 'position_management') {
      const analysis = anyAnalysis;

      console.log(`[POSITION-MGMT BY-INSTRUMENT] Found analysis for: ${instrumentKey}`);

      // Check if analysis is expired
      const now = new Date();
      const isExpired = analysis.valid_until && now > new Date(analysis.valid_until);

      // Extract position management data
      const positionData = analysis.analysis_data?.position_management || analysis.analysis_data || {};

      // Fix: Ensure current_price is never null (app fails to parse null)
      let currentPrice = analysis.current_price;
      if (currentPrice === null || currentPrice === undefined) {
        console.log(`[POSITION-MGMT BY-INSTRUMENT] ⚠️ current_price is null, fetching from cache/candles...`);

        // Try price cache first
        try {
          const priceCacheService = (await import('../services/priceCache.service.js')).default;
          currentPrice = priceCacheService.getPrice(instrumentKey);
          console.log(`[POSITION-MGMT BY-INSTRUMENT] Price from cache: ${currentPrice}`);
        } catch (e) {
          console.warn(`[POSITION-MGMT BY-INSTRUMENT] Price cache error: ${e.message}`);
        }

        // If still null, try from candle data
        if (!currentPrice) {
          try {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const candles = await candleFetcherService.fetchCandlesFromAPI(
              instrumentKey,
              '1d',
              yesterday,
              new Date(),
              false
            );
            if (candles && candles.length > 0) {
              currentPrice = candles[candles.length - 1].close;
              console.log(`[POSITION-MGMT BY-INSTRUMENT] Price from candles: ${currentPrice}`);
            }
          } catch (e) {
            console.warn(`[POSITION-MGMT BY-INSTRUMENT] Candle fetch error: ${e.message}`);
          }
        }

        // Fallback to original_levels entry price or market_summary
        if (!currentPrice) {
          currentPrice = analysis.analysis_data?.original_levels?.entry
            || analysis.analysis_data?.market_summary?.last
            || 0;
          console.log(`[POSITION-MGMT BY-INSTRUMENT] Price from fallback: ${currentPrice}`);
        }

        // Update the cached analysis with the correct price (async, don't wait)
        if (currentPrice && currentPrice !== 0) {
          StockAnalysis.updateOne(
            { _id: analysis._id },
            { $set: { current_price: currentPrice } }
          ).catch(err => console.warn(`[POSITION-MGMT] Failed to update price: ${err.message}`));
        }
      }

      const responsePayload = {
        success: true,
        data: {
          _id: analysis._id,
          instrument_key: analysis.instrument_key,
          stock_name: analysis.stock_name,
          stock_symbol: analysis.stock_symbol,
          analysis_type: 'position_management',
          current_price: currentPrice,
          analysis_data: {
            schema_version: '1.0',
            symbol: analysis.stock_symbol,
            analysis_type: 'position_management',
            generated_at_ist: analysis.created_at?.toISOString() || new Date().toISOString(),
            // Wrap position data in position_management key (app expects this structure)
            position_management: positionData,
            original_levels: analysis.analysis_data?.original_levels || null,
            original_swing_analysis_id: analysis.analysis_data?.original_swing_analysis_id || null
          },
          status: analysis.status,
          valid_until: analysis.valid_until,
          is_expired: isExpired,
          created_at: analysis.created_at
        },
        cached: true,
        analysis_id: analysis._id.toString(),
        is_weekly_track: true,
        error: null,
        message: isExpired ? 'Position analysis expired. New analysis runs at 4:00 PM.' : null
      };

      console.log(`[POSITION-MGMT BY-INSTRUMENT] Returning position_management for ${analysis.stock_symbol}, current_price: ${currentPrice}`);
      return res.json(responsePayload);
    }

    // Validate required fields exist for completed SWING analysis
    // Support both old schema (market_summary + strategies) and new schema (setup_score + verdict + trading_plan)
    const hasOldSchemaData = anyAnalysis.analysis_data?.market_summary?.last &&
      anyAnalysis.analysis_data?.market_summary?.trend;
    const hasNewSchemaData = anyAnalysis.analysis_data?.setup_score &&
      anyAnalysis.analysis_data?.verdict;

    if (!hasOldSchemaData && !hasNewSchemaData) {
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

    // Check if analysis is expired (for weekly watchlist stocks)
    const now = new Date();
    const isExpired = analysis.valid_until && now > new Date(analysis.valid_until);

    // Generate expiry message for users
    let expiryMessage = null;
    if (isExpired) {
      expiryMessage = 'New weekly analysis will be available from Saturday 6 PM';
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
      valid_until: analysis.valid_until,
      expires_at: analysis.expires_at,
      is_expired: isExpired,
      expiry_message: expiryMessage
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
    }).lean();

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
    }).lean();

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
        valid_until: analysis.valid_until, // 🆕 Add validity period
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

// REMOVED: /api/ai/add-to-watchlist endpoint (was for order placement, now deprecated)
// Use /api/watchlist/track-weekly for weekly tracking instead

/**
 * @route POST /api/ai/evaluate-missed-entry
 * @desc Evaluate if user should still enter a trade when entry price has been passed
 * @access Private
 */
router.post('/evaluate-missed-entry', authenticateToken, async (req, res) => {
  try {
    const {
      instrument_key,
      original_entry,
      current_price,
      target,
      stop_loss,
      strategy_type,
      analysis_type = 'swing'
    } = req.body;

    // Validate required fields
    if (!instrument_key || !original_entry || !current_price || !target || !stop_loss || !strategy_type) {
      return res.status(400).json({
        success: false,
        error: 'missing_fields',
        message: 'Required fields: instrument_key, original_entry, current_price, target, stop_loss, strategy_type'
      });
    }

    // Validate strategy type
    if (!['BUY', 'SELL'].includes(strategy_type.toUpperCase())) {
      return res.status(400).json({
        success: false,
        error: 'invalid_strategy_type',
        message: 'strategy_type must be BUY or SELL'
      });
    }

    // Get stock info
    const stockInfo = await Stock.getByInstrumentKey(instrument_key);
    if (!stockInfo) {
      return res.status(404).json({
        success: false,
        error: 'stock_not_found',
        message: `No stock found with instrument_key: ${instrument_key}`
      });
    }

    console.log(`[EVALUATE MISSED ENTRY API] 🔍 Request for ${stockInfo.trading_symbol}`);
    console.log(`[EVALUATE MISSED ENTRY API] Entry: ₹${original_entry}, Current: ₹${current_price}`);

    // Import aiReviewService
    const { aiReviewService } = await import('../services/ai/aiReview.service.js');

    // Evaluate the missed entry
    const result = await aiReviewService.evaluateMissedEntry({
      stockSymbol: stockInfo.trading_symbol,
      stockName: stockInfo.name,
      originalEntry: parseFloat(original_entry),
      currentPrice: parseFloat(current_price),
      target: parseFloat(target),
      stopLoss: parseFloat(stop_loss),
      strategyType: strategy_type.toUpperCase(),
      analysisType: analysis_type
    });

    console.log(`[EVALUATE MISSED ENTRY API] ✅ Verdict: ${result.verdict}`);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('❌ Evaluate Missed Entry API Error:', error);
    res.status(500).json({
      success: false,
      error: 'internal_error',
      message: 'Failed to evaluate missed entry'
    });
  }
});

export default router;