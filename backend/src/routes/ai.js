import express from 'express';
import aiReviewService from '../services/aiAnalyze.service.js';
import StockAnalysis from '../models/stockAnalysis.js';
import Stock from '../models/stock.js';
import { auth as authenticateToken } from '../middleware/auth.js';
import rateLimit from 'express-rate-limit';

const router = express.Router();

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

        // Lookup stock details from database
        console.log(`🔍 Looking up stock details for: ${instrument_key}`);
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

        console.log(`📊 Found stock: ${stock_name} (${stock_symbol})`);

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
                        
                        console.log(`💰 Analyzing ${candles.length} candles to find most recent price...`);
                        
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
                            
                            console.log(`💰 Most recent candle: ${candleTime} with close price ₹${newPrice}`);
                            console.log(`💰 Total candles analyzed: ${candles.length}`);
                            
                            current_price = newPrice;
                            console.log(`💰 Updated current_price from latest market data: ₹${current_price}`);
                        } else {
                            console.warn(`⚠️ No valid candle found in ${candles.length} candles`);
                        }
                    }
                } catch (priceError) {
                    console.warn(`⚠️ Could not fetch current price: ${priceError.message}`);
                }
            }
            
            // Fallback: use a default price if we can't fetch current price
            if (!current_price) {
                console.warn('⚠️ Using fallback price of ₹100 for demo purposes');
                current_price = 100;
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

        const userId = req.user.id;

        // TESTING: Skip rate limiting check
        console.log(`🧪 TESTING: Skipping rate limiting for user ${userId}`);

        console.log(`📊 AI Analysis request: ${stock_symbol} (${analysis_type}) by user ${userId}`);

        // Start AI analysis
        const result = await aiReviewService.analyzeStock({
            instrument_key,
            stock_name,
            stock_symbol,
            current_price: price,
            analysis_type,
            user_id: userId,
            isFromRewardedAd,
            creditType,
            forceFresh
        });

        if (result.success) {
            const responseData = {
                success: true,
                data: result.data,
                cached: result.cached || false,
                analysis_id: result.data._id
            };

            // Add cache info for debugging
            if (result.cached) {
                responseData.cache_info = {
                    message: 'Analysis retrieved from cache',
                    created_at: result.data.created_at
                };
            }

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
        
        const stats = await StockAnalysis.getAnalysisStats(userId);
        const recentAnalyses = await StockAnalysis.findActiveForUser(userId, 5);
        
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

        await StockAnalysis.deleteOne({ _id: analysisId, user_id: userId });

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
 * @route GET /api/ai/health
 * @desc Check AI service health
 * @access Public
 */
router.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'AI service is running',
        timestamp: new Date().toISOString(),
        openai_configured: !!process.env.OPENAI_API_KEY
    });
});

export default router;