/**
 * Weekly Levels Calculator
 *
 * Research-backed Entry/Target/StopLoss for weekly swing picks.
 * Uses percentage-based structural levels instead of ATR buffers.
 *
 * A+ Momentum: entry = fridayHigh × 1.005, stop = max(ema20, weeklyS1) × 0.997
 * Pullback:    entry = fridayHigh × 1.001, stop = max(fridayLow, ema20) × 0.997
 *
 * ATR is NOT used for entry/stop/target (kept for scoring & position sizing only).
 * Guardrails from engine/scanLevels.js are reused for validation.
 */

import { round2, isNum } from '../../engine/helpers.js';
import scanLevels, { roundToTick } from '../../engine/scanLevels.js';

const TAG = '[WEEKLY_LEVELS]';

// Re-export for convenience
export { roundToTick };

// ═══════════════════════════════════════════════════════════════════════════════
// PARTIAL BOOKING (T1) — same logic as engine, inlined for independence
// Priority: dailyR1 → midpoint(entry, T2)
// Must be between entry + 2% buffer and T2 - 5% buffer
// ═══════════════════════════════════════════════════════════════════════════════

function calculatePartialBooking(entry, target2, data) {
  const { dailyR1 } = data;
  const minLevel = entry * 1.02;
  const maxLevel = target2 * 0.95;

  // Daily R1 — nearest overhead level for partial booking
  if (isNum(dailyR1) && dailyR1 > minLevel && dailyR1 < maxLevel) {
    return { target1: roundToTick(dailyR1), target1Basis: 'daily_r1' };
  }

  // Midpoint — always works
  const mid = entry + (target2 - entry) * 0.5;
  return { target1: roundToTick(mid), target1Basis: 'midpoint' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// A+ MOMENTUM TARGET WATERFALL
// Weekly R1 → Weekly R2 → entry × 1.03 (3% fallback)
// T3: Weekly R2 (if not used as T2) → entry × 1.05
// ═══════════════════════════════════════════════════════════════════════════════

function findAPlusMomentumTargets(entry, data) {
  const { weeklyR1, weeklyR2 } = data;

  console.log(`${TAG}   TARGET WATERFALL (A+ Momentum):`);
  console.log(`${TAG}     Available levels: weeklyR1=${round2(weeklyR1)}, weeklyR2=${round2(weeklyR2)}`);

  let target2, target2Basis, target3, t2UsedLevel;

  // T2 waterfall
  if (isNum(weeklyR1) && weeklyR1 > entry) {
    target2 = weeklyR1;
    target2Basis = 'weekly_r1';
    t2UsedLevel = 'weeklyR1';
    console.log(`${TAG}     T2: weeklyR1 ${round2(weeklyR1)} > entry ${round2(entry)} -> SELECTED`);
  } else if (isNum(weeklyR2) && weeklyR2 > entry) {
    target2 = weeklyR2;
    target2Basis = 'weekly_r2';
    t2UsedLevel = 'weeklyR2';
    console.log(`${TAG}     T2: weeklyR1 skipped (${!isNum(weeklyR1) ? 'missing' : round2(weeklyR1) + ' <= entry'}), weeklyR2 ${round2(weeklyR2)} -> SELECTED`);
  } else {
    target2 = roundToTick(entry * 1.03);
    target2Basis = 'pct_3_fallback';
    t2UsedLevel = 'fallback';
    console.log(`${TAG}     T2: No pivot above entry -> 3% fallback = ${round2(target2)}`);
  }

  // T3 waterfall: next unused level → entry × 1.05
  if (t2UsedLevel === 'weeklyR1' && isNum(weeklyR2) && weeklyR2 > target2) {
    target3 = weeklyR2;
    console.log(`${TAG}     T3: weeklyR2 ${round2(weeklyR2)} (next unused) -> SELECTED`);
  } else {
    target3 = roundToTick(entry * 1.05);
    console.log(`${TAG}     T3: 5% extension = ${round2(target3)}`);
  }

  return { target2: roundToTick(target2), target2Basis, target3: roundToTick(target3) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PULLBACK TARGET WATERFALL
// high20D → Weekly R1 → Weekly R2 → null (reject if no viable target)
// T3: next unused from Weekly R1 → Weekly R2 → 52W High
// ═══════════════════════════════════════════════════════════════════════════════

function findPullbackTargets(entry, data) {
  const { high20D, weeklyR1, weeklyR2, high52W } = data;

  console.log(`${TAG}   TARGET WATERFALL (Pullback):`);
  console.log(`${TAG}     Available levels: high20D=${round2(high20D)}, weeklyR1=${round2(weeklyR1)}, weeklyR2=${round2(weeklyR2)}, high52W=${round2(high52W)}`);

  let target2, target2Basis, t2UsedLevel;

  // T2 waterfall
  if (isNum(high20D) && high20D > entry) {
    target2 = high20D;
    target2Basis = 'high_20d';
    t2UsedLevel = 'high20D';
    console.log(`${TAG}     T2: high20D ${round2(high20D)} > entry ${round2(entry)} -> SELECTED`);
  } else if (isNum(weeklyR1) && weeklyR1 > entry) {
    target2 = weeklyR1;
    target2Basis = 'weekly_r1';
    t2UsedLevel = 'weeklyR1';
    console.log(`${TAG}     T2: high20D skipped (${!isNum(high20D) ? 'missing' : round2(high20D) + ' <= entry'}), weeklyR1 ${round2(weeklyR1)} -> SELECTED`);
  } else if (isNum(weeklyR2) && weeklyR2 > entry) {
    target2 = weeklyR2;
    target2Basis = 'weekly_r2';
    t2UsedLevel = 'weeklyR2';
    console.log(`${TAG}     T2: high20D & weeklyR1 skipped, weeklyR2 ${round2(weeklyR2)} -> SELECTED`);
  } else {
    // No viable target — reject
    console.log(`${TAG}     T2: ALL levels below entry or missing -> REJECTED`);
    return null;
  }

  // T3 waterfall: next unused level from Weekly R1 → Weekly R2 → 52W High
  const t3Candidates = [];
  if (t2UsedLevel !== 'weeklyR1' && isNum(weeklyR1) && weeklyR1 > target2) t3Candidates.push({ value: weeklyR1, basis: 'weeklyR1' });
  if (t2UsedLevel !== 'weeklyR2' && isNum(weeklyR2) && weeklyR2 > target2) t3Candidates.push({ value: weeklyR2, basis: 'weeklyR2' });
  if (isNum(high52W) && high52W > target2) t3Candidates.push({ value: high52W, basis: 'high52W' });

  const target3 = t3Candidates.length > 0 ? roundToTick(t3Candidates[0].value) : null;
  console.log(`${TAG}     T3: ${t3Candidates.length > 0 ? t3Candidates[0].basis + ' = ' + round2(target3) : 'none available'}`);

  return { target2: roundToTick(target2), target2Basis, target3 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIME RULES — weekly-specific entry confirmation and holding rules
// ═══════════════════════════════════════════════════════════════════════════════

function getWeeklyTimeRules(archetype) {
  if (archetype === '52w_breakout') {
    return {
      entryConfirmation: 'close_above',
      entryWindowDays: 3,
      maxHoldDays: 5,
      weekEndRule: 'trail_or_exit',
      t1BookingPct: 50,
      postT1Stop: 'move_to_entry'
    };
  }

  // Pullback — conservative, buy_above only
  return {
    entryConfirmation: 'close_above',
    entryWindowDays: 3,
    maxHoldDays: 5,
    weekEndRule: 'exit_if_no_t1',
    t1BookingPct: 50,
    postT1Stop: 'move_to_entry'
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// A+ MOMENTUM LEVELS (52W Breakout)
// ═══════════════════════════════════════════════════════════════════════════════

function calculateWeeklyAPlusMomentumLevels(data) {
  const { ema20, fridayHigh, fridayClose, weeklyS1, dailyR1, atr } = data;

  console.log(`${TAG} ── A+ MOMENTUM LEVEL CALCULATION ──`);
  console.log(`${TAG}   INPUT DATA:`);
  console.log(`${TAG}     fridayHigh=${round2(fridayHigh)}, fridayClose=${round2(fridayClose)}, ema20=${round2(ema20)}`);
  console.log(`${TAG}     weeklyS1=${round2(weeklyS1)}, dailyR1=${round2(dailyR1)}, atr=${round2(atr)}`);

  if (!isNum(fridayHigh) || fridayHigh <= 0) {
    console.log(`${TAG}   REJECTED: Friday high missing/invalid`);
    return { valid: false, reason: 'Friday high required for A+ momentum entry' };
  }

  if (!isNum(ema20) || ema20 <= 0) {
    console.log(`${TAG}   REJECTED: EMA20 missing/invalid`);
    return { valid: false, reason: 'EMA20 required for A+ momentum stop' };
  }

  // ENTRY: fridayHigh × 1.005 — "Buy when price exceeds 52W high by 0.5%"
  const entry = roundToTick(fridayHigh * 1.005);
  console.log(`${TAG}   ENTRY: fridayHigh(${round2(fridayHigh)}) x 1.005 = ${round2(entry)}`);

  // Entry range: 1% band for intraday swings
  const entryRange = [entry, roundToTick(entry * 1.01)];
  console.log(`${TAG}   ENTRY RANGE: [${round2(entryRange[0])}, ${round2(entryRange[1])}] (1% band)`);

  // STOP: max(ema20, weeklyS1) × 0.997 — EMA20 = trend, Weekly S1 = floor, 0.3% buffer
  const stopBase = isNum(weeklyS1) && weeklyS1 > 0
    ? Math.max(ema20, weeklyS1)
    : ema20;
  let stop = roundToTick(stopBase * 0.997);
  console.log(`${TAG}   STOP: max(ema20=${round2(ema20)}, weeklyS1=${round2(weeklyS1)}) = ${round2(stopBase)} x 0.997 = ${round2(stop)}`);

  // Stop cap: entry × 0.985 — reject if stop is wider than 1.5%
  const maxStop = roundToTick(entry * 0.985);
  if (stop < maxStop) {
    console.log(`${TAG}   STOP CAP: stop ${round2(stop)} < maxStop(entry x 0.985 = ${round2(maxStop)}) -> capped to ${round2(maxStop)}`);
    stop = maxStop;
  } else {
    console.log(`${TAG}   STOP CAP: stop ${round2(stop)} >= maxStop ${round2(maxStop)} -> no cap needed`);
  }

  const riskPct = ((entry - stop) / entry * 100);
  console.log(`${TAG}   RISK: entry(${round2(entry)}) - stop(${round2(stop)}) = ${round2(entry - stop)} (${round2(riskPct)}%)`);

  // TARGETS: Weekly R1 → Weekly R2 → entry × 1.03
  const targets = findAPlusMomentumTargets(entry, data);

  // Distance from EMA20 for context
  const distanceFromEMA = isNum(fridayClose) && isNum(ema20)
    ? ((fridayClose - ema20) / ema20) * 100
    : 0;

  return {
    valid: true,
    mode: 'A_PLUS_MOMENTUM',
    archetype: '52w_breakout',
    entry,
    entry_basis: '52w_high_pct',
    entryRange,
    stop,
    target: targets.target2,
    target3: targets.target3,
    target2_basis: targets.target2Basis,
    dailyR1Check: isNum(dailyR1) ? dailyR1 : null,
    entryType: 'buy_above',
    reason: `A+ Momentum (52W Breakout): Entry at fridayHigh×1.005 = ${round2(entry)}, ` +
            `Stop at max(EMA20,S1)×0.997 = ${round2(stop)}, ` +
            `${round2(distanceFromEMA)}% above EMA20. ` +
            `T2: ${targets.target2Basis} = ${round2(targets.target2)}`
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PULLBACK LEVELS (EMA20 Retest)
// No aggressive mode — always buy_above, always conservative
// ═══════════════════════════════════════════════════════════════════════════════

function calculateWeeklyPullbackLevels(data) {
  const { ema20, fridayHigh, fridayLow, dailyR1 } = data;

  console.log(`${TAG} ── PULLBACK LEVEL CALCULATION ──`);
  console.log(`${TAG}   INPUT DATA:`);
  console.log(`${TAG}     fridayHigh=${round2(fridayHigh)}, fridayLow=${round2(fridayLow)}, ema20=${round2(ema20)}`);
  console.log(`${TAG}     dailyR1=${round2(dailyR1)}, high20D=${round2(data.high20D)}, weeklyR1=${round2(data.weeklyR1)}, weeklyR2=${round2(data.weeklyR2)}, high52W=${round2(data.high52W)}`);

  if (!isNum(fridayHigh) || fridayHigh <= 0) {
    console.log(`${TAG}   REJECTED: Friday high missing/invalid`);
    return { valid: false, reason: 'Friday high required for pullback entry' };
  }

  if (!isNum(ema20) || ema20 <= 0) {
    console.log(`${TAG}   REJECTED: EMA20 missing/invalid`);
    return { valid: false, reason: 'EMA20 required for pullback stop' };
  }

  // ENTRY: fridayHigh × 1.001 — "Break above high of pullback candle"
  const entry = roundToTick(fridayHigh * 1.001);
  console.log(`${TAG}   ENTRY: fridayHigh(${round2(fridayHigh)}) x 1.001 = ${round2(entry)}`);

  // Entry range: 0.5% slippage band
  const entryRange = [entry, roundToTick(entry * 1.005)];
  console.log(`${TAG}   ENTRY RANGE: [${round2(entryRange[0])}, ${round2(entryRange[1])}] (0.5% band)`);

  // STOP: max(fridayLow, ema20) × 0.997 — "Below swing low"; EMA20 break = trend invalid
  const stopBase = isNum(fridayLow) && fridayLow > 0
    ? Math.max(fridayLow, ema20)
    : ema20;
  const stop = roundToTick(stopBase * 0.997);
  console.log(`${TAG}   STOP: max(fridayLow=${round2(fridayLow)}, ema20=${round2(ema20)}) = ${round2(stopBase)} x 0.997 = ${round2(stop)}`);

  const riskPct = ((entry - stop) / entry * 100);
  console.log(`${TAG}   RISK: entry(${round2(entry)}) - stop(${round2(stop)}) = ${round2(entry - stop)} (${round2(riskPct)}%)`);

  // TARGETS: high20D → Weekly R1 → Weekly R2 → reject
  const targets = findPullbackTargets(entry, data);

  if (!targets) {
    console.log(`${TAG}   REJECTED: No viable structural target`);
    return {
      valid: false,
      reason: 'Pullback REJECTED: No viable structural target above entry (high20D, Weekly R1, Weekly R2 all below entry or missing)'
    };
  }

  return {
    valid: true,
    mode: 'PULLBACK_CONSERVATIVE',
    archetype: 'pullback',
    entry,
    entry_basis: 'friday_high_pct',
    entryRange,
    stop,
    target: targets.target2,
    target3: targets.target3,
    target2_basis: targets.target2Basis,
    dailyR1Check: isNum(dailyR1) ? dailyR1 : null,
    entryType: 'buy_above',
    reason: `Pullback (EMA20 Retest): Entry at fridayHigh×1.001 = ${round2(entry)}, ` +
            `Stop at max(fridayLow,EMA20)×0.997 = ${round2(stop)}. ` +
            `T2: ${targets.target2Basis} = ${round2(targets.target2)}`
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTER — main entry point, matches calculateTradingLevels signature
// Returns the same shape as engine/scanLevels.calculateTradingLevels()
// ═══════════════════════════════════════════════════════════════════════════════

export function calculateWeeklyTradingLevels(scanType, data) {
  console.log(`${TAG} ════════════════════════════════════════════════════════════`);
  console.log(`${TAG} calculateWeeklyTradingLevels called: scanType="${scanType}"`);

  // Validate required data
  if (!data) {
    console.log(`${TAG} REJECTED: No data provided`);
    return { valid: false, reason: 'No data provided' };
  }

  const { ema20, fridayClose, atr } = data;

  if (!isNum(ema20) || ema20 <= 0) {
    console.log(`${TAG} REJECTED: EMA20 missing or invalid`);
    return { valid: false, reason: 'EMA20 missing or invalid' };
  }

  if (!isNum(fridayClose) || fridayClose <= 0) {
    console.log(`${TAG} REJECTED: Friday close missing or invalid`);
    return { valid: false, reason: 'Friday close missing or invalid' };
  }

  // Route to scan-specific calculator
  let result;

  switch (scanType?.toLowerCase()) {
    case 'a_plus_momentum':
      result = calculateWeeklyAPlusMomentumLevels(data);
      break;

    case 'pullback':
      result = calculateWeeklyPullbackLevels(data);
      break;

    default:
      console.log(`${TAG} Unknown weekly scan type "${scanType}" -> falling back to engine`);
      return scanLevels.calculateTradingLevels(scanType, data);
  }

  if (!result.valid) {
    console.log(`${TAG} Calculation returned invalid: ${result.reason}`);
    return result;
  }

  // Apply guardrails (reuse engine validation)
  console.log(`${TAG}   GUARDRAILS: entry=${round2(result.entry)}, stop=${round2(result.stop)}, target=${round2(result.target)}`);
  const guarded = scanLevels.applyGuardrails(result.entry, result.stop, result.target, atr, scanType);

  if (!guarded.valid) {
    console.log(`${TAG}   GUARDRAILS REJECTED: ${guarded.reason}`);
    return {
      ...guarded,
      scanType,
      mode: result.mode,
      reason: guarded.reason,
      originalReason: result.reason
    };
  }

  console.log(`${TAG}   GUARDRAILS PASSED: R:R=${guarded.riskReward}:1, risk=${guarded.riskPercent}%, reward=${guarded.rewardPercent}%`);
  if (guarded.adjustments) {
    console.log(`${TAG}   GUARDRAILS ADJUSTMENTS: ${guarded.adjustments.join(', ')}`);
  }

  // Calculate T1 (partial booking)
  const { target1, target1Basis } = calculatePartialBooking(
    roundToTick(guarded.entry),
    roundToTick(guarded.target),
    data
  );
  console.log(`${TAG}   T1 (partial booking): ${round2(target1)} (basis: ${target1Basis})`);

  // Time rules
  const timeRules = getWeeklyTimeRules(result.archetype);

  console.log(`${TAG}   FINAL LEVELS:`);
  console.log(`${TAG}     Entry: ${roundToTick(guarded.entry)} [${result.entryType}]`);
  console.log(`${TAG}     Stop:  ${roundToTick(guarded.stop)}`);
  console.log(`${TAG}     T1:    ${round2(target1)} (${target1Basis})`);
  console.log(`${TAG}     T2:    ${roundToTick(guarded.target)} (${result.target2_basis})`);
  console.log(`${TAG}     T3:    ${result.target3 ? roundToTick(result.target3) : 'none'}`);
  console.log(`${TAG}     R:R:   ${guarded.riskReward}:1 | Risk: ${guarded.riskPercent}% | Reward: ${guarded.rewardPercent}%`);
  console.log(`${TAG} ════════════════════════════════════════════════════════════`);

  return {
    valid: true,
    scanType,
    mode: result.mode,
    entry: roundToTick(guarded.entry),
    entry_basis: result.entry_basis || null,
    entryRange: result.entryRange ? [roundToTick(result.entryRange[0]), roundToTick(result.entryRange[1])] : null,
    stop: roundToTick(guarded.stop),
    target1,
    target1_basis: target1Basis,
    target2: roundToTick(guarded.target),
    target2_basis: result.target2_basis,
    target3: result.target3 ? roundToTick(result.target3) : null,
    dailyR1Check: result.dailyR1Check ? roundToTick(result.dailyR1Check) : null,
    entryType: result.entryType,
    archetype: result.archetype,
    reason: result.reason,
    riskReward: parseFloat(guarded.riskReward),
    riskPercent: parseFloat(guarded.riskPercent),
    rewardPercent: parseFloat(guarded.rewardPercent),
    adjustments: guarded.adjustments,
    entryConfirmation: timeRules.entryConfirmation,
    entryWindowDays: timeRules.entryWindowDays,
    maxHoldDays: timeRules.maxHoldDays,
    weekEndRule: timeRules.weekEndRule,
    t1BookingPct: timeRules.t1BookingPct,
    postT1Stop: timeRules.postT1Stop
  };
}

export default {
  calculateWeeklyAPlusMomentumLevels,
  calculateWeeklyPullbackLevels,
  calculateWeeklyTradingLevels,
  roundToTick,
};
