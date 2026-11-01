// Invoices: the plain logic, kept apart from the screens so it can be tested on its own
// (src/invoices/model.test.mjs). Invoices are stored with the rest of the finance data
// (kroft:finance in kv_store), so they sync, work offline and are covered by backup/export the
// same way income and expenses are.
//
// An invoice:
//   { id, number, client:{ name, email, phone }, items:[{ id, description, qty, price }],
//     currency, issueDate, dueDate, vatRate, discount, notes,
//     status: "draft" | "sent" | "paid" | "cancelled",   ("overdue" is worked out, not stored)
//     sentAt, paidDate, incomeId, createdAt }
// Dates are local YYYY-MM-DD strings, like the rest of KROFT.

export const FREE_INVOICES_PER_MONTH = 3;

export const DEFAULT_INVOICE_SETTINGS = {
  businessName: "",   // blank = the profile's business name, then the person's name
  address: "",
  email: "",
  phone: "",
  bankName: "",
  accountName: "",
  accountNumber: "",
  prefix: "INV",
  nextNumber: 1,
  dueDays: 7,
  vatRate: 0,
  note: "Thank you for your business.",
};

export const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

export const lineTotal = item => round2((Number(item.qty) || 0) * (Number(item.price) || 0));

export function invoiceTotals(inv) {
  const subtotal = round2((inv.items || []).reduce((s, it) => s + lineTotal(it), 0));
  const discount = Math.min(subtotal, Math.max(0, round2(inv.discount)));
  const taxable = round2(subtotal - discount);
  const vatRate = Math.max(0, Number(inv.vatRate) || 0);
  const vat = round2(taxable * vatRate / 100);
  return { subtotal, discount, vat, vatRate, total: round2(taxable + vat) };
}

export const formatInvoiceNumber = (prefix, n) => `${(prefix || "INV").trim() || "INV"}-${String(Math.max(1, Math.floor(n) || 1)).padStart(4, "0")}`;

export function addDays(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export function daysBetween(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00`), b = new Date(`${toIso}T00:00:00`);
  return Math.round((b - a) / 86400000);
}

// "overdue" is a sent invoice past its due date; it isn't stored, so it can never go stale.
export function invoiceStatus(inv, today) {
  if (inv.status === "paid" || inv.status === "cancelled" || inv.status === "draft") return inv.status;
  return inv.dueDate && inv.dueDate < today ? "overdue" : "sent";
}

export const STATUS_LABEL = { draft: "Draft", sent: "Sent", overdue: "Overdue", paid: "Paid", cancelled: "Cancelled" };

export function invoicesCreatedInMonth(invoices, today) {
  const month = today.slice(0, 7);
  return invoices.filter(inv => (inv.createdAt || "").slice(0, 7) === month).length;
}

// Free plan: a few invoices a month; KROFT Plus: no limit.
export function invoiceAllowance({ subscribed, invoices, today }) {
  if (subscribed) return { allowed: true, used: null, limit: null };
  const used = invoicesCreatedInMonth(invoices, today);
  return { allowed: used < FREE_INVOICES_PER_MONTH, used, limit: FREE_INVOICES_PER_MONTH };
}

// A new invoice and the settings with the next number reserved.
export function createInvoice({ settings, client = {}, items = [], dueDate, notes, currency, today, id, vatRate, discount }) {
  const s = { ...DEFAULT_INVOICE_SETTINGS, ...settings };
  const invoice = {
    id,
    number: formatInvoiceNumber(s.prefix, s.nextNumber),
    client: { name: (client.name || "").trim(), email: (client.email || "").trim(), phone: (client.phone || "").trim() },
    items: (items.length ? items : [{ description: "", qty: 1, price: 0 }]).map((it, i) => ({
      id: it.id || `${id}-${i}`,
      description: (it.description || "").trim(),
      qty: Number(it.qty) > 0 ? Number(it.qty) : 1,
      price: round2(it.price),
    })),
    currency,
    issueDate: today,
    dueDate: dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : addDays(today, Number(s.dueDays) || 7),
    vatRate: vatRate ?? (Number(s.vatRate) || 0),
    discount: round2(discount || 0),
    notes: (notes ?? s.note ?? "").trim(),
    status: "draft",
    sentAt: null,
    paidDate: null,
    incomeId: null,
    createdAt: today,
  };
  return { invoice, settings: { ...s, nextNumber: (Number(s.nextNumber) || 1) + 1 } };
}

// What stops an invoice being sent: shown to the person instead of a broken PDF.
export function invoiceProblem(inv) {
  if (!inv.client?.name) return "Add who the invoice is for.";
  const items = inv.items || [];
  if (!items.some(it => it.description && lineTotal(it) > 0)) return "Add at least one item with a description and an amount.";
  if (items.some(it => lineTotal(it) > 0 && !it.description)) return "Every item needs a description.";
  if (inv.dueDate && inv.issueDate && inv.dueDate < inv.issueDate) return "The due date is before the invoice date.";
  return null;
}

// Nigerian numbers are usually written 0803 123 4567; WhatsApp wants 2348031234567.
export function whatsappNumber(phone, defaultCountry = "234") {
  let digits = String(phone || "").replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("+")) return digits.slice(1);
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.startsWith("0")) return defaultCountry + digits.slice(1);
  return digits;
}

export function whatsappLink(phone, text) {
  const n = whatsappNumber(phone);
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

export const fromName = (settings, user = {}) => (settings.businessName || user.businessName || user.name || "").trim();

export function paymentLines(settings) {
  const lines = [];
  if (settings.bankName) lines.push(`Bank: ${settings.bankName}`);
  if (settings.accountName) lines.push(`Account name: ${settings.accountName}`);
  if (settings.accountNumber) lines.push(`Account number: ${settings.accountNumber}`);
  return lines;
}

// The message that goes with the PDF when it's sent.
export function sendMessage(inv, settings, user, fmt) {
  const { total } = invoiceTotals(inv);
  const who = inv.client?.name ? `Hi ${inv.client.name.split(/\s+/)[0]},` : "Hello,";
  const from = fromName(settings, user);
  const pay = paymentLines(settings);
  return [
    who,
    "",
    `Here's invoice ${inv.number}${from ? ` from ${from}` : ""} for ${fmt(total, inv.currency)}, due ${prettyDate(inv.dueDate)}.`,
    ...(pay.length ? ["", "Payment details:", ...pay] : []),
    "",
    "Thank you!",
  ].join("\n");
}

// A polite chase for an unpaid invoice.
export function reminderMessage(inv, settings, user, fmt, today) {
  const { total } = invoiceTotals(inv);
  const who = inv.client?.name ? `Hi ${inv.client.name.split(/\s+/)[0]},` : "Hello,";
  const late = inv.dueDate ? daysBetween(inv.dueDate, today) : 0;
  const when = late > 0 ? `was due ${late === 1 ? "yesterday" : `${late} days ago`} (${prettyDate(inv.dueDate)})`
    : late === 0 ? "is due today" : `is due ${prettyDate(inv.dueDate)}`;
  const pay = paymentLines(settings);
  return [
    who,
    "",
    `A friendly reminder that invoice ${inv.number} for ${fmt(total, inv.currency)} ${when}.`,
    ...(pay.length ? ["", "Payment details:", ...pay] : []),
    "",
    "If you've already paid, thank you, and please ignore this message.",
    fromName(settings, user) ? `\n${fromName(settings, user)}` : "",
  ].join("\n").trim();
}

export function prettyDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Short summary for KROFT's AI, so "who owes me?" can be answered.
export function invoicesForAI(invoices, today, fmt) {
  const open = invoices.filter(inv => ["sent", "overdue"].includes(invoiceStatus(inv, today)));
  if (!open.length) return `${invoices.length} invoice${invoices.length === 1 ? "" : "s"} on record, none unpaid.`;
  const overdue = open.filter(inv => invoiceStatus(inv, today) === "overdue");
  const list = open.slice(0, 8).map(inv => `${inv.number} ${inv.client.name} ${fmt(invoiceTotals(inv).total, inv.currency)} due ${inv.dueDate}${invoiceStatus(inv, today) === "overdue" ? " (OVERDUE)" : ""}`).join("; ");
  return `${open.length} unpaid (${overdue.length} overdue): ${list}`;
}
