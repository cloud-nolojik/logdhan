import express from 'express';
import { auth } from '../middleware/auth.js';
import { User } from '../models/user.js';
import { getExactStock, getCurrentPrice } from '../utils/stock.js';
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
    
    console.log(`Fetching prices for ${watchlist.length} items in watchlist...`);
    const startTime = Date.now();
    
    const watchlistWithPrices = await Promise.all(
      watchlist.map((item, index) =>
        limit(async () => {
          try {
            console.log(`Processing watchlist item ${index + 1}/${watchlist.length}: ${item.trading_symbol}`);
            const currentPrice = await getCurrentPrice(item.instrument_key);
            console.log(`Completed watchlist item ${index + 1}/${watchlist.length}: ${item.trading_symbol} = ${currentPrice}`);
            
            return {
              instrument_key: item.instrument_key,
              trading_symbol: item.trading_symbol,
              name: item.name,
              exchange: item.exchange,
              addedAt: item.addedAt,
              currentPrice
            };
          } catch (err) {
            console.warn(`Error fetching price for ${item.trading_symbol} (${item.instrument_key}):`, err.message);
            return {
              instrument_key: item.instrument_key,
              trading_symbol: item.trading_symbol,
              name: item.name,
              exchange: item.exchange,
              addedAt: item.addedAt,
              currentPrice: null
            };
          }
        })
      )
    );

    const endTime = Date.now();
    console.log(`Watchlist pricing completed in ${endTime - startTime}ms`);

    res.json({ data: watchlistWithPrices, success: true, message: "Watchlist fetched successfully" });

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