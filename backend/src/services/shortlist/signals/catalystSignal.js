/**
 * Catalyst signal — does this stock have a news-driven reason to move today?
 *
 * Wraps the existing upstoxNewsScraper. Returns a Map<symbol, catalystMeta>
 * that the composite scorer looks up per candidate.
 *
 * Signal output per stock:
 *   null → scraper didn't run / failed
 *   0    → no catalyst found for this symbol
 *   1    → symbol was surfaced by the scraper (has a catalyst today)
 */

import { scrapeUpstoxNewsForCandidates } from '../../dailyPicks/upstoxNewsScraper.js';

const LOG = '[shortlist/catalyst]';

/**
 * Build a catalyst lookup map for today.
 *
 * @returns {Promise<{
 *   status: 'ok'|'degraded'|'failed',
 *   catalystsBySymbol: Map<string, { direction: string, sentiment?: string, headline?: string }>,
 *   warning?: string
 * }>}
 */
export async function fetchCatalysts() {
  try {
    const result = await scrapeUpstoxNewsForCandidates();

    if (!result || result.error) {
      return {
        status: 'failed',
        catalystsBySymbol: new Map(),
        warning: `catalyst fetch failed: ${result?.error || 'unknown'}`
      };
    }

    const candidates = result.candidates || [];
    const map = new Map();

    for (const c of candidates) {
      if (!c?.symbol) continue;
      map.set(c.symbol.toUpperCase(), {
        direction: c.direction || 'NEUTRAL',
        sentiment: c.news_context?.sentiment || null,
        headline: c.news_context?.headline || null
      });
    }

    console.log(`${LOG} loaded ${map.size} catalyst-tagged stocks`);
    return { status: 'ok', catalystsBySymbol: map };
  } catch (err) {
    console.error(`${LOG} error:`, err.message);
    return {
      status: 'failed',
      catalystsBySymbol: new Map(),
      warning: `catalyst fetch threw: ${err.message}`
    };
  }
}

/**
 * Look up whether a specific symbol has a catalyst.
 * @returns {{ value: number|null, meta: object|null }}
 */
export function scoreCatalyst(symbol, catalystsBySymbol, status) {
  if (status === 'failed') return { value: null, meta: null };
  const hit = catalystsBySymbol.get(symbol.toUpperCase());
  if (!hit) return { value: 0, meta: null };
  return { value: 1, meta: hit };
}

export default { fetchCatalysts, scoreCatalyst };
