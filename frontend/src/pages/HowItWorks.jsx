import React from 'react';
import { Link } from 'react-router-dom';

export default function HowItWorks() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 py-20 bg-gradient-to-br from-slate-900 via-blue-900 to-indigo-900 relative overflow-hidden">
      {/* Background Effects */}
      <div className="absolute inset-0 opacity-20">
        <div className="absolute top-20 left-10 w-72 h-72 bg-blue-500 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-20 right-10 w-96 h-96 bg-purple-500 rounded-full blur-3xl animate-pulse delay-1000"></div>
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-cyan-500 rounded-full blur-3xl animate-pulse delay-500"></div>
      </div>
      
      <div className="relative z-10">
        <h1 className="text-4xl md:text-6xl font-black text-white mb-4 text-center bg-gradient-to-r from-white via-blue-100 to-cyan-100 bg-clip-text text-transparent">How LogDhan Works</h1>
        <p className="text-xl md:text-2xl text-blue-100 text-center mb-8 max-w-3xl mx-auto">Learn AI-powered swing trading with structured setups and WhatsApp alerts</p>
      </div>
      
      {/* Educational Badge */}
      <div className="bg-red-500/20 border border-red-500/50 rounded-full px-6 py-2 mb-8 inline-flex items-center">
        <span className="text-red-300 text-sm font-semibold">⚠️ NOT SEBI-REGISTERED • EDUCATIONAL ONLY</span>
      </div>
      
      <div className="max-w-4xl w-full space-y-8">
        
        {/* The Problem */}
        <div className="bg-gradient-to-br from-red-500/20 to-red-600/30 backdrop-blur-sm border border-red-400/50 rounded-3xl p-8 md:p-12 text-center shadow-2xl hover:shadow-red-500/20 transition-all duration-300">
          <div className="text-6xl mb-6 animate-bounce">⚠️</div>
          <h2 className="text-3xl md:text-4xl font-black text-white mb-6 bg-gradient-to-r from-red-200 to-orange-200 bg-clip-text text-transparent">The Problem with Learning Stock Analysis</h2>
          <p className="text-white/90 text-lg max-w-2xl mx-auto mb-6">
            Most people struggle to learn swing trading systematically. They rely on random news, chase tips without understanding, or make emotional decisions without rules.
          </p>
          <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            <div className="bg-red-600/30 backdrop-blur-sm rounded-2xl p-6 border border-red-400/30 hover:bg-red-500/40 transition-all duration-300 transform hover:scale-105">
              <h3 className="font-bold text-white mb-2">📰 Unstructured</h3>
              <p className="text-white/80 text-sm">Random news = random conclusions</p>
            </div>
            <div className="bg-red-600/30 backdrop-blur-sm rounded-2xl p-6 border border-red-400/30 hover:bg-red-500/40 transition-all duration-300 transform hover:scale-105">
              <h3 className="font-bold text-white mb-2">👥 Tip-chasing</h3>
              <p className="text-white/80 text-sm">Unverified calls without understanding the 'why'</p>
            </div>
            <div className="bg-red-600/30 backdrop-blur-sm rounded-2xl p-6 border border-red-400/30 hover:bg-red-500/40 transition-all duration-300 transform hover:scale-105">
              <h3 className="font-bold text-white mb-2">😰 Emotional</h3>
              <p className="text-white/80 text-sm">No rules, no risk control, no process</p>
            </div>
          </div>
        </div>

        {/* The Solution */}
        <div className="bg-gradient-to-br from-emerald-500/20 to-green-600/30 backdrop-blur-sm border border-emerald-400/50 rounded-3xl p-8 md:p-12 text-center shadow-2xl hover:shadow-emerald-500/20 transition-all duration-300">
          <div className="text-6xl mb-6 animate-pulse">💡</div>
          <h2 className="text-3xl md:text-4xl font-black text-white mb-6 bg-gradient-to-r from-emerald-200 to-green-200 bg-clip-text text-transparent">The LogDhan Educational Solution</h2>
          <p className="text-white/90 text-lg max-w-2xl mx-auto mb-6">
            We give you a structured way to learn swing trading: build a watchlist, see AI-generated swing setups 
            (with entry, SL, targets, R:R, expiry, AI confidence), get WhatsApp alerts at key moments, and keep a learning log.
          </p>
          <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            <div className="bg-emerald-600/30 backdrop-blur-sm rounded-2xl p-6 border border-emerald-400/30 hover:bg-emerald-500/40 transition-all duration-300 transform hover:scale-105">
              <h3 className="font-bold text-white mb-2">📝 Add to Watchlist</h3>
              <p className="text-white/80 text-sm">Add stocks to your smart watchlist for tracking</p>
            </div>
            <div className="bg-emerald-600/30 backdrop-blur-sm rounded-2xl p-6 border border-emerald-400/30 hover:bg-emerald-500/40 transition-all duration-300 transform hover:scale-105">
              <h3 className="font-bold text-white mb-2">🤖 AI Swing Setups</h3>
              <p className="text-white/80 text-sm">Get clear rules and AI confidence scores</p>
            </div>
            <div className="bg-emerald-600/30 backdrop-blur-sm rounded-2xl p-6 border border-emerald-400/30 hover:bg-emerald-500/40 transition-all duration-300 transform hover:scale-105">
              <h3 className="font-bold text-white mb-2">📊 WhatsApp Alerts</h3>
              <p className="text-white/80 text-sm">Learn timing with setup/confirmation/manage alerts</p>
            </div>
          </div>
        </div>

        {/* L.O.G. Methodology */}
        <div className="bg-gradient-to-br from-amber-500/20 via-orange-500/20 to-yellow-600/30 backdrop-blur-sm border border-amber-400/50 rounded-3xl p-8 md:p-12 shadow-2xl hover:shadow-amber-500/20 transition-all duration-300">
          <div className="text-6xl mb-6 text-center">📋</div>
          <h2 className="text-3xl md:text-4xl font-black text-white mb-6 text-center bg-gradient-to-r from-amber-200 to-yellow-200 bg-clip-text text-transparent">The Locate • Optimize • Generate Methodology</h2>
          <p className="text-white/90 text-center mb-8 max-w-2xl mx-auto">
            Our structured approach to swing trading education: AI locates opportunities, optimizes timing, and generates WhatsApp alerts at the right moments.
          </p>
          <div className="grid md:grid-cols-3 gap-6">
            <div className="bg-gradient-to-br from-orange-500/30 to-red-500/20 backdrop-blur-sm rounded-2xl p-8 text-center border border-orange-400/40 hover:bg-orange-500/40 transition-all duration-300 transform hover:scale-105 shadow-lg">
              <div className="text-5xl mb-4 transform hover:rotate-12 transition-transform duration-300">📝</div>
              <h3 className="text-xl font-bold text-white mb-3">Locate opportunities</h3>
              <p className="text-white/80 text-sm">
                AI scans thousands of stocks daily to locate the best swing trading opportunities. Track 3-30 selected stocks based on your plan.
              </p>
            </div>
            <div className="bg-gradient-to-br from-blue-500/30 to-indigo-500/20 backdrop-blur-sm rounded-2xl p-8 text-center border border-blue-400/40 hover:bg-blue-500/40 transition-all duration-300 transform hover:scale-105 shadow-lg">
              <div className="text-5xl mb-4 transform hover:scale-125 transition-transform duration-300">🤖</div>
              <h3 className="text-xl font-bold text-white mb-3">Optimise</h3>
              <p className="text-white/80 text-sm">
                Our AI creates short-term swing setups with clear rules: entry, SL, targets, R:R, expiry, and AI confidence.
              </p>
            </div>
            <div className="bg-gradient-to-br from-emerald-500/30 to-green-500/20 backdrop-blur-sm rounded-2xl p-8 text-center border border-emerald-400/40 hover:bg-emerald-500/40 transition-all duration-300 transform hover:scale-105 shadow-lg">
              <div className="text-5xl mb-4 transform hover:rotate-12 transition-transform duration-300">📱</div>
              <h3 className="text-xl font-bold text-white mb-3">Generate</h3>
              <p className="text-white/80 text-sm">
                Receive WhatsApp alerts (setup, confirmation, manage, expiry) to learn timing. Use with any broker.
              </p>
            </div>
          </div>
        </div>

        {/* How It Works - 6 Steps */}
        <div className="bg-gradient-to-br from-slate-800/40 to-slate-900/60 backdrop-blur-sm border border-slate-600/50 rounded-3xl p-8 md:p-12 shadow-2xl">
          <div className="text-6xl mb-6 text-center">🎯</div>
          <h2 className="text-3xl md:text-4xl font-black text-white mb-8 text-center bg-gradient-to-r from-slate-200 to-white bg-clip-text text-transparent">How LogDhan Works (6 Steps)</h2>
          <div className="grid md:grid-cols-2 gap-8">
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="bg-gradient-to-br from-blue-500 to-blue-600 rounded-full p-4 text-white font-black text-lg shadow-lg hover:scale-110 transition-transform duration-300">1</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">📝 Build Your Watchlist</h3>
                  <p className="text-white/80 text-sm">
                    Add stocks you want to learn about (3-30 based on plan). Focus on cash market swing opportunities.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="bg-gradient-to-br from-emerald-500 to-green-600 rounded-full p-4 text-white font-black text-lg shadow-lg hover:scale-110 transition-transform duration-300">2</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">🤖 AI Builds Setups</h3>
                  <p className="text-white/80 text-sm">
                    Our AI analyzes each stock and creates swing setups with entry, SL, targets, R:R ratio, expiry window, and confidence score.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="bg-gradient-to-br from-purple-500 to-violet-600 rounded-full p-4 text-white font-black text-lg shadow-lg hover:scale-110 transition-transform duration-300">3</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">📱 WhatsApp "Setup" Alert</h3>
                  <p className="text-white/80 text-sm">
                    Get notified when a new swing setup is ready. Learn the entry rules, stop loss, and target levels.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="bg-gradient-to-br from-orange-500 to-red-600 rounded-full p-4 text-white font-black text-lg shadow-lg hover:scale-110 transition-transform duration-300">4</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">⚡ "Confirmation" Alert</h3>
                  <p className="text-white/80 text-sm">
                    Receive WhatsApp alert when technical confirmation hits. Learn the optimal entry timing for your broker.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="bg-gradient-to-br from-teal-500 to-cyan-600 rounded-full p-4 text-white font-black text-lg shadow-lg hover:scale-110 transition-transform duration-300">5</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">📊 "Manage" & "Expiry"</h3>
                  <p className="text-white/80 text-sm">
                    Get alerts for position management and time-boxed expiry. Learn when to exit if targets aren't hit.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="bg-gradient-to-br from-rose-500 to-pink-600 rounded-full p-4 text-white font-black text-lg shadow-lg hover:scale-110 transition-transform duration-300">6</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">🚀 Grow Your Universe</h3>
                  <p className="text-white/80 text-sm">
                    Upgrade to track more stocks. Same AI for all plans; only watchlist size/alert quota changes.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Key Features */}
        <div className="bg-white/10 border border-gold-light rounded-xl p-8">
          <h2 className="text-2xl font-bold text-white mb-6 text-center">🎯 What You Get with LogDhan</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="text-2xl">⚡</div>
                <div>
                  <h4 className="font-bold text-white">AI Swing Setups</h4>
                  <p className="text-white/80 text-sm">Clear entry, SL, targets, R:R ratio, expiry window, and AI confidence scores for each setup.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">📱</div>
                <div>
                  <h4 className="font-bold text-white">WhatsApp Alerts (4 Types)</h4>
                  <p className="text-white/80 text-sm">Setup → Confirmation → Manage → Expiry alerts delivered at the right moments.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">🎯</div>
                <div>
                  <h4 className="font-bold text-white">Risk-First Approach</h4>
                  <p className="text-white/80 text-sm">ATR-aligned stop losses, R:R ratios shown upfront, time-boxed expiry to limit exposure.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">🤖</div>
                <div>
                  <h4 className="font-bold text-white">AI Confidence & Reasoning</h4>
                  <p className="text-white/80 text-sm">See why each setup exists (trend, volatility regime, breadth) with confidence scores.</p>
                </div>
              </div>
            </div>
            
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="text-2xl">💰</div>
                <div>
                  <h4 className="font-bold text-white">Cash Market Focus</h4>
                  <p className="text-white/80 text-sm">Short-term swing setups focused on cash market stocks for educational learning.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">🔗</div>
                <div>
                  <h4 className="font-bold text-white">Broker-Agnostic</h4>
                  <p className="text-white/80 text-sm">Use setups with any broker platform you prefer - we provide the educational strategy.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">📊</div>
                <div>
                  <h4 className="font-bold text-white">Smart Watchlist (3-30 Stocks)</h4>
                  <p className="text-white/80 text-sm">Track multiple stocks based on your plan. Same AI features for all - only capacity differs.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">🆓</div>
                <div>
                  <h4 className="font-bold text-white">1-Month FREE Trial</h4>
                  <p className="text-white/80 text-sm">Try AI swing setups + WhatsApp alerts with 3 stocks completely free.</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Why Swing Strategy Education Works */}
        <div className="bg-gradient-to-r from-gold-light/20 to-gold/20 border border-gold-light rounded-xl p-8">
          <h2 className="text-2xl font-bold text-white mb-6 text-center">🎓 Why Swing Strategy Education Works</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="text-2xl">📝</div>
                <div>
                  <h4 className="font-bold text-white">Structured Learning Approach</h4>
                  <p className="text-white/80 text-sm">Learn swing trading systematically: understand setups → see confirmations → practice timing → manage risk.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">⏰</div>
                <div>
                  <h4 className="font-bold text-white">Perfect Timing Education</h4>
                  <p className="text-white/80 text-sm">WhatsApp alerts teach you when to enter, manage, and exit positions for optimal learning outcomes.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">🎯</div>
                <div>
                  <h4 className="font-bold text-white">Risk Management Focus</h4>
                  <p className="text-white/80 text-sm">Learn to calculate position sizes, set stop losses, and understand R:R ratios from day one.</p>
                </div>
              </div>
            </div>
            
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="text-2xl">🤖</div>
                <div>
                  <h4 className="font-bold text-white">AI-Powered Education</h4>
                  <p className="text-white/80 text-sm">See confidence scores and reasoning behind each setup to understand market analysis.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">📱</div>
                <div>
                  <h4 className="font-bold text-white">Real-Time Learning</h4>
                  <p className="text-white/80 text-sm">Learn market timing with live alerts rather than theoretical examples from textbooks.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">📚</div>
                <div>
                  <h4 className="font-bold text-white">Build Your Experience</h4>
                  <p className="text-white/80 text-sm">Track multiple stocks simultaneously to see how different setups play out in various market conditions.</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* AI Technology */}
        <div className="bg-gradient-to-r from-purple-500/20 to-blue-500/20 border border-purple-400/50 rounded-xl p-8">
          <h2 className="text-2xl font-bold text-white mb-4 text-center">🧠 AI Swing Strategy Engine</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h4 className="font-bold text-white mb-2">Multi-Factor Analysis</h4>
              <p className="text-white/80 text-sm mb-4">
                Our AI analyzes trend strength, volatility regimes, market breadth, and technical patterns to generate high-confidence swing setups.
              </p>
            </div>
            <div>
              <h4 className="font-bold text-white mb-2">Risk-Aware Modeling</h4>
              <p className="text-white/80 text-sm mb-4">
                Each setup includes ATR-aligned stop losses, realistic R:R ratios, and time-boxed expiry to teach proper risk management.
              </p>
            </div>
            <div>
              <h4 className="font-bold text-white mb-2">Confidence Scoring</h4>
              <p className="text-white/80 text-sm mb-4">
                See why the AI likes each setup with confidence scores and reasoning based on current market conditions.
              </p>
            </div>
            <div>
              <h4 className="font-bold text-white mb-2">Real-Time Monitoring</h4>
              <p className="text-white/80 text-sm mb-4">
                Continuous market monitoring triggers WhatsApp alerts at optimal moments for educational timing practice.
              </p>
            </div>
          </div>
        </div>

        {/* Important Educational Disclaimer */}
        <div className="bg-red-500/20 border border-red-500/50 rounded-xl p-6">
          <h3 className="text-lg font-bold text-white mb-3">⚠️ Educational Disclaimer</h3>
          <div className="space-y-3 text-red-200 text-sm">
            <p>
              <strong>NOT SEBI-REGISTERED:</strong> LogDhan is not registered with SEBI. We provide AI-generated swing setups for educational purposes only.
            </p>
            <p>
              <strong>NOT INVESTMENT ADVICE:</strong> All strategies, setups, and WhatsApp alerts are for learning swing trading concepts. This is not financial or investment advice.
            </p>
            <p>
              <strong>TRADING INVOLVES RISK:</strong> Past performance does not guarantee future results. You may lose money trading. Only trade with money you can afford to lose.
            </p>
            <p>
              <strong>YOUR RESPONSIBILITY:</strong> You are solely responsible for your trading decisions. Always consult qualified financial advisors and do your own research before trading.
            </p>
          </div>
        </div>

        {/* Call to Action */}
        <div className="bg-gradient-to-br from-violet-500/20 via-blue-500/20 to-cyan-500/30 backdrop-blur-sm border border-violet-400/50 rounded-3xl p-8 md:p-12 text-center shadow-2xl">
          <div className="text-6xl mb-6">🚀</div>
          <h2 className="text-3xl md:text-4xl font-black text-white mb-6 bg-gradient-to-r from-violet-200 to-cyan-200 bg-clip-text text-transparent">Ready to Start Learning?</h2>
          <p className="text-white/80 text-lg mb-8 max-w-2xl mx-auto">Join thousands of traders learning AI-powered swing trading with structured setups and WhatsApp alerts</p>
          <div className="flex flex-col sm:flex-row gap-6 justify-center mb-6">
            <Link to="/download">
              <button className="bg-gradient-to-r from-violet-600 via-purple-600 to-blue-600 hover:from-violet-700 hover:via-purple-700 hover:to-blue-700 text-white font-black px-10 py-4 rounded-2xl shadow-xl hover:shadow-2xl transition-all duration-300 transform hover:scale-110 hover:-translate-y-1 text-xl border-2 border-white/20">
                📱 Download LogDhan App
              </button>
            </Link>
            <Link to="/pricing">
              <button className="bg-white/10 hover:bg-white/20 text-white border-2 border-white/30 hover:border-white/50 font-black px-10 py-4 rounded-2xl shadow-xl hover:shadow-2xl transition-all duration-300 transform hover:scale-110 hover:-translate-y-1 text-xl backdrop-blur-sm">
                💰 View Pricing
              </button>
            </Link>
          </div>
          <p className="text-white/70 text-sm">
            Questions? Contact us at <a href="mailto:hello@nolojik.com" className="text-cyan-300 hover:text-cyan-200 hover:underline font-semibold">hello@nolojik.com</a>
          </p>
        </div>
      </div>
    </div>
  );
}