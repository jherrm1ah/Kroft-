// Tests what a contact's profile shows (src/contacts/profile.js). Run with: npm test
import * as P from "./profile.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };
const fmt = (n, cur) => `${cur} ${Number(n).toLocaleString("en-US")}`;
const today = "2026-11-02";

eq("initials", [P.initials("Tunde Bakare"), P.initials("ada"), P.initials(" Chidi  Okafor Jr "), P.initials("")], ["TB", "A", "CJ", "?"]);
eq("email inside a From line", [P.emailIn("Tunde <TUNDE@x.com>"), P.emailIn("ada@y.ng"), P.emailIn("Tunde")], ["tunde@x.com", "ada@y.ng", ""]);
eq("relative days", [P.relativeDay(today, today), P.relativeDay("2026-11-01", today), P.relativeDay("2026-11-03", today), P.relativeDay("2026-10-29", today), P.relativeDay("2026-10-12", today), P.relativeDay("2026-11-05", today)],
  ["today", "yesterday", "tomorrow", "4 days ago", "3 weeks ago", "in 3 days"]);

const tunde = { id: 7, name: "Tunde Bakare", email: "tunde@x.com", phone: "0803", category: "business", role: "Marketing manager", company: "Ọlá Foods", birthday: "1990-11-12",
  log: [{ id: 1, type: "call", at: "2026-10-30T10:00:00Z" }] };
const inv = (o) => ({ currency: "NGN", issueDate: "2026-10-01", items: [{ description: "x", qty: 1, price: o.price }], ...o });
const data = {
  tasks: [{ id: 1, title: "Send logo files", done: false, contactId: 7 }, { id: 2, title: "Old", done: true, contactId: 7 }, { id: 3, title: "Someone else", contactId: 8 }],
  reminders: [{ id: 1, text: "Chase Tunde", done: false, contactId: 7 }],
  appts: [{ id: 1, title: "Brand review", date: "2026-11-04", time: "10:00", contactId: 7 }, { id: 2, title: "Kick-off", date: "2026-10-31", contactId: 7 }, { id: 3, title: "Other", date: "2026-11-04", contactId: 9 }],
  notes: [{ id: 1, title: "Prefers WhatsApp", contactId: 7 }],
  files: [],
  emails: [{ id: 1, from: "Tunde Bakare <tunde@x.com>", subject: "Logo", read: false }, { id: 2, from: "other@y.com", subject: "x", read: true }],
  invoices: [
    inv({ id: "a", clientId: 7, client: { name: "Tunde Bakare" }, status: "sent", dueDate: "2026-10-20", price: 50000 }),
    inv({ id: "b", client: { name: "tunde bakare" }, status: "paid", paidDate: "2026-10-05", price: 20000 }),
    inv({ id: "c", clientId: 8, client: { name: "Tunde Bakare" }, status: "sent", dueDate: "2026-12-01", price: 99 }),
  ],
  quotes: [{ kind: "quote", id: "q", clientId: 7, client: { name: "Tunde" }, status: "sent", validUntil: "2026-12-01", currency: "NGN", items: [{ description: "Site", qty: 1, price: 300000 }] }],
};
const r = P.contactRecords(tunde, data, today);
eq("only this contact's records", [r.tasks.length, r.reminders.length, r.upcoming.map(a => a.title), r.past.map(a => a.title), r.notes.length, r.emails.length], [2, 1, ["Brand review"], ["Kick-off"], 1, 1]);
eq("invoices by link, and older ones by name, but not another contact's", r.invoices.map(i => i.id), ["a", "b"]);
const m = P.contactMoney(r, today);
eq("money: owed, paid, overdue, open quotes", [m.owed, m.paid, m.overdue, m.openQuotes, m.quoted], [{ NGN: 50000 }, { NGN: 20000 }, 1, 1, { NGN: 300000 }]);

const lines = P.contactSummary(tunde, r, m, today, fmt);
eq("what KROFT knows, in order", lines, [
  "Tunde is a Marketing manager at Ọlá Foods.",
  "Owes you NGN 50,000 (1 invoice overdue).",
  "Has paid you NGN 20,000 across 2 invoices.",
  "1 open quote worth NGN 300,000.",
  "Next: Brand review, in 2 days at 10:00.",
  "You last met (Kick-off) 2 days ago.",
  "1 open task and 1 reminder for Tunde.",
  "1 email from Tunde in your inbox, 1 unread.",
  "1 note saved about Tunde.",
  "Tunde's birthday is in 10 days.",
]);
eq("an article that fits the role", P.contactSummary({ name: "Ada", role: "accountant" }, P.contactRecords({ id: 1, name: "Ada" }, {}, today), P.contactMoney(P.contactRecords({ id: 1, name: "Ada" }, {}, today), today), today, fmt)[0], "Ada is an accountant.");
eq("nothing known: no sentences", P.contactSummary({ id: 2, name: "New Person" }, P.contactRecords({ id: 2, name: "New Person" }, {}, today), P.contactMoney(P.contactRecords({ id: 2, name: "New Person" }, {}, today), today), today, fmt), []);
eq("birthday today", P.contactSummary({ name: "Bisi", birthday: "1995-11-02" }, P.contactRecords({ id: 3, name: "Bisi" }, {}, today), { owed: {}, paid: {}, quoted: {}, overdue: 0, openQuotes: 0 }, today, fmt), ["It's Bisi's birthday today."]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
