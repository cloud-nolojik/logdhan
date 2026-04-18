/**
 * Gap signal — estimated opening gap % per stock at 8:30 AM.
 *
 * We don't have pre-open matched prices yet (that's 9:08). So at 8:30 we estimate:
 *   stock_gap ≈ SGX_Nifty_pct × sector_beta + catalyst_boost
 *
 * Sector betas are rough averages — purpose is to bias the 8:30 shortlist toward
 * stocks likely to gap in the macro direction. The 9:08 finalize pass replaces
 * these estimates with actual pre-open prints.
 */

import { fetchSGXNiftyData } from '../../dailyPicks/globalMarketIntel.js';

const LOG = '[shortlist/gap]';

/**
 * Rough sector betas to Nifty (1-day).
 * Calibrated from long-term observation — not daily-recomputed.
 * Higher beta = stock/sector moves more than Nifty per unit of Nifty move.
 */
export const SECTOR_BETAS = {
  BANKING:     1.15,
  TECH:        1.20,
  AUTO:        1.10,
  METALS:      1.35,  // highest beta — commodities driven
  ENERGY:      1.00,
  PHARMA:      0.70,  // defensive
  FMCG:        0.60,  // most defensive
  CEMENT:      0.95,
  REALTY:      1.30,
  INDUSTRIAL:  1.10,
  FINSERVICES: 1.10,
  DEFENSE:     0.90,
  TRANSPORT:   0.90,
  CHEMICALS:   0.90,
  TELECOM:     0.75,
  COMMODITIES: 1.15,
  OTHER:       1.00
};

/**
 * Fetch the macro gap baseline (SGX Nifty change %).
 * Returns a status object the orchestrator stores in signal_status.
 */
export async function fetchMacroGap() {
  try {
    const sgx = await fetchSGXNiftyData();
    if (!sgx || typeof sgx.change_pct !== 'number') {
      return { status: 'failed', macroGapPct: null, warning: 'SGX Nifty change_pct missing' };
    }
    console.log(`${LOG} SGX Nifty ${sgx.change_pct >= 0 ? '+' : ''}${sgx.change_pct}%`);
    return { status: 'ok', macroGapPct: sgx.change_pct, sgxRaw: sgx };
  } catch (err) {
    console.warn(`${LOG} SGX fetch failed, gap signal degraded: ${err.message}`);
    return { status: 'degraded', macroGapPct: 0, warning: `SGX fetch failed: ${err.message}` };
  }
}

/**
 * Estimate gap % for a single stock.
 *
 * @param {string} sectorCode  - SECTOR_MAPPING key (e.g. 'TECH', 'BANKING')
 * @param {number} macroGapPct - SGX Nifty change %
 * @param {object} catalystMeta - From catalystSignal ({ direction, sentiment } or null)
 * @returns {number} Estimated gap %
 */
export function estimateStockGap(sectorCode, macroGapPct, catalystMeta) {
  const beta = SECTOR_BETAS[sectorCode] ?? SECTOR_BETAS.OTHER;
  let gap = (macroGapPct ?? 0) * beta;

  // Catalyst nudge: strong news can add/subtract ~1% independent of macro
  if (catalystMeta) {
    const dir = (catalystMeta.direction || '').toUpperCase();
    const sentiment = (catalystMeta.sentiment || '').toLowerCase();
    if (dir === 'LONG' || sentiment === 'bullish' || sentiment === 'positive') {
      gap += 0.8;
    } else if (dir === 'SHORT' || sentiment === 'bearish' || sentiment === 'negative') {
      gap -= 0.8;
    }
  }

  return Number(gap.toFixed(2));
}

/**
 * Score a stock's gap contribution to composite.
 *
 * Scoring rules:
 *   |gap| >= 2.0%  → 1.0  (strong gap, high-interest)
 *   |gap| >= 1.0%  → 0.6  (moderate)
 *   |gap| >= 0.3%  → 0.2  (mild)
 *   otherwise      → 0    (flat — not worth watching)
 *
 * Sign of gap is used to infer direction elsewhere; this returns only magnitude score.
 */
export function scoreGap(gapPct) {
  if (gapPct === null || gapPct === undefined) return null;
  const abs = Math.abs(gapPct);
  if (abs >= 2.0) return 1.0;
  if (abs >= 1.0) return 0.6;
  if (abs >= 0.3) return 0.2;
  return 0;
}

export default { fetchMacroGap, estimateStockGap, scoreGap, SECTOR_BETAS };
