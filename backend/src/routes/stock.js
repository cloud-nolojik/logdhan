import express from 'express';
// Use database version instead of JSON file version
import { searchStocks, getExactStock, getCurrentPrice } from '../utils/stockDb.js';
import { User } from '../models/user.js';
import { auth } from '../middleware/auth.js';
import LatestPrice from '../models/latestPrice.js';
import WeeklyWatchlist from '../models/weeklyWatchlist.js';

const router = express.Router();

// Route: Search stocks
router.get('/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Search term must be at least 2 characters long' });
    }

    const { allMatches } = await searchStocks(q);
    //now we need iwht use rwatchlist if it already added then we need to remove it from the allMatches
    const user = await User.findById(req.user.id);
    const watchlist = user.watchlist;
    allMatches.forEach((stock) => {
      if (watchlist.some((item) => item.instrument_key === stock.instrument_key)) {
        stock.isInWatchlist = true;
      }
    });

    res.status(200).json({
      results: allMatches.map((stock) => ({
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        name: stock.name,
        exchange: stock.exchange,
        tradingViewLink: `https://www.tradingview.com/chart?symbol=${stock.exchange}:${stock.trading_symbol}`
      })),
      total: allMatches.length
    });
  } catch (error) {
    console.error('Error in /search:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Route: Get exact stock details with TradingView link
router.get('/:instrument_key', auth, async (req, res) => {
  try {
    const { instrument_key } = req.params;

    // Validate instrument_key parameter
    if (!instrument_key || instrument_key.trim().length === 0) {
      return res.status(400).json({ error: 'Invalid instrument_key parameter' });
    }

    const stock = await getExactStock(instrument_key);

    if (!stock) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    // Get current price of the stock
    let currentPrice;
    try {
      currentPrice = await getCurrentPrice(instrument_key);

    } catch (priceError) {
      console.warn('Error getting current price:', priceError);
      currentPrice = null; // Set to null if price fetch fails
    }

    // Fallback: Try to get cached price from LatestPrice collection
    if (!currentPrice) {
      try {
        const priceDoc = await LatestPrice.findOne({ instrument_key });
        currentPrice = priceDoc?.last_traded_price || priceDoc?.close || null;
        if (currentPrice) {
          console.log(`Using cached price for ${stock.tradingsymbol || stock.trading_symbol}: ₹${currentPrice}`);
        }
      } catch (fallbackError) {
        console.warn('Fallback price fetch also failed:', fallbackError.message);
      }
    }

    // Check if API price is stale by comparing against WeeklyWatchlist's daily_snapshots
    // This handles the case where 1-min candles API returns old data before market opens
    if (currentPrice) {
      try {
        // Find current week's watchlist
        const now = new Date();
        const watchlist = await WeeklyWatchlist.findOne({
          week_start: { $lte: now },
          week_end: { $gte: now }
        });

        if (watchlist) {
          const stockInWatchlist = watchlist.stocks.find(s => s.instrument_key === instrument_key);
          if (stockInWatchlist?.daily_snapshots?.length > 0) {
            const lastSnapshot = stockInWatchlist.daily_snapshots[stockInWatchlist.daily_snapshots.length - 1];
            const lastSnapshotClose = lastSnapshot.close;

            // If API price differs >5% from last snapshot, use snapshot price
            const priceDiffPct = Math.abs((currentPrice - lastSnapshotClose) / lastSnapshotClose) * 100;
            if (priceDiffPct > 5) {
              console.log(`[STOCK-PRICE-FIX] ${stock.tradingsymbol || stock.trading_symbol}: API price ₹${currentPrice} differs ${priceDiffPct.toFixed(1)}% from last snapshot close ₹${lastSnapshotClose}`);
              console.log(`[STOCK-PRICE-FIX] Using snapshot close as current price`);
              currentPrice = lastSnapshotClose;
            }
          }
        }
      } catch (snapshotError) {
        console.warn('Error checking snapshot price:', snapshotError.message);
      }
    }

    // Check if stock is in user's watchlist
    let isInWatchlist = false;
    try {
      const user = await User.findById(req.user.id);
      if (user && user.watchlist) {
        isInWatchlist = user.watchlist.some((item) => item.instrument_key === instrument_key);
      }
    } catch (watchlistError) {
      console.warn('Error checking watchlist:', watchlistError);
    }

    res.status(200).json({
      success: true,
      data: {
        instrument_key: stock.instrument_key,
        trading_symbol: stock.tradingsymbol || stock.trading_symbol,
        name: stock.name,
        exchange: stock.exchange,
        currentPrice: currentPrice,
        tradingViewLink: `https://www.tradingview.com/chart?symbol=${stock.exchange}:${stock.tradingsymbol || stock.trading_symbol}`,
        is_in_watchlist: isInWatchlist
      }
    });
  } catch (error) {
    console.error('Error in GET /:instrument_key:', error);
    console.error('Error details:', error.message, error.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Route: Get stock news
router.get('/:instrument_key/news', auth, async (req, res) => {
  try {
    const { instrument_key } = req.params;
    const { limit = 10 } = req.query; // Default to 10 news items

    // Validate instrument_key parameter
    if (!instrument_key || instrument_key.trim().length === 0) {

      return res.status(400).json({
        success: false,
        error: 'Invalid instrument_key parameter'
      });
    }

    // Get stock details to extract stock name
    const stockDetails = await getExactStock(instrument_key);
    if (!stockDetails) {

      return res.status(404).json({
        success: false,
        error: 'Stock not found'
      });
    }

    // Import aiReviewService instance to use its news fetching functionality
    const { aiReviewService } = await import('../services/ai/aiReview.service.js');

    // Fetch news using the existing service
    const stockName = stockDetails.name || stockDetails.trading_symbol;

    try {
      const newsItems = await aiReviewService.fetchNewsData(stockName);

      if (!newsItems || newsItems.length === 0) {
        return res.status(200).json({
          success: true,
          data: {
            stockName: stockName,
            stockSymbol: stockDetails.trading_symbol,
            totalNews: 0,
            news: [],
            message: 'No news available for this stock'
          }
        });
      }

      // Process and format news items for frontend
      const formattedNews = newsItems.slice(0, parseInt(limit)).map((item) => ({
        title: item.title,
        link: item.link,
        publishedDate: item.pubDate,
        source: item.source || 'Google News',
        snippet: item.contentSnippet || item.content || item.summary || '',
        thumbnail: item.thumbnail || null,
        guid: item.guid || item.link
      }));

      res.status(200).json({
        success: true,
        data: {
          stockName: stockName,
          stockSymbol: stockDetails.trading_symbol,
          totalNews: formattedNews.length,
          news: formattedNews
        }
      });
    } catch (newsError) {
      console.error('❌ Error fetching news data:', newsError);
      return res.status(200).json({
        success: true,
        data: {
          stockName: stockName,
          stockSymbol: stockDetails.trading_symbol,
          totalNews: 0,
          news: [],
          message: 'Unable to fetch news at the moment',
          error: newsError.message
        }
      });
    }

  } catch (error) {
    console.error('❌ Error in news endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch stock news',
      message: error.message
    });
  }
});

export default router;