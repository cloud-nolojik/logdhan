import React from 'react';
import { motion } from 'framer-motion';

export default function Download() {
  const platforms = [
    {
      name: 'Android',
      icon: '🤖',
      description: 'Download from Google Play Store',
      link: '/download/android',
      gradient: 'from-green-500 to-green-600',
      available: true,
    },
    {
      name: 'iOS',
      icon: '🍎',
      description: 'Download from App Store',
      link: '/download/ios',
      gradient: 'from-blue-500 to-blue-600',
      available: true,
    },
    {
      name: 'Web App',
      icon: '🌐',
      description: 'Access via web browser',
      link: '/download/web',
      gradient: 'from-accent-purple to-accent-pink',
      available: true,
    },
  ];

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 py-16 bg-main-gradient">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="max-w-4xl w-full text-center px-4"
      >
        <h1 className="text-3xl md:text-5xl lg:text-6xl font-bold text-white mb-6 px-4">
          Download 
          <span className="block text-transparent bg-accent-gradient bg-clip-text">
            LogDhan
          </span>
        </h1>
        
        <p className="text-xl text-white/90 mb-12 max-w-2xl mx-auto">
          Get started with AI-powered trading insights on your preferred platform
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-12">
          {platforms.map((platform, index) => (
            <motion.div
              key={platform.name}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.2, duration: 0.6 }}
            >
              <a
                href={platform.link}
                className="group block"
              >
                <div className={`bg-gradient-to-br ${platform.gradient} p-8 rounded-2xl shadow-2xl hover:shadow-glow-lg transition-all duration-300 transform group-hover:scale-105 border border-white/10`}>
                  <div className="text-6xl mb-4">{platform.icon}</div>
                  <h3 className="text-2xl font-bold text-white mb-3">{platform.name}</h3>
                  <p className="text-white/90 mb-6">{platform.description}</p>
                  <div className="bg-white/20 hover:bg-white/30 text-white font-semibold px-6 py-3 rounded-xl transition-all duration-300">
                    {platform.available ? 'Download Now' : 'Coming Soon'}
                  </div>
                </div>
              </a>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8, duration: 0.6 }}
          className="bg-white/10 backdrop-blur-sm border border-accent-purple/30 rounded-2xl p-8 max-w-2xl mx-auto"
        >
          <h3 className="text-xl font-semibold text-white mb-4">Why Choose LogDhan?</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-white/80">
            <div className="flex items-center gap-2">
              <span className="text-accent-cyan">🚀</span>
              <span>Fast & Secure</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-accent-purple">🤖</span>
              <span>AI-Powered</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-accent-pink">📊</span>
              <span>Real-time Data</span>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}