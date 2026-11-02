// Tests the business side of projects. Run with: npm test
import * as P from "./money.js";
import * as M from "../invoices/model.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };
const fmt = (n, cur) => `${cur} ${n.toFixed(2)}`;
const today = "2026-11-02";

const project = {
  id: "p1", name: "Website for Ọlá Stores", status: "In Progress", clientName: "Ọlá Stores", value: 600000, currency: "NGN",
  expenseIds: ["e1", "e2"], incomeIds: ["i1", "i9"],
  milestones: [
    { id: "m1", title: "Design", done: true, dueDate: "2026-10-20", amount: 200000, invoiceId: "inv1" },
    { id: "m2", title: "Build", done: false, dueDate: "2026-10-30", amount: 300000, invoiceId: "inv2" },
    { id: "m3", title: "Launch", done: false, dueDate: "2026-11-05", amount: 100000 },
    { id: "m4", title: "Handover", done: false },
  ],
};
const inv = (id, total, extra = {}) => ({ id, kind: "invoice", number: id.toUpperCase(), currency: "NGN", issueDate: "2026-10-20", dueDate: "2026-10-27", status: "sent", vatRate: 0, discount: 0, items: [{ description: "x", qty: 1, price: total }], client: { name: "Ọlá Stores" }, projectId: "p1", ...extra });
const invoices = [
  M.recordPayment(inv("inv1", 200000), { id: "pay1", amount: 200000, date: "2026-10-25", incomeId: "i9" }, today), // paid in full
  M.recordPayment(inv("inv2", 300000), { id: "pay2", amount: 100000, date: "2026-11-01" }, today),                    // part paid
  inv("inv3", 50000, { status: "draft" }),                                                                             // draft: not counted
  inv("inv4", 70000, { status: "cancelled" }),                                                                         // cancelled: not counted
  inv("inv5", 999, { projectId: "other" }),                                                                            // another project
];
const income = [{ id: "i1", amount: 25000 }, { id: "i9", amount: 200000, invoiceId: "inv1" }, { id: "i2", amount: 1 }];
const expenses = [{ id: "e1", amount: 120000 }, { id: "e2", amount: 30000.5 }, { id: "e3", amount: 7 }];

const m = P.projectMoney({ project, invoices, income, expenses });
eq("money: value, invoiced, paid, owed, still to invoice", [m.value, m.invoiced, m.paid, m.owed, m.toInvoice], [600000, 500000, 300000, 200000, 100000]);
eq("earned counts invoice payments once, plus other linked income", m.earned, 325000);
eq("spent and profit", [m.spent, m.profit], [150000.5, 174999.5]);
eq("an older project with nothing set", P.projectMoney({ project: { id: "x" } }), { value: 0, invoiced: 0, paid: 0, earned: 0, spent: 0, owed: 0, toInvoice: 0, profit: 0 });

eq("milestone states", project.milestones.map(x => P.milestoneState(x, today)), ["done", "overdue", "soon", ""]);
eq("milestone when", project.milestones.map(x => P.milestoneWhen(x, today)), ["Due 2026-10-20", "3 days overdue", "Due in 3 days", ""]);
eq("milestone invoice and its status", [P.milestoneInvoice(project.milestones[0], invoices, today).status, P.milestoneInvoice(project.milestones[1], invoices, today).status, P.milestoneInvoice(project.milestones[2], invoices, today)], ["paid", "overdue", null]);

eq("can a milestone be invoiced?", [
  P.milestoneInvoiceProblem(project, project.milestones[2]),
  P.milestoneInvoiceProblem(project, project.milestones[3]),
  P.milestoneInvoiceProblem({ ...project, clientName: " " }, project.milestones[2]),
], ["", "Add an amount to the milestone first.", "Add who the project is for first (Edit the project)."]);
eq("the milestone's invoice line", P.milestoneInvoiceItems(project, project.milestones[2]), [{ description: "Website for Ọlá Stores — Launch", qty: 1, price: 100000 }]);

const now = new Date("2026-11-02T10:00:00").getTime();
const rem = P.milestoneReminders([project, { ...project, id: "p2", status: "Completed" }], today, now);
eq("reminders: open milestones still ahead, 9am on the day", rem.map(r => [r.clientKey, r.title, r.body, new Date(r.firesAt).getHours()]), [["milestone:m3", "Milestone due today: Launch", "Website for Ọlá Stores", 9]]);

eq("AI line", P.projectLineForAI(project, invoices, today, fmt),
  "Website for Ọlá Stores — In Progress, for Ọlá Stores, 1/4 milestones done, next: Build due 2026-10-30 (OVERDUE), worth NGN 600000.00, invoiced NGN 500000.00, paid NGN 300000.00");
eq("AI line for a plain old project", P.projectLineForAI({ name: "Garden", status: "Not Started" }, [], today, fmt), "Garden — Not Started");

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
