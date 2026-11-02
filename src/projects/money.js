// The business side of a project (Workspace › Projects): who it's for, what it's worth,
// milestones with due dates and amounts, invoicing a milestone, and the project's money
// (invoiced, paid, still to invoice, spent, profit). Nothing here touches the screen or storage.
//
// A project (older ones have only the first line):
//   { id, name, status, deadline, description, milestones, taskIds, …, expenseIds, incomeIds,
//     clientName, clientId, value, currency }
// A milestone: { id, title, done, dueDate?, amount?, invoiceId?, doneDate? }
// An invoice made from a milestone carries projectId and milestoneId.

import { invoiceTotals, amountPaid, invoiceStatus, round2 } from "../invoices/model.js";

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const dayNumber = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
const daysUntil = (today, d) => Math.round(dayNumber(d) - dayNumber(today));

// Invoices that belong to the project: made from one of its milestones, or linked to it.
export const projectInvoices = (project, invoices) => invoices.filter(inv => inv.projectId === project.id && inv.status !== "cancelled");

export function projectMoney({ project, invoices = [], income = [], expenses = [] }) {
  const invs = projectInvoices(project, invoices).filter(inv => inv.status !== "draft");
  const invoiced = round2(invs.reduce((s, inv) => s + invoiceTotals(inv).total, 0));
  const paidOnInvoices = round2(invs.reduce((s, inv) => s + amountPaid(inv), 0));
  // Income linked to the project by hand, leaving out entries that are payments on the
  // project's own invoices (counted above already).
  const ownInvoiceIds = new Set(invs.map(inv => String(inv.id)));
  const linkedIncome = income.filter(x => (project.incomeIds || []).includes(x.id) && !ownInvoiceIds.has(String(x.invoiceId)));
  const otherIncome = round2(linkedIncome.reduce((s, x) => s + (Number(x.amount) || 0), 0));
  const spent = round2(expenses.filter(x => (project.expenseIds || []).includes(x.id)).reduce((s, x) => s + (Number(x.amount) || 0), 0));
  const value = round2(project.value || 0);
  const earned = round2(paidOnInvoices + otherIncome);
  return {
    value, invoiced, paid: paidOnInvoices, earned, spent,
    owed: round2(invoiced - paidOnInvoices),
    toInvoice: value ? Math.max(0, round2(value - invoiced)) : 0,
    profit: round2(earned - spent),
  };
}

// "done", "overdue", "soon" (within 7 days), "due" or "" (no date).
export function milestoneState(m, today) {
  if (m.done) return "done";
  if (!isDate(m.dueDate)) return "";
  const d = daysUntil(today, m.dueDate);
  return d < 0 ? "overdue" : d <= 7 ? "soon" : "due";
}

export function milestoneWhen(m, today, prettyDate = d => d) {
  if (!isDate(m.dueDate)) return "";
  if (m.done) return `Due ${prettyDate(m.dueDate)}`;
  const d = daysUntil(today, m.dueDate);
  if (d < 0) return `${-d} day${d === -1 ? "" : "s"} overdue`;
  if (d === 0) return "Due today";
  if (d === 1) return "Due tomorrow";
  return d <= 7 ? `Due in ${d} days` : `Due ${prettyDate(m.dueDate)}`;
}

// The invoice behind a milestone, and how it stands: { invoice, status } or null.
export function milestoneInvoice(m, invoices, today) {
  if (!m.invoiceId) return null;
  const invoice = invoices.find(inv => String(inv.id) === String(m.invoiceId));
  return invoice ? { invoice, status: invoiceStatus(invoice, today) } : null;
}

// Why a milestone can't be invoiced yet, or "" when it can.
export function milestoneInvoiceProblem(project, m) {
  if (!String(project.clientName || "").trim()) return "Add who the project is for first (Edit the project).";
  if (!(Number(m.amount) > 0)) return "Add an amount to the milestone first.";
  return "";
}

// What goes on a milestone's invoice: one line, "<project> — <milestone>".
export const milestoneInvoiceItems = (project, m) => [{ description: `${project.name} — ${m.title}`, qty: 1, price: round2(m.amount) }];

// Phone reminders at 9am on the day a milestone is due (not done ones).
export function milestoneReminders(projects, today, now) {
  const out = [];
  for (const p of projects) {
    if (p.status === "Completed") continue;
    for (const m of p.milestones || []) {
      if (m.done || !isDate(m.dueDate) || m.dueDate < today) continue;
      const fires = new Date(`${m.dueDate}T09:00:00`);
      if (fires.getTime() <= now) continue;
      out.push({ clientKey: `milestone:${m.id}`, firesAt: fires.toISOString(), title: `Milestone due today: ${m.title}`, body: p.name });
    }
  }
  return out;
}

// One line per project for KROFT's AI.
export function projectLineForAI(p, invoices, today, fmt) {
  const ms = p.milestones || [];
  const done = ms.filter(m => m.done).length;
  const next = ms.filter(m => !m.done && isDate(m.dueDate)).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
  const money = projectMoney({ project: p, invoices });
  const cur = p.currency || "";
  return [
    `${p.name} — ${p.status}${p.deadline ? `, due ${p.deadline}` : ""}`,
    p.clientName ? `for ${p.clientName}` : "",
    ms.length ? `${done}/${ms.length} milestones done` : "",
    next ? `next: ${next.title} due ${next.dueDate}${milestoneState(next, today) === "overdue" ? " (OVERDUE)" : ""}` : "",
    p.value && cur ? `worth ${fmt(p.value, cur)}, invoiced ${fmt(money.invoiced, cur)}, paid ${fmt(money.paid, cur)}` : "",
  ].filter(Boolean).join(", ");
}
