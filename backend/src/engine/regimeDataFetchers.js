/**
 * Regime Data Fetchers — v2
 *
 * Pulls the five input data bundles for buildMarketContext:
 *   - niftyStructure    (via candleFetcherService — DB cache + rate-limited Upstox)
 *   - breadthPct        (from breadth_daily collection, populated by nightly job)
 *   - vixData           (from india_vix_daily collection + rolling percentile calc)
 *   - overnightData     (scraped live at 8:40 AM — reuses existing SGX scraper)
 *   - flowData          (from institutional_flow_daily collection)
 *
 * Every function is fail-soft: returns null on failure. buildMarketContext
 * handles null inputs via null-safe weighted sum.
 */

import BreadthDaily from '../models/breadthDaily.js';
import IndiaVixDaily from '../models/indiaVixDaily.js';
import InstitutionalFlowDaily from '../models/institutionalFlowDaily.js';
import { VIX_PERCENTILE_WINDOW_DAYS } from '../constants/regimeConstants.js';

const NIFTY_50_INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';

// ─── Nifty structure ─────────────────────────────────────────────────────────

function ema(data, period) {
  if (!data || data.length < period) return null;
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}

/**
 * Returns { close, ema20, ema50, ema50_prev5 } or null.
 * Uses candleFetcherService (DB-first + rate-limited Upstox + incremental update).
 */
export async function fetchNiftyStructure() {
  try {
    const { default: candleFetcherService } =
      await import('../services/candleFetcher.service.js');

    const result = await candleFetcherService.getCandleDataForAnalysis(
      NIFTY_50_INSTRUMENT_KEY,
      'swing',   // term — fetches 1d (plus 15m/1h for cache) — only 1d used here
      true       // skipIntraday — we only need daily
    );
    if (!result?.success) return null;

    const candles = result.data?.['1d'] || [];
    if (candles.length < 55) return null;

    const closes = candles.map(c => Array.isArray(c) ? c[4] : c.close);
    const close = closes[closes.length - 1];
    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    // ema50 5 trading days ago = ema over closes with last 5 dropped
    const ema50_prev5 = ema(closes.slice(0, -5), 50);

    if (![close, ema20, ema50, ema50_prev5].every(x => typeof x === 'number' && Number.isFinite(x))) {
      return null;
    }
    return { close, ema20, ema50, ema50_prev5 };
  } catch (err) {
    console.error('[REGIME V2] fetchNiftyStructure failed:', err.message);
    return null;
  }
}

// ─── Breadth ─────────────────────────────────────────────────────────────────

/**
 * Returns % of Nifty 500 constituents trading above their own 50-DMA, or null.
 * Reads the most recent row from breadth_daily (populated nightly).
 */
export async function fetchBreadthPct() {
  try {
    const latest = await BreadthDaily.findOne().sort({ date: -1 }).lean();
    if (!latest || typeof latest.pct_above_50dma !== 'number') return null;
    return latest.pct_above_50dma;
  } catch (err) {
    console.error('[REGIME V2] fetchBreadthPct failed:', err.message);
    return null;
  }
}

// ─── VIX ─────────────────────────────────────────────────────────────────────

/**
 * Returns { close, percentileRank } or null.
 * Percentile is computed over the trailing VIX_PERCENTILE_WINDOW_DAYS.
 */
export async function fetchVixData() {
  try {
    const rows = await IndiaVixDaily
      .find()
      .sort({ date: -1 })
      .limit(VIX_PERCENTILE_WINDOW_DAYS + 1)
      .lean();
    if (!rows || rows.length === 0) return null;
    const latest = rows[0];
    if (typeof latest.close !== 'number') return null;

    const closes = rows.map(r => r.close).filter(x => typeof x === 'number');
    if (closes.length < 30) {
      // Not enough history; return close without percentile.
      return { close: latest.close, percentileRank: null };
    }

    // Percentile rank of latest within closes.
    const sorted = [...closes].sort((a, b) => a - b);
    const idx = sorted.findIndex(x => x >= latest.close);
    const pct = idx < 0 ? 100 : Math.round((idx / sorted.length) * 100);
    return { close: latest.close, percentileRank: pct };
  } catch (err) {
    console.error('[REGIME V2] fetchVixData failed:', err.message);
    return null;
  }
}

// ─── Overnight (GIFT + Asia + DXY) ───────────────────────────────────────────

async function fetchYahooQuoteChangePct(symbol) {
  // Yahoo's free quote endpoint. If Yahoo flakiness becomes a problem,
  // swap to Upstox index instruments or a paid vendor.
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  const q = json?.quoteResponse?.result?.[0];
  const pct = q?.regularMarketChangePercent;
  if (typeof pct !== 'number') throw new Error('Yahoo: missing changePercent');
  return pct;
}

/**
 * Returns { giftPct, asiaCompositePct, dxyPct } — every field nullable.
 * GIFT Nifty reuses your existing scraper. Asia & DXY fetched here.
 */
export async function fetchOvernightData() {
  const out = { giftPct: null, asiaCompositePct: null, dxyPct: null };

  // GIFT / SGX Nifty — use the globalMarketIntel scraper which is the single
  // working source in this codebase (returns { change_pct, last_price, ... }).
  try {
    const { fetchSGXNiftyData } = await import('../services/dailyPicks/globalMarketIntel.js');
    if (typeof fetchSGXNiftyData === 'function') {
      const g = await fetchSGXNiftyData();
      const pct = g?.change_pct ?? g?.changePct;
      if (typeof pct === 'number') out.giftPct = pct;
    }
  } catch (err) {
    console.warn('[REGIME V2] GIFT Nifty fetch failed:', err.message);
  }

  // Asia composite = average of Nikkei 225 + Hang Seng change %
  try {
    const [nikkei, hangseng] = await Promise.all([
      fetchYahooQuoteChangePct('^N225').catch(() => null),
      fetchYahooQuoteChangePct('^HSI').catch(() => null),
    ]);
    const parts = [nikkei, hangseng].filter(x => typeof x === 'number');
    if (parts.length > 0) out.asiaCompositePct = parts.reduce((a, b) => a + b, 0) / parts.length;
  } catch (err) {
    console.warn('[REGIME V2] Asia composite fetch failed:', err.message);
  }

  // DXY
  try {
    const dxy = await fetchYahooQuoteChangePct('DX-Y.NYB').catch(() => null);
    if (typeof dxy === 'number') out.dxyPct = dxy;
  } catch (err) {
    console.warn('[REGIME V2] DXY fetch failed:', err.message);
  }

  return out;
}

// ─── Flow (prev-day FII/DII) ─────────────────────────────────────────────────

/**
 * Returns { fiiCr, diiCr } or null. Reads the most recent row (one-day-lag acceptable).
 */
export async function fetchPrevDayFlow() {
  try {
    const latest = await InstitutionalFlowDaily.findOne().sort({ date: -1 }).lean();
    if (!latest) return null;
    return {
      fiiCr: typeof latest.fii_net_cr === 'number' ? latest.fii_net_cr : null,
      diiCr: typeof latest.dii_net_cr === 'number' ? latest.dii_net_cr : null,
    };
  } catch (err) {
    console.error('[REGIME V2] fetchPrevDayFlow failed:', err.message);
    return null;
  }
}

// ─── Top-level orchestrator: fetch everything in parallel ────────────────────

export async function fetchAllRegimeInputs() {
  const [niftyStructure, breadthPct, vixData, overnightData, flowData] = await Promise.all([
    fetchNiftyStructure(),
    fetchBreadthPct(),
    fetchVixData(),
    fetchOvernightData(),
    fetchPrevDayFlow(),
  ]);
  return { niftyStructure, breadthPct, vixData, overnightData, flowData };
}

export default {
  fetchNiftyStructure,
  fetchBreadthPct,
  fetchVixData,
  fetchOvernightData,
  fetchPrevDayFlow,
  fetchAllRegimeInputs,
};
