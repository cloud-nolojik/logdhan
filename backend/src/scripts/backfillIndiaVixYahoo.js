/**
 * Backfill India VIX from Yahoo Finance.
 *
 * Pulls ~2 years of daily OHLC for ^INDIAVIX via Yahoo's public chart API.
 * Upserts each row into india_vix_daily, same shape the NSE-CSV backfill uses.
 *
 * No CSV download needed — just run:
 *
 *   node src/scripts/backfillIndiaVixYahoo.js          (default: 730 days)
 *   node src/scripts/backfillIndiaVixYahoo.js 1095     (3 years)
 *
 * After it finishes, india_vix_daily will have enough history for
 * fetchVixData() to compute a percentile rank (needs ≥ 30 rows minimum;
 * 252 rows for a proper 1-year rolling percentile).
 */

import '../loadEnv.js';
import mongoose from 'mongoose';
import IndiaVixDaily from '../models/indiaVixDaily.js';

const LOG = '[backfill vix/yahoo]';
const YAHOO_SYMBOL = '%5EINDIAVIX';  // URL-encoded ^INDIAVIX

function pad(n) { return String(n).padStart(2, '0'); }

function ymdFromEpochSec(s) {
  const d = new Date(s * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

async function fetchYahooChart(daysBack) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - (daysBack * 86400);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${YAHOO_SYMBOL}?period1=${from}&period2=${now}&interval=1d&includePrePost=false&events=div,splits`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();

  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo: no chart result');

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const open  = q.open?.[i];
    const high  = q.high?.[i];
    const low   = q.low?.[i];
    const close = q.close?.[i];
    if (typeof close !== 'number' || !Number.isFinite(close)) continue;
    rows.push({
      date: ymdFromEpochSec(ts[i]),
      open:  typeof open  === 'number' ? open  : null,
      high:  typeof high  === 'number' ? high  : null,
      low:   typeof low   === 'number' ? low   : null,
      close,
    });
  }
  return rows;
}

async function main() {
  const daysBack = Number(process.argv[2] || 730);
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) { console.error(`${LOG} MONGODB_URI not set`); process.exit(1); }

  console.log(`${LOG} fetching last ${daysBack} days of ^INDIAVIX from Yahoo...`);
  const rows = await fetchYahooChart(daysBack);
  console.log(`${LOG} got ${rows.length} rows`);
  if (rows.length === 0) {
    console.error(`${LOG} no data returned — aborting`);
    process.exit(1);
  }

  await mongoose.connect(uri);
  let upserts = 0;
  // Walk rows in order so prev_close chains are natural
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = rows[i - 1];
    const doc = {
      date: r.date,
      open: r.open, high: r.high, low: r.low, close: r.close,
      prev_close: prev?.close ?? null,
      change_pct: prev?.close ? ((r.close - prev.close) / prev.close) * 100 : null,
      source: 'YAHOO_BACKFILL',
      fetched_at: new Date(),
    };
    await IndiaVixDaily.findOneAndUpdate({ date: r.date }, doc, { upsert: true });
    upserts++;
  }
  console.log(`${LOG} ✅ upserted ${upserts} rows into india_vix_daily`);
  console.log(`${LOG} latest: ${rows[rows.length - 1].date} close=${rows[rows.length - 1].close}`);
  console.log(`${LOG} earliest: ${rows[0].date} close=${rows[0].close}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
