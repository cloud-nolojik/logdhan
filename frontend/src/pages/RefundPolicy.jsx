import React from 'react';

export default function RefundPolicy() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-4 py-16 bg-gradient-to-br from-[#1e3a8a] to-[#06b6d4]">
      <div className="bg-white/10 border border-gold-light rounded-xl p-8 max-w-4xl w-full shadow-lg">
        <h1 className="text-2xl md:text-3xl font-bold text-white mb-6">Refund Policy</h1>
        
        <div className="text-white/90 space-y-4 text-sm md:text-base">
          <div className="bg-blue-500/20 border border-blue-500/50 rounded-lg p-4 mb-6">
            <p className="text-blue-200 font-semibold">📧 For Refund Requests:</p>
            <p className="text-blue-100 mt-1">Contact <a href="mailto:hello@nolojik.com" className="text-gold-light hover:underline font-semibold">hello@nolojik.com</a> with your phone number and transaction details.</p>
          </div>

          <h2 className="text-lg font-semibold text-gold-light">1. Refund Eligibility</h2>
          <p>Refunds are processed in accordance with Indian consumer protection laws. Credits that have been used (AI reviews consumed) are generally non-refundable. Unused credits may be eligible for refund under specific circumstances.</p>

          <h2 className="text-lg font-semibold text-gold-light">2. Technical Issues</h2>
          <p>If money has been deducted from your account but you have not received credits due to technical issues, please contact us immediately at <a href="mailto:hello@nolojik.com" className="text-gold-light hover:underline font-semibold">hello@nolojik.com</a> with your transaction details.</p>

          <h2 className="text-lg font-semibold text-gold-light">3. Refund Process</h2>
          <p>To request a refund, please provide the following information:</p>
          <ul className="list-disc list-inside ml-4 space-y-1">
            <li>Your registered phone number</li>
            <li>Transaction date and amount</li>
            <li>Payment method used</li>
            <li>Transaction ID or reference number</li>
            <li>Reason for refund request</li>
          </ul>

          <h2 className="text-lg font-semibold text-gold-light">4. Processing Time</h2>
          <p>Approved refunds will be processed within 7-10 business days from the date of approval. Refunds will be credited back to the original payment method used for the transaction.</p>

          <h2 className="text-lg font-semibold text-gold-light">5. Dispute Resolution</h2>
          <p>Any disputes regarding refunds will be resolved in accordance with Indian consumer protection laws and the jurisdiction of Indian courts.</p>

          <h2 className="text-lg font-semibold text-gold-light">6. Contact for Refunds</h2>
          <p>For all refund-related queries, contact us at:</p>
          <div className="bg-white/5 rounded-lg p-3 ml-4">
            <p><strong>Email:</strong> <a href="mailto:hello@nolojik.com" className="text-gold-light hover:underline">hello@nolojik.com</a></p>
            <p className="text-sm text-white/80 mt-1">Include your phone number and transaction details in your email</p>
          </div>
        </div>
        
        <div className="text-xs text-white/60 mt-8 pt-4 border-t border-white/20">
          <p>Last updated: {new Date().toLocaleDateString()}</p>
          <p className="mt-1">LogDhan is a product of Nolojik Innovations</p>
        </div>
      </div>
    </div>
  );
} 