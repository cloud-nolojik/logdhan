/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SCAN-SPECIFIC LEVEL CALCULATOR
 * Entry/Target/StopLoss based on ChartInk scan type
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Core Principle: The entry strategy should match WHY the stock was found.
 *
 * ChartInk Scan Types:
 * - breakout: Stock coiled near 20D high with volume surge
 * - pullback: Stock pulled back to EMA20 support
 * - momentum: Stock already running (3-10% above EMA20)
 * - consolidation_breakout: Stock in tight range near highs
 * - a_plus_momentum: FRESH 52-WEEK HIGH BREAKOUT with 1.5x volume + uptrend + 2%+ weekly gain
 */

import { round2, isNum } from './helpers.js';

/**
 * Round to nearest tick (0.05 for most Indian stocks)
 */
export function roundToTick(price, tick = 0.05) {
  if (!isNum(price)) return 0;
  return parseFloat((Math.round(price / tick) * tick).toFixed(2));
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PARTIAL BOOKING LEVEL (target1) - 50% profit booking
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Calculate partial profit booking level (target1)
 * Priority: weekly R1 → daily R1 → midpoint
 * Must be between entry (+ 2% buffer) and target (- 5% buffer)
 *
 * @param {number} entry - Entry price
 * @param {number} target - Main target price
 * @param {object} data - Contains weeklyR1, dailyR1 from enrichment
 * @returns {{ target1: number, target1Basis: string }}
 */
function calculatePartialBookingLevel(entry, target, data) {
  const { weeklyR1, dailyR1, dailyPivot, isIntraday } = data;
  const minLevel = entry * 1.02;   // At least 2% above entry
  const maxLevel = target * 0.95;  // At least 5% below main target

  if (isIntraday) {
    // Intraday: Daily Pivot → Midpoint
    // (Daily R1 is typically the main T2 target, so T1 must be below it)
    if (isNum(dailyPivot) && dailyPivot > minLevel && dailyPivot < maxLevel) {
      return { target1: roundToTick(dailyPivot), target1Basis: 'daily_pivot' };
    }
    const mid = entry + (target - entry) * 0.5;
    return { target1: roundToTick(mid), target1Basis: 'midpoint' };
  }

  // Swing: Weekly R1 → Daily R1 → Midpoint (unchanged)
  if (isNum(weeklyR1) && weeklyR1 > minLevel && weeklyR1 < maxLevel) {
    return { target1: roundToTick(weeklyR1), target1Basis: 'weekly_r1' };
  }

  if (isNum(dailyR1) && dailyR1 > minLevel && dailyR1 < maxLevel) {
    return { target1: roundToTick(dailyR1), target1Basis: 'daily_r1' };
  }

  const mid = entry + (target - entry) * 0.5;
  return { target1: roundToTick(mid), target1Basis: 'midpoint' };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TIME RULES - Entry confirmation and timing rules by scan type
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Get time-based trading rules for a scan type.
 * These control how the trade simulation processes entries and exits.
 *
 * @param {string} archetype - '52w_breakout', 'trend-follow', 'pullback', etc.
 * @param {string} entryType - 'buy_above' or 'limit'
 * @returns {object} Time rules for simulation
 */
function getTimeRules(archetype, entryType) {
  // 52W Breakout — needs close confirmation, patient entry
  if (archetype === '52w_breakout') {
    return {
      entryConfirmation: 'close_above',  // Daily close must be >= entry
      entryWindowDays: 3,                // Mon-Wed to trigger entry
      maxHoldDays: 5,                    // Full trading week
      weekEndRule: 'trail_or_exit',      // Tighten stop on Friday if still holding
      t1BookingPct: 50,                  // Always book 50% at T1
      postT1Stop: 'move_to_entry'        // Stop moves to entry after T1 hit
    };
  }

  // Momentum / Breakout — close confirmation, shorter entry window
  if (entryType === 'buy_above') {
    return {
      entryConfirmation: 'close_above',
      entryWindowDays: 2,                // Mon-Tue only (momentum fades fast)
      maxHoldDays: 5,
      weekEndRule: 'exit_if_no_t1',      // If T1 not hit by Friday, exit at close
      t1BookingPct: 50,
      postT1Stop: 'move_to_entry'
    };
  }

  // Pullback — limit order fills on touch, more patient
  if (entryType === 'limit') {
    return {
      entryConfirmation: 'touch',        // Low touching entry = limit fill
      entryWindowDays: 4,                // Mon-Thu (pullbacks need patience)
      maxHoldDays: 5,
      weekEndRule: 'hold_if_above_entry', // Keep if above entry, exit if below
      t1BookingPct: 50,
      postT1Stop: 'move_to_entry'
    };
  }

  // Default fallback
  return {
    entryConfirmation: 'close_above',
    entryWindowDays: 3,
    maxHoldDays: 5,
    weekEndRule: 'exit_if_no_t1',
    t1BookingPct: 50,
    postT1Stop: 'move_to_entry'
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STRUCTURAL LADDER - Target Selection
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Instead of falling back to arbitrary ATR targets, we climb a structural ladder:
 *
 * | Priority | Level               | Source          | Min R:R | When                          |
 * |----------|---------------------|-----------------|---------|-------------------------------|
 * | 0        | ATR Extension (2.5) | ATR-based       | 1.5:1   | ONLY when entry ≥ 52W high    |
 * | 1        | Weekly R1           | Pivot formula   | 1.5:1   | Standard overhead resistance  |
 * | 2        | Weekly R2           | Pivot formula   | 1.5:1   | If R1 too close               |
 * | 3        | 52W High            | Historical      | 1.5:1   | If entry below 52W high       |
 * | 4        | REJECT              | —               | —       | No viable target              |
 *
 * Level 0 exists because stocks at NEW 52-week highs have NO overhead resistance.
 * The a_plus_momentum scan finds stocks that just broke their 252-day high,
 * so high52W ≈ prevHigh ≈ entry, making Level 3 dead code for those stocks.
 * ATR extension targets are well-proven for breakout continuation trades.
 *
 * Inside Level 0, we still check Weekly R1/R2 first — if pivots happen to be
 * above entry (possible if calculated from a strong intraweek move), prefer
 * the structural level over the ATR extension.
 *
 * Each level is where institutional profit-taking naturally occurs.
 * If none give adequate R:R → the setup is NOT viable for swing trading.
 *
 * @param {Object} params - { entry, risk, weeklyR1, weeklyR2, high52W, atr, minRR }
 * @returns {Object} { target2, target3, target2_basis, reason } or { rejected: true, reason }
 */
function findStructuralTarget(params) {
  const { entry, risk, weeklyR1, weeklyR2, high52W, atr, minRR = 1.5 } = params;

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD: Invalid risk (stop >= entry)
  // ─────────────────────────────────────────────────────────────────────────
  if (!isNum(risk) || risk <= 0) {
    return { rejected: true, reason: 'Invalid risk (stop >= entry)', noData: false };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD: No structural data available (all pivots null AND no ATR)
  // ─────────────────────────────────────────────────────────────────────────
  const hasAnyLevel = isNum(weeklyR1) || isNum(weeklyR2) || isNum(high52W);
  const hasATR = isNum(atr) && atr > 0;
  if (!hasAnyLevel && !hasATR) {
    return {
      rejected: true,
      reason: 'No structural data available (pivot/52W data missing, no ATR)',
      noData: true
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEVEL 0: ATR Extension — for stocks AT or ABOVE their 52-week high
  // ─────────────────────────────────────────────────────────────────────────
  // When a stock just broke its 52W high (a_plus_momentum scan), there is
  // NO overhead resistance. The 52W high IS today's price, so Level 3
  // (high52W > entry) is always false. Use ATR-based extension instead.
  //
  // Threshold: entry >= high52W * 0.995 (within 0.5% of 52W high)
  // This catches stocks that broke their high even if high_52w is slightly
  // above entry due to intraday wick on the breakout day.
  //
  // Priority within Level 0:
  //   1. Weekly R1 (if above entry with good R:R) — structural always preferred
  //   2. Weekly R2 (if R1 doesn't work)
  //   3. ATR extension (2.5 ATR for T1, 4.0 ATR for T2/trail)
  // ─────────────────────────────────────────────────────────────────────────
  if (hasATR && isNum(high52W) && entry >= high52W * 0.995) {
    // Stock is at or within 0.5% of 52W high — treat as breakout-to-new-highs
    const extensionTarget = entry + (2.5 * atr);
    const extensionRR = (extensionTarget - entry) / risk;

    if (extensionRR >= minRR) {
      // Still prefer Weekly R1/R2 if they're above entry (rare but possible)
      if (isNum(weeklyR1) && weeklyR1 > entry) {
        const rrR1 = (weeklyR1 - entry) / risk;
        if (rrR1 >= minRR) {
          return {
            target2: weeklyR1,
            target3: isNum(weeklyR2) && weeklyR2 > weeklyR1 ? weeklyR2 :
                     roundToTick(entry + (4.0 * atr)),
            target2_basis: 'weekly_r1',
            reason: `52W breakout but Weekly R1 (${round2(weeklyR1)}) still overhead, R:R ${round2(rrR1)}:1`
          };
        }
      }
      if (isNum(weeklyR2) && weeklyR2 > entry) {
        const rrR2 = (weeklyR2 - entry) / risk;
        if (rrR2 >= minRR) {
          return {
            target2: weeklyR2,
            target3: roundToTick(entry + (4.0 * atr)),
            target2_basis: 'weekly_r2',
            reason: `52W breakout, Weekly R2 (${round2(weeklyR2)}) is the target, R:R ${round2(rrR2)}:1`
          };
        }
      }

      // No weekly pivots work — use ATR extension
      return {
        target2: roundToTick(extensionTarget),
        target3: roundToTick(entry + (4.0 * atr)),
        target2_basis: 'atr_extension_52w_breakout',
        reason: `52W HIGH BREAKOUT: No overhead resistance. ` +
                `T2 at 2.5 ATR (${round2(extensionTarget)}), R:R ${round2(extensionRR)}:1`
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEVEL 1: Weekly R1 - Primary institutional profit-taking zone
  // ─────────────────────────────────────────────────────────────────────────
  if (isNum(weeklyR1) && weeklyR1 > entry) {
    const rr = (weeklyR1 - entry) / risk;
    if (rr >= minRR) {
      return {
        target2: weeklyR1,
        target3: isNum(weeklyR2) && weeklyR2 > weeklyR1 ? weeklyR2 : null,
        target2_basis: 'weekly_r1',
        reason: `T2 at Weekly R1 (${round2(weeklyR1)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEVEL 2: Weekly R2 - Secondary resistance (bigger move required)
  // ─────────────────────────────────────────────────────────────────────────
  if (isNum(weeklyR2) && weeklyR2 > entry) {
    const rr = (weeklyR2 - entry) / risk;
    if (rr >= minRR) {
      return {
        target2: weeklyR2,
        target3: null,
        target2_basis: 'weekly_r2',
        reason: `Weekly R1 too close, T2 at Weekly R2 (${round2(weeklyR2)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEVEL 3: 52-Week High - Historical resistance (last resort)
  // ─────────────────────────────────────────────────────────────────────────
  if (isNum(high52W) && high52W > entry) {
    const rr = (high52W - entry) / risk;
    if (rr >= minRR) {
      return {
        target2: high52W,
        target3: null,
        target2_basis: '52w_high',
        reason: `Pivots too close, T2 at 52W High (${round2(high52W)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEVEL 4: REJECT - No structural target gives adequate R:R
  // ─────────────────────────────────────────────────────────────────────────
  return {
    rejected: true,
    noData: false,  // Data exists, but R:R is insufficient
    reason: `No structural target gives min ${minRR}:1 R:R. ` +
            `Weekly R1=${round2(weeklyR1) || 'N/A'}, R2=${round2(weeklyR2) || 'N/A'}, ` +
            `52W High=${round2(high52W) || 'N/A'}, Entry=${round2(entry)}, Risk=${round2(risk)}`
  };
}

/**
 * Structural ladder for pullback (uses Daily R1/R2 first, then weekly)
 * Pullbacks are shorter-term trades, so daily pivots are more relevant
 */
function findPullbackTarget(params) {
  const { entry, risk, dailyR1, dailyR2, weeklyR1, weeklyR2, high52W, minRR = 1.2 } = params;

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD: Invalid risk (stop >= entry)
  // ─────────────────────────────────────────────────────────────────────────
  if (!isNum(risk) || risk <= 0) {
    return { rejected: true, reason: 'Invalid risk (stop >= entry)', noData: false };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD: No structural data available (all pivots null)
  // ─────────────────────────────────────────────────────────────────────────
  const hasAnyLevel = isNum(dailyR1) || isNum(dailyR2) || isNum(weeklyR1) || isNum(weeklyR2) || isNum(high52W);
  if (!hasAnyLevel) {
    return {
      rejected: true,
      reason: 'No structural data available (pivot/52W data missing)',
      noData: true
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEVEL 1: Daily R1 - First profit-taking zone for pullback
  // ─────────────────────────────────────────────────────────────────────────
  if (isNum(dailyR1) && dailyR1 > entry) {
    const rr = (dailyR1 - entry) / risk;
    if (rr >= minRR) {
      return {
        target2: dailyR1,
        target3: isNum(weeklyR1) && weeklyR1 > dailyR1 ? weeklyR1 : null,
        target2_basis: 'daily_r1',
        reason: `T2 at Daily R1 (${round2(dailyR1)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEVEL 2: Daily R2 - Secondary daily resistance
  // ─────────────────────────────────────────────────────────────────────────
  if (isNum(dailyR2) && dailyR2 > entry) {
    const rr = (dailyR2 - entry) / risk;
    if (rr >= minRR) {
      return {
        target2: dailyR2,
        target3: isNum(weeklyR1) && weeklyR1 > dailyR2 ? weeklyR1 : null,
        target2_basis: 'daily_r2',
        reason: `Daily R1 too close, T2 at Daily R2 (${round2(dailyR2)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEVEL 3: Weekly R1 - Bigger move if daily pivots too close
  // ─────────────────────────────────────────────────────────────────────────
  if (isNum(weeklyR1) && weeklyR1 > entry) {
    const rr = (weeklyR1 - entry) / risk;
    if (rr >= minRR) {
      return {
        target2: weeklyR1,
        target3: isNum(weeklyR2) && weeklyR2 > weeklyR1 ? weeklyR2 : null,
        target2_basis: 'weekly_r1',
        reason: `Daily pivots too close, T2 at Weekly R1 (${round2(weeklyR1)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEVEL 4: Weekly R2 - Last weekly level
  // ─────────────────────────────────────────────────────────────────────────
  if (isNum(weeklyR2) && weeklyR2 > entry) {
    const rr = (weeklyR2 - entry) / risk;
    if (rr >= minRR) {
      return {
        target2: weeklyR2,
        target3: null,
        target2_basis: 'weekly_r2',
        reason: `Weekly R1 too close, T2 at Weekly R2 (${round2(weeklyR2)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEVEL 5: 52W High - Historical resistance (last resort)
  // ─────────────────────────────────────────────────────────────────────────
  if (isNum(high52W) && high52W > entry) {
    const rr = (high52W - entry) / risk;
    if (rr >= minRR) {
      return {
        target2: high52W,
        target3: null,
        target2_basis: '52w_high',
        reason: `All pivots too close, T2 at 52W High (${round2(high52W)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LEVEL 6: REJECT - No structural target gives adequate R:R
  // ─────────────────────────────────────────────────────────────────────────
  return {
    rejected: true,
    noData: false,  // Data exists, but R:R is insufficient
    reason: `No structural target gives min ${minRR}:1 R:R for pullback. ` +
            `Daily R1=${round2(dailyR1) || 'N/A'}, Weekly R1=${round2(weeklyR1) || 'N/A'}`
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DAILY (INTRADAY) STRUCTURAL LADDER — LONG Target Selection
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * For intraday MIS trades that must exit by 3 PM, weekly pivots are
 * unreachable (~5% away). Daily pivots provide actionable targets:
 *
 * | Priority | Level              | Typical Distance | Daily Hit Rate |
 * |----------|--------------------|------------------|----------------|
 * | 1        | Daily R1           | ~2.3%            | ~50%           |
 * | 2        | Daily R2           | ~4.6%            | ~20%           |
 * | 3        | Previous Day High  | varies           | fallback       |
 * | 4        | REJECT / null      | —                | —              |
 *
 * Returns null when ALL daily data is missing (API failure) — caller should
 * fall back to findStructuralTarget() with weekly pivots as degraded mode.
 * Returns { rejected: true } when data exists but no level gives adequate R:R.
 *
 * @param {Object} params - { entry, risk, dailyR1, dailyR2, previousDayHigh, minRR }
 * @returns {Object|null} { target2, target3, target2_basis, reason } or { rejected } or null
 */
function findDailyLongTarget(params) {
  const { entry, risk, dailyR1, dailyR2, previousDayHigh, minRR = 1.2 } = params;

  // GUARD: Invalid risk (stop >= entry)
  if (!isNum(risk) || risk <= 0) {
    return { rejected: true, reason: 'Invalid risk (stop >= entry)', noData: false };
  }

  // GUARD: All daily data missing → return null to signal fallback to weekly
  const hasAnyLevel = isNum(dailyR1) || isNum(dailyR2) || isNum(previousDayHigh);
  if (!hasAnyLevel) {
    return null;
  }

  // LEVEL 1: Daily R1 — primary intraday target (~2.3% from pivot, hit ~50% of days)
  if (isNum(dailyR1) && dailyR1 > entry) {
    const rr = (dailyR1 - entry) / risk;
    if (rr >= minRR) {
      return {
        target2: dailyR1,
        target3: isNum(dailyR2) && dailyR2 > dailyR1 ? dailyR2 : null,
        target2_basis: 'daily_r1',
        reason: `Intraday T2 at Daily R1 (${round2(dailyR1)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // LEVEL 2: Daily R2 — secondary intraday target (~4.6%, hit ~20% of days)
  if (isNum(dailyR2) && dailyR2 > entry) {
    const rr = (dailyR2 - entry) / risk;
    if (rr >= minRR) {
      return {
        target2: dailyR2,
        target3: null,
        target2_basis: 'daily_r2',
        reason: `Daily R1 too close, Intraday T2 at Daily R2 (${round2(dailyR2)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // LEVEL 3: Previous Day High — fallback structural level
  if (isNum(previousDayHigh) && previousDayHigh > entry) {
    const rr = (previousDayHigh - entry) / risk;
    if (rr >= minRR) {
      return {
        target2: previousDayHigh,
        target3: null,
        target2_basis: 'previous_day_high',
        reason: `Daily pivots too close, Intraday T2 at Prev Day High (${round2(previousDayHigh)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // LEVEL 4: REJECT — no intraday target gives adequate R:R
  return {
    rejected: true,
    noData: false,
    reason: `No intraday target gives min ${minRR}:1 R:R. ` +
            `Daily R1=${round2(dailyR1) || 'N/A'}, R2=${round2(dailyR2) || 'N/A'}, ` +
            `Prev Day High=${round2(previousDayHigh) || 'N/A'}, Entry=${round2(entry)}, Risk=${round2(risk)}`
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DAILY (INTRADAY) STRUCTURAL LADDER — SHORT Target Selection
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Mirror of findDailyLongTarget for SHORT/bearish intraday trades.
 *
 * | Priority | Level              | Typical Distance | Daily Hit Rate |
 * |----------|--------------------|------------------|----------------|
 * | 1        | Daily S1           | ~2.3%            | ~50%           |
 * | 2        | Daily S2           | ~4.6%            | ~20%           |
 * | 3        | Previous Day Low   | varies           | fallback       |
 * | 4        | REJECT / null      | —                | —              |
 *
 * Returns null when ALL daily data is missing — caller falls back to weekly.
 *
 * @param {Object} params - { entry, risk, dailyS1, dailyS2, previousDayLow, minRR }
 * @returns {Object|null} { target2, target3, target2_basis, reason } or { rejected } or null
 */
function findDailyShortTarget(params) {
  const { entry, risk, dailyS1, dailyS2, previousDayLow, minRR = 1.2 } = params;

  // GUARD: Invalid risk (stop <= entry for shorts)
  if (!isNum(risk) || risk <= 0) {
    return { rejected: true, reason: 'Invalid risk (stop <= entry)', noData: false };
  }

  // GUARD: All daily data missing → return null to signal fallback to weekly
  const hasAnyLevel = isNum(dailyS1) || isNum(dailyS2) || isNum(previousDayLow);
  if (!hasAnyLevel) {
    return null;
  }

  // LEVEL 1: Daily S1 — primary intraday short target
  if (isNum(dailyS1) && dailyS1 < entry) {
    const rr = (entry - dailyS1) / risk;
    if (rr >= minRR) {
      return {
        target2: dailyS1,
        target3: isNum(dailyS2) && dailyS2 < dailyS1 ? dailyS2 : null,
        target2_basis: 'daily_s1',
        reason: `Intraday Short to Daily S1 (${round2(dailyS1)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // LEVEL 2: Daily S2 — secondary intraday short target
  if (isNum(dailyS2) && dailyS2 < entry) {
    const rr = (entry - dailyS2) / risk;
    if (rr >= minRR) {
      return {
        target2: dailyS2,
        target3: null,
        target2_basis: 'daily_s2',
        reason: `Daily S1 too close, Intraday Short to Daily S2 (${round2(dailyS2)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // LEVEL 3: Previous Day Low — fallback structural support
  if (isNum(previousDayLow) && previousDayLow < entry) {
    const rr = (entry - previousDayLow) / risk;
    if (rr >= minRR) {
      return {
        target2: previousDayLow,
        target3: null,
        target2_basis: 'previous_day_low',
        reason: `Daily pivots too close, Intraday Short to Prev Day Low (${round2(previousDayLow)}), R:R ${round2(rr)}:1`
      };
    }
  }

  // LEVEL 4: REJECT — no intraday short target gives adequate R:R
  return {
    rejected: true,
    noData: false,
    reason: `No intraday short target gives min ${minRR}:1 R:R. ` +
            `Daily S1=${round2(dailyS1) || 'N/A'}, S2=${round2(dailyS2) || 'N/A'}, ` +
            `Prev Day Low=${round2(previousDayLow) || 'N/A'}, Entry=${round2(entry)}, Risk=${round2(risk)}`
  };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 1H SWING-BASED TARGET FINDER (for intraday daily picks)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Replaces daily pivot targets (R1/S1) with real 1H swing structure.
 * Looks for nearest resistance/support zone within 5% of entry.
 *
 * LONG: target = nearest resistanceZone midpoint above entry (within 5%)
 * SHORT: target = nearest supportZone midpoint below entry (within 5%)
 *
 * @param {Object} params - { entry, risk, resistanceZones, supportZones, isShort, minRR }
 * @returns {Object} { target2, target2_basis, reason } or { rejected: true, reason }
 */
function find1HSwingTarget(params) {
  const { entry, risk, resistanceZones = [], supportZones = [], isShort = false, minRR = 1.2 } = params;

  if (!isNum(risk) || risk <= 0) {
    return { rejected: true, reason: 'Invalid risk', noData: false };
  }

  if (isShort) {
    // SHORT: find nearest support zone midpoint below entry, within 5%
    const zone = supportZones.find(z => z.midpoint < entry && z.midpoint >= entry * 0.95);
    if (zone) {
      const rr = (entry - zone.midpoint) / risk;
      if (rr >= minRR) {
        return {
          target2: zone.midpoint,
          target3: null,
          target2_basis: '1h_swing_support',
          reason: `1H swing support at ${round2(zone.midpoint)}, R:R ${round2(rr)}:1`
        };
      }
      return {
        rejected: true,
        noData: false,
        reason: `1H swing support at ${round2(zone.midpoint)} too close, R:R ${round2((entry - zone.midpoint) / risk)}:1 < ${minRR}:1`
      };
    }
    return {
      rejected: true,
      noData: supportZones.length === 0,
      reason: `No 1H structural target found (no support zone within 5% below entry ${round2(entry)})`
    };
  } else {
    // LONG: find nearest resistance zone midpoint above entry, within 5%
    const zone = resistanceZones.find(z => z.midpoint > entry && z.midpoint <= entry * 1.05);
    if (zone) {
      const rr = (zone.midpoint - entry) / risk;
      if (rr >= minRR) {
        return {
          target2: zone.midpoint,
          target3: null,
          target2_basis: '1h_swing_resistance',
          reason: `1H swing resistance at ${round2(zone.midpoint)}, R:R ${round2(rr)}:1`
        };
      }
      return {
        rejected: true,
        noData: false,
        reason: `1H swing resistance at ${round2(zone.midpoint)} too close, R:R ${round2((zone.midpoint - entry) / risk)}:1 < ${minRR}:1`
      };
    }
    return {
      rejected: true,
      noData: resistanceZones.length === 0,
      reason: `No 1H structural target found (no resistance zone within 5% above entry ${round2(entry)})`
    };
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MAIN FUNCTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * @param {string} scanType - 'breakout' | 'pullback' | 'momentum' | 'consolidation_breakout'
 * @param {object} data - Required market data
 * @returns {object} Trading levels with validation
 */
export function calculateTradingLevels(scanType, data) {
  console.log(`🔍 [SCAN_LEVELS] calculateTradingLevels called with scanType="${scanType}"`);

  // ─────────────────────────────────────────────────────────────────────────
  // VALIDATE REQUIRED DATA
  // ─────────────────────────────────────────────────────────────────────────
  const validation = validateData(data);
  if (!validation.valid) {
    console.log(`🔍 [SCAN_LEVELS] Validation FAILED: ${validation.reason}`);
    return validation;
  }
  console.log(`🔍 [SCAN_LEVELS] Validation passed`);

  const { atr } = data;

  let result;

  console.log(`🔍 [SCAN_LEVELS] Switching on scanType: "${scanType?.toLowerCase()}"`);
  switch (scanType?.toLowerCase()) {
    case 'breakout':
      console.log(`🔍 [SCAN_LEVELS] Calling calculateBreakoutLevels`);
      result = calculateBreakoutLevels(data);
      break;

    case 'pullback':
      console.log(`🔍 [SCAN_LEVELS] Calling calculatePullbackLevels`);
      result = calculatePullbackLevels(data);
      break;

    case 'momentum':
    case 'momentum_carry':  // Alias for daily picks
      console.log(`🔍 [SCAN_LEVELS] Calling calculateMomentumLevels`);
      result = calculateMomentumLevels(data);
      break;

    case 'consolidation_breakout':
      console.log(`🔍 [SCAN_LEVELS] Calling calculateConsolidationLevels`);
      result = calculateConsolidationLevels(data);
      break;

    case 'a_plus_momentum':
      // A+ Momentum: Uptrend + 3% weekly gain + near 20d high
      // Similar to momentum but with stronger confirmation (near highs)
      console.log(`🔍 [SCAN_LEVELS] Calling calculateAPlusMomentumLevels`);
      result = calculateAPlusMomentumLevels(data);
      break;

    // ═══════════════════════════════════════════════════════════════════════════
    // SHORT/BEARISH SCAN TYPES
    // ═══════════════════════════════════════════════════════════════════════════

    case 'breakdown_setup':
      console.log(`🔍 [SCAN_LEVELS] Calling calculateBreakdownLevels`);
      result = calculateBreakdownLevels(data);
      break;

    case 'momentum_carry_bearish':
      console.log(`🔍 [SCAN_LEVELS] Calling calculateMomentumBearishLevels`);
      result = calculateMomentumBearishLevels(data);
      break;

    case 'failed_at_resistance':
      console.log(`🔍 [SCAN_LEVELS] Calling calculateFailedResistanceLevels`);
      result = calculateFailedResistanceLevels(data);
      break;

    case 'compression_bearish':
      console.log(`🔍 [SCAN_LEVELS] Calling calculateCompressionBearishLevels`);
      result = calculateCompressionBearishLevels(data);
      break;

    default:
      console.log(`🔍 [SCAN_LEVELS] Unknown scan type: "${scanType}"`);
      return {
        valid: false,
        reason: `Unknown scan type: ${scanType}`
      };
  }

  console.log(`🔍 [SCAN_LEVELS] Result from calculation:`, JSON.stringify(result));

  if (!result.valid) {
    console.log(`🔍 [SCAN_LEVELS] Calculation returned invalid: ${result.reason}`);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // APPLY GUARDRAILS
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`🔍 [SCAN_LEVELS] Applying guardrails...`);
  const guarded = applyGuardrails(result.entry, result.stop, result.target, atr, scanType);
  console.log(`🔍 [SCAN_LEVELS] Guardrails result:`, JSON.stringify(guarded));

  if (!guarded.valid) {
    return {
      ...guarded,
      scanType,
      mode: result.mode,
      reason: guarded.reason,
      originalReason: result.reason
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CALCULATE TARGET1 (partial booking level)
  // ─────────────────────────────────────────────────────────────────────────
  const { target1, target1Basis } = calculatePartialBookingLevel(
    roundToTick(guarded.entry),
    roundToTick(guarded.target),
    data
  );

  // ─────────────────────────────────────────────────────────────────────────
  // GET TIME RULES (entry confirmation, windows, week-end rules)
  // ─────────────────────────────────────────────────────────────────────────
  const timeRules = getTimeRules(result.archetype, result.entryType);

  return {
    valid: true,
    scanType,
    mode: result.mode,
    entry: roundToTick(guarded.entry),
    entry_basis: result.entry_basis || null,
    entryRange: result.entryRange ? [roundToTick(result.entryRange[0]), roundToTick(result.entryRange[1])] : null,
    stop: roundToTick(guarded.stop),
    // ── Targets (consistent naming: target1, target2, target3) ──
    target1,                                                                // T1: Partial booking level (50%)
    target1_basis: target1Basis,                                            // 'weekly_r1', 'daily_r1', or 'midpoint'
    target2: roundToTick(guarded.target),                                   // T2: Main target (full exit or trail)
    target2_basis: result.target2_basis,                                    // 'weekly_r1', 'weekly_r2', 'daily_r1', 'daily_r2', '52w_high', or 'atr_extension_52w_breakout'
    target3: result.target3 ? roundToTick(result.target3) : null,           // T3: Extension target (optional, for trailing)
    dailyR1Check: result.dailyR1Check ? roundToTick(result.dailyR1Check) : null,  // Momentum checkpoint (backward compat)
    // ── Entry/Exit Rules ──
    entryType: result.entryType,
    archetype: result.archetype,
    reason: result.reason,
    // ── Risk/Reward ──
    riskReward: parseFloat(guarded.riskReward),
    riskPercent: parseFloat(guarded.riskPercent),
    rewardPercent: parseFloat(guarded.rewardPercent),
    adjustments: guarded.adjustments,
    // ── Time Rules ──
    entryConfirmation: timeRules.entryConfirmation,
    entryWindowDays: timeRules.entryWindowDays,
    maxHoldDays: timeRules.maxHoldDays,
    weekEndRule: timeRules.weekEndRule,
    t1BookingPct: timeRules.t1BookingPct,
    postT1Stop: timeRules.postT1Stop
  };
}

/**
 * Validate required data points
 */
function validateData(data) {
  if (!data) {
    return { valid: false, reason: 'No data provided' };
  }

  const { atr, ema20, prevClose } = data;

  if (!isNum(atr) || atr <= 0) {
    return { valid: false, reason: 'ATR missing or invalid' };
  }

  if (!isNum(ema20) || ema20 <= 0) {
    return { valid: false, reason: 'EMA20 missing or invalid' };
  }

  if (!isNum(prevClose) || prevClose <= 0) {
    return { valid: false, reason: 'Previous candle close missing or invalid' };
  }

  return { valid: true };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BREAKOUT SCAN FORMULAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What ChartInk found:
 * - Stock coiled near 20-day high (97-103%)
 * - Volume surge (>1.5x average)
 * - RSI strong but not overbought (55-70)
 *
 * Strategy: Buy ABOVE resistance on breakout confirmation
 * Target: STRUCTURAL LADDER (Weekly R1 → R2 → 52W High → REJECT)
 */
function calculateBreakoutLevels(data) {
  const { ema20, high20D, prevHigh, prevLow, prevClose, atr, weeklyR1, weeklyR2, high52W, dailyR1, dailyR2, isIntraday, previousDayHigh } = data;

  // Use 20D high if available, otherwise prev high
  const resistanceLevel = isNum(high20D) && high20D > 0 ? high20D : prevHigh;

  if (!isNum(resistanceLevel) || resistanceLevel <= 0) {
    return { valid: false, reason: 'No resistance level available for breakout' };
  }

  // Entry: Above resistance with buffer for confirmation (0.2 ATR)
  const entry = resistanceLevel + (0.2 * atr);

  // Stop: PDL − 0.15% buffer (intraday) or ATR-based (swing)
  let stop;
  if (isIntraday) {
    stop = roundToTick(prevLow * (1 - 0.0015));
    // Fallback: if risk > 3%, use EMA20 as tighter stop
    const riskPct = ((entry - stop) / entry) * 100;
    if (riskPct > 3.0 && isNum(ema20) && ema20 > 0 && ema20 < entry) {
      stop = roundToTick(ema20 * (1 - 0.0015));
      console.log(`  [Breakout] PDL stop risk ${round2(riskPct)}% > 3%, using EMA20 stop: ${round2(stop)}`);
    }
  } else {
    const breakoutZoneBottom = resistanceLevel * 0.97;
    const stopBase = Math.max(ema20, breakoutZoneBottom);
    stop = stopBase - (0.1 * atr);
  }

  // Calculate risk
  const risk = entry - stop;

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET: Intraday → Fixed 3% (breakout stocks break beyond 1H structure)
  //         Swing    → Weekly R1 → R2 → 52W High
  // ═══════════════════════════════════════════════════════════════════════════
  let targetResult;
  if (isIntraday) {
    // Fixed 3% target for breakout — these stocks break beyond 1H structure
    const target = roundToTick(entry * 1.03);
    const reward = Math.abs(target - entry);
    const rr = risk > 0 ? reward / risk : 0;

    if (rr < 1.2) {
      return {
        valid: false,
        noData: true,
        reason: `Breakout REJECTED: Fixed 3% target R:R ${rr.toFixed(1)}:1 < 1.2:1 (stop too wide for 3% target)`
      };
    }

    console.log(`  [Breakout] Using fixed 3% target: ${target} (entry=${round2(entry)}, R:R=${rr.toFixed(1)})`);
    targetResult = {
      target2: target,
      target3: null,
      target2_basis: 'fixed_3pct',
      reason: `Fixed 3% target at ${round2(target)}, R:R ${round2(rr)}:1`
    };
  } else {
    targetResult = findStructuralTarget({
      entry, risk, weeklyR1, weeklyR2, high52W, atr,
      minRR: data.minRR || 1.5
    });
  }

  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,
      reason: `Breakout REJECTED: ${targetResult.reason}`
    };
  }

  const entryRange = [roundToTick(entry), roundToTick(entry + 0.3 * atr)];

  return {
    valid: true,
    mode: 'BREAKOUT',
    archetype: 'breakout',
    entry,
    entry_basis: '20d_high',
    entryRange,
    stop,
    target: targetResult.target2,
    target3: targetResult.target3,
    target2_basis: targetResult.target2_basis,
    dailyR1Check: isNum(dailyR1) ? dailyR1 : null,
    entryType: 'buy_above',
    reason: `Breakout setup: Price coiled near ${round2(resistanceLevel)} with volume. ` +
            `Entry triggers above resistance for confirmation. ${targetResult.reason}`
  };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PULLBACK SCAN FORMULAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What ChartInk found:
 * - Stock in uptrend (EMA20 > EMA50 > SMA200)
 * - Pulled back to EMA20 support (97-103%)
 * - RSI cooled off (40-55)
 *
 * Strategy: AUTOMATICALLY decides between:
 * - AGGRESSIVE (LIMIT at EMA20) - when pullback is healthy
 * - CONSERVATIVE (BUY_ABOVE) - when pullback needs confirmation
 *
 * Target: STRUCTURAL LADDER (Daily R1 → R2 → Weekly R1 → R2 → 52W High → REJECT)
 * Pullbacks use daily pivots first (shorter-term trades)
 */
function calculatePullbackLevels(data) {
  const {
    ema20,
    ema50,
    high20D,
    prevHigh,
    prevLow,
    prevClose,
    prevVolume,
    avgVolume20,
    atr,
    rsi,
    weeklyR1,
    weeklyR2,
    dailyR1,
    dailyR2,
    high52W,
    isIntraday,
    resistanceZones
  } = data;

  // ─────────────────────────────────────────────────────────────────────────
  // DECISION LOGIC: Aggressive vs Conservative
  // ─────────────────────────────────────────────────────────────────────────

  // Rule 1: Distance from EMA20 (most important)
  // If price is within 0.4 ATR of EMA20, it's respecting support
  const distanceATR = Math.abs(prevClose - ema20) / atr;

  // Rule 2: Volume behavior (if available)
  // Low volume pullback = controlled profit-taking (good)
  // High volume pullback = institutional selling (bad)
  const hasVolumeData = isNum(prevVolume) && isNum(avgVolume20) && avgVolume20 > 0;
  const volumeRatio = hasVolumeData ? prevVolume / avgVolume20 : 1.0;

  // Rule 3: Price position relative to EMA20
  // Close above EMA20 = buyers still in control
  const aboveEMA = prevClose >= ema20;

  // Rule 4: RSI behavior (if available)
  // RSI 45-55 = controlled cooldown
  // RSI < 45 = momentum may have broken
  const hasRSI = isNum(rsi);
  const rsiHealthy = !hasRSI || rsi >= 45;

  // DECISION: All conditions must be met for aggressive mode
  const isHealthyPullback = (
    distanceATR <= 0.4 &&
    volumeRatio < 1.3 &&
    aboveEMA &&
    rsiHealthy
  );

  let entry, stop, entryType, entryRange, reason, mode;

  if (isHealthyPullback) {
    // ─────────────────────────────────────────────────────────────────────
    // AGGRESSIVE MODE: Buy the dip with limit order
    // ─────────────────────────────────────────────────────────────────────

    // Entry: At EMA20, but cap at 0.3% below (don't go too deep)
    const maxDip = ema20 * 0.003; // 0.3% of EMA20
    const dipAmount = Math.min(0.1 * atr, maxDip);
    entry = ema20 - dipAmount;

    // Entry range: Tight band around entry for limit order (±0.5% of entry, capped at 0.2*ATR)
    const pullbackSpread = Math.min(entry * 0.005, 0.2 * atr);
    entryRange = [roundToTick(entry - pullbackSpread), roundToTick(entry + pullbackSpread)];

    entryType = 'limit';
    mode = 'PULLBACK_AGGRESSIVE';
    reason = 'Healthy pullback: Price respecting EMA20, RSI cooled, low volume. ' +
             'Safe to buy the dip with limit order.';
  } else {
    // ─────────────────────────────────────────────────────────────────────
    // CONSERVATIVE MODE: Wait for confirmation
    // ─────────────────────────────────────────────────────────────────────

    if (!isNum(prevHigh) || prevHigh <= 0) {
      return { valid: false, reason: 'Previous candle high required for conservative pullback entry' };
    }

    // Entry: Above prev high = bounce confirmed
    entry = prevHigh + (0.1 * atr);

    // Entry range for slippage (buy_above: entry to entry + 0.2*ATR)
    entryRange = [roundToTick(entry), roundToTick(entry + 0.2 * atr)];

    entryType = 'buy_above';
    mode = 'PULLBACK_CONSERVATIVE';
    reason = buildConservativeReason(distanceATR, rsi, prevClose, ema20, volumeRatio);
  }

  // Stop: min(EMA50, PDL) − 0.15% buffer (intraday) or ATR-based (swing)
  if (isIntraday) {
    const ema50Val = isNum(ema50) && ema50 > 0 ? ema50 : Infinity;
    const pdl = isNum(prevLow) && prevLow > 0 ? prevLow : Infinity;
    const stopBase = Math.min(ema50Val, pdl);
    if (!isFinite(stopBase)) {
      stop = ema20 - (0.6 * atr); // fallback if neither available
    } else {
      stop = roundToTick(stopBase * (1 - 0.0015));
    }
  } else {
    stop = ema20 - (0.6 * atr);
  }

  const risk = entry - stop;

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET: Intraday → 1H swing resistance zones
  //         Swing    → Daily R1 → R2 → Weekly R1 → R2 → 52W High
  // ═══════════════════════════════════════════════════════════════════════════
  const targetResult = isIntraday
    ? find1HSwingTarget({
        entry, risk, resistanceZones, isShort: false,
        minRR: data.minRR || 1.2
      })
    : findPullbackTarget({
        entry, risk, dailyR1, dailyR2, weeklyR1, weeklyR2, high52W,
        minRR: data.minRR || 1.2
      });

  // If no structural target gives adequate R:R → REJECT this setup
  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,
      reason: `Pullback REJECTED: ${targetResult.reason}`
    };
  }

  return {
    valid: true,
    mode,
    archetype: 'pullback',
    entry,
    entry_basis: mode === 'PULLBACK_AGGRESSIVE' ? 'ema20' : 'prev_high',
    entryRange,
    stop,
    target: targetResult.target2,
    target3: targetResult.target3,
    target2_basis: targetResult.target2_basis,
    dailyR1Check: isNum(dailyR1) ? dailyR1 : null,
    entryType,
    reason: `${reason} ${targetResult.reason}`
  };
}

/**
 * Build explanation for why conservative mode was chosen
 */
function buildConservativeReason(distanceATR, rsi, close, ema20, volumeRatio) {
  const reasons = [];

  if (distanceATR > 0.4) {
    reasons.push(`Price ${round2(distanceATR)} ATR from EMA20 (not holding cleanly)`);
  }
  if (isNum(rsi) && rsi < 45) {
    reasons.push(`RSI ${round2(rsi)} shows weak momentum`);
  }
  if (close < ema20) {
    reasons.push('Closed below EMA20 support');
  }
  if (volumeRatio >= 1.3) {
    reasons.push(`High volume (${round2(volumeRatio)}x avg) selling pressure`);
  }

  if (reasons.length === 0) {
    reasons.push('Pullback needs confirmation');
  }

  return 'Conservative entry: ' + reasons.join('. ') + '. ' +
         'Entry triggers above prev high for safety.';
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MOMENTUM SCAN FORMULAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What ChartInk found:
 * - Stock already running (3-10% above EMA20)
 * - Strong RSI (55-68)
 * - Has room to run
 *
 * Strategy: Continuation entry above recent high
 * Target: STRUCTURAL LADDER (Weekly R1 → R2 → 52W High → REJECT)
 * NOTE: If already within 2% of 20D high, treat as BREAKOUT instead
 */
function calculateMomentumLevels(data) {
  const { ema20, high20D, prevHigh, prevLow, prevClose, atr, weeklyR1, weeklyR2, high52W, dailyR1, dailyR2, isIntraday, previousDayHigh } = data;

  if (!isNum(prevHigh) || prevHigh <= 0) {
    return { valid: false, reason: 'Previous candle high required for momentum entry' };
  }

  // Edge case: If close is within 2% of 20D high, this is more breakout than momentum
  // Note: nearBreakout redirect passes full `data` which includes isIntraday/dailyR2
  const nearBreakout = isNum(high20D) && prevClose >= high20D * 0.98;

  if (nearBreakout) {
    // Redirect to breakout logic with modified reason
    const breakoutLevels = calculateBreakoutLevels(data);
    if (breakoutLevels.valid) {
      breakoutLevels.mode = 'MOMENTUM_NEAR_BREAKOUT';
      breakoutLevels.reason = 'Momentum stock near 20D high - treating as breakout. ' +
                              breakoutLevels.reason;
    }
    return breakoutLevels;
  }

  // Entry: Above prev high for continuation (don't chase)
  const entry = prevHigh + (0.15 * atr);

  // Entry range for slippage
  const entryRange = [roundToTick(entry), roundToTick(entry + 0.3 * atr)];

  // Stop: PDL − 0.15% buffer (intraday) or ATR-based (swing)
  let stop;
  if (isIntraday) {
    stop = roundToTick(prevLow * (1 - 0.0015));
    // Fallback: if risk > 3%, use midpoint(entry, PDL) as stop
    const riskPct = ((entry - stop) / entry) * 100;
    if (riskPct > 3.0) {
      stop = roundToTick((entry + prevLow) / 2);
      console.log(`  [Momentum] PDL stop risk ${round2(riskPct)}% > 3%, using midpoint stop: ${round2(stop)}`);
    }
  } else {
    const ema20Stop = ema20 - (0.1 * atr);
    const atrStop = entry - (1.2 * atr);
    stop = Math.max(ema20Stop, atrStop);
  }

  const risk = entry - stop;

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET: Intraday → Fixed 3% (momentum stocks break beyond 1H structure)
  //         Swing    → Weekly ladder
  // ═══════════════════════════════════════════════════════════════════════════
  let targetResult;
  if (isIntraday) {
    // Fixed 3% target for momentum — these stocks break beyond 1H structure
    const target = roundToTick(entry * 1.03);
    const reward = Math.abs(target - entry);
    const rr = risk > 0 ? reward / risk : 0;

    if (rr < 1.2) {
      return {
        valid: false,
        noData: true,
        reason: `Momentum REJECTED: Fixed 3% target R:R ${rr.toFixed(1)}:1 < 1.2:1 (stop too wide for 3% target)`
      };
    }

    console.log(`  [Momentum] Using fixed 3% target: ${target} (entry=${round2(entry)}, R:R=${rr.toFixed(1)})`);
    targetResult = {
      target2: target,
      target3: null,
      target2_basis: 'fixed_3pct',
      reason: `Fixed 3% target at ${round2(target)}, R:R ${round2(rr)}:1`
    };
  } else {
    targetResult = findStructuralTarget({
      entry, risk, weeklyR1, weeklyR2, high52W, atr,
      minRR: data.minRR || 1.5
    });
  }

  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,
      reason: `Momentum REJECTED: ${targetResult.reason}`
    };
  }

  return {
    valid: true,
    mode: 'MOMENTUM',
    archetype: 'trend-follow',
    entry,
    entry_basis: 'prev_high',
    entryRange,
    stop,
    target: targetResult.target2,
    target3: targetResult.target3,
    target2_basis: targetResult.target2_basis,
    dailyR1Check: isNum(dailyR1) ? dailyR1 : null,
    entryType: 'buy_above',
    reason: `Momentum continuation: Stock running ${round2(((prevClose - ema20) / ema20) * 100)}% above EMA20. ` +
            `Entry above prev high (${round2(prevHigh)}) confirms continued buying. ${targetResult.reason}`
  };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONSOLIDATION BREAKOUT SCAN FORMULAS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What ChartInk found:
 * - Stock in tight range near highs (range < 2.5%)
 * - Coiled energy (low volatility = big move coming)
 * - RSI neutral (50-65)
 *
 * Strategy: Buy above consolidation range, target range expansion
 * Target: STRUCTURAL LADDER (Weekly R1 → R2 → 52W High → REJECT)
 */
function calculateConsolidationLevels(data) {
  const { prevHigh, prevLow, high10D, low10D, atr, weeklyR1, weeklyR2, high52W, dailyR1, isIntraday, resistanceZones } = data;

  if (!isNum(prevHigh) || !isNum(prevLow) || prevHigh <= 0 || prevLow <= 0) {
    return { valid: false, reason: 'Previous candle high/low required for consolidation entry' };
  }

  const prevRange = prevHigh - prevLow;

  // Entry: Just above the tight range (small buffer since range is already tight)
  const entry = prevHigh + (0.1 * atr);

  // Entry range for slippage
  const entryRange = [roundToTick(entry), roundToTick(entry + 0.2 * atr)];

  // Stop: PDL − 0.15% buffer (intraday) or consolidation-based (swing)
  let stop;
  if (isIntraday) {
    stop = roundToTick(prevLow * (1 - 0.0015));
  } else {
    const has10DRange = isNum(high10D) && isNum(low10D) && high10D > low10D;
    const consolidationLow = has10DRange ? Math.min(low10D, prevLow) : prevLow;
    stop = consolidationLow - (0.1 * atr);
  }

  const risk = entry - stop;

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET: Intraday → 1H swing resistance zones; Swing → Weekly ladder
  // ═══════════════════════════════════════════════════════════════════════════
  const targetResult = isIntraday
    ? find1HSwingTarget({
        entry, risk, resistanceZones, isShort: false,
        minRR: data.minRR || 1.2
      })
    : findStructuralTarget({
        entry, risk, weeklyR1, weeklyR2, high52W, atr,
        minRR: data.minRR || 1.5
      });

  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,
      reason: `Consolidation REJECTED: ${targetResult.reason}`
    };
  }

  return {
    valid: true,
    mode: 'CONSOLIDATION_BREAKOUT',
    archetype: 'breakout',
    entry,
    entry_basis: 'prev_high',
    entryRange,
    stop,
    target: targetResult.target2,
    target3: targetResult.target3,
    target2_basis: targetResult.target2_basis,
    dailyR1Check: isNum(dailyR1) ? dailyR1 : null,
    entryType: 'buy_above',
    reason: `Consolidation breakout: Tight range (${round2((prevRange / prevHigh) * 100)}%) near highs signals energy buildup. ` +
            `${targetResult.reason}`
  };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A+ MOMENTUM SCAN FORMULAS — 52-WEEK HIGH BREAKOUT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ACTUAL ChartInk Query (decoded):
 *   close > 1 day ago max(252, high)  →  FRESH 52-WEEK HIGH (today's close > previous 252-day max high)
 *   volume > sma(volume, 50) * 1.5    →  Volume 1.5x above 50-day average
 *   close > sma(close, 200)           →  Above 200 DMA (long-term uptrend)
 *   rsi(14) > 55 and rsi(14) < 75     →  RSI in strong-but-not-exhausted zone
 *   ema(close, 20) > ema(close, 50)   →  EMA stack bullish (short-term trending)
 *   close > 1 week ago close * 1.02   →  2%+ weekly gain (momentum confirmed)
 *   market cap > 1000, close > 100    →  Mid-cap+ liquid stocks
 *
 * Key insight: These stocks just made NEW 52-WEEK HIGHS.
 * There is NO overhead resistance — the 52W high IS today's price.
 * The standard structural ladder (Weekly R1 → R2 → 52W High) may fail because
 * high_52w ≈ prevHigh, so entry > high_52w always.
 * Level 0 in findStructuralTarget handles this with ATR extension targets.
 *
 * Strategy: Buy the breakout continuation
 * - Entry: Above prev high (confirms breakout holds on Monday)
 * - Stop: Below EMA20 (momentum support, capped at 1.5 ATR)
 * - Target: STRUCTURAL LADDER with 52W breakout extension fallback
 *   Weekly R1/R2 may still work if they're above the new high.
 *   If not → ATR extension target (2.5 ATR from entry) since there's no overhead structure.
 */
function calculateAPlusMomentumLevels(data) {
  const { ema20, prevHigh, prevLow, prevClose, atr, weeklyR1, weeklyR2, high52W, dailyR1, isIntraday, resistanceZones } = data;

  if (!isNum(prevHigh) || prevHigh <= 0) {
    return { valid: false, reason: 'Previous candle high required for A+ momentum entry' };
  }

  if (!isNum(ema20) || ema20 <= 0) {
    return { valid: false, reason: 'EMA20 required for A+ momentum stop' };
  }

  // ENTRY: Above prev high + small buffer for confirmation
  const entry = prevHigh + (0.15 * atr);

  // Entry range for slippage
  const entryRange = [roundToTick(entry), roundToTick(entry + 0.3 * atr)];

  // STOP: PDL − 0.15% buffer (intraday) or EMA20-based (swing)
  let stop;
  if (isIntraday) {
    stop = roundToTick(prevLow * (1 - 0.0015));
    // Fallback: if risk > 3%, use EMA20 as tighter stop
    const riskPct = ((entry - stop) / entry) * 100;
    if (riskPct > 3.0 && isNum(ema20) && ema20 > 0 && ema20 < entry) {
      stop = roundToTick(ema20 * (1 - 0.0015));
      console.log(`  [APlusMomentum] PDL stop risk ${round2(riskPct)}% > 3%, using EMA20 stop: ${round2(stop)}`);
    }
  } else {
    const ema20Stop = ema20 - (0.2 * atr);
    const maxStop = entry - (1.5 * atr);
    stop = Math.max(ema20Stop, maxStop);
  }

  // RISK calculation
  const risk = entry - stop;

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET: Intraday → 1H swing resistance zones
  //         Swing → Weekly ladder with 52W breakout ATR extension fallback
  // ═══════════════════════════════════════════════════════════════════════════
  const targetResult = isIntraday
    ? find1HSwingTarget({
        entry, risk, resistanceZones, isShort: false,
        minRR: data.minRR || 1.2
      })
    : findStructuralTarget({
        entry, risk, weeklyR1, weeklyR2, high52W, atr,
        minRR: data.minRR || 1.5
      });

  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,
      reason: `A+ Momentum REJECTED: ${targetResult.reason}`
    };
  }

  // Calculate distance from EMA20 for context
  const distanceFromEMA = ((prevClose - ema20) / ema20) * 100;

  return {
    valid: true,
    mode: 'A_PLUS_MOMENTUM',
    archetype: '52w_breakout',
    entry,
    entry_basis: '52w_high',
    entryRange,
    stop,
    target: targetResult.target2,
    target3: targetResult.target3,
    target2_basis: targetResult.target2_basis,
    dailyR1Check: isNum(dailyR1) ? dailyR1 : null,
    entryType: 'buy_above',
    reason: `A+ Momentum (52W Breakout): Stock ${round2(distanceFromEMA)}% above EMA20, ` +
            `broke 252-day high with 1.5x+ volume. ` +
            `Entry above ${round2(prevHigh)} confirms breakout holds. ${targetResult.reason}`
  };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GUARDRAILS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These guards REJECT invalid trades rather than adjusting stops
 * (adjusting stops breaks structural logic)
 */
function applyGuardrails(entry, stop, target, atr, scanType) {
  const adjustments = [];

  // Detect if this is a SHORT trade based on scan type
  const isShortTrade = ['breakdown_setup', 'momentum_carry_bearish', 'failed_at_resistance', 'compression_bearish'].includes(scanType);

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD A: Sanity check - all values must be positive
  // ─────────────────────────────────────────────────────────────────────────
  if (!isNum(entry) || !isNum(stop) || !isNum(target)) {
    return {
      valid: false,
      reason: 'Invalid levels calculated (missing values)',
      debug: { entry, stop, target }
    };
  }

  if (entry <= 0 || stop <= 0 || target <= 0) {
    return {
      valid: false,
      reason: 'Invalid levels calculated (zero or negative values)',
      debug: { entry, stop, target }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD B: Stop validation (direction-aware)
  // ─────────────────────────────────────────────────────────────────────────
  if (isShortTrade) {
    // SHORT: Stop must be ABOVE entry
    if (stop <= entry) {
      return {
        valid: false,
        reason: `Stop (${round2(stop)}) must be above entry (${round2(entry)}) for SHORT trade`,
        debug: { entry, stop, target }
      };
    }
  } else {
    // LONG: Stop must be BELOW entry
    if (stop >= entry) {
      return {
        valid: false,
        reason: `Stop (${round2(stop)}) must be below entry (${round2(entry)}) for LONG trade`,
        debug: { entry, stop, target }
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD C: Target validation (direction-aware)
  // ─────────────────────────────────────────────────────────────────────────
  if (isShortTrade) {
    // SHORT: Target must be BELOW entry
    if (target >= entry) {
      return {
        valid: false,
        reason: `Target (${round2(target)}) must be below entry (${round2(entry)}) for SHORT trade`,
        debug: { entry, stop, target }
      };
    }
  } else {
    // LONG: Target must be ABOVE entry
    if (target <= entry) {
      return {
        valid: false,
        reason: `Target (${round2(target)}) must be above entry (${round2(entry)}) for LONG trade`,
        debug: { entry, stop, target }
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD D: Maximum risk check (8%) - REJECT, don't adjust
  // ─────────────────────────────────────────────────────────────────────────
  const risk = isShortTrade ? (stop - entry) : (entry - stop);
  const riskPercent = (risk / entry) * 100;
  const MAX_RISK_PERCENT = 3.0;

  if (riskPercent > MAX_RISK_PERCENT) {
    return {
      valid: false,
      reason: `Risk too high: ${round2(riskPercent)}% (max ${MAX_RISK_PERCENT}%). ` +
              `Either reduce position size or skip this setup.`,
      riskPercent: round2(riskPercent),
      suggestedAction: 'skip_or_reduce_size'
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD E: Minimum risk check (0.5%) - avoid noise stops
  // ─────────────────────────────────────────────────────────────────────────
  const MIN_RISK_PERCENT = 0.5;

  if (riskPercent < MIN_RISK_PERCENT) {
    return {
      valid: false,
      reason: `Risk too small: ${round2(riskPercent)}% (min ${MIN_RISK_PERCENT}%). ` +
              `Stop is too close to entry - likely to trigger on noise.`,
      riskPercent: round2(riskPercent),
      suggestedAction: 'widen_stop_or_skip'
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD F: Minimum target - worth the effort
  // Pullback targets are tighter (1.5%), momentum needs more room (2%)
  // ─────────────────────────────────────────────────────────────────────────
  const reward = isShortTrade ? (entry - target) : (target - entry);
  const rewardPercent = (reward / entry) * 100;
  const MIN_TARGET_PERCENT = scanType === 'pullback' ? 1.5 : 2.0;

  if (rewardPercent < MIN_TARGET_PERCENT) {
    return {
      valid: false,
      reason: `Target too close: ${round2(rewardPercent)}% (min ${MIN_TARGET_PERCENT}%). ` +
              `Not worth the swing trade effort.`,
      rewardPercent: round2(rewardPercent),
      suggestedAction: 'skip_this_setup'
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD G: Maximum target (15%) - realistic for 1-2 week swing
  // ─────────────────────────────────────────────────────────────────────────
  const MAX_TARGET_PERCENT = 15.0;
  let adjustedTarget = target;

  if (rewardPercent > MAX_TARGET_PERCENT) {
    adjustedTarget = isShortTrade
      ? entry * (1 - MAX_TARGET_PERCENT / 100)
      : entry * (1 + MAX_TARGET_PERCENT / 100);
    adjustments.push(
      `Target capped from ${round2(rewardPercent)}% to ${MAX_TARGET_PERCENT}% ` +
      `(original structural target: ${round2(target)})`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD H: Risk-Reward ratio check (minimum 1.2:1)
  // ─────────────────────────────────────────────────────────────────────────
  const adjustedReward = isShortTrade ? (entry - adjustedTarget) : (adjustedTarget - entry);
  const riskReward = adjustedReward / risk;
  const MIN_RR = 1.2;

  if (riskReward < MIN_RR) {
    const minimumViableTarget = isShortTrade
      ? entry - (risk * 1.5)
      : entry + (risk * 1.5);
    return {
      valid: false,
      reason: `R:R too low: ${round2(riskReward)}:1 (min ${MIN_RR}:1). ` +
              `Risk ${round2(riskPercent)}% vs Reward ${round2((adjustedReward / entry) * 100)}%`,
      currentRR: round2(riskReward),
      suggestedTarget: roundToTick(minimumViableTarget),
      suggestedAction: `Need target ${isShortTrade ? '<=' : '>='} ${round2(minimumViableTarget)} for viable trade`
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Calculate final metrics
  // ─────────────────────────────────────────────────────────────────────────
  const finalRewardPercent = ((adjustedTarget - entry) / entry) * 100;

  return {
    valid: true,
    entry,
    stop,
    target: adjustedTarget,
    riskReward: round2(riskReward),
    riskPercent: round2(riskPercent),
    rewardPercent: round2(finalRewardPercent),
    adjustments: adjustments.length > 0 ? adjustments : undefined
  };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SHORT TRADE SUPPORT - Bearish Setups
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Find structural support levels for SHORT targets (downward ladder)
 * Priority: Weekly S1 → Weekly S2 → 20D Low → ATR Extension → REJECT
 *
 * @param {Object} params - { entry, risk, weeklyS1, weeklyS2, low20D, atr, minRR }
 * @returns {Object} { target2, target3, target2_basis, reason } or { rejected: true, reason }
 */
function findShortStructuralTarget(params) {
  const { entry, risk, weeklyS1, weeklyS2, low20D, atr, minRR = 1.5 } = params;

  // Guard: Invalid risk (stop <= entry for shorts)
  if (!isNum(risk) || risk <= 0) {
    return { rejected: true, reason: 'Invalid risk (stop <= entry)', noData: false };
  }

  // Guard: No structural data available
  const hasAnyLevel = isNum(weeklyS1) || isNum(weeklyS2) || isNum(low20D);
  const hasATR = isNum(atr) && atr > 0;
  if (!hasAnyLevel && !hasATR) {
    return {
      rejected: true,
      reason: 'No structural data available (pivot/20D low missing, no ATR)',
      noData: true
    };
  }

  // Try Weekly S1 first (primary support)
  if (isNum(weeklyS1) && weeklyS1 < entry) {
    const rrS1 = (entry - weeklyS1) / risk;
    if (rrS1 >= minRR) {
      return {
        target2: weeklyS1,
        target3: isNum(weeklyS2) && weeklyS2 < weeklyS1 ? weeklyS2 :
                 isNum(low20D) && low20D < weeklyS1 ? low20D :
                 roundToTick(entry - (3.0 * atr)),
        target2_basis: 'weekly_s1',
        reason: `Short to Weekly S1 support (${round2(weeklyS1)}), R:R ${round2(rrS1)}:1`
      };
    }
  }

  // Try Weekly S2 (secondary support)
  if (isNum(weeklyS2) && weeklyS2 < entry) {
    const rrS2 = (entry - weeklyS2) / risk;
    if (rrS2 >= minRR) {
      return {
        target2: weeklyS2,
        target3: isNum(low20D) && low20D < weeklyS2 ? low20D :
                 roundToTick(entry - (3.0 * atr)),
        target2_basis: 'weekly_s2',
        reason: `Short to Weekly S2 support (${round2(weeklyS2)}), R:R ${round2(rrS2)}:1`
      };
    }
  }

  // Try 20D Low (structural support)
  if (isNum(low20D) && low20D < entry) {
    const rrLow = (entry - low20D) / risk;
    if (rrLow >= minRR) {
      return {
        target2: low20D,
        target3: hasATR ? roundToTick(entry - (3.0 * atr)) : null,
        target2_basis: 'low_20d',
        reason: `Short to 20D Low support (${round2(low20D)}), R:R ${round2(rrLow)}:1`
      };
    }
  }

  // Fallback: ATR extension (for breakdown-to-new-lows scenarios)
  if (hasATR) {
    const extensionTarget = entry - (2.0 * atr);
    const extensionRR = (entry - extensionTarget) / risk;
    if (extensionRR >= minRR) {
      return {
        target2: roundToTick(extensionTarget),
        target3: roundToTick(entry - (3.5 * atr)),
        target2_basis: 'atr_extension',
        reason: `Breakdown to new lows, ATR extension target (${round2(extensionTarget)}), R:R ${round2(extensionRR)}:1`
      };
    }
  }

  // All levels failed R:R check — reject setup
  return {
    rejected: true,
    reason: `All support levels (Weekly S1: ${isNum(weeklyS1) ? round2(weeklyS1) : 'N/A'}, ` +
            `S2: ${isNum(weeklyS2) ? round2(weeklyS2) : 'N/A'}, ` +
            `20D Low: ${isNum(low20D) ? round2(low20D) : 'N/A'}) ` +
            `below entry ${round2(entry)} fail minimum R:R of ${minRR}:1`,
    noData: false
  };
}

/**
 * BREAKDOWN SETUP (bearish version of breakout)
 * Stock sitting just above 20D low, ready to break down
 *
 * Entry: Below prev low (confirms breakdown)
 * Stop: Recent swing high (5-10 day high), NOT 20D high (already moved)
 * Target: Weekly S1 → S2 → 20D Low → ATR Extension
 */
function calculateBreakdownLevels(data) {
  const { ema20, low20D, prevHigh, prevLow, prevClose, atr, high5D, high10D, weeklyS1, weeklyS2, dailyS1, isIntraday } = data;

  if (!isNum(prevLow) || prevLow <= 0) {
    return { valid: false, reason: 'Previous candle low required for breakdown entry' };
  }

  // Entry: Below prev low (breakdown confirmation)
  const entry = prevLow - (0.15 * atr);
  const entryRange = [roundToTick(entry - 0.3 * atr), roundToTick(entry)];

  // Stop: PDH + 0.15% buffer (intraday) or swing-high based (swing)
  let stop;
  if (isIntraday) {
    stop = roundToTick(prevHigh * (1 + 0.0015));
    // Fallback: if risk > 3%, use EMA20 as tighter stop
    const riskPct = ((stop - entry) / entry) * 100;
    if (riskPct > 3.0 && isNum(ema20) && ema20 > 0 && ema20 > entry) {
      stop = roundToTick(ema20 * (1 + 0.0015));
      console.log(`  [Breakdown] PDH stop risk ${round2(riskPct)}% > 3%, using EMA20 stop: ${round2(stop)}`);
    }
  } else {
    let swingHigh = high5D || high10D || prevClose * 1.03;
    const maxStop = entry * 1.05;
    stop = Math.min(swingHigh + (0.3 * atr), maxStop);
  }

  const risk = stop - entry;

  // Target: Intraday → Fixed 3% (breakdown stocks break beyond 1H structure)
  //         Swing    → Weekly support ladder
  let targetResult;
  if (isIntraday) {
    // Fixed 3% target for breakdown — these stocks break beyond 1H structure
    const target = roundToTick(entry * 0.97);
    const reward = Math.abs(target - entry);
    const rr = risk > 0 ? reward / risk : 0;

    if (rr < 1.2) {
      return {
        valid: false,
        noData: true,
        reason: `Breakdown REJECTED: Fixed 3% target R:R ${rr.toFixed(1)}:1 < 1.2:1 (stop too wide for 3% target)`
      };
    }

    console.log(`  [Breakdown] Using fixed 3% target: ${target} (entry=${round2(entry)}, R:R=${rr.toFixed(1)})`);
    targetResult = {
      target2: target,
      target3: null,
      target2_basis: 'fixed_3pct',
      reason: `Fixed 3% target at ${round2(target)}, R:R ${round2(rr)}:1`
    };
  } else {
    targetResult = findShortStructuralTarget({
      entry, risk, weeklyS1, weeklyS2, low20D, atr,
      minRR: data.minRR || 1.5
    });
  }

  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,
      reason: `Breakdown REJECTED: ${targetResult.reason}`
    };
  }

  return {
    valid: true,
    mode: 'BREAKDOWN',
    archetype: 'breakdown',
    entry,
    entry_basis: 'prev_low',
    entryRange,
    stop,
    target: targetResult.target2,
    target3: targetResult.target3,
    target2_basis: targetResult.target2_basis,
    dailyS1Check: isNum(dailyS1) ? dailyS1 : null,
    entryType: 'sell_below',
    reason: `Breakdown setup: Stock cracking support at ${round2(prevLow)}. ` +
            `Stop at PDH ${round2(prevHigh)}. ${targetResult.reason}`
  };
}

/**
 * MOMENTUM CARRY BEARISH (short version of momentum)
 * Stock in downtrend, running below EMA20
 *
 * Entry: Below prev low (confirms continued selling)
 * Stop: Above EMA20 (momentum resistance), capped at 2 ATR
 * Target: Weekly S1 → S2 → 20D Low
 */
function calculateMomentumBearishLevels(data) {
  const { ema20, prevHigh, prevLow, prevClose, atr, weeklyS1, weeklyS2, low20D, dailyS1, isIntraday } = data;

  if (!isNum(prevLow) || prevLow <= 0) {
    return { valid: false, reason: 'Previous candle low required for momentum bearish entry' };
  }

  if (!isNum(ema20) || ema20 <= 0) {
    return { valid: false, reason: 'EMA20 required for momentum bearish stop' };
  }

  // Entry: Below prev low (momentum continuation)
  const entry = prevLow - (0.1 * atr);
  const entryRange = [roundToTick(entry - 0.2 * atr), roundToTick(entry)];

  // Stop: PDH + 0.15% buffer (intraday) or EMA20-based (swing)
  let stop;
  if (isIntraday) {
    stop = roundToTick(prevHigh * (1 + 0.0015));
    // Fallback: if risk > 3%, use midpoint(entry, PDH) as stop
    const riskPct = ((stop - entry) / entry) * 100;
    if (riskPct > 3.0) {
      stop = roundToTick((entry + prevHigh) / 2);
      console.log(`  [MomentumBearish] PDH stop risk ${round2(riskPct)}% > 3%, using midpoint stop: ${round2(stop)}`);
    }
  } else {
    const ema20Stop = ema20 + (0.3 * atr);
    const maxStop = entry + (2.0 * atr);
    stop = Math.min(ema20Stop, maxStop);
  }

  const risk = stop - entry;

  // Target: Intraday → Fixed 3% (momentum bearish stocks break beyond 1H structure)
  //         Swing    → Weekly support ladder
  let targetResult;
  if (isIntraday) {
    // Fixed 3% target for momentum bearish — these stocks break beyond 1H structure
    const target = roundToTick(entry * 0.97);
    const reward = Math.abs(target - entry);
    const rr = risk > 0 ? reward / risk : 0;

    if (rr < 1.2) {
      return {
        valid: false,
        noData: true,
        reason: `Momentum Bearish REJECTED: Fixed 3% target R:R ${rr.toFixed(1)}:1 < 1.2:1 (stop too wide for 3% target)`
      };
    }

    console.log(`  [MomentumBearish] Using fixed 3% target: ${target} (entry=${round2(entry)}, R:R=${rr.toFixed(1)})`);
    targetResult = {
      target2: target,
      target3: null,
      target2_basis: 'fixed_3pct',
      reason: `Fixed 3% target at ${round2(target)}, R:R ${round2(rr)}:1`
    };
  } else {
    targetResult = findShortStructuralTarget({
      entry, risk, weeklyS1, weeklyS2, low20D, atr,
      minRR: data.minRR || 1.5
    });
  }

  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,
      reason: `Momentum Bearish REJECTED: ${targetResult.reason}`
    };
  }

  return {
    valid: true,
    mode: 'MOMENTUM_BEARISH',
    archetype: 'momentum',
    entry,
    entry_basis: 'prev_low',
    entryRange,
    stop,
    target: targetResult.target2,
    target3: targetResult.target3,
    target2_basis: targetResult.target2_basis,
    dailyS1Check: isNum(dailyS1) ? dailyS1 : null,
    entryType: 'sell_below',
    reason: `Momentum bearish: Stock running ${round2(((ema20 - prevClose) / ema20) * 100)}% below EMA20. ` +
            `Entry below prev low (${round2(prevLow)}) confirms continued selling. ${targetResult.reason}`
  };
}

/**
 * FAILED AT RESISTANCE (bearish version of pullback)
 * Stock rejected at resistance, ready to fall back
 *
 * Entry: Below prev low (confirms rejection)
 * Stop: Above resistance (pattern invalidates if it breaks through)
 * Target: Weekly S1 → S2 → 20D Low
 */
function calculateFailedResistanceLevels(data) {
  const { high20D, prevHigh, prevLow, prevClose, atr, weeklyS1, weeklyS2, weeklyR1, low20D, dailyS1, isIntraday, supportZones } = data;

  if (!isNum(prevLow) || prevLow <= 0) {
    return { valid: false, reason: 'Previous candle low required for failed resistance entry' };
  }

  // Identify the resistance level (high20D or weeklyR1) — used for logging only now
  const resistance = isNum(high20D) && high20D > prevClose ? high20D :
                     isNum(weeklyR1) && weeklyR1 > prevClose ? weeklyR1 :
                     prevClose * 1.05;

  // Entry: Below prev low (confirms rejection)
  const entry = prevLow - (0.1 * atr);
  const entryRange = [roundToTick(entry - 0.2 * atr), roundToTick(entry)];

  // Stop: PDH + 0.15% buffer (intraday) or resistance-based (swing)
  let stop;
  if (isIntraday) {
    stop = roundToTick(prevHigh * (1 + 0.0015));
  } else {
    stop = resistance + (0.3 * atr);
  }

  const risk = stop - entry;

  // Target: Intraday → 1H swing support zones; Swing → Weekly support ladder
  const targetResult = isIntraday
    ? find1HSwingTarget({
        entry, risk, supportZones, isShort: true,
        minRR: data.minRR || 1.2
      })
    : findShortStructuralTarget({
        entry, risk, weeklyS1, weeklyS2, low20D, atr,
        minRR: data.minRR || 1.5
      });

  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,
      reason: `Failed Resistance REJECTED: ${targetResult.reason}`
    };
  }

  return {
    valid: true,
    mode: 'FAILED_RESISTANCE',
    archetype: 'pullback',
    entry,
    entry_basis: 'prev_low',
    entryRange,
    stop,
    stop_basis: 'prev_high',
    target: targetResult.target2,
    target3: targetResult.target3,
    target2_basis: targetResult.target2_basis,
    dailyS1Check: isNum(dailyS1) ? dailyS1 : null,
    entryType: 'sell_below',
    reason: `Failed resistance: Stock rejected at ${round2(resistance)}, falling back. ` +
            `Entry below prev low confirms rejection. ${targetResult.reason}`
  };
}

/**
 * COMPRESSION BEARISH (bearish version of consolidation breakout)
 * Stock in tight range near lows, ready to break down
 *
 * Entry: Below consolidation range
 * Stop: Above consolidation high (pattern fails if it breaks out upward)
 * Target: Weekly S1 → S2 → 20D Low
 */
function calculateCompressionBearishLevels(data) {
  const { prevHigh, prevLow, low10D, high10D, atr, weeklyS1, weeklyS2, low20D, dailyS1, isIntraday, supportZones } = data;

  if (!isNum(prevHigh) || !isNum(prevLow) || prevHigh <= 0 || prevLow <= 0) {
    return { valid: false, reason: 'Previous candle high/low required for compression bearish entry' };
  }

  // Entry: Below the tight range
  const entry = prevLow - (0.1 * atr);
  const entryRange = [roundToTick(entry - 0.2 * atr), roundToTick(entry)];

  // Stop: PDH + 0.15% buffer (intraday) or consolidation-based (swing)
  let stop;
  if (isIntraday) {
    stop = roundToTick(prevHigh * (1 + 0.0015));
  } else {
    const has10DRange = isNum(high10D) && isNum(low10D) && high10D > low10D;
    const consolidationHigh = has10DRange ? Math.max(high10D, prevHigh) : prevHigh;
    stop = consolidationHigh + (0.1 * atr);
  }

  const risk = stop - entry;

  // Target: Intraday → 1H swing support zones; Swing → Weekly support ladder
  const targetResult = isIntraday
    ? find1HSwingTarget({
        entry, risk, supportZones, isShort: true,
        minRR: data.minRR || 1.2
      })
    : findShortStructuralTarget({
        entry, risk, weeklyS1, weeklyS2, low20D, atr,
        minRR: data.minRR || 1.5
      });

  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,
      reason: `Compression Bearish REJECTED: ${targetResult.reason}`
    };
  }

  const prevRange = prevHigh - prevLow;

  return {
    valid: true,
    mode: 'COMPRESSION_BEARISH',
    archetype: 'breakdown',
    entry,
    entry_basis: 'prev_low',
    entryRange,
    stop,
    stop_basis: 'prev_high',
    target: targetResult.target2,
    target3: targetResult.target3,
    target2_basis: targetResult.target2_basis,
    dailyS1Check: isNum(dailyS1) ? dailyS1 : null,
    entryType: 'sell_below',
    reason: `Compression bearish: Tight range (${round2((prevRange / prevHigh) * 100)}%) near lows signals energy buildup. ` +
            `${targetResult.reason}`
  };
}


/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXPORTS
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default {
  calculateTradingLevels,
  calculateBreakoutLevels,
  calculatePullbackLevels,
  calculateMomentumLevels,
  calculateConsolidationLevels,
  calculateAPlusMomentumLevels,
  calculateBreakdownLevels,
  calculateMomentumBearishLevels,
  calculateFailedResistanceLevels,
  calculateCompressionBearishLevels,
  applyGuardrails,
  roundToTick
};