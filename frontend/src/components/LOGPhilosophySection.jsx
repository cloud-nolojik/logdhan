import React from 'react';

const logBlocks = [
  {
    title: 'Locate opportunities',
    icon: (
      <svg className="w-8 h-8 text-chartgreen" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 20V4m0 0l-4 4m4-4l4 4" /></svg>
    ),
    desc: 'AI finds trading opportunities',
    color: 'text-chartgreen',
  },
  {
    title: 'Optimize timing',
    icon: (
      <svg className="w-8 h-8 text-gold-light" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M8 12h8M12 8v8" /></svg>
    ),
    desc: 'Get AI-powered entry & exit signals',
    color: 'text-gold-light',
  },
  {
    title: 'Generate profits',
    icon: (
      <svg className="w-8 h-8 text-chartgreen-light" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M12 20V10m0 0l-4 4m4-4l4 4" /></svg>
    ),
    desc: 'Follow AI strategy & profit',
    color: 'text-chartgreen-light',
  },
];

export default function LOGPhilosophySection() {
  return (
    <section className="py-16 px-4 max-w-4xl mx-auto text-center">
      <h2 className="text-2xl md:text-3xl font-bold text-white mb-8">Our Process: <span className="text-gold-light">Locate • Optimise • Generate</span></h2>
      <div className="flex flex-col md:flex-row gap-8 justify-center items-stretch mb-8">
        {logBlocks.map((b, i) => (
          <div key={i} className="flex-1 bg-white/10 rounded-xl p-6 flex flex-col items-center shadow-lg border border-white/10">
            <div className={`mb-3 ${b.color}`}>{b.icon}</div>
            <div className="text-xl font-semibold text-white mb-2">{b.title}</div>
            <div className="text-white/80 text-base">{b.desc}</div>
          </div>
        ))}
      </div>
      <div className="italic text-white/90 text-lg max-w-2xl mx-auto mt-4">
        "AI swing strategies with clear entry/SL/targets + WhatsApp alerts when conditions confirm."
      </div>
    </section>
  );
} 