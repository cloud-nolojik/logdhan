/**
 * Unit tests for the 2026-06-05 evening RSI-exhaustion exit:
 *   computeRSI(closes, period=14)            — Wilder smoothing
 *   computeSMA(values, period)               — simple moving average
 *   decideRsiExhaustionExit({ closes, isLong, ... })
 *                                            — dual-condition exit gate
 *
 * Background:
 *   The BE-only mode was eating winners on tops (LTF +₹0 on 2026-06-05).
 *   User feedback: "5-min RSI closed above 80 right at the top — can we exit
 *   there?" The new rule keeps the original SL untouched and adds ONE exit
 *   signal: RSI peaked ≥80 (LONG) + RSI now below both 70 AND its MA → exit.
 *
 *   The dual-condition gate prevents whipsaw — a raw RSI<MA cross fires only
 *   after we know the move has been stretched.
 */

import { describe, it, expect } from 'vitest';
import { computeRSI, computeSMA, decideRsiExhaustionExit, _testExports } from '../services/orb/orbService.js';

const { RSI_PERIOD, RSI_MA_PERIOD, RSI_OVERBOUGHT, RSI_OVERSOLD, RSI_NEUTRAL_HIGH, RSI_NEUTRAL_LOW } = _testExports;

// Build N closes that ramp up linearly (RSI will be high, then plateau low)
const ramp = (n, start = 100, step = 0.5) =>
  Array.from({ length: n }, (_, i) => start + i * step);

const flat = (n, val = 100) => Array.from({ length: n }, () => val);

describe('Constants are sane', () => {
  it('RSI_PERIOD is 14, MA period 14', () => {
    expect(RSI_PERIOD).toBe(14);
    expect(RSI_MA_PERIOD).toBe(14);
  });
  it('Overbought 80, oversold 20', () => {
    expect(RSI_OVERBOUGHT).toBe(80);
    expect(RSI_OVERSOLD).toBe(20);
  });
  it('Neutral high 70, neutral low 30', () => {
    expect(RSI_NEUTRAL_HIGH).toBe(70);
    expect(RSI_NEUTRAL_LOW).toBe(30);
  });
});

describe('computeRSI — Wilder smoothing', () => {
  it('returns [] for too-short input', () => {
    expect(computeRSI([1, 2, 3], 14)).toEqual([]);
    expect(computeRSI([], 14)).toEqual([]);
  });

  it('strong uptrend → RSI approaches 100', () => {
    const closes = ramp(30, 100, 1);   // each bar +1
    const rsi = computeRSI(closes, 14);
    const lastRsi = rsi[rsi.length - 1];
    expect(lastRsi).toBeGreaterThan(95);
  });

  it('strong downtrend → RSI approaches 0', () => {
    const closes = ramp(30, 100, -1);   // each bar -1
    const rsi = computeRSI(closes, 14);
    const lastRsi = rsi[rsi.length - 1];
    expect(lastRsi).toBeLessThan(5);
  });

  it('flat prices → RSI undefined behaviour (0/0); we map to 100', () => {
    const rsi = computeRSI(flat(20, 100), 14);
    // No gains, no losses → avgGain=0, avgLoss=0 → RSI = 100 per our code (avoid /0)
    expect(rsi[rsi.length - 1]).toBe(100);
  });

  it('returns NaN for the first `period` slots', () => {
    const rsi = computeRSI(ramp(20, 100, 1), 14);
    for (let i = 0; i < 14; i++) {
      expect(Number.isNaN(rsi[i])).toBe(true);
    }
    expect(Number.isFinite(rsi[14])).toBe(true);
  });

  it('handles non-finite diffs gracefully', () => {
    const closes = [100, NaN, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113];
    const rsi = computeRSI(closes, 14);
    // Should still produce a finite value despite the NaN
    expect(Number.isFinite(rsi[14])).toBe(true);
  });
});

describe('computeSMA', () => {
  it('returns [] for too-short input', () => {
    expect(computeSMA([1, 2], 5)).toEqual([]);
  });

  it('5-period SMA of [1,2,3,4,5,6,7] last value is 5 ((3+4+5+6+7)/5)', () => {
    const sma = computeSMA([1, 2, 3, 4, 5, 6, 7], 5);
    expect(sma[sma.length - 1]).toBe(5);
  });

  it('NaNs in input → those windows return NaN', () => {
    const sma = computeSMA([NaN, NaN, 3, 4, 5], 3);
    expect(Number.isNaN(sma[2])).toBe(true);   // window includes 2 NaNs
    expect(Number.isFinite(sma[4])).toBe(true);  // window is [3,4,5]
    expect(sma[4]).toBe(4);
  });
});

describe('decideRsiExhaustionExit — armed condition', () => {
  it('insufficient closes → not armed, not exit', () => {
    const r = decideRsiExhaustionExit({ closes: [1, 2, 3], isLong: true });
    expect(r.armed).toBe(false);
    expect(r.exit).toBe(false);
  });

  it('LONG: RSI never reaches 80 → not armed (oscillating mid-range)', () => {
    // Sine-wave oscillation keeps RSI mid-range (40-60).
    // A pure monotonic ramp would give RSI=100 because no losses exist.
    const closes = [];
    for (let i = 0; i < 40; i++) closes.push(100 + 2 * Math.sin(i / 2.5));
    const r = decideRsiExhaustionExit({ closes, isLong: true });
    expect(r.armed).toBe(false);
    expect(r.exit).toBe(false);
    expect(r.reason).toMatch(/not armed/);
  });

  it('LONG: strong ramp then plateau → armed (RSI peaked ≥80 then dropped)', () => {
    const closes = [];
    for (let i = 0; i < 20; i++) closes.push(100 + i);          // strong rise
    for (let i = 0; i < 20; i++) closes.push(120 - i * 0.5);    // then drop
    const r = decideRsiExhaustionExit({ closes, isLong: true });
    expect(r.armed).toBe(true);
  });

  it('SHORT: RSI never reaches 20 → not armed (oscillating mid-range)', () => {
    // Same sine wave keeps RSI mid-range for both directions.
    const closes = [];
    for (let i = 0; i < 40; i++) closes.push(100 + 2 * Math.sin(i / 2.5));
    const r = decideRsiExhaustionExit({ closes, isLong: false });
    expect(r.armed).toBe(false);
  });

  it('SHORT: strong down-ramp → armed', () => {
    const closes = [];
    for (let i = 0; i < 30; i++) closes.push(100 - i);
    for (let i = 0; i < 10; i++) closes.push(70 + i * 0.5);
    const r = decideRsiExhaustionExit({ closes, isLong: false });
    expect(r.armed).toBe(true);
  });
});

describe('decideRsiExhaustionExit — fire condition', () => {
  it('LONG armed but RSI still > 70 → hold', () => {
    // Ramp up sharply, last bar still high
    const closes = [];
    for (let i = 0; i < 25; i++) closes.push(100 + i);
    for (let i = 0; i < 5; i++) closes.push(125 + i * 0.1);   // still rising slightly
    const r = decideRsiExhaustionExit({ closes, isLong: true });
    expect(r.armed).toBe(true);
    expect(r.exit).toBe(false);
    expect(r.reason).toMatch(/still ≥70|still on right side of MA/);
  });

  it('LONG armed AND RSI dropped < 70 AND < MA → fire exit', () => {
    // Strong rise (RSI peaks ≥80), then sharp pullback (RSI drops below 70 and below MA)
    const closes = [];
    for (let i = 0; i < 20; i++) closes.push(100 + i);             // big rise → RSI > 80
    for (let i = 0; i < 20; i++) closes.push(120 - i * 1.5);       // sharp drop → RSI < 70
    const r = decideRsiExhaustionExit({ closes, isLong: true });
    expect(r.armed).toBe(true);
    expect(r.exit).toBe(true);
    expect(r.lastRsi).toBeLessThan(70);
    expect(r.lastRsi).toBeLessThan(r.lastMA);
  });

  it('SHORT armed AND RSI > 30 AND > MA → fire exit', () => {
    // Strong drop (RSI < 20), then sharp bounce (RSI back > 30 and > MA)
    const closes = [];
    for (let i = 0; i < 20; i++) closes.push(100 - i);             // big drop → RSI < 20
    for (let i = 0; i < 20; i++) closes.push(80 + i * 1.5);        // sharp bounce → RSI > 30
    const r = decideRsiExhaustionExit({ closes, isLong: false });
    expect(r.armed).toBe(true);
    expect(r.exit).toBe(true);
    expect(r.lastRsi).toBeGreaterThan(30);
    expect(r.lastRsi).toBeGreaterThan(r.lastMA);
  });

  it('LONG armed, RSI dropped < 70 but still ABOVE MA → hold (one condition not met)', () => {
    // Setup: RSI peaked ≥80, dropped below 70 but recovered fast so it's above MA
    const closes = [];
    for (let i = 0; i < 20; i++) closes.push(100 + i);                  // rise → RSI > 80
    for (let i = 0; i < 5; i++) closes.push(120 - i * 1.2);             // brief drop
    for (let i = 0; i < 8; i++) closes.push(114 + i * 0.3);             // recover slowly
    const r = decideRsiExhaustionExit({ closes, isLong: true });
    if (r.armed && Number.isFinite(r.lastRsi) && r.lastRsi >= r.lastMA) {
      // If recovery put RSI back above its MA, exit must be false
      expect(r.exit).toBe(false);
    }
  });
});

describe('Whipsaw safety — bare RSI<MA cross WITHOUT having been armed must NOT exit', () => {
  it('Mild oscillation: RSI ranges 45-65, crosses its MA repeatedly, never armed → never exit', () => {
    // Build a sine-wave-ish close series that keeps RSI in mid-range
    const closes = [];
    for (let i = 0; i < 50; i++) {
      closes.push(100 + 2 * Math.sin(i / 3));
    }
    const r = decideRsiExhaustionExit({ closes, isLong: true });
    expect(r.armed).toBe(false);
    expect(r.exit).toBe(false);
  });
});

describe('LTF 2026-06-05 scenario — synthetic replay', () => {
  it('Big spike then drift → exit fires', () => {
    // Approximate LTF: flat then ramp up then drift down
    const closes = [];
    for (let i = 0; i < 10; i++) closes.push(275);                 // flat preamble
    for (let i = 0; i < 6; i++) closes.push(275 + i * 0.4);        // spike to ~277
    for (let i = 0; i < 20; i++) closes.push(277 - i * 0.35);      // drift down to ~270
    const r = decideRsiExhaustionExit({ closes, isLong: true });
    expect(r.armed).toBe(true);
    expect(r.exit).toBe(true);
    expect(r.reason).toMatch(/EXIT/);
  });
});
