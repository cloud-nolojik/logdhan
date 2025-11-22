import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";

export default function Pricing() {
  const [pricingPlans, setPricingPlans] = useState([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [plansError, setPlansError] = useState(null);

  useEffect(() => {
    const fetchPlans = async () => {
      try {
        setPlansLoading(true);
        setPlansError(null);

        const response = await fetch("/api/v1/public/plans");
        if (!response.ok) {
          throw new Error("Failed to fetch plans");
        }

        const data = await response.json();
        if (data.success && Array.isArray(data.data)) {
          setPricingPlans(data.data);
        } else {
          throw new Error("Invalid pricing data received");
        }
      } catch (err) {
        console.error("Error fetching plans:", err);
        setPlansError(err.message || "Unable to load plans right now.");
        setPricingPlans([]);
      } finally {
        setPlansLoading(false);
      }
    };

    fetchPlans();
  }, []);

  // helper to attach style "tone" per plan
  const formatPlanForCard = (plan) => {
    const isTrial = plan.type === "TRIAL";

    const tone =
      isTrial ? "emerald" : plan.isPopular ? "blue" : plan.isBestValue ? "amber" : "violet";

    const toneStyles = {
      emerald: {
        accentText: "text-emerald-600",
        accentLight: "text-emerald-500",
        badgeBg: "bg-emerald-100 text-emerald-800",
        cardRing: "ring-emerald-100",
      },
      blue: {
        accentText: "text-blue-600",
        accentLight: "text-blue-500",
        badgeBg: "bg-blue-100 text-blue-800",
        cardRing: "ring-blue-100",
      },
      amber: {
        accentText: "text-amber-600",
        accentLight: "text-amber-500",
        badgeBg: "bg-amber-100 text-amber-800",
        cardRing: "ring-amber-100",
      },
      violet: {
        accentText: "text-violet-600",
        accentLight: "text-violet-500",
        badgeBg: "bg-violet-100 text-violet-800",
        cardRing: "ring-violet-100",
      },
    };

    const styles = toneStyles[tone];

    return {
      name: plan.name,
      stockLimit: plan.stockLimit,
      price: isTrial ? "FREE" : `₹${plan.price}`,
      billing:
        plan.billingCycle === "MONTHLY"
          ? "per month"
          : plan.billingCycle === "ANNUALLY"
          ? "per year"
          : "1-month trial",
      features: plan.features,
      isTrial,
      isPopular: plan.isPopular,
      isBestValue: plan.isBestValue,
      badge: isTrial
        ? "FREE Trial"
        : plan.isPopular
        ? "Most Popular"
        : plan.isBestValue
        ? "Best Value"
        : "Advanced",
      emoji: isTrial ? "🎁" : plan.isPopular ? "⭐" : plan.isBestValue ? "💎" : "📈",
      buttonText: isTrial
        ? "Start free trial"
        : plan.isPopular || plan.isBestValue
        ? "Subscribe now"
        : "Choose plan",
      styles,
    };
  };

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-16 sm:px-6 lg:px-8">
      {/* soft background */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,_#e0f2fe,_transparent_55%),_radial-gradient(circle_at_bottom,_#f1f5f9,_transparent_60%)]" />

      <div className="mx-auto max-w-6xl">
        {/* HEADER */}
        <div className="text-center mb-12">
          <p className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
            Pricing · Educational swing analysis
          </p>
          <h1 className="mt-4 text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-slate-900">
            AI swing strategy{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 to-emerald-500">
              plans for your watchlist
            </span>
          </h1>
          <p className="mt-4 max-w-2xl mx-auto text-sm sm:text-base text-slate-600">
            One account works across all platforms. Start with the free trial, then pick the
            watchlist size that suits you.
          </p>
        </div>

        {/* TOP HIGHLIGHT / DISCLAIMER */}
        <div className="mb-10 rounded-3xl border border-emerald-100 bg-white shadow-sm p-6 sm:p-8 text-center">
          <div className="text-3xl mb-3">🎆</div>
          <p className="text-sm sm:text-base text-slate-700 mb-4">
            <span className="font-semibold text-emerald-600">
              AI swing setups + optional WhatsApp alerts
            </span>{" "}
            for educational learning. Same analysis on every plan – only watchlist size changes.
          </p>
          <div className="inline-flex flex-col sm:flex-row items-center gap-3 justify-center">
            <Link
              to="/download"
              className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-emerald-500 px-6 py-3 text-sm font-semibold text-white shadow-md shadow-blue-500/20 hover:shadow-lg hover:brightness-105 transition"
            >
              🎁 Start with 1-month free trial
            </Link>
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-[11px] font-medium text-amber-800 text-left">
              ⚠️ SwingSetups is{" "}
              <span className="font-semibold">not SEBI-registered – educational only.</span> We
              do not provide investment advice or portfolio management services.
            </div>
          </div>
        </div>

        {/* ERROR / LOADING */}
        {plansLoading && (
          <div className="text-center py-10">
            <div className="inline-block h-6 w-6 animate-spin rounded-full border-b-2 border-blue-500 mb-3" />
            <p className="text-sm text-slate-600">Loading pricing plans…</p>
          </div>
        )}

        {plansError && !plansLoading && (
          <div className="mb-8 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Couldn&apos;t load plans right now. Please try again later. ({plansError})
          </div>
        )}

        {/* PLANS */}
        {!plansLoading && pricingPlans.length > 0 && (
          <div className="mb-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {pricingPlans.map((plan, index) => {
              const card = formatPlanForCard(plan);

              return (
                <div
                  key={index}
                  className={`relative flex flex-col rounded-3xl bg-white border border-slate-100 shadow-sm hover:shadow-lg transition-shadow duration-200 p-6 sm:p-7 ${card.styles.cardRing}`}
                >
                  {/* badge */}
                  <span
                    className={`absolute right-4 top-4 rounded-full px-3 py-1 text-[10px] font-semibold ${card.styles.badgeBg}`}
                  >
                    {card.badge}
                  </span>

                  <div className="mb-3 text-3xl">{card.emoji}</div>
                  <h3 className="text-lg sm:text-xl font-semibold text-slate-900">
                    {card.name}
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    {card.isTrial
                      ? "Best way to explore SwingSetups"
                      : card.isPopular
                      ? "Most common choice"
                      : card.isBestValue
                      ? "For bigger watchlists"
                      : "For very active users"}
                  </p>

                  <div className="mt-5 mb-4">
                    <div
                      className={`text-3xl font-semibold leading-tight ${card.styles.accentText}`}
                    >
                      {card.price}
                    </div>
                    <div className="text-xs text-slate-500">{card.billing}</div>
                  </div>

                  <div className="mb-5 space-y-2 text-sm">
                    <div className="flex items-center gap-2 text-slate-700">
                      <span className={`${card.styles.accentLight} text-base font-semibold`}>
                        {card.stockLimit}
                      </span>
                      <span className="text-xs text-slate-500">stocks watchlist</span>
                    </div>
                    {card.features?.slice(0, 2).map((feature, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-slate-600">
                        <span className="mt-0.5">✅</span>
                        <span>{feature}</span>
                      </div>
                    ))}
                  </div>

                  <button
                    className="mt-auto w-full rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 transition"
                  >
                    {card.buttonText}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* FEATURES BLOCK – always shown */}
        <div className="mb-10 rounded-3xl bg-white border border-slate-100 shadow-sm p-6 sm:p-8">
          <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-6 text-center">
            What&apos;s included in every plan
          </h2>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="rounded-2xl bg-slate-50 p-5">
              <div className="text-2xl mb-2 text-center">⚡</div>
              <h3 className="text-base font-semibold text-slate-900 mb-1 text-center">
                AI swing setups
              </h3>
              <p className="text-xs text-slate-600 text-center">
                Entry, SL, targets, R:R, expiry window and AI confidence – same analysis for all
                plans.
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-5">
              <div className="text-2xl mb-2 text-center">📱</div>
              <h3 className="text-base font-semibold text-slate-900 mb-1 text-center">
                Optional WhatsApp alerts
              </h3>
              <p className="text-xs text-slate-600 text-center">
                Get notified when new setups are ready or when important changes happen in your
                watchlist.
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-5">
              <div className="text-2xl mb-2 text-center">📊</div>
              <h3 className="text-base font-semibold text-slate-900 mb-1 text-center">
                Watchlist capacity
              </h3>
              <p className="text-xs text-slate-600 text-center">
                Only difference between plans is how many stocks you can track – from a small
                starter watchlist to 30 stocks.
              </p>
            </div>
            <div className="rounded-2xl bg-slate-50 p-5">
              <div className="text-2xl mb-2 text-center">🎯</div>
              <h3 className="text-base font-semibold text-slate-900 mb-1 text-center">
                Cash-market focus
              </h3>
              <p className="text-xs text-slate-600 text-center">
                Short-term swing structures on NSE &amp; BSE cash-market stocks, for educational
                learning.
              </p>
            </div>
          </div>

          <div className="mt-6 rounded-2xl bg-emerald-50 border border-emerald-100 px-4 py-3 text-xs text-emerald-800 text-center">
            💡 Pro tip: Start with the free trial, explore how the AI analysis works with a few
            stocks, then upgrade only if it fits your style.
          </div>
        </div>

        {/* FOOT NOTE */}
        <div className="rounded-2xl bg-slate-900 text-slate-100 px-4 py-4 text-xs sm:text-[11px]">
          <p>
            <span className="font-semibold">ℹ️ Note:</span> Subscriptions renew automatically.
            You can cancel anytime. Payments are processed securely by Cashfree. All prices
            include GST. SwingSetups does not execute orders or manage money – it only provides
            an educational view of price regions.
          </p>
        </div>
      </div>
    </div>
  );
}