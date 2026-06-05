/**
 * Unit tests for the 2026-06-05 BE-only stop-management mode.
 *
 * Two pure helpers under test:
 *   computeATR(bars, period=14)        — Wilder's average True Range
 *   computeBeStop({entry, isLong, atr5m}) — BE move with ATR-adaptive cushion
 *
 * Background:
 *   After 8 trades on 2026-06-05 (-₹417 net), the candle-based trail/tighten
 *   engine was identified as the dominant loss driver. The replacement is
 *   pure "BE-only" (Douglas / Bandy): hold original SL until +1R, then move
 *   to entry ± max(0.3% × entry, 0.5 × ATR_5min). No further tightening.
 *
 *   The cushion prevents the "₹0 PnL" stop pattern (LTF 2026-06-05: entered
 *   ₹275.80, BE = entry, stopped at ₹275.80 for ₹0 booked).
 */

import { describe, it, expect } from 'vitest';
import { computeATR, computeBeStop, _testExports } from '../services/orb/orbService.js';

const { BE_CUSHION_PCT, BE_CUSHION_ATR_MULT } = _testExports;

// Helper to build a synthetic 5-min candle.
const bar = (close, range = 1) => ({
  open: close - range / 2,
  high: close + range / 2,
  low:  close - range / 2,
  close,
});

describe('Constants are sane', () => {
  it('BE_CUSHION_PCT is 0.3%', () => {
    expect(BE_CUSHION_PCT).toBe(0.3);
  });
  it('BE_CUSHION_ATR_MULT is 0.5', () => {
    expect(BE_CUSHION_ATR_MULT).toBe(0.5);
  });
});

describe('computeATR — Wilder true-range average', () => {
  it('returns 0 for empty input', () => {
    expect(computeATR([])).toBe(0);
    expect(computeATR(null)).toBe(0);
  });

  it('returns 0 with only 1 bar (no prevClose to compute TR)', () => {
    expect(computeATR([bar(100, 2)])).toBe(0);
  });

  it('computes TR over 2 bars correctly', () => {
    // bar1: H=101, L=99, C=100
    // bar2: H=103, L=101, prev close=100 → TR = max(2, 3, 1) = 3
    const bars = [
      { high: 101, low: 99, close: 100 },
      { high: 103, low: 101, close: 102 },
    ];
    expect(computeATR(bars, 14)).toBe(3);
  });

  it('averages TR over last N bars', () => {
    const bars = [
      { high: 100, low: 100, close: 100 },
      { high: 101, low: 99,  close: 100 },   // TR = max(2, 1, 1) = 2
      { high: 102, low: 100, close: 101 },   // TR = max(2, 2, 0) = 2
      { high: 103, low: 102, close: 103 },   // TR = max(1, 2, 1) = 2
    ];
    expect(computeATR(bars, 14)).toBe(2);   // (2 + 2 + 2) / 3 = 2
  });

  it('respects period — uses only last N TRs', () => {
    const bars = [
      { high: 100, low: 100, close: 100 },
      { high: 110, low: 100, close: 105 },   // TR = 10 (big bar)
      { high: 106, low: 104, close: 105 },   // TR = max(2, 1, 1) = 2
      { high: 107, low: 105, close: 106 },   // TR = 2
    ];
    // With period=2, only last 2 TRs (2 and 2) → ATR = 2 (ignores the 10-TR big bar)
    expect(computeATR(bars, 2)).toBe(2);
    // With period=14, all 3 TRs (10, 2, 2) → ATR = 14/3 ≈ 4.67
    expect(computeATR(bars, 14)).toBeCloseTo(4.67, 1);
  });

  it('skips malformed bars (NaN high/low/close)', () => {
    const bars = [
      { high: 100, low: 100, close: 100 },
      { high: NaN, low: 99, close: 100 },   // skipped
      { high: 103, low: 101, close: 102 },  // TR = max(2, 3, 1) = 3
    ];
    expect(computeATR(bars, 14)).toBe(3);
  });
});

describe('computeBeStop — cushioned breakeven', () => {
  it('LONG with no ATR → uses pct floor (0.3% below entry)', () => {
    const stop = computeBeStop({ entry: 100, isLong: true, atr5m: 0 });
    expect(stop).toBe(99.7);   // 100 - 0.3% = 99.7
  });

  it('SHORT with no ATR → uses pct floor (0.3% above entry)', () => {
    const stop = computeBeStop({ entry: 100, isLong: false, atr5m: 0 });
    expect(stop).toBe(100.3);   // 100 + 0.3%
  });

  it('LONG with low ATR → pct floor dominates (max wins)', () => {
    // entry 100, atr5m 0.4 → pct cushion = 0.3, atr cushion = 0.2 → use 0.3
    const stop = computeBeStop({ entry: 100, isLong: true, atr5m: 0.4 });
    expect(stop).toBe(99.7);
  });

  it('LONG with high ATR → ATR cushion dominates', () => {
    // entry 100, atr5m 2 → pct cushion = 0.3, atr cushion = 1.0 → use 1.0
    const stop = computeBeStop({ entry: 100, isLong: true, atr5m: 2 });
    expect(stop).toBe(99);
  });

  it('SHORT with high ATR → ATR cushion dominates', () => {
    const stop = computeBeStop({ entry: 100, isLong: false, atr5m: 2 });
    expect(stop).toBe(101);   // 100 + 1.0
  });

  it('treats undefined atr5m as 0 (pct-only fallback)', () => {
    const stop = computeBeStop({ entry: 1000, isLong: true });
    expect(stop).toBeCloseTo(997, 5);   // 1000 - 0.3% = 997
  });

  it('LONG replay 2026-06-05: LTF entry 275.80 with avg ATR ~1.5', () => {
    // Pct cushion: 275.80 × 0.003 = 0.827
    // ATR cushion: 1.5 × 0.5 = 0.75
    // Max = 0.827 → BE stop ≈ 274.97
    const stop = computeBeStop({ entry: 275.80, isLong: true, atr5m: 1.5 });
    expect(stop).toBeCloseTo(274.973, 2);
    // Critically: SL must NOT equal entry (the bug we're fixing)
    expect(stop).toBeLessThan(275.80);
    // And must give meaningful breathing room (not within 1 paise of entry)
    expect(275.80 - stop).toBeGreaterThan(0.5);
  });

  it('LONG replay 2026-06-05: BAJFINANCE entry 902 with ATR ~4', () => {
    // Pct: 902 × 0.003 = 2.706
    // ATR: 4 × 0.5 = 2.0
    // Max = 2.706 → BE ≈ 899.294
    const stop = computeBeStop({ entry: 902, isLong: true, atr5m: 4 });
    expect(stop).toBeCloseTo(899.294, 2);
    // The 2026-06-05 tighten was 906 (above entry, immediately hit). New BE
    // is below entry, giving room for the trade to continue developing.
    expect(stop).toBeLessThan(902);
  });

  it('SHORT replay 2026-06-05: AMBUJACEM entry 420 (illustrative)', () => {
    // entry 420, atr5m 1.5 → pct 1.26, atr 0.75 → max 1.26 → BE ≈ 421.26
    const stop = computeBeStop({ entry: 420, isLong: false, atr5m: 1.5 });
    expect(stop).toBeCloseTo(421.26, 2);
    expect(stop).toBeGreaterThan(420);
  });

  it('integrates with computeATR — full pipeline on synthetic data', () => {
    // Build 5 bars with consistent ranges ≈ 1.5
    const bars = [];
    for (let i = 0; i < 5; i++) {
      bars.push({ high: 100 + i + 0.75, low: 100 + i - 0.75, close: 100 + i });
    }
    const atr = computeATR(bars, 14);
    const stop = computeBeStop({ entry: 100, isLong: true, atr5m: atr });
    expect(atr).toBeGreaterThan(0);
    expect(stop).toBeLessThan(100);
    expect(stop).toBeGreaterThan(98);   // sanity: not way too far
  });
});

describe('Integration: cushion size is meaningful (not noise-equivalent)', () => {
  it('LTF-class stock (₹275, ATR 1.5) → cushion ≈ ₹0.83', () => {
    const cushion = 275.80 - computeBeStop({ entry: 275.80, isLong: true, atr5m: 1.5 });
    expect(cushion).toBeCloseTo(0.827, 2);
  });

  it('BAJFINANCE-class stock (₹902, ATR 4) → cushion ≈ ₹2.71', () => {
    const cushion = 902 - computeBeStop({ entry: 902, isLong: true, atr5m: 4 });
    expect(cushion).toBeCloseTo(2.706, 2);
  });

  it('high-vol stock (₹10000, ATR 50) → pct floor wins (cushion=₹30)', () => {
    // pct floor: 10000 × 0.003 = 30. ATR cushion: 50 × 0.5 = 25. Max = 30.
    const cushion = 10000 - computeBeStop({ entry: 10000, isLong: true, atr5m: 50 });
    expect(cushion).toBeCloseTo(30, 1);
  });

  it('very-high-vol stock (₹10000, ATR 100) → ATR dominates (cushion=₹50)', () => {
    // pct floor: 30. ATR: 100 × 0.5 = 50. Max = 50.
    const cushion = 10000 - computeBeStop({ entry: 10000, isLong: true, atr5m: 100 });
    expect(cushion).toBeCloseTo(50, 1);
  });

  it('low-priced stock (₹50, ATR 0.05) → pct floor → cushion ≈ ₹0.15', () => {
    const cushion = 50 - computeBeStop({ entry: 50, isLong: true, atr5m: 0.05 });
    expect(cushion).toBeCloseTo(0.15, 3);
  });
});
