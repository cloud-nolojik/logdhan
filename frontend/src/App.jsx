import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Footer from './components/Footer';
import SEBIDisclaimerBanner from './components/SEBIDisclaimerBanner';
import Home from './pages/Home';
import HowItWorks from './pages/HowItWorks';
import Pricing from './pages/Pricing';
import PricingPolicy from './pages/PricingPolicy';
import Download from './pages/Download';
import DownloadAndroid from './pages/DownloadAndroid';
import PrivacyPolicy from './pages/PrivacyPolicy';
import Terms from './pages/Terms';
import RefundPolicy from './pages/RefundPolicy';
import Contact from './pages/Contact';
import AdminIndex from './pages/admin/AdminIndex';
import WhatsAppAlerts from './pages/admin/WhatsAppAlerts';
import AppFeedback from './pages/admin/AppFeedback';
import JobMonitor from './pages/admin/JobMonitor';

export default function App() {
  return (
    <div className="min-h-screen flex flex-col bg-main-gradient">
      <head>
        <title>SwingSetups – AI Swing Analysis for Your Watchlist</title>
        <meta name="description" content="SwingSetups provides daily AI-generated swing analysis for your stock watchlist. Clear price regions, simple explanations, educational approach. Track NSE & BSE stocks." />
        <link rel="icon" href="/favicon.ico" />
      </head>
      <SEBIDisclaimerBanner />
      <Navbar />
      <main className="flex-1">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/how-it-works" element={<HowItWorks />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/pricing-policy" element={<PricingPolicy />} />
          <Route path="/download" element={<Download />} />
          <Route path="/download/android" element={<DownloadAndroid />} />
         <Route path="/privacy-policy" element={<PrivacyPolicy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/refund-policy" element={<RefundPolicy />} />
          <Route path="/contact" element={<Contact />} />
          <Route path="/admin" element={<AdminIndex />} />
          <Route path="/admin/whatsapp-alerts" element={<WhatsAppAlerts />} />
          <Route path="/admin/feedback" element={<AppFeedback />} />
          <Route path="/admin/jobs" element={<JobMonitor />} />
        </Routes>
      </main>
      <Footer />
    </div>
  );
} 