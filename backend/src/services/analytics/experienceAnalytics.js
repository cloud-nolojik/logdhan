/**
 * Experience Analytics Service
 * Tracks onboarding metrics, quiz completion rates, and classification accuracy
 */
class ExperienceAnalyticsService {
  constructor() {
    this.events = [];
    this.batchSize = 50;
    this.flushInterval = 30000; // 30 seconds
    
    // Start periodic flush
    this.startPeriodicFlush();
  }
  
  /**
   * Track experience-related analytics event
   * @param {string} userId - User ID
   * @param {string} eventType - Type of event
   * @param {Object} properties - Event properties
   */
  track(userId, eventType, properties = {}) {
    const event = {
      userId: userId,
      eventType: eventType,
      properties: properties,
      timestamp: new Date().toISOString(),
      sessionId: this.getSessionId(userId)
    };
    
    this.events.push(event);
    
    // Log important events immediately
    const criticalEvents = [
      'onboarding_started',
      'quiz_completed',
      'diagnostic_completed',
      'experience_level_changed',
      'gaming_attempt_detected'
    ];
    
    if (criticalEvents.includes(eventType)) {
      console.log(`📊 Analytics: ${eventType}`, { userId, properties });
    }
    
    // Flush if batch is full
    if (this.events.length >= this.batchSize) {
      this.flush();
    }
  }
  
  /**
   * Track onboarding funnel events
   */
  trackOnboardingStarted(userId, entryPoint = 'main_flow') {
    this.track(userId, 'onboarding_started', {
      entry_point: entryPoint,
      timestamp: Date.now()
    });
  }
  
  trackOnboardingCompleted(userId, duration, level, method, skipPenalty = false) {
    this.track(userId, 'onboarding_completed', {
      duration_seconds: duration,
      final_level: level,
      assessment_method: method,
      skip_penalty: skipPenalty,
      completion_rate: 1.0
    });
  }
  
  trackOnboardingAbandoned(userId, step, duration) {
    this.track(userId, 'onboarding_abandoned', {
      abandoned_at_step: step,
      duration_seconds: duration,
      completion_rate: this.calculateCompletionRate(step)
    });
  }
  
  /**
   * Track quiz-specific events
   */
  trackQuizStarted(userId, quizType) {
    this.track(userId, 'quiz_started', {
      quiz_type: quizType,
      timestamp: Date.now()
    });
  }
  
  trackQuizCompleted(userId, quizType, score, maxScore, duration, answers) {
    const accuracy = score / maxScore;
    const level = this.scoreToLevel(score, maxScore, quizType);
    
    this.track(userId, 'quiz_completed', {
      quiz_type: quizType,
      score: score,
      max_score: maxScore,
      accuracy: accuracy,
      duration_seconds: duration,
      predicted_level: level,
      question_count: answers.length,
      answers_breakdown: this.analyzeAnswerPatterns(answers)
    });
  }
  
  trackQuizSkipped(userId, quizType, reason = 'user_skip') {
    this.track(userId, 'quiz_skipped', {
      quiz_type: quizType,
      skip_reason: reason,
      penalty_applied: true
    });
  }
  
  /**
   * Track anti-gaming events
   */
  trackGamingAttemptDetected(userId, attemptType, quizScore, claimedLevel) {
    this.track(userId, 'gaming_attempt_detected', {
      attempt_type: attemptType, // 'advanced_with_low_score'
      quiz_score: quizScore,
      claimed_level: claimedLevel,
      corrective_action: 'intervention_shown'
    });
  }
  
  trackGamingInterventionResponse(userId, userChoice, recommendedLevel, finalLevel) {
    this.track(userId, 'gaming_intervention_response', {
      user_choice: userChoice, // 'accepted_recommendation' | 'insisted_advanced'
      recommended_level: recommendedLevel,
      final_level: finalLevel,
      penalty_applied: userChoice === 'insisted_advanced'
    });
  }
  
  /**
   * Track behavioral signal events
   */
  trackBehavioralSignal(userId, signalType, signalValue, context = {}) {
    this.track(userId, 'behavioral_signal', {
      signal_type: signalType,
      signal_value: signalValue,
      context: context,
      current_level: context.current_level
    });
  }
  
  trackExperienceLevelChanged(userId, fromLevel, toLevel, reason, confidence) {
    this.track(userId, 'experience_level_changed', {
      from_level: fromLevel,
      to_level: toLevel,
      change_reason: reason, // 'quiz_result' | 'behavioral_adjustment' | 'manual_override'
      confidence: confidence,
      is_upgrade: this.isLevelUpgrade(fromLevel, toLevel),
      is_downgrade: this.isLevelDowngrade(fromLevel, toLevel)
    });
  }
  
  /**
   * Track feature usage by experience level
   */
  trackFeatureUsage(userId, featureName, experienceLevel, metadata = {}) {
    this.track(userId, 'feature_usage', {
      feature_name: featureName,
      experience_level: experienceLevel,
      metadata: metadata
    });
  }
  
  /**
   * Track assessment accuracy over time
   */
  trackAssessmentAccuracy(userId, predictedLevel, actualBehavior, daysSinceAssessment) {
    const isAccurate = this.isLevelPredictionAccurate(predictedLevel, actualBehavior);
    
    this.track(userId, 'assessment_accuracy', {
      predicted_level: predictedLevel,
      actual_behavior_signals: actualBehavior,
      is_accurate: isAccurate,
      days_since_assessment: daysSinceAssessment,
      accuracy_score: this.calculateAccuracyScore(predictedLevel, actualBehavior)
    });
  }
  
  /**
   * Get analytics summary for dashboard
   */
  async getAnalyticsSummary(timeframe = '7d') {
    // In a real implementation, this would query a proper analytics database
    const recentEvents = this.events.filter(event => {
      const eventDate = new Date(event.timestamp);
      const cutoffDate = new Date(Date.now() - this.parseTimeframe(timeframe));
      return eventDate > cutoffDate;
    });
    
    return {
      total_onboardings_started: this.countEvents(recentEvents, 'onboarding_started'),
      total_onboardings_completed: this.countEvents(recentEvents, 'onboarding_completed'),
      completion_rate: this.calculateOverallCompletionRate(recentEvents),
      
      quiz_completion_rate: this.calculateQuizCompletionRate(recentEvents),
      average_quiz_score: this.calculateAverageQuizScore(recentEvents),
      
      gaming_attempts: this.countEvents(recentEvents, 'gaming_attempt_detected'),
      intervention_success_rate: this.calculateInterventionSuccessRate(recentEvents),
      
      level_distribution: this.calculateLevelDistribution(recentEvents),
      behavioral_adjustments: this.countEvents(recentEvents, 'experience_level_changed'),
      
      feature_usage_by_level: this.calculateFeatureUsageByLevel(recentEvents),
      
      timeframe: timeframe,
      generated_at: new Date().toISOString()
    };
  }
  
  /**
   * Helper methods for analytics calculations
   */
  scoreToLevel(score, maxScore, quizType) {
    const percentage = score / maxScore;
    
    if (quizType === 'quick_quiz') {
      return score <= 2 ? 'beginner' : score <= 4 ? 'intermediate' : 'advanced';
    } else {
      return score <= 4 ? 'beginner' : score <= 8 ? 'intermediate' : 'advanced';
    }
  }
  
  analyzeAnswerPatterns(answers) {
    const patterns = {
      total_questions: answers.length,
      perfect_scores: answers.filter(a => a.score === 2).length,
      partial_scores: answers.filter(a => a.score === 1).length,
      wrong_answers: answers.filter(a => a.score === 0).length,
      consistency_score: this.calculateConsistencyScore(answers)
    };
    
    return patterns;
  }
  
  calculateCompletionRate(currentStep) {
    const stepMap = {
      'welcome': 0.1,
      'quiz_started': 0.3,
      'quiz_completed': 0.7,
      'diagnostic_offered': 0.8,
      'diagnostic_completed': 1.0
    };
    
    return stepMap[currentStep] || 0.5;
  }
  
  calculateConsistencyScore(answers) {
    if (answers.length < 2) return 1.0;
    
    const scores = answers.map(a => a.score);
    const variance = this.calculateVariance(scores);
    
    // Lower variance = higher consistency
    return Math.max(0, 1 - (variance / 2)); // Normalize to 0-1
  }
  
  calculateVariance(numbers) {
    const mean = numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
    const squaredDiffs = numbers.map(n => Math.pow(n - mean, 2));
    return squaredDiffs.reduce((sum, sq) => sum + sq, 0) / numbers.length;
  }
  
  isLevelUpgrade(fromLevel, toLevel) {
    const levels = ['beginner', 'intermediate', 'advanced'];
    return levels.indexOf(toLevel) > levels.indexOf(fromLevel);
  }
  
  isLevelDowngrade(fromLevel, toLevel) {
    const levels = ['beginner', 'intermediate', 'advanced'];
    return levels.indexOf(toLevel) < levels.indexOf(fromLevel);
  }
  
  isLevelPredictionAccurate(predictedLevel, actualBehaviorSignals) {
    // Analyze behavior signals to determine if initial level prediction was accurate
    const expectedSignals = this.getExpectedSignalsForLevel(predictedLevel);
    const matchScore = this.calculateSignalMatchScore(expectedSignals, actualBehaviorSignals);
    
    return matchScore > 0.7; // 70% threshold for accuracy
  }
  
  calculateAccuracyScore(predictedLevel, actualBehavior) {
    const expectedSignals = this.getExpectedSignalsForLevel(predictedLevel);
    return this.calculateSignalMatchScore(expectedSignals, actualBehavior);
  }
  
  getExpectedSignalsForLevel(level) {
    const expectedSignals = {
      'beginner': {
        'simplify_click': 'high',
        'glossary_tap': 'high',
        'help_screen_visit': 'medium',
        'position_size_calc_use': 'low'
      },
      'intermediate': {
        'simplify_click': 'medium',
        'glossary_tap': 'medium',
        'technical_indicator_use': 'medium',
        'position_size_calc_use': 'medium'
      },
      'advanced': {
        'simplify_click': 'low',
        'glossary_disable': 'high',
        'advanced_order_type': 'high',
        'technical_indicator_use': 'high'
      }
    };
    
    return expectedSignals[level] || expectedSignals['intermediate'];
  }
  
  calculateSignalMatchScore(expectedSignals, actualSignals) {
    // Simplified implementation - in reality would be more sophisticated
    let matches = 0;
    let total = 0;
    
    for (const [signal, expectedFreq] of Object.entries(expectedSignals)) {
      const actualFreq = this.categorizeSignalFrequency(actualSignals[signal] || 0);
      if (actualFreq === expectedFreq) matches++;
      total++;
    }
    
    return total > 0 ? matches / total : 0;
  }
  
  categorizeSignalFrequency(count) {
    if (count >= 10) return 'high';
    if (count >= 3) return 'medium';
    return 'low';
  }
  
  countEvents(events, eventType) {
    return events.filter(e => e.eventType === eventType).length;
  }
  
  calculateOverallCompletionRate(events) {
    const started = this.countEvents(events, 'onboarding_started');
    const completed = this.countEvents(events, 'onboarding_completed');
    return started > 0 ? completed / started : 0;
  }
  
  calculateQuizCompletionRate(events) {
    const started = this.countEvents(events, 'quiz_started');
    const completed = this.countEvents(events, 'quiz_completed');
    return started > 0 ? completed / started : 0;
  }
  
  calculateAverageQuizScore(events) {
    const quizEvents = events.filter(e => e.eventType === 'quiz_completed');
    if (quizEvents.length === 0) return 0;
    
    const totalScore = quizEvents.reduce((sum, e) => sum + (e.properties.score || 0), 0);
    return totalScore / quizEvents.length;
  }
  
  calculateInterventionSuccessRate(events) {
    const interventions = events.filter(e => e.eventType === 'gaming_intervention_response');
    if (interventions.length === 0) return 0;
    
    const successes = interventions.filter(e => e.properties.user_choice === 'accepted_recommendation').length;
    return successes / interventions.length;
  }
  
  calculateLevelDistribution(events) {
    const completedOnboardings = events.filter(e => e.eventType === 'onboarding_completed');
    const distribution = { beginner: 0, intermediate: 0, advanced: 0 };
    
    completedOnboardings.forEach(event => {
      const level = event.properties.final_level;
      if (distribution.hasOwnProperty(level)) {
        distribution[level]++;
      }
    });
    
    return distribution;
  }
  
  calculateFeatureUsageByLevel(events) {
    const featureEvents = events.filter(e => e.eventType === 'feature_usage');
    const usage = {};
    
    featureEvents.forEach(event => {
      const feature = event.properties.feature_name;
      const level = event.properties.experience_level;
      
      if (!usage[feature]) usage[feature] = {};
      if (!usage[feature][level]) usage[feature][level] = 0;
      
      usage[feature][level]++;
    });
    
    return usage;
  }
  
  parseTimeframe(timeframe) {
    const timeframes = {
      '1d': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000
    };
    
    return timeframes[timeframe] || timeframes['7d'];
  }
  
  getSessionId(userId) {
    // Simple session ID generation - in production, would be more sophisticated
    return `${userId}_${Date.now()}`;
  }
  
  /**
   * Flush events to persistent storage (database, analytics service, etc.)
   */
  flush() {
    if (this.events.length === 0) return;
    
    const eventsToFlush = [...this.events];
    this.events = [];
    
    // In a real implementation, this would send to analytics service
    console.log(`📊 Flushing ${eventsToFlush.length} analytics events`);
    
    // Simulate sending to external analytics service
    this.sendToAnalyticsService(eventsToFlush);
  }
  
  sendToAnalyticsService(events) {
    // In production, would send to services like Mixpanel, PostHog, etc.
    try {
      // Simulate API call
      console.log(`📊 Sent ${events.length} events to analytics service`);
    } catch (error) {
      console.error('Failed to send analytics events:', error);
      // Re-add events to queue on failure
      this.events.unshift(...events);
    }
  }
  
  startPeriodicFlush() {
    setInterval(() => {
      this.flush();
    }, this.flushInterval);
  }
}

export const experienceAnalytics = new ExperienceAnalyticsService();