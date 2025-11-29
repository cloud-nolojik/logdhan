/**
 * Sync Screener Watchlist Script
 *
 * This script:
 * 1. Fetches stocks from Screener.in (Vijesh Stock List)
 * 2. Finds instrument_key for each stock from MongoDB
 * 3. Clears all users' watchlists
 * 4. Adds these stocks to all users' watchlists
 *
 * Usage (standalone):
 *   node src/scripts/syncScreenerWatchlist.js
 *   node src/scripts/syncScreenerWatchlist.js --dry-run
 *
 * Usage (imported by agendaScheduledBulkAnalysis.service.js):
 *   import { syncScreenerWatchlist } from '../scripts/syncScreenerWatchlist.js';
 *   await syncScreenerWatchlist();
 */

import axios from 'axios';
import * as cheerio from 'cheerio';

const SCREEN_URL = 'https://www.screener.in/screens/3326768/vijesh-stock-list/';

/**
 * Fetch stocks from Screener.in
 */
export async function fetchScreenerStocks() {
  console.log('[SCREENER SYNC] Fetching stocks from Screener.in...');
  console.log(`[SCREENER SYNC] URL: ${SCREEN_URL}`);

  const res = await axios.get(SCREEN_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
    timeout: 30000, // 30 second timeout
  });

  const html = res.data;
  const $ = cheerio.load(html);

  const stocks = [];

  $('table.data-table tbody tr').each((i, row) => {
    const tds = $(row).find('td');
    if (tds.length === 0) return;

    const nameCell = $(tds[1]);
    const name = nameCell.text().trim();

    const companyLink = nameCell.find('a').attr('href');

    // Extract symbol from URL (e.g., "/company/HDFCBANK/" -> "HDFCBANK")
    let symbol = null;
    if (companyLink) {
      const match = companyLink.match(/\/company\/([^/]+)\//);
      if (match) {
        symbol = match[1];
      }
    }

    if (!name) return;

    stocks.push({
      name,
      symbol,
    });
  });

  console.log(`[SCREENER SYNC] ✅ Found ${stocks.length} stocks from Screener`);
  return stocks;
}

/**
 * Find instrument_key for each stock from MongoDB
 * @param {Array} screenerStocks - Stocks from Screener.in
 * @param {Object} StockModel - Mongoose Stock model
 */
export async function findInstrumentKeys(screenerStocks, StockModel) {
  console.log('[SCREENER SYNC] Finding instrument keys from MongoDB...');

  const watchlistItems = [];
  const notFound = [];

  for (const stock of screenerStocks) {
    let dbStock = null;

    // Strategy 1: Exact symbol match with NSE
    if (stock.symbol) {
      dbStock = await StockModel.findOne({
        trading_symbol: stock.symbol,
        exchange: 'NSE'
      }).lean();
    }

    // Strategy 2: Symbol with EQ suffix (NSE equity)
    if (!dbStock && stock.symbol) {
      dbStock = await StockModel.findOne({
        trading_symbol: `${stock.symbol}-EQ`,
        exchange: 'NSE'
      }).lean();
    }

    // Strategy 3: Fuzzy name match
    if (!dbStock) {
      const nameRegex = new RegExp(stock.name.split(' ')[0], 'i');
      dbStock = await StockModel.findOne({
        name: nameRegex,
        exchange: 'NSE',
        instrument_type: 'EQUITY'
      }).lean();
    }

    if (dbStock) {
      watchlistItems.push({
        instrument_key: dbStock.instrument_key,
        trading_symbol: dbStock.trading_symbol,
        name: dbStock.name,
        exchange: dbStock.exchange,
      });
      console.log(`[SCREENER SYNC]   ✅ ${stock.symbol || stock.name} -> ${dbStock.trading_symbol}`);
    } else {
      notFound.push(stock);
      console.log(`[SCREENER SYNC]   ❌ ${stock.symbol || stock.name} -> NOT FOUND`);
    }
  }

  console.log(`[SCREENER SYNC] Summary: ${watchlistItems.length} found, ${notFound.length} not found`);
  return { watchlistItems, notFound };
}

/**
 * Update all users' watchlists with new stocks
 * @param {Array} watchlistItems - Stocks to add to watchlists
 * @param {Object} UserModel - Mongoose User model
 * @param {boolean} dryRun - If true, don't make changes
 */
export async function updateAllUsersWatchlists(watchlistItems, UserModel, dryRun = false) {
  console.log('[SCREENER SYNC] Updating all users\' watchlists...');

  const users = await UserModel.find({}).select('_id email name watchlist');
  console.log(`[SCREENER SYNC] Found ${users.length} users`);

  if (dryRun) {
    console.log('[SCREENER SYNC] 🔸 DRY RUN - No changes made');
    return { usersUpdated: 0, totalUsers: users.length, dryRun: true };
  }

  const newWatchlist = watchlistItems.map(item => ({
    instrument_key: item.instrument_key,
    trading_symbol: item.trading_symbol,
    name: item.name,
    exchange: item.exchange,
    added_at: new Date()
  }));

  let usersUpdated = 0;

  for (const user of users) {
    try {
      user.watchlist = newWatchlist;
      await user.save();
      usersUpdated++;
    } catch (error) {
      console.error(`[SCREENER SYNC] ❌ Failed to update ${user.email || user._id}:`, error.message);
    }
  }

  console.log(`[SCREENER SYNC] ✅ Updated ${usersUpdated}/${users.length} users`);
  return { usersUpdated, totalUsers: users.length };
}

/**
 * Main sync function - can be called from other services
 * @param {Object} options
 * @param {Object} options.StockModel - Mongoose Stock model
 * @param {Object} options.UserModel - Mongoose User model
 * @param {boolean} options.dryRun - If true, don't make changes
 */
export async function syncScreenerWatchlist({ StockModel, UserModel, dryRun = false } = {}) {
  console.log('='.repeat(60));
  console.log('[SCREENER SYNC] 🔄 Starting Screener Watchlist Sync');
  console.log('='.repeat(60));

  try {
    // Step 1: Fetch from Screener
    const screenerStocks = await fetchScreenerStocks();

    if (screenerStocks.length === 0) {
      console.log('[SCREENER SYNC] ❌ No stocks found from Screener');
      return { success: false, error: 'No stocks found from Screener' };
    }

    // Step 2: Find instrument keys
    const { watchlistItems, notFound } = await findInstrumentKeys(screenerStocks, StockModel);

    if (watchlistItems.length === 0) {
      console.log('[SCREENER SYNC] ❌ No stocks matched in database');
      return { success: false, error: 'No stocks matched in database' };
    }

    // Step 3: Update all users' watchlists
    const updateResult = await updateAllUsersWatchlists(watchlistItems, UserModel, dryRun);

    // Summary
    const summary = {
      success: true,
      screenerStocksCount: screenerStocks.length,
      matchedStocksCount: watchlistItems.length,
      notFoundCount: notFound.length,
      usersUpdated: updateResult.usersUpdated,
      totalUsers: updateResult.totalUsers,
      watchlistItems // Return the items for bulk analysis
    };

    console.log('='.repeat(60));
    console.log('[SCREENER SYNC] 📊 SUMMARY');
    console.log(`[SCREENER SYNC]   Screener stocks: ${summary.screenerStocksCount}`);
    console.log(`[SCREENER SYNC]   Matched in DB:   ${summary.matchedStocksCount}`);
    console.log(`[SCREENER SYNC]   Not found:       ${summary.notFoundCount}`);
    console.log(`[SCREENER SYNC]   Users updated:   ${summary.usersUpdated}`);
    console.log('='.repeat(60));

    return summary;

  } catch (error) {
    console.error('[SCREENER SYNC] ❌ Error:', error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================
// STANDALONE SCRIPT MODE
// ============================================================
const isStandaloneScript = process.argv[1]?.includes('syncScreenerWatchlist.js');

if (isStandaloneScript) {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes('--dry-run');

  (async () => {
    try {
      // Load environment
      await import('../loadEnv.js');

      // Import mongoose and models
      const mongoose = (await import('mongoose')).default;
      const Stock = (await import('../models/stock.js')).default;
      const { User } = await import('../models/user.js');

      // Connect to MongoDB
      console.log('\n📦 Connecting to MongoDB...');
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('   ✅ Connected\n');

      // Run sync
      const result = await syncScreenerWatchlist({
        StockModel: Stock,
        UserModel: User,
        dryRun: DRY_RUN
      });

      // Close connection
      await mongoose.connection.close();
      console.log('\n📦 MongoDB connection closed');

      process.exit(result.success ? 0 : 1);

    } catch (error) {
      console.error('❌ Fatal error:', error);
      process.exit(1);
    }
  })();
}
