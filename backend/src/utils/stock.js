import { fileURLToPath } from 'url';
import path from 'path';
import { promises as fs } from 'fs';
import axios from 'axios';

const API_KEY = '5d2c7442-7ce9-44b3-a0df-19c110d72262';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let nseStocks = null;
let bseStocks = null;

// Load stock data from JSON files into memory
async function loadStockData() {
  try {
    const nseData = await fs.readFile(path.join(__dirname, '../data/NSE.json'), 'utf8');
    const bseData = await fs.readFile(path.join(__dirname, '../data/BSE.json'), 'utf8');
    nseStocks = JSON.parse(nseData);
    bseStocks = JSON.parse(bseData);
    console.log('Stock data loaded successfully');
  } catch (error) {
    console.error('Error loading stock data:', error);
    throw error;
  }
}

// Preload data
loadStockData().catch(console.error);

// Helper: Match scoring logic
function calculateMatchScore(searchTerm, stock) {
  const term = searchTerm.toLowerCase().replace(/\s+/g, '');
  let score = 0;

  const underlying = stock.underlying_symbol?.toLowerCase() || '';
  const symbol = stock.trading_symbol?.toLowerCase() || '';
  const name = stock.name?.replace(/\s+/g, '').toLowerCase() || '';

  if (underlying === term) score += 100;
  else if (symbol === term) score += 90;

  if (underlying.includes(term)) score += 50;
  if (symbol.includes(term)) score += 40;

  if (underlying.startsWith(term)) score += 30;
  if (symbol.startsWith(term)) score += 25;

  if (name.includes(term)) score += 10;

  return score;
}

// Helper: Search stocks
export async function searchStocks(searchTerm) {
  const pattern = new RegExp(searchTerm.replace(/\s+/g, ''), 'i');

  const nseMatches = nseStocks.filter(s =>
    (pattern.test(s.trading_symbol) || pattern.test(s.underlying_symbol) || pattern.test(s.name.replace(/\s+/g, ''))) && s.segment === "NSE_EQ" && s.instrument_type === "EQ"
  ).map(s => ({
    ...s,
    exchange: 'NSE',
    matchScore: calculateMatchScore(searchTerm, s)
  }));

  const bseMatches = bseStocks.filter(s =>
    (pattern.test(s.trading_symbol) || pattern.test(s.underlying_symbol) || pattern.test(s.name.replace(/\s+/g, ''))) && s.segment === "BSE_EQ" && s.instrument_type === "EQ"   
  ).map(s => ({
    ...s,
    exchange: 'BSE',
    matchScore: calculateMatchScore(searchTerm, s)
  }));

  const allMatches = [...nseMatches, ...bseMatches].sort((a, b) => b.matchScore - a.matchScore);

  return { allMatches: allMatches };
}

// Helper: Exact stock fetch
export async function getExactStock(instrumentKey) {
  // First check NSE stocks
  let stock = nseStocks.find(s => s.instrument_key === instrumentKey);
  if (stock) {
    return { ...stock, exchange: 'NSE' };
  }


  // Then check BSE stocks
  stock = bseStocks.find(s => s.instrument_key === instrumentKey);
  if (stock) {
    return { ...stock, exchange: 'BSE' };
  }

  //

  return null;
}

// Export other utility functions that might be needed
export async function validateStock(instrumentKey) {
  const stock = await getExactStock(instrumentKey);
  return stock !== null;
}

export async function getCurrentPrice(instrumentKey,sendCandles = false) {
  const currentDate = new Date();
  const previousDay = new Date(currentDate); 
  previousDay.setDate(currentDate.getDate() - 3);
  const currentDayFormattedDate = getFormattedDate(currentDate);
  const previousDayFormattedDate = getFormattedDate(previousDay);

  const axiosConfig = {
    headers: {
      'Accept': 'application/json',
      'x-api-key': API_KEY
    },
    timeout: 15000 // Increased to 15 second timeout for better reliability
  };

  try {
    // Try both encoded and non-encoded instrument keys
    const encodedInstrumentKey = encodeURIComponent(instrumentKey);
    
    // Use correct API endpoints based on official documentation
    const apiFormats = [
      // Format 1: Current day intraday data (no date params needed)
      {
        name: 'v3-intraday-current',
        url: `https://api.upstox.com/v3/historical-candle/intraday/${instrumentKey}/minutes/1`
      },
      // Format 2: Historical data with date range (for non-trading days)
      {
        name: 'v3-historical-with-dates',
        url: `https://api.upstox.com/v3/historical-candle/${instrumentKey}/minutes/1/${currentDayFormattedDate}/${previousDayFormattedDate}`
      },
      // Format 3: Just today's data with to_date
      // {
      //   name: 'v3-today-only',
      //   url: `https://api.upstox.com/v3/historical-candle/${instrumentKey}/minutes/1?${previousDayFormattedDate}/${currentDayFormattedDate}`
      // }
    ];

    for (const format of apiFormats) {
      try {
       // console.log(`Trying ${format.name} API for ${instrumentKey}...`);
        
        const response = await axios.get(format.url, axiosConfig);
        const candles = response.data?.data?.candles || [];
        
        if (candles.length > 0) {
          if (sendCandles) {
           // console.log(`✅ Success with ${format.name} - Returning ${candles.length} candles for ${instrumentKey}`);
            return candles;
          } else {
            const latest = candles[0]; // last candle
            const currentPrice = latest ? latest[4] : null; // close price
           // console.log(`✅ Success with ${format.name} - Price for ${instrumentKey}: ${currentPrice}`);
            return currentPrice;
          }
        } else {
          console.log(`${format.name} returned no candles for ${instrumentKey}`);
        }
      } catch (apiError) {
        // Only log errors for debugging, don't spam console in production
        if (apiError.response?.status !== 400) {
          console.log(`❌ ${format.name} failed for ${instrumentKey}: ${apiError.response?.status} - ${apiError.response?.data?.message || apiError.message}`);
        }
        
        // Continue to next format without detailed logging for 400 errors
        continue;
      }
    }

    return null;

  } catch (error) {
    console.error(`Unexpected error fetching current price for ${instrumentKey}:`, error.message);
    if (error.code === 'ECONNABORTED') {
      console.error(`Request timeout for ${instrumentKey}`);
    }
    return null;
  }
}

function getFormattedDate(date) {
  return date.toISOString().split('T')[0];
}


export async function getStockExchange(instrumentKey) {
  const stock = await getExactStock(instrumentKey);
  return stock ? stock.exchange : null;
}

// Export the loadStockData function in case it needs to be called explicitly
export { loadStockData };

    
