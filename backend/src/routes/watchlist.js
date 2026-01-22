import express from 'express';
import { auth } from '../middleware/auth.js';
import { User } from '../models/user.js';
import { Subscription } from '../models/subscription.js';
import StockAnalysis from '../models/stockAnalysis.js';
// Use database version instead of JSON file version
import { getExactStock } from '../utils/stockDb.js';
import priceCacheService from '../services/priceCache.service.js';
import WeeklyWatchlist from '../models/weeklyWatchlist.js';
import { checkEntryZoneProximity } from '../engine/index.js';

const router = express.Router();

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

    // Check stock limit based on subscription
    const currentStockCount = user.watchlist.length;

    try {
      const stockLimitCheck = await Subscription.canUserAddStock(req.user.id, currentStockCount);

      if (!stockLimitCheck.canAdd) {
        return res.status(403).json({
          error: 'Stock limit reached',
          message: `You can add maximum ${stockLimitCheck.stockLimit} stocks to your watchlist. Current: ${stockLimitCheck.currentCount}`,
          data: {
            stockLimit: stockLimitCheck.stockLimit,
            currentCount: stockLimitCheck.currentCount,
            canAdd: false,
            needsUpgrade: true
          }
        });
      }
    } catch (subscriptionError) {
      console.error('Error checking subscription limits:', subscriptionError);
      return res.status(400).json({
        error: 'Subscription check failed',
        message: subscriptionError.message
      });
    }

    // Add to watchlist
    user.watchlist.push({
      instrument_key: stock.instrument_key,
      trading_symbol: stock.trading_symbol,
      name: stock.name,
      exchange: stock.exchange,
      addedAt: new Date(),
      added_source: 'manual' // Explicitly mark as manual add
    });
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

    // Get stock details
    const stock = await getExactStock(instrument_key);
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
      const currentSource = user.watchlist[existingIndex].added_source;
      if (currentSource === 'manual') {
        user.watchlist[existingIndex].added_source = 'weekly_track';
        await user.save();
      }
      return res.status(200).json({
        success: true,
        message: 'Stock already being tracked',
        stock: {
          instrument_key: stock.instrument_key,
          trading_symbol: stock.trading_symbol,
          name: stock.name,
          exchange: stock.exchange,
          added_source: user.watchlist[existingIndex].added_source
        }
      });
    }

    // Check stock limit based on subscription
    const currentStockCount = user.watchlist.length;

    try {
      const stockLimitCheck = await Subscription.canUserAddStock(req.user.id, currentStockCount);

      if (!stockLimitCheck.canAdd) {
        return res.status(403).json({
          success: false,
          error: 'Stock limit reached',
          message: `You can add maximum ${stockLimitCheck.stockLimit} stocks. Current: ${stockLimitCheck.currentCount}`,
          data: {
            stockLimit: stockLimitCheck.stockLimit,
            currentCount: stockLimitCheck.currentCount,
            canAdd: false,
            needsUpgrade: true
          }
        });
      }
    } catch (subscriptionError) {
      console.error('Error checking subscription limits:', subscriptionError);
      return res.status(400).json({
        success: false,
        error: 'Subscription check failed',
        message: subscriptionError.message
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
    await user.save();

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

// Get user's watchlist
router.get('/', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const watchlist = user.watchlist || [];

    const startTime = Date.now();

    // Bulk analysis downtime notifications disabled
    const isInScheduledWindow = false;
    

    // ⚡ OPTIMIZATION: Fetch prices using triple-fallback pattern (DB → Memory → API)
    const instrumentKeys = watchlist.map((item) => item.instrument_key);
    const priceMap = await priceCacheService.getLatestPrices(instrumentKeys);

    // Process watchlist items in parallel (for analysis and monitoring data)
    const watchlistWithPrices = await Promise.all(
      watchlist.map(async (item) => {
        try {
          // Get price from database
          const current_price = priceMap[item.instrument_key] || null;

          // Fetch analysis status for this stock (hide if in scheduled window)
          let analysis = null;
          if (!isInScheduledWindow) {
            analysis = await StockAnalysis.findOne({
              instrument_key: item.instrument_key
            }).sort({ created_at: -1 }).lean();
          }

          // Calculate AI confidence from strategies and get strategy type
          let ai_confidence = null;
          let strategy_type = null; // BUY, SELL, HOLD, NO_TRADE
          if (analysis && analysis.analysis_data && analysis.analysis_data.strategies) {
            const strategies = analysis.analysis_data.strategies;
            if (strategies.length > 0) {
              // Get average confidence from all strategies
              const confidences = strategies.
                filter((s) => s.confidence != null).
                map((s) => s.confidence);
              if (confidences.length > 0) {
                ai_confidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
              }

              // Get the strategy type from the first/best strategy
              // Strategies are typically sorted by confidence, so first one is best
              strategy_type = strategies[0]?.type || null;
            }
          }

          return {
            instrument_key: item.instrument_key,
            trading_symbol: item.trading_symbol,
            name: item.name,
            exchange: item.exchange,
            addedAt: item.addedAt,
            added_source: item.added_source || 'manual', // Default to manual if missing
            current_price,
            // Analysis status fields
            has_analysis: !!analysis,
            analysis_status: analysis?.status || null,
            ai_confidence,
            strategy_type // BUY, SELL, HOLD, NO_TRADE
          };
        } catch (err) {
          console.warn(`Error fetching data for ${item.trading_symbol} (${item.instrument_key}):`, err.message);
          return {
            instrument_key: item.instrument_key,
            trading_symbol: item.trading_symbol,
            name: item.name,
            exchange: item.exchange,
            addedAt: item.addedAt,
            added_source: item.added_source || 'screener',
            current_price: null,
            has_analysis: false,
            analysis_status: null,
            ai_confidence: null,
            strategy_type: null
          };
        }
      })
    );

    const endTime = Date.now();

    // Get subscription info for stock limits
    let stockLimitInfo = null;
    try {
      const subscription = await Subscription.findActiveForUser(req.user.id);
      if (subscription) {
        stockLimitInfo = {
          stockLimit: subscription.stockLimit,
          currentCount: watchlist.length,
          remaining: Math.max(0, subscription.stockLimit - watchlist.length),
          canAddMore: subscription.stockLimit > watchlist.length
        };
      }
    } catch (error) {
      console.warn('Error fetching subscription for stock limits:', error);
    }

    // Get cache statistics for last update time
    const cacheStats = priceCacheService.getStats();

    // Fetch WeeklyWatchlist (global ChartInk-screened stocks)
    let weeklyWatchlistData = null;
    try {
      const weeklyWatchlist = await WeeklyWatchlist.getCurrentWeek();
      if (weeklyWatchlist && weeklyWatchlist.stocks?.length > 0) {
        // Get prices for weekly watchlist stocks
        const weeklyInstrumentKeys = weeklyWatchlist.stocks.map(s => s.instrument_key);
        const weeklyPriceMap = await priceCacheService.getLatestPrices(weeklyInstrumentKeys);

        // Enrich weekly watchlist stocks
        const enrichedWeeklyStocks = await Promise.all(
          weeklyWatchlist.stocks
            .filter(stock => ['WATCHING', 'APPROACHING', 'TRIGGERED'].includes(stock.status))
            .map(async (stock) => {
              const currentPrice = weeklyPriceMap[stock.instrument_key] || null;

              // Check entry zone proximity
              let zoneStatus = null;
              if (currentPrice && stock.entry_zone) {
                zoneStatus = checkEntryZoneProximity(currentPrice, stock.entry_zone);
              }

              // Fetch latest analysis for this stock
              let analysis = null;
              if (!isInScheduledWindow) {
                analysis = await StockAnalysis.findOne({
                  instrument_key: stock.instrument_key
                }).sort({ created_at: -1 }).lean();
              }

              // Calculate AI confidence
              let ai_confidence = null;
              let strategy_type = null;
              if (analysis?.analysis_data?.strategies?.length > 0) {
                const strategies = analysis.analysis_data.strategies;
                const confidences = strategies.filter(s => s.confidence != null).map(s => s.confidence);
                if (confidences.length > 0) {
                  ai_confidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
                }
                strategy_type = strategies[0]?.type || null;
              }

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
                status: stock.status,
                // Analysis fields
                has_analysis: !!analysis,
                analysis_status: analysis?.status || null,
                ai_confidence,
                strategy_type
              };
            })
        );

        weeklyWatchlistData = {
          week_start: weeklyWatchlist.week_start,
          week_end: weeklyWatchlist.week_end,
          screening_run_at: weeklyWatchlist.screening_run_at,
          stocks: enrichedWeeklyStocks,
          total_count: enrichedWeeklyStocks.length
        };
      }
    } catch (weeklyError) {
      console.warn('Error fetching weekly watchlist:', weeklyError.message);
    }

    res.json({
      data: watchlistWithPrices,
      weeklyWatchlist: weeklyWatchlistData,
      stockLimitInfo,
      isInScheduledWindow,
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

    // Get latest position management analysis
    const analysis = await StockAnalysis.findOne({
      instrument_key,
      analysis_type: 'position_management',
      status: 'completed'
    }).sort({ created_at: -1 }).lean();

    if (!analysis) {
      return res.json({
        success: true,
        has_analysis: false,
        message: 'No position analysis available yet. Analysis runs at 4:00 PM on trading days.'
      });
    }

    // Check if analysis is still valid
    const now = new Date();
    const isExpired = analysis.valid_until && now > new Date(analysis.valid_until);

    // Extract position management data
    const positionData = analysis.analysis_data?.position_management || null;

    res.json({
      success: true,
      has_analysis: true,
      is_expired: isExpired,
      analysis: positionData,
      original_levels: analysis.analysis_data?.original_levels || null,
      analyzed_at: analysis.created_at,
      valid_until: analysis.valid_until,
      current_price: analysis.current_price,
      original_swing_analysis_id: analysis.analysis_data?.original_swing_analysis_id || null
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
