// Upgrade nudges: a small card that appears at the moment a paid plan would actually help, with
// a button to see the plans and an X to close it. Free users are shown what Plus adds, Plus users
// what Pro adds; Pro users never see one.
//
// They're kept rare so they help rather than nag:
//   - at most one a day (GAP_MS between any two);
//   - each nudge only where it's relevant (place) and once the person is clearly using that part
//     of KROFT (when);
//   - closing one keeps it away for SNOOZE_MS, and a nudge is never shown more than MAX_SHOWS
//     times in all.
//
// Plain functions so they can be tested. The record of what was shown is kept on the device
// (it's a convenience, not account data).

export const GAP_MS = 20 * 3600 * 1000;           // about a day between any two nudges
export const SNOOZE_MS = 14 * 24 * 3600 * 1000;   // a closed nudge stays away two weeks
export const MAX_SHOWS = 3;

export const NUDGES = [
  // Free → Plus
  {
    id: "plus-chat", for: "free", place: "chat", to: "plus",
    title: "Get more from KROFT's AI",
    body: "Upgrade to Plus for unlimited voice, no daily AI limits and a memory three times longer.",
    cta: "Get Plus",
    when: f => f.chatTurns >= 6,
  },
  {
    id: "plus-invoices", for: "free", place: "invoices", to: "plus",
    title: "Running a business on KROFT?",
    body: "Upgrade to Plus for unlimited invoices and quotes, payment reminders and client statements.",
    cta: "Get Plus",
    when: f => f.invoicesThisMonth >= 2,
  },
  {
    id: "plus-finance", for: "free", place: "finance", to: "plus",
    title: "Let your money plan itself",
    body: "Upgrade to Plus so unused budget carries into next month, with a morning summary of your day.",
    cta: "Get Plus",
    when: f => f.entries >= 10,
  },
  // Plus → Pro
  {
    id: "pro-invoices", for: "plus", place: "invoices", to: "pro",
    title: "Put your brand on every invoice",
    body: "Upgrade to Pro to add your logo to invoices, quotes, receipts and statements, without the KROFT line.",
    cta: "Upgrade to Pro",
    when: f => f.sentInvoices >= 3,
  },
  {
    id: "pro-projects", for: "plus", place: "projects", to: "pro",
    title: "Bring KROFT to your biggest clients",
    body: "Upgrade to Pro for your logo on every document and priority support when you need help.",
    cta: "Upgrade to Pro",
    when: f => f.projects >= 2,
  },
];

export const emptyNudgeState = () => ({ lastShownAt: 0, shows: {}, closedAt: {} });

// The nudge to show here and now, or null.
export function pickNudge({ plan, place, facts = {}, state = emptyNudgeState(), now = Date.now() }) {
  if (!place || plan === "pro") return null;
  if (now - (state.lastShownAt || 0) < GAP_MS) return null;
  return NUDGES.find(n =>
    n.for === plan && n.place === place &&
    (state.shows?.[n.id] || 0) < MAX_SHOWS &&
    now - (state.closedAt?.[n.id] || 0) >= SNOOZE_MS &&
    n.when(facts)
  ) || null;
}

export const markShown = (state, id, now = Date.now()) =>
  ({ ...state, lastShownAt: now, shows: { ...state.shows, [id]: (state.shows?.[id] || 0) + 1 } });

export const markClosed = (state, id, now = Date.now()) =>
  ({ ...state, closedAt: { ...state.closedAt, [id]: now } });

// Where the person is in KROFT, as a nudge place (or null where nudges never appear).
export function nudgePlace({ tab, homeSection, workspaceSection, invoicesOpen }) {
  if (invoicesOpen) return "invoices";
  if (tab === "nova") return "chat";
  if (tab === "home" && homeSection === "finance") return "finance";
  if (tab === "workspace" && workspaceSection === "projects") return "projects";
  return null;
}
