/**
 * Unit tests for pickScannerTarget — the LONG/SHORT R:R branching helper
 * extracted from runScannerPy's inner pickTarget.
 *
 * Verifies that:
 *   - LONG picks: targets above close, sl below, reward = t − close
 *   - SHORT picks: targets below close, sl above, reward = close − t
 *   - The minRR threshold (default 1.0) gates "viable" vs "fallback"
 *   - Missing-direction defaults to LONG
 */

import { describe, it, expect } from 'vitest';
import { pickScannerTarget } from '../services/dailyPicks/dailyPicksService.js';

describe('pickScannerTarget — LONG direction', () => {
  it('picks t1 when t1 already has ≥ 1:1 R:R', () => {
    // close 100, sl 99 → risk 1.0
    // t1=102, t2=103, t3=105 → rewards 2,3,5 → t1 RR=2 ≥ 1 → t1
    const s = {
      direction: 'LONG', close: 100, sl: 99,
      t1: 102, t1_pct: 2.0, rr_t1: 2.0,
      t2: 103, t2_pct: 3.0, rr_t2: 3.0,
      t3: 105, t3_pct: 5.0, rr_t3: 5.0,
    };
    const result = pickScannerTarget(s, 1.0);
    expect(result.label).toBe('t1');
    expect(result.t).toBe(102);
    expect(result.isFallback).toBe(false);
  });

  it('skips t1 with sub-1:1 R:R, picks t2', () => {
    // close 100, sl 99 → risk 1.0. t1 at 100.5 → reward 0.5 < 1.0 fails.
    // t2 at 102 → reward 2 ≥ 1 → pick t2.
    const s = {
      direction: 'LONG', close: 100, sl: 99,
      t1: 100.5, t1_pct: 0.5, rr_t1: 0.5,
      t2: 102,   t2_pct: 2.0, rr_t2: 2.0,
      t3: 105,   t3_pct: 5.0, rr_t3: 5.0,
    };
    const result = pickScannerTarget(s, 1.0);
    expect(result.label).toBe('t2');
    expect(result.isFallback).toBe(false);
  });

  it('falls back to widest available when no target meets 1:1', () => {
    // close 100, sl 99 → risk 1.0
    // t1=100.3 (reward 0.3), t2=100.5 (reward 0.5), t3=100.7 (reward 0.7)
    // All fail 1.0 → fall back to t3 (widest viable below threshold).
    const s = {
      direction: 'LONG', close: 100, sl: 99,
      t1: 100.3, t1_pct: 0.3, rr_t1: 0.3,
      t2: 100.5, t2_pct: 0.5, rr_t2: 0.5,
      t3: 100.7, t3_pct: 0.7, rr_t3: 0.7,
    };
    const result = pickScannerTarget(s, 1.0);
    expect(result.label).toBe('t3');
    expect(result.isFallback).toBe(true);
  });

  it('filters out targets below close (invalid for LONG)', () => {
    // t1 is below close — should be filtered out
    const s = {
      direction: 'LONG', close: 100, sl: 99,
      t1: 98,    t1_pct: -2.0, rr_t1: -2.0,
      t2: 103,   t2_pct:  3.0, rr_t2:  3.0,
      t3: 105,   t3_pct:  5.0, rr_t3:  5.0,
    };
    const result = pickScannerTarget(s, 1.0);
    expect(result.label).toBe('t2');   // t1 invalid → first viable = t2
  });
});

describe('pickScannerTarget — SHORT direction', () => {
  it('picks t1 when t1 already has ≥ 1:1 R:R', () => {
    // close 100, sl 101 → risk 1.0
    // t1=98 (reward 2), t2=97 (reward 3), t3=95 (reward 5) → t1 RR=2 → t1
    const s = {
      direction: 'SHORT', close: 100, sl: 101,
      t1: 98, t1_pct: -2.0, rr_t1: 2.0,
      t2: 97, t2_pct: -3.0, rr_t2: 3.0,
      t3: 95, t3_pct: -5.0, rr_t3: 5.0,
    };
    const result = pickScannerTarget(s, 1.0);
    expect(result.label).toBe('t1');
    expect(result.t).toBe(98);
    expect(result.isFallback).toBe(false);
  });

  it('skips t1 with sub-1:1 R:R, picks t2', () => {
    // close 100, sl 101 → risk 1.0
    // t1=99.5 (reward 0.5 < 1) → skip. t2=98 (reward 2) → pick.
    const s = {
      direction: 'SHORT', close: 100, sl: 101,
      t1: 99.5, t1_pct: -0.5, rr_t1: 0.5,
      t2: 98,   t2_pct: -2.0, rr_t2: 2.0,
      t3: 95,   t3_pct: -5.0, rr_t3: 5.0,
    };
    const result = pickScannerTarget(s, 1.0);
    expect(result.label).toBe('t2');
    expect(result.isFallback).toBe(false);
  });

  it('falls back when no target meets 1:1', () => {
    const s = {
      direction: 'SHORT', close: 100, sl: 101,
      t1: 99.7, t1_pct: -0.3, rr_t1: 0.3,
      t2: 99.5, t2_pct: -0.5, rr_t2: 0.5,
      t3: 99.3, t3_pct: -0.7, rr_t3: 0.7,
    };
    const result = pickScannerTarget(s, 1.0);
    expect(result.label).toBe('t3');   // widest viable = t3 (deepest below close)
    expect(result.isFallback).toBe(true);
  });

  it('filters out targets above close (invalid for SHORT)', () => {
    // t1 is above close — invalid for SHORT, should be filtered
    const s = {
      direction: 'SHORT', close: 100, sl: 101,
      t1: 102, t1_pct:  2.0, rr_t1: -2.0,
      t2: 98,  t2_pct: -2.0, rr_t2:  2.0,
      t3: 95,  t3_pct: -5.0, rr_t3:  5.0,
    };
    const result = pickScannerTarget(s, 1.0);
    expect(result.label).toBe('t2');
  });
});

describe('pickScannerTarget — defaults and edge cases', () => {
  it('treats missing direction as LONG', () => {
    const s = {
      close: 100, sl: 99,                              // no direction field
      t1: 102, t1_pct: 2.0, rr_t1: 2.0,
      t2: 103, t2_pct: 3.0, rr_t2: 3.0,
      t3: 105, t3_pct: 5.0, rr_t3: 5.0,
    };
    const result = pickScannerTarget(s);
    expect(result.label).toBe('t1');
    expect(result.t).toBe(102);
  });

  it('respects custom minRR threshold', () => {
    // With minRR=2.0, t1 RR=1.5 fails, t2 RR=3.0 passes
    const s = {
      direction: 'LONG', close: 100, sl: 99,
      t1: 101.5, t1_pct: 1.5, rr_t1: 1.5,
      t2: 103,   t2_pct: 3.0, rr_t2: 3.0,
      t3: 105,   t3_pct: 5.0, rr_t3: 5.0,
    };
    expect(pickScannerTarget(s, 1.0).label).toBe('t1');   // 1.5 ≥ 1.0 → t1
    expect(pickScannerTarget(s, 2.0).label).toBe('t2');   // 1.5 < 2.0 → t2
    expect(pickScannerTarget(s, 4.0).label).toBe('t3');   // none pass → fallback t3
  });

  it('handles all targets equal to close (no viable target)', () => {
    // All targets at the close → nothing passes the filter
    const s = {
      direction: 'LONG', close: 100, sl: 99,
      t1: 100, t1_pct: 0, rr_t1: 0,
      t2: 100, t2_pct: 0, rr_t2: 0,
      t3: 100, t3_pct: 0, rr_t3: 0,
    };
    const result = pickScannerTarget(s, 1.0);
    expect(result.isFallback).toBe(true);
    expect(result.t).toBe(100);
  });
});
