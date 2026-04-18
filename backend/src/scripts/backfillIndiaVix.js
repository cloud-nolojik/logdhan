/**
 * Backfill India VIX — 24 months from historical CSV.
 *
 * NSE does not expose a long-history API easily. Download the historical
 * CSV from https://www.niftyindices.com/reports/historical-data
 * (choose INDIAVIX, 2 years), save it, then run:
 *
 *   node src/scripts/backfillIndiaVix.js <path-to-csv>
 */

import '../loadEnv.js';
import fs from 'fs';
import IndiaVixDaily from '../models/indiaVixDaily.js';
import mongoose from 'mongoose';

function parseIstDate(s) {
  // NSE CSV typically uses "DD-MMM-YYYY" or "DD-MM-YYYY". Normalize to ISO.
  const tryIso = new Date(s);
  if (!isNaN(tryIso)) return tryIso.toISOString().slice(0, 10);
  const m = s.match(/^(\d{2})-(\w{3})-(\d{4})$/);
  if (m) {
    const months = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
    return `${m[3]}-${months[m[2]]}-${m[1]}`;
  }
  return null;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error('Usage: node src/scripts/backfillIndiaVix.js <csv-path>');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

  const raw = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
  const header = raw.shift().split(',').map(h => h.trim().toUpperCase());
  const idx = {
    date: header.findIndex(h => h.includes('DATE')),
    open: header.findIndex(h => h === 'OPEN'),
    high: header.findIndex(h => h === 'HIGH'),
    low:  header.findIndex(h => h === 'LOW'),
    close: header.findIndex(h => h === 'CLOSE'),
    prev:  header.findIndex(h => h.includes('PREV')),
  };

  let count = 0;
  for (const line of raw) {
    const cols = line.split(',').map(c => c.trim());
    const date = parseIstDate(cols[idx.date]);
    if (!date) continue;
    const doc = {
      date,
      open:  Number(cols[idx.open])  || null,
      high:  Number(cols[idx.high])  || null,
      low:   Number(cols[idx.low])   || null,
      close: Number(cols[idx.close]) || null,
      prev_close: idx.prev >= 0 ? (Number(cols[idx.prev]) || null) : null,
      source: 'BACKFILL_CSV',
    };
    if (doc.close) {
      await IndiaVixDaily.findOneAndUpdate({ date }, doc, { upsert: true });
      count++;
    }
  }
  console.log(`Backfilled ${count} VIX rows`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
