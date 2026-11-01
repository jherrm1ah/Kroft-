// What KROFT knows about a contact: everything linked to them, gathered in one place for their
// profile page (and the sentences of its summary). Pure functions over KROFT's own data, so the
// profile never states anything that isn't actually recorded; tested in profile.test.mjs.

import { clientKey, invoiceStatus, quoteStatus, invoiceTotals, amountPaid, balanceDue } from "../invoices/model.js";

const lower = s => String(s || "").trim().toLowerCase();

// An email address inside a "Name <address>" string, or the string itself.
export const emailIn = s => (String(s || "").match(/[^\s<>"]+@[^\s<>"]+/) || [""])[0].toLowerCase();

export function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

// Everything linked to one contact.
export function contactRecords(contact, { tasks = [], reminders = [], appts = [], notes = [], files = [], emails = [], invoices = [], quotes = [] }, today) {
  const id = contact.id;
  const linked = x => x.contactId != null && String(x.contactId) === String(id);
  // Invoices and quotes: linked by clientId, or (older ones) by the same client name.
  const nameKey = `name:${lower(contact.name)}`;
  const mine = d => (d.clientId != null ? String(d.clientId) === String(id) : clientKey(d) === nameKey);
  const address = lower(contact.email);
  const myEmails = address ? emails.filter(e => emailIn(e.from) === address || lower(e.from).includes(address)) : [];
  const myAppts = appts.filter(linked).slice().sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  return {
    tasks: tasks.filter(linked),
    reminders: reminders.filter(linked),
    upcoming: myAppts.filter(a => (a.date || "") >= today),
    past: myAppts.filter(a => (a.date || "") < today).reverse(),
    notes: notes.filter(linked),
    files: files.filter(linked),
    emails: myEmails,
    invoices: invoices.filter(mine),
    quotes: quotes.filter(mine),
    log: contact.log || [],
  };
}

// Money: what they owe, what they've paid, open quotes. Amounts by currency.
export function contactMoney(records, today) {
  const owed = {}, paid = {}, quoted = {};
  let overdue = 0, unpaid = 0;
  for (const inv of records.invoices) {
    const st = invoiceStatus(inv, today);
    if (["sent", "overdue", "partial"].includes(st)) { owed[inv.currency] = (owed[inv.currency] || 0) + balanceDue(inv); unpaid++; }
    if (st === "overdue") overdue++;
    const p = amountPaid(inv);
    if (p) paid[inv.currency] = (paid[inv.currency] || 0) + p;
  }
  let openQuotes = 0;
  for (const q of records.quotes) {
    if (["draft", "sent", "accepted"].includes(quoteStatus(q, today))) { openQuotes++; quoted[q.currency] = (quoted[q.currency] || 0) + invoiceTotals(q).total; }
  }
  return { owed, paid, quoted, overdue, unpaid, openQuotes };
}

export function relativeDay(iso, today) {
  if (!iso) return "";
  const d = Math.round((new Date(`${today}T00:00:00`) - new Date(`${iso.slice(0, 10)}T00:00:00`)) / 86400000);
  if (d === 0) return "today";
  if (d === 1) return "yesterday";
  if (d === -1) return "tomorrow";
  if (d > 1 && d < 7) return `${d} days ago`;
  if (d > 1 && d < 60) return `${Math.round(d / 7)} week${Math.round(d / 7) === 1 ? "" : "s"} ago`;
  if (d > 1) return `${Math.round(d / 30)} months ago`;
  if (d < -1 && d > -7) return `in ${-d} days`;
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const sumText = (byCur, fmt) => Object.entries(byCur).filter(([, v]) => v > 0).map(([cur, v]) => fmt(v, cur)).join(" + ");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// The "What KROFT knows" sentences, most useful first. Only facts from the records.
export function contactSummary(contact, records, money, today, fmt) {
  const lines = [];
  const first = (contact.name || "They").split(/\s+/)[0];
  const role = [contact.role, contact.company].filter(Boolean).join(" at ");
  if (role) lines.push(`${first} is ${/^[aeiou]/i.test(role) ? "an" : "a"} ${role}.`);

  const owed = sumText(money.owed, fmt), paid = sumText(money.paid, fmt), quoted = sumText(money.quoted, fmt);
  if (owed) lines.push(`Owes you ${owed}${money.overdue ? ` (${plural(money.overdue, "invoice")} overdue)` : ""}.`);
  if (paid) lines.push(`Has paid you ${paid} across ${plural(records.invoices.length, "invoice")}.`);
  if (money.openQuotes) lines.push(`${plural(money.openQuotes, "open quote")} worth ${quoted}.`);

  const next = records.upcoming[0];
  if (next) lines.push(`Next: ${next.title}, ${relativeDay(next.date, today)}${next.time ? ` at ${next.time}` : ""}.`);

  // Last contact: a call or email placed from KROFT, an email from them, or a past meeting.
  const touches = [
    ...records.log.map(l => ({ at: l.at, what: l.type === "call" ? "called them" : "emailed them" })),
    ...records.past.slice(0, 1).map(a => ({ at: a.date, what: `met (${a.title})` })),
  ].filter(t => t.at).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (touches[0]) lines.push(`You last ${touches[0].what} ${relativeDay(String(touches[0].at), today)}.`);

  const openTasks = records.tasks.filter(t => !t.done).length, openRem = records.reminders.filter(r => !r.done).length;
  if (openTasks || openRem) lines.push(`${[openTasks && plural(openTasks, "open task"), openRem && plural(openRem, "reminder")].filter(Boolean).join(" and ")} for ${first}.`);
  if (records.emails.length) lines.push(`${plural(records.emails.length, "email")} from ${first} in your inbox${records.emails.some(e => !e.read) ? `, ${records.emails.filter(e => !e.read).length} unread` : ""}.`);
  if (records.notes.length || records.files.length) lines.push(`${[records.notes.length && plural(records.notes.length, "note"), records.files.length && plural(records.files.length, "file")].filter(Boolean).join(" and ")} saved about ${first}.`);

  if (contact.birthday) {
    const [, m, d] = contact.birthday.split("-").map(Number);
    const y = Number(today.slice(0, 4));
    let next = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (next < today) next = `${y + 1}-${next.slice(5)}`;
    const days = Math.round((new Date(`${next}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000);
    if (days <= 30) lines.push(days === 0 ? `It's ${first}'s birthday today.` : `${first}'s birthday is ${days === 1 ? "tomorrow" : `in ${days} days`}.`);
  }
  return lines;
}
