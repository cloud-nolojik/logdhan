import React, { useState } from 'react';
import { motion } from 'framer-motion';

const faqs = [
  {
    q: 'Is this stock advice or tips?',
    a: 'No. SwingSetups is an educational tool. We show how price has behaved near important regions and explain it in simple language. We do not give buy or sell calls. You decide what to do based on your own risk profile, capital, and time frame.'
  },
  {
    q: 'Do you support intraday trading?',
    a: 'No. SwingSetups focuses on multi-day swing moves, not very frequent intraday trading. Analysis is updated once per day after market close, so you get a calm, structured view instead of constant signals.'
  },
  {
    q: 'How many stocks can I track on each plan?',
    a: 'The free trial lets you track up to 3 stocks for 30 days. Paid plans allow larger watchlists, from 3 to 30 stocks depending on your subscription tier. For the latest details, please refer to the Pricing page.'
  },
  {
    q: 'What time is analysis updated?',
    a: 'SwingSetups reviews your watchlist after market close (usually around 5 PM IST) and generates fresh analysis for the next trading day. You see updated regions, context, and reasoning once per day.'
  },
  {
    q: 'What stocks are supported?',
    a: 'NSE and BSE equities are supported. You can add any listed stock from these exchanges to your watchlist. Focus is on reasonably liquid stocks where swing structures are more meaningful.'
  },
  {
    q: 'Do you place trades or connect to my broker?',
    a: 'No. SwingSetups does not connect to any broker, does not place orders, and does not handle your money. We only show educational price analysis. You remain in full control of all trading decisions and execution with your own broker.'
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
