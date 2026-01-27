import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);
console.log('✅ Connected to MongoDB\n');

const Stock = mongoose.model('Stock', new mongoose.Schema({}, { strict: false }));

// Insert APLAPOLLO and ASHOKLEY
const stocks = [
  {
    instrument_key: 'NSE_EQ|INE702C01019',
    exchange_token: '702C01019',
    tradingsymbol: 'APLAPOLLO',
    name: 'APL APOLLO TUBES LIMITED',
    exchange: 'NSE',
    segment: 'NSE_EQ',
    instrument_type: 'EQ',
    isin: 'INE702C01019',
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    instrument_key: 'NSE_EQ|INE208A01029',
    exchange_token: '208A01029',
    tradingsymbol: 'ASHOKLEY',
    name: 'ASHOK LEYLAND LIMITED',
    exchange: 'NSE',
    segment: 'NSE_EQ',
    instrument_type: 'EQ',
    isin: 'INE208A01029',
    createdAt: new Date(),
    updatedAt: new Date()
  }
];

for (const stock of stocks) {
  const existing = await Stock.findOne({ instrument_key: stock.instrument_key });

  if (existing) {
    console.log(`✅ ${stock.tradingsymbol} already exists`);
  } else {
    await Stock.create(stock);
    console.log(`✅ Inserted ${stock.tradingsymbol}`);
  }
}

console.log('\n✅ Done');
await mongoose.disconnect();
