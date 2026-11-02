// Tests KROFT's plans and prices. Run with: npm test
import * as P from "./plans.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };

eq("three plans, in order", P.PLANS.map(p => p.id), ["free", "plus", "pro"]);
eq("naira for NGN, dollars for everyone else", [P.planPrice("plus", "month", "NGN"), P.planPrice("pro", "year", "GBP"), P.planPrice("free", "month", "NGN")],
  [{ amount: 3500, currency: "NGN" }, { amount: 129.99, currency: "USD" }, null]);
eq("yearly is two months free", [P.monthsFree("plus", "NGN"), P.monthsFree("pro", "NGN"), P.monthsFree("plus", "USD")], [2, 2, 2]);
eq("every paid plan costs less a year than 12 months", ["NGN", "USD"].every(c => ["plus", "pro"].every(id => P.PRICES[c][id].year < P.PRICES[c][id].month * 12)), true);
eq("Pro costs more than Plus", ["NGN", "USD"].every(c => P.PRICES[c].pro.month > P.PRICES[c].plus.month), true);
eq("current plan", [P.currentPlan({ subscribed: false }), P.currentPlan({ subscribed: true }), P.currentPlan({ subscribed: true, plan: "pro" })], ["free", "plus", "pro"]);
eq("Pro only counts while the subscription is active", P.currentPlan({ subscribed: false, plan: "pro" }), "free");
eq("features read as text, planned ones marked", [P.featureText("A"), P.featureText({ t: "B", soon: true })], ["A", "B"]);
eq("Pro's unbuilt features are marked soon (recurring invoices, bank import)", P.PLANS.find(p => p.id === "pro").features.filter(f => f.soon).map(P.featureText), ["Recurring invoices", "Bank statement import"]);
eq("the logo is listed as ready in Pro", P.PLANS.find(p => p.id === "pro").features.some(f => typeof f === "string" && /logo/i.test(f)), true);
const list = id => P.PLANS.find(p => p.id === id).features.map(P.featureText).join(" | ");
eq("Free says its AI extras have daily limits", /daily limits/.test(list("free")), true);
eq("Plus lists the overdue alert", /overdue/.test(list("plus")), true);
eq("Pro says what priority support means", /Priority support: your feedback is answered first/.test(list("pro")), true);
eq("payments aren't switched on until Google is connected", P.PAYMENTS_READY, false);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
