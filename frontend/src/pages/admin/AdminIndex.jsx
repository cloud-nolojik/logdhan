import React from 'react';
import { Navigate } from 'react-router-dom';
import AdminLayout from '../../components/admin/AdminLayout';

function AdminDashboard() {
  return (
    <div className="max-w-4xl mx-auto">
      <div className="bg-white rounded-lg shadow-lg p-8 text-center">
        <h1 className="text-2xl font-bold text-gray-800 mb-4">Welcome to Admin Panel</h1>
        <p className="text-gray-500 mb-8">Select a section from the navigation above to get started.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <a
            href="/admin/whatsapp-alerts"
            className="block p-6 bg-purple-50 rounded-lg hover:bg-purple-100 transition"
          >
            <div className="text-4xl mb-3">📢</div>
            <h2 className="text-lg font-semibold text-purple-700">Bulk Alerts</h2>
            <p className="text-gray-500 text-sm mt-1">Send push notifications or WhatsApp messages</p>
          </a>

          <a
            href="/admin/feedback"
            className="block p-6 bg-blue-50 rounded-lg hover:bg-blue-100 transition"
          >
            <div className="text-4xl mb-3">💬</div>
            <h2 className="text-lg font-semibold text-blue-700">App Feedback</h2>
            <p className="text-gray-500 text-sm mt-1">View and manage user feedback</p>
          </a>
        </div>
      </div>
    </div>
  );
}

export default function AdminIndex() {
  return (
    <AdminLayout>
      <AdminDashboard />
    </AdminLayout>
  );
}
