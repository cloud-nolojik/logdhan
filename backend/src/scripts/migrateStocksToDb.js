#!/usr/bin/env node

import '../loadEnv.js';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Stock from '../models/stock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const BATCH_SIZE = 1000; // Process stocks in batches
const DATA_DIR = path.join(__dirname, '../data');

// Stats tracking
const stats = {
  nse: { total: 0, processed: 0, errors: 0 },
  bse: { total: 0, processed: 0, errors: 0 },
  startTime: Date.now()
};

// Connect to MongoDB
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });

  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    process.exit(1);
  }
}

// Read and parse JSON file
function readJsonFile(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`❌ Error reading file ${filePath}:`, error.message);
    return [];
  }
}

// Filter only equity segments
function filterEquityStocks(stocks, exchange) {
  const segmentFilter = exchange === 'NSE' ? 'NSE_EQ' : 'BSE_EQ';
  return stocks.filter((stock) => stock.segment === segmentFilter);
}

// Process stocks in batches
async function processBatch(stocks, exchange) {
  const formattedStocks = stocks.map((stock) => ({
    segment: stock.segment,
    name: stock.name || '',
    exchange: stock.exchange || exchange,
    isin: stock.isin || null,
    instrument_type: stock.instrument_type || '',
    instrument_key: stock.instrument_key,
    lot_size: stock.lot_size || 1,
    freeze_quantity: stock.freeze_quantity || null,
    exchange_token: stock.exchange_token || '',
    tick_size: stock.tick_size || 0.05,
    trading_symbol: stock.trading_symbol || '',
    short_name: stock.short_name || null,
    qty_multiplier: stock.qty_multiplier || 1,
    is_active: true
  }));

  try {
    const result = await Stock.bulkUpsert(formattedStocks);
    return result.modifiedCount + result.upsertedCount;
  } catch (error) {
    console.error(`❌ Batch processing error:`, error.message);
    throw error;
  }
}

// Process file with progress tracking
async function processFile(fileName, exchange) {

  const filePath = path.join(DATA_DIR, fileName);

  if (!fs.existsSync(filePath)) {

    return;
  }

  // Read all stocks
  const allStocks = readJsonFile(filePath);

  // Filter only equity stocks
  const equityStocks = filterEquityStocks(allStocks, exchange);

  const statsKey = exchange.toLowerCase();
  stats[statsKey].total = equityStocks.length;

  // Process in batches
  let processed = 0;
  for (let i = 0; i < equityStocks.length; i += BATCH_SIZE) {
    const batch = equityStocks.slice(i, Math.min(i + BATCH_SIZE, equityStocks.length));

    try {
      const count = await processBatch(batch, exchange);
      processed += batch.length;
      stats[statsKey].processed += batch.length;

      // Progress indicator
      const progress = Math.round(processed / equityStocks.length * 100);
      process.stdout.write(`   Processing: ${progress}% (${processed}/${equityStocks.length})\r`);
    } catch (error) {
      stats[statsKey].errors += batch.length;
      console.error(`\n   ❌ Error processing batch ${i}-${i + batch.length}: ${error.message}`);
    }
  }

}

// Create indexes for optimized queries
async function createIndexes() {

  try {
    const collection = mongoose.connection.collection('stocks');

    // Drop existing indexes except _id
    const existingIndexes = await collection.indexes();
    for (const index of existingIndexes) {
      if (index.name !== '_id_') {
        await collection.dropIndex(index.name).catch(() => {});
      }
    }

    // Create new optimized indexes
    await collection.createIndex({ instrument_key: 1 }, { unique: true });
    await collection.createIndex({ segment: 1, is_active: 1 });
    await collection.createIndex({ exchange: 1, trading_symbol: 1 });
    await collection.createIndex({ name: 1 });
    await collection.createIndex({ trading_symbol: 1 });
    await collection.createIndex({ isin: 1 }, { sparse: true });
    await collection.createIndex(
      { name: 'text', trading_symbol: 'text', short_name: 'text' },
      { weights: { trading_symbol: 10, name: 5, short_name: 3 } }
    );

  } catch (error) {
    console.error('❌ Error creating indexes:', error.message);
  }
}

// Verify migration
async function verifyMigration() {

  const nseCount = await Stock.countDocuments({ segment: 'NSE_EQ' });
  const bseCount = await Stock.countDocuments({ segment: 'BSE_EQ' });
  const totalCount = await Stock.countDocuments({});

  // Sample queries to test

  const sampleStock = await Stock.findOne({ segment: 'NSE_EQ' });
  if (sampleStock) {

  }

  const searchResults = await Stock.searchStocks('RELIANCE', 5);

  return { nseCount, bseCount, totalCount };
}

// Main migration function
async function migrate() {

  try {
    // Connect to database
    await connectDB();

    // Clear existing data (optional - comment out to append)
    const clearData = process.argv.includes('--clear');
    if (clearData) {

      await Stock.deleteMany({});

    }

    // Process NSE data
    await processFile('NSE.json', 'NSE');

    // Process BSE data
    await processFile('BSE.json', 'BSE');

    // Create indexes
    await createIndexes();

    // Verify migration
    const counts = await verifyMigration();

    // Print summary
    const duration = Math.round((Date.now() - stats.startTime) / 1000);

    if (stats.nse.errors === 0 && stats.bse.errors === 0) {

    } else {

    }

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();

  }
}

// Run migration
migrate().catch(console.error);

// Handle termination
process.on('SIGINT', async () => {

  await mongoose.disconnect();
  process.exit(0);
});