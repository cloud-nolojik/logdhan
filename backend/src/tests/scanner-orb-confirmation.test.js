/**
 * Unit tests for evaluateScannerOrbConfirmation — the pure decision behind
 * the 09:32 IST "did the open confirm the pre-open thesis?" gate.
 *
 * The decision matrix is:
 *   0 failed checks  → CONFIRMED  (hold)
 *   1 failed check   → WARN       (hold, audit-only)
 *   2+ failed checks → EXITED     (cancel SL-M + target, market exit)
 *   missing OHLC     → SKIPPED
 *
 * Three checks:
 *   1. DIRECTION — stock moved in trade direction by ≥ MIN_MOVE_PCT (default 0.15%)
 *   2. VOLUME    — actual/expected ratio ≥ VOL_RATIO_THRESHOLD (default 0.50)
 *                  Null ratio → auto-pass (don't penalize on missing data)
 *   3. NIFTY     — Nifty NOT moving against us by more than NIFTY_AGAINST_PCT (0.30)
 *                  Null/0 nifty change → auto-pass
 */

import { describe, it, expect } from 'vitest';
import { evaluateScannerOrbConfirmation } from '../services/dailyPicks/dailyPicksService.js';

const LONG  = { direction: 'LONG' };
const SHORT = { direction: 'SHORT' };

// Helper: build an OHLC payload from a percentage move from open
function orbFromMove({ open = 100, movePct = 0, high = null, low = null, volume = null }) {
  const close = open * (1 + movePct / 100);
  return {
    open,
    close,
    high: high ?? Math.max(open, close),
    low:  low  ?? Math.min(open, close),
    volume,
  };
}

describe('evaluateScannerOrbConfirmation — all-pass cases (CONFIRMED)', () => {
  it('LONG: stock +0.5%, vol ratio 1.2, Nifty +0.2% → CONFIRMED', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.5 }),
      volumeRatio: 1.2,
      niftyChangePct: 0.2,
    });
    expect(r.decision).toBe('CONFIRMED');
    expect(r.fail_count).toBe(0);
    expect(r.fail_reasons).toEqual([]);
    expect(r.checks.direction.passed).toBe(true);
    expect(r.checks.volume.passed).toBe(true);
    expect(r.checks.nifty_alignment.passed).toBe(true);
  });

  it('SHORT: stock -0.4%, vol ratio 0.8, Nifty -0.1% → CONFIRMED', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: SHORT,
      orb: orbFromMove({ movePct: -0.4 }),
      volumeRatio: 0.8,
      niftyChangePct: -0.1,
    });
    expect(r.decision).toBe('CONFIRMED');
    expect(r.fail_count).toBe(0);
  });
});

describe('evaluateScannerOrbConfirmation — single failure cases (WARN)', () => {
  it('LONG: stock flat (+0.05%), good vol, neutral Nifty → WARN (direction only)', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.05 }),
      volumeRatio: 1.0,
      niftyChangePct: 0.1,
    });
    expect(r.decision).toBe('WARN');
    expect(r.fail_reasons).toEqual(['direction']);
  });

  it('LONG: good direction, low vol ratio (0.3), neutral Nifty → WARN (volume only)', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.4 }),
      volumeRatio: 0.3,
      niftyChangePct: 0.0,
    });
    expect(r.decision).toBe('WARN');
    expect(r.fail_reasons).toEqual(['volume']);
  });

  it('LONG: good direction, good vol, Nifty -0.5% (against) → WARN (nifty only)', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.4 }),
      volumeRatio: 1.0,
      niftyChangePct: -0.5,
    });
    expect(r.decision).toBe('WARN');
    expect(r.fail_reasons).toEqual(['nifty']);
  });

  it('SHORT: stock +0.3% (wrong dir), good vol, Nifty flat → WARN (direction only)', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: SHORT,
      orb: orbFromMove({ movePct: 0.3 }),
      volumeRatio: 1.0,
      niftyChangePct: 0,
    });
    expect(r.decision).toBe('WARN');
    expect(r.fail_reasons).toEqual(['direction']);
  });
});

describe('evaluateScannerOrbConfirmation — multi-failure cases (EXITED)', () => {
  it('LONG: wrong direction (-0.5%) + low vol (0.2) → EXITED', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: -0.5 }),
      volumeRatio: 0.2,
      niftyChangePct: 0.1,
    });
    expect(r.decision).toBe('EXITED');
    expect(r.fail_reasons).toEqual(expect.arrayContaining(['direction', 'volume']));
    expect(r.fail_count).toBe(2);
  });

  it('LONG: flat direction + Nifty against → EXITED', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.05 }),
      volumeRatio: 0.8,
      niftyChangePct: -0.6,
    });
    expect(r.decision).toBe('EXITED');
    expect(r.fail_reasons).toEqual(expect.arrayContaining(['direction', 'nifty']));
  });

  it('LONG: all three checks fail → EXITED (fail_count = 3)', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: -0.8 }),  // wrong direction
      volumeRatio: 0.1,                      // low vol
      niftyChangePct: -1.5,                  // Nifty against
    });
    expect(r.decision).toBe('EXITED');
    expect(r.fail_count).toBe(3);
    expect(r.fail_reasons).toEqual(expect.arrayContaining(['direction', 'volume', 'nifty']));
  });

  it('SHORT: stock rallying + low vol → EXITED', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: SHORT,
      orb: orbFromMove({ movePct: 0.5 }),    // rallied (wrong dir for SHORT)
      volumeRatio: 0.2,
      niftyChangePct: 0.0,
    });
    expect(r.decision).toBe('EXITED');
    expect(r.fail_reasons).toEqual(expect.arrayContaining(['direction', 'volume']));
  });
});

describe('evaluateScannerOrbConfirmation — null / missing data graceful paths', () => {
  it('null OHLC → SKIPPED (don\'t guess on missing data)', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG, orb: null, volumeRatio: 1.0, niftyChangePct: 0.5,
    });
    expect(r.decision).toBe('SKIPPED');
    expect(r.fail_reasons).toEqual(['missing_or_invalid_orb']);
  });

  it('OHLC with zero open → SKIPPED (corrupt data)', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: { open: 0, high: 100, low: 99, close: 100 },
      volumeRatio: 1.0, niftyChangePct: 0.5,
    });
    expect(r.decision).toBe('SKIPPED');
  });

  it('OHLC with NaN close → SKIPPED', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: { open: 100, high: 101, low: 99, close: NaN },
      volumeRatio: 1.0, niftyChangePct: 0.5,
    });
    expect(r.decision).toBe('SKIPPED');
  });

  it('null volumeRatio auto-passes the volume check (don\'t penalize on missing data)', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.4 }),
      volumeRatio: null,
      niftyChangePct: 0.1,
    });
    expect(r.decision).toBe('CONFIRMED');
    expect(r.checks.volume.passed).toBe(true);
    expect(r.checks.volume.ratio).toBeNull();
  });

  it('null niftyChangePct auto-passes the nifty check', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.4 }),
      volumeRatio: 1.0,
      niftyChangePct: null,
    });
    expect(r.decision).toBe('CONFIRMED');
    expect(r.checks.nifty_alignment.passed).toBe(true);
    expect(r.checks.nifty_alignment.nifty_change_pct).toBeNull();
  });
});

describe('evaluateScannerOrbConfirmation — boundary cases', () => {
  it('LONG: stock exactly +0.15% (at min-move threshold) → CONFIRMED (>= comparison)', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.15 }),
      volumeRatio: 1.0, niftyChangePct: 0,
    });
    expect(r.checks.direction.passed).toBe(true);
    expect(r.decision).toBe('CONFIRMED');
  });

  it('LONG: vol ratio exactly 0.5 (at threshold) → passes (>= comparison)', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.4 }),
      volumeRatio: 0.5,
      niftyChangePct: 0,
    });
    expect(r.checks.volume.passed).toBe(true);
  });

  it('LONG: Nifty exactly -0.3% (at threshold) → passes (strict < comparison fails the threshold)', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.4 }),
      volumeRatio: 1.0,
      niftyChangePct: -0.3,
    });
    // -0.3 is NOT < -0.3 → nifty check passes (against = false)
    expect(r.checks.nifty_alignment.passed).toBe(true);
    expect(r.checks.nifty_alignment.against).toBe(false);
  });

  it('LONG: Nifty -0.31% (just past threshold) → nifty fails', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.4 }),
      volumeRatio: 1.0,
      niftyChangePct: -0.31,
    });
    expect(r.checks.nifty_alignment.passed).toBe(false);
    expect(r.checks.nifty_alignment.against).toBe(true);
  });
});

describe('evaluateScannerOrbConfirmation — audit shape', () => {
  it('returns a complete checks object with the expected keys for downstream persistence', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ movePct: 0.4 }),
      volumeRatio: 1.0,
      niftyChangePct: 0.1,
    });
    expect(r.checks).toHaveProperty('direction');
    expect(r.checks).toHaveProperty('volume');
    expect(r.checks).toHaveProperty('nifty_alignment');
    expect(r.checks.direction).toHaveProperty('stock_change_pct');
    expect(r.checks.volume).toHaveProperty('ratio');
    expect(r.checks.volume).toHaveProperty('threshold');
    expect(r.checks.nifty_alignment).toHaveProperty('threshold');
    expect(r.checks.nifty_alignment).toHaveProperty('against');
    expect(r).toHaveProperty('stock_change_pct');
  });

  it('stock_change_pct on the result equals direction.stock_change_pct', () => {
    const r = evaluateScannerOrbConfirmation({
      pick: LONG,
      orb: orbFromMove({ open: 1000, movePct: 0.73 }),
      volumeRatio: 1.0,
      niftyChangePct: 0,
    });
    expect(r.stock_change_pct).toBeCloseTo(0.73, 6);
    expect(r.checks.direction.stock_change_pct).toBeCloseTo(0.73, 6);
  });
});
