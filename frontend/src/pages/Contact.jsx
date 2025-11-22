import React from "react";
import { motion } from "framer-motion";

export default function Contact() {
  return (
    <section className="min-h-screen flex flex-col items-center justify-center py-20 px-4 relative overflow-hidden bg-slate-50">
      {/* Soft background like home page */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_#e0f2fe,_transparent_55%),_radial-gradient(circle_at_bottom,_#f1f5f9,_transparent_60%)]" />

      {/* Very subtle animated blobs */}
      <div className="absolute inset-0 -z-10">
        <motion.div
          animate={{ x: [0, 60, 0], y: [0, -40, 0], scale: [1, 1.05, 1] }}
          transition={{ duration: 22, repeat: Infinity, ease: "linear" }}
          className="absolute top-20 left-10 w-72 h-72 bg-blue-200/40 rounded-full blur-3xl"
        />
        <motion.div
          animate={{ x: [0, -50, 0], y: [0, 40, 0], scale: [1, 1.08, 1] }}
          transition={{ duration: 26, repeat: Infinity, ease: "linear" }}
          className="absolute bottom-16 right-6 w-80 h-80 bg-emerald-200/40 rounded-full blur-3xl"
        />
      </div>

      <div className="container mx-auto max-w-4xl z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <div className="inline-flex items-center bg-white/70 backdrop-blur-sm rounded-full px-5 py-2 border border-slate-200 mb-6">
            <span className="text-xs font-semibold text-blue-700">
              💬 GET IN TOUCH
            </span>
          </div>
          <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-slate-900 mb-4">
            Contact{" "}
            <span className="text-transparent bg-gradient-to-r from-blue-600 to-emerald-500 bg-clip-text">
              SwingSetups
            </span>{" "}
            team
          </h1>
          <p className="text-base md:text-lg text-slate-600 max-w-2xl mx-auto leading-relaxed">
            Have questions about SwingSetups or your watchlist analysis? Reach
            out and we&apos;ll be happy to help.
          </p>
        </motion.div>

        {/* Contact Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-16">
          {/* Phone Card */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.5 }}
            className="bg-white/90 border border-slate-200 rounded-2xl p-6 text-center shadow-sm hover:shadow-md hover:border-blue-400/70 transition-all duration-200 group"
          >
            <div className="bg-blue-50 rounded-2xl p-4 w-14 h-14 mx-auto mb-5 flex items-center justify-center group-hover:scale-105 transition-transform duration-200">
              <span className="text-2xl">📞</span>
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">
              Quick call
            </h3>
            <p className="text-slate-500 mb-3 text-sm">
              Instant support for urgent queries
            </p>
            <a
              href="tel:+919008108650"
              className="text-blue-600 text-base font-semibold hover:text-blue-700 transition"
            >
              +91&nbsp;90081&nbsp;08650
            </a>
          </motion.div>

          {/* Email Card */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="bg-white/90 border border-slate-200 rounded-2xl p-6 text-center shadow-sm hover:shadow-md hover:border-emerald-400/70 transition-all duration-200 group"
          >
            <div className="bg-emerald-50 rounded-2xl p-4 w-14 h-14 mx-auto mb-5 flex items-center justify-center group-hover:scale-105 transition-transform duration-200">
              <span className="text-2xl">✉️</span>
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">
              Email support
            </h3>
            <p className="text-slate-500 mb-3 text-sm">
              For detailed questions and feedback
            </p>
            <a
              href="mailto:hello@nolojik.com"
              className="text-emerald-600 text-base font-semibold hover:text-emerald-700 transition break-all"
            >
              hello@nolojik.com
            </a>
            <div className="text-slate-400 text-xs mt-2">
              Typically replies within 24 hours
            </div>
          </motion.div>

          {/* App Support Card */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.5 }}
            className="bg-white/90 border border-slate-200 rounded-2xl p-6 text-center shadow-sm hover:shadow-md hover:border-orange-400/70 transition-all duration-200 group"
          >
            <div className="bg-orange-50 rounded-2xl p-4 w-14 h-14 mx-auto mb-5 flex items-center justify-center group-hover:scale-105 transition-transform duration-200">
              <span className="text-2xl">📱</span>
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">
              App help
            </h3>
            <p className="text-slate-500 mb-3 text-sm">
              Need help with the SwingSetups app?
            </p>
            <p className="text-orange-600 text-sm font-semibold">
              Use in-app support or email us
            </p>
          </motion.div>
        </div>

        {/* Address Section */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="bg-white/90 border border-slate-200 rounded-2xl p-6 sm:p-8 text-center shadow-sm"
        >
          <div className="bg-violet-50 rounded-2xl p-4 w-14 h-14 mx-auto mb-5 flex items-center justify-center">
            <span className="text-2xl">🏢</span>
          </div>
          <h3 className="text-lg font-semibold text-slate-900 mb-3">
            Registered office
          </h3>
          <div className="text-slate-600 text-sm space-y-1">
            <p className="font-semibold">Nolojik Innovations Private Limited</p>
            <p>No. 235, Binnamangala, 13th Cross</p>
            <p>Indiranagar 2nd Stage</p>
            <p>Bengaluru – 560038, India</p>
          </div>
        </motion.div>

        {/* Bottom tagline */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6, duration: 0.5 }}
          className="text-center mt-10"
        >
          <p className="text-slate-500 text-sm">
            Track your watchlist with{" "}
            <span className="text-transparent bg-gradient-to-r from-blue-600 to-emerald-500 bg-clip-text font-semibold">
              SwingSetups
            </span>
          </p>
          <p className="text-slate-400 text-[11px] mt-2">
            SwingSetups is a product of Nolojik Innovations Private Limited.
          </p>
        </motion.div>
      </div>
    </section>
  );
}