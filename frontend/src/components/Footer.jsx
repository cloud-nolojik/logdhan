import React from 'react';
import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="bg-slate-900 border-t border-slate-800 text-white py-8 px-4 mt-8">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-6">
          <div>
            <h3 className="text-xl font-bold text-transparent bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text mb-4">SwingSetups</h3>
            <p className="text-sm text-slate-300">AI swing analysis for your watchlist. Educational stock analysis platform.</p>
          </div>
          <div>
            <h4 className="font-semibold text-white mb-3">Quick Links</h4>
            <div className="flex flex-col gap-2 text-sm text-slate-300">
              <Link to="/how-it-works" className="hover:text-blue-400 transition">How It Works</Link>
              <Link to="/pricing" className="hover:text-blue-400 transition">Pricing</Link>
              <Link to="/download" className="hover:text-blue-400 transition">Download</Link>
              <Link to="/contact" className="hover:text-blue-400 transition">Contact</Link>
            </div>
          </div>
          <div>
            <h4 className="font-semibold text-white mb-3">Legal</h4>
            <div className="flex flex-col gap-2 text-sm text-slate-300">
              <Link to="/privacy-policy" className="hover:text-blue-400 transition">Privacy Policy</Link>
              <Link to="/terms" className="hover:text-blue-400 transition">Terms & Conditions</Link>
              <Link to="/refund-policy" className="hover:text-blue-400 transition">Refund Policy</Link>
              <Link to="/pricing-policy" className="hover:text-blue-400 transition">Pricing Policy</Link>
            </div>
          </div>
        </div>
        <div className="border-t border-slate-700 pt-6 text-center">
          <div className="text-sm text-slate-300 mb-2">
            Email: <a href="mailto:contact-swingsetups@nolojik.com" className="text-blue-400 hover:text-emerald-400 transition hover:underline">contact-swingsetups@nolojik.com</a>
          </div>
          <div className="text-xs text-slate-400 space-y-1">
            <p>SwingSetups is a product of Nolojik Innovations Private Limited</p>
            <p>Legal Name: Nolojik Innovations Private Limited (CIN: U62090KA2023PTC180927)</p>
            <p>Registered under the Companies Act, 2013 | Headquartered in Bengaluru, India</p>
            <p className="mt-3 text-amber-400">SwingSetups is an educational tool. It does not provide investment advice or portfolio management services.</p>
          </div>
          <div className="text-sm text-slate-300 mt-4">© 2025 Nolojik Innovations Private Limited. All rights reserved.</div>
        </div>
      </div>
    </footer>
  );
} 