import React from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";

export default function Download() {
  const platforms = [
    {
      name: "Android",
      icon: "🤖",
      description: "Install the SwingSetups app from Google Play.",
      link: "/download/android",
      accent: "border-emerald-300 bg-emerald-50/80",
      pill: "bg-emerald-100 text-emerald-700",
      available: true,
      cta: "Get Android app",
    },
    {
      name: "iOS",
      icon: "🍎",
      description: "iOS version is under development.",
     
      accent: "border-slate-200 bg-white/80",
      pill: "bg-slate-100 text-slate-700",
      available: false,
      cta: "Coming soon",
    },
    {
      name: "Web app",
      icon: "🌐",
      description: "Use SwingSetups directly in your browser.",
    
      accent: "border-blue-200 bg-blue-50/80",
      pill: "bg-blue-100 text-blue-700",
      available: false,
      cta: "Coming soon",
    },
  ];

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-4 py-16 relative overflow-hidden bg-slate-50">
      {/* soft background similar to Home */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_#e0f2fe,_transparent_55%),_radial-gradient(circle_at_bottom,_#f1f5f9,_transparent_60%)]" />

      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7 }}
        className="max-w-4xl w-full text-center"
      >
        <h1 className="text-3xl md:text-5xl font-semibold tracking-tight text-slate-900 mb-4">
          Get{" "}
          <span className="text-transparent bg-gradient-to-r from-blue-600 to-emerald-500 bg-clip-text">
            SwingSetups
          </span>
        </h1>

        <p className="text-base md:text-lg text-slate-600 mb-10 max-w-2xl mx-auto">
          Start tracking your watchlist with daily AI swing analysis. Same
          account works across supported platforms.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
          {platforms.map((platform, index) => (
            <motion.div
              key={platform.name}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.15, duration: 0.5 }}
            >
              {platform.available ? (
                <Link to={platform.link} className="block h-full">
                  <div
                    className={`h-full rounded-2xl border ${platform.accent} shadow-sm hover:shadow-md transition-all duration-200 p-6 flex flex-col items-center text-center`}
                  >
                    <div className="text-4xl mb-3">{platform.icon}</div>
                    <h3 className="text-lg font-semibold text-slate-900 mb-1">
                      {platform.name}
                    </h3>
                    <p className="text-sm text-slate-600 mb-5">
                      {platform.description}
                    </p>
                    <div
                      className={`mt-auto inline-flex items-center justify-center px-4 py-2 rounded-full text-xs font-semibold ${platform.pill}`}
                    >
                      Available
                    </div>
                    <button
                      className="mt-3 w-full rounded-xl px-4 py-2 text-sm font-semibold bg-gradient-to-r from-blue-600 to-emerald-500 text-white hover:brightness-105 transition"
                      type="button"
                    >
                      {platform.cta}
                    </button>
                  </div>
                </Link>
              ) : (
                <div
                  className={`h-full rounded-2xl border ${platform.accent} shadow-sm p-6 flex flex-col items-center text-center opacity-75`}
                >
                  <div className="text-4xl mb-3">{platform.icon}</div>
                  <h3 className="text-lg font-semibold text-slate-900 mb-1">
                    {platform.name}
                  </h3>
                  <p className="text-sm text-slate-600 mb-5">
                    {platform.description}
                  </p>
                  <div
                    className={`mt-auto inline-flex items-center justify-center px-4 py-2 rounded-full text-xs font-semibold ${platform.pill}`}
                  >
                    Planned
                  </div>
                  <button
                    className="mt-3 w-full rounded-xl px-4 py-2 text-sm font-semibold bg-slate-100 text-slate-500 cursor-not-allowed transition"
                    type="button"
                    disabled
                  >
                    {platform.cta}
                  </button>
                </div>
              )}
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.5 }}
          className="bg-white/90 backdrop-blur-sm border border-slate-200 rounded-2xl p-6 max-w-2xl mx-auto shadow-sm"
        >
          <h3 className="text-lg font-semibold text-slate-900 mb-3">
            Same experience across platforms
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm text-slate-600">
            <div className="flex items-center justify-center gap-2">
              <span className="text-blue-500">📊</span>
              <span>Daily swing review</span>
            </div>
            <div className="flex items-center justify-center gap-2">
              <span className="text-emerald-500">🧭</span>
              <span>Clear price regions</span>
            </div>
            <div className="flex items-center justify-center gap-2">
              <span className="text-purple-500">🔐</span>
              <span>Same login everywhere</span>
            </div>
          </div>
          <p className="mt-4 text-[11px] text-slate-500">
            SwingSetups provides AI-generated educational analysis only. It does
            not place orders or manage money.
          </p>
        </motion.div>
      </motion.div>
    </div>
  );
}