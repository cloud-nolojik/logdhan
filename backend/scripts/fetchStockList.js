import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

// Define the Stock schema (matching the actual schema)
const stockSchema = new mongoose.Schema({
  instrument_key: String,
  exchange_token: String,
  trading_symbol: String,
  name: String,
  short_name: String,
  last_price: Number,
  expiry: Date,
  strike: Number,
  tick_size: Number,
  lot_size: Number,
  instrument_type: String,
  option_type: String,
  exchange: String,
  segment: String,
  isin: String,
  is_active: Boolean,
  search_keywords: [String]
});

const Stock = mongoose.model('Stock', stockSchema);

// List of stocks from the screenshots
const stockNames = [
  'Waaree Renewab.',
  'Ingersoll-Rand',
  'Page Industries',
  'IRCTC',
  'Ganesh Housing',
  'Natl. Aluminium',
  'Mazagon Dock',
  'Multi Comm. Exc.',
  'Triveni Turbine',
  'KPIT Technologi.',
  'Nippon Life Ind.',
  'Blue Jet Health',
  'Action Const.Eq.',
  'Bharat Electron',
  'ABB',
  'Inox India',
  'CG Power & Ind',
  'Dhanuka Agritech',
  'Kirl.Pneumatic',
  'eClerx Services',
  'Newgen Software',
  'Fiem Industries',
  'LTIMindtree',
  'TBO Tek',
  'Dodla Dairy',
  'Fine Organic',
  'Godfrey Phillips',
  'Blue Star',
  'Gabriel India',
  'Caplin Point Lab',
  'J B Chemicals &',
  'Schaeffler India',
  'Vesuvius India',
  'ICICI Lombard',
  'Varun Beverages',
  'Jyothy Labs',
  'Zydus Lifesci.',
  'KSB',
  'Hindustan Copper',
  'Siemens',
  'Godawari Power',
  'P I Industries',
  'Supreme Petroch.',
  'Dr Reddy\'s Labs',
  'APL Apollo Tubes',
  'Tube Investments',
  'Maruti Suzuki',
  'Gravita India',
  'Jupiter Wagons',
  'KEI Industries',
  'Birlasoft Ltd',
  'Grindwell Norton',
  'Transport Corp.',
  'ZF Commercial',
  'Poly Medicure'
];

// Simplified search terms for better matching
const searchTerms = [
  'WAAREE',
  'INGERSOLL',
  'PAGE',
  'IRCTC',
  'GANESH',
  'NALCO',
  'MAZAGON',
  'MCX',
  'TRIVENI',
  'KPIT',
  'NIPPON',
  'BLUEJET',
  'ACTION',
  'BEL',
  'ABB',
  'INOX',
  'CGPOWER',
  'DHANUKA',
  'KIRLPNU',
  'ECLERX',
  'NEWGEN',
  'FIEM',
  'LTIM',
  'TBO',
  'DODLA',
  'FINEORG',
  'GODFREY',
  'BLUESTAR',
  'GABRIEL',
  'CAPLIN',
  'JBCHEM',
  'SCHAEFFLER',
  'VESUVIUS',
  'ICICIGI',
  'VBL',
  'JYOTHY',
  'ZYDUS',
  'KSB',
  'HINDCOPPER',
  'SIEMENS',
  'GODAWARI',
  'PIIND',
  'SUPREME',
  'DRREDDY',
  'APLAPOLLO',
  'TIINDIA',
  'MARUTI',
  'GRAVITA',
  'JUPITER',
  'KEI',
  'BIRLASOFT',
  'GRINDWELL',
  'TCI',
  'ZFCVINDIA',
  'POLYMED'
];

async function fetchStockData() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');
    
    const stockData = [];
    const notFound = [];
    
    // Search for each stock
    for (let i = 0; i < searchTerms.length; i++) {
      const searchTerm = searchTerms[i];
      const originalName = stockNames[i];
      
      // Try to find the stock using various search strategies
      let stock = await Stock.findOne({
        $or: [
          { trading_symbol: searchTerm },
          { trading_symbol: new RegExp(searchTerm, 'i') },
          { name: new RegExp(searchTerm, 'i') },
          { short_name: new RegExp(searchTerm, 'i') }
        ],
        segment: { $in: ['NSE_EQ', 'BSE_EQ'] },
        is_active: true
      }).select('trading_symbol name instrument_key exchange segment');
      
      if (stock) {
        stockData.push({
          index: i + 1,
          originalName: originalName,
          trading_symbol: stock.trading_symbol,
          name: stock.name,
          instrument_key: stock.instrument_key,
          exchange: stock.exchange,
          segment: stock.segment
        });
        console.log(`✅ ${i + 1}. Found: ${stock.trading_symbol} - ${stock.instrument_key}`);
      } else {
        notFound.push({
          index: i + 1,
          originalName: originalName,
          searchTerm: searchTerm
        });
        console.log(`❌ ${i + 1}. Not found: ${originalName} (searched: ${searchTerm})`);
      }
    }
    
    // Output results as JSON array
    console.log('\n\n📊 STOCK DATA ARRAY:\n');
    console.log(JSON.stringify(stockData.map(s => ({
      symbol: s.trading_symbol,
      instrument_key: s.instrument_key,
      name: s.name
    })), null, 2));
    
    console.log('\n\n📈 SUMMARY:');
    console.log(`Total stocks searched: ${searchTerms.length}`);
    console.log(`Found: ${stockData.length}`);
    console.log(`Not found: ${notFound.length}`);
    
    if (notFound.length > 0) {
      console.log('\n❌ STOCKS NOT FOUND:');
      notFound.forEach(item => {
        console.log(`${item.index}. ${item.originalName} (searched: ${item.searchTerm})`);
      });
    }
    
    // Save to file for reference
    const fs = await import('fs');
    const outputPath = path.join(__dirname, 'stock_list_output.json');
    await fs.promises.writeFile(
      outputPath,
      JSON.stringify({
        found: stockData,
        notFound: notFound,
        summary: {
          total: searchTerms.length,
          found: stockData.length,
          notFound: notFound.length
        }
      }, null, 2)
    );
    console.log(`\n💾 Results saved to: ${outputPath}`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Disconnected from MongoDB');
  }
}

// Run the script
fetchStockData();