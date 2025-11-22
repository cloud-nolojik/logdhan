import React from "react";
import { motion } from "framer-motion";

export default function PricingPolicy() {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-16 sm:px-6 lg:px-8 relative overflow-hidden">
      {/* soft background, same idea as home/pricing */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_#e0f2fe,_transparent_55%),_radial-gradient(circle_at_bottom,_#f1f5f9,_transparent_60%)]" />

      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="mx-auto max-w-4xl"
      >
        {/* Heading */}
        <h1 className="text-center text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-slate-900 mb-8">
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-emerald-500">
            Pricing Policy
          </span>
        </h1>

        {/* Card */}
        <div className="rounded-2xl bg-white border border-slate-200 shadow-sm p-6 sm:p-8 mb-8 space-y-6 text-sm sm:text-[15px] text-slate-700">
          {/* 1. How pricing works */}
          <section>
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-2">
              1. How SwingSetups pricing works
            </h2>
            <p className="mb-2">
              SwingSetups plans are based on the{" "}
              <strong>maximum number of stocks in your watchlist</strong> and the{" "}
              <strong>billing cycle</strong> (for example, monthly or yearly).
              All plans include the same AI swing analysis – only the watchlist
              capacity and duration change.
            </p>
            <p className="text-slate-600">
              Example: a plan that supports <strong>10 stocks</strong> for{" "}
              <strong>₹X / month</strong> will give you daily analysis for up to
              10 stocks in your watchlist during the active subscription period.
            </p>
          </section>

          {/* 2. Free trial & renewals */}
          <section>
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-2">
              2. Free trial & subscription renewals
            </h2>
            <ul className="list-disc pl-5 space-y-1 text-slate-700">
              <li>
                New users may get a <strong>time-limited free trial</strong>{" "}
                (for example, 30 days with a small watchlist size). Trial
                duration and limits are clearly mentioned on the pricing /
                checkout pages.
              </li>
              <li>
                After the trial ends, you can{" "}
                <strong>upgrade to a paid plan</strong>. We will not start a
                paid subscription without an explicit confirmation from you.
              </li>
              <li>
                Paid plans are usually{" "}
                <strong>auto-renewing</strong> for the selected billing cycle
                (for example, monthly). The renewal date is shown in the app or
                payment receipt.
              </li>
              <li>
                You can <strong>cancel future renewals</strong> at any time
                before the next billing date. After cancellation, your plan will
                remain active until the current period ends.
              </li>
            </ul>
          </section>

          {/* 3. Changes to pricing */}
          <section>
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-2">
              3. Changes to pricing
            </h2>
            <p className="mb-2">
              We may update our plan prices from time to time due to changes in
              infrastructure costs, AI model usage, or new features.
            </p>
            <ul className="list-disc pl-5 space-y-1 text-slate-700">
              <li>
                <strong>Existing active subscriptions</strong> will continue at
                the old price until the end of the current billing period.
              </li>
              <li>
                Any <strong>price change for renewals</strong> will be{" "}
                <strong>communicated in advance</strong> via email / in-app
                notice, where applicable.
              </li>
              <li>
                When you <strong>purchase or upgrade</strong> after a change,
                the new price shown at checkout will apply to that transaction.
              </li>
            </ul>
          </section>

          {/* 4. Refunds & cancellations */}
          <section>
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-2">
              4. Refunds & cancellations
            </h2>
            <p className="mb-2">
              SwingSetups is a{" "}
              <strong>digital, subscription-based educational service</strong>.
              Once a plan is activated and access is granted, we generally{" "}
              <strong>do not provide refunds</strong> for the current billing
              period.
            </p>
            <ul className="list-disc pl-5 space-y-1 text-slate-700">
              <li>
                You can cancel at any time to stop{" "}
                <strong>future auto-renewals</strong>.
              </li>
              <li>
                In rare cases of technical issues (for example, you were charged
                but did not receive access), we will review and assist on a{" "}
                <strong>case-by-case basis</strong>.
              </li>
              <li>
                Any country-specific consumer protection rules will be
                honoured, where applicable.
              </li>
            </ul>
          </section>

          {/* 5. Educational-only note */}
          <section>
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-2">
              5. Educational-only service
            </h2>
            <p className="text-slate-700">
              SwingSetups provides{" "}
              <strong>AI-generated educational analysis</strong> of price
              behaviour. We do not provide investment advice, tips, or portfolio
              management services, and we are{" "}
              <strong>not SEBI-registered</strong>. You are solely responsible
              for your trading and investment decisions.
            </p>
          </section>

          {/* contact */}
          <section>
            <h2 className="text-base sm:text-lg font-semibold text-slate-900 mb-2">
              6. Questions about pricing?
            </h2>
            <p>
              If you have any questions about this pricing policy, please write
              to us at{" "}
              <a
                href="mailto:hello@nolojik.com"
                className="font-semibold text-blue-600 hover:text-blue-700 hover:underline"
              >
                hello@nolojik.com
              </a>
              .
            </p>
          </section>
        </div>

        {/* footer meta */}
        <div className="text-center text-[11px] text-slate-500">
          <p>Last updated: {new Date().toLocaleDateString()}</p>
          <p className="mt-1">
            SwingSetups is a product of Nolojik Innovations Private Limited.
          </p>
        </div>
      </motion.div>
    </div>
  );
}