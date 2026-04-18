/**
 * Backfill FII/DII — N calendar days back using NSE historical endpoint.
 *
 * Usage: node src/scripts/backfillFiiFlow.js 500
 *
 * Note: NSE has changed this endpoint shape multiple times. If the URL below
 * returns 404 / HTML, try one of the alternates at the end of this file and
 * swap as needed.
 */

import InstitutionalFlowDaily from '../models/institutionalFlowDaily.js';
import mongoose from 'mongoose';

async function fetchRange(fromDate, toDate) {
  const url = `https://www.nseindia.com/api/historicalOR/foDIIFIITradeRect?from=${fromDate}&to=${toDate}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://www.nseindia.com/',
  };
  await fetch('https://www.nseindia.com/', { headers });
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`NSE historical HTTP ${res.status}`);
  return res.json();
}

function fmtDate(d) {
  // DD-MM-YYYY for NSE query string
  const iso = d.toISOString().slice(0, 10);
  return iso.split('-').reverse().join('-');
}

function num(v) {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const daysBack = Number(process.argv[2] || 500);
  await mongoose.connect(process.env.MONGO_URI);

  const to = new Date();
  const from = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
  const payload = await fetchRange(fmtDate(from), fmtDate(to));

  const rows = Array.isArray(payload) ? payload : (payload?.data || []);
  let count = 0;
  for (const r of rows) {
    const rawDate = r.date || r.DATE || r.reportDate || '';
    // Accept DD-MM-YYYY, YYYY-MM-DD, or ISO
    let date;
    if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
      date = rawDate.slice(0, 10);
    } else if (/^\d{2}-\d{2}-\d{4}/.test(rawDate)) {
      date = rawDate.split('-').reverse().join('-');
    } else {
      const d = new Date(rawDate);
      date = !isNaN(d) ? d.toISOString().slice(0, 10) : null;
    }
    if (!date) continue;

    const doc = {
      date,
      fii_net_cr: num(r.fiiNetValue ?? r.fii_net ?? r.FII ?? r.netBuySellFII),
      dii_net_cr: num(r.diiNetValue ?? r.dii_net ?? r.DII ?? r.netBuySellDII),
      source: 'BACKFILL_NSE',
    };
    if (typeof doc.fii_net_cr === 'number') {
      await InstitutionalFlowDaily.findOneAndUpdate({ date }, doc, { upsert: true });
      count++;
    }
  }
  console.log(`Backfilled ${count} FII/DII rows`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });

// Alternate URLs tried when the primary endpoint shape is stale:
//   https://www.nseindia.com/api/fiidiiTradeReact?reportType=fii_dii_report
//   https://www.nseindia.com/api/historical/fiidiiData?from=<from>&to=<to>
