import React from 'react';

export default function PrivacyPolicy() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-4 py-16 bg-gradient-to-br from-[#1e3a8a] to-[#06b6d4]">
      <div className="bg-white/10 border border-gold-light rounded-xl p-8 max-w-4xl w-full shadow-lg">
        <h1 className="text-2xl md:text-3xl font-bold text-white mb-6">Privacy Policy</h1>
        
        <div className="text-white/90 space-y-4 text-sm md:text-base">
          <div className="bg-yellow-500/20 border border-yellow-500/50 rounded-lg p-4 mb-6">
            <p className="text-yellow-200 font-semibold">⚠️ Important Notice:</p>
            <p className="text-yellow-100 mt-1">LogDhan AI reviews can make mistakes and should not be considered as financial advice. Always verify information independently before making investment decisions.</p>
          </div>

          <h2 className="text-lg font-semibold text-gold-light">1. Data Collection and Processing</h2>
          <p>LogDhan collects and processes data in accordance with Indian data protection laws. We collect trading queries, user preferences, and usage patterns to provide AI-powered trading insights. All data is processed securely and stored with encryption.</p>

          <h2 className="text-lg font-semibold text-gold-light">2. AI Data Usage</h2>
          <p>Your trading queries and interactions are processed by our AI systems to generate personalized insights. We do not share your personal trading data with third parties. However, anonymized and aggregated data may be used to improve our AI models.</p>

          <h2 className="text-lg font-semibold text-gold-light">3. Credit System</h2>
          <p>Our credit-based system (1 AI review = 1 credit) tracks your usage for billing purposes. Payment and credit information is processed securely through approved payment gateways in compliance with Indian payment regulations.</p>

          <h2 className="text-lg font-semibold text-gold-light">4. Data Retention</h2>
          <p>We retain your data only as long as necessary to provide our services or as required by Indian law. You may request data deletion by contacting us, subject to legal obligations.</p>

          <h2 className="text-lg font-semibold text-gold-light">5. Data Security</h2>
          <p>We implement industry-standard security measures to protect your data. However, no system is 100% secure, and we cannot guarantee absolute security of your information.</p>

          <h2 className="text-lg font-semibold text-gold-light">6. Your Rights</h2>
          <p>Under Indian data protection laws, you have rights to access, correct, and delete your personal data. Contact us to exercise these rights.</p>

          <h2 className="text-lg font-semibold text-gold-light">7. Contact Information</h2>
          <p>For privacy-related questions or to exercise your data rights, contact us at <a href="mailto:hello@nolojik.com" className="text-gold-light hover:underline font-semibold">hello@nolojik.com</a>.</p>
        </div>
        
        <div className="text-xs text-white/60 mt-8 pt-4 border-t border-white/20">
          <p>Last updated: {new Date().toLocaleDateString()}</p>
          <p className="mt-1">LogDhan is a product of Nolojik Innovations</p>
        </div>
      </div>
    </div>
  );
} 