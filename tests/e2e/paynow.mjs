// End-to-end check of Pay now: the business adds its own payment link (Paystack, Flutterwave…) in
// Invoice details, and every unpaid invoice gets a Pay now button that opens it, as a real tappable
// link in the PDF. A link that isn't a web address is pointed out; paid invoices have no button.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const pdfText = async dl => { const chunks = []; for await (const c of await dl.createReadStream()) chunks.push(c); return Buffer.concat(chunks).toString("latin1"); };
const server = await startServer();
const browser = await chromium.launch();
try {
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);
  await page.getByRole("tab", { name: "Finance" }).click();
  await page.getByRole("button", { name: /^Invoices/ }).click();
  await page.getByRole("button", { name: "Details" }).click();

  const field = page.getByLabel("Online payment link");
  await field.fill("my bank account");
  check("a link that isn't a web address is pointed out", await page.getByText("That doesn't look like a web address.", { exact: false }).isVisible());
  await field.fill("paystack.com/pay/ada-studio");
  check("a real link is explained: straight to you", await page.getByText("the money goes straight to you", { exact: false }).isVisible());
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await page.getByRole("button", { name: "New invoice" }).click();
  await page.locator("label", { hasText: "Client name" }).locator("input").fill("Tunde Bakare");
  await page.getByLabel("Item 1 description").fill("Brand design");
  await page.getByLabel("Item 1 price").fill("50000");
  await page.getByRole("button", { name: "Save invoice" }).click();
  await page.locator('img[alt="Preview of INV-0001"]').waitFor({ timeout: 15000 });

  let [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Share (or download )?PDF/ }).click()]);
  let pdf = await pdfText(dl);
  check("the invoice PDF has a tappable Pay now link to the business's own page", /\/Subtype \/Link [^>]*\/URI \(https:\/\/paystack\.com\/pay\/ada-studio\)/.test(pdf));

  // Paid: no button.
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.locator("label", { hasText: "Amount received" }).locator("input").fill("50000");
  await page.getByRole("button", { name: "Save payment" }).click();
  await page.waitForTimeout(800);
  [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Share (or download )?PDF/ }).click()]);
  pdf = await pdfText(dl);
  check("a paid invoice has no Pay now", !pdf.includes("/Subtype /Link"));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
const failures = failureCount();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
