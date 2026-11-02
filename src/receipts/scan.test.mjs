// Tests reading a receipt from the AI's reply. Run with: npm test
import { receiptPrompt, parseReceiptReply } from "./scan.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };
const opts = { categories: ["Operations", "Travel", "Food"], currency: "NGN", today: "2026-11-02" };

const prompt = receiptPrompt(opts);
eq("prompt names the categories, currency and today", [prompt.includes("Operations, Travel, Food"), prompt.includes("use NGN"), prompt.includes("use 2026-11-02")], [true, true, true]);

eq("a plain reply", parseReceiptReply('{"receipt":true,"merchant":"Shoprite Lekki","date":"2026-10-30","total":12500.5,"currency":"ngn","category":"food","due":""}', opts),
  { ok: true, merchant: "Shoprite Lekki", date: "2026-10-30", total: 12500.5, currency: "NGN", category: "Food", due: "" });
eq("in a code block, with a total as text", parseReceiptReply('```json\n{"receipt":true,"merchant":"Uber","date":"2026-11-01","total":"4,300","currency":"NGN","category":"Travel"}\n```', opts).total, 4300);
eq("a future or missing date becomes today", [parseReceiptReply('{"merchant":"A","date":"2027-01-01","total":5}', opts).date, parseReceiptReply('{"merchant":"A","total":5}', opts).date], ["2026-11-02", "2026-11-02"]);
eq("unknown category is left blank, odd currency falls back", (({ category, currency }) => [category, currency])(parseReceiptReply('{"merchant":"A","total":5,"category":"Gadgets","currency":"naira"}', opts)), ["", "NGN"]);
eq("a bill with a due date", parseReceiptReply('{"merchant":"Ikeja Electric","total":45000,"due":"2026-11-20"}', opts).due, "2026-11-20");
eq("no name", parseReceiptReply('{"total":5}', opts).merchant, "Receipt");
eq("problems", [parseReceiptReply('{"receipt":false}', opts), parseReceiptReply('{"merchant":"A","total":0}', opts), parseReceiptReply("Sorry, I can't read that.", opts)],
  [{ ok: false, reason: "not-receipt" }, { ok: false, reason: "no-total" }, { ok: false, reason: "unreadable" }]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
