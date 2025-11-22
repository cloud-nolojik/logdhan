import React from 'react';
import { motion } from 'framer-motion';

export default function OurApproachSection() {
  return (
    <section className="py-24 px-4 bg-gradient-to-br from-slate-900 via-blue-900 to-indigo-900">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="text-center mb-16">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            viewport={{ once: true }}
          >
            <div className="inline-flex items-center bg-slate-800/50 backdrop-blur-sm rounded-full px-4 py-2 border border-slate-700/50 mb-4">
              <span className="text-blue-300 text-xs font-semibold tracking-wide">
                OUR APPROACH
              </span>
            </div>

            <h2 className="text-4xl md:text-5xl font-bold text-white mb-6 leading-tight">
              Education first,{" "}
              <span className="text-transparent bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text">
                not tips
              </span>
            </h2>

            <p className="text-lg md:text-xl text-slate-300 max-w-3xl mx-auto leading-relaxed">
              SwingSetups does not issue buy or sell calls. It shows how price has behaved near important regions
              and explains that behaviour in simple language.
            </p>
            <p className="text-base md:text-lg text-slate-400 max-w-3xl mx-auto mt-4">
              You decide how to use this information based on your own risk, capital, and time frame. We stay on the
              analysis side, not the decision side.
            </p>
          </motion.div>
        </div>

        {/* Pillars */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              icon: '🔍',
              title: 'Transparent',
              desc: 'Explains why regions were chosen and which data points were considered.',
              color: 'text-blue-300',
              bgGradient: 'from-blue-500/20 to-blue-600/20',
            },
            {
              icon: '🛡️',
              title: 'Conservative',
              desc: 'Risk is always discussed next to possible reward, in straightforward terms.',
              color: 'text-emerald-300',
              bgGradient: 'from-emerald-500/20 to-emerald-600/20',
            },
            {
              icon: '🎯',
              title: 'Independent',
              desc: 'No brokerage tie-ins, no incentives from your trades, and no order placement.',
              color: 'text-purple-300',
              bgGradient: 'from-purple-500/20 to-purple-600/20',
            },
          ].map((pillar, i) => (
            <motion.div
              key={pillar.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: i * 0.1 }}
              viewport={{ once: true }}
              className="relative group"
            >
              <div
                className={`absolute inset-0 bg-gradient-to-br ${pillar.bgGradient} rounded-2xl blur-xl opacity-40 group-hover:opacity-70 transition-opacity duration-300`}
              />
              <div className="relative bg-slate-900/60 backdrop-blur-sm border border-slate-700/60 rounded-2xl p-7 hover:border-slate-500/80 transition-all duration-300">
                <div className="mb-4">
                  <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-slate-800/80">
                    <span className="text-xl">{pillar.icon}</span>
                  </div>
                </div>
                <h3 className={`text-xl font-semibold mb-2 ${pillar.color}`}>{pillar.title}</h3>
                <p className="text-slate-300 text-sm leading-relaxed">{pillar.desc}</p>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Educational disclaimer */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          viewport={{ once: true }}
          className="mt-16 bg-amber-900/20 border border-amber-500/30 rounded-xl p-6 max-w-4xl mx-auto"
        >
          <div className="flex items-start gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <div className="text-amber-300 font-semibold mb-2">
                NOT SEBI-REGISTERED • EDUCATIONAL ONLY
              </div>
              <p className="text-amber-100/80 text-sm leading-relaxed">
                SwingSetups provides AI-generated educational analysis. We do not provide investment advice or
                portfolio management services. Trading involves risk; past performance does not guarantee future
                results. You are solely responsible for your own trading decisions.
              </p>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}