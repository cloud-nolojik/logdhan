import { describe, it, expect } from 'vitest';
import {
  computeStructure, computeBreadth, computeVolatility, computeOvernight, computeFlow,
  computeRegimeScore, scoreToLabel, scoreToSizing, decidePlaybook, buildMarketContext,
} from '../engine/regimeScoring.js';

describe('regime v2 input computation', () => {
  it('structure: all inputs zero → 0', () => {
    expect(computeStructure({ close: 100, ema20: 100, ema50: 100, ema50_prev5: 100 })).toBe(0);
  });

  it('structure: 3% above EMA50 + 2% above EMA20 + 1% slope → +1', () => {
    const s = computeStructure({ close: 103, ema20: 100.98, ema50: 100, ema50_prev5: 99.01 });
    expect(s).toBeCloseTo(1.0, 1);
  });

  it('structure: missing data → null', () => {
    expect(computeStructure({ close: 100 })).toBeNull();
    expect(computeStructure(null)).toBeNull();
  });

  it('breadth: 50% → 0, 75% → +1, 25% → -1', () => {
    expect(computeBreadth(50)).toBe(0);
    expect(computeBreadth(75)).toBe(1);
    expect(computeBreadth(25)).toBe(-1);
    expect(computeBreadth(null)).toBeNull();
  });

  it('volatility inverts VIX: low pct → +1, high pct → -1', () => {
    expect(computeVolatility(25)).toBe(1);
    expect(computeVolatility(50)).toBe(0);
    expect(computeVolatility(75)).toBe(-1);
    expect(computeVolatility(null)).toBeNull();
  });

  it('overnight: pure GIFT when Asia/DXY null', () => {
    const o = computeOvernight({ giftPct: 0.75 });
    expect(o).toBeCloseTo(1.0, 1);
  });

  it('overnight: DXY sign flipped (strong dollar = negative)', () => {
    const o = computeOvernight({ dxyPct: 0.50 });
    expect(o).toBeCloseTo(-1.0, 1);
  });

  it('flow: disagreement dampens', () => {
    expect(computeFlow({ fiiCr:  3000, diiCr:  1000 })).toBeCloseTo(1.0);
    expect(computeFlow({ fiiCr:  3000, diiCr: -1000 })).toBeCloseTo(0.5);
  });
});

describe('regime score composition', () => {
  it('all-null directional → halt reason', () => {
    const { score, reason } = computeRegimeScore({
      structure: null, breadth: null, overnight: null, flow: null, volatility: null,
    });
    expect(score).toBeNull();
    expect(reason).toBe('no_directional_data');
  });

  it('low vol boosts magnitude, high vol shrinks it', () => {
    const base = { structure: 0.5, breadth: 0.5, overnight: 0.5, flow: 0.5 };
    const calm    = computeRegimeScore({ ...base, volatility:  1 }).score;
    const neutral = computeRegimeScore({ ...base, volatility:  0 }).score;
    const stressed= computeRegimeScore({ ...base, volatility: -1 }).score;
    expect(calm).toBeGreaterThan(neutral);
    expect(stressed).toBeLessThan(neutral);
  });
});

describe('label + sizing mapping', () => {
  it('label thresholds', () => {
    expect(scoreToLabel( 0.70)).toBe('STRONG_BULL');
    expect(scoreToLabel( 0.40)).toBe('WEAK_BULL');
    expect(scoreToLabel( 0.10)).toBe('NEUTRAL');
    expect(scoreToLabel(-0.40)).toBe('WEAK_BEAR');
    expect(scoreToLabel(-0.70)).toBe('STRONG_BEAR');
  });

  it('sizing: strong score → 3 trades', () => {
    const { maxTrades, sizeMultiplier } = scoreToSizing(0.80);
    expect(maxTrades).toBe(3);
    expect(sizeMultiplier).toBeGreaterThan(0.9);
  });

  it('sizing: below threshold → 0 trades', () => {
    const { maxTrades } = scoreToSizing(0.05);
    expect(maxTrades).toBe(0);
  });
});

describe('playbook decision', () => {
  it('structure + overnight disagree strongly → gap_fade', () => {
    const pb = decidePlaybook({ structure: 0.6, overnight: -0.5, vixPctRank: 50 });
    expect(pb).toBe('gap_fade');
  });
  it('extreme VIX → halt', () => {
    const pb = decidePlaybook({ structure: 0.5, overnight: 0.5, vixPctRank: 95 });
    expect(pb).toBe('halt');
  });
  it('normal alignment → standard', () => {
    const pb = decidePlaybook({ structure: 0.4, overnight: 0.4, vixPctRank: 50 });
    expect(pb).toBe('standard');
  });
});

describe('end-to-end buildMarketContext', () => {
  it('missing everything → HALT', () => {
    const ctx = buildMarketContext({
      niftyStructure: null, breadthPct: null, vixData: null, overnightData: null, flowData: null,
    });
    expect(ctx.regime).toBe('HALT');
    expect(ctx.max_trades).toBe(0);
  });

  it('strong bull day', () => {
    const ctx = buildMarketContext({
      niftyStructure: { close: 22500, ema20: 22050, ema50: 21800, ema50_prev5: 21600 },
      breadthPct: 68,
      vixData: { close: 12, percentileRank: 20 },
      overnightData: { giftPct: 0.5, asiaCompositePct: 0.6, dxyPct: -0.2 },
      flowData: { fiiCr: 2500, diiCr: 1000 },
    });
    expect(ctx.regime).toMatch(/BULL/);
    expect(ctx.max_trades).toBeGreaterThanOrEqual(2);
    expect(ctx.playbook).toBe('standard');
  });

  it('gap-fade day: structure bear, overnight bull', () => {
    const ctx = buildMarketContext({
      niftyStructure: { close: 21000, ema20: 21400, ema50: 21800, ema50_prev5: 21900 },
      breadthPct: 35,
      vixData: { close: 16, percentileRank: 60 },
      overnightData: { giftPct: 0.8, asiaCompositePct: 0.9, dxyPct: -0.3 },
      flowData: { fiiCr: -500, diiCr: 200 },
    });
    expect(ctx.playbook).toBe('gap_fade');
  });
});
