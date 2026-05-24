/**
 * Unit tests for the LONG/SHORT symmetry fix in analyzeIntradayStructure.
 *
 * Before this fix, only LONG positions had pattern-based stop tightening:
 *   • Bearish engulfing  → tighten LONG stop
 *   • Shooting star       → tighten LONG stop
 *
 * SHORT positions had no equivalent — a bullish reversal candle against a
 * SHORT trade was ignored. These tests verify the SHORT mirrors now work:
 *   • Bullish engulfing  → tighten SHORT stop
 *   • Hammer              → tighten SHORT stop
 *   • Bearish continuation bar (against an UP-trending stock that's now down)
 *     → trail SHORT stop DOWN
 *   • Bearish bar with drying volume → exhaustion warning for SHORT
 */

import { describe, it, expect } from 'vitest';
import { analyzeIntradayStructure } from '../services/dailyPicks/tradingDecisions.js';

// 15-min frame where structure is intact for SHORT (lower-highs maintained).
// c-1: H=102 L=99   close=100   (the "prior" bar)
// c0:  H=101.5 L=98 close=99    (the "last" bar — lower-high preserved)
const shortIntact15m = [
  { open: 100, high: 102,   low: 99, close: 100 },
  { open: 100, high: 101.5, low: 98, close: 99  },
];

// 15-min frame intact for LONG (higher-lows maintained).
const longIntact15m = [
  { open: 100, high: 100.5, low: 99,  close: 100 },
  { open: 100, high: 101,   low: 99.5, close: 100.8 },
];

describe('SHORT — bullish engulfing reversal candle → tighten', () => {
  it('bullish engulfing of prior bar against an active SHORT → tighten to bar HIGH', () => {
    // Setup: SHORT position at entry=101, currentStop=103
    // 5-min bars:
    //   c-1 (prev): small bearish body — open 100.2, close 99.8, range 99.5-100.4 → body 0.4
    //   c0  (last): strong BULLISH body engulfing prior — open 99.8, close 101.0
    //               body 1.2 > prev body 0.4, opens ≤ prev close (99.8 ≤ 99.8), closes ≥ prev open (101.0 ≥ 100.2) ✓
    const candles5m = [
      { open: 100.2, high: 100.4, low: 99.5, close: 99.8,  volume: 1000 },
      { open: 99.8,  high: 101.2, low: 99.7, close: 101.0, volume: 1500 },
    ];
    const result = analyzeIntradayStructure({
      candles5m,
      candles15m: shortIntact15m,
      direction: 'SHORT',
      currentStop: 103,
      entryPrice: 101,
      plannedStop: 103,
    });
    expect(result.action).toBe('tighten');
    expect(result.reason).toMatch(/bullish engulfing/);
    expect(result.newStop).toBe(101.2);   // tightened to the bar HIGH
  });
});

describe('SHORT — hammer reversal candle → tighten', () => {
  it('hammer with long lower wick against an active SHORT → tighten to bar HIGH', () => {
    // Hammer: long lower wick > 2× body, small body in upper third of range.
    // Body = |close - open| = small. Lower wick = min(open,close) - low = LARGE.
    //   open=100, close=100.2, high=100.3, low=99.0
    //   body = 0.2, range = 1.3, lower wick = min(100, 100.2) - 99 = 1.0
    //   lowerWick (1.0) > 2 × body (0.4)? YES
    //   body (0.2) < 0.30 × range (0.39)? YES
    const candles5m = [
      { open: 99.5, high: 100, low: 99,   close: 99.8, volume: 1000 },
      { open: 100,  high: 100.3, low: 99, close: 100.2, volume: 1200 },
    ];
    const result = analyzeIntradayStructure({
      candles5m,
      candles15m: shortIntact15m,
      direction: 'SHORT',
      currentStop: 103,
      entryPrice: 101,
      plannedStop: 103,
    });
    expect(result.action).toBe('tighten');
    expect(result.reason).toMatch(/hammer/);
    expect(result.newStop).toBe(100.3);   // tightened to bar HIGH (above the hammer)
  });
});

describe('SHORT — bearish continuation bar trails stop DOWN', () => {
  it('strong bearish 5-min bar with structure intact → trail SHORT stop DOWN to bar HIGH', () => {
    // Bearish bar: close < open, body > 50% of range.
    // open=100, close=98.5, high=100.1, low=98.4 → body=1.5, range=1.7, bodyRatio=0.88
    // Need volume not drying (last vol ~= avg of prior 3).
    const candles5m = [
      { open: 101, high: 101.2, low: 100.5, close: 100.8, volume: 1000 },
      { open: 100.8, high: 101, low: 100.4, close: 100.5, volume: 1100 },
      { open: 100.5, high: 100.7, low: 100.2, close: 100.3, volume: 950 },
      { open: 100.3, high: 100.5, low: 100,   close: 100.2, volume: 1050 },
      { open: 100,   high: 100.1, low: 98.4,  close: 98.5,  volume: 1080 },  // last — strong bearish
    ];
    const result = analyzeIntradayStructure({
      candles5m,
      candles15m: shortIntact15m,
      direction: 'SHORT',
      currentStop: 103,
      entryPrice: 101,
      plannedStop: 103,
    });
    expect(result.action).toBe('trail');
    expect(result.reason).toMatch(/bearish.*continuation/);
    expect(result.newStop).toBe(100.1);   // trail to bar HIGH (above the close)
    expect(result.newStop).toBeLessThan(103);   // strictly below the prior stop = improvement
  });
});

describe('SHORT — bearish bar but volume drying → exhaustion warning, no trail', () => {
  it('bearish bar with drying volume → hold (don\'t move stop, warn instead)', () => {
    const candles5m = [
      { open: 101, high: 101.2, low: 100.5, close: 100.8, volume: 5000 },
      { open: 100.8, high: 101, low: 100.4, close: 100.5, volume: 4500 },
      { open: 100.5, high: 100.7, low: 100.2, close: 100.3, volume: 5500 },
      { open: 100,   high: 100.1, low: 98.4,  close: 98.5,  volume: 1000 }, // last — strong bearish but vol << avg
    ];
    const result = analyzeIntradayStructure({
      candles5m,
      candles15m: shortIntact15m,
      direction: 'SHORT',
      currentStop: 103,
      entryPrice: 101,
      plannedStop: 103,
    });
    expect(result.action).toBe('hold');
    expect(result.reason).toMatch(/volume drying/);
    expect(result.reason).toMatch(/exhaustion risk on SHORT/);
    expect(result.newStop).toBeNull();
  });
});

describe('Symmetry check — LONG patterns still fire as before (regression guard)', () => {
  it('LONG + bearish engulfing → tighten (unchanged behavior)', () => {
    const candles5m = [
      { open: 99.5, high: 99.8, low: 99.3, close: 99.7,  volume: 1000 },
      { open: 99.7, high: 99.8, low: 98.5, close: 98.7,  volume: 1500 },  // bearish, body bigger
    ];
    const result = analyzeIntradayStructure({
      candles5m,
      candles15m: longIntact15m,
      direction: 'LONG',
      currentStop: 97,
      entryPrice: 99,
      plannedStop: 97,
    });
    expect(result.action).toBe('tighten');
    expect(result.reason).toMatch(/bearish engulfing/);
    expect(result.newStop).toBe(98.5);   // bar's LOW
  });

  it('LONG + shooting star → tighten (unchanged behavior)', () => {
    // Body 0.1, upper wick 0.8 — wick > 2× body, body < 30% of range
    const candles5m = [
      { open: 99.5, high: 99.7, low: 99.3, close: 99.6, volume: 1000 },
      { open: 99.5, high: 100.5, low: 99.4, close: 99.6, volume: 1200 },
    ];
    const result = analyzeIntradayStructure({
      candles5m,
      candles15m: longIntact15m,
      direction: 'LONG',
      currentStop: 97,
      entryPrice: 99,
      plannedStop: 97,
    });
    expect(result.action).toBe('tighten');
    expect(result.reason).toMatch(/shooting star/);
    expect(result.newStop).toBe(99.4);   // bar's LOW
  });
});

describe('Direction-gating — patterns DON\'T fire on wrong side', () => {
  it('LONG position + bullish engulfing → NOT tightened (bull engulf is SHORT-only)', () => {
    // Same bullish engulfing bar that would fire for a SHORT
    const candles5m = [
      { open: 100.2, high: 100.4, low: 99.5, close: 99.8, volume: 1000 },
      { open: 99.8, high: 101.2, low: 99.7, close: 101.0, volume: 1500 },
    ];
    const result = analyzeIntradayStructure({
      candles5m,
      candles15m: longIntact15m,
      direction: 'LONG',
      currentStop: 97,
      entryPrice: 99,
      plannedStop: 97,
    });
    // Bullish engulfing on a LONG trade is just a strong continuation bar,
    // so it should TRAIL, not tighten.
    expect(result.action).not.toBe('tighten');
  });

  it('SHORT position + bearish engulfing → NOT tightened (bear engulf is LONG-only)', () => {
    // Bearish engulfing bar — would fire on a LONG, should NOT fire on a SHORT
    const candles5m = [
      { open: 99.5, high: 99.8, low: 99.3, close: 99.7, volume: 1000 },
      { open: 99.7, high: 99.8, low: 98.5, close: 98.7, volume: 1500 },
    ];
    const result = analyzeIntradayStructure({
      candles5m,
      candles15m: shortIntact15m,
      direction: 'SHORT',
      currentStop: 103,
      entryPrice: 101,
      plannedStop: 103,
    });
    // Bearish engulfing on a SHORT is a continuation bar → should trail or hold,
    // NOT a "tighten" via reversal logic.
    expect(result.action).not.toBe('tighten');
  });
});
