// End-to-end check of the plan picker: every Upgrade opens it first, showing Free, Plus and Pro
// with prices (naira for NGN), monthly and yearly, what's coming soon, and a payment step that
// says plainly Google payment isn't switched on yet, so nobody can be charged by mistake.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const server = await startServer();
const browser = await chromium.launch();
try {
  console.log("\nwebsite");
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);

  // From Profile.
  await page.locator('nav button[title="Profile"]').click();
  await page.getByText("Upgrade plan", { exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Choose your plan" });
  check("Upgrade opens the plans first", await sheet.isVisible());
  let text = await sheet.innerText();
  check("three plans with prices", ["Free", "Plus", "Pro", "MOST POPULAR", "CURRENT"].every(t => text.includes(t)) && /\$4\.99/.test(text) && /\$12\.99/.test(text), text.slice(0, 300));
  check("Pro's planned features are marked soon", (text.match(/SOON/g) || []).length === 4);
  await sheet.getByRole("tab", { name: /^Yearly/ }).click();
  text = await sheet.innerText();
  check("yearly prices", /\$49\.99/.test(text) && /\$129\.99/.test(text) && /2 months free/.test(text), text.slice(0, 200));

  await sheet.getByRole("button", { name: "Choose Plus" }).click();
  const pay = page.getByRole("dialog", { name: "Upgrade" });
  text = await pay.innerText();
  check("the payment step: plan, yearly price, and that Google payment is coming", text.includes("KROFT Plus") && /\$49\.99/.test(text) && text.includes("Billed yearly") && text.includes("Nothing has been charged"), text.slice(0, 300));
  check("…and there's no way to pay yet", await pay.getByRole("button", { name: "Google Pay · coming soon" }).isDisabled());
  await pay.getByRole("button", { name: "Back" }).click();
  check("Back returns to the plans", await sheet.isVisible());
  await sheet.getByRole("button", { name: "Close" }).click();
  check("closes", !(await sheet.isVisible()));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // From Invoices, once the free invoices are used. (Naira prices are covered in src/plans.test.mjs.)
  console.log("\nfrom Invoices");
  const ng = await newShellContext(browser, null);
  const p2 = await ng.newPage();
  await p2.goto(URL); await signUp(p2);
  await p2.locator('nav button[title="Home"]').click();
  await p2.getByText(/^Finance$/).first().click();
  await p2.getByRole("button", { name: /^Invoices/ }).click();
  for (let i = 0; i < 4; i++) {
    await p2.getByRole("button", { name: "New invoice" }).click();
    if (await p2.getByRole("dialog", { name: "Choose your plan" }).isVisible().catch(() => false)) break;
    await p2.locator("label", { hasText: "Client name" }).locator("input").fill(`Client ${i}`);
    await p2.getByLabel("Item 1 description").fill("Work");
    await p2.getByLabel("Item 1 price").fill("1000");
    await p2.getByRole("button", { name: "Save invoice" }).click();
    await p2.getByRole("button", { name: "Back" }).click();
  }
  const s2 = p2.getByRole("dialog", { name: "Choose your plan" });
  check("using up the free invoices opens the plans", await s2.isVisible());
  await ng.close();
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
const failures = failureCount();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
