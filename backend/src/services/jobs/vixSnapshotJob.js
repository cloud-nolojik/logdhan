/**
 * India VIX Snapshot Job
 *
 * Schedule: 21:00 IST daily (after NSE close)
 *
 * Fetches India VIX close from NSE allIndices API and upserts into india_vix_daily.
 */

import IndiaVixDaily from '../../models/indiaVixDaily.js';

const NSE_ALL_INDICES_URL = 'https://www.nseindia.com/api/allIndices';

function todayIstDateStr() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  return new Date(istMs).toISOString().slice(0, 10);
}

/**
 * NSE blocks simple fetches — they require a session cookie dance.
 * If you already have an NSE scraper utility, prefer that.
 */
async function fetchNseVix() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.nseindia.com/',
  };

  // Step 1: get cookies by hitting the homepage
  await fetch('https://www.nseindia.com/', { headers, signal: AbortSignal.timeout(8000) });

  // Step 2: call the allIndices endpoint
  const res = await fetch(NSE_ALL_INDICES_URL, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`NSE allIndices HTTP ${res.status}`);
  const json = await res.json();

  const vix = (json?.data || []).find(i =>
    (i.index || '').toUpperCase().includes('INDIA VIX')
  );
  if (!vix) throw new Error('INDIA VIX not found in allIndices response');

  const num = (v) => {
    if (typeof v === 'number') return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    open: num(vix.open),
    high: num(vix.high),
    low: num(vix.low),
    close: num(vix.last ?? vix.previousClose),
    prev_close: num(vix.previousClose),
    change_pct: num(vix.percentChange),
  };
}

export async function runVixSnapshotJob() {
  console.log('[JOB vix] starting');
  const date = todayIstDateStr();

  const vix = await fetchNseVix();
  if (!vix.close) throw new Error('VIX close missing from NSE payload');

  await IndiaVixDaily.findOneAndUpdate(
    { date },
    { date, ...vix, source: 'NSE_ALLINDICES', fetched_at: new Date() },
    { upsert: true, new: true }
  );

  console.log(`[JOB vix] date=${date} close=${vix.close} change=${vix.change_pct}%`);
  return { date, close: vix.close };
}

export default { runVixSnapshotJob };
