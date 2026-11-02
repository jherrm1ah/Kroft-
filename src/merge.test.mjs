// Tests merging two devices' changes. Run with: npm test
import { merge3 } from "./merge.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };

const base = {
  income: [{ id: 1, label: "Salary", amount: 100 }],
  expenses: [{ id: 10, label: "Rent", amount: 50 }, { id: 11, label: "Fuel", amount: 20 }],
  invoices: [{ id: "a", number: "INV-0001", status: "sent", payments: [] }],
  invoiceSettings: { nextNumber: 2, prefix: "INV" },
  cats: ["Rent", "Fuel"],
};

// Phone adds an expense and pays the invoice; website adds income and edits rent.
const phone = { ...base, expenses: [...base.expenses, { id: 12, label: "Lunch", amount: 5 }], invoices: [{ ...base.invoices[0], status: "paid", payments: [{ id: "p1", amount: 30 }] }] };
const web = { ...base, income: [...base.income, { id: 2, label: "Gift", amount: 40 }], expenses: [{ id: 10, label: "Rent", amount: 55 }, base.expenses[1]] };
const m = merge3(base, phone, web);
eq("both devices' new items are kept", [m.income.map(x => x.id), m.expenses.map(x => x.id)], [[1, 2], [10, 11, 12]]);
eq("edits to different items both survive", [m.expenses[0].amount, m.invoices[0].status, m.invoices[0].payments.length], [55, "paid", 1]);

// Deletes.
eq("deleted on one device, untouched on the other: deleted", merge3(base, { ...base, expenses: [base.expenses[0]] }, base).expenses.map(x => x.id), [10]);
eq("deleted on one device, edited on the other: the edit is kept", merge3(base, { ...base, expenses: [base.expenses[0]] }, { ...base, expenses: [base.expenses[0], { id: 11, label: "Fuel", amount: 25 }] }).expenses.map(x => [x.id, x.amount]), [[10, 50], [11, 25]]);
eq("everything deleted on one device", merge3(base, { ...base, expenses: [] }, base).expenses, []);

// Same item edited on both: field by field, this device wins a clash.
eq("same item, different fields: both kept", merge3({ id: 1, a: 1, b: 1 }, { id: 1, a: 2, b: 1 }, { id: 1, a: 1, b: 3 }), { id: 1, a: 2, b: 3 });
eq("same field changed on both: this device wins", merge3({ x: "old" }, { x: "mine" }, { x: "theirs" }), { x: "mine" });
eq("a number both raised takes the larger (next invoice number)", merge3({ n: 2 }, { n: 3 }, { n: 4 }).n, 4);

// Order: this device's order; the other device's new items after the item they follow there.
eq("new items placed sensibly", merge3([{ id: 1 }, { id: 2 }], [{ id: 0 }, { id: 1 }, { id: 2 }], [{ id: 1 }, { id: 5 }, { id: 2 }]).map(x => x.id), [0, 1, 5, 2]);
eq("an item added at the top elsewhere stays at the top", merge3([{ id: 1 }], [{ id: 1 }, { id: 2 }], [{ id: 9 }, { id: 1 }]).map(x => x.id), [9, 1, 2]);

// Plain lists (categories, linked ids).
eq("plain lists: additions from both, removals from both", merge3(["a", "b", "c"], ["a", "c", "d"], ["a", "b", "c", "e"]), ["a", "c", "d", "e"]);
eq("plain list removed on one side, re-added on the other stays", merge3(["a"], [], ["a", "b"]), ["b"]);

// Nothing in common to compare with (first save after updating KROFT): nothing is lost.
eq("no base: union of both", merge3(undefined, { list: [{ id: 1 }] }, { list: [{ id: 2 }] }).list.map(x => x.id), [2, 1]);
eq("unchanged on one side: the other side as is", [merge3(base, base, web) === web, merge3(base, phone, base) === phone], [true, true]);
eq("a field removed here, unchanged there: removed", merge3({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 }), { a: 1 });
eq("a field added on both sides", merge3({}, { a: 1 }, { b: 2 }), { a: 1, b: 2 });
eq("lists without ids: this device's list", merge3([[1]], [[2]], [[3]]), [[2]]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
