import React, { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <nav className="bg-transparent px-4 py-3 flex items-center justify-between" role="navigation" aria-label="Main navigation">
      <Link to="/" className="flex items-center gap-3 hover:opacity-90 transition">
        <img src="/logo.svg" alt="LogDhan Educational Analysis Platform Logo" className="h-10 w-auto" />
        <div className="flex flex-col">
          <span className="text-xl font-bold text-white">LogDhan</span>
          <span className="text-xs text-gray-300">Your Educational Analysis Companion</span>
        </div>
      </Link>
      <div className="hidden md:flex gap-6 items-center">
        <NavLink to="/" className={({isActive}) => isActive ? 'text-logdhan-orange-light font-semibold' : 'text-white hover:text-logdhan-orange-light transition'}>Home</NavLink>
        <NavLink to="/how-it-works" className={({isActive}) => isActive ? 'text-logdhan-orange-light font-semibold' : 'text-white hover:text-logdhan-orange-light transition'}>How It Works</NavLink>
        <NavLink to="/pricing" className={({isActive}) => isActive ? 'text-logdhan-orange-light font-semibold' : 'text-white hover:text-logdhan-orange-light transition'}>Pricing</NavLink>
        <NavLink to="/contact" className={({isActive}) => isActive ? 'text-logdhan-orange-light font-semibold' : 'text-white hover:text-logdhan-orange-light transition'}>Contact</NavLink>
        <Link to="/download">
          <div className="ml-4 bg-log-gradient hover:shadow-glow text-white font-bold px-4 py-2 rounded-lg shadow cursor-pointer transition-all duration-300 transform hover:scale-105">
            Download App
          </div>
        </Link>
      </div>
      <button 
        className="md:hidden text-white" 
        onClick={() => setMenuOpen(!menuOpen)}
        aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={menuOpen}
      >
        <svg width="28" height="28" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
      {menuOpen && (
        <div className="absolute top-16 left-0 w-full bg-primary-dark z-50 flex flex-col items-center py-4 md:hidden animate-fade-in" role="menu" aria-label="Mobile navigation menu">
          <NavLink to="/" className="py-2 text-white w-full text-center" onClick={()=>setMenuOpen(false)}>Home</NavLink>
          <NavLink to="/how-it-works" className="py-2 text-white w-full text-center" onClick={()=>setMenuOpen(false)}>How It Works</NavLink>
          <NavLink to="/pricing" className="py-2 text-white w-full text-center" onClick={()=>setMenuOpen(false)}>Pricing</NavLink>
          <NavLink to="/contact" className="py-2 text-white w-full text-center" onClick={()=>setMenuOpen(false)}>Contact</NavLink>
          <div className="py-2 text-center w-full">
            <Link to="/download" onClick={()=>setMenuOpen(false)}>
              <div className="bg-log-gradient text-white font-bold px-4 py-2 rounded-lg shadow mx-4">
                Download App
              </div>
            </Link>
          </div>
        </div>
      )}
    </nav>
  );
} 