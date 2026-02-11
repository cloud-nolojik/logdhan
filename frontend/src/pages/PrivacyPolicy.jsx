import React from 'react';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-4 py-16 bg-main-gradient">
      <div className="max-w-4xl w-full bg-slate-900/70 border border-slate-700/60 rounded-2xl p-8 md:p-10 shadow-2xl backdrop-blur-lg">
        <h1 className="text-3xl md:text-4xl font-bold text-white mb-6">
          <span className="text-transparent bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text">
            Privacy Policy
          </span>
        </h1>

        {/* Important notice */}
        <div className="bg-amber-900/30 border border-amber-500/50 rounded-xl p-4 mb-8">
          <p className="text-amber-200 font-semibold">⚠️ Important:</p>
          <p className="text-amber-100 text-sm mt-1">
            SwingSetups provides AI-generated educational analysis of price behaviour. 
            It does not give stock tips or investment advice. Please use your own judgement 
            and consult a registered advisor if needed.
          </p>
        </div>

        <div className="text-slate-100 space-y-5 text-sm md:text-base leading-relaxed">
          <p className="text-slate-300">
            This Privacy Policy explains how <span className="font-semibold">SwingSetups</span> (a product of Nolojik Innovations)
            collects, uses, and protects your information when you use our mobile app and website.
          </p>

          {/* 1. Data we collect */}
          <div>
            <h2 className="text-lg font-semibold text-blue-300 mb-1">
              1. Data we collect
            </h2>
            <p className="text-slate-300 mb-2">
              We collect only the information needed to run the service and improve it over time. This may include:
            </p>
            <ul className="list-disc list-inside space-y-1 text-slate-300 text-sm md:text-base">
              <li>
                <span className="font-semibold">Account details:</span> your name, email address, and basic profile information.
              </li>
              <li>
                <span className="font-semibold">Usage data:</span> which features you use, your watchlist stocks,
                when you open the app, and how often you view analyses.
              </li>
              <li>
                <span className="font-semibold">Device information:</span> device type, operating system, app version, and basic technical logs.
              </li>
              <li>
                <span className="font-semibold">Ad interaction data:</span> ad views, completion status, and daily usage tracking
                (stocks added per day for fair usage tracking).
              </li>
            </ul>
          </div>

          {/* 2. How we use your data */}
          <div>
            <h2 className="text-lg font-semibold text-blue-300 mb-1">
              2. How we use your data
            </h2>
            <p className="text-slate-300 mb-2">
              We use your information to:
            </p>
            <ul className="list-disc list-inside space-y-1 text-slate-300 text-sm md:text-base">
              <li>Generate daily AI-based swing analysis for the stocks in your watchlist.</li>
              <li>Show you relevant content, explanations, and alerts inside the app.</li>
              <li>Serve relevant advertisements and enforce fair usage limits.</li>
              <li>Monitor performance, fix bugs, and improve the overall product.</li>
              <li>Communicate important updates, service changes, or policy changes.</li>
            </ul>
          </div>

          {/* 3. What we do NOT do */}
          <div>
            <h2 className="text-lg font-semibold text-blue-300 mb-1">
              3. What we do <span className="underline underline-offset-2">not</span> do
            </h2>
            <ul className="list-disc list-inside space-y-1 text-slate-300 text-sm md:text-base">
              <li>We do <span className="font-semibold">not</span> connect to your broker account.</li>
              <li>We do <span className="font-semibold">not</span> place any trades or handle your money.</li>
              <li>We do <span className="font-semibold">not</span> sell your personal data to third parties.</li>
              <li>We do <span className="font-semibold">not</span> share your personal watchlist with advertisers.</li>
            </ul>
          </div>

          {/* 4. Data sharing */}
          <div>
            <h2 className="text-lg font-semibold text-blue-300 mb-1">
              4. Data sharing
            </h2>
            <p className="text-slate-300 mb-2">
              We may share limited data with trusted service providers who help us run SwingSetups, such as:
            </p>
            <ul className="list-disc list-inside space-y-1 text-slate-300 text-sm md:text-base">
              <li>Cloud hosting providers (for servers and databases).</li>
              <li>Ad network providers (Google AdMob) for serving advertisements.</li>
              <li>Analytics tools (to understand app performance and usage patterns).</li>
            </ul>
            <p className="text-slate-300 mt-2">
              These providers are required to protect your data and use it only for providing services to us.
            </p>
          </div>

          {/* 5. Storage & security */}
          <div>
            <h2 className="text-lg font-semibold text-blue-300 mb-1">
              5. Data storage and security
            </h2>
            <p className="text-slate-300">
              We use industry-standard security practices to protect your information, including encryption in transit 
              and restricted access controls. However, no system is 100% secure, and we cannot guarantee absolute security 
              of data transmitted over the internet.
            </p>
          </div>

          {/* 6. Data retention */}
          <div>
            <h2 className="text-lg font-semibold text-blue-300 mb-1">
              6. Data retention
            </h2>
            <p className="text-slate-300">
              We retain your data for as long as your account is active or as needed to provide the service, comply with
              legal obligations, resolve disputes, or enforce our agreements. If you close your account, we may retain 
              some records as required by law or for legitimate business purposes.
            </p>
          </div>

          {/* 7. Your choices & rights */}
          <div>
            <h2 className="text-lg font-semibold text-blue-300 mb-1">
              7. Your choices and rights
            </h2>
            <p className="text-slate-300 mb-2">
              You can:
            </p>
            <ul className="list-disc list-inside space-y-1 text-slate-300 text-sm md:text-base">
              <li>Update your basic account details from within the app (where available).</li>
              <li>Change your watchlist at any time.</li>
              <li>Request clarification about how your data is used.</li>
              <li>Request deletion of your account and associated personal data, subject to legal requirements.</li>
            </ul>
            <p className="text-slate-300 mt-2">
              To exercise these rights, please write to us at{' '}
              <a
                href="mailto:contact-swingsetups@nolojik.com"
                className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2 font-semibold"
              >
                contact-swingsetups@nolojik.com
              </a>.
            </p>
          </div>

          {/* 8. Changes to this policy */}
          <div>
            <h2 className="text-lg font-semibold text-blue-300 mb-1">
              8. Changes to this policy
            </h2>
            <p className="text-slate-300">
              We may update this Privacy Policy from time to time as our product or legal requirements change.
              When we make significant changes, we will update the “Last updated” date below and may notify you 
              inside the app or by email.
            </p>
          </div>

          {/* 9. Contact */}
          <div>
            <h2 className="text-lg font-semibold text-blue-300 mb-1">
              9. Contact us
            </h2>
            <p className="text-slate-300">
              For any questions about this Privacy Policy or how we handle your data, please contact:
            </p>
            <p className="text-slate-200 mt-2">
              <span className="font-semibold">Nolojik Innovations Pvt Ltd</span><br />
              Email:{' '}
              <a
                href="mailto:contact-swingsetups@nolojik.com"
                className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2 font-semibold"
              >
                contact-swingsetups@nolojik.com
              </a>
            </p>
          </div>
        </div>

        <div className="text-xs text-slate-400 mt-8 pt-4 border-t border-slate-700/60">
          <p>Last updated: {new Date().toLocaleDateString()}</p>
          <p className="mt-1">SwingSetups is a product of Nolojik Innovations</p>
        </div>
      </div>
    </div>
  );
}