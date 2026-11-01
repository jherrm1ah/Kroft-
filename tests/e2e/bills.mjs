// End-to-end check of supplier bills (Finance › Bills): adding a bill, paying it in two parts
// (each payment lands in expenses), the status and what's owed updating, telling KROFT about a
// bill in chat, and in the Android app the phone reminders for the day before and the due day.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { SHELLS, check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const sse = (text, action) => {
  const full = action ? `${text}<action>${JSON.stringify(action)}</action>` : text;
  return `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: full } })}\n\ndata: [DONE]\n\n`;
};
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inDays = n => ymd(new Date(Date.now() + n * 86400000));

async function openBills(page) {
  const closeChat = page.getByRole("button", { name: "Close Ask Kroft" });
  if (await closeChat.isVisible().catch(() => false)) await closeChat.click();
  await page.locator('nav button[title="Home"]').click();
  await page.getByText(/^Finance$/).first().click();
  await page.getByRole("button", { name: /^Bills/ }).click();
}

async function addBill(page, { supplier, amount, due, ref = "" }) {
  await page.getByRole("button", { name: "New bill" }).click();
  const field = name => page.locator("label", { hasText: name }).locator("input");
  await field("Who it's from").fill(supplier);
  await field("Amount").fill(amount);
  if (ref) await field("Their reference").fill(ref);
  await field("Due date").fill(due);
  await page.getByRole("tab", { name: "Operations" }).click();
  await page.getByRole("button", { name: "Save bill" }).click();
}

const finance = page => page.evaluate(() => JSON.parse(localStorage.getItem("kroft:finance") || "null"));
const savedSoon = (page, test) => page.waitForFunction(fn => { const f = JSON.parse(localStorage.getItem("kroft:finance") || "null"); return f && new Function("f", `return (${fn})(f)`)(f); }, test.toString(), { timeout: 5000 }).catch(() => {});

async function website(browser) {
  console.log("\nwebsite");
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  let reply = null;
  await page.route("**/api/chat", route => route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: reply }));
  await page.goto(URL); await signUp(page);

  await openBills(page);
  check("empty Bills screen explains what it's for", await page.getByText("No bills yet").isVisible());
  await page.getByRole("button", { name: "New bill" }).click();
  await page.getByRole("button", { name: "Save bill" }).click();
  check("a bill needs a supplier", await page.getByText("Add who the bill is from.").isVisible());
  await page.getByRole("button", { name: "Back" }).click();

  await addBill(page, { supplier: "Dangote Cement", amount: "250,000", due: inDays(3), ref: "DC-1182" });
  let body = await page.locator("body").innerText();
  check("saved bill shows what's owed and when", /250,000\.00/.test(body) && body.includes("DUE SOON") && body.includes("Due in 3 days") && body.includes("DC-1182"), body.slice(0, 240));

  // Part payment, then the rest.
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.locator("label", { hasText: "Amount paid" }).locator("input").fill("100000");
  await page.getByRole("button", { name: "Save payment" }).click();
  body = await page.locator("body").innerText();
  check("part payment: part paid, 150,000 still owed", body.includes("PART PAID") && /150,000\.00/.test(body) && /100,000\.00 paid of/.test(body), body.slice(0, 240));
  await page.getByRole("button", { name: "Record payment" }).click();
  check("next payment offers what's left", await page.locator("label", { hasText: "Amount paid" }).locator("input").inputValue() === "150000");
  await page.getByRole("button", { name: "Save payment" }).click();
  check("paid in full", await page.getByText("PAID", { exact: true }).first().isVisible());

  await savedSoon(page, f => (f.bills || []).some(b => b.payments?.length === 2) && f.expenses.length === 2);
  const f = await finance(page);
  const exps = f?.expenses || [];
  check("each payment is an expense in the bill's category", exps.length === 2 && exps[0].label === "Bill · Dangote Cement (DC-1182) (part payment)" && exps[0].amount === 100000 && exps[1].amount === 150000 && exps.every(e => e.cat === "Operations" && e.billId), JSON.stringify(exps));

  // Deleting the expense elsewhere reopens the bill.
  await page.evaluate(() => {});
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("tab", { name: "Paid" }).click();
  check("paid bills are under Paid", await page.getByText("Dangote Cement").first().isVisible());
  await page.getByRole("tab", { name: /^To pay/ }).click();
  check("nothing left to pay", await page.getByText("Nothing to pay. You're all caught up.").isVisible());

  // An overdue one.
  await addBill(page, { supplier: "PHCN", amount: "30000", due: inDays(-2) });
  await page.getByRole("button", { name: "Back" }).click();
  body = await page.locator("body").innerText();
  check("overdue bill: counted and shown first", body.includes("2 days overdue") && body.includes("OVERDUE") && /30,000\.00 overdue/.test(body), body.slice(0, 300));
  await page.getByRole("button", { name: "Back" }).click();
  check("Finance's Bills button says how many are overdue", await page.getByRole("button", { name: "Bills · 1 overdue" }).isVisible());

  // Telling KROFT.
  reply = sse("Saved the bill from Ikeja Electric.", { type: "add_bill", supplier: "Ikeja Electric", amount: 45000, due: inDays(10), ref: "IE-77" });
  await page.getByRole("button", { name: /Ask Kroft/i }).first().click();
  const box = page.locator("textarea").last();
  await box.fill("I owe Ikeja Electric 45k, due in 10 days");
  await box.press("Enter");
  const saved = await page.getByText(/Bill from Ikeja Electric saved/).waitFor({ timeout: 10000 }).then(() => true, () => false);
  check("asking KROFT saves a bill", saved);
  await openBills(page);
  check("it's in Bills", await page.getByText("Ikeja Electric", { exact: true }).first().isVisible());
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

async function android(browser) {
  console.log("\nAndroid app");
  const ctx = await newShellContext(browser, SHELLS["current APK (1.1.0)"]);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);
  await openBills(page);
  await addBill(page, { supplier: "Landlord", amount: "500000", due: inDays(5) });
  await page.waitForTimeout(2500);
  const scheduled = (await page.evaluate(() => window.__all || [])).filter(c => c.key === "LocalNotifications.schedule").flatMap(c => c.options.notifications || []);
  const bill = scheduled.filter(n => String(n.extra?.clientKey || "").startsWith("bill:"));
  check("phone reminders the day before and on the day, at 9am", bill.length === 2 && bill.some(n => n.title === "Bill due tomorrow: Landlord") && bill.some(n => n.title === "Bill due today: Landlord") && bill.every(n => new Date(n.schedule.at).getHours() === 9), JSON.stringify(bill.map(n => [n.title, n.schedule?.at])));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

const server = await startServer();
const browser = await chromium.launch();
try {
  await website(browser);
  await android(browser);
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
const failures = failureCount();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
