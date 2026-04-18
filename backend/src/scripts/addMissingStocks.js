#!/usr/bin/env node
/**
 * addMissingStocks.js
 *
 * Fetches the live Upstox NSE instrument master, finds a given set of trading
 * symbols (or name fragments), confirms matches, and upserts them into the
 * Stock collection so the news scraper / pipeline can resolve them.
 *
 * Usage:
 *   node backend/src/scripts/addMissingStocks.js
 *
 * Add symbols to SYMBOLS_TO_ADD below and re-run whenever new stocks need
 * inserting without doing a full instrument sync.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import axios from 'axios';
import zlib from 'zlib';
import { promisify } from 'util';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../../.env') });

import Stock from '../models/stock.js';

const gunzip = promisify(zlib.gunzip);
const LOG = '[ADD-MISSING-STOCKS]';

// ─── Add trading symbols (or partial name fragments) here ─────────────────
// The script will search by exact trading_symbol first, then by name substring.
// Leave empty if you only need patches/deactivations below.
const SYMBOLS_TO_ADD = [];

// Also these name fragments as fallback if symbol lookup misses
const NAME_FRAGMENTS = [];
// ──────────────────────────────────────────────────────────────────────────

async function downloadNSEInstruments() {
  const url = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
  console.log(`${LOG} Downloading NSE instrument master from Upstox...`);
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  const decompressed = await gunzip(response.data);
  const all = JSON.parse(decompressed.toString());
  const equity = all.filter(i => i.segment === 'NSE_EQ');
  console.log(`${LOG} Downloaded: ${all.length} total, ${equity.length} NSE_EQ equity instruments`);
  return equity;
}

function formatForDb(i) {
  return {
    segment:        i.segment,
    name:           i.name || '',
    exchange:       i.exchange || 'NSE',
    isin:           i.isin || null,
    instrument_type: i.instrument_type || '',
    instrument_key: i.instrument_key,
    lot_size:       i.lot_size       || 1,
    freeze_quantity: i.freeze_quantity || null,
    exchange_token: i.exchange_token  || '',
    tick_size:      i.tick_size       || 0.05,
    trading_symbol: i.trading_symbol  || '',
    short_name:     i.short_name      || null,
    qty_multiplier: i.qty_multiplier  || 1,
    is_active:      true,
    last_updated:   new Date(),
  };
}

// ─── One-off short_name patches (instrument_key → alias) ──────────────────
// These fix cases where the AI guesses a different symbol than the DB's
// trading_symbol. Setting short_name lets fallback #3 in mapToCandidates
// catch the stock by the AI's guessed symbol.
const SHORT_NAME_PATCHES = {
  'NSE_EQ|INE045601023': 'PARASDEFENCE',  // PARAS → "Paras Def and Space Tech"
  'NSE_EQ|INE053A01029': 'IHCL',          // INDHOTEL → "Indian Hotels" (AI guesses IHCL)
};

// ─── Deactivate duplicate / non-equity entries ────────────────────────────
// NSE_EQ instrument keys that should be marked is_active=false.
// Use case: bond/NCD ISINs that share a trading_symbol with the equity — they
// cause API failures in getFnoUniverse() which returns ALL active NSE_EQ rows
// for a given trading_symbol, including these debt instruments.
//   CHOLAFIN NSE_EQ|INE121A08PJ0 — Cholamandalam NCD (ISIN prefix "08" = debt)
//   MOTHERSON NSE_EQ|INE775A08105 — Samvardhana Motherson NCD (debt)
const DEACTIVATE_KEYS = [
  'NSE_EQ|INE121A08PJ0',  // CHOLAFIN bond — causes API failures
  'NSE_EQ|INE775A08105',  // MOTHERSON bond — causes API failures
];
// ──────────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`${LOG} Connecting to MongoDB...`);
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`${LOG} Connected`);

  const instruments = await downloadNSEInstruments();

  // Build lookup maps
  const bySymbol = new Map(instruments.map(i => [i.trading_symbol?.toUpperCase(), i]));
  const byName   = instruments; // searched linearly by fragment

  const toUpsert = [];
  const tried = new Set();

  // 1. Exact symbol matches
  for (const sym of SYMBOLS_TO_ADD) {
    const up = sym.toUpperCase();
    if (tried.has(up)) continue;
    tried.add(up);
    const found = bySymbol.get(up);
    if (found) {
      console.log(`${LOG} ✅ Symbol match: ${up} → "${found.name}" (${found.instrument_key})`);
      toUpsert.push(formatForDb(found));
    } else {
      console.log(`${LOG} ⚠️  Symbol not found: ${up}`);
    }
  }

  // 2. Name-fragment fallback for anything not yet matched
  const foundSymbols = new Set(toUpsert.map(s => s.trading_symbol?.toUpperCase()));
  for (const frag of NAME_FRAGMENTS) {
    const fragUp = frag.toUpperCase();
    const matches = byName.filter(i =>
      i.name?.toUpperCase().includes(fragUp) &&
      !foundSymbols.has(i.trading_symbol?.toUpperCase())
    );
    if (matches.length === 0) {
      console.log(`${LOG} ⚠️  Name fragment "${frag}": no matches`);
    } else if (matches.length === 1) {
      const m = matches[0];
      console.log(`${LOG} ✅ Name fragment "${frag}" → "${m.trading_symbol}" — "${m.name}" (${m.instrument_key})`);
      toUpsert.push(formatForDb(m));
      foundSymbols.add(m.trading_symbol?.toUpperCase());
    } else {
      console.log(`${LOG} ℹ️  Name fragment "${frag}": ${matches.length} matches:`);
      matches.forEach(m => console.log(`      ${m.trading_symbol} — "${m.name}" (${m.instrument_key})`));
      console.log(`${LOG}    → Taking first match: ${matches[0].trading_symbol}`);
      const m = matches[0];
      toUpsert.push(formatForDb(m));
      foundSymbols.add(m.trading_symbol?.toUpperCase());
    }
  }

  const hasPatchWork = Object.keys(SHORT_NAME_PATCHES).length > 0 || DEACTIVATE_KEYS.length > 0;
  if (toUpsert.length === 0 && !hasPatchWork) {
    console.log(`${LOG} Nothing to upsert and no patches/deactivations pending. Done.`);
    await mongoose.disconnect();
    return;
  }
  if (toUpsert.length === 0) {
    console.log(`${LOG} Nothing to upsert (SYMBOLS_TO_ADD empty) — proceeding to patches/deactivations.`);
  }

  // Deduplicate by instrument_key
  const seen = new Set();
  const deduped = toUpsert.filter(s => {
    if (seen.has(s.instrument_key)) return false;
    seen.add(s.instrument_key);
    return true;
  });

  console.log(`\n${LOG} Upserting ${deduped.length} stock(s) into DB:`);
  for (const s of deduped) {
    const res = await Stock.updateOne(
      { instrument_key: s.instrument_key },
      { $set: s },
      { upsert: true }
    );
    const action = res.upsertedCount > 0 ? 'INSERTED' : 'UPDATED';
    console.log(`  ${action}: ${s.trading_symbol} — "${s.name}" (key=${s.instrument_key}, isin=${s.isin})`);
  }

  // Apply short_name patches
  if (Object.keys(SHORT_NAME_PATCHES).length > 0) {
    console.log(`\n${LOG} Applying short_name patches...`);
    for (const [key, alias] of Object.entries(SHORT_NAME_PATCHES)) {
      const r = await Stock.updateOne(
        { instrument_key: key },
        { $set: { short_name: alias, last_updated: new Date() } }
      );
      if (r.matchedCount === 0) {
        console.log(`  ⚠️  NOT FOUND in DB: ${key} — skipped`);
      } else {
        const doc = await Stock.findOne({ instrument_key: key })
          .select('trading_symbol name short_name isin').lean();
        console.log(`  ✅ Patched ${doc.trading_symbol} → short_name="${alias}" (${doc.name})`);
      }
    }
  }

  // Deactivate non-equity / duplicate entries
  if (DEACTIVATE_KEYS.length > 0) {
    console.log(`\n${LOG} Deactivating ${DEACTIVATE_KEYS.length} bond/duplicate key(s)...`);
    for (const key of DEACTIVATE_KEYS) {
      const r = await Stock.updateOne(
        { instrument_key: key },
        { $set: { is_active: false, last_updated: new Date() } }
      );
      if (r.matchedCount === 0) {
        console.log(`  ⚠️  NOT FOUND in DB: ${key} — skipped`);
      } else {
        const doc = await Stock.findOne({ instrument_key: key })
          .select('trading_symbol name instrument_key is_active').lean();
        console.log(`  ✅ Deactivated ${doc.trading_symbol} key=${key} (${doc.name}) — is_active=false`);
      }
    }
  }

  console.log(`\n${LOG} ✅ Done.`);

  await mongoose.disconnect();
  console.log(`${LOG} Disconnected`);
}

run().catch(err => {
  console.error(`${LOG} Fatal:`, err);
  process.exit(1);
});
