// Tests the Finance CSV export. Run with: npm test
import { financeCsvRows, toCsv, csvField, hasAnythingToExport } from "./exportCsv.js";
import * as M from "../invoices/model.js";
import * as B from "../bills/model.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };
const today = "2026-11-02";

eq("cells: formulas shown as text, commas and quotes wrapped, numbers stay numbers", [csvField("=SUM(A1)"), csvField('Ada, "Designs"'), csvField(-5), csvField("-5"), csvField(12.5)], ["'=SUM(A1)", '"Ada, ""Designs"""', "-5", "'-5", "12.5"]);

const inv = M.recordPayment({ id: "i1", kind: "invoice", number: "INV-0002", client: { name: "Tunde, Bakare" }, currency: "NGN", issueDate: "2026-10-20", dueDate: "2026-10-27", status: "sent", vatRate: 7.5, taxLabel: "VAT", discount: 0, items: [{ description: "Logo", qty: 1, price: 100000 }], projectId: "p1" }, { id: "x", amount: 40000, date: "2026-10-25" }, today);
const old = { id: "i0", kind: "invoice", number: "INV-0001", client: { name: "Ada" }, currency: "NGN", issueDate: "2026-09-01", dueDate: "2026-09-08", status: "paid", paidDate: "2026-09-05", vatRate: 0, discount: 0, items: [{ description: "Card", qty: 2, price: 5000 }] };
const quote = { id: "q1", kind: "quote", number: "QUO-0001", client: { name: "Bisi" }, currency: "NGN", issueDate: "2026-10-30", validUntil: "2026-11-13", status: "sent", vatRate: 0, discount: 0, items: [{ description: "Site", qty: 1, price: 300000 }] };
const bill = B.recordBillPayment(B.createBill({ supplier: "Dangote", ref: "DC-1", description: "Cement", amount: 250000, currency: "NGN", category: "Supplies", billDate: "2026-10-28", dueDate: "2026-11-06", today, id: "b1" }), { id: "bp", amount: 100000, date: today });

const rows = financeCsvRows({ income: [{ date: "2026-10-25", label: "INV-0002 · Tunde", cat: "Invoice", amount: 40000 }], expenses: [{ date: "2026-10-02", label: "Fuel", cat: "Travel", amount: 2000, repeat: "weekly" }], invoices: [inv, old], quotes: [quote], bills: [bill], projects: [{ id: "p1", name: "Brand" }], today, currency: "NGN" });
const at = title => rows.findIndex(r => r[0] === title);
eq("income and expenses first, as before, oldest first", rows.slice(0, 3), [["Date", "Type", "Description", "Category", "Amount", "Currency", "Repeats"], ["2026-10-02", "Expense", "Fuel", "Travel", 2000, "NGN", "weekly"], ["2026-10-25", "Income", "INV-0002 · Tunde", "Invoice", 40000, "NGN", ""]]);
eq("then titled sections with a blank line before each", [rows[at("INVOICES") - 1], rows[at("QUOTES") - 1], rows[at("BILLS") - 1]], [[], [], []]);
eq("invoices: totals, tax, what's paid and still owed, project; oldest first", rows.slice(at("INVOICES") + 2, at("INVOICES") + 4), [
  ["INV-0001", "Ada", "2026-09-01", "2026-09-08", "Paid", 10000, 0, 0, "", 10000, 10000, 0, "NGN", ""],
  ["INV-0002", "Tunde, Bakare", "2026-10-20", "2026-10-27", "Overdue", 100000, 0, 7500, "VAT", 107500, 40000, 67500, "NGN", "Brand"],
]);
eq("quotes", rows[at("QUOTES") + 2], ["QUO-0001", "Bisi", "2026-10-30", "2026-11-13", "Sent", 300000, "NGN"]);
eq("bills: paid and still owed", rows[at("BILLS") + 2], ["Dangote", "DC-1", "Cement", "2026-10-28", "2026-11-06", "Part paid", 250000, 100000, 150000, "NGN", "Supplies"]);
eq("as CSV text: a client name with a comma stays one cell", toCsv(rows).includes('INV-0002,"Tunde, Bakare",2026-10-20'), true);
eq("sections left out when empty", financeCsvRows({ income: [{ date: "2026-01-01", label: "x", cat: "y", amount: 1 }], today, currency: "USD" }).length, 2);
eq("something to export", [hasAnythingToExport({}), hasAnythingToExport({ bills: [bill] }), hasAnythingToExport({ invoices: [] })], [false, true, false]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
