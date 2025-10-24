import Agenda from 'agenda';
import dailyDataPrefetchService from './dailyDataPrefetch.service.js';
import DailyJobStatus from '../models/dailyJobStatus.js';
import MarketTiming from '../models/marketTiming.js';

/**
 * Agenda-based Data Pre-fetch Service
 * Handles daily data pre-fetching, cache cleanup, and system health monitoring
 * Uses MongoDB for job persistence and scheduling
 */
class AgendaDataPrefetchService {
    constructor() {
        this.agenda = null;
        this.isInitialized = false;
        this.stats = {
            dataPrefetchJobs: 0,
            successfulJobs: 0,
            failedJobs: 0
        };
    }

    async initialize() {
        if (this.isInitialized) {
            console.log('⚠️ [AGENDA DATA] Service already initialized');
            return;
        }

        try {
            console.log('🚀 [AGENDA DATA] Initializing Agenda data pre-fetch service...');

            // Use existing MongoDB connection
            const mongoUrl = process.env.MONGODB_URI;
            this.agenda = new Agenda({ 
                db: { 
                    address: mongoUrl,
                    collection: 'data_prefetch_jobs',
                    options: {
                        useUnifiedTopology: true
                    }
                },
                processEvery: '1 minute',
                maxConcurrency: 5,
                defaultConcurrency: 2
            });

            // Define all job types
            this.defineJobs();

            // Handle job events
            this.setupEventHandlers();

            // Start agenda
            await this.agenda.start();

            // Schedule recurring jobs
            await this.scheduleRecurringJobs();

            this.isInitialized = true;
            console.log('✅ [AGENDA DATA] Service initialized successfully');

        } catch (error) {
            console.error('❌ [AGENDA DATA] Failed to initialize service:', error);
            throw error;
        }
    }

    /**
     * Define all job types
     */
    defineJobs() {
        // Daily data pre-fetch job
        this.agenda.define('daily-data-prefetch', async (job) => {
            console.log('🌅 [AGENDA DATA] Starting daily data pre-fetch job');
            this.stats.dataPrefetchJobs++;
            
            try {
                const result = await dailyDataPrefetchService.runDailyPrefetch();
                
                if (result.success) {
                    console.log('✅ [AGENDA DATA] Daily data pre-fetch completed successfully');
                    console.log(`📊 [AGENDA DATA] Job summary: ${result.job?.summary?.unique_stocks || 0} stocks, ${result.job?.summary?.total_bars_fetched || 0} bars`);
                    this.stats.successfulJobs++;
                } else {
                    console.log(`⚠️ [AGENDA DATA] Daily data pre-fetch skipped: ${result.reason}`);
                    this.stats.successfulJobs++;
                }
                
            } catch (error) {
                console.error('❌ [AGENDA DATA] Daily data pre-fetch failed:', error);
                this.stats.failedJobs++;
                
                // Log error to job status for monitoring
                try {
                    const errorJob = DailyJobStatus.createJob(new Date(), 'data_prefetch', 0);
                    errorJob.markFailed(`Agenda job error: ${error.message}`);
                    await errorJob.save();
                } catch (logError) {
                    console.error('❌ [AGENDA DATA] Failed to log error to job status:', logError);
                }
                
                throw error;
            }
        });

        // Note: Cache cleanup removed - MongoDB TTL index handles this automatically and more efficiently

        // Note: Job status cleanup removed - MongoDB TTL indexes handle this automatically
        // Note: System health check removed - manual monitoring preferred

        // Chart cleanup job (moved from setInterval in index.js)
        this.agenda.define('chart-cleanup', async (job) => {
            console.log('🗑️ [AGENDA DATA] Starting chart cleanup job');
            
            try {
                let azureStorageService;
                try {
                    const azureModule = await import('../storage/azureStorage.service.js');
                    azureStorageService = azureModule.azureStorageService || azureModule.default;
                } catch (importError) {
                    console.log('⚠️ [AGENDA DATA] Azure storage service not available, skipping cloud cleanup');
                    azureStorageService = null;
                }
                
                const path = await import('path');
                const fs = await import('fs');
                
                // Clean up local files
                const chartDir = path.join(process.cwd(), 'temp', 'charts');
                let localFilesDeleted = 0;
                
                if (fs.existsSync(chartDir)) {
                    const files = fs.readdirSync(chartDir);
                    const now = Date.now();
                    const oneHour = 60 * 60 * 1000;
                    
                    files.forEach(file => {
                        const filePath = path.join(chartDir, file);
                        try {
                            const stats = fs.statSync(filePath);
                            
                            if (now - stats.mtime.getTime() > oneHour) {
                                if (fs.existsSync(filePath)) {
                                    fs.unlinkSync(filePath);
                                    localFilesDeleted++;
                                    console.log(`🗑️ [AGENDA DATA] Cleaned up old local chart: ${file}`);
                                }
                            }
                        } catch (fileError) {
                            if (fileError.code !== 'ENOENT') {
                                console.warn(`⚠️ [AGENDA DATA] Could not clean up ${file}:`, fileError.message);
                            }
                        }
                    });
                }
                
                // Clean up Azure storage
                if (azureStorageService) {
                    try {
                        await azureStorageService.cleanupOldCharts(24);
                        console.log('✅ [AGENDA DATA] Azure chart cleanup completed');
                    } catch (azureError) {
                        console.warn('⚠️ [AGENDA DATA] Azure chart cleanup failed:', azureError.message);
                    }
                } else {
                    console.log('⚠️ [AGENDA DATA] Skipping Azure cleanup - service not available');
                }
                
                console.log(`✅ [AGENDA DATA] Chart cleanup completed: ${localFilesDeleted} local files deleted`);
                this.stats.successfulJobs++;
                
            } catch (error) {
                console.error('❌ [AGENDA DATA] Chart cleanup failed:', error);
                this.stats.failedJobs++;
                throw error;
            }
        });

        // Manual trigger job (for testing and admin purposes)
        this.agenda.define('manual-data-prefetch', async (job) => {
            const { targetDate, reason } = job.attrs.data;
            console.log(`🔄 [AGENDA DATA] Manual data pre-fetch triggered: ${reason || 'No reason provided'}`);
            
            try {
                const result = await dailyDataPrefetchService.runDailyPrefetch(targetDate ? new Date(targetDate) : null);
                console.log(`✅ [AGENDA DATA] Manual data pre-fetch completed: ${JSON.stringify(result)}`);
                this.stats.successfulJobs++;
                
            } catch (error) {
                console.error('❌ [AGENDA DATA] Manual data pre-fetch failed:', error);
                this.stats.failedJobs++;
                throw error;
            }
        });

        // Current day data pre-fetch job (runs after 4:00 PM on trading days)
        this.agenda.define('current-day-prefetch', async (job) => {
            console.log('🌆 [AGENDA DATA] Starting current day data pre-fetch job');
            
            try {
                const result = await dailyDataPrefetchService.runCurrentDayPrefetch();
                
                if (result.success) {
                    console.log('✅ [AGENDA DATA] Current day data pre-fetch completed successfully');
                    console.log(`📊 [AGENDA DATA] Current day summary: ${result.results?.successCount || 0} stocks, ${result.results?.totalBars || 0} bars`);
                    this.stats.successfulJobs++;
                } else {
                    console.log(`⚠️ [AGENDA DATA] Current day data pre-fetch skipped: ${result.reason}`);
                    this.stats.successfulJobs++;
                }
                
            } catch (error) {
                console.error('❌ [AGENDA DATA] Current day data pre-fetch failed:', error);
                this.stats.failedJobs++;
                throw error;
            }
        });

        // NEW: AI Analysis trigger job (runs at 4:30 PM after data is ready)
        this.agenda.define('trigger-analysis', async (job) => {
            console.log('🧠 [AGENDA DATA] Starting AI analysis trigger job at 4:30 PM');
            
            try {
                // Import the analysis service dynamically to avoid circular dependency
                const { default: aiAnalyzeService } = await import('./aiAnalyze.service.js');
                
                // Get list of recently analyzed stocks for re-analysis
                const StockAnalysis = (await import('../models/stockAnalysis.js')).default;
                
                // Find analyses from the last 7 days to refresh with new EOD data
                const recentAnalyses = await StockAnalysis.find({
                    created_at: { 
                        $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
                    },
                    status: 'completed'
                }).distinct('instrument_key');
                
                console.log(`🔄 [AGENDA DATA] Found ${recentAnalyses.length} stocks for re-analysis with fresh EOD data`);
                
                // Trigger fresh analysis for each stock (this will use the latest data from 4:00-4:05 PM fetch)
                let successCount = 0;
                let errorCount = 0;
                
                for (const instrumentKey of recentAnalyses.slice(0, 20)) { // Limit to 20 stocks to avoid overload
                    try {
                        // This will create fresh analysis with the updated EOD data
                        console.log(`📊 [AGENDA DATA] Triggering fresh analysis for ${instrumentKey}`);
                        
                        // Note: We're not waiting for completion to avoid timeouts
                        // The analysis will run in background and send WhatsApp when complete
                        aiAnalyzeService.generateStockAnalysisWithPayload({
                            instrument_key: instrumentKey,
                            analysis_type: 'swing',
                            force_fresh: true // Force fresh analysis with new EOD data
                        }).catch(error => {
                            console.error(`❌ [AGENDA DATA] Analysis failed for ${instrumentKey}:`, error.message);
                        });
                        
                        successCount++;
                        
                        // Small delay to avoid overwhelming the system
                        await new Promise(resolve => setTimeout(resolve, 100));
                        
                    } catch (error) {
                        console.error(`❌ [AGENDA DATA] Failed to trigger analysis for ${instrumentKey}:`, error.message);
                        errorCount++;
                    }
                }
                
                console.log(`✅ [AGENDA DATA] AI analysis trigger completed: ${successCount} triggered, ${errorCount} errors`);
                console.log(`📱 [AGENDA DATA] Users will receive WhatsApp notifications as analyses complete`);
                this.stats.successfulJobs++;
                
            } catch (error) {
                console.error('❌ [AGENDA DATA] AI analysis trigger failed:', error);
                this.stats.failedJobs++;
                throw error;
            }
        });
    }

    /**
     * Setup event handlers for monitoring
     */
    setupEventHandlers() {
        this.agenda.on('ready', () => {
            console.log('🎯 [AGENDA DATA] Agenda data pre-fetch service ready');
        });

        this.agenda.on('start', (job) => {
            console.log(`🔄 [AGENDA DATA] Job started: ${job.attrs.name}`);
        });

        this.agenda.on('complete', (job) => {
            console.log(`✅ [AGENDA DATA] Job completed: ${job.attrs.name}`);
        });

        this.agenda.on('fail', (err, job) => {
            console.error(`❌ [AGENDA DATA] Job failed: ${job.attrs.name}`, err);
        });

        this.agenda.on('error', (err) => {
            console.error('❌ [AGENDA DATA] Agenda error:', err);
        });
    }

    /**
     * Schedule all recurring jobs
     */
    async scheduleRecurringJobs() {
        try {
            // Cancel any existing recurring jobs to avoid duplicates
            await this.agenda.cancel({
                name: { $in: ['daily-data-prefetch', 'chart-cleanup', 'current-day-prefetch', 'trigger-analysis'] }
            });

            // UPDATED: Daily data pre-fetch: 4:00 PM IST on weekdays (right at market close)
            // Better timing: get fresh EOD data immediately after market close
            await this.agenda.every('0 16 * * 1-5', 'daily-data-prefetch', {}, {
                timezone: 'Asia/Kolkata'
            });
            console.log('📅 [AGENDA DATA] Scheduled daily data pre-fetch for 4:00 PM IST (market close)');

            // Current day data pre-fetch: 4:05 PM IST on weekdays (after market close)
            await this.agenda.every('5 16 * * 1-5', 'current-day-prefetch', {}, {
                timezone: 'Asia/Kolkata'
            });
            console.log('📅 [AGENDA DATA] Scheduled current day data pre-fetch for 4:05 PM IST (append intraday data)');

            // NEW: AI Analysis trigger: 4:30 PM IST on weekdays (start analysis with fresh data)
            await this.agenda.every('30 16 * * 1-5', 'trigger-analysis', {}, {
                timezone: 'Asia/Kolkata'
            });
            console.log('📅 [AGENDA DATA] Scheduled AI analysis trigger for 4:30 PM IST (post-market analysis)');

            // Chart cleanup: Every hour
            await this.agenda.every('0 * * * *', 'chart-cleanup', {}, {
                timezone: 'Asia/Kolkata'
            });
            console.log('📅 [AGENDA DATA] Scheduled chart cleanup for every hour');
            
            console.log('📝 [AGENDA DATA] Note: AI cache cleanup handled by MongoDB TTL index automatically');

        } catch (error) {
            console.error('❌ [AGENDA DATA] Failed to schedule recurring jobs:', error);
            throw error;
        }
    }

    // Note: getSystemHealthStats method removed - manual monitoring preferred

    /**
     * Manually trigger a job (for testing and admin purposes)
     */
    async triggerJob(jobName, data = {}) {
        try {
            console.log(`🔄 [AGENDA DATA] Manually triggering job: ${jobName}`);
            
            const job = await this.agenda.now(jobName, data);
            console.log(`▶️ [AGENDA DATA] Job ${jobName} queued with ID: ${job.attrs._id}`);
            
            return {
                success: true,
                jobId: job.attrs._id,
                jobName: jobName,
                scheduledAt: job.attrs.nextRunAt
            };
            
        } catch (error) {
            console.error(`❌ [AGENDA DATA] Failed to trigger job ${jobName}:`, error);
            throw error;
        }
    }

    /**
     * Get job statistics
     */
    async getJobStats() {
        try {
            const jobs = await this.agenda.jobs({});
            const jobsByName = {};
            
            jobs.forEach(job => {
                const name = job.attrs.name;
                if (!jobsByName[name]) {
                    jobsByName[name] = {
                        name: name,
                        total: 0,
                        scheduled: 0,
                        running: 0,
                        completed: 0,
                        failed: 0
                    };
                }
                
                jobsByName[name].total++;
                
                if (job.attrs.nextRunAt && job.attrs.nextRunAt > new Date()) {
                    jobsByName[name].scheduled++;
                } else if (job.attrs.lastRunAt && !job.attrs.lastFinishedAt) {
                    jobsByName[name].running++;
                } else if (job.attrs.lastFinishedAt && !job.attrs.failedAt) {
                    jobsByName[name].completed++;
                } else if (job.attrs.failedAt) {
                    jobsByName[name].failed++;
                }
            });
            
            return {
                summary: this.stats,
                jobs: Object.values(jobsByName),
                totalJobs: jobs.length
            };
            
        } catch (error) {
            console.error('❌ [AGENDA DATA] Error getting job stats:', error);
            throw error;
        }
    }

    /**
     * Stop the service gracefully
     */
    async stop() {
        try {
            console.log('🛑 [AGENDA DATA] Stopping service...');
            
            if (this.agenda) {
                await this.agenda.stop();
                console.log('✅ [AGENDA DATA] Service stopped successfully');
            }
            
            this.isInitialized = false;
            
        } catch (error) {
            console.error('❌ [AGENDA DATA] Error stopping service:', error);
            throw error;
        }
    }

    /**
     * Pause all recurring jobs
     */
    async pauseJobs() {
        try {
            await this.agenda.cancel({
                name: { $in: ['daily-data-prefetch', 'chart-cleanup'] }
            });
            console.log('⏸️ [AGENDA DATA] All recurring jobs paused');
            
        } catch (error) {
            console.error('❌ [AGENDA DATA] Error pausing jobs:', error);
            throw error;
        }
    }

    /**
     * Resume all recurring jobs
     */
    async resumeJobs() {
        try {
            await this.scheduleRecurringJobs();
            console.log('▶️ [AGENDA DATA] All recurring jobs resumed');
            
        } catch (error) {
            console.error('❌ [AGENDA DATA] Error resuming jobs:', error);
            throw error;
        }
    }
}

const agendaDataPrefetchService = new AgendaDataPrefetchService();
export default agendaDataPrefetchService;