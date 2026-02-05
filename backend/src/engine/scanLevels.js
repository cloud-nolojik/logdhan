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
  return Math.round(price / tick) * tick;
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
  const { weeklyR1, dailyR1 } = data;
  const minLevel = entry * 1.02;   // At least 2% above entry
  const maxLevel = target * 0.95;  // At least 5% below main target

  // Weekly R1 — most common for momentum/breakout scans
  if (isNum(weeklyR1) && weeklyR1 > minLevel && weeklyR1 < maxLevel) {
    return { target1: roundToTick(weeklyR1), target1Basis: 'weekly_r1' };
  }

  // Daily R1 — fallback
  if (isNum(dailyR1) && dailyR1 > minLevel && dailyR1 < maxLevel) {
    return { target1: roundToTick(dailyR1), target1Basis: 'daily_r1' };
  }

  // Midpoint — always works
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
 * so high52W ≈ fridayHigh ≈ entry, making Level 3 dead code for those stocks.
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

  const { atr, ema20, fridayClose } = data;

  if (!isNum(atr) || atr <= 0) {
    return { valid: false, reason: 'ATR missing or invalid' };
  }

  if (!isNum(ema20) || ema20 <= 0) {
    return { valid: false, reason: 'EMA20 missing or invalid' };
  }

  if (!isNum(fridayClose) || fridayClose <= 0) {
    return { valid: false, reason: 'Friday close missing or invalid' };
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
  const { ema20, high20D, fridayHigh, fridayClose, atr, weeklyR1, weeklyR2, high52W, dailyR1 } = data;

  // Use 20D high if available, otherwise Friday high
  const resistanceLevel = isNum(high20D) && high20D > 0 ? high20D : fridayHigh;

  if (!isNum(resistanceLevel) || resistanceLevel <= 0) {
    return { valid: false, reason: 'No resistance level available for breakout' };
  }

  // Entry: Above resistance with buffer for confirmation (0.2 ATR)
  const entry = resistanceLevel + (0.2 * atr);

  // Stop: Below breakout zone or EMA20, whichever is higher (tighter)
  // This protects against failed breakouts
  const breakoutZoneBottom = resistanceLevel * 0.97;
  const stopBase = Math.max(ema20, breakoutZoneBottom);
  const stop = stopBase - (0.1 * atr);

  // Calculate risk first
  const risk = entry - stop;

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET: STRUCTURAL LADDER (Weekly R1 → R2 → 52W High → REJECT)
  // No arbitrary ATR targets - only structural levels where institutions take profit
  // ═══════════════════════════════════════════════════════════════════════════
  const targetResult = findStructuralTarget({
    entry,
    risk,
    weeklyR1,
    weeklyR2,
    high52W,
    atr,
    minRR: 1.5
  });

  // If no structural target gives adequate R:R → REJECT this setup
  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,  // Distinguish missing data from bad R:R
      reason: `Breakout REJECTED: ${targetResult.reason}`
    };
  }

  // Entry range for slippage (0.3 ATR above entry)
  const entryRange = [roundToTick(entry), roundToTick(entry + 0.3 * atr)];

  return {
    valid: true,
    mode: 'BREAKOUT',
    archetype: 'breakout',
    entry,
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
    high20D,
    fridayHigh,
    fridayClose,
    fridayVolume,
    avgVolume20,
    atr,
    rsi,
    weeklyR1,
    weeklyR2,
    dailyR1,
    dailyR2,
    high52W
  } = data;

  // ─────────────────────────────────────────────────────────────────────────
  // DECISION LOGIC: Aggressive vs Conservative
  // ─────────────────────────────────────────────────────────────────────────

  // Rule 1: Distance from EMA20 (most important)
  // If price is within 0.4 ATR of EMA20, it's respecting support
  const distanceATR = Math.abs(fridayClose - ema20) / atr;

  // Rule 2: Volume behavior (if available)
  // Low volume pullback = controlled profit-taking (good)
  // High volume pullback = institutional selling (bad)
  const hasVolumeData = isNum(fridayVolume) && isNum(avgVolume20) && avgVolume20 > 0;
  const volumeRatio = hasVolumeData ? fridayVolume / avgVolume20 : 1.0;

  // Rule 3: Price position relative to EMA20
  // Close above EMA20 = buyers still in control
  const aboveEMA = fridayClose >= ema20;

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

    // Entry range: Slightly above and below EMA20
    entryRange = [roundToTick(ema20 - 0.3 * atr), roundToTick(ema20 + 0.3 * atr)];

    // Stop: Below EMA20 support
    stop = ema20 - (0.6 * atr);

    entryType = 'limit';
    mode = 'PULLBACK_AGGRESSIVE';
    reason = 'Healthy pullback: Price respecting EMA20, RSI cooled, low volume. ' +
             'Safe to buy the dip with limit order.';
  } else {
    // ─────────────────────────────────────────────────────────────────────
    // CONSERVATIVE MODE: Wait for confirmation
    // ─────────────────────────────────────────────────────────────────────

    if (!isNum(fridayHigh) || fridayHigh <= 0) {
      return { valid: false, reason: 'Friday high required for conservative pullback entry' };
    }

    // Entry: Above Friday high = bounce confirmed
    entry = fridayHigh + (0.1 * atr);

    // Entry range for slippage
    entryRange = [roundToTick(entry), roundToTick(entry + 0.3 * atr)];

    // Stop: Below EMA20 support
    stop = ema20 - (0.6 * atr);

    entryType = 'buy_above';
    mode = 'PULLBACK_CONSERVATIVE';
    reason = buildConservativeReason(distanceATR, rsi, fridayClose, ema20, volumeRatio);
  }

  const risk = entry - stop;

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET: STRUCTURAL LADDER for pullbacks
  // Daily R1 → Daily R2 → Weekly R1 → Weekly R2 → 52W High → REJECT
  // Pullbacks are shorter-term, so daily pivots have higher priority
  // ═══════════════════════════════════════════════════════════════════════════
  const targetResult = findPullbackTarget({
    entry,
    risk,
    dailyR1,
    dailyR2,
    weeklyR1,
    weeklyR2,
    high52W,
    minRR: 1.2  // Lower bar for pullbacks (shorter-term)
  });

  // If no structural target gives adequate R:R → REJECT this setup
  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,  // Distinguish missing data from bad R:R
      reason: `Pullback REJECTED: ${targetResult.reason}`
    };
  }

  return {
    valid: true,
    mode,
    archetype: 'pullback',
    entry,
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
         'Entry triggers above Friday high for safety.';
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
  const { ema20, high20D, fridayHigh, fridayClose, atr, weeklyR1, weeklyR2, high52W, dailyR1 } = data;

  if (!isNum(fridayHigh) || fridayHigh <= 0) {
    return { valid: false, reason: 'Friday high required for momentum entry' };
  }

  // Edge case: If close is within 2% of 20D high, this is more breakout than momentum
  const nearBreakout = isNum(high20D) && fridayClose >= high20D * 0.98;

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

  // Entry: Above Friday high for continuation (don't chase)
  const entry = fridayHigh + (0.15 * atr);

  // Entry range for slippage
  const entryRange = [roundToTick(entry), roundToTick(entry + 0.3 * atr)];

  // Stop: Back to EMA20 means momentum lost
  // But also cap at 1.2 ATR from entry (for high-ATR stocks)
  const ema20Stop = ema20 - (0.1 * atr);
  const atrStop = entry - (1.2 * atr);
  const stop = Math.max(ema20Stop, atrStop);

  // Calculate risk first
  const risk = entry - stop;

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET: STRUCTURAL LADDER (Weekly R1 → R2 → 52W High → REJECT)
  // No arbitrary ATR targets - only structural levels
  // ═══════════════════════════════════════════════════════════════════════════
  const targetResult = findStructuralTarget({
    entry,
    risk,
    weeklyR1,
    weeklyR2,
    high52W,
    atr,
    minRR: 1.5
  });

  // If no structural target gives adequate R:R → REJECT this setup
  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,  // Distinguish missing data from bad R:R
      reason: `Momentum REJECTED: ${targetResult.reason}`
    };
  }

  return {
    valid: true,
    mode: 'MOMENTUM',
    archetype: 'trend-follow',
    entry,
    entryRange,
    stop,
    target: targetResult.target2,
    target3: targetResult.target3,
    target2_basis: targetResult.target2_basis,
    dailyR1Check: isNum(dailyR1) ? dailyR1 : null,
    entryType: 'buy_above',
    reason: `Momentum continuation: Stock running ${round2(((fridayClose - ema20) / ema20) * 100)}% above EMA20. ` +
            `Entry above Friday high (${round2(fridayHigh)}) confirms continued buying. ${targetResult.reason}`
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
  const { ema20, high10D, low10D, fridayHigh, fridayLow, atr, weeklyR1, weeklyR2, high52W, dailyR1 } = data;

  if (!isNum(fridayHigh) || !isNum(fridayLow) || fridayHigh <= 0 || fridayLow <= 0) {
    return { valid: false, reason: 'Friday high/low required for consolidation entry' };
  }

  const fridayRange = fridayHigh - fridayLow;

  // Use 10-day range if available, otherwise use Friday range
  const has10DRange = isNum(high10D) && isNum(low10D) && high10D > low10D;

  // Entry: Just above the tight range (small buffer since range is already tight)
  const entry = fridayHigh + (0.1 * atr);

  // Entry range for slippage
  const entryRange = [roundToTick(entry), roundToTick(entry + 0.2 * atr)];

  // Stop: Below the consolidation range (pattern fails if broken)
  const consolidationLow = has10DRange ? Math.min(low10D, fridayLow) : fridayLow;
  const stop = consolidationLow - (0.1 * atr);

  const risk = entry - stop;

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET: STRUCTURAL LADDER (Weekly R1 → R2 → 52W High → REJECT)
  // No arbitrary range expansion targets - only structural levels
  // ═══════════════════════════════════════════════════════════════════════════
  const targetResult = findStructuralTarget({
    entry,
    risk,
    weeklyR1,
    weeklyR2,
    high52W,
    atr,
    minRR: 1.5
  });

  // If no structural target gives adequate R:R → REJECT this setup
  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,  // Distinguish missing data from bad R:R
      reason: `Consolidation REJECTED: ${targetResult.reason}`
    };
  }

  return {
    valid: true,
    mode: 'CONSOLIDATION_BREAKOUT',
    archetype: 'breakout',
    entry,
    entryRange,
    stop,
    target: targetResult.target2,
    target3: targetResult.target3,
    target2_basis: targetResult.target2_basis,
    dailyR1Check: isNum(dailyR1) ? dailyR1 : null,
    entryType: 'buy_above',
    reason: `Consolidation breakout: Tight range (${round2((fridayRange / fridayHigh) * 100)}%) near highs signals energy buildup. ` +
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
 * high_52w ≈ fridayHigh, so entry > high_52w always.
 * Level 0 in findStructuralTarget handles this with ATR extension targets.
 *
 * Strategy: Buy the breakout continuation
 * - Entry: Above Friday high (confirms breakout holds on Monday)
 * - Stop: Below EMA20 (momentum support, capped at 1.5 ATR)
 * - Target: STRUCTURAL LADDER with 52W breakout extension fallback
 *   Weekly R1/R2 may still work if they're above the new high.
 *   If not → ATR extension target (2.5 ATR from entry) since there's no overhead structure.
 */
function calculateAPlusMomentumLevels(data) {
  const { ema20, fridayHigh, fridayClose, atr, weeklyR1, weeklyR2, high52W, dailyR1 } = data;

  if (!isNum(fridayHigh) || fridayHigh <= 0) {
    return { valid: false, reason: 'Friday high required for A+ momentum entry' };
  }

  if (!isNum(ema20) || ema20 <= 0) {
    return { valid: false, reason: 'EMA20 required for A+ momentum stop' };
  }

  // ENTRY: Above Friday high + small buffer for confirmation
  const entry = fridayHigh + (0.15 * atr);

  // Entry range for slippage
  const entryRange = [roundToTick(entry), roundToTick(entry + 0.3 * atr)];

  // STOP: Below EMA20 (momentum support), capped at 1.5 ATR from entry
  const ema20Stop = ema20 - (0.2 * atr);
  const maxStop = entry - (1.5 * atr);
  const stop = Math.max(ema20Stop, maxStop);

  // RISK calculation
  const risk = entry - stop;

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGET: STRUCTURAL LADDER with 52W breakout extension fallback
  // For stocks at new 52W highs, Level 0 provides ATR extension targets
  // since there is no overhead resistance to anchor to.
  // ═══════════════════════════════════════════════════════════════════════════
  const targetResult = findStructuralTarget({
    entry,
    risk,
    weeklyR1,
    weeklyR2,
    high52W,
    atr,
    minRR: 1.5
  });

  // If no structural target gives adequate R:R → REJECT this setup
  if (targetResult.rejected) {
    return {
      valid: false,
      noData: targetResult.noData || false,  // Distinguish missing data from bad R:R
      reason: `A+ Momentum REJECTED: ${targetResult.reason}`
    };
  }

  // Calculate distance from EMA20 for context
  const distanceFromEMA = ((fridayClose - ema20) / ema20) * 100;

  return {
    valid: true,
    mode: 'A_PLUS_MOMENTUM',
    archetype: '52w_breakout',
    entry,
    entryRange,
    stop,
    target: targetResult.target2,         // T2 (main target — from structural ladder or ATR extension)
    target3: targetResult.target3,        // T3 (extension — for trailing, optional)
    target2_basis: targetResult.target2_basis, // 'weekly_r1', 'weekly_r2', '52w_high', or 'atr_extension_52w_breakout'
    dailyR1Check: isNum(dailyR1) ? dailyR1 : null,  // Momentum checkpoint (not a target)
    entryType: 'buy_above',
    reason: `A+ Momentum (52W Breakout): Stock ${round2(distanceFromEMA)}% above EMA20, ` +
            `broke 252-day high with 1.5x+ volume. ` +
            `Entry above ${round2(fridayHigh)} confirms breakout holds. ${targetResult.reason}`
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
  // GUARD B: Stop MUST be below entry (for BUY setups)
  // ─────────────────────────────────────────────────────────────────────────
  if (stop >= entry) {
    return {
      valid: false,
      reason: `Stop (${round2(stop)}) must be below entry (${round2(entry)})`,
      debug: { entry, stop, target }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD C: Target MUST be above entry (for BUY setups)
  // ─────────────────────────────────────────────────────────────────────────
  if (target <= entry) {
    return {
      valid: false,
      reason: `Target (${round2(target)}) must be above entry (${round2(entry)})`,
      debug: { entry, stop, target }
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD D: Maximum risk check (5%) - REJECT, don't adjust
  // ─────────────────────────────────────────────────────────────────────────
  const risk = entry - stop;
  const riskPercent = (risk / entry) * 100;
  const MAX_RISK_PERCENT = 8.0;

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
  // GUARD F: Minimum target (2%) - worth the effort
  // ─────────────────────────────────────────────────────────────────────────
  const reward = target - entry;
  const rewardPercent = (reward / entry) * 100;
  const MIN_TARGET_PERCENT = 2.0;

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
    adjustedTarget = entry * (1 + MAX_TARGET_PERCENT / 100);
    adjustments.push(
      `Target capped from ${round2(rewardPercent)}% to ${MAX_TARGET_PERCENT}% ` +
      `(original structural target: ${round2(target)})`
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GUARD H: Risk-Reward ratio check (minimum 1.2:1)
  // ─────────────────────────────────────────────────────────────────────────
  const adjustedReward = adjustedTarget - entry;
  const riskReward = adjustedReward / risk;
  const MIN_RR = 1.2;

  if (riskReward < MIN_RR) {
    const minimumViableTarget = entry + (risk * 1.5);
    return {
      valid: false,
      reason: `R:R too low: ${round2(riskReward)}:1 (min ${MIN_RR}:1). ` +
              `Risk ${round2(riskPercent)}% vs Reward ${round2((adjustedReward / entry) * 100)}%`,
      currentRR: round2(riskReward),
      suggestedTarget: roundToTick(minimumViableTarget),
      suggestedAction: `Need target >= ${round2(minimumViableTarget)} for viable trade`
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
  applyGuardrails,
  roundToTick
};