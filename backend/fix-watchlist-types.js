import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);
console.log('✅ Connected to MongoDB\n');

const db = mongoose.connection.db;
const collection = db.collection('weeklywatchlists');

// Find the watchlist
const watchlist = await collection.findOne({ week_label: '26 Jan - 30 Jan 2026' });

if (!watchlist) {
  console.log('❌ Watchlist not found');
  process.exit(1);
}

console.log('Found watchlist. Current types:');
console.log('  week_start type:', typeof watchlist.week_start);
console.log('  week_end type:', typeof watchlist.week_end);
console.log('  week_start value:', watchlist.week_start);

if (typeof watchlist.week_start === 'string') {
  console.log('\n⚠️  Dates are stored as strings - fixing...\n');

  // Update with proper Date objects
  const result = await collection.updateOne(
    { _id: watchlist._id },
    {
      $set: {
        week_start: new Date('2026-01-26T00:00:00.000Z'),
        week_end: new Date('2026-01-30T23:59:59.999Z'),
        createdAt: new Date('2026-01-27T10:30:00.000Z'),
        updatedAt: new Date('2026-01-27T10:30:00.000Z'),
        screening_run_at: new Date('2026-01-27T10:30:00.000Z'),
        'stocks.0.added_at': new Date('2026-01-27T10:30:00.000Z'),
        'stocks.1.added_at': new Date('2026-01-27T10:30:00.000Z')
      }
    }
  );

  console.log('✅ Updated:', result.modifiedCount, 'document(s)');
} else {
  console.log('\n✅ Dates are already proper Date objects');
}

// Verify the fix
const fixed = await collection.findOne({ week_label: '26 Jan - 30 Jan 2026' });
console.log('\nAfter fix:');
console.log('  week_start type:', typeof fixed.week_start);
console.log('  week_start instanceof Date:', fixed.week_start instanceof Date);
console.log('  week_start value:', fixed.week_start);

// Test the query that getCurrentWeek uses
const now = new Date();
const testResult = await collection.findOne({
  week_start: { $lte: now },
  week_end: { $gte: now },
  status: 'ACTIVE'
});

console.log('\n🔍 Testing getCurrentWeek query:');
console.log('  Result:', testResult ? `✅ FOUND - ${testResult.week_label}` : '❌ NOT FOUND');
if (testResult) {
  console.log('  Stocks:', testResult.stocks.length);
  testResult.stocks.forEach(s => console.log(`    - ${s.symbol}`));
}

await mongoose.disconnect();
console.log('\n✅ Done');
