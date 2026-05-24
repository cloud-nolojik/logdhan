/**
 * Unit tests for regime-aware routing pure functions added May 2026.
 *
 * Now covers TWO scanner types (May 2026 v3):
 *   - SWING    (scanner_swing.py)  — 8-mode swing scanner, multi-day setups
 *   - INTRADAY (scanner.py)         — 5-mode intraday scanner, same-day exit
 *
 * Coverage:
 *   - selectScannerModeForRegime(regime, scannerType): regime → mode for each type
 *   - REGIME_TO_SWING_MODE / REGIME_TO_INTRADAY_MODE: mapping completeness
 *   - getActiveScannerType + getRegimeToScannerMode: env-driven routing
 *   - resolveOrbAtrRatioForVix:   India VIX → MAX_ORB_ATR_RATIO scaling
 *   - MIN_ORB_RR_BY_REGIME:       coverage check vs router output
 */

import { describe, it, expect } from 'vitest';
import {
  selectScannerModeForRegime,
  REGIME_TO_SWING_MODE,
  REGIME_TO_INTRADAY_MODE,
  getRegimeToScannerMode,
  getActiveScannerType,
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

describe('selectScannerModeForRegime — SWING table (v2 May 2026)', () => {
  it('STRONG_BULL → vcp_pivot (Minervini VCP)', () => {
    expect(selectScannerModeForRegime('STRONG_BULL', 'swing')).toBe('vcp_pivot');
  });

  it('WEAK_BULL → pullback_20ema (Raschke 20-EMA touch)', () => {
    expect(selectScannerModeForRegime('WEAK_BULL', 'swing')).toBe('pullback_20ema');
  });

  it('NEUTRAL → rsi2_meanrev (Connors RSI-2)', () => {
    expect(selectScannerModeForRegime('NEUTRAL', 'swing')).toBe('rsi2_meanrev');
  });

  it('WEAK_BEAR → failed_bounce (the proven winner)', () => {
    expect(selectScannerModeForRegime('WEAK_BEAR', 'swing')).toBe('failed_bounce');
  });

  it('STRONG_BEAR → failed_bounce (was broken breakdown)', () => {
    expect(selectScannerModeForRegime('STRONG_BEAR', 'swing')).toBe('failed_bounce');
  });

  it('EXTREME_BEAR → null (sit out)', () => {
    expect(selectScannerModeForRegime('EXTREME_BEAR', 'swing')).toBeNull();
  });
});

describe('selectScannerModeForRegime — INTRADAY table (v3 May 2026)', () => {
  it('STRONG_BULL → intraday_gap_long', () => {
    expect(selectScannerModeForRegime('STRONG_BULL', 'intraday')).toBe('intraday_gap_long');
  });

  it('WEAK_BULL → intraday_breakout_long', () => {
    expect(selectScannerModeForRegime('WEAK_BULL', 'intraday')).toBe('intraday_breakout_long');
  });

  it('NEUTRAL → intraday_range_fade', () => {
    expect(selectScannerModeForRegime('NEUTRAL', 'intraday')).toBe('intraday_range_fade');
  });

  it('WEAK_BEAR → intraday_failed_rally (SHORT)', () => {
    expect(selectScannerModeForRegime('WEAK_BEAR', 'intraday')).toBe('intraday_failed_rally');
  });

  it('STRONG_BEAR → intraday_gap_short (SHORT)', () => {
    expect(selectScannerModeForRegime('STRONG_BEAR', 'intraday')).toBe('intraday_gap_short');
  });

  it('EXTREME_BEAR → null (sit out)', () => {
    expect(selectScannerModeForRegime('EXTREME_BEAR', 'intraday')).toBeNull();
  });
});

describe('selectScannerModeForRegime — default scanner type', () => {
  it('default (no second arg) uses the active scanner type', () => {
    // The default arg path must round-trip through getActiveScannerType()
    // and return the same value as an explicit call with that type.
    const active = getActiveScannerType();
    expect(['intraday', 'swing']).toContain(active);
    expect(selectScannerModeForRegime('STRONG_BULL'))
      .toBe(selectScannerModeForRegime('STRONG_BULL', active));
  });
});

describe('selectScannerModeForRegime — sit-out fallback (applies to both types)', () => {
  for (const t of ['intraday', 'swing']) {
    it(`[${t}] UNKNOWN → null`, () => {
      expect(selectScannerModeForRegime('UNKNOWN', t)).toBeNull();
    });
    it(`[${t}] HALT → null`, () => {
      expect(selectScannerModeForRegime('HALT', t)).toBeNull();
    });
    it(`[${t}] legacy 'SCANNER' placeholder → null`, () => {
      expect(selectScannerModeForRegime('SCANNER', t)).toBeNull();
    });
    it(`[${t}] CONFLICT → null`, () => {
      expect(selectScannerModeForRegime('CONFLICT', t)).toBeNull();
    });
    it(`[${t}] null → null`, () => {
      expect(selectScannerModeForRegime(null, t)).toBeNull();
    });
    it(`[${t}] undefined → null`, () => {
      expect(selectScannerModeForRegime(undefined, t)).toBeNull();
    });
    it(`[${t}] empty string → null`, () => {
      expect(selectScannerModeForRegime('', t)).toBeNull();
    });
    it(`[${t}] prototype-pollution keys → null`, () => {
      expect(selectScannerModeForRegime('toString', t)).toBeNull();
      expect(selectScannerModeForRegime('constructor', t)).toBeNull();
      expect(selectScannerModeForRegime('__proto__', t)).toBeNull();
    });
  }
});

describe('REGIME_TO_SWING_MODE — mapping integrity', () => {
  it('contains all 5 active regime engine labels', () => {
    const labels = ['STRONG_BULL', 'WEAK_BULL', 'NEUTRAL', 'WEAK_BEAR', 'STRONG_BEAR'];
    for (const label of labels) {
      expect(REGIME_TO_SWING_MODE).toHaveProperty(label);
    }
  });

  it('EXTREME_BEAR is present and mapped to null', () => {
    expect(REGIME_TO_SWING_MODE).toHaveProperty('EXTREME_BEAR');
    expect(REGIME_TO_SWING_MODE.EXTREME_BEAR).toBeNull();
  });

  it('SHORT modes are only for bear regimes', () => {
    const shortModes = ['failed_bounce', 'breakdown'];
    for (const [regime, mode] of Object.entries(REGIME_TO_SWING_MODE)) {
      if (mode && shortModes.includes(mode)) {
        expect(regime).toMatch(/BEAR/);
      }
    }
  });

  it('LONG modes only fire on bull or neutral regimes (not bear)', () => {
    const longModes = [
      'momentum_leader', 'recovery_breakout', 'nr7_compression',
      'vcp_pivot', 'pullback_20ema', 'rsi2_meanrev',
    ];
    for (const [regime, mode] of Object.entries(REGIME_TO_SWING_MODE)) {
      if (mode && longModes.includes(mode)) {
        expect(regime).not.toMatch(/BEAR/);
      }
    }
  });

  it('EXTREME_BEAR is the only built-in sit-out (NEUTRAL re-enabled v2)', () => {
    expect(REGIME_TO_SWING_MODE.EXTREME_BEAR).toBeNull();
    expect(REGIME_TO_SWING_MODE.NEUTRAL).not.toBeNull();   // v2 — uses rsi2_meanrev
  });
});

describe('REGIME_TO_INTRADAY_MODE — mapping integrity', () => {
  it('contains all 5 active regime engine labels', () => {
    const labels = ['STRONG_BULL', 'WEAK_BULL', 'NEUTRAL', 'WEAK_BEAR', 'STRONG_BEAR'];
    for (const label of labels) {
      expect(REGIME_TO_INTRADAY_MODE).toHaveProperty(label);
    }
  });

  it('EXTREME_BEAR is present and mapped to null', () => {
    expect(REGIME_TO_INTRADAY_MODE).toHaveProperty('EXTREME_BEAR');
    expect(REGIME_TO_INTRADAY_MODE.EXTREME_BEAR).toBeNull();
  });

  it('every value is either null or starts with "intraday_"', () => {
    for (const [, mode] of Object.entries(REGIME_TO_INTRADAY_MODE)) {
      if (mode != null) {
        expect(mode.startsWith('intraday_')).toBe(true);
      }
    }
  });

  it('SHORT intraday modes only fire on bear regimes', () => {
    const intradayShorts = ['intraday_failed_rally', 'intraday_gap_short'];
    for (const [regime, mode] of Object.entries(REGIME_TO_INTRADAY_MODE)) {
      if (mode && intradayShorts.includes(mode)) {
        expect(regime).toMatch(/BEAR/);
      }
    }
  });

  it('LONG intraday modes only fire on bull or neutral regimes', () => {
    const intradayLongs = ['intraday_gap_long', 'intraday_breakout_long', 'intraday_range_fade'];
    for (const [regime, mode] of Object.entries(REGIME_TO_INTRADAY_MODE)) {
      if (mode && intradayLongs.includes(mode)) {
        expect(regime).not.toMatch(/BEAR/);
      }
    }
  });

  it('the two maps cover the same set of regime labels', () => {
    // If we add a new regime to the engine, we must add it to BOTH maps.
    expect(new Set(Object.keys(REGIME_TO_SWING_MODE)))
      .toEqual(new Set(Object.keys(REGIME_TO_INTRADAY_MODE)));
  });
});

describe('getRegimeToScannerMode — explicit type resolution', () => {
  it('"swing" returns the swing map', () => {
    expect(getRegimeToScannerMode('swing')).toBe(REGIME_TO_SWING_MODE);
  });

  it('"intraday" returns the intraday map', () => {
    expect(getRegimeToScannerMode('intraday')).toBe(REGIME_TO_INTRADAY_MODE);
  });

  it('default (no arg) returns one of the two maps', () => {
    const m = getRegimeToScannerMode();
    expect([REGIME_TO_INTRADAY_MODE, REGIME_TO_SWING_MODE]).toContain(m);
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
