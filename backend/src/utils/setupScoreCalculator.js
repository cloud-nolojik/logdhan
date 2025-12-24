/**
 * Setup Score Calculator
 *
 * Deterministic scoring for screening candidates.
 * Higher score = better swing trade candidate (0-100 scale)
 */

/**
 * Round to 2 decimal places
 * @param {number} x
 * @returns {number}
 */
function round2(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return x;
  return Math.round(x * 100) / 100;
}

/**
 * Get letter grade from score
 * @param {number} score
 * @returns {string}
 */
function getGrade(score) {
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}

/**
 * Calculate setup quality score (0-100)
 * @param {Object} stock - Stock data with indicators
 * @param {number} [niftyReturn1M=0] - Nifty 1-month return for relative strength
 * @param {boolean} [debug=false] - Enable debug logging
 * @returns {{ score: number, breakdown: Array, grade: string }}
 */
export function calculateSetupScore(stock, niftyReturn1M = 0, debug = false) {
  let score = 0;
  const breakdown = [];

  const {
    price,
    dma20,
    dma50,
    dma200,
    rsi,
    atr,
    volume,
    volume_20avg,
    high_20d,
    return_1m
  } = stock;

  if (debug) {
    console.log('[SCORE DEBUG] Input values:', {
      price, dma20, dma50, dma200, rsi, atr, volume, volume_20avg, high_20d, return_1m, niftyReturn1M
    });
  }

  // 1. ATR% - Volatility = Opportunity (max 20 points)
  if (atr && price) {
    const atrPct = (atr / price) * 100;
    if (atrPct >= 2 && atrPct <= 3.5) {
      score += 20;
      breakdown.push({ factor: "ATR%", points: 20, detail: `${atrPct.toFixed(1)}% (sweet spot)` });
    } else if (atrPct >= 1.5 && atrPct < 2) {
      score += 12;
      breakdown.push({ factor: "ATR%", points: 12, detail: `${atrPct.toFixed(1)}% (acceptable)` });
    } else if (atrPct > 3.5 && atrPct <= 5) {
      score += 8;
      breakdown.push({ factor: "ATR%", points: 8, detail: `${atrPct.toFixed(1)}% (high volatility)` });
    } else {
      breakdown.push({ factor: "ATR%", points: 0, detail: `${atrPct.toFixed(1)}% (outside range)` });
    }
  }

  // 2. Distance from 20 DMA - Not overextended (max 20 points)
  if (dma20 && price) {
    const distFrom20 = ((price - dma20) / dma20) * 100;
    if (distFrom20 >= 0 && distFrom20 <= 3) {
      score += 20;
      breakdown.push({ factor: "DMA20 Distance", points: 20, detail: `${distFrom20.toFixed(1)}% (ideal)` });
    } else if (distFrom20 > 3 && distFrom20 <= 6) {
      score += 12;
      breakdown.push({ factor: "DMA20 Distance", points: 12, detail: `${distFrom20.toFixed(1)}% (acceptable)` });
    } else if (distFrom20 > 6) {
      score += 0;
      breakdown.push({ factor: "DMA20 Distance", points: 0, detail: `${distFrom20.toFixed(1)}% (overextended)` });
    } else if (distFrom20 < 0 && distFrom20 >= -2) {
      score += 15;
      breakdown.push({ factor: "DMA20 Distance", points: 15, detail: `${distFrom20.toFixed(1)}% (pullback zone)` });
    } else {
      breakdown.push({ factor: "DMA20 Distance", points: 0, detail: `${distFrom20.toFixed(1)}% (too far below)` });
    }
  }

  // 3. RSI Position (max 15 points)
  if (rsi) {
    if (rsi >= 55 && rsi <= 65) {
      score += 15;
      breakdown.push({ factor: "RSI", points: 15, detail: `${rsi.toFixed(0)} (momentum zone)` });
    } else if (rsi >= 45 && rsi < 55) {
      score += 10;
      breakdown.push({ factor: "RSI", points: 10, detail: `${rsi.toFixed(0)} (neutral-bullish)` });
    } else if (rsi > 65 && rsi <= 70) {
      score += 8;
      breakdown.push({ factor: "RSI", points: 8, detail: `${rsi.toFixed(0)} (strong but extended)` });
    } else if (rsi > 70) {
      score += 0;
      breakdown.push({ factor: "RSI", points: 0, detail: `${rsi.toFixed(0)} (overbought)` });
    } else {
      score += 5;
      breakdown.push({ factor: "RSI", points: 5, detail: `${rsi.toFixed(0)} (weak momentum)` });
    }
  }

  // 4. Volume Confirmation (max 15 points)
  if (volume && volume_20avg) {
    const volRatio = volume / volume_20avg;
    if (volRatio >= 1.3) {
      score += 15;
      breakdown.push({ factor: "Volume", points: 15, detail: `${(volRatio * 100).toFixed(0)}% of avg (strong)` });
    } else if (volRatio >= 1.1) {
      score += 10;
      breakdown.push({ factor: "Volume", points: 10, detail: `${(volRatio * 100).toFixed(0)}% of avg (good)` });
    } else if (volRatio >= 0.8) {
      score += 5;
      breakdown.push({ factor: "Volume", points: 5, detail: `${(volRatio * 100).toFixed(0)}% of avg (normal)` });
    } else {
      score += 0;
      breakdown.push({ factor: "Volume", points: 0, detail: `${(volRatio * 100).toFixed(0)}% of avg (low)` });
    }
  }

  // 5. Near Breakout Level (max 20 points)
  if (high_20d && price) {
    const distToHigh = ((high_20d - price) / price) * 100;
    if (distToHigh <= 1 && distToHigh >= 0) {
      score += 20;
      breakdown.push({ factor: "Breakout Proximity", points: 20, detail: `${distToHigh.toFixed(1)}% from 20D high` });
    } else if (distToHigh <= 2) {
      score += 15;
      breakdown.push({ factor: "Breakout Proximity", points: 15, detail: `${distToHigh.toFixed(1)}% from 20D high` });
    } else if (distToHigh <= 5) {
      score += 8;
      breakdown.push({ factor: "Breakout Proximity", points: 8, detail: `${distToHigh.toFixed(1)}% from 20D high` });
    } else {
      breakdown.push({ factor: "Breakout Proximity", points: 0, detail: `${distToHigh.toFixed(1)}% from 20D high (far)` });
    }
  }

  // 6. Relative Strength vs Nifty (max 10 points)
  if (return_1m !== undefined && niftyReturn1M !== undefined) {
    const outperformance = return_1m - niftyReturn1M;
    if (outperformance > 5) {
      score += 10;
      breakdown.push({ factor: "Relative Strength", points: 10, detail: `+${outperformance.toFixed(1)}% vs Nifty` });
    } else if (outperformance > 0) {
      score += 6;
      breakdown.push({ factor: "Relative Strength", points: 6, detail: `+${outperformance.toFixed(1)}% vs Nifty` });
    } else {
      score += 0;
      breakdown.push({ factor: "Relative Strength", points: 0, detail: `${outperformance.toFixed(1)}% vs Nifty (underperforming)` });
    }
  }

  const finalScore = Math.min(score, 100);
  const grade = getGrade(finalScore);

  if (debug) {
    console.log('[SCORE DEBUG] Final:', { score: finalScore, grade, breakdown });
  }

  return {
    score: finalScore,
    breakdown,
    grade
  };
}

/**
 * Suggest entry zone based on technical levels
 * @param {Object} stock - Stock data
 * @returns {{ low: number, high: number, center: number, based_on: string } | null}
 */
export function suggestEntryZone(stock) {
  const { price, dma20, atr, support_1, pivot } = stock;

  if (!price || !atr) {
    return null;
  }

  // Entry zone logic:
  // - Ideal: near DMA20 or support
  // - Range: 0.5 ATR spread
  let zoneCenter = dma20 || price;
  let basedOn = "dma20";

  // If support is close and below current price, use that
  if (support_1 && support_1 < price && support_1 > price * 0.95) {
    zoneCenter = support_1;
    basedOn = "support";
  }

  // If pivot is between support and price, consider it
  if (pivot && pivot < price && pivot > (support_1 || price * 0.95)) {
    zoneCenter = pivot;
    basedOn = "pivot";
  }

  const halfSpread = atr * 0.25;

  return {
    low: round2(zoneCenter - halfSpread),
    high: round2(zoneCenter + halfSpread),
    center: round2(zoneCenter),
    based_on: basedOn
  };
}

/**
 * Determine if a stock is approaching its entry zone
 * @param {number} currentPrice
 * @param {{ low: number, high: number }} entryZone
 * @returns {{ inZone: boolean, approaching: boolean, distancePct: number, direction: string }}
 */
export function checkEntryZoneProximity(currentPrice, entryZone) {
  if (!currentPrice || !entryZone || !entryZone.low || !entryZone.high) {
    return { inZone: false, approaching: false, distancePct: null, direction: null };
  }

  const { low, high } = entryZone;

  // In zone
  if (currentPrice >= low && currentPrice <= high) {
    return {
      inZone: true,
      approaching: false,
      distancePct: 0,
      direction: "in_zone"
    };
  }

  // Above zone
  if (currentPrice > high) {
    const distancePct = ((currentPrice - high) / currentPrice) * 100;
    return {
      inZone: false,
      approaching: distancePct <= 2,
      distancePct: round2(distancePct),
      direction: "above"
    };
  }

  // Below zone
  const distancePct = ((low - currentPrice) / currentPrice) * 100;
  return {
    inZone: false,
    approaching: distancePct <= 2,
    distancePct: round2(distancePct),
    direction: "below"
  };
}

/**
 * Rank multiple stocks by setup score
 * @param {Array} stocks - Array of stock objects
 * @param {number} [niftyReturn1M=0]
 * @returns {Array} Sorted array with scores
 */
export function rankStocksBySetup(stocks, niftyReturn1M = 0) {
  return stocks
    .map(stock => ({
      ...stock,
      ...calculateSetupScore(stock, niftyReturn1M),
      entry_zone: suggestEntryZone(stock)
    }))
    .sort((a, b) => b.score - a.score);
}

export default {
  calculateSetupScore,
  suggestEntryZone,
  checkEntryZoneProximity,
  rankStocksBySetup
};
