/**
 * Weekly Picks Scoring
 *
 * Scoring functions for weekly swing picks.
 * Extracted from engine/scoring.js — provides weekly-specific scoring
 * for A+ Momentum and Pullback scan types.
 *
 * The core scoring logic remains in engine/scoring.js.
 * This file provides convenient weekly-specific wrappers.
 */

import scoring, { calculateSetupScore, getGrade } from '../../engine/scoring.js';

const { GRADE_THRESHOLDS } = scoring;

// Re-export for convenience
export { getGrade, GRADE_THRESHOLDS };

/**
 * Calculate score for A+ Momentum stock
 * Uses the momentum scoring framework (100 pts total)
 */
export function calculateAPlusMomentumScore(stock, levels = null, niftyReturn1M = 0, debug = false) {
  return calculateSetupScore(stock, levels, niftyReturn1M, debug, 'a_plus_momentum');
}

/**
 * Calculate score for Pullback stock
 * Uses the pullback-specific scoring framework (inverted volume, EMA20 proximity, etc.)
 */
export function calculatePullbackScore(stock, levels = null, niftyReturn1M = 0, debug = false) {
  return calculateSetupScore(stock, levels, niftyReturn1M, debug, 'pullback');
}

/**
 * Calculate score for any weekly scan type
 * Routes to the appropriate scoring framework based on scanType
 */
export function calculateWeeklySetupScore(stock, levels = null, niftyReturn1M = 0, debug = false, scanType = 'a_plus_momentum') {
  return calculateSetupScore(stock, levels, niftyReturn1M, debug, scanType);
}

export default {
  calculateAPlusMomentumScore,
  calculatePullbackScore,
  calculateWeeklySetupScore,
  getGrade,
  GRADE_THRESHOLDS,
};
