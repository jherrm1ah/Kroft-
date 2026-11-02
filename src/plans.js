// KROFT's plans: Free, Plus and Pro, with their prices and what each includes. Shown whenever
// someone taps Upgrade (the plan picker in Kroft.jsx), so it's one place to change.
//
// Prices are shown in naira for people whose currency is NGN, otherwise in US dollars. Payment
// is through Google (see PAYMENTS_READY): until that's connected, picking a paid plan says so
// instead of taking anyone to a checkout.
//
// "soon" marks something that's planned but not built yet, so the page never promises a feature
// as if it already works.

export const PAYMENTS_READY = false;   // turn on once Google payments are connected

export const PRICES = {
  NGN: { plus: { month: 3500, year: 35000 }, pro: { month: 9500, year: 95000 } },
  USD: { plus: { month: 4.99, year: 49.99 }, pro: { month: 12.99, year: 129.99 } },
};

export const PLANS = [
  {
    id: "free", name: "Free", tagline: "Run your money and a side business.",
    features: [
      "Finances, budgets, bills and receipts",
      "Contacts, notes, tasks and reminders",
      "Chat with KROFT's AI",
      "3 invoices and 3 quotes a month",
      "30 voice turns a day",
    ],
  },
  {
    id: "plus", name: "Plus", tagline: "For freelancers and solo businesses.", popular: true,
    features: [
      "Everything in Free",
      "Unlimited invoices and quotes",
      "Payment reminders to clients",
      "Client statements",
      "Unlimited voice",
      "No daily AI limits (fair use)",
      "Morning summary and reminder calls",
      "Longer memory and budget rollover",
    ],
  },
  {
    id: "pro", name: "Pro", tagline: "For a business with projects and many clients.",
    features: [
      "Everything in Plus",
      { t: "Projects with milestones", soon: true },
      { t: "Your logo on invoices, no KROFT footer", soon: true },
      { t: "Recurring invoices", soon: true },
      { t: "Bank statement import", soon: true },
      "Priority support",
    ],
  },
];

export const priceCurrency = userCurrency => (userCurrency === "NGN" ? "NGN" : "USD");

// { amount, currency } for a paid plan, or null for Free.
export function planPrice(planId, period, userCurrency) {
  const cur = priceCurrency(userCurrency);
  const p = PRICES[cur][planId];
  return p ? { amount: p[period], currency: cur } : null;
}

// How much a year costs compared with paying monthly: whole months saved (2 for 35,000 vs 3,500).
export function monthsFree(planId, userCurrency) {
  const p = PRICES[priceCurrency(userCurrency)][planId];
  return p ? Math.round((p.month * 12 - p.year) / p.month) : 0;
}

// The plan someone is on now. There's one paid subscription today (Plus); Pro comes with Google
// payments.
export const currentPlan = ({ subscribed, plan }) => (plan === "pro" ? "pro" : subscribed ? "plus" : "free");

export const featureText = f => (typeof f === "string" ? f : f.t);
