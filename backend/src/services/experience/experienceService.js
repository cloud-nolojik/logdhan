import { User } from '../../models/user.js';

/**
 * Enhanced Experience Classification Service
 * Handles quiz-based initial assessment and behavioral signal adjustment
 */
class ExperienceService {
  constructor() {
    // Signal weights based on experience level implications
    this.signalWeights = {
      // Negative signals (indicate lower experience)
      'simplify_click': {
        beginner: -0.05,
        intermediate: -0.03,
        advanced: -0.01
      },
      'glossary_tap': {
        beginner: -0.03,
        intermediate: -0.02,
        advanced: 0.0
      },
      'stop_loss_error': { // SL > Entry on BUY trades
        beginner: -0.10,
        intermediate: -0.07,
        advanced: -0.04
      },
      'help_screen_visit': {
        beginner: -0.02,
        intermediate: -0.01,
        advanced: 0.0
      },
      
      // Positive signals (indicate higher experience)
      'position_size_calc_use': {
        beginner: 0.02,
        intermediate: 0.03,
        advanced: 0.04
      },
      'glossary_disable': {
        beginner: 0.05,
        intermediate: 0.07,
        advanced: 0.10
      },
      'high_risk_reward_trade': { // RR > 2
        beginner: 0.04,
        intermediate: 0.05,
        advanced: 0.06
      },
      'technical_indicator_use': {
        beginner: 0.03,
        intermediate: 0.02,
        advanced: 0.01
      },
      'advanced_order_type': { // Stop-limit, bracket orders, etc.
        beginner: 0.06,
        intermediate: 0.04,
        advanced: 0.02
      },
      'sector_analysis_use': {
        beginner: 0.05,
        intermediate: 0.03,
        advanced: 0.02
      }
    };
    
    // Batch size for signal processing
    this.SIGNAL_BATCH_SIZE = 20;
  }
  
  /**
   * Process quiz results and set initial experience level
   * @param {string} userId - User ID
   * @param {Object} quizData - Quiz results
   */
  async processQuizAssessment(userId, quizData) {
    try {
      const { type, score, answers, maxScore } = quizData;
      
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }
      
      // Calculate initial level and confidence
      const { level, confidence } = this.calculateExperienceFromScore(score, maxScore, type);
      
      // Update user experience
      user.experience = {
        level: level,
        score: score,
        confidence: confidence,
        lastUpdated: new Date(),
        assessmentMethod: type
      };
      
      // Store quiz results
      if (type === 'quick_quiz') {
        user.assessmentHistory.quickQuiz = {
          completed: true,
          score: score,
          completedAt: new Date(),
          answers: answers
        };
      } else if (type === 'deep_diagnostic') {
        user.assessmentHistory.deepDiagnostic = {
          completed: true,
          score: score,
          completedAt: new Date(),
          answers: answers,
          badge: score >= 10 ? 'Pro Verified' : null
        };
      }
      
      // Update legacy fields for backward compatibility
      user.tradingExperience = level;
      user.preferredQuestionStyle = this.mapExperienceToQuestionStyle(level);
      user.onboardingCompleted = true;
      
      await user.save();
      
      console.log(`📊 Experience assessment complete: User ${userId} → ${level} (score: ${score}, confidence: ${confidence})`);
      
      return {
        level: level,
        score: score,
        confidence: confidence,
        badge: user.assessmentHistory.deepDiagnostic?.badge || null
      };
      
    } catch (error) {
      console.error('Error processing quiz assessment:', error);
      throw error;
    }
  }
  
  /**
   * Add behavioral signals to user profile
   * @param {string} userId - User ID
   * @param {Array} signals - Array of experience signals
   */
  async addBehavioralSignals(userId, signals) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }
      
      // Add signals to user profile
      user.experienceSignals.push(...signals);
      
      // Check if we should process a batch
      if (user.experienceSignals.length >= this.SIGNAL_BATCH_SIZE) {
        await this.processSignalBatch(user);
      }
      
      await user.save();
      
      console.log(`📊 Added ${signals.length} behavioral signals for user ${userId}`);
      
      return { success: true, signalsAdded: signals.length };
      
    } catch (error) {
      console.error('Error adding behavioral signals:', error);
      throw error;
    }
  }
  
  /**
   * Process accumulated behavioral signals and adjust experience level
   * @param {Object} user - User document
   */
  async processSignalBatch(user) {
    try {
      const signals = user.experienceSignals;
      if (signals.length === 0) return;
      
      // Calculate weighted signal impact
      const currentLevel = user.experience?.level || 'intermediate';
      let totalAdjustment = 0;
      
      signals.forEach(signal => {
        const weight = this.signalWeights[signal.type];
        if (weight && weight[currentLevel] !== undefined) {
          totalAdjustment += weight[currentLevel] * signal.value;
        }
      });
      
      // Apply adjustment to score
      const previousScore = user.experience?.score || 3; // Default to intermediate
      const adjustedScore = Math.max(0, Math.min(6, previousScore + totalAdjustment));
      
      // Determine new level
      const newLevel = this.scoreToLevel(adjustedScore);
      const newConfidence = this.calculateAdjustedConfidence(
        user.experience?.confidence || 0.3,
        signals.length,
        Math.abs(totalAdjustment)
      );
      
      // Update experience
      user.experience = {
        level: newLevel,
        score: adjustedScore,
        confidence: newConfidence,
        lastUpdated: new Date(),
        assessmentMethod: 'behavioral_adjustment'
      };
      
      // Store batch processing record
      user.signalBatches.push({
        processedAt: new Date(),
        signalCount: signals.length,
        scoreAdjustment: totalAdjustment,
        previousScore: previousScore,
        newScore: adjustedScore
      });
      
      // Update legacy fields
      user.tradingExperience = newLevel;
      user.preferredQuestionStyle = this.mapExperienceToQuestionStyle(newLevel);
      
      // Clear processed signals
      user.experienceSignals = [];
      
      // Log level changes
      if (currentLevel !== newLevel) {
        console.log(`🔄 Experience level changed: User ${user._id} → ${currentLevel} to ${newLevel} (score: ${previousScore} → ${adjustedScore})`);
      }
      
    } catch (error) {
      console.error('Error processing signal batch:', error);
      throw error;
    }
  }
  
  /**
   * Force process pending signals for a user
   * @param {string} userId - User ID
   */
  async forceProcessSignals(userId) {
    try {
      const user = await User.findById(userId);
      if (!user || user.experienceSignals.length === 0) {
        return { processed: false, reason: 'No pending signals' };
      }
      
      await this.processSignalBatch(user);
      await user.save();
      
      return { 
        processed: true, 
        newLevel: user.experience.level,
        newScore: user.experience.score 
      };
      
    } catch (error) {
      console.error('Error force processing signals:', error);
      throw error;
    }
  }
  
  /**
   * Get user's current experience data
   * @param {string} userId - User ID
   */
  async getUserExperience(userId) {
    try {
      // Handle test/mock user IDs
      if (userId?.startsWith('mock_')) {
        const experience = userId.split('_')[1];
        return ['beginner', 'intermediate', 'advanced'].includes(experience) ? experience : 'intermediate';
      }
      
      const user = await User.findById(userId).select('experience tradingExperience');
      
      // Return enhanced experience data if available
      if (user?.experience?.level) {
        return {
          level: user.experience.level,
          score: user.experience.score,
          confidence: user.experience.confidence,
          lastUpdated: user.experience.lastUpdated,
          method: user.experience.assessmentMethod
        };
      }
      
      // Fallback to legacy field
      return user?.tradingExperience || 'intermediate';
      
    } catch (error) {
      console.error('Error fetching user experience:', error);
      return 'intermediate'; // Safe fallback
    }
  }
  
  /**
   * Calculate experience level from quiz score
   * @param {number} score - Quiz score
   * @param {number} maxScore - Maximum possible score
   * @param {string} assessmentType - 'quick_quiz' or 'deep_diagnostic'
   */
  calculateExperienceFromScore(score, maxScore, assessmentType) {
    const percentage = score / maxScore;
    
    let level, confidence;
    
    if (assessmentType === 'quick_quiz') {
      // Quick quiz: lower confidence, simpler thresholds
      level = score <= 2 ? 'beginner' : score <= 4 ? 'intermediate' : 'advanced';
      confidence = 0.3; // Low confidence for quick assessment
    } else {
      // Deep diagnostic: higher confidence, more nuanced thresholds
      level = score <= 4 ? 'beginner' : score <= 8 ? 'intermediate' : 'advanced';
      confidence = percentage >= 0.8 ? 0.85 : percentage >= 0.6 ? 0.75 : percentage >= 0.4 ? 0.65 : 0.55;
    }
    
    return { level, confidence };
  }
  
  /**
   * Convert numerical score to experience level
   * @param {number} score - Experience score (0-6)
   */
  scoreToLevel(score) {
    if (score < 3) return 'beginner';
    if (score < 5) return 'intermediate';
    return 'advanced';
  }
  
  /**
   * Calculate adjusted confidence after behavioral signals
   * @param {number} currentConfidence - Current confidence level
   * @param {number} signalCount - Number of signals processed
   * @param {number} adjustmentMagnitude - Absolute value of score adjustment
   */
  calculateAdjustedConfidence(currentConfidence, signalCount, adjustmentMagnitude) {
    // More signals and larger adjustments increase confidence in classification
    const signalConfidenceBoost = Math.min(0.1, signalCount * 0.005);
    const adjustmentConfidenceBoost = Math.min(0.05, adjustmentMagnitude * 0.1);
    
    return Math.min(0.95, currentConfidence + signalConfidenceBoost + adjustmentConfidenceBoost);
  }
  
  /**
   * Map experience level to question style for backward compatibility
   * @param {string} level - Experience level
   */
  mapExperienceToQuestionStyle(level) {
    const mapping = {
      'beginner': 'simple',
      'intermediate': 'standard',
      'advanced': 'advanced'
    };
    return mapping[level] || 'standard';
  }
  
  /**
   * Check if user should be prompted to retake assessment
   * @param {string} userId - User ID
   */
  async shouldRetakeAssessment(userId) {
    try {
      const user = await User.findById(userId).select('experience assessmentHistory signalBatches');
      
      if (!user?.experience?.lastUpdated) return true;
      
      const daysSinceAssessment = (Date.now() - user.experience.lastUpdated) / (1000 * 60 * 60 * 24);
      const confidence = user.experience.confidence || 0;
      
      // Suggest retake if:
      // - Low confidence and 30+ days since assessment
      // - Multiple significant adjustments via behavioral signals
      // - Never took deep diagnostic and has been active for 60+ days
      
      const lowConfidenceOld = confidence < 0.5 && daysSinceAssessment > 30;
      const multipleAdjustments = user.signalBatches?.length > 5;
      const neverTookDiagnostic = !user.assessmentHistory?.deepDiagnostic?.completed && daysSinceAssessment > 60;
      
      return lowConfidenceOld || multipleAdjustments || neverTookDiagnostic;
      
    } catch (error) {
      console.error('Error checking retake assessment:', error);
      return false;
    }
  }
  
  /**
   * Get experience analytics for user
   * @param {string} userId - User ID
   */
  async getExperienceAnalytics(userId) {
    try {
      const user = await User.findById(userId).select('experience assessmentHistory signalBatches experienceSignals');
      
      if (!user) return null;
      
      return {
        currentExperience: user.experience,
        assessmentHistory: user.assessmentHistory,
        recentSignals: user.experienceSignals.slice(-10), // Last 10 signals
        adjustmentHistory: user.signalBatches.slice(-5), // Last 5 adjustments
        shouldRetakeAssessment: await this.shouldRetakeAssessment(userId)
      };
      
    } catch (error) {
      console.error('Error getting experience analytics:', error);
      return null;
    }
  }
}

export const experienceService = new ExperienceService();