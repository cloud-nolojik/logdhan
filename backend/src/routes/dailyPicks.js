/**
 * Daily Picks API Routes
 *
 * GET  /api/daily-picks/today       — Today's picks with live prices
 * GET  /api/daily-picks/history     — Recent daily pick results
 * POST /api/daily-picks/trigger-scan  — Manual scan trigger (admin/testing)
 * POST /api/daily-picks/trigger-entry — Manual entry trigger (admin/testing)
 * POST /api/daily-picks/trigger-exit  — Manual exit trigger (admin/testing)
 */

import express from 'express';
import { auth, adminAuth } from '../middleware/auth.js';
import DailyPick from '../models/dailyPick.js';
import { SCAN_LABELS } from '../services/dailyPicks/dailyPicksScans.js';
import { runDailyPicks, placeEntryOrders } from '../services/dailyPicks/dailyPicksService.js';
import { runDailyExit } from '../services/dailyPicks/dailyPicksExitService.js';
import priceCacheService from '../services/priceCache.service.js';
import { getIstDayRange } from '../utils/tradingDay.js';

const router = express.Router();

/**
 * GET /api/daily-picks/today
 * Returns today's DailyPick with live prices enriched.
 */
router.get('/today', auth, async (req, res) => {
  try {
    const today = getIstDayRange().startUtc;

    const doc = await DailyPick.findOne({ trading_date: today }).lean();

    if (!doc || !doc.picks || doc.picks.length === 0) {
      return res.json({
        success: true,
        data: {
          picks: [],
          market_context: doc?.market_context || {},
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
        ai_insight: pick.ai_insight
      };
    });

    res.json({
      success: true,
      data: {
        trading_date: doc.trading_date,
        scan_date: doc.scan_date,
        market_context: doc.market_context,
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

    const result = await placeEntryOrders({ dryRun });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[DAILY-PICKS-API] Trigger entry error:', error.message);
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
