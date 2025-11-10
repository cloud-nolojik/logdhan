import express from 'express';
import { auth } from '../middleware/auth.js';
import { User } from '../models/user.js';
import { Subscription } from '../models/subscription.js';
import StockAnalysis from '../models/stockAnalysis.js';
import MonitoringSubscription from '../models/monitoringSubscription.js';
import MarketHoursUtil from '../utils/marketHours.js';
// Use database version instead of JSON file version
import { getExactStock, getCurrentPrice } from '../utils/stockDb.js';
import pLimit from 'p-limit'; 
// Upstox allows 50 requests/second, so 20 concurrent is safe with 10s timeouts
const limit = pLimit(20); // Optimized for better performance while staying within rate limits


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
    const isInWatchlist = user.watchlist.some(item => 
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
      addedAt: new Date()
    });
    await user.save();

    res.status(201).json({
      message: 'Stock added to watchlist',
      stock: {
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        name: stock.name,
        exchange: stock.exchange,
        addedAt: user.watchlist[user.watchlist.length - 1].addedAt
      }
    });
  } catch (error) {
    console.error('Error adding stock to watchlist:', error);
    res.status(500).json({ error: 'Error adding stock to watchlist' });
  }
});


// Get user's watchlist
router.get('/', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const watchlist = user.watchlist || [];

    //console.log(`Fetching prices for ${watchlist.length} items in watchlist...`);
    const startTime = Date.now();

    // Check if we're currently in the scheduled window using MarketHoursUtil
    const bulkAnalysisCheck = await MarketHoursUtil.isBulkAnalysisAllowed();
    const isInScheduledWindow = bulkAnalysisCheck.reason === 'scheduled_window';

    if (isInScheduledWindow) {
      console.log('⏰ Currently in scheduled window (4:00 PM - 4:59 PM IST) - hiding all analyses');
    }

    const watchlistWithPrices = await Promise.all(
      watchlist.map((item, index) =>
        limit(async () => {
          try {
           // console.log(`Processing watchlist item ${index + 1}/${watchlist.length}: ${item.trading_symbol}`);
            const current_price = await getCurrentPrice(item.instrument_key);

            // Fetch analysis status for this stock (hide if in scheduled window)
            let analysis = null;
            if (!isInScheduledWindow) {
              analysis = await StockAnalysis.findOne({
                instrument_key: item.instrument_key,
              }).sort({ created_at: -1 }).lean();
            }

            // Check if stock is being monitored by this user
            const activeMonitoring = await MonitoringSubscription.findOne({
              instrument_key: item.instrument_key,
              'subscribed_users.user_id': req.user._id,
              monitoring_status: 'active' // Only active monitoring jobs
            }).lean();

            // Calculate AI confidence from strategies
            let ai_confidence = null;
            if (analysis && analysis.analysis_data && analysis.analysis_data.strategies) {
              const strategies = analysis.analysis_data.strategies;
              if (strategies.length > 0) {
                // Get average confidence from all strategies
                const confidences = strategies
                  .filter(s => s.confidence != null)
                  .map(s => s.confidence);
                if (confidences.length > 0) {
                  ai_confidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
                }
              }
            }

            //console.log(`Completed watchlist item ${index + 1}/${watchlist.length}: ${item.trading_symbol} = ${currentPrice}`);

            return {
              instrument_key: item.instrument_key,
              trading_symbol: item.trading_symbol,
              name: item.name,
              exchange: item.exchange,
              addedAt: item.addedAt,
              current_price,
              // Analysis status fields
              has_analysis: !!analysis,
              analysis_status: analysis?.status || null,
              ai_confidence,
              is_monitoring: !!activeMonitoring,
              monitoring_strategy_id: activeMonitoring?.strategy_id || null
            };
          } catch (err) {
            console.warn(`Error fetching data for ${item.trading_symbol} (${item.instrument_key}):`, err.message);
            return {
              instrument_key: item.instrument_key,
              trading_symbol: item.trading_symbol,
              name: item.name,
              exchange: item.exchange,
              addedAt: item.addedAt,
              current_price: null,
              has_analysis: false,
              analysis_status: null,
              ai_confidence: null,
              is_monitoring: false,
              monitoring_strategy_id: null
            };
          }
        })
      )
    );

    //const endTime = Date.now();
   // console.log(`Watchlist with analysis data completed in ${endTime - startTime}ms`);

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

    res.json({
      data: watchlistWithPrices,
      stockLimitInfo,
      isInScheduledWindow,
      success: true,
      message: "Watchlist fetched successfully"
    });

  } catch (error) {
    console.error('Error fetching watchlist:', error);
    res.status(500).json({ error: 'Error fetching watchlist' });
  }
});


// Remove stock from watchlist
router.delete('/:instrument_key', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const stockIndex = user.watchlist.findIndex(
      item => item.instrument_key === req.params.instrument_key
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