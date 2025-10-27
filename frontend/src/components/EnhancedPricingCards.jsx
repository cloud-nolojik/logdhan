import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';

const pricingPlans = [
  {
    name: "Educational Trial",
    icon: "🎓",
    price: "FREE",
    period: "First Month Only",
    description: "Try educational analysis for 1 month",
    features: [
      "1 month free trial",
      "Basic educational analysis",
      "3 stocks in watchlist", 
      "Basic monitoring alerts",
      "Limited AI analysis",
      "Auto-converts to paid plan"
    ],
    cta: "Start 1-Month Trial",
    featured: false,
    color: "green",
    adSupported: false
  },
  {
    name: "Basic Plan", 
    icon: "📚",
    price: "₹999",
    period: "month",
    description: "Essential educational features",
    features: [
      "10 stocks in watchlist",
      "Same AI analysis as all plans", 
      "Same monitoring & alerts",
      "Educational content library",
      "Email support",
      "Auto-renewal"
    ],
    cta: "Subscribe ₹999/month",
    featured: true,
    color: "blue",
    adSupported: false
  },
  {
    name: "Premium Plan",
    icon: "🏆", 
    price: "₹1999",
    period: "month",
    description: "Advanced educational features",
    features: [
      "20 stocks in watchlist",
      "Same AI analysis as all plans",
      "Same monitoring & alerts",
      "Priority educational support",
      "Advanced charting tools",
      "Only difference: More stocks"
    ],
    cta: "Subscribe ₹1999/month",
    featured: false,
    color: "purple",
    adSupported: false,
    bestValue: false
  },
  {
    name: "Pro Plan",
    icon: "💎", 
    price: "₹2999",
    period: "month",
    description: "Complete educational experience",
    features: [
      "30 stocks in watchlist",
      "Same AI analysis as all plans",
      "Same monitoring & alerts",
      "Same triggering features",
      "Premium educational content",
      "Dedicated educational support"
    ],
    cta: "Subscribe ₹2999/month",
    featured: false,
    color: "gold",
    adSupported: false,
    bestValue: true
  }
];

const colorSchemes = {
  green: {
    bg: "from-green-500/10 to-emerald-500/10",
    border: "border-green-500/30",
    button: "bg-green-600 hover:bg-green-700 focus:ring-green-500",
    text: "text-green-400",
    badge: "bg-green-500"
  },
  blue: {
    bg: "from-blue-500/10 to-indigo-500/10", 
    border: "border-blue-500/30",
    button: "bg-blue-600 hover:bg-blue-700 focus:ring-blue-500",
    text: "text-blue-400",
    badge: "bg-blue-500"
  },
  purple: {
    bg: "from-purple-500/10 to-violet-500/10",
    border: "border-purple-500/30", 
    button: "bg-purple-600 hover:bg-purple-700 focus:ring-purple-500",
    text: "text-purple-400",
    badge: "bg-purple-500"
  },
  gold: {
    bg: "from-yellow-500/10 to-orange-500/10",
    border: "border-yellow-500/30", 
    button: "bg-yellow-600 hover:bg-yellow-700 focus:ring-yellow-500",
    text: "text-yellow-400",
    badge: "bg-yellow-500"
  }
};

export default function EnhancedPricingCards() {
  return (
    <section aria-label="Pricing plans" className="py-12 px-4 max-w-7xl mx-auto">
      {/* Header */}
      <div className="text-center mb-12">
        <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
          Choose Your <span className="text-transparent bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text">Educational Plan</span>
        </h2>
        <p className="text-lg text-gray-300 mb-6 max-w-2xl mx-auto">
          Access educational stock analysis tools for learning. All plans designed for educational purposes only.
        </p>
        
        {/* Educational Disclaimer */}
        <div className="inline-flex items-center bg-amber-900/20 border border-amber-500/30 rounded-xl px-6 py-3 mb-8">
          <span className="text-amber-400 text-sm font-semibold mr-2">⚠️</span>
          <span className="text-amber-200 text-sm font-medium">EDUCATIONAL ONLY - Not Investment Advice</span>
        </div>
      </div>

      {/* Mobile-First Pricing Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
        {pricingPlans.map((plan, index) => {
          const colors = colorSchemes[plan.color];
          
          return (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              viewport={{ once: true }}
              className={`relative bg-gradient-to-br ${colors.bg} ${colors.border} border-2 rounded-2xl p-6 h-full flex flex-col transform transition-all duration-300 hover:scale-105 hover:shadow-2xl ${
                plan.featured ? 'ring-2 ring-blue-500 ring-opacity-50' : ''
              } ${
                plan.bestValue ? 'ring-2 ring-purple-500 ring-opacity-50' : ''
              }`}
            >
              {/* Featured/Best Value Badge */}
              {plan.featured && (
                <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
                  <div className={`${colors.badge} text-white px-4 py-1 rounded-full text-sm font-semibold`}>
                    Most Popular
                  </div>
                </div>
              )}
              
              {plan.bestValue && (
                <div className="absolute -top-3 left-1/2 transform -translate-x-1/2">
                  <div className={`${colors.badge} text-white px-4 py-1 rounded-full text-sm font-semibold`}>
                    Best Value
                  </div>
                </div>
              )}

              {/* Plan Header */}
              <div className="text-center mb-6">
                <div className="text-4xl mb-3">{plan.icon}</div>
                <h3 className="text-xl font-bold text-white mb-2">{plan.name}</h3>
                <p className="text-gray-300 text-sm mb-4">{plan.description}</p>
                
                {/* Pricing */}
                <div className="mb-4">
                  <div className="text-3xl font-bold text-white mb-1">
                    {plan.price}
                    {plan.period && plan.price !== "FREE" && (
                      <span className="text-lg text-gray-400">/{plan.period}</span>
                    )}
                  </div>
                  <div className="text-sm text-gray-400">
                    Educational Stock Analysis Platform
                  </div>
                </div>
              </div>

              {/* Features List */}
              <div className="flex-grow mb-6">
                <ul className="space-y-3" role="list">
                  {plan.features.map((feature, idx) => (
                    <li key={idx} className="flex items-start text-sm">
                      <div className="w-5 h-5 bg-green-500 rounded-full flex items-center justify-center mr-3 mt-0.5 flex-shrink-0">
                        <span className="text-white text-xs font-bold" aria-hidden="true">✓</span>
                      </div>
                      <span className="text-gray-200">{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* CTA Button */}
              <div className="mt-auto">
                <button
                  className={`w-full ${colors.button} text-white font-bold py-4 px-6 rounded-xl transition-all duration-300 transform hover:scale-105 focus:outline-none focus:ring-4 focus:ring-opacity-50 text-lg min-h-[3rem]`}
                  aria-label={`${plan.cta} - ${plan.name} plan`}
                  onClick={() => {
                    if (plan.price === "FREE") {
                      window.open('https://logdhan.com', '_blank');
                    } else {
                      // Handle subscription logic
                      window.location.href = '/pricing-policy';
                    }
                  }}
                >
                  {plan.cta}
                </button>
              </div>

              {/* Ad-supported indicator */}
              {plan.adSupported && (
                <div className="mt-4 text-center">
                  <span className="text-xs text-gray-400 bg-gray-800/50 px-3 py-1 rounded-full">
                    📺 Ad-supported
                  </span>
                </div>
              )}
            </motion.div>
          );
        })}
      </div>

      {/* Quick Comparison */}
      <div className="mt-12 bg-white/5 rounded-2xl p-6 backdrop-blur-sm">
        <h3 className="text-xl font-bold text-white mb-6 text-center">Quick Comparison</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" role="table" aria-label="Plan comparison table">
            <thead>
              <tr className="border-b border-gray-600">
                <th className="text-left py-3 px-4 text-gray-300 font-semibold">Feature</th>
                <th className="text-center py-3 px-4 text-green-400 font-semibold">Trial</th>
                <th className="text-center py-3 px-4 text-blue-400 font-semibold">₹999</th>
                <th className="text-center py-3 px-4 text-purple-400 font-semibold">₹1999</th>
                <th className="text-center py-3 px-4 text-yellow-400 font-semibold">₹2999</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-gray-700">
                <td className="py-3 px-4 text-gray-200">Watchlist Stocks</td>
                <td className="text-center py-3 px-4 text-green-400">3 stocks</td>
                <td className="text-center py-3 px-4 text-blue-400">10 stocks</td>
                <td className="text-center py-3 px-4 text-purple-400">20 stocks</td>
                <td className="text-center py-3 px-4 text-yellow-400">30 stocks</td>
              </tr>
              <tr className="border-b border-gray-700">
                <td className="py-3 px-4 text-gray-200">AI Analysis</td>
                <td className="text-center py-3 px-4 text-green-400">Limited</td>
                <td className="text-center py-3 px-4 text-blue-400">Same as all</td>
                <td className="text-center py-3 px-4 text-purple-400">Same as all</td>
                <td className="text-center py-3 px-4 text-yellow-400">Same as all</td>
              </tr>
              <tr className="border-b border-gray-700">
                <td className="py-3 px-4 text-gray-200">Features</td>
                <td className="text-center py-3 px-4 text-green-400">Trial</td>
                <td className="text-center py-3 px-4 text-blue-400">Same as all</td>
                <td className="text-center py-3 px-4 text-purple-400">Same as all</td>
                <td className="text-center py-3 px-4 text-yellow-400">Same as all</td>
              </tr>
              <tr>
                <td className="py-3 px-4 text-gray-200">Only Difference</td>
                <td className="text-center py-3 px-4 text-green-400">-</td>
                <td className="text-center py-3 px-4 text-blue-400">Watchlist size</td>
                <td className="text-center py-3 px-4 text-purple-400">Watchlist size</td>
                <td className="text-center py-3 px-4 text-yellow-400">Watchlist size</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Educational Emphasis */}
      <div className="mt-8 text-center">
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-6 max-w-3xl mx-auto">
          <h4 className="text-lg font-bold text-red-400 mb-2">📚 Educational Purpose Only</h4>
          <p className="text-red-200 text-sm">
            All LogDhan plans provide educational tools for learning stock analysis concepts. 
            This is not investment advice. Always consult qualified financial advisors for investment decisions.
          </p>
        </div>
      </div>
    </section>
  );
}