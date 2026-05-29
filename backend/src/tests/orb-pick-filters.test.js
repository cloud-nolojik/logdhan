/**
 * Unit tests for the 2026-05-29 ORB pick-quality filters:
 *   1. Min distance% floor — drops breakouts with distance past OR < MIN_DISTANCE_PCT
 *   2. Direction-bias gate — when ≥ BIAS_GATE_MIN_CONFIRMED confirmed signals
 *      and one side is ≥ BIAS_GATE_THRESHOLD_PCT, lock to that side for the day.
 *
 * These tests cover the pure decision helper decideBreakoutActions() which is
 * called from checkBreakouts(). The helper is pure (no DB, no Kite) — it just
 * mutates the input array with _action and returns the new bias.
 *
 * Real-world regression scenario: 2026-05-29.
 *   At 10:01 first scan, 30 confirmed signals: ~25 SHORT, ~5 LONG (83% bear bias).
 *   Three picks were below the 1.0% distance floor (RBLBANK 0.97%, PRESTIGE
 *   0.97%, PNBHOUSING 0.88%) — all lost money. Six LONGs were taken against
 *   the bear tape — CAMS (-176) and ABFRL (-81) dominated the LONG losses.
 */

import { describe, it, expect } from 'vitest';
import { decideBreakoutActions, _testExports } from '../services/orb/orbService.js';

const { MIN_DISTANCE_PCT, BIAS_GATE_MIN_CONFIRMED, BIAS_GATE_THRESHOLD_PCT } = _testExports;

// Helper to construct test breakout objects with the shape checkBreakouts produces.
function mkBreakout({ symbol, direction = 'LONG', distancePct = 1.5, staleFlag = false }) {
  return {
    candidate: { symbol, orHigh: 100, orLow: 95, orRange: 5, iep: 100 },
    direction,
    bar1Close: 0, bar2Close: 0,
    distance: 0,
    distancePct,
    staleFlag,
  };
}

describe('Constants are sane', () => {
  it('MIN_DISTANCE_PCT is 1.0 (per 2026-05-29 analysis)', () => {
    expect(MIN_DISTANCE_PCT).toBe(1.0);
  });
  it('BIAS_GATE_MIN_CONFIRMED is 10', () => {
    expect(BIAS_GATE_MIN_CONFIRMED).toBe(10);
  });
  it('BIAS_GATE_THRESHOLD_PCT is 70', () => {
    expect(BIAS_GATE_THRESHOLD_PCT).toBe(70);
  });
});

describe('Distance floor filter', () => {
  it('drops a single below-floor pick to BELOW_FLOOR', () => {
    const confirmed = [mkBreakout({ symbol: 'WEAK', distancePct: 0.5 })];
    decideBreakoutActions({ confirmed, slotsLeft: 3, existingBias: 'BOTH' });
    expect(confirmed[0]._action).toBe('BELOW_FLOOR');
  });

  it('keeps a pick at exactly the floor (>= comparison)', () => {
    const confirmed = [mkBreakout({ symbol: 'EDGE', distancePct: 1.0 })];
    decideBreakoutActions({ confirmed, slotsLeft: 3, existingBias: 'BOTH' });
    expect(confirmed[0]._action).toBe('ENTER');
  });

  it('replays 2026-05-29 morning — RBLBANK/PRESTIGE/PNBHOUSING dropped to BELOW_FLOOR', () => {
    const confirmed = [
      mkBreakout({ symbol: 'LODHA',      direction: 'LONG',  distancePct: 1.22 }),
      mkBreakout({ symbol: 'RBLBANK',    direction: 'SHORT', distancePct: 0.97 }),
      mkBreakout({ symbol: 'PNBHOUSING', direction: 'SHORT', distancePct: 0.88 }),
      mkBreakout({ symbol: 'PRESTIGE',   direction: 'LONG',  distancePct: 0.97 }),
    ];
    decideBreakoutActions({ confirmed, slotsLeft: 3, existingBias: 'BOTH' });
    const byName = Object.fromEntries(confirmed.map(b => [b.candidate.symbol, b._action]));
    expect(byName.LODHA).toBe('ENTER');
    expect(byName.RBLBANK).toBe('BELOW_FLOOR');
    expect(byName.PNBHOUSING).toBe('BELOW_FLOOR');
    expect(byName.PRESTIGE).toBe('BELOW_FLOOR');
  });

  it('stale-flag takes precedence over below-floor', () => {
    const confirmed = [mkBreakout({ symbol: 'BOTH', distancePct: 0.5, staleFlag: true })];
    decideBreakoutActions({ confirmed, slotsLeft: 3, existingBias: 'BOTH' });
    expect(confirmed[0]._action).toBe('SKIP_STALE');
  });
});

describe('Direction-bias gate', () => {
  it('does NOT lock bias when confirmed.length < BIAS_GATE_MIN_CONFIRMED', () => {
    const confirmed = Array.from({ length: 9 }, (_, i) =>
      mkBreakout({ symbol: `S${i}`, direction: 'SHORT', distancePct: 1.5 })
    );
    const { newBias, biasReason } = decideBreakoutActions({
      confirmed, slotsLeft: 3, existingBias: null,
    });
    expect(newBias).toBeNull();
    expect(biasReason).toBeNull();
  });

  it('locks SHORT when 80% are SHORT — replay 2026-05-29 morning scan', () => {
    // 25 SHORTs + 5 LONGs = 83% SHORT, well over 70% threshold
    const confirmed = [
      ...Array.from({ length: 25 }, (_, i) => mkBreakout({ symbol: `S${i}`, direction: 'SHORT', distancePct: 1.5 })),
      ...Array.from({ length: 5 },  (_, i) => mkBreakout({ symbol: `L${i}`, direction: 'LONG',  distancePct: 1.5 })),
    ];
    const { newBias, biasReason } = decideBreakoutActions({
      confirmed, slotsLeft: 3, existingBias: null,
    });
    expect(newBias).toBe('SHORT');
    expect(biasReason).toMatch(/Bias LOCKED to SHORT/);
    expect(biasReason).toMatch(/83%/);
  });

  it('locks LONG when 80% are LONG', () => {
    const confirmed = [
      ...Array.from({ length: 25 }, (_, i) => mkBreakout({ symbol: `L${i}`, direction: 'LONG',  distancePct: 1.5 })),
      ...Array.from({ length: 5 },  (_, i) => mkBreakout({ symbol: `S${i}`, direction: 'SHORT', distancePct: 1.5 })),
    ];
    const { newBias, biasReason } = decideBreakoutActions({
      confirmed, slotsLeft: 3, existingBias: null,
    });
    expect(newBias).toBe('LONG');
    expect(biasReason).toMatch(/Bias LOCKED to LONG/);
  });

  it('returns BOTH when neither side hits threshold (60/40 split)', () => {
    const confirmed = [
      ...Array.from({ length: 6 }, (_, i) => mkBreakout({ symbol: `S${i}`, direction: 'SHORT', distancePct: 1.5 })),
      ...Array.from({ length: 4 }, (_, i) => mkBreakout({ symbol: `L${i}`, direction: 'LONG',  distancePct: 1.5 })),
    ];
    const { newBias, biasReason } = decideBreakoutActions({
      confirmed, slotsLeft: 3, existingBias: null,
    });
    expect(newBias).toBe('BOTH');
    expect(biasReason).toMatch(/No clear bias/);
  });

  it('locks at exactly 70% threshold (>= comparison)', () => {
    // 7 SHORT + 3 LONG = 70% SHORT, exactly at threshold
    const confirmed = [
      ...Array.from({ length: 7 }, (_, i) => mkBreakout({ symbol: `S${i}`, direction: 'SHORT', distancePct: 1.5 })),
      ...Array.from({ length: 3 }, (_, i) => mkBreakout({ symbol: `L${i}`, direction: 'LONG',  distancePct: 1.5 })),
    ];
    const { newBias } = decideBreakoutActions({
      confirmed, slotsLeft: 3, existingBias: null,
    });
    expect(newBias).toBe('SHORT');
  });

  it('persists existing SHORT bias on subsequent scan even if current candidates split evenly', () => {
    const confirmed = [
      mkBreakout({ symbol: 'L1', direction: 'LONG',  distancePct: 1.5 }),
      mkBreakout({ symbol: 'S1', direction: 'SHORT', distancePct: 1.5 }),
    ];
    const { newBias } = decideBreakoutActions({
      confirmed, slotsLeft: 3, existingBias: 'SHORT',
    });
    expect(newBias).toBe('SHORT');
    // Only the SHORT one enters; LONG is marked WRONG_SIDE
    expect(confirmed.find(b => b.candidate.symbol === 'S1')._action).toBe('ENTER');
    expect(confirmed.find(b => b.candidate.symbol === 'L1')._action).toBe('WRONG_SIDE');
  });

  it('with SHORT bias locked, all LONGs get WRONG_SIDE', () => {
    const confirmed = [
      mkBreakout({ symbol: 'LODHA',      direction: 'LONG',  distancePct: 1.22 }),
      mkBreakout({ symbol: 'YESBANK',    direction: 'LONG',  distancePct: 1.26 }),
      mkBreakout({ symbol: 'CAMS',       direction: 'LONG',  distancePct: 1.91 }),
      mkBreakout({ symbol: 'ABFRL',      direction: 'LONG',  distancePct: 1.90 }),
      mkBreakout({ symbol: 'POWERGRID',  direction: 'SHORT', distancePct: 1.59 }),
      mkBreakout({ symbol: 'POLICYBZR',  direction: 'SHORT', distancePct: 1.78 }),
      mkBreakout({ symbol: 'JSL',        direction: 'SHORT', distancePct: 2.22 }),
    ];
    decideBreakoutActions({ confirmed, slotsLeft: 3, existingBias: 'SHORT' });
    const byName = Object.fromEntries(confirmed.map(b => [b.candidate.symbol, b._action]));
    // The 4 LONGs are all WRONG_SIDE
    expect(byName.LODHA).toBe('WRONG_SIDE');
    expect(byName.YESBANK).toBe('WRONG_SIDE');
    expect(byName.CAMS).toBe('WRONG_SIDE');
    expect(byName.ABFRL).toBe('WRONG_SIDE');
    // The 3 SHORTs fill the 3 slots
    expect(byName.POWERGRID).toBe('ENTER');
    expect(byName.POLICYBZR).toBe('ENTER');
    expect(byName.JSL).toBe('ENTER');
  });

  it('BOTH bias allows both LONG and SHORT entries', () => {
    const confirmed = [
      mkBreakout({ symbol: 'L1', direction: 'LONG',  distancePct: 2.0 }),
      mkBreakout({ symbol: 'S1', direction: 'SHORT', distancePct: 1.8 }),
      mkBreakout({ symbol: 'L2', direction: 'LONG',  distancePct: 1.6 }),
    ];
    decideBreakoutActions({ confirmed, slotsLeft: 3, existingBias: 'BOTH' });
    expect(confirmed.every(b => b._action === 'ENTER')).toBe(true);
  });
});

describe('Combined: floor + bias + slot logic together', () => {
  it('2026-05-29 morning replay with both fixes active — only top SHORTs enter', () => {
    // Real first-scan candidates from the day's log, sorted desc by distance%
    const confirmed = [
      mkBreakout({ symbol: 'LODHA',      direction: 'LONG',  distancePct: 1.22 }),
      mkBreakout({ symbol: 'RBLBANK',    direction: 'SHORT', distancePct: 0.97 }),
      mkBreakout({ symbol: 'PNBHOUSING', direction: 'SHORT', distancePct: 0.88 }),
      // + 22 more SHORTs below the floor or above (mocked at 1.5% so they pass)
      ...Array.from({ length: 22 }, (_, i) => mkBreakout({ symbol: `EXTRA_S${i}`, direction: 'SHORT', distancePct: 1.5 })),
      ...Array.from({ length: 2 },  (_, i) => mkBreakout({ symbol: `EXTRA_L${i}`, direction: 'LONG',  distancePct: 1.5 })),
    ];
    const { newBias } = decideBreakoutActions({
      confirmed, slotsLeft: 3, existingBias: null,
    });
    expect(newBias).toBe('SHORT');

    const byName = Object.fromEntries(confirmed.map(b => [b.candidate.symbol, b._action]));
    // LODHA is LONG → WRONG_SIDE under new SHORT bias
    expect(byName.LODHA).toBe('WRONG_SIDE');
    // RBLBANK and PNBHOUSING dropped by floor
    expect(byName.RBLBANK).toBe('BELOW_FLOOR');
    expect(byName.PNBHOUSING).toBe('BELOW_FLOOR');
    // 3 of the EXTRA_S take the slots
    const slotsFilled = confirmed.filter(b => b._action === 'ENTER').length;
    expect(slotsFilled).toBe(3);
    expect(confirmed.filter(b => b._action === 'ENTER').every(b => b.direction === 'SHORT')).toBe(true);
  });
});

describe('Action precedence ordering', () => {
  it('STALE > BELOW_FLOOR > WRONG_SIDE > ENTER > SLOT_FULL', () => {
    const confirmed = [
      // stale + below-floor + wrong-side → STALE wins
      mkBreakout({ symbol: 'A', direction: 'LONG', distancePct: 0.5, staleFlag: true }),
      // below-floor + wrong-side → BELOW_FLOOR wins
      mkBreakout({ symbol: 'B', direction: 'LONG', distancePct: 0.5 }),
      // wrong-side only → WRONG_SIDE
      mkBreakout({ symbol: 'C', direction: 'LONG', distancePct: 1.5 }),
      // valid → ENTER (with slots=1)
      mkBreakout({ symbol: 'D', direction: 'SHORT', distancePct: 1.5 }),
      // valid but no slots → SLOT_FULL
      mkBreakout({ symbol: 'E', direction: 'SHORT', distancePct: 1.5 }),
    ];
    decideBreakoutActions({ confirmed, slotsLeft: 1, existingBias: 'SHORT' });
    const byName = Object.fromEntries(confirmed.map(b => [b.candidate.symbol, b._action]));
    expect(byName.A).toBe('SKIP_STALE');
    expect(byName.B).toBe('BELOW_FLOOR');
    expect(byName.C).toBe('WRONG_SIDE');
    expect(byName.D).toBe('ENTER');
    expect(byName.E).toBe('SLOT_FULL');
  });
});
