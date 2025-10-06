import express from 'express';
import { auth } from '../middleware/auth.js';
import StockAnalysis from '../models/stockAnalysis.js';
import aiAnalyzeService from '../services/aiAnalyze.service.js';
import { User } from '../models/user.js';
import { getCurrentPrice } from '../utils/stock.js';

const router = express.Router();

// Get user's watchlist as stock list
async function getUserWatchlist(userId) {
    try {
        const user = await User.findById(userId);
        if (!user || !user.watchlist) {
            console.log(`📊 No watchlist found for user ${userId}`);
            return [];
        }
        
        const watchlist = user.watchlist || [];
        console.log(`📊 Loaded ${watchlist.length} stocks from user's watchlist`);
        return watchlist;
    } catch (error) {
        console.error('❌ Error loading user watchlist:', error);
        return [];
    }
}

// Route: Trigger bulk analysis for all stocks in the list
router.post('/analyze-all', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysis_type = 'swing' } = req.body;
        
        console.log(`🚀 Starting bulk analysis for user ${userId}, type: ${analysis_type}`);
        
        // Get user's watchlist
        const stocks = await getUserWatchlist(userId);
        if (stocks.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No stocks found in watchlist',
                message: 'Your watchlist is empty. Please add stocks to your watchlist before running bulk analysis.'
            });
        }
        
        // Delete all existing analyses for this user with the same analysis_type
        const deleteResult = await StockAnalysis.deleteMany({
            user_id: userId,
            analysis_type: analysis_type
        });
        
        console.log(`🗑️ Deleted ${deleteResult.deletedCount} existing analyses`);
        
        // Start bulk analysis (run in background)
        processBulkAnalysis(userId, stocks, analysis_type).catch(error => {
            console.error('❌ Background bulk analysis failed:', error);
        });
        
        res.status(200).json({
            success: true,
            message: 'Bulk analysis started',
            data: {
                total_stocks: stocks.length,
                analysis_type: analysis_type,
                deleted_existing: deleteResult.deletedCount,
                estimated_time_minutes: Math.ceil(stocks.length * 1.5), // Estimate 1.5 minutes per stock
                status: 'started'
            }
        });
        
    } catch (error) {
        console.error('❌ Error starting bulk analysis:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to start bulk analysis',
            message: error.message
        });
    }
});

// Route: Get bulk analysis status
router.get('/status', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const { analysis_type = 'swing' } = req.query;
        
        // Count analyses by status using same approach as strategies endpoint
        console.log(`📊 [BULK STATUS] Querying for user: ${userId}, analysis_type: ${analysis_type}`);
        
        // Use the same query pattern as strategies endpoint which we know works
        const completedAnalyses = await StockAnalysis.find({
            user_id: userId,
            analysis_type: analysis_type,
            status: 'completed',
            expires_at: { $gt: new Date() }
        }).select('status').lean();
        
        const inProgressAnalyses = await StockAnalysis.find({
            user_id: userId,
            analysis_type: analysis_type,
            status: 'in_progress',
            expires_at: { $gt: new Date() }
        }).select('status').lean();
        
        const pendingAnalyses = await StockAnalysis.find({
            user_id: userId,
            analysis_type: analysis_type,
            status: 'pending',
            expires_at: { $gt: new Date() }
        }).select('status').lean();
        
        const failedAnalyses = await StockAnalysis.find({
            user_id: userId,
            analysis_type: analysis_type,
            status: 'failed',
            expires_at: { $gt: new Date() }
        }).select('status').lean();
        
        console.log(`📊 [BULK STATUS] Found completed: ${completedAnalyses.length}, in_progress: ${inProgressAnalyses.length}, pending: ${pendingAnalyses.length}, failed: ${failedAnalyses.length}`);
        
        // Build status map using the actual counts
        const statusMap = {
            'completed': completedAnalyses.length,
            'in_progress': inProgressAnalyses.length, 
            'pending': pendingAnalyses.length,
            'failed': failedAnalyses.length
        };
        
        let totalAnalyses = completedAnalyses.length + inProgressAnalyses.length + pendingAnalyses.length + failedAnalyses.length;
        
        // Get target count from user's watchlist
        const stocks = await getUserWatchlist(userId);
        const targetCount = stocks.length;
        
        const completed = statusMap.completed || 0;
        const inProgress = statusMap.in_progress || 0;
        const pending = statusMap.pending || 0;
        const failed = statusMap.failed || 0;
        
        const isComplete = completed >= targetCount;
        const progressPercentage = Math.round((completed / targetCount) * 100);
        
        res.status(200).json({
            success: true,
            data: {
                target_count: targetCount,
                total_analyses: totalAnalyses,
                completed: completed,
                in_progress: inProgress,
                pending: pending,
                failed: failed,
                progress_percentage: progressPercentage,
                is_complete: isComplete,
                analysis_type: analysis_type,
                status: isComplete ? 'completed' : inProgress > 0 ? 'in_progress' : 'pending'
            }
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
        
        console.log(`📊 Fetching strategies for user ${userId}, type: ${analysis_type}`);
        
        // Fetch all completed analyses
        const analyses = await StockAnalysis.find({
            user_id: userId,
            analysis_type: analysis_type,
            status: 'completed',
            expires_at: { $gt: new Date() }
        })
        .select('instrument_key stock_name stock_symbol current_price analysis_data created_at')
        .sort({ created_at: -1 })
        .limit(parseInt(limit));
        
        console.log(`📊 Found ${analyses.length} completed analyses`);
        
        // Extract and rank strategies
        const allStrategies = [];
        
        let noTradeCount = 0;
        
        analyses.forEach(analysis => {
            if (analysis.analysis_data && analysis.analysis_data.strategies) {
                analysis.analysis_data.strategies.forEach(strategy => {
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
        
        // Group by sentiment and risk for additional insights
        const sentimentGroups = {
            BULLISH: allStrategies.filter(s => s.overall_sentiment === 'BULLISH'),
            BEARISH: allStrategies.filter(s => s.overall_sentiment === 'BEARISH'),
            NEUTRAL: allStrategies.filter(s => s.overall_sentiment === 'NEUTRAL')
        };
        
        const riskGroups = {
            Low: allStrategies.filter(s => s.strategy.risk_meter === 'Low'),
            Medium: allStrategies.filter(s => s.strategy.risk_meter === 'Medium'),
            High: allStrategies.filter(s => s.strategy.risk_meter === 'High')
        };
        
        res.status(200).json({
            success: true,
            data: {
                strategies: allStrategies,
                summary: {
                    total_strategies: allStrategies.length,
                    total_stocks_analyzed: analyses.length,
                    no_trade_count: noTradeCount,
                    avg_confidence: allStrategies.length > 0 ? 
                        (allStrategies.reduce((sum, s) => sum + s.strategy.confidence, 0) / allStrategies.length).toFixed(3) : 0,
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
                        BUY: allStrategies.filter(s => s.strategy.type === 'BUY').length,
                        SELL: allStrategies.filter(s => s.strategy.type === 'SELL').length,
                        NO_TRADE: allStrategies.filter(s => s.strategy.type === 'NO_TRADE').length
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
async function processBulkAnalysis(userId, stocks, analysisType) {
    console.log(`🔄 [BULK ANALYSIS] Starting background processing for user ${userId} with ${stocks.length} stocks, type: ${analysisType}`);
    let completed = 0;
    let failed = 0;
    
    // Process stocks in batches to avoid overwhelming the system
    const batchSize = 5;
    const totalBatches = Math.ceil(stocks.length / batchSize);
    
    for (let i = 0; i < totalBatches; i++) {
        const batchStart = i * batchSize;
        const batchEnd = Math.min(batchStart + batchSize, stocks.length);
        const batch = stocks.slice(batchStart, batchEnd);
        
        console.log(`📦 [BULK ANALYSIS] Processing batch ${i + 1}/${totalBatches} (stocks ${batchStart + 1}-${batchEnd})`);
        
        // Process batch in parallel
        const batchPromises = batch.map(async (stock, index) => {
            try {
                console.log(`🔍 [BULK ANALYSIS] Analyzing ${stock.trading_symbol} (${stock.name})`);
                
                // Fetch real current price
                let currentPrice = '0'
                try {
                     currentPrice = await getCurrentPrice(stock.instrument_key);
                    
                } catch (priceError) {
                    console.error(`❌ [BULK ANALYSIS] Price fetch failed for ${stock.trading_symbol}:`, priceError.message);
                    console.log(`⚠️ [BULK ANALYSIS] Using fallback price: ₹${currentPrice}`);
                }
                
                await aiAnalyzeService.analyzeStock({
                    instrument_key: stock.instrument_key,
                    stock_symbol: stock.trading_symbol, // Use trading_symbol for display
                    stock_name: stock.name,
                    current_price: currentPrice,
                    analysis_type: analysisType,
                    user_id: userId,
                    forceFresh: true // Always force fresh analysis
                });
                
                completed++;
                console.log(`✅ [BULK ANALYSIS] Completed ${stock.trading_symbol} (${completed}/${stocks.length})`);
                
            } catch (error) {
                failed++;
                console.error(`❌ [BULK ANALYSIS] Failed to analyze ${stock.trading_symbol}:`, error.message);
            }
        });
        
        await Promise.all(batchPromises);
        
        // Add delay between batches to avoid rate limiting
        if (i < totalBatches - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
        }
    }
    
    console.log(`🏁 [BULK ANALYSIS] Completed for user ${userId}. Success: ${completed}, Failed: ${failed}`);
}

export default router;