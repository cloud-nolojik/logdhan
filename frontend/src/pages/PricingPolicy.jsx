import React from 'react';
import { motion } from 'framer-motion';

export default function PricingPolicy() {
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-4 py-16 bg-main-gradient">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="max-w-4xl w-full"
      >
        <h1 className="text-3xl md:text-5xl font-bold text-white mb-8 text-center">
          <span className="text-transparent bg-accent-gradient bg-clip-text">
            Pricing Policy
          </span>
        </h1>

        <div className="bg-white/10 backdrop-blur-sm border border-white/20 rounded-2xl p-8 mb-8">
          <div className="space-y-6 text-white/90">
            
            <div className="bg-blue-500/20 border border-blue-500/30 rounded-xl p-6">
              <h3 className="text-xl font-semibold text-white mb-4">🔒 Your Credits Are Protected</h3>
              <p className="mb-4">
                When you purchase credits, your <strong>price-to-service ratio is locked in</strong> for those specific credits only. 
                This means if you buy the Starter Pack (100 reviews for ₹1,800), those credits will always give you 100 AI reviews.
              </p>
              <p className="text-blue-200">
                <strong>Example:</strong> You bought the Light Pack (25 reviews for ₹500). Later we change pricing to 50 reviews for ₹500. 
                Your existing credits still give you 25 reviews, but any NEW credits you buy will use the new rate.
              </p>
            </div>

            <div className="bg-green-500/20 border border-green-500/30 rounded-xl p-6">
              <h3 className="text-xl font-semibold text-white mb-4">📈 Why Might Pricing Change?</h3>
              <ul className="space-y-2 text-green-200">
                <li>• <strong>AI Model Improvements:</strong> More advanced AI requires higher computational costs</li>
                <li>• <strong>Feature Enhancements:</strong> New features may require more processing power</li>
                <li>• <strong>Market Conditions:</strong> Infrastructure and API costs may fluctuate</li>
                <li>• <strong>Service Quality:</strong> Better analysis quality may require more resources</li>
              </ul>
            </div>

            <div className="bg-purple-500/20 border border-purple-500/30 rounded-xl p-6">
              <h3 className="text-xl font-semibold text-white mb-4">⚡ How It Works</h3>
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <span className="text-purple-300 text-xl">1️⃣</span>
                  <div>
                    <strong>Purchase Credits:</strong> Your rate is locked in (e.g., Starter Pack: 100 reviews for ₹1,800)
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-purple-300 text-xl">2️⃣</span>
                  <div>
                    <strong>Rate Changes:</strong> New users might pay different rates (e.g., 80 reviews for ₹1,800)
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-purple-300 text-xl">3️⃣</span>
                  <div>
                    <strong>You're Protected:</strong> Your existing credits still work at your original rate
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-yellow-500/20 border border-yellow-500/30 rounded-xl p-6">
              <h3 className="text-xl font-semibold text-white mb-4">🔄 How Credit Batches Work</h3>
              <div className="space-y-3">
                <p><strong>Each credit purchase is a separate "batch" with its own rate:</strong></p>
                <div className="bg-yellow-600/20 rounded-lg p-3 text-sm">
                  <p>• <strong>Batch 1:</strong> Light Pack - 25 reviews for ₹500 (₹20/review)</p>
                  <p>• <strong>Batch 2:</strong> Starter Pack - 100 reviews for ₹1,800 (₹18/review)</p>
                  <p>• <strong>Total:</strong> You have 125 AI reviews across both batches</p>
                </div>
                <p className="text-yellow-200">
                  <strong>Note:</strong> We'll always notify you of any pricing changes before they take effect.
                </p>
              </div>
            </div>

            <div className="bg-accent-cyan/20 border border-accent-cyan/30 rounded-xl p-6">
              <h3 className="text-xl font-semibold text-white mb-4">📞 Questions?</h3>
              <p>
                If you have questions about pricing or how your credits work, contact us at{' '}
                <a href="mailto:hello@nolojik.com" className="text-accent-cyan hover:underline font-semibold">
                  hello@nolojik.com
                </a>
              </p>
            </div>

          </div>
        </div>

        <div className="text-center">
          <p className="text-white/60 text-sm">
            Last updated: {new Date().toLocaleDateString()}
          </p>
          <p className="text-white/60 text-sm mt-1">
            LogDhan is a product of Nolojik Innovations
          </p>
        </div>
      </motion.div>
    </div>
  );
}