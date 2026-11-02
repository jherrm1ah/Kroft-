// Supplier bills: money the business owes. A bill is what a supplier charged (amount, their
// reference, when it's due); paying it, in full or in parts, records each payment as an expense,
// the same way getting paid for an invoice records income. Nothing here touches the screen or
// storage, so it's easy to test.
//
// A bill: { id, supplier, supplierId, ref, description, amount, currency, category, billDate,
//           dueDate, notes, status: "open" | "cancelled", payments: [{ id, amount, date,
//           expenseId }], createdAt }
// Whether it's paid, part paid, due or overdue is worked out from its payments and dates, never
// stored, so it can't go stale.

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const addDays = (iso, days) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const dayNumber = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
const daysBetween = (a, b) => Math.round(dayNumber(b) - dayNumber(a));
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

export const BILL_STATUS_LABEL = { due: "To pay", soon: "Due soon", overdue: "Overdue", partial: "Part paid", paid: "Paid", cancelled: "Cancelled" };
export const DUE_SOON_DAYS = 7;

export function createBill({ supplier, supplierId = null, ref = "", description = "", amount, currency, category = "", billDate, dueDate, notes = "", today, id }) {
  // No bill date given: today, or the due date if that's already passed (an overdue bill).
  const issued = isDate(billDate) ? billDate : isDate(dueDate) && dueDate < today ? dueDate : today;
  return {
    id,
    supplier: String(supplier || "").trim(),
    supplierId,
    ref: String(ref || "").trim(),
    description: String(description || "").trim(),
    amount: round2(amount),
    currency,
    category: String(category || "").trim(),
    billDate: issued,
    dueDate: isDate(dueDate) ? dueDate : issued,
    notes: String(notes || "").trim(),
    status: "open",
    payments: [],
    createdAt: today,
  };
}

// What's wrong with a bill before it can be saved, or "" if nothing.
export function billProblem(b) {
  if (!String(b.supplier || "").trim()) return "Add who the bill is from.";
  if (!(Number(b.amount) > 0)) return "Enter the amount of the bill.";
  if (isDate(b.dueDate) && isDate(b.billDate) && b.dueDate < b.billDate) return "The due date can't be before the bill date.";
  if (Number(b.amount) + 0.005 < billPaid(b)) return "The amount can't be less than what's already been paid.";
  return "";
}

export const billPayments = b => (Array.isArray(b.payments) ? b.payments : []);
export const billPaid = b => round2(billPayments(b).reduce((s, p) => s + (Number(p.amount) || 0), 0));
export const billBalance = b => Math.max(0, round2((Number(b.amount) || 0) - billPaid(b)));

export function billStatus(b, today) {
  if (b.status === "cancelled") return "cancelled";
  if (billBalance(b) <= 0) return "paid";
  if (b.dueDate && b.dueDate < today) return "overdue";
  if (billPaid(b) > 0) return "partial";
  if (b.dueDate && daysBetween(today, b.dueDate) <= DUE_SOON_DAYS) return "soon";
  return "due";
}
export const billIsOpen = (b, today) => ["due", "soon", "overdue", "partial"].includes(billStatus(b, today));

// "Due today", "Due in 3 days", "4 days overdue", "Paid 3 Nov"…
export function billWhen(b, today, prettyDate = d => d) {
  const st = billStatus(b, today);
  if (st === "cancelled") return "Cancelled";
  if (st === "paid") { const last = billPayments(b).reduce((d, p) => (p.date > d ? p.date : d), ""); return `Paid ${prettyDate(last)}`; }
  const days = daysBetween(today, b.dueDate);
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return days <= DUE_SOON_DAYS ? `Due in ${days} days` : `Due ${prettyDate(b.dueDate)}`;
}

export function recordBillPayment(b, { id, amount, date, expenseId }) {
  return { ...b, payments: [...billPayments(b), { id, amount: round2(amount), date, expenseId: expenseId || null }] };
}
export function removeBillPayment(b, paymentId) {
  return { ...b, payments: billPayments(b).filter(p => p.id !== paymentId) };
}

// Each payment is an expense entry. When that entry is edited (amount, date) or deleted elsewhere
// in KROFT, the bill follows. Returns the same array when nothing changed.
export function syncBillsWithExpenses(bills, expenses) {
  const byId = new Map(expenses.map(e => [String(e.id), e]));
  let changed = false;
  const out = bills.map(b => {
    const pays = billPayments(b);
    if (!pays.length) return b;
    let touched = false;
    const next = [];
    for (const p of pays) {
      if (!p.expenseId) { next.push(p); continue; }
      const e = byId.get(String(p.expenseId));
      if (!e) { touched = true; continue; }
      const amount = round2(e.amount), date = e.date || p.date;
      if (amount !== p.amount || date !== p.date) { touched = true; next.push({ ...p, amount, date }); }
      else next.push(p);
    }
    if (!touched) return b;
    changed = true;
    return { ...b, payments: next };
  });
  return changed ? out : bills;
}

// Totals for the top of the Bills screen and Finance: what's owed (per currency), how much is
// overdue, what falls due in the next 7 days.
export function billsSummary(bills, today) {
  const owed = {}, overdue = {}, soon = {};
  let overdueCount = 0, soonCount = 0, openCount = 0;
  for (const b of bills) {
    const st = billStatus(b, today);
    if (!billIsOpen(b, today)) continue;
    const bal = billBalance(b);
    openCount++;
    owed[b.currency] = round2((owed[b.currency] || 0) + bal);
    if (st === "overdue") { overdueCount++; overdue[b.currency] = round2((overdue[b.currency] || 0) + bal); }
    else if (daysBetween(today, b.dueDate) <= DUE_SOON_DAYS) { soonCount++; soon[b.currency] = round2((soon[b.currency] || 0) + bal); }
  }
  return { owed, overdue, soon, overdueCount, soonCount, openCount };
}

// Who you owe, most first: { name, owed: {cur: n}, count, overdueCount }.
export function supplierSummaries(bills, today) {
  const by = new Map();
  for (const b of bills) {
    if (!billIsOpen(b, today)) continue;
    const key = b.supplierId ? `id:${b.supplierId}` : `name:${b.supplier.toLowerCase()}`;
    if (!by.has(key)) by.set(key, { key, name: b.supplier, owed: {}, count: 0, overdueCount: 0 });
    const s = by.get(key);
    s.owed[b.currency] = round2((s.owed[b.currency] || 0) + billBalance(b));
    s.count++;
    if (billStatus(b, today) === "overdue") s.overdueCount++;
  }
  const total = s => Object.values(s.owed).reduce((a, v) => a + v, 0);
  return [...by.values()].sort((a, b) => total(b) - total(a));
}

// The list order: overdue first, then by due date; paid and cancelled last, newest first.
export function sortBills(bills, today) {
  const rank = b => (billIsOpen(b, today) ? 0 : 1);
  return bills.slice().sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 0 ? String(a.dueDate).localeCompare(String(b.dueDate)) : String(b.billDate).localeCompare(String(a.billDate))));
}

// Phone reminders: 9am the day before a bill is due and 9am on the day, for bills still open.
// Same { clientKey, firesAt, title, body } shape as appointment reminders.
export function billReminders(bills, today, now, fmt) {
  const out = [];
  for (const b of bills) {
    if (!billIsOpen(b, today) || !isDate(b.dueDate)) continue;
    const amount = fmt(billBalance(b), b.currency);
    for (const [offset, title] of [[-1, `Bill due tomorrow: ${b.supplier}`], [0, `Bill due today: ${b.supplier}`]]) {
      const day = addDays(b.dueDate, offset);
      const fires = new Date(`${day}T09:00:00`);
      if (fires.getTime() <= now) continue;
      out.push({ clientKey: `bill:${b.id}:${offset ? "before" : "day"}`, firesAt: fires.toISOString(), title, body: `${amount}${b.ref ? ` · ${b.ref}` : ""}` });
    }
  }
  return out;
}

// One line for KROFT's AI, so "what do I owe?" / "which bills are due?" can be answered.
export function billsForAI(bills, today, fmt) {
  const open = sortBills(bills.filter(b => billIsOpen(b, today)), today);
  if (!open.length) return `${bills.length} bill${bills.length === 1 ? "" : "s"} on record, none to pay.`;
  const overdue = open.filter(b => billStatus(b, today) === "overdue").length;
  const list = open.slice(0, 8).map(b => `${b.supplier}${b.ref ? ` (${b.ref})` : ""} ${fmt(billBalance(b), b.currency)}${billPaid(b) > 0 ? ` left of ${fmt(b.amount, b.currency)}` : ""} due ${b.dueDate}${billStatus(b, today) === "overdue" ? " (OVERDUE)" : ""}`).join("; ");
  return `${open.length} to pay (${overdue} overdue): ${list}`;
}

// The expense entry for a payment on a bill.
export function billExpenseLabel(b, part) {
  return `Bill · ${b.supplier}${b.ref ? ` (${b.ref})` : ""}${part ? " (part payment)" : ""}`;
}
