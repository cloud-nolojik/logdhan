import express, { response } from 'express';
import { auth } from '../middleware/auth.js';
import StockAnalysis from '../models/stockAnalysis.js';
import AnalysisSession from '../models/analysisSession.js';
import aiAnalyzeService from '../services/aiAnalyze.service.js';
import { User } from '../models/user.js';
import { Subscription } from '../models/subscription.js';
import { getCurrentPrice } from '../utils/stockDb.js';
import upstoxMarketTimingService from '../services/upstoxMarketTiming.service.js';
import { messagingService } from '../services/messaging/messaging.service.js';
import MarketHoursUtil from '../utils/marketHours.js';

const router = express.Router();

// Helper function to send WhatsApp notification when bulk analysis completes
async function sendBulkAnalysisCompletionNotification(session) {
  try {
    const user = await User.findById(session.user_id);
    if (user && user.mobileNumber) {
      const analysisData = {
        userName: user.name || user.email?.split('@')[0] || 'logdhanuser',
        stocksProcessed: session.successful_stocks || session.stocks?.length || 0
      };

      await messagingService.sendAnalysisServiceUpdate(
        user.mobileNumber,
        analysisData
      );

    } else {

    }
  } catch (notificationError) {
    console.error(`❌ Failed to send bulk analysis completion notification for session ${session.session_id}:`, notificationError);
    // Don't fail the entire session if notification fails
  }
}

// Helper function to get user-friendly bulk analysis messages
// NOTE: Bulk analysis now runs at 7:30 AM - analysis available anytime
function getBulkAnalysisMessage(reason) {
  const messages = {
    before_session: "✅ Analysis is available anytime. Fresh bulk analysis runs daily at 7:30 AM before market opens.",
    session_ended: "✅ Analysis is available anytime. Fresh bulk analysis runs daily at 7:30 AM before market opens.",
    weekend_session: "📈 Weekend - analysis available! Fresh analysis will run Monday 7:30 AM.",
    holiday: "🏖️ Holiday - analysis available! Fresh analysis will run next trading day 7:30 AM.",
    outside_window: "✅ Analysis is available anytime. Fresh bulk analysis runs daily at 7:30 AM.",
    weekday_session: "✅ Analysis available! Fresh bulk analysis runs daily at 7:30 AM before market opens.",
    monday_morning: "🌅 Monday morning - fresh analysis running at 7:30 AM before market opens."
  };

  return messages[reason] || "Analysis is available. Fresh bulk analysis runs daily at 7:30 AM.";
}
import mongoose from 'mongoose';

// Get user's watchlist as stock list
async function getUserWatchlist(userId) {
  try {
    const user = await User.findById(userId);
    if (!user || !user.watchlist) {
      ////console.log((`📊 No watchlist found for user ${userId}`);
      return [];
    }

    const watchlist = user.watchlist || [];
    // Only log if called from non-status endpoints to reduce spam
    const stack = new Error().stack;
    if (!stack.includes('/status')) {

      ////console.log((`📊 Loaded ${watchlist.length} stocks from user's watchlist`);
    }return watchlist;
  } catch (error) {
    console.error('❌ Error loading user watchlist:', error);
    return [];
  }
}

// Route: Trigger bulk analysis for all stocks in the list
router.post('/analyze-all', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { analysis_type = 'swing', resume = false } = req.body;

    //console.log(`🚀 [ANALYZE-ALL] Mobile app called analyze-all: userId=${userId}, type=${analysis_type}, resume=${resume}`);

    // Delete ALL existing sessions for this user - no conditions, always start fresh
    //console.log(`🗑️ [ANALYZE-ALL] Deleting all existing sessions for user...`);
    const sessionDeleteResult = await AnalysisSession.deleteMany({
      user_id: userId,
      analysis_type: analysis_type
    });
    //console.log(`🗑️ [ANALYZE-ALL] Deleted ${sessionDeleteResult.deletedCount} existing sessions`);

    // Check if bulk analysis is allowed (5.00 PM on market close till next 8.59 AM)
    const analysisPermission = await StockAnalysis.isBulkAnalysisAllowed();

    if (!analysisPermission.allowed) {

      return res.status(423).json({
        success: false,
        error: 'bulk_analysis_not_allowed',
        message: getBulkAnalysisMessage(analysisPermission.reason),
        reason: analysisPermission.reason,
        nextAllowed: analysisPermission.nextAllowed,
        validUntil: analysisPermission.validUntil
      });
    }

    // Check if user can analyze stocks (trial expiry check)
    // try {
    //     const analysisPermissionCheck = await Subscription.canUserAnalyzeStock(userId);

    //     if (!analysisPermissionCheck.canAnalyze) {
    //         return res.status(403).json({
    //             success: false,
    //             error: 'analysis_not_allowed',
    //             message: analysisPermissionCheck.isTrialExpired 
    //                 ? 'Your free trial has expired. Please subscribe to continue analyzing stocks.'
    //                 : 'You need an active subscription to analyze stocks.',
    //             data: {
    //                 planId: analysisPermissionCheck.planId,
    //                 isTrialExpired: analysisPermissionCheck.isTrialExpired,
    //                 trialExpiryDate: analysisPermissionCheck.trialExpiryDate,
    //                 needsUpgrade: true
    //             }
    //         });
    //     }
    // } catch (subscriptionError) {
    //     console.error('Error checking analysis permission:', subscriptionError);
    //     return res.status(400).json({
    //         success: false,
    //         error: 'subscription_check_failed',
    //         message: subscriptionError.message
    //     });
    // }

    // Get user's watchlist
    const watchlistStocks = await getUserWatchlist(userId);
    if (watchlistStocks.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No stocks found in watchlist',
        message: 'Your watchlist is empty. Please add stocks to your watchlist before running bulk analysis.'
      });
    }

    // Only delete expired or failed analyses - keep valid ones that haven't expired
    const now = new Date();
    const deleteResult = await StockAnalysis.deleteMany({
      analysis_type: analysis_type,
      $or: [
      { expires_at: { $lt: now } }, // Expired analyses
      { status: 'failed' }, // Failed analyses
      { status: 'in_progress' }, // ALL in_progress analyses
      { status: 'pending' } // ALL pending analyses
      ]
    });

    // Create new session (always fresh)
    const session = await AnalysisSession.createSession(userId, watchlistStocks, analysis_type);
    //console.log(`✅ [SESSION CREATED] New session: ${session.session_id} for ${watchlistStocks.length} stocks, userId=${userId}`);

    // CRITICAL: Update session to "running" and WAIT for database write completion
    session.status = 'running';
    session.started_at = new Date();
    session.last_updated = new Date();

    // Ensure session is fully saved to database before proceeding
    await session.save();
    //console.log(`✅ [SESSION STATUS] Session fully saved to database as 'running': ${session.session_id}`);

    // Double-check by reloading from database
    const verifySession = await AnalysisSession.findById(session._id);
    //console.log(`🔍 [SESSION VERIFY] Database verification - status: ${verifySession?.status}, id: ${verifySession?.session_id}`);

    // Start background processing IMMEDIATELY after database save
    //console.log(`🚀 [BACKGROUND] Starting background processing for verified session: ${session.session_id}, status: ${session.status}`);

    // Start processing immediately
    setImmediate(async () => {
      try {
        //console.log(`🔥 [BACKGROUND] Background processing starting for: ${session.session_id}`);
        await processSessionBasedBulkAnalysis(session);
        //console.log(`✅ [BACKGROUND] Background processing completed for: ${session.session_id}`);
      } catch (error) {
        console.error(`❌ [BACKGROUND] Background processing failed for ${session.session_id}:`, error);
        try {
          const failedSession = await AnalysisSession.findById(session._id);
          if (failedSession) {
            failedSession.status = 'failed';
            failedSession.error_message = error.message;
            failedSession.completed_at = new Date();
            await failedSession.save();
            //console.log(`💀 [BACKGROUND] Marked session as failed: ${session.session_id}`);
          }
        } catch (saveError) {
          console.error(`❌ [BACKGROUND] Failed to mark session as failed: ${saveError.message}`);
        }
      }
    });

    const responseData = {
      session_id: session.session_id,
      total_stocks: session.total_stocks,
      processed_stocks: session.processed_stocks,
      analysis_type: analysis_type,
      estimated_time_minutes: Math.ceil((session.total_stocks - session.processed_stocks) * 1.5),
      status: session.status
    };

    //console.log(`📤 [ANALYZE-ALL RESPONSE] Returning session_id=${responseData.session_id}, status=${responseData.status}, total_stocks=${responseData.total_stocks}`);

    const finalResponse = {
      success: true,
      message: 'Bulk analysis started',
      data: responseData
    };

    //console.log("bulk analysis session response:", JSON.stringify(finalResponse));
    res.status(200).json(finalResponse);

  } catch (error) {
    console.error('❌ Error starting bulk analysis:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start bulk analysis',
      message: error.message
    });
  }
});

// Route: Cancel bulk analysis
router.post('/cancel', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { analysis_type = 'swing' } = req.body;

    ////console.log((`🛑 Cancelling bulk analysis for user ${userId}, type: ${analysis_type}`);

    // Find active session
    const session = await AnalysisSession.findActiveSession(userId, analysis_type);

    if (!session) {
      return res.status(200).json({
        success: true,
        message: 'Analysis has already completed successfully.',
        status: 'already_completed'
      });
    }

    // Mark session as cancelled
    session.status = 'cancelled';
    session.cancelled_at = new Date();
    session.completed_at = new Date();
    session.last_updated = new Date();
    await session.save();

    ////console.log((`✅ Cancelled session: ${session.session_id}`);

    res.status(200).json({
      success: true,
      message: 'Analysis cancelled successfully',
      data: {
        session_id: session.session_id,
        total_stocks: session.total_stocks,
        analysis_type: analysis_type,
        estimated_time_minutes: 0, // No time remaining since cancelled
        status: session.status,
        processed_stocks: session.processed_stocks,
        cancelled_at: session.cancelled_at
      }
    });

  } catch (error) {
    console.error('❌ Error cancelling analysis:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel analysis',
      message: error.message
    });
  }
});

// Route: Get bulk analysis status
router.get('/status', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { analysis_type = 'swing' } = req.query;

    // Find the single session for this user (latest one)
    let activeSession = await AnalysisSession.findOne({
      user_id: userId,
      analysis_type: analysis_type
    }).sort({ created_at: -1 });

    //console.log(`📋 [SESSION SEARCH] Single session found: ${activeSession ? `${activeSession.session_id} (${activeSession.status})` : 'null'}`);

    // If there's an active or resumable session, use session-based status
    if (activeSession) {
      // Check if session is timed out
      if (activeSession.isTimedOut()) {
        activeSession.status = 'failed';
        activeSession.error_message = 'Session timed out due to inactivity';
        activeSession.completed_at = new Date();
        await activeSession.save();
      }

      // Check if current stock processing is timed out
      if (activeSession.isCurrentStockTimedOut()) {
        await activeSession.timeoutCurrentStock();
      }

      const isComplete = activeSession.processed_stocks >= activeSession.total_stocks ||
      activeSession.status === 'completed' ||
      activeSession.status === 'cancelled' ||
      activeSession.status === 'failed';

      // Prepare individual stock details with their current status and strategy data
      const stockDetails = await Promise.all(activeSession.metadata.watchlist_stocks.map(async (stock) => {
        let stockStatus = 'pending';
        if (stock.processed) {
          // Check session-level error first
          if (stock.error_reason) {
            stockStatus = 'failed';
          } else {
            // Check actual analysis document status for failures like insufficientData
            try {
              const StockAnalysis = (await import('../models/stockAnalysis.js')).default;

              // Use started_at if created_at is undefined
              let sessionDate;
              try {
                const rawDate = activeSession.created_at || activeSession.started_at;
                sessionDate = rawDate instanceof Date ?
                rawDate :
                new Date(rawDate);

                // If date is invalid, use a fallback (1 hour ago)
                if (isNaN(sessionDate.getTime())) {
                  sessionDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
                  console.warn(`⚠️ Invalid session date for ${stock.trading_symbol}, using fallback date`);
                }
              } catch (dateError) {
                sessionDate = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
                console.warn(`⚠️ Date parsing error for ${stock.trading_symbol}, using fallback date:`, dateError.message);
              }

              const analysis = await StockAnalysis.findOne({
                stock_symbol: stock.trading_symbol,
                created_at: { $gte: sessionDate } // Only check analyses from this session
              }).sort({ created_at: -1 });

              if (analysis && (analysis.status === 'failed' || analysis.analysis_data?.insufficientData === true)) {
                stockStatus = 'failed';
              } else {
                stockStatus = 'completed';
              }
            } catch (analysisCheckError) {
              console.warn(`⚠️ Could not check analysis status for ${stock.trading_symbol}:`, analysisCheckError.message);
              stockStatus = 'completed'; // Default to completed if we can't check
            }
          }
        } else if (activeSession.current_stock_key === stock.instrument_key) {
          // Only show as in_progress if session is actually running
          if (activeSession.status === 'in_progress' || activeSession.status === 'running') {
            stockStatus = 'in_progress';
          } else if (activeSession.status === 'cancelled') {
            // If session was cancelled while processing this stock, show as pending
            stockStatus = 'pending';
          } else {
            // For other states (failed, completed), show as pending
            stockStatus = 'pending';
          }
        }

        const stockDetail = {
          instrument_key: stock.instrument_key,
          stock_name: stock.stock_name,
          trading_symbol: stock.trading_symbol,
          status: stockStatus,
          error_reason: stock.error_reason || null,
          processing_started_at: stock.processing_started_at || null,
          processing_completed_at: stock.processing_completed_at || null
        };

        // For completed stocks, fetch strategy data
        if (stockStatus === 'completed') {
          try {
            const StockAnalysis = (await import('../models/stockAnalysis.js')).default;
            const analysis = await StockAnalysis.findOne({
              stock_symbol: stock.trading_symbol,
              status: 'completed',
              expires_at: { $gt: new Date() },
              // Only get valid analyses with actual strategies
              $and: [
              { 'analysis_data.insufficientData': { $ne: true } },
              { 'analysis_data.strategies.0': { $exists: true } }]

            }).sort({ created_at: -1 });

            if (analysis && analysis.analysis_data?.strategies?.length > 0) {
              const strategy = analysis.analysis_data.strategies[0]; // Get the first/primary strategy
              stockDetail.strategy = {
                id: strategy.id,
                type: strategy.type,
                alignment: strategy.alignment || "neutral",
                title: strategy.title,
                confidence: strategy.confidence,
                entryType: strategy.entryType || "limit",
                entry: strategy.entry,
                entryRange: strategy.entryRange || null,
                target: strategy.target,
                stopLoss: strategy.stop_loss || strategy.stopLoss, // Handle both field names
                riskReward: strategy.riskReward || strategy.risk_reward || 1.0, // Handle both field names
                timeframe: strategy.timeframe || "swing", // Default timeframe
                indicators: strategy.indicators || null,
                reasoning: strategy.reasoning || null,
                warnings: strategy.warnings || null,
                triggers: strategy.triggers || null,
                invalidations: strategy.invalidations || null,
                beginner_summary: strategy.beginner_summary || null,
                why_in_plain_words: strategy.why_in_plain_words || null,
                risk_meter: strategy.risk_meter || null,
                analysis_id: analysis._id.toString()
              };
              stockDetail.current_price = analysis.current_price;
            }
          } catch (strategyError) {
            console.warn(`⚠️ Failed to fetch strategy for ${stock.trading_symbol}:`, strategyError.message);
          }
        }

        return stockDetail;
      }));

      // Calculate actual completed/failed counts based on real status
      const actualCompletedCount = stockDetails.filter((s) => s.status === 'completed').length;
      const actualFailedCount = stockDetails.filter((s) => s.status === 'failed').length;
      const actualInProgressCount = stockDetails.filter((s) => s.status === 'in_progress').length;
      const actualPendingCount = stockDetails.filter((s) => s.status === 'pending').length;

      const sessionResponseData = {
        session_id: activeSession.session_id,
        target_count: activeSession.total_stocks,
        total_analyses: stockDetails.length, // Count actual current analyses, not processed_stocks
        completed: actualCompletedCount,
        in_progress: actualInProgressCount,
        pending: actualPendingCount,
        failed: actualFailedCount,
        progress_percentage: Math.round(actualCompletedCount / stockDetails.length * 100), // Calculate based on actual analyses
        is_complete: isComplete,
        analysis_type: analysis_type,
        status: activeSession.status === 'completed' ? 'completed' : isComplete ? 'completed' : activeSession.status,
        current_stock: activeSession.current_stock_key,
        session_status: activeSession.status === 'completed' ? 'completed' : isComplete ? 'completed' : activeSession.status,
        started_at: activeSession.started_at,
        last_updated: activeSession.last_updated,
        estimated_completion: activeSession.metadata?.estimated_completion_time,
        stocks: stockDetails
      };

      //console.log("bulk analysis status response:", JSON.stringify({
      //     success: true,
      //     data: sessionResponseData
      // }));

      return res.status(200).json({
        success: true,
        data: sessionResponseData
      });
    }

    // No session found - return default "no analysis running" status
    const stocks = await getUserWatchlist(userId);
    const targetCount = stocks.length;

    const noSessionResponseData = {
      session_id: null,
      target_count: targetCount,
      total_analyses: 0,
      completed: 0,
      in_progress: 0,
      pending: 0,
      failed: 0,
      progress_percentage: 0,
      is_complete: false,
      analysis_type: analysis_type,
      status: 'pending',
      current_stock: null,
      session_status: null,
      started_at: null,
      last_updated: null,
      estimated_completion: null
    };

    res.status(200).json({
      success: true,
      data: noSessionResponseData
    });

  } catch (error) {
    console.error('❌ Error getting bulk analysis status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get status',
      message: error.message
    });
  }
});

// Route: Get all completed analyses sorted by best confidence
router.get('/strategies', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { analysis_type = 'swing', limit = 50 } = req.query;

    ////console.log((`📊 Fetching strategies for user ${userId}, type: ${analysis_type}`);

    // Convert userId to ObjectId for proper database matching
    let userObjectId;
    try {
      if (mongoose.Types.ObjectId.isValid(userId)) {
        userObjectId = mongoose.Types.ObjectId.createFromHexString(userId);
      } else {
        userObjectId = userId;
      }
    } catch (error) {
      console.error('❌ Error converting userId to ObjectId:', error.message);
      userObjectId = userId;
    }

    // Fetch only valid completed analyses (with actual strategies, not insufficient data failures)
    const analyses = await StockAnalysis.find({
      analysis_type: analysis_type,
      status: 'completed',
      expires_at: { $gt: new Date() },
      // Only include analyses with actual usable data
      $and: [
      { 'analysis_data.insufficientData': { $ne: true } },
      { 'analysis_data.strategies.0': { $exists: true } } // Has at least one strategy
      ]
    }).
    select('instrument_key stock_name stock_symbol current_price analysis_data created_at status progress').
    sort({ created_at: -1 });

    ////console.log((`📊 Found ${analyses.length} analyses (completed + failed)`);

    // Extract and rank strategies
    const allStrategies = [];

    let noTradeCount = 0;

    analyses.forEach((analysis) => {
      if (analysis.status === 'failed') {
        // Handle failed analyses - show them as failed entries
        allStrategies.push({
          analysis_id: analysis._id,
          instrument_key: analysis.instrument_key,
          stock_name: analysis.stock_name,
          stock_symbol: analysis.stock_symbol,
          current_price: analysis.current_price || null,
          created_at: analysis.created_at,
          status: 'failed', // Mark as failed
          strategy: {
            id: 'failed',
            type: 'FAILED',
            title: 'Analysis Failed',
            confidence: 0,
            entry: 0,
            target: 0,
            stopLoss: 0,
            riskReward: 0,
            timeframe: 'N/A',
            risk_meter: { label: 'Unknown', score: 0 },
            beginner_summary: {
              one_liner: `Failed: ${analysis.progress?.current_step || 'Price data unavailable'}`,
              steps: ['Analysis could not be completed'],
              checklist: ['Check market hours', 'Verify stock symbol']
            },
            error_reason: analysis.analysis_data?.error_reason || analysis.progress?.current_step || 'Unknown error'
          },
          market_summary: null,
          overall_sentiment: 'NEUTRAL'
        });
      } else if (analysis.analysis_data && analysis.analysis_data.strategies) {
        // Handle successful analyses
        analysis.analysis_data.strategies.forEach((strategy) => {
          // Include all strategies, but track NO_TRADE separately
          if (strategy.type === 'NO_TRADE') {
            noTradeCount++;
          }

          // Include tradeable strategies and NO_TRADE with confidence > 0
          if (strategy.confidence > 0) {
            allStrategies.push({
              analysis_id: analysis._id,
              instrument_key: analysis.instrument_key,
              stock_name: analysis.stock_name,
              stock_symbol: analysis.stock_symbol,
              current_price: analysis.current_price,
              created_at: analysis.created_at,
              status: 'completed',
              strategy: {
                id: strategy.id,
                type: strategy.type,
                title: strategy.title,
                confidence: strategy.confidence,
                entry: strategy.entry,
                target: strategy.target,
                stopLoss: strategy.stopLoss,
                riskReward: strategy.riskReward,
                timeframe: strategy.timeframe,
                risk_meter: strategy.risk_meter,
                beginner_summary: strategy.beginner_summary,
                archetype: strategy.archetype,
                alignment: strategy.alignment,
                isTopPick: strategy.isTopPick,
                actionability: strategy.actionability,
                score: strategy.score,
                score_band: strategy.score_band
              },
              market_summary: analysis.analysis_data.market_summary,
              overall_sentiment: analysis.analysis_data.overall_sentiment
            });
          }
        });
      }
    });

    // Sort by confidence score (highest first)
    allStrategies.sort((a, b) => b.strategy.confidence - a.strategy.confidence);

    // Apply limit to final strategies array (after sorting)
    const limitedStrategies = allStrategies.slice(0, parseInt(limit));

    ////console.log((`📊 Sorted and limited to ${limitedStrategies.length} strategies from ${allStrategies.length} total`);

    // Group by sentiment and risk for additional insights (using limited strategies)
    const sentimentGroups = {
      BULLISH: limitedStrategies.filter((s) => s.overall_sentiment === 'BULLISH'),
      BEARISH: limitedStrategies.filter((s) => s.overall_sentiment === 'BEARISH'),
      NEUTRAL: limitedStrategies.filter((s) => s.overall_sentiment === 'NEUTRAL')
    };

    const riskGroups = {
      Low: limitedStrategies.filter((s) => s.strategy.risk_meter === 'Low'),
      Medium: limitedStrategies.filter((s) => s.strategy.risk_meter === 'Medium'),
      High: limitedStrategies.filter((s) => s.strategy.risk_meter === 'High')
    };

    // Count successful vs failed strategies (using limited strategies)
    const successfulStrategies = limitedStrategies.filter((s) => s.status !== 'failed');
    const failedStrategies = limitedStrategies.filter((s) => s.status === 'failed');

    res.status(200).json({
      success: true,
      data: {
        strategies: limitedStrategies,
        summary: {
          total_strategies: limitedStrategies.length,
          total_stocks_analyzed: analyses.length,
          successful_analyses: successfulStrategies.length,
          failed_analyses: failedStrategies.length,
          no_trade_count: noTradeCount,
          avg_confidence: successfulStrategies.length > 0 ?
          (successfulStrategies.reduce((sum, s) => sum + s.strategy.confidence, 0) / successfulStrategies.length).toFixed(3) : 0,
          sentiment_breakdown: {
            BULLISH: sentimentGroups.BULLISH.length,
            BEARISH: sentimentGroups.BEARISH.length,
            NEUTRAL: sentimentGroups.NEUTRAL.length
          },
          risk_breakdown: {
            Low: riskGroups.Low.length,
            Medium: riskGroups.Medium.length,
            High: riskGroups.High.length
          },
          strategy_types: {
            BUY: limitedStrategies.filter((s) => s.strategy.type === 'BUY').length,
            SELL: limitedStrategies.filter((s) => s.strategy.type === 'SELL').length,
            NO_TRADE: limitedStrategies.filter((s) => s.strategy.type === 'NO_TRADE').length,
            FAILED: limitedStrategies.filter((s) => s.strategy.type === 'FAILED').length
          }
        }
      }
    });

  } catch (error) {
    console.error('❌ Error fetching strategies:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch strategies',
      message: error.message
    });
  }
});

// Background function to process bulk analysis
// async function processBulkAnalysis(userId, stocks, analysisType) {
//     ////console.log((`🔄 [BULK ANALYSIS] Starting background processing for user ${userId} with ${stocks.length} stocks, type: ${analysisType}`);
//     let completed = 0;
//     let failed = 0;
//     let dailyLimitReached = false;

//     // Process stocks in smaller batches to avoid overwhelming Upstox API
//     const batchSize = 3; // Reduced from 5 to 3 to prevent rate limiting
//     const totalBatches = Math.ceil(stocks.length / batchSize);

//     for (let i = 0; i < totalBatches; i++) {
//         const batchStart = i * batchSize;
//         const batchEnd = Math.min(batchStart + batchSize, stocks.length);
//         const batch = stocks.slice(batchStart, batchEnd);

//         ////console.log((`📦 [BULK ANALYSIS] Processing batch ${i + 1}/${totalBatches} (stocks ${batchStart + 1}-${batchEnd})`);

//         // Process batch in parallel
//         const batchPromises = batch.map(async (stock, index) => {
//             try {
//                 ////console.log((`🔍 [BULK ANALYSIS] Analyzing ${stock.trading_symbol} (${stock.name})`);
//                 if (dailyLimitReached) {
//                     return;
//                 }

//                 // Fetch real current price
//                 let currentPrice = null;
//                 try {
//                     currentPrice = await getCurrentPrice(stock.instrument_key);
//                     ////console.log((`💰 [BULK ANALYSIS] Price fetched for ${stock.trading_symbol}: ₹${currentPrice}`);
//                 } catch (priceError) {
//                     console.error(`❌ [BULK ANALYSIS] Price fetch failed for ${stock.trading_symbol}:`, priceError.message);
//                     // Skip this stock if we can't get the price
//                     failed++;

//                     // Create a failed analysis record
//                     try {
//                         const failedAnalysis = await StockAnalysis.findOneAndUpdate(
//                             {
//                                 instrument_key: stock.instrument_key,
//                                 analysis_type: analysisType
//                             },
//                             {
//                                 instrument_key: stock.instrument_key,
//                                 stock_name: stock.name,
//                                 stock_symbol: stock.trading_symbol,
//                                 analysis_type: analysisType,
//                                 // current_price: undefined (omitted for failed analysis)
//                                 status: 'failed',
//                                 expires_at: await StockAnalysis.getExpiryTime(),
//                                 progress: {
//                                     percentage: 0,
//                                     current_step: `Price fetch failed: ${priceError.message}`,
//                                     steps_completed: 0,
//                                     total_steps: 8,
//                                     estimated_time_remaining: 0,
//                                     last_updated: new Date()
//                                 },
//                                 analysis_data: {
//                                     schema_version: '1.3',
//                                     symbol: stock.trading_symbol,
//                                     analysis_type: analysisType,
//                                     insufficientData: true,
//                                     strategies: [],
//                                     overall_sentiment: 'NEUTRAL',
//                                     error_reason: `Price fetch failed: ${priceError.message}`,
//                                     failed_at: new Date().toISOString()
//                                 },
//                                 created_at: new Date()
//                             },
//                             {
//                                 upsert: true,
//                                 new: true,
//                                 runValidators: true
//                             }
//                         );
//                         ////console.log((`📝 Created failed analysis record for ${stock.trading_symbol} (price fetch failed)`);
//                     } catch (saveError) {
//                         console.error(`❌ Failed to save failed analysis record for ${stock.trading_symbol}:`, saveError.message);
//                     }

//                     return; // Skip to next stock
//                 }

//                 // Convert price to number and validate
//                 const numericPrice = parseFloat(currentPrice);
//                 if (!currentPrice || isNaN(numericPrice) || numericPrice <= 0) {
//                     ////console.log((`⚠️ [BULK ANALYSIS] Invalid price for ${stock.trading_symbol} (${currentPrice}), skipping`);
//                     failed++;

//                     // Create failed record for invalid price
//                     try {
//                         const failedAnalysis = await StockAnalysis.findOneAndUpdate(
//                             {
//                                 instrument_key: stock.instrument_key,
//                                 analysis_type: analysisType
//                             },
//                             {
//                             instrument_key: stock.instrument_key,
//                             stock_name: stock.name,
//                             stock_symbol: stock.trading_symbol,
//                             analysis_type: analysisType,
//                             // current_price: undefined (omitted for failed analysis)
//                             status: 'failed',
//                             expires_at: await StockAnalysis.getExpiryTime(),
//                             progress: {
//                                 percentage: 0,
//                                 current_step: `Invalid price: ${currentPrice}`,
//                                 steps_completed: 0,
//                                 total_steps: 8,
//                                 estimated_time_remaining: 0,
//                                 last_updated: new Date()
//                             },
//                             analysis_data: {
//                                 schema_version: '1.3',
//                                 symbol: stock.trading_symbol,
//                                 analysis_type: analysisType,
//                                 insufficientData: true,
//                                 strategies: [],
//                                 overall_sentiment: 'NEUTRAL',
//                                 error_reason: `Invalid or missing price data: ${currentPrice}`,
//                                 failed_at: new Date().toISOString()
//                             },
//                             created_at: new Date()
//                         },
//                         {
//                             upsert: true,
//                             new: true,
//                             runValidators: true
//                         }
//                     );
//                         ////console.log((`📝 Created failed analysis record for ${stock.trading_symbol} (invalid price)`);
//                     } catch (saveError) {
//                         console.error(`❌ Failed to save failed analysis for invalid price ${stock.trading_symbol}:`, saveError.message);
//                     }

//                     return; // Skip to next stock
//                 }

//                 // ⚡ Check user limits before analyzing (using centralized method)
//                 const limitsCheck = await aiAnalyzeService.checkAnalysisLimits(userId, stock.instrument_key);

//                 if (!limitsCheck.allowed) {
//                     // User has reached their daily limit
//                     if (limitsCheck.reason === 'daily_limit_reached') {
//                         dailyLimitReached = true;
//                         const limitInfo = limitsCheck.limitInfo || {};
//                         const used = limitInfo.usedCount ?? 'unknown';
//                         const limit = limitInfo.stockLimit ?? 'unknown';
//                         console.log(`⚖️ [BULK ANALYSIS] Daily AI limit reached for user ${userId} after ${used}/${limit} stocks`);
//                         return; // Stop processing more stocks for this user
//                     }
//                     // Other limit reasons (e.g., watchlist quota)
//                     console.log(`⚠️ [BULK ANALYSIS] Skipping ${stock.trading_symbol} - ${limitsCheck.reason}: ${limitsCheck.message}`);
//                     return; // Skip this stock
//                 }

//                 const analysisResult = await aiAnalyzeService.analyzeStock({
//                     instrument_key: stock.instrument_key,
//                     stock_symbol: stock.trading_symbol, // Use trading_symbol for display
//                     stock_name: stock.name,
//                     current_price: numericPrice, // Use validated numeric price
//                     analysis_type: analysisType,
//                     user_id: userId,
//                 });

//                 if (!analysisResult.success) {
//                     throw new Error(analysisResult.message || analysisResult.error || 'Analysis failed');
//                 }

//                 completed++;
//                 ////console.log((`✅ [BULK ANALYSIS] Completed ${stock.trading_symbol} (${completed}/${stocks.length})`);

//             } catch (error) {
//                 failed++;
//                 console.error(`❌ [BULK ANALYSIS] Failed to analyze ${stock.trading_symbol}:`, error.message);

//                 // Create a failed analysis record so it's tracked properly
//                 try {
//                     const failedAnalysis = await StockAnalysis.findOneAndUpdate(
//                         {
//                             instrument_key: stock.instrument_key,
//                             analysis_type: analysisType
//                         },
//                         {
//                             instrument_key: stock.instrument_key,
//                             stock_name: stock.name,
//                             stock_symbol: stock.trading_symbol,
//                             analysis_type: analysisType,
//                             // current_price: undefined (omitted for failed analysis)
//                             status: 'failed',
//                             expires_at: await StockAnalysis.getExpiryTime(),
//                             progress: {
//                                 percentage: 0,
//                                 current_step: `Failed: ${error.message}`,
//                                 steps_completed: 0,
//                                 total_steps: 8,
//                                 estimated_time_remaining: 0,
//                                 last_updated: new Date()
//                             },
//                             analysis_data: {
//                                 schema_version: '1.3',
//                                 symbol: stock.trading_symbol,
//                                 analysis_type: analysisType,
//                                 insufficientData: true,
//                                 strategies: [],
//                                 overall_sentiment: 'NEUTRAL',
//                                 error_reason: error.message,
//                                 failed_at: new Date().toISOString()
//                             },
//                             created_at: new Date()
//                         },
//                         {
//                             upsert: true,
//                             new: true,
//                             runValidators: true
//                         }
//                     );
//                     ////console.log((`📝 Created failed analysis record for ${stock.trading_symbol}: ${failedAnalysis._id}`);
//                 } catch (saveError) {
//                     console.error(`❌ Failed to save failed analysis record for ${stock.trading_symbol}:`, saveError.message);
//                 }
//             }
//         });

//         await Promise.all(batchPromises);

//         if (dailyLimitReached) {
//             console.log(`⚖️ [BULK ANALYSIS] Stopping further batches for user ${userId} after hitting daily limit`);
//             break;
//         }

//         // Add progressively longer delays between batches to avoid rate limiting
//         if (i < totalBatches - 1) {
//             const delayMs = Math.min(2000 + (i * 1000), 10000); // Start at 2s, increase by 1s per batch, max 10s
//             ////console.log((`⏱️ [BULK ANALYSIS] Waiting ${delayMs/1000}s before next batch to avoid rate limiting...`);
//             await new Promise(resolve => setTimeout(resolve, delayMs));
//         }
//     }

//     ////console.log((`🏁 [BULK ANALYSIS] Completed for user ${userId}. Success: ${completed}, Failed: ${failed}, Total processed: ${completed + failed}/${stocks.length}`);
// }

// Session-based bulk analysis processing with cancellation and timeout support
async function processSessionBasedBulkAnalysis(session) {
  //console.log(`🔄 [SESSION ANALYSIS] Starting session-based processing: ${session.session_id}`);

  try {
    // Session status already updated to "running" before this function is called
    //console.log(`📝 [SESSION ANALYSIS] Session already running, starting stock processing: ${session.session_id}`);

    // Debug: Log the full session metadata
    //console.log(`🔍 [SESSION DEBUG] Session metadata:`, JSON.stringify(session.metadata, null, 2));
    //console.log(`🔍 [SESSION DEBUG] Session watchlist_stocks count: ${session.metadata?.watchlist_stocks?.length || 0}`);

    // Check for existing valid analyses for each stock
    const now = new Date();
    const stocksNeedingAnalysis = [];

    for (const stock of session.metadata.watchlist_stocks) {
      if (stock.processed) {
        continue; // Already processed in this session
      }

      // Check if valid analysis already exists in database (completed AND has usable data)
      const existingAnalysis = await StockAnalysis.findOne({
        instrument_key: stock.instrument_key,
        analysis_type: session.analysis_type,
        status: 'completed',
        expires_at: { $gt: now },
        // Ensure analysis has actual strategies and not insufficient data
        $and: [
        { 'analysis_data.insufficientData': { $ne: true } },
        { 'analysis_data.strategies.0': { $exists: true } } // Has at least one strategy
        ]
      });

      if (existingAnalysis) {
        // Mark as processed in session without running analysis
        const sessionStock = session.metadata.watchlist_stocks.find((s) => s.instrument_key === stock.instrument_key);
        if (sessionStock) {
          sessionStock.processed = true;
          sessionStock.processing_started_at = new Date();
          sessionStock.processing_completed_at = new Date();
          sessionStock.error_reason = null;
        }

        // Increment successful stocks counter for existing valid analysis
        session.successful_stocks = (session.successful_stocks || 0) + 1;
      } else {
        stocksNeedingAnalysis.push(stock);
      }
    }

    // Save session with updated processed flags
    await session.save();

    const unprocessedStocks = stocksNeedingAnalysis;

    //console.log(`📊 [SESSION ANALYSIS] Unprocessed stock details:`, unprocessedStocks.map(s => ({ 
    // symbol: s.trading_symbol, 
    // key: s.instrument_key, 
    // processed: s.processed 
    // })));

    if (unprocessedStocks.length === 0) {
      //console.log(`✅ [SESSION ANALYSIS] All stocks already processed for session: ${session.session_id}`);
      session.status = 'completed';
      session.completed_at = new Date();
      await session.save();

      // Send WhatsApp notification for bulk analysis completion
      await sendBulkAnalysisCompletionNotification(session);

      return;
    }

    //console.log(`📋 [SESSION ANALYSIS] Processing ${unprocessedStocks.length} remaining stocks`);

    // Process stocks one by one to enable proper cancellation and timeout handling
    for (let i = 0; i < unprocessedStocks.length; i++) {
      // Reload session to check for cancellation
      const refreshedSession = await AnalysisSession.findById(session._id);
      if (!refreshedSession) {
        //console.log(`❌ [SESSION ANALYSIS] Session not found: ${session.session_id} - stopping processing`);
        return;
      }

      if (refreshedSession.status === 'cancelled') {
        //console.log(`🛑 [SESSION ANALYSIS] Session cancelled: ${session.session_id} - stopping processing`);
        return;
      }

      // Update local session reference
      session = refreshedSession;

      const stock = unprocessedStocks[i];
      //console.log(`🔍 [SESSION ANALYSIS] Processing stock ${i + 1}/${unprocessedStocks.length}: ${stock.trading_symbol} (${stock.instrument_key})`);

      // Set current stock and update timestamp with retry logic
      try {
        // Refresh session before making changes
        const freshSession = await AnalysisSession.findById(session._id);
        if (freshSession) {
          freshSession.current_stock_key = stock.instrument_key;
          freshSession.last_updated = new Date();

          // Mark stock as processing started
          const stockInSession = freshSession.metadata.watchlist_stocks.find((s) => s.instrument_key === stock.instrument_key);
          if (stockInSession) {
            stockInSession.processing_started_at = new Date();
            //console.log(`📝 [SESSION ANALYSIS] Marked ${stock.trading_symbol} as processing started`);
          } else {

            //console.log(`⚠️ [SESSION ANALYSIS] Could not find ${stock.trading_symbol} in session stocks`);
          }
          await freshSession.save();
          //console.log(`✅ [SESSION ANALYSIS] Updated session with current stock: ${stock.trading_symbol}`);

          // Update local session reference
          Object.assign(session, freshSession.toObject());
        }
      } catch (sessionUpdateError) {
        console.error(`⚠️ [SESSION ANALYSIS] Failed to update session start for ${stock.trading_symbol}:`, sessionUpdateError.message);
        // Continue processing even if session update fails
      }

      //console.log(`✅ [SESSION ANALYSIS] Valid price ₹${numericPrice} for ${stock.trading_symbol}, starting AI analysis...`);

      // ⚡ Check user limits before analyzing (using centralized method)
      const limitsCheck = await aiAnalyzeService.checkAnalysisLimits(session.user_id, stock.instrument_key);

      if (!limitsCheck.allowed) {
        // User has reached their daily limit
        if (limitsCheck.reason === 'daily_limit_reached') {

          session.status = 'paused';
          session.error_message = 'daily_limit_reached';
          session.last_updated = new Date();
          await session.save();
          return; // Stop processing session
        }
        // Other limit reasons - skip this stock

        await markStockAsFailed(session, stock, limitsCheck.message);
        continue; // Skip to next stock
      }

      // Start analysis (single attempt, no retries)
      try {
        //console.log(`🤖 [SESSION ANALYSIS] Calling aiAnalyzeService.analyzeStock for ${stock.trading_symbol}...`);
        const analysisPromise = aiAnalyzeService.analyzeStock({
          instrument_key: stock.instrument_key,
          stock_name: stock.stock_name,
          stock_symbol: stock.trading_symbol,

          current_price: null,
          analysis_type: session.analysis_type,
          user_id: session.user_id,
          // user_id: removed for bulk analysis to make results shareable across users
          forceFresh: false,
          scheduled_release_time: MarketHoursUtil.getScheduledReleaseTime(),
          skipNotification: true // Skip per-stock notifications in bulk analysis
        });

        // 10-minute timeout per stock
        const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Stock analysis timeout after 10 minutes')), session.timeout_threshold)
        );

        const analysisResult = await Promise.race([analysisPromise, timeoutPromise]);
        //console.log(`🎯 [SESSION ANALYSIS] AI analysis completed for ${stock.trading_symbol}, result:`, analysisResult?.success ? 'SUCCESS' : 'FAILED');

        if (analysisResult && analysisResult.success) {
          // Mark stock as successfully processed
          await markStockAsSuccessful(session, stock);
          //console.log(`✅ [SESSION ANALYSIS] Successfully completed ${stock.trading_symbol}`);
        } else {
          // Analysis failed - mark as failed
          const errorMsg = analysisResult?.message || analysisResult?.error || 'Analysis returned failure status';
          //console.log(`❌ [SESSION ANALYSIS] Analysis failed for ${stock.trading_symbol}: ${errorMsg}`);
          await markStockAsFailed(session, stock, errorMsg);
        }

      } catch (analysisError) {
        console.error(`❌ [SESSION ANALYSIS] Analysis error for ${stock.trading_symbol}:`, analysisError.message);
        await markStockAsFailed(session, stock, analysisError.message);
      }

      // Update session heartbeat
      await session.updateHeartbeat();

      // Rate limiting delay between stocks (larger delay to prevent 429 errors)
      const delayBetweenStocks = 5000; // 5 seconds between each stock
      //console.log(`⏱️ [SESSION ANALYSIS] Waiting ${delayBetweenStocks/1000}s before next stock to prevent rate limiting...`);
      await new Promise((resolve) => setTimeout(resolve, delayBetweenStocks));
    }

    // Mark session as completed
    //console.log(`🏁 [SESSION ANALYSIS] All stocks processed, marking session as completed`);
    session.status = 'completed';
    session.completed_at = new Date();
    session.current_stock_key = null;
    await session.save();

    //console.log(`🏁 [SESSION ANALYSIS] Session completed: ${session.session_id}. Success: ${session.successful_stocks}, Failed: ${session.failed_stocks}`);

    // Send WhatsApp notification for bulk analysis completion
    await sendBulkAnalysisCompletionNotification(session);

  } catch (sessionError) {
    console.error(`❌ [SESSION ANALYSIS] Session failed: ${session.session_id}`, sessionError);
    console.error(`❌ [SESSION ANALYSIS] Full error details:`, sessionError.stack);

    // Try to mark session as failed, but don't let this fail too
    try {
      session.status = 'failed';
      session.error_message = sessionError.message;
      session.completed_at = new Date();
      await session.save();
      //console.log(`✅ [SESSION ANALYSIS] Marked session as failed: ${session.session_id}`);
    } catch (saveError) {
      console.error(`❌ [SESSION ANALYSIS] Failed to save failed session: ${session.session_id}`, saveError);
    }
  }
}

// Helper function to mark stock as failed with retry logic for version conflicts
async function markStockAsFailed(session, stock, errorReason, retryCount = 0) {
  const maxRetries = 3;

  // Create failed analysis record
  try {
    const failedAnalysis = await StockAnalysis.findOneAndUpdate(
      {
        instrument_key: stock.instrument_key,
        analysis_type: session.analysis_type
      },
      {
        instrument_key: stock.instrument_key,
        stock_name: stock.stock_name,
        stock_symbol: stock.trading_symbol,
        analysis_type: session.analysis_type,
        // current_price: undefined (omitted for failed analysis)
        status: 'failed',
        expires_at: await StockAnalysis.getExpiryTime(),
        progress: {
          percentage: 0,
          current_step: `Failed: ${errorReason}`,
          steps_completed: 0,
          total_steps: 8,
          estimated_time_remaining: 0,
          last_updated: new Date()
        },
        analysis_data: {
          schema_version: '1.3',
          symbol: stock.trading_symbol,
          analysis_type: session.analysis_type,
          insufficientData: true,
          strategies: [],
          overall_sentiment: 'NEUTRAL',
          error_reason: errorReason,
          failed_at: new Date().toISOString()
        },
        created_at: new Date()
      },
      {
        upsert: true,
        new: true,
        runValidators: true
      }
    );
  } catch (saveError) {
    console.error(`❌ Failed to save failed analysis record for ${stock.trading_symbol}:`, saveError.message);
  }

  // Update session stock status with retry logic
  try {
    // Refresh session to get latest version
    const freshSession = await AnalysisSession.findById(session._id);
    if (!freshSession) {
      console.error(`❌ Session not found for update: ${session.session_id}`);
      return;
    }

    // Update session stock status
    const stockInSession = freshSession.metadata.watchlist_stocks.find((s) => s.instrument_key === stock.instrument_key);
    if (stockInSession) {
      stockInSession.processed = true;
      stockInSession.processing_completed_at = new Date();
      stockInSession.error_reason = errorReason;
    }

    freshSession.failed_stocks = (freshSession.failed_stocks || 0) + 1;
    freshSession.processed_stocks = (freshSession.processed_stocks || 0) + 1;
    freshSession.last_updated = new Date();

    await freshSession.save();

    // Update the local session reference
    Object.assign(session, freshSession.toObject());

  } catch (sessionError) {
    if (sessionError.name === 'VersionError' && retryCount < maxRetries) {
      ////console.log((`🔄 Retrying session update for ${stock.trading_symbol} (attempt ${retryCount + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, 100 * (retryCount + 1))); // Exponential backoff
      return markStockAsFailed(session, stock, errorReason, retryCount + 1);
    } else {
      console.error(`❌ Failed to update session for ${stock.trading_symbol} after ${retryCount + 1} attempts:`, sessionError.message);
      throw sessionError;
    }
  }
}

// Helper function to mark stock as successful with retry logic for version conflicts
async function markStockAsSuccessful(session, stock, retryCount = 0) {
  const maxRetries = 3;

  try {
    // Refresh session to get latest version
    const freshSession = await AnalysisSession.findById(session._id);
    if (!freshSession) {
      console.error(`❌ Session not found for update: ${session.session_id}`);
      return;
    }

    // Update session stock status
    const stockInSession = freshSession.metadata.watchlist_stocks.find((s) => s.instrument_key === stock.instrument_key);
    if (stockInSession) {
      stockInSession.processed = true;
      stockInSession.processing_completed_at = new Date();
    }

    freshSession.successful_stocks = (freshSession.successful_stocks || 0) + 1;
    freshSession.processed_stocks = (freshSession.processed_stocks || 0) + 1;
    freshSession.last_updated = new Date();

    await freshSession.save();

    // Update the local session reference
    Object.assign(session, freshSession.toObject());

  } catch (sessionError) {
    if (sessionError.name === 'VersionError' && retryCount < maxRetries) {
      ////console.log((`🔄 Retrying session update for ${stock.trading_symbol} (attempt ${retryCount + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, 100 * (retryCount + 1))); // Exponential backoff
      return markStockAsSuccessful(session, stock, retryCount + 1);
    } else {
      console.error(`❌ Failed to update session for ${stock.trading_symbol} after ${retryCount + 1} attempts:`, sessionError.message);
      throw sessionError;
    }
  }
}

// Route: Reanalyze a specific stock
router.post('/reanalyze-stock', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { instrument_key, stock_name, stock_symbol, analysis_type = 'swing' } = req.body;

    if (!instrument_key || !stock_name || !stock_symbol) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'instrument_key, stock_name, and stock_symbol are required'
      });
    }

    // Check if stock analysis is allowed based on market timing (same as bulk analysis)
    const analysisPermission = await StockAnalysis.isBulkAnalysisAllowed();

    if (!analysisPermission.allowed) {

      return res.status(423).json({
        success: false,
        error: 'stock_reanalysis_not_allowed',
        message: getBulkAnalysisMessage(analysisPermission.reason),
        reason: analysisPermission.reason,
        nextAllowed: analysisPermission.nextAllowed,
        validUntil: analysisPermission.validUntil
      });
    }

    ////console.log((`🔄 Reanalyzing stock ${stock_symbol} for user ${userId}`);

    // Only delete existing analysis if it's expired, failed, or explicitly requested for reanalysis
    // For reanalysis, we DO want to force fresh analysis even if current one is valid
    const deleteResult = await StockAnalysis.deleteMany({
      instrument_key: instrument_key,
      analysis_type: analysis_type
      // Note: For reanalysis endpoint, we delete ALL existing analyses to force fresh analysis
    });

    // Get current price
    let currentPrice = null;
    try {
      currentPrice = await getCurrentPrice(instrument_key);
      if (!currentPrice || isNaN(parseFloat(currentPrice)) || parseFloat(currentPrice) <= 0) {
        throw new Error('Invalid price data received');
      }
    } catch (priceError) {
      console.error(`❌ Price fetch failed for ${stock_symbol}:`, priceError.message);
      return res.status(400).json({
        success: false,
        error: 'Price fetch failed',
        message: `Unable to get current price for ${stock_symbol}: ${priceError.message}`,
        retry_later: true
      });
    }

    // Start fresh analysis
    try {
      const result = await aiAnalyzeService.analyzeStock({
        instrument_key: instrument_key,
        stock_symbol: stock_symbol,
        stock_name: stock_name,
        current_price: parseFloat(currentPrice),
        analysis_type: analysis_type,
        // user_id: removed for bulk analysis to make results shareable across users
        forceFresh: true
      });

      if (result.success) {
        ////console.log((`✅ Reanalysis completed for ${stock_symbol}`);
        res.status(200).json({
          success: true,
          message: `${stock_symbol} reanalyzed successfully`,
          data: {
            instrument_key: instrument_key,
            stock_symbol: stock_symbol,
            current_price: parseFloat(currentPrice),
            analysis_id: result.data._id
          }
        });
      } else {
        console.error(`❌ Reanalysis failed for ${stock_symbol}:`, result.message);
        res.status(500).json({
          success: false,
          error: 'Analysis failed',
          message: result.message || 'Unknown error during analysis'
        });
      }
    } catch (analysisError) {
      console.error(`❌ Reanalysis error for ${stock_symbol}:`, analysisError.message);
      res.status(500).json({
        success: false,
        error: 'Analysis error',
        message: analysisError.message
      });
    }

  } catch (error) {
    console.error('❌ Error in reanalyze-stock:', error);
    res.status(500).json({
      success: false,
      error: 'Server error',
      message: error.message
    });
  }
});

// Route: Version check endpoint
router.get('/version', auth, async (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      version: '2.0.0-session-based',
      features: ['session-tracking', 'cancellation', 'resume', 'timeout-handling'],
      timestamp: new Date().toISOString()
    }
  });
});

// Route: Debug endpoint to list all sessions for a user (for testing)
router.get('/debug/sessions', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { analysis_type = 'swing' } = req.query;

    const allSessions = await AnalysisSession.find({
      user_id: userId,
      analysis_type: analysis_type
    }).sort({ created_at: -1 });

    const activeSession = await AnalysisSession.findActiveSession(userId, analysis_type);
    const resumableSession = await AnalysisSession.findResumableSession(userId, analysis_type);

    res.status(200).json({
      success: true,
      data: {
        all_sessions: allSessions,
        active_session: activeSession,
        resumable_session: resumableSession,
        total_sessions: allSessions.length
      }
    });

  } catch (error) {
    console.error('❌ Error in debug sessions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get debug sessions',
      message: error.message
    });
  }
});

// Route: Check if bulk analysis timing is allowed
router.get('/timing-check', auth, async (req, res) => {
  try {
    const analysisPermission = await StockAnalysis.isBulkAnalysisAllowed();

    const response = {
      success: true,
      data: {
        allowed: analysisPermission.allowed,
        reason: analysisPermission.reason || null,
        message: analysisPermission.allowed ? null : getBulkAnalysisMessage(analysisPermission.reason),
        nextAllowed: analysisPermission.nextAllowed || null,
        validUntil: analysisPermission.validUntil || null
      }
    };

    res.json(response);
  } catch (error) {
    console.error('❌ Error checking bulk analysis timing:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check timing',
      message: 'Unable to check if bulk analysis is allowed at this time'
    });
  }
});

// Route: Get analysis with order status and monitoring details
router.get('/analysis-details/:analysisId', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { analysisId } = req.params;

    // Find the analysis document
    const analysis = await StockAnalysis.findById(analysisId);
    if (!analysis || analysis.user_id.toString() !== userId) {
      return res.status(404).json({
        success: false,
        error: 'analysis_not_found',
        message: 'Analysis not found or access denied'
      });
    }

    // Get monitoring status for each strategy
    const strategies = analysis.analysis_data?.strategies || [];
    const strategyStatuses = {};

    for (const strategy of strategies) {
      // Import monitoring service dynamically
      const agendaMonitoringService = (await import('../services/agendaMonitoringService.js')).default;
      const monitoringStatus = await agendaMonitoringService.getMonitoringStatus(analysisId, strategy.id);
      strategyStatuses[strategy.id] = monitoringStatus;
    }

    // Check if orders are placed
    const hasPlacedOrders = analysis.hasActiveOrders();
    const placedOrders = analysis.placed_orders || [];

    res.status(200).json({
      success: true,
      data: {
        analysis: {
          id: analysis._id,
          stock_symbol: analysis.stock_symbol,
          instrument_key: analysis.instrument_key,
          analysis_type: analysis.analysis_type,
          created_at: analysis.created_at,
          expires_at: analysis.expires_at,
          current_price: analysis.current_price
        },
        strategies: strategies.map((strategy) => ({
          ...strategy,
          monitoring: strategyStatuses[strategy.id] || { isMonitoring: false },
          hasOrders: placedOrders.some((order) => order.strategy_id === strategy.id)
        })),
        orders: {
          hasPlacedOrders,
          totalOrders: placedOrders.length,
          placedOrders: placedOrders.map((order) => ({
            order_id: order.order_id,
            strategy_id: order.strategy_id,
            status: order.status,
            quantity: order.quantity,
            price: order.price,
            transaction_type: order.transaction_type,
            tag: order.tag,
            placed_at: order.placed_at,
            hasAutomaticStopLossTarget: order.hasAutomaticStopLossTarget || false
          }))
        },
        monitoring: {
          anyActiveMonitoring: Object.values(strategyStatuses).some((s) => s.isMonitoring),
          activeStrategiesCount: Object.values(strategyStatuses).filter((s) => s.isMonitoring).length,
          totalStrategies: strategies.length
        },
        history: {
          totalOrdersPlaced: analysis.total_orders_placed || 0,
          lastOrderPlacedAt: analysis.last_order_placed_at,
          orderPlacementHistory: analysis.order_placement_history || []
        }
      }
    });

  } catch (error) {
    console.error('❌ Error getting analysis details:', error);
    res.status(500).json({
      success: false,
      error: 'analysis_details_failed',
      message: error.message
    });
  }
});

// Route: Record order placement success
router.post('/record-order-placement', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      analysisId,
      strategyId,
      orderData,
      orderResponse,
      stockSymbol,
      instrumentToken
    } = req.body;

    // Validate required fields
    if (!analysisId || !strategyId || !orderData || !orderResponse) {
      return res.status(400).json({
        success: false,
        error: 'missing_required_fields',
        message: 'analysisId, strategyId, orderData, and orderResponse are required'
      });
    }

    // Find the analysis document
    const analysis = await StockAnalysis.findById(analysisId);
    if (!analysis || analysis.user_id.toString() !== userId) {
      return res.status(404).json({
        success: false,
        error: 'analysis_not_found',
        message: 'Analysis not found or access denied'
      });
    }

    // Record the order placement
    const orderRecord = {
      recorded_at: new Date(),
      strategy_id: strategyId,
      order_details: {
        ...orderData,
        upstox_response: orderResponse,
        placement_method: 'multi_order_api',
        stock_symbol: stockSymbol || analysis.stock_symbol,
        instrument_token: instrumentToken || analysis.instrument_key
      }
    };

    // Add to analysis document
    if (!analysis.order_placement_history) {
      analysis.order_placement_history = [];
    }
    analysis.order_placement_history.push(orderRecord);

    // Update analysis status
    analysis.last_order_placed_at = new Date();
    analysis.total_orders_placed = (analysis.total_orders_placed || 0) + 1;

    await analysis.save();

    res.status(200).json({
      success: true,
      message: 'Order placement recorded successfully',
      data: {
        analysisId: analysisId,
        strategyId: strategyId,
        stockSymbol: analysis.stock_symbol,
        recordedAt: orderRecord.recorded_at,
        totalOrdersPlaced: analysis.total_orders_placed
      }
    });

  } catch (error) {
    console.error('❌ Error recording order placement:', error);
    res.status(500).json({
      success: false,
      error: 'record_order_failed',
      message: error.message
    });
  }
});

export default router;