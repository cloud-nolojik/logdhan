import express from 'express';
import { experienceService } from '../services/experience/experienceService.js';
import { experienceAnalytics } from '../services/analytics/experienceAnalytics.js';
import { auth } from '../middleware/auth.js';

const router = express.Router();

/**
 * Submit quiz results and get initial experience classification
 * POST /api/v1/experience/quiz
 */
router.post('/quiz', auth, async (req, res) => {
  try {
    const { type, score, answers, maxScore, duration } = req.body;
    
    // Validate input
    if (!type || typeof score !== 'number' || !Array.isArray(answers)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid quiz data. Required: type, score, answers'
      });
    }
    
    if (!['quick_quiz', 'deep_diagnostic'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid quiz type. Must be quick_quiz or deep_diagnostic'
      });
    }
    
    // Track quiz completion
    experienceAnalytics.trackQuizCompleted(
      req.user.id,
      type,
      score,
      maxScore || (type === 'quick_quiz' ? 6 : 12),
      duration || 0,
      answers
    );
    
    const result = await experienceService.processQuizAssessment(req.user.id, {
      type,
      score,
      answers,
      maxScore: maxScore || (type === 'quick_quiz' ? 6 : 12)
    });
    
    // Track onboarding completion
    experienceAnalytics.trackOnboardingCompleted(
      req.user.id,
      duration || 0,
      result.level,
      type
    );
    
    res.json({
      success: true,
      data: result,
      message: `Experience level set to ${result.level}`
    });
    
  } catch (error) {
    console.error('Error processing quiz:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process quiz results'
    });
  }
});

/**
 * Submit behavioral signals for experience adjustment
 * POST /api/v1/experience/signals
 */
router.post('/signals', auth, async (req, res) => {
  try {
    const { signals } = req.body;
    
    if (!Array.isArray(signals) || signals.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid signals data. Expected array of signals'
      });
    }
    
    // Validate signal structure
    const validSignals = signals.filter(signal => 
      signal.type && 
      typeof signal.type === 'string' &&
      (signal.value === undefined || typeof signal.value === 'number') &&
      (signal.metadata === undefined || typeof signal.metadata === 'object')
    );
    
    if (validSignals.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid signals found'
      });
    }
    
    // Track each behavioral signal
    const userExperience = await experienceService.getUserExperience(req.user.id);
    const currentLevel = typeof userExperience === 'string' ? userExperience : userExperience.level;
    
    validSignals.forEach(signal => {
      experienceAnalytics.trackBehavioralSignal(
        req.user.id,
        signal.type,
        signal.value || 1,
        { current_level: currentLevel, ...signal.metadata }
      );
    });
    
    const result = await experienceService.addBehavioralSignals(req.user.id, validSignals);
    
    res.json({
      success: true,
      data: result,
      message: `Added ${validSignals.length} behavioral signals`
    });
    
  } catch (error) {
    console.error('Error adding behavioral signals:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add behavioral signals'
    });
  }
});

/**
 * Get current user experience data
 * GET /api/v1/experience/current
 */
router.get('/current', auth, async (req, res) => {
  try {
    const experienceData = await experienceService.getUserExperience(req.user.id);
    
    res.json({
      success: true,
      data: experienceData
    });
    
  } catch (error) {
    console.error('Error getting user experience:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get experience data'
    });
  }
});

/**
 * Force process pending behavioral signals
 * POST /api/v1/experience/process-signals
 */
router.post('/process-signals', auth, async (req, res) => {
  try {
    const result = await experienceService.forceProcessSignals(req.user.id);
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    console.error('Error processing signals:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process signals'
    });
  }
});

/**
 * Get experience analytics for user
 * GET /api/v1/experience/analytics
 */
router.get('/analytics', auth, async (req, res) => {
  try {
    const analytics = await experienceService.getExperienceAnalytics(req.user.id);
    
    if (!analytics) {
      return res.status(404).json({
        success: false,
        message: 'No experience data found'
      });
    }
    
    // Track analytics request
    experienceAnalytics.trackFeatureUsage(
      req.user.id,
      'experience_analytics_view',
      analytics.currentExperience?.level || 'unknown'
    );
    
    res.json({
      success: true,
      data: analytics
    });
    
  } catch (error) {
    console.error('Error getting experience analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get analytics'
    });
  }
});

/**
 * Check if user should retake assessment
 * GET /api/v1/experience/should-retake
 */
router.get('/should-retake', auth, async (req, res) => {
  try {
    const shouldRetake = await experienceService.shouldRetakeAssessment(req.user.id);
    
    res.json({
      success: true,
      data: { shouldRetake }
    });
    
  } catch (error) {
    console.error('Error checking retake assessment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check retake status'
    });
  }
});

/**
 * Skip quiz and set default intermediate level
 * POST /api/v1/experience/skip-quiz
 */
router.post('/skip-quiz', auth, async (req, res) => {
  try {
    const result = await experienceService.processQuizAssessment(req.user.id, {
      type: 'self_reported',
      score: 3, // Default to intermediate
      answers: [],
      maxScore: 6
    });
    
    res.json({
      success: true,
      data: result,
      message: 'Experience level set to intermediate (default)'
    });
    
  } catch (error) {
    console.error('Error skipping quiz:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to skip quiz'
    });
  }
});

export default router;