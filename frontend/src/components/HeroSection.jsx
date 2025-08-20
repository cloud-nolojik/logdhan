import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';

export default function HeroSection() {
  return (
    <section className="relative overflow-hidden min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 via-white to-gray-100">
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
          {/* Logo and brand */}
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.2, duration: 0.8, type: "spring", stiffness: 100 }}
            className="mb-8"
          >
            <div className="flex items-center justify-center gap-4 mb-4">
              <div className="relative">
                <img src="/logo.svg" alt="LogDhan L.O.G Logo" className="h-20 w-auto drop-shadow-lg" />
              </div>
              <div className="text-left">
                <h1 className="text-4xl font-bold bg-gradient-to-r from-violet-600 via-blue-600 to-emerald-600 bg-clip-text text-transparent">
                  LogDhan
                </h1>
                <p className="text-lg text-gray-600 font-medium">Log your trades, Optimise decisions, Generate Dhan.</p>
              </div>
            </div>
          </motion.div>

          {/* Main headline */}
          <motion.h2 
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.8 }}
            className="text-3xl md:text-5xl lg:text-6xl font-extrabold mb-6 leading-tight"
          >
            <span className="block bg-gradient-to-r from-gray-900 via-gray-800 to-gray-900 bg-clip-text text-transparent">
              Plan Your Trades
            </span>
            <span className="block bg-gradient-to-r from-violet-600 via-blue-600 to-emerald-600 bg-clip-text text-transparent">
              Get AI Review
            </span>
          </motion.h2>

          {/* Subtitle */}
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6, duration: 0.8 }}
            className="text-lg md:text-xl text-gray-600 mb-8 font-light max-w-3xl mx-auto leading-relaxed"
          >
            Stop impulsive trading. Plan your trades, get AI feedback, and maintain detailed logs.
          </motion.p>

          {/* Free plan highlight */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.8, duration: 0.6, type: "spring" }}
            className="relative inline-flex items-center mb-8 mx-auto"
          >
            <div className="bg-gradient-to-r from-violet-500/10 via-blue-500/10 to-emerald-500/10 backdrop-blur-sm rounded-2xl px-6 py-4 border border-violet-200">
              <div className="flex items-center space-x-3">
                <div className="bg-gradient-to-r from-violet-500 to-blue-500 rounded-lg p-2">
                  <span className="text-xl">🚀</span>
                </div>
                <div className="text-left">
                  <div className="bg-gradient-to-r from-violet-600 to-emerald-600 bg-clip-text text-transparent font-bold text-lg">Forever FREE Plan</div>
                  <div className="text-gray-600 text-sm">3 AI reviews daily + 1 bonus after ad</div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Download buttons */}
          <motion.div 
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.0, duration: 0.8 }}
            className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-12"
          >
            <Link to="/download" className="group">
              <div className="bg-gradient-to-r from-violet-600 via-blue-600 to-emerald-600 hover:from-violet-700 hover:via-blue-700 hover:to-emerald-700 text-white font-bold px-8 py-4 rounded-xl shadow-lg transition-all duration-300 transform group-hover:scale-105 flex items-center gap-3 text-lg">
                <span className="text-2xl">📱</span>
                <span>Download App</span>
              </div>
            </Link>
            <Link to="/how-it-works" className="group">
              <div className="bg-white/90 backdrop-blur-sm border-2 border-gray-200 text-gray-800 hover:bg-white hover:border-violet-300 font-bold px-8 py-4 rounded-xl shadow-lg transition-all duration-300 transform group-hover:scale-105 flex items-center gap-3 text-lg">
                <span className="text-2xl">⚡</span>
                <span>How It Works</span>
              </div>
            </Link>
          </motion.div>

          {/* Key features highlight */}
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1.2, duration: 0.8 }}
            className="flex flex-wrap justify-center gap-4 max-w-4xl mx-auto"
          >
            <motion.div 
              whileHover={{ scale: 1.05 }}
              className="flex items-center gap-3 bg-white/80 backdrop-blur-sm rounded-xl px-5 py-3 border border-orange-200 shadow-sm"
            >
              <div className="bg-gradient-to-r from-orange-500 to-orange-600 rounded-lg p-2">
                <span className="text-lg">📝</span>
              </div>
              <span className="font-medium text-orange-700">Plan Your Trades</span>
            </motion.div>
            <motion.div 
              whileHover={{ scale: 1.05 }}
              className="flex items-center gap-3 bg-white/80 backdrop-blur-sm rounded-xl px-5 py-3 border border-blue-200 shadow-sm"
            >
              <div className="bg-gradient-to-r from-blue-500 to-blue-600 rounded-lg p-2">
                <span className="text-lg">🤖</span>
              </div>
              <span className="font-medium text-blue-700">AI Review</span>
            </motion.div>
            <motion.div 
              whileHover={{ scale: 1.05 }}
              className="flex items-center gap-3 bg-white/80 backdrop-blur-sm rounded-xl px-5 py-3 border border-emerald-200 shadow-sm"
            >
              <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 rounded-lg p-2">
                <span className="text-lg">📊</span>
              </div>
              <span className="font-medium text-emerald-700">Track & Learn</span>
            </motion.div>
          </motion.div>
        </motion.div>
      </div>

      {/* Floating elements */}
      <motion.div 
        animate={{ y: [0, -20, 0], rotate: [0, 5, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        className="absolute top-1/4 left-10 text-slate-400/30 text-6xl"
      >📊</motion.div>
      <motion.div 
        animate={{ y: [0, 15, 0], rotate: [0, -3, 0] }}
        transition={{ duration: 8, repeat: Infinity, ease: "easeInOut", delay: 2 }}
        className="absolute top-1/2 right-10 text-slate-400/30 text-4xl"
      >💰</motion.div>
      <motion.div 
        animate={{ y: [0, -10, 0], rotate: [0, 2, 0] }}
        transition={{ duration: 7, repeat: Infinity, ease: "easeInOut", delay: 4 }}
        className="absolute bottom-1/4 left-1/4 text-slate-400/30 text-5xl"
      >📈</motion.div>
    </section>
  );
} 