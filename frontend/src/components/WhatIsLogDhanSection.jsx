import React from 'react';
import { motion } from 'framer-motion';

export default function WhatIsLogDhanSection() {
  return (
    <section className="py-20 px-4 max-w-7xl mx-auto" id="how-it-works">
      <div className="grid grid-cols-1 lg:grid-cols-2 items-center gap-16">
        <motion.div 
          initial={{ opacity: 0, x: -50 }}
          whileInView={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
          viewport={{ once: true }}
          className="">
          <div className="mb-6">
            <div className="inline-flex items-center bg-slate-800/50 backdrop-blur-sm rounded-full px-4 py-2 border border-slate-700/50 mb-4">
              <span className="text-blue-400 text-sm font-semibold">🚀 WHAT IS LOGDHAN?</span>
            </div>
            <h2 className="text-4xl md:text-5xl font-black text-white mb-6 leading-tight">
              Your <span className="text-transparent bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text">AI Swing Strategy Generator</span>
            </h2>
            <p className="text-xl text-slate-300 mb-8 leading-relaxed">
              Focus: short-term swing trading (cash market). Get precise setups with entries, stops, targets, AI confidence, and time-boxed expiry. WhatsApp alerts at key moments—setup, confirmation, manage, expiry. Use the setups with any broker you choose.
            </p>
            
            {/* Educational Disclaimer */}
            <div className="bg-amber-900/20 border border-amber-500/30 rounded-xl p-4 mb-6">
              <div className="flex items-center gap-2 text-amber-400 text-sm font-semibold mb-2">
                <span>⚠️</span>
                <span>NOT SEBI-REGISTERED • EDUCATIONAL ONLY</span>
              </div>
              <p className="text-amber-200/80 text-sm">
                LogDhan provides model-generated strategies for learning purposes. We do not provide investment advice. 
                Trading involves risk; past performance does not guarantee future results. You are solely responsible for your trades.
              </p>
            </div>
          </div>
          
          <div className="space-y-4">
            {[
              { icon: '📊', title: 'AI Swing Setups Only', desc: 'No noise. Clear entries, stops, targets, and invalidation', color: 'text-emerald-400' },
              { icon: '🤖', title: 'AI Confidence + Reasoning', desc: 'See why a setup exists (trend, volatility regime, breadth)', color: 'text-blue-400' },
              { icon: '⚡', title: 'Risk-First Defaults', desc: 'R:R shown upfront, ATR-aligned SL, time-boxed expiry', color: 'text-purple-400' },
              { icon: '📱', title: 'WhatsApp at Right Time', desc: 'Setup → Confirmation → Manage → Expiry alerts', color: 'text-pink-400' },
              { icon: '🎯', title: 'Your Choice of Broker', desc: 'Use setups with any broker platform you prefer', color: 'text-yellow-400' }
            ].map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.6, delay: i * 0.1 }}
                viewport={{ once: true }}
                className="flex items-start space-x-4 p-4 rounded-2xl bg-slate-800/20 backdrop-blur-sm border border-slate-700/30 hover:border-slate-600/50 transition-all duration-300 group"
              >
                <div className="bg-slate-700/50 rounded-xl p-3 group-hover:scale-110 transition-transform duration-300">
                  <span className="text-2xl">{item.icon}</span>
                </div>
                <div className="flex-1">
                  <h3 className={`font-bold text-lg mb-1 ${item.color}`}>{item.title}</h3>
                  <p className="text-slate-400">{item.desc}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
        
        <motion.div 
          initial={{ opacity: 0, x: 50 }}
          whileInView={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          viewport={{ once: true }}
          className="flex justify-center items-center">
          <div className="relative">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-500/20 to-purple-500/20 rounded-3xl blur-2xl"></div>
            <div className="relative bg-slate-800/40 backdrop-blur-sm border border-slate-700/50 rounded-3xl p-8 shadow-2xl">
              <div className="bg-gradient-to-br from-blue-600 to-purple-600 rounded-2xl p-8 text-center">
                <div className="bg-white/10 rounded-xl p-6 mb-6">
                  <div className="text-6xl mb-4">📱</div>
                  <div className="text-white font-bold text-2xl mb-2">LogDhan App</div>
                  <div className="text-blue-200 text-sm">Available on all platforms</div>
                </div>
                <div className="space-y-3">
                  <div className="bg-white/10 rounded-lg p-3 flex items-center justify-between">
                    <span className="text-white text-sm">AI Strategies</span>
                    <span className="bg-emerald-500 text-white text-xs px-2 py-1 rounded-full font-bold">FREE TRIAL</span>
                  </div>
                  <div className="bg-white/10 rounded-lg p-3 flex items-center justify-between">
                    <span className="text-white text-sm">Status</span>
                    <span className="text-emerald-400 text-sm font-bold">Active</span>
                  </div>
                  <div className="bg-white/10 rounded-lg p-3 flex items-center justify-between">
                    <span className="text-white text-sm">Plan</span>
                    <span className="text-blue-300 text-sm font-bold">Trial Plan</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
} 