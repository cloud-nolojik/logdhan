import React from "react";
import { Link } from "react-router-dom";

export default function Pricing() {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-16 sm:px-6 lg:px-8">
      {/* soft background */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_#e0f2fe,_transparent_55%),_radial-gradient(circle_at_bottom,_#f1f5f9,_transparent_60%)]" />

      <div className="mx-auto max-w-6xl">
        {/* HEADER */}
        <div className="text-center mb-12">
          <p className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
            100% free, ad-supported
          </p>
          <h1 className="mt-4 text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-slate-900">
            Everything is{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-emerald-500">
              free
            </span>
          </h1>
          <p className="mt-4 max-w-2xl mx-auto text-sm sm:text-base text-slate-600">
            No subscriptions, no hidden fees. SwingSetups is completely free and supported
            by short advertisements.
          </p>
        </div>

        {/* HOW IT WORKS CARD */}
        <div className="mb-10 rounded-3xl border border-emerald-100 bg-white shadow-sm p-6 sm:p-8">
          <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-6 text-center">
            How SwingSetups works
          </h2>

          <div className="grid md:grid-cols-3 gap-6 mb-8">
            <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-5 text-center">
              <div className="text-3xl mb-3">🆓</div>
              <h3 className="text-base font-semibold text-emerald-900 mb-2">Free forever</h3>
              <p className="text-xs text-emerald-700">
                No subscription fees, no in-app purchases. All features are available to everyone.
              </p>
            </div>

            <div className="rounded-2xl bg-blue-50 border border-blue-100 p-5 text-center">
              <div className="text-3xl mb-3">📊</div>
              <h3 className="text-base font-semibold text-blue-900 mb-2">5 stocks per day</h3>
              <p className="text-xs text-blue-700">
                Add up to 5 new stocks to your watchlist each day. No limit on total watchlist size —
                it grows over time.
              </p>
            </div>

            <div className="rounded-2xl bg-amber-50 border border-amber-100 p-5 text-center">
              <div className="text-3xl mb-3">📺</div>
              <h3 className="text-base font-semibold text-amber-900 mb-2">Watch short ads</h3>
              <p className="text-xs text-amber-700">
                Unlock Daily Picks, Trail Protection, and Trade Check by watching a brief ad.
                Each unlock lasts for the trading day.
              </p>
            </div>
          </div>

          <div className="rounded-2xl bg-slate-100 border border-slate-200 px-4 py-3 text-xs text-slate-700 text-center">
            That's it. No credit card needed. No trials. No "upgrade" walls.
          </div>
        </div>

        {/* FEATURES BLOCK */}
        <div className="mb-10 rounded-3xl bg-white border border-slate-100 shadow-sm p-6 sm:p-8">
          <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-6 text-center">
            What's included
          </h2>

          <div className="space-y-6">
            {/* DISCOVERY */}
            <div className="rounded-2xl bg-blue-50 border border-blue-100 p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xl">🔍</span>
                <h3 className="text-base font-semibold text-blue-900">DISCOVERY</h3>
              </div>
              <ul className="text-xs text-blue-800 space-y-1">
                <li className="flex gap-2"><span>✓</span> Weekly Grade A stock picks (Saturday)</li>
                <li className="flex gap-2"><span>✓</span> 4 setup types: Breakout, Pullback, Momentum, Consolidation</li>
                <li className="flex gap-2"><span>✓</span> Daily Picks — top opportunities each trading day</li>
              </ul>
            </div>

            {/* ANALYSIS */}
            <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xl">📊</span>
                <h3 className="text-base font-semibold text-emerald-900">ANALYSIS</h3>
              </div>
              <ul className="text-xs text-emerald-800 space-y-1">
                <li className="flex gap-2"><span>✓</span> Daily post-market analysis (4 PM)</li>
                <li className="flex gap-2"><span>✓</span> Clear verdicts: "WAIT", "SKIP", "HOLD", "EXIT"</li>
                <li className="flex gap-2"><span>✓</span> Exact ₹ risk/reward amounts</li>
                <li className="flex gap-2"><span>✓</span> Beginner-friendly explanations</li>
              </ul>
            </div>

            {/* MANAGEMENT */}
            <div className="rounded-2xl bg-violet-50 border border-violet-100 p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xl">🎯</span>
                <h3 className="text-base font-semibold text-violet-900">MANAGEMENT</h3>
              </div>
              <ul className="text-xs text-violet-800 space-y-1">
                <li className="flex gap-2"><span>✓</span> Position tracking with trail stop suggestions</li>
                <li className="flex gap-2"><span>✓</span> Exit coaching when structure breaks</li>
                <li className="flex gap-2"><span>✓</span> Trade journal with P&amp;L</li>
              </ul>
            </div>

            {/* ALERTS & EMOTIONAL SUPPORT */}
            <div className="grid md:grid-cols-2 gap-4">
              <div className="rounded-2xl bg-amber-50 border border-amber-100 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xl">🔔</span>
                  <h3 className="text-base font-semibold text-amber-900">ALERTS</h3>
                </div>
                <ul className="text-xs text-amber-800 space-y-1">
                  <li className="flex gap-2"><span>✓</span> WhatsApp notifications (optional)</li>
                  <li className="flex gap-2"><span>✓</span> Price alerts when stock reaches zone</li>
                </ul>
              </div>

              <div className="rounded-2xl bg-pink-50 border border-pink-100 p-5">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xl">🛡️</span>
                  <h3 className="text-base font-semibold text-pink-900">EMOTIONAL SUPPORT</h3>
                </div>
                <ul className="text-xs text-pink-800 space-y-1">
                  <li className="flex gap-2"><span>✓</span> Permission to skip weak setups</li>
                  <li className="flex gap-2"><span>✓</span> "Why it's okay" when trades fail</li>
                  <li className="flex gap-2"><span>✓</span> No FOMO - quality over quantity</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        {/* WHY ADS? */}
        <div className="mb-10 rounded-3xl bg-white border border-slate-100 shadow-sm p-6 sm:p-8">
          <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-4 text-center">
            Why ads?
          </h2>
          <p className="text-sm text-slate-600 text-center max-w-2xl mx-auto mb-6">
            We believe quality trading education shouldn't be locked behind expensive subscriptions.
            Short ads let us keep everything free while covering our AI and infrastructure costs.
          </p>
          <div className="grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
            <div className="flex items-start gap-3">
              <span className="text-emerald-500 mt-0.5">✓</span>
              <p className="text-sm text-slate-700">Ads are short (15-30 seconds)</p>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-emerald-500 mt-0.5">✓</span>
              <p className="text-sm text-slate-700">Unlocks last the full trading day</p>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-emerald-500 mt-0.5">✓</span>
              <p className="text-sm text-slate-700">No pop-ups or banner interruptions</p>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-emerald-500 mt-0.5">✓</span>
              <p className="text-sm text-slate-700">Your data is never sold</p>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="mb-10 rounded-3xl bg-slate-900 text-white p-6 sm:p-8 text-center">
          <div className="text-3xl mb-3">📈</div>
          <h2 className="text-xl sm:text-2xl font-semibold mb-3">
            Ready to start?
          </h2>
          <p className="text-sm text-slate-300 mb-6 max-w-lg mx-auto">
            Download the app, add your first stocks, and get AI swing analysis — all for free.
          </p>
          <Link
            to="/download"
            className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-emerald-500 px-8 py-3 text-sm font-semibold text-white shadow-md shadow-blue-500/20 hover:shadow-lg hover:brightness-105 transition"
          >
            Download the App
          </Link>
        </div>

        {/* DISCLAIMER */}
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-xs text-amber-800">
          <p>
            <span className="font-semibold">⚠️ Educational only:</span> SwingSetups is not
            SEBI-registered. We do not provide investment advice or portfolio management services.
            All analysis is AI-generated educational content. Trading involves risk; past performance
            does not guarantee future results.
          </p>
        </div>
      </div>
    </div>
  );
}
