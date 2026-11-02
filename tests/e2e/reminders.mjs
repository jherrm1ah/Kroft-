// End-to-end check of the Reminders screen: one clear "New reminder" button with AI suggest and
// Schedule a call (marked Plus) beside each other, a count of what's left, To do and Done kept
// apart, ticking off with the circle, tapping a reminder to edit it, and clearing done ones
// (with undo).
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const server = await startServer();
const browser = await chromium.launch();
try {
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);
  await page.locator('nav button[title="Workspace"]').click();
  await page.getByText("Reminders", { exact: true }).first().click();

  check("empty: says so, with one way to add", await page.getByText("No reminders yet").isVisible() && await page.getByRole("button", { name: /New reminder/ }).count() === 1);
  check("the screen's title isn't repeated", await page.getByRole("heading", { name: "Reminders" }).count() === 0);
  check("AI suggest and Schedule a call sit side by side", await page.getByRole("button", { name: /AI suggest/ }).isVisible() && await page.getByRole("button", { name: "Schedule a call (KROFT Plus)" }).isVisible());

  for (const [t, w] of [["Call Tunde about the logo invoice", "Tomorrow 9am"], ["Pay the landlord", "Friday"], ["Take a long walk", "Today"]]) {
    await page.getByRole("button", { name: /New reminder/ }).click();
    await page.getByPlaceholder("Remind me to…").fill(t);
    await page.getByPlaceholder("When e.g. Tomorrow 9am").fill(w);
    await page.getByRole("button", { name: "Add", exact: true }).click();
  }
  check("a count of what's left", await page.getByText("reminders to go", { exact: false }).isVisible() && (await page.getByText("reminders to go", { exact: false }).innerText()).startsWith("reminders to go"));

  await page.getByRole("button", { name: 'Mark "Take a long walk" done' }).click();
  check("ticked off: counted as done", await page.getByText("reminders to go · 1 done").isVisible());
  check("done ones are folded away", await page.getByRole("button", { name: "Done (1)" }).isVisible() && !(await page.getByText("Take a long walk").isVisible()));
  await page.getByRole("button", { name: "Done (1)" }).click();
  check("…and open when tapped", await page.getByText("Take a long walk").isVisible());

  await page.getByRole("button", { name: 'Edit "Pay the landlord"' }).click();
  await page.getByPlaceholder("When").fill("Friday 10am");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  check("tapping a reminder edits it", await page.getByText("Friday 10am").isVisible());

  await page.getByRole("button", { name: "Clear done" }).click();
  check("Clear done removes them", !(await page.getByText("Take a long walk").isVisible()) && await page.getByText("Cleared 1 done reminder.").isVisible());

  await page.getByRole("button", { name: 'Mark "Pay the landlord" done' }).click();
  await page.getByRole("button", { name: 'Mark "Call Tunde about the logo invoice" done' }).click();
  check("everything ticked off: All done", await page.getByText("All done").isVisible());

  await page.getByRole("button", { name: "Schedule a call (KROFT Plus)" }).click();
  check("Schedule a call on Free opens the plans", await page.getByRole("dialog", { name: "Choose your plan" }).isVisible());
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
