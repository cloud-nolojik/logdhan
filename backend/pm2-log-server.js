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

// Simple web interface
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>PM2 Log Viewer</title>
        <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .container { max-width: 1200px; margin: 0 auto; }
            .log-container { background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 10px 0; }
            .log-content { background: #000; color: #0f0; padding: 10px; border-radius: 3px; font-family: monospace; white-space: pre-wrap; max-height: 400px; overflow-y: auto; }
            .controls { margin: 10px 0; }
            button { padding: 8px 16px; margin: 5px; cursor: pointer; }
            select, input { padding: 5px; margin: 5px; }
            .error { color: red; }
            .info { color: blue; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>PM2 Log Viewer</h1>
            
            <div class="controls">
                <button onclick="loadProcesses()">Refresh Processes</button>
                <select id="processSelect">
                    <option value="">Select Process</option>
                </select>
                <select id="logType">
                    <option value="both">Both (Out + Error)</option>
                    <option value="out">Output Only</option>
                    <option value="error">Error Only</option>
                </select>
                <input type="number" id="lineCount" value="50" min="1" max="1000" placeholder="Lines">
                <button onclick="loadLogs()">Load Logs</button>
                <button onclick="loadAllLogs()">All Processes</button>
            </div>

            <div id="processInfo"></div>
            <div id="logOutput"></div>
        </div>

        <script>
            async function loadProcesses() {
                try {
                    const response = await fetch('/api/pm2/list');
                    const processes = await response.json();
                    
                    const select = document.getElementById('processSelect');
                    select.innerHTML = '<option value="">Select Process</option>';
                    
                    processes.forEach(proc => {
                        const option = document.createElement('option');
                        option.value = proc.name;
                        option.textContent = \`\${proc.name} (pid: \${proc.pid}, status: \${proc.pm2_env.status})\`;
                        select.appendChild(option);
                    });
                    
                    document.getElementById('processInfo').innerHTML = 
                        \`<p class="info">Found \${processes.length} PM2 processes</p>\`;
                } catch (error) {
                    document.getElementById('processInfo').innerHTML = 
                        \`<p class="error">Failed to load processes: \${error.message}</p>\`;
                }
            }

            async function loadLogs() {
                const processName = document.getElementById('processSelect').value;
                const logType = document.getElementById('logType').value;
                const lines = document.getElementById('lineCount').value;
                
                if (!processName) {
                    alert('Please select a process');
                    return;
                }

                try {
                    const response = await fetch(\`/api/pm2/logs/\${processName}?type=\${logType}&lines=\${lines}\`);
                    const data = await response.json();
                    
                    document.getElementById('logOutput').innerHTML = \`
                        <div class="log-container">
                            <h3>Logs for \${processName} (\${data.type}, last \${data.lines} lines)</h3>
                            <div class="log-content">\${data.logs}</div>
                        </div>
                    \`;
                } catch (error) {
                    document.getElementById('logOutput').innerHTML = 
                        \`<p class="error">Failed to load logs: \${error.message}</p>\`;
                }
            }

            async function loadAllLogs() {
                const lines = document.getElementById('lineCount').value;
                
                try {
                    const response = await fetch(\`/api/pm2/logs?lines=\${lines}\`);
                    const data = await response.json();
                    
                    document.getElementById('logOutput').innerHTML = \`
                        <div class="log-container">
                            <h3>All PM2 Logs (last \${data.lines} lines)</h3>
                            <div class="log-content">\${data.logs}</div>
                        </div>
                    \`;
                } catch (error) {
                    document.getElementById('logOutput').innerHTML = 
                        \`<p class="error">Failed to load logs: \${error.message}</p>\`;
                }
            }

            // Auto-load processes on page load
            loadProcesses();
        </script>
    </body>
    </html>
  `);
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