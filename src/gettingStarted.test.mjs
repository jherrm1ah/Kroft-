// Tests the getting-started steps. Run with: npm test
import { GOALS, startProgress, nextStep, goalById } from "./gettingStarted.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };

eq("five goals, three steps each", [GOALS.length, GOALS.every(g => g.steps.length === 3)], [5, true]);
eq("unknown goal: nothing to show", [startProgress("nope", {}), goalById(undefined)], [null, null]);

const fresh = startProgress("paid", {});
eq("a new account: nothing done, first step next", [fresh.doneCount, fresh.complete, nextStep(fresh).id], [0, false, "details"]);
const half = startProgress("paid", { invoiceSettings: { otherPayment: " PayPal: x " }, invoices: [{ status: "draft" }] });
eq("steps tick off from real data", [half.steps.map(s => s.done), nextStep(half).id], [[true, true, false], "send"]);
const all = startProgress("paid", { invoiceSettings: { bankName: "GTBank" }, invoices: [{ status: "sent" }] });
eq("all done", [all.complete, nextStep(all)], [true, null]);

eq("money", startProgress("money", { expenses: [{}], budgets: { Rent: 0, Food: 5000 }, bills: [] }).steps.map(s => s.done), [true, true, false]);
eq("a zero budget doesn't count", startProgress("money", { budgets: { Rent: 0 } }).steps[1].done, false);
eq("projects", startProgress("projects", { projects: [{ milestones: [{ title: "a" }, { dueDate: "2026-11-09" }] }], invoices: [{ projectId: "p" }] }).complete, true);
eq("organised", startProgress("organised", { tasks: [{}], appts: [], notes: [{}] }).doneCount, 2);
eq("assistant: an earlier chat counts as asking", startProgress("assistant", { chatHistory: [{}], smartReminders: [], voiceTurnsCount: 2 }).steps.map(s => s.done), [true, false, true]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
