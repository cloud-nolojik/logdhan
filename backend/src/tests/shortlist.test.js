import { describe, it, expect } from 'vitest';

import { scoreCatalyst } from '../services/shortlist/signals/catalystSignal.js';
import { estimateStockGap, scoreGap, SECTOR_BETAS } from '../services/shortlist/signals/gapSignal.js';
import { computeRsZScores, scoreRs } from '../services/shortlist/signals/relativeStrengthSignal.js';
import { scoreSector } from '../services/shortlist/signals/sectorRankSignal.js';
import {
  inferStockDirection,
  mandateFromContext,
  scoreDirectionFit
} from '../services/shortlist/signals/directionFitSignal.js';
import {
  computeComposite,
  rankCandidates,
  topN,
  DEFAULT_WEIGHTS
} from '../services/shortlist/compositeScorer.js';

// ─────────────────────────────────────────────────────────────────────
// catalyst signal
// ─────────────────────────────────────────────────────────────────────
describe('scoreCatalyst', () => {
  const map = new Map([
    ['TCS',   { direction: 'LONG', sentiment: 'bullish', headline: 'TCS wins deal' }],
    ['SBIN',  { direction: 'SHORT', sentiment: 'bearish', headline: 'SBI miss' }]
  ]);

  it('returns 1 for symbol with catalyst', () => {
    const { value, meta } = scoreCatalyst('TCS', map, 'ok');
    expect(value).toBe(1);
    expect(meta?.direction).toBe('LONG');
  });

  it('returns 0 for symbol without catalyst', () => {
    const { value } = scoreCatalyst('RELIANCE', map, 'ok');
    expect(value).toBe(0);
  });

  it('returns null when scraper failed', () => {
    const { value } = scoreCatalyst('TCS', new Map(), 'failed');
    expect(value).toBeNull();
  });

  it('is case-insensitive on symbol lookup', () => {
    const { value } = scoreCatalyst('tcs', map, 'ok');
    expect(value).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// gap signal
// ─────────────────────────────────────────────────────────────────────
describe('estimateStockGap', () => {
  it('applies sector beta to macro gap', () => {
    // METALS beta 1.35 × +1% SGX = +1.35%
    const gap = estimateStockGap('METALS', 1.0, null);
    expect(gap).toBeCloseTo(1.35, 2);
  });

  it('FMCG (defensive) gaps less than METALS (cyclical) on same macro move', () => {
    const fmcg = estimateStockGap('FMCG', 1.0, null);
    const metals = estimateStockGap('METALS', 1.0, null);
    expect(Math.abs(metals)).toBeGreaterThan(Math.abs(fmcg));
  });

  it('catalyst LONG nudges gap up by +0.8%', () => {
    const noCat = estimateStockGap('TECH', 0.5, null);
    const withCat = estimateStockGap('TECH', 0.5, { direction: 'LONG' });
    expect(withCat - noCat).toBeCloseTo(0.8, 2);
  });

  it('catalyst SHORT nudges gap down by -0.8%', () => {
    const noCat = estimateStockGap('TECH', 0.5, null);
    const withCat = estimateStockGap('TECH', 0.5, { direction: 'SHORT' });
    expect(withCat - noCat).toBeCloseTo(-0.8, 2);
  });

  it('unknown sector falls back to OTHER beta (1.0)', () => {
    const gap = estimateStockGap('FAKESECTOR', 1.0, null);
    expect(gap).toBeCloseTo(1.0, 2);
  });
});

describe('scoreGap', () => {
  it('returns 1.0 for big gap >= 2%', () => {
    expect(scoreGap(2.5)).toBe(1.0);
    expect(scoreGap(-2.1)).toBe(1.0);
  });
  it('returns 0.6 for moderate gap 1-2%', () => {
    expect(scoreGap(1.5)).toBe(0.6);
  });
  it('returns 0.2 for mild gap 0.3-1%', () => {
    expect(scoreGap(0.5)).toBe(0.2);
  });
  it('returns 0 for flat', () => {
    expect(scoreGap(0.1)).toBe(0);
  });
  it('returns null when gap is null', () => {
    expect(scoreGap(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// relative strength
// ─────────────────────────────────────────────────────────────────────
describe('computeRsZScores', () => {
  it('stock above universe mean gets positive z', () => {
    const rows = [
      { symbol: 'A', stockReturn5d: 5 },
      { symbol: 'B', stockReturn5d: 3 },
      { symbol: 'C', stockReturn5d: 1 }
    ];
    // niftyReturn=2, deltas = [3, 1, -1], mean = 1, std > 0
    const z = computeRsZScores(rows, 2);
    expect(z.get('A')).toBeGreaterThan(0);
    expect(z.get('C')).toBeLessThan(0);
  });

  it('skips stocks with null returns', () => {
    const rows = [
      { symbol: 'A', stockReturn5d: 5 },
      { symbol: 'B', stockReturn5d: null },
      { symbol: 'C', stockReturn5d: 1 }
    ];
    const z = computeRsZScores(rows, 2);
    expect(z.has('A')).toBe(true);
    expect(z.has('B')).toBe(false);
    expect(z.has('C')).toBe(true);
  });

  it('returns empty map when no valid rows', () => {
    const rows = [{ symbol: 'A', stockReturn5d: null }];
    const z = computeRsZScores(rows, 1);
    expect(z.size).toBe(0);
  });
});

describe('scoreRs', () => {
  it('z >= 1.5 scores 1.0', () => { expect(scoreRs(1.6)).toBe(1.0); });
  it('z in [1, 1.5) scores 0.75', () => { expect(scoreRs(1.2)).toBe(0.75); });
  it('z in [0.5, 1) scores 0.5', () => { expect(scoreRs(0.7)).toBe(0.5); });
  it('z in [0, 0.5) scores 0.25', () => { expect(scoreRs(0.1)).toBe(0.25); });
  it('z < 0 scores 0', () => { expect(scoreRs(-0.5)).toBe(0); });
  it('null → null', () => { expect(scoreRs(null)).toBeNull(); });
});

// ─────────────────────────────────────────────────────────────────────
// sector rank
// ─────────────────────────────────────────────────────────────────────
describe('scoreSector', () => {
  it('returns 1 if in top N', () => {
    expect(scoreSector('TECH', ['BANKING', 'TECH', 'AUTO'])).toBe(1);
  });
  it('returns 0 if not in top N', () => {
    expect(scoreSector('FMCG', ['BANKING', 'TECH', 'AUTO'])).toBe(0);
  });
  it('returns null on bad input', () => {
    expect(scoreSector(null, ['BANKING'])).toBeNull();
    expect(scoreSector('TECH', null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// direction fit
// ─────────────────────────────────────────────────────────────────────
describe('inferStockDirection', () => {
  it('big positive gap → LONG', () => {
    expect(inferStockDirection(2.0, null)).toBe('LONG');
  });
  it('big negative gap → SHORT', () => {
    expect(inferStockDirection(-1.5, null)).toBe('SHORT');
  });
  it('catalyst LONG overrides small gap', () => {
    expect(inferStockDirection(0.1, { direction: 'LONG' })).toBe('LONG');
  });
  it('tiny gap, no catalyst → NEUTRAL', () => {
    expect(inferStockDirection(0.1, null)).toBe('NEUTRAL');
  });
});

describe('mandateFromContext', () => {
  it('regime_score >= 0.3 → LONG_BIASED', () => {
    expect(mandateFromContext({ regime_score: 0.5, regime: 'WEAK_BULL', playbook: 'standard' })).toBe('LONG_BIASED');
  });
  it('regime_score <= -0.3 → SHORT_BIASED', () => {
    expect(mandateFromContext({ regime_score: -0.4, regime: 'WEAK_BEAR', playbook: 'standard' })).toBe('SHORT_BIASED');
  });
  it('|regime_score| < 0.3 → NEUTRAL', () => {
    expect(mandateFromContext({ regime_score: 0.1, regime: 'NEUTRAL', playbook: 'standard' })).toBe('NEUTRAL');
  });
  it('playbook=gap_fade → GAP_FADE regardless of score', () => {
    expect(mandateFromContext({ regime_score: 0.8, regime: 'STRONG_BULL', playbook: 'gap_fade' })).toBe('GAP_FADE');
  });
  it('regime=HALT → HALT', () => {
    expect(mandateFromContext({ regime: 'HALT', regime_score: 0, playbook: 'halt' })).toBe('HALT');
  });
});

describe('scoreDirectionFit', () => {
  it('LONG_BIASED + LONG → +1', () => {
    expect(scoreDirectionFit('LONG', 'LONG_BIASED')).toBe(1);
  });
  it('LONG_BIASED + SHORT → -1', () => {
    expect(scoreDirectionFit('SHORT', 'LONG_BIASED')).toBe(-1);
  });
  it('SHORT_BIASED + SHORT → +1', () => {
    expect(scoreDirectionFit('SHORT', 'SHORT_BIASED')).toBe(1);
  });
  it('NEUTRAL mandate → 0 regardless of direction', () => {
    expect(scoreDirectionFit('LONG', 'NEUTRAL')).toBe(0);
    expect(scoreDirectionFit('SHORT', 'NEUTRAL')).toBe(0);
  });
  it('HALT mandate → null', () => {
    expect(scoreDirectionFit('LONG', 'HALT')).toBeNull();
  });
  it('GAP_FADE + non-neutral stock → 0.5', () => {
    expect(scoreDirectionFit('LONG', 'GAP_FADE')).toBe(0.5);
    expect(scoreDirectionFit('NEUTRAL', 'GAP_FADE')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// composite scorer
// ─────────────────────────────────────────────────────────────────────
describe('computeComposite', () => {
  it('all signals contribute with default weights', () => {
    const s = computeComposite({
      catalyst: 1, gap: 1, rs: 1, sector_top3: 1, direction_fit: 1
    });
    expect(s).toBeCloseTo(1.0, 3);
  });

  it('all zeros → 0', () => {
    const s = computeComposite({ catalyst: 0, gap: 0, rs: 0, sector_top3: 0, direction_fit: 0 });
    expect(s).toBe(0);
  });

  it('null signals get weight redistributed', () => {
    // Only rs=1, rest null → composite should still be 1 (renormalized)
    const s = computeComposite({
      catalyst: null, gap: null, rs: 1, sector_top3: null, direction_fit: null
    });
    expect(s).toBeCloseTo(1.0, 3);
  });

  it('negative direction_fit drags composite down', () => {
    const aligned = computeComposite({ catalyst: 1, gap: 1, rs: 1, sector_top3: 1, direction_fit: 1 });
    const misaligned = computeComposite({ catalyst: 1, gap: 1, rs: 1, sector_top3: 1, direction_fit: -1 });
    expect(aligned).toBeGreaterThan(misaligned);
  });

  it('all-null returns 0', () => {
    const s = computeComposite({ catalyst: null, gap: null, rs: null, sector_top3: null, direction_fit: null });
    expect(s).toBe(0);
  });

  it('respects custom weights', () => {
    // Put all weight on rs
    const weights = { catalyst: 0, gap: 0, rs: 1, sector_top3: 0, direction_fit: 0 };
    const s = computeComposite({ catalyst: 1, gap: 1, rs: 0, sector_top3: 1, direction_fit: 1 }, weights);
    expect(s).toBe(0); // only rs counts, rs=0
  });
});

describe('rankCandidates + topN', () => {
  const candidates = [
    { symbol: 'A', signals: { catalyst: 1, gap: 1, rs: 1, sector_top3: 1, direction_fit: 1 } },
    { symbol: 'B', signals: { catalyst: 0, gap: 0.6, rs: 0.5, sector_top3: 1, direction_fit: 1 } },
    { symbol: 'C', signals: { catalyst: 0, gap: 0, rs: 0, sector_top3: 0, direction_fit: 0 } },
    { symbol: 'D', signals: { catalyst: 1, gap: 0.6, rs: 0.75, sector_top3: 1, direction_fit: 1 } }
  ];

  it('ranks highest composite first', () => {
    const ranked = rankCandidates(candidates);
    expect(ranked[0].symbol).toBe('A');
    expect(ranked[ranked.length - 1].symbol).toBe('C');
  });

  it('assigns sequential ranks', () => {
    const ranked = rankCandidates(candidates);
    expect(ranked.map(r => r.rank)).toEqual([1, 2, 3, 4]);
  });

  it('topN trims correctly', () => {
    const ranked = rankCandidates(candidates);
    const top2 = topN(ranked, 2);
    expect(top2).toHaveLength(2);
    expect(top2[0].symbol).toBe('A');
  });

  it('DEFAULT_WEIGHTS sums to 1', () => {
    const sum = Object.values(DEFAULT_WEIGHTS).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────
// sanity: SECTOR_BETAS covers all sectors in SECTOR_MAPPING expectations
// ─────────────────────────────────────────────────────────────────────
describe('SECTOR_BETAS coverage', () => {
  const expectedSectors = [
    'TECH', 'BANKING', 'ENERGY', 'AUTO', 'PHARMA', 'FMCG',
    'METALS', 'CEMENT', 'REALTY', 'INDUSTRIAL', 'FINSERVICES',
    'DEFENSE', 'TRANSPORT', 'CHEMICALS', 'TELECOM', 'COMMODITIES', 'OTHER'
  ];

  it.each(expectedSectors)('has beta for %s', (sector) => {
    expect(SECTOR_BETAS[sector]).toBeGreaterThan(0);
  });
});
