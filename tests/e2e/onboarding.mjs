// End-to-end check of a new account's first two minutes: KROFT asks what it's wanted for, opens
// that part of the app, and Home shows three steps for the goal that tick themselves off as
// they're done; plus skipping the question and hiding the card.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const server = await startServer();
const browser = await chromium.launch();
try {
  console.log("\nnew account: Get paid");
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page, { skipGoal: false });

  const picker = page.getByRole("dialog", { name: "What do you want KROFT for" });
  await picker.waitFor({ timeout: 10000 });
  const text = await picker.innerText();
  check("after sign-up, KROFT asks what it's wanted for", text.includes("Ada, what do you want KROFT to help with first?") && ["Get paid", "Track my money", "Run projects", "Stay organised", "Talk to KROFT"].every(g => text.includes(g)), text.slice(0, 200));
  await picker.getByRole("button", { name: /^Get paid/ }).click();
  check("choosing Get paid opens Invoices", await page.getByRole("dialog", { name: "Invoices" }).isVisible());
  await page.getByRole("dialog", { name: "Invoices" }).getByRole("button", { name: "Back", exact: true }).click();

  const card = () => page.locator("div", { hasText: /^Getting started: Get paid/ }).first();
  check("Home shows the three steps, none done", await page.getByText("Getting started: Get paid").isVisible() && await page.getByText("0 of 3 done").isVisible());

  // Step 1 opens Invoices; adding payment details ticks it.
  await page.getByRole("button", { name: "Add how clients pay you" }).click();
  await page.getByRole("dialog", { name: "Invoices" }).getByRole("button", { name: "Details" }).click();
  await page.locator("label", { hasText: "Account number or IBAN" }).locator("input").fill("0123456789");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog", { name: "Invoices" }).getByRole("button", { name: "Back", exact: true }).click();
  check("adding payment details ticks the first step", await page.getByText("1 of 3 done").isVisible() && await page.getByRole("button", { name: "Add how clients pay you" }).isDisabled());

  // Steps 2 and 3: an invoice, then sending it.
  await page.getByRole("button", { name: "Create your first invoice" }).click();
  await page.getByRole("button", { name: "New invoice" }).click();
  await page.locator("label", { hasText: "Client name" }).locator("input").fill("Tunde");
  await page.getByLabel("Item 1 description").fill("Logo");
  await page.getByLabel("Item 1 price").fill("50000");
  await page.getByRole("button", { name: "Save invoice" }).click();
  await Promise.all([page.waitForEvent("download", { timeout: 8000 }).catch(() => null), page.getByRole("button", { name: /Share (or download )?PDF/ }).click()]);
  await page.waitForTimeout(1200);
  await page.getByRole("dialog", { name: "Invoices" }).getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("dialog", { name: "Invoices" }).getByRole("button", { name: "Back", exact: true }).click();
  check("all three done: 'You're all set'", await page.getByText("You're all set").isVisible());
  await page.getByRole("button", { name: "Done", exact: true }).click();
  check("Done hides the card", !(await page.getByText("You're all set").isVisible()));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();

  console.log("\nnew account: Run projects, then hide the card");
  const ctx2 = await newShellContext(browser, null);
  const p2 = await ctx2.newPage();
  await p2.goto(URL); await signUp(p2, { skipGoal: false });
  await p2.getByRole("button", { name: /^Run projects/ }).click();
  check("choosing Run projects opens Workspace › Projects", await p2.getByRole("button", { name: "New project" }).first().isVisible());
  await p2.locator('nav button[title="Home"]').click();
  check("the projects steps are on Home", await p2.getByText("Getting started: Run projects").isVisible() && await p2.getByRole("button", { name: "Create a project" }).isVisible());
  await p2.getByRole("button", { name: "Hide getting started" }).click();
  check("the card can be hidden", !(await p2.getByText("Getting started: Run projects").isVisible()));
  await ctx2.close();

  console.log("\nnew account: skip");
  const ctx3 = await newShellContext(browser, null);
  const p3 = await ctx3.newPage();
  await p3.goto(URL); await signUp(p3, { skipGoal: false });
  await p3.getByRole("button", { name: "I'll look around myself" }).click();
  check("skipping goes straight to Home with no card", await p3.getByText(/^Hi, Ada/).isVisible() && !(await p3.getByText(/^Getting started/).isVisible()));
  await ctx3.close();
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
const failures = failureCount();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
