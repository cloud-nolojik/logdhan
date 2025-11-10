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
router.post('/analyze-stock', authenticateToken, /* analysisRateLimit, */ async (req, res) => {
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
        const user = await User.findById(userId);
        const subscription = await Subscription.findActiveForUser(userId);

        // Check if user can manually analyze based on quota and timing
        let canAnalyzeManually = false;
        if (user && subscription) {
            const currentWatchlistCount = user.watchlist.length;
            const stockLimit = subscription.stockLimit;

            console.log(`📊 [FRESH ANALYSIS] User watchlist: ${currentWatchlistCount}/${stockLimit}`);

            // If user hasn't filled their watchlist quota, allow manual analysis anytime
            if (currentWatchlistCount < stockLimit) {
                canAnalyzeManually = true;
                console.log(`✅ [FRESH ANALYSIS] User can analyze manually (quota not filled: ${currentWatchlistCount}/${stockLimit})`);
            } else {
                // User has filled quota - check when this stock was added
                const watchlistItem = user.watchlist.find(item => item.instrument_key === instrument_key);

                if (watchlistItem && watchlistItem.addedAt) {
                    // Check if stock was added after 5:00 PM IST today
                    // Convert 5:00 PM IST to UTC for comparison with MongoDB timestamps
                    const now = new Date();
                    const todayIST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
                    const fivePmIST = new Date(todayIST);
                    fivePmIST.setHours(17, 0, 0, 0);

                    // Convert back to UTC for comparison
                    const fivePmUTC = new Date(fivePmIST.toLocaleString('en-US', { timeZone: 'UTC' }));
                    const addedAt = new Date(watchlistItem.addedAt);

                    console.log(`⏰ [FRESH ANALYSIS] Comparing times - addedAt: ${addedAt.toISOString()}, 5PM IST in UTC: ${fivePmUTC.toISOString()}`);

                    if (addedAt > fivePmUTC) {
                        // Added after 5 PM IST - must wait for next bulk run
                        canAnalyzeManually = false;
                        console.log(`❌ [FRESH ANALYSIS] Stock added after 5 PM IST (${addedAt.toISOString()}), must wait for bulk run`);
                        return res.status(423).json({
                            success: false,
                            error: 'stock_added_after_bulk_run',
                            message: 'Stock added after bulk analysis. Please wait for the next daily run at 5:00 PM',
                            reason: 'stock_added_after_bulk_run'
                        });
                    } else {
                        // Added before 5 PM IST - should have been in bulk run, allow manual
                        canAnalyzeManually = true;
                        console.log(`✅ [FRESH ANALYSIS] Stock added before 5 PM IST, allowing manual analysis`);
                    }
                }
            }
        }

        // Check if stock analysis is allowed based on market timing
        const analysisPermission = await StockAnalysis.isBulkAnalysisAllowed();

        // Allow analysis if: (timing is OK) OR (user can analyze manually due to quota/timing)
        if (!analysisPermission.allowed && !canAnalyzeManually) {
            console.log(`❌ [STOCK ANALYSIS] Individual analysis blocked: ${analysisPermission.reason}, next allowed: ${analysisPermission.nextAllowed}`);
            return res.status(423).json({
                success: false,
                error: 'stock_analysis_not_allowed',
                message: `Analysis can be started only from 5.00 PM on market close till next 8.59 AM. ${analysisPermission.reason}`,
                reason: analysisPermission.reason,
                nextAllowed: analysisPermission.nextAllowed,
                validUntil: analysisPermission.validUntil
            });
        }

        if (canAnalyzeManually) {
            console.log(`✅ [STOCK ANALYSIS] Individual analysis allowed (user within quota or stock added before bulk run)`);
        } else {
            console.log(`✅ [STOCK ANALYSIS] Individual analysis allowed: ${analysisPermission.reason}, valid until: ${analysisPermission.validUntil}`);
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


        // Get current price from latest candle data using modern candleFetcher service
        let current_price = null;
        try {
            console.log(`📊 [PRICE FETCH] Getting current price for ${stock_symbol} (${instrument_key})`);
            
            // Use candleFetcherService to get candle data (DB first, API fallback)
            const term = analysis_type === 'swing' ? 'short' : 'intraday';
            const candleResult = await candleFetcherService.getCandleDataForAnalysis(instrument_key, term);
            
            if (candleResult.success && candleResult.data) {
                console.log(`✅ [PRICE FETCH] Got data from ${candleResult.source}: ${Object.keys(candleResult.data).length} timeframes`);
                
                // Try to get current price from any available timeframe (prefer shorter timeframes for latest price)
                const timeframes = ['15m', '1h', '1d'];
                let latestCandle = null;
                let latestTimestamp = null;
                
                for (const timeframe of timeframes) {
                    const candles = candleResult.data[timeframe];
                    if (candles && candles.length > 0) {
                        console.log(`📊 [PRICE FETCH] Checking ${timeframe}: ${candles.length} candles`);
                        
                        // Get the most recent candle from this timeframe
                        const lastCandle = candles[candles.length - 1];
                        const timestamp = Array.isArray(lastCandle) ? lastCandle[0] : lastCandle.timestamp;
                        
                        // Validate timestamp before using it
                        if (!timestamp) {
                            console.warn(`⚠️ [PRICE FETCH] Invalid timestamp (null/undefined) in ${timeframe} candle`);
                            continue;
                        }
                        
                        const candleTime = new Date(timestamp).getTime();
                        
                        // Check if the timestamp is valid
                        if (isNaN(candleTime)) {
                            console.warn(`⚠️ [PRICE FETCH] Invalid timestamp "${timestamp}" in ${timeframe} candle`);
                            continue;
                        }
                        
                        if (!latestTimestamp || candleTime > latestTimestamp) {
                            latestTimestamp = candleTime;
                            latestCandle = lastCandle;
                            try {
                                const timestampStr = new Date(timestamp).toISOString();
                                console.log(`🎯 [PRICE FETCH] Found newer candle in ${timeframe}: ${timestampStr}`);
                            } catch (e) {
                                console.log(`🎯 [PRICE FETCH] Found newer candle in ${timeframe}: ${timestamp} (raw)`);
                            }
                        }
                    }
                }
                
                if (latestCandle) {
                    current_price = Array.isArray(latestCandle) ? latestCandle[4] : latestCandle.close;
                    const candleTime = Array.isArray(latestCandle) ? latestCandle[0] : latestCandle.timestamp;
                    
                    try {
                        const candleTimeStr = new Date(candleTime).toISOString();
                        console.log(`✅ [PRICE FETCH] Current price: ₹${current_price} (from ${candleTimeStr})`);
                    } catch (e) {
                        console.log(`✅ [PRICE FETCH] Current price: ₹${current_price} (from ${candleTime} - raw timestamp)`);
                    }
                } else {
                    console.warn(`⚠️ [PRICE FETCH] No valid candles found in any timeframe`);
                }
            } else {
                console.warn(`⚠️ [PRICE FETCH] Failed to get candle data: ${candleResult.error || 'Unknown error'}`);
            }
            
            // No fallback price - if we can't get current price, we can't proceed
            if (!current_price) {
                console.error('❌ No current price available and no fallback allowed');
                return res.status(400).json({
                    success: false,
                    error: 'Current price not available',
                    message: 'Unable to fetch current market price. Please try again later.'
                });
            }
            
        } catch (error) {
            console.error('❌ Error fetching current price:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch current price',
                message: 'Unable to get current market price for analysis'
            });
        }

        // Validate analysis type
        if (!['swing', 'intraday'].includes(analysis_type)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid analysis type',
                message: 'analysis_type must be either "swing" or "intraday"'
            });
        }

        // Validate current_price
        const price = parseFloat(current_price);
        if (isNaN(price) || price <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Invalid price',
                message: 'Unable to determine current market price'
            });
        }

        // Check if user can analyze stocks (trial expiry check)
        try {
            const analysisPermissionCheck = await Subscription.canUserAnalyzeStock(userId);
            
            if (!analysisPermissionCheck.canAnalyze) {
                return res.status(403).json({
                    success: false,
                    error: 'analysis_not_allowed',
                    message: analysisPermissionCheck.isTrialExpired 
                        ? 'Your free trial has expired. Please subscribe to continue analyzing stocks.'
                        : 'You need an active subscription to analyze stocks.',
                    data: {
                        planId: analysisPermissionCheck.planId,
                        isTrialExpired: analysisPermissionCheck.isTrialExpired,
                        trialExpiryDate: analysisPermissionCheck.trialExpiryDate,
                        needsUpgrade: true
                    }
                });
            }
        } catch (subscriptionError) {
            console.error('Error checking analysis permission:', subscriptionError);
            return res.status(400).json({
                success: false,
                error: 'subscription_check_failed',
                message: subscriptionError.message
            });
        }

        // Start AI analysis directly
        const result = await aiReviewService.analyzeStock({
            instrument_key,
            stock_name,
            stock_symbol,
            current_price,
            analysis_type,
            userId,
            forceFresh: forceFresh  // Use forceFresh if requested via query param
        });

        if (result.success) {
            const responseData = {
                success: true,
                data: result.data,
                analysis_id: result.data._id
            };


            res.json(responseData);
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
                message: result.message
            });
        }

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

        console.log(`🔍 [ANALYSIS BY INSTRUMENT] Fetching analysis for instrument: ${instrumentKey}, type: ${analysis_type}, user: ${userId}`);
        const analysisPermission = await StockAnalysis.isBulkAnalysisAllowed();
          



        // First check for any analysis (completed or in progress)
        const anyAnalysis = await StockAnalysis.findOne({
            instrument_key: instrumentKey,
            analysis_type: analysis_type,
        }).sort({ created_at: -1 }); // Get most recent analysis

        // if(!anyAnalysis){
        //     //chck for market timrtig if no analysis found
        //     // if (!analysisPermission.allowed) {    
        //     //     console.log(`❌ [ANALYSIS BY INSTRUMENT] Analysis blocked: ${analysisPermission.reason}, next allowed: ${analysisPermission.nextAllowed}`);
        //     //     return res.status(423).json({
        //     //         success: false,
        //     //         error: 'stock_analysis_not_allowed',
        //     //         message: `Analysis can be accessed only from 5:00 PM after market close, until the next trading day at 8:59 AM.`,
        //     //         reason: analysisPermission.reason,
        //     //         nextAllowed: analysisPermission.nextAllowed,
        //     //         validUntil: analysisPermission.validUntil
        //     //     });
        //     // }
        // } 

        // // Auto-fail analyses stuck for more than 10 minutes
        // if (anyAnalysis && anyAnalysis.status === 'in_progress') {
        //     const now = new Date();
        //     const analysisAge = now - anyAnalysis.created_at;
        //     const maxAge = 10 * 60 * 1000; // 10 minutes
            
        //     if (analysisAge > maxAge) {
        //         console.log(`⏰ [ANALYSIS TIMEOUT] Auto-failing stuck analysis: ${anyAnalysis._id}, age: ${Math.round(analysisAge/1000/60)}min`);
        //         anyAnalysis.status = 'failed';
        //         anyAnalysis.progress.current_step = 'Analysis timed out';
        //         anyAnalysis.progress.percentage = 100;
        //         await anyAnalysis.save();
        //     }
        // }

        // if (!anyAnalysis) {
        //     // Check if there's a scheduled analysis waiting to be released
        //     const scheduledAnalysis = await StockAnalysis.findOne({
        //         instrument_key: instrumentKey,
        //         analysis_type: analysis_type,
        //         expires_at: { $gt: new Date() },
        //         scheduled_release_time: { $gt: new Date() } // Has a future release time
        //     }).sort({ created_at: -1 });

        //     if (scheduledAnalysis) {
        //         const releaseTime = scheduledAnalysis.scheduled_release_time;
        //         const releaseTimeIST = releaseTime.toLocaleString('en-IN', {
        //             timeZone: 'Asia/Kolkata',
        //             hour: '2-digit',
        //             minute: '2-digit',
        //             hour12: true
        //         });

        //         console.log(`⏰ [ANALYSIS BY INSTRUMENT] Scheduled analysis found but not released yet. Release at: ${releaseTimeIST}`);
        //         return res.status(200).json({
        //             success: true,
        //             status: 'scheduled',
        //             error: 'scheduled',
        //             message: `Analysis will be available after ${releaseTimeIST} today`,
        //             call_to_action: 'Check back after the scheduled release time',
        //             scheduled_release_time: releaseTime,
        //             can_analyze_manually: false // Scheduled analysis means bulk run happened, no manual override
        //         });
        //     }

        //     console.log(`📭 [ANALYSIS BY INSTRUMENT] No analysis found for instrument: ${instrumentKey}`);

        //     // Check if user can manually analyze this stock
        //     const userId = req.user.id;
        //     const user = await User.findById(userId);
        //     const subscription = await Subscription.findActiveForUser(userId);

        //     console.log(`🔍 [DEBUG] Checking manual analysis permission for ${instrumentKey}`);
        //     console.log(`🔍 [DEBUG] User found: ${!!user}, Subscription found: ${!!subscription}`);

        //     let canAnalyzeManually = false;
        //     let messageToUser = 'This stock will be analyzed in the next daily run';
        //     let callToActionToUser = 'Analysis will be available at 5:00 PM on the next trading day';

        //     if (user && subscription) {
        //         const currentWatchlistCount = user.watchlist.length;
        //         const stockLimit = subscription.stockLimit;

        //         console.log(`📊 [ANALYSIS CHECK] User watchlist: ${currentWatchlistCount}/${stockLimit}`);
        //         console.log(`📊 [ANALYSIS CHECK] Watchlist items:`, user.watchlist.map(item => ({
        //             symbol: item.trading_symbol,
        //             addedAt: item.addedAt
        //         })));

        //         // If user hasn't filled their watchlist quota, allow manual analysis
        //         if (currentWatchlistCount < stockLimit) {
        //             canAnalyzeManually = true;
        //             messageToUser = 'This stock has not been analyzed yet';
        //             callToActionToUser = 'Click "Analyze This Stock" to get AI strategies';
        //             console.log(`✅ [ANALYSIS CHECK] User can analyze manually (quota not filled)`);
        //         } else {
        //             // User has filled quota - check when this stock was added
        //             const watchlistItem = user.watchlist.find(item => item.instrument_key === instrumentKey);

        //             if (watchlistItem && watchlistItem.addedAt) {
        //                 // Check if stock was added after 5:00 PM IST today
        //                 // Convert 5:00 PM IST to UTC for comparison with MongoDB timestamps
        //                 const now = new Date();
        //                 const todayIST = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
        //                 const fivePmIST = new Date(todayIST);
        //                 fivePmIST.setHours(17, 0, 0, 0);

        //                 // Convert back to UTC for comparison
        //                 const fivePmUTC = new Date(fivePmIST.toLocaleString('en-US', { timeZone: 'UTC' }));
        //                 const addedAt = new Date(watchlistItem.addedAt);

        //                 console.log(`⏰ [ANALYSIS CHECK] Comparing times - addedAt: ${addedAt.toISOString()}, 5PM IST in UTC: ${fivePmUTC.toISOString()}`);

        //                 if (addedAt > fivePmUTC) {
        //                     // Added after 5 PM IST - must wait for next bulk run
        //                     canAnalyzeManually = false;
        //                     messageToUser = 'Stock added after bulk analysis. Will be analyzed in next daily run';
        //                     callToActionToUser = 'Analysis will be available at 5:00 PM on the next trading day';
        //                     console.log(`⏰ [ANALYSIS CHECK] Stock added after 5 PM IST (${addedAt.toISOString()}), must wait`);
        //                 } else {
        //                     // Added before 5 PM IST - should have been in bulk run, allow manual
        //                     canAnalyzeManually = true;
        //                     messageToUser = 'This stock has not been analyzed yet';
        //                     callToActionToUser = 'Click "Analyze This Stock" to get AI strategies';
        //                     console.log(`✅ [ANALYSIS CHECK] Stock added before 5 PM IST, allow manual analysis`);
        //                 }
        //             } else {
        //                 // No addedAt timestamp, allow manual analysis as fallback
        //                 canAnalyzeManually = true;
        //                 console.log(`⚠️ [ANALYSIS CHECK] No addedAt found, allowing manual analysis`);
        //             }
        //         }
        //     }

        //     console.log(`🎯 [FINAL DECISION] can_analyze_manually: ${canAnalyzeManually}`);
        //     console.log(`🎯 [FINAL DECISION] message: ${messageToUser}`);
        //     console.log(`🎯 [FINAL DECISION] call_to_action: ${callToActionToUser}`);

        //     return res.status(200).json({
        //         success: true,
        //         status: 'not_analyzed',
        //         error: 'not_analyzed',
        //         message: messageToUser,
        //         call_to_action: callToActionToUser,
        //         can_analyze_manually: canAnalyzeManually
        //     });

           
        // }

        // If analysis is not completed, return in_progress status (unless failed)
        if (anyAnalysis.status !== 'completed') {
            // If analysis failed, return 404 to stop polling
            if (anyAnalysis.status === 'failed') {
                console.log(`💀 [ANALYSIS BY INSTRUMENT] Analysis failed for instrument: ${instrumentKey}`);
                return res.status(404).json({
                    success: false,
                    error: 'Analysis failed',
                    message: 'Analysis failed or timed out'
                });
            }
            console.log(`🔄 [ANALYSIS BY INSTRUMENT] Analysis in progress for instrument: ${instrumentKey}, status: ${anyAnalysis.status}`);
            
            // Create minimal analysis_data structure with required fields
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
                disclaimer: "Analysis in progress..."
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
                    status: anyAnalysis.status,
                    progress: anyAnalysis.progress,
                    created_at: anyAnalysis.created_at,
                    expires_at: anyAnalysis.expires_at
                },
                cached: false,
                analysis_id: anyAnalysis._id.toString(),
                error: null,
                message: 'Analysis in progress'
            });
        }

        // Validate required fields exist for completed analysis
        if (!anyAnalysis.analysis_data?.market_summary?.last || 
            !anyAnalysis.analysis_data?.market_summary?.trend || 
            !anyAnalysis.analysis_data?.market_summary?.volatility || 
            !anyAnalysis.analysis_data?.market_summary?.volume) {
            console.log(`❌ [ANALYSIS BY INSTRUMENT] Incomplete analysis data for instrument: ${instrumentKey}`);
            
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

        console.log(`✅ [ANALYSIS BY INSTRUMENT] Found complete analysis: ${analysis._id}, status: ${analysis.status}`);

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
                recent_analyses: recentAnalyses.map(analysis => ({
                    _id: analysis._id,
                    stock_symbol: analysis.stock_symbol,
                    analysis_type: analysis.analysis_type,
                    created_at: analysis.created_at,
                    top_strategy: analysis.analysis_data.strategies.find(s => s.isTopPick) || analysis.analysis_data.strategies[0]
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
                                0
                            ]
                        }
                    },
                    expired: {
                        $sum: {
                            $cond: [
                                { $lt: ['$expires_at', new Date()] },
                                1,
                                0
                            ]
                        }
                    }
                }
            }
        ]);
        
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

export default router;