import React from 'react';
import { motion } from 'framer-motion';

const features = [
  {
    title: 'NSE & BSE Coverage',
    icon: <svg className="w-7 h-7 text-blue-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 3h18v18H3z"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
  },
  {
    title: 'Multi-day Swing Focus',
    icon: <svg className="w-7 h-7 text-emerald-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
  },
  {
    title: 'Explained in Plain English',
    icon: <svg className="w-7 h-7 text-purple-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  },
  {
    title: 'Updated After Market Close',
    icon: <svg className="w-7 h-7 text-yellow-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" /></svg>
  },
  {
    title: 'No Complex Indicators',
    icon: <svg className="w-7 h-7 text-pink-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>
  },
  {
    title: 'User-controlled Decisions',
    icon: <svg className="w-7 h-7 text-cyan-300" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg>
  },
];

export default function FeatureSection() {
  return (
    <section className="py-24 px-4 max-w-7xl mx-auto">
      <div className="text-center mb-16">
        <div className="inline-flex items-center bg-slate-800/50 backdrop-blur-sm rounded-full px-4 py-2 border border-slate-700/50 mb-4">
          <span className="text-blue-300 text-xs font-semibold tracking-wide">
            BUILT FOR INDIAN MARKETS
          </span>
        </div>

        <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">
          Focused on{" "}
          <span className="text-transparent bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text">
            multi-day price movement
          </span>
        </h2>

        <p className="text-lg text-slate-300 max-w-3xl mx-auto">
          Calm, once-a-day updates explained in simple language. No intraday noise.
        </p>
      </div>

      {/* Feature Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
        {features.map((f, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: i * 0.1 }}
            viewport={{ once: true }}
            className="group relative"
          >
            {/* Glow */}
            <div className="absolute inset-0 bg-gradient-to-br from-blue-600/10 to-emerald-500/10 rounded-3xl blur-2xl opacity-40 group-hover:opacity-70 transition-all duration-300"></div>

            {/* Card */}
            <div className="relative bg-slate-900/60 backdrop-blur-md border border-slate-700/60 rounded-3xl p-8 shadow-xl hover:border-slate-500/80 transition-all duration-300">
              <div className="mb-6 flex items-center justify-center w-14 h-14 rounded-2xl bg-slate-800/60">
                {f.icon}
              </div>

              <h3 className="text-lg font-semibold text-white mb-2">
                {f.title}
              </h3>

              <p className="text-slate-400 text-sm">
                {/* optional desc if required */}
              </p>
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}