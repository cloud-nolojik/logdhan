// shortChart.service.js - Short-term trading chart generation
// ESM module

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { azureStorageService } from '../storage/azureStorage.service.js';

// ====== CONFIG ======
const TICK_SIZE_DEFAULT = 0.05;
const MICRO_BARS = 120;                      // Short-term: ~2 hours for swing triggers
const BG = 'white';
const CHART_COLORS = {
  price: 'rgba(75, 192, 192, 1)',
  priceArea: 'rgba(75, 192, 192, 0.1)',
  vwap: 'rgba(0, 0, 0, 0.9)',               
  highLow: 'rgba(128, 128, 128, 0.2)',
  entry: 'rgba(0, 120, 255, 0.8)',
  stop: 'rgba(220, 20, 60, 0.8)', 
  target1: 'rgba(0, 160, 0, 0.8)',
  target2: 'rgba(0, 160, 0, 0.6)',
  watermark: 'rgba(0, 0, 0, 0.1)'
};

// ====== HELPERS ======
const roundTick = (n, tick = TICK_SIZE_DEFAULT) =>
  Number.isFinite(n) ? Math.round(n / tick) * tick : undefined;

// Convert short-term bars to candle format for charting
const toCandles15m = (bars) =>
  (bars || []).map(([t, o, h, l, c], index) => ({
    x: index, // Use index for category scale
    timestamp: t, // Keep original timestamp for labels
    o, h, l, c
  }));

function cleanNum(n) {
  return Number.isFinite(Number(n)) ? Number(n) : undefined;
}

function pickLevelsFromReview(reviewResult) {
  // accept either a single object or [object]
  const rr = Array.isArray(reviewResult) ? reviewResult[0] : reviewResult;
  if (!rr || !rr.analysis) return null;

  const plan = rr.analysis?.plan || null;
  const cp   = rr.analysis?.userReview?.correctedPlan || null;

  // choose the first actionable source: plan > correctedPlan
  const choose = (src) => {
    if (!src) return null;
    const sideOk = src.side && src.side !== 'none';
    const hasNums = isFinite(+src.entry) && isFinite(+src.stop)
      && Array.isArray(src.targets) && isFinite(+src.targets[0]) && isFinite(+src.targets[1]);
    return sideOk && hasNums ? src : null;
  };

  const src = choose(plan) || choose(cp);
  if (!src) return null;

  // tick rounding helpers
  const tick = +(
    rr.analysis?.meta?.tickSize ??
    rr.meta?.tickSize ??
    0.05
  );

  const roundToTick = (n) => {
    const x = Number(n);
    if (!isFinite(x) || !isFinite(tick) || tick <= 0) return x;
    // round to nearest tick (then fix to 2 dp to avoid FP noise)
    const r = Math.round(x / tick) * tick;
    return Number(r.toFixed(2));
  };

  const cleanNum = (n) => roundToTick(Number(n));

  // build result
  return {
    side: String(src.side).toLowerCase(),
    entry:  cleanNum(src.entry),
    stop:   cleanNum(src.stop),
    t1:     cleanNum(src.targets?.[0]),
    t2:     cleanNum(src.targets?.[1]),
    triggerSummary: String(src.trigger || '').slice(0, 140)
  };
}

// Dashed horizontal line “dataset”
const hLine = (y, label, color = 'rgba(0,0,0,0.35)') => ({
  type: 'line',
  label,
  data: [],
  parsing: false,
  borderWidth: 1.5, // Slightly thicker for visibility
  borderColor: color,
  pointRadius: 0,
  // custom flag read by plugin below
  _hline: y
});

// Plugin to draw full-width horizontal lines and add watermarks
const HLINE_PLUGIN = {
  id: 'hline',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales, canvas, options } = chart;
    
    // Draw horizontal lines for Entry/SL/T1/T2
    for (const ds of chart.config.data.datasets) {
      if (ds._hline == null) continue;
      const yPix = scales.y.getPixelForValue(ds._hline);
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = ds.borderColor || 'rgba(0,0,0,0.35)';
      ctx.lineWidth = ds.borderWidth ?? 1;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, yPix);
      ctx.lineTo(chartArea.right, yPix);
      ctx.stroke();
      
      // Label + price (top-right aligned)
      if (ds.label && ds.label !== 'High' && ds.label !== 'Low' && ds.label !== 'Day High' && ds.label !== 'Day Low') {
        const label = ds.label ? `${ds.label} ${ds._hline.toFixed(2)}` : `${ds._hline.toFixed(2)}`;
        ctx.fillStyle = ds.borderColor || 'rgba(0,0,0,0.7)';
        ctx.font = 'bold 11px Arial';
        ctx.textAlign = 'right';
        ctx.fillText(label, chartArea.right - 5, yPix - 2);
      }
      
      ctx.restore();
    }
    
    // Add watermarks
    const wm = options._chartWatermarks || {};
    
    // Timestamp watermark (bottom left)
    if (wm.timestamp) {
      ctx.save();
      ctx.fillStyle = CHART_COLORS.watermark;
      ctx.font = '11px Arial';
      ctx.textAlign = 'left';
      ctx.fillText(wm.timestamp, chartArea.left + 5, canvas.height - 10);
      ctx.restore();
    }
    
    // Symbol watermark (bottom right)
    if (wm.symbol) {
      ctx.save();
      ctx.fillStyle = CHART_COLORS.watermark;
      ctx.font = '11px Arial';
      ctx.textAlign = 'right';
      ctx.fillText(wm.symbol, chartArea.right - 5, canvas.height - 10);
      ctx.restore();
    }
    
    // Corner context chip (top right) with color coding
    if (wm.contextChip) {
      ctx.save();
      const chipText = wm.contextChip;
      const chipPadding = 8;
      const chipHeight = 22;
      
      // Determine chip color based on content
      let chipBgColor = 'rgba(0, 0, 0, 0.7)'; // default
      if (chipText.includes('Above VWAP') && chipText.includes('Bullish')) {
        chipBgColor = 'rgba(0, 160, 0, 0.8)'; // green for bullish above VWAP
      } else if (chipText.includes('Below VWAP') && chipText.includes('Bearish')) {
        chipBgColor = 'rgba(220, 20, 60, 0.8)'; // red for bearish below VWAP
      } else if (chipText.includes('Above VWAP') && chipText.includes('Bearish')) {
        chipBgColor = 'rgba(255, 140, 0, 0.8)'; // orange for mixed signal
      } else if (chipText.includes('Below VWAP') && chipText.includes('Bullish')) {
        chipBgColor = 'rgba(255, 140, 0, 0.8)'; // orange for mixed signal
      }
      
      // Measure text width
      ctx.font = 'bold 11px Arial';
      const textWidth = ctx.measureText(chipText).width;
      const chipWidth = textWidth + chipPadding * 2;
      
      // Draw chip background with rounded corners effect
      const chipX = chartArea.right - chipWidth - 8;
      const chipY = chartArea.top + 8;
      
      ctx.fillStyle = chipBgColor;
      ctx.fillRect(chipX, chipY, chipWidth, chipHeight);
      
      // Draw chip text
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.textAlign = 'center';
      ctx.fillText(chipText, chipX + chipWidth / 2, chipY + chipHeight / 2 + 4);
      
      ctx.restore();
    }
  }
};

// ====== RENDER CONFIG ======
function makeChartConfig({ candles, vwap, range, levels, symbol, timestamp, contextChip }) {
  const datasets = [
    // VWAP line (thicker for instant bias recognition)
    {
      type: 'line',
      label: 'VWAP',
      data: vwap.map((v, i) => ({ x: i, y: v.y })), // Map VWAP to chart indices
      borderWidth: 2, // Slightly thinner
      borderColor: CHART_COLORS.vwap,
      pointRadius: 0,
      borderDash: [],
      backgroundColor: 'transparent'
    },
    // Price line (close prices) - render on top
    {
      type: 'line',
      label: 'Price',
      data: candles.map((c, i) => ({ x: i, y: c.c })),
      borderColor: CHART_COLORS.price,
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 1,
      tension: 0.1,
      fill: false
    }
  ];

  // Remove day high/low lines to reduce clutter
  // if (Number.isFinite(range.high)) datasets.push(hLine(range.high, 'Day High'));
  // if (Number.isFinite(range.low))  datasets.push(hLine(range.low,  'Day Low'));

  if (levels) {
    const { entry, stop, t1, t2 } = levels;
    console.log('Chart levels:', { entry, stop, t1, t2 }); // Debug log
    if (Number.isFinite(entry)) datasets.push(hLine(entry, 'Entry', CHART_COLORS.entry));
    if (Number.isFinite(stop))  datasets.push(hLine(stop,  'SL', CHART_COLORS.stop));
    if (Number.isFinite(t1))    datasets.push(hLine(t1,    'T1', CHART_COLORS.target1));
    if (Number.isFinite(t2))    datasets.push(hLine(t2,    'T2', CHART_COLORS.target2));
  }

  return {
    type: 'line', // Changed from candlestick to line
    data: { datasets },
    options: {
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { 
          type: 'category',
          grid: { display: false },
          labels: candles.map((candle, i) => {
            // Show every 10th label to avoid overcrowding
            if (i % 10 === 0 || i === candles.length - 1) {
              const date = new Date(candle.t); // Use 't' field for timestamp
              const day = date.getDate().toString().padStart(2, '0');
              const month = (date.getMonth() + 1).toString().padStart(2, '0');
              const time = date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
              return `${day}/${month} ${time}`; // Show date and 24-hour time
            }
            return ''; // Empty string for labels we don't want to show
          }),
          ticks: {
            maxRotation: 45, // Rotate labels for better readability
            minRotation: 45
          }
        },
        y: { 
          ticks: { maxTicksLimit: 6 },
          // Expand Y-axis to include all trading levels
          min: function(context) {
            const chart = context.chart;
            const datasets = chart.data.datasets;
            let minPrice = Infinity;
            let minLevel = Infinity;
            
            // Find minimum price from data
            datasets.forEach(dataset => {
              if (dataset.label === 'Price' && dataset.data) {
                dataset.data.forEach(point => {
                  if (point.y < minPrice) minPrice = point.y;
                });
              }
              // Find minimum level (targets, entry, stop)
              if (dataset._hline && dataset._hline < minLevel) {
                minLevel = dataset._hline;
              }
            });
            
            return Math.min(minPrice, minLevel) - 5; // Add 5 point buffer
          },
          max: function(context) {
            const chart = context.chart;
            const datasets = chart.data.datasets;
            let maxPrice = -Infinity;
            let maxLevel = -Infinity;
            
            // Find maximum price from data
            datasets.forEach(dataset => {
              if (dataset.label === 'Price' && dataset.data) {
                dataset.data.forEach(point => {
                  if (point.y > maxPrice) maxPrice = point.y;
                });
              }
              // Find maximum level (targets, entry, stop)
              if (dataset._hline && dataset._hline > maxLevel) {
                maxLevel = dataset._hline;
              }
            });
            
            return Math.max(maxPrice, maxLevel) + 5; // Add 5 point buffer
          }
        }
      },
      layout: { padding: { top: contextChip ? 30 : 6, right: 8, bottom: timestamp || symbol ? 25 : 8, left: 8 } },
      // Store watermark data for plugin access
      _chartWatermarks: {
        symbol: symbol,
        timestamp: timestamp,
        contextChip: contextChip
      }
    },
    plugins: [HLINE_PLUGIN]
  };
}

// ====== RENDERER ======
async function renderPngBuffers({ payload, levels }) {
  // ------- Helper functions and constants -------
  // Get tick size for price rounding (e.g., 0.05 for stocks, 0.01 for futures)
  const TICK = 0.05;
  
  // Get current IST time for chart timestamp watermark
  const nowIST = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  
  // Utility: Round price to nearest tick size (e.g., 125.07 → 125.05 for 0.05 tick)
  const roundTick = (n, t=TICK) => (Number.isFinite(+n) ? Number((Math.round(+n/t)*t).toFixed(2)) : null);
  
  // Utility: Convert API bar array [timestamp, open, high, low, close, volume] to candle objects
  const toCandles = (arr=[]) => arr.map(a => ({ t:a[0], o:+a[1], h:+a[2], l:+a[3], c:+a[4], v:+a[5] }));

  // ------- Data preparation for chart rendering -------
  // Initialize variables for chart data
  let primaryBars = [], vwapSeries = [], range = null;
  const microBars = 120; // Use 120 bars for micro chart (~2 hours of 15m bars)
  
  // Get 15-minute and 1-hour bar data from payload snapshots
  const bars15m = payload?.snapshots?.lastBars15m || [];
  const bars1h  = payload?.snapshots?.lastBars1h  || [];
  
  // Ensure we have required data, throw error if missing
  if (!bars15m.length || !bars1h.length) throw new Error('missing_snapshot_bars');

  // Calculate VWAP using 15-minute bars (good for swing trading timing)
  vwapSeries = computeVWAP15m(bars15m);

  // Calculate today's high/low range using 15-minute data
  range = todayRange15m(bars15m);

  // Set primary display data to 15-minute bars
  primaryBars = bars15m;

  // ------- Round trading levels to tick size -------
  let lvls = null;
  if (levels) {
    // Round all trading levels (entry, stop loss, targets) to proper tick increments
    lvls = {
      ...levels,
      entry: roundTick(levels.entry), // Entry price rounded to tick
      stop:  roundTick(levels.stop),  // Stop loss price rounded to tick
      t1:    roundTick(levels.t1),    // Target 1 price rounded to tick
      t2:    roundTick(levels.t2)     // Target 2 price rounded to tick
    };
  }

  // ------- Prepare chart data and context information -------
  // Convert all primary bars to candle format for charting
  const allCandles   = toCandles(primaryBars);
  // Take only the last 120 candles for micro chart (recent price action focus)
  const microCandles = allCandles.slice(-microBars);

  // Trim VWAP series to match micro chart timeframe
  const vwapTrimmed = (vwapSeries && vwapSeries.length)
    ? vwapSeries.slice(-microBars) // Last 120 VWAP points
    : [];

  // Create context chip showing VWAP position and trend
  let contextChip = null;
  if (microCandles.length) {
    // Get the most recent closing price
    const lastClose = microCandles.at(-1)?.c;
    
    if (vwapTrimmed.length) {
      // Get the most recent VWAP value
      const lastV = vwapTrimmed.at(-1)?.y;
      
      if (Number.isFinite(lastClose) && Number.isFinite(lastV)) {
        // Determine if price is above or below VWAP
        const vPos = lastClose > lastV ? 'Above VWAP' : 'Below VWAP';
        
        // Calculate recent trend by comparing last 5 vs previous 5 closes
        const recent = microCandles.slice(-5).map(c => c.c);   // Last 5 closes
        const prev   = microCandles.slice(-10, -5).map(c => c.c); // Previous 5 closes
        const rAvg   = recent.reduce((a,b)=>a+b,0)/Math.max(1,recent.length); // Recent average
        const pAvg   = prev.reduce((a,b)=>a+b,0)/Math.max(1,prev.length);     // Previous average
        const trend  = rAvg > pAvg ? 'Bullish' : 'Bearish'; // Compare averages for trend
        
        // Combine VWAP position and trend for context chip
        contextChip  = `${vPos} · ${trend}`;
      }
    } else {
      // Fallback when VWAP is not available - show trend only
      const recent = microCandles.slice(-5).map(c => c.c);
      const prev   = microCandles.slice(-10, -5).map(c => c.c);
      const rAvg   = recent.reduce((a,b)=>a+b,0)/Math.max(1,recent.length);
      const pAvg   = prev.reduce((a,b)=>a+b,0)/Math.max(1,prev.length);
      const trend  = rAvg > pAvg ? 'Bullish' : 'Bearish';
      contextChip  = `VWAP Unknown · ${trend}`;
    }
  }

  // ------- Create chart rendering canvases -------
  // Set background color for charts
  const chartJSNodeCanvasOptions = { backgroundColour: BG };
  // Create smaller canvas for micro chart (focused recent action)
  const microCanvas = new ChartJSNodeCanvas({ width: 800,  height: 360, ...chartJSNodeCanvasOptions });
  // Create larger canvas for full chart (complete view)
  const fullCanvas  = new ChartJSNodeCanvas({ width: 1400, height: 700, ...chartJSNodeCanvasOptions });

  // ------- Chart metadata -------
  // Get stock symbol from payload or use default
  const symbol    = payload?.meta?.symbol || 'STOCK';
  // Create timestamp for chart watermark
  const timestamp = `Generated ${nowIST} IST`;

  // ------- Build chart configurations -------
  // Configure micro chart (last 120 bars with context chip)
  const microCfg = makeChartConfig({
    candles: microCandles,     // Recent price data
    vwap: vwapTrimmed,        // VWAP for recent period
    range,                    // Day's high/low range
    levels: lvls,             // Trading levels (entry, stop, targets)
    symbol,                   // Stock symbol
    timestamp,                // Generation timestamp
    contextChip               // VWAP position + trend indicator
  });

  // Configure full chart (all available bars, no context chip)
  const fullCfg = makeChartConfig({
    candles: toCandles(primaryBars), // All primary bar data
    vwap: vwapSeries,               // Full VWAP series
    range,                          // Day's high/low range
    levels: lvls,                   // Trading levels
    symbol,                         // Stock symbol
    timestamp                       // Generation timestamp
  });

  // ------- Render charts to PNG buffers -------
  // Generate micro chart image
  const microPng = await microCanvas.renderToBuffer(microCfg);
  // Generate full chart image
  const fullPng  = await fullCanvas.renderToBuffer(fullCfg);

  // Return both chart images plus metadata
  return { microPng, fullPng, range, levels: lvls };
}


// bars15m: [ [timeISO, open, high, low, close, volume], ... ]
// Returns { high: number|null, low: number|null }
function todayRange15m(bars15m = [], tz = 'Asia/Kolkata') {
  if (!Array.isArray(bars15m) || !bars15m.length) {
    return { high: null, low: null };
  }

  // Get today's date in IST for comparison
  const nowIST = new Date(
    new Date().toLocaleString('en-US', { timeZone: tz })
  );
  const yyyy = nowIST.getFullYear();
  const mm = String(nowIST.getMonth() + 1).padStart(2, '0');
  const dd = String(nowIST.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`; // YYYY-MM-DD

  // Date formatter to get YYYY-MM-DD for each bar in IST
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const istDayKey = (ts) => fmt.format(new Date(ts));

  // Filter bars for today in IST
  const todaysBars = bars15m.filter(bar => istDayKey(bar[0]) === todayStr);

  if (!todaysBars.length) {
    return { high: null, low: null };
  }

  // Calculate high and low from today's bars
  let high = -Infinity;
  let low = Infinity;
  for (const [, , h, l] of todaysBars) {
    if (h > high) high = h;
    if (l < low) low = l;
  }

  return {
    high: Number.isFinite(high) ? high : null,
    low: Number.isFinite(low) ? low : null
  };
}


// bars15m: [ [timeISO, open, high, low, close, volume], ... ]
// returns: [ { x: timeISO, y: vwapNumber }, ... ]
function computeVWAP15m(bars15m = [], opts = {}) {
  const {
    sessionize = true,            // reset VWAP each trading day
    tz = 'Asia/Kolkata',          // NSE session timezone
    useTypicalPrice = true,       // (H+L+C)/3; else use Close
    decimals = 6
  } = opts;

  if (!Array.isArray(bars15m) || !bars15m.length) return [];

  // Build a stable "IST date" key for session resets
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const istDayKey = (ts) => fmt.format(new Date(ts)); // YYYY-MM-DD

  let out = [];
  let cumPV = 0, cumV = 0;
  let curDay = sessionize ? istDayKey(bars15m[0][0]) : null;

  for (let i = 0; i < bars15m.length; i++) {
    const a = bars15m[i];
    if (!a || a.length < 6) { out.push({ x: a?.[0] ?? null, y: NaN }); continue; }

    const [time, o, h, l, c, vRaw] = a;
    const vol = Number(vRaw) || 0;

    // session reset when calendar day (in IST) changes
    if (sessionize) {
      const d = istDayKey(time);
      if (d !== curDay) { cumPV = 0; cumV = 0; curDay = d; }
    }

    const tp = useTypicalPrice ? (Number(h)+Number(l)+Number(c)) / 3 : Number(c);
    // ignore negative/NaN volume gracefully
    if (vol > 0 && Number.isFinite(tp)) {
      cumPV += tp * vol;
      cumV  += vol;
    }

    const vwap = cumV > 0 ? (cumPV / cumV) : NaN;
    out.push({ x: time, y: Number(vwap.toFixed(decimals)) });
  }

  return out;
}


// ====== STORAGE HELPERS ======
async function saveBufferToLocal(buffer, fileName) {
  const root = process.env.PUBLIC_DIR || path.join(process.cwd(), 'public');
  const dir  = path.join(root, 'charts');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, buffer);
  const baseUrl = process.env.BACKEND_BASE_URL || process.env.BASE_URL || 'https://logdhan.com';
  return `${baseUrl}/charts/${fileName}`;
}

async function uploadBufferViaService(buffer, fileName) {
  if (!azureStorageService?.isEnabled?.()) return null;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'charts-'));
  const tmpPath = path.join(tmpDir, fileName);
  try {
    await fs.writeFile(tmpPath, buffer);
    const url = await azureStorageService.uploadChart(tmpPath, fileName);
    return url;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ====== PUBLIC API ======
/**
 * @param {Object} args
 * @param {Object} args.payload - exact analysis payload (with snapshots.lastBars15m/1h/1D)
 * @param {Array}  args.reviewResult - reviewResult array containing ui/analysis
 * @param {String} args.tag - symbol/name for file names (optional)
 * @returns {{microUrl:string, fullUrl:string, range:{high:number|null,low:number|null}, levels:Object|null}}
 */
export async function createAndUploadShortTermCharts(payload, reviewResult, tag = 'chart' ) {
  // 1) Pick levels from review (plan if side!="none", else correctedPlan)
  const picked = pickLevelsFromReview(reviewResult);

  // 2) Render PNG buffers
  const { microPng, fullPng, range, levels } = await renderPngBuffers({
    payload,
    levels: picked || undefined
  });

  // 3) Name files
  const safeTag = (tag || 'chart').toString().trim().toLowerCase().replace(/\s+/g, '-');
  const stamp   = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); // yyyymmddhhmmss
  const microName = `${safeTag}-${stamp}-micro.png`;
  const fullName  = `${safeTag}-${stamp}-full.png`;

  // 4) Try Azure via your service
  let microUrl = await uploadBufferViaService(microPng, microName);
  let fullUrl  = await uploadBufferViaService(fullPng,  fullName);

  // 5) Fallback to local /public/charts
  if (!microUrl) microUrl = await saveBufferToLocal(microPng, microName);
  if (!fullUrl)  fullUrl  = await saveBufferToLocal(fullPng,  fullName);

  return { microUrl, fullUrl, range, levels };
}

export default { createAndUploadShortTermCharts };