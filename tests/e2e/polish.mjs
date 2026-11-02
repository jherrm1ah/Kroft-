// End-to-end check of the layout polish: Workspace screens don't repeat their title and lead with
// one full-width main button; Home's first day shows one "Start with your money" card instead of
// three $0 cards; Finance has two main buttons and a 2×2 tools grid; pop-up messages never cover
// the header's buttons or the tabs.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const server = await startServer();
const browser = await chromium.launch();
const overlaps = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

try {
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);

  // Home, day one.
  check("Home: one 'Start with your money' card", await page.getByText("Start with your money").isVisible());
  check("Home: no $0 profit bar or 'no data' card", !(await page.getByText("Net profit this month").isVisible()) && !(await page.getByText("No financial data yet").isVisible()));

  // The welcome message mustn't cover the header's buttons or the tabs.
  const toast = await page.getByText("Welcome to KROFT, Ada.").boundingBox();
  const help = await page.getByRole("button", { name: /help|\?/i }).first().boundingBox().catch(() => null);
  const ask = await page.getByRole("button", { name: /Ask Kroft/ }).first().boundingBox().catch(() => null);
  const tabs = await page.getByText("Overview", { exact: true }).first().boundingBox();
  check("pop-up messages don't cover the header or the tabs", toast && !overlaps(toast, help) && !overlaps(toast, ask) && !overlaps(toast, tabs), JSON.stringify({ toast, ask, tabs }));

  await page.getByRole("button", { name: "Add income" }).first().click();
  check("Home: Add income opens the form in Finance", await page.getByRole("dialog", { name: "New income entry" }).isVisible());
  await page.getByRole("dialog", { name: "New income entry" }).getByRole("button", { name: "Close" }).click();

  // Finance.
  const main = await page.getByRole("button", { name: "Add income" }).boundingBox();
  const exp = await page.getByRole("button", { name: "Add expense" }).boundingBox();
  check("Finance: Add income and Add expense side by side, one line each", main && exp && Math.abs(main.y - exp.y) < 2 && main.height < 56 && exp.height < 56, JSON.stringify({ main, exp }));
  const tools = await Promise.all(["Scan receipt", "Invoices", "Bills", "Export"].map(n => page.getByRole("button", { name: n, exact: true }).boundingBox()));
  check("Finance: the four tools in a 2×2 grid", tools.every(Boolean) && Math.abs(tools[0].y - tools[1].y) < 2 && Math.abs(tools[2].y - tools[3].y) < 2 && tools[2].y > tools[0].y && Math.abs(tools[0].x - tools[2].x) < 2, JSON.stringify(tools));

  // Workspace screens.
  for (const [screen, button] of [["Calendar", "New appointment"], ["Notes", "New note"], ["Tasks", "New task"], ["Documents", "New document"], ["Projects", "New project"], ["Voice Memos", "Record a memo"], ["Contacts", "New contact"], ["Email", "Compose"]]) {
    await page.locator('nav button[title="Workspace"]').click();
    await page.getByText(screen, { exact: true }).first().click();
    const b = page.getByRole("button", { name: button, exact: true });
    const box = await b.boundingBox().catch(() => null);
    check(`${screen}: title not repeated, one full-width "${button}"`, (await page.getByRole("heading", { name: screen }).count()) === 0 && (await b.count()) === 1 && box && box.width > 300, JSON.stringify(box));
  }
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
