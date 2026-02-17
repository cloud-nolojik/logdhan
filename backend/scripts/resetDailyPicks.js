#!/usr/bin/env node

/**
 * Reset today's daily picks to PENDING so you can re-trigger ORB collection.
 *
 * Usage:
 *   node backend/scripts/resetDailyPicks.js
 *
 * Then trigger ORB collection:
 *   curl -X POST https://logdhan.com/api/daily-picks/orb-collect
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI not set in .env');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  // Find today's doc
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const doc = await db.collection('dailypicks').findOne({
    createdAt: { $gte: today }
  });

  if (!doc) {
    console.log('No DailyPick doc found for today.');
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log(`Found doc ${doc._id} with ${doc.picks.length} picks:`);
  for (const pick of doc.picks) {
    console.log(`  ${pick.symbol} — status: ${pick.trade.status}, kite: ${pick.kite.kite_status}`);
  }

  // Build $set for all picks
  const setFields = {};
  for (let i = 0; i < doc.picks.length; i++) {
    setFields[`picks.${i}.trade.status`] = 'PENDING';
    setFields[`picks.${i}.trade.exit_reason`] = null;
    setFields[`picks.${i}.kite.kite_status`] = 'pending';
    setFields[`picks.${i}.validation`] = null;
    setFields[`picks.${i}.orb`] = null;
  }

  const result = await db.collection('dailypicks').updateOne(
    { _id: doc._id },
    { $set: setFields }
  );

  console.log(`\nReset ${result.modifiedCount ? doc.picks.length : 0} picks to PENDING.`);

  // Verify
  const updated = await db.collection('dailypicks').findOne({ _id: doc._id });
  for (const pick of updated.picks) {
    console.log(`  ${pick.symbol} — status: ${pick.trade.status}`);
  }

  await mongoose.disconnect();
  console.log('\nDone. Now trigger ORB collection to test.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
