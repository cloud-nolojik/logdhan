/**
 * FII/DII — daily forward accumulator.
 *
 * Usage: node src/scripts/backfillFiiFlow.js [days_ignored]
 *
 * NSE retired its historical FII/DII range endpoint (foDIIFIITradeRect)
 * sometime before May 2026 — it now returns 404. The only working public
 * endpoint is `fiidiiTradeReact?reportType=fii_dii_report` which returns
 * the LATEST trading day only (2 rows: one for FII/FPI, one for DII).
 *
 * This script therefore upserts today's row and exits. Schedule it nightly
 * (post-market close) via cron to accumulate forward. The `days` argv is
 * accepted but ignored — kept so backfillAll.js's call signature still works.
 *
 * To fill historical days, see BACKTEST_PLAN.md options (PDF parsing or
 * third-party scrape). The regime engine handles missing FII rows by
 * treating the input as null, which contributes 0 to the composite score.
 *
 * Exit codes:
 *   0 — row upserted, OR endpoint returned no rows / changed shape (soft fail
 *       so backfillAll.js continues to the breadth step).
 *   1 — Mongo connect failure (genuinely cannot proceed).
 */

import '../loadEnv.js';
import InstitutionalFlowDaily from '../models/institutionalFlowDaily.js';
import mongoose from 'mongoose';

const LOG = '[backfill fii]';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

async function fetchLatest() {
  const headers = {
    'User-Agent': UA,
    'Accept': 'application/json',
    'Referer': 'https://www.nseindia.com/',
  };
  // Prime cookies (NSE blocks API calls without a prior homepage visit).
  await fetch('https://www.nseindia.com/', { headers });
  const url = 'https://www.nseindia.com/api/fiidiiTradeReact?reportType=fii_dii_report';
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`NSE fiidiiTradeReact HTTP ${res.status}`);
  return res.json();
}

function num(v) {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Convert NSE's "22-May-2026" → "2026-05-22".
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                 Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
function parseNseDate(s) {
  if (!s) return null;
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (m && MONTHS[m[2]]) return `${m[3]}-${MONTHS[m[2]]}-${m[1]}`;
  // Fallback: native parse handles ISO / RFC strings.
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error(`${LOG} MONGODB_URI not set`); process.exit(1); }
  await mongoose.connect(uri);

  let payload;
  try {
    payload = await fetchLatest();
  } catch (err) {
    console.warn(`${LOG} fetch failed: ${err.message} — skipping (soft fail)`);
    await mongoose.disconnect();
    return; // exit 0
  }

  const rows = Array.isArray(payload) ? payload : (payload?.data || []);
  if (rows.length === 0) {
    console.warn(`${LOG} endpoint returned 0 rows — skipping (soft fail)`);
    await mongoose.disconnect();
    return;
  }

  // Group the FII row and DII row by date. Endpoint returns one row per
  // category per date (today only). category values: "FII/FPI" and "DII".
  const byDate = new Map();
  for (const r of rows) {
    const date = parseNseDate(r.date);
    if (!date) continue;
    const cat = (r.category || '').toUpperCase();
    const net = num(r.netValue);
    if (net === null) continue;
    const entry = byDate.get(date) || { date };
    if (cat.includes('FII') || cat.includes('FPI')) entry.fii_net_cr = net;
    else if (cat.includes('DII')) entry.dii_net_cr = net;
    byDate.set(date, entry);
  }

  let count = 0;
  for (const entry of byDate.values()) {
    if (typeof entry.fii_net_cr !== 'number' && typeof entry.dii_net_cr !== 'number') continue;
    const doc = { ...entry, source: 'NSE_FIIDII' };
    await InstitutionalFlowDaily.findOneAndUpdate({ date: entry.date }, doc, { upsert: true });
    count++;
    console.log(`${LOG} ${entry.date} FII=${entry.fii_net_cr ?? 'n/a'} DII=${entry.dii_net_cr ?? 'n/a'}`);
  }
  console.log(`${LOG} upserted ${count} row${count === 1 ? '' : 's'}`);
  await mongoose.disconnect();
}

main().catch(async err => {
  console.error(`${LOG} unexpected error: ${err.message}`);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
