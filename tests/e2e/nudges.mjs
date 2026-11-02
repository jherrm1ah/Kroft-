// End-to-end check of upgrade nudges: a Free user making invoices is shown what Plus adds, a Plus
// user with several projects what Pro adds, and a Pro user nothing. The button opens the plans;
// the X closes it, and nothing else shows the same day.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const server = await startServer();
const browser = await chromium.launch();

async function context(extra = {}) {
  const ctx = await newShellContext(browser, null);
  await ctx.addInitScript(keys => { for (const [k, v] of Object.entries(keys)) localStorage.setItem(k, v); }, { "kroft-e2e-nudges": "1", ...extra });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);
  return { ctx, page, errors };
}
async function projects(page, n) {
  await page.locator('nav button[title="Workspace"]').click();
  await page.getByText("Projects", { exact: true }).first().click();
  for (let i = 1; i <= n; i++) {
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.getByPlaceholder("Project name").first().fill(`Project ${i}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
  }
}

try {
  // Free: invoices.
  console.log("\nFree");
  let { ctx, page, errors } = await context();
  await page.locator('nav button[title="Home"]').click();
  await page.getByRole("tab", { name: "Finance" }).click();
  await page.getByRole("button", { name: /^Invoices/ }).click();
  for (const who of ["Tunde Bakare", "Ngozi Eze"]) {
    await page.getByRole("button", { name: "New invoice" }).click();
    await page.locator("label", { hasText: "Client name" }).locator("input").fill(who);
    await page.getByLabel("Item 1 description").fill("Design");
    await page.getByLabel("Item 1 price").fill("20000");
    await page.getByRole("button", { name: "Save invoice" }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
  }
  const card = page.getByRole("dialog", { name: "Running a business on KROFT?" });
  await card.waitFor({ timeout: 15000 }).catch(() => {});
  check("Free, two invoices this month: Plus is suggested", await card.isVisible() && (await card.innerText()).includes("unlimited invoices and quotes"));
  await card.getByRole("button", { name: "Get Plus" }).click();
  check("…its button opens the plans", await page.getByRole("dialog", { name: "Choose your plan" }).isVisible());
  check("…and the nudge gets out of the way", !(await card.isVisible()));
  await page.getByRole("dialog", { name: "Choose your plan" }).getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(2000);
  check("only one nudge a day", !(await page.getByRole("dialog", { name: /KROFT|Plus|Pro/ }).filter({ hasText: "Upgrade to" }).isVisible()));
  check("no page errors (Free)", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // Plus: projects → Pro, closed with the X.
  console.log("\nPlus");
  ({ ctx, page, errors } = await context({ "kroft-e2e-plus": "1" }));
  await projects(page, 2);
  const pro = page.getByRole("dialog", { name: "Bring KROFT to your biggest clients" });
  await pro.waitFor({ timeout: 15000 }).catch(() => {});
  check("Plus, two projects: Pro is suggested", await pro.isVisible() && await pro.getByRole("button", { name: "Upgrade to Pro" }).isVisible());
  await pro.getByRole("button", { name: "Close" }).click();
  check("the X closes it", !(await pro.isVisible()));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("kroft-nudges")));
  check("…and it's remembered, so it stays away", saved.closedAt?.["pro-projects"] > 0 && saved.shows?.["pro-projects"] === 1, JSON.stringify(saved));
  check("no page errors (Plus)", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // Pro: nothing.
  console.log("\nPro");
  ({ ctx, page, errors } = await context({ "kroft-e2e-pro": "1" }));
  await projects(page, 2);
  await page.waitForTimeout(9000);   // past when a nudge would have appeared
  check("Pro never sees a nudge", (await page.getByRole("button", { name: /Get Plus|Upgrade to Pro/ }).count()) === 0);
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
