// Invoices: the plain logic, kept apart from the screens so it can be tested on its own
// (src/invoices/model.test.mjs). Invoices are stored with the rest of the finance data
// (kroft:finance in kv_store), so they sync, work offline and are covered by backup/export the
// same way income and expenses are.
//
// An invoice:
//   { id, number, client:{ name, email, phone }, items:[{ id, description, qty, price }],
//     currency, issueDate, dueDate, vatRate, discount, notes,
//     status: "draft" | "sent" | "paid" | "cancelled",   ("overdue" is worked out, not stored)
//     sentAt, paidDate, incomeId, createdAt, clientId, quoteId,
//     payments:[{ id, amount, date, incomeId }] }
// Every payment is also an income entry (incomeId), and the income entries are the source of
// truth: syncInvoicesWithIncome() keeps payments in step when an entry is edited or deleted.
// "paid" means the payments cover the total; "partial" (worked out) means some has been paid.
// clientId links to a contact (Workspace › Contacts); quoteId to the quote it came from.
//
// A quote has the same shape plus kind:"quote", validUntil instead of dueDate, and
//   status: "draft" | "sent" | "accepted" | "declined" | "invoiced"   ("expired" is worked out)
//   invoiceId once it has been turned into an invoice.
// Dates are local YYYY-MM-DD strings, like the rest of KROFT.

export const FREE_INVOICES_PER_MONTH = 3;
export const FREE_QUOTES_PER_MONTH = 3;

export const DEFAULT_INVOICE_SETTINGS = {
  businessName: "",   // blank = the profile's business name, then the person's name
  address: "",
  email: "",
  phone: "",
  bankName: "",
  accountName: "",
  accountNumber: "",     // or an IBAN
  otherPayment: "",      // anything else a client needs: SWIFT/BIC, sort code, routing number, PayPal, mobile money
  prefix: "INV",
  nextNumber: 1,
  dueDays: 7,
  quotePrefix: "QUO",
  nextQuoteNumber: 1,
  quoteValidDays: 14,
  vatRate: 0,
  taxLabel: "VAT",       // what the tax is called where the business is: VAT, GST, Sales tax, IVA, TVA…
  taxId: "",             // the business's tax or registration number, shown on invoices
  note: "Thank you for your business.",
};

// What the tax on a document is called (older invoices were all VAT), and the line for the
// business's tax number on it.
export const taxName = doc => String(doc?.taxLabel || "").trim() || "VAT";
export const taxIdLine = settings => settings?.taxId?.trim() ? `${taxName(settings)} no. ${settings.taxId.trim()}` : "";

// The person's own language and region (en-NG, en-US, fr-FR…), so dates and money read the way
// they're written where they are. Falls back to British English when there's no browser.
export const userLocale = () => (typeof navigator !== "undefined" && navigator.language) || "en-GB";

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
  if (inv.dueDate && inv.dueDate < today) return "overdue";
  return amountPaid(inv) > 0 ? "partial" : "sent";
}

// ── Payments ──
// Invoices marked paid before part-payments existed have no payments list, just paidDate and
// incomeId: they count as one payment of the full amount.
export function paymentsOf(inv) {
  if (Array.isArray(inv.payments)) return inv.payments;
  if (inv.status === "paid") return [{ id: inv.incomeId || `${inv.id}-paid`, amount: invoiceTotals(inv).total, date: inv.paidDate || inv.issueDate, incomeId: inv.incomeId || null }];
  return [];
}
export const amountPaid = inv => round2(paymentsOf(inv).reduce((s, p) => s + (Number(p.amount) || 0), 0));
export const balanceDue = inv => Math.max(0, round2(invoiceTotals(inv).total - amountPaid(inv)));
export const hasPayments = inv => paymentsOf(inv).length > 0;

// The invoice after its payments list changed: paid once they cover the total (paid on the
// date of the last payment), otherwise sent.
function withPayments(inv, payments, today) {
  const next = { ...inv, payments };
  const covered = payments.length > 0 && balanceDue(next) <= 0;
  const lastDate = payments.reduce((d, p) => (p.date > d ? p.date : d), "");
  if (covered) return { ...next, status: "paid", paidDate: lastDate, incomeId: null };
  return { ...next, status: inv.status === "draft" && !payments.length ? "draft" : "sent", sentAt: inv.sentAt || today, paidDate: null, incomeId: null };
}

export function recordPayment(inv, { id, amount, date, incomeId }, today) {
  const amt = round2(amount);
  return withPayments(inv, [...paymentsOf(inv), { id, amount: amt, date: date || today, incomeId: incomeId || null }], today);
}

export function removePayment(inv, paymentId, today) {
  return withPayments(inv, paymentsOf(inv).filter(p => p.id !== paymentId), today);
}

// Income entries are the record of money received. When one that belongs to an invoice payment
// is edited (amount/date) or deleted elsewhere in KROFT (Entry history, KROFT chat), the invoice
// follows. Also moves old "paid" invoices onto a payments list. Returns the same array when
// nothing changed, so it's cheap to call on every change.
export function syncInvoicesWithIncome(invoices, income, today) {
  const byId = new Map(income.map(e => [String(e.id), e]));
  let changed = false;
  const out = invoices.map(inv => {
    const legacy = !Array.isArray(inv.payments) && inv.status === "paid";
    const payments = paymentsOf(inv);
    if (!payments.length && !legacy) return inv;
    let touched = legacy;
    const next = [];
    for (const p of payments) {
      if (!p.incomeId) { next.push(p); continue; }
      const entry = byId.get(String(p.incomeId));
      if (!entry) { touched = true; continue; }                       // income entry deleted
      const amount = round2(entry.amount), date = entry.date || p.date;
      if (amount !== p.amount || date !== p.date) { touched = true; next.push({ ...p, amount, date }); }
      else next.push(p);
    }
    if (!touched) return inv;
    changed = true;
    return withPayments(inv, next, today);
  });
  return changed ? out : invoices;
}

export const STATUS_LABEL = { draft: "Draft", sent: "Sent", partial: "Part paid", overdue: "Overdue", paid: "Paid", cancelled: "Cancelled", accepted: "Accepted", declined: "Declined", invoiced: "Invoiced", expired: "Expired" };

// A quote past its "valid until" date that the client never answered.
export function quoteStatus(q, today) {
  if (q.status !== "sent") return q.status;
  return q.validUntil && q.validUntil < today ? "expired" : "sent";
}

export const docStatus = (doc, today) => (doc.kind === "quote" ? quoteStatus(doc, today) : invoiceStatus(doc, today));

export function invoicesCreatedInMonth(invoices, today) {
  const month = today.slice(0, 7);
  return invoices.filter(inv => (inv.createdAt || "").slice(0, 7) === month).length;
}

// Free plan: a few invoices (and, separately, a few quotes) a month; KROFT Plus: no limit.
export function invoiceAllowance({ subscribed, invoices, today, limit = FREE_INVOICES_PER_MONTH }) {
  if (subscribed) return { allowed: true, used: null, limit: null };
  const used = invoicesCreatedInMonth(invoices, today);
  return { allowed: used < limit, used, limit };
}
export const quoteAllowance = ({ subscribed, quotes, today }) => invoiceAllowance({ subscribed, invoices: quotes, today, limit: FREE_QUOTES_PER_MONTH });

// A new invoice and the settings with the next number reserved.
export function createInvoice({ settings, client = {}, items = [], dueDate, notes, currency, today, id, vatRate, discount, taxLabel }) {
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
    taxLabel: taxName({ taxLabel: taxLabel ?? s.taxLabel }),
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

// A new quote and the settings with the next quote number reserved.
export function createQuote({ settings, client = {}, items = [], validUntil, notes, currency, today, id, vatRate, discount, clientId = null }) {
  const s = { ...DEFAULT_INVOICE_SETTINGS, ...settings };
  const { invoice } = createInvoice({ settings: s, client, items, currency, today, id, vatRate, discount, notes: notes ?? "" });
  const { dueDate, sentAt, paidDate, incomeId, ...rest } = invoice;
  const quote = {
    ...rest,
    kind: "quote",
    number: formatInvoiceNumber(s.quotePrefix || "QUO", s.nextQuoteNumber),
    validUntil: validUntil && /^\d{4}-\d{2}-\d{2}$/.test(validUntil) ? validUntil : addDays(today, Number(s.quoteValidDays) || 14),
    clientId,
    sentAt: null,
    invoiceId: null,
  };
  return { quote, settings: { ...s, nextQuoteNumber: (Number(s.nextQuoteNumber) || 1) + 1 } };
}

// Turns an accepted (or sent) quote into a draft invoice with the same client and items.
export function invoiceFromQuote({ quote, settings, today, id }) {
  const { invoice, settings: next } = createInvoice({
    settings, client: quote.client, currency: quote.currency, today, id,
    items: quote.items.map(({ description, qty, price }) => ({ description, qty, price })),
    vatRate: quote.vatRate, discount: quote.discount, taxLabel: quote.taxLabel,
  });
  return { invoice: { ...invoice, clientId: quote.clientId || null, quoteId: quote.id }, settings: next };
}

// ── Clients ──
// Everyone who has been sent an invoice or quote, with what they owe and have paid. Linked to a
// contact by clientId; older invoices without one are matched by name.
export const clientKey = doc => (doc.clientId ? `id:${doc.clientId}` : `name:${(doc.client?.name || "").trim().toLowerCase()}`);

export function clientSummaries({ invoices = [], quotes = [], contacts = [], today }) {
  const byKey = new Map();
  const get = (key, doc) => {
    if (!byKey.has(key)) {
      const contact = doc.clientId ? contacts.find(c => String(c.id) === String(doc.clientId)) : null;
      byKey.set(key, {
        key, clientId: doc.clientId || null,
        name: contact?.name || doc.client?.name || "",
        email: contact?.email || doc.client?.email || "",
        phone: contact?.phone || doc.client?.phone || "",
        owed: {}, paid: {}, overdueCount: 0, unpaidCount: 0, invoiceCount: 0, quoteCount: 0, openQuotes: 0, lastDate: "",
      });
    }
    return byKey.get(key);
  };
  for (const inv of invoices) {
    if (!inv.client?.name) continue;
    const c = get(clientKey(inv), inv);
    c.invoiceCount++;
    const st = invoiceStatus(inv, today);
    const { total } = invoiceTotals(inv);
    if (st === "sent" || st === "overdue" || st === "partial") { c.owed[inv.currency] = round2((c.owed[inv.currency] || 0) + balanceDue(inv)); c.unpaidCount++; }
    if (st === "overdue") c.overdueCount++;
    const paid = amountPaid(inv);
    if (paid) c.paid[inv.currency] = round2((c.paid[inv.currency] || 0) + paid);
    if ((inv.issueDate || "") > c.lastDate) c.lastDate = inv.issueDate;
  }
  for (const q of quotes) {
    if (!q.client?.name) continue;
    const c = get(clientKey(q), q);
    c.quoteCount++;
    if (["draft", "sent", "accepted"].includes(quoteStatus(q, today))) c.openQuotes++;
    if ((q.issueDate || "") > c.lastDate) c.lastDate = q.issueDate;
  }
  // Biggest debt first, then most recent.
  const owedTotal = c => Object.values(c.owed).reduce((a, b) => a + b, 0);
  return [...byKey.values()].sort((a, b) => owedTotal(b) - owedTotal(a) || b.lastDate.localeCompare(a.lastDate));
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
  if (settings.accountNumber) lines.push(`${/^[A-Z]{2}\d{2}/i.test(settings.accountNumber.replace(/\s/g, "")) ? "IBAN" : "Account number"}: ${settings.accountNumber}`);
  for (const l of String(settings.otherPayment || "").split("\n").map(x => x.trim()).filter(Boolean)) lines.push(l);
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
  const total = balanceDue(inv);
  const partly = amountPaid(inv) > 0;
  const who = inv.client?.name ? `Hi ${inv.client.name.split(/\s+/)[0]},` : "Hello,";
  const late = inv.dueDate ? daysBetween(inv.dueDate, today) : 0;
  const when = late > 0 ? `was due ${late === 1 ? "yesterday" : `${late} days ago`} (${prettyDate(inv.dueDate)})`
    : late === 0 ? "is due today" : `is due ${prettyDate(inv.dueDate)}`;
  const pay = paymentLines(settings);
  return [
    who,
    "",
    partly
      ? `A friendly reminder that the balance of ${fmt(total, inv.currency)} on invoice ${inv.number} ${when}. Thank you for the payment so far.`
      : `A friendly reminder that invoice ${inv.number} for ${fmt(total, inv.currency)} ${when}.`,
    ...(pay.length ? ["", "Payment details:", ...pay] : []),
    "",
    "If you've already paid, thank you, and please ignore this message.",
    fromName(settings, user) ? `\n${fromName(settings, user)}` : "",
  ].join("\n").trim();
}

// The message that goes with a quote.
export function quoteMessage(q, settings, user, fmt) {
  const { total } = invoiceTotals(q);
  const who = q.client?.name ? `Hi ${q.client.name.split(/\s+/)[0]},` : "Hello,";
  const from = fromName(settings, user);
  return [
    who,
    "",
    `Here's quote ${q.number}${from ? ` from ${from}` : ""} for ${fmt(total, q.currency)}, valid until ${prettyDate(q.validUntil)}.`,
    "",
    "Let me know if you'd like to go ahead, or if anything needs changing.",
    "",
    "Thank you!",
  ].join("\n");
}

export function prettyDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(userLocale(), { day: "numeric", month: "short", year: "numeric" });
}

// Short summary for KROFT's AI, so "who owes me?" can be answered.
export function quotesForAI(quotes = [], today, fmt) {
  const open = quotes.filter(q => ["draft", "sent", "accepted"].includes(quoteStatus(q, today)));
  if (!open.length) return `${quotes.length} quote${quotes.length === 1 ? "" : "s"} on record, none open.`;
  return `${open.length} open: ` + open.slice(0, 6).map(q => `${q.number} ${q.client.name} ${fmt(invoiceTotals(q).total, q.currency)} ${quoteStatus(q, today)}`).join("; ");
}

export function invoicesForAI(invoices, today, fmt) {
  const open = invoices.filter(inv => ["sent", "overdue", "partial"].includes(invoiceStatus(inv, today)));
  if (!open.length) return `${invoices.length} invoice${invoices.length === 1 ? "" : "s"} on record, none unpaid.`;
  const overdue = open.filter(inv => invoiceStatus(inv, today) === "overdue");
  const list = open.slice(0, 8).map(inv => `${inv.number} ${inv.client.name} ${fmt(balanceDue(inv), inv.currency)} ${amountPaid(inv) > 0 ? `still due of ${fmt(invoiceTotals(inv).total, inv.currency)}` : ""} due ${inv.dueDate}${invoiceStatus(inv, today) === "overdue" ? " (OVERDUE)" : ""}`.replace(/\s+/g, " ")).join("; ");
  return `${open.length} unpaid (${overdue.length} overdue): ${list}`;
}
