// import React, { useState } from 'react';

// export default function Checkout() {
//   const [amount, setAmount] = useState('');
//   const [showModal, setShowModal] = useState(false);

//   const handleSubmit = (e) => {
//     e.preventDefault();
//     setShowModal(true);
//   };

//   return (
//     <div className="min-h-[70vh] flex flex-col items-center justify-center px-4 py-16 bg-gradient-to-br from-[#1e3a8a] to-[#06b6d4]">
//       <div className="bg-white/10 border border-gold-light rounded-xl p-8 max-w-md w-full shadow-lg flex flex-col items-center">
//         <h1 className="text-2xl md:text-3xl font-bold text-white mb-4">Buy Credits</h1>
//         <div className="bg-white/10 border border-gold-light rounded-lg p-4 mb-4">
//           <h3 className="text-white text-center font-semibold mb-3">Choose Your Plan</h3>
//           <div className="space-y-2 text-xs text-white/90">
//             <div className="flex justify-between">
//               <span>Micro-Pack:</span>
//               <span>5 Reviews – ₹110</span>
//             </div>
//             <div className="flex justify-between">
//               <span>Light Pack:</span>
//               <span>25 Reviews – ₹500</span>
//             </div>
//             <div className="flex justify-between">
//               <span>Starter Pack:</span>
//               <span className="text-blue-400 font-bold">100 Reviews – ₹1,800</span>
//             </div>
//             <div className="flex justify-between">
//               <span>Growth Pack:</span>
//               <span>500 Reviews – ₹6,000</span>
//             </div>
//           </div>
//         </div>
//         <form onSubmit={handleSubmit} className="w-full flex flex-col gap-4">
//           <label className="text-white/90 font-medium">Amount (₹)</label>
//           <input
//             type="number"
//             min="1"
//             required
//             value={amount}
//             onChange={e => setAmount(e.target.value)}
//             className="rounded-lg px-4 py-2 border border-gold-light bg-white/80 text-primary focus:ring-gold-light focus:border-gold-light"
//             placeholder="Enter amount"
//           />
//           <button type="submit" className="bg-gold-light hover:bg-gold text-primary font-bold px-6 py-3 rounded-lg shadow-lg transition text-lg mt-2">Proceed to Payment</button>
//         </form>
//         <div className="text-xs text-white/70 mt-4 text-center">
//           Credits will be credited instantly upon successful payment.<br />
//           <strong>You will receive {amount || '0'} credits for ₹{amount || '0'}</strong><br />
//           <strong>= {amount ? Math.floor(amount / 1) : '0'} AI reviews (1 credit = 1 review)</strong><br />
//           Support: <a href="mailto:hello@nolojik.com" className="text-gold-light hover:underline">hello@nolojik.com</a>
//         </div>
//       </div>
//       {showModal && (
//         <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
//           <div className="bg-white rounded-xl p-8 max-w-sm w-full text-center shadow-xl">
//             <h2 className="text-xl font-bold mb-2 text-primary">Payment Simulation</h2>
//             <p className="mb-4">Pretend you are being redirected to Cashfree for payment of <span className="text-gold font-bold">₹{amount}</span>.</p>
//             <button onClick={() => setShowModal(false)} className="bg-gold-light hover:bg-gold text-primary font-bold px-6 py-2 rounded-lg shadow transition">Close</button>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// } 