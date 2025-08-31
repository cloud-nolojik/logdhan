import React from 'react';
import { motion } from 'framer-motion';

export default function Contact() {
  return (
    <section className="min-h-screen flex flex-col items-center justify-center py-20 px-4 relative overflow-hidden">
      {/* Animated background elements */}
      <div className="absolute inset-0">
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
      </div>

      <div className="container mx-auto max-w-4xl z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="text-center mb-16"
        >
          <div className="inline-flex items-center bg-slate-800/50 backdrop-blur-sm rounded-full px-6 py-3 border border-slate-700/50 mb-6">
            <span className="text-blue-400 text-sm font-semibold">💬 GET IN TOUCH</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-black text-white mb-6">
            Contact <span className="text-transparent bg-gradient-to-r from-orange-500 via-blue-500 to-emerald-500 bg-clip-text">L.O.G</span> Team
          </h1>
          <p className="text-xl text-slate-300 max-w-2xl mx-auto leading-relaxed">
            Questions about the <span className="text-orange-400 font-bold">Log</span> • <span className="text-blue-400 font-bold">Optimise</span> • <span className="text-emerald-400 font-bold">Generate</span> philosophy? 
            We're here to help you master disciplined trading.
          </p>
        </motion.div>

        {/* Contact Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16">
          {/* Phone Card */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.8 }}
            className="bg-gradient-to-br from-slate-800/40 to-slate-900/40 backdrop-blur-sm border border-slate-700/50 rounded-2xl p-8 text-center hover:border-blue-500/50 transition-all duration-300 group"
          >
            <div className="bg-blue-500/20 rounded-2xl p-4 w-16 h-16 mx-auto mb-6 group-hover:scale-110 transition-transform duration-300">
              <span className="text-3xl">📞</span>
            </div>
            <h3 className="text-xl font-bold text-white mb-3">Quick Call</h3>
            <p className="text-slate-400 mb-4 text-sm">Instant support for urgent queries</p>
            <a href="tel:+919008108650" className="text-blue-400 text-lg font-bold hover:text-blue-300 transition">
              +91 9008108650
            </a>
          </motion.div>

          {/* Email Card */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4, duration: 0.8 }}
            className="bg-gradient-to-br from-slate-800/40 to-slate-900/40 backdrop-blur-sm border border-slate-700/50 rounded-2xl p-8 text-center hover:border-emerald-500/50 transition-all duration-300 group"
          >
            <div className="bg-emerald-500/20 rounded-2xl p-4 w-16 h-16 mx-auto mb-6 group-hover:scale-110 transition-transform duration-300">
              <span className="text-3xl">✉️</span>
            </div>
            <h3 className="text-xl font-bold text-white mb-3">Email Support</h3>
            <p className="text-slate-400 mb-4 text-sm">Detailed questions & feedback</p>
            <a href="mailto:logdhan-help@nolojik.com" className="text-emerald-400 text-lg font-bold hover:text-emerald-300 transition break-all">
              logdhan-help@nolojik.com
            </a>
            <div className="text-slate-500 text-xs mt-2">Response within 24 hours</div>
          </motion.div>

          {/* App Support Card */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6, duration: 0.8 }}
            className="bg-gradient-to-br from-slate-800/40 to-slate-900/40 backdrop-blur-sm border border-slate-700/50 rounded-2xl p-8 text-center hover:border-orange-500/50 transition-all duration-300 group"
          >
            <div className="bg-orange-500/20 rounded-2xl p-4 w-16 h-16 mx-auto mb-6 group-hover:scale-110 transition-transform duration-300">
              <span className="text-3xl">📱</span>
            </div>
            <h3 className="text-xl font-bold text-white mb-3">App Help</h3>
            <p className="text-slate-400 mb-4 text-sm">Need help with LogDhan app?</p>
            <div className="text-orange-400 text-sm font-semibold">
              Use in-app support or email us
            </div>
          </motion.div>
        </div>

        {/* Address Section */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8, duration: 0.8 }}
          className="bg-gradient-to-br from-slate-800/40 to-slate-900/40 backdrop-blur-sm border border-slate-700/50 rounded-2xl p-8 text-center"
        >
          <div className="bg-purple-500/20 rounded-2xl p-4 w-16 h-16 mx-auto mb-6">
            <span className="text-3xl">🏢</span>
          </div>
          <h3 className="text-xl font-bold text-white mb-4">Visit Our Office</h3>
          <div className="text-slate-300 space-y-1">
            <p className="font-semibold">Nolojik Innovations Pvt Ltd</p>
            <p>No 235, Binnamangala, 13th Cross</p>
            <p>Indiranagar 2nd Stage</p>
            <p>Bangalore - 560038</p>
          </div>
        </motion.div>

        {/* Bottom tagline */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.0, duration: 0.8 }}
          className="text-center mt-12"
        >
          <p className="text-slate-400 text-sm">
            <span className="text-transparent bg-gradient-to-r from-orange-400 via-blue-400 to-emerald-400 bg-clip-text font-bold">L.O.G</span> your way to wealth with LogDhan
          </p>
          <p className="text-slate-500 text-xs mt-2">LogDhan is a product of Nolojik Innovations</p>
        </motion.div>
      </div>
    </section>
  );
} 