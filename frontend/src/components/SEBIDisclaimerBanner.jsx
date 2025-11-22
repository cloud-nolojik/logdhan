import React from 'react';

export default function SEBIDisclaimerBanner() {
  return (
    <div className="w-full bg-amber-900/20 border-b border-amber-700/30">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-2 flex items-center gap-3 text-xs sm:text-sm text-amber-200">
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-700/30 text-amber-400 text-xs font-semibold flex-shrink-0">
          !
        </span>
        <p className="leading-snug">
          Educational use only · SwingSetups is not a SEBI-registered advisor or broker. Please consult certified professionals before trading or investing.
        </p>
      </div>
    </div>
  );
}