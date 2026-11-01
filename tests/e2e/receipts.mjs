// End-to-end check of receipts and client statements: a receipt PDF for each payment on an
// invoice (numbered INV-0001-R1, -R2…), and a statement of account for a client with every
// invoice and payment and the balance, on the website and in the Android app.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { SHELLS, check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const pdfFromDownload = async dl => {
  const chunks = [];
  for await (const c of await dl.createReadStream()) chunks.push(c);
  return Buffer.concat(chunks).toString("latin1");
};
const iso = d => d.toISOString().slice(0, 10);

async function invoiceWithPayments(page) {
  await page.locator('nav button[title="Home"]').click();
  await page.getByText(/^Finance$/).first().click();
  await page.getByRole("button", { name: /^Invoices/ }).click();
  for (const [what, price] of [["Logo", "50000"], ["Flyers", "20000"]]) {
    await page.getByRole("button", { name: "New invoice" }).click();
    await page.locator("label", { hasText: "Client name" }).locator("input").fill("Tunde Bakare");
    await page.getByLabel("Item 1 description").fill(what);
    await page.getByLabel("Item 1 price").fill(price);
    await page.getByRole("button", { name: "Save invoice" }).click();
    // Sharing the PDF sends it (drafts aren't on statements).
    const share = page.getByRole("button", { name: /Share (or download )?PDF/ });
    const dl = page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
    await share.click(); await dl; await page.waitForTimeout(1500);
    if (what === "Logo") {
      const amountBox = page.locator("label", { hasText: "Amount received" }).locator("input");
      await page.getByRole("button", { name: "Record payment" }).click();
      await amountBox.fill("20000");
      await page.locator("label", { hasText: "Date received" }).locator("input").fill(iso(new Date(Date.now() - 2 * 86400000)));
      await page.getByRole("button", { name: "Save payment" }).click();
      await page.getByRole("button", { name: "Record payment" }).click();
      await amountBox.fill("10000");
      await page.getByRole("button", { name: "Save payment" }).click();
    }
    await page.getByRole("button", { name: "Back" }).click();
  }
}

async function website(browser) {
  console.log("\nwebsite");
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);
  await invoiceWithPayments(page);

  // Receipts.
  await page.getByText("INV-0001", { exact: false }).first().click();
  const buttons = page.getByRole("button", { name: /^Receipt for the payment of/ });
  check("each payment has a Receipt button", await buttons.count() === 2);
  let [dl] = await Promise.all([page.waitForEvent("download"), buttons.nth(1).click()]);
  let pdf = await pdfFromDownload(dl);
  check("receipt downloads, numbered after the invoice", dl.suggestedFilename() === "Receipt INV-0001-R2 Tunde Bakare.pdf", dl.suggestedFilename());
  check("receipt is a valid one-page PDF titled with its number", pdf.startsWith("%PDF-1.4") && /\/Count 1\b/.test(pdf) && pdf.includes("(Receipt INV-0001-R2)"));

  // Statement: from the client.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("tab", { name: "Clients" }).click();
  await page.getByText("Tunde Bakare").first().click();
  await page.getByRole("button", { name: "Statement of account" }).click();
  const shown = await page.getByAltText(/Preview of the statement for Tunde Bakare/).waitFor({ timeout: 10000 }).then(() => true, () => false);
  const body = await page.locator("body").innerText();
  check("statement shows invoiced, paid and the balance, with a preview", shown && /Invoiced\s*\n?\s*\$70,000\.00/.test(body) && /Paid\s*\n?\s*\$30,000\.00/.test(body) && /Balance due\s*\n?\s*\$40,000\.00/.test(body), body.slice(0, 300));
  [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Share or download PDF" }).click()]);
  pdf = await pdfFromDownload(dl);
  check("statement downloads as a PDF named for the client and date", /^Statement Tunde Bakare \d{4}-\d{2}-\d{2}\.pdf$/.test(dl.suggestedFilename()) && pdf.startsWith("%PDF-1.4"), dl.suggestedFilename());
  await page.getByRole("tab", { name: "This year" }).click();
  check("period can be changed", await page.getByRole("tab", { name: "This year" }).getAttribute("aria-selected") === "true");
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

async function android(browser) {
  console.log("\nAndroid app");
  const ctx = await newShellContext(browser, SHELLS["current APK (1.1.0)"]);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);
  await invoiceWithPayments(page);
  await page.getByText("INV-0001", { exact: false }).first().click();
  await page.getByRole("button", { name: /^Receipt for the payment of/ }).first().click();
  await page.waitForTimeout(2500);
  const args = await page.evaluate(() => window.__args || {});
  const w = args["Filesystem.writeFile"] || {}, sh = args["Share.share"] || {};
  check("receipt is saved on the phone and shared with a thank-you message", w.path === "exports/Receipt INV-0001-R1 Tunde Bakare.pdf" && String(w.data).startsWith("JVBERi0") && String(sh.text).includes("Thank you for your payment"), JSON.stringify({ path: w.path, text: sh.text }).slice(0, 200));
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
