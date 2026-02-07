/**
 * Scoring Module - Framework-Based Scoring
 *
 * Single source of truth for:
 * - Setup Score (0-100 rating based on 6-factor framework)
 * - RSI Elimination (pre-filter for extended stocks)
 * - Candidate Ranking
 * - Confidence Calculation
 *
 * MOMENTUM FRAMEWORK FACTORS (100 points total):
 * 1. Volume Conviction     - 20 pts (Critical)
 * 2. Risk:Reward Ratio     - 20 pts (Critical)
 * 3. RSI Position          - 15 pts (High) + Elimination filter
 * 4. % Weekly Move         - 15 pts (High)
 * 5. Upside % to Target    - 15 pts (High)
 * 6. Relative Strength     - 10 pts (Medium)
 * 7. Price Accessibility   -  5 pts (Low)
 *
 * PULLBACK FRAMEWORK FACTORS (100 points total):
 * 1. EMA20 Proximity       - 25 pts (Critical) - the core pullback thesis
 * 2. Volume Decline Quality - 20 pts (Critical) - INVERTED: low volume = good
 * 3. RSI Cooling           - 15 pts (High) - cooled RSI = controlled pullback
 * 4. Trend Structure       - 15 pts (High) - EMA stack must be intact
 * 5. Risk:Reward Ratio     - 15 pts (High) - recalibrated for pullback R:R
 * 6. Relative Strength     -  5 pts (Medium)
 * 7. ATR% Tradability      -  5 pts (Low)
 */

import { round2, isNum, clamp } from './helpers.js';

/**
 * Grade thresholds for setup scores
 */
const GRADE_THRESHOLDS = {
  'A+': 80,
  A: 70,
  'B+': 60,
  B: 50,
  C: 40
  // Below 40 = D
};

/**
 * Get letter grade from numeric score
 */
export function getGrade(score) {
  if (score >= GRADE_THRESHOLDS['A+']) return 'A+';
  if (score >= GRADE_THRESHOLDS.A) return 'A';
  if (score >= GRADE_THRESHOLDS['B+']) return 'B+';
  if (score >= GRADE_THRESHOLDS.B) return 'B';
  if (score >= GRADE_THRESHOLDS.C) return 'C';
  return 'D';
}

/**
 * Calculate Setup Score for a stock (Framework-Based)
 *
 * Evaluates swing trading quality on 0-100 scale using 6-factor framework.
 * Requires trading levels for R:R and upside calculation.
 *
 * @param {Object} stock - Stock data with indicators
 * @param {Object} levels - Trading levels from calculateAPlusMomentumLevels (optional)
 * @param {number} niftyReturn1M - Nifty 1-month return for relative strength
 * @param {boolean} debug - Include detailed breakdown
 * @param {string} scanType - Scan type for scan-specific scoring ('a_plus_momentum', 'pullback')
 * @returns {Object} { score, grade, breakdown, eliminated, eliminationReason }
 */
export function calculateSetupScore(stock, levels = null, niftyReturn1M = 0, debug = false, scanType = 'a_plus_momentum') {
  // Route to pullback-specific scoring
  if (scanType === 'pullback') {
    return calculatePullbackScore(stock, levels, niftyReturn1M, debug);
  }

  const {
    last,
    price,
    close,
    rsi,
    rsi14,
    volume,
    volume_20avg,
    volume_vs_avg,
    return_1m,
    weekly_change_pct,
    weeklyChangePercent
  } = stock;

  const currentPrice = last || price || close;
  const currentRsi = rsi14 || rsi;
  const weeklyRsi = stock.weekly_rsi;  // NEW: For dual-timeframe elimination

  // Validate minimum required data
  if (!isNum(currentPrice)) {
    return {
      score: 0,
      grade: 'D',
      breakdown: [{ factor: 'DATA_ERROR', points: 0, max: 100, value: null, reason: 'Missing price data' }],
      eliminated: true,
      eliminationReason: 'Missing price data'
    };
  }

  // ============================================
  // PRE-FILTER: RSI Elimination (Hard Gate)
  // Now checks BOTH daily AND weekly RSI
  // This catches cases like BAJAJCON (daily RSI ~72.3, weekly RSI 74.8)
  // ============================================
  if (isNum(currentRsi) && currentRsi > 72) {
    return {
      score: 0,
      grade: 'X',
      breakdown: [{ factor: 'RSI_ELIMINATED', points: 0, max: 100, value: round2(currentRsi), reason: `Daily RSI ${round2(currentRsi)} > 72 (too extended)` }],
      eliminated: true,
      eliminationReason: `Daily RSI ${round2(currentRsi)} > 72 (too extended)`
    };
  }

  // NEW: Weekly RSI elimination - catches extended stocks that daily RSI might miss
  if (isNum(weeklyRsi) && weeklyRsi > 72) {
    return {
      score: 0,
      grade: 'X',
      breakdown: [{ factor: 'WEEKLY_RSI_ELIMINATED', points: 0, max: 100, value: round2(weeklyRsi), reason: `Weekly RSI ${round2(weeklyRsi)} > 72 (weekly overbought)` }],
      eliminated: true,
      eliminationReason: `Weekly RSI ${round2(weeklyRsi)} > 72 (weekly overbought)`
    };
  }

  const breakdown = [];
  let totalScore = 0;

  // ============================================
  // FACTOR 1: Volume Conviction (20 pts) - CRITICAL
  // ============================================
  const volRatio = volume_vs_avg || (volume && volume_20avg ? volume / volume_20avg : null);

  let volumeScore = 0;
  let volumeReason = '';

  if (isNum(volRatio)) {
    if (volRatio >= 3.0) {
      volumeScore = 20;
      volumeReason = `Exceptional volume (${round2(volRatio)}x avg) - strong institutional interest`;
    } else if (volRatio >= 2.5) {
      volumeScore = 18;
      volumeReason = `Very high volume (${round2(volRatio)}x avg)`;
    } else if (volRatio >= 2.0) {
      volumeScore = 16;
      volumeReason = `High volume (${round2(volRatio)}x avg) - good conviction`;
    } else if (volRatio >= 1.5) {
      volumeScore = 12;
      volumeReason = `Above average volume (${round2(volRatio)}x avg)`;
    } else if (volRatio >= 1.2) {
      volumeScore = 8;
      volumeReason = `Slightly above average (${round2(volRatio)}x avg)`;
    } else if (volRatio >= 1.0) {
      volumeScore = 5;
      volumeReason = `Average volume (${round2(volRatio)}x avg)`;
    } else {
      volumeScore = 2;
      volumeReason = `Below average volume (${round2(volRatio)}x avg) - weak conviction`;
    }
  } else {
    volumeScore = 5;
    volumeReason = 'No volume data available';
  }

  totalScore += volumeScore;
  breakdown.push({ factor: 'Volume Conviction', points: volumeScore, max: 20, reason: volumeReason });

  // ============================================
  // FACTOR 2: Risk:Reward Ratio (20 pts) - CRITICAL
  // ============================================
  let rrScore = 0;
  let rrReason = '';
  let rrValue = null;

  if (levels && levels.valid && isNum(levels.riskReward)) {
    rrValue = levels.riskReward;

    if (rrValue >= 3.0) {
      rrScore = 20;
      rrReason = `Excellent R:R (1:${round2(rrValue)}) - high quality setup`;
    } else if (rrValue >= 2.5) {
      rrScore = 17;
      rrReason = `Very good R:R (1:${round2(rrValue)})`;
    } else if (rrValue >= 2.0) {
      rrScore = 14;
      rrReason = `Good R:R (1:${round2(rrValue)}) - meets framework minimum`;
    } else if (rrValue >= 1.5) {
      rrScore = 10;
      rrReason = `Acceptable R:R (1:${round2(rrValue)})`;
    } else if (rrValue >= 1.2) {
      rrScore = 5;
      rrReason = `Marginal R:R (1:${round2(rrValue)}) - consider skipping`;
    } else {
      rrScore = 0;
      rrReason = `Poor R:R (1:${round2(rrValue)}) - not recommended`;
    }
  } else if (levels && !levels.valid) {
    rrScore = 0;
    rrReason = `Levels invalid: ${levels.reason || 'unknown'}`;
  } else {
    // No levels provided - give neutral score
    rrScore = 10;
    rrReason = 'R:R not calculated (levels not provided)';
  }

  totalScore += rrScore;
  breakdown.push({ factor: 'Risk:Reward', points: rrScore, max: 20, reason: rrReason, value: rrValue ? `1:${round2(rrValue)}` : 'N/A' });

  // ============================================
  // FACTOR 3: RSI Position (15 pts)
  // ============================================
  let rsiScore = 0;
  let rsiReason = '';

  if (isNum(currentRsi)) {
    if (currentRsi >= 55 && currentRsi <= 62) {
      rsiScore = 15;
      rsiReason = `Sweet spot (RSI ${round2(currentRsi)}) - ideal entry zone`;
    } else if (currentRsi >= 52 && currentRsi < 55) {
      rsiScore = 12;
      rsiReason = `Building momentum (RSI ${round2(currentRsi)})`;
    } else if (currentRsi > 62 && currentRsi <= 65) {
      rsiScore = 12;
      rsiReason = `Good momentum (RSI ${round2(currentRsi)})`;
    } else if (currentRsi > 65 && currentRsi <= 68) {
      rsiScore = 10;
      rsiReason = `Strong but acceptable (RSI ${round2(currentRsi)})`;
    } else if (currentRsi > 68 && currentRsi <= 72) {
      rsiScore = 5;
      rsiReason = `Caution zone (RSI ${round2(currentRsi)}) - near overbought`;
    } else if (currentRsi >= 45 && currentRsi < 52) {
      rsiScore = 8;
      rsiReason = `Neutral zone (RSI ${round2(currentRsi)})`;
    } else {
      rsiScore = 3;
      rsiReason = `Outside ideal range (RSI ${round2(currentRsi)})`;
    }
  } else {
    rsiScore = 7;
    rsiReason = 'No RSI data available';
  }

  totalScore += rsiScore;
  breakdown.push({ factor: 'RSI Position', points: rsiScore, max: 15, reason: rsiReason, value: currentRsi ? round2(currentRsi) : 'N/A' });

  // ============================================
  // FACTOR 4: % Weekly Move (15 pts)
  // ============================================
  const weeklyChange = weekly_change_pct || weeklyChangePercent || 0;

  let weeklyScore = 0;
  let weeklyReason = '';

  if (isNum(weeklyChange)) {
    if (weeklyChange >= 7) {
      weeklyScore = 15;
      weeklyReason = `Strong momentum (+${round2(weeklyChange)}% this week)`;
    } else if (weeklyChange >= 5) {
      weeklyScore = 13;
      weeklyReason = `Good momentum (+${round2(weeklyChange)}% this week)`;
    } else if (weeklyChange >= 4) {
      weeklyScore = 11;
      weeklyReason = `Solid momentum (+${round2(weeklyChange)}% this week)`;
    } else if (weeklyChange >= 3) {
      weeklyScore = 9;
      weeklyReason = `Meets minimum (+${round2(weeklyChange)}% this week)`;
    } else if (weeklyChange >= 2) {
      weeklyScore = 6;
      weeklyReason = `Moderate move (+${round2(weeklyChange)}% this week)`;
    } else if (weeklyChange >= 1) {
      weeklyScore = 3;
      weeklyReason = `Weak momentum (+${round2(weeklyChange)}% this week)`;
    } else {
      weeklyScore = 0;
      weeklyReason = `No momentum (${round2(weeklyChange)}% this week)`;
    }
  } else {
    weeklyScore = 5;
    weeklyReason = 'Weekly change not available';
  }

  totalScore += weeklyScore;
  breakdown.push({ factor: 'Weekly Move', points: weeklyScore, max: 15, reason: weeklyReason, value: `${round2(weeklyChange)}%` });

  // ============================================
  // FACTOR 5: Upside % to Target (15 pts)
  // ============================================
  let upsideScore = 0;
  let upsideReason = '';
  let upsidePct = 0;

  if (levels && levels.valid && isNum(levels.target2) && isNum(currentPrice)) {
    upsidePct = ((levels.target2 - currentPrice) / currentPrice) * 100;

    if (upsidePct >= 15) {
      upsideScore = 15;
      upsideReason = `Excellent upside (${round2(upsidePct)}% to target)`;
    } else if (upsidePct >= 12) {
      upsideScore = 13;
      upsideReason = `Very good upside (${round2(upsidePct)}% to target)`;
    } else if (upsidePct >= 10) {
      upsideScore = 11;
      upsideReason = `Good upside (${round2(upsidePct)}% to target)`;
    } else if (upsidePct >= 8) {
      upsideScore = 9;
      upsideReason = `Decent upside (${round2(upsidePct)}% to target)`;
    } else if (upsidePct >= 6) {
      upsideScore = 7;
      upsideReason = `Moderate upside (${round2(upsidePct)}% to target)`;
    } else if (upsidePct >= 4) {
      upsideScore = 4;
      upsideReason = `Limited upside (${round2(upsidePct)}% to target)`;
    } else {
      upsideScore = 2;
      upsideReason = `Minimal upside (${round2(upsidePct)}% to target)`;
    }
  } else if (levels && levels.rewardPercent) {
    // Use rewardPercent from levels if available
    upsidePct = levels.rewardPercent;
    if (upsidePct >= 10) upsideScore = 11;
    else if (upsidePct >= 7) upsideScore = 8;
    else if (upsidePct >= 5) upsideScore = 5;
    else upsideScore = 3;
    upsideReason = `${round2(upsidePct)}% reward potential`;
  } else {
    upsideScore = 7;
    upsideReason = 'Upside not calculated (no target)';
  }

  totalScore += upsideScore;
  breakdown.push({ factor: 'Upside to Target', points: upsideScore, max: 15, reason: upsideReason, value: `${round2(upsidePct)}%` });

  // ============================================
  // FACTOR 6: Relative Strength vs Nifty (10 pts)
  // ============================================
  let rsScore = 0;
  let rsReason = '';

  if (isNum(return_1m) && isNum(niftyReturn1M)) {
    const outperformance = return_1m - niftyReturn1M;

    if (outperformance >= 10) {
      rsScore = 10;
      rsReason = `Strong outperformer (+${round2(outperformance)}% vs Nifty)`;
    } else if (outperformance >= 7) {
      rsScore = 8;
      rsReason = `Good outperformer (+${round2(outperformance)}% vs Nifty)`;
    } else if (outperformance >= 5) {
      rsScore = 7;
      rsReason = `Outperforming (+${round2(outperformance)}% vs Nifty)`;
    } else if (outperformance >= 3) {
      rsScore = 5;
      rsReason = `Slight outperformer (+${round2(outperformance)}% vs Nifty)`;
    } else if (outperformance >= 0) {
      rsScore = 3;
      rsReason = `In line with Nifty (${round2(outperformance)}%)`;
    } else {
      rsScore = 0;
      rsReason = `Underperforming (${round2(outperformance)}% vs Nifty)`;
    }
  } else if (isNum(return_1m)) {
    // No Nifty data, use absolute return
    if (return_1m >= 10) rsScore = 7;
    else if (return_1m >= 5) rsScore = 5;
    else if (return_1m >= 0) rsScore = 3;
    else rsScore = 0;
    rsReason = `1M return: ${round2(return_1m)}% (no Nifty comparison)`;
  } else {
    rsScore = 3;
    rsReason = 'No relative strength data';
  }

  totalScore += rsScore;
  breakdown.push({ factor: 'Relative Strength', points: rsScore, max: 10, reason: rsReason });

  // ============================================
  // FACTOR 7: Price Accessibility (5 pts) - Bonus
  // ============================================
  let priceScore = 0;
  let priceReason = '';

  if (isNum(currentPrice) && currentPrice > 0) {
    if (currentPrice <= 200) {
      priceScore = 5;
      priceReason = `Low price (₹${round2(currentPrice)}) - easy position sizing`;
    } else if (currentPrice <= 500) {
      priceScore = 4;
      priceReason = `Moderate price (₹${round2(currentPrice)})`;
    } else if (currentPrice <= 1000) {
      priceScore = 3;
      priceReason = `Higher price (₹${round2(currentPrice)})`;
    } else if (currentPrice <= 2000) {
      priceScore = 2;
      priceReason = `Expensive (₹${round2(currentPrice)})`;
    } else {
      priceScore = 1;
      priceReason = `Very expensive (₹${round2(currentPrice)}) - needs larger capital`;
    }
  } else {
    priceScore = 2;
    priceReason = 'Price not available';
  }

  totalScore += priceScore;
  breakdown.push({ factor: 'Price Accessibility', points: priceScore, max: 5, reason: priceReason });

  // ============================================
  // FINAL RESULT
  // ============================================
  return {
    score: round2(totalScore),
    grade: getGrade(totalScore),
    breakdown: debug ? breakdown : undefined,
    eliminated: false,
    eliminationReason: null,
    // Include levels info in result for reference
    levels_valid: levels?.valid || false,
    risk_reward: rrValue
  };
}

/**
 * Calculate Pullback Score for a stock
 *
 * Evaluates pullback trading quality on 0-100 scale using pullback-specific factors.
 * Inverted priorities from momentum scoring: low volume = good, cooled RSI = good.
 *
 * @param {Object} stock - Stock data with indicators
 * @param {Object} levels - Trading levels from calculatePullbackLevels
 * @param {number} niftyReturn1M - Nifty 1-month return for relative strength
 * @param {boolean} debug - Include detailed breakdown
 * @returns {Object} { score, grade, breakdown, eliminated, eliminationReason }
 */
function calculatePullbackScore(stock, levels = null, niftyReturn1M = 0, debug = false) {
  const {
    last,
    price,
    close,
    rsi,
    rsi14,
    ema20,
    ema50,
    dma200,
    volume_vs_avg,
    volume,
    volume_20avg,
    return_1m,
    atr,
    atr_pct
  } = stock;

  const currentPrice = last || price || close;
  const currentRsi = rsi14 || rsi;
  const weeklyRsi = stock.weekly_rsi;

  // Validate minimum required data
  if (!isNum(currentPrice)) {
    return {
      score: 0,
      grade: 'D',
      breakdown: [{ factor: 'DATA_ERROR', points: 0, max: 100, value: null, reason: 'Missing price data' }],
      eliminated: true,
      eliminationReason: 'Missing price data'
    };
  }

  // ============================================
  // PRE-FILTER: RSI Elimination (shared with momentum)
  // ============================================
  if (isNum(currentRsi) && currentRsi > 72) {
    return {
      score: 0,
      grade: 'X',
      breakdown: [{ factor: 'RSI_ELIMINATED', points: 0, max: 100, value: round2(currentRsi), reason: `Daily RSI ${round2(currentRsi)} > 72 (too extended for pullback)` }],
      eliminated: true,
      eliminationReason: `Daily RSI ${round2(currentRsi)} > 72 (too extended)`
    };
  }

  if (isNum(weeklyRsi) && weeklyRsi > 72) {
    return {
      score: 0,
      grade: 'X',
      breakdown: [{ factor: 'WEEKLY_RSI_ELIMINATED', points: 0, max: 100, value: round2(weeklyRsi), reason: `Weekly RSI ${round2(weeklyRsi)} > 72 (weekly overbought)` }],
      eliminated: true,
      eliminationReason: `Weekly RSI ${round2(weeklyRsi)} > 72 (weekly overbought)`
    };
  }

  // Pullback-specific: RSI too weak = trend may be broken
  if (isNum(currentRsi) && currentRsi < 35) {
    return {
      score: 0,
      grade: 'X',
      breakdown: [{ factor: 'RSI_TOO_WEAK', points: 0, max: 100, value: round2(currentRsi), reason: `RSI ${round2(currentRsi)} < 35 — trend may be broken, not a pullback` }],
      eliminated: true,
      eliminationReason: `RSI ${round2(currentRsi)} < 35 — trend may be broken`
    };
  }

  const breakdown = [];
  let totalScore = 0;

  // ============================================
  // FACTOR 1: EMA20 Proximity (25 pts) - PRIMARY
  // The core pullback thesis: price at EMA20 support
  // ============================================
  let emaScore = 0;
  let emaReason = '';

  if (isNum(ema20) && isNum(currentPrice) && ema20 > 0) {
    const distancePct = Math.abs(currentPrice - ema20) / ema20 * 100;

    if (distancePct <= 0.5) {
      emaScore = 25;
      emaReason = `Textbook pullback (${round2(distancePct)}% from EMA20) — sitting right on support`;
    } else if (distancePct <= 1.0) {
      emaScore = 22;
      emaReason = `Very close to EMA20 (${round2(distancePct)}% away) — strong support zone`;
    } else if (distancePct <= 2.0) {
      emaScore = 18;
      emaReason = `Near EMA20 (${round2(distancePct)}% away) — within pullback range`;
    } else if (distancePct <= 3.0) {
      emaScore = 12;
      emaReason = `Approaching EMA20 (${round2(distancePct)}% away) — may not reach`;
    } else if (distancePct <= 5.0) {
      emaScore = 6;
      emaReason = `Far from EMA20 (${round2(distancePct)}% away) — extended`;
    } else {
      emaScore = 2;
      emaReason = `Too far from EMA20 (${round2(distancePct)}% away) — not a pullback`;
    }
  } else {
    emaScore = 5;
    emaReason = 'No EMA20 data available';
  }

  totalScore += emaScore;
  breakdown.push({ factor: 'EMA20 Proximity', points: emaScore, max: 25, reason: emaReason });

  // ============================================
  // FACTOR 2: Volume Decline Quality (20 pts) - INVERTED
  // Low volume = controlled profit-taking (good for pullback)
  // ============================================
  const volRatio = volume_vs_avg || (volume && volume_20avg ? volume / volume_20avg : null);

  let volumeScore = 0;
  let volumeReason = '';

  if (isNum(volRatio)) {
    if (volRatio <= 0.6) {
      volumeScore = 20;
      volumeReason = `Very low volume (${round2(volRatio)}x avg) — controlled pullback, no panic selling`;
    } else if (volRatio <= 0.7) {
      volumeScore = 18;
      volumeReason = `Low volume (${round2(volRatio)}x avg) — healthy profit-taking`;
    } else if (volRatio <= 0.8) {
      volumeScore = 16;
      volumeReason = `Below average volume (${round2(volRatio)}x avg) — normal pullback`;
    } else if (volRatio <= 0.9) {
      volumeScore = 13;
      volumeReason = `Slightly below avg (${round2(volRatio)}x avg) — acceptable`;
    } else if (volRatio <= 1.0) {
      volumeScore = 10;
      volumeReason = `Average volume (${round2(volRatio)}x avg) — neutral`;
    } else if (volRatio <= 1.3) {
      volumeScore = 5;
      volumeReason = `Above average (${round2(volRatio)}x avg) — some selling pressure`;
    } else {
      volumeScore = 0;
      volumeReason = `High volume decline (${round2(volRatio)}x avg) — possible distribution`;
    }
  } else {
    volumeScore = 8;
    volumeReason = 'No volume data available';
  }

  totalScore += volumeScore;
  breakdown.push({ factor: 'Volume Decline Quality', points: volumeScore, max: 20, reason: volumeReason });

  // ============================================
  // FACTOR 3: RSI Cooling (15 pts)
  // Pullback RSI should be cooled, not hot
  // ============================================
  let rsiScore = 0;
  let rsiReason = '';

  if (isNum(currentRsi)) {
    if (currentRsi >= 45 && currentRsi <= 52) {
      rsiScore = 15;
      rsiReason = `Ideal pullback zone (RSI ${round2(currentRsi)}) — cooled but not broken`;
    } else if (currentRsi > 52 && currentRsi <= 58) {
      rsiScore = 12;
      rsiReason = `Good cooldown (RSI ${round2(currentRsi)}) — still has room to bounce`;
    } else if (currentRsi >= 40 && currentRsi < 45) {
      rsiScore = 8;
      rsiReason = `Deep pullback (RSI ${round2(currentRsi)}) — watch for trend break`;
    } else if (currentRsi > 58 && currentRsi <= 65) {
      rsiScore = 6;
      rsiReason = `Not fully cooled (RSI ${round2(currentRsi)}) — pullback may continue`;
    } else if (currentRsi >= 35 && currentRsi < 40) {
      rsiScore = 4;
      rsiReason = `Very deep pullback (RSI ${round2(currentRsi)}) — risky`;
    } else {
      rsiScore = 2;
      rsiReason = `Outside pullback range (RSI ${round2(currentRsi)})`;
    }
  } else {
    rsiScore = 7;
    rsiReason = 'No RSI data available';
  }

  totalScore += rsiScore;
  breakdown.push({ factor: 'RSI Cooling', points: rsiScore, max: 15, reason: rsiReason, value: currentRsi ? round2(currentRsi) : 'N/A' });

  // ============================================
  // FACTOR 4: Trend Structure (15 pts)
  // EMA stack must be intact for pullback to be valid
  // ============================================
  let trendScore = 0;
  let trendReason = '';
  const trendParts = [];

  if (isNum(ema20) && isNum(ema50) && ema20 > ema50) {
    trendScore += 6;
    trendParts.push('EMA20 > EMA50');
  }
  if (isNum(ema50) && isNum(dma200) && ema50 > dma200) {
    trendScore += 5;
    trendParts.push('EMA50 > SMA200');
  }
  if (isNum(currentPrice) && isNum(dma200) && currentPrice > dma200) {
    trendScore += 4;
    trendParts.push('Price > SMA200');
  }

  if (trendParts.length === 3) {
    trendReason = `Full trend stack intact: ${trendParts.join(', ')}`;
  } else if (trendParts.length > 0) {
    trendReason = `Partial trend: ${trendParts.join(', ')}`;
  } else {
    trendReason = 'No trend structure data — EMA stack not confirmed';
    trendScore = 3;
  }

  totalScore += trendScore;
  breakdown.push({ factor: 'Trend Structure', points: trendScore, max: 15, reason: trendReason });

  // ============================================
  // FACTOR 5: Risk:Reward Ratio (15 pts) - recalibrated for pullback
  // ============================================
  let rrScore = 0;
  let rrReason = '';
  let rrValue = null;

  if (levels && levels.valid && isNum(levels.riskReward)) {
    rrValue = levels.riskReward;

    if (rrValue >= 2.5) {
      rrScore = 15;
      rrReason = `Excellent R:R (1:${round2(rrValue)}) — great pullback setup`;
    } else if (rrValue >= 2.0) {
      rrScore = 13;
      rrReason = `Very good R:R (1:${round2(rrValue)})`;
    } else if (rrValue >= 1.5) {
      rrScore = 10;
      rrReason = `Good R:R (1:${round2(rrValue)}) — solid for pullback`;
    } else if (rrValue >= 1.3) {
      rrScore = 6;
      rrReason = `Acceptable R:R (1:${round2(rrValue)}) — minimum for pullback`;
    } else if (rrValue >= 1.0) {
      rrScore = 3;
      rrReason = `Marginal R:R (1:${round2(rrValue)}) — tight but possible`;
    } else {
      rrScore = 0;
      rrReason = `Poor R:R (1:${round2(rrValue)}) — not recommended`;
    }
  } else if (levels && !levels.valid) {
    rrScore = 0;
    rrReason = `Levels invalid: ${levels.reason || 'unknown'}`;
  } else {
    rrScore = 7;
    rrReason = 'R:R not calculated (levels not provided)';
  }

  totalScore += rrScore;
  breakdown.push({ factor: 'Risk:Reward', points: rrScore, max: 15, reason: rrReason, value: rrValue ? `1:${round2(rrValue)}` : 'N/A' });

  // ============================================
  // FACTOR 6: Relative Strength vs Nifty (5 pts)
  // Outperformer pulling back = strong candidate
  // ============================================
  let rsScore = 0;
  let rsReason = '';

  if (isNum(return_1m) && isNum(niftyReturn1M)) {
    const outperformance = return_1m - niftyReturn1M;

    if (outperformance >= 8) {
      rsScore = 5;
      rsReason = `Strong outperformer pulling back (+${round2(outperformance)}% vs Nifty)`;
    } else if (outperformance >= 5) {
      rsScore = 4;
      rsReason = `Good outperformer (+${round2(outperformance)}% vs Nifty)`;
    } else if (outperformance >= 2) {
      rsScore = 3;
      rsReason = `Slight outperformer (+${round2(outperformance)}% vs Nifty)`;
    } else if (outperformance >= 0) {
      rsScore = 2;
      rsReason = `In line with Nifty (${round2(outperformance)}%)`;
    } else {
      rsScore = 0;
      rsReason = `Underperforming (${round2(outperformance)}% vs Nifty)`;
    }
  } else if (isNum(return_1m)) {
    if (return_1m >= 5) rsScore = 4;
    else if (return_1m >= 0) rsScore = 2;
    else rsScore = 0;
    rsReason = `1M return: ${round2(return_1m)}% (no Nifty comparison)`;
  } else {
    rsScore = 2;
    rsReason = 'No relative strength data';
  }

  totalScore += rsScore;
  breakdown.push({ factor: 'Relative Strength', points: rsScore, max: 5, reason: rsReason });

  // ============================================
  // FACTOR 7: ATR% Tradability (5 pts)
  // Ideal ATR% for swing: 1.5-3.5%
  // ============================================
  let atrScore = 0;
  let atrReason = '';

  const atrPct = atr_pct || (isNum(atr) && isNum(currentPrice) && currentPrice > 0 ? (atr / currentPrice) * 100 : null);

  if (isNum(atrPct)) {
    if (atrPct >= 1.5 && atrPct <= 3.5) {
      atrScore = 5;
      atrReason = `Ideal volatility (ATR ${round2(atrPct)}%) — good for swing`;
    } else if (atrPct >= 1.0 && atrPct < 1.5) {
      atrScore = 3;
      atrReason = `Low volatility (ATR ${round2(atrPct)}%) — moves may be small`;
    } else if (atrPct > 3.5 && atrPct <= 5.0) {
      atrScore = 3;
      atrReason = `High volatility (ATR ${round2(atrPct)}%) — wider stops needed`;
    } else {
      atrScore = 1;
      atrReason = `Extreme volatility (ATR ${round2(atrPct)}%) — risky`;
    }
  } else {
    atrScore = 2;
    atrReason = 'No ATR data available';
  }

  totalScore += atrScore;
  breakdown.push({ factor: 'ATR Tradability', points: atrScore, max: 5, reason: atrReason });

  // ============================================
  // FINAL RESULT
  // ============================================
  return {
    score: round2(totalScore),
    grade: getGrade(totalScore),
    breakdown: debug ? breakdown : undefined,
    eliminated: false,
    eliminationReason: null,
    levels_valid: levels?.valid || false,
    risk_reward: rrValue
  };
}

/**
 * Calculate Setup Score (Legacy Signature)
 *
 * Backward-compatible wrapper that accepts old signature.
 * Use calculateSetupScore(stock, levels, niftyReturn1M, debug) for new code.
 *
 * @param {Object} stock - Stock data with indicators
 * @param {number} niftyReturn1M - Nifty 1-month return for relative strength
 * @param {boolean} debug - Include detailed breakdown
 * @returns {Object} { score, grade, breakdown }
 */
export function calculateSetupScoreLegacy(stock, niftyReturn1M = 0, debug = false) {
  // Call new function without levels
  return calculateSetupScore(stock, null, niftyReturn1M, debug);
}

/**
 * Pick best candidate from Stage 2 candidates
 *
 * @param {Object} stage2Result - Result from candidates.generate()
 * @returns {Object} { best, ranked, reason }
 */
export function pickBestCandidate(stage2Result) {
  const { candidates, insufficientData } = stage2Result;

  if (insufficientData || !candidates || candidates.length === 0) {
    return {
      best: null,
      ranked: [],
      reason: 'No valid candidates available'
    };
  }

  // Filter for candidates with valid R:R
  const valid = candidates.filter(c => c.skeleton?.riskReward > 0);

  if (valid.length === 0) {
    return {
      best: null,
      ranked: [],
      reason: 'No candidates with positive R:R'
    };
  }

  // Prefer candidates with R:R >= 1.5 (hard gate)
  const goodRR = valid.filter(c => c.skeleton.riskReward >= 1.5);
  const pool = goodRR.length > 0 ? goodRR : valid;

  // Score each candidate
  const scored = pool.map(c => {
    const { rr, trend_align = 0.5, distance_pct = 0, scan_type_bonus = 0 } = c.score || {};

    const rawScore = round2(
      (rr * 0.55) +
      (trend_align * 0.35) -
      (Math.min(distance_pct, 5) * 0.10) +
      scan_type_bonus
    );

    console.log(`🔍 [SCORING] ${c.id}(${c.name}): RR=${rr}, trend=${trend_align}, dist=${distance_pct}, bonus=${scan_type_bonus} → score=${rawScore}`);

    return {
      ...c,
      totalScore: rawScore,
      rawScore
    };
  });

  // Sort by total score descending
  const ranked = scored.sort((a, b) => b.totalScore - a.totalScore);

  console.log(`🔍 [SCORING] Winner: ${ranked[0].id}(${ranked[0].name}) with score=${ranked[0].totalScore}`);

  return {
    best: ranked[0],
    ranked,
    reason: `Selected ${ranked[0].name} (score: ${ranked[0].totalScore})`
  };
}

/**
 * Calculate confidence score for a trade setup
 *
 * @param {Object} params
 * @param {Object} params.candidate - Selected candidate
 * @param {Object} params.indicators - Market indicators
 * @param {string} params.sentiment - Sentiment (BULLISH/BEARISH/NEUTRAL)
 * @param {number} params.sentimentConfidence - Sentiment confidence (0-1)
 * @returns {Object} { confidence, adjustments, breakdown }
 */
export function calculateConfidence({
  candidate,
  indicators,
  sentiment = 'NEUTRAL',
  sentimentConfidence = 0.5
}) {
  if (!candidate) {
    return { confidence: 0.3, adjustments: [], breakdown: 'No candidate' };
  }

  const { skeleton, score, rawScore } = candidate;
  const { type, riskReward } = skeleton || {};
  const { trend_align = 0.5 } = score || {};

  // Normalize rawScore to 0.50-0.85 range for base confidence
  const normalizedScore = rawScore ? 0.35 + (rawScore / 6) : 0.5;
  let baseConfidence = Math.min(0.85, Math.max(0.50, normalizedScore));

  const adjustments = [];

  // === NEGATIVE ADJUSTMENTS (max -0.40) ===
  const isBuySetup = type === 'BUY';
  const sentimentConflict = (isBuySetup && sentiment === 'BEARISH') ||
                            (!isBuySetup && sentiment === 'BULLISH');
  if (sentimentConflict) {
    adjustments.push({ factor: 'SENT_CONFLICT', adjustment: -0.08 });
  }

  const volatility = indicators?.atr_pct > 2 ? 'HIGH' : 'NORMAL';
  if (volatility === 'HIGH' && riskReward < 1.5) {
    adjustments.push({ factor: 'HIGH_VOL_LOW_RR', adjustment: -0.05 });
  }

  if (sentimentConfidence < 0.5) {
    adjustments.push({ factor: 'LOW_SENT_CONF', adjustment: -0.04 });
  }

  if (indicators?.volume_vs_avg < 0.8) {
    adjustments.push({ factor: 'LOW_VOLUME', adjustment: -0.03 });
  }

  if (riskReward < 1.0) {
    adjustments.push({ factor: 'POOR_RR', adjustment: -0.07 });
  }

  const distancePct = score?.distance_pct || 0;
  if (distancePct > 3) {
    adjustments.push({ factor: 'FAR_ENTRY', adjustment: -0.04 });
  }

  // === POSITIVE ADJUSTMENTS (max +0.18) ===
  const sentimentAligned = (isBuySetup && sentiment === 'BULLISH') ||
                           (!isBuySetup && sentiment === 'BEARISH');
  if (sentimentAligned && sentimentConfidence >= 0.7) {
    adjustments.push({ factor: 'SENT_ALIGNED', adjustment: +0.04 });
  }

  if (riskReward >= 2.0) {
    adjustments.push({ factor: 'STRONG_RR', adjustment: +0.04 });
  }

  if (indicators?.volume_vs_avg >= 1.3) {
    adjustments.push({ factor: 'HIGH_VOLUME', adjustment: +0.02 });
  }

  if (distancePct < 0.5) {
    adjustments.push({ factor: 'CLOSE_ENTRY', adjustment: +0.03 });
  }

  if (trend_align >= 0.9) {
    adjustments.push({ factor: 'TREND_ALIGNED', adjustment: +0.05 });
  }

  // Calculate final confidence
  const totalAdjustment = adjustments.reduce((sum, a) => sum + a.adjustment, 0);
  const finalConfidence = clamp(baseConfidence + totalAdjustment, 0.30, 0.95);

  return {
    confidence: round2(finalConfidence),
    confidencePercent: round2(finalConfidence * 100),
    baseConfidence: round2(baseConfidence),
    totalAdjustment: round2(totalAdjustment),
    adjustments
  };
}

/**
 * Rank stocks by setup quality (with levels)
 *
 * @param {Array} stocks - Array of stock data with indicators and levels
 * @param {number} niftyReturn1M - Nifty 1-month return
 * @returns {Array} Stocks sorted by score with grades
 */
export function rankStocks(stocks, niftyReturn1M = 0) {
  if (!Array.isArray(stocks)) return [];

  const scored = stocks.map(stock => {
    const { score, grade, breakdown, eliminated, eliminationReason } = calculateSetupScore(
      stock,
      stock.levels || null,
      niftyReturn1M,
      true
    );
    return {
      ...stock,
      setup_score: score,
      grade,
      score_breakdown: breakdown,
      eliminated,
      eliminationReason
    };
  });

  // Filter out eliminated stocks, then sort by score
  return scored
    .filter(s => !s.eliminated)
    .sort((a, b) => b.setup_score - a.setup_score);
}

export default {
  calculateSetupScore,
  calculateSetupScoreLegacy,
  pickBestCandidate,
  calculateConfidence,
  rankStocks,
  getGrade,
  GRADE_THRESHOLDS
};
