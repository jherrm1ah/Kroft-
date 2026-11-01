// Receipts and client statements: what goes on them, worked out from the invoices and their
// payments. No drawing here (that's in pdf.js), so this is easy to test.
//
// A receipt confirms one payment against one invoice. Its number is the invoice number plus
// "-R" and the payment's number on that invoice (INV-0007-R2), given when the payment is
// recorded, so a receipt keeps its number even if another payment is later removed.
//
// A statement lists, for one client and one currency, every invoice and payment in a period,
// with a running balance: what they owed at the start, what was invoiced and paid, and what
// they owe at the end, plus which invoices are still unpaid and how late they are.

import { paymentsOf, invoiceTotals, clientKey, round2, daysBetween } from "./model.js";

// ── Receipts ──
export function receiptNumber(inv, paymentId) {
  const list = paymentsOf(inv);
  const i = list.findIndex(p => p.id === paymentId);
  if (i < 0) return "";
  return `${inv.number}-R${list[i].n || i + 1}`;
}

// Payments in the order they were received (by date, then the order they were recorded).
const byDate = list => list.map((p, i) => ({ p, i })).sort((a, b) => String(a.p.date).localeCompare(String(b.p.date)) || a.i - b.i).map(x => x.p);

export function receiptFor(inv, paymentId) {
  const list = paymentsOf(inv);
  const payment = list.find(p => p.id === paymentId);
  if (!payment) return null;
  const ordered = byDate(list);
  const before = ordered.slice(0, ordered.findIndex(p => p.id === paymentId));
  const paidBefore = round2(before.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const total = invoiceTotals(inv).total;
  const amount = round2(payment.amount);
  const balanceAfter = Math.max(0, round2(total - paidBefore - amount));
  return {
    number: receiptNumber(inv, paymentId),
    date: payment.date,
    amount, total, paidBefore, balanceAfter,
    paidInFull: balanceAfter <= 0,
    currency: inv.currency,
    invoiceNumber: inv.number,
    invoiceDate: inv.issueDate,
    client: inv.client || {},
  };
}

export function receiptMessage(r, fmt, from = "") {
  const who = r.client?.name ? `Hi ${r.client.name.split(/\s+/)[0]},` : "Hello,";
  return [
    who,
    `Thank you for your payment of ${fmt(r.amount, r.currency)} for invoice ${r.invoiceNumber}. Here's your receipt (${r.number}).`,
    r.paidInFull ? "The invoice is now paid in full." : `${fmt(r.balanceAfter, r.currency)} is still due on the invoice.`,
    from ? `\n${from}` : "",
  ].filter(Boolean).join("\n");
}

// ── Statements ──
// Invoices that count: sent to the client (not drafts or cancelled ones), not quotes.
const counts = inv => inv.kind !== "quote" && inv.status !== "draft" && inv.status !== "cancelled";

// The currencies a client has been invoiced in, most used first.
export function statementCurrencies(invoices, key) {
  const n = {};
  for (const inv of invoices) if (counts(inv) && clientKey(inv) === key) n[inv.currency] = (n[inv.currency] || 0) + 1;
  return Object.keys(n).sort((a, b) => n[b] - n[a]);
}

// from: first day included (null = from the start); to: the statement date (included).
export function statementFor({ invoices, key, currency, from = null, to }) {
  const docs = invoices.filter(inv => counts(inv) && clientKey(inv) === key && inv.currency === currency);
  const events = [];
  for (const inv of docs) {
    events.push({ date: inv.issueDate, kind: "invoice", ref: inv.number, details: `Invoice ${inv.number}`, charge: invoiceTotals(inv).total, paid: 0, order: 0 });
    for (const p of paymentsOf(inv)) {
      events.push({ date: p.date, kind: "payment", ref: inv.number, details: `Payment, invoice ${inv.number}`, charge: 0, paid: round2(p.amount), order: 1 });
    }
  }
  events.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.order - b.order || a.ref.localeCompare(b.ref));
  const upTo = events.filter(e => e.date <= to);
  const opening = round2(upTo.filter(e => from && e.date < from).reduce((s, e) => s + e.charge - e.paid, 0));
  let balance = opening;
  const lines = upTo.filter(e => !from || e.date >= from).map(e => {
    balance = round2(balance + e.charge - e.paid);
    return { date: e.date, kind: e.kind, details: e.details, charge: e.charge, paid: e.paid, balance };
  });
  const invoiced = round2(lines.reduce((s, l) => s + l.charge, 0));
  const paid = round2(lines.reduce((s, l) => s + l.paid, 0));

  // What's still unpaid on the statement date, oldest first.
  const unpaid = docs.filter(inv => inv.issueDate <= to).map(inv => {
    const paidBy = paymentsOf(inv).filter(p => p.date <= to).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const due = Math.max(0, round2(invoiceTotals(inv).total - paidBy));
    const late = inv.dueDate && inv.dueDate < to ? daysBetween(inv.dueDate, to) : 0;
    return { number: inv.number, issueDate: inv.issueDate, dueDate: inv.dueDate, total: invoiceTotals(inv).total, due, daysOverdue: late };
  }).filter(u => u.due > 0).sort((a, b) => String(a.issueDate).localeCompare(String(b.issueDate)) || a.number.localeCompare(b.number));
  const overdue = round2(unpaid.filter(u => u.daysOverdue > 0).reduce((s, u) => s + u.due, 0));

  return { currency, from, to, opening, lines, invoiced, paid, closing: round2(opening + invoiced - paid), unpaid, overdue, client: docs[0]?.client || {} };
}

export function statementMessage(st, fmt, name = "", from = "") {
  const who = name ? `Hi ${name.split(/\s+/)[0]},` : "Hello,";
  const owed = st.closing > 0
    ? `The balance on your account is ${fmt(st.closing, st.currency)}${st.overdue > 0 ? `, of which ${fmt(st.overdue, st.currency)} is overdue` : ""}.`
    : "Your account is fully paid. Thank you!";
  return [who, "Here's your statement of account.", owed, from ? `\n${from}` : ""].filter(Boolean).join("\n");
}

// Start of the period for the statement's period choices.
export function periodStart(period, today) {
  if (period === "year") return `${today.slice(0, 4)}-01-01`;
  if (period === "90") {
    const [y, m, d] = today.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d - 89));
    return dt.toISOString().slice(0, 10);
  }
  return null;
}

// Plain ASCII file names (see invoiceFileName).
const ascii = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, "").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim();
export const receiptFileName = r => `${ascii(`Receipt ${r.number}${r.client?.name ? ` ${r.client.name}` : ""}`)}.pdf`;
export const statementFileName = (name, to) => `${ascii(`Statement ${name || ""} ${to}`)}.pdf`;
