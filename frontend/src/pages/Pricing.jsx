import React from 'react';
import { Link } from 'react-router-dom';
import { useCreditInfo } from '../hooks/useCreditInfo';

export default function Pricing() {
  const { creditInfo, loading } = useCreditInfo();
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-4 py-16 bg-gradient-to-br from-[#1e3a8a] to-[#06b6d4]">
      <h1 className="text-2xl md:text-3xl font-bold text-white mb-4">Choose Your Subscription Plan</h1>
      
      <div className="max-w-4xl w-full mb-8">
        <div className="bg-white/10 border border-gold-light rounded-xl p-6 text-center mb-8">
          <p className="text-white/90 text-lg mb-4">
            <span className="text-gold-light font-semibold">Unlimited free logging</span> of your trade plans. 
            AI reviews consume credits based on your subscription plan. 
            <span className="text-green-400 font-semibold">Start FREE with unlimited AI reviews by watching short ads!</span>
          </p>
        </div>

        {/* Pricing Table */}
        <div className="bg-white/10 border border-gold-light rounded-xl p-6 overflow-x-auto">
          <table className="w-full text-white">
            <thead>
              <tr className="border-b border-white/20">
                <th className="text-left py-3 px-4 font-bold text-gold-light">Plan</th>
                <th className="text-center py-3 px-4 font-bold text-gold-light">Credits</th>
                <th className="text-center py-3 px-4 font-bold text-gold-light">₹ / Credit</th>
                <th className="text-center py-3 px-4 font-bold text-gold-light">Price (₹)</th>
                <th className="text-center py-3 px-4 font-bold text-gold-light">Billing</th>
                <th className="text-center py-3 px-4 font-bold text-gold-light">Action</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-white/10 bg-green-500/10">
                <td className="py-3 px-4 font-semibold">
                  Basic Free
                  <div className="text-xs text-white/70 mt-1">Ad-supported • Unlimited reviews</div>
                </td>
                <td className="text-center py-3 px-4">
                  ∞
                  <div className="text-xs text-white/70">Watch ads</div>
                </td>
                <td className="text-center py-3 px-4">—</td>
                <td className="text-center py-3 px-4 font-bold text-green-400">FREE</td>
                <td className="text-center py-3 px-4">Lifetime</td>
                <td className="text-center py-3 px-4">
                  <button className="bg-green-500 hover:bg-green-600 text-white font-bold px-4 py-2 rounded-lg text-sm transition">
                    Continue Free
                  </button>
                </td>
              </tr>
              <tr className="border-b border-white/10 bg-blue-500/10">
                <td className="py-3 px-4 font-semibold">
                  Pro Monthly
                  <span className="text-xs bg-blue-500 text-white px-2 py-1 rounded ml-2">Popular</span>
                  <div className="text-xs text-white/70 mt-1">No ads • Full AI access • All features</div>
                </td>
                <td className="text-center py-3 px-4">150</td>
                <td className="text-center py-3 px-4">0.66</td>
                <td className="text-center py-3 px-4 font-bold text-gold-light">99</td>
                <td className="text-center py-3 px-4">Monthly</td>
                <td className="text-center py-3 px-4">
                  <button className="bg-blue-500 hover:bg-blue-600 text-white font-bold px-4 py-2 rounded-lg text-sm transition">
                    Subscribe Monthly – ₹99
                  </button>
                </td>
              </tr>
              <tr className="border-b border-white/10 bg-purple-500/10">
                <td className="py-3 px-4 font-semibold">
                  Pro Annual
                  <span className="text-xs bg-purple-500 text-white px-2 py-1 rounded ml-2">Best Value</span>
                  <div className="text-xs text-white/70 mt-1">No ads • Full AI access • Save ₹189</div>
                </td>
                <td className="text-center py-3 px-4">
                  2000
                  <div className="text-xs text-white/70">~167/month</div>
                </td>
                <td className="text-center py-3 px-4">0.50</td>
                <td className="text-center py-3 px-4 font-bold text-gold-light">999</td>
                <td className="text-center py-3 px-4">Yearly</td>
                <td className="text-center py-3 px-4">
                  <button className="bg-purple-500 hover:bg-purple-600 text-white font-bold px-4 py-2 rounded-lg text-sm transition">
                    Subscribe Yearly – ₹999
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Ad-Supported Model Explanation */}
        <div className="bg-gradient-to-r from-green-500/10 to-blue-500/10 border border-green-500/20 rounded-xl p-6 mt-6">
          <h3 className="text-xl font-bold text-center text-green-400 mb-4">How Our Ad-Supported Free Plan Works</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="space-y-3">
              <div className="flex items-start">
                <div className="w-6 h-6 bg-green-500/20 rounded-full flex items-center justify-center mr-3 mt-0.5">
                  <span className="text-green-400 font-bold text-xs">∞</span>
                </div>
                <div>
                  <p className="font-semibold text-white">Unlimited AI Reviews</p>
                  <p className="text-white/70">Get unlimited comprehensive AI trade reviews with short ads.</p>
                </div>
              </div>
              <div className="flex items-start">
                <div className="w-6 h-6 bg-blue-500/20 rounded-full flex items-center justify-center mr-3 mt-0.5">
                  <span className="text-blue-400 font-bold text-xs">📺</span>
                </div>
                <div>
                  <p className="font-semibold text-white">Ad-Supported Model</p>
                  <p className="text-white/70">Simple: Watch ad → Get AI review. Repeat unlimited times.</p>
                </div>
              </div>
            </div>
            <div className="space-y-3">
              <div className="flex items-start">
                <div className="w-6 h-6 bg-purple-500/20 rounded-full flex items-center justify-center mr-3 mt-0.5">
                  <span className="text-purple-400 font-bold text-xs">📱</span>
                </div>
                <div>
                  <p className="font-semibold text-white">Non-Intrusive Ads</p>
                  <p className="text-white/70">Small banner ads and optional rewarded videos. No interruptions.</p>
                </div>
              </div>
              <div className="flex items-start">
                <div className="w-6 h-6 bg-orange-500/20 rounded-full flex items-center justify-center mr-3 mt-0.5">
                  <span className="text-orange-400 font-bold text-xs">⚡</span>
                </div>
                <div>
                  <p className="font-semibold text-white">Always Upgrade</p>
                  <p className="text-white/70">Need more reviews? Upgrade to Pro anytime for ad-free experience.</p>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-4 p-3 bg-gradient-to-r from-green-600/20 to-blue-600/20 rounded-lg text-center">
            <p className="text-green-400 font-semibold text-sm">💡 Pro Tip: Basic Free gives you unlimited AI reviews with ads - analyze as many trades as you want!</p>
          </div>
        </div>

        <div className="text-center mt-6">
          <p className="text-white/70 text-sm">
            <strong>Note:</strong> Subscriptions renew automatically. Cancel anytime. Secure payments by Cashfree. *All prices include GST.
          </p>
        </div>
      </div>

      <div className="mt-8 text-white/80 text-center text-sm max-w-md space-y-2">
        <p><span className="text-gold-light font-semibold">Basic Free:</span> Lifetime access with unlimited reviews by watching ads.</p>
        <p><span className="text-gold-light font-semibold">Pro Monthly:</span> 150 credits/month with ad-free experience.</p>
        <p><span className="text-gold-light font-semibold">Pro Annual:</span> 2000 credits/year with maximum value and savings.</p>
        <p>
          <Link to="/pricing-policy" className="text-gold-light hover:underline font-semibold">
            📋 View Pricing Policy
          </Link>
        </p>
        <p>Contact: <a href="mailto:hello@nolojik.com" className="text-gold-light hover:underline">hello@nolojik.com</a></p>
      </div>
    </div>
  );
} 