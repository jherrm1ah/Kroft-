// Tests receipts and client statements. Run with: npm test
import * as M from "./model.js";
import * as D from "./documents.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };
const fmt = (n, cur) => `${cur} ${n.toFixed(2)}`;
const today = "2026-11-01";

const make = (number, total, issueDate, dueDate, extra = {}) => ({
  id: number, kind: "invoice", number, currency: "NGN", issueDate, dueDate, status: "sent", vatRate: 0, discount: 0,
  client: { name: "Tunde Bakare", email: "tunde@example.com" }, clientId: "c1", items: [{ description: "Work", qty: 1, price: total }], ...extra,
});

// ── Receipts ──
let inv = make("INV-0007", 100000, "2026-10-01", "2026-10-15");
inv = M.recordPayment(inv, { id: "a", amount: 40000, date: "2026-10-05" }, today);
inv = M.recordPayment(inv, { id: "b", amount: 60000, date: "2026-10-20" }, today);
eq("payments get receipt numbers in order", ["a", "b"].map(id => D.receiptNumber(inv, id)), ["INV-0007-R1", "INV-0007-R2"]);
const r1 = D.receiptFor(inv, "a"), r2 = D.receiptFor(inv, "b");
eq("first receipt: paid 40,000, 60,000 still due", [r1.amount, r1.paidBefore, r1.balanceAfter, r1.paidInFull], [40000, 0, 60000, false]);
eq("second receipt: paid in full", [r2.amount, r2.paidBefore, r2.balanceAfter, r2.paidInFull], [60000, 40000, 0, true]);
eq("receipt for an unknown payment", D.receiptFor(inv, "zzz"), null);

// A payment removed and another recorded: numbers aren't reused.
let again = M.removePayment(inv, "b", today);
again = M.recordPayment(again, { id: "c", amount: 10000, date: "2026-10-25" }, today);
eq("a removed receipt's number isn't reused", D.receiptNumber(again, "c"), "INV-0007-R3");
// A payment dated before an earlier-recorded one counts as paid before it.
let back = M.recordPayment(make("INV-0008", 50000, "2026-10-01", "2026-10-30"), { id: "x", amount: 20000, date: "2026-10-20" }, today);
back = M.recordPayment(back, { id: "y", amount: 10000, date: "2026-10-10" }, today);
eq("receipts follow the payment dates", [D.receiptFor(back, "y").paidBefore, D.receiptFor(back, "x").paidBefore, D.receiptFor(back, "x").balanceAfter], [0, 10000, 20000]);
// Invoices marked paid before part payments existed.
const legacy = make("INV-0002", 30000, "2026-09-01", "2026-09-08", { status: "paid", paidDate: "2026-09-05", incomeId: "inc1" });
eq("old paid invoices have a receipt too", [D.receiptNumber(legacy, "inc1"), D.receiptFor(legacy, "inc1").paidInFull], ["INV-0002-R1", true]);

const msg = D.receiptMessage(r1, fmt, "Ada Designs");
eq("receipt message: thanks, amount, what's still due", [msg.startsWith("Hi Tunde,"), msg.includes("NGN 40000.00 for invoice INV-0007"), msg.includes("NGN 60000.00 is still due"), msg.endsWith("Ada Designs")], [true, true, true, true]);
eq("receipt file name", D.receiptFileName({ number: "INV-0007-R1", client: { name: "Tunde Bákàrè" } }), "Receipt INV-0007-R1 Tunde Bakare.pdf");

// ── Statements ──
const key = M.clientKey(inv);
const invoices = [
  inv,                                                                                             // 100,000 on 1 Oct, paid 40k (5 Oct) + 60k (20 Oct)
  M.recordPayment(make("INV-0009", 80000, "2026-10-10", "2026-10-24"), { id: "p9", amount: 30000, date: "2026-10-28" }, today), // 50k left, overdue
  make("INV-0004", 20000, "2026-08-01", "2026-08-15"),                                             // older, unpaid
  make("INV-0010", 5000, "2026-10-30", "2026-11-13", { status: "draft" }),                        // draft: left out
  make("INV-0011", 9000, "2026-10-12", "2026-10-26", { status: "cancelled" }),                    // cancelled: left out
  make("INV-0012", 700, "2026-10-12", "2026-10-26", { currency: "USD" }),                         // other currency
  make("INV-0013", 1000, "2026-10-12", "2026-10-26", { clientId: "c2", client: { name: "Other" } }), // other client
];
eq("currencies the client was invoiced in", D.statementCurrencies(invoices, key), ["NGN", "USD"]);

const all = D.statementFor({ invoices, key, currency: "NGN", from: null, to: today });
eq("all time: no opening balance, every invoice and payment in date order", [all.opening, all.lines.map(l => `${l.date} ${l.details} ${l.balance}`)], [0, [
  "2026-08-01 Invoice INV-0004 20000", "2026-10-01 Invoice INV-0007 120000", "2026-10-05 Payment, invoice INV-0007 80000",
  "2026-10-10 Invoice INV-0009 160000", "2026-10-20 Payment, invoice INV-0007 100000", "2026-10-28 Payment, invoice INV-0009 70000"]]);
eq("all time: invoiced, paid, balance", [all.invoiced, all.paid, all.closing], [200000, 130000, 70000]);
eq("unpaid invoices, oldest first, with days overdue", all.unpaid.map(u => [u.number, u.due, u.daysOverdue]), [["INV-0004", 20000, 78], ["INV-0009", 50000, 8]]);
eq("overdue total", all.overdue, 70000);

const oct = D.statementFor({ invoices, key, currency: "NGN", from: "2026-10-01", to: "2026-10-15" });
eq("a period: opening balance from before it, only its activity, balance at its end", [oct.opening, oct.lines.length, oct.invoiced, oct.paid, oct.closing], [20000, 3, 180000, 40000, 160000]);
eq("unpaid as of the statement date ignores later payments", oct.unpaid.map(u => [u.number, u.due, u.daysOverdue]), [["INV-0004", 20000, 61], ["INV-0007", 60000, 0], ["INV-0009", 80000, 0]]);
eq("closing balance = opening + invoiced − paid", oct.closing, oct.opening + oct.invoiced - oct.paid);

const usd = D.statementFor({ invoices, key, currency: "USD", from: null, to: today });
eq("one currency per statement", [usd.lines.length, usd.closing], [1, 700]);
const nothing = D.statementFor({ invoices, key, currency: "NGN", from: "2026-11-01", to: today });
eq("a quiet period: opening equals closing", [nothing.lines.length, nothing.opening, nothing.closing], [0, 70000, 70000]);

const sm = D.statementMessage(all, fmt, "Tunde Bakare", "Ada Designs");
eq("statement message says the balance and what's overdue", [sm.startsWith("Hi Tunde,"), sm.includes("NGN 70000.00, of which NGN 70000.00 is overdue")], [true, true]);
eq("paid-up statement message", D.statementMessage({ ...all, closing: 0, overdue: 0 }, fmt).includes("fully paid"), true);
eq("periods", [D.periodStart("all", today), D.periodStart("year", today), D.periodStart("90", today)], [null, "2026-01-01", "2026-08-04"]);
eq("statement file name", D.statementFileName("Tunde Bákàrè", today), "Statement Tunde Bakare 2026-11-01.pdf");

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
