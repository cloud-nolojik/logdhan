import React, { useState } from 'react';
import { motion } from 'framer-motion';

const faqs = [
  {
    q: '⚠️ Is LogDhan providing investment advice?',
    a: 'NO. LogDhan is strictly an educational platform. We provide learning tools for stock analysis education, not investment recommendations or advice. We are not registered with SEBI as an Investment Adviser or Research Analyst. All content is for educational purposes only.'
  },
  {
    q: 'How do the AI swing setups work?',
    a: 'Our AI analyzes thousands of NSE/BSE stocks daily using technical patterns, volume, and market sentiment. It generates educational swing setups showing entry price, stop-loss, target, risk-reward ratio, and confidence score - all for learning swing trading concepts and market analysis.'
  },
  {
    q: 'How do WhatsApp alerts work?',
    a: 'You receive educational WhatsApp notifications when: 1) AI creates a new swing setup, 2) Entry conditions are met. All alerts are for educational learning about market timing and trade management.'
  },
  {
    q: 'Can I use LogDhan with any broker?',
    a: 'Yes! LogDhan doesn\'t integrate with any broker platforms. We send educational WhatsApp alerts when AI detects trigger conditions. You then manually place trades on your preferred broker platform (Zerodha, Upstox, ICICI, etc.) based on the educational insights.'
  },
  {
    q: 'What stocks does the AI cover?',
    a: 'AI analyzes 1000+ stocks from NSE and BSE, including NIFTY 50, NIFTY 500, and popular mid/small cap stocks like RELIANCE, INFY, TCS, HDFC Bank, and many more for comprehensive educational swing trading analysis.'
  },
  {
    q: 'What are the plan differences?',
    a: 'Free Trial: 1-month with 3 stocks + WhatsApp alerts for learning. Paid Plans: ₹999 (10 stocks), ₹1999 (20 stocks), ₹2999 (30 stocks) per month. All include AI confidence scoring and real-time educational alerts - no investment advice.'
  },
  {
    q: 'Is my educational data secure and private?',
    a: 'Absolutely. Your learning data is encrypted and never shared with third parties. We maintain strict privacy standards for all educational content interactions and never share your watchlist or trading preferences. See our Privacy Policy for details.'
  },
];

export default function FAQSection() {
  const [openFaq, setOpenFaq] = useState(0);

  return (
    <section className="py-20 px-4 max-w-4xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        viewport={{ once: true }}
        className="text-center mb-16"
      >
        <h2 className="text-4xl md:text-5xl font-black text-white mb-4">
          Frequently Asked <span className="text-transparent bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text">Questions</span>
        </h2>
        <p className="text-xl text-slate-400">Everything you need to know about AI swing trading education</p>
      </motion.div>
      
      <div className="space-y-4">
        {faqs.map((f, i) => (
          <motion.div 
            key={i}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: i * 0.1 }}
            viewport={{ once: true }}
            className="group"
          >
            <div className="bg-slate-800/30 backdrop-blur-sm border border-slate-700/50 rounded-2xl overflow-hidden shadow-xl hover:border-slate-600/70 transition-all duration-300">
              <button
                onClick={() => setOpenFaq(openFaq === i ? -1 : i)}
                className="w-full p-6 text-left flex items-center justify-between hover:bg-slate-700/20 transition-colors duration-300"
              >
                <h3 className="text-lg font-bold text-white group-hover:text-blue-300 transition-colors duration-300">
                  {f.q}
                </h3>
                <div className={`text-blue-400 transform transition-transform duration-300 ${
                  openFaq === i ? 'rotate-180' : ''
                }`}>
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
              </button>
              
              <motion.div
                initial={false}
                animate={{ height: openFaq === i ? 'auto' : 0 }}
                transition={{ duration: 0.3 }}
                className="overflow-hidden"
              >
                <div className="px-6 pb-6 pt-0">
                  <div className="h-px bg-slate-600/50 mb-4"></div>
                  <p className="text-slate-300 leading-relaxed">{f.a}</p>
                </div>
              </motion.div>
            </div>
          </motion.div>
        ))}
      </div>
      
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.5 }}
        viewport={{ once: true }}
        className="text-center mt-12"
      >
        <div className="bg-slate-800/30 backdrop-blur-sm border border-slate-700/50 rounded-2xl p-8">
          <div className="text-4xl mb-4">🚀</div>
          <h3 className="text-2xl font-bold text-white mb-2">Still have questions?</h3>
          <p className="text-slate-400 mb-6">Get in touch with our team for personalized support</p>
          <a 
            href="mailto:hello@nolojik.com"
            className="inline-flex items-center bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-bold px-8 py-4 rounded-2xl transition-all duration-300 transform hover:scale-105 shadow-lg"
          >
            <span className="mr-2">📧</span>
            Contact Support
          </a>
        </div>
      </motion.div>
    </section>
  );
} 