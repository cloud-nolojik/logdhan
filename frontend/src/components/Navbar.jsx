import React, { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <nav className="backdrop-blur-md bg-slate-900/60 border-b border-slate-800/50 shadow-lg shadow-slate-900/10 px-6 py-4 flex items-center justify-between sticky top-0 z-50">
      
      {/* Logo */}
      <Link to="/" className="flex items-center gap-3 hover:opacity-90 transition">
        <img src="/trans_bg_logo.png" alt="SwingSetups Logo" className="h-10 w-auto" />
        <div className="flex flex-col leading-tight">
          <span className="text-lg font-bold text-white">SwingSetups</span>
          <span className="text-[10px] text-slate-400">AI Swing Analysis</span>
        </div>
      </Link>

      {/* Desktop Menu */}
      <div className="hidden md:flex gap-6 items-center">
        {[
          { to: "/", label: "Home" },
          { to: "/how-it-works", label: "How It Works" },
          { to: "/pricing", label: "Pricing" },
          { to: "/contact", label: "Contact" }
        ].map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              isActive
                ? "text-blue-400 font-semibold"
                : "text-white hover:text-blue-300 transition"
            }
          >
            {item.label}
          </NavLink>
        ))}

        {/* CTA Button */}
        <Link to="/download">
          <div className="ml-4 bg-gradient-to-r from-blue-600 to-emerald-500 hover:from-blue-700 hover:to-emerald-600 text-white font-bold px-5 py-2.5 rounded-xl shadow-lg shadow-blue-500/20 cursor-pointer transition-transform hover:scale-105">
            Download App
          </div>
        </Link>
      </div>

      {/* Mobile Menu Toggle */}
      <button
        className="md:hidden text-white"
        onClick={() => setMenuOpen(!menuOpen)}
        aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={menuOpen}
      >
        <svg width="28" height="28" fill="none" viewBox="0 0 24 24">
          <path stroke="currentColor" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Mobile Menu */}
      {menuOpen && (
        <div className="absolute top-16 left-0 w-full backdrop-blur-lg bg-slate-900/80 border-b border-slate-800/60 shadow-lg shadow-slate-900/20 z-50 flex flex-col items-center py-4 md:hidden animate-fade-in">
          <NavLink to="/" className="py-3 text-white w-full text-center hover:text-blue-300" onClick={() => setMenuOpen(false)}>Home</NavLink>
          <NavLink to="/how-it-works" className="py-3 text-white w-full text-center hover:text-blue-300" onClick={() => setMenuOpen(false)}>How It Works</NavLink>
          <NavLink to="/pricing" className="py-3 text-white w-full text-center hover:text-blue-300" onClick={() => setMenuOpen(false)}>Pricing</NavLink>
          <NavLink to="/contact" className="py-3 text-white w-full text-center hover:text-blue-300" onClick={() => setMenuOpen(false)}>Contact</NavLink>

          <div className="py-4 w-full flex justify-center">
            <Link to="/download" onClick={() => setMenuOpen(false)}>
              <div className="bg-gradient-to-r from-blue-600 to-emerald-500 text-white font-bold px-6 py-3 rounded-xl shadow-lg transition-transform hover:scale-105">
                Download App
              </div>
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
}
