import React, { useState, useEffect } from 'react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5650';

export default function WhatsAppAlerts() {
  // Auth state
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // Main UI state
  const [users, setUsers] = useState([]);
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [alertType, setAlertType] = useState('weekly');
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 50,
    total: 0,
    pages: 0
  });
  const [summary, setSummary] = useState({
    totalUsers: 0,
    usersWithApp: 0,
    usersWithoutApp: 0
  });

  // Send status
  const [sendingStatus, setSendingStatus] = useState(null);

  // Check for existing token on mount
  useEffect(() => {
    const token = localStorage.getItem('adminToken');
    if (token) {
      setIsLoggedIn(true);
    }
  }, []);

  // Fetch users when logged in
  useEffect(() => {
    if (isLoggedIn) {
      fetchUsers();
    }
  }, [isLoggedIn, pagination.page, searchQuery]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError('');

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password })
      });

      const data = await response.json();

      if (data.success) {
        localStorage.setItem('adminToken', data.token);
        setIsLoggedIn(true);
        setPassword('');
      } else {
        setLoginError(data.error || 'Login failed');
      }
    } catch (error) {
      setLoginError('Connection error. Please try again.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('adminToken');
    setIsLoggedIn(false);
    setUsers([]);
    setSelectedUsers([]);
  };

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('adminToken');
      const response = await fetch(
        `${API_BASE_URL}/api/v1/admin/users?page=${pagination.page}&limit=${pagination.limit}&search=${searchQuery}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );

      const data = await response.json();

      if (data.success) {
        setUsers(data.data.users);
        setPagination(prev => ({
          ...prev,
          total: data.data.pagination.total,
          pages: data.data.pagination.pages
        }));
        setSummary(data.data.summary);

        // Select all users by default
        setSelectedUsers(data.data.users.map(u => u._id));
      } else if (response.status === 401) {
        // Token expired
        handleLogout();
      }
    } catch (error) {
      console.error('Error fetching users:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectAll = (checked) => {
    if (checked) {
      setSelectedUsers(users.map(u => u._id));
    } else {
      setSelectedUsers([]);
    }
  };

  const handleSelectUser = (userId, checked) => {
    if (checked) {
      setSelectedUsers([...selectedUsers, userId]);
    } else {
      setSelectedUsers(selectedUsers.filter(id => id !== userId));
    }
  };

  const handleSendAlerts = async () => {
    if (selectedUsers.length === 0) return;

    const confirmed = window.confirm(
      `Are you sure you want to send ${alertType} alerts to ${selectedUsers.length} users via WhatsApp?`
    );

    if (!confirmed) return;

    setSendingStatus({ status: 'sending', progress: 0 });

    try {
      const token = localStorage.getItem('adminToken');
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/whatsapp/bulk-send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          userIds: selectedUsers,
          alertType
        })
      });

      const data = await response.json();

      if (data.success) {
        setSendingStatus({
          status: 'complete',
          jobId: data.data.jobId,
          totalUsers: data.data.totalUsers,
          message: data.data.message
        });
      } else {
        setSendingStatus({
          status: 'error',
          message: data.error || 'Failed to send alerts'
        });
      }
    } catch (error) {
      setSendingStatus({
        status: 'error',
        message: error.message || 'Connection error'
      });
    }
  };

  // Login Screen
  if (!isLoggedIn) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
        <div className="bg-slate-800 rounded-xl p-8 w-full max-w-md">
          <h1 className="text-2xl font-bold text-white mb-6 text-center">Admin Login</h1>

          <form onSubmit={handleLogin}>
            <div className="mb-4">
              <label className="block text-slate-400 text-sm mb-2">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-emerald-500"
                placeholder="Enter admin password"
                required
              />
            </div>

            {loginError && (
              <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-lg text-red-400 text-sm">
                {loginError}
              </div>
            )}

            <button
              type="submit"
              disabled={loginLoading}
              className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-600 text-white font-semibold py-3 rounded-lg transition"
            >
              {loginLoading ? 'Logging in...' : 'Login'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Main Admin UI
  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-2xl md:text-3xl font-bold">Bulk WhatsApp Alerts</h1>
          <button
            onClick={handleLogout}
            className="text-slate-400 hover:text-white transition"
          >
            Logout
          </button>
        </div>

        {/* Alert Type Toggle */}
        <div className="bg-slate-800 rounded-lg p-4 md:p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Alert Type</h2>
          <div className="flex gap-4">
            <button
              onClick={() => setAlertType('weekly')}
              className={`px-6 py-3 rounded-lg font-medium transition ${
                alertType === 'weekly'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              Weekly Setups
            </button>
            <button
              onClick={() => setAlertType('daily')}
              className={`px-6 py-3 rounded-lg font-medium transition ${
                alertType === 'daily'
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
              }`}
            >
              Daily Analysis
            </button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-slate-800 rounded-lg p-4">
            <p className="text-slate-400 text-sm">Total Users</p>
            <p className="text-2xl font-bold">{summary.totalUsers}</p>
          </div>
          <div className="bg-slate-800 rounded-lg p-4">
            <p className="text-slate-400 text-sm">With App</p>
            <p className="text-2xl font-bold text-emerald-400">{summary.usersWithApp}</p>
          </div>
          <div className="bg-slate-800 rounded-lg p-4">
            <p className="text-slate-400 text-sm">Selected</p>
            <p className="text-2xl font-bold text-blue-400">{selectedUsers.length}</p>
          </div>
        </div>

        {/* Search and Select All */}
        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <input
            type="text"
            placeholder="Search by name or mobile..."
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setPagination(prev => ({ ...prev, page: 1 }));
            }}
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-emerald-500"
          />
          <label className="flex items-center gap-2 bg-slate-800 px-4 py-3 rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={selectedUsers.length === users.length && users.length > 0}
              onChange={(e) => handleSelectAll(e.target.checked)}
              className="w-5 h-5 rounded"
            />
            <span>Select All</span>
          </label>
        </div>

        {/* User List */}
        <div className="bg-slate-800 rounded-lg overflow-hidden mb-6">
          {loading ? (
            <div className="p-8 text-center text-slate-400">Loading users...</div>
          ) : users.length === 0 ? (
            <div className="p-8 text-center text-slate-400">No users found</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-700">
                  <tr>
                    <th className="p-3 text-left w-12">
                      <input
                        type="checkbox"
                        checked={selectedUsers.length === users.length && users.length > 0}
                        onChange={(e) => handleSelectAll(e.target.checked)}
                        className="w-5 h-5 rounded"
                      />
                    </th>
                    <th className="p-3 text-left">Name</th>
                    <th className="p-3 text-left">Mobile</th>
                    <th className="p-3 text-left">App Status</th>
                    <th className="p-3 text-left">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map(user => (
                    <tr key={user._id} className="border-t border-slate-700 hover:bg-slate-700/50">
                      <td className="p-3">
                        <input
                          type="checkbox"
                          checked={selectedUsers.includes(user._id)}
                          onChange={(e) => handleSelectUser(user._id, e.target.checked)}
                          className="w-5 h-5 rounded"
                        />
                      </td>
                      <td className="p-3">
                        {user.firstName || user.lastName
                          ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
                          : 'No name'}
                      </td>
                      <td className="p-3 font-mono text-sm text-slate-300">
                        {user.mobileNumber}
                      </td>
                      <td className="p-3">
                        {user.hasApp ? (
                          <span className="px-2 py-1 bg-emerald-500/20 text-emerald-400 rounded text-sm">
                            App Installed
                          </span>
                        ) : (
                          <span className="px-2 py-1 bg-orange-500/20 text-orange-400 rounded text-sm">
                            No App
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-slate-400 text-sm">
                        {new Date(user.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Pagination */}
        {pagination.pages > 1 && (
          <div className="flex justify-center gap-2 mb-6">
            <button
              onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
              disabled={pagination.page === 1}
              className="px-4 py-2 bg-slate-800 rounded-lg disabled:opacity-50"
            >
              Previous
            </button>
            <span className="px-4 py-2 text-slate-400">
              Page {pagination.page} of {pagination.pages}
            </span>
            <button
              onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
              disabled={pagination.page === pagination.pages}
              className="px-4 py-2 bg-slate-800 rounded-lg disabled:opacity-50"
            >
              Next
            </button>
          </div>
        )}

        {/* Send Button */}
        <div className="flex justify-end">
          <button
            onClick={handleSendAlerts}
            disabled={selectedUsers.length === 0 || sendingStatus?.status === 'sending'}
            className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-600 disabled:cursor-not-allowed px-8 py-3 rounded-lg font-semibold transition"
          >
            {sendingStatus?.status === 'sending'
              ? 'Sending...'
              : `Send ${alertType === 'weekly' ? 'Weekly' : 'Daily'} Alert to ${selectedUsers.length} Users`}
          </button>
        </div>

        {/* Status Modal */}
        {sendingStatus && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
            <div className="bg-slate-800 rounded-xl p-8 max-w-md w-full">
              {sendingStatus.status === 'sending' && (
                <div className="text-center">
                  <div className="animate-spin w-12 h-12 border-4 border-emerald-500 border-t-transparent rounded-full mx-auto mb-4"></div>
                  <p className="text-lg">Sending alerts...</p>
                  <p className="text-slate-400 text-sm mt-2">This may take a few minutes</p>
                </div>
              )}

              {sendingStatus.status === 'complete' && (
                <div className="text-center">
                  <div className="text-5xl mb-4">✓</div>
                  <p className="text-xl font-semibold mb-2">Alerts Queued!</p>
                  <p className="text-slate-400 mb-4">
                    {sendingStatus.message}
                  </p>
                  <p className="text-slate-500 text-sm mb-4">
                    Job ID: {sendingStatus.jobId}
                  </p>
                  <button
                    onClick={() => setSendingStatus(null)}
                    className="px-6 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition"
                  >
                    Close
                  </button>
                </div>
              )}

              {sendingStatus.status === 'error' && (
                <div className="text-center">
                  <div className="text-5xl mb-4 text-red-400">✕</div>
                  <p className="text-xl font-semibold mb-2 text-red-400">Error</p>
                  <p className="text-slate-400 mb-4">
                    {sendingStatus.message}
                  </p>
                  <button
                    onClick={() => setSendingStatus(null)}
                    className="px-6 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg transition"
                  >
                    Close
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
