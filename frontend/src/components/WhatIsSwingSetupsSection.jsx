import React from 'react';
import { motion } from 'framer-motion';

export default function WhatIsSwingSetupsSection() {
  return (
    <section className="py-24 px-4 bg-gradient-to-br from-slate-900 via-blue-900 to-indigo-900">
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">

        {/* LEFT — TEXT */}
        <motion.div
          initial={{ opacity: 0, x: -40 }}
          whileInView={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.7 }}
          viewport={{ once: true }}
          className="space-y-8"
        >
          <div>
            <div className="inline-flex items-center bg-slate-800/40 backdrop-blur-sm border border-slate-700/50 px-4 py-2 rounded-full mb-6">
              <span className="text-blue-300 text-xs font-semibold tracking-wide">
                WHAT YOU SEE IN THE APP
              </span>
            </div>

            <h2 className="text-4xl md:text-5xl font-bold text-white leading-tight">
              Clear daily views for your{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-emerald-400">
                watchlist stocks
              </span>
            </h2>

            <p className="text-slate-300 text-lg leading-relaxed max-w-xl mt-4">
              SwingSetups reviews your watchlist after market close and highlights how price behaved in key regions. 
              Explanations are written in simple language to help you reason through structure — not follow calls.
            </p>
          </div>

          <div className="space-y-4">
            {[
              {
                title: "Price regions, not entry/targets",
                desc: "Upper, middle, and lower zones based on recent behaviour — not buy/sell triggers.",
                color: "text-blue-300"
              },
              {
                title: "One review per day",
                desc: "Post-market analysis keeps noise low and focused on swing movement.",
                color: "text-emerald-300"
              },
              {
                title: "Reasoning behind each region",
                desc: "Short explanations show why those zones mattered earlier, in simple terms.",
                color: "text-purple-300"
              },
              {
                title: "Highlights when the view weakens",
                desc: "Notes when price behaviour changes enough to reconsider the earlier structure.",
                color: "text-yellow-300"
              },
            ].map((item, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.5, delay: i * 0.1 }}
                viewport={{ once: true }}
                className="p-4 rounded-xl bg-slate-800/40 backdrop-blur-sm border border-slate-700/40 hover:bg-slate-800/60 transition"
              >
                <h3 className={`font-semibold text-lg mb-1 ${item.color}`}>
                  {item.title}
                </h3>
                <p className="text-slate-400 text-sm">{item.desc}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* RIGHT — SAMPLE VIEW CARD */}
        <motion.div
          initial={{ opacity: 0, x: 40 }}
          whileInView={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.7 }}
          viewport={{ once: true }}
          className="flex justify-center"
        >
          <div className="w-full max-w-sm rounded-3xl bg-slate-800/60 backdrop-blur-xl border border-slate-700/50 shadow-2xl overflow-hidden">

            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-700/50 bg-slate-900/40">
              <p className="text-xs text-slate-400 font-medium">Example view · SwingSetups</p>
            </div>

            <div className="p-6 space-y-4">

              <div>
                <h4 className="text-sm font-semibold text-white">
                  TATASTEEL · Upward-leaning structure
                </h4>
                <p className="text-xs text-slate-500 mt-1">
                  Educational interpretation of recent behaviour
                </p>
              </div>

              {/* REGIONS */}
              <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-xl bg-slate-800 border border-slate-700 p-3">
                  <p className="text-[11px] text-slate-400">Middle zone</p>
                  <p className="text-sm font-semibold text-white">₹184.10</p>
                </div>
                <div className="rounded-xl bg-slate-800 border border-emerald-500/40 p-3">
                  <p className="text-[11px] text-emerald-300">Upper region</p>
                  <p className="text-sm font-semibold text-emerald-400">₹190.79</p>
                </div>
                <div classname="rounded-xl bg-slate-800 border border-rose-500/40 p-3">
                  <p className="text-[11px] text-rose-300">Lower region</p>
                  <p className="text-sm font-semibold text-rose-400">₹180.75</p>
                </div>
              </div>

              {/* EXPLANATION */}
              <div className="rounded-xl bg-slate-800 border border-slate-700 p-3 text-xs text-slate-300 space-y-1">
                <p>Price has respected the area near ₹184.10 recently.</p>
                <p>Behaviour slowed near ₹190.79 and turned weaker around ₹180.75 earlier.</p>
                <p className="text-[11px] text-slate-500 pt-1">
                  This is educational context based on past behaviour, not a recommendation.
                </p>
              </div>

            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}