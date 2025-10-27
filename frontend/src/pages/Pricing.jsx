import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

export default function Pricing() {
  const [pricingPlans, setPricingPlans] = useState([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState(null);

  useEffect(() => {
    const fetchPlans = async () => {
      try {
        setPlansLoading(true);
        const response = await fetch('https://logdhan.com/api/public/plans');
        if (!response.ok) {
          throw new Error('Failed to fetch plans');
        }
        const data = await response.json();
        
        if (data.success && Array.isArray(data.data)) {
          setPricingPlans(data.data);
        } else {
          throw new Error('Invalid data format');
        }
      } catch (err) {
        console.error('Error fetching plans:', err);
        setPlansError(err.message);
        setPricingPlans([]);
      } finally {
        setPlansLoading(false);
      }
    };

    fetchPlans();
  }, []);

  // Helper function to format plan data for the cards
  const formatPlanForCard = (plan) => {
    const isTrial = plan.type === 'TRIAL';
    return {
      name: plan.name,
      stockLimit: plan.stockLimit,
      price: isTrial ? 'FREE' : `₹${plan.price}`,
      billing: plan.billingCycle === 'MONTHLY' ? 'per month' : plan.billingCycle === 'ANNUALLY' ? 'per year' : '1 Month Trial',
      features: plan.features,
      popular: plan.isPopular,
      isBestValue: plan.isBestValue,
      buttonText: isTrial ? '🎯 Start Free Trial' : plan.isPopular ? '💳 Subscribe Now' : plan.isBestValue ? '💰 Subscribe Now' : '🚀 Subscribe Now',
      buttonClass: isTrial ? 'bg-emerald-500 hover:bg-emerald-400' : plan.isPopular ? 'bg-blue-500 hover:bg-blue-400' : plan.isBestValue ? 'bg-amber-500 hover:bg-amber-400' : 'bg-purple-500 hover:bg-purple-400',
      cardClass: isTrial ? 'from-emerald-500/30 to-green-600/40 border-emerald-400/50' : plan.isPopular ? 'from-blue-500/30 to-indigo-600/40 border-blue-400/50' : plan.isBestValue ? 'from-amber-500/30 to-orange-600/40 border-amber-400/50' : 'from-purple-500/30 to-violet-600/40 border-purple-400/50',
      badge: isTrial ? '🎁 FREE' : plan.isPopular ? '⭐ Popular' : plan.isBestValue ? '💎 Best Value' : '🔥 Advanced',
      badgeClass: isTrial ? 'bg-emerald-400 text-emerald-900' : plan.isPopular ? 'bg-blue-400 text-blue-900' : plan.isBestValue ? 'bg-amber-400 text-amber-900' : 'bg-purple-400 text-purple-900',
      textColor: isTrial ? 'text-emerald-300' : plan.isPopular ? 'text-blue-300' : plan.isBestValue ? 'text-amber-300' : 'text-purple-300',
      textColorLight: isTrial ? 'text-emerald-200' : plan.isPopular ? 'text-blue-200' : plan.isBestValue ? 'text-amber-200' : 'text-purple-200',
      emoji: isTrial ? '🚀' : plan.isPopular ? '📈' : plan.isBestValue ? '👑' : '🎯'
    };
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-20 bg-gradient-to-br from-slate-900 via-blue-900 to-indigo-900 relative overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0 opacity-20">
        <div className="absolute top-20 left-10 w-72 h-72 bg-violet-500 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-20 right-10 w-96 h-96 bg-cyan-500 rounded-full blur-3xl animate-pulse delay-1000"></div>
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-purple-500 rounded-full blur-3xl animate-pulse delay-500"></div>
      </div>
      
      <div className="relative z-10 text-center mb-12">
        <div className="text-6xl mb-6">💰</div>
        <h1 className="text-4xl md:text-6xl font-black text-white mb-4 bg-gradient-to-r from-white via-blue-100 to-cyan-100 bg-clip-text text-transparent">AI Swing Strategy Plans</h1>
        <p className="text-xl md:text-2xl text-blue-100 max-w-3xl mx-auto">Choose the perfect plan to learn AI-powered swing trading</p>
      </div>
      
      <div className="max-w-4xl w-full mb-8">
        <div className="bg-gradient-to-br from-emerald-500/20 to-blue-500/30 backdrop-blur-sm border border-emerald-400/50 rounded-3xl p-8 text-center mb-12 shadow-2xl hover:shadow-emerald-500/20 transition-all duration-300">
          <div className="text-4xl mb-4">🎆</div>
          <p className="text-white/90 text-xl mb-6">
            <span className="text-emerald-300 font-black text-2xl">AI swing setups + WhatsApp alerts</span> for educational learning.
          </p>
          <div className="bg-gradient-to-r from-green-400 to-emerald-500 text-white font-black px-8 py-3 rounded-2xl inline-block text-xl mb-4 shadow-lg transform hover:scale-105 transition-all duration-300">
            🎁 Start with 1-month FREE trial!
          </div>
          <div className="bg-red-500/30 border border-red-400/50 rounded-2xl px-6 py-3 inline-flex items-center backdrop-blur-sm">
            <span className="text-red-200 text-sm font-semibold">⚠️ NOT SEBI-REGISTERED • EDUCATIONAL ONLY</span>
          </div>
        </div>

        {/* Pricing Cards */}
        {plansLoading ? (
          <div className="text-center py-12 mb-12">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-white mb-4"></div>
            <p className="text-white/70">Loading pricing plans...</p>
          </div>
        ) : pricingPlans.length > 0 ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8 mb-12">
            {pricingPlans.map((plan, index) => {
              const cardData = formatPlanForCard(plan);
              return (
                <div key={index} className={`bg-gradient-to-br ${cardData.cardClass} backdrop-blur-sm border-2 rounded-3xl p-8 text-center shadow-2xl hover:shadow-${cardData.textColor.split('-')[1]}-500/30 transition-all duration-300 transform hover:scale-105 relative overflow-hidden`}>
                  <div className={`absolute top-4 right-4 ${cardData.badgeClass} px-3 py-1 rounded-full text-xs font-black`}>
                    {cardData.badge}
                  </div>
                  <div className="text-4xl mb-4">{cardData.emoji}</div>
                  <h3 className="text-2xl font-black text-white mb-2">{cardData.name}</h3>
                  <p className={`${cardData.textColorLight} text-sm mb-4`}>
                    {plan.type === 'TRIAL' ? 'Perfect for getting started' : 
                     plan.isPopular ? 'Most popular choice' : 
                     plan.isBestValue ? 'Maximum capacity' : 'For serious traders'}
                  </p>
                  <div className="text-center mb-6">
                    <div className={`text-4xl font-black ${cardData.textColor}`}>{cardData.price}</div>
                    <div className={`${cardData.textColorLight} text-sm`}>{cardData.billing}</div>
                  </div>
                  <div className="space-y-3 mb-8">
                    <div className="flex items-center justify-center gap-2 text-white">
                      <span className={`${cardData.textColor} text-xl font-black`}>{cardData.stockLimit}</span>
                      <span className="text-sm">stocks watchlist</span>
                    </div>
                    {cardData.features.slice(0, 2).map((feature, idx) => (
                      <div key={idx} className={`flex items-center justify-center gap-2 ${cardData.textColorLight} text-sm`}>
                        <span>✅</span> {feature}
                      </div>
                    ))}
                  </div>
                  <button className={`w-full ${cardData.buttonClass} text-white font-black px-6 py-4 rounded-2xl transition-all duration-300 transform hover:scale-105 shadow-lg`}>
                    {cardData.buttonText}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        {/* Plan Features Explanation - Always show regardless of API status */}
        <div className="bg-gradient-to-br from-slate-800/40 to-slate-900/60 backdrop-blur-sm border border-slate-600/50 rounded-3xl p-8 md:p-12 shadow-2xl">
          <div className="text-6xl mb-6 text-center">⚡</div>
          <h3 className="text-3xl md:text-4xl font-black text-white mb-8 text-center bg-gradient-to-r from-slate-200 to-white bg-clip-text text-transparent">AI Swing Strategy Features</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-6">
              <div className="bg-gradient-to-br from-emerald-500/20 to-green-600/30 backdrop-blur-sm rounded-2xl p-6 border border-emerald-400/30 hover:bg-emerald-500/30 transition-all duration-300 transform hover:scale-105">
                <div className="text-4xl mb-4 text-center">⚡</div>
                <h4 className="font-black text-white text-xl mb-3 text-center">AI Swing Setups</h4>
                <p className="text-emerald-200 text-center">Entry, SL, targets, R:R, expiry window, AI confidence - same for all plans.</p>
              </div>
              <div className="bg-gradient-to-br from-blue-500/20 to-indigo-600/30 backdrop-blur-sm rounded-2xl p-6 border border-blue-400/30 hover:bg-blue-500/30 transition-all duration-300 transform hover:scale-105">
                <div className="text-4xl mb-4 text-center">📱</div>
                <h4 className="font-black text-white text-xl mb-3 text-center">WhatsApp Alerts</h4>
                <p className="text-blue-200 text-center">Setup → Confirmation → Manage → Expiry alerts for all plans.</p>
              </div>
            </div>
            <div className="space-y-6">
              <div className="bg-gradient-to-br from-purple-500/20 to-violet-600/30 backdrop-blur-sm rounded-2xl p-6 border border-purple-400/30 hover:bg-purple-500/30 transition-all duration-300 transform hover:scale-105">
                <div className="text-4xl mb-4 text-center">📊</div>
                <h4 className="font-black text-white text-xl mb-3 text-center">Watchlist Capacity</h4>
                <p className="text-purple-200 text-center">Only difference: 3, 10, 20, or 30 stocks depending on your plan.</p>
              </div>
              <div className="bg-gradient-to-br from-orange-500/20 to-red-600/30 backdrop-blur-sm rounded-2xl p-6 border border-orange-400/30 hover:bg-orange-500/30 transition-all duration-300 transform hover:scale-105">
                <div className="text-4xl mb-4 text-center">🎯</div>
                <h4 className="font-black text-white text-xl mb-3 text-center">Cash Market Focus</h4>
                <p className="text-orange-200 text-center">Short-term swing setups for cash market stocks (educational only).</p>
              </div>
            </div>
          </div>
          <div className="mt-8 p-6 bg-gradient-to-r from-emerald-500/30 to-cyan-500/30 backdrop-blur-sm rounded-2xl text-center border border-emerald-400/50 shadow-lg">
            <div className="text-3xl mb-3">💡</div>
            <p className="text-emerald-200 font-black text-lg">🎆 Pro Tip: Start with FREE trial to explore AI swing setups + WhatsApp alerts!</p>
          </div>
        </div>

        <div className="text-center mt-8">
          <div className="bg-slate-800/50 backdrop-blur-sm rounded-2xl p-6 border border-slate-600/30">
            <p className="text-slate-300 text-sm leading-relaxed">
              <strong className="text-white">ℹ️ Note:</strong> Subscriptions renew automatically. Cancel anytime. Secure payments by Cashfree. *All prices include GST.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-12 relative z-10">
        <div className="bg-gradient-to-br from-violet-500/20 via-blue-500/20 to-cyan-500/30 backdrop-blur-sm border border-violet-400/50 rounded-3xl p-8 shadow-2xl">
          <div className="text-4xl mb-6 text-center">📋</div>
          <h3 className="text-2xl font-black text-white mb-6 text-center">Quick Plan Summary</h3>
          {pricingPlans.length > 0 ? (
            <div className="grid md:grid-cols-2 gap-4 text-center max-w-3xl mx-auto">
              {pricingPlans.map((plan, index) => {
                const cardData = formatPlanForCard(plan);
                const isTrial = plan.type === 'TRIAL';
                return (
                  <div key={index} className={`${isTrial ? 'bg-emerald-500/20 border-emerald-400/30' : plan.isPopular ? 'bg-blue-500/20 border-blue-400/30' : plan.isBestValue ? 'bg-amber-500/20 border-amber-400/30' : 'bg-purple-500/20 border-purple-400/30'} rounded-2xl p-4 border`}>
                    <p className={`${cardData.textColor} font-black`}>
                      {isTrial ? '🎁 Trial:' : `${cardData.emoji} ${plan.name} (${cardData.price}):`}
                    </p>
                    <p className="text-white text-sm">
                      {isTrial ? `1-month free with ${plan.stockLimit} stocks + AI swing setups + WhatsApp alerts` : `${plan.stockLimit} stocks watchlist - same AI swing features`}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center text-white/70">
              <p>Plan information will be displayed here once loaded.</p>
            </div>
          )}
          <div className="mt-8 text-center space-y-4">
            <Link to="/pricing-policy" className="inline-block bg-slate-700/50 hover:bg-slate-600/50 text-cyan-300 hover:text-cyan-200 font-black px-6 py-3 rounded-2xl transition-all duration-300 transform hover:scale-105 border border-slate-600/50">
              📋 View Pricing Policy
            </Link>
            <p className="text-slate-300">
              Questions? Contact us at <a href="mailto:hello@nolojik.com" className="text-cyan-300 hover:text-cyan-200 hover:underline font-semibold">hello@nolojik.com</a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
} 