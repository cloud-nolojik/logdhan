/**
 * Scoring Module
 *
 * Single source of truth for:
 * - Setup Score (0-100 rating for swing trading quality)
 * - Candidate Ranking (picking best trade candidate)
 * - Confidence Calculation
 */

import { round2, isNum, clamp } from './helpers.js';

/**
 * Grade thresholds for setup scores
 */
const GRADE_THRESHOLDS = {
  A: 80,
  B: 65,
  C: 50,
  D: 35
  // Below 35 = F
};

/**
 * Get letter grade from numeric score
 */
export function getGrade(score) {
  if (score >= GRADE_THRESHOLDS.A) return 'A';
  if (score >= GRADE_THRESHOLDS.B) return 'B';
  if (score >= GRADE_THRESHOLDS.C) return 'C';
  if (score >= GRADE_THRESHOLDS.D) return 'D';
  return 'F';
}

/**
 * Calculate Setup Score for a stock
 *
 * Evaluates swing trading quality on 0-100 scale.
 *
 * @param {Object} stock - Stock data with indicators
 * @param {number} niftyReturn1M - Nifty 1-month return for relative strength
 * @param {boolean} debug - Include detailed breakdown
 * @returns {Object} { score, grade, breakdown }
 */
export function calculateSetupScore(stock, niftyReturn1M = 0, debug = false) {
  const {
    last,
    price,
    dma20,
    ema20,
    atr,
    atr_pct,
    rsi,
    volume,
    volume_20avg,
    volume_vs_avg,
    high_20d,
    return_1m,
    distance_from_20dma_pct
  } = stock;

  const currentPrice = last || price;
  const ma20 = ema20 || dma20;

  // Validate minimum required data
  if (!isNum(currentPrice) || !isNum(atr)) {
    return {
      score: 0,
      grade: 'F',
      breakdown: [{ factor: 'error', points: 0, reason: 'Missing price or ATR' }]
    };
  }

  const breakdown = [];
  let totalScore = 0;

  // 1. ATR% Volatility (max 20 points)
  // Sweet spot: 2-3.5% daily volatility
  const atrPercent = atr_pct || (atr / currentPrice * 100);
  let atrPoints = 0;
  let atrReason = '';

  if (atrPercent >= 2 && atrPercent <= 3.5) {
    atrPoints = 20;
    atrReason = `Ideal volatility (${round2(atrPercent)}%)`;
  } else if (atrPercent >= 1.5 && atrPercent < 2) {
    atrPoints = 12;
    atrReason = `Acceptable volatility (${round2(atrPercent)}%)`;
  } else if (atrPercent > 3.5 && atrPercent <= 5) {
    atrPoints = 8;
    atrReason = `High volatility (${round2(atrPercent)}%)`;
  } else if (atrPercent < 1.5) {
    atrPoints = 4;
    atrReason = `Low volatility (${round2(atrPercent)}%)`;
  } else {
    atrPoints = 0;
    atrReason = `Excessive volatility (${round2(atrPercent)}%)`;
  }
  totalScore += atrPoints;
  breakdown.push({ factor: 'ATR%', points: atrPoints, max: 20, reason: atrReason });

  // 2. Distance from 20 DMA (max 20 points)
  // Ideal: 0-3% above (momentum zone)
  let dmaPoints = 0;
  let dmaReason = '';

  if (isNum(ma20)) {
    const distancePct = distance_from_20dma_pct || ((currentPrice - ma20) / ma20 * 100);

    if (distancePct >= 0 && distancePct <= 3) {
      dmaPoints = 20;
      dmaReason = `Good entry zone (${round2(distancePct)}% from 20DMA)`;
    } else if (distancePct > 3 && distancePct <= 6) {
      dmaPoints = 12;
      dmaReason = `Acceptable (${round2(distancePct)}% from 20DMA)`;
    } else if (distancePct >= -2 && distancePct < 0) {
      dmaPoints = 15;
      dmaReason = `Pullback zone (${round2(distancePct)}% from 20DMA)`;
    } else if (distancePct > 6) {
      dmaPoints = 0;
      dmaReason = `Overextended (${round2(distancePct)}% from 20DMA)`;
    } else {
      dmaPoints = 5;
      dmaReason = `Below support (${round2(distancePct)}% from 20DMA)`;
    }
  } else {
    dmaReason = 'No 20DMA data';
  }
  totalScore += dmaPoints;
  breakdown.push({ factor: '20DMA Distance', points: dmaPoints, max: 20, reason: dmaReason });

  // 3. RSI Position (max 15 points)
  // Pullback-first strategy: favors neutral zone for pullback entries
  // While giving reasonable credit to momentum for breakouts
  let rsiPoints = 0;
  let rsiReason = '';

  if (isNum(rsi)) {
    if (rsi >= 40 && rsi <= 60) {
      // Best for pullback entries - neutral zone
      rsiPoints = 15;
      rsiReason = `Ideal pullback zone (RSI ${round2(rsi)})`;
    } else if (rsi > 60 && rsi <= 70) {
      // Good momentum for breakouts - slightly reward, don't penalize
      rsiPoints = 12;
      rsiReason = `Bullish momentum (RSI ${round2(rsi)})`;
    } else if (rsi >= 30 && rsi < 40) {
      // Oversold potential - caution for catching falling knives
      rsiPoints = 8;
      rsiReason = `Oversold bounce zone (RSI ${round2(rsi)})`;
    } else if (rsi > 70) {
      // Overbought - risky for new entries
      rsiPoints = 3;
      rsiReason = `Overbought caution (RSI ${round2(rsi)})`;
    } else if (rsi < 30) {
      // Very oversold - high risk
      rsiPoints = 3;
      rsiReason = `Very oversold - high risk (RSI ${round2(rsi)})`;
    } else {
      rsiPoints = 5;
      rsiReason = `RSI outside sweet spot (${round2(rsi)})`;
    }
  } else {
    rsiReason = 'No RSI data';
  }
  totalScore += rsiPoints;
  breakdown.push({ factor: 'RSI', points: rsiPoints, max: 15, reason: rsiReason });

  // 4. Volume Confirmation (max 15 points)
  // Above 1.3x average = strong confirmation
  let volPoints = 0;
  let volReason = '';

  const volRatio = volume_vs_avg || (volume && volume_20avg ? volume / volume_20avg : null);

  if (isNum(volRatio)) {
    if (volRatio >= 1.3) {
      volPoints = 15;
      volReason = `Strong volume (${round2(volRatio)}x average)`;
    } else if (volRatio >= 1.1) {
      volPoints = 10;
      volReason = `Above average (${round2(volRatio)}x)`;
    } else if (volRatio >= 0.8) {
      volPoints = 5;
      volReason = `Average volume (${round2(volRatio)}x)`;
    } else {
      volPoints = 0;
      volReason = `Low volume (${round2(volRatio)}x average)`;
    }
  } else {
    volReason = 'No volume data';
  }
  totalScore += volPoints;
  breakdown.push({ factor: 'Volume', points: volPoints, max: 15, reason: volReason });

  // 5. Breakout Proximity (max 20 points)
  // How close to 20-day high
  let breakoutPoints = 0;
  let breakoutReason = '';

  if (isNum(high_20d)) {
    const breakoutDist = ((high_20d - currentPrice) / currentPrice) * 100;

    if (breakoutDist >= 0 && breakoutDist <= 1) {
      breakoutPoints = 20;
      breakoutReason = `Near breakout (${round2(breakoutDist)}% from 20D high)`;
    } else if (breakoutDist > 1 && breakoutDist <= 2) {
      breakoutPoints = 15;
      breakoutReason = `Close to breakout (${round2(breakoutDist)}%)`;
    } else if (breakoutDist > 2 && breakoutDist <= 5) {
      breakoutPoints = 8;
      breakoutReason = `Approaching high (${round2(breakoutDist)}%)`;
    } else if (breakoutDist < 0) {
      breakoutPoints = 18;
      breakoutReason = `New high! (${round2(Math.abs(breakoutDist))}% above)`;
    } else {
      breakoutPoints = 0;
      breakoutReason = `Far from high (${round2(breakoutDist)}%)`;
    }
  } else {
    breakoutReason = 'No 20-day high data';
  }
  totalScore += breakoutPoints;
  breakdown.push({ factor: 'Breakout', points: breakoutPoints, max: 20, reason: breakoutReason });

  // 6. Relative Strength vs Nifty (max 10 points)
  let rsPoints = 0;
  let rsReason = '';

  if (isNum(return_1m) && isNum(niftyReturn1M)) {
    const outperformance = return_1m - niftyReturn1M;

    if (outperformance > 5) {
      rsPoints = 10;
      rsReason = `Strong outperformance (+${round2(outperformance)}% vs Nifty)`;
    } else if (outperformance > 0) {
      rsPoints = 6;
      rsReason = `Outperforming (+${round2(outperformance)}% vs Nifty)`;
    } else if (outperformance >= -5) {
      rsPoints = 3;
      rsReason = `In line with Nifty (${round2(outperformance)}%)`;
    } else {
      rsPoints = 0;
      rsReason = `Underperforming (${round2(outperformance)}% vs Nifty)`;
    }
  } else {
    rsReason = 'No relative strength data';
  }
  totalScore += rsPoints;
  breakdown.push({ factor: 'Rel Strength', points: rsPoints, max: 10, reason: rsReason });

  return {
    score: round2(totalScore),
    grade: getGrade(totalScore),
    breakdown: debug ? breakdown : undefined
  };
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
  // Formula: (RR * 0.55) + (trend_align * 0.35) - (min(distance_pct, 5) * 0.10) + scan_type_bonus
  const scored = pool.map(c => {
    const { rr, trend_align = 0.5, distance_pct = 0, scan_type_bonus = 0 } = c.score || {};

    const totalScore = round2(
      (rr * 0.55) +
      (trend_align * 0.35) -
      (Math.min(distance_pct, 5) * 0.10) +
      scan_type_bonus
    );

    return {
      ...c,
      totalScore
    };
  });

  // Sort by total score descending
  const ranked = scored.sort((a, b) => b.totalScore - a.totalScore);

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

  const { skeleton, score, totalScore } = candidate;
  const { type, riskReward } = skeleton || {};
  const { trend_align = 0.5 } = score || {};

  // Base confidence from candidate total score
  let baseConfidence = totalScore ? Math.min(totalScore, 1) : 0.5;

  const adjustments = [];

  // === NEGATIVE ADJUSTMENTS (max -0.40) ===

  // Sentiment conflict with strategy
  const isBuySetup = type === 'BUY';
  const sentimentConflict = (isBuySetup && sentiment === 'BEARISH') ||
                            (!isBuySetup && sentiment === 'BULLISH');
  if (sentimentConflict) {
    adjustments.push({ factor: 'SENT_CONFLICT', adjustment: -0.08 });
  }

  // High volatility + Low R:R
  const volatility = indicators?.atr_pct > 2 ? 'HIGH' : 'NORMAL';
  if (volatility === 'HIGH' && riskReward < 1.5) {
    adjustments.push({ factor: 'HIGH_VOL_LOW_RR', adjustment: -0.05 });
  }

  // Low sentiment confidence
  if (sentimentConfidence < 0.5) {
    adjustments.push({ factor: 'LOW_SENT_CONF', adjustment: -0.04 });
  }

  // Below average volume
  if (indicators?.volume_vs_avg < 0.8) {
    adjustments.push({ factor: 'LOW_VOLUME', adjustment: -0.03 });
  }

  // Poor R:R
  if (riskReward < 1.0) {
    adjustments.push({ factor: 'POOR_RR', adjustment: -0.07 });
  }

  // Price far from entry
  const distancePct = score?.distance_pct || 0;
  if (distancePct > 3) {
    adjustments.push({ factor: 'FAR_ENTRY', adjustment: -0.04 });
  }

  // === POSITIVE ADJUSTMENTS (max +0.18) ===

  // Sentiment aligned + high confidence
  const sentimentAligned = (isBuySetup && sentiment === 'BULLISH') ||
                           (!isBuySetup && sentiment === 'BEARISH');
  if (sentimentAligned && sentimentConfidence >= 0.7) {
    adjustments.push({ factor: 'SENT_ALIGNED', adjustment: +0.04 });
  }

  // Strong R:R
  if (riskReward >= 2.0) {
    adjustments.push({ factor: 'STRONG_RR', adjustment: +0.04 });
  }

  // Above average volume
  if (indicators?.volume_vs_avg >= 1.3) {
    adjustments.push({ factor: 'HIGH_VOLUME', adjustment: +0.02 });
  }

  // Price very close to entry
  if (distancePct < 0.5) {
    adjustments.push({ factor: 'CLOSE_ENTRY', adjustment: +0.03 });
  }

  // Strong trend alignment
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
 * Rank stocks by setup quality
 *
 * @param {Array} stocks - Array of stock data with indicators
 * @param {number} niftyReturn1M - Nifty 1-month return
 * @returns {Array} Stocks sorted by score with grades
 */
export function rankStocks(stocks, niftyReturn1M = 0) {
  if (!Array.isArray(stocks)) return [];

  const scored = stocks.map(stock => {
    const { score, grade, breakdown } = calculateSetupScore(stock, niftyReturn1M);
    return {
      ...stock,
      setup_score: score,
      grade,
      score_breakdown: breakdown
    };
  });

  return scored.sort((a, b) => b.setup_score - a.setup_score);
}

export default {
  calculateSetupScore,
  pickBestCandidate,
  calculateConfidence,
  rankStocks,
  getGrade,
  GRADE_THRESHOLDS
};
