import React from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';

export default function DownloadAndroid() {
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-4 py-16 bg-main-gradient">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="max-w-3xl w-full text-center"
      >
        <div className="text-8xl mb-8">🤖</div>
        
        <h1 className="text-4xl md:text-6xl font-bold text-white mb-6">
          Download for 
          <span className="block text-transparent bg-gradient-to-r from-green-400 to-green-600 bg-clip-text">
            Android
          </span>
        </h1>
        
        <p className="text-xl text-white/90 mb-8">
          Get LogDhan on your Android device and start making smarter trading decisions
        </p>

        <div className="bg-white/10 backdrop-blur-sm border border-white/20 rounded-2xl p-8 mb-8">
          <h3 className="text-2xl font-semibold text-white mb-6">Download Options</h3>
          
          <div className="space-y-4">
            <a
              href="https://play.google.com/store/apps/details?id=swingsetups"
              target="_blank"
              rel="noopener noreferrer"
              className="block bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white font-bold px-8 py-4 rounded-xl shadow-2xl transition-all duration-300 transform hover:scale-105"
            >
              <div className="flex items-center justify-center gap-3">
                <span className="text-2xl">📱</span>
                <div>
                  <div className="text-lg">Google Play Store</div>
                  <div className="text-sm opacity-90">Recommended</div>
                </div>
              </div>
            </a>

            <div className="bg-white/5 border border-white/10 text-white/60 font-semibold px-8 py-4 rounded-xl">
              <div className="flex items-center justify-center gap-3">
                <span className="text-2xl">📦</span>
                <div>
                  <div className="text-lg">Direct APK Download</div>
                  <div className="text-sm">Coming Soon</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white/5 border border-accent-purple/30 rounded-2xl p-6 mb-8">
          <h4 className="text-lg font-semibold text-white mb-4">System Requirements</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-white/80 text-sm">
            <div>✅ Android 6.0 or higher</div>
            <div>✅ 100MB free storage</div>
            <div>✅ Internet connection</div>
            <div>✅ Camera (for QR scanning)</div>
          </div>
        </div>

        <Link to="/download" className="inline-block bg-white/10 hover:bg-white/20 text-white font-semibold px-6 py-3 rounded-xl transition-all duration-300">
          ← Back to All Platforms
        </Link>
      </motion.div>
    </div>
  );
}