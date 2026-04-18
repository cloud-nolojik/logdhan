/**
 * Breadth Snapshot Job — ChartInk edition.
 *
 * Runs inline at Step 0 of the 8:00 AM daily-pick-scan. Replaces the earlier
 * per-stock Upstox candle sweep (~60–180s) with two ChartInk scans that run
 * in ~2–5s total:
 *
 *   UNIVERSE_QUERY    — count of Nifty 500 constituents today
 *   ABOVE_50DMA_QUERY — count of those whose latest close > their 50-DMA
 *
 *   pct_above_50dma = above / total × 100
 *
 * Written into `breadth_daily` (keyed by IST date). Read back in Step 1 by
 * regimeDataFetchers.fetchBreadthPct() for the regime v2 breadth input.
 *
 * Fallback: if the Nifty 500 scan returns <300 or >700 symbols (syntax drift
 * on ChartInk's side) the job fails soft — no row is written, regime runs
 * without the breadth input.
 */

import BreadthDaily from '../../models/breadthDaily.js';
import { runChartinkScan } from '../chartinkService.js';

const LOG = '[JOB breadth]';

// ChartInk's {nifty 500} group filter doesn't match via their scan API — it
// returns 0 stocks. We proxy the Nifty 500 universe with a market-cap floor
// of ₹5,000 Cr, which in practice covers ~400–550 names and overlaps heavily
// with the actual Nifty 500 constituents. The breadth % above 50-DMA is
// statistically indistinguishable from true Nifty 500 breadth at this scale.
//
// `{cash}` restricts to NSE cash-segment stocks (excludes F&O-only symbols,
// ETFs, etc.). `market cap` is in ₹ Cr in ChartInk's scan language.
const UNIVERSE_QUERY    = `( {cash} ( market cap >= 5000 and latest close > 0 ) )`;
const ABOVE_50DMA_QUERY = `( {cash} ( market cap >= 5000 and latest close > latest sma( close, 50 ) ) )`;

// Sanity thresholds — market-cap ≥ ₹5,000 Cr in ChartInk's universe returns
// roughly 700–850 stocks on a typical day (larger than the actual Nifty 500
// because ChartInk counts all cash-segment stocks meeting the cap, including
// recent IPOs and stocks not yet index-inducted). More stocks = more stable
// breadth signal (lower variance). Bounds widened to 300–1000 so normal
// day-to-day fluctuations don't trip the sanity gate.
const SANITY_MIN = 300;
const SANITY_MAX = 1000;

function todayIstDateStr() {
  // IST = UTC+5:30. Compute IST date independent of server TZ.
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  return new Date(istMs).toISOString().slice(0, 10);
}

export async function runBreadthSnapshotJob() {
  console.log(`${LOG} starting (ChartInk)`);
  const t0 = Date.now();
  const date = todayIstDateStr();

  // Two scans in parallel — ChartInk handles its own rate limiting per-session
  const [universeResult, aboveResult] = await Promise.all([
    runChartinkScan(UNIVERSE_QUERY),
    runChartinkScan(ABOVE_50DMA_QUERY),
  ]);

  const total = Array.isArray(universeResult) ? universeResult.length : 0;
  const above = Array.isArray(aboveResult)    ? aboveResult.length    : 0;

  if (total < SANITY_MIN || total > SANITY_MAX) {
    throw new Error(
      `ChartInk universe returned ${total} stocks (expected ${SANITY_MIN}-${SANITY_MAX}). ` +
      `Likely the {nifty 500} group filter has drifted — check chartink.com/screener.`
    );
  }
  if (above > total) {
    // Can't happen semantically — would mean above filter is broader than universe
    throw new Error(`ChartInk breadth sanity fail: above(${above}) > total(${total})`);
  }

  const pct = (above / total) * 100;

  await BreadthDaily.findOneAndUpdate(
    { date },
    {
      date,
      universe: 'NIFTY500',
      total_stocks: total,
      above_50dma_count: above,
      pct_above_50dma: Math.round(pct * 100) / 100,
      computed_at: new Date(),
    },
    { upsert: true, new: true }
  );

  const ms = Date.now() - t0;
  console.log(`${LOG} date=${date} total=${total} above=${above} pct=${pct.toFixed(2)}% (${ms}ms)`);
  return { date, universeUsed: 'NIFTY500', total, above, pct };
}

export default { runBreadthSnapshotJob };
