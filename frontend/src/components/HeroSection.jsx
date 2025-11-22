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
            AI swing analysis · Educational only
          </p>

          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold tracking-tight text-white">
            Daily swing analysis{" "}
            <span className="block text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-emerald-400">
              for your watchlist stocks
            </span>
          </h1>

          <p className="max-w-xl text-sm sm:text-base text-slate-300">
            Add the stocks you follow. SwingSetups reviews them after market
            close and marks important price regions in simple English.
            It is an educational view of price behaviour, not a trading tip.
          </p>

          <ul className="space-y-2 text-sm text-slate-200">
            <li className="flex gap-2">
              <span className="mt-0.5 h-4 w-4 rounded-full bg-emerald-500/20 text-emerald-300 flex items-center justify-center text-xs border border-emerald-400/30">
                ✓
              </span>
              <span>Works on NSE &amp; BSE stocks.</span>
            </li>
            <li className="flex gap-2">
              <span className="mt-0.5 h-4 w-4 rounded-full bg-emerald-500/20 text-emerald-300 flex items-center justify-center text-xs border border-emerald-400/30">
                ✓
              </span>
              <span>
                Neutral, educational explanations – no "sure-shot" calls or tips.
              </span>
            </li>
            <li className="flex gap-2">
              <span className="mt-0.5 h-4 w-4 rounded-full bg-emerald-500/20 text-emerald-300 flex items-center justify-center text-xs border border-emerald-400/30">
                ✓
              </span>
              <span>
                Track from 3 to 100 stocks in your watchlist, depending on plan.
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
                See an example analysis
              </Link>
            </div>
          </div>

          <p className="text-[11px] text-slate-400 pt-1">
            No brokerage integration. SwingSetups does not execute orders or
            manage money. It only explains price regions for learning.
          </p>
        </div>

        {/* RIGHT – sample card */}
        <div className="w-full lg:w-1/2 flex justify-center">
          <div className="w-full max-w-sm rounded-[28px] bg-gradient-to-b from-slate-800/80 to-slate-900/80 backdrop-blur-xl shadow-2xl shadow-blue-900/30 border border-slate-700/50 overflow-hidden">
            {/* Fake tab bar to make it feel app-like */}
            <div className="bg-slate-800/60 backdrop-blur-sm px-4 py-3 border-b border-slate-700/50 flex items-center justify-between">
              <p className="text-xs font-medium text-slate-300">SwingSetups · Example view</p>
              <div className="flex gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
              </div>
            </div>

            <div className="p-5">
              <h2 className="text-sm font-semibold text-white">
                TATASTEEL · Upward-leaning structure
              </h2>
              <p className="mt-1 text-xs text-slate-400">
                Educational map of recent price behaviour
              </p>

            <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
              <div className="rounded-xl bg-slate-700/40 backdrop-blur-sm border border-slate-600/30 p-3">
                <p className="text-[11px] text-slate-400">Middle zone</p>
                <p className="text-sm font-semibold text-white">
                  ₹184.10
                </p>
              </div>
              <div className="rounded-xl bg-emerald-500/10 backdrop-blur-sm border border-emerald-500/30 p-3">
                <p className="text-[11px] text-emerald-300">Upper region</p>
                <p className="text-sm font-semibold text-emerald-400">
                  ₹190.79
                </p>
              </div>
              <div className="rounded-xl bg-rose-500/10 backdrop-blur-sm border border-rose-500/30 p-3">
                <p className="text-[11px] text-rose-300">Lower region</p>
                <p className="text-sm font-semibold text-rose-400">
                  ₹180.75
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-xl bg-slate-700/30 backdrop-blur-sm border border-slate-600/30 p-3 text-xs text-slate-300 space-y-1">
              <p>
                Price has respected the area near ₹184.10 in recent sessions.
              </p>
              <p>
                Movement has slowed around ₹190.79 and weakened near ₹180.75 in
                the past.
              </p>
              <p className="text-[11px] text-slate-400 pt-1">
                This is only an educational interpretation of past price
                behaviour, not a recommendation.
              </p>
            </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
