/**
 * Cleanup Script for Old Agenda Jobs
 * 
 * This script removes all the unwanted Agenda jobs from MongoDB:
 * - daily-data-prefetch
 * - chart-cleanup 
 * - send-daily-reauth-reminders
 * - check-expired-sessions
 * - send-individual-reminder
 * - send-session-expired-notification
 */

import mongoose from 'mongoose';
import './src/loadEnv.js';

async function cleanupOldAgendaJobs() {
    try {
        console.log('🧹 Starting cleanup of old Agenda jobs...');
        
        // Connect to MongoDB
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('✅ Connected to MongoDB');
        
        const db = mongoose.connection.db;
        const collection = db.collection('monitoring_jobs');
        
        // List of jobs to remove
        const jobsToRemove = [
            'daily-data-prefetch',
            'chart-cleanup',
            'send-daily-reauth-reminders', 
            'check-expired-sessions',
            'send-individual-reminder',
            'send-session-expired-notification'
        ];
        
        console.log(`🎯 Target jobs for removal: ${jobsToRemove.join(', ')}`);
        
        // Get current job count
        const totalJobsBefore = await collection.countDocuments();
        console.log(`📊 Total jobs before cleanup: ${totalJobsBefore}`);
        
        // Remove unwanted jobs
        const result = await collection.deleteMany({
            name: { $in: jobsToRemove }
        });
        
        console.log(`🗑️ Removed ${result.deletedCount} unwanted jobs`);
        
        // Get remaining jobs
        const remainingJobs = await collection.find().toArray();
        console.log(`📊 Total jobs after cleanup: ${remainingJobs.length}`);
        
        if (remainingJobs.length > 0) {
            console.log('\\n📋 Remaining jobs:');
            remainingJobs.forEach((job, idx) => {
                const nextRun = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'}) : 'No schedule';
                console.log(`   ${idx + 1}. ${job.name}`);
                console.log(`      ├─ ID: ${job._id}`);
                console.log(`      ├─ Next Run: ${nextRun}`);
                console.log(`      └─ Repeat: ${job.repeatInterval || 'One-time'}`);
            });
        }
        
        console.log('\\n✅ Cleanup completed successfully!');
        console.log('\\n🎯 Optimal Agenda Architecture:');
        console.log('   ✅ check-triggers-batch (every 15 minutes) - NEW HYBRID BATCH');
        console.log('   ✅ cleanup-stale-locks (every 5 minutes)');
        console.log('   ✅ manual-data-prefetch (on-demand)');
        console.log('   ✅ current-day-prefetch (on-demand)');
        console.log('   ✅ trigger-analysis (on-demand)');
        console.log('\\n🗑️ Removed unnecessary jobs:');
        jobsToRemove.forEach(job => console.log(`   ❌ ${job}`));
        
    } catch (error) {
        console.error('❌ Cleanup failed:', error);
    } finally {
        await mongoose.disconnect();
        console.log('\\n🔌 Disconnected from MongoDB');
        process.exit(0);
    }
}

// Run cleanup
cleanupOldAgendaJobs();