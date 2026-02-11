import React from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";

export default function HowItWorks() {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        {/* subtle background gradient */}
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_#e0f2fe,_transparent_55%),_radial-gradient(circle_at_bottom,_#f1f5f9,_transparent_60%)]" />

        {/* HEADER */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-center mb-14"
        >
          <p className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
            How it works
          </p>
          <h1 className="mt-4 text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-slate-900">
            From discovery to{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-emerald-500">
              confident action
            </span>
          </h1>
          <p className="mt-4 max-w-2xl mx-auto text-sm sm:text-base text-slate-600">
            Clear verdicts, honest risk assessment, and guidance at every step —
            including when the right move is to wait.
          </p>
        </motion.div>

        {/* STEP-BY-STEP */}
        <div className="space-y-6 mb-16">
          {/* Step 1 - DISCOVER */}
          <motion.div
            initial={{ opacity: 0, x: -24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="rounded-3xl bg-white border border-slate-100 shadow-sm p-6 sm:p-8"
          >
            <div className="flex items-start gap-4 sm:gap-6">
              <div className="flex h-12 w-12 sm:h-14 sm:w-14 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-blue-700 text-lg font-semibold">
                1
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <h2 className="text-xl sm:text-2xl font-semibold text-slate-900">
                    DISCOVER
                  </h2>
                  <span className="text-xs font-medium text-slate-500 bg-slate-100 px-2 py-1 rounded-full">
                    Saturday
                  </span>
                </div>
                <p className="text-sm sm:text-base text-slate-600 mb-4">
                  Every weekend, we scan 1000+ stocks using proven patterns.
                  Only Grade A setups (score 80+) make the cut.
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { name: "Breakout", desc: "Pushing to new highs" },
                    { name: "Pullback", desc: "Dipping to support" },
                    { name: "Momentum", desc: "Running strong" },
                    { name: "Consolidation", desc: "Tight range breakout" },
                  ].map((type) => (
                    <div key={type.name} className="bg-slate-50 rounded-xl p-3 text-center">
                      <p className="text-sm font-semibold text-slate-900">{type.name}</p>
                      <p className="text-[11px] text-slate-500">{type.desc}</p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-emerald-600 mt-4 font-medium">
                  You get 5-15 quality picks, not 50 random stocks.
                </p>
              </div>
            </div>
          </motion.div>

          {/* Step 2 - ADD TO WATCHLIST */}
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="rounded-3xl bg-white border border-slate-100 shadow-sm p-6 sm:p-8"
          >
            <div className="flex items-start gap-4 sm:gap-6">
              <div className="flex h-12 w-12 sm:h-14 sm:w-14 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-lg font-semibold">
                2
              </div>
              <div>
                <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-2">
                  ADD TO WATCHLIST
                </h2>
                <p className="text-sm sm:text-base text-slate-600 mb-3">
                  Review our discoveries, add what interests you. Or add your own stocks —
                  we'll analyze them too.
                </p>
                <div className="flex flex-wrap gap-2">
                  <span className="px-3 py-1 bg-emerald-50 text-emerald-700 text-xs font-medium rounded-full">
                    Add up to 5 new stocks per day
                  </span>
                  <span className="px-3 py-1 bg-slate-100 text-slate-600 text-xs font-medium rounded-full">
                    No total watchlist limit
                  </span>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Step 3 - DAILY ANALYSIS */}
          <motion.div
            initial={{ opacity: 0, x: -24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="rounded-3xl bg-white border border-slate-100 shadow-sm p-6 sm:p-8"
          >
            <div className="flex items-start gap-4 sm:gap-6">
              <div className="flex h-12 w-12 sm:h-14 sm:w-14 flex-shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 text-lg font-semibold">
                3
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <h2 className="text-xl sm:text-2xl font-semibold text-slate-900">
                    DAILY ANALYSIS
                  </h2>
                  <span className="text-xs font-medium text-slate-500 bg-slate-100 px-2 py-1 rounded-full">
                    4 PM after market close
                  </span>
                </div>
                <p className="text-sm sm:text-base text-slate-600 mb-4">
                  For each stock, you get a clear verdict — not confusing charts.
                </p>

                {/* Sample verdicts */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">🎯</span>
                      <p className="font-semibold text-blue-700">WAIT for ₹775</p>
                    </div>
                    <p className="text-xs text-blue-600">Not in zone yet — set an alert</p>
                  </div>
                  <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">⏸️</span>
                      <p className="font-semibold text-amber-700">SKIP today</p>
                    </div>
                    <p className="text-xs text-amber-600">Not a strong setup right now</p>
                  </div>
                </div>

                <div className="mt-4 bg-slate-50 rounded-xl p-4">
                  <p className="text-xs text-slate-600 mb-2 font-medium">Every analysis includes:</p>
                  <ul className="text-xs text-slate-600 space-y-1">
                    <li className="flex gap-2"><span className="text-emerald-500">✓</span> Exact ₹ amounts for risk and reward</li>
                    <li className="flex gap-2"><span className="text-emerald-500">✓</span> What to do if you're in the trade vs not yet</li>
                    <li className="flex gap-2"><span className="text-emerald-500">✓</span> Why the setup makes sense (in plain English)</li>
                  </ul>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Step 4 - MANAGE POSITIONS */}
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="rounded-3xl bg-white border border-slate-100 shadow-sm p-6 sm:p-8"
          >
            <div className="flex items-start gap-4 sm:gap-6">
              <div className="flex h-12 w-12 sm:h-14 sm:w-14 flex-shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-700 text-lg font-semibold">
                4
              </div>
              <div className="flex-1">
                <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-2">
                  MANAGE POSITIONS
                </h2>
                <p className="text-sm sm:text-base text-slate-600 mb-4">
                  Once you're in a trade, we help you manage it with clear guidance.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 text-center">
                    <p className="font-semibold text-emerald-700 mb-1">HOLD</p>
                    <p className="text-[11px] text-emerald-600">Structure intact, stay in</p>
                  </div>
                  <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-center">
                    <p className="font-semibold text-blue-700 mb-1">TRAIL STOP</p>
                    <p className="text-[11px] text-blue-600">Move stop to ₹785</p>
                  </div>
                  <div className="bg-rose-50 border border-rose-100 rounded-xl p-4 text-center">
                    <p className="font-semibold text-rose-700 mb-1">EXIT</p>
                    <p className="text-[11px] text-rose-600">Broken below ₹760</p>
                  </div>
                </div>

                <div className="mt-4 bg-amber-50 border border-amber-100 rounded-xl p-4">
                  <p className="text-xs text-amber-700">
                    <span className="font-semibold">When trades fail:</span> We show exactly what you lost (e.g., "₹2,200 = 2.2%")
                    and remind you that planned losses are normal. Following your rules matters more than any single trade.
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        </div>

        {/* WHAT MAKES US DIFFERENT */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="rounded-3xl bg-slate-900 text-white p-6 sm:p-8 mb-16"
        >
          <h2 className="text-2xl sm:text-3xl font-semibold mb-6 text-center">
            What makes us different
          </h2>

          <div className="space-y-4">
            {[
              {
                other: '"RSI divergence with EMA crossover suggests bullish momentum"',
                us: '"Stock pulled back. Risk ₹22 to make ₹46."'
              },
              {
                other: '"Here are 50 stocks!"',
                us: '"5 Grade A setups this week. No FOMO, quality over quantity."'
              },
              {
                other: '"Your stop loss was hit"',
                us: '"Stop hit. You lost ₹2,200 (2.2%). That\'s normal. You followed your plan."'
              },
              {
                other: 'Confusing charts and indicators',
                us: '"WAIT for ₹775, then BUY with stop at ₹760"'
              },
            ].map((item, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 bg-slate-800/50 rounded-xl">
                <div className="flex items-start gap-3">
                  <span className="text-rose-400 text-sm mt-0.5">✗</span>
                  <p className="text-slate-400 text-sm">{item.other}</p>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-emerald-400 text-sm mt-0.5">✓</span>
                  <p className="text-emerald-300 text-sm font-medium">{item.us}</p>
                </div>
              </div>
            ))}
          </div>
        </motion.div>

        {/* BUILT FOR INDIAN TRADERS */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="rounded-3xl bg-white border border-slate-100 shadow-sm p-6 sm:p-8 mb-16"
        >
          <h2 className="text-2xl sm:text-3xl font-semibold text-slate-900 mb-6 text-center">
            Built for Indian retail traders
          </h2>
          <div className="space-y-3 max-w-3xl mx-auto">
            {[
              "Works on NSE & BSE equities",
              "Focus on multi-day swing moves, not hyper-active intraday",
              "Simple English — like chatting with an experienced friend",
              "Know your risk in ₹ amounts before every trade",
              "You stay in control — we don't place any orders for you",
            ].map((text) => (
              <div key={text} className="flex items-start gap-3">
                <span className="mt-0.5 text-emerald-600">✓</span>
                <p className="text-sm sm:text-base text-slate-700">{text}</p>
              </div>
            ))}
          </div>
        </motion.div>

        {/* DISCLAIMER */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="mb-16 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-5 sm:px-6"
        >
          <div className="flex items-start gap-3">
            <span className="text-xl">⚠️</span>
            <div>
              <p className="text-xs font-semibold text-amber-700 mb-1">
                NOT SEBI-REGISTERED · EDUCATIONAL ONLY
              </p>
              <p className="text-xs text-amber-800/90">
                SwingSetups provides AI-generated educational analysis. We do
                not provide investment advice or portfolio management services.
                Trading involves risk; past performance does not guarantee
                future results. You are solely responsible for your trading
                decisions.
              </p>
            </div>
          </div>
        </motion.div>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="rounded-3xl bg-white border border-slate-100 shadow-sm p-6 sm:p-8 text-center"
        >
          <div className="text-4xl mb-3">🚀</div>
          <h2 className="text-2xl sm:text-3xl font-semibold text-slate-900 mb-3">
            Ready to trade with clarity?
          </h2>
          <p className="text-sm sm:text-base text-slate-600 mb-6 max-w-2xl mx-auto">
            Start free — add up to 5 stocks per day. See exactly how we turn confusing charts
            into clear actions.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/download"
              className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-emerald-500 px-8 py-3 text-sm font-semibold text-white shadow-md shadow-blue-500/20 hover:shadow-lg hover:brightness-105 transition"
            >
              Download the App
            </Link>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
