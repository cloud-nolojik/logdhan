/**
 * Debug script to check price for MTARTECH from different sources
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import LatestPrice from '../src/models/latestPrice.js';
import priceCacheService from '../src/services/priceCache.service.js';
import { getCurrentPrice } from '../src/utils/stockDb.js';

const INSTRUMENT_KEY = 'NSE_EQ|INE316H01017'; // MTARTECH

async function debugPrice() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    console.log('='.repeat(60));
    console.log('DEBUGGING PRICE FOR MTARTECH');
    console.log('Instrument Key:', INSTRUMENT_KEY);
    console.log('='.repeat(60));

    // 1. Check LatestPrice collection directly
    console.log('\n📊 1. LatestPrice Collection (Direct DB Query):');
    const priceDoc = await LatestPrice.findOne({ instrument_key: INSTRUMENT_KEY });
    if (priceDoc) {
      console.log('   last_traded_price:', priceDoc.last_traded_price);
      console.log('   close:', priceDoc.close);
      console.log('   previous_day_close:', priceDoc.previous_day_close);
      console.log('   change:', priceDoc.change);
      console.log('   change_percent:', priceDoc.change_percent);
      console.log('   updated_at:', priceDoc.updated_at);
    } else {
      console.log('   ❌ No document found in LatestPrice');
    }

    // 2. Check priceCacheService.getLatestPricesWithChange
    console.log('\n📊 2. priceCacheService.getLatestPricesWithChange():');
    const priceDataMap = await priceCacheService.getLatestPricesWithChange([INSTRUMENT_KEY]);
    const priceData = priceDataMap[INSTRUMENT_KEY];
    if (priceData) {
      console.log('   price:', priceData.price);
      console.log('   change:', priceData.change);
      console.log('   change_percent:', priceData.change_percent);
      console.log('   previous_day_close:', priceData.previous_day_close);
    } else {
      console.log('   ❌ No data returned from getLatestPricesWithChange');
    }

    // 3. Check getCurrentPrice (direct Upstox API)
    console.log('\n📊 3. getCurrentPrice() - Direct Upstox API:');
    try {
      const apiPrice = await getCurrentPrice(INSTRUMENT_KEY);
      console.log('   API price:', apiPrice);
    } catch (e) {
      console.log('   ❌ Error:', e.message);
    }

    console.log('\n' + '='.repeat(60));
    console.log('DEBUG COMPLETE');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  }
}

debugPrice();
