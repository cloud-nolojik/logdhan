/**
 * Earnings & Corporate Event Filter
 *
 * Checks NSE corporate announcements for upcoming board meetings / results
 * that could cause unpredictable gaps and invalidate technical setups.
 *
 * Stocks with earnings in the next 4 days are flagged for removal from daily picks.
 *
 * Data source: NSE India corporate events calendar
 * Fallback: lightweight ChartInk corporate action flag (if available in scan data)
 */

import { round2 } from './dailyPicksHelpers.js';

const LOG = '[EARNINGS-FILTER]';

// Cache earnings data for the day (refreshed on first call each day)
let earningsCache = {
  date: null,       // YYYY-MM-DD
  symbols: new Set(), // Symbols with upcoming earnings/events
  lastFetched: 0
};

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const EARNINGS_LOOKAHEAD_DAYS = 4;         // Block stocks with events in next 4 days (earnings announced early can cause gaps)

/**
 * Fetch upcoming corporate events from NSE.
 * NSE exposes board meeting data for result announcements.
 * Uses a best-effort approach — if NSE is unreachable, returns empty (fail-open).
 */
async function fetchUpcomingEarnings() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // Return cached data if still fresh
  if (earningsCache.date === today && (Date.now() - earningsCache.lastFetched) < CACHE_TTL_MS) {
    const ageMin = Math.round((Date.now() - earningsCache.lastFetched) / 60000);
    console.log(`${LOG} Cache hit — ${earningsCache.symbols.size} symbols, age=${ageMin}min (TTL=${CACHE_TTL_MS / 3600000}h)`);
    return earningsCache.symbols;
  }

  console.log(`${LOG} Fetching upcoming corporate events from NSE...`);

  try {
    // NSE Board Meetings API — returns upcoming board meeting dates
    // Format: https://www.nseindia.com/api/corporate-board-meetings?index=equities
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch('https://www.nseindia.com/api/corporate-board-meetings?index=equities', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.nseindia.com/companies-listing/corporate-filings-board-meetings'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`${LOG} NSE API returned ${response.status} — using empty filter`);
      earningsCache = { date: today, symbols: new Set(), lastFetched: Date.now() };
      return earningsCache.symbols;
    }

    const data = await response.json();
    const events = Array.isArray(data) ? data : [];

    // Parse events and find stocks with results in next EARNINGS_LOOKAHEAD_DAYS
    const earningsSymbols = new Set();
    const cutoffDate = new Date(now.getTime() + EARNINGS_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

    for (const event of events) {
      try {
        const meetingDate = new Date(event.bm_date || event.meetingDate || event.date);
        const symbol = event.symbol || event.bm_symbol || '';
        const purpose = (event.bm_purpose || event.purpose || '').toLowerCase();

        // Only filter for results/earnings announcements, not routine meetings
        const isEarnings = purpose.includes('result') ||
                          purpose.includes('financial') ||
                          purpose.includes('quarterly') ||
                          purpose.includes('annual') ||
                          purpose.includes('dividend');

        if (isEarnings && meetingDate >= now && meetingDate <= cutoffDate && symbol) {
          earningsSymbols.add(symbol.toUpperCase());
        }
      } catch (_) { /* skip malformed entries */ }
    }

    earningsCache = { date: today, symbols: earningsSymbols, lastFetched: Date.now() };
    console.log(`${LOG} Found ${earningsSymbols.size} stocks with upcoming earnings/events: ${[...earningsSymbols].slice(0, 20).join(', ')}${earningsSymbols.size > 20 ? '...' : ''}`);

    return earningsSymbols;

  } catch (err) {
    console.warn(`${LOG} NSE fetch failed (${err.message}) — using empty filter (fail-open)`);
    earningsCache = { date: today, symbols: new Set(), lastFetched: Date.now() };
    return earningsCache.symbols;
  }
}

/**
 * Filter candidates, removing those with upcoming earnings.
 * Returns { filtered: [...kept], removed: [...removed] }
 *
 * Call this BEFORE scoring — removes candidates early in the pipeline.
 */
async function filterEarningsStocks(candidates) {
  console.log(`${LOG} ═══════════════════════════════════════`);
  console.log(`${LOG} Filtering ${candidates.length} candidates (lookahead=${EARNINGS_LOOKAHEAD_DAYS} days)`);

  if (candidates.length === 0) return { filtered: candidates, removed: [] };

  const earningsSymbols = await fetchUpcomingEarnings();

  if (earningsSymbols.size === 0) {
    console.log(`${LOG} No earnings data available — all ${candidates.length} candidates pass (fail-open)`);
    console.log(`${LOG} ═══════════════════════════════════════`);
    return { filtered: candidates, removed: [] };
  }

  console.log(`${LOG} Checking against ${earningsSymbols.size} upcoming earnings symbols`);

  const filtered = [];
  const removed = [];

  for (const candidate of candidates) {
    if (earningsSymbols.has(candidate.symbol)) {
      removed.push(candidate);
      console.log(`${LOG} ⛔ ${candidate.symbol} (${candidate.direction} ${candidate.scan_type}): REMOVED — earnings within ${EARNINGS_LOOKAHEAD_DAYS} days`);
    } else {
      filtered.push(candidate);
    }
  }

  console.log(`${LOG} Result: ${removed.length} removed, ${filtered.length} remaining`);
  if (removed.length > 0) {
    console.log(`${LOG} Removed: ${removed.map(r => r.symbol).join(', ')}`);
  }
  console.log(`${LOG} ═══════════════════════════════════════`);

  return { filtered, removed };
}

/**
 * Check if a single symbol has upcoming earnings
 */
async function hasUpcomingEarnings(symbol) {
  const earningsSymbols = await fetchUpcomingEarnings();
  return earningsSymbols.has(symbol.toUpperCase());
}

export { filterEarningsStocks, hasUpcomingEarnings, fetchUpcomingEarnings };

export default { filterEarningsStocks, hasUpcomingEarnings, fetchUpcomingEarnings };
