/**
 * Shortlist Service — the 8:30 AM "shortlist-heavy" scan.
 *
 * Takes a marketContext (from computeMarketContextV2) and produces a ranked
 * top-50 intraday watchlist by combining 5 signals:
 *   1. catalyst       (news scraper)
 *   2. gap            (SGX Nifty × sector beta + catalyst nudge)
 *   3. rs             (5-day return z-score vs Nifty)
 *   4. sector_top3    (is stock's sector in today's top-3 by 5-day return)
 *   5. direction_fit  (alignment with marketContext mandate)
 *
 * Designed to be STANDALONE — does not touch legacy dailyPicksService.
 * Once validated, the legacy ChartInk scan block can be replaced by a call
 * to buildShortlist().
 */

import Stock from '../../models/stock.js';
import ShortlistWatchlist from '../../models/shortlistWatchlist.js';
import { getFnoUniverse } from '../../constants/fnoUniverse.js';
import { getSectorForStock } from '../../utils/sectorMapping.js';

import { fetchCatalysts, scoreCatalyst } from './signals/catalystSignal.js';
import { fetchMacroGap, estimateStockGap, scoreGap } from './signals/gapSignal.js';
import {
  fetchNiftyReturn5d,
  fetchStockReturn5d,
  computeRsZScores,
  scoreRs
} from './signals/relativeStrengthSignal.js';
import { rankSectors, scoreSector } from './signals/sectorRankSignal.js';
import {
  inferStockDirection,
  mandateFromContext,
  scoreDirectionFit
} from './signals/directionFitSignal.js';
import { rankCandidates, topN, DEFAULT_WEIGHTS } from './compositeScorer.js';

const LOG = '[shortlist]';

function getISTDateStr() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return ist.toISOString().split('T')[0];
}

/**
 * Build today's preliminary shortlist.
 *
 * @param {object} marketContext        - Output of computeMarketContextV2()
 * @param {object} [options]
 * @param {number} [options.outputSize=50]
 * @param {number} [options.topSectorsN=3]
 * @param {object} [options.weights]    - Override composite weights
 * @param {boolean} [options.persist=true] - Save to MongoDB
 * @returns {Promise<{date, candidates, signal_status, stats, warnings}>}
 */
export async function buildShortlist(marketContext, options = {}) {
  const {
    outputSize = 50,
    topSectorsN = 3,
    weights = DEFAULT_WEIGHTS,
    persist = true
  } = options;

  const startMs = Date.now();
  const date = getISTDateStr();
  const warnings = [];
  const signal_status = {
    catalyst: 'ok',
    gap: 'ok',
    rs: 'ok',
    sector: 'ok',
    direction: 'ok'
  };

  console.log(`${LOG} ▶ shortlist scan started for ${date}`);
  console.log(`${LOG}   regime=${marketContext?.regime} score=${marketContext?.regime_score} playbook=${marketContext?.playbook}`);

  // Respect HALT: return empty shortlist if day is halted
  if (marketContext?.regime === 'HALT') {
    const doc = {
      date,
      market_context: marketContext,
      candidates: [],
      signal_status,
      stats: { universe_size: 0, scored_count: 0, output_count: 0, duration_ms: Date.now() - startMs },
      warnings: [`HALT regime — shortlist skipped: ${marketContext.halt_reason || 'unknown'}`]
    };
    if (persist) await ShortlistWatchlist.upsertForDate(date, doc);
    return doc;
  }

  // Step 1: Load F&O universe
  const universe = await getFnoUniverse(Stock);
  console.log(`${LOG} universe loaded: ${universe.length} F&O stocks`);
  if (universe.length === 0) {
    const doc = {
      date,
      market_context: marketContext,
      candidates: [],
      signal_status: { ...signal_status, catalyst: 'failed', gap: 'failed', rs: 'failed', sector: 'failed', direction: 'failed' },
      stats: { universe_size: 0, scored_count: 0, output_count: 0, duration_ms: Date.now() - startMs },
      warnings: ['F&O universe empty — check Stock collection + FNO_SYMBOLS list']
    };
    if (persist) await ShortlistWatchlist.upsertForDate(date, doc);
    return doc;
  }

  // Step 2–5: Run all non-per-stock signals in parallel
  const [catalystResult, gapResult, niftyResult, sectorResult] = await Promise.all([
    fetchCatalysts(),
    fetchMacroGap(),
    fetchNiftyReturn5d(),
    rankSectors({ topN: topSectorsN })
  ]);

  signal_status.catalyst = catalystResult.status;
  signal_status.gap      = gapResult.status;
  signal_status.rs       = niftyResult.status;
  signal_status.sector   = sectorResult.status;

  if (catalystResult.warning) warnings.push(catalystResult.warning);
  if (gapResult.warning)      warnings.push(gapResult.warning);
  if (niftyResult.warning)    warnings.push(niftyResult.warning);
  if (sectorResult.warning)   warnings.push(sectorResult.warning);

  const mandate = mandateFromContext(marketContext);
  console.log(`${LOG} day mandate: ${mandate}`);

  // Step 6: Fetch per-stock 5-day returns (parallel, chunked to avoid overload)
  console.log(`${LOG} fetching 5-day returns for ${universe.length} stocks...`);
  const CHUNK = 20;
  const stockReturns = new Map();
  for (let i = 0; i < universe.length; i += CHUNK) {
    const batch = universe.slice(i, i + CHUNK);
    await Promise.all(
      batch.map(async s => {
        const r = await fetchStockReturn5d(s.instrument_key, s.trading_symbol);
        stockReturns.set(s.trading_symbol, r);
      })
    );
  }

  // Compute z-scores across universe
  let rsZMap = new Map();
  if (niftyResult.status === 'ok') {
    const rows = universe.map(s => ({
      symbol: s.trading_symbol,
      stockReturn5d: stockReturns.get(s.trading_symbol)
    }));
    rsZMap = computeRsZScores(rows, niftyResult.niftyReturn5d);
    if (rsZMap.size === 0) signal_status.rs = 'degraded';
  } else {
    signal_status.rs = 'failed';
  }

  // Step 7: Score each candidate on all 5 signals
  const candidates = [];
  for (const s of universe) {
    const sym = s.trading_symbol;
    const sectorInfo = getSectorForStock(sym, s.name);
    const sectorCode = sectorInfo?.code || 'OTHER';

    // 1. Catalyst
    const { value: catalyst, meta: catalystMeta } =
      scoreCatalyst(sym, catalystResult.catalystsBySymbol, catalystResult.status);

    // 2. Gap
    let gapPctEstimate = null;
    let gapSignalScore = null;
    if (gapResult.status !== 'failed') {
      gapPctEstimate = estimateStockGap(sectorCode, gapResult.macroGapPct, catalystMeta);
      gapSignalScore = scoreGap(gapPctEstimate);
    }

    // 3. RS
    let rsZ = rsZMap.get(sym);
    if (rsZ === undefined) rsZ = null;
    const rsScore = scoreRs(rsZ);

    // 4. Sector top-3
    const sectorScore =
      sectorResult.status === 'failed' ? null : scoreSector(sectorCode, sectorResult.topN);

    // 5. Direction fit
    const stockDirection = inferStockDirection(gapPctEstimate ?? 0, catalystMeta);
    const directionScore = scoreDirectionFit(stockDirection, mandate);

    // Build reasons
    const reasons = [];
    if (catalyst === 1) reasons.push(`news:${catalystMeta?.headline?.slice(0, 40) || 'catalyst'}`);
    if (gapPctEstimate !== null && Math.abs(gapPctEstimate) >= 1) reasons.push(`gap:${gapPctEstimate}%`);
    if (rsZ !== null && rsZ >= 1) reasons.push(`rs_z:+${rsZ}`);
    if (sectorScore === 1) reasons.push(`sector_top3:${sectorCode}`);

    candidates.push({
      trading_symbol: sym,
      name: s.name,
      instrument_key: s.instrument_key,
      sector: sectorCode,
      direction: stockDirection,
      signals: {
        catalyst,
        gap: gapSignalScore,
        rs: rsScore,
        sector_top3: sectorScore,
        direction_fit: directionScore
      },
      reasons,
      catalyst_meta: catalystMeta
    });
  }

  // Step 8: Rank by composite + take top N
  const ranked = rankCandidates(candidates, weights);
  const output = topN(ranked, outputSize);

  const durationMs = Date.now() - startMs;
  console.log(`${LOG} ✔ done: scored ${candidates.length} / kept top ${output.length} in ${durationMs}ms`);
  console.log(`${LOG}   top 5: ${output.slice(0, 5).map(c => `${c.trading_symbol}(${c.composite_score})`).join(', ')}`);

  const doc = {
    date,
    market_context: marketContext,
    candidates: output,
    signal_status,
    stats: {
      universe_size: universe.length,
      scored_count: candidates.length,
      output_count: output.length,
      duration_ms: durationMs
    },
    warnings
  };

  if (persist) {
    await ShortlistWatchlist.upsertForDate(date, doc);
    console.log(`${LOG} saved to shortlist_watchlists (date=${date})`);
  }

  return doc;
}

export default { buildShortlist };
