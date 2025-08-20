import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import Home from './pages/Home';
import HowItWorks from './pages/HowItWorks';
import Pricing from './pages/Pricing';
import PricingPolicy from './pages/PricingPolicy';
import Download from './pages/Download';
import DownloadAndroid from './pages/DownloadAndroid';
import DownloadIOS from './pages/DownloadIOS';
import DownloadWeb from './pages/DownloadWeb';
import PrivacyPolicy from './pages/PrivacyPolicy';
import Terms from './pages/Terms';
import RefundPolicy from './pages/RefundPolicy';
import Contact from './pages/Contact';

export default function App() {
  return (
    <div className="min-h-screen flex flex-col bg-main-gradient">
      <head>
        <title>LogDhan – AI for Smarter Trades</title>
        <meta name="description" content="LogDhan is a credit-based AI trading assistant for smarter investing and better decisions. Powered by Nolojik Innovations." />
        <link rel="icon" href="/logo.svg" />
      </head>
      <Navbar />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/how-it-works" element={<HowItWorks />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/pricing-policy" element={<PricingPolicy />} />
          <Route path="/download" element={<Download />} />
          <Route path="/download/android" element={<DownloadAndroid />} />
          <Route path="/download/ios" element={<DownloadIOS />} />
          <Route path="/download/web" element={<DownloadWeb />} />
          <Route path="/privacy-policy" element={<PrivacyPolicy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/refund-policy" element={<RefundPolicy />} />
          <Route path="/contact" element={<Contact />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
} 