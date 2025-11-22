import React from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';

export default function DownloadAndroid() {
  return (
    <section className="relative overflow-hidden bg-slate-50">
      {/* subtle background gradient */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_#e0f2fe,_transparent_55%),_radial-gradient(circle_at_bottom,_#f1f5f9,_transparent_60%)]" />

      <div className="relative max-w-5xl mx-auto px-4 py-20">
        
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-center mb-12"
        >
          <img
            src="/app-icon.png"
            alt="SwingSetups Icon"
            className="w-20 h-20 mx-auto mb-6 rounded-2xl shadow-md"
          />

          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight text-slate-900">
            Download for Android
          </h1>

          <p className="text-slate-600 mt-4 max-w-2xl mx-auto text-base">
            Install SwingSetups on your Android device and get daily swing analysis
            for the stocks you follow. Simple, educational views — not trading calls.
          </p>
        </motion.div>

        {/* Play Store Button */}
        <div className="max-w-md mx-auto bg-white border border-slate-200 rounded-2xl shadow-sm p-6 space-y-6">
          
          <a
            href="https://play.google.com/store/apps/details?id=swingsetups"
            target="_blank"
            className="flex items-center justify-center gap-3 rounded-xl bg-gradient-to-r from-blue-600 to-emerald-500 text-white font-semibold px-6 py-3 shadow-md hover:brightness-105 transition"
          >
            📱 Install from Google Play
          </a>

          <div className="text-center text-xs text-slate-500">
            APK sideload option will be available soon.
          </div>
        </div>

        {/* System Requirements */}
        <div className="max-w-md mx-auto mt-10 bg-slate-50 border border-slate-200 rounded-xl p-6">
          <p className="font-medium text-slate-800 mb-4">System requirements</p>
          <ul className="text-sm text-slate-600 space-y-2">
            <li>• Android 6.0 or higher</li>
            <li>• 100MB free storage</li>
            <li>• Internet connection</li>
          </ul>
        </div>

        {/* Back link */}
        <div className="text-center mt-10">
          <Link className="text-sm text-blue-600 hover:underline" to="/download">
            ← Back to downloads
          </Link>
        </div>
      </div>
    </section>
  );
}