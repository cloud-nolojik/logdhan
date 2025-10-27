import React from 'react';
import { motion } from 'framer-motion';

export default function SEBIDisclaimerBanner() {
  return (
    <motion.div 
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      className="bg-gradient-to-r from-red-600 to-red-500 text-white text-center py-3 px-4 text-sm font-medium sticky top-0 z-50 shadow-lg"
    >
      <div className="container mx-auto flex items-center justify-center gap-2">
        <span className="text-lg">⚠️</span>
        <span className="font-bold">EDUCATIONAL ONLY:</span>
        <span>
          LogDhan provides educational stock analysis tools for learning purposes only. Not investment advice. 
          SEBI registration not required for educational content. 
          <span className="font-semibold"> Consult certified financial advisors for investment decisions.</span>
        </span>
      </div>
    </motion.div>
  );
}