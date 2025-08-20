import React from 'react';

export default function Terms() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-4 py-16 bg-gradient-to-br from-[#1e3a8a] to-[#06b6d4]">
      <div className="bg-white/10 border border-gold-light rounded-xl p-8 max-w-4xl w-full shadow-lg">
        <h1 className="text-2xl md:text-3xl font-bold text-white mb-6">Terms of Service</h1>
        
        <div className="text-white/90 space-y-4 text-sm md:text-base">
          <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-4 mb-6">
            <p className="text-red-200 font-semibold">⚠️ Important Disclaimer:</p>
            <p className="text-red-100 mt-1">LogDhan AI reviews can make mistakes and should not be considered as financial advice. Always consult with qualified financial advisors and verify information independently before making investment decisions.</p>
          </div>

          <h2 className="text-lg font-semibold text-gold-light">1. Service Description</h2>
          <p>LogDhan is an AI-powered trading assistant that provides insights and analysis for investment decisions. This service is provided by Nolojik Innovations Private Limited and operates on a credit-based system where 1 AI review equals 1 credit.</p>

          <h2 className="text-lg font-semibold text-gold-light">2. User Responsibilities</h2>
          <p>By using LogDhan, you agree to use the service responsibly and acknowledge that all AI-generated content is for informational purposes only. You are solely responsible for your investment decisions and any consequences thereof.</p>

          <h2 className="text-lg font-semibold text-gold-light">3. Credit System and Billing</h2>
          <p>LogDhan operates on a prepaid credit system. Credits are consumed when you request AI reviews (1 review = 1 credit). All purchases are subject to our refund policy and Indian payment regulations.</p>

          <h2 className="text-lg font-semibold text-gold-light">4. Limitation of Liability</h2>
          <p>Nolojik Innovations Private Limited and LogDhan shall not be liable for any financial losses, damages, or consequences arising from the use of AI-generated trading insights. Users trade at their own risk.</p>

          <h2 className="text-lg font-semibold text-gold-light">5. Intellectual Property</h2>
          <p>LogDhan and all related technologies are proprietary to Nolojik Innovations Private Limited. Users may not reproduce, distribute, or create derivative works without explicit permission.</p>

          <h2 className="text-lg font-semibold text-gold-light">6. Service Availability</h2>
          <p>We strive to maintain service availability but do not guarantee uninterrupted access. Scheduled maintenance and technical issues may temporarily affect service.</p>

          <h2 className="text-lg font-semibold text-gold-light">7. Governing Law</h2>
          <p>These terms are governed by Indian law. Any disputes shall be resolved in accordance with Indian legal procedures and jurisdiction.</p>

          <h2 className="text-lg font-semibold text-gold-light">8. Contact Information</h2>
          <p>For questions about these terms, contact us at <a href="mailto:hello@nolojik.com" className="text-gold-light hover:underline font-semibold">hello@nolojik.com</a>.</p>
        </div>
        
        <div className="text-xs text-white/60 mt-8 pt-4 border-t border-white/20">
          <p>Last updated: {new Date().toLocaleDateString()}</p>
          <p className="mt-1">LogDhan is a product of Nolojik Innovations Private Limited</p>
          <p className="mt-1">Legal Name: Nolojik Innovations Private Limited (CIN: U62090KA2023PTC180927)</p>
          <p>Registered under the Companies Act, 2013 | Headquartered in Bengaluru, India</p>
        </div>
      </div>
    </div>
  );
} 