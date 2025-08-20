import express from 'express';
import { searchStocks, getExactStock, getCurrentPrice } from '../utils/stock.js';
import { User } from '../models/user.js';
import { auth } from '../middleware/auth.js';


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
    allMatches.forEach(stock => {
      if (watchlist.some(item => item.instrument_key === stock.instrument_key)) {
        stock.isInWatchlist = true;
      } 
    });

    res.status(200).json({
      results: allMatches.map(stock => ({
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        name: stock.name,
        exchange: stock.exchange,
        tradingViewLink: `https://www.tradingview.com/chart?symbol=${stock.exchange}:${stock.trading_symbol}`
      })),
      total: allMatches.length,
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
    
    console.log('Getting stock details for instrument_key:', instrument_key);
    
    const stock = await getExactStock(instrument_key);
    console.log('Stock found:', stock);

    if (!stock) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    // Get current price of the stock
    let currentPrice;
    try {
      currentPrice = await getCurrentPrice(instrument_key);
      console.log('Current price:', currentPrice);
    } catch (priceError) {
      console.warn('Error getting current price:', priceError);
      currentPrice = null; // Set to null if price fetch fails
    }

    res.status(200).json({
      success: true,
      data: {
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        name: stock.name,
        exchange: stock.exchange,
        currentPrice: currentPrice,
        tradingViewLink: `https://www.tradingview.com/chart?symbol=${stock.exchange}:${stock.trading_symbol}`
      }
    });
  } catch (error) {
    console.error('Error in GET /:instrument_key:', error);
    console.error('Error details:', error.message, error.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;