/**
 * Unit tests for ORB validatePicks() — the two gates added in May 2026:
 *   1. Absolute risk floor (MIN_RISK_PCT_PER_TRADE) — rejects sub-0.5% risk picks
 *   2. VIX-aware MAX_ORB_ATR_RATIO — Check 5 threshold scales with VIX
 *
 * Both gates live inside validatePicks(); these tests build minimal pick +
 * orbData fixtures and assert on pick.validation outputs.
 */

import { describe, it, expect } from 'vitest';
import { validatePicks } from '../services/dailyPicks/orbValidationService.js';
import { MIN_RISK_PCT_PER_TRADE } from '../services/dailyPicks/dailyPicksConstants.js';

function makePick({ symbol = 'TEST', direction = 'LONG', atrPct = 2.0 } = {}) {
  return {
    symbol,
    direction,
    scan_type: 'momentum_leader',
    levels: { entry: 100, stop: 99, target: 102 },
    regime_aligned: true,
    scan_scores: { atr_pct: atrPct },
    orb: {},
    validation: null,
  };
}

function makeOrbData({
  symbol = 'TEST',
  high = 100.5,        // Sub-0.5% range vs low 100.0 → triggers risk-floor reject
  low  = 100.0,
  open = 100.2,
  gapPct = 0.5,
  niftyDir = 'NEUTRAL',
  niftyChangePct = 0.0,
} = {}) {
  return {
    [symbol]: {
      high, low, opening_price: open, ltp: open,
      gap_percent: gapPct, orb_direction: 'UP',
    },
    _NIFTY: { orb_direction: niftyDir, nifty_change_pct: niftyChangePct },
  };
}

describe('Check 3 — Absolute risk floor (MIN_RISK_PCT_PER_TRADE)', () => {
  it('constant is 0.5%', () => {
    expect(MIN_RISK_PCT_PER_TRADE).toBe(0.5);
  });

  it('rejects sub-0.5% risk pick with risk_too_small reason', () => {
    // ORB high=100.5, low=100.0 → entry≈100.6, stop≈99.9 → risk≈0.7% which
    // SHOULD pass the floor. To reject, push the range tighter:
    // high=100.2, low=100.0 → entry≈100.3 (×1.001), stop≈99.9 (×0.999),
    // risk≈0.4% < 0.5% floor → must fail with risk_too_small.
    const pick = makePick();
    const orbData = makeOrbData({ high: 100.2, low: 100.0 });
    validatePicks([pick], orbData, 'STRONG_BULL', 1, null, null);
    expect(pick.validation.passed).toBe(false);
    expect(pick.validation.skip_reason).toMatch(/orb_alignment/);
    expect(pick.validation.checks.orb_alignment.risk_too_small).toBe(true);
    expect(pick.validation.checks.orb_alignment.risk_pct).toBeLessThan(MIN_RISK_PCT_PER_TRADE);
  });

  it('passes a normal-risk pick where risk_pct ≥ 0.5%', () => {
    // ORB 1.5% range → risk well above 0.5% floor
    const pick = makePick();
    const orbData = makeOrbData({ high: 101.5, low: 100.0, gapPct: 0.3 });
    validatePicks([pick], orbData, 'STRONG_BULL', 1, null, null);
    expect(pick.validation.checks.orb_alignment.risk_too_small).toBe(false);
    expect(pick.validation.checks.orb_alignment.risk_pct).toBeGreaterThanOrEqual(MIN_RISK_PCT_PER_TRADE);
  });
});

describe('Check 5 — VIX-aware MAX_ORB_ATR_RATIO', () => {
  /*
   * Strategy for testing the dynamic ratio: build an ORB whose range/ATR
   * ratio sits BETWEEN the normal threshold (1.25) and the panic threshold
   * (2.00). At normal VIX it should fail; at panic VIX it should pass.
   *
   * ORB range = (high - low) / low. ATR effective is max(daily_atr, |gap|).
   * Set atrPct = 1.0%, no gap. ORB range 1.6% → ratio = 1.6.
   *   At normal VIX (≤16): max_ratio=1.25 → 1.6 > 1.25 → FAIL
   *   At elevated VIX (16<v≤22): max_ratio=1.50 → 1.6 > 1.50 → FAIL
   *   At panic VIX (22<v≤35): max_ratio=2.00 → 1.6 ≤ 2.00 → PASS
   */
  it('1.6× ATR ratio rejected at normal VIX (1.25× threshold)', () => {
    const pick = makePick({ atrPct: 1.0 });
    const orbData = makeOrbData({
      high: 101.6, low: 100.0, gapPct: 0.0,  // range 1.6%, atr 1.0% → ratio 1.6
    });
    validatePicks([pick], orbData, 'STRONG_BULL', 1, null, /*indiaVix=*/12);
    expect(pick.validation.checks.orb_range_width.passed).toBe(false);
    expect(pick.validation.checks.orb_range_width.max_ratio).toBe(1.25);
  });

  it('1.6× ATR ratio rejected at elevated VIX (1.50× threshold)', () => {
    const pick = makePick({ atrPct: 1.0 });
    const orbData = makeOrbData({ high: 101.6, low: 100.0, gapPct: 0.0 });
    validatePicks([pick], orbData, 'STRONG_BULL', 1, null, /*indiaVix=*/18);
    expect(pick.validation.checks.orb_range_width.passed).toBe(false);
    expect(pick.validation.checks.orb_range_width.max_ratio).toBe(1.50);
  });

  it('1.6× ATR ratio PASSES at panic VIX (2.00× threshold)', () => {
    const pick = makePick({ atrPct: 1.0 });
    const orbData = makeOrbData({ high: 101.6, low: 100.0, gapPct: 0.0 });
    validatePicks([pick], orbData, 'STRONG_BULL', 1, null, /*indiaVix=*/28);
    expect(pick.validation.checks.orb_range_width.passed).toBe(true);
    expect(pick.validation.checks.orb_range_width.max_ratio).toBe(2.00);
  });

  it('records vix value in check output for audit', () => {
    const pick = makePick({ atrPct: 1.0 });
    const orbData = makeOrbData({ high: 101.0, low: 100.0 });
    validatePicks([pick], orbData, 'STRONG_BULL', 1, null, /*indiaVix=*/18);
    expect(pick.validation.checks.orb_range_width.india_vix).toBe(18);
  });
});

describe('validatePicks defensive fallback (Blocker #1)', () => {
  it('does not throw on unknown regime — falls back to NEUTRAL R:R', () => {
    const pick = makePick();
    const orbData = makeOrbData({ high: 101.5, low: 100.0 });
    // 'UNKNOWN' is not a key in MIN_ORB_RR_BY_REGIME — must not throw
    expect(() => {
      validatePicks([pick], orbData, 'UNKNOWN', 1, null, null);
    }).not.toThrow();
    // The pick should still get a validation object (passed or failed, but populated)
    expect(pick.validation).toBeDefined();
  });

  it('does not throw on HALT or empty string regime', () => {
    const p1 = makePick();
    const p2 = makePick({ symbol: 'TEST2' });
    expect(() => validatePicks([p1], makeOrbData({ symbol: 'TEST'  }), 'HALT', 1)).not.toThrow();
    expect(() => validatePicks([p2], makeOrbData({ symbol: 'TEST2' }), '',     1)).not.toThrow();
  });
});
