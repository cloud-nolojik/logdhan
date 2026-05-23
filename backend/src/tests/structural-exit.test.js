/**
 * Unit tests for analyzeIntradayStructure — May 2026 cushion + two-bar gates.
 *
 * Gating logic:
 *   1. If 15-min structure breaks (last close < prior low for LONG):
 *      a. Below STRUCTURE_EXIT_MIN_R_CUSHION (0.5R) profit → downgrade to tighten
 *      b. Above 0.5R but prior bar didn't ALSO break → downgrade to tighten (await confirmation)
 *      c. Above 0.5R AND prior bar also broke → exit
 *   2. Anything else: existing trail / hold / tighten logic.
 */

import { describe, it, expect } from 'vitest';
import { analyzeIntradayStructure } from '../services/dailyPicks/tradingDecisions.js';
import { STRUCTURE_EXIT_MIN_R_CUSHION } from '../services/dailyPicks/dailyPicksConstants.js';

// Realistic 5-min candle pair (bullish prev, mildly bearish last).
// Most tests reuse this since the 5-min layer isn't what we're testing.
const baseline5m = [
  { open: 100.0, high: 100.6, low: 99.7, close: 100.4, volume: 1000 },
  { open: 100.4, high: 100.5, low: 99.0, close: 99.2,  volume: 1100 },
];

describe('analyzeIntradayStructure — cushion gate (Layer 1)', () => {
  // Reusable breaking-structure fixture: last 15-min closed below prior low.
  // c-2: open=99, high=100, low=98,   close=99
  // c-1: open=100, high=102, low=99,  close=101   (prior low = 99)
  // c0:  open=101, high=101.5,low=98, close=98.5  (close 98.5 < prior low 99 → break)
  const breaking15m = [
    { open: 99,    high: 100,  low: 98,   close: 99   },
    { open: 100,   high: 102,  low: 99,   close: 101  },
    { open: 101,   high: 101.5,low: 98.0, close: 98.5 },
  ];

  it('LOSING trade below cushion → tighten (cushion gate fires)', () => {
    // entry=100, plannedStop=95 → risk=5. Close=98.5 → unrealized=(98.5-100)/5=-0.3R.
    // Trade is underwater; below cushion. Cushion gate must downgrade exit.
    const r = analyzeIntradayStructure({
      candles5m: baseline5m,
      candles15m: breaking15m,
      direction: 'LONG',
      currentStop: 95,
      entryPrice: 100,
      plannedStop: 95,
    });
    expect(r.action).not.toBe('exit');
    expect(['tighten', 'hold']).toContain(r.action);
    expect(r.reason).toMatch(/cushion|unrealized/i);
  });

  it('WINNING trade still below 0.5R cushion → tighten (cushion gate fires)', () => {
    // entry=98.0, plannedStop=93.0 → risk=5.0. Close=98.5 → unrealized=(98.5-98)/5=+0.1R.
    // Trade is profitable but cushion (+0.5R) not yet built. Cushion gate
    // must downgrade exit regardless. This is the case N5 said was missing.
    const r = analyzeIntradayStructure({
      candles5m: baseline5m,
      candles15m: breaking15m,
      direction: 'LONG',
      currentStop: 93,
      entryPrice: 98.0,
      plannedStop: 93,
    });
    expect(r.action).not.toBe('exit');
    expect(['tighten', 'hold']).toContain(r.action);
    expect(r.reason).toMatch(/cushion|unrealized/i);
    // Specifically, the reason must mention R math (not, e.g., two-bar)
    expect(r.reason).toMatch(/unrealized R/);
  });

  it('cushion threshold matches constant (0.5R default)', () => {
    expect(STRUCTURE_EXIT_MIN_R_CUSHION).toBe(0.5);
  });
});

describe('analyzeIntradayStructure — two-bar confirmation gate (Layer 2)', () => {
  it('above cushion but only single bar broke → tighten (await confirmation)', () => {
    // Trade is at +0.5R+ unrealized. Last 15-min broke, prior 15-min did NOT.
    const candles15m = [
      { open: 99,    high: 100, low:  98,   close: 99.5 },  // c-2: low=98
      { open: 100,   high: 102, low:  99,   close: 101  },  // c-1: close 101 > c-2.low 98 → DID NOT break
      { open: 101,   high: 101.5,low: 98.5, close: 98.8 },  // c0: close 98.8 < c-1.low 99 → break #1 only
    ];
    const r = analyzeIntradayStructure({
      candles5m: baseline5m,
      candles15m,
      direction: 'LONG',
      currentStop: 95,
      entryPrice: 96,           // unrealized = (98.8-96)/5 = +0.56R → above cushion
      plannedStop: 91,
    });
    expect(r.action).not.toBe('exit');
    expect(['tighten', 'hold']).toContain(r.action);
    expect(r.reason).toMatch(/unconfirmed|prior 15-min/i);
  });

  it('two consecutive breaks above cushion → exit', () => {
    const candles15m = [
      { open: 100,   high: 101, low:  99.5, close: 100.5 }, // c-2: low=99.5
      { open: 100.5, high: 100.7,low: 99.0, close: 99.2 },  // c-1: close 99.2 < c-2.low 99.5 → break
      { open: 99.2,  high: 99.5,low:  98.5, close: 98.7 },  // c0:  close 98.7 < c-1.low 99.0 → break (confirms)
    ];
    const r = analyzeIntradayStructure({
      candles5m: baseline5m,
      candles15m,
      direction: 'LONG',
      currentStop: 95,
      entryPrice: 96,           // unrealized = (98.7-96)/5 = +0.54R → above cushion
      plannedStop: 91,
    });
    expect(r.action).toBe('exit');
    expect(r.reason).toMatch(/CONFIRMED/);
  });

  it('below cushion overrides two-bar confirmation → still tighten', () => {
    // Both bars broke but we're losing money — cushion gate wins.
    const candles15m = [
      { open: 100,   high: 101, low:  99.5, close: 100.5 },
      { open: 100.5, high: 100.7,low: 99.0, close: 99.2 },
      { open: 99.2,  high: 99.5,low:  98.5, close: 98.7 },
    ];
    const r = analyzeIntradayStructure({
      candles5m: baseline5m,
      candles15m,
      direction: 'LONG',
      currentStop: 95,
      entryPrice: 100,          // unrealized = -0.26R → below cushion
      plannedStop: 95,
    });
    expect(r.action).not.toBe('exit');
    expect(['tighten', 'hold']).toContain(r.action);
  });

  it('insufficient history (only 2 15-min candles) → tighten (cannot confirm)', () => {
    const candles15m = [
      { open: 100, high: 102,  low: 99,    close: 101  },
      { open: 101, high: 101.5,low: 98.5,  close: 98.6 },
    ];
    const r = analyzeIntradayStructure({
      candles5m: baseline5m,
      candles15m,
      direction: 'LONG',
      currentStop: 95,
      entryPrice: 96,
      plannedStop: 91,
    });
    expect(r.action).not.toBe('exit');
    expect(r.reason).toMatch(/insufficient/i);
  });
});

describe('analyzeIntradayStructure — missing R-context fail-loud (review S3)', () => {
  it('caller without entryPrice → hold with MISSING_R_CONTEXT reason', () => {
    const breaking15m = [
      { open: 100,   high: 101, low:  99.5, close: 100.5 },
      { open: 100.5, high: 100.7,low: 99.0, close: 99.2 },
      { open: 99.2,  high: 99.5,low:  98.5, close: 98.7 },
    ];
    const r = analyzeIntradayStructure({
      candles5m: baseline5m,
      candles15m: breaking15m,
      direction: 'LONG',
      currentStop: 95,
      // entryPrice + plannedStop omitted on purpose
    });
    expect(r.action).toBe('hold');
    expect(r.reason).toMatch(/MISSING_R_CONTEXT/);
    expect(r.newStop).toBeNull();
  });

  it('caller without plannedStop → hold with MISSING_R_CONTEXT reason', () => {
    const breaking15m = [
      { open: 100,   high: 101, low:  99.5, close: 100.5 },
      { open: 100.5, high: 100.7,low: 99.0, close: 99.2 },
      { open: 99.2,  high: 99.5,low:  98.5, close: 98.7 },
    ];
    const r = analyzeIntradayStructure({
      candles5m: baseline5m,
      candles15m: breaking15m,
      direction: 'LONG',
      currentStop: 95,
      entryPrice: 96,
      // plannedStop omitted
    });
    expect(r.action).toBe('hold');
    expect(r.reason).toMatch(/MISSING_R_CONTEXT/);
  });
});

describe('analyzeIntradayStructure — SHORT direction mirror', () => {
  it('SHORT: two consecutive upside breaks above cushion → exit', () => {
    // For SHORT, structure breaks when close > prior high
    const candles15m = [
      { open: 100,   high: 100.5, low: 99.5, close: 99.8 },  // c-2: high=100.5
      { open: 99.8,  high: 101.0, low: 99.0, close: 100.8 }, // c-1: close 100.8 > c-2.high 100.5 → break
      { open: 100.8, high: 102.0, low: 100.5,close: 101.5 }, // c0: close 101.5 > c-1.high 101.0 → break (confirms)
    ];
    // For SHORT: entryPrice high, plannedStop higher (above entry)
    //   profit = entry - currentClose; in our case entry=104, close=101.5 → +0.5R if risk=5
    const r = analyzeIntradayStructure({
      candles5m: baseline5m,    // 5m doesn't matter for exit gate
      candles15m,
      direction: 'SHORT',
      currentStop: 109,
      entryPrice: 104,          // unrealized = (104-101.5)/5 = +0.5R → at cushion
      plannedStop: 109,
    });
    expect(r.action).toBe('exit');
    expect(r.reason).toMatch(/CONFIRMED/);
  });
});

describe('analyzeIntradayStructure — happy path (no break)', () => {
  it('uptrend intact + bullish 5-min → trail (no exit)', () => {
    const candles15m = [
      { open: 99,  high: 100,  low: 98.5, close: 99.5  }, // higher-low setup
      { open: 99.5,high: 101,  low: 99.0, close: 100.5 },
      { open: 100.5,high: 102, low: 100.0,close: 101.5 }, // higher low + higher close
    ];
    const c5 = [
      { open: 100.5, high: 101.2, low: 100.3, close: 101.0, volume: 1500 },
      { open: 101.0, high: 101.8, low: 100.9, close: 101.6, volume: 2000 },  // bullish
    ];
    const r = analyzeIntradayStructure({
      candles5m: c5,
      candles15m,
      direction: 'LONG',
      currentStop: 99.0,
      entryPrice: 100,
      plannedStop: 95,
    });
    expect(r.action).not.toBe('exit');
  });
});
