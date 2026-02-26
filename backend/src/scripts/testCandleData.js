/**
 * Test Step 3 enrichment for a stock — calls the same function as daily picks pipeline
 * Skips intraday data to simulate pre-market scan time (8:45 AM)
 *
 * Usage: node src/scripts/testCandleData.js WEBELSOLAR
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

import { getDailyAnalysisData } from '../services/technicalData.service.js';

const symbol = process.argv[2] || 'WEBELSOLAR';

async function test() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log(`\nCalling getDailyAnalysisData(['${symbol}'], { skipIntraday: true })...\n`);
    const result = await getDailyAnalysisData([symbol]);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('ERROR:', error.message);
  } finally {
    await mongoose.connection.close();
  }
}

test();
