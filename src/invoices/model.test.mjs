// Tests the invoice logic and the PDF wrapper. Run with: npm test
import * as M from "./model.js";
import { buildPdf, pdfString, invoiceFileName } from "./pdf.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };
const fmt = (n, cur) => `${cur} ${n.toFixed(2)}`;
const today = "2026-11-01";

// ── Totals ──
const inv = { items: [{ description: "Logo design", qty: 1, price: 50000 }, { description: "Revisions", qty: 3, price: 2500.335 }], discount: 5000, vatRate: 7.5 };
eq("line totals round to kobo", M.lineTotal(inv.items[1]), 7501.01);
eq("totals: subtotal, discount, VAT on the discounted amount, total", M.invoiceTotals(inv), { subtotal: 57501.01, discount: 5000, vat: 3937.58, vatRate: 7.5, total: 56438.59 });
eq("discount can't exceed subtotal", M.invoiceTotals({ items: [{ qty: 1, price: 100 }], discount: 500 }).total, 0);
eq("no items is zero", M.invoiceTotals({}).total, 0);

// ── Numbers and dates ──
eq("invoice numbers are padded", [M.formatInvoiceNumber("INV", 7), M.formatInvoiceNumber("KC", 1234), M.formatInvoiceNumber("", 0)], ["INV-0007", "KC-1234", "INV-0001"]);
eq("addDays crosses months", [M.addDays("2026-11-28", 7), M.addDays("2026-12-31", 1)], ["2026-12-05", "2027-01-01"]);
eq("daysBetween", M.daysBetween("2026-10-25", today), 7);

// ── Creating ──
const { invoice, settings } = M.createInvoice({ settings: { prefix: "INV", nextNumber: 4, dueDays: 14 }, client: { name: " Tunde Bakare " }, items: [{ description: "Logo", qty: 1, price: 50000 }], currency: "NGN", today, id: "a1" });
eq("new invoice gets the next number and reserves the one after", [invoice.number, settings.nextNumber], ["INV-0004", 5]);
eq("due date defaults from settings", invoice.dueDate, "2026-11-15");
eq("new invoice starts as a draft for a trimmed client name", [invoice.status, invoice.client.name, invoice.createdAt], ["draft", "Tunde Bakare", today]);
eq("explicit due date kept", M.createInvoice({ settings: {}, today, id: "b", dueDate: "2026-11-06", currency: "NGN" }).invoice.dueDate, "2026-11-06");

// ── Status ──
eq("status is worked out from the due date", [
  M.invoiceStatus({ status: "sent", dueDate: "2026-10-31" }, today),
  M.invoiceStatus({ status: "sent", dueDate: today }, today),
  M.invoiceStatus({ status: "paid", dueDate: "2026-01-01" }, today),
  M.invoiceStatus({ status: "draft", dueDate: "2026-01-01" }, today),
], ["overdue", "sent", "paid", "draft"]);

// ── Free plan allowance ──
const mk = (createdAt) => ({ createdAt });
eq("free plan: 3 a month", M.invoiceAllowance({ subscribed: false, invoices: [mk("2026-11-01"), mk("2026-11-01"), mk("2026-10-30")], today }), { allowed: true, used: 2, limit: 3 });
eq("free plan: 4th is blocked", M.invoiceAllowance({ subscribed: false, invoices: [mk("2026-11-01"), mk("2026-11-02"), mk("2026-11-03")], today }).allowed, false);
eq("Plus has no limit", M.invoiceAllowance({ subscribed: true, invoices: [mk("2026-11-01"), mk("2026-11-01"), mk("2026-11-01")], today }).allowed, true);

// ── Problems that block sending ──
eq("needs a client", M.invoiceProblem({ client: {}, items: [{ description: "x", qty: 1, price: 1 }] }), "Add who the invoice is for.");
eq("needs a priced item", M.invoiceProblem({ client: { name: "A" }, items: [{ description: "x", qty: 1, price: 0 }] }), "Add at least one item with a description and an amount.");
eq("priced items need descriptions", M.invoiceProblem({ client: { name: "A" }, items: [{ description: "x", qty: 1, price: 5 }, { description: "", qty: 1, price: 5 }] }), "Every item needs a description.");
eq("ready invoice has no problem", M.invoiceProblem(invoice), null);

// ── WhatsApp ──
eq("Nigerian numbers become international", [M.whatsappNumber("0803 123 4567"), M.whatsappNumber("+234 803 123 4567"), M.whatsappNumber("002348031234567"), M.whatsappNumber("")], ["2348031234567", "2348031234567", "2348031234567", ""]);
eq("WhatsApp link carries the message", M.whatsappLink("08031234567", "Hi & bye"), "https://wa.me/2348031234567?text=Hi%20%26%20bye");

// ── Messages ──
const s = { ...M.DEFAULT_INVOICE_SETTINGS, businessName: "Ada Designs", bankName: "GTBank", accountName: "Ada Obi", accountNumber: "0123456789" };
const sent = { ...invoice, status: "sent", dueDate: "2026-10-29" };
const msg = M.sendMessage(sent, s, {}, fmt);
eq("send message names the invoice, amount and bank", [msg.startsWith("Hi Tunde,"), msg.includes("INV-0004 from Ada Designs for NGN 50000.00"), msg.includes("Account number: 0123456789")], [true, true, true]);
const rem = M.reminderMessage(sent, s, {}, fmt, today);
eq("reminder says how late it is, politely", [rem.includes("was due 3 days ago"), rem.includes("If you've already paid")], [true, true]);
eq("reminder on the due day", M.reminderMessage({ ...sent, dueDate: today }, s, {}, fmt, today).includes("is due today"), true);
eq("from name falls back to profile", [M.fromName({}, { businessName: "Carter Co" }), M.fromName({}, { name: "Ada" }), M.fromName({ businessName: "X" }, { businessName: "Y" })], ["Carter Co", "Ada", "X"]);

// ── AI summary ──
eq("AI summary lists unpaid and overdue", M.invoicesForAI([sent, { ...invoice, id: "c", number: "INV-0005", status: "paid" }], today, fmt), "1 unpaid (1 overdue): INV-0004 Tunde Bakare NGN 50000.00 due 2026-10-29 (OVERDUE)");
eq("AI summary with nothing unpaid", M.invoicesForAI([], today, fmt), "0 invoices on record, none unpaid.");

// ── PDF wrapper ──
const fakeJpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const pdf = buildPdf([{ jpeg: fakeJpeg, width: 10, height: 14 }, { jpeg: fakeJpeg, width: 10, height: 14 }], { title: "Invoice INV-0004", author: "Adé Ọlá" });
const text = new TextDecoder("latin1").decode(pdf);
eq("PDF header and end", [text.startsWith("%PDF-1.4\n"), text.trimEnd().endsWith("%%EOF")], [true, true]);
eq("PDF has 2 pages", /\/Count 2/.test(text), true);
const xrefAt = Number(text.match(/startxref\n(\d+)/)[1]);
eq("startxref points at the xref table", text.slice(xrefAt, xrefAt + 4), "xref");
const offsets = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]));
eq("every xref offset points at its object", offsets.every((o, i) => text.slice(o).startsWith(`${i + 1} 0 obj`)), true);
eq("image length matches the JPEG", /\/Filter \/DCTDecode \/Length 7 >>/.test(text), true);
eq("non-ASCII author written as UTF-16", pdfString("Adé"), "<FEFF004100640065301>".replace("0065301", "00E9"));
eq("PDF strings escape brackets", pdfString("a(b)c\\"), "(a\\(b\\)c\\\\)");

eq("file names are plain ASCII", [invoiceFileName({ number: "INV-0001", client: { name: "Tunde Bákàrè" } }), invoiceFileName({ number: "INV-0002", client: { name: "Ọ̀ṣun / Foods" } }), invoiceFileName({ number: "INV-0003", client: {} })], ["INV-0001 Tunde Bakare.pdf", "INV-0002 Osun _ Foods.pdf", "INV-0003.pdf"]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
