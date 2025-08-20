import React from 'react';
import { Link } from 'react-router-dom';

export default function HowItWorks() {
  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-4 py-16 bg-gradient-to-br from-[#1e3a8a] to-[#06b6d4]">
      <h1 className="text-2xl md:text-3xl font-bold text-white mb-8">How LogDhan Works</h1>
      
      <div className="max-w-4xl w-full space-y-8">
        
        {/* The Problem */}
        <div className="bg-red-500/20 border border-red-500/50 rounded-xl p-8 text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <h2 className="text-2xl font-bold text-white mb-4">The Problem with Retail Trading</h2>
          <p className="text-white/90 text-lg max-w-2xl mx-auto mb-6">
            <strong>99% of retail traders lose money</strong> due to impulsive trading decisions based on news, tips, or emotions. 
            They buy and sell without a plan, leading to consistent losses.
          </p>
          <div className="grid md:grid-cols-3 gap-4 max-w-2xl mx-auto">
            <div className="bg-red-600/20 rounded-lg p-4">
              <h3 className="font-bold text-white mb-2">📰 News-Based Trading</h3>
              <p className="text-white/80 text-sm">Making decisions based on market news</p>
            </div>
            <div className="bg-red-600/20 rounded-lg p-4">
              <h3 className="font-bold text-white mb-2">👥 Following Tips</h3>
              <p className="text-white/80 text-sm">Listening to others without analysis</p>
            </div>
            <div className="bg-red-600/20 rounded-lg p-4">
              <h3 className="font-bold text-white mb-2">😰 Emotional Trading</h3>
              <p className="text-white/80 text-sm">Fear and greed driving decisions</p>
            </div>
          </div>
        </div>

        {/* The Solution */}
        <div className="bg-green-500/20 border border-green-500/50 rounded-xl p-8 text-center">
          <div className="text-4xl mb-4">💡</div>
          <h2 className="text-2xl font-bold text-white mb-4">The LogDhan Solution</h2>
          <p className="text-white/90 text-lg max-w-2xl mx-auto mb-6">
            <strong>Plan your trades before executing them.</strong> LogDhan helps you create a trading plan, 
            get AI review of your plan, and maintain detailed logs for continuous improvement.
          </p>
          <div className="grid md:grid-cols-3 gap-4 max-w-2xl mx-auto">
            <div className="bg-green-600/20 rounded-lg p-4">
              <h3 className="font-bold text-white mb-2">📝 Plan Your Trade</h3>
              <p className="text-white/80 text-sm">Document your reasoning and strategy</p>
            </div>
            <div className="bg-green-600/20 rounded-lg p-4">
              <h3 className="font-bold text-white mb-2">🤖 AI Review</h3>
              <p className="text-white/80 text-sm">Get intelligent feedback on your plan</p>
            </div>
            <div className="bg-green-600/20 rounded-lg p-4">
              <h3 className="font-bold text-white mb-2">📊 Learn & Optimize</h3>
              <p className="text-white/80 text-sm">Track results and improve over time</p>
            </div>
          </div>
        </div>

        {/* How It Works - Step by Step */}
        <div className="bg-white/10 border border-gold-light rounded-xl p-8">
          <h2 className="text-2xl font-bold text-white mb-6 text-center">📋 How LogDhan Works</h2>
          <div className="grid md:grid-cols-2 gap-8">
            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="bg-blue-500 rounded-full p-3 text-white font-bold">1</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">📝 Create Your Trading Plan</h3>
                  <p className="text-white/80 text-sm">
                    Before making any trade, document your plan: Which stock? Why? Entry price? Exit strategy? 
                    Stop loss? This forces you to think rationally, not emotionally.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="bg-green-500 rounded-full p-3 text-white font-bold">2</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">🤖 Get AI Review</h3>
                  <p className="text-white/80 text-sm">
                    Submit your trading plan to LogDhan's AI for review. The AI analyzes your reasoning, 
                    checks technical factors, and provides feedback on your plan before you execute it.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="bg-purple-500 rounded-full p-3 text-white font-bold">3</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">🎯 Decide & Execute</h3>
                  <p className="text-white/80 text-sm">
                    Based on AI feedback, decide whether to proceed, modify, or abandon your trade. 
                    You make the final decision - AI just helps you think more clearly.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="bg-orange-500 rounded-full p-3 text-white font-bold">4</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">📊 Log Your Trade</h3>
                  <p className="text-white/80 text-sm">
                    Whether you execute the trade or not, log it in LogDhan. Record your original plan, 
                    AI feedback, final decision, and eventual outcome.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="bg-teal-500 rounded-full p-3 text-white font-bold">5</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">📈 Track & Analyze</h3>
                  <p className="text-white/80 text-sm">
                    Review your trading logs regularly. See patterns in your behavior, identify what works, 
                    and learn from both successful and failed trades.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="bg-red-500 rounded-full p-3 text-white font-bold">6</div>
                <div>
                  <h3 className="text-lg font-bold text-white mb-2">📤 Export & Review</h3>
                  <p className="text-white/80 text-sm">
                    Export your trading logs to Excel/CSV. Share with mentors, review with experts, 
                    or analyze deeper to continuously improve your trading skills.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Key Features */}
        <div className="bg-white/10 border border-gold-light rounded-xl p-8">
          <h2 className="text-2xl font-bold text-white mb-6 text-center">🎯 What You Get</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="text-2xl">📊</div>
                <div>
                  <h4 className="font-bold text-white">Technical Analysis</h4>
                  <p className="text-white/80 text-sm">Chart patterns, support/resistance levels, and technical indicators analysis</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">📈</div>
                <div>
                  <h4 className="font-bold text-white">Market Trends</h4>
                  <p className="text-white/80 text-sm">Current market sentiment and trend analysis for informed decisions</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">🎯</div>
                <div>
                  <h4 className="font-bold text-white">Buy/Sell Signals</h4>
                  <p className="text-white/80 text-sm">Clear recommendations on whether to buy, sell, or hold</p>
                </div>
              </div>
            </div>
            
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="text-2xl">⚡</div>
                <div>
                  <h4 className="font-bold text-white">Real-Time Insights</h4>
                  <p className="text-white/80 text-sm">Get fresh analysis based on current market conditions</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">💡</div>
                <div>
                  <h4 className="font-bold text-white">Risk Assessment</h4>
                  <p className="text-white/80 text-sm">Understand the risk level of your potential investments</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">📱</div>
                <div>
                  <h4 className="font-bold text-white">Mobile-First</h4>
                  <p className="text-white/80 text-sm">Access powerful analysis tools right from your smartphone</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Why LOGS Matter */}
        <div className="bg-gradient-to-r from-gold-light/20 to-gold/20 border border-gold-light rounded-xl p-8">
          <h2 className="text-2xl font-bold text-white mb-6 text-center">📋 Why Trading LOGS Matter</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="text-2xl">📈</div>
                <div>
                  <h4 className="font-bold text-white">Track Your Progress</h4>
                  <p className="text-white/80 text-sm">Every trade tells a story. LogDhan helps you maintain detailed logs of your trading decisions and outcomes.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">🎯</div>
                <div>
                  <h4 className="font-bold text-white">Identify Patterns</h4>
                  <p className="text-white/80 text-sm">Discover what works and what doesn't by analyzing your trading logs over time.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">🔍</div>
                <div>
                  <h4 className="font-bold text-white">Learn from Mistakes</h4>
                  <p className="text-white/80 text-sm">Review past trades to understand mistakes and avoid repeating them in the future.</p>
                </div>
              </div>
            </div>
            
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="text-2xl">📊</div>
                <div>
                  <h4 className="font-bold text-white">Performance Analytics</h4>
                  <p className="text-white/80 text-sm">Get detailed insights into your trading performance with comprehensive analytics.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">💡</div>
                <div>
                  <h4 className="font-bold text-white">AI-Driven Insights</h4>
                  <p className="text-white/80 text-sm">Our AI analyzes your trading logs to provide personalized recommendations.</p>
                </div>
              </div>
              
              <div className="flex items-start gap-3">
                <div className="text-2xl">🚀</div>
                <div>
                  <h4 className="font-bold text-white">Continuous Improvement</h4>
                  <p className="text-white/80 text-sm">Use your trading logs as a foundation for continuous learning and growth.</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* AI Technology */}
        <div className="bg-gradient-to-r from-purple-500/20 to-blue-500/20 border border-purple-400/50 rounded-xl p-8">
          <h2 className="text-2xl font-bold text-white mb-4 text-center">🧠 Powered by Advanced AI</h2>
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h4 className="font-bold text-white mb-2">Machine Learning Models</h4>
              <p className="text-white/80 text-sm mb-4">
                Our AI is trained on vast amounts of market data, historical patterns, and your trading logs to provide accurate analysis.
              </p>
            </div>
            <div>
              <h4 className="font-bold text-white mb-2">Continuous Learning</h4>
              <p className="text-white/80 text-sm mb-4">
                The AI continuously learns from market movements and your trading logs to improve its analysis over time.
              </p>
            </div>
          </div>
        </div>

        {/* Important Disclaimer */}
        <div className="bg-red-500/20 border border-red-500/50 rounded-xl p-6">
          <h3 className="text-lg font-bold text-white mb-3">⚠️ Important Disclaimer</h3>
          <p className="text-red-200 text-sm">
            LogDhan AI provides analysis and insights for educational purposes only. This is not financial advice. 
            Always consult with qualified financial advisors and do your own research before making investment decisions. 
            Trading involves risk and you may lose money.
          </p>
        </div>

        {/* Call to Action */}
        <div className="text-center space-y-4">
          <h2 className="text-xl font-bold text-white">Ready to Start?</h2>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link to="/download">
              <button className="bg-gold-light hover:bg-gold text-primary font-bold px-8 py-3 rounded-lg shadow-lg transition text-lg">
                Download LogDhan App
              </button>
            </Link>
            <Link to="/pricing">
              <button className="bg-white/10 hover:bg-white/20 text-white border border-white/30 font-bold px-8 py-3 rounded-lg transition text-lg">
                View Pricing
              </button>
            </Link>
          </div>
          <p className="text-white/70 text-sm">
            Contact us at <a href="mailto:hello@nolojik.com" className="text-gold-light hover:underline">hello@nolojik.com</a> for any questions
          </p>
        </div>
      </div>
    </div>
  );
}