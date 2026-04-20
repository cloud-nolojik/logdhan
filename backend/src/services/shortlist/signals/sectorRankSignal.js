/**
 * Sector ranking signal — rank sector indices by 5-day return.
 *
 * Intraday winners cluster in leading sectors. "Top-3 sector" is the lightest,
 * most reliable regime filter. Stocks in a strong sector benefit from sector
 * tape regardless of their own setup.
 *
 * This signal scores: is the stock's sector in the top-3 for 5-day return?
 */

import { getCandleData } from '../../technicalData.service.js';

const LOG = '[shortlist/sector]';

// Reuse the same sector index map used by sectorRegime.js.
// Hardcoded here to avoid cross-module import chain (keeps this signal standalone-testable).
const SECTOR_INDEX_MAP = {
  TECH:         { instrumentKey: 'NSE_INDEX|Nifty IT',           symbol: 'NIFTY_IT' },
  BANKING:      { instrumentKey: 'NSE_INDEX|Nifty Bank',         symbol: 'NIFTY_BANK' },
  ENERGY:       { instrumentKey: 'NSE_INDEX|Nifty Energy',       symbol: 'NIFTY_ENERGY' },
  // POWER is a dedicated bucket for T&D / heavy electrical equipment stocks
  // (BHEL, ABB, Hitachi Energy, CG Power, KEI, Siemens etc.).
  // Nifty PSE tracks public-sector enterprises and is the best available proxy
  // for this cluster — it captures BHEL, NTPC, Power Grid, Coal India, ONGC, etc.
  POWER:        { instrumentKey: 'NSE_INDEX|Nifty PSE',          symbol: 'NIFTY_PSE' },
  AUTO:         { instrumentKey: 'NSE_INDEX|Nifty Auto',         symbol: 'NIFTY_AUTO' },
  PHARMA:       { instrumentKey: 'NSE_INDEX|Nifty Pharma',       symbol: 'NIFTY_PHARMA' },
  FMCG:         { instrumentKey: 'NSE_INDEX|Nifty FMCG',         symbol: 'NIFTY_FMCG' },
  METALS:       { instrumentKey: 'NSE_INDEX|Nifty Metal',        symbol: 'NIFTY_METAL' },
  REALTY:       { instrumentKey: 'NSE_INDEX|Nifty Realty',       symbol: 'NIFTY_REALTY' },
  FINSERVICES:  { instrumentKey: 'NSE_INDEX|Nifty Fin Service',  symbol: 'NIFTY_FINSERV' },
  CEMENT:       { instrumentKey: 'NSE_INDEX|Nifty Infra',        symbol: 'NIFTY_INFRA' },
  INDUSTRIAL:   { instrumentKey: 'NSE_INDEX|Nifty Infra',        symbol: 'NIFTY_INFRA' }
};

function nDayReturn(candles, n) {
  if (!Array.isArray(candles) || candles.length < n + 1) return null;
  const t0 = candles[0]?.[0];
  const tLast = candles[candles.length - 1]?.[0];
  const descending = t0 && tLast && new Date(t0).getTime() > new Date(tLast).getTime();
  const newest = descending ? candles[0] : candles[candles.length - 1];
  const nBack  = descending ? candles[n] : candles[candles.length - 1 - n];
  const newestClose = newest?.[4];
  const nBackClose  = nBack?.[4];
  if (!newestClose || !nBackClose) return null;
  return ((newestClose - nBackClose) / nBackClose) * 100;
}

/**
 * Rank sectors by 5-day return.
 * Returns { sectorReturns: { CODE: pct }, topN: ['CODE', ...], ranks: { CODE: 1..N } }
 */
export async function rankSectors({ topN = 3, lookbackDays = 5 } = {}) {
  const uniqueIndices = new Map(); // instrumentKey → {symbol, sectorsUsingIt: []}
  for (const [code, { instrumentKey, symbol }] of Object.entries(SECTOR_INDEX_MAP)) {
    if (!uniqueIndices.has(instrumentKey)) {
      uniqueIndices.set(instrumentKey, { symbol, codes: [] });
    }
    uniqueIndices.get(instrumentKey).codes.push(code);
  }

  const returnsPerIndex = {};
  const failures = [];

  // Fetch all unique sector-index candles in parallel
  await Promise.all(
    Array.from(uniqueIndices.entries()).map(async ([instrumentKey, { symbol, codes }]) => {
      try {
        const candles = await getCandleData(instrumentKey, symbol, '1d', { allowOutdated: true });
        const r = nDayReturn(candles, lookbackDays);
        if (r !== null) {
          for (const c of codes) returnsPerIndex[c] = r;
        } else {
          failures.push(symbol);
        }
      } catch (err) {
        failures.push(`${symbol}(${err.message})`);
      }
    })
  );

  if (Object.keys(returnsPerIndex).length === 0) {
    return {
      status: 'failed',
      sectorReturns: {},
      topN: [],
      ranks: {},
      warning: `sector ranking failed: ${failures.join(',')}`
    };
  }

  // Rank by return DESC
  const ranked = Object.entries(returnsPerIndex).sort((a, b) => b[1] - a[1]);
  const ranks = {};
  ranked.forEach(([code], i) => { ranks[code] = i + 1; });
  const top    = ranked.slice(0, topN).map(([code]) => code);
  const bottom = ranked.slice(-topN).map(([code]) => code);   // weakest N sectors

  console.log(`${LOG} ranked ${ranked.length} sectors, top ${topN}: ${top.join(', ')} | bottom ${topN}: ${bottom.join(', ')}`);

  return {
    status: failures.length > 0 ? 'degraded' : 'ok',
    sectorReturns: returnsPerIndex,
    topN: top,
    bottomN: bottom,
    ranks,
    warning: failures.length > 0 ? `${failures.length} index fetches failed: ${failures.join(',')}` : null
  };
}

/**
 * Score: is this stock's sector in the top-N sectors for 5-day return?
 */
export function scoreSector(sectorCode, topNSectors) {
  if (!sectorCode || !Array.isArray(topNSectors)) return null;
  return topNSectors.includes(sectorCode) ? 1 : 0;
}

export default { rankSectors, scoreSector };
