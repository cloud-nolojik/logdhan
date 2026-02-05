import React, { useState, useEffect } from 'react';
import AdminLayout from '../../components/admin/AdminLayout';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://swingsetups.com';

function WhatsAppAlertsContent() {
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

  // Weekly watchlist data
  const [watchlistData, setWatchlistData] = useState(null);
  const [watchlistLoading, setWatchlistLoading] = useState(false);

  // Send status
  const [sendingStatus, setSendingStatus] = useState(null);

  // Notification method for weekly alerts
  const [notificationMethod, setNotificationMethod] = useState('push'); // 'push' or 'whatsapp'

  // Fetch users and watchlist on mount
  useEffect(() => {
    fetchUsers();
    if (alertType === 'weekly') {
      fetchWatchlist();
    }
  }, [pagination.page, searchQuery]);

  // Fetch watchlist when alert type changes to weekly
  useEffect(() => {
    if (alertType === 'weekly') {
      fetchWatchlist();
    }
  }, [alertType]);

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
      }
    } catch (error) {
      console.error('Error fetching users:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchWatchlist = async () => {
    setWatchlistLoading(true);
    try {
      const token = localStorage.getItem('adminToken');
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/weekly-watchlist`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await response.json();

      if (data.success) {
        setWatchlistData(data.data);
      }
    } catch (error) {
      console.error('Error fetching watchlist:', error);
    } finally {
      setWatchlistLoading(false);
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

    const method = notificationMethod;
    const methodLabel = method === 'push' ? 'Push Notification' : 'WhatsApp';

    const confirmed = window.confirm(
      `Are you sure you want to send ${alertType} alerts to ${selectedUsers.length} users via ${methodLabel}?`
    );

    if (!confirmed) return;

    setSendingStatus({ status: 'sending', progress: 0 });

    try {
      const token = localStorage.getItem('adminToken');
      const endpoint = method === 'push'
        ? `${API_BASE_URL}/api/v1/admin/push/bulk-send`
        : `${API_BASE_URL}/api/v1/admin/whatsapp/bulk-send`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          userIds: selectedUsers,
          alertType,
          watchlistData: alertType === 'weekly' && watchlistData ? {
            stockCount: watchlistData.stockCount,
            topPick: watchlistData.topPick?.symbol,
            topPickReason: watchlistData.topPick?.reason,
            runnerUp: watchlistData.runnerUp?.symbol,
            runnerUpReason: watchlistData.runnerUp?.reason
          } : null
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

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <h1 className="text-2xl font-bold text-gray-800">Bulk Alerts</h1>
        <p className="text-gray-500 mt-1">Send push notifications or WhatsApp messages to users</p>
      </div>

      {/* Alert Type Toggle */}
      <div className="bg-white rounded-lg shadow-lg p-4 md:p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Alert Type</h2>
        <div className="flex gap-4">
          <button
            onClick={() => setAlertType('weekly')}
            className={`px-6 py-3 rounded-lg font-medium transition ${
              alertType === 'weekly'
                ? 'bg-emerald-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            Weekly Setups
          </button>
          <button
            onClick={() => setAlertType('daily')}
            className={`px-6 py-3 rounded-lg font-medium transition ${
              alertType === 'daily'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            Daily Analysis
          </button>
        </div>
      </div>

      {/* Notification Method Toggle */}
      <div className="bg-white rounded-lg shadow-lg p-4 md:p-6 mb-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4">Notification Method</h2>
        <div className="flex gap-4">
          <button
            onClick={() => setNotificationMethod('push')}
            className={`px-6 py-3 rounded-lg font-medium transition ${
              notificationMethod === 'push'
                ? 'bg-purple-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            Push Notification
          </button>
          <button
            onClick={() => setNotificationMethod('whatsapp')}
            className={`px-6 py-3 rounded-lg font-medium transition ${
              notificationMethod === 'whatsapp'
                ? 'bg-green-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            WhatsApp
          </button>
        </div>
        <p className="text-gray-500 text-sm mt-2">
          {notificationMethod === 'push'
            ? 'Send in-app push notifications to users with the app installed'
            : 'Send WhatsApp messages to users with mobile numbers'}
        </p>
      </div>

      {/* Weekly Watchlist Preview */}
      {alertType === 'weekly' && (
        <div className="bg-white rounded-lg shadow-lg p-4 md:p-6 mb-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Weekly Watchlist Preview</h2>
          {watchlistLoading ? (
            <p className="text-gray-400">Loading watchlist...</p>
          ) : watchlistData ? (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <div className="bg-emerald-100 px-4 py-2 rounded-lg">
                  <span className="text-emerald-600 font-bold text-2xl">{watchlistData.stockCount}</span>
                  <span className="text-gray-500 ml-2">Stocks</span>
                </div>
                <span className="text-gray-500">{watchlistData.weekLabel}</span>
              </div>

              {watchlistData.topPick && (
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded text-xs font-medium">TOP PICK</span>
                    <span className="font-bold text-lg text-gray-800">{watchlistData.topPick.symbol}</span>
                  </div>
                  <p className="text-gray-500 text-sm">{watchlistData.topPick.reason}</p>
                </div>
              )}

              {watchlistData.runnerUp && (
                <div className="bg-gray-50 p-4 rounded-lg">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="bg-gray-200 text-gray-600 px-2 py-0.5 rounded text-xs font-medium">RUNNER UP</span>
                    <span className="font-bold text-lg text-gray-800">{watchlistData.runnerUp.symbol}</span>
                  </div>
                  <p className="text-gray-500 text-sm">{watchlistData.runnerUp.reason}</p>
                </div>
              )}

              {watchlistData.stockCount === 0 && (
                <p className="text-orange-500">No stocks in the current weekly watchlist</p>
              )}
            </div>
          ) : (
            <p className="text-gray-400">No watchlist data available</p>
          )}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-gray-500 text-sm">Total Users</p>
          <p className="text-2xl font-bold text-gray-800">{summary.totalUsers}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-gray-500 text-sm">With App</p>
          <p className="text-2xl font-bold text-emerald-600">{summary.usersWithApp}</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <p className="text-gray-500 text-sm">Selected</p>
          <p className="text-2xl font-bold text-blue-600">{selectedUsers.length}</p>
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
          className="flex-1 bg-white border border-gray-300 rounded-lg px-4 py-3 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <label className="flex items-center gap-2 bg-white border border-gray-300 px-4 py-3 rounded-lg cursor-pointer">
          <input
            type="checkbox"
            checked={selectedUsers.length === users.length && users.length > 0}
            onChange={(e) => handleSelectAll(e.target.checked)}
            className="w-5 h-5 rounded"
          />
          <span className="text-gray-700">Select All</span>
        </label>
      </div>

      {/* User List */}
      <div className="bg-white rounded-lg shadow-lg overflow-hidden mb-6">
        {loading ? (
          <div className="p-8 text-center text-gray-400">Loading users...</div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-gray-400">No users found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="p-3 text-left w-12">
                    <input
                      type="checkbox"
                      checked={selectedUsers.length === users.length && users.length > 0}
                      onChange={(e) => handleSelectAll(e.target.checked)}
                      className="w-5 h-5 rounded"
                    />
                  </th>
                  <th className="p-3 text-left text-gray-600">Name</th>
                  <th className="p-3 text-left text-gray-600">Mobile</th>
                  <th className="p-3 text-left text-gray-600">App Status</th>
                  <th className="p-3 text-left text-gray-600">Joined</th>
                </tr>
              </thead>
              <tbody>
                {users.map(user => (
                  <tr key={user._id} className="border-t border-gray-200 hover:bg-gray-50">
                    <td className="p-3">
                      <input
                        type="checkbox"
                        checked={selectedUsers.includes(user._id)}
                        onChange={(e) => handleSelectUser(user._id, e.target.checked)}
                        className="w-5 h-5 rounded"
                      />
                    </td>
                    <td className="p-3 text-gray-800">
                      {user.firstName || user.lastName
                        ? `${user.firstName || ''} ${user.lastName || ''}`.trim()
                        : 'No name'}
                    </td>
                    <td className="p-3 font-mono text-sm text-gray-600">
                      {user.mobileNumber}
                    </td>
                    <td className="p-3">
                      {user.hasApp ? (
                        <span className="px-2 py-1 bg-emerald-100 text-emerald-700 rounded text-sm">
                          App Installed
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-orange-100 text-orange-700 rounded text-sm">
                          No App
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-gray-500 text-sm">
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
            className="px-4 py-2 bg-white border border-gray-300 rounded-lg disabled:opacity-50"
          >
            Previous
          </button>
          <span className="px-4 py-2 text-gray-600">
            Page {pagination.page} of {pagination.pages}
          </span>
          <button
            onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
            disabled={pagination.page === pagination.pages}
            className="px-4 py-2 bg-white border border-gray-300 rounded-lg disabled:opacity-50"
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
          className={`${
            notificationMethod === 'push'
              ? 'bg-purple-600 hover:bg-purple-700'
              : 'bg-emerald-600 hover:bg-emerald-700'
          } disabled:bg-gray-400 disabled:cursor-not-allowed text-white px-8 py-3 rounded-lg font-semibold transition`}
        >
          {sendingStatus?.status === 'sending'
            ? 'Sending...'
            : `Send ${alertType === 'weekly' ? 'Weekly' : 'Daily'} ${notificationMethod === 'push' ? 'Push' : 'WhatsApp'} Alert to ${selectedUsers.length} Users`}
        </button>
      </div>

      {/* Status Modal */}
      {sendingStatus && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl p-8 max-w-md w-full shadow-xl">
            {sendingStatus.status === 'sending' && (
              <div className="text-center">
                <div className="animate-spin w-12 h-12 border-4 border-blue-600 border-t-transparent rounded-full mx-auto mb-4"></div>
                <p className="text-lg text-gray-800">Sending alerts...</p>
                <p className="text-gray-500 text-sm mt-2">This may take a few minutes</p>
              </div>
            )}

            {sendingStatus.status === 'complete' && (
              <div className="text-center">
                <div className="text-5xl mb-4 text-green-500">&#10003;</div>
                <p className="text-xl font-semibold mb-2 text-gray-800">Alerts Queued!</p>
                <p className="text-gray-500 mb-4">
                  {sendingStatus.message}
                </p>
                <p className="text-gray-400 text-sm mb-4">
                  Job ID: {sendingStatus.jobId}
                </p>
                <button
                  onClick={() => setSendingStatus(null)}
                  className="px-6 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition"
                >
                  Close
                </button>
              </div>
            )}

            {sendingStatus.status === 'error' && (
              <div className="text-center">
                <div className="text-5xl mb-4 text-red-500">&#10007;</div>
                <p className="text-xl font-semibold mb-2 text-red-600">Error</p>
                <p className="text-gray-500 mb-4">
                  {sendingStatus.message}
                </p>
                <button
                  onClick={() => setSendingStatus(null)}
                  className="px-6 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg transition"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function WhatsAppAlerts() {
  return (
    <AdminLayout>
      <WhatsAppAlertsContent />
    </AdminLayout>
  );
}
