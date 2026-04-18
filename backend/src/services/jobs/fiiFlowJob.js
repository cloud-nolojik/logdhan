/**
 * FII/DII Flow Snapshot Job
 *
 * Schedule: 19:00 IST daily (NSE publishes around 18:30 IST)
 *
 * Fetches prev-day FII/DII cash segment net values from NSE.
 */

import InstitutionalFlowDaily from '../../models/institutionalFlowDaily.js';

const NSE_FIIDII_URL = 'https://www.nseindia.com/api/fiidiiTradeReact';

function todayIstDateStr() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  return new Date(istMs).toISOString().slice(0, 10);
}

async function fetchNseFiiDii() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.nseindia.com/',
  };
  await fetch('https://www.nseindia.com/', { headers, signal: AbortSignal.timeout(8000) });
  const res = await fetch(NSE_FIIDII_URL, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`NSE fiidii HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('NSE fiidii: unexpected shape');

  const num = (v) => {
    if (typeof v === 'number') return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const pickRow = (category) => arr.find(r =>
    (r.category || '').toUpperCase().includes(category.toUpperCase())
  );
  const fii = pickRow('FII') || pickRow('FPI');
  const dii = pickRow('DII');

  return {
    fii_net_cr: fii ? num(fii.netValue) : null,
    dii_net_cr: dii ? num(dii.netValue) : null,
    fii_gross_buy_cr: fii ? num(fii.buyValue) : null,
    fii_gross_sell_cr: fii ? num(fii.sellValue) : null,
    dii_gross_buy_cr: dii ? num(dii.buyValue) : null,
    dii_gross_sell_cr: dii ? num(dii.sellValue) : null,
  };
}

export async function runFiiFlowJob() {
  console.log('[JOB fiiflow] starting');
  const date = todayIstDateStr();
  const flow = await fetchNseFiiDii();
  if (typeof flow.fii_net_cr !== 'number') throw new Error('FII net missing');

  await InstitutionalFlowDaily.findOneAndUpdate(
    { date },
    { date, ...flow, source: 'NSE_FIIDII', fetched_at: new Date() },
    { upsert: true, new: true }
  );

  console.log(`[JOB fiiflow] date=${date} FII=${flow.fii_net_cr}cr DII=${flow.dii_net_cr}cr`);
  return { date, ...flow };
}

export default { runFiiFlowJob };
