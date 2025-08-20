import React from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';

export default function DownloadWeb() {
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-4 py-16 bg-main-gradient">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="max-w-3xl w-full text-center"
      >
        <div className="text-8xl mb-8">🌐</div>
        
        <h1 className="text-4xl md:text-6xl font-bold text-white mb-6">
          Access via 
          <span className="block text-transparent bg-accent-gradient bg-clip-text">
            Web Browser
          </span>
        </h1>
        
        <p className="text-xl text-white/90 mb-8">
          Use LogDhan directly in your web browser - no download required
        </p>

        <div className="bg-white/10 backdrop-blur-sm border border-white/20 rounded-2xl p-8 mb-8">
          <h3 className="text-2xl font-semibold text-white mb-6">Access Options</h3>
          
          <div className="space-y-4">
            <a
              href="https://app.logdhan.com"
              target="_blank"
              rel="noopener noreferrer"
              className="block bg-accent-gradient hover:shadow-glow-lg text-white font-bold px-8 py-4 rounded-xl shadow-2xl transition-all duration-300 transform hover:scale-105"
            >
              <div className="flex items-center justify-center gap-3">
                <span className="text-2xl">🚀</span>
                <div>
                  <div className="text-lg">Launch Web App</div>
                  <div className="text-sm opacity-90">app.logdhan.com</div>
                </div>
              </div>
            </a>

            <div className="bg-white/5 border border-white/10 text-white/60 font-semibold px-8 py-4 rounded-xl">
              <div className="flex items-center justify-center gap-3">
                <span className="text-2xl">📱</span>
                <div>
                  <div className="text-lg">Install as PWA</div>
                  <div className="text-sm">Add to home screen for app-like experience</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <div className="bg-white/5 border border-accent-purple/30 rounded-2xl p-6">
            <h4 className="text-lg font-semibold text-white mb-4">✅ Supported Browsers</h4>
            <div className="space-y-2 text-white/80 text-sm">
              <div>🔵 Chrome 90+</div>
              <div>🦊 Firefox 88+</div>
              <div>🟡 Safari 14+</div>
              <div>🔷 Edge 90+</div>
            </div>
          </div>

          <div className="bg-white/5 border border-accent-cyan/30 rounded-2xl p-6">
            <h4 className="text-lg font-semibold text-white mb-4">🌟 Web Features</h4>
            <div className="space-y-2 text-white/80 text-sm">
              <div>⚡ Fast loading</div>
              <div>📱 Mobile responsive</div>
              <div>🔄 Auto-sync</div>
              <div>🔒 Secure connection</div>
            </div>
          </div>
        </div>

        <div className="bg-accent-pink/10 border border-accent-pink/30 rounded-2xl p-6 mb-8">
          <h4 className="text-lg font-semibold text-white mb-3">💡 Pro Tip</h4>
          <p className="text-white/80 text-sm">
            For the best experience, add LogDhan to your home screen. In Chrome/Safari, 
            click the share button and select "Add to Home Screen" for an app-like experience.
          </p>
        </div>

        <Link to="/download" className="inline-block bg-white/10 hover:bg-white/20 text-white font-semibold px-6 py-3 rounded-xl transition-all duration-300">
          ← Back to All Platforms
        </Link>
      </motion.div>
    </div>
  );
}