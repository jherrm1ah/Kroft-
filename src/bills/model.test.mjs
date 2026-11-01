// Tests supplier bills. Run with: npm test
import * as B from "./model.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };
const fmt = (n, cur) => `${cur} ${n.toFixed(2)}`;
const today = "2026-11-02";

const cement = B.createBill({ supplier: " Dangote Cement ", ref: "DC-1182", description: "40 bags", amount: 250000.005, currency: "NGN", category: "Supplies", billDate: "2026-10-28", dueDate: "2026-11-06", today, id: "b1" });
eq("a new bill: trimmed, rounded, open, no payments", [cement.supplier, cement.amount, cement.status, cement.payments, cement.dueDate], ["Dangote Cement", 250000.01, "open", [], "2026-11-06"]);
eq("an overdue bill with no bill date is dated its due date", B.createBill({ supplier: "X", amount: 1, currency: "NGN", dueDate: "2026-10-20", today, id: "y" }).billDate, "2026-10-20");
eq("no dates: dated today, due today", (({ billDate, dueDate }) => [billDate, dueDate])(B.createBill({ supplier: "X", amount: 1, currency: "NGN", today, id: "x" })), [today, today]);

eq("problems before saving", [B.billProblem({ supplier: "", amount: 5 }), B.billProblem({ supplier: "A", amount: 0 }), B.billProblem({ supplier: "A", amount: 5, billDate: "2026-11-02", dueDate: "2026-11-01" }), B.billProblem(cement)],
  ["Add who the bill is from.", "Enter the amount of the bill.", "The due date can't be before the bill date.", ""]);

// Statuses.
const at = (dueDate, extra = {}) => ({ ...cement, dueDate, ...extra });
eq("statuses from dates and payments", [
  B.billStatus(at("2026-12-20"), today), B.billStatus(at("2026-11-06"), today), B.billStatus(at("2026-11-01"), today),
  B.billStatus(B.recordBillPayment(at("2026-12-20"), { id: "p", amount: 1000, date: today }), today),
  B.billStatus(B.recordBillPayment(at("2026-11-01"), { id: "p", amount: 250000.01, date: today }), today),
  B.billStatus(at("2026-11-01", { status: "cancelled" }), today),
], ["due", "soon", "overdue", "partial", "paid", "cancelled"]);
eq("when, in words", [B.billWhen(at("2026-11-02"), today), B.billWhen(at("2026-11-03"), today), B.billWhen(at("2026-11-06"), today), B.billWhen(at("2026-10-31"), today), B.billWhen(at("2026-11-01"), today), B.billWhen(at("2026-12-20"), today)],
  ["Due today", "Due tomorrow", "Due in 4 days", "2 days overdue", "1 day overdue", "Due 2026-12-20"]);

// Paying.
let paid = B.recordBillPayment(cement, { id: "p1", amount: 100000, date: "2026-10-30", expenseId: "e1" });
paid = B.recordBillPayment(paid, { id: "p2", amount: 150000.01, date: today, expenseId: "e2" });
eq("paid in two parts", [B.billPaid(paid), B.billBalance(paid), B.billStatus(paid, today), B.billWhen(paid, today)], [250000.01, 0, "paid", `Paid ${today}`]);
eq("removing a payment opens it again", [B.billBalance(B.removeBillPayment(paid, "p2")), B.billStatus(B.removeBillPayment(paid, "p2"), today)], [150000.01, "partial"]);
eq("amount can't go below what's paid", B.billProblem({ ...paid, amount: 1000 }), "The amount can't be less than what's already been paid.");
eq("expense labels", [B.billExpenseLabel(cement, false), B.billExpenseLabel({ ...cement, ref: "" }, true)], ["Bill · Dangote Cement (DC-1182)", "Bill · Dangote Cement (part payment)"]);

// Following the expense entries.
const expenses = [{ id: "e1", amount: 90000, date: "2026-10-31" }, { id: "e2", amount: 150000.01, date: today }];
const bills = [paid, cement];
const synced = B.syncBillsWithExpenses(bills, expenses);
eq("an edited expense updates its payment", [synced[0].payments[0].amount, synced[0].payments[0].date, B.billBalance(synced[0])], [90000, "2026-10-31", 10000]);
eq("a deleted expense removes its payment", B.billPayments(B.syncBillsWithExpenses([paid], [expenses[1]])[0]).map(p => p.id), ["p2"]);
const same = [B.recordBillPayment(cement, { id: "p", amount: 5, date: today, expenseId: "e9" })];
eq("nothing to change: same list back", B.syncBillsWithExpenses(same, [{ id: "e9", amount: 5, date: today }]) === same, true);

// Summaries.
const list = [
  B.createBill({ supplier: "Dangote Cement", amount: 250000, currency: "NGN", dueDate: "2026-11-06", today, id: "a" }),                    // soon
  B.createBill({ supplier: "PHCN", amount: 30000, currency: "NGN", billDate: "2026-10-01", dueDate: "2026-10-20", today, id: "b" }),        // overdue
  B.createBill({ supplier: "dangote cement", amount: 50000, currency: "NGN", dueDate: "2026-12-30", today, id: "c" }),                       // later
  B.createBill({ supplier: "AWS", amount: 40, currency: "USD", dueDate: "2026-11-02", today, id: "d" }),                                     // today
  B.recordBillPayment(B.createBill({ supplier: "Paid Co", amount: 10, currency: "NGN", dueDate: "2026-10-01", today, id: "e" }), { id: "x", amount: 10, date: today }),
  { ...B.createBill({ supplier: "Gone", amount: 99, currency: "NGN", dueDate: "2026-10-01", today, id: "f" }), status: "cancelled" },
];
const sum = B.billsSummary(list, today);
eq("summary: owed per currency, overdue, due this week", [sum.owed, sum.overdue, sum.soon, sum.overdueCount, sum.soonCount, sum.openCount],
  [{ NGN: 330000, USD: 40 }, { NGN: 30000 }, { NGN: 250000, USD: 40 }, 1, 2, 4]);
eq("suppliers: same name together, most owed first", B.supplierSummaries(list, today).map(s => [s.name, s.owed, s.count, s.overdueCount]),
  [["Dangote Cement", { NGN: 300000 }, 2, 0], ["PHCN", { NGN: 30000 }, 1, 1], ["AWS", { USD: 40 }, 1, 0]]);
eq("list order: open by due date, then paid/cancelled", B.sortBills(list, today).map(b => b.id), ["b", "d", "a", "c", "e", "f"]);

// Reminders at 9am the day before and on the day.
const now = new Date("2026-11-02T10:00:00").getTime();
const rem = B.billReminders(list, today, now, fmt);
eq("reminders: only ahead, only open bills", rem.map(r => r.clientKey), ["bill:a:before", "bill:a:day", "bill:c:before", "bill:c:day"]);
eq("reminder text", [rem[0].title, rem[0].body, new Date(rem[0].firesAt).getHours()], ["Bill due tomorrow: Dangote Cement", "NGN 250000.00", 9]);

eq("AI summary", B.billsForAI(list, today, fmt), "4 to pay (1 overdue): PHCN NGN 30000.00 due 2026-10-20 (OVERDUE); AWS USD 40.00 due 2026-11-02; Dangote Cement NGN 250000.00 due 2026-11-06; dangote cement NGN 50000.00 due 2026-12-30");
eq("AI summary with nothing to pay", B.billsForAI([], today, fmt), "0 bills on record, none to pay.");

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
