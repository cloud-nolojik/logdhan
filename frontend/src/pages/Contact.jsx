import React from 'react';

export default function Contact() {
  return (
    <section className="min-h-[60vh] flex flex-col items-center justify-center py-16 px-4">
      <h1 className="text-3xl md:text-4xl font-bold text-white mb-4">Contact Us</h1>
      <p className="text-lg text-white/90 mb-6 max-w-xl text-center">
        Have questions, feedback, or need support? Reach out to us anytime.<br />
        <span className="text-gold-light font-semibold">LogDhan</span> is here to help you on your wealth journey.
      </p>
      <div className="bg-white/10 rounded-xl p-8 shadow-lg border border-white/10 flex flex-col items-center">
        <div className="text-lg text-white mb-2">Phone:</div>
        <a href="tel:+919008108650" className="text-gold-light text-xl font-bold hover:underline mb-4">+91 9008108650</a>
        <div className="text-lg text-white mb-2">Address:</div>
        <p className="text-white/90 text-center mb-4">Nolojik Innovations Pvt Ltd<br />No 235, Binnamangala, 13th Cross<br />Indiranagar 2nd Stage<br />Bangalore - 560038</p>
        <div className="text-lg text-white mb-2">Email:</div>
        <a href="mailto:logdhan-help@nolojik.com" className="text-gold-light text-xl font-bold hover:underline mb-4">logdhan-help@nolojik.com</a>
        <div className="text-white/80 text-sm">We typically respond within 24 hours.</div>
      </div>
      <div className="text-xs text-white/60 mt-8">LogDhan is a product of Nolojik Innovations</div>
    </section>
  );
} 