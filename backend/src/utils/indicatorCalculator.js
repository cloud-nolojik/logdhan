import * as TI from 'technicalindicators';

/**
 * Calculate technical indicators from candle data
 * @param {Array} candles - Array of candle data (can be newest first or oldest first)
 * @returns {Object} - Calculated indicators
 */
export function calculateTechnicalIndicators(candles) {
    console.log(`🔧 calculateTechnicalIndicators called with ${candles.length} candles`);

    // Handle both array format [timestamp, open, high, low, close, volume] and object format
    const isArrayFormat = Array.isArray(candles[0]);

    // Sort candles to oldest first for indicator calculation
    const sortedCandles = [...candles].sort((a, b) => {
        const timeA = isArrayFormat ? a[0] : a.timestamp;
        const timeB = isArrayFormat ? b[0] : b.timestamp;
        return new Date(timeA) - new Date(timeB);
    });

    const closes = sortedCandles.map(c => isArrayFormat ? c[4] : c.close);
    const highs = sortedCandles.map(c => isArrayFormat ? c[2] : c.high);
    const lows = sortedCandles.map(c => isArrayFormat ? c[3] : c.low);
    const opens = sortedCandles.map(c => isArrayFormat ? c[1] : c.open);
    const volumes = sortedCandles.map(c => isArrayFormat ? c[5] : c.volume);

    console.log(`🔧 Data arrays created - closes: ${closes.length}, sample values: [${closes.slice(0, 3).join(', ')}...]`);

    const indicators = {};

    try {
        // EMA20 calculation
        if (closes.length >= 20) {
            const ema20 = TI.EMA.calculate({ period: 20, values: closes });
            const ema20Value = ema20[ema20.length - 1];

            indicators.ema20 = ema20Value;
            indicators.ema20_1d = ema20Value;
            indicators.ema20_1h = ema20Value;
            indicators.ema20_15m = ema20Value;
            indicators.ema201d = ema20Value;
        }

        // EMA50 calculation
        if (closes.length >= 50) {
            const ema50 = TI.EMA.calculate({ period: 50, values: closes });
            const ema50Value = ema50[ema50.length - 1];

            indicators.ema50 = ema50Value;
            indicators.ema50_1d = ema50Value;
            indicators.ema50_1h = ema50Value;
            indicators.ema50_15m = ema50Value;
            indicators.ema501d = ema50Value;
        }

        // SMA calculations
        if (closes.length >= 20) {
            const sma20 = TI.SMA.calculate({ period: 20, values: closes });
            indicators.sma20 = sma20[sma20.length - 1];
            indicators.sma20_1d = sma20[sma20.length - 1];
            indicators.sma201d = sma20[sma20.length - 1];
        }

        if (closes.length >= 50) {
            const sma50 = TI.SMA.calculate({ period: 50, values: closes });
            indicators.sma50 = sma50[sma50.length - 1];
            indicators.sma50_1d = sma50[sma50.length - 1];
            indicators.sma501d = sma50[sma50.length - 1];
        }

        // RSI calculation
        if (closes.length >= 14) {
            const rsi = TI.RSI.calculate({ period: 14, values: closes });
            indicators.rsi = rsi[rsi.length - 1];
            indicators.rsi14 = rsi[rsi.length - 1];
            indicators.rsi_14 = rsi[rsi.length - 1];
            indicators.rsi14_1h = rsi[rsi.length - 1];
            indicators.rsi14_15m = rsi[rsi.length - 1];
            indicators.rsi14_1d = rsi[rsi.length - 1];
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
                indicators.atr14 = atr[atr.length - 1];
                indicators.atr_14 = atr[atr.length - 1];
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
                indicators.adx14 = adx[adx.length - 1].adx;
                indicators.adx_14 = adx[adx.length - 1].adx;
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

        console.log(`✅ Calculated ${Object.keys(indicators).length} indicators`);

    } catch (error) {
        console.error('❌ Error calculating indicators:', error);
    }

    return indicators;
}

export default {
    calculateTechnicalIndicators
};
