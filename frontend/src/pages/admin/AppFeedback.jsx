import React, { useState, useEffect } from 'react';
import AdminLayout from '../../components/admin/AdminLayout';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://swingsetups.com';

function AppFeedbackContent() {
  // Feedback data
  const [feedbacks, setFeedbacks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 20,
    total: 0,
    pages: 0
  });
  const [summary, setSummary] = useState({
    average_rating: '0.0',
    total_count: 0,
    unread_count: 0,
    rating_breakdown: {
      five_star: 0,
      four_star: 0,
      three_star: 0,
      two_star: 0,
      one_star: 0
    }
  });

  // Filter state
  const [filterType, setFilterType] = useState('');
  const [filterRead, setFilterRead] = useState('');

  // Selected feedback for detail view
  const [selectedFeedback, setSelectedFeedback] = useState(null);

  // Fetch feedbacks on mount and when filters change
  useEffect(() => {
    fetchFeedbacks();
  }, [pagination.page, filterType, filterRead]);

  const fetchFeedbacks = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('adminToken');
      let url = `${API_BASE_URL}/api/v1/app-feedback/admin/list?page=${pagination.page}&limit=${pagination.limit}`;

      if (filterType) {
        url += `&type=${filterType}`;
      }
      if (filterRead) {
        url += `&is_read=${filterRead}`;
      }

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await response.json();

      if (data.success) {
        setFeedbacks(data.data.feedbacks);
        setPagination(prev => ({
          ...prev,
          total: data.data.pagination.total,
          pages: data.data.pagination.pages
        }));
        setSummary(data.data.summary);
      }
    } catch (error) {
      console.error('Error fetching feedbacks:', error);
    } finally {
      setLoading(false);
    }
  };

  const markAsRead = async (feedbackId) => {
    try {
      const token = localStorage.getItem('adminToken');
      await fetch(`${API_BASE_URL}/api/v1/app-feedback/admin/${feedbackId}/read`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      fetchFeedbacks(); // Refresh list
    } catch (error) {
      console.error('Error marking as read:', error);
    }
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getRatingStars = (rating) => {
    return String.fromCharCode(9733).repeat(rating) + String.fromCharCode(9734).repeat(5 - rating);
  };

  const getRatingColor = (rating) => {
    if (rating >= 4) return 'text-green-500';
    if (rating === 3) return 'text-yellow-500';
    return 'text-red-500';
  };

  const getFeedbackTypeLabel = (type) => {
    switch (type) {
      case 'feature_request': return 'Feature Request';
      case 'bug_report': return 'Bug Report';
      default: return 'General';
    }
  };

  const getFeedbackTypeBadgeColor = (type) => {
    switch (type) {
      case 'feature_request': return 'bg-purple-100 text-purple-800';
      case 'bug_report': return 'bg-red-100 text-red-800';
      default: return 'bg-blue-100 text-blue-800';
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">App Feedback</h1>
          <p className="text-gray-500 mt-1">View and manage user feedback</p>
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow p-4 text-center">
          <p className="text-3xl font-bold text-blue-600">{summary.total_count}</p>
          <p className="text-gray-500 text-sm">Total</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 text-center">
          <p className="text-3xl font-bold text-yellow-500">{summary.average_rating}</p>
          <p className="text-gray-500 text-sm">Avg Rating</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 text-center">
          <p className="text-3xl font-bold text-red-500">{summary.unread_count}</p>
          <p className="text-gray-500 text-sm">Unread</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 text-center">
          <p className="text-3xl font-bold text-green-500">{summary.rating_breakdown.five_star}</p>
          <p className="text-gray-500 text-sm">5 Stars</p>
        </div>
        <div className="bg-white rounded-lg shadow p-4 text-center">
          <p className="text-3xl font-bold text-red-400">{summary.rating_breakdown.one_star + summary.rating_breakdown.two_star}</p>
          <p className="text-gray-500 text-sm">1-2 Stars</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-lg p-4 mb-6">
        <div className="flex flex-wrap gap-4 items-center">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Type</label>
            <select
              value={filterType}
              onChange={(e) => {
                setFilterType(e.target.value);
                setPagination(prev => ({ ...prev, page: 1 }));
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">All Types</option>
              <option value="feedback">General</option>
              <option value="feature_request">Feature Request</option>
              <option value="bug_report">Bug Report</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Status</label>
            <select
              value={filterRead}
              onChange={(e) => {
                setFilterRead(e.target.value);
                setPagination(prev => ({ ...prev, page: 1 }));
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="">All</option>
              <option value="false">Unread</option>
              <option value="true">Read</option>
            </select>
          </div>
          <button
            onClick={fetchFeedbacks}
            className="mt-5 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Feedback List */}
      <div className="bg-white rounded-lg shadow-lg overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-gray-500">Loading...</div>
        ) : feedbacks.length === 0 ? (
          <div className="p-8 text-center text-gray-500">No feedback found</div>
        ) : (
          <div className="divide-y divide-gray-200">
            {feedbacks.map((feedback) => (
              <div
                key={feedback._id}
                className={`p-4 hover:bg-gray-50 cursor-pointer transition-colors ${
                  !feedback.is_read ? 'bg-blue-50' : ''
                }`}
                onClick={() => {
                  setSelectedFeedback(feedback);
                  if (!feedback.is_read) {
                    markAsRead(feedback._id);
                  }
                }}
              >
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-lg ${getRatingColor(feedback.rating)}`}>
                        {getRatingStars(feedback.rating)}
                      </span>
                      <span className={`px-2 py-0.5 rounded text-xs ${getFeedbackTypeBadgeColor(feedback.feedback_type)}`}>
                        {getFeedbackTypeLabel(feedback.feedback_type)}
                      </span>
                      {!feedback.is_read && (
                        <span className="px-2 py-0.5 rounded text-xs bg-red-100 text-red-800">
                          New
                        </span>
                      )}
                    </div>
                    <p className="text-gray-800 font-medium">
                      {feedback.user_name || 'Anonymous'}
                      {feedback.user_mobile && (
                        <span className="text-gray-400 text-sm ml-2">{feedback.user_mobile}</span>
                      )}
                    </p>
                    <p className="text-gray-600 text-sm mt-1 line-clamp-2">
                      {feedback.comment || 'No comment'}
                    </p>
                  </div>
                  <div className="text-right text-sm text-gray-400">
                    {formatDate(feedback.created_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Pagination */}
        {pagination.pages > 1 && (
          <div className="p-4 border-t border-gray-200 flex justify-center gap-2">
            <button
              onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
              disabled={pagination.page === 1}
              className="px-3 py-1 border rounded disabled:opacity-50"
            >
              Prev
            </button>
            <span className="px-3 py-1">
              Page {pagination.page} of {pagination.pages}
            </span>
            <button
              onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
              disabled={pagination.page === pagination.pages}
              className="px-3 py-1 border rounded disabled:opacity-50"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {/* Feedback Detail Modal */}
      {selectedFeedback && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6">
              <div className="flex justify-between items-start mb-4">
                <h2 className="text-xl font-bold text-gray-800">Feedback Details</h2>
                <button
                  onClick={() => setSelectedFeedback(null)}
                  className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
                >
                  &times;
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-xs text-gray-500">Rating</label>
                  <p className={`text-2xl ${getRatingColor(selectedFeedback.rating)}`}>
                    {getRatingStars(selectedFeedback.rating)}
                  </p>
                </div>

                <div>
                  <label className="text-xs text-gray-500">Type</label>
                  <p>
                    <span className={`px-2 py-1 rounded text-sm ${getFeedbackTypeBadgeColor(selectedFeedback.feedback_type)}`}>
                      {getFeedbackTypeLabel(selectedFeedback.feedback_type)}
                    </span>
                  </p>
                </div>

                <div>
                  <label className="text-xs text-gray-500">User</label>
                  <p className="text-gray-800">
                    {selectedFeedback.user_name || 'Anonymous'}
                  </p>
                  {selectedFeedback.user_mobile && (
                    <p className="text-gray-500 text-sm">{selectedFeedback.user_mobile}</p>
                  )}
                </div>

                <div>
                  <label className="text-xs text-gray-500">Comment</label>
                  <p className="text-gray-800 bg-gray-50 p-3 rounded-lg">
                    {selectedFeedback.comment || 'No comment provided'}
                  </p>
                </div>

                {selectedFeedback.app_version && (
                  <div>
                    <label className="text-xs text-gray-500">App Version</label>
                    <p className="text-gray-600">{selectedFeedback.app_version}</p>
                  </div>
                )}

                {selectedFeedback.device_info && (
                  <div>
                    <label className="text-xs text-gray-500">Device</label>
                    <p className="text-gray-600">{selectedFeedback.device_info}</p>
                  </div>
                )}

                <div>
                  <label className="text-xs text-gray-500">Submitted</label>
                  <p className="text-gray-600">{formatDate(selectedFeedback.created_at)}</p>
                </div>
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  onClick={() => setSelectedFeedback(null)}
                  className="px-4 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AppFeedback() {
  return (
    <AdminLayout>
      <AppFeedbackContent />
    </AdminLayout>
  );
}
