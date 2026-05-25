/**
 * Unit tests for the new 09:32 ORB-breakout entry selection pure functions:
 *
 *   computeOrbBreakoutLevels        — entry/SL/T_n math from a 9:15-9:30 candle
 *   evaluateShortlistCandidate      — direction filter + combined score
 *   selectTopOrbEntries             — rank + slice
 *
 * The orchestrator executeShortlistOrbEntry has side effects (Mongo, Kite) and
 * is covered by integration tests, not these.
 */

import { describe, it, expect } from 'vitest';
import {
  computeOrbBreakoutLevels,
  evaluateShortlistCandidate,
  selectTopOrbEntries,
} from '../services/dailyPicks/dailyPicksService.js';

// ─── computeOrbBreakoutLevels ───────────────────────────────────────────────

describe('computeOrbBreakoutLevels — LONG entries', () => {
  it('valid ORB: entry = close + buffer, SL = ORB low, T_n = entry + n×R', () => {
    const l = computeOrbBreakoutLevels({
      direction: 'LONG',
      orb: { high: 102, low: 99, close: 101 },
      bufferPct: 0.05,
    });
    expect(l.valid).toBe(true);
    // close=101, buffer=max(tick, 0.05% × 101) = max(0.05, 0.0505) = 0.0505
    // entry ≈ 101.0505; SL = 99; risk ≈ 2.0505
    expect(l.entry).toBeGreaterThan(101);
    expect(l.entry).toBeLessThan(101.1);
    expect(l.sl).toBe(99);
    expect(l.risk).toBeCloseTo(l.entry - 99, 6);
    expect(l.t1).toBeCloseTo(l.entry + l.risk, 6);
    expect(l.t2).toBeCloseTo(l.entry + 2 * l.risk, 6);
    expect(l.t3).toBeCloseTo(l.entry + 3 * l.risk, 6);
    expect(l.risk_reward).toBe(1.0);
  });

  it('buffer floors at 1 NSE tick when 0.05% × price < tick', () => {
    // NSE tick rules: price <= 250 → tick 0.01, 250-1000 → 0.05, ...
    // For a ₹500 stock (tick 0.05): 0.05% × 500 = 0.25 > 0.05 → buffer = 0.25
    // For a ₹50 stock (tick 0.01): 0.05% × 50 = 0.025 > 0.01 → buffer = 0.025
    const l50 = computeOrbBreakoutLevels({
      direction: 'LONG',
      orb: { high: 51, low: 49.5, close: 50 },
      bufferPct: 0.05,
    });
    expect(l50.entry).toBeCloseTo(50.025, 6);  // 50 + max(0.01, 0.025) = 50.025

    // Test the actual floor path: bufferPct = 0.001% gives 0.001 < tick 0.01
    const lFloor = computeOrbBreakoutLevels({
      direction: 'LONG',
      orb: { high: 51, low: 49.5, close: 50 },
      bufferPct: 0.001,
    });
    expect(lFloor.entry).toBeCloseTo(50.01, 6);  // 50 + max(0.01, 0.0005) = 50.01 (tick wins)
  });
});

describe('computeOrbBreakoutLevels — SHORT entries', () => {
  it('valid ORB: entry = close - buffer, SL = ORB high, T_n = entry - n×R', () => {
    const l = computeOrbBreakoutLevels({
      direction: 'SHORT',
      orb: { high: 102, low: 99, close: 100 },
      bufferPct: 0.05,
    });
    expect(l.valid).toBe(true);
    expect(l.entry).toBeLessThan(100);
    expect(l.sl).toBe(102);
    expect(l.risk).toBeCloseTo(102 - l.entry, 6);
    expect(l.t1).toBeCloseTo(l.entry - l.risk, 6);
    expect(l.t2).toBeCloseTo(l.entry - 2 * l.risk, 6);
    expect(l.t3).toBeCloseTo(l.entry - 3 * l.risk, 6);
  });
});

describe('computeOrbBreakoutLevels — invalid inputs', () => {
  it('null ORB → valid=false, reason missing_or_invalid_orb', () => {
    const l = computeOrbBreakoutLevels({ direction: 'LONG', orb: null });
    expect(l.valid).toBe(false);
    expect(l.reason).toBe('missing_or_invalid_orb');
  });

  it('zero close → valid=false', () => {
    const l = computeOrbBreakoutLevels({ direction: 'LONG', orb: { high: 102, low: 99, close: 0 } });
    expect(l.valid).toBe(false);
  });

  it('close OUTSIDE high-low band → valid=false', () => {
    const l = computeOrbBreakoutLevels({ direction: 'LONG', orb: { high: 100, low: 99, close: 101.5 } });
    expect(l.valid).toBe(false);
    expect(l.reason).toBe('orb_close_outside_high_low');
  });

  it('high == low → valid=false (zero-range candle)', () => {
    const l = computeOrbBreakoutLevels({ direction: 'LONG', orb: { high: 100, low: 100, close: 100 } });
    expect(l.valid).toBe(false);
    expect(l.reason).toBe('zero_or_negative_orb_range');
  });
});

// ─── evaluateShortlistCandidate ─────────────────────────────────────────────

const LONG_CAND = { symbol: 'TEST', direction: 'LONG', composite: 0.6, rank_score: 60 };
const SHORT_CAND = { symbol: 'TEST', direction: 'SHORT', composite: 0.6, rank_score: 60 };

describe('evaluateShortlistCandidate — passes path', () => {
  it('LONG with direction+volume+nifty all pass → passes=true, combined > composite', () => {
    const r = evaluateShortlistCandidate({
      candidate: LONG_CAND,
      orb: { open: 100, high: 102, low: 99.5, close: 101 },  // +1% from open = direction-pass
      volumeRatio: 1.2,                                       // > 0.5 threshold
      niftyChangePct: 0.2,                                    // not against
    });
    expect(r.passes).toBe(true);
    expect(r.intradayScore).toBeCloseTo(1.0, 6);  // 0.5 + 0.3 + 0.2 all pass
    expect(r.combinedScore).toBeCloseTo(0.5 * 0.6 + 0.5 * 1.0, 6);   // 0.8
    expect(r.computedLevels.valid).toBe(true);
    expect(r.rejection_reason).toBeNull();
  });

  it('LONG direction-pass + volume-fail still passes (1 fail OK)', () => {
    const r = evaluateShortlistCandidate({
      candidate: LONG_CAND,
      orb: { open: 100, high: 102, low: 99.5, close: 101 },
      volumeRatio: 0.2,    // FAIL
      niftyChangePct: 0.0,
    });
    expect(r.passes).toBe(true);
    expect(r.intradayScore).toBeCloseTo(0.7, 6);   // 0.5 (dir) + 0 (vol) + 0.2 (nifty) = 0.7
    expect(r.combinedScore).toBeCloseTo(0.5 * 0.6 + 0.5 * 0.7, 6);  // 0.65
  });
});

describe('evaluateShortlistCandidate — rejection paths', () => {
  it('direction NOT confirmed → passes=false, reason direction_not_confirmed', () => {
    const r = evaluateShortlistCandidate({
      candidate: LONG_CAND,
      orb: { open: 100, high: 100.1, low: 99.9, close: 100 },  // flat → direction fail
      volumeRatio: 1.5, niftyChangePct: 0.0,
    });
    expect(r.passes).toBe(false);
    expect(r.rejection_reason).toBe('direction_not_confirmed');
    expect(r.combinedScore).toBe(0);
  });

  it('SHORT with stock rallying → passes=false', () => {
    const r = evaluateShortlistCandidate({
      candidate: SHORT_CAND,
      orb: { open: 100, high: 102, low: 99.5, close: 101 },  // +1% — wrong direction for SHORT
      volumeRatio: 1.5, niftyChangePct: 0.0,
    });
    expect(r.passes).toBe(false);
    expect(r.rejection_reason).toBe('direction_not_confirmed');
  });

  it('null OHLC → passes=false, reason no_orb_data', () => {
    const r = evaluateShortlistCandidate({
      candidate: LONG_CAND, orb: null, volumeRatio: 1.0, niftyChangePct: 0.5,
    });
    expect(r.passes).toBe(false);
    expect(r.rejection_reason).toBe('no_orb_data');
  });

  it('direction passes but resulting risk < MIN_RISK floor → reject with below_floor reason', () => {
    // Engineered to fail the 0.5% risk floor while clearly passing direction.
    //   open 1000, close 1003  → +0.3% direction-pass (well above 0.15% threshold)
    //   ORB high 1004, low 1002 (close 1003 inside)
    //   entry = 1003 + buffer ≈ 1003.5; SL = 1002; risk ≈ 1.5 / 1003.5 ≈ 0.15% — below 0.5%
    const r = evaluateShortlistCandidate({
      candidate: { ...LONG_CAND, symbol: 'TIGHT' },
      orb: { open: 1000, high: 1004, low: 1002, close: 1003 },
      volumeRatio: 1.0, niftyChangePct: 0,
    });
    expect(r.passes).toBe(false);
    expect(r.rejection_reason).toMatch(/below_floor/);
    // The direction check itself must have passed for this to be the trigger
    expect(r.confirmation.checks.direction.passed).toBe(true);
  });
});

// ─── selectTopOrbEntries ────────────────────────────────────────────────────

describe('selectTopOrbEntries — ranking + slice', () => {
  const make = (sym, score, passes) => ({
    candidate: { symbol: sym }, passes, combinedScore: score,
  });

  it('returns only passers, sorted desc by combinedScore, limited to N', () => {
    const evaluated = [
      make('A', 0.4, true),
      make('B', 0.8, true),
      make('C', 0.6, false),   // fails, dropped
      make('D', 0.7, true),
      make('E', 0.9, true),
    ];
    const top = selectTopOrbEntries(evaluated, 3);
    expect(top.map(t => t.candidate.symbol)).toEqual(['E', 'B', 'D']);
  });

  it('limit larger than passer count → returns all passers', () => {
    const evaluated = [make('A', 0.4, true), make('B', 0.8, true)];
    const top = selectTopOrbEntries(evaluated, 5);
    expect(top.map(t => t.candidate.symbol)).toEqual(['B', 'A']);
  });

  it('all fail → empty array', () => {
    const evaluated = [make('A', 0.4, false), make('B', 0.8, false)];
    expect(selectTopOrbEntries(evaluated, 3)).toEqual([]);
  });

  it('limit = 0 → empty array', () => {
    const evaluated = [make('A', 0.8, true)];
    expect(selectTopOrbEntries(evaluated, 0)).toEqual([]);
  });
});

// ─── regression guard: kiteOrderService API surface ─────────────────────────
//
// 2026-05-25 incident: executeShortlistOrbEntry called kiteOrderService.getFunds()
// — a method that does not exist. The try-catch around it silently absorbed the
// TypeError and returned early with picks_placed=0, never reaching the order
// loop. SHORTLIST selected LICI/DIVISLAB/TORNTPHARM but placed zero orders.
//
// The dryRun=true unit-test path skips the Kite block, so the typo was invisible
// to existing tests. This regression guard asserts the exact methods we depend
// on actually exist on the service module — a one-call import check.

describe('kiteOrderService API surface — regression guard for 2026-05-25 typo', () => {
  it('getAvailableBalance is a function', async () => {
    const mod = await import('../services/kiteOrder.service.js');
    const svc = mod.default;
    expect(typeof svc.getAvailableBalance).toBe('function');
  });

  it('placeOrder is a function', async () => {
    const mod = await import('../services/kiteOrder.service.js');
    const svc = mod.default;
    expect(typeof svc.placeOrder).toBe('function');
  });

  it('cancelOrder, modifyOrder, getOrderDetails are functions', async () => {
    const mod = await import('../services/kiteOrder.service.js');
    const svc = mod.default;
    expect(typeof svc.cancelOrder).toBe('function');
    expect(typeof svc.modifyOrder).toBe('function');
    expect(typeof svc.getOrderDetails).toBe('function');
  });

  it('getFunds() does NOT exist (legacy typo — must stay removed)', async () => {
    const mod = await import('../services/kiteOrder.service.js');
    const svc = mod.default;
    expect(svc.getFunds).toBeUndefined();
  });
});

// ─── integration: candidate → levels → ranking (end-to-end of pure path) ─────

describe('end-to-end pure path: 3 candidates → top 2 selected', () => {
  it('produces sensible selection given mixed candidates', () => {
    const candidates = [
      { symbol: 'A', direction: 'LONG',  composite: 0.5, rank_score: 50,
        orb: { open: 100, high: 102, low: 99.5, close: 101 },           // direction OK
        vol: 1.5, nifty: 0.1 },
      { symbol: 'B', direction: 'LONG',  composite: 0.7, rank_score: 70,
        orb: { open: 100, high: 100.1, low: 99.9, close: 100 },         // direction FAIL
        vol: 1.5, nifty: 0.1 },
      { symbol: 'C', direction: 'SHORT', composite: 0.6, rank_score: 60,
        orb: { open: 100, high: 100.5, low: 98, close: 99 },             // direction OK (SHORT)
        vol: 1.2, nifty: -0.1 },
    ];
    const evaluated = candidates.map(c => ({
      candidate: { symbol: c.symbol, direction: c.direction, composite: c.composite, rank_score: c.rank_score },
      ...evaluateShortlistCandidate({
        candidate: { symbol: c.symbol, direction: c.direction, composite: c.composite, rank_score: c.rank_score },
        orb: c.orb, volumeRatio: c.vol, niftyChangePct: c.nifty,
      }),
    }));
    const top = selectTopOrbEntries(evaluated, 2);
    // B failed direction — should not appear. A and C pass; pick the higher
    // combined first. C composite=0.6 vs A composite=0.5; both have high intra.
    expect(top.map(t => t.candidate.symbol)).toContain('C');
    expect(top.map(t => t.candidate.symbol)).toContain('A');
    expect(top.map(t => t.candidate.symbol)).not.toContain('B');
  });
});
