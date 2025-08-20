import React from 'react';
import { Link } from 'react-router-dom';

export default function PricingCard() {
  return (
    <div className="bg-white/10 border border-gold-light rounded-xl p-8 max-w-md mx-auto shadow-lg flex flex-col items-center">
      <div className="text-2xl font-bold text-gold-light mb-2">Most Popular</div>
      <div className="text-3xl font-bold text-white mb-2">₹99</div>
      <div className="text-lg text-white mb-4">per month • <span className="font-semibold">150 Credits • No Ads</span></div>
      
      <div className="bg-gold-light/20 border border-gold-light rounded-lg p-4 mb-4 w-full">
        <h3 className="text-sm font-bold text-white mb-2 text-center">All Plans (INR)</h3>
        <div className="text-xs text-white/90 space-y-1">
          <div className="flex justify-between">
            <span>Basic Free:</span>
            <span className="font-bold text-green-400">3+1 reviews/day – FREE</span>
          </div>
          <div className="flex justify-between">
            <span>Pro Monthly:</span>
            <span className="font-bold text-blue-400">150 Credits – ₹99</span>
          </div>
          <div className="flex justify-between">
            <span>Pro Annual:</span>
            <span className="font-bold text-purple-400">2000 Credits – ₹999</span>
          </div>
          <div className="text-center mt-2 text-green-400 text-xs">
            <span>✨ Ad-supported free plan with upgrade options</span>
          </div>
        </div>
      </div>
      
      <ul className="text-white/90 mb-6 text-sm list-disc list-inside">
        <li>Unlimited free trade logging</li>
        <li>Start with Basic Free: 3+1 daily AI reviews</li>
        <li>Pro plans offer unlimited access without ads</li>
        <li>Credit rollover up to 50% (Pro plans)</li>
        <li>Cancel anytime</li>
      </ul>
      <Link to="/pricing">
        <button className="bg-gold-light hover:bg-gold text-primary font-bold px-8 py-3 rounded-lg shadow-lg transition text-lg">View All Plans</button>
      </Link>
      <div className="mt-4 text-xs text-white/70">Contact: <a href="mailto:hello@nolojik.com" className="text-gold-light hover:underline">hello@nolojik.com</a></div>
    </div>
  );
} 