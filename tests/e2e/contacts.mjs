// End-to-end check of a contact's profile: tapping a contact opens their page with what KROFT
// knows about them (money owed and paid, open quote), editing adds who they are, an invoice
// opens from the profile and Back returns to it, and "Ask KROFT" starts a chat about them.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const field = (page, label) => page.locator("label", { hasText: label }).locator("input");

async function openInvoices(page) {
  await page.locator('nav button[title="Home"]').click();
  await page.getByText(/^Finance$/).first().click();
  await page.getByRole("button", { name: /^Invoices/ }).click();
}

async function openContact(page, name) {
  await page.locator('nav button[title="Workspace"]').click();
  await page.getByText("Contacts", { exact: true }).first().click();
  const row = page.getByText(name, { exact: true }).first();
  if (!(await row.isVisible())) await page.locator("[role=button]", { hasText: /^Business/ }).first().click();
  await row.click();
}

const server = await startServer();
const browser = await chromium.launch();
try {
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL);
  await signUp(page);

  // An invoice (sent, then part paid) and a quote for Tunde. Saving adds Tunde to Contacts.
  await openInvoices(page);
  await page.getByRole("button", { name: "New invoice" }).click();
  await field(page, "Client name").fill("Tunde Bakare");
  await field(page, "Phone").fill("08031234567");
  await page.getByLabel("Item 1 description").fill("Logo design");
  await page.getByLabel("Item 1 price").fill("50000");
  await page.getByRole("button", { name: "Save invoice" }).click();
  await page.getByRole("button", { name: "Record payment" }).click();
  await field(page, "Amount received").fill("20000");
  await page.getByRole("button", { name: "Save payment" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("tab", { name: "Quotes" }).click();
  await page.getByRole("button", { name: "New quote" }).click();
  await field(page, "Client name").fill("Tunde Bakare");
  await page.getByLabel("Item 1 description").fill("Website");
  await page.getByLabel("Item 1 price").fill("300000");
  await page.getByRole("button", { name: "Save quote" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Back" }).click();

  // The profile.
  await openContact(page, "Tunde Bakare");
  const profile = page.getByRole("dialog", { name: "Tunde Bakare" });
  check("tapping a contact opens their profile", await profile.isVisible());
  const text = await profile.innerText();
  check("what KROFT knows: owed, paid, open quote", /Owes you [^\n]*30,000\.00/.test(text) && /Has paid you [^\n]*20,000\.00 across 1 invoice/.test(text) && /1 open quote worth [^\n]*300,000\.00/.test(text), text.slice(0, 400));
  check("money section lists the invoice and the quote", text.includes("INV-0001") && text.includes("QUO-0001") && /PART PAID/.test(text));
  check("quick actions for the phone number", await profile.getByRole("button", { name: "Call" }).isVisible() && await profile.getByRole("button", { name: "WhatsApp" }).isVisible());

  // Editing adds who they are.
  await profile.getByRole("button", { name: "Edit" }).click();
  await field(page, "Company").fill("Ọlá Foods");
  await field(page, "Role").fill("Marketing manager");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  check("details show in the profile and the summary", await profile.getByText("Tunde is a Marketing manager at Ọlá Foods.").isVisible() && await profile.getByText("Ọlá Foods").first().isVisible());
  await page.waitForTimeout(1200);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kroft:contacts") || "null"));
  check("edits are saved to the contact", JSON.stringify(saved).includes("Marketing manager"));

  // An invoice opens from the profile; Back comes back to it.
  await profile.getByText("INV-0001").click();
  check("invoice opens from the profile", await page.getByRole("heading", { name: "INV-0001" }).isVisible());
  await page.getByRole("button", { name: "Back" }).first().click();
  check("Back returns to the profile", await profile.isVisible() && !(await page.getByRole("heading", { name: "INV-0001" }).isVisible()));

  // Ask KROFT.
  await profile.getByRole("button", { name: /Ask KROFT about Tunde/ }).click();
  const box = page.locator("textarea").last();
  check("Ask KROFT starts a chat about them", await box.inputValue() === "What do you know about Tunde Bakare?");

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
