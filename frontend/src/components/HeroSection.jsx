import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';

export default function HeroSection() {
  return (
    <section aria-label="Hero section" className="relative overflow-hidden min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 via-white to-gray-100">
      {/* Modern startup background */}
      <div className="absolute inset-0">
        {/* Main gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-violet-50/40 via-white to-blue-50/30"></div>
        
        {/* Elegant grid pattern */}
        <div className="absolute inset-0 opacity-30" style={{
          backgroundImage: `
            linear-gradient(rgba(99, 102, 241, 0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(99, 102, 241, 0.03) 1px, transparent 1px)
          `,
          backgroundSize: '32px 32px'
        }}></div>
        
        {/* Floating gradient orbs */}
        <motion.div 
          animate={{ 
            x: [0, 100, 0],
            y: [0, -50, 0],
            scale: [1, 1.1, 1]
          }}
          transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
          className="absolute top-20 left-10 w-72 h-72 bg-gradient-to-r from-violet-400/10 to-purple-400/10 rounded-full blur-3xl"
        />
        <motion.div 
          animate={{ 
            x: [0, -80, 0],
            y: [0, 70, 0],
            scale: [1, 1.2, 1]
          }}
          transition={{ duration: 25, repeat: Infinity, ease: "linear" }}
          className="absolute bottom-20 right-10 w-96 h-96 bg-gradient-to-r from-blue-400/10 to-cyan-400/10 rounded-full blur-3xl"
        />
        <motion.div 
          animate={{ 
            x: [0, 60, 0],
            y: [0, -40, 0],
            scale: [1, 0.9, 1]
          }}
          transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
          className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-gradient-to-r from-emerald-400/8 to-teal-400/8 rounded-full blur-3xl"
        />
      </div>

      <div className="container mx-auto px-4 z-10 text-center">
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="max-w-4xl mx-auto"
        >
          {/* Main headline */}
          <motion.h1 
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.8 }}
            className="text-3xl md:text-5xl lg:text-6xl font-extrabold mb-6 leading-tight"
            aria-label="LogDhan: Educational stock analysis platform"
          >
            <div className="mb-6">
              <span className="inline-block text-xs md:text-sm uppercase tracking-[0.3em] text-gray-500 font-semibold bg-gray-100 px-4 py-2 rounded-full border border-gray-200">Locate • Optimize • Generate</span>
            </div>
            <div className="space-y-2 md:space-y-3">
              <div className="text-2xl sm:text-3xl md:text-5xl lg:text-6xl font-black leading-tight">
                <span className="bg-gradient-to-r from-orange-500 via-orange-600 to-red-500 bg-clip-text text-transparent drop-shadow-sm">Locate opportunities</span>
              </div>
              <div className="text-2xl sm:text-3xl md:text-5xl lg:text-6xl font-black leading-tight">
                <span className="bg-gradient-to-r from-blue-500 via-blue-600 to-indigo-600 bg-clip-text text-transparent drop-shadow-sm">Optimize timing</span>
              </div>
              <div className="text-2xl sm:text-3xl md:text-5xl lg:text-6xl font-black leading-tight">
                <span className="bg-gradient-to-r from-emerald-500 via-green-600 to-teal-600 bg-clip-text text-transparent drop-shadow-sm">Generate profits</span>
              </div>
            </div>
            <div className="mt-6 md:mt-8 mb-2">
              <h2 className="text-xl sm:text-2xl md:text-4xl font-bold text-gray-700 leading-tight">
                AI Swing Strategies with <span className="text-green-600">WhatsApp Alerts</span>
              </h2>
            </div>
          </motion.h1>

          {/* Subtitle */}
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6, duration: 0.8 }}
            className="text-base sm:text-lg md:text-xl text-gray-600 mb-6 md:mb-8 font-light max-w-3xl mx-auto leading-relaxed px-4 sm:px-0"
          >
            AI finds trading opportunities daily. Get AI-generated short-term swing setups with clear entry points, stop-losses, targets, risk-reward ratios, expiry windows, and AI confidence scores. Receive real-time WhatsApp alerts when confirmation hits, then place orders on your preferred broker platform.
          </motion.p>

          {/* Free plan highlight */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.8, duration: 0.6, type: "spring" }}
            className="relative inline-flex items-center mb-8 mx-auto"
          >
            <div className="bg-gradient-to-r from-violet-50 via-blue-50 to-emerald-50 backdrop-blur-sm rounded-3xl px-8 py-6 border-2 border-violet-100 shadow-xl hover:shadow-2xl transition-all duration-300 transform hover:scale-105">
              <div className="flex items-center space-x-4">
                <div className="bg-gradient-to-r from-violet-500 to-blue-500 rounded-2xl p-3 shadow-lg">
                  <span className="text-2xl">🚀</span>
                </div>
                <div className="text-left">
                  <div className="bg-gradient-to-r from-violet-600 via-purple-600 to-emerald-600 bg-clip-text text-transparent font-black text-xl">1-Month FREE Trial</div>
                  <div className="text-gray-700 text-base font-medium">Try AI swing setups with 3 stocks + WhatsApp alerts</div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Download buttons */}
          <motion.div 
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.0, duration: 0.8 }}
            className="flex flex-col sm:flex-row gap-4 md:gap-6 justify-center items-center mb-8 md:mb-12 px-4 sm:px-0"
          >
            <Link to="/download" className="group" aria-label="Download LogDhan mobile application">
              <div className="bg-gradient-to-r from-violet-600 via-purple-600 to-blue-600 hover:from-violet-700 hover:via-purple-700 hover:to-blue-700 text-white font-bold px-10 py-5 rounded-2xl shadow-xl hover:shadow-2xl transition-all duration-300 transform group-hover:scale-110 group-hover:-translate-y-1 flex items-center gap-4 text-xl border-2 border-white/20">
                <span className="text-3xl group-hover:rotate-12 transition-transform duration-300">📱</span>
                <span>Download App</span>
              </div>
            </Link>
            <Link to="/how-it-works" className="group" aria-label="Learn how LogDhan educational platform works">
              <div className="bg-white/95 backdrop-blur-sm border-2 border-gray-300 text-gray-800 hover:bg-white hover:border-violet-400 hover:text-violet-700 font-bold px-10 py-5 rounded-2xl shadow-xl hover:shadow-2xl transition-all duration-300 transform group-hover:scale-110 group-hover:-translate-y-1 flex items-center gap-4 text-xl">
                <span className="text-3xl group-hover:scale-125 transition-transform duration-300">⚡</span>
                <span>How It Works</span>
              </div>
            </Link>
          </motion.div>

        </motion.div>
      </div>

      {/* Floating elements */}
      <motion.div 
        animate={{ y: [0, -20, 0], rotate: [0, 5, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        className="absolute top-1/4 left-10 text-slate-400/30 text-6xl"
        aria-hidden="true"
      >📊</motion.div>
      <motion.div 
        animate={{ y: [0, 15, 0], rotate: [0, -3, 0] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut", delay: 2 }}
        className="absolute top-1/2 right-10 text-slate-400/30 text-4xl"
        aria-hidden="true"
      >💰</motion.div>
      <motion.div 
        animate={{ y: [0, -10, 0], rotate: [0, 2, 0] }}
        transition={{ duration: 7, repeat: Infinity, ease: "easeInOut", delay: 4 }}
        className="absolute bottom-1/4 left-1/4 text-slate-400/30 text-5xl"
        aria-hidden="true"
      >📈</motion.div>
    </section>
  );
} 