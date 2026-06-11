/**
 * In-play RVOL snapshot — pure-function coverage (2026-06-11 paper cutover).
 *
 * Locks down the two functions that decide WHAT the system trades each day:
 *   • computeRvol5  — first-minutes RVOL vs the scaled 09:15-slot baseline
 *   • selectInPlay  — top-N selection, RVOL5_MIN boundary, fallback trigger
 * Plus computeATR on daily bars (paper stop sizing) and computeBeStop
 * (legacy, dead-gated — kept green so a future re-enable starts from passing).
 */

import { describe, it, expect } from 'vitest';
import {
  computeRvol5,
  selectInPlay,
  computeATR,
  computeBeStop,
} from '../services/orb/orbService.js';

describe('computeRvol5', () => {
  const profile = { '09:15': 100000, '09:30': 80000 };

  it('scales the 09:15 slot by the baseline fraction (0.55)', () => {
    // 110,000 ÷ (100,000 × 0.55) = 2.0
    expect(computeRvol5(110000, profile)).toBeCloseTo(2.0, 9);
  });

  it('uses ONLY the 09:15 slot — other slots are irrelevant', () => {
    expect(computeRvol5(110000, { '09:30': 999999, '09:15': 100000 }))
      .toBeCloseTo(2.0, 9);
  });

  it('returns null when the 09:15 baseline is missing, zero, or profile absent', () => {
    expect(computeRvol5(110000, {})).toBeNull();
    expect(computeRvol5(110000, { '09:15': 0 })).toBeNull();
    expect(computeRvol5(110000, null)).toBeNull();
    expect(computeRvol5(110000, undefined)).toBeNull();
  });

  it('returns null on missing/zero/negative volume', () => {
    expect(computeRvol5(0, profile)).toBeNull();
    expect(computeRvol5(null, profile)).toBeNull();
    expect(computeRvol5(undefined, profile)).toBeNull();
    expect(computeRvol5(-5, profile)).toBeNull();
  });
});

describe('selectInPlay', () => {
  const mk = (n, top = 5.0, step = 0.1) =>
    Array.from({ length: n }, (_, i) => ({ symbol: `S${i}`, rvol5: top - i * step }));

  it('caps at topN and keeps rank order', () => {
    const { selected, fallback } = selectInPlay(mk(40)); // 5.0 … 1.1
    expect(fallback).toBe(false);
    expect(selected.size).toBe(20);
    expect(selected.has('S0')).toBe(true);   // top
    expect(selected.has('S19')).toBe(true);  // rank 20
    expect(selected.has('S20')).toBe(false); // rank 21 — above floor but over topN
    expect(selected.has('S39')).toBe(false);
  });

  it('floor boundary: rvol5 exactly at RVOL5_MIN (1.0) qualifies', () => {
    const rows = [1.0, 1.0, 1.0, 1.0, 1.0].map((v, i) => ({ symbol: `E${i}`, rvol5: v }));
    const { selected, fallback } = selectInPlay(rows);
    expect(fallback).toBe(false);          // 5 qualified == minQualified
    expect(selected.size).toBe(5);
  });

  it('fallback fires when fewer than minQualified clear the floor', () => {
    const rows = [1.0, 1.0, 1.0, 0.9].map((v, i) => ({ symbol: `F${i}`, rvol5: v }));
    // only 3 ≥ 1.0 < minQualified(5) → top-10 ranked regardless of floor
    const { selected, fallback } = selectInPlay(rows);
    expect(fallback).toBe(true);
    expect(selected.size).toBe(4);         // all 4 (fewer than fallbackN=10 exist)
    expect(selected.has('F3')).toBe(true); // below floor but in fallback set
  });

  it('fallback is still ranked and capped at fallbackN', () => {
    const rows = mk(30, 0.99, 0.01);       // all below floor
    const { selected, fallback } = selectInPlay(rows);
    expect(fallback).toBe(true);
    expect(selected.size).toBe(10);
    expect(selected.has('S0')).toBe(true);
    expect(selected.has('S10')).toBe(false);
  });

  it('filters null/NaN/undefined rvol5 — never selectable, even via fallback', () => {
    const rows = [
      { symbol: 'A', rvol5: 3 },
      { symbol: 'B', rvol5: null },
      { symbol: 'C', rvol5: NaN },
      { symbol: 'D', rvol5: undefined },
    ];
    const { selected } = selectInPlay(rows);
    expect(selected.has('A')).toBe(true);
    expect(selected.size).toBe(1);
  });

  it('empty/garbage input → empty selection, no throw', () => {
    expect(selectInPlay([]).selected.size).toBe(0);
    expect(selectInPlay(null).selected.size).toBe(0);
    expect(selectInPlay(undefined).selected.size).toBe(0);
  });
});

describe('computeATR on daily bars (paper stop sizing)', () => {
  it('constant-range bars with no gaps → ATR = range', () => {
    const daily = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, '0')}T00:00:00+0530`,
      open: 100, high: 105, low: 95, close: 100, volume: 1,
    }));
    expect(computeATR(daily, 14)).toBeCloseTo(10, 6);
  });

  it('gap days widen TR via |high − prevClose| / |low − prevClose|', () => {
    // day1 closes 100; day2 gaps to 120–118 (range 2, but TR = 120−100 = 20)
    const bars = [
      { date: '2026-06-01T00:00:00+0530', open: 100, high: 101, low: 99, close: 100 },
      { date: '2026-06-02T00:00:00+0530', open: 119, high: 120, low: 118, close: 119 },
    ];
    expect(computeATR(bars, 1)).toBeCloseTo(20, 6);
  });
});

describe('computeBeStop (legacy — dead-gated, kept green)', () => {
  it('LONG: pct cushion when ATR small', () => {
    expect(computeBeStop({ entry: 1000, isLong: true, atr5m: 0 })).toBeCloseTo(997, 9);
  });
  it('LONG: ATR cushion dominates when larger', () => {
    expect(computeBeStop({ entry: 1000, isLong: true, atr5m: 10 })).toBeCloseTo(995, 9);
  });
  it('SHORT mirrors above entry', () => {
    expect(computeBeStop({ entry: 1000, isLong: false, atr5m: 10 })).toBeCloseTo(1005, 9);
  });
});
