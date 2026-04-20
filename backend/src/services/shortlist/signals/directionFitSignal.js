/**
 * Direction-fit signal — does this stock's inferred direction match the day's mandate?
 *
 * marketContext.regime_score ∈ [-1, +1]:
 *   score >= +0.3 → day is long-biased
 *   score <= -0.3 → day is short-biased
 *   else          → neutral (both directions acceptable)
 *
 * Each stock gets an inferred direction from its gap + catalyst:
 *   gap > +0.5% OR catalyst=LONG → LONG candidate
 *   gap < -0.5% OR catalyst=SHORT → SHORT candidate
 *   else → NEUTRAL (unless the sector+volume AND-rule fires — see below)
 *
 * Sector+volume AND-rule (no catalyst required):
 *   sector_top3 AND vol_ratio >= 1.5 → LONG
 *   sector_bottom3 AND vol_ratio >= 1.5 → SHORT  (only on SHORT_BIASED or NEUTRAL days)
 *
 * Two independent signals need to agree before this fires. Neither alone is enough.
 * The SHORT side is regime-guarded — elevated volume in a weak sector on a LONG_BIASED
 * day could simply be rotation out of laggards, not a short trigger.
 *
 * Direction-fit = +1 (aligned), -1 (counter-regime), 0 (neutral day or neutral stock).
 *
 * For gap_fade playbook: the logic inverts — we WANT counter-gap candidates.
 */

const LONG_REGIME_THRESHOLD  = 0.3;
const SHORT_REGIME_THRESHOLD = -0.3;

// Minimum vol-ratio to treat sector+volume as a directional signal.
// 1.5× is "elevated" per volumeSignal.scoreVolume() scoring.
const SECTOR_VOL_RATIO_MIN = 1.5;

/**
 * Infer what direction this stock looks like for today.
 *
 * @param {number}      gapPct        - estimated gap % (positive = up)
 * @param {object|null} catalystMeta  - from catalystSignal (direction, headline, etc.)
 * @param {object}      [sectorVol]   - optional sector+volume context
 * @param {boolean}     [sectorVol.sectorTop3]    - is stock's sector in top-3 by 5d return?
 * @param {boolean}     [sectorVol.sectorBottom3] - is stock's sector in bottom-3 by 5d return?
 * @param {number|null} [sectorVol.volRatio]      - yesterday vol / 20d avg vol
 * @param {string}      [sectorVol.mandate]       - day mandate (to guard SHORT side)
 * @returns {'LONG'|'SHORT'|'NEUTRAL'}
 */
export function inferStockDirection(gapPct, catalystMeta, sectorVol = {}) {
  // Rule 1: catalyst wins immediately
  if (catalystMeta?.direction === 'LONG')  return 'LONG';
  if (catalystMeta?.direction === 'SHORT') return 'SHORT';

  // Rule 2: explicit gap threshold
  if (gapPct > 0.5)  return 'LONG';
  if (gapPct < -0.5) return 'SHORT';

  // Rule 3: sector + volume AND-predicate (no catalyst required)
  // Only fires when both signals agree. Volume threshold = 1.5×.
  const { sectorTop3, sectorBottom3, volRatio, mandate } = sectorVol;
  const volSufficient = typeof volRatio === 'number' && volRatio >= SECTOR_VOL_RATIO_MIN;

  if (sectorTop3 && volSufficient) return 'LONG';

  // SHORT side: only on SHORT_BIASED or NEUTRAL mandate days.
  // On LONG_BIASED days, high volume in a weak sector = rotation out, not a short.
  if (sectorBottom3 && volSufficient && mandate !== 'LONG_BIASED') return 'SHORT';

  return 'NEUTRAL';
}

/**
 * Infer the day's directional mandate from marketContext.
 * Returns 'LONG_BIASED' | 'SHORT_BIASED' | 'NEUTRAL' | 'GAP_FADE' | 'HALT'.
 */
export function mandateFromContext(marketContext) {
  if (!marketContext) return 'NEUTRAL';
  if (marketContext.regime === 'HALT') return 'HALT';
  if (marketContext.playbook === 'gap_fade') return 'GAP_FADE';

  const s = Number(marketContext.regime_score);
  if (!Number.isFinite(s)) return 'NEUTRAL';
  if (s >=  LONG_REGIME_THRESHOLD)  return 'LONG_BIASED';
  if (s <=  SHORT_REGIME_THRESHOLD) return 'SHORT_BIASED';
  return 'NEUTRAL';
}

/**
 * Score direction fit.
 *
 *   mandate LONG_BIASED  + stock LONG     → +1
 *   mandate LONG_BIASED  + stock SHORT    → -1
 *   mandate SHORT_BIASED + stock SHORT    → +1
 *   mandate SHORT_BIASED + stock LONG     → -1
 *   mandate NEUTRAL      + either         →  0
 *   mandate GAP_FADE     + inverted       →  see below
 *   HALT                                  →  null (no one trades)
 *
 * In GAP_FADE playbook: reward fade candidates = stock direction opposite to gap.
 * Since inferStockDirection uses gap sign, in gap_fade we want stocks with
 * clear direction but we score them positively if sector/macro suggests fade viability.
 * Simple rule: in gap_fade, any non-neutral stock gets +0.5, neutral gets 0.
 */
export function scoreDirectionFit(stockDirection, mandate) {
  if (mandate === 'HALT') return null;

  if (mandate === 'GAP_FADE') {
    return stockDirection === 'NEUTRAL' ? 0 : 0.5;
  }

  if (mandate === 'NEUTRAL') return 0;

  if (mandate === 'LONG_BIASED') {
    if (stockDirection === 'LONG')  return 1;
    if (stockDirection === 'SHORT') return -1;
    return 0;
  }

  if (mandate === 'SHORT_BIASED') {
    if (stockDirection === 'SHORT') return 1;
    if (stockDirection === 'LONG')  return -1;
    return 0;
  }

  return 0;
}

export default { inferStockDirection, mandateFromContext, scoreDirectionFit };
