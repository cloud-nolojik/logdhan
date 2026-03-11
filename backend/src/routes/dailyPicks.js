/**
 * Daily Picks API Routes
 *
 * GET  /api/daily-picks/today       — Today's picks with live prices
 * GET  /api/daily-picks/history     — Recent daily pick results
 * GET  /api/daily-picks/review      — Candidate review table (admin)
 * POST /api/daily-picks/trigger-scan  — Manual scan trigger (admin/testing)
 * POST /api/daily-picks/trigger-entry — Manual entry trigger (admin/testing)
 * POST /api/daily-picks/trigger-exit  — Manual exit trigger (admin/testing)
 */

import express from 'express';
import { auth, adminAuth } from '../middleware/auth.js';
import DailyPick from '../models/dailyPick.js';
import { SCAN_LABELS } from '../services/dailyPicks/dailyPicksScans.js';
import { runDailyPicks, validateAndPlaceEntries, placePreMarketEntries } from '../services/dailyPicks/dailyPicksService.js';
import { runDailyExit } from '../services/dailyPicks/dailyPicksExitService.js';
import priceCacheService from '../services/priceCache.service.js';
import { getIstDayRange } from '../utils/tradingDay.js';

const router = express.Router();

// ─── Sanitize global intel text for mobile display ───────────────────────────
// Strips markdown links [text](url) and raw URLs so the mobile app shows
// clean, readable text. Full content is preserved (no truncation).

function cleanText(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // Strip markdown links: [text](url) → text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Strip raw URLs
    .replace(/https?:\/\/[^\s)]+/g, '')
    // Clean up leftover parentheses from stripped URLs
    .replace(/\(\s*\)/g, '')
    // Collapse multiple spaces
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeIntelForMobile(intel) {
  if (!intel) return intel;
  const cleaned = { ...intel };

  // Clean top-level text fields (strip URLs/markdown only, no truncation)
  cleaned.risk_reason = cleanText(cleaned.risk_reason);
  cleaned.recommendation_reason = cleanText(cleaned.recommendation_reason);

  // Clean global cues detail fields
  if (cleaned.global_cues) {
    cleaned.global_cues = {
      ...cleaned.global_cues,
      us_detail: cleanText(cleaned.global_cues.us_detail),
      indian_impact: cleanText(cleaned.global_cues.indian_impact),
      asian_detail: cleanText(cleaned.global_cues.asian_detail),
      rupee_impact: cleanText(cleaned.global_cues.rupee_impact),
      crude_indian_impact: cleanText(cleaned.global_cues.crude_indian_impact)
    };
  }

  // Clean major events
  if (cleaned.major_events && Array.isArray(cleaned.major_events)) {
    cleaned.major_events = cleaned.major_events.map(evt => ({
      ...evt,
      event: cleanText(evt.event),
      indian_impact: cleanText(evt.indian_impact)
    }));
  }

  return cleaned;
}

const ALLOWED_MOBILE = '919008108650';
const mobileAuth = (req, res, next) => {
  if (req.user?.mobileNumber !== ALLOWED_MOBILE) {
    return res.status(403).json({ success: false, error: 'Not authorized' });
  }
  next();
};

/**
 * GET /api/daily-picks/today
 * Returns today's DailyPick with live prices enriched.
 */
router.get('/today', auth, async (req, res) => {
  try {
    const today = getIstDayRange().startUtc;

    const doc = await DailyPick.findOne({ trading_date: today }).lean();

    if (!doc || !doc.picks || doc.picks.length === 0) {
      const emptyContext = { ...(doc?.market_context || {}) };
      if (doc?.global_intel) {
        emptyContext.global_intel = sanitizeIntelForMobile(doc.global_intel);
      }
      return res.json({
        success: true,
        data: {
          picks: [],
          market_context: emptyContext,
          message: 'No setups today'
        }
      });
    }

    // Get live prices for all picks with instrument keys
    const instrumentKeys = doc.picks
      .filter(p => p.instrument_key)
      .map(p => p.instrument_key);

    let livePrices = {};
    if (instrumentKeys.length > 0) {
      try {
        livePrices = await priceCacheService.getLatestPrices(instrumentKeys);
      } catch (err) {
        console.error('[DAILY-PICKS-API] Live price fetch failed:', err.message);
      }
    }

    // Enrich picks with live data
    const enrichedPicks = doc.picks.map((pick, index) => {
      const currentPrice = pick.instrument_key ? livePrices[pick.instrument_key] : null;
      const entryPrice = pick.trade?.entry_price || pick.levels?.entry;

      let currentReturnPct = null;
      if (currentPrice && entryPrice && pick.trade?.status === 'ENTERED') {
        const multiplier = pick.direction === 'LONG' ? 1 : -1;
        currentReturnPct = Math.round(((currentPrice - entryPrice) / entryPrice) * 100 * multiplier * 100) / 100;
      }

      return {
        rank: index + 1,
        symbol: pick.symbol,
        stock_name: pick.stock_name,
        scan_type: pick.scan_type,
        scan_type_label: SCAN_LABELS[pick.scan_type] || pick.scan_type,
        direction: pick.direction,
        rank_score: pick.rank_score,
        scan_scores: pick.scan_scores,
        levels: pick.levels,
        trade: {
          ...pick.trade,
          current_price: currentPrice,
          current_return_pct: currentReturnPct
        },
        kite_status: pick.kite?.kite_status,
        ai_insight: pick.ai_insight,
        validation: pick.validation ? {
          passed: pick.validation.passed,
          skip_reason: pick.validation.skip_reason,
          checks: pick.validation.checks
        } : null
      };
    });

    // Fetch live Nifty 50 price + change
    const marketContext = { ...doc.market_context };
    try {
      const niftyKey = 'NSE_INDEX|Nifty 50';
      const niftyDataMap = await priceCacheService.getLatestPricesWithChange([niftyKey]);
      const niftyData = niftyDataMap[niftyKey];
      if (niftyData) {
        marketContext.nifty_price = niftyData.price;
        marketContext.nifty_change = niftyData.change || 0;
        marketContext.nifty_change_pct = niftyData.change_percent || 0;
      }
    } catch (err) {
      console.warn('[DAILY-PICKS-API] Nifty price fetch failed:', err.message);
    }

    // Attach global intel (stored as top-level field) into market_context for the app
    // Clean text fields: strip markdown links, raw URLs, and limit length for mobile display
    if (doc.global_intel) {
      marketContext.global_intel = sanitizeIntelForMobile(doc.global_intel);
    }
    res.json({
      success: true,
      data: {
        trading_date: doc.trading_date ? new Date(new Date(doc.trading_date).getTime() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0] : null,
        scan_date: doc.scan_date ? new Date(new Date(doc.scan_date).getTime() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0] : null,
        market_context: marketContext,
        picks: enrichedPicks,
        summary: {
          ...doc.summary,
          auto_exit_time: '3:00 PM'
        },
        results: doc.results
      }
    });

  } catch (error) {
    console.error('[DAILY-PICKS-API] Error fetching today:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/daily-picks/history?days=7
 * Returns recent daily pick results for performance tracking.
 */
router.get('/history', auth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 90);
    const docs = await DailyPick.findRecent(days).lean();

    const history = docs.map(doc => ({
      trading_date: doc.trading_date,
      market_context: { regime: doc.market_context?.regime },
      picks_count: doc.picks?.length || 0,
      results: doc.results,
      picks: (doc.picks || []).map(p => ({
        symbol: p.symbol,
        direction: p.direction,
        rank_score: p.rank_score,
        trade: {
          status: p.trade?.status,
          return_pct: p.trade?.return_pct,
          pnl: p.trade?.pnl
        }
      }))
    }));

    // Aggregate summary
    let totalTrades = 0, totalWins = 0, totalLosses = 0;
    let cumulativePnl = 0;
    const dailyPnls = [];

    for (const doc of docs) {
      if (doc.results) {
        totalWins += doc.results.winners || 0;
        totalLosses += doc.results.losers || 0;
        cumulativePnl += doc.results.total_pnl || 0;
        dailyPnls.push(doc.results.total_pnl || 0);
      }
      totalTrades += (doc.picks || []).filter(p =>
        ['TARGET_HIT', 'STOPPED_OUT', 'TIME_EXIT'].includes(p.trade?.status)
      ).length;
    }

    res.json({
      success: true,
      data: history,
      summary: {
        total_days: docs.length,
        total_trades: totalTrades,
        win_rate_pct: totalTrades > 0 ? Math.round((totalWins / totalTrades) * 100 * 100) / 100 : 0,
        avg_daily_pnl: dailyPnls.length > 0 ? Math.round((dailyPnls.reduce((a, b) => a + b, 0) / dailyPnls.length) * 100) / 100 : 0,
        cumulative_pnl: Math.round(cumulativePnl * 100) / 100
      }
    });

  } catch (error) {
    console.error('[DAILY-PICKS-API] Error fetching history:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/daily-picks/review?date=2026-02-19
 * Returns candidate review table for a given trading date (admin only).
 * Defaults to today if no date provided.
 */
router.get('/review', auth, mobileAuth, async (req, res) => {
  try {
    let tradingDate;
    if (req.query.date) {
      // Parse date string as IST midnight (same logic as getIstDayRange)
      const [y, m, d] = req.query.date.split('-').map(Number);
      tradingDate = new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - 5.5 * 60 * 60 * 1000);
    } else {
      tradingDate = getIstDayRange().startUtc;
    }

    const doc = await DailyPick.findOne({ trading_date: tradingDate })
      .select('trading_date scan_date candidates_review summary market_context')
      .lean();

    if (!doc) {
      return res.json({ success: true, data: null, message: 'No scan found for this date' });
    }

    // Sort by rank_score descending
    const candidates = (doc.candidates_review || [])
      .sort((a, b) => (b.rank_score || 0) - (a.rank_score || 0));

    // Summary counts
    const statusCounts = {};
    for (const c of candidates) {
      statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
    }

    res.json({
      success: true,
      data: {
        trading_date: doc.trading_date ? new Date(new Date(doc.trading_date).getTime() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0] : null,
        scan_date: doc.scan_date ? new Date(new Date(doc.scan_date).getTime() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0] : null,
        market_regime: doc.market_context?.regime,
        total_candidates: candidates.length,
        status_counts: statusCounts,
        candidates
      }
    });
  } catch (error) {
    console.error('[DAILY-PICKS-API] Error fetching review:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/daily-picks/review/dates
 * Returns list of trading dates that have candidate review data (admin only).
 */
router.get('/review/dates', auth, mobileAuth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const docs = await DailyPick.find(
      { trading_date: { $gte: cutoff }, 'candidates_review.0': { $exists: true } },
      { trading_date: 1, 'summary.total_candidates': 1, 'summary.selected_count': 1 }
    ).sort({ trading_date: -1 }).lean();

    const dates = docs.map(d => ({
      date: new Date(new Date(d.trading_date).getTime() + 5.5 * 60 * 60 * 1000).toISOString().split('T')[0],
      total_candidates: d.summary?.total_candidates || 0,
      selected_count: d.summary?.selected_count || 0
    }));

    res.json({ success: true, data: dates });
  } catch (error) {
    console.error('[DAILY-PICKS-API] Error fetching review dates:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/daily-picks/trigger-scan
 * Manual trigger for scanning (admin/testing).
 */
router.post('/trigger-scan', adminAuth, async (req, res) => {
  try {
    const { dryRun = false } = req.body;
    console.log(`[DAILY-PICKS-API] Manual scan trigger (dryRun=${dryRun})`);

    const result = await runDailyPicks({ dryRun });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[DAILY-PICKS-API] Trigger scan error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/daily-picks/trigger-entry
 * Manual trigger for entry placement (admin/testing).
 */
router.post('/trigger-entry', adminAuth, async (req, res) => {
  try {
    const { dryRun = false } = req.body;
    console.log(`[DAILY-PICKS-API] Manual entry trigger (dryRun=${dryRun})`);

    const result = await validateAndPlaceEntries({ dryRun });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[DAILY-PICKS-API] Trigger entry error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/daily-picks/trigger-premarket-entry
 * Manual trigger for pre-market GTT/AMO entry placement.
 * Places orders for today's PENDING picks that failed or weren't placed yet.
 */
router.post('/trigger-premarket-entry', async (req, res) => {
  try {
    console.log(`[DAILY-PICKS-API] Manual pre-market entry trigger`);

    const doc = await DailyPick.findToday();
    if (!doc) {
      return res.json({ success: true, data: { message: 'No picks today' } });
    }

    const result = await placePreMarketEntries(doc);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[DAILY-PICKS-API] Pre-market entry trigger error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/daily-picks/trigger-exit
 * Manual trigger for 3 PM exit (admin/testing).
 */
router.post('/trigger-exit', adminAuth, async (req, res) => {
  try {
    const { dryRun = false } = req.body;
    console.log(`[DAILY-PICKS-API] Manual exit trigger (dryRun=${dryRun})`);

    const result = await runDailyExit({ dryRun });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[DAILY-PICKS-API] Trigger exit error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
