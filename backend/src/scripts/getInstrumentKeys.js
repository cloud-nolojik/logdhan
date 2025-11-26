/**
 * Script to fetch instrument details from MongoDB for given stock symbols
 * Usage: node src/scripts/getInstrumentKeys.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '../../.env') });

// Stock symbols to fetch (format: EXCHANGE:SYMBOL)
const stocksToFetch = [
'NSE:NATCOPHARM', 'BSE:FEDDERSHOL', 'NSE:VPRPL', 'NSE:CDSL', 'NSE:GOODLUCK',
'NSE:AHLUCONT', 'NSE:RATNAMANI', 'NSE:FINEORG', 'NSE:SURAJEST', 'NSE:KFINTECH',
'NSE:APARINDS', 'BSE:PANORAMA', 'NSE:NEWGEN', 'NSE:DHANUKA', 'NSE:GRSE',
'NSE:TCS', 'NSE:BLUESTARCO', 'NSE:SHARDAMOTR', 'NSE:TATASTEEL', 'NSE:MAZDOCK',
'NSE:POLYCAB', 'NSE:JIOFIN', 'NSE:RELIANCE', 'NSE:TITAN', 'NSE:GLENMARK',
'NSE:BSOFT', 'NSE:IRCTC', 'NSE:IGL', 'NSE:VEDL', 'NSE:NESTLEIND',
'NSE:TMPV', 'NSE:MANINFRA', 'NSE:HDFCBANK', 'NSE:SUPREMEIND', 'NSE:GRINDWELL',
'NSE:GPIL', 'NSE:INFY', 'NSE:MGL', 'NSE:KPITTECH', 'NSE:HINDALCO',
'NSE:MARUTI', 'NSE:JWL', 'NSE:MONARCH', 'NSE:GANESHHOU', 'NSE:DOLATALGO',
'NSE:TITAGARH', 'NSE:MANKIND', 'NSE:GEOJITFSL', 'NSE:JBCHEPHARM', 'NSE:LTIM',
'NSE:DRREDDY', 'NSE:TIMKEN', 'BSE:NIBE', 'NSE:SONACOMS', 'NSE:BEL',
'NSE:AJANTPHARM', 'NSE:SENCO', 'NSE:NESCO', 'NSE:ACE', 'NSE:VOLTAMP',
'NSE:KRYSTAL', 'NSE:VESUVIUS', 'NSE:ASIANPAINT', 'NSE:WSTCSTPAPR', 'NSE:BLS',
'NSE:TRITURBINE', 'NSE:RADHIKAJWE', 'NSE:PERSISTENT', 'NSE:BIKAJI', 'NSE:TIINDIA',
'NSE:KEI', 'NSE:GUJGASLTD', 'NSE:ACI', 'NSE:LIKHITHA', 'NSE:DEEPAKNTR',
'NSE:ASTRAL', 'NSE:INDOTHAI', 'NSE:CAPLIPOINT', 'NSE:PGHL', 'NSE:ECLERX',
'NSE:BAYERCROP', 'NSE:WCIL', 'NSE:BERGEPAINT', 'NSE:SPLPETRO', 'NSE:GODFRYPHLP',
'NSE:BASF', 'NSE:CLEAN', 'NSE:HAPPYFORGE', 'NSE:PIIND', 'NSE:POLYMED',
'NSE:COROMANDEL', 'NSE:INGERRAND', 'NSE:KSB', 'NSE:CREATIVE', 'NSE:MAHSEAMLES',
'NSE:ROUTE', 'NSE:INDIAMART'];

async function connectDB() {
  try {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI not found in environment variables');
    }
    await mongoose.connect(mongoUri);

  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1);
  }
}

async function getInstrumentDetails() {
  const db = mongoose.connection.db;
  const stocksCollection = db.collection('stocks');

  const results = [];
  const notFound = [];

  for (const stockStr of stocksToFetch) {
    const [exchange, symbol] = stockStr.split(':');

    // Build query - match exchange and trading_symbol
    const query = {
      exchange: exchange,
      trading_symbol: symbol,
      is_active: true
    };

    const stock = await stocksCollection.findOne(query);

    if (stock) {
      results.push({
        instrument_key: stock.instrument_key,
        trading_symbol: stock.trading_symbol,
        name: stock.name,
        exchange: stock.exchange
      });
    } else {
      notFound.push(stockStr);
    }
  }

  return { results, notFound };
}

async function main() {
  await connectDB();

  const { results, notFound } = await getInstrumentDetails();

  // Output the JSON array

  if (notFound.length > 0) {

  }

  await mongoose.connection.close();

}

main().catch(console.error);