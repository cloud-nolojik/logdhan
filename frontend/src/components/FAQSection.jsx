import React, { useState } from 'react';
import { motion } from 'framer-motion';

const faqs = [
  {
    q: 'What are Grade A setups?',
    a: 'We score every stock from 0-100 based on trend strength, volatility, volume, and distance from key levels. Only stocks scoring 80+ (Grade A) get detailed AI analysis. This means fewer but higher-quality setups — no FOMO, quality over quantity.'
  },
  {
    q: 'What setup types do you find?',
    a: 'Four patterns that work for swing trading: Breakout (stock pushing to new highs with volume), Pullback (stock dipping to support in an uptrend), Momentum (stock running strong above its averages), and Consolidation Breakout (tight range about to expand).'
  },
  {
    q: 'What does "WAIT for ₹775" mean?',
    a: 'It\'s a clear action. The stock isn\'t at the ideal entry yet. Set an alert at ₹775. When it reaches that level, consider taking a position with the suggested stop-loss. No confusing jargon — just what to do.'
  },
  {
    q: 'What if the app says "SKIP"?',
    a: 'That\'s valuable information! Not every day has good setups. "SKIP — not a strong setup today" means waiting is the smart move. We\'ll alert you when something is ready. Permission to NOT trade is a feature.'
  },
  {
    q: 'How do you handle losses?',
    a: 'We show you exactly what you could lose (e.g., "₹2,200 if stopped out") and remind you that planned losses are normal. Following your rules matters more than any single trade. We help you stay emotionally grounded.'
  },
  {
    q: 'Is this stock advice or tips?',
    a: 'No. SwingSetups is an educational tool. We provide clear verdicts and risk/reward analysis, but we do not give buy or sell calls. You decide what to do based on your own risk profile, capital, and time frame.'
  },
  {
    q: 'How many stocks can I track?',
    a: 'The free trial lets you track up to 3 stocks for 30 days. Paid plans allow larger watchlists, from 3 to 100 stocks depending on your subscription tier. Every Saturday, we also share our discovery of Grade A setups.'
  },
  {
    q: 'What time is analysis updated?',
    a: 'SwingSetups reviews your watchlist after market close (usually around 5 PM IST). You get clear verdicts like "WAIT for ₹775" or "HOLD — structure intact" once per day. No noisy intraday signals.'
  },
  {
    q: 'Do you place trades or connect to my broker?',
    a: 'No. SwingSetups does not connect to any broker, does not place orders, and does not handle your money. You remain in full control of all trading decisions and execution with your own broker.'
  },
  {
    q: 'Is my data secure?',
    a: 'Yes. Your watchlist and usage data are stored securely and are not sold to third parties. We have no brokerage partnerships and do not earn revenue from your trades. You can read more in our Privacy Policy.'
  },
];

export default function FAQSection() {
  const [openFaq, setOpenFaq] = useState(0);

  return (
    <section id="faq" className="py-20 px-4 max-w-4xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        viewport={{ once: true }}
        className="text-center mb-16"
      >
        <h2 className="text-4xl md:text-5xl font-black text-white mb-4">
          Frequently Asked{' '}
          <span className="text-transparent bg-gradient-to-r from-blue-600 to-emerald-500 bg-clip-text">
            Questions
          </span>
        </h2>
        <p className="text-xl text-slate-400">
          Common questions about SwingSetups
        </p>
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
                <div
                  className={`text-blue-400 transform transition-transform duration-300 ${
                    openFaq === i ? 'rotate-180' : ''
                  }`}
                >
                  <svg
                    className="w-6 h-6"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M19 9l-7 7-7-7"
                    />
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
          <h3 className="text-2xl font-bold text-white mb-2">
            Still have questions?
          </h3>
          <p className="text-slate-400 mb-6">
            Get in touch with our team for any clarification
          </p>
          <a
            href="mailto:hello@nolojik.com"
            className="inline-flex items-center bg-gradient-to-r from-blue-600 to-emerald-500 hover:from-blue-700 hover:to-emerald-600 text-white font-bold px-8 py-4 rounded-2xl transition-all duration-300 transform hover:scale-105 shadow-lg shadow-blue-500/20"
          >
            <span className="mr-2">📧</span>
            Contact Support
          </a>
        </div>
      </motion.div>
    </section>
  );
}
