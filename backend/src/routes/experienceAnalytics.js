import express from 'express';
import { experienceAnalytics } from '../services/analytics/experienceAnalytics.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

/**
 * Get analytics summary for admin dashboard
 * GET /api/v1/analytics/experience/summary
 */
router.get('/summary', auth, async (req, res) => {
  try {
    const { timeframe = '7d' } = req.query;
    
    // Validate timeframe
    if (!['1d', '7d', '30d'].includes(timeframe)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid timeframe. Must be 1d, 7d, or 30d'
      });
    }
    
    const summary = await experienceAnalytics.getAnalyticsSummary(timeframe);
    
    res.json({
      success: true,
      data: summary
    });
    
  } catch (error) {
    console.error('Error getting analytics summary:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get analytics summary'
    });
  }
});

/**
 * Track onboarding start event
 * POST /api/v1/analytics/experience/onboarding/start
 */
router.post('/onboarding/start', auth, async (req, res) => {
  try {
    const { entryPoint = 'main_flow' } = req.body;
    
    experienceAnalytics.trackOnboardingStarted(req.user.id, entryPoint);
    
    res.json({
      success: true,
      message: 'Onboarding start tracked'
    });
    
  } catch (error) {
    console.error('Error tracking onboarding start:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to track onboarding start'
    });
  }
});

/**
 * Track quiz start event
 * POST /api/v1/analytics/experience/quiz/start
 */
router.post('/quiz/start', auth, async (req, res) => {
  try {
    const { quizType } = req.body;
    
    if (!['quick_quiz', 'deep_diagnostic'].includes(quizType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid quiz type'
      });
    }
    
    experienceAnalytics.trackQuizStarted(req.user.id, quizType);
    
    res.json({
      success: true,
      message: 'Quiz start tracked'
    });
    
  } catch (error) {
    console.error('Error tracking quiz start:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to track quiz start'
    });
  }
});

/**
 * Track quiz skip event
 * POST /api/v1/analytics/experience/quiz/skip
 */
router.post('/quiz/skip', auth, async (req, res) => {
  try {
    const { quizType, reason = 'user_skip' } = req.body;
    
    if (!['quick_quiz', 'deep_diagnostic'].includes(quizType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid quiz type'
      });
    }
    
    experienceAnalytics.trackQuizSkipped(req.user.id, quizType, reason);
    
    res.json({
      success: true,
      message: 'Quiz skip tracked'
    });
    
  } catch (error) {
    console.error('Error tracking quiz skip:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to track quiz skip'
    });
  }
});

/**
 * Track gaming attempt detection
 * POST /api/v1/analytics/experience/gaming/detected
 */
router.post('/gaming/detected', auth, async (req, res) => {
  try {
    const { attemptType, quizScore, claimedLevel } = req.body;
    
    if (!attemptType || typeof quizScore !== 'number' || !claimedLevel) {
      return res.status(400).json({
        success: false,
        message: 'Required fields: attemptType, quizScore, claimedLevel'
      });
    }
    
    experienceAnalytics.trackGamingAttemptDetected(
      req.user.id,
      attemptType,
      quizScore,
      claimedLevel
    );
    
    res.json({
      success: true,
      message: 'Gaming attempt tracked'
    });
    
  } catch (error) {
    console.error('Error tracking gaming attempt:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to track gaming attempt'
    });
  }
});

/**
 * Track gaming intervention response
 * POST /api/v1/analytics/experience/gaming/response
 */
router.post('/gaming/response', auth, async (req, res) => {
  try {
    const { userChoice, recommendedLevel, finalLevel } = req.body;
    
    if (!userChoice || !recommendedLevel || !finalLevel) {
      return res.status(400).json({
        success: false,
        message: 'Required fields: userChoice, recommendedLevel, finalLevel'
      });
    }
    
    experienceAnalytics.trackGamingInterventionResponse(
      req.user.id,
      userChoice,
      recommendedLevel,
      finalLevel
    );
    
    res.json({
      success: true,
      message: 'Gaming intervention response tracked'
    });
    
  } catch (error) {
    console.error('Error tracking gaming intervention response:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to track gaming intervention response'
    });
  }
});

/**
 * Track onboarding abandonment
 * POST /api/v1/analytics/experience/onboarding/abandoned
 */
router.post('/onboarding/abandoned', auth, async (req, res) => {
  try {
    const { step, duration } = req.body;
    
    if (!step || typeof duration !== 'number') {
      return res.status(400).json({
        success: false,
        message: 'Required fields: step, duration'
      });
    }
    
    experienceAnalytics.trackOnboardingAbandoned(req.user.id, step, duration);
    
    res.json({
      success: true,
      message: 'Onboarding abandonment tracked'
    });
    
  } catch (error) {
    console.error('Error tracking onboarding abandonment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to track onboarding abandonment'
    });
  }
});

/**
 * Force flush analytics events
 * POST /api/v1/analytics/experience/flush
 */
router.post('/flush', auth, async (req, res) => {
  try {
    experienceAnalytics.flush();
    
    res.json({
      success: true,
      message: 'Analytics events flushed'
    });
    
  } catch (error) {
    console.error('Error flushing analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to flush analytics'
    });
  }
});

export default router;