import React, { useState } from 'react';
import { motion } from 'framer-motion';

const faqs = [
  {
    q: 'What is LogDhan?',
    a: 'LogDhan is an AI-powered trade planning and review app that helps you plan trades before execution, get AI insights, and maintain detailed logs for disciplined investing.'
  },
  {
    q: 'How does the free plan work?',
    a: 'Our Basic Free plan gives you unlimited AI trade reviews by watching short ads. It\'s completely free forever with small banner ads and rewarded videos for each review.'
  },
  {
    q: 'What are the differences between free and Pro plans?',
    a: 'Basic Free: Unlimited reviews with ads. Pro Monthly: 150 credits/month, no ads. Pro Annual: 2000 credits/year, no ads, best value. Pro plans offer unlimited reviews and ad-free experience.'
  },
  {
    q: 'Are ads intrusive or annoying?',
    a: 'No! We use small banner ads and rewarded videos for each review. No pop-ups or interruptions during your trading analysis. Simply watch a short ad to get your AI review.'
  },
  {
    q: 'Is my data secure and private?',
    a: 'Absolutely. Your data is encrypted and never shared with third parties. See our Privacy Policy for details.'
  },
  {
    q: 'Can I upgrade or cancel anytime?',
    a: 'Yes! Upgrade from Basic Free to Pro anytime for ad-free experience. Pro subscriptions can be cancelled anytime with no penalties.'
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
        <p className="text-xl text-slate-400">Everything you need to know about LogDhan</p>
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