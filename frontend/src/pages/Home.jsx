import React from 'react';
import { Link } from 'react-router-dom';
import { useCreditInfo } from '../hooks/useCreditInfo';
import HeroSection from '../components/HeroSection';
import WhatIsLogDhanSection from '../components/WhatIsLogDhanSection';
import LOGPhilosophySection from '../components/LOGPhilosophySection';
import WhyLOGMattersSection from '../components/WhyLOGMattersSection';
import FeatureSection from '../components/FeatureSection';
import FAQSection from '../components/FAQSection';

export default function Home() {
  const { creditInfo, loading } = useCreditInfo();
  
  return (
    <>
      <HeroSection />
      <div className="w-full h-2 bg-gradient-to-r from-gold-light to-chartgreen opacity-60 my-2" />
      <WhatIsLogDhanSection />
      <div className="w-full h-2 bg-gradient-to-r from-chartgreen to-gold-light opacity-60 my-2" />
      <LOGPhilosophySection />
      {/* <div className="w-full h-2 bg-gradient-to-r from-gold-light to-chartgreen-light opacity-60 my-2" /> */}
      {/* <WhyLOGMattersSection /> */}
      <div className="w-full h-2 bg-gradient-to-r from-chartgreen-light to-gold opacity-60 my-2" />
      <FeatureSection />
      <div className="w-full h-2 bg-gradient-to-r from-gold to-chartgreen opacity-60 my-2" />
      <section className="py-16 px-4 max-w-3xl mx-auto" id="download">
        <h2 className="text-2xl md:text-3xl font-bold text-white mb-8 text-center">Get Started with LogDhan</h2>
        <div className="bg-white/10 border border-gold-light rounded-xl p-8 text-center">
          <div className="text-6xl mb-6">📱</div>
          <h3 className="text-xl font-bold text-white mb-4">Download the LogDhan App</h3>
          <p className="text-white/90 mb-6 max-w-md mx-auto">
            Get AI swing setups with WhatsApp alerts on your mobile device. 
            Start with 1-month free trial (3 stocks) or upgrade for more watchlist capacity.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <Link to="/download" className="group">
              <div className="bg-accent-gradient hover:shadow-glow-lg text-white font-bold px-8 py-4 rounded-xl shadow-lg transition-all duration-300 transform group-hover:scale-105">
                📱 Download App
              </div>
            </Link>
          </div>
          <div className="mt-6 text-white/70 text-sm">
            <p><span className="text-gold-light font-semibold">
              Trial: 1-month free with 3 stocks + WhatsApp alerts
            </span></p>
            <p>Paid Plans: ₹999/₹1999/₹2999 for 10/20/30 stocks • Same AI features • Available on all devices</p>
          </div>
        </div>
      </section>
      <FAQSection />
    </>
  );
} 