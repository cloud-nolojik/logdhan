// mediumChart.service.js - Medium-term trading chart generation (ESM)

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ChartJSNodeCanvas } from 'chartjs-node-canvas';
import { azureStorageService } from '../storage/azureStorage.service.js';

// ====== CONFIG ======
const TICK_SIZE_DEFAULT = 0.05;
const BG = 'white';
const MICRO_DAILY_BARS = 120; // ~6 months of daily bars
const CHART_COLORS = {
  price: 'rgba(75, 192, 192, 1)',
  ema20: 'rgba(0, 120, 255, 0.9)',
  ema50: 'rgba(255, 165, 0, 0.9)',
  highLow: 'rgba(128, 128, 128, 0.2)',
  entry: 'rgba(0, 120, 255, 0.8)',
  stop: 'rgba(220, 20, 60, 0.85)',
  target1: 'rgba(0, 160, 0, 0.85)',
  target2: 'rgba(0, 160, 0, 0.65)',
  watermark: 'rgba(0, 0, 0, 0.1)'
};

// ====== HELPERS ======
const roundTick = (n, tick = TICK_SIZE_DEFAULT) =>
  Number.isFinite(n) ? Number((Math.round(n / tick) * tick).toFixed(2)) : null;

const toCandles = (arr = []) =>
  arr.map(a => ({ t: a[0], o:+a[1], h:+a[2], l:+a[3], c:+a[4], v:+a[5] }));

const ema = (closes = [], period = 20) => {
  if (!Array.isArray(closes) || closes.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = closes[0];
  out.push(prev);
  for (let i = 1; i < closes.length; i++) {
    const v = closes[i] * k + prev * (1 - k);
    out.push(v);
    prev = v;
  }
  return out;
};

function pickLevelsFromReview(reviewResult) {
  const rr = Array.isArray(reviewResult) ? reviewResult[0] : reviewResult;
  if (!rr || !rr.analysis) return null;

  const plan = rr.analysis?.plan || null;
  const cp   = rr.analysis?.userReview?.correctedPlan || null;

  const choose = (src) => {
    if (!src) return null;
    const sideOk = src.side && src.side !== 'none';
    const hasNums =
      isFinite(+src.entry) && isFinite(+src.stop) &&
      Array.isArray(src.targets) && isFinite(+src.targets[0]) && isFinite(+src.targets[1]);
    return sideOk && hasNums ? src : null;
  };

  const src = choose(plan) || choose(cp);
  if (!src) return null;

  const tick = +(
    rr.analysis?.meta?.tickSize ??
    rr.meta?.tickSize ??
    TICK_SIZE_DEFAULT
  );

  const roundToTick = (n) => {
    const x = Number(n);
    if (!isFinite(x) || !isFinite(tick) || tick <= 0) return x;
    const r = Math.round(x / tick) * tick;
    return Number(r.toFixed(2));
  };

  const cleanNum = (n) => roundToTick(Number(n));

  return {
    side: String(src.side).toLowerCase(),
    entry:  cleanNum(src.entry),
    stop:   cleanNum(src.stop),
    t1:     cleanNum(src.targets?.[0]),
    t2:     cleanNum(src.targets?.[1]),
    triggerSummary: String(src.trigger || '').slice(0, 140)
  };
}

// Dashed horizontal line dataset stub
const hLine = (y, label, color = 'rgba(0,0,0,0.35)') => ({
  type: 'line',
  label,
  data: [],
  parsing: false,
  borderWidth: 1.5,
  borderColor: color,
  pointRadius: 0,
  _hline: y
});

// Plugin to draw full-width hlines + watermarks + top-right chip
const HLINE_PLUGIN = {
  id: 'hline',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales, canvas, options } = chart;

    for (const ds of chart.config.data.datasets) {
      if (ds._hline == null) continue;
      const yPix = scales.y.getPixelForValue(ds._hline);
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = ds.borderColor || 'rgba(0,0,0,0.35)';
      ctx.lineWidth = ds.borderWidth ?? 1.5;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, yPix);
      ctx.lineTo(chartArea.right, yPix);
      ctx.stroke();

      if (ds.label && !/High|Low/.test(ds.label)) {
        const label = `${ds.label} ${Number(ds._hline).toFixed(2)}`;
        ctx.fillStyle = ds.borderColor || 'rgba(0,0,0,0.7)';
        ctx.font = 'bold 11px Arial';
        ctx.textAlign = 'right';
        ctx.fillText(label, chartArea.right - 5, yPix - 2);
      }
      ctx.restore();
    }

    const wm = options._chartWatermarks || {};

    if (wm.timestamp) {
      ctx.save();
      ctx.fillStyle = CHART_COLORS.watermark;
      ctx.font = '11px Arial';
      ctx.textAlign = 'left';
      ctx.fillText(wm.timestamp, chartArea.left + 5, canvas.height - 10);
      ctx.restore();
    }

    if (wm.symbol) {
      ctx.save();
      ctx.fillStyle = CHART_COLORS.watermark;
      ctx.font = '11px Arial';
      ctx.textAlign = 'right';
      ctx.fillText(wm.symbol, chartArea.right - 5, canvas.height - 10);
      ctx.restore();
    }

    if (wm.contextChip) {
      ctx.save();
      const chipText = wm.contextChip;
      const chipPadding = 8;
      const chipHeight = 22;

      let chipBgColor = 'rgba(0, 0, 0, 0.7)';
      if (chipText === 'W1&D1 Bullish') chipBgColor = 'rgba(0, 160, 0, 0.8)';
      else if (chipText === 'W1&D1 Bearish') chipBgColor = 'rgba(220, 20, 60, 0.85)';
      else chipBgColor = 'rgba(255, 140, 0, 0.85)';

      ctx.font = 'bold 11px Arial';
      const textWidth = ctx.measureText(chipText).width;
      const chipWidth = textWidth + chipPadding * 2;

      const chipX = chartArea.right - chipWidth - 8;
      const chipY = chartArea.top + 8;

      ctx.fillStyle = chipBgColor;
      ctx.fillRect(chipX, chipY, chipWidth, chipHeight);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.textAlign = 'center';
      ctx.fillText(chipText, chipX + chipWidth / 2, chipY + chipHeight / 2 + 4);

      ctx.restore();
    }
  }
};

// ====== CONFIG BUILDERS ======
function makeChartConfig({ candles, ema20, ema50, levels, symbol, timestamp, contextChip, xLabelFmt }) {
  const datasets = [
    // Price line
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
    },
    // EMA20
    {
      type: 'line',
      label: 'EMA20',
      data: ema20.map((y, i) => ({ x: i, y })),
      borderColor: CHART_COLORS.ema20,
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    },
    // EMA50
    {
      type: 'line',
      label: 'EMA50',
      data: ema50.map((y, i) => ({ x: i, y })),
      borderColor: CHART_COLORS.ema50,
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false
    }
  ];

  if (levels) {
    const { entry, stop, t1, t2 } = levels;
    if (Number.isFinite(entry)) datasets.push(hLine(entry, 'Entry', CHART_COLORS.entry));
    if (Number.isFinite(stop))  datasets.push(hLine(stop,  'SL',    CHART_COLORS.stop));
    if (Number.isFinite(t1))    datasets.push(hLine(t1,    'T1',    CHART_COLORS.target1));
    if (Number.isFinite(t2))    datasets.push(hLine(t2,    'T2',    CHART_COLORS.target2));
  }

  return {
    type: 'line',
    data: { datasets },
    options: {
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: {
          type: 'category',
          grid: { display: false },
          labels: candles.map((c, i) => xLabelFmt ? xLabelFmt(c.t, i, candles.length) : ''),
          ticks: { maxRotation: 45, minRotation: 45 }
        },
        y: {
          ticks: { maxTicksLimit: 6 },
          min: (ctx) => {
            const { datasets } = ctx.chart.data;
            let minY = Infinity;
            let minL = Infinity;
            for (const ds of datasets) {
              if (Array.isArray(ds.data)) {
                ds.data.forEach(pt => { if (pt?.y < minY) minY = pt.y; });
              }
              if (ds._hline != null && ds._hline < minL) minL = ds._hline;
            }
            const base = Math.min(minY, minL);
            return Number.isFinite(base) ? base - 5 : undefined;
          },
          max: (ctx) => {
            const { datasets } = ctx.chart.data;
            let maxY = -Infinity;
            let maxL = -Infinity;
            for (const ds of datasets) {
              if (Array.isArray(ds.data)) {
                ds.data.forEach(pt => { if (pt?.y > maxY) maxY = pt.y; });
              }
              if (ds._hline != null && ds._hline > maxL) maxL = ds._hline;
            }
            const base = Math.max(maxY, maxL);
            return Number.isFinite(base) ? base + 5 : undefined;
          }
        }
      },
      layout: { padding: { top: contextChip ? 30 : 6, right: 8, bottom: (timestamp || symbol) ? 25 : 8, left: 8 } },
      _chartWatermarks: { symbol, timestamp, contextChip }
    },
    plugins: [HLINE_PLUGIN]
  };
}

// ====== RENDERER ======
async function renderPngBuffers({ payload, levels }) {
  const tick = +(payload?.meta?.tickSize ?? TICK_SIZE_DEFAULT);

  const nowIST = new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata'
  });

  const symbol = payload?.meta?.symbol || 'STOCK';
  const timestamp = `Generated ${nowIST} IST`;

  // Data (snapshots supplied by buildMediumTermReviewPayload)
  const bars1D = payload?.snapshots?.lastBars1D || [];
  const bars1W = payload?.snapshots?.lastBars1W || [];

  if (!bars1D.length || !bars1W.length) {
    throw new Error('missing_snapshot_bars_medium');
  }

  const dailyC = toCandles(bars1D);
  const weeklyC = toCandles(bars1W);

  // Compute EMAs for each view
  const dCloses = dailyC.map(c => c.c);
  const wCloses = weeklyC.map(c => c.c);
  const dEma20 = ema(dCloses, 20);
  const dEma50 = ema(dCloses, 50);
  const wEma20 = ema(wCloses, 20);
  const wEma50 = ema(wCloses, 50);

  // Levels rounding to tick
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

  // Context chip: W1&D1 Bullish/Bearish/Mixed
  const biasW = payload?.trendMomentum?.biasWeekly || payload?.meta?.biasWeekly || 'neutral';
  const biasD = payload?.trendMomentum?.biasDaily  || payload?.meta?.biasDaily  || 'neutral';
  let contextChip = 'Mixed/Neutral';
  if (biasW === 'bullish' && biasD === 'bullish') contextChip = 'W1&D1 Bullish';
  else if (biasW === 'bearish' && biasD === 'bearish') contextChip = 'W1&D1 Bearish';

  // Trims
  const microDaily = dailyC.slice(-MICRO_DAILY_BARS);
  const microEma20 = dEma20.slice(-MICRO_DAILY_BARS);
  const microEma50 = dEma50.slice(-MICRO_DAILY_BARS);

  // Canvases
  const microCanvas = new ChartJSNodeCanvas({ width: 800,  height: 360, backgroundColour: BG });
  const fullCanvas  = new ChartJSNodeCanvas({ width: 1400, height: 700, backgroundColour: BG });

  // Label formatters
  const xLblDaily = (ts, i, n) => {
    if (i % 10 !== 0 && i !== n - 1) return '';
    const d = new Date(ts);
    const day = String(d.getDate()).padStart(2, '0');
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    return `${day}/${mon}`;
  };
  const xLblWeekly = (ts, i, n) => {
    if (i % 4 !== 0 && i !== n - 1) return '';
    const d = new Date(ts);
    const day = String(d.getDate()).padStart(2, '0');
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    const yr  = String(d.getFullYear()).slice(-2);
    return `${day}/${mon}/${yr}`;
  };

  // Build configs
  const microCfg = makeChartConfig({
    candles: microDaily,
    ema20: microEma20,
    ema50: microEma50,
    levels: lvls,
    symbol,
    timestamp,
    contextChip,
    xLabelFmt: xLblDaily
  });

  const fullCfg = makeChartConfig({
    candles: weeklyC,
    ema20: wEma20,
    ema50: wEma50,
    levels: lvls,
    symbol,
    timestamp,
    contextChip, // also show on weekly
    xLabelFmt: xLblWeekly
  });

  const microPng = await microCanvas.renderToBuffer(microCfg);
  const fullPng  = await fullCanvas.renderToBuffer(fullCfg);

  return { microPng, fullPng, levels: lvls };
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
 * @param {Object} payload - medium-term payload (snapshots.lastBars1D/1W present)
 * @param {Array|Object} reviewResult - model review result (plan/correctedPlan levels)
 * @param {String} tag - file name tag
 * @returns {{microUrl:string, fullUrl:string, levels:Object|null}}
 */
export async function createAndUploadMediumTermCharts(payload, reviewResult, tag = 'medium-chart') {
  // 1) Choose levels from review (plan > correctedPlan)
  const picked = pickLevelsFromReview(reviewResult);

  // 2) Render
  const { microPng, fullPng, levels } = await renderPngBuffers({
    payload,
    levels: picked || undefined
  });

  // 3) Names
  const safeTag = (tag || 'medium-chart').toString().trim().toLowerCase().replace(/\s+/g, '-');
  const stamp   = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const microName = `${safeTag}-${stamp}-micro.png`;
  const fullName  = `${safeTag}-${stamp}-full.png`;

  // 4) Upload (Azure → local fallback)
  let microUrl = await uploadBufferViaService(microPng, microName);
  let fullUrl  = await uploadBufferViaService(fullPng,  fullName);

  if (!microUrl) microUrl = await saveBufferToLocal(microPng, microName);
  if (!fullUrl)  fullUrl  = await saveBufferToLocal(fullPng,  fullName);

  return { microUrl, fullUrl, levels };
}

export default { createAndUploadMediumTermCharts };