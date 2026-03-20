#!/usr/bin/env node
/**
 * Build Sector Mapping from NSE Index Constituents
 *
 * Fetches the official constituent list for every relevant Nifty sector index from NSE India.
 * No keyword guessing — every mapping comes from direct index membership.
 * Writes the result to backend/src/data/sectorMap.json — a simple { SYMBOL: SECTOR_CODE } map.
 *
 * sectorMapping.js reads this file at import time and uses it for getSectorForStock().
 *
 * Usage:
 *   node backend/src/scripts/buildSectorMapping.js
 *
 * Run periodically (weekly) or after major index reconstitutions.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG = '[BUILD-SECTOR-MAP]';
const OUTPUT_PATH = path.resolve(__dirname, '../data/sectorMap.json');

// ── Sector indices: each index maps directly to a sector code ──
// Order matters — first index wins for a given stock.
// More specific indices listed before broader ones within the same sector.
// ── CORE sector indices only ──
// These are the SAME indices used by sectorRegime.js to determine bullish/bearish per sector.
// A stock mapped to ENERGY must come from Nifty Energy — not from a thematic index like Nifty Rural.
// Thematic/broad indices (CONSUMPTION, RURAL, MOBILITY) mix sectors and cause misclassifications.
const SECTOR_INDICES = [
  // BANKING
  { index: 'NIFTY BANK',                          sector: 'BANKING' },
  { index: 'NIFTY PSU BANK',                      sector: 'BANKING' },
  { index: 'NIFTY PRIVATE BANK',                  sector: 'BANKING' },
  // FINSERVICES
  { index: 'NIFTY FINANCIAL SERVICES',             sector: 'FINSERVICES' },
  { index: 'NIFTY FINANCIAL SERVICES EX-BANK',     sector: 'FINSERVICES' },
  { index: 'NIFTY CAPITAL MARKETS',                sector: 'FINSERVICES' },
  { index: 'NIFTY MIDSMALL FINANCIAL SERVICES',    sector: 'FINSERVICES' },
  // TECH
  { index: 'NIFTY IT',                             sector: 'TECH' },
  { index: 'NIFTY MIDSMALL IT & TELECOM',          sector: 'TECH' },
  // PHARMA
  { index: 'NIFTY PHARMA',                         sector: 'PHARMA' },
  { index: 'NIFTY HEALTHCARE INDEX',               sector: 'PHARMA' },
  { index: 'NIFTY MIDSMALL HEALTHCARE',            sector: 'PHARMA' },
  // FMCG
  { index: 'NIFTY FMCG',                           sector: 'FMCG' },
  { index: 'NIFTY CONSUMER DURABLES',              sector: 'FMCG' },
  // AUTO
  { index: 'NIFTY AUTO',                           sector: 'AUTO' },
  // METALS
  { index: 'NIFTY METAL',                          sector: 'METALS' },
  // REALTY
  { index: 'NIFTY REALTY',                         sector: 'REALTY' },
  // ENERGY
  { index: 'NIFTY ENERGY',                         sector: 'ENERGY' },
  { index: 'NIFTY OIL AND GAS',                    sector: 'ENERGY' },
  // DEFENSE
  { index: 'NIFTY IND DEFENCE',                    sector: 'DEFENSE' },
  // TELECOM
  { index: 'NIFTY MEDIA',                          sector: 'TELECOM' },
  // INDUSTRIAL
  { index: 'NIFTY INFRASTRUCTURE',                 sector: 'INDUSTRIAL' },
  { index: 'NIFTY INDIA MFG',                      sector: 'INDUSTRIAL' },
  // TRANSPORT
  { index: 'NIFTY TRANSPORTATION & LOGISTICS',     sector: 'TRANSPORT' },
  // COMMODITIES
  { index: 'NIFTY COMMODITIES',                    sector: 'COMMODITIES' },
];

// Manual overrides for known misclassifications from NSE index membership
const OVERRIDES = {
  'LT':           'INDUSTRIAL',
  'LTIM':         'TECH',
  'ABB':          'INDUSTRIAL',
  'SIEMENS':      'INDUSTRIAL',
  'BHEL':         'INDUSTRIAL',
  'CUMMINSIND':   'INDUSTRIAL',
  'THERMAX':      'INDUSTRIAL',
  'KEC':          'INDUSTRIAL',
  'ADANIENT':     'INDUSTRIAL',
  'HAVELLS':      'INDUSTRIAL',
  'VOLTAS':       'INDUSTRIAL',
  'CROMPTON':     'INDUSTRIAL',
  'BLUESTARCO':   'INDUSTRIAL',
  'DIXON':        'INDUSTRIAL',
  'KAJARIACER':   'CEMENT',
  'CENTURYPLY':   'CEMENT',
  'BHARTIARTL':   'TELECOM',
  'TITAN':        'FMCG',
  'RELIANCE':     'ENERGY',
};

// NSE industry string → our sector code (for broad/mixed indices where sector is null)
const INDUSTRY_TO_SECTOR = {
  // Banking
  'Private Sector Bank': 'BANKING', 'Public Sector Bank': 'BANKING', 'Other Bank': 'BANKING',
  'Non Banking Financial Company (NBFC)': 'BANKING', 'Housing Finance Company': 'BANKING',
  'Microfinance Institutions': 'BANKING',
  // Finservices
  'Life Insurance': 'FINSERVICES', 'General Insurance': 'FINSERVICES',
  'Asset Management Company': 'FINSERVICES', 'Financial Institution': 'FINSERVICES',
  'Stockbroking & Allied': 'FINSERVICES', 'Investment Company': 'FINSERVICES',
  'Exchange and Data Platform': 'FINSERVICES', 'Financial Technology (Fintech)': 'FINSERVICES',
  'Depositories Clearing Houses and Other Intermediaries': 'FINSERVICES',
  'Financial Products Distributor': 'FINSERVICES', 'Other Financial Services': 'FINSERVICES',
  // Tech
  'Computers - Software & Consulting': 'TECH', 'IT Enabled Services': 'TECH',
  'Software Products': 'TECH', 'Business Process Outsourcing (BPO)/ Knowledge Process Outsourcing (KPO)': 'TECH',
  'E-Retail/ E-Commerce': 'TECH', 'Internet & Catalogue Retail': 'TECH',
  'Digital Entertainment': 'TECH',
  // Pharma
  'Pharmaceuticals': 'PHARMA', 'Hospital': 'PHARMA', 'Biotechnology': 'PHARMA',
  'Healthcare Service Provider': 'PHARMA', 'Healthcare Research Analytics & Technology': 'PHARMA',
  'Medical Equipment & Supplies': 'PHARMA', 'Pharmacy Retail': 'PHARMA',
  // FMCG
  'Packaged Foods': 'FMCG', 'Personal Care': 'FMCG', 'Household Products': 'FMCG',
  'Edible Oil': 'FMCG', 'Dairy Products': 'FMCG', 'Tea & Coffee': 'FMCG',
  'Breweries & Distilleries': 'FMCG', 'Other Beverages': 'FMCG',
  'Cigarettes & Tobacco Products': 'FMCG', 'Diversified FMCG': 'FMCG',
  'Other Food Products': 'FMCG', 'Animal Feed': 'FMCG', 'Sugar': 'FMCG',
  'Footwear': 'FMCG', 'Garments & Apparels': 'FMCG',
  'Gems Jewellery And Watches': 'FMCG', 'Paints': 'FMCG',
  'Speciality Retail': 'FMCG', 'Diversified Retail': 'FMCG',
  'Houseware': 'FMCG', 'Sanitary Ware': 'FMCG',
  'Furniture Home Furnishing': 'FMCG', 'Stationary': 'FMCG',
  'Household Appliances': 'FMCG', 'Consumer Electronics': 'FMCG',
  // Auto
  'Auto Components & Equipments': 'AUTO', 'Passenger Cars & Utility Vehicles': 'AUTO',
  '2/3 Wheelers': 'AUTO', 'Commercial Vehicles': 'AUTO',
  'Construction Vehicles': 'AUTO', 'Tractors': 'AUTO',
  'Tyres & Rubber Products': 'AUTO',
  // Metals
  'Iron & Steel Products': 'METALS', 'Iron & Steel': 'METALS',
  'Aluminium': 'METALS', 'Copper': 'METALS', 'Zinc': 'METALS',
  'Ferro & Silica Manganese': 'METALS', 'Diversified Metals': 'METALS',
  'Industrial Minerals': 'METALS', 'Castings & Forgings': 'METALS',
  'Trading - Minerals': 'METALS', 'Trading - Metals': 'METALS',
  // Realty
  'Residential Commercial Projects': 'REALTY',
  // Energy
  'Power Generation': 'ENERGY', 'Integrated Power Utilities': 'ENERGY',
  'Power Distribution': 'ENERGY', 'Power - Transmission': 'ENERGY', 'Power Trading': 'ENERGY',
  'Oil Exploration & Production': 'ENERGY', 'Refineries & Marketing': 'ENERGY',
  'Oil Storage & Transportation': 'ENERGY', 'Trading - Gas': 'ENERGY',
  'LPG/CNG/PNG/LNG Supplier': 'ENERGY', 'Gas Transmission/Marketing': 'ENERGY',
  'Coal': 'ENERGY', 'Petrochemicals': 'ENERGY',
  // Chemicals
  'Specialty Chemicals': 'CHEMICALS', 'Commodity Chemicals': 'CHEMICALS',
  'Pesticides & Agrochemicals': 'CHEMICALS', 'Fertilizers': 'CHEMICALS',
  'Dyes And Pigments': 'CHEMICALS', 'Carbon Black': 'CHEMICALS',
  'Industrial Gases': 'CHEMICALS', 'Explosives': 'CHEMICALS',
  // Cement
  'Cement & Cement Products': 'CEMENT', 'Plywood Boards/ Laminates': 'CEMENT',
  'Ceramics': 'CEMENT', 'Glass - Industrial': 'CEMENT',
  // Defense
  'Aerospace & Defense': 'DEFENSE', 'Ship Building & Allied Services': 'DEFENSE',
  // Transport
  'Logistics Solution Provider': 'TRANSPORT', 'Shipping': 'TRANSPORT',
  'Railway Wagons': 'TRANSPORT', 'Airline': 'TRANSPORT',
  'Port & Port services': 'TRANSPORT', 'Airport & Airport services': 'TRANSPORT',
  'Tour Travel Related Services': 'TRANSPORT', 'Hotels & Resorts': 'TRANSPORT',
  'Restaurants': 'TRANSPORT', 'Amusement Parks/ Other Recreation': 'TRANSPORT',
  'Transport Related Services': 'TRANSPORT',
  // Telecom
  'Telecom - Cellular & Fixed line services': 'TELECOM',
  'Telecom - Equipment & Accessories': 'TELECOM',
  'Telecom - Infrastructure': 'TELECOM', 'Other Telecom Services': 'TELECOM',
  'Media & Entertainment': 'TELECOM', 'TV Broadcasting & Software Production': 'TELECOM',
  'Film Production Distribution & Exhibition': 'TELECOM', 'Print Media': 'TELECOM',
  // Industrial
  'Heavy Electrical Equipment': 'INDUSTRIAL', 'Other Electrical Equipment': 'INDUSTRIAL',
  'Cables - Electricals': 'INDUSTRIAL', 'Compressors Pumps & Diesel Engines': 'INDUSTRIAL',
  'Industrial Products': 'INDUSTRIAL', 'Other Industrial Products': 'INDUSTRIAL',
  'Civil Construction': 'INDUSTRIAL', 'Abrasives & Bearings': 'INDUSTRIAL',
  'Electrodes & Refractories': 'INDUSTRIAL', 'Plastic Products - Industrial': 'INDUSTRIAL',
  'Plastic Products - Consumer': 'INDUSTRIAL', 'Packaging': 'INDUSTRIAL',
  'Paper & Paper Products': 'INDUSTRIAL', 'Other Textile Products': 'INDUSTRIAL',
  'Diversified Commercial Services': 'INDUSTRIAL', 'Water Supply & Management': 'INDUSTRIAL',
  'Lubricants': 'INDUSTRIAL', 'Other Agricultural Products': 'INDUSTRIAL',
  // Catchall
  'Holding Company': 'INDUSTRIAL', 'Diversified': 'INDUSTRIAL',
};

const DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 15000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchIndexConstituents(indexName) {
  const encodedIndex = encodeURIComponent(indexName);
  const url = `https://www.nseindia.com/api/equity-stockIndices?index=${encodedIndex}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.nseindia.com/market-data/live-equity-market'
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`${LOG} ${indexName}: HTTP ${response.status}`);
      return [];
    }

    const data = await response.json();
    if (!data.data || !Array.isArray(data.data)) {
      console.warn(`${LOG} ${indexName}: no data array in response`);
      return [];
    }

    return data.data.filter(d => d.symbol && !d.symbol.startsWith('NIFTY'));
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      console.error(`${LOG} ${indexName}: timeout after ${REQUEST_TIMEOUT_MS}ms`);
    } else {
      console.error(`${LOG} ${indexName}: ${err.message}`);
    }
    return [];
  }
}

async function main() {
  console.log(`${LOG} ═══════════════════════════════════════════════════`);
  console.log(`${LOG} Building sector mapping from NSE index constituents`);
  console.log(`${LOG} No keyword guessing — direct index membership only`);
  console.log(`${LOG} ═══════════════════════════════════════════════════`);

  const sectorMap = {};
  const industryData = {};

  // Step 1: Fetch all sector indices
  console.log(`${LOG} Fetching ${SECTOR_INDICES.length} indices...`);

  for (const { index: indexName, sector: sectorCode } of SECTOR_INDICES) {
    console.log(`${LOG} Fetching: ${indexName}${sectorCode ? ` → ${sectorCode}` : ' (mixed — use industry)'}...`);

    const constituents = await fetchIndexConstituents(indexName);
    let added = 0;

    for (const stock of constituents) {
      const symbol = stock.symbol;
      if (!symbol) continue;

      // Store industry for mixed-sector indices
      if (stock.meta?.industry) {
        industryData[symbol] = stock.meta.industry;
      }

      if (sectorMap[symbol]) continue; // first index wins

      if (sectorCode) {
        // Sector index — direct mapping
        sectorMap[symbol] = sectorCode;
        added++;
      } else {
        // Mixed index (MNC, IPO, etc.) — use industry string for exact mapping
        const industry = stock.meta?.industry;
        if (industry && INDUSTRY_TO_SECTOR[industry]) {
          sectorMap[symbol] = INDUSTRY_TO_SECTOR[industry];
          added++;
        }
      }
    }

    console.log(`${LOG} ${indexName}: ${constituents.length} stocks, ${added} new (total: ${Object.keys(sectorMap).length})`);
    await delay(DELAY_MS);
  }

  // Step 2: Fetch broad market indices for remaining stocks (using industry → sector)
  const BROAD_INDICES = [
    'NIFTY 50', 'NIFTY NEXT 50', 'NIFTY 100', 'NIFTY 200', 'NIFTY 500',
    'NIFTY TOTAL MKT',
    'NIFTY MIDCAP 150', 'NIFTY MIDCAP 100', 'NIFTY MIDCAP 50',
    'NIFTY SMLCAP 250', 'NIFTY SMLCAP 100', 'NIFTY SMLCAP 50',
    'NIFTY MICROCAP250',
    'NIFTY MIDSML 400', 'NIFTY LARGEMID250',
    'NIFTY IPO',
  ];

  console.log(`${LOG} ───────────────────────────────────────────────────`);
  console.log(`${LOG} Fetching ${BROAD_INDICES.length} broad indices for remaining stocks...`);
  let broadMapped = 0;

  for (const indexName of BROAD_INDICES) {
    const stocks = await fetchIndexConstituents(indexName);
    let mapped = 0;

    for (const stock of stocks) {
      const symbol = stock.symbol;
      if (!symbol) continue;

      if (stock.meta?.industry) {
        industryData[symbol] = stock.meta.industry;
      }

      if (sectorMap[symbol]) continue; // already mapped

      const industry = stock.meta?.industry;
      if (industry && INDUSTRY_TO_SECTOR[industry]) {
        sectorMap[symbol] = INDUSTRY_TO_SECTOR[industry];
        mapped++;
      }
    }

    broadMapped += mapped;
    console.log(`${LOG} ${indexName}: ${stocks.length} stocks, ${mapped} new (total: ${Object.keys(sectorMap).length})`);
    await delay(DELAY_MS);
  }

  console.log(`${LOG} ───────────────────────────────────────────────────`);
  console.log(`${LOG} Broad indices: ${broadMapped} additional stocks mapped`);

  // Step 3: Manual overrides
  let overrideCount = 0;
  for (const [symbol, sector] of Object.entries(OVERRIDES)) {
    if (sectorMap[symbol] && sectorMap[symbol] !== sector) {
      console.log(`${LOG} Override: ${symbol} ${sectorMap[symbol]} → ${sector}`);
      sectorMap[symbol] = sector;
      overrideCount++;
    } else if (!sectorMap[symbol]) {
      sectorMap[symbol] = sector;
      overrideCount++;
    }
  }
  console.log(`${LOG} Manual overrides: ${overrideCount} applied`);

  // Step 4: Log unmapped industries (for future INDUSTRY_TO_SECTOR additions)
  const unmappedIndustries = {};
  for (const [symbol, industry] of Object.entries(industryData)) {
    if (!sectorMap[symbol] && !INDUSTRY_TO_SECTOR[industry]) {
      unmappedIndustries[industry] = (unmappedIndustries[industry] || 0) + 1;
    }
  }
  if (Object.keys(unmappedIndustries).length > 0) {
    console.log(`${LOG} ───────────────────────────────────────────────────`);
    console.log(`${LOG} UNMAPPED INDUSTRIES (add to INDUSTRY_TO_SECTOR):`);
    Object.entries(unmappedIndustries).sort((a, b) => b[1] - a[1]).forEach(([ind, count]) => {
      console.log(`${LOG}   ${count}x  '${ind}'`);
    });
  }

  // Step 5: Summary
  console.log(`${LOG} ═══════════════════════════════════════════════════`);
  console.log(`${LOG} SECTOR DISTRIBUTION`);
  console.log(`${LOG} ───────────────────────────────────────────────────`);

  const sectorCounts = {};
  for (const sector of Object.values(sectorMap)) {
    sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;
  }

  Object.entries(sectorCounts).sort((a, b) => b[1] - a[1]).forEach(([sector, count]) => {
    console.log(`${LOG} ${sector.padEnd(14)} ${count} stocks`);
  });

  console.log(`${LOG} ───────────────────────────────────────────────────`);
  console.log(`${LOG} TOTAL: ${Object.keys(sectorMap).length} stocks mapped`);

  // Step 6: Write files
  const sorted = {};
  for (const key of Object.keys(sectorMap).sort()) {
    sorted[key] = sectorMap[key];
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`${LOG} Written to: ${OUTPUT_PATH}`);

  const industryPath = path.resolve(__dirname, '../data/sectorIndustry.json');
  const sortedIndustry = {};
  for (const key of Object.keys(industryData).sort()) {
    sortedIndustry[key] = industryData[key];
  }
  fs.writeFileSync(industryPath, JSON.stringify(sortedIndustry, null, 2) + '\n');
  console.log(`${LOG} Industry data written to: ${industryPath}`);

  console.log(`${LOG} ═══════════════════════════════════════════════════`);
  console.log(`${LOG} Done.`);
}

main().catch(err => {
  console.error(`${LOG} Fatal:`, err);
  process.exit(1);
});
