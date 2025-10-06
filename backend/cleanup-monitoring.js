import { Queue } from 'bullmq';
import Redis from 'ioredis';

/**
 * Clean up all monitoring jobs and clear the queue
 */

async function cleanupMonitoring() {
    console.log('🧹 Cleaning up monitoring queue...');
    console.log('='.repeat(50));
    
    const connection = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD,
        maxRetriesPerRequest: null
    });
    
    const monitoringQueue = new Queue('trigger-monitoring', { connection });
    
    try {
        // 1. Get all repeatable jobs
        const repeatableJobs = await monitoringQueue.getRepeatableJobs();
        console.log(`📋 Found ${repeatableJobs.length} repeatable jobs`);
        
        // 2. Remove each repeatable job
        for (const job of repeatableJobs) {
            console.log(`   ❌ Removing job: ${job.id || job.key}`);
            await monitoringQueue.removeRepeatableByKey(job.key);
        }
        
        // 3. Clean completed jobs
        const completedCount = await monitoringQueue.clean(
            0,      // Grace period: 0 = immediate
            1000,   // Limit: max 1000 jobs
            'completed'
        );
        console.log(`   🗑️  Cleaned ${completedCount.length} completed jobs`);
        
        // 4. Clean failed jobs
        const failedCount = await monitoringQueue.clean(
            0,      // Grace period: 0 = immediate
            1000,   // Limit: max 1000 jobs
            'failed'
        );
        console.log(`   🗑️  Cleaned ${failedCount.length} failed jobs`);
        
        // 5. Clean waiting jobs
        const waitingJobs = await monitoringQueue.getJobs(['waiting']);
        console.log(`   🔍 Found ${waitingJobs.length} waiting jobs`);
        for (const job of waitingJobs) {
            await job.remove();
        }
        
        // 6. Clean delayed jobs
        const delayedJobs = await monitoringQueue.getJobs(['delayed']);
        console.log(`   🔍 Found ${delayedJobs.length} delayed jobs`);
        for (const job of delayedJobs) {
            await job.remove();
        }
        
        // 7. Clean active jobs (be careful with this)
        const activeJobs = await monitoringQueue.getJobs(['active']);
        console.log(`   ⚠️  Found ${activeJobs.length} active jobs`);
        
        // 8. Obliterate the queue completely (nuclear option)
        console.log('\n💣 Obliterating entire queue...');
        await monitoringQueue.obliterate({ force: true });
        
        console.log('\n✅ Queue cleanup complete!');
        console.log('   All monitoring jobs have been removed.');
        console.log('   The queue is now empty and ready for fresh jobs.');
        
    } catch (error) {
        console.error('❌ Cleanup failed:', error);
    } finally {
        await monitoringQueue.close();
        await connection.quit();
        console.log('\n👋 Cleanup process finished');
        process.exit(0);
    }
}

// Run cleanup
cleanupMonitoring();