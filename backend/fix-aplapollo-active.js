import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);
console.log('✅ Connected to MongoDB\n');

const Stock = mongoose.model('Stock', new mongoose.Schema({}, { strict: false }));

// Update APLAPOLLO to set is_active: true
const result = await Stock.updateOne(
  { instrument_key: 'NSE_EQ|INE702C01019' },
  { $set: { is_active: true } }
);

console.log('Updated APLAPOLLO:', result.modifiedCount, 'document(s)');

// Verify
const stock = await Stock.findOne({
  instrument_key: 'NSE_EQ|INE702C01019',
  is_active: true
});

if (stock) {
  console.log('✅ APLAPOLLO now active:', stock.tradingsymbol);
} else {
  console.log('❌ Still not found with is_active: true');
}

// Also update ASHOKLEY just in case
const result2 = await Stock.updateOne(
  { instrument_key: 'NSE_EQ|INE208A01029' },
  { $set: { is_active: true } }
);

console.log('Updated ASHOKLEY:', result2.modifiedCount, 'document(s)');

await mongoose.disconnect();
console.log('\n✅ Done');
