#!/usr/bin/env node

import express from 'express';
import { exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const app = express();
const PORT = process.env.LOG_SERVER_PORT || 3001;

// Enable CORS and JSON parsing
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use(express.json());

// Get PM2 home directory
const PM2_HOME = process.env.PM2_HOME || path.join(os.homedir(), '.pm2');
const LOGS_DIR = path.join(PM2_HOME, 'logs');

// Helper function to execute PM2 commands
function execPM2Command(command) {
  return new Promise((resolve, reject) => {
    exec(`pm2 ${command}`, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message, stderr });
      } else {
        resolve(stdout);
      }
    });
  });
}

// Get list of PM2 processes
app.get('/api/pm2/list', async (req, res) => {
  try {
    const output = await execPM2Command('jlist');
    const processes = JSON.parse(output);
    res.json(processes);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get PM2 process list', details: error });
  }
});

// Get logs for a specific process
app.get('/api/pm2/logs/:processName', async (req, res) => {
  const { processName } = req.params;
  const { lines = 50, type = 'both' } = req.query;

  try {
    let command;
    if (type === 'error') {
      command = `logs ${processName} --err --lines ${lines}`;
    } else if (type === 'out') {
      command = `logs ${processName} --out --lines ${lines}`;
    } else {
      command = `logs ${processName} --lines ${lines}`;
    }

    const output = await execPM2Command(command);
    res.json({ 
      processName, 
      type, 
      lines: parseInt(lines),
      logs: output 
    });
  } catch (error) {
    res.status(500).json({ 
      error: `Failed to get logs for process ${processName}`, 
      details: error 
    });
  }
});

// Get logs for all processes
app.get('/api/pm2/logs', async (req, res) => {
  const { lines = 50 } = req.query;

  try {
    const output = await execPM2Command(`logs --lines ${lines}`);
    res.json({ 
      lines: parseInt(lines),
      logs: output 
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to get all logs', 
      details: error 
    });
  }
});

// Stream logs in real-time (experimental)
app.get('/api/pm2/logs/:processName/stream', (req, res) => {
  const { processName } = req.params;
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const child = exec(`pm2 logs ${processName} --lines 0`);
  
  child.stdout.on('data', (data) => {
    res.write(`data: ${JSON.stringify({ type: 'log', data: data.toString() })}\n\n`);
  });

  child.stderr.on('data', (data) => {
    res.write(`data: ${JSON.stringify({ type: 'error', data: data.toString() })}\n\n`);
  });

  child.on('close', (code) => {
    res.write(`data: ${JSON.stringify({ type: 'close', code })}\n\n`);
    res.end();
  });

  req.on('close', () => {
    child.kill();
  });
});

// Get raw log files list
app.get('/api/pm2/logfiles', (req, res) => {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      return res.status(404).json({ error: 'PM2 logs directory not found' });
    }

    const files = fs.readdirSync(LOGS_DIR)
      .filter(file => file.endsWith('.log'))
      .map(file => {
        const filePath = path.join(LOGS_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          size: stats.size,
          modified: stats.mtime,
          path: filePath
        };
      });

    res.json(files);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read log files', details: error.message });
  }
});

// Read raw log file content
app.get('/api/pm2/logfile/:filename', (req, res) => {
  const { filename } = req.params;
  const { lines = 100, tail = true } = req.query;
  
  const filePath = path.join(LOGS_DIR, filename);
  
  if (!fs.existsSync(filePath) || !filename.endsWith('.log')) {
    return res.status(404).json({ error: 'Log file not found' });
  }

  try {
    if (tail === 'true') {
      exec(`tail -n ${lines} "${filePath}"`, (error, stdout, stderr) => {
        if (error) {
          return res.status(500).json({ error: 'Failed to read log file', details: error.message });
        }
        res.json({ 
          filename, 
          lines: parseInt(lines),
          content: stdout 
        });
      });
    } else {
      exec(`head -n ${lines} "${filePath}"`, (error, stdout, stderr) => {
        if (error) {
          return res.status(500).json({ error: 'Failed to read log file', details: error.message });
        }
        res.json({ 
          filename, 
          lines: parseInt(lines),
          content: stdout 
        });
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to read log file', details: error.message });
  }
});

// Web interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>SwingSetups.ai - Live Logs</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0f172a; color: #e2e8f0; min-height: 100vh; }

            .header {
                background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e3a5f 100%);
                padding: 20px 24px;
                border-bottom: 1px solid rgba(99, 102, 241, 0.3);
            }
            .header h1 { font-size: 22px; font-weight: 700; margin-bottom: 16px; }
            .header h1 span.fire { margin-right: 6px; }

            .controls {
                display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
            }
            .controls select {
                background: #1e293b; color: #e2e8f0; border: 1px solid #334155;
                padding: 8px 12px; border-radius: 6px; font-size: 13px; cursor: pointer;
            }
            .btn {
                padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500;
                cursor: pointer; border: 1px solid #334155; background: #1e293b; color: #e2e8f0;
                transition: all 0.15s;
            }
            .btn:hover { background: #334155; }
            .btn-danger { border-color: #dc2626; color: #fca5a5; }
            .btn-danger:hover { background: #dc2626; color: #fff; }

            .live-badge {
                display: inline-flex; align-items: center; gap: 6px;
                padding: 6px 14px; border-radius: 20px;
                background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4);
                font-size: 12px; font-weight: 600; color: #fca5a5;
            }
            .live-dot {
                width: 8px; height: 8px; border-radius: 50%; background: #ef4444;
                animation: pulse 1.5s infinite;
            }
            .live-badge.paused { background: rgba(100, 116, 139, 0.2); border-color: #475569; color: #94a3b8; }
            .live-badge.paused .live-dot { background: #64748b; animation: none; }
            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

            .log-area {
                flex: 1; padding: 16px 24px; overflow: hidden; display: flex; flex-direction: column;
            }
            .log-content {
                flex: 1; background: #020617; border: 1px solid #1e293b; border-radius: 8px;
                padding: 16px; font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
                font-size: 12.5px; line-height: 1.7; color: #67e8f9;
                overflow-y: auto; white-space: pre-wrap; word-break: break-all;
                min-height: calc(100vh - 160px);
            }
            .log-content::-webkit-scrollbar { width: 8px; }
            .log-content::-webkit-scrollbar-track { background: #0f172a; }
            .log-content::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }

            .log-line { display: block; padding: 1px 0; }

            .status-bar {
                padding: 6px 24px; background: #0f172a; border-top: 1px solid #1e293b;
                font-size: 11px; color: #64748b; display: flex; justify-content: space-between;
            }

            .toast {
                position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
                padding: 10px 20px; border-radius: 8px; font-size: 13px; font-weight: 500;
                z-index: 100; transition: opacity 0.3s; opacity: 0;
            }
            .toast.show { opacity: 1; }
            .toast.success { background: #065f46; color: #6ee7b7; border: 1px solid #059669; }
            .toast.error { background: #7f1d1d; color: #fca5a5; border: 1px solid #dc2626; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1><span class="fire">🔥</span> SwingSetups.ai  -  Live Logs</h1>
            <div class="controls">
                <select id="processSelect" onchange="switchProcess()">
                    <option value="">Loading...</option>
                </select>
                <button class="btn btn-danger" onclick="clearDisplay()">Clear Display</button>
                <button class="btn" onclick="flushLogs()">Flush PM2 Logs</button>
                <button class="btn" onclick="toggleAutoRefresh()" id="autoRefreshBtn">Toggle Auto-Refresh</button>
                <button class="btn" onclick="downloadLogs()">Download</button>
                <div class="live-badge" id="liveBadge">
                    <div class="live-dot"></div>
                    LIVE
                </div>
            </div>
        </div>

        <div class="log-area">
            <div class="log-content" id="logOutput">Connecting...</div>
        </div>

        <div class="status-bar">
            <span id="statusLeft">Lines: 0</span>
            <span id="statusRight">Last updated: -</span>
        </div>

        <div class="toast" id="toast"></div>

        <script>
            let autoRefresh = true;
            let refreshInterval = null;
            let currentProcess = '';
            let lineCount = 200;

            function showToast(message, type = 'success') {
                const t = document.getElementById('toast');
                t.textContent = message;
                t.className = 'toast show ' + type;
                setTimeout(() => t.className = 'toast', 3000);
            }

            async function loadProcesses() {
                try {
                    const res = await fetch('/api/pm2/list');
                    const procs = await res.json();
                    const select = document.getElementById('processSelect');
                    select.innerHTML = '';

                    // Add "All" option
                    const allOpt = document.createElement('option');
                    allOpt.value = '__all__';
                    allOpt.textContent = 'All Processes';
                    select.appendChild(allOpt);

                    procs.forEach(p => {
                        const opt = document.createElement('option');
                        opt.value = p.name;
                        opt.textContent = p.name + ' (' + p.pm2_env.status + ')';
                        select.appendChild(opt);
                    });

                    // Default to first real process if available
                    if (procs.length > 0) {
                        select.value = procs[0].name;
                        currentProcess = procs[0].name;
                    }
                    fetchLogs();
                } catch (e) {
                    document.getElementById('logOutput').textContent = 'Failed to load processes: ' + e.message;
                }
            }

            function switchProcess() {
                currentProcess = document.getElementById('processSelect').value;
                document.getElementById('logOutput').textContent = 'Loading...';
                fetchLogs();
            }

            async function fetchLogs() {
                try {
                    let url;
                    if (currentProcess === '__all__' || !currentProcess) {
                        url = '/api/pm2/logs?lines=' + lineCount;
                    } else {
                        url = '/api/pm2/logs/' + currentProcess + '?type=out&lines=' + lineCount;
                    }

                    const res = await fetch(url);
                    const data = await res.json();
                    const logEl = document.getElementById('logOutput');
                    const wasAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 50;

                    logEl.textContent = data.logs || 'No logs available';

                    if (wasAtBottom) {
                        logEl.scrollTop = logEl.scrollHeight;
                    }

                    const lines = (data.logs || '').split('\\n').filter(l => l.trim()).length;
                    document.getElementById('statusLeft').textContent = 'Lines: ' + lines;
                    document.getElementById('statusRight').textContent = 'Last updated: ' + new Date().toLocaleTimeString();
                } catch (e) {
                    document.getElementById('logOutput').textContent = 'Error fetching logs: ' + e.message;
                }
            }

            function clearDisplay() {
                document.getElementById('logOutput').textContent = '';
                document.getElementById('statusLeft').textContent = 'Lines: 0';
                showToast('Display cleared');
            }

            async function flushLogs() {
                if (!confirm('This will permanently delete all PM2 log files on the server. Continue?')) return;
                try {
                    const body = currentProcess && currentProcess !== '__all__'
                        ? JSON.stringify({ processName: currentProcess })
                        : '{}';
                    const res = await fetch('/api/pm2/flush', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body
                    });
                    const data = await res.json();
                    if (data.success) {
                        document.getElementById('logOutput').textContent = '';
                        showToast(data.message);
                    } else {
                        showToast('Failed to flush: ' + (data.error || 'Unknown error'), 'error');
                    }
                } catch (e) {
                    showToast('Error: ' + e.message, 'error');
                }
            }

            function toggleAutoRefresh() {
                autoRefresh = !autoRefresh;
                const badge = document.getElementById('liveBadge');
                const btn = document.getElementById('autoRefreshBtn');

                if (autoRefresh) {
                    startAutoRefresh();
                    badge.className = 'live-badge';
                    badge.innerHTML = '<div class="live-dot"></div> LIVE';
                    showToast('Auto-refresh enabled (5s)');
                } else {
                    stopAutoRefresh();
                    badge.className = 'live-badge paused';
                    badge.innerHTML = '<div class="live-dot"></div> PAUSED';
                    showToast('Auto-refresh paused');
                }
            }

            function startAutoRefresh() {
                stopAutoRefresh();
                refreshInterval = setInterval(fetchLogs, 5000);
            }

            function stopAutoRefresh() {
                if (refreshInterval) {
                    clearInterval(refreshInterval);
                    refreshInterval = null;
                }
            }

            function downloadLogs() {
                const logs = document.getElementById('logOutput').textContent;
                const blob = new Blob([logs], { type: 'text/plain' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = (currentProcess || 'all') + '-logs-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.txt';
                a.click();
                URL.revokeObjectURL(url);
                showToast('Logs downloaded');
            }

            // Init
            loadProcesses();
            startAutoRefresh();
        </script>
    </body>
    </html>
  `);
});

// Flush (clear) PM2 logs
app.post('/api/pm2/flush', async (req, res) => {
  const { processName } = req.body || {};

  try {
    if (processName) {
      await execPM2Command(`flush ${processName}`);
      res.json({ success: true, message: `Logs flushed for ${processName}` });
    } else {
      await execPM2Command('flush');
      res.json({ success: true, message: 'All PM2 logs flushed' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to flush logs', details: error });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    pm2Home: PM2_HOME,
    logsDir: LOGS_DIR
  });
});

app.listen(PORT, () => {
  console.log(`PM2 Log Server running on port ${PORT}`);
  console.log(`Web interface: http://localhost:${PORT}`);
  console.log(`API endpoints:`);
  console.log(`  GET /api/pm2/list - List all PM2 processes`);
  console.log(`  GET /api/pm2/logs - Get all logs`);
  console.log(`  GET /api/pm2/logs/:processName - Get logs for specific process`);
  console.log(`  GET /api/pm2/logfiles - List log files`);
  console.log(`  GET /api/pm2/logfile/:filename - Read raw log file`);
  console.log(`  GET /health - Health check`);
});