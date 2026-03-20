/**
 * Sector Regime Module
 *
 * Checks each sector index (Nifty Bank, Nifty IT, etc.) against its 50 EMA
 * to determine per-sector bullish/bearish regime.
 *
 * Called by dailyPicksService at Step 1 alongside the broad market regime.
 *
 * Nifty 50 answers:   "Should I trade today, and how much?"
 * Sector regime answers: "Which stocks, in which direction?"
 */

import { round2, isNum } from './helpers.js';
import { REGIME } from './regime.js';
import { getSectorForStock } from '../utils/sectorMapping.js';

const LOG = '[SECTOR-REGIME]';

// Map sector code → { instrumentKey, symbol (for getCandleData) }
// Instrument keys from NSE.json, symbols shortened for logging
const SECTOR_INDEX_MAP = {
  TECH:         { instrumentKey: 'NSE_INDEX|Nifty IT',           symbol: 'NIFTY_IT' },
  BANKING:      { instrumentKey: 'NSE_INDEX|Nifty Bank',         symbol: 'NIFTY_BANK' },
  ENERGY:       { instrumentKey: 'NSE_INDEX|Nifty Energy',       symbol: 'NIFTY_ENERGY' },
  AUTO:         { instrumentKey: 'NSE_INDEX|Nifty Auto',         symbol: 'NIFTY_AUTO' },
  PHARMA:       { instrumentKey: 'NSE_INDEX|Nifty Pharma',       symbol: 'NIFTY_PHARMA' },
  FMCG:         { instrumentKey: 'NSE_INDEX|Nifty FMCG',        symbol: 'NIFTY_FMCG' },
  METALS:       { instrumentKey: 'NSE_INDEX|Nifty Metal',        symbol: 'NIFTY_METAL' },
  REALTY:       { instrumentKey: 'NSE_INDEX|Nifty Realty',       symbol: 'NIFTY_REALTY' },
  FINSERVICES:  { instrumentKey: 'NSE_INDEX|Nifty Fin Service',  symbol: 'NIFTY_FINSERV' },
  CEMENT:       { instrumentKey: 'NSE_INDEX|Nifty Infra',        symbol: 'NIFTY_INFRA' },
  INDUSTRIAL:   { instrumentKey: 'NSE_INDEX|Nifty Infra',        symbol: 'NIFTY_INFRA' },
  DEFENSE:      { instrumentKey: 'NSE_INDEX|Nifty Ind Defence',  symbol: 'NIFTY_DEFENCE' },
  TRANSPORT:    { instrumentKey: 'NSE_INDEX|Nifty Trans Logis',  symbol: 'NIFTY_TRANSLOG' },
  CHEMICALS:    { instrumentKey: 'NSE_INDEX|Nifty Commodities',  symbol: 'NIFTY_COMMODITIES' },
  TELECOM:      { instrumentKey: 'NSE_INDEX|Nifty Commodities',  symbol: 'NIFTY_COMMODITIES' },  // no dedicated telecom index
  COMMODITIES:  { instrumentKey: 'NSE_INDEX|Nifty Commodities',  symbol: 'NIFTY_COMMODITIES' },
};

/**
 * Calculate EMA for an array of values
 */
function calculateEMA(data, period) {
  if (!data || data.length < period) return null;
  const k = 2 / (period + 1);
  let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Determine regime from distance percentage (same thresholds as broad market)
 */
function regimeFromDistance(distancePct) {
  if (distancePct > 3)  return REGIME.STRONG_BULLISH;
  if (distancePct > 1)  return REGIME.BULLISH;
  if (distancePct < -3) return REGIME.STRONG_BEARISH;
  if (distancePct < -1) return REGIME.BEARISH;
  return REGIME.NEUTRAL;
}

/**
 * Fetch and check regime for ALL sectors in parallel.
 * De-duplicates shared indices (CEMENT/INDUSTRIAL both use Nifty Infra) to avoid double API calls.
 *
 * @param {Object} options - { allowOutdated }
 * @returns {Object} { sectorRegimes: { BANKING: {...}, TECH: {...}, ... }, bullish, bearish, neutral }
 */
export async function fetchAllSectorRegimes({ allowOutdated = false } = {}) {
  // Dynamic import — same pattern as regime.js to avoid circular deps with services/
  const { getCandleData } = await import('../services/technicalData.service.js');

  // De-duplicate instrument keys — CEMENT and INDUSTRIAL both use NIFTY_INFRA, etc.
  const uniqueKeys = {};
  for (const [sectorCode, info] of Object.entries(SECTOR_INDEX_MAP)) {
    if (!uniqueKeys[info.instrumentKey]) {
      uniqueKeys[info.instrumentKey] = { info, sectors: [sectorCode] };
    } else {
      uniqueKeys[info.instrumentKey].sectors.push(sectorCode);
    }
  }

  // Fetch all unique indices in parallel
  const fetchPromises = Object.entries(uniqueKeys).map(async ([instrumentKey, { info, sectors }]) => {
    let ema50 = null;
    let last = null;
    let distancePct = null;
    let regime = REGIME.UNKNOWN;

    try {
      const candles = await getCandleData(instrumentKey, info.symbol, '1d', { allowOutdated });
      if (candles && candles.length >= 50) {
        const closes = candles.map(c => Array.isArray(c) ? c[4] : c.close);
        ema50 = calculateEMA(closes, 50);
        last = closes[closes.length - 1];
        if (isNum(ema50) && isNum(last)) {
          distancePct = round2(((last - ema50) / ema50) * 100);
          regime = regimeFromDistance(distancePct);
        }
      }
    } catch (err) {
      console.error(`${LOG} ${info.symbol}: fetch failed — ${err.message}`);
    }

    // Map result to all sectors that share this index
    return sectors.map(sectorCode => ({
      sector: sectorCode,
      regime,
      last: isNum(last) ? round2(last) : null,
      ema50: isNum(ema50) ? round2(ema50) : null,
      distancePct,
      indexName: info.symbol,
    }));
  });

  const results = (await Promise.all(fetchPromises)).flat();

  // Build sector → regime map
  const sectorRegimes = {};
  for (const r of results) {
    sectorRegimes[r.sector] = r;
  }

  // Print results — log by unique index first, then sector mappings
  console.log(`${LOG} ═══════════════════════════════════════════════════════`);
  console.log(`${LOG} SECTOR REGIME CHECK (${Object.keys(uniqueKeys).length} indices → ${results.length} sectors)`);
  console.log(`${LOG} ───────────────────────────────────────────────────────`);

  // Log each unique index once with all mapped sectors
  for (const [, { info, sectors }] of Object.entries(uniqueKeys)) {
    const r = sectorRegimes[sectors[0]]; // all share same regime
    const tag = r.regime.includes('BULL') ? '🟢' : r.regime.includes('BEAR') ? '🔴' : '⚪';
    const distStr = r.distancePct !== null ? `${r.distancePct > 0 ? '+' : ''}${r.distancePct}%` : 'N/A';
    const sectorList = sectors.join(', ');
    console.log(`${LOG} ${tag} ${info.symbol.padEnd(20)} ${r.regime.padEnd(16)} ${distStr.padStart(7)} from EMA50  → ${sectorList}`);
  }

  const bullish = [];
  const bearish = [];
  const neutral = [];

  for (const r of results) {
    if (r.regime === REGIME.STRONG_BULLISH || r.regime === REGIME.BULLISH) bullish.push(r.sector);
    else if (r.regime === REGIME.STRONG_BEARISH || r.regime === REGIME.BEARISH) bearish.push(r.sector);
    else neutral.push(r.sector);
  }

  console.log(`${LOG} ───────────────────────────────────────────────────────`);
  console.log(`${LOG} BULLISH sectors (${bullish.length}): ${bullish.join(', ') || 'none'}`);
  console.log(`${LOG} BEARISH sectors (${bearish.length}): ${bearish.join(', ') || 'none'}`);
  console.log(`${LOG} NEUTRAL sectors (${neutral.length}): ${neutral.join(', ') || 'none'}`);
  console.log(`${LOG} ═══════════════════════════════════════════════════════`);

  return {
    sectorRegimes,
    bullish,
    bearish,
    neutral,
  };
}

/**
 * Get the regime for a specific stock's sector.
 * Falls back to broadMarketRegime for unmapped stocks (OTHER) so callers always get a result.
 *
 * @param {string} stockSymbol - e.g. 'TCS', 'HDFCBANK'
 * @param {Object} sectorRegimes - result.sectorRegimes from fetchAllSectorRegimes()
 * @param {Object} [broadMarketRegime] - result from fetchAndCheckRegime() — used as fallback for OTHER
 * @returns {Object} sector regime result (never null — falls back to broad market)
 */
export function getSectorRegimeForStock(stockSymbol, sectorRegimes, broadMarketRegime = null) {
  const sector = getSectorForStock(stockSymbol);

  if (sector && sector.code !== 'OTHER' && sectorRegimes[sector.code]) {
    return sectorRegimes[sector.code];
  }

  // Fallback: use broad market regime for unmapped stocks
  if (broadMarketRegime) {
    return {
      sector: 'OTHER',
      regime: broadMarketRegime.regime,
      last: broadMarketRegime.niftyLast,
      ema50: broadMarketRegime.ema50,
      distancePct: broadMarketRegime.distancePct,
      indexName: 'NIFTY_50',
    };
  }

  return { sector: 'OTHER', regime: REGIME.NEUTRAL, last: null, ema50: null, distancePct: null, indexName: 'NIFTY_50' };
}

export { SECTOR_INDEX_MAP };

export default {
  fetchAllSectorRegimes,
  getSectorRegimeForStock,
  SECTOR_INDEX_MAP,
};
