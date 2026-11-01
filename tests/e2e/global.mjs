// End-to-end check that invoices work for a business outside Nigeria: the tax can be named the
// way the country names it (GST, Sales tax, IVA…), with a tax number; payment details take an
// IBAN and anything else (SWIFT, sort code, PayPal); and money and dates follow the person's own
// region. Runs as a phone set to German (de-DE).
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, failureCount, URL } from "./harness.mjs";

const server = await startServer();
const browser = await chromium.launch();
try {
  console.log("\nphone set to German (de-DE)");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "de-DE", acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);
  await page.locator('nav button[title="Home"]').click();
  await page.getByText(/^Finance$/).first().click();
  await page.getByRole("button", { name: /^Invoices/ }).click();

  const newInvoice = async (client, price) => {
    await page.getByRole("button", { name: "New invoice" }).click();
    await page.locator("label", { hasText: "Client name" }).locator("input").fill(client);
    await page.getByLabel("Item 1 description").fill("Website");
    await page.getByLabel("Item 1 price").fill(price);
  };

  // A first invoice asks for payment details: tax name and number, IBAN and other ways to pay.
  await newInvoice("Lena", "500");
  await page.getByRole("button", { name: "Save invoice" }).click();
  await page.getByText("Add details").click();
  const field = name => page.locator("label", { hasText: name }).locator("input");
  await field("Account number or IBAN").fill("de89 3704 0044 0532 0130 00");
  check("IBAN letters are kept (and capitalised)", await field("Account number or IBAN").inputValue() === "DE89 3704 0044 0532 0130 00");
  await page.getByLabel("Other payment details").fill("SWIFT/BIC: COBADEFFXXX\nPayPal: ada@example.com");
  await field("Tax name").fill("MwSt");
  await field("MwSt % (0 if none)").fill("19");
  await field("Tax number (optional)").fill("DE123456789");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  check("payment details count as added (no 'Add your bank details' prompt)", !(await page.getByText("Add details").isVisible()));

  // A new invoice uses that tax name, and money is written the German way.
  await page.getByRole("button", { name: "Back" }).click();
  await newInvoice("Jonas", "1000");
  check("the editor names the tax MwSt, with the rate from settings", await page.locator("label", { hasText: "MwSt %" }).first().isVisible() && await page.locator("label", { hasText: "MwSt %" }).locator("input").first().inputValue() === "19");
  const editor = await page.locator("body").innerText();
  check("totals show 'MwSt (19%)' and German number format", editor.includes("MwSt (19%)") && /1\.190,00/.test(editor), editor.match(/MwSt[^\n]*\n?[^\n]*/)?.[0]);
  await page.getByRole("button", { name: "Save invoice" }).click();
  const shown = await page.getByAltText(/Preview of INV-0002/).waitFor({ timeout: 10000 }).then(() => true, () => false);
  const view = await page.locator("body").innerText();
  check("the saved invoice previews, with the total in German format", shown && /1\.190,00/.test(view), view.slice(0, 200));
  check("due date in German order (day, then month)", /\d{1,2}\. [A-ZÄÖÜa-zäöü]{3,4}\.? \d{4}/.test(view), view.match(/Fällig|Due[^\n]*/)?.[0]);
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
