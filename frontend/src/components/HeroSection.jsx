import React from 'react';
import { Link } from 'react-router-dom';

export default function HeroSection() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-blue-900 to-indigo-900">
      {/* subtle background gradient */}
      <div className="pointer-events-none absolute inset-0 opacity-20">
        <div className="absolute top-20 left-10 w-72 h-72 bg-blue-500 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-20 right-10 w-96 h-96 bg-emerald-500 rounded-full blur-3xl animate-pulse delay-1000"></div>
      </div>

      <div className="relative mx-auto flex max-w-6xl flex-col-reverse gap-10 px-4 py-16 sm:px-6 lg:flex-row lg:items-center lg:py-20">
        {/* LEFT – text */}
        <div className="w-full lg:w-1/2 space-y-6">
          <p className="inline-flex items-center rounded-full bg-blue-500/20 backdrop-blur-sm px-3 py-1 text-xs font-medium text-blue-300 border border-blue-400/30">
            Your calm, experienced trading friend
          </p>

          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-white">
            Clear actions,{" "}
            <span className="block text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-emerald-400">
              not confusing charts
            </span>
          </h1>

          <p className="max-w-xl text-sm sm:text-base text-slate-300">
            "WAIT for ₹775" beats "RSI divergence with EMA crossover."
            We find Grade A setups weekly and tell you exactly what to do —
            including when to skip.
          </p>

          <ul className="space-y-2 text-sm text-slate-200">
            <li className="flex gap-2">
              <span className="mt-0.5 h-4 w-4 rounded-full bg-emerald-500/20 text-emerald-300 flex items-center justify-center text-xs border border-emerald-400/30">
                ✓
              </span>
              <span>Weekly discovery of Grade A setups (breakout, pullback, momentum)</span>
            </li>
            <li className="flex gap-2">
              <span className="mt-0.5 h-4 w-4 rounded-full bg-emerald-500/20 text-emerald-300 flex items-center justify-center text-xs border border-emerald-400/30">
                ✓
              </span>
              <span>
                Clear verdicts: "WAIT for ₹775" or "SKIP today"
              </span>
            </li>
            <li className="flex gap-2">
              <span className="mt-0.5 h-4 w-4 rounded-full bg-emerald-500/20 text-emerald-300 flex items-center justify-center text-xs border border-emerald-400/30">
                ✓
              </span>
              <span>
                Know exactly what to risk (₹22) to potentially gain (₹46)
              </span>
            </li>
            <li className="flex gap-2">
              <span className="mt-0.5 h-4 w-4 rounded-full bg-amber-500/20 text-amber-300 flex items-center justify-center text-xs border border-amber-400/30">
                ✓
              </span>
              <span>
                Permission to NOT trade when there's no good setup
              </span>
            </li>
          </ul>

          <div className="pt-2">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <Link
                  to="/download"
                  className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-emerald-500 px-6 py-3 text-sm font-semibold text-white shadow-sm shadow-blue-500/10 hover:shadow-md hover:shadow-blue-500/20 hover:brightness-105 transition"
                >
                  Download the App
                </Link>
                <p className="text-xs text-slate-400 mt-1.5 ml-1">
                  30-day free trial with 3 stocks
                </p>
              </div>
              <Link
                to="/how-it-works"
                className="inline-flex items-center justify-center rounded-xl border border-slate-600/50 bg-slate-800/40 backdrop-blur-sm px-5 py-3 text-sm font-semibold text-white hover:bg-slate-700/40 transition"
              >
                See how it works
              </Link>
            </div>
          </div>

          <p className="text-[11px] text-slate-400 pt-1">
            Educational only. SwingSetups does not execute orders or manage money.
          </p>
        </div>

        {/* RIGHT – sample card */}
        <div className="w-full lg:w-1/2 flex justify-center">
          <div className="w-full max-w-sm rounded-[28px] bg-gradient-to-b from-slate-800/80 to-slate-900/80 backdrop-blur-xl shadow-2xl shadow-blue-900/30 border border-slate-700/50 overflow-hidden">
            {/* Header with grade */}
            <div className="bg-slate-800/60 backdrop-blur-sm px-4 py-3 border-b border-slate-700/50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-white">TATASTEEL</p>
                <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-semibold border border-emerald-500/30">
                  Grade A (85/100)
                </span>
              </div>
              <span className="text-xs text-slate-400">Pullback</span>
            </div>

            <div className="p-5 space-y-4">
              {/* Main verdict */}
              <div className="rounded-xl bg-blue-500/10 border border-blue-500/30 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-lg">🎯</span>
                  <p className="text-blue-300 font-semibold">WAIT for ₹142</p>
                </div>
                <p className="text-xs text-slate-300">Not in zone yet — set an alert</p>
              </div>

              {/* Why this makes sense */}
              <div className="space-y-2">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Why this makes sense</p>
                <ul className="text-xs text-slate-300 space-y-1">
                  <li className="flex gap-2">
                    <span className="text-emerald-400">•</span>
                    Stock pulled back to support (₹140-145)
                  </li>
                  <li className="flex gap-2">
                    <span className="text-emerald-400">•</span>
                    Risk ₹4.50 to potentially gain ₹9.50
                  </li>
                  <li className="flex gap-2">
                    <span className="text-emerald-400">•</span>
                    Even if wrong, that's a small planned loss
                  </li>
                </ul>
              </div>

              {/* What to do */}
              <div className="rounded-xl bg-slate-700/30 border border-slate-600/30 p-3 space-y-2">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">What to do</p>
                <div className="text-xs text-slate-200 space-y-1">
                  <p>→ Set alert at ₹142</p>
                  <p>→ When it hits, place order with stop at ₹138</p>
                  <p>→ Target: ₹152</p>
                </div>
              </div>

              {/* If it fails */}
              <div className="rounded-xl bg-amber-500/10 border border-amber-500/20 p-3">
                <p className="text-[11px] text-amber-200">
                  <span className="font-semibold">If it fails:</span> ₹450 loss (on 100 shares) = 0.45% of ₹1L capital. That's normal. You followed your rules.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
