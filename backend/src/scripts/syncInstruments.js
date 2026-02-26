/**
 * Manual instrument key sync
 *
 * Usage: node src/scripts/syncInstruments.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

import { runSync } from '../services/instrumentSync.service.js';

async function main() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB\n');
    await runSync();
  } catch (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

main();
