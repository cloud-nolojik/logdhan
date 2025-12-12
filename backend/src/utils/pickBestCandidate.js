/**
 * Pick the best candidate from Stage 2 results
 * @param {Object} s2 - Stage 2 result containing candidates array
 * @returns {{ best: Object|null, ranked: Array }} - Best candidate and all ranked candidates
 */
export function pickBestStage2Candidate(s2) {
  const candidates = Array.isArray(s2?.candidates) ? s2.candidates : [];

  // keep only valid candidates
  const valid = candidates.filter(c => c && c.ok === true && c.skeleton && typeof c.skeleton.riskReward === "number");

  if (valid.length === 0) {
    return { best: null, ranked: [] };
  }

  // hard gate: prefer RR >= 1.5 if any exist
  const rrOk = valid.filter(c => c.skeleton.riskReward >= 1.5);
  const pool = rrOk.length ? rrOk : valid;

  // deterministic weighted score (use what Stage-2 already computed)
  const scoreOf = (c) => {
    const s = c.score || {};
    const rr = typeof s.rr === "number" ? s.rr : (c.skeleton.riskReward || 0);
    const trend = typeof s.trend_align === "number" ? s.trend_align : 0;
    const dist = typeof s.distance_pct === "number" ? s.distance_pct : 999;

    // weights: prioritize RR + trend alignment, penalize very large distance
    return (rr * 0.55) + (trend * 0.35) - (Math.min(dist, 5) * 0.10);
  };

  // Create ranked array with scores
  const ranked = pool.map(c => ({
    c,
    totalScore: scoreOf(c)
  })).sort((a, b) => b.totalScore - a.totalScore);

  return {
    best: ranked[0]?.c || null,
    ranked
  };
}

/**
 * Shrink candidate for prompt to reduce tokens
 * @param {Object} c - Candidate object
 * @returns {Object} - Minimal candidate object for prompt
 */
export function shrinkCandidateForPrompt(c) {
  if (!c) return null;
  // reduce tokens: keep only what Stage-3 needs
  return {
    id: c.id,
    name: c.name,
    score: c.score,
    skeleton: c.skeleton
  };
}
