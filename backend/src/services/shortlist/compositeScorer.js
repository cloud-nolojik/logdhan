/**
 * Composite scorer — combine 5 signal scores into one ranking number.
 *
 * Weighted sum with null-safety: if a signal is missing/failed, its weight is
 * redistributed across the remaining signals so rankings stay comparable.
 *
 * Default weights (tuned for intraday):
 *   catalyst:      0.15   — news kick is powerful but rare; it's a boost, not backbone
 *   gap:           0.25   — gap + sector gives the day's direction
 *   rs:            0.30   — single best non-news predictor of intraday winners
 *   sector_top3:   0.20   — sector tape alignment
 *   direction_fit: 0.10   — alignment with regime mandate (small because regime is already
 *                           reflected in gap/sector; this prevents chasing counter-trend)
 */

export const DEFAULT_WEIGHTS = Object.freeze({
  catalyst:      0.15,
  gap:           0.25,
  rs:            0.30,
  sector_top3:   0.20,
  direction_fit: 0.10
});

/**
 * Compute composite score for one candidate.
 *
 * Each signal score must be one of:
 *   - number in [-1, +1]  → normal weighted contribution
 *   - null                → signal missing, weight redistributed
 *
 * Returns a number scaled to [-1, +1] when sign-preserving, else [0, 1] when
 * only the catalyst/sector/rs contribute.
 *
 * @param {object} signals   - { catalyst, gap, rs, sector_top3, direction_fit } (null-safe)
 * @param {object} [weights] - override weights
 * @returns {number}         - composite score
 */
export function computeComposite(signals, weights = DEFAULT_WEIGHTS) {
  const keys = Object.keys(weights);

  // Build the set of signals that actually contributed (non-null)
  const present = keys.filter(k => signals[k] !== null && signals[k] !== undefined);
  if (present.length === 0) return 0;

  const totalWeight = present.reduce((s, k) => s + weights[k], 0);
  if (totalWeight === 0) return 0;

  let sum = 0;
  for (const k of present) {
    sum += (signals[k] ?? 0) * weights[k];
  }

  // Renormalize so partial-signal scores are comparable to full-signal scores
  const composite = sum / totalWeight;
  return Number(composite.toFixed(4));
}

/**
 * Score and rank a list of candidates.
 *
 * @param {Array<{symbol, signals: {...}}>} candidates
 * @param {object} [weights]
 * @returns {Array} same candidates with `composite_score` + `rank` attached, sorted DESC
 */
export function rankCandidates(candidates, weights = DEFAULT_WEIGHTS) {
  const scored = candidates.map(c => ({
    ...c,
    composite_score: computeComposite(c.signals || {}, weights)
  }));

  scored.sort((a, b) => b.composite_score - a.composite_score);
  scored.forEach((c, i) => { c.rank = i + 1; });
  return scored;
}

/**
 * Trim to top N candidates.
 */
export function topN(candidates, n = 50) {
  return candidates.slice(0, n);
}

export default { DEFAULT_WEIGHTS, computeComposite, rankCandidates, topN };
