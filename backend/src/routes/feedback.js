import express from 'express';
import { auth } from '../middleware/auth.js';
import AnalysisFeedback from '../models/analysisFeedback.js';
import StockAnalysis from '../models/stockAnalysis.js';

const router = express.Router();

/**
 * POST /api/feedback/analysis/:analysisId
 * Create or update feedback for an analysis
 * Body: { rating, comment?, tags?, detailed_ratings?, outcome? }
 */
router.post('/analysis/:analysisId', auth, async (req, res) => {
    try {
        const { analysisId } = req.params;
        const userId = req.user.id;
        const { rating, comment, tags, detailed_ratings, outcome } = req.body;

        // Validate rating
        if (!rating || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
            return res.status(400).json({
                success: false,
                error: 'Rating must be an integer between 1 and 5'
            });
        }

        // Verify analysis exists
        const analysis = await StockAnalysis.findById(analysisId);
        if (!analysis) {
            return res.status(404).json({
                success: false,
                error: 'Analysis not found'
            });
        }

        // Check if feedback already exists
        let feedback = await AnalysisFeedback.findOne({
            analysis_id: analysisId,
            user_id: userId
        });

        if (feedback) {
            // Update existing feedback
            await feedback.updateFeedback({
                rating,
                comment,
                tags,
                detailed_ratings,
                outcome
            });

            return res.json({
                success: true,
                message: 'Feedback updated successfully',
                data: {
                    feedback: {
                        id: feedback._id,
                        rating: feedback.rating,
                        comment: feedback.comment,
                        tags: feedback.tags,
                        detailed_ratings: feedback.detailed_ratings,
                        outcome: feedback.outcome,
                        createdAt: feedback.createdAt,
                        updatedAt: feedback.updatedAt,
                        edited_at: feedback.edited_at
                    }
                }
            });
        } else {
            // Create new feedback with strategy snapshot
            // Extract strategy (we use strategies[0] as current design has one strategy per analysis)
            const strategy = analysis.analysis_data?.strategies?.[0] || null;

            // Create analysis snapshot for context
            const analysisSnapshot = {
                analysis_type: analysis.analysis_type,
                generated_at: analysis.generated_at_ist || analysis.createdAt,
                market_summary: analysis.analysis_data?.market_summary || {},
                overall_sentiment: analysis.analysis_data?.overall_sentiment || 'NEUTRAL',
                schema_version: analysis.analysis_data?.schema_version || 'unknown'
            };

            feedback = await AnalysisFeedback.create({
                analysis_id: analysisId,
                user_id: userId,
                stock_symbol: analysis.stock_symbol,
                strategy_snapshot: strategy,  // 🎯 SNAPSHOT: Entire strategy object
                analysis_snapshot: analysisSnapshot,  // 🎯 SNAPSHOT: Analysis metadata
                rating,
                comment: comment || '',
                tags: tags || [],
                detailed_ratings: detailed_ratings || {},
                outcome: outcome || {}
            });

            return res.status(201).json({
                success: true,
                message: 'Feedback created successfully',
                data: {
                    feedback: {
                        id: feedback._id,
                        rating: feedback.rating,
                        comment: feedback.comment,
                        tags: feedback.tags,
                        detailed_ratings: feedback.detailed_ratings,
                        outcome: feedback.outcome,
                        strategy_snapshot: feedback.strategy_snapshot,
                        analysis_snapshot: feedback.analysis_snapshot,
                        createdAt: feedback.createdAt,
                        updatedAt: feedback.updatedAt
                    }
                }
            });
        }

    } catch (error) {
        console.error('Error creating/updating feedback:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to save feedback',
            message: error.message
        });
    }
});

/**
 * GET /api/feedback/analysis/:analysisId
 * Get user's feedback for a specific analysis
 */
router.get('/analysis/:analysisId', auth, async (req, res) => {
    try {
        const { analysisId } = req.params;
        const userId = req.user.id;

        const feedback = await AnalysisFeedback.findOne({
            analysis_id: analysisId,
            user_id: userId,
            is_deleted: false
        });

        if (!feedback) {
            return res.json({
                success: true,
                data: {
                    feedback: null,
                    has_feedback: false
                }
            });
        }

        res.json({
            success: true,
            data: {
                feedback: {
                    id: feedback._id,
                    rating: feedback.rating,
                    comment: feedback.comment,
                    tags: feedback.tags,
                    detailed_ratings: feedback.detailed_ratings,
                    outcome: feedback.outcome,
                    strategy_snapshot: feedback.strategy_snapshot,
                    analysis_snapshot: feedback.analysis_snapshot,
                    createdAt: feedback.createdAt,
                    updatedAt: feedback.updatedAt,
                    edited_at: feedback.edited_at
                },
                has_feedback: true
            }
        });

    } catch (error) {
        console.error('Error fetching feedback:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch feedback',
            message: error.message
        });
    }
});

/**
 * GET /api/feedback/analysis/:analysisId/stats
 * Get aggregate statistics for an analysis (all users)
 */
router.get('/analysis/:analysisId/stats', auth, async (req, res) => {
    try {
        const { analysisId } = req.params;

        const stats = await AnalysisFeedback.getAverageRatingForAnalysis(analysisId);

        if (!stats || stats.length === 0) {
            return res.json({
                success: true,
                data: {
                    average_rating: null,
                    total_feedbacks: 0,
                    rating_counts: {
                        five_star: 0,
                        four_star: 0,
                        three_star: 0,
                        two_star: 0,
                        one_star: 0
                    }
                }
            });
        }

        res.json({
            success: true,
            data: stats[0]
        });

    } catch (error) {
        console.error('Error fetching feedback stats:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch feedback statistics',
            message: error.message
        });
    }
});

/**
 * GET /api/feedback/my-feedback
 * Get user's feedback history
 */
router.get('/my-feedback', auth, async (req, res) => {
    try {
        const userId = req.user.id;
        const { limit = 20 } = req.query;

        const feedbackHistory = await AnalysisFeedback.getUserFeedbackHistory(
            userId,
            parseInt(limit)
        );

        res.json({
            success: true,
            data: {
                feedbacks: feedbackHistory.map(fb => ({
                    id: fb._id,
                    analysis_id: fb.analysis_id,
                    stock_symbol: fb.stock_symbol,
                    rating: fb.rating,
                    comment: fb.comment,
                    tags: fb.tags,
                    detailed_ratings: fb.detailed_ratings,
                    outcome: fb.outcome,
                    strategy_snapshot: fb.strategy_snapshot,
                    analysis_snapshot: fb.analysis_snapshot,
                    createdAt: fb.createdAt,
                    updatedAt: fb.updatedAt,
                    edited_at: fb.edited_at
                })),
                total: feedbackHistory.length
            }
        });

    } catch (error) {
        console.error('Error fetching feedback history:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch feedback history',
            message: error.message
        });
    }
});

/**
 * DELETE /api/feedback/analysis/:analysisId
 * Delete (soft delete) user's feedback for an analysis
 */
router.delete('/analysis/:analysisId', auth, async (req, res) => {
    try {
        const { analysisId } = req.params;
        const userId = req.user.id;

        const feedback = await AnalysisFeedback.findOne({
            analysis_id: analysisId,
            user_id: userId
        });

        if (!feedback) {
            return res.status(404).json({
                success: false,
                error: 'Feedback not found'
            });
        }

        await feedback.softDelete();

        res.json({
            success: true,
            message: 'Feedback deleted successfully'
        });

    } catch (error) {
        console.error('Error deleting feedback:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete feedback',
            message: error.message
        });
    }
});

/**
 * GET /api/feedback/stock/:stockSymbol/stats
 * Get average rating for a stock across all analyses
 */
router.get('/stock/:stockSymbol/stats', auth, async (req, res) => {
    try {
        const { stockSymbol } = req.params;

        const stats = await AnalysisFeedback.getAverageRatingForStock(stockSymbol);

        if (!stats || stats.length === 0) {
            return res.json({
                success: true,
                data: {
                    average_rating: null,
                    total_feedbacks: 0,
                    average_accuracy: null,
                    average_usefulness: null,
                    average_clarity: null
                }
            });
        }

        res.json({
            success: true,
            data: stats[0]
        });

    } catch (error) {
        console.error('Error fetching stock feedback stats:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch stock feedback statistics',
            message: error.message
        });
    }
});

/**
 * PATCH /api/feedback/analysis/:analysisId/outcome
 * Update outcome data for existing feedback (after trade completion)
 */
router.patch('/analysis/:analysisId/outcome', auth, async (req, res) => {
    try {
        const { analysisId } = req.params;
        const userId = req.user.id;
        const { outcome } = req.body;

        if (!outcome) {
            return res.status(400).json({
                success: false,
                error: 'Outcome data is required'
            });
        }

        const feedback = await AnalysisFeedback.findOne({
            analysis_id: analysisId,
            user_id: userId,
            is_deleted: false
        });

        if (!feedback) {
            return res.status(404).json({
                success: false,
                error: 'Feedback not found. Please create feedback first before updating outcome.'
            });
        }

        await feedback.updateFeedback({ outcome });

        res.json({
            success: true,
            message: 'Outcome updated successfully',
            data: {
                feedback: {
                    id: feedback._id,
                    outcome: feedback.outcome,
                    updatedAt: feedback.updatedAt,
                    edited_at: feedback.edited_at
                }
            }
        });

    } catch (error) {
        console.error('Error updating outcome:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to update outcome',
            message: error.message
        });
    }
});

/**
 * GET /api/feedback/stats/global
 * Get global feedback statistics for AI model improvement (admin/internal use)
 */
router.get('/stats/global', auth, async (req, res) => {
    try {
        const { daysBack = 30 } = req.query;

        const stats = await AnalysisFeedback.getFeedbackStats(parseInt(daysBack));

        if (!stats || stats.length === 0) {
            return res.json({
                success: true,
                data: {
                    total_feedbacks: 0,
                    average_rating: null,
                    average_accuracy: null,
                    average_usefulness: null,
                    average_clarity: null,
                    trades_taken_count: 0,
                    accurate_predictions_count: 0,
                    common_tags: []
                }
            });
        }

        res.json({
            success: true,
            data: stats[0]
        });

    } catch (error) {
        console.error('Error fetching global stats:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch global statistics',
            message: error.message
        });
    }
});

export default router;
