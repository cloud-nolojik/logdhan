import React from 'react';
import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="bg-primary-dark text-white py-6 px-4 mt-8">
      <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex flex-col md:flex-row gap-2 md:gap-6 items-center">
          <Link to="/privacy-policy" className="hover:text-gold-light transition">Privacy Policy</Link>
          <Link to="/terms" className="hover:text-gold-light transition">Terms</Link>
          <Link to="/refund-policy" className="hover:text-gold-light transition">Refund Policy</Link>
          <Link to="/contact" className="hover:text-gold-light transition">Contact</Link>
        </div>
        <div className="text-sm text-gold-light">© 2025 Nolojik Innovations Private Limited</div>
        <div className="text-sm">Email: <a href="mailto:logdhan-help@nolojik.com" className="text-gold-light hover:underline">logdhan-help@nolojik.com</a></div>
      </div>
      <div className="text-center text-xs mt-2 opacity-70">
        <p>LogDhan is a product of Nolojik Innovations Private Limited</p>
        <p className="mt-1">Legal Name: Nolojik Innovations Private Limited (CIN: U62090KA2023PTC180927)</p>
        <p>Registered under the Companies Act, 2013 | Headquartered in Bengaluru, India</p>
      </div>
    </footer>
  );
} 