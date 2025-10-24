import express from 'express';
import aiReviewService from '../services/aiAnalyze.service.js';
import StockAnalysis from '../models/stockAnalysis.js';
import Stock from '../models/stock.js';
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

        // Check if stock analysis is allowed based on market timing (same as bulk analysis)
        const analysisPermission = await StockAnalysis.isBulkAnalysisAllowed();
        
        if (!analysisPermission.allowed) {
            console.log(`❌ [STOCK ANALYSIS] Individual analysis blocked: ${analysisPermission.reason}, next allowed: ${analysisPermission.nextAllowed}`);
            return res.status(423).json({
                success: false,
                error: 'stock_analysis_not_allowed',
                message: `Analysis can be started only from 4:00 PM on market close till next 8:45 AM. ${analysisPermission.reason}`,
                reason: analysisPermission.reason,
                nextAllowed: analysisPermission.nextAllowed,
                validUntil: analysisPermission.validUntil
            });
        }
        
        console.log(`✅ [STOCK ANALYSIS] Individual analysis allowed: ${analysisPermission.reason}, valid until: ${analysisPermission.validUntil}`);

        // Get user ID from authenticated request
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


        // Get current price from latest candle data
        let current_price = null;
        try {
            // Create temporary trade data to fetch latest price
            const tempTradeData = {
                term: analysis_type === 'swing' ? 'short' : 'intraday',
                instrument_key,
                stock: stock_name
            };
            
            // Use aiReviewService to get latest candle data
            const { endpoints } = await aiReviewService.aiReviewService.buildCandleUrls(tempTradeData);
            
            // Try to fetch latest price from the first endpoint
            if (endpoints.length > 0) {
                const latestEndpoint = endpoints[0]; // Get first endpoint for current price
                try {
                    const candleData = await aiReviewService.fetchCandleData(latestEndpoint.url);
                    const candles = candleData?.data?.candles || candleData?.candles || [];
                    
                    if (candles.length > 0) {
                        // Find the candle with the most recent timestamp
                        let latestCandle = null;
                        let latestTimestamp = null;
                        
                        
                        for (const candle of candles) {
                            const timestamp = Array.isArray(candle) ? candle[0] : candle.time;
                            const candleTime = new Date(timestamp).getTime();
                            
                            if (!latestTimestamp || candleTime > latestTimestamp) {
                                latestTimestamp = candleTime;
                                latestCandle = candle;
                            }
                        }
                        
                        if (latestCandle) {
                            const newPrice = Array.isArray(latestCandle) ? latestCandle[4] : latestCandle.close;
                            const candleTime = Array.isArray(latestCandle) ? latestCandle[0] : latestCandle.time;
                            
                            current_price = newPrice;
                        } else {
                            console.warn(`⚠️ No valid candle found in ${candles.length} candles`);
                        }
                    }
                } catch (priceError) {
                    console.warn(`⚠️ Could not fetch current price: ${priceError.message}`);
                }
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

        // TESTING: Skip rate limiting check

        // Start AI analysis directly
        const result = await aiReviewService.analyzeStock(
            instrument_key,
            stock_name,
            stock_symbol,
            price,
            analysis_type,
            userId
        );

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