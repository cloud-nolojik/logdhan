import React from 'react';
import { motion } from 'framer-motion';

const features = [
  {
    title: 'Smart Trade Logging',
    icon: (
      <svg className="w-8 h-8 text-accent-cyan" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>
    ),
    color: 'text-accent-cyan',
  },
  {
    title: 'AI-Powered Insights',
    icon: (
      <svg className="w-8 h-8 text-accent-purple" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M8 15s1.5-2 4-2 4 2 4 2" /></svg>
    ),
    color: 'text-accent-purple',
  },
  {
    title: 'Export Trading Journal',
    icon: (
      <svg className="w-8 h-8 text-accent-pink" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4" /></svg>
    ),
    color: 'text-accent-pink',
  },
  {
    title: 'Mobile App Experience',
    icon: (
      <svg className="w-8 h-8 text-secondary" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
    ),
    color: 'text-secondary',
  },
  {
    title: 'TradingView Integration',
    icon: (
      <svg className="w-8 h-8 text-chartgreen" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 16l3-3 2 2 3-5" /></svg>
    ),
    color: 'text-chartgreen',
  },
  {
    title: 'Ad-Supported Free Plan',
    icon: (
      <svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /><circle cx="12" cy="12" r="10" /></svg>
    ),
    color: 'text-green-400',
  },
];

export default function FeatureSection() {
  return (
    <section className="py-20 px-4 max-w-7xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        viewport={{ once: true }}
      >
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-black text-white mb-4">
            Powerful <span className="text-transparent bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text">Features</span>
          </h2>
          <p className="text-xl text-slate-400 max-w-2xl mx-auto">Everything you need to become a disciplined, profitable trader</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((f, i) => (
            <motion.div 
              key={i} 
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.15, duration: 0.6 }}
              viewport={{ once: true }}
              whileHover={{ scale: 1.05, y: -5 }}
              className="group relative"
            >
              <div className="absolute inset-0 bg-gradient-to-br from-slate-800/50 to-slate-900/50 rounded-3xl blur-xl group-hover:blur-2xl transition-all duration-300"></div>
              <div className="relative bg-slate-800/40 backdrop-blur-sm rounded-3xl p-8 border border-slate-700/50 group-hover:border-slate-600/70 transition-all duration-300 shadow-2xl h-full flex flex-col">
                <div className="flex-shrink-0 mb-6">
                  <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 bg-gradient-to-br ${getGradientColors(i)}`}>
                    <div className="text-white text-2xl">{f.icon}</div>
                  </div>
                  <h3 className="text-xl font-bold text-white group-hover:text-blue-300 transition-colors duration-300">{f.title}</h3>
                </div>
                <div className="mt-auto">
                  <div className="w-full h-1 bg-slate-700/50 rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      whileInView={{ width: "100%" }}
                      transition={{ delay: i * 0.15 + 0.5, duration: 0.8 }}
                      className={`h-full rounded-full bg-gradient-to-r ${getGradientColors(i)}`}
                    />
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </motion.div>
    </section>
  );
}

function getGradientColors(index) {
  const gradients = [
    'from-cyan-400 to-blue-500',
    'from-purple-400 to-pink-500', 
    'from-pink-400 to-red-500',
    'from-yellow-400 to-orange-500',
    'from-green-400 to-teal-500',
    'from-blue-400 to-purple-500'
  ];
  return gradients[index % gradients.length];
} 