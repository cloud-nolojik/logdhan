/**
 * Test harness for monitoring scenarios without live market data.
 * Simulates monitoring checks with mocked candles to exercise:
 *  - All conditions met
 *  - Conditions not met (continue monitoring)
 *  - Expired subscription
 *
 * Usage:
 *   node backend/scripts/test-monitoring-scenarios.js --analysisId=<id> --strategyId=S1 [--scenario=all|met|not_met|expired]
 *
 * Requirements:
 *   - MONGODB_URI must point to the DB containing the analysis document.
 *   - The analysis document should already exist (status=completed) with the given strategyId.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import MonitoringSubscription from '../src/models/monitoringSubscription.js';
import StockAnalysis from '../src/models/stockAnalysis.js';
import agendaMonitoringService from '../src/services/agendaMonitoringService.js';
import candleFetcherService from '../src/services/candleFetcher.service.js';

const argv = yargs(hideBin(process.argv))
  // Defaults prefilled for MARUTI/S1 and user 6911543998bb1ec8704b8731 – override as needed
  .option('analysisId', { type: 'string', default: '691f4389656075439f1d3906' })
  .option('strategyId', { type: 'string', default: 'S1' })
  .option('userId', { type: 'string', default: '6911543998bb1ec8704b8731' })
  .option('scenario', {
    type: 'string',
    default: 'all',
    choices: ['all', 'start', 'met', 'not_met', 'expired'],
    describe: 'Pick which scenario(s) to run; "all" runs start+met+not_met+expired'
  })
  .option('forceMet', {
    type: 'boolean',
    default: false,
    describe: 'Force conditions_met without trigger evaluation (sets FORCE_CONDITIONS_MET=true)'
  })
  .help()
  .argv;

const SCENARIOS = ['start', 'met', 'not_met', 'expired'];

function patchMarketData(mock) {
  candleFetcherService.getMarketDataForTriggers = async () => {
    return mock;
  };
}

function buildMockData(basePrice, entry, highHit, rsi, timestamp = new Date()) {
  const ts = new Date(timestamp).toISOString();
  return {
    current_price: basePrice,
    timeframes: {
      '15m': {
        close: basePrice,
        high: highHit,
        low: basePrice - 50,
        open: basePrice - 10,
        volume: 1_000_000,
        vwap: basePrice - 20,
        timestamp: ts
      },
      '1h': {
        close: basePrice,
        high: highHit,
        low: basePrice - 100,
        open: basePrice - 20,
        rsi14_1h: rsi,
        timestamp: ts
      },
      '1d': {
        close: basePrice,
        high: highHit,
        low: basePrice - 150,
        open: basePrice - 30,
        timestamp: ts
      }
    }
  };
}

async function ensureSubscription(analysisId, strategyId, userId) {
    const analysis = await StockAnalysis.findById(analysisId);
    if (!analysis) throw new Error(`Analysis ${analysisId} not found`);
    const strategy = analysis.analysis_data?.strategies?.find(s => s.id === strategyId);
    if (!strategy) throw new Error(`Strategy ${strategyId} not found on analysis ${analysisId}`);

    const jobId = `monitor_${analysisId}_${strategyId}`;
    const resolvedUserId = userId || analysis.user_id || new mongoose.Types.ObjectId();
    const subscription = await MonitoringSubscription.findOrCreateSubscription(
        analysisId,
        strategyId,
        resolvedUserId,
        analysis.stock_symbol,
        analysis.instrument_key,
        jobId,
        { frequency_seconds: 900 }
    );

  return { analysis, strategy, subscription };
}

async function runScenario({ name, analysis, strategy }) {
    console.log(`\n=== Scenario: ${name.toUpperCase()} ===`);

    // Scenario "start": just ensure subscription exists and print status, no mock check
    if (name === 'start') {
        const sub = await MonitoringSubscription.findOne({
            analysis_id: analysis._id,
            strategy_id: strategy.id
        }).lean();
        console.log({
            monitoring_status: sub?.monitoring_status,
            conditions_met_at: sub?.conditions_met_at,
            expires_at: sub?.expires_at,
            subscribed_users: sub?.subscribed_users?.length,
            last_trigger_snapshot: sub?.last_trigger_snapshot?.snapshot_timestamp,
        });
        return;
    }

    // Build mock data per scenario
    let mockData;
    if (name === 'met') {
        mockData = buildMockData(strategy.entry + 20, strategy.entry, strategy.entry + 30, 65);
    } else if (name === 'not_met') {
        mockData = buildMockData(strategy.entry - 100, strategy.entry, strategy.entry - 20, 50);
  } else if (name === 'expired') {
    mockData = buildMockData(strategy.entry - 50, strategy.entry, strategy.entry - 10, 55);
  } else {
    throw new Error(`Unknown scenario ${name}`);
  }

  // Patch market data provider
  patchMarketData(mockData);

  // Adjust expiry for the expired scenario
  if (name === 'expired') {
    await MonitoringSubscription.updateMany(
      { analysis_id: analysis._id, strategy_id: strategy.id },
      { $set: { expires_at: new Date(Date.now() - 60 * 60 * 1000), monitoring_status: 'active' } }
    );
    await agendaMonitoringService.cleanupExpiredSubscriptions();
  }

  // Execute a monitoring check
  await agendaMonitoringService.executeMonitoringCheck(analysis._id, strategy.id);

  // Fetch and print subscription status
  const sub = await MonitoringSubscription.findOne({
    analysis_id: analysis._id,
    strategy_id: strategy.id
  }).lean();

  console.log({
    monitoring_status: sub?.monitoring_status,
    conditions_met_at: sub?.conditions_met_at,
    expires_at: sub?.expires_at,
    subscribed_users: sub?.subscribed_users?.length,
    last_trigger_snapshot: sub?.last_trigger_snapshot?.snapshot_timestamp,
  });
}

async function main() {
  const scenariosToRun = argv.scenario === 'all' ? SCENARIOS : [argv.scenario];

  if (argv.forceMet) {
    process.env.FORCE_CONDITIONS_MET = 'true';
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error('MONGODB_URI is not set. Please export it or add it to backend/.env');
  }

  await mongoose.connect(mongoUri, { maxPoolSize: 5 });
  console.log('✅ Connected to MongoDB');

  const { analysis, strategy } = await ensureSubscription(argv.analysisId, argv.strategyId, argv.userId);

  // Run each scenario sequentially
  for (const name of scenariosToRun) {
    await runScenario({ name, analysis, strategy });
  }

  await mongoose.disconnect();
  console.log('✅ Done');
}

main().catch(err => {
  console.error('❌ Test failed:', err);
  mongoose.disconnect();
  process.exit(1);
});
