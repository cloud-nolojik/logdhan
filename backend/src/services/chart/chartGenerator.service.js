import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

class ChartGeneratorService {
  constructor() {
    this.openaiApiKey = process.env.OPENAI_API_KEY;
  }

  /**
   * Generate technical chart with AI-driven pattern analysis
   */
  async generateChart(chartData) {
    try {
      // Handle both old format (logEntry) and new format (chartData object)
      let tradeData, candleSummary, indicators, patternAnalysis, chartOverlay;

      if (chartData.tradeData) {
        // New format from AI service
        ({ tradeData, candleSummary, indicators, patternAnalysis, chartOverlay } = chartData);
      } else
      {

        return null;
      }

      // Convert candleSummary to OHLCV format if it's a string
      let ohlcvData;
      if (typeof candleSummary === 'string' || candleSummary?.message === 'Levels only – no candles') {

        ohlcvData = this.generateMockOHLCVData(tradeData);
      } else if (candleSummary?.candles && candleSummary.candles.length === 0) {

        ohlcvData = this.generateMockOHLCVData(tradeData);
      } else {
        ohlcvData = candleSummary.candles || this.generateMockOHLCVData(tradeData);
      }

      // Extract timeframe info for chart title
      let timeframe = null;
      if (typeof candleSummary === 'object' && candleSummary.timeframe) {
        timeframe = candleSummary.timeframe;
      }

      // Draw chart with provided data and indicators
      const chartBuffer = await this.drawTechnicalChart(ohlcvData, tradeData, patternAnalysis, chartOverlay, indicators, timeframe);

      // Upload to Azure
      const chartUrl = await this.uploadChart(chartBuffer);

      return {
        chartUrl,
        analysis: patternAnalysis
      };

    } catch (error) {
      console.error('❌ Chart generation failed:', error);

      // Generate fail-soft fallback response
      const fallbackUrl = await this.generateFallbackChart(tradeData, error.message);

      return {
        chartUrl: fallbackUrl,
        analysis: {
          error: 'Chart generation failed',
          fallback: true,
          message: 'Technical chart unavailable - showing placeholder'
        }
      };
    }
  }

  /**
   * AI analyzes OHLCV data for patterns and trading signals
   */
  async aiAnalyzeTechnicalPatterns(logEntry, ohlcvData) {
    const prompt = `You are a professional technical analyst. Analyze this trading setup:

STOCK: ${logEntry.stock}
DIRECTION: ${logEntry.direction}
ENTRY: ₹${logEntry.entryPrice}
TARGET: ₹${logEntry.targetPrice}
STOP: ₹${logEntry.stopLoss}
TERM: ${logEntry.term}

OHLCV DATA (last 50 candles):
${JSON.stringify(ohlcvData.slice(-50), null, 2)}

TASKS:
1. Identify key technical patterns (breakouts, triangles, flags, etc.)
2. Find support/resistance levels
3. Suggest trendlines to draw on chart
4. Determine optimal buy zone and confidence level
5. Identify volume confirmation signals

RESPOND IN JSON:
{
  "pattern": "Cup & Handle Breakout",
  "trendDirection": "Bullish",
  "keyLevels": {
    "strongSupport": [1520, 1480],
    "strongResistance": [1600, 1650],
    "immediateSupport": 1540,
    "immediateResistance": 1580
  },
  "trendlines": [
    {
      "type": "support",
      "startPrice": 1480,
      "endPrice": 1540,
      "startIndex": 10,
      "endIndex": 45,
      "color": "#00ff00"
    }
  ],
  "buySignal": {
    "optimalEntry": 1562,
    "reason": "Breakout above resistance with volume spike",
    "confidence": 85,
    "volumeConfirmation": true
  },
  "annotations": [
    {
      "type": "arrow",
      "price": 1562,
      "text": "BUY HERE",
      "color": "#00ff00"
    },
    {
      "type": "zone",
      "fromPrice": 1595,
      "toPrice": 1605,
      "text": "TARGET ZONE",
      "color": "#0099ff"
    }
  ],
  "riskReward": 2.1,
  "marketContext": "Stock breaking out of consolidation phase"
}`;

    try {
      const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [
        {
          role: 'system',
          content: 'You are a professional technical analyst. Always respond with valid JSON only.'
        },
        {
          role: 'user',
          content: prompt
        }],

        temperature: 0.3,
        max_tokens: 1500
      }, {
        headers: {
          'Authorization': `Bearer ${this.openaiApiKey}`,
          'Content-Type': 'application/json'
        }
      });

      const content = response.data.choices[0].message.content;

      // Try to extract JSON from markdown code blocks
      let jsonContent = content;
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonContent = jsonMatch[1];
      } else {
        // Look for JSON object in the content
        const objectMatch = content.match(/\{[\s\S]*\}/);
        if (objectMatch) {
          jsonContent = objectMatch[0];
        }
      }

      return JSON.parse(jsonContent);

    } catch (error) {
      console.error('❌ AI technical analysis failed:', error);
      return {
        pattern: 'Analysis unavailable',
        confidence: 0,
        error: error.message
      };
    }
  }

  /**
   * Generate mock OHLCV data when real data is not available
   */
  generateMockOHLCVData(tradeData) {
    const mockData = [];
    const entryPrice = parseFloat(tradeData.entryprice) || 1000; // Default price if invalid
    const targetPrice = parseFloat(tradeData.target) || entryPrice * 1.03;
    const stopPrice = parseFloat(tradeData.stoploss) || entryPrice * 0.98;

    // Validate that we have valid prices
    if (isNaN(entryPrice) || entryPrice <= 0) {
      console.warn('⚠️ Invalid entry price, using default ₹1000');
      const defaultPrice = 1000;
      return this.generateDefaultMockData(defaultPrice, tradeData.symbol || 'STOCK');
    }

    // Create a more realistic price progression that moves towards the target
    let basePrice = entryPrice * 0.98; // Start slightly below entry
    const candleCount = 50;
    const targetDirection = tradeData.direction === 'BUY' ? 1 : -1;
    const trendStrength = 0.4; // How much to trend towards target

    // Add some market session-based time intervals
    const now = new Date();
    const startTime = new Date(now.getTime() - candleCount * 15 * 60000); // 15min intervals

    for (let i = 0; i < candleCount; i++) {
      // Create trend towards target with some randomness
      const progressFactor = i / candleCount;
      const trendBias = (entryPrice - basePrice) * trendStrength * progressFactor * targetDirection;

      // Add market volatility and noise
      const volatility = Math.random() * 0.015; // 1.5% max volatility
      const randomWalk = (Math.random() - 0.5) * volatility;

      const open = basePrice;
      const priceChange = trendBias + randomWalk;
      const close = basePrice * (1 + priceChange);

      // Realistic wick generation
      const wickRange = Math.abs(close - open) * (0.5 + Math.random() * 1.5);
      const high = Math.max(open, close) + wickRange * Math.random();
      const low = Math.min(open, close) - wickRange * Math.random();

      // Ensure prices stay reasonable
      const finalHigh = Math.max(open, close, high);
      const finalLow = Math.min(open, close, low);

      const candleTime = new Date(startTime.getTime() + i * 15 * 60000);

      mockData.push({
        timestamp: candleTime.toISOString(),
        open: Math.round(open * 100) / 100,
        high: Math.round(finalHigh * 100) / 100,
        low: Math.round(finalLow * 100) / 100,
        close: Math.round(close * 100) / 100,
        volume: Math.floor(Math.random() * 150000) + 25000 + (i % 5 === 0 ? 50000 : 0) // Volume spikes every 5 candles
      });

      basePrice = close;
    }

    return mockData;
  }

  /**
   * Generate default mock data with valid prices
   */
  generateDefaultMockData(basePrice, symbol) {
    const mockData = [];
    const candleCount = 50;
    let currentPrice = basePrice;

    // Add some market session-based time intervals
    const now = new Date();
    const startTime = new Date(now.getTime() - candleCount * 15 * 60000); // 15min intervals

    for (let i = 0; i < candleCount; i++) {
      // Create slight price movement (±2%)
      const priceChange = (Math.random() - 0.5) * 0.04; // ±2% change
      const open = currentPrice;
      const close = currentPrice * (1 + priceChange);

      // Create realistic high and low
      const high = Math.max(open, close) * (1 + Math.random() * 0.01); // Up to 1% wick
      const low = Math.min(open, close) * (1 - Math.random() * 0.01); // Down to 1% wick

      const candleTime = new Date(startTime.getTime() + i * 15 * 60000);

      mockData.push({
        timestamp: candleTime.toISOString(),
        open: Math.round(open * 100) / 100,
        high: Math.round(high * 100) / 100,
        low: Math.round(low * 100) / 100,
        close: Math.round(close * 100) / 100,
        volume: Math.floor(Math.random() * 100000) + 50000
      });

      currentPrice = close;
    }

    return mockData;
  }

  /**
   * Draw professional technical chart using Canvas
   */
  async drawTechnicalChart(ohlcvData, tradeData, technicalAnalysis, chartOverlay = null, indicators = null, timeframe = null) {
    const width = 800;
    const height = 600;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Validate ohlcvData
    if (!ohlcvData || ohlcvData.length === 0) {
      console.warn('⚠️ No OHLCV data provided, generating fallback chart');
      ohlcvData = this.generateDefaultMockData(parseFloat(tradeData.entryprice) || 1000, tradeData.symbol || 'STOCK');
    }

    // Chart styling
    const padding = { top: 50, right: 80, bottom: 100, left: 60 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    // Background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Calculate price range with validation
    const prices = ohlcvData.map((d) => [d.high, d.low]).flat().filter((p) => !isNaN(p) && p > 0);

    // If no valid prices, use fallback values
    if (prices.length === 0) {
      console.warn('⚠️ No valid price data found, using fallback chart');
      const fallbackPrice = parseFloat(tradeData.entryprice) || 1000;
      const minPrice = fallbackPrice * 0.95;
      const maxPrice = fallbackPrice * 1.05;
      const priceRange = maxPrice - minPrice;
    } else {
      var minPrice = Math.min(...prices) * 0.98;
      var maxPrice = Math.max(...prices) * 1.02;
      var priceRange = maxPrice - minPrice;
    }

    // Price to pixel conversion
    const priceToY = (price) => padding.top + (maxPrice - price) / priceRange * chartHeight;
    const indexToX = (index) => padding.left + index / (ohlcvData.length - 1) * chartWidth;

    // Draw grid lines with price labels
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 0.5;
    ctx.fillStyle = '#888';
    ctx.font = '10px Arial';

    for (let i = 0; i <= 10; i++) {
      const y = padding.top + i / 10 * chartHeight;
      const price = maxPrice - i / 10 * priceRange;

      // Draw horizontal grid line
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();

      // Draw price label on right (with validation)
      const priceLabel = isNaN(price) || !isFinite(price) ? '₹--' : `₹${Math.round(price)}`;
      ctx.fillText(priceLabel, width - padding.right + 5, y + 3);
    }

    // Draw vertical grid lines with time labels
    for (let i = 0; i <= 5; i++) {
      const x = padding.left + i / 5 * chartWidth;
      const dataIndex = Math.floor(i / 5 * (ohlcvData.length - 1));

      // Draw vertical grid line
      ctx.strokeStyle = '#222';
      ctx.beginPath();
      ctx.moveTo(x, padding.top);
      ctx.lineTo(x, height - padding.bottom);
      ctx.stroke();

      // Draw time label at bottom
      if (ohlcvData[dataIndex]) {
        const timestamp = new Date(ohlcvData[dataIndex].timestamp);
        const timeLabel = timestamp.toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Asia/Kolkata'
        });
        ctx.fillStyle = '#888';
        ctx.fillText(timeLabel, x - 15, height - padding.bottom + 15);
      }
    }

    // Draw candlesticks with validation
    ohlcvData.forEach((candle, index) => {
      // Skip invalid candles
      if (!candle || isNaN(candle.open) || isNaN(candle.close) || isNaN(candle.high) || isNaN(candle.low)) {
        return;
      }

      const x = indexToX(index);
      const openY = priceToY(candle.open);
      const closeY = priceToY(candle.close);
      const highY = priceToY(candle.high);
      const lowY = priceToY(candle.low);

      // Skip if any Y position is invalid
      if (!isFinite(openY) || !isFinite(closeY) || !isFinite(highY) || !isFinite(lowY)) {
        return;
      }

      const isGreen = candle.close > candle.open;
      ctx.strokeStyle = isGreen ? '#00ff88' : '#ff4444';
      ctx.fillStyle = isGreen ? '#00ff88' : '#ff4444';

      // Draw wick
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, highY);
      ctx.lineTo(x, lowY);
      ctx.stroke();

      // Draw body
      const bodyHeight = Math.abs(closeY - openY);
      const bodyY = Math.min(openY, closeY);
      ctx.fillRect(x - 2, bodyY, 4, bodyHeight || 1);
    });

    // Draw support/resistance levels
    if (technicalAnalysis.keyLevels) {
      const levels = technicalAnalysis.keyLevels;

      // Support levels
      if (levels.strongSupport) {
        levels.strongSupport.forEach((price) => {
          const y = priceToY(price);
          ctx.strokeStyle = '#00ff00';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(padding.left, y);
          ctx.lineTo(width - padding.right, y);
          ctx.stroke();

          // Label
          ctx.fillStyle = '#00ff00';
          ctx.font = '12px Arial';
          ctx.fillText(`Support: ₹${price}`, width - padding.right + 5, y + 4);
        });
      }

      // Resistance levels
      if (levels.strongResistance) {
        levels.strongResistance.forEach((price) => {
          const y = priceToY(price);
          ctx.strokeStyle = '#ff4444';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(padding.left, y);
          ctx.lineTo(width - padding.right, y);
          ctx.stroke();

          // Label
          ctx.fillStyle = '#ff4444';
          ctx.font = '12px Arial';
          ctx.fillText(`Resistance: ₹${price}`, width - padding.right + 5, y + 4);
        });
      }
    }

    // Draw trendlines
    if (technicalAnalysis.trendlines) {
      technicalAnalysis.trendlines.forEach((trendline) => {
        const startX = indexToX(trendline.startIndex);
        const endX = indexToX(trendline.endIndex);
        const startY = priceToY(trendline.startPrice);
        const endY = priceToY(trendline.endPrice);

        ctx.strokeStyle = trendline.color || '#ffff00';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      });
    }

    // Use updated levels if available, otherwise use original trade levels
    let entryPrice = tradeData.entryprice;
    let targetPrice = tradeData.target;
    let stopPrice = tradeData.stoploss;
    let showBothLevels = false;

    if (technicalAnalysis.updatedLevels && technicalAnalysis.updatedLevels.isOutdated) {
      // Show both original and suggested levels
      showBothLevels = true;
    }

    // Draw trade levels
    if (showBothLevels) {
      // Draw original levels (faded)
      ctx.globalAlpha = 0.3;

      // Original entry
      const origEntryY = priceToY(tradeData.entryprice);
      ctx.strokeStyle = '#00ffff';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(padding.left, origEntryY);
      ctx.lineTo(width - padding.right, origEntryY);
      ctx.stroke();
      ctx.fillStyle = '#888888';
      ctx.font = '11px Arial';
      ctx.fillText(`Original Entry: ₹${tradeData.entryprice}`, padding.left + 10, origEntryY - 5);

      // Original target
      const origTargetY = priceToY(tradeData.target);
      ctx.strokeStyle = '#00ff00';
      ctx.beginPath();
      ctx.moveTo(padding.left, origTargetY);
      ctx.lineTo(width - padding.right, origTargetY);
      ctx.stroke();
      ctx.fillText(`Original Target: ₹${tradeData.target}`, padding.left + 10, origTargetY - 5);

      // Original stop
      const origStopY = priceToY(tradeData.stoploss);
      ctx.strokeStyle = '#ff0000';
      ctx.beginPath();
      ctx.moveTo(padding.left, origStopY);
      ctx.lineTo(width - padding.right, origStopY);
      ctx.stroke();
      ctx.fillText(`Original Stop: ₹${tradeData.stoploss}`, padding.left + 10, origStopY + 15);

      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;

      // Now draw suggested levels (bright)
      entryPrice = technicalAnalysis.updatedLevels.suggestedEntry;
      targetPrice = technicalAnalysis.updatedLevels.suggestedTarget;
      stopPrice = technicalAnalysis.updatedLevels.suggestedStop;
    }

    const entryY = priceToY(entryPrice);
    const targetY = priceToY(targetPrice);
    const stopY = priceToY(stopPrice);

    // Entry line
    ctx.strokeStyle = '#00ffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(padding.left, entryY);
    ctx.lineTo(width - padding.right, entryY);
    ctx.stroke();
    ctx.fillStyle = '#00ffff';
    ctx.font = 'bold 14px Arial';
    const entryLabel = showBothLevels ?
    `📈 SUGGESTED ENTRY: ₹${entryPrice}` : `📈 ENTRY: ₹${entryPrice}`;
    ctx.fillText(entryLabel, padding.left + 10, entryY - 10);

    // Target line
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding.left, targetY);
    ctx.lineTo(width - padding.right, targetY);
    ctx.stroke();
    ctx.fillStyle = '#00ff00';
    const targetLabel = showBothLevels ?
    `🎯 SUGGESTED TARGET: ₹${targetPrice}` : `🎯 TARGET: ₹${targetPrice}`;
    ctx.fillText(targetLabel, padding.left + 10, targetY - 10);

    // Stop loss line
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding.left, stopY);
    ctx.lineTo(width - padding.right, stopY);
    ctx.stroke();
    ctx.fillStyle = '#ff0000';
    const stopLabel = showBothLevels ?
    `🛑 SUGGESTED STOP: ₹${stopPrice}` : `🛑 STOP: ₹${stopPrice}`;
    ctx.fillText(stopLabel, padding.left + 10, stopY + 20);

    // Show R:R ratio for suggested levels
    if (showBothLevels && technicalAnalysis.updatedLevels.riskRewardRatio) {
      ctx.fillStyle = '#ffff00';
      ctx.font = 'bold 16px Arial';
      ctx.fillText(`R:R = ${technicalAnalysis.updatedLevels.riskRewardRatio}`, width - 200, 60);
    }

    // Current price indicator (rightmost candle)
    if (ohlcvData.length > 0) {
      const currentPrice = ohlcvData[ohlcvData.length - 1].close;
      const currentPriceY = priceToY(currentPrice);

      // Draw current price line
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(padding.left, currentPriceY);
      ctx.lineTo(width - padding.right, currentPriceY);
      ctx.stroke();
      ctx.setLineDash([]); // Reset dash

      // Current price label
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px Arial';
      ctx.fillText(`Current: ₹${currentPrice}`, width - padding.right + 5, currentPriceY - 5);
    }

    // Chart title with timeframe
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px Arial';
    const titleText = timeframe ?
    `${tradeData.symbol} (${timeframe}) - ${technicalAnalysis.patternType || 'Technical Analysis'}` :
    `${tradeData.symbol} - ${technicalAnalysis.patternType || 'Technical Analysis'}`;
    ctx.fillText(titleText, padding.left, 30);

    // Confidence score
    if (technicalAnalysis.confidenceScore) {
      ctx.fillStyle = '#ffff00';
      ctx.font = '14px Arial';
      ctx.fillText(`Confidence: ${Math.round(technicalAnalysis.confidenceScore * 100)}%`, width - 150, 30);
    }

    // Add technical indicators snapshot if available
    if (indicators) {
      ctx.fillStyle = '#cccccc';
      ctx.font = '11px Arial';
      let yPos = height - padding.bottom + 40;

      if (indicators.ema20) {
        ctx.fillText(`EMA20: ₹${Math.round(indicators.ema20 * 100) / 100}`, padding.left, yPos);
      }
      if (indicators.rsi) {
        ctx.fillText(`RSI: ${indicators.rsi}`, padding.left + 120, yPos);
      }
      if (indicators.volume_avg) {
        ctx.fillText(`Vol Avg: ${Math.round(indicators.volume_avg / 1000)}K`, padding.left + 200, yPos);
      }
    }

    // Warning for outdated trade levels
    if (ohlcvData.length > 0) {
      const currentPrice = ohlcvData[ohlcvData.length - 1].close;
      const entryPrice = tradeData.entryprice;
      const priceDiff = Math.abs((currentPrice - entryPrice) / entryPrice * 100);

      if (priceDiff > 5) {// If more than 5% difference
        ctx.fillStyle = '#ff6600';
        ctx.font = 'bold 12px Arial';
        ctx.fillText(`⚠️ OUTDATED: Current ₹${currentPrice} vs Entry ₹${entryPrice}`, padding.left, 50);
      }
    }

    // Add color legend for level interpretation
    if (showBothLevels) {
      const legendX = width - padding.right - 200;
      const legendY = padding.top + 60;

      // Legend background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.fillRect(legendX - 10, legendY - 10, 190, 80);

      // Legend title
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px Arial';
      ctx.fillText('Level Legend:', legendX, legendY);

      // Legend entries
      ctx.font = '11px Arial';
      ctx.fillStyle = '#00ffff';
      ctx.fillText('■ Suggested Levels', legendX, legendY + 20);
      ctx.fillStyle = '#888888';
      ctx.fillText('■ Original Levels', legendX, legendY + 35);
      ctx.fillStyle = '#ffffff';
      ctx.fillText('- - - Current Price', legendX, legendY + 50);
    }

    return canvas.toBuffer('image/png');
  }

  /**
   * Generate a simple fallback chart with error message
   */
  async generateFallbackChart(tradeData, errorMessage) {
    try {
      const width = 800;
      const height = 600;
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');

      // Dark background
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, width, height);

      // Error message
      ctx.fillStyle = '#ff6600';
      ctx.font = 'bold 24px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Technical Chart Unavailable', width / 2, height / 2 - 60);

      // Stock info
      ctx.fillStyle = '#ffffff';
      ctx.font = '18px Arial';
      ctx.fillText(`${tradeData.symbol} - ${tradeData.direction} @ ₹${tradeData.entryprice}`, width / 2, height / 2);

      // Suggestion
      ctx.fillStyle = '#888888';
      ctx.font = '14px Arial';
      ctx.fillText('Please try again later or contact support if issue persists', width / 2, height / 2 + 40);

      // Trade levels summary
      ctx.textAlign = 'left';
      ctx.fillStyle = '#00ffff';
      ctx.fillText(`Entry: ₹${tradeData.entryprice}`, 50, height - 100);
      ctx.fillStyle = '#00ff00';
      ctx.fillText(`Target: ₹${tradeData.target}`, 50, height - 70);
      ctx.fillStyle = '#ff0000';
      ctx.fillText(`Stop: ₹${tradeData.stoploss}`, 50, height - 40);

      const chartBuffer = canvas.toBuffer('image/png');
      return await this.uploadChart(chartBuffer);

    } catch (fallbackError) {
      console.error('❌ Fallback chart generation also failed:', fallbackError);
      return null;
    }
  }

  /**
   * Upload chart to Azure storage
   */
  async uploadChart(chartBuffer) {
    const fileName = `chart-${uuidv4()}.png`;

    try {
      // Save locally first
      const chartDir = path.join(process.cwd(), 'temp', 'charts');
      if (!fs.existsSync(chartDir)) {
        fs.mkdirSync(chartDir, { recursive: true });
      }

      const localPath = path.join(chartDir, fileName);

      fs.writeFileSync(localPath, chartBuffer);

      // Import Azure service dynamically
      const { azureStorageService } = await import('../storage/azureStorage.service.js');
      const azureUrl = await azureStorageService.uploadChart(localPath, fileName);

      // Clean up local file only if Azure upload was successful
      try {
        if (fs.existsSync(localPath)) {
          fs.unlinkSync(localPath);
        }
      } catch (cleanupError) {
        // Ignore ENOENT errors silently
        if (cleanupError.code !== 'ENOENT') {
          console.warn('⚠️ Could not clean up local file:', cleanupError.message);
        }
      }

      return azureUrl;

    } catch (error) {
      console.error('Chart upload failed:', error);
      // Fallback to local URL
      const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5650}`;
      return `${backendUrl}/charts/${fileName}`;
    }
  }
}

export const chartGeneratorService = new ChartGeneratorService();