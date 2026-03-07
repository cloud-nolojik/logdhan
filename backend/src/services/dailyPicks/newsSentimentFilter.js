/**
 * @deprecated — FULLY SUPERSEDED as of the audit fix (March 2026).
 *
 * Scoring is now done in TWO places, both using shared constants from dailyPicksConstants.js:
 *   1. LIVE: dailyPicksService.js Step 5.5 (inline scoring after global intel fetch)
 *   2. BACKTEST: pipelineBacktest.js extractViableCandidates() (same constants)
 *
 * This module is NO LONGER imported anywhere. Keeping for reference only.
 * Safe to delete once confident nothing calls it.
 *
 * Data source: globalMarketIntel.js (Claude web search with candidate stock symbols).
 *
 * Scoring:
 * - Stock with bullish news + LONG direction → +8 pts
 * - Stock in hot sector + LONG direction → +5 pts
 * - Stock with bearish news + LONG direction → -12 pts
 * - Stock in cold sector + LONG direction → -6 pts
 * - (Reverse for SHORT)
 *
 * Fail-open: if no intel available, all candidates pass through unscored.
 */

import { getSectorSentimentForStock, getStockSpecificNews } from './globalMarketIntel.js';
import { SECTOR_MAPPING } from '../../utils/sectorMapping.js';

const LOG = '[NEWS-SENTIMENT]';

// Scoring adjustments — stock-specific news
const STOCK_NEWS_BOOST = 8;        // +8 pts for stock-specific aligned HIGH impact
const STOCK_NEWS_PENALTY = -12;    // -12 pts for stock-specific opposing HIGH impact

// Scoring adjustments — sector-level
const SECTOR_BOOST = 5;            // +5 pts for stock in hot sector (aligned)
const SECTOR_PENALTY = -6;         // -6 pts for stock in cold sector (opposing)

/**
 * Apply news + sector sentiment scoring to candidates.
 * Uses LIVE data from globalMarketIntel (Step 5.5 web search).
 *
 * Attaches _newsSentiment to each candidate with:
 *   - sentiment, source (stock_news | sector | none)
 *   - adjustment (positive or negative)
 *   - reason (human-readable)
 *
 * @param {Array} candidates - Enriched candidates
 * @returns {Array} Same candidates with _newsSentiment attached
 */
async function applyNewsSentiment(candidates) {
  if (!candidates || candidates.length === 0) return candidates;

  console.log(`${LOG} ═══════════════════════════════════════`);
  console.log(`${LOG} Applying news sentiment to ${candidates.length} candidates`);

  let stockBoosted = 0, stockPenalized = 0;
  let sectorBoosted = 0, sectorPenalized = 0;
  let noData = 0;

  for (const c of candidates) {
    const symbol = (c.symbol || '').toUpperCase();
    const isBullish = c.direction === 'LONG';

    let adjustment = 0;
    let reason = '';
    let sentiment = null;
    let source = 'none';
    let topHeadline = null;

    // Priority 1: Stock-specific news (highest signal)
    const stockNews = getStockSpecificNews(symbol);
    if (stockNews && stockNews.sentiment) {
      sentiment = stockNews.sentiment;
      topHeadline = stockNews.headline || null;
      source = 'stock_news';

      const aligned = (isBullish && sentiment === 'BULLISH') || (!isBullish && sentiment === 'BEARISH');
      const opposing = (isBullish && sentiment === 'BEARISH') || (!isBullish && sentiment === 'BULLISH');

      if (aligned && stockNews.impact === 'HIGH') {
        adjustment = STOCK_NEWS_BOOST;
        reason = `stock_news_aligned (${sentiment}, ${stockNews.headline || ''})`;
        stockBoosted++;
      } else if (opposing && stockNews.impact === 'HIGH') {
        adjustment = STOCK_NEWS_PENALTY;
        reason = `stock_news_opposing (${sentiment}, ${stockNews.headline || ''})`;
        stockPenalized++;
      } else if (aligned) {
        adjustment = Math.round(STOCK_NEWS_BOOST / 2);
        reason = `stock_news_mild_aligned (${sentiment})`;
        stockBoosted++;
      } else if (opposing) {
        adjustment = Math.round(STOCK_NEWS_PENALTY / 2);
        reason = `stock_news_mild_opposing (${sentiment})`;
        stockPenalized++;
      }
    }

    // Priority 2: Sector sentiment (if no stock-specific news)
    if (adjustment === 0) {
      const sectorInfo = getSectorSentimentForStock(symbol, SECTOR_MAPPING);
      if (sectorInfo && sectorInfo.sentiment) {
        sentiment = sectorInfo.sentiment;
        source = 'sector';

        const aligned = (isBullish && sentiment === 'BULLISH') || (!isBullish && sentiment === 'BEARISH');
        const opposing = (isBullish && sentiment === 'BEARISH') || (!isBullish && sentiment === 'BULLISH');

        if (aligned) {
          adjustment = SECTOR_BOOST;
          reason = `sector_bullish (${sectorInfo.sectorName}: ${sectorInfo.reason || ''})`;
          sectorBoosted++;
        } else if (opposing) {
          adjustment = SECTOR_PENALTY;
          reason = `sector_bearish (${sectorInfo.sectorName}: ${sectorInfo.reason || ''})`;
          sectorPenalized++;
        } else {
          reason = `sector_neutral (${sectorInfo.sectorName})`;
        }
      } else {
        noData++;
        reason = 'no_intel';
      }
    }

    c._newsSentiment = {
      sentiment,
      source,
      adjustment,
      reason,
      topHeadline
    };

    const originalScore = c.rank_score || 0;
    if (adjustment !== 0) {
      c.rank_score = (c.rank_score || 0) + adjustment;
      console.log(`${LOG} ${adjustment > 0 ? '📈' : '📉'} ${symbol} (${c.direction}): score ${originalScore}→${c.rank_score} (${adjustment > 0 ? '+' : ''}${adjustment}) via ${source} — ${reason}`);
      if (topHeadline) console.log(`${LOG}   └─ "${topHeadline}"`);
    } else {
      console.log(`${LOG}   ${symbol} (${c.direction}): score ${originalScore} unchanged — ${reason}`);
    }
  }

  console.log(`${LOG} ───────────────────────────────────────`);
  console.log(`${LOG} Sentiment summary: stock[+${stockBoosted}/-${stockPenalized}] sector[+${sectorBoosted}/-${sectorPenalized}] no_data=${noData} (${candidates.length} total)`);
  if (stockBoosted + stockPenalized + sectorBoosted + sectorPenalized === 0 && noData === candidates.length) {
    console.log(`${LOG} ⚠️ No intel data available — all candidates passed unscored (fail-open)`);
  }
  console.log(`${LOG} ═══════════════════════════════════════`);

  return candidates;
}

/**
 * Clear cache — kept for backward compatibility.
 * Actual cache clearing is now in globalMarketIntel.clearIntelCache()
 */
function clearNewsCache() {
  // No-op: cache is in globalMarketIntel.js now
}

export {
  applyNewsSentiment,
  clearNewsCache,
  STOCK_NEWS_BOOST,
  STOCK_NEWS_PENALTY,
  SECTOR_BOOST,
  SECTOR_PENALTY
};
