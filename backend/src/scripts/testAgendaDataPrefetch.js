#!/usr/bin/env node

/**
 * Test script for Agenda Data Pre-fetch Service
 * Usage: node src/scripts/testAgendaDataPrefetch.js
 */

import './loadEnv.js';
import mongoose from 'mongoose';
import agendaDataPrefetchService from '../services/agendaDataPrefetchService.js';

async function testAgendaService() {
  try {

    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI);

    // Initialize the service
    await agendaDataPrefetchService.initialize();

    // Test 1: Get job statistics

    const jobStats = await agendaDataPrefetchService.getJobStats();

    // Test 2: System health monitoring removed - manual monitoring preferred

    // Test 3: Manually trigger a data pre-fetch job

    try {
      const triggerResult = await agendaDataPrefetchService.triggerJob('manual-data-prefetch', {
        reason: 'Test script manual trigger',
        targetDate: new Date().toISOString()
      });

    } catch (triggerError) {

    }

    // Test 4: Manually trigger cache cleanup

    try {
      const cleanupResult = await agendaDataPrefetchService.triggerJob('cache-cleanup', {
        reason: 'Test script cache cleanup'
      });

    } catch (cleanupError) {

    }

    // Test 5: Check scheduled jobs

    const finalJobStats = await agendaDataPrefetchService.getJobStats();

    finalJobStats.jobs.forEach((job) => {

    });

    // Wait a bit to see job processing

    await new Promise((resolve) => setTimeout(resolve, 10000));

    // Final stats

    const finalStats = await agendaDataPrefetchService.getJobStats();

  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {

    try {
      await agendaDataPrefetchService.stop();
      await mongoose.connection.close();

    } catch (stopError) {
      console.error('❌ Error during cleanup:', stopError);
    }

    // Force exit since Agenda might keep process alive
    setTimeout(() => {

      process.exit(0);
    }, 2000);
  }
}

// Check if this is being run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testAgendaService().catch(console.error);
}

export default testAgendaService;