import React from 'react';

const testimonials = [
  {
    name: 'Amit S.',
    avatar: '🧑🏻',
    quote: 'With LogDhan, I finally understand my trading patterns. The AI feedback is a game changer!',
    color: 'border-chartgreen',
  },
  {
    name: 'Priya R.',
    avatar: '👩🏽',
    quote: 'The Locate • Optimise • Generate method helped me optimize my decisions and grow my portfolio with confidence.',
    color: 'border-gold-light',
  },
  {
    name: 'Rahul D.',
    avatar: '🧑🏾',
    quote: 'Exporting my logs for review is so easy. I love the credit system—super transparent!',
    color: 'border-chartgreen-light',
  },
];

function WhyLOGMattersSection() {
  return (
    <section className="py-16 px-4 max-w-5xl mx-auto text-center">
      <h2 className="text-2xl md:text-3xl font-bold text-white mb-8">Why Locate • Optimise • Generate Matters?</h2>
      <div className="flex flex-col md:flex-row gap-8 justify-center items-stretch">
        {testimonials.map((t, i) => (
          <div key={i} className={`flex-1 bg-white/10 rounded-xl p-6 flex flex-col items-center shadow-lg border-2 ${t.color}`}>
            <div className="text-4xl mb-2">{t.avatar}</div>
            <div className="text-lg text-white font-semibold mb-1">{t.name}</div>
            <div className="text-white/80 text-base italic">“{t.quote}”</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default WhyLOGMattersSection; 