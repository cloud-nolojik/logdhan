// chartRenderAndUpload.js
// ESM module

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { azureStorageService } from '../storage/azureStorage.service.js';


// ====== CONFIG ======
const TICK_SIZE_DEFAULT = 0.05;              // fallback if payload.meta.tickSize missing
const MICRO_BARS = 30;                       // ~90 minutes (3m bars) - tightened for last 90 mins
const BG = 'white';                          // background for PNG
const CHART_COLORS = {
  price: 'rgba(75, 192, 192, 1)',
  priceArea: 'rgba(75, 192, 192, 0.1)',
  vwap: 'rgba(0, 0, 0, 0.9)',               // Thicker/darker VWAP for clarity
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

const toCandles3m = (bars) =>
  (bars || []).map(([t, o, h, l, c], index) => ({
    x: index, // Use index for category scale
    timestamp: t, // Keep original timestamp for labels
    o, h, l, c
  }));

// Session VWAP from 1m bars (start-of-day cumulative)
function computeVWAP1m(bars1m, bars3m) {
  let cumPV = 0, cumV = 0;
  const out = [];
  // Map 1m bars to 3m bar indices for alignment
  let bar3mIndex = 0;
  
  for (let i = 0; i < (bars1m || []).length; i++) {
    const b = bars1m[i];
    const t = b[0], h = b[2], l = b[3], c = b[4], v = b[5];
    const tp = (h + l + c) / 3;
    cumPV += tp * v;
    cumV  += v;
    
    // Find corresponding 3m bar index
    while (bar3mIndex < bars3m.length - 1 && 
           new Date(bars3m[bar3mIndex + 1][0]).getTime() <= new Date(t).getTime()) {
      bar3mIndex++;
    }
    
    out.push({ x: bar3mIndex, y: cumV ? (cumPV / cumV) : tp });
  }
  return out;
}

function todayRange3m(bars3m) {
  if (!bars3m?.length) return { high: null, low: null };
  let hi = -Infinity, lo = Infinity;
  for (const b of bars3m) {
    const h = b[2], l = b[3];
    if (h > hi) hi = h;
    if (l < lo) lo = l;
  }
  return {
    high: Number.isFinite(hi) ? hi : null,
    low:  Number.isFinite(lo) ? lo : null
  };
}

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
      data: vwap,
      parsing: { xAxisKey: 'x', yAxisKey: 'y' },
      borderWidth: 3, // Thicker than price for instant bias reading
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
          type: 'category', // Use category scale instead of time to avoid date adapter issues
          grid: { display: false },
          labels: candles.map((candle) => {
            // Create labels from candle timestamps
            const date = new Date(candle.timestamp);
            return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          })
        },
        y: { ticks: { maxTicksLimit: 6 } }
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
  const bars3m = payload?.snapshots?.lastBars3m || [];
  const bars1m = payload?.snapshots?.lastBars1m || [];

  if (!bars1m.length || !bars3m.length) {
    throw new Error('missing_snapshot_bars');
  }

  // Round levels to tick size
  const tick = payload?.meta?.tickSize || TICK_SIZE_DEFAULT;
  let lvls = null;
  if (levels) {
    lvls = {
      ...levels,
      entry: roundTick(levels.entry, tick),
      stop:  roundTick(levels.stop,  tick),
      t1:    roundTick(levels.t1,    tick),
      t2:    roundTick(levels.t2,    tick)
    };
  }

  const allCandles  = toCandles3m(bars3m);
  const microCandles = allCandles.slice(-MICRO_BARS);
  const vwap   = computeVWAP1m(bars1m, bars3m);
  const range  = todayRange3m(bars3m);

  // Create watermarks and context info
  const symbol = payload?.meta?.symbol || 'STOCK';
  const timestamp = `Generated ${new Date().toLocaleTimeString('en-IN', { 
    hour: '2-digit', 
    minute: '2-digit',
    timeZone: 'Asia/Kolkata'
  })} IST`;
  
  // Generate context chip for micro chart only (focused view)
  let contextChip = null;
  if (microCandles.length > 0 && vwap.length > 0) {
    const currentPrice = microCandles[microCandles.length - 1].c;
    // Filter VWAP to micro timeframe
    const microVWAP = vwap.slice(-MICRO_BARS);
    const currentVWAP = microVWAP[microVWAP.length - 1]?.y;
    
    if (currentVWAP && Number.isFinite(currentPrice) && Number.isFinite(currentVWAP)) {
      const vwapPosition = currentPrice > currentVWAP ? 'Above VWAP' : 'Below VWAP';
      
      // Simple trend detection (compare last 5 vs previous 5 candles)
      const recent = microCandles.slice(-5).map(c => c.c);
      const previous = microCandles.slice(-10, -5).map(c => c.c);
      const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const previousAvg = previous.reduce((a, b) => a + b, 0) / previous.length;
      const trend = recentAvg > previousAvg ? 'Bullish' : 'Bearish';
      
      contextChip = `${vwapPosition} · ${trend}`;
    }
  }

  // Create canvases with simplified configuration
  const chartJSNodeCanvasOptions = {
    backgroundColour: BG
  };
  
  const microCanvas = new ChartJSNodeCanvas({ width: 800,  height: 360, ...chartJSNodeCanvasOptions });
  const fullCanvas  = new ChartJSNodeCanvas({ width: 1400, height: 700, ...chartJSNodeCanvasOptions });

  // Focus on micro chart with context chip, full chart without chip for clarity
  const microVWAP = vwap.slice(-MICRO_BARS); // Match VWAP to micro timeframe
  const microCfg = makeChartConfig({ candles: microCandles, vwap: microVWAP, range, levels: lvls, symbol, timestamp, contextChip });
  const fullCfg  = makeChartConfig({  candles: allCandles,  vwap, range, levels: lvls, symbol, timestamp });

  const microPng = await microCanvas.renderToBuffer(microCfg);
  const fullPng  = await fullCanvas.renderToBuffer(fullCfg);

  return { microPng, fullPng, range, levels: lvls };
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
 * @param {Object} args.payload - exact analysis payload (with snapshots.lastBars1m/3m)
 * @param {Array}  args.reviewResult - reviewResult array containing ui/analysis
 * @param {String} args.tag - symbol/name for file names (optional)
 * @returns {{microUrl:string, fullUrl:string, range:{high:number|null,low:number|null}, levels:Object|null}}
 */
export async function createAndUploadIntradayCharts(payload, reviewResult, tag = 'chart' ) {
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

export default { createAndUploadIntradayCharts };