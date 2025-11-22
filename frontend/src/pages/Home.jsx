import React from 'react';
import { Link } from 'react-router-dom';
import HeroSection from '../components/HeroSection';
import WhatIsSwingSetupsSection from '../components/WhatIsSwingSetupsSection';
import OurApproachSection from '../components/OurApproachSection';
import FeatureSection from '../components/FeatureSection';
import FAQSection from '../components/FAQSection';

const SectionDivider = () => (
  <div className="max-w-5xl mx-auto px-6 py-10">
    <div className="h-px bg-gradient-to-r from-emerald-400/40 via-blue-500/70 to-emerald-400/40 rounded-full" />
  </div>
);

export default function Home() {
  return (
    <>
      <HeroSection />
      <SectionDivider />
      <WhatIsSwingSetupsSection />
      <SectionDivider />
      <OurApproachSection />
      <SectionDivider />
      <FeatureSection />
      <SectionDivider />
      <section className="py-16 px-4" id="download">
        <div className="max-w-6xl mx-auto bg-slate-900/60 backdrop-blur border border-white/10 rounded-3xl shadow-2xl shadow-blue-900/30 overflow-hidden">
          <div className="grid lg:grid-cols-[1.15fr_0.85fr] gap-10 p-10">
            <div className="space-y-6">
              <div className="inline-flex items-center text-xs font-semibold uppercase tracking-[0.2em] text-emerald-200 bg-emerald-500/10 border border-emerald-400/30 px-4 py-2 rounded-full">
                30-day free trial
              </div>
              <div className="space-y-3">
                <h2 className="text-3xl md:text-4xl font-black text-white leading-tight">
                  Swing-ready setups, delivered nightly after market close
                </h2>
                <p className="text-lg text-slate-200/90">
                  Add the tickers you care about and get a calm, structured swing read with key regions and reasoning—once per day, no noise.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <span className="px-4 py-2 bg-white/5 text-white/80 text-sm rounded-full border border-white/10">
                  NSE &amp; BSE coverage
                </span>
                <span className="px-4 py-2 bg-white/5 text-white/80 text-sm rounded-full border border-white/10">
                  Evening delivery
                </span>
                <span className="px-4 py-2 bg-white/5 text-white/80 text-sm rounded-full border border-white/10">
                  Structured swing context
                </span>
              </div>
              <div className="flex flex-col sm:flex-row gap-4 items-start">
                <Link
                  to="/download"
                  className="inline-flex items-center justify-center bg-gradient-to-r from-blue-600 to-emerald-500 hover:from-blue-700 hover:to-emerald-600 text-white font-bold px-7 py-4 rounded-2xl transition-all duration-300 transform hover:scale-[1.02] shadow-lg shadow-blue-500/20 w-full sm:w-auto"
                >
                  <span className="mr-2 text-xl">📈</span>
                  Start free
                </Link>
                <a
                  href="#faq"
                  className="inline-flex items-center justify-center px-7 py-4 rounded-2xl border border-white/15 text-white/80 hover:text-white hover:border-white/40 transition-all duration-300 bg-white/5 w-full sm:w-auto"
                >
                  See FAQ
                </a>
              </div>
              <p className="text-sm text-white/60">No card needed. Cancel anytime.</p>
            </div>
            <div className="bg-white/5 rounded-2xl border border-white/10 p-6 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-200">
                Plans at a glance
              </p>
              <ul className="space-y-3 text-white">
                <li className="flex gap-3">
                  <span className="mt-0.5">✅</span>
                  <div>
                    <p className="font-semibold">Free trial</p>
                    <p className="text-sm text-white/70">30 days • Track up to 3 stocks</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="mt-0.5">📊</span>
                  <div>
                    <p className="font-semibold">Pricing</p>
                    <p className="text-sm text-white/70">
                      Plans from ₹99 to ₹1999 per month. Track from 3 to 30 stocks based on your plan.
                    </p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="mt-0.5">🛡️</span>
                  <div>
                    <p className="font-semibold">Stable delivery</p>
                    <p className="text-sm text-white/70">Nightly analysis after market close with calm, structured context.</p>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="mt-0.5">🌐</span>
                  <div>
                    <p className="font-semibold">Cross-platform</p>
                    <p className="text-sm text-white/70">Same account works across web, Android, and iOS.</p>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>
      <FAQSection />
    </>
  );
}
