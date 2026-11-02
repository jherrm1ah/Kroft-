// The Finance › Export CSV file: income and expenses first (as before), then invoices, quotes and
// bills, each as its own titled section with its own header row, separated by a blank line. One
// file that opens as one sheet in Excel, Google Sheets or Numbers.

import { invoiceTotals, amountPaid, balanceDue, invoiceStatus, quoteStatus, STATUS_LABEL, taxName } from "../invoices/model.js";
import { billStatus, billPaid, billBalance, BILL_STATUS_LABEL } from "../bills/model.js";

// One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @) gets a leading ' so
// it shows as text; numbers stay numbers.
export function csvField(v) {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function financeCsvRows({ income = [], expenses = [], invoices = [], quotes = [], bills = [], projects = [], today, currency }) {
  const rows = [
    ["Date", "Type", "Description", "Category", "Amount", "Currency", "Repeats"],
    ...[...income.map(r => ({ ...r, type: "Income" })), ...expenses.map(r => ({ ...r, type: "Expense" }))]
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .map(r => [r.date || "", r.type, r.label, r.cat, Number(r.amount) || 0, r.cur || currency, (r.repeat && r.repeat !== "none") ? r.repeat : ""]),
  ];
  const projectName = id => projects.find(p => p.id === id)?.name || "";
  const byDate = (a, b) => (a.issueDate || "").localeCompare(b.issueDate || "") || String(a.number).localeCompare(String(b.number));

  if (invoices.length) {
    rows.push([], ["INVOICES"], ["Number", "Client", "Issued", "Due", "Status", "Subtotal", "Discount", "Tax", "Tax name", "Total", "Paid", "Balance", "Currency", "Project"]);
    for (const inv of invoices.slice().sort(byDate)) {
      const t = invoiceTotals(inv);
      rows.push([inv.number, inv.client?.name || "", inv.issueDate || "", inv.dueDate || "", STATUS_LABEL[invoiceStatus(inv, today)] || "", t.subtotal, t.discount, t.vat, t.vat ? taxName(inv) : "", t.total, amountPaid(inv), inv.status === "cancelled" ? 0 : balanceDue(inv), inv.currency || currency, projectName(inv.projectId)]);
    }
  }
  if (quotes.length) {
    rows.push([], ["QUOTES"], ["Number", "Client", "Issued", "Valid until", "Status", "Total", "Currency"]);
    for (const q of quotes.slice().sort(byDate)) {
      rows.push([q.number, q.client?.name || "", q.issueDate || "", q.validUntil || "", STATUS_LABEL[quoteStatus(q, today)] || "", invoiceTotals(q).total, q.currency || currency]);
    }
  }
  if (bills.length) {
    rows.push([], ["BILLS"], ["Supplier", "Reference", "For", "Bill date", "Due", "Status", "Amount", "Paid", "Still owed", "Currency", "Category"]);
    for (const b of bills.slice().sort((x, y) => (x.billDate || "").localeCompare(y.billDate || ""))) {
      const st = billStatus(b, today);
      rows.push([b.supplier, b.ref || "", b.description || "", b.billDate || "", b.dueDate || "", BILL_STATUS_LABEL[st] || "", Number(b.amount) || 0, billPaid(b), st === "cancelled" ? 0 : billBalance(b), b.currency || currency, b.category || ""]);
    }
  }
  return rows;
}

export const toCsv = rows => rows.map(row => row.map(csvField).join(",")).join("\r\n");
export const hasAnythingToExport = d => [d.income, d.expenses, d.invoices, d.quotes, d.bills].some(l => (l || []).length > 0);
