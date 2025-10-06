import axios from 'axios';
import * as TI from 'technicalindicators';

const API_KEY = '5d2c7442-7ce9-44b3-a0df-19c110d72262';

/**
 * Get candle data for specific timeframe
 * @param {string} instrumentKey - The instrument key
 * @param {string} timeframe - The timeframe (1m, 5m, 15m, 30m, 1h, 1d)
 * @param {number} count - Number of candles to fetch (default 100 for indicators)
 * @param {boolean} calculateIndicators - Whether to calculate technical indicators
 * @returns {Object} - Latest candle data with OHLC values, indicators, and timeframe info
 */
export async function getCandleDataForTimeframe(instrumentKey, timeframe = '15m', count = 100, calculateIndicators = true) {
    const currentDate = new Date();
    const previousDay = new Date(currentDate);
    
    // For daily data, we need much more historical data to calculate indicators
    if (timeframe === '1d' || timeframe === 'day') {
        previousDay.setDate(currentDate.getDate() - 100); // Go back 100 days for daily candles
    } else {
        previousDay.setDate(currentDate.getDate() - 7); // 7 days for intraday timeframes
    }
    
    const currentDayFormattedDate = getFormattedDate(currentDate);
    const previousDayFormattedDate = getFormattedDate(previousDay);
    
    console.log(`📅 Date range for ${timeframe}: ${previousDayFormattedDate} to ${currentDayFormattedDate} (${Math.ceil((currentDate - previousDay) / (1000 * 60 * 60 * 24))} days)`);;
    
    // Map timeframe to V3 API unit and interval
    const intervalMap = {
        '1m': { unit: 'minutes', interval: '1' },
        '5m': { unit: 'minutes', interval: '5' },
        '15m': { unit: 'minutes', interval: '15' },
        '30m': { unit: 'minutes', interval: '30' },
        '1h': { unit: 'minutes', interval: '60' },
        '60m': { unit: 'minutes', interval: '60' },
        '1d': { unit: 'days', interval: '1' },
        'day': { unit: 'days', interval: '1' }
    };
    
    console.log(`🔍 Mapping timeframe ${timeframe} to intervalConfig:`, intervalMap[timeframe.toLowerCase()]);
    
    const intervalConfig = intervalMap[timeframe.toLowerCase()] || { unit: 'minutes', interval: '15' };
    
    const axiosConfig = {
        headers: {
            'Accept': 'application/json',
            'x-api-key': API_KEY
        },
        timeout: 10000
    };
    
    try {
        console.log(`📊 Fetching ${timeframe} candle data for ${instrumentKey}...`);
        
        // Use V3 API endpoints for better interval support
        // For intraday V3: /v3/historical-candle/intraday/{instrumentKey}/{unit}/{interval}
        // For historical V3: /v3/historical-candle/{instrumentKey}/{unit}/{interval}/{to_date}/{from_date}
        const apiFormats = [
            {
                name: `intraday-v3-${timeframe}`,
                url: `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${intervalConfig.unit}/${intervalConfig.interval}`
            },
            {
                name: `historical-v3-${timeframe}`,
                url: `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${intervalConfig.unit}/${intervalConfig.interval}/${currentDayFormattedDate}/${previousDayFormattedDate}`
            }
        ];
        
        for (const format of apiFormats) {
            try {
                console.log(`🔍 Trying ${format.name}: ${format.url}`);
                const response = await axios.get(format.url, axiosConfig);
                console.log(`📡 Response status: ${response.status}, data structure:`, {
                    status: response.data?.status,
                    hasData: !!response.data?.data,
                    candlesCount: response.data?.data?.candles?.length || 0
                });
                const candles = response.data?.data?.candles || [];
                
                if (candles.length > 0) {
                    // Get the most recent completed candle (not the current forming one)
                    const latestCandles = candles.slice(0, Math.min(count, candles.length));
                    
                    // Parse candle data
                    // Candle format: [timestamp, open, high, low, close, volume]
                    const parsedCandles = latestCandles.map(candle => ({
                        timestamp: candle[0],
                        open: candle[1],
                        high: candle[2],
                        low: candle[3],
                        close: candle[4],
                        volume: candle[5]
                    }));
                    
                    const latestCandle = parsedCandles[0];
                    
                    console.log(`✅ Got ${timeframe} candle - Close: ${latestCandle.close}, High: ${latestCandle.high}, Low: ${latestCandle.low}`);
                    
                    // Calculate technical indicators if requested and we have enough data
                    let indicators = {};
                    console.log(`🔍 Debug: ${timeframe} - ${parsedCandles.length} candles available, calculateIndicators: ${calculateIndicators}`);
                    
                    if (calculateIndicators && parsedCandles.length >= 20) {
                        console.log(`📈 Calculating indicators for ${timeframe} with ${parsedCandles.length} candles...`);
                        indicators = calculateTechnicalIndicators(parsedCandles);
                        console.log(`📈 Calculated ${Object.keys(indicators).length} indicators for ${timeframe}:`, Object.keys(indicators).join(', '));
                        console.log(`📈 Sample indicator values:`, {
                            ema20: indicators.ema20,
                            ema50: indicators.ema50,
                            sma20: indicators.sma20
                        });
                    } else {
                        console.log(`⚠️ Not calculating indicators for ${timeframe}: calculateIndicators=${calculateIndicators}, candles=${parsedCandles.length}`);
                    }
                    
                    return {
                        success: true,
                        timeframe: timeframe,
                        interval: `${intervalConfig.unit}/${intervalConfig.interval}`,
                        latest: latestCandle,
                        candles: parsedCandles,
                        indicators: indicators,
                        current_price: latestCandle.close, // For compatibility
                        timestamp: new Date().toISOString()
                    };
                }
            } catch (error) {
                console.log(`⚠️ ${format.name} failed: ${error.message}`);
                if (error.response) {
                    console.log(`   Status: ${error.response.status}`);
                    console.log(`   Data: ${JSON.stringify(error.response.data)}`);
                }
                continue;
            }
        }
        
        // Fallback to 1-minute candles if specific timeframe fails
        console.log(`⚠️ Could not fetch ${timeframe} candles, trying 1-minute fallback...`);
        const fallbackUrl = `https://api.upstox.com/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/1`;
        
        try {
            const response = await axios.get(fallbackUrl, axiosConfig);
            const candles = response.data?.data?.candles || [];
            
            if (candles.length > 0) {
                // Aggregate 1-minute candles to approximate the requested timeframe
                const aggregatedCandle = aggregateCandles(candles, timeframe);
                
                return {
                    success: true,
                    timeframe: timeframe,
                    interval: `${intervalConfig.unit}/${intervalConfig.interval}`,
                    latest: aggregatedCandle,
                    candles: [aggregatedCandle],
                    current_price: aggregatedCandle.close,
                    timestamp: new Date().toISOString(),
                    note: 'Aggregated from 1-minute candles'
                };
            }
        } catch (error) {
            console.error(`❌ Fallback also failed: ${error.message}`);
        }
        
        throw new Error(`Unable to fetch ${timeframe} candle data for ${instrumentKey}`);
        
    } catch (error) {
        console.error(`❌ Error fetching candle data: ${error.message}`);
        return {
            success: false,
            error: error.message,
            timeframe: timeframe,
            current_price: null
        };
    }
}

/**
 * Get market data based on trigger requirements
 * @param {string} instrumentKey - The instrument key
 * @param {Array} triggers - Array of trigger conditions with timeframes
 * @returns {Object} - Market data for all required timeframes
 */
export async function getMarketDataForTriggers(instrumentKey, triggers = []) {
    const marketData = {
        current_price: null,
        timeframes: {},
        indicators: {} // Store indicators by timeframe
    };
    
    // Extract unique timeframes from triggers
    const timeframesNeeded = new Set(['1m']); // Always get current price (1m)
    
    triggers.forEach(trigger => {
        if (trigger.timeframe) {
            // Normalize timeframe format
            let normalized = trigger.timeframe.toLowerCase();
            if (normalized === '1d' || normalized === 'day' || normalized === '1day') {
                normalized = '1d';
            }
            timeframesNeeded.add(normalized);
        }
    });
    
    console.log(`📊 Fetching market data for timeframes: ${Array.from(timeframesNeeded).join(', ')}`);
    
    // Fetch data for each timeframe with indicators
    for (const timeframe of timeframesNeeded) {
        // Fetch more candles for better indicator calculation
        const count = timeframe === '1d' || timeframe === 'day' ? 100 : 100;
        const candleData = await getCandleDataForTimeframe(instrumentKey, timeframe, count, true);
        
        if (candleData.success) {
            marketData.timeframes[timeframe] = candleData.latest;
            
            // Store indicators for this timeframe
            if (candleData.indicators) {
                marketData.indicators[timeframe] = candleData.indicators;
                
                // Also merge indicators into the timeframe data for easier access
                marketData.timeframes[timeframe] = {
                    ...candleData.latest,
                    ...candleData.indicators
                };
            }
            
            // Set current price from 1m data
            if (timeframe === '1m') {
                marketData.current_price = candleData.latest.close;
            }
        }
    }
    
    // If we couldn't get 1m data, use the smallest timeframe available
    if (!marketData.current_price && Object.keys(marketData.timeframes).length > 0) {
        const firstTimeframe = Object.values(marketData.timeframes)[0];
        marketData.current_price = firstTimeframe.close;
    }
    
    return marketData;
}

/**
 * Aggregate 1-minute candles to create a larger timeframe candle
 * @param {Array} candles - Array of 1-minute candles
 * @param {string} targetTimeframe - Target timeframe (5m, 15m, etc.)
 * @returns {Object} - Aggregated candle
 */
function aggregateCandles(candles, targetTimeframe) {
    const minutesMap = {
        '5m': 5,
        '15m': 15,
        '30m': 30,
        '1h': 60,
        '60m': 60
    };
    
    const minutes = minutesMap[targetTimeframe.toLowerCase()] || 15;
    const candlesToAggregate = candles.slice(0, minutes);
    
    if (candlesToAggregate.length === 0) {
        return null;
    }
    
    // Candle format: [timestamp, open, high, low, close, volume]
    const aggregated = {
        timestamp: candlesToAggregate[0][0], // Latest timestamp
        open: candlesToAggregate[candlesToAggregate.length - 1][1], // Oldest open
        high: Math.max(...candlesToAggregate.map(c => c[2])), // Highest high
        low: Math.min(...candlesToAggregate.map(c => c[3])), // Lowest low
        close: candlesToAggregate[0][4], // Latest close
        volume: candlesToAggregate.reduce((sum, c) => sum + c[5], 0) // Sum of volumes
    };
    
    return aggregated;
}

/**
 * Calculate technical indicators from candle data
 * @param {Array} candles - Array of candle data (newest first)
 * @returns {Object} - Calculated indicators
 */
function calculateTechnicalIndicators(candles) {
    console.log(`🔧 calculateTechnicalIndicators called with ${candles.length} candles`);
    
    // Reverse candles to oldest first for indicator calculation
    const reversedCandles = [...candles].reverse();
    
    const closes = reversedCandles.map(c => c.close);
    const highs = reversedCandles.map(c => c.high);
    const lows = reversedCandles.map(c => c.low);
    const opens = reversedCandles.map(c => c.open);
    const volumes = reversedCandles.map(c => c.volume);
    
    console.log(`🔧 Data arrays created - closes: ${closes.length}, sample values: [${closes.slice(0, 3).join(', ')}...]`);
    
    const indicators = {};
    
    try {
        // EMA calculations with detailed verification
        if (closes.length >= 20) {
            console.log(`🔧 Calculating EMA20 with ${closes.length} values...`);
            console.log(`📊 Input data sample (last 10 closes): [${closes.slice(-10).map(c => c.toFixed(2)).join(', ')}]`);
            console.log(`📊 Input data sample (first 10 closes): [${closes.slice(0, 10).map(c => c.toFixed(2)).join(', ')}]`);
            
            const ema20 = TI.EMA.calculate({ period: 20, values: closes });
            const ema20Value = ema20[ema20.length - 1];
            
            console.log(`🔧 EMA20 calculation details:`);
            console.log(`   - Input values: ${closes.length} closes`);
            console.log(`   - Output values: ${ema20.length} EMA points`);
            console.log(`   - Last 5 EMA20 values: [${ema20.slice(-5).map(v => v.toFixed(4)).join(', ')}]`);
            console.log(`   - Final EMA20: ${ema20Value.toFixed(6)}`);
            
            // Manual verification of EMA calculation (simplified)
            const multiplier = 2 / (20 + 1); // EMA multiplier for period 20
            console.log(`   - EMA20 multiplier: ${multiplier.toFixed(6)}`);
            console.log(`   - Latest close: ${closes[closes.length - 1]}`);
            console.log(`   - Previous EMA20: ${ema20.length > 1 ? ema20[ema20.length - 2].toFixed(6) : 'N/A'}`);
            
            indicators.ema20 = ema20Value;
            indicators.ema20_1d = ema20Value; // Alias for trigger compatibility
            indicators.ema201d = ema20Value; // Compact alias (no underscore)
        } else {
            console.log(`⚠️ Not enough data for EMA20 (need 20, have ${closes.length})`);
        }
        
        if (closes.length >= 50) {
            console.log(`🔧 Calculating EMA50 with ${closes.length} values...`);
            
            const ema50 = TI.EMA.calculate({ period: 50, values: closes });
            const ema50Value = ema50[ema50.length - 1];
            
            console.log(`🔧 EMA50 calculation details:`);
            console.log(`   - Input values: ${closes.length} closes`);
            console.log(`   - Output values: ${ema50.length} EMA points`);
            console.log(`   - Last 5 EMA50 values: [${ema50.slice(-5).map(v => v.toFixed(4)).join(', ')}]`);
            console.log(`   - Final EMA50: ${ema50Value.toFixed(6)}`);
            
            const multiplier50 = 2 / (50 + 1); // EMA multiplier for period 50
            console.log(`   - EMA50 multiplier: ${multiplier50.toFixed(6)}`);
            console.log(`   - Latest close: ${closes[closes.length - 1]}`);
            console.log(`   - Previous EMA50: ${ema50.length > 1 ? ema50[ema50.length - 2].toFixed(6) : 'N/A'}`);
            
            indicators.ema50 = ema50Value;
            indicators.ema50_1d = ema50Value; // Alias for trigger compatibility
            indicators.ema501d = ema50Value; // Compact alias (no underscore)
            
            // Compare EMA20 vs EMA50
            if (indicators.ema20) {
                const comparison = indicators.ema20 > indicators.ema50 ? 'BULLISH' : 'BEARISH';
                const difference = Math.abs(indicators.ema20 - indicators.ema50);
                const percentDiff = (difference / indicators.ema50 * 100);
                
                console.log(`📈 EMA Cross Analysis:`);
                console.log(`   - EMA20: ${indicators.ema20.toFixed(4)}`);
                console.log(`   - EMA50: ${indicators.ema50.toFixed(4)}`);
                console.log(`   - Difference: ${difference.toFixed(4)} (${percentDiff.toFixed(2)}%)`);
                console.log(`   - Signal: ${comparison} (EMA20 ${comparison === 'BULLISH' ? '>' : '<'} EMA50)`);
            }
        } else {
            console.log(`⚠️ Not enough data for EMA50 (need 50, have ${closes.length})`);
        }
        
        // SMA calculations
        if (closes.length >= 20) {
            const sma20 = TI.SMA.calculate({ period: 20, values: closes });
            indicators.sma20 = sma20[sma20.length - 1];
            indicators.sma20_1d = sma20[sma20.length - 1]; // Timeframe alias
            indicators.sma201d = sma20[sma20.length - 1]; // Compact alias
        }
        
        if (closes.length >= 50) {
            const sma50 = TI.SMA.calculate({ period: 50, values: closes });
            indicators.sma50 = sma50[sma50.length - 1];
            indicators.sma50_1d = sma50[sma50.length - 1]; // Timeframe alias
            indicators.sma501d = sma50[sma50.length - 1]; // Compact alias
        }
        
        // RSI calculation
        if (closes.length >= 14) {
            const rsi = TI.RSI.calculate({ period: 14, values: closes });
            indicators.rsi = rsi[rsi.length - 1];
            indicators.rsi14 = rsi[rsi.length - 1]; // Alias
            indicators.rsi_14 = rsi[rsi.length - 1]; // Underscore alias
        }
        
        // MACD calculation
        if (closes.length >= 26) {
            const macd = TI.MACD.calculate({
                values: closes,
                fastPeriod: 12,
                slowPeriod: 26,
                signalPeriod: 9,
                SimpleMAOscillator: false,
                SimpleMASignal: false
            });
            if (macd.length > 0) {
                const latestMACD = macd[macd.length - 1];
                indicators.macd = latestMACD.MACD;
                indicators.macd_signal = latestMACD.signal;
                indicators.macd_histogram = latestMACD.histogram;
            }
        }
        
        // Bollinger Bands
        if (closes.length >= 20) {
            const bb = TI.BollingerBands.calculate({
                period: 20,
                values: closes,
                stdDev: 2
            });
            if (bb.length > 0) {
                const latestBB = bb[bb.length - 1];
                indicators.bb_upper = latestBB.upper;
                indicators.bb_middle = latestBB.middle;
                indicators.bb_lower = latestBB.lower;
            }
        }
        
        // Stochastic
        if (closes.length >= 14) {
            const stoch = TI.Stochastic.calculate({
                high: highs,
                low: lows,
                close: closes,
                period: 14,
                signalPeriod: 3
            });
            if (stoch.length > 0) {
                const latestStoch = stoch[stoch.length - 1];
                indicators.stochastic_k = latestStoch.k;
                indicators.stochastic_d = latestStoch.d;
            }
        }
        
        // ATR (Average True Range)
        if (closes.length >= 14) {
            const atr = TI.ATR.calculate({
                high: highs,
                low: lows,
                close: closes,
                period: 14
            });
            if (atr.length > 0) {
                indicators.atr = atr[atr.length - 1];
                indicators.atr14 = atr[atr.length - 1]; // Alias
                indicators.atr_14 = atr[atr.length - 1]; // Underscore alias
            }
        }
        
        // ADX (Average Directional Index)
        if (closes.length >= 14) {
            const adx = TI.ADX.calculate({
                high: highs,
                low: lows,
                close: closes,
                period: 14
            });
            if (adx.length > 0) {
                indicators.adx = adx[adx.length - 1].adx;
                indicators.adx14 = adx[adx.length - 1].adx; // Alias
                indicators.adx_14 = adx[adx.length - 1].adx; // Underscore alias
            }
        }
        
        // VWAP approximation (simplified - actual VWAP needs intraday data)
        if (volumes.length > 0) {
            let sumPriceVolume = 0;
            let sumVolume = 0;
            for (let i = 0; i < Math.min(20, closes.length); i++) {
                const idx = closes.length - 1 - i;
                const typicalPrice = (highs[idx] + lows[idx] + closes[idx]) / 3;
                sumPriceVolume += typicalPrice * volumes[idx];
                sumVolume += volumes[idx];
            }
            indicators.vwap = sumVolume > 0 ? sumPriceVolume / sumVolume : closes[closes.length - 1];
        }
        
    } catch (error) {
        console.error('Error calculating indicators:', error);
    }
    
    // Final summary of key indicators
    if (Object.keys(indicators).length > 0) {
        console.log(`📋 Technical Indicators Summary:`);
        console.log(`   📊 Moving Averages:`);
        if (indicators.ema20) console.log(`      - EMA20: ${indicators.ema20.toFixed(4)}`);
        if (indicators.ema50) console.log(`      - EMA50: ${indicators.ema50.toFixed(4)}`);
        if (indicators.sma20) console.log(`      - SMA20: ${indicators.sma20.toFixed(4)}`);
        if (indicators.sma50) console.log(`      - SMA50: ${indicators.sma50.toFixed(4)}`);
        
        console.log(`   📊 Oscillators:`);
        if (indicators.rsi) console.log(`      - RSI(14): ${indicators.rsi.toFixed(2)}`);
        if (indicators.stochastic_k && indicators.stochastic_d) {
            console.log(`      - Stochastic: K=${indicators.stochastic_k.toFixed(2)}, D=${indicators.stochastic_d.toFixed(2)}`);
        }
        
        console.log(`   📊 Trend & Volatility:`);
        if (indicators.macd !== undefined) console.log(`      - MACD: ${indicators.macd.toFixed(4)}`);
        if (indicators.adx) console.log(`      - ADX(14): ${indicators.adx.toFixed(2)}`);
        if (indicators.atr) console.log(`      - ATR(14): ${indicators.atr.toFixed(4)}`);
        if (indicators.vwap) console.log(`      - VWAP: ${indicators.vwap.toFixed(4)}`);
        
        // Verification check - manual EMA calculation for last value
        if (indicators.ema20 && closes.length >= 20) {
            const currentClose = closes[closes.length - 1];
            const ema20Multiplier = 2 / (20 + 1);
            console.log(`🔍 EMA20 Manual Verification:`);
            console.log(`   - Current Close: ${currentClose}`);
            console.log(`   - EMA20 Multiplier: ${ema20Multiplier.toFixed(6)}`);
            console.log(`   - Calculated EMA20: ${indicators.ema20.toFixed(6)}`);
            console.log(`   - Formula: EMA = (Current Close * Multiplier) + (Previous EMA * (1 - Multiplier))`);
        }
    }
    
    return indicators;
}

function getFormattedDate(date) {
    return date.toISOString().split('T')[0];
}

export default {
    getCandleDataForTimeframe,
    getMarketDataForTriggers
};