import React from 'react';

export default function RefundPolicy() {
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-16 sm:px-6 lg:px-8">
      {/* subtle background gradient */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_#e0f2fe,_transparent_55%),_radial-gradient(circle_at_bottom,_#f1f5f9,_transparent_60%)]" />

      <div className="mx-auto max-w-4xl bg-white rounded-3xl border border-slate-100 shadow-sm p-8 md:p-10">
        
        <h1 className="text-3xl md:text-4xl font-bold text-slate-900 mb-6">
          <span className="text-transparent bg-gradient-to-r from-blue-600 to-emerald-500 bg-clip-text">
            Refund Policy
          </span>
        </h1>

        <div className="text-slate-700 space-y-6 text-sm md:text-base leading-relaxed">

          {/* Contact box */}
          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4">
            <p className="text-blue-700 font-semibold">📩 For Refund Requests</p>
            <p className="text-blue-600 text-sm mt-1">
              Email us at{" "}
              <a href="mailto:hello@nolojik.com" className="text-emerald-600 hover:text-blue-600 hover:underline transition font-semibold">
                hello@nolojik.com
              </a>{" "}
              with your registered mobile number and transaction details.
            </p>
          </div>

          {/* 1. Eligibility */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">1. Refund Eligibility</h2>
            <p className="text-slate-600">
              We follow transparent, fair-use refund policies aligned with Indian consumer protection laws.
              Subscription payments are generally non-refundable once the plan is active, especially if daily analyses
              have already been generated for your watchlist.
            </p>
            <p className="text-slate-600 mt-2">
              If you believe you were charged incorrectly or did not receive expected access, you may request a case-based review.
            </p>
          </div>

          {/* 2. Billing issues */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">2. Technical or Billing Issues</h2>
            <p className="text-slate-600">
              If money was deducted but your subscription did not activate due to a technical issue, please contact us with your payment
              reference. After verification, refunds or manual activation will be processed as appropriate.
            </p>
          </div>

          {/* 3. How to request */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">3. How to Request a Refund</h2>
            <p className="text-slate-600">Include the following details in your email:</p>
            <ul className="list-disc list-inside space-y-1 text-slate-600 mt-2">
              <li>Your registered phone number</li>
              <li>Transaction date & amount</li>
              <li>Payment method (UPI / Card / NetBanking)</li>
              <li>Transaction or UTR reference number</li>
              <li>Reason for refund request</li>
            </ul>
          </div>

          {/* 4. Processing time */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">4. Processing Time</h2>
            <p className="text-slate-600">
              Approved refunds are processed within **7–10 business days** and credited back to the original payment method.
            </p>
          </div>

          {/* 5. Disputes */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">5. Dispute Resolution</h2>
            <p className="text-slate-600">
              Refund-related disputes will be resolved under applicable Indian laws and jurisdiction.
            </p>
          </div>

          {/* 6. Contact */}
          <div>
            <h2 className="text-lg font-semibold text-slate-900 mb-1">6. Support Contact</h2>
            <div className="bg-slate-50 rounded-2xl p-4 border border-slate-200">
              <p className="text-slate-700"><strong>Email:</strong> <a className="text-blue-600 hover:text-emerald-500 hover:underline transition" href="mailto:hello@nolojik.com">hello@nolojik.com</a></p>
              <p className="text-xs text-slate-500 mt-2">Include registered phone number + transaction details</p>
            </div>
          </div>

        </div>

        <div className="text-xs text-slate-500 mt-10 pt-4 border-t border-slate-200">
          <p>Last updated: {new Date().toLocaleDateString()}</p>
          <p className="mt-1">SwingSetups is a product of Nolojik Innovations Pvt Ltd</p>
        </div>
      </div>
    </div>
  );
}