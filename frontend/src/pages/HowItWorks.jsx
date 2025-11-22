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
            How it works · Step by step
          </p>
          <h1 className="mt-4 text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-slate-900">
            How SwingSetups{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-emerald-500">
              analyzes your watchlist
            </span>
          </h1>
          <p className="mt-4 max-w-2xl mx-auto text-sm sm:text-base text-slate-600">
            One calm, AI-powered review after market close. No noisy intraday
            pings – just clear levels you can use as an educational reference.
          </p>
        </motion.div>

        {/* STEP-BY-STEP */}
        <div className="space-y-6 mb-16">
          {/* Step 1 */}
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
              <div>
                <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-2">
                  Add your watchlist
                </h2>
                <p className="text-sm sm:text-base text-slate-600">
                  Pick the stocks you already follow. You can start with just a
                  few names and adjust anytime. Your plan decides how many
                  stocks you can track (3 to 100 stocks, depending on plan).
                </p>
              </div>
            </div>
          </motion.div>

          {/* Step 2 */}
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
                  Daily AI review after market close
                </h2>
                <p className="text-sm sm:text-base text-slate-600">
                  Each trading day (usually around 5 PM), SwingSetups reviews
                  your watchlist and builds simple structures using recent price
                  data. No intraday noise – just one clean update per day.
                </p>
              </div>
            </div>
          </motion.div>

          {/* Step 3 */}
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
              <div>
                <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-2">
                  See clear regions, not confusing calls
                </h2>
                <p className="text-sm sm:text-base text-slate-600">
                  You see upper, middle, and lower price regions with plain
                  explanations of how price has behaved earlier – plus short
                  notes on recent trend, volatility, and why regions were chosen.
                </p>
              </div>
            </div>
          </motion.div>

          {/* Step 4 */}
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
              <div>
                <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-2">
                  Use it as a reference
                </h2>
                <p className="text-sm sm:text-base text-slate-600">
                  Use these regions as an educational guide while planning your
                  own trades. SwingSetups never places orders – you stay in
                  control and decide what to do based on your own risk profile
                  and time frame.
                </p>
              </div>
            </div>
          </motion.div>
        </div>

        {/* WHAT YOU GET */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="rounded-3xl bg-white border border-slate-100 shadow-sm p-6 sm:p-8 mb-16"
        >
          <h2 className="text-2xl sm:text-3xl font-semibold text-slate-900 mb-6 text-center">
            What you get with SwingSetups
          </h2>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-5">
              <div className="text-2xl mb-2">📍</div>
              <h3 className="text-lg font-semibold text-slate-900 mb-1">
                Simple price regions
              </h3>
              <p className="text-sm text-slate-600">
                Middle zone, upper region, and lower region explained in plain
                English. No heavy jargon or complex indicators.
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-5">
              <div className="text-2xl mb-2">🔄</div>
              <h3 className="text-lg font-semibold text-slate-900 mb-1">
                Updated once per day
              </h3>
              <p className="text-sm text-slate-600">
                Fresh analysis after market close – not noisy intraday signals.
                Calm, structured view for swing trading.
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-5">
              <div className="text-2xl mb-2">💡</div>
              <h3 className="text-lg font-semibold text-slate-900 mb-1">
                Reasoning &amp; context
              </h3>
              <p className="text-sm text-slate-600">
                Short notes on recent trend, volatility, and why regions were
                chosen. Understand the “why” behind each analysis.
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-5">
              <div className="text-2xl mb-2">⚡</div>
              <h3 className="text-lg font-semibold text-slate-900 mb-1">
                Alerts for key changes
              </h3>
              <p className="text-sm text-slate-600">
                Highlights when behaviour near a region weakens the structure,
                helping you stay informed.
              </p>
            </div>
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
              "Language similar to Zerodha Varsity – clear and simple",
              "No heavy jargon, no complex indicators on the screen",
              "You stay in control – we don't place any orders for you",
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
            Ready to get started?
          </h2>
          <p className="text-sm sm:text-base text-slate-600 mb-6 max-w-2xl mx-auto">
            Start with 3 stocks free for 30 days, or choose a bigger plan for
            your entire watchlist.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/download"
              className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-emerald-500 px-8 py-3 text-sm font-semibold text-white shadow-md shadow-blue-500/20 hover:shadow-lg hover:brightness-105 transition"
            >
              📱 Start Free
            </Link>
            <Link
              to="/pricing"
              className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-8 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 transition"
            >
              💰 View Pricing
            </Link>
          </div>
        </motion.div>
      </div>
    </div>
  );
}