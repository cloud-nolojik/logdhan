import express from 'express';
import { auth } from '../middleware/auth.js';
import { User } from '../models/user.js';
import StockAnalysis from '../models/stockAnalysis.js';
// Use database version instead of JSON file version
import { getExactStock } from '../utils/stockDb.js';
import priceCacheService from '../services/priceCache.service.js';
import WeeklyWatchlist from '../models/weeklyWatchlist.js';
import { buildDailyUpdateCardFromAnalysis } from './weeklyWatchlist.js';
import { checkEntryZoneProximity } from '../engine/index.js';

const router = express.Router();

const DAILY_ADD_LIMIT = 5;

function getTodayISTDateString() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000);
  const istDate = new Date(istMs);
  return istDate.toISOString().split('T')[0]; // "YYYY-MM-DD"
}

function checkDailyAddLimit(user, instrumentKey) {
  const today = getTodayISTDateString();
  const tracker = user.dailyAddTracker || { date: '', keys: [] };

  // Reset tracker if it's a new day
  if (tracker.date !== today) {
    return { canAdd: true, addedToday: 0, remaining: DAILY_ADD_LIMIT };
  }

  // Already added this stock today — re-add is free (doesn't count again)
  if (tracker.keys.includes(instrumentKey)) {
    return { canAdd: true, addedToday: tracker.keys.length, remaining: Math.max(0, DAILY_ADD_LIMIT - tracker.keys.length) };
  }

  // Check limit
  if (tracker.keys.length >= DAILY_ADD_LIMIT) {
    return { canAdd: false, addedToday: tracker.keys.length, remaining: 0 };
  }

  return { canAdd: true, addedToday: tracker.keys.length, remaining: DAILY_ADD_LIMIT - tracker.keys.length };
}

function trackDailyAdd(user, instrumentKey) {
  const today = getTodayISTDateString();
  if (!user.dailyAddTracker || user.dailyAddTracker.date !== today) {
    user.dailyAddTracker = { date: today, keys: [instrumentKey] };
  } else if (!user.dailyAddTracker.keys.includes(instrumentKey)) {
    user.dailyAddTracker.keys.push(instrumentKey);
  }
}

// Extract analysis enrichment data from a StockAnalysis document
function extractAnalysisFields(analysis) {
  if (!analysis) return { has_analysis: false, analysis_status: null, ai_confidence: null, strategy_type: null, simple_verdict: null };

  let ai_confidence = null;
  let strategy_type = null;
  let simple_verdict = null;

  if (analysis.analysis_data) {
    const data = analysis.analysis_data;

    if (data.verdict && data.setup_score) {
      ai_confidence = data.verdict.confidence || null;
      strategy_type = data.verdict.action || null;
      const action = data.verdict.action || 'N/A';
      const score = data.setup_score.total || 0;
      const grade = data.setup_score.grade || '';
      simple_verdict = `${action} • ${score}/100 (${grade})`;
    } else if (data.position_management?.recommendation) {
      const pm = data.position_management;
      ai_confidence = pm.recommendation.confidence || null;
      strategy_type = pm.recommendation.for_holders || null;
      const statusLabel = pm.status?.label || 'TRACKING';
      const statusColor = pm.status?.color || 'YELLOW';
      const colorEmoji = statusColor === 'GREEN' ? '🟢' : statusColor === 'RED' ? '🔴' : '🟡';
      simple_verdict = `${colorEmoji} ${statusLabel}`;
    } else if (data.strategies?.length > 0) {
      const strategies = data.strategies;
      const confidences = strategies.filter(s => s.confidence != null).map(s => s.confidence);
      if (confidences.length > 0) {
        ai_confidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
      }
      strategy_type = strategies[0]?.type || null;
      simple_verdict = strategies[0]?.entry?.simple_verdict || null;
    }
  }

  // Check if expired (valid_until or 7-day age fallback)
  const isExpired = (() => {
    if (analysis.valid_until) return new Date() > new Date(analysis.valid_until);
    if (analysis.created_at) {
      const ageMs = Date.now() - new Date(analysis.created_at).getTime();
      return ageMs > 7 * 24 * 60 * 60 * 1000;
    }
    return false;
  })();

  return {
    has_analysis: !isExpired,
    analysis_status: isExpired ? 'expired' : (analysis.status || null),
    ai_confidence: isExpired ? null : ai_confidence,
    strategy_type: isExpired ? null : strategy_type,
    simple_verdict: isExpired ? null : simple_verdict
  };
}

// Add stock to watchlist
router.post('/', auth, async (req, res) => {
  try {
    const { instrument_key } = req.body;

    // Get stock details
    const stock = await getExactStock(instrument_key);
    if (!stock) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    // Check if stock is already in watchlist
    const user = await User.findById(req.user.id);
    const isInWatchlist = user.watchlist.some((item) =>
      item.instrument_key === instrument_key
    );

    if (isInWatchlist) {
      return res.status(200).json({ message: 'Stock already in watchlist' });
    }

    // Check daily add limit (5 unique new stocks per day)
    const dailyCheck = checkDailyAddLimit(user, instrument_key);
    if (!dailyCheck.canAdd) {
      return res.status(403).json({
        error: 'Daily limit reached',
        message: `You can add up to ${DAILY_ADD_LIMIT} new stocks per day. Come back tomorrow!`,
        data: {
          dailyLimit: DAILY_ADD_LIMIT,
          addedToday: dailyCheck.addedToday,
          remaining: 0,
          canAdd: false
        }
      });
    }

    // Add to watchlist
    user.watchlist.push({
      instrument_key: stock.instrument_key,
      trading_symbol: stock.trading_symbol,
      name: stock.name,
      exchange: stock.exchange,
      addedAt: new Date(),
      added_source: 'manual'
    });

    // Track daily add
    trackDailyAdd(user, instrument_key);
    await user.save();

    res.status(201).json({
      message: 'Stock added to watchlist',
      stock: {
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        name: stock.name,
        exchange: stock.exchange,
        addedAt: user.watchlist[user.watchlist.length - 1].addedAt,
        added_source: 'manual'
      }
    });
  } catch (error) {
    console.error('Error adding stock to watchlist:', error);
    res.status(500).json({ error: 'Error adding stock to watchlist' });
  }
});

// Add stock to watchlist for weekly tracking (from AI Analysis screen)
router.post('/track-weekly', auth, async (req, res) => {
  try {
    const { instrument_key } = req.body;
    console.log('📥 track-weekly request:', { instrument_key, userId: req.user.id });

    // Get stock details
    const stock = await getExactStock(instrument_key);
    console.log('📊 Stock lookup result:', stock ? stock.trading_symbol : 'NOT FOUND');
    if (!stock) {
      return res.status(404).json({ success: false, error: 'Stock not found' });
    }

    // Check if stock is already in watchlist
    const user = await User.findById(req.user.id);
    const existingIndex = user.watchlist.findIndex((item) =>
      item.instrument_key === instrument_key
    );

    if (existingIndex !== -1) {
      // Stock already exists - update source to weekly_track if it was manual
      const existingItem = user.watchlist[existingIndex];
      const currentSource = existingItem.added_source;
      if (currentSource === 'manual') {
        user.watchlist[existingIndex].added_source = 'weekly_track';
        await user.save();
      }
      // Use existing watchlist item data (in case stock lookup failed)
      return res.status(200).json({
        success: true,
        message: 'Stock already being tracked',
        stock: {
          instrument_key: existingItem.instrument_key,
          trading_symbol: existingItem.trading_symbol || stock?.trading_symbol,
          name: existingItem.name || stock?.name,
          exchange: existingItem.exchange || stock?.exchange,
          added_source: user.watchlist[existingIndex].added_source
        }
      });
    }

    // Check daily add limit (5 unique new stocks per day)
    const dailyCheck = checkDailyAddLimit(user, instrument_key);
    if (!dailyCheck.canAdd) {
      return res.status(403).json({
        success: false,
        error: 'Daily limit reached',
        message: `You can add up to ${DAILY_ADD_LIMIT} new stocks per day. Come back tomorrow!`,
        data: {
          dailyLimit: DAILY_ADD_LIMIT,
          addedToday: dailyCheck.addedToday,
          remaining: 0,
          canAdd: false
        }
      });
    }

    // Add to watchlist with weekly_track source
    user.watchlist.push({
      instrument_key: stock.instrument_key,
      trading_symbol: stock.trading_symbol,
      name: stock.name,
      exchange: stock.exchange,
      addedAt: new Date(),
      added_source: 'weekly_track'
    });

    // Track daily add
    trackDailyAdd(user, instrument_key);
    await user.save();
    console.log('✅ Stock added to watchlist:', stock.trading_symbol, 'for user:', req.user.id);

    res.status(201).json({
      success: true,
      message: 'Stock added for weekly tracking',
      stock: {
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        name: stock.name,
        exchange: stock.exchange,
        addedAt: user.watchlist[user.watchlist.length - 1].addedAt,
        added_source: 'weekly_track'
      }
    });
  } catch (error) {
    console.error('Error adding stock for weekly tracking:', error);
    res.status(500).json({ success: false, error: 'Error adding stock for weekly tracking' });
  }
});

// Check if a stock is in user's watchlist (lightweight — no DB queries, uses auth-loaded user)
router.get('/check/:instrument_key', auth, (req, res) => {
  const { instrument_key } = req.params;
  const watchlist = req.user.watchlist || [];
  const item = watchlist.find(w => w.instrument_key === instrument_key);

  res.json({
    success: true,
    data: item ? [{ instrument_key: item.instrument_key, trading_symbol: item.trading_symbol, name: item.name }] : []
  });
});

// Get user's watchlist
router.get('/', auth, async (req, res) => {
  try {
    const user = req.user;
    const watchlist = user.watchlist || [];

    // Collect all instrument keys upfront for batch queries
    const userInstrumentKeys = watchlist.map(item => item.instrument_key);

    // Fetch weekly watchlist and batch analysis query in parallel
    const [weeklyWatchlist, allAnalyses] = await Promise.all([
      WeeklyWatchlist.getCurrentWeek().catch(() => null),
      // Single batch query replaces N+1 per-stock StockAnalysis.findOne() calls
      StockAnalysis.find({
        instrument_key: { $in: userInstrumentKeys }
      }).sort({ created_at: -1 }).lean()
    ]);

    // Build analysis map: instrument_key -> latest analysis
    const analysisMap = {};
    for (const a of allAnalyses) {
      if (!analysisMap[a.instrument_key]) analysisMap[a.instrument_key] = a;
    }

    // Collect weekly instrument keys for combined price fetch
    const weeklyStocks = (weeklyWatchlist?.stocks || []).filter(
      stock => ['WATCHING', 'APPROACHING', 'TRIGGERED'].includes(stock.status)
    );
    const weeklyInstrumentKeys = weeklyStocks.map(s => s.instrument_key);

    // Deduplicate and fetch ALL prices in a single call
    const allInstrumentKeys = [...new Set([...userInstrumentKeys, ...weeklyInstrumentKeys])];
    const allPriceDataMap = await priceCacheService.getLatestPricesWithChange(allInstrumentKeys);

    // If weekly watchlist has stocks not covered by the batch analysis query, fetch them too
    const missingWeeklyKeys = weeklyInstrumentKeys.filter(k => !analysisMap[k]);
    if (missingWeeklyKeys.length > 0) {
      const weeklyAnalyses = await StockAnalysis.find({
        instrument_key: { $in: missingWeeklyKeys }
      }).sort({ created_at: -1 }).lean();
      for (const a of weeklyAnalyses) {
        if (!analysisMap[a.instrument_key]) analysisMap[a.instrument_key] = a;
      }
    }

    // Process user watchlist items (no more per-item DB queries)
    const watchlistWithPrices = watchlist.map(item => {
      const priceData = allPriceDataMap[item.instrument_key] || null;
      const analysis = analysisMap[item.instrument_key] || null;
      const analysisFields = extractAnalysisFields(analysis);

      return {
        instrument_key: item.instrument_key,
        trading_symbol: item.trading_symbol,
        name: item.name,
        exchange: item.exchange,
        addedAt: item.addedAt,
        added_source: item.added_source || 'manual',
        current_price: priceData?.price || null,
        net_change: priceData?.change || 0,
        percent_change: priceData?.change_percent || 0,
        ...analysisFields
      };
    });

    // Get daily add limit info
    const today = getTodayISTDateString();
    const tracker = user.dailyAddTracker || { date: '', keys: [] };
    const addedToday = tracker.date === today ? tracker.keys.length : 0;
    const stockLimitInfo = {
      dailyLimit: DAILY_ADD_LIMIT,
      addedToday,
      remaining: Math.max(0, DAILY_ADD_LIMIT - addedToday),
      canAddMore: addedToday < DAILY_ADD_LIMIT
    };

    // Get cache statistics for last update time
    const cacheStats = priceCacheService.getStats();

    // Enrich weekly watchlist stocks (no more per-item DB queries)
    let weeklyWatchlistData = null;
    if (weeklyWatchlist && weeklyStocks.length > 0) {
      const enrichedWeeklyStocks = weeklyStocks.map(stock => {
        const weeklyPriceData = allPriceDataMap[stock.instrument_key] || null;
        const currentPrice = weeklyPriceData?.price || null;

        let zoneStatus = null;
        if (currentPrice && stock.entry_zone) {
          zoneStatus = checkEntryZoneProximity(currentPrice, stock.entry_zone);
        }

        const analysis = analysisMap[stock.instrument_key] || null;
        const analysisFields = extractAnalysisFields(analysis);

        return {
          _id: stock._id,
          instrument_key: stock.instrument_key,
          trading_symbol: stock.symbol,
          name: stock.stock_name,
          addedAt: stock.added_at,
          added_source: 'chartink',
          scan_type: stock.scan_type,
          setup_score: stock.setup_score,
          grade: stock.grade,
          entry_zone: stock.entry_zone,
          zone_status: zoneStatus,
          current_price: currentPrice,
          net_change: weeklyPriceData?.change || 0,
          percent_change: weeklyPriceData?.change_percent || 0,
          status: stock.status,
          ...analysisFields
        };
      });

      weeklyWatchlistData = {
        week_start: weeklyWatchlist.week_start,
        week_end: weeklyWatchlist.week_end,
        screening_run_at: weeklyWatchlist.screening_run_at,
        stocks: enrichedWeeklyStocks,
        total_count: enrichedWeeklyStocks.length
      };
    }

    res.json({
      data: watchlistWithPrices,
      weeklyWatchlist: weeklyWatchlistData,
      stockLimitInfo,
      isInScheduledWindow: false,
      priceUpdate: {
        lastUpdated: cacheStats.lastFetchTime,
        cacheAge: cacheStats.cacheAge,
        nextUpdateIn: cacheStats.nextFetchIn,
        isFetching: cacheStats.isFetching
      },
      success: true,
      message: "Watchlist fetched successfully"
    });

  } catch (error) {
    console.error('Error fetching watchlist:', error);
    res.status(500).json({ error: 'Error fetching watchlist' });
  }
});

/**
 * GET /api/v1/watchlist/:instrument_key/position-analysis
 * Get latest position management analysis for a weekly_track stock
 *
 * This returns the GLOBAL analysis (same for all users tracking this stock).
 * Analysis includes: status (GREEN/YELLOW/RED), recommendations for holders/watchers,
 * updated levels, today's price action verdict, and alerts.
 */
router.get('/:instrument_key/position-analysis', auth, async (req, res) => {
  try {
    const { instrument_key } = req.params;

    // Get latest position/daily tracking analysis
    // Check for daily_track first (new system), fallback to position_management (legacy)
    const analysis = await StockAnalysis.findOne({
      instrument_key,
      analysis_type: { $in: ['daily_track', 'position_management'] },
      status: 'completed'
    }).sort({ created_at: -1 }).lean();

    // Check if analysis exists and is still valid (not expired)
    const now = new Date();
    const isExpired = analysis && analysis.valid_until && now > new Date(analysis.valid_until);

    if (!analysis || isExpired) {
      return res.json({
        success: true,
        has_analysis: false,
        message: 'No position analysis available yet. Analysis runs at 4:00 PM on trading days.'
      });
    }

    // Extract data based on analysis type
    // daily_track uses analysis_data.daily_track, position_management uses analysis_data.position_management
    const positionData = analysis.analysis_data?.daily_track
      || analysis.analysis_data?.position_management
      || null;

    // Build daily_update_card by looking up stock in WeeklyWatchlist
    let dailyUpdateCard = null;
    try {
      const weeklyWatchlist = await WeeklyWatchlist.getCurrentWeek();
      if (weeklyWatchlist) {
        const stock = weeklyWatchlist.stocks.find(s => s.instrument_key === instrument_key);
        if (stock) {
          const dailyTrack = analysis.analysis_data?.daily_track || null;
          const journeyStatus = stock.trade_simulation?.status || 'WAITING';
          const trackingStatus = stock.tracking_status || 'WATCHING';
          const trackingFlags = stock.tracking_flags || [];
          const levels = stock.levels || {};
          const snapshots = stock.daily_snapshots || [];
          const lastSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
          dailyUpdateCard = buildDailyUpdateCardFromAnalysis(dailyTrack, journeyStatus, trackingStatus, trackingFlags, levels, lastSnapshot);
        }
      }
    } catch (err) {
      console.warn('Error building daily_update_card:', err.message);
    }

    res.json({
      success: true,
      has_analysis: true,
      analysis_type: analysis.analysis_type,  // Let client know which type
      analysis: positionData,
      original_levels: analysis.analysis_data?.original_levels || null,
      analyzed_at: analysis.created_at,
      valid_until: analysis.valid_until,
      current_price: analysis.current_price,
      original_swing_analysis_id: analysis.analysis_data?.original_swing_analysis_id
        || analysis.analysis_data?.weekend_analysis_id
        || null,
      // Include trigger info for daily_track
      trigger: analysis.analysis_data?.trigger || null,
      daily_snapshot: analysis.analysis_data?.daily_snapshot || null,
      // Pre-built daily update card for display
      daily_update_card: dailyUpdateCard
    });
  } catch (error) {
    console.error('Error fetching position analysis:', error);
    res.status(500).json({ success: false, error: 'Error fetching position analysis' });
  }
});

// Remove stock from watchlist
router.delete('/:instrument_key', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const stockIndex = user.watchlist.findIndex(
      (item) => item.instrument_key === req.params.instrument_key
    );

    if (stockIndex === -1) {
      return res.status(404).json({ error: 'Stock not found in watchlist' });
    }

    user.watchlist.splice(stockIndex, 1);
    await user.save();

    res.json({ message: 'Stock removed from watchlist' });
  } catch (error) {
    console.error('Error removing stock from watchlist:', error);
    res.status(500).json({ error: 'Error removing stock from watchlist' });
  }
});

export default router;
