import React from 'react';
import { motion } from 'framer-motion';

export default function WhatIsSwingSetupsSection() {
  const features = [
    {
      icon: "🎯",
      title: "Clear Verdicts",
      desc: '"WAIT for ₹775" not confusing jargon. Know exactly what action to take.',
      color: "text-blue-300",
      bgColor: "bg-blue-500/10",
      borderColor: "border-blue-500/30"
    },
    {
      icon: "📊",
      title: "Know Your Risk",
      desc: "See exact ₹ amounts you could lose or gain before you trade.",
      color: "text-emerald-300",
      bgColor: "bg-emerald-500/10",
      borderColor: "border-emerald-500/30"
    },
    {
      icon: "🛡️",
      title: "Permission to Skip",
      desc: '"No good setup today" is a valid answer. Quality over quantity.',
      color: "text-amber-300",
      bgColor: "bg-amber-500/10",
      borderColor: "border-amber-500/30"
    },
    {
      icon: "🔍",
      title: "Weekend Discovery",
      desc: "Fresh Grade A stocks every Saturday. Breakout, pullback, momentum setups.",
      color: "text-purple-300",
      bgColor: "bg-purple-500/10",
      borderColor: "border-purple-500/30"
    },
    {
      icon: "📅",
      title: "Daily Updates",
      desc: "Analysis refreshed after market close (~5 PM). One calm update per day.",
      color: "text-cyan-300",
      bgColor: "bg-cyan-500/10",
      borderColor: "border-cyan-500/30"
    },
    {
      icon: "🚪",
      title: "Exit Coaching",
      desc: "Know when to hold, trail your stop, or exit. Position management made simple.",
      color: "text-pink-300",
      bgColor: "bg-pink-500/10",
      borderColor: "border-pink-500/30"
    },
  ];

  return (
    <section className="py-24 px-4 bg-gradient-to-br from-slate-900 via-blue-900 to-indigo-900">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <div className="inline-flex items-center bg-slate-800/40 backdrop-blur-sm border border-slate-700/50 px-4 py-2 rounded-full mb-6">
            <span className="text-blue-300 text-xs font-semibold tracking-wide">
              WHAT YOU GET
            </span>
          </div>

          <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight mb-4">
            Trading guidance that{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-emerald-400">
              actually helps
            </span>
          </h2>

          <p className="text-slate-300 text-lg leading-relaxed max-w-2xl mx-auto">
            Not just charts and indicators. Clear actions, honest risk assessment,
            and permission to wait when there's nothing worth trading.
          </p>
        </motion.div>

        {/* Feature Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((item, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              viewport={{ once: true }}
              className={`p-6 rounded-2xl ${item.bgColor} backdrop-blur-sm border ${item.borderColor} hover:scale-[1.02] transition-transform`}
            >
              <div className="text-3xl mb-4">{item.icon}</div>
              <h3 className={`font-semibold text-xl mb-2 ${item.color}`}>
                {item.title}
              </h3>
              <p className="text-slate-300 text-sm">{item.desc}</p>
            </motion.div>
          ))}
        </div>

        {/* Bottom comparison teaser */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          viewport={{ once: true }}
          className="mt-16 text-center"
        >
          <div className="inline-flex items-center gap-4 bg-slate-800/40 backdrop-blur-sm border border-slate-700/50 rounded-2xl px-6 py-4">
            <div className="text-left">
              <p className="text-slate-400 text-xs line-through">"RSI divergence with EMA crossover"</p>
              <p className="text-emerald-300 text-sm font-semibold mt-1">"Stock pulled back. Risk ₹22 to make ₹46."</p>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}