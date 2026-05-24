/**
 * Unit tests for VWAP entry filter + VWAP exit logic.
 *
 *   computeVwap         — incremental cumulative VWAP over 5-min OHLCV bars
 *   evaluateVwapExit    — pure decision: 2-consecutive-closes-wrong-side rule
 *   evaluateShortlistCandidate (with vwapAtOrbClose) — entry rejects when
 *                                                       trigger sits on the
 *                                                       wrong side of VWAP
 */

import { describe, it, expect } from 'vitest';
import {
  computeVwap,
  evaluateVwapExit,
  evaluateShortlistCandidate,
} from '../services/dailyPicks/dailyPicksService.js';

// ─── computeVwap ────────────────────────────────────────────────────────────

describe('computeVwap — basic accumulation', () => {
  it('single bar: returns the typical_price', () => {
    const r = computeVwap([{ high: 102, low: 98, close: 100, volume: 1000 }]);
    expect(r.vwap).toBeCloseTo(100, 6);   // tp = (102+98+100)/3 = 100
    expect(r.totalVol).toBe(1000);
    expect(r.totalTpVol).toBeCloseTo(100_000, 6);
  });

  it('two bars equal volume: equally-weighted average of typical prices', () => {
    const r = computeVwap([
      { high: 102, low: 98,  close: 100, volume: 1000 },  // tp 100
      { high: 105, low: 100, close: 103, volume: 1000 },  // tp 102.67
    ]);
    expect(r.vwap).toBeCloseTo((100 + 102.6667) / 2, 3);
  });

  it('volume weighting: heavier-volume bar pulls VWAP toward its tp', () => {
    const r = computeVwap([
      { high: 102, low: 98,  close: 100, volume: 100 },    // tp 100, low vol
      { high: 105, low: 100, close: 103, volume: 10_000 }, // tp 102.67, high vol
    ]);
    // VWAP should be much closer to 102.67 than to 100 because of the volume mass
    expect(r.vwap).toBeGreaterThan(102);
    expect(r.vwap).toBeLessThan(102.7);
  });

  it('incremental update via prev: same result as one-shot', () => {
    const bars = [
      { high: 102, low: 98,  close: 100, volume: 500 },
      { high: 105, low: 100, close: 103, volume: 800 },
      { high: 104, low: 101, close: 102, volume: 600 },
    ];
    const oneShot = computeVwap(bars);
    const partA   = computeVwap(bars.slice(0, 2));
    const partB   = computeVwap(bars.slice(2),   partA);
    expect(partB.vwap).toBeCloseTo(oneShot.vwap, 6);
    expect(partB.totalVol).toBe(oneShot.totalVol);
  });
});

describe('computeVwap — invalid input handling', () => {
  it('empty bars: returns null vwap (no volume)', () => {
    const r = computeVwap([]);
    expect(r.vwap).toBeNull();
    expect(r.totalVol).toBe(0);
  });

  it('zero-volume bar is skipped (does not poison accumulator)', () => {
    const r = computeVwap([
      { high: 102, low: 98,  close: 100, volume: 0 },     // skipped
      { high: 105, low: 100, close: 103, volume: 1000 },
    ]);
    expect(r.vwap).toBeCloseTo((105 + 100 + 103) / 3, 6);
    expect(r.totalVol).toBe(1000);
  });

  it('NaN-laced bar is skipped, not blown up', () => {
    const r = computeVwap([
      { high: NaN, low: 98, close: 100, volume: 1000 },
      { high: 105, low: 100, close: 103, volume: 1000 },
    ]);
    expect(r.vwap).toBeCloseTo((105 + 100 + 103) / 3, 6);
  });
});

// ─── evaluateVwapExit ───────────────────────────────────────────────────────

describe('evaluateVwapExit — LONG positions', () => {
  it('close on correct side (above vwap): no exit, counter reset', () => {
    const r = evaluateVwapExit({ direction: 'LONG', latestClose: 1105, vwap: 1100, consecutiveOpp: 1 });
    expect(r.exit).toBe(false);
    expect(r.consecutiveOpp).toBe(0);
    expect(r.side).toBe('correct');
  });

  it('first close below VWAP: no exit, counter increments to 1', () => {
    const r = evaluateVwapExit({ direction: 'LONG', latestClose: 1099, vwap: 1100, consecutiveOpp: 0 });
    expect(r.exit).toBe(false);
    expect(r.consecutiveOpp).toBe(1);
    expect(r.side).toBe('wrong');
  });

  it('SECOND consecutive close below VWAP: EXIT fires', () => {
    const r = evaluateVwapExit({ direction: 'LONG', latestClose: 1098, vwap: 1100, consecutiveOpp: 1 });
    expect(r.exit).toBe(true);
    expect(r.reason).toBe('two_consecutive_closes_below_vwap');
    expect(r.consecutiveOpp).toBe(2);
  });

  it('a single bar above VWAP after one below: counter resets to 0', () => {
    const r = evaluateVwapExit({ direction: 'LONG', latestClose: 1101, vwap: 1100, consecutiveOpp: 1 });
    expect(r.exit).toBe(false);
    expect(r.consecutiveOpp).toBe(0);
  });
});

describe('evaluateVwapExit — SHORT positions', () => {
  it('SHORT — close below VWAP is correct side: no exit', () => {
    const r = evaluateVwapExit({ direction: 'SHORT', latestClose: 99, vwap: 100, consecutiveOpp: 0 });
    expect(r.exit).toBe(false);
    expect(r.side).toBe('correct');
  });

  it('SHORT — first close ABOVE VWAP: counter=1, no exit', () => {
    const r = evaluateVwapExit({ direction: 'SHORT', latestClose: 101, vwap: 100, consecutiveOpp: 0 });
    expect(r.exit).toBe(false);
    expect(r.consecutiveOpp).toBe(1);
  });

  it('SHORT — second consecutive above: EXIT fires', () => {
    const r = evaluateVwapExit({ direction: 'SHORT', latestClose: 102, vwap: 100, consecutiveOpp: 1 });
    expect(r.exit).toBe(true);
    expect(r.reason).toBe('two_consecutive_closes_above_vwap');
  });
});

describe('evaluateVwapExit — null/invalid VWAP handling', () => {
  it('null vwap → no_vwap reason, no exit, counter preserved', () => {
    const r = evaluateVwapExit({ direction: 'LONG', latestClose: 100, vwap: null, consecutiveOpp: 1 });
    expect(r.exit).toBe(false);
    expect(r.reason).toBe('no_vwap');
    expect(r.consecutiveOpp).toBe(1);
  });

  it('NaN close → no exit, abstain', () => {
    const r = evaluateVwapExit({ direction: 'LONG', latestClose: NaN, vwap: 100, consecutiveOpp: 0 });
    expect(r.exit).toBe(false);
    expect(r.reason).toBe('no_vwap');
  });
});

// ─── evaluateShortlistCandidate — VWAP entry filter ─────────────────────────

const LONG_CAND  = { symbol: 'X', direction: 'LONG',  composite: 0.6, rank_score: 60 };
const SHORT_CAND = { symbol: 'Y', direction: 'SHORT', composite: 0.6, rank_score: 60 };

describe('evaluateShortlistCandidate — VWAP entry filter (LONG)', () => {
  // All-pass baseline OHLC (direction confirmed, plenty of risk)
  const baseOrb = { open: 100, high: 102, low: 99.5, close: 101 };

  it('vwapAtOrbClose null → check is skipped, baseline passes', () => {
    const r = evaluateShortlistCandidate({
      candidate: LONG_CAND, orb: baseOrb, volumeRatio: 1.0, niftyChangePct: 0,
      vwapAtOrbClose: null,
    });
    expect(r.passes).toBe(true);
    expect(r.vwapAtEntry).toBeNull();
  });

  it('LONG: trigger ABOVE vwap → passes', () => {
    // computed trigger ≈ 101.05 (101 + ~0.05). VWAP at 100 → trigger > vwap.
    const r = evaluateShortlistCandidate({
      candidate: LONG_CAND, orb: baseOrb, volumeRatio: 1.0, niftyChangePct: 0,
      vwapAtOrbClose: 100,
    });
    expect(r.passes).toBe(true);
    expect(r.vwapAtEntry).toBe(100);
  });

  it('LONG: trigger BELOW vwap → REJECT with on_wrong_side reason', () => {
    // trigger ≈ 101.05, VWAP at 102 → trigger < vwap → reject
    const r = evaluateShortlistCandidate({
      candidate: LONG_CAND, orb: baseOrb, volumeRatio: 1.0, niftyChangePct: 0,
      vwapAtOrbClose: 102,
    });
    expect(r.passes).toBe(false);
    expect(r.rejection_reason).toMatch(/wrong_side_of_vwap/);
  });
});

describe('evaluateShortlistCandidate — VWAP entry filter (SHORT)', () => {
  // SHORT baseline: stock dropped intraday
  const baseOrb = { open: 100, high: 100.5, low: 98, close: 99 };

  it('SHORT: trigger BELOW vwap → passes', () => {
    // computed SHORT trigger ≈ 99 - 0.05 = ~98.95. VWAP 100 → trigger < vwap ✓
    const r = evaluateShortlistCandidate({
      candidate: SHORT_CAND, orb: baseOrb, volumeRatio: 1.0, niftyChangePct: 0,
      vwapAtOrbClose: 100,
    });
    expect(r.passes).toBe(true);
  });

  it('SHORT: trigger ABOVE vwap → REJECT', () => {
    // SHORT trigger ≈ 98.95. VWAP at 98 → trigger > vwap → reject
    const r = evaluateShortlistCandidate({
      candidate: SHORT_CAND, orb: baseOrb, volumeRatio: 1.0, niftyChangePct: 0,
      vwapAtOrbClose: 98,
    });
    expect(r.passes).toBe(false);
    expect(r.rejection_reason).toMatch(/wrong_side_of_vwap/);
  });
});
