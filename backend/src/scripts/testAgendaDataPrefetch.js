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
        console.log('🧪 Testing Agenda Data Pre-fetch Service...');
        
        // Connect to database
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');

        // Initialize the service
        await agendaDataPrefetchService.initialize();
        console.log('✅ Agenda Data Pre-fetch Service initialized');

        // Test 1: Get job statistics
        console.log('\n📊 Test 1: Getting job statistics...');
        const jobStats = await agendaDataPrefetchService.getJobStats();
        console.log('Job Statistics:', JSON.stringify(jobStats, null, 2));

        // Test 2: System health monitoring removed - manual monitoring preferred
        console.log('\n🏥 Test 2: System health monitoring removed - use manual tools');

        // Test 3: Manually trigger a data pre-fetch job
        console.log('\n🔄 Test 3: Manually triggering data pre-fetch job...');
        try {
            const triggerResult = await agendaDataPrefetchService.triggerJob('manual-data-prefetch', {
                reason: 'Test script manual trigger',
                targetDate: new Date().toISOString()
            });
            console.log('Trigger Result:', JSON.stringify(triggerResult, null, 2));
        } catch (triggerError) {
            console.log('Expected trigger error (job may already be running):', triggerError.message);
        }

        // Test 4: Manually trigger cache cleanup
        console.log('\n🧹 Test 4: Manually triggering cache cleanup...');
        try {
            const cleanupResult = await agendaDataPrefetchService.triggerJob('cache-cleanup', {
                reason: 'Test script cache cleanup'
            });
            console.log('Cleanup Result:', JSON.stringify(cleanupResult, null, 2));
        } catch (cleanupError) {
            console.log('Expected cleanup error (job may already be running):', cleanupError.message);
        }

        // Test 5: Check scheduled jobs
        console.log('\n📅 Test 5: Checking scheduled recurring jobs...');
        const finalJobStats = await agendaDataPrefetchService.getJobStats();
        console.log('Scheduled Jobs:');
        finalJobStats.jobs.forEach(job => {
            console.log(`   - ${job.name}: Total=${job.total}, Scheduled=${job.scheduled}, Running=${job.running}, Completed=${job.completed}, Failed=${job.failed}`);
        });

        // Wait a bit to see job processing
        console.log('\n⏳ Waiting 10 seconds to observe job processing...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Final stats
        console.log('\n📈 Final Statistics:');
        const finalStats = await agendaDataPrefetchService.getJobStats();
        console.log('Service Stats:', JSON.stringify(finalStats.summary, null, 2));

        console.log('\n✅ All tests completed successfully!');
        console.log('\nNote: The service will continue running scheduled jobs in the background.');
        console.log('Scheduled Jobs:');
        console.log('   - Daily Data Pre-fetch: 1:00 AM IST (weekdays)');
        console.log('   - Cache Cleanup: 2:00 AM IST (daily)');
        console.log('   - Job Status Cleanup: 3:00 AM IST (Sundays)');
        console.log('   - System Health Check: Every 6 hours');

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        console.log('\n🛑 Stopping service and closing connection...');
        
        try {
            await agendaDataPrefetchService.stop();
            await mongoose.connection.close();
            console.log('🔌 Service stopped and disconnected from MongoDB');
        } catch (stopError) {
            console.error('❌ Error during cleanup:', stopError);
        }
        
        // Force exit since Agenda might keep process alive
        setTimeout(() => {
            console.log('🚪 Force exiting...');
            process.exit(0);
        }, 2000);
    }
}

// Check if this is being run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    testAgendaService().catch(console.error);
}

export default testAgendaService;