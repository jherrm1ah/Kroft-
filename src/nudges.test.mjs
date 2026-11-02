// Tests the upgrade nudges. Run with: npm test
import { pickNudge, markShown, markClosed, nudgePlace, emptyNudgeState, NUDGES, GAP_MS, SNOOZE_MS, MAX_SHOWS } from "./nudges.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };

const now = Date.UTC(2026, 10, 2, 12);
const busy = { chatTurns: 8, invoicesThisMonth: 2, entries: 12, sentInvoices: 4, projects: 3 };
const id = args => pickNudge({ now, facts: busy, ...args })?.id || null;

eq("Free in the chat, after a real conversation: Plus", id({ plan: "free", place: "chat" }), "plus-chat");
eq("Free, not yet using the chat much: nothing", pickNudge({ plan: "free", place: "chat", facts: { chatTurns: 2 }, now }), null);
eq("Free in Invoices near the monthly limit: Plus", id({ plan: "free", place: "invoices" }), "plus-invoices");
eq("Free in Finance with plenty of entries: Plus", id({ plan: "free", place: "finance" }), "plus-finance");
eq("Plus in Invoices, sending invoices: Pro", id({ plan: "plus", place: "invoices" }), "pro-invoices");
eq("Plus in Projects with several projects: Pro", id({ plan: "plus", place: "projects" }), "pro-projects");
eq("Plus is never offered Plus", id({ plan: "plus", place: "chat" }), null);
eq("Pro never sees a nudge", ["chat", "invoices", "finance", "projects"].map(place => id({ plan: "pro", place })), [null, null, null, null]);
eq("nowhere else", id({ plan: "free", place: null }), null);

let s = markShown(emptyNudgeState(), "plus-chat", now);
eq("at most one a day", id({ plan: "free", place: "invoices", state: s }), null);
eq("…and the next day another can show", pickNudge({ plan: "free", place: "invoices", facts: busy, state: s, now: now + GAP_MS })?.id, "plus-invoices");

s = markClosed(s, "plus-chat", now);
eq("closed: stays away for two weeks", pickNudge({ plan: "free", place: "chat", facts: busy, state: s, now: now + GAP_MS })?.id || null, null);
eq("…then may come back", pickNudge({ plan: "free", place: "chat", facts: busy, state: s, now: now + SNOOZE_MS })?.id, "plus-chat");

let many = emptyNudgeState();
for (let i = 0; i < MAX_SHOWS; i++) many = markShown(many, "plus-chat", now - (i + 1) * SNOOZE_MS * 2);
eq(`never more than ${MAX_SHOWS} times in all`, pickNudge({ plan: "free", place: "chat", facts: busy, state: many, now })?.id || null, null);

eq("places", [
  nudgePlace({ tab: "home", homeSection: "overview" }), nudgePlace({ tab: "home", homeSection: "finance" }),
  nudgePlace({ tab: "nova" }), nudgePlace({ tab: "workspace", workspaceSection: "projects" }),
  nudgePlace({ tab: "workspace", workspaceSection: "tasks" }), nudgePlace({ tab: "home", homeSection: "finance", invoicesOpen: true }),
], [null, "finance", "chat", "projects", null, "invoices"]);
eq("every nudge has a title, a line, a button and a plan to go to", NUDGES.every(n => n.title && n.body && n.cta && ["plus", "pro"].includes(n.to) && ["free", "plus"].includes(n.for)), true);
eq("Free nudges lead to Plus, Plus nudges to Pro", NUDGES.every(n => (n.for === "free" ? n.to === "plus" : n.to === "pro")), true);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
