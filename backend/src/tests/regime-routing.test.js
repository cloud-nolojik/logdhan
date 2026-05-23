/**
 * Unit tests for regime-aware routing pure functions added May 2026.
 *
 * Coverage:
 *   - selectScannerModeForRegime: regime label → scanner.py mode mapping
 *   - resolveOrbAtrRatioForVix:   India VIX → MAX_ORB_ATR_RATIO scaling
 *   - REGIME_TO_SCANNER_MODE:     mapping completeness vs regime engine output
 *   - MIN_ORB_RR_BY_REGIME:       coverage check vs router output (Blocker #1)
 *   - resolveOrbAtrRatioForVix's SIT_OUT signal at VIX > 35
 */

import { describe, it, expect } from 'vitest';
import {
  selectScannerModeForRegime,
  REGIME_TO_SCANNER_MODE,
} from '../services/dailyPicks/dailyPicksService.js';
import {
  resolveOrbAtrRatioForVix,
  MAX_ORB_ATR_RATIO_NORMAL,
  MAX_ORB_ATR_RATIO_ELEVATED,
  MAX_ORB_ATR_RATIO_PANIC,
  MIN_ORB_RR_BY_REGIME,
  VIX_NORMAL_MAX_THRESHOLD,
  VIX_ELEVATED_MAX_THRESHOLD,
  VIX_EXTREME_SIT_OUT_THRESHOLD,
} from '../services/dailyPicks/dailyPicksConstants.js';

describe('selectScannerModeForRegime — routing table', () => {
  it('STRONG_BULL → momentum_leader', () => {
    expect(selectScannerModeForRegime('STRONG_BULL')).toBe('momentum_leader');
  });

  it('WEAK_BULL → recovery_breakout (unchanged from legacy)', () => {
    expect(selectScannerModeForRegime('WEAK_BULL')).toBe('recovery_breakout');
  });

  it('NEUTRAL → nr7_compression', () => {
    expect(selectScannerModeForRegime('NEUTRAL')).toBe('nr7_compression');
  });

  it('WEAK_BEAR → failed_bounce', () => {
    expect(selectScannerModeForRegime('WEAK_BEAR')).toBe('failed_bounce');
  });

  it('STRONG_BEAR → breakdown', () => {
    expect(selectScannerModeForRegime('STRONG_BEAR')).toBe('breakdown');
  });

  it('EXTREME_BEAR → null (sit out)', () => {
    expect(selectScannerModeForRegime('EXTREME_BEAR')).toBeNull();
  });
});

describe('selectScannerModeForRegime — sit-out fallback', () => {
  it('UNKNOWN → null (sit out, do NOT default to recovery_breakout)', () => {
    expect(selectScannerModeForRegime('UNKNOWN')).toBeNull();
  });

  it('HALT → null (regime engine signals halt)', () => {
    expect(selectScannerModeForRegime('HALT')).toBeNull();
  });

  it('legacy SCANNER placeholder → null', () => {
    expect(selectScannerModeForRegime('SCANNER')).toBeNull();
  });

  it('CONFLICT → null', () => {
    expect(selectScannerModeForRegime('CONFLICT')).toBeNull();
  });

  it('null → null', () => {
    expect(selectScannerModeForRegime(null)).toBeNull();
  });

  it('undefined → null', () => {
    expect(selectScannerModeForRegime(undefined)).toBeNull();
  });

  it('empty string → null', () => {
    expect(selectScannerModeForRegime('')).toBeNull();
  });

  it('prototype-pollution-style key ("toString") → null', () => {
    // Regression for the `in` operator vs `.hasOwnProperty` fix
    expect(selectScannerModeForRegime('toString')).toBeNull();
    expect(selectScannerModeForRegime('constructor')).toBeNull();
    expect(selectScannerModeForRegime('__proto__')).toBeNull();
  });
});

describe('REGIME_TO_SCANNER_MODE — mapping integrity', () => {
  it('contains all 5 active regime engine labels', () => {
    const labels = ['STRONG_BULL', 'WEAK_BULL', 'NEUTRAL', 'WEAK_BEAR', 'STRONG_BEAR'];
    for (const label of labels) {
      expect(REGIME_TO_SCANNER_MODE).toHaveProperty(label);
    }
  });

  it('EXTREME_BEAR is present and mapped to null', () => {
    expect(REGIME_TO_SCANNER_MODE).toHaveProperty('EXTREME_BEAR');
    expect(REGIME_TO_SCANNER_MODE.EXTREME_BEAR).toBeNull();
  });

  it('SHORT modes are only for bear regimes', () => {
    const shortModes = ['failed_bounce', 'breakdown'];
    for (const [regime, mode] of Object.entries(REGIME_TO_SCANNER_MODE)) {
      if (mode && shortModes.includes(mode)) {
        expect(regime).toMatch(/BEAR/);
      }
    }
  });

  it('LONG modes are for bull or neutral regimes', () => {
    const longModes = ['momentum_leader', 'recovery_breakout', 'nr7_compression'];
    for (const [regime, mode] of Object.entries(REGIME_TO_SCANNER_MODE)) {
      if (mode && longModes.includes(mode)) {
        expect(regime).not.toMatch(/BEAR/);
      }
    }
  });
});

describe('MIN_ORB_RR_BY_REGIME — coverage check (Blocker #1 from code review)', () => {
  it('contains keys for every active regime engine label', () => {
    // These are the labels regimeScoring.js scoreToLabel() actually produces.
    const activeLabels = ['STRONG_BULL', 'WEAK_BULL', 'NEUTRAL', 'WEAK_BEAR', 'STRONG_BEAR'];
    for (const label of activeLabels) {
      expect(MIN_ORB_RR_BY_REGIME).toHaveProperty(label);
      expect(typeof MIN_ORB_RR_BY_REGIME[label]).toBe('number');
      expect(MIN_ORB_RR_BY_REGIME[label]).toBeGreaterThan(0);
    }
  });

  it('all R:R thresholds are between 1.0 and 3.0 (sanity)', () => {
    for (const v of Object.values(MIN_ORB_RR_BY_REGIME)) {
      expect(v).toBeGreaterThanOrEqual(1.0);
      expect(v).toBeLessThanOrEqual(3.0);
    }
  });

  it('NEUTRAL has the strictest R:R (highest threshold)', () => {
    // NEUTRAL is the lowest-conviction regime so we demand the best R:R.
    const neutral = MIN_ORB_RR_BY_REGIME.NEUTRAL;
    for (const [label, v] of Object.entries(MIN_ORB_RR_BY_REGIME)) {
      if (label !== 'NEUTRAL') {
        expect(neutral).toBeGreaterThanOrEqual(v);
      }
    }
  });
});

describe('resolveOrbAtrRatioForVix — VIX scaling and sit-out', () => {
  // Calibration: 1.25× normal / 1.50× elevated / 2.00× panic / SIT_OUT extreme
  it('null / 0 / negative VIX → normal baseline', () => {
    expect(resolveOrbAtrRatioForVix(null)).toBe(MAX_ORB_ATR_RATIO_NORMAL);
    expect(resolveOrbAtrRatioForVix(0)).toBe(MAX_ORB_ATR_RATIO_NORMAL);
    expect(resolveOrbAtrRatioForVix(-5)).toBe(MAX_ORB_ATR_RATIO_NORMAL);
  });

  it('VIX in normal range (≤ 16) → 1.25× baseline', () => {
    expect(resolveOrbAtrRatioForVix(10)).toBe(MAX_ORB_ATR_RATIO_NORMAL);
    expect(resolveOrbAtrRatioForVix(VIX_NORMAL_MAX_THRESHOLD)).toBe(MAX_ORB_ATR_RATIO_NORMAL);
  });

  it('VIX in elevated range (16 < x ≤ 22) → 1.50×', () => {
    expect(resolveOrbAtrRatioForVix(VIX_NORMAL_MAX_THRESHOLD + 0.01)).toBe(MAX_ORB_ATR_RATIO_ELEVATED);
    expect(resolveOrbAtrRatioForVix(18)).toBe(MAX_ORB_ATR_RATIO_ELEVATED);
    expect(resolveOrbAtrRatioForVix(VIX_ELEVATED_MAX_THRESHOLD)).toBe(MAX_ORB_ATR_RATIO_ELEVATED);
  });

  it('VIX in panic range (22 < x ≤ 35) → 2.00×', () => {
    expect(resolveOrbAtrRatioForVix(VIX_ELEVATED_MAX_THRESHOLD + 0.01)).toBe(MAX_ORB_ATR_RATIO_PANIC);
    expect(resolveOrbAtrRatioForVix(28)).toBe(MAX_ORB_ATR_RATIO_PANIC);
    expect(resolveOrbAtrRatioForVix(VIX_EXTREME_SIT_OUT_THRESHOLD)).toBe(MAX_ORB_ATR_RATIO_PANIC);
  });

  it('VIX > 35 → SIT_OUT (extreme volatility sit-out)', () => {
    expect(resolveOrbAtrRatioForVix(VIX_EXTREME_SIT_OUT_THRESHOLD + 0.01)).toBe('SIT_OUT');
    expect(resolveOrbAtrRatioForVix(50)).toBe('SIT_OUT');
    expect(resolveOrbAtrRatioForVix(100)).toBe('SIT_OUT');
  });

  it('monotonically non-decreasing across the trading band', () => {
    // Ratio should never decrease as VIX rises (until we hit SIT_OUT)
    const vix = [5, 10, 15, 16, 17, 20, 22, 25, 30, 35];
    let prev = -Infinity;
    for (const v of vix) {
      const r = resolveOrbAtrRatioForVix(v);
      expect(typeof r).toBe('number');
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });
});
