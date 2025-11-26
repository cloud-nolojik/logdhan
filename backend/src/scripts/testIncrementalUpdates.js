#!/usr/bin/env node

/**
 * Test script for incremental data updates
 * Usage: node src/scripts/testIncrementalUpdates.js
 */

import './loadEnv.js';
import mongoose from 'mongoose';
import dailyDataPrefetchService from '../services/dailyDataPrefetch.service.js';
import PreFetchedData from '../models/preFetchedData.js';

async function testIncrementalUpdates() {
  try {

    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI);

    // Test data
    const testStock = {
      instrument_key: 'NSE_EQ|INE002A01018', // Reliance
      stock_symbol: 'RELIANCE',
      stock_name: 'Reliance Industries Limited'
    };

    // Check existing data
    const existing = await PreFetchedData.findOne({
      instrument_key: testStock.instrument_key,
      timeframe: '1d'
    });

    if (existing) {

    } else {

    }

    // Run update for this specific stock
    const result = await dailyDataPrefetchService.updateExistingData(
      testStock,
      '1d',
      existing
    );

    if (result.error) {

    }

    // Show updated data
    const updated = await PreFetchedData.findOne({
      instrument_key: testStock.instrument_key,
      timeframe: '1d'
    });

    if (updated) {

    }

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    await mongoose.connection.close();

  }
}

// Run the test
testIncrementalUpdates();