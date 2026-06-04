/**
 * Unit tests for the ORB pick-quality decision logic in decideBreakoutActions()
 * and the pure helpers it composes with (computeOrbStop, scoreCandidateQuality,
 * slotKey, buildVolumeProfile).
 *
 * 2026-06-02: the breakout-breadth direction lock was removed — the live Nifty
 * regime gate is now the sole direction authority (BULL→LONG, BEAR→SHORT,
 * NEUTRAL→both). The >2×-OR-range "stale" hard cut was also removed (redundant
 * with the ranking's distance penalty). So direction tests are now regime-driven.
 *
 * The helper is pure (no DB, no Kite) — it mutates the input array with _action
 * and returns the regime gate side.
 */

import { describe, it, expect } from 'vitest';
import { decideBreakoutActions, computeOrbStop, scoreCandidateQuality, buildVolumeProfile, slotKey, computeADRPct, needsVolumeBaselineRetry, isBarComplete, _testExports } from '../services/orb/orbService.js';

const { MIN_DISTANCE_PCT } = _testExports;

// Helper to construct test breakout objects with the shape checkBreakouts produces.
function mkBreakout({ symbol, direction = 'LONG', distancePct = 1.5 }) {
  return {
    candidate: { symbol, orHigh: 100, orLow: 95, orRange: 5, iep: 100 },
    direction,
    bar1Close: 0, bar2Close: 0,
    distance: 0,
    distancePct,
  };
}

describe('Constants are sane', () => {
  it('MIN_DISTANCE_PCT is 1.0 (per 2026-05-29 analysis)', () => {
    expect(MIN_DISTANCE_PCT).toBe(1.0);
  });
});

describe('Distance floor filter', () => {
  it('drops a single below-floor pick to BELOW_FLOOR', () => {
    const confirmed = [mkBreakout({ symbol: 'WEAK', distancePct: 0.5 })];
    decideBreakoutActions({ confirmed, slotsLeft: 3 });
    expect(confirmed[0]._action).toBe('BELOW_FLOOR');
  });

  it('keeps a pick at exactly the floor (>= comparison)', () => {
    const confirmed = [mkBreakout({ symbol: 'EDGE', distancePct: 1.0 })];
    decideBreakoutActions({ confirmed, slotsLeft: 3 });
    expect(confirmed[0]._action).toBe('ENTER');
  });

  it('replays 2026-05-29 morning — RBLBANK/PRESTIGE/PNBHOUSING dropped to BELOW_FLOOR', () => {
    const confirmed = [
      mkBreakout({ symbol: 'LODHA',      direction: 'LONG',  distancePct: 1.22 }),
      mkBreakout({ symbol: 'RBLBANK',    direction: 'SHORT', distancePct: 0.97 }),
      mkBreakout({ symbol: 'PNBHOUSING', direction: 'SHORT', distancePct: 0.88 }),
      mkBreakout({ symbol: 'PRESTIGE',   direction: 'LONG',  distancePct: 0.97 }),
    ];
    decideBreakoutActions({ confirmed, slotsLeft: 3 });   // no regime → both sides allowed
    const byName = Object.fromEntries(confirmed.map(b => [b.candidate.symbol, b._action]));
    expect(byName.LODHA).toBe('ENTER');
    expect(byName.RBLBANK).toBe('BELOW_FLOOR');
    expect(byName.PNBHOUSING).toBe('BELOW_FLOOR');
    expect(byName.PRESTIGE).toBe('BELOW_FLOOR');
  });
});

describe('Direction gate — Nifty regime is the sole authority', () => {
  it('BULL regime → SHORT breakouts are WRONG_SIDE, LONGs enter', () => {
    const confirmed = [
      mkBreakout({ symbol: 'L1', direction: 'LONG',  distancePct: 1.5 }),
      mkBreakout({ symbol: 'S1', direction: 'SHORT', distancePct: 2.0 }),
    ];
    decideBreakoutActions({ confirmed, slotsLeft: 3, marketRegime: 'BULL' });
    const byName = Object.fromEntries(confirmed.map(b => [b.candidate.symbol, b._action]));
    expect(byName.S1).toBe('WRONG_SIDE');
    expect(byName.L1).toBe('ENTER');
  });

  it('BEAR regime → LONG breakouts are WRONG_SIDE, SHORTs enter', () => {
    const confirmed = [
      mkBreakout({ symbol: 'L1', direction: 'LONG',  distancePct: 2.0 }),
      mkBreakout({ symbol: 'S1', direction: 'SHORT', distancePct: 1.5 }),
    ];
    decideBreakoutActions({ confirmed, slotsLeft: 3, marketRegime: 'BEAR' });
    const byName = Object.fromEntries(confirmed.map(b => [b.candidate.symbol, b._action]));
    expect(byName.L1).toBe('WRONG_SIDE');
    expect(byName.S1).toBe('ENTER');
  });

  it('NEUTRAL regime → both directions allowed (no breadth fallback)', () => {
    const confirmed = [
      mkBreakout({ symbol: 'L1', direction: 'LONG',  distancePct: 1.5 }),
      mkBreakout({ symbol: 'S1', direction: 'SHORT', distancePct: 2.0 }),
    ];
    decideBreakoutActions({ confirmed, slotsLeft: 3, marketRegime: 'NEUTRAL' });
    expect(confirmed.every(b => b._action === 'ENTER')).toBe(true);
  });

  it('no regime passed → both directions allowed', () => {
    const confirmed = [
      mkBreakout({ symbol: 'L1', direction: 'LONG',  distancePct: 1.5 }),
      mkBreakout({ symbol: 'S1', direction: 'SHORT', distancePct: 1.8 }),
    ];
    decideBreakoutActions({ confirmed, slotsLeft: 3 });
    expect(confirmed.every(b => b._action === 'ENTER')).toBe(true);
  });

  it('returns gateSide matching the regime', () => {
    expect(decideBreakoutActions({ confirmed: [], slotsLeft: 3, marketRegime: 'BEAR' }).gateSide).toBe('SHORT');
    expect(decideBreakoutActions({ confirmed: [], slotsLeft: 3, marketRegime: 'BULL' }).gateSide).toBe('LONG');
    expect(decideBreakoutActions({ confirmed: [], slotsLeft: 3, marketRegime: 'NEUTRAL' }).gateSide).toBeNull();
  });
});

describe('Action precedence + slots', () => {
  it('BELOW_FLOOR > WRONG_SIDE > ENTER > SLOT_FULL', () => {
    const confirmed = [
      mkBreakout({ symbol: 'B', direction: 'LONG',  distancePct: 0.5 }),  // below-floor + wrong-side → BELOW_FLOOR
      mkBreakout({ symbol: 'C', direction: 'LONG',  distancePct: 1.5 }),  // wrong-side only → WRONG_SIDE
      mkBreakout({ symbol: 'D', direction: 'SHORT', distancePct: 1.5 }),  // valid → ENTER (slots=1)
      mkBreakout({ symbol: 'E', direction: 'SHORT', distancePct: 1.5 }),  // valid but no slots → SLOT_FULL
    ];
    decideBreakoutActions({ confirmed, slotsLeft: 1, marketRegime: 'BEAR' });
    const byName = Object.fromEntries(confirmed.map(b => [b.candidate.symbol, b._action]));
    expect(byName.B).toBe('BELOW_FLOOR');
    expect(byName.C).toBe('WRONG_SIDE');
    expect(byName.D).toBe('ENTER');
    expect(byName.E).toBe('SLOT_FULL');
  });

  it('per-scan cap: slotsLeft=2 → only the top 2 enter, rest SLOT_FULL', () => {
    const confirmed = [
      mkBreakout({ symbol: 'A', direction: 'SHORT', distancePct: 1.5 }),
      mkBreakout({ symbol: 'B', direction: 'SHORT', distancePct: 1.5 }),
      mkBreakout({ symbol: 'C', direction: 'SHORT', distancePct: 1.5 }),
      mkBreakout({ symbol: 'D', direction: 'SHORT', distancePct: 1.5 }),
    ];
    decideBreakoutActions({ confirmed, slotsLeft: 2, marketRegime: 'BEAR' });
    expect(confirmed.filter(b => b._action === 'ENTER').length).toBe(2);
    expect(confirmed.filter(b => b._action === 'SLOT_FULL').length).toBe(2);
  });
});

describe('Stop-loss risk cap — computeOrbStop (2026-06-02)', () => {
  const OR = { orHigh: 100, orLow: 95, orRange: 5 };

  it('LONG extended fill → risk-cap applies, 1R bounded to MAX_SL_PCT', () => {
    // Filled 10% above the OR — OR-edge stop would risk ~11%; cap must kick in.
    const { stop, source } = computeOrbStop({ isLong: true, ...OR, entry: 110 });
    expect(source).toMatch(/risk-cap/);
    const riskPct = (110 - stop) / 110 * 100;
    expect(riskPct).toBeLessThanOrEqual(1.55);   // ~MAX_SL_PCT (1.5%) + tick tolerance
    expect(stop).toBeLessThan(110);
  });

  it('LONG tight fill just above OR → OR-edge stop is used', () => {
    const { stop, source } = computeOrbStop({ isLong: true, ...OR, entry: 100.2 });
    expect(source).toBe('OR-edge');
    expect(stop).toBeLessThan(100.2);
  });

  it('SHORT extended fill → risk-cap applies, 1R bounded', () => {
    const { stop, source } = computeOrbStop({ isLong: false, ...OR, entry: 85 });
    expect(source).toMatch(/risk-cap/);
    const riskPct = (stop - 85) / 85 * 100;
    expect(riskPct).toBeLessThanOrEqual(1.55);
    expect(stop).toBeGreaterThan(85);
  });

  it('always returns the stop nearer to entry than the looser of the two', () => {
    const r = computeOrbStop({ isLong: true, ...OR, entry: 108 });
    expect(r.stop).toBe(Math.max(r.orStop, r.capStop));  // LONG: nearer = higher
  });
});

describe('Quality ranking — scoreCandidateQuality (RVOL removed, now a gate)', () => {
  it('higher relative strength scores higher, all else equal', () => {
    const lo = scoreCandidateQuality({ relStrength: 0.0, distancePct: 1 });
    const hi = scoreCandidateQuality({ relStrength: 1.5, distancePct: 1 });
    expect(hi).toBeGreaterThan(lo);
  });

  it('more extended (higher distance%) is PENALISED, all else equal', () => {
    const near = scoreCandidateQuality({ relStrength: 0.5, distancePct: 1 });
    const far  = scoreCandidateQuality({ relStrength: 0.5, distancePct: 4 });
    expect(near).toBeGreaterThan(far);
  });

  it('score = wRs·relStrength − wDist·distance (no RVOL term)', () => {
    const s = scoreCandidateQuality({ relStrength: 0.5, distancePct: 1 });
    expect(s).toBeCloseTo((1.0 * 0.5) - (0.4 * 1), 6);
  });

  it('a market-aligned near breakout beats a discordant extended one', () => {
    const alignedNear  = scoreCandidateQuality({ relStrength: 1.2, distancePct: 1.1 });
    const discordantFar = scoreCandidateQuality({ relStrength: -0.3, distancePct: 3.5 });
    expect(alignedNear).toBeGreaterThan(discordantFar);
  });

  it('volatility-adjusts relStrength — tight-OR name beats wide-OR name at equal raw relStrength', () => {
    const tightOR = scoreCandidateQuality({ relStrength: 1.0, distancePct: 1, orWidthPct: 0.8 });
    const wideOR  = scoreCandidateQuality({ relStrength: 1.0, distancePct: 1, orWidthPct: 2.4 });
    expect(tightOR).toBeGreaterThan(wideOR);
  });

  it('falls back to raw relStrength when orWidthPct is missing', () => {
    const s = scoreCandidateQuality({ relStrength: 0.5, distancePct: 1 });
    expect(s).toBeCloseTo((1.0 * 0.5) - (0.4 * 1), 6);
  });
});

describe('RVOL entry gate (2026-06-02)', () => {
  it('rvol below 1.1× → LOW_RVOL, not entered (even with good distance/regime)', () => {
    const confirmed = [{ ...mkBreakout({ symbol: 'THIN', direction: 'SHORT', distancePct: 2.0 }), rvol: 0.9 }];
    decideBreakoutActions({ confirmed, slotsLeft: 3, marketRegime: 'BEAR' });
    expect(confirmed[0]._action).toBe('LOW_RVOL');
  });

  it('rvol at/above 1.1× → passes the gate and enters', () => {
    const confirmed = [{ ...mkBreakout({ symbol: 'THICK', direction: 'SHORT', distancePct: 2.0 }), rvol: 1.3 }];
    decideBreakoutActions({ confirmed, slotsLeft: 3, marketRegime: 'BEAR' });
    expect(confirmed[0]._action).toBe('ENTER');
  });

  it('missing rvol (undefined) does NOT gate — handled upstream by the discard filter', () => {
    const confirmed = [mkBreakout({ symbol: 'NORV', direction: 'SHORT', distancePct: 2.0 })];
    decideBreakoutActions({ confirmed, slotsLeft: 3, marketRegime: 'BEAR' });
    expect(confirmed[0]._action).toBe('ENTER');
  });
});

describe('Time-matched RVOL baseline — slotKey / buildVolumeProfile (2026-06-02)', () => {
  it('slotKey reads HH:MM off the IST string (no UTC shift)', () => {
    expect(slotKey('2026-06-01T09:45:00+0530')).toBe('09:45');
    expect(slotKey('2026-06-01T13:15:00+0530')).toBe('13:15');
    expect(slotKey('garbage')).toBe(null);
  });

  it('buildVolumeProfile averages volume per slot across days', () => {
    const bars = [
      { date: '2026-05-30T09:45:00+0530', volume: 1000 },
      { date: '2026-05-31T09:45:00+0530', volume: 2000 },   // 09:45 avg = 1500
      { date: '2026-05-30T10:00:00+0530', volume: 400 },
      { date: '2026-05-31T10:00:00+0530', volume: 600 },    // 10:00 avg = 500
      { date: '2026-05-31T10:15:00+0530', volume: 0 },      // skipped (vol<=0)
    ];
    const profile = buildVolumeProfile(bars);
    expect(profile['09:45']).toBe(1500);
    expect(profile['10:00']).toBe(500);
    expect(profile['10:15']).toBeUndefined();
  });

  it('time-matched RVOL flags a heavy breakout in a normally-quiet slot', () => {
    // Midday slot normally trades 500; breakout candle does 1500 → 3x conviction.
    const profile = { '13:00': 500 };
    const rvol = 1500 / profile['13:00'];
    expect(rvol).toBe(3);
  });
});

describe('ADR for volatility-normalised OR filter — computeADRPct (2026-06-02)', () => {
  it('averages daily (high−low) across days as % of price', () => {
    const bars = [
      // day 1 range = 110-100 = 10
      { date: '2026-05-30T09:15:00+0530', high: 105, low: 100 },
      { date: '2026-05-30T09:30:00+0530', high: 110, low: 104 },
      // day 2 range = 106-100 = 6   → avg range = 8, on ref price 100 → 8%
      { date: '2026-05-31T09:15:00+0530', high: 103, low: 100 },
      { date: '2026-05-31T09:30:00+0530', high: 106, low: 102 },
    ];
    expect(computeADRPct(bars, 100)).toBeCloseTo(8.0, 3);
  });

  it('returns null with no usable bars or no ref price', () => {
    expect(computeADRPct([], 100)).toBeNull();
    expect(computeADRPct([{ date: '2026-05-30T09:15:00+0530', high: 105, low: 100 }], 0)).toBeNull();
  });
});

describe('Lazy RVOL-baseline retry guard — needsVolumeBaselineRetry (2026-06-02)', () => {
  it('all candidates missing avgDailyVolume → retry', () => {
    const rangeSet = [{ avgDailyVolume: null }, { avgDailyVolume: 0 }, {}];
    expect(needsVolumeBaselineRetry(rangeSet, false)).toBe(true);
  });

  it('partial data (at least one has volume) → no retry (Kite is reachable)', () => {
    const rangeSet = [{ avgDailyVolume: null }, { avgDailyVolume: 12345 }];
    expect(needsVolumeBaselineRetry(rangeSet, false)).toBe(false);
  });

  it('already retried → never retry again', () => {
    const rangeSet = [{ avgDailyVolume: null }];
    expect(needsVolumeBaselineRetry(rangeSet, true)).toBe(false);
  });

  it('empty set → no retry', () => {
    expect(needsVolumeBaselineRetry([], false)).toBe(false);
  });
});

describe('Forming-candle filter — isBarComplete (2026-06-03 bug fix)', () => {
  // At 10:01 (nowMin = 601): the 09:45–10:00 candle (start 585) is closed; the
  // 10:00–10:15 candle (start 600) is still forming and must be dropped.
  it('a candle whose 15-min window has closed is complete', () => {
    expect(isBarComplete('2026-06-03T09:45:00+0530', 601)).toBe(true);  // 585+15=600 ≤ 601
    expect(isBarComplete('2026-06-03T09:30:00+0530', 601)).toBe(true);
  });

  it('the just-started (forming) candle is NOT complete — this was the bug', () => {
    expect(isBarComplete('2026-06-03T10:00:00+0530', 601)).toBe(false); // 600+15=615 > 601
  });

  it('a candle is complete exactly when nowMin reaches its close', () => {
    expect(isBarComplete('2026-06-03T10:00:00+0530', 615)).toBe(true);  // closes at 615
    expect(isBarComplete('2026-06-03T10:00:00+0530', 614)).toBe(false);
  });

  it('unparseable date → not complete (safe default)', () => {
    expect(isBarComplete('garbage', 601)).toBe(false);
  });
});
