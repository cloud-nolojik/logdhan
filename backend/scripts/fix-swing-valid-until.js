/**
 * Fix valid_until for existing swing analyses
 *
 * This script updates all swing analyses to use Friday expiry
 * (next Friday 3:29:59 PM IST) using updateMany for reliability.
 *
 * Run: node scripts/fix-swing-valid-until.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function fixSwingValidUntil() {
  try {
    console.log('🔧 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Import the model and utility after connection
    const StockAnalysis = (await import('../src/models/stockAnalysis.js')).default;
    const MarketHoursUtil = (await import('../src/utils/marketHours.js')).default;

    // Get the correct valid_until (next Friday 3:29:59 PM IST)
    const correctValidUntil = await MarketHoursUtil.getWeeklyValidUntilTime();
    console.log(`📅 Correct valid_until for swing analyses: ${correctValidUntil.toISOString()}`);

    // Update ALL swing analyses at once using updateMany (more reliable than .save())
    const result = await StockAnalysis.updateMany(
      { analysis_type: 'swing' },
      { $set: { valid_until: correctValidUntil } }
    );

    console.log(`📊 Matched: ${result.matchedCount}, Modified: ${result.modifiedCount}`);

    // Verify a few samples
    const samples = await StockAnalysis.find({ analysis_type: 'swing' }).limit(5);
    console.log('\n--- Sample verification ---');
    for (const s of samples) {
      const day = s.valid_until?.getDay();
      const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day];
      console.log(`${s.stock_symbol}: ${s.valid_until?.toISOString()} (${dayName})`);
    }

    console.log(`\n✅ Done! Updated ${result.modifiedCount} swing analyses to Friday expiry.`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

fixSwingValidUntil();
