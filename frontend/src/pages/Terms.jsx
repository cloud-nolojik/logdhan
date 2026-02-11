import React from 'react';

export default function Terms() {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-16 sm:px-6 lg:px-8">
      {/* subtle background gradient */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_#e0f2fe,_transparent_55%),_radial-gradient(circle_at_bottom,_#f1f5f9,_transparent_60%)]" />

      <div className="mx-auto max-w-4xl bg-white rounded-3xl border border-slate-100 shadow-sm p-8 md:p-10">
        
        <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-6">
          <span className="text-transparent bg-gradient-to-r from-blue-600 to-emerald-500 bg-clip-text">
            Terms of Service
          </span>
        </h1>

        <div className="text-slate-700 space-y-6 text-sm md:text-base leading-relaxed">

          {/* Disclaimer */}
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-4">
            <p className="text-amber-700 font-semibold">⚠️ Important Disclaimer</p>
            <p className="text-amber-800/90 text-sm mt-1">
              SwingSetups is an educational platform and does <strong>not</strong> provide financial advice, investment recommendations, or brokerage services. All information is for learning purposes only. Trading involves risk and users are responsible for their decisions.
            </p>
          </div>

          {/* 1. Service Description */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">1. Service Description</h2>
            <p className="text-slate-600">
              SwingSetups provides AI-generated analysis of stock price behaviour for educational purposes.
              The platform does not execute orders, suggest trades, or manage portfolios. Access is free
              and supported by advertisements. Users may add up to 5 new stocks to their watchlist per
              calendar day.
            </p>
          </div>

          {/* 2. User Responsibilities */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">2. User Responsibilities</h2>
            <p className="text-slate-600">
              By using SwingSetups, you agree to:
            </p>
            <ul className="list-disc list-inside text-slate-600 space-y-1 mt-2">
              <li>Use analysis only for learning, not as actionable investment advice</li>
              <li>Verify information independently before trading</li>
              <li>Comply with applicable laws and exchange regulations</li>
            </ul>
          </div>

          {/* 3. Ad-Supported Service */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">3. Ad-Supported Service</h2>
            <p className="text-slate-600">
              SwingSetups is a free, ad-supported application. Content such as Daily Picks, Trail Protection,
              and Trade Check is unlocked by watching short rewarded advertisements. No subscription fees,
              in-app purchases, or payment processing is involved. Watchlist additions are limited to 5 new
              stocks per day to ensure quality analysis for all users.
            </p>
          </div>

          {/* 4. Limitation of Liability */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">4. Limitation of Liability</h2>
            <p className="text-slate-600">
              SwingSetups and Nolojik Innovations Pvt Ltd are not liable for financial loss, trading outcomes, market movements,
              or decisions based on platform content. Users trade entirely at their own risk.
            </p>
          </div>

          {/* 5. Intellectual Property */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">5. Intellectual Property</h2>
            <p className="text-slate-600">
              All branding, algorithms, UI, analysis outputs, and documentation belong to Nolojik Innovations Pvt Ltd.
              Redistribution, scraping, automated extraction, or resale is prohibited without written permission.
            </p>
          </div>

          {/* 6. Availability */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">6. Service Availability</h2>
            <p className="text-slate-600">
              While we strive to provide continuous service, uptime is not guaranteed. Maintenance, outages, and market holidays
              may impact availability or analysis timing.
            </p>
          </div>

          {/* 7. Compliance */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">7. Governing Law</h2>
            <p className="text-slate-600">
              These terms are governed by Indian law. Any disputes fall under the jurisdiction of Bengaluru courts.
            </p>
          </div>

          {/* 8. Contact */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">8. Contact</h2>
            <p className="text-slate-600">
              For queries regarding these terms:
              <br />
              <a href="mailto:contact-swingsetups@nolojik.com" className="text-blue-600 hover:text-emerald-500 hover:underline transition">
                contact-swingsetups@nolojik.com
              </a>
            </p>
          </div>
        </div>

        {/* Footer text */}
        <div className="text-xs text-slate-500 mt-10 pt-4 border-t border-slate-200">
          <p>Last updated: {new Date().toLocaleDateString()}</p>
          <p className="mt-1">SwingSetups is a product of Nolojik Innovations Pvt Ltd</p>
          <p className="mt-1 text-slate-600">CIN: U62090KA2023PTC180927</p>
          <p className="text-slate-600">Registered under the Companies Act, 2013 · Bengaluru, India</p>
        </div>

      </div>
    </div>
  );
}