import React from 'react';
import { motion } from 'framer-motion';

const features = [
  {
    title: 'AI Swing Setups',
    icon: (
      <svg className="w-8 h-8 text-accent-cyan" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
    ),
    color: 'text-accent-cyan',
  },
  {
    title: 'WhatsApp Alerts',
    icon: (
      <svg className="w-8 h-8 text-accent-purple" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
    ),
    color: 'text-accent-purple',
  },
  {
    title: 'Risk-First Approach',
    icon: (
      <svg className="w-8 h-8 text-accent-pink" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 12l2 2 4-4" /><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3 4-3 9-3 9 1.34 9 3" /><path d="M21 5c0 1.66-4 3-9 3S3 6.66 3 5s4-3 9-3 9 1.34 9 3" /></svg>
    ),
    color: 'text-accent-pink',
  },
  {
    title: 'Cash Market Focus',
    icon: (
      <svg className="w-8 h-8 text-secondary" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
    ),
    color: 'text-secondary',
  },
  {
    title: 'AI Confidence Scoring',
    icon: (
      <svg className="w-8 h-8 text-chartgreen" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M9 19c-5 0-8-3-8-8s3-8 8-8 8 3 8 8-3 8-8 8" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
    ),
    color: 'text-chartgreen',
  },
  {
    title: 'Time-Boxed Expiry',
    icon: (
      <svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><polyline points="12,6 12,12 16,14" /></svg>
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
            Swing Trading <span className="text-transparent bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text">Features</span>
          </h2>
          <p className="text-xl text-slate-400 max-w-2xl mx-auto">AI-generated swing setups with WhatsApp alerts for your trading platform</p>
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