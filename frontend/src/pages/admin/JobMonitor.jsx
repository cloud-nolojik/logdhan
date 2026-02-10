import React, { useState, useEffect, useCallback } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://swingsetups.com';

function timeAgo(dateStr) {
  if (!dateStr) return 'Never';
  const now = new Date();
  const date = new Date(dateStr);
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

function getStatusColor(job) {
  if (!job.stats?.isInitialized) return { bg: 'bg-gray-100', text: 'text-gray-500', dot: 'bg-gray-400', label: 'Not Init' };
  if (job.stats?.isRunning) return { bg: 'bg-yellow-50', text: 'text-yellow-700', dot: 'bg-yellow-400', label: 'Running' };
  if (job.agenda?.failReason || job.lastFailure) return { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500', label: 'Failed' };
  return { bg: 'bg-green-50', text: 'text-green-700', dot: 'bg-green-500', label: 'OK' };
}

function JobCard({ job, onTrigger, triggeringJob }) {
  const [expanded, setExpanded] = useState(false);
  const status = getStatusColor(job);
  const isTriggering = triggeringJob === job.key;

  const failReason = job.agenda?.failReason || job.lastFailure?.failReason;
  const failCount = job.agenda?.failCount || job.lastFailure?.failCount || 0;

  return (
    <div className={`rounded-lg border ${status.bg} border-gray-200 p-4 transition-all`}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`w-2.5 h-2.5 rounded-full ${status.dot} flex-shrink-0`}></span>
            <h3 className="font-semibold text-gray-800 text-sm truncate">{job.name}</h3>
            <span className={`text-xs px-1.5 py-0.5 rounded ${status.bg} ${status.text} font-medium`}>
              {status.label}
            </span>
          </div>
          <p className="text-gray-500 text-xs ml-4.5">{job.description}</p>
          <p className="text-gray-400 text-xs ml-4.5 mt-0.5">{job.schedule}</p>
        </div>

        <button
          onClick={() => onTrigger(job.key)}
          disabled={isTriggering}
          className="flex-shrink-0 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-md hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
        >
          {isTriggering ? 'Running...' : 'Run Now'}
        </button>
      </div>

      {/* Stats row */}
      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <div>
          <span className="text-gray-400">Last Run</span>
          <p className="text-gray-700 font-medium" title={formatDate(job.agenda?.lastRunAt || job.stats?.lastRunAt)}>
            {timeAgo(job.agenda?.lastRunAt || job.stats?.lastRunAt)}
          </p>
        </div>
        <div>
          <span className="text-gray-400">Next Run</span>
          <p className="text-gray-700 font-medium">{formatDate(job.agenda?.nextRunAt)}</p>
        </div>
        <div>
          <span className="text-gray-400">Runs</span>
          <p className="text-gray-700 font-medium">{job.stats?.runsCompleted ?? '-'}</p>
        </div>
        <div>
          <span className="text-gray-400">Errors</span>
          <p className={`font-medium ${(job.stats?.errors || 0) > 0 ? 'text-red-600' : 'text-gray-700'}`}>
            {job.stats?.errors ?? '-'}
          </p>
        </div>
      </div>

      {/* Fail reason (expandable) */}
      {failReason && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-red-600 hover:text-red-800 flex items-center gap-1"
          >
            <span>{expanded ? 'Hide' : 'Show'} error</span>
            <span className="text-gray-400">(failed {failCount}x)</span>
          </button>
          {expanded && (
            <pre className="mt-1 text-xs bg-red-50 border border-red-200 rounded p-2 overflow-x-auto whitespace-pre-wrap text-red-800 max-h-40 overflow-y-auto">
              {failReason}
            </pre>
          )}
        </div>
      )}

      {/* Extra stats for specific jobs */}
      {job.stats && (
        <div className="mt-2 flex flex-wrap gap-2">
          {job.stats.stocksProcessed != null && (
            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
              Stocks: {job.stats.stocksProcessed}
            </span>
          )}
          {job.stats.alertsTriggered != null && (
            <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">
              Alerts: {job.stats.alertsTriggered}
            </span>
          )}
          {job.stats.phase1Stocks != null && (
            <span className="text-xs bg-teal-100 text-teal-700 px-2 py-0.5 rounded">
              P1: {job.stats.phase1Stocks} / P2: {job.stats.phase2Stocks}
            </span>
          )}
          {job.stats.trackedInstruments != null && (
            <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded">
              Tracked: {job.stats.trackedInstruments}
            </span>
          )}
          {job.stats.isRunning != null && job.key === 'priceCache' && (
            <span className={`text-xs px-2 py-0.5 rounded ${job.stats.isRunning ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
              {job.stats.isRunning ? 'Polling Active' : 'Polling Stopped'}
            </span>
          )}
          {job.agenda?.lockedAt && (
            <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">
              Locked: {timeAgo(job.agenda.lockedAt)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function JobMonitor() {
  const [jobs, setJobs] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [triggeringJob, setTriggeringJob] = useState(null);
  const [toast, setToast] = useState(null);
  const [flushing, setFlushing] = useState(false);

  const getToken = () => localStorage.getItem('token');

  const fetchStatus = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setError('No auth token found. Please login in the app first.');
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/job-monitor/status`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (response.status === 401 || response.status === 403) {
        setError('Not authorized. This page is restricted.');
        setLoading(false);
        return;
      }

      const data = await response.json();

      if (data.success) {
        setJobs(data.data.jobs);
        setSummary(data.data.summary);
        setError(null);
        setLastRefresh(new Date());
      } else {
        setError(data.error || 'Failed to fetch status');
      }
    } catch (e) {
      setError('Connection error: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Auto-refresh every 30s
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchStatus]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleTrigger = async (jobKey) => {
    const token = getToken();
    if (!token) return;

    setTriggeringJob(jobKey);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/job-monitor/trigger/${jobKey}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();

      if (data.success) {
        setToast({ type: 'success', message: `${data.data.jobName || jobKey} triggered successfully` });
        // Refresh status after short delay
        setTimeout(fetchStatus, 2000);
      } else {
        setToast({ type: 'error', message: data.error || 'Failed to trigger job' });
      }
    } catch (e) {
      setToast({ type: 'error', message: 'Connection error: ' + e.message });
    } finally {
      setTriggeringJob(null);
    }
  };

  const handleFlushLogs = async () => {
    const token = getToken();
    if (!token) return;

    setFlushing(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/job-monitor/flush-logs`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();

      if (data.success) {
        setToast({ type: 'success', message: 'PM2 logs cleared successfully' });
      } else {
        setToast({ type: 'error', message: data.error || 'Failed to clear logs' });
      }
    } catch (e) {
      setToast({ type: 'error', message: 'Connection error: ' + e.message });
    } finally {
      setFlushing(false);
    }
  };

  // Error / loading states
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full mx-auto mb-3"></div>
          <p className="text-gray-500">Loading job status...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-lg p-8 max-w-md w-full text-center">
          <div className="text-4xl mb-4 text-red-400">X</div>
          <h2 className="text-xl font-bold text-gray-800 mb-2">Access Denied</h2>
          <p className="text-gray-500">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-gray-800">Job Monitor</h1>
              <p className="text-xs text-gray-400 mt-0.5">
                {lastRefresh ? `Updated ${timeAgo(lastRefresh)}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleFlushLogs}
                disabled={flushing}
                className="px-3 py-1.5 text-sm bg-red-500 hover:bg-red-600 text-white rounded-md transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                {flushing ? 'Clearing...' : 'Clear Logs'}
              </button>
              <button
                onClick={fetchStatus}
                className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-md transition-colors"
              >
                Refresh
              </button>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                <span className="text-xs text-gray-500">Auto (30s)</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 py-4">
        {/* Summary cards */}
        {summary && (
          <div className="grid grid-cols-4 gap-3 mb-4">
            <div className="bg-white rounded-lg shadow-sm p-3 text-center">
              <p className="text-2xl font-bold text-gray-800">{summary.total}</p>
              <p className="text-xs text-gray-400">Total</p>
            </div>
            <div className="bg-white rounded-lg shadow-sm p-3 text-center">
              <p className="text-2xl font-bold text-green-600">{summary.initialized}</p>
              <p className="text-xs text-gray-400">Initialized</p>
            </div>
            <div className="bg-white rounded-lg shadow-sm p-3 text-center">
              <p className="text-2xl font-bold text-yellow-600">{summary.running}</p>
              <p className="text-xs text-gray-400">Running</p>
            </div>
            <div className="bg-white rounded-lg shadow-sm p-3 text-center">
              <p className={`text-2xl font-bold ${summary.failed > 0 ? 'text-red-600' : 'text-gray-800'}`}>{summary.failed}</p>
              <p className="text-xs text-gray-400">Failed</p>
            </div>
          </div>
        )}

        {/* Job list */}
        <div className="space-y-3">
          {jobs.map(job => (
            <JobCard
              key={job.key}
              job={job}
              onTrigger={handleTrigger}
              triggeringJob={triggeringJob}
            />
          ))}
        </div>
      </div>

      {/* Toast notification */}
      {toast && (
        <div className={`fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg shadow-lg text-sm font-medium z-50 transition-all ${
          toast.type === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}
