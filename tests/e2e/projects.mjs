// End-to-end check of projects' business side (Workspace › Projects): a project for a client
// with a value, milestones with due dates and amounts, invoicing a milestone in one tap (the
// draft invoice opens, and the milestone shows it), the project's money, and in the Android app
// a phone reminder on the day a milestone is due.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { SHELLS, check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inDays = n => ymd(new Date(Date.now() + n * 86400000));

async function openProjects(page) {
  await page.locator('nav button[title="Workspace"]').click();
  await page.getByText("Projects", { exact: true }).first().click();
}

async function newProject(page, { name, client = "", value = "" }) {
  await page.getByRole("button", { name: "Create Project" }).first().click();
  await page.getByPlaceholder("Project name").first().fill(name);
  if (client) await page.getByLabel("Client").first().fill(client);
  if (value) await page.getByLabel("Project value").first().fill(value);
  await page.getByRole("button", { name: "Create", exact: true }).click();
}

async function addMilestone(page, { title, due = "", amount = "" }) {
  await page.getByRole("button", { name: "+ New" }).first().click();
  await page.getByLabel("Milestone", { exact: true }).fill(title);
  if (due) await page.getByLabel("Milestone due date").fill(due);
  if (amount) await page.getByLabel("Milestone amount").fill(amount);
  await page.getByRole("button", { name: "Add", exact: true }).click();
}

async function website(browser) {
  console.log("\nwebsite");
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);
  await openProjects(page);

  await newProject(page, { name: "Shop website", client: "Ọlá Stores", value: "600000" });
  check("project shows who it's for and its value", await page.getByText("For Ọlá Stores · $600,000.00").isVisible());
  await page.getByText("Shop website").first().click();
  check("an untouched project's money: value and what's left to invoice", /VALUE\s*\n?\s*\$600,000\.00/.test(await page.locator("body").innerText()) && /TO INVOICE\s*\n?\s*\$600,000\.00/.test(await page.locator("body").innerText()));

  await addMilestone(page, { title: "Design approved", due: inDays(3), amount: "200000" });
  await addMilestone(page, { title: "Kick-off call" });
  let body = await page.locator("body").innerText();
  check("milestone shows when it's due and its amount", body.includes("Due in 3 days · $200,000.00"), body.slice(body.indexOf("MILESTONES"), body.indexOf("MILESTONES") + 200));
  check("only milestones with an amount can be invoiced", await page.getByRole("button", { name: "Invoice milestone Design approved" }).isVisible() && !(await page.getByRole("button", { name: "Invoice milestone Kick-off call" }).isVisible()));

  await page.getByRole("button", { name: "Invoice milestone Design approved" }).click();
  const opened = await page.getByAltText(/Preview of INV-0001/).waitFor({ timeout: 10000 }).then(() => true, () => false);
  body = await page.locator("body").innerText();
  check("invoicing a milestone opens its draft invoice for the client", opened && body.includes("Ọlá Stores") && /200,000\.00/.test(body) && body.includes("DRAFT"), body.slice(0, 200));
  // Sharing it sends it, which counts it as invoiced.
  await Promise.all([page.waitForEvent("download", { timeout: 8000 }).catch(() => null), page.getByRole("button", { name: /Share (or download )?PDF/ }).click()]);
  await page.waitForTimeout(1200);
  await page.getByRole("dialog", { name: "Invoices" }).getByRole("button", { name: "Back" }).click();

  body = await page.locator("body").innerText();
  check("the milestone shows its invoice", await page.getByRole("button", { name: "Open invoice INV-0001" }).isVisible() && body.includes("INV-0001 · SENT"), body.slice(body.indexOf("MILESTONES"), body.indexOf("MILESTONES") + 260));
  check("project money: invoiced, owed and still to invoice", /INVOICED\s*\n?\s*\$200,000\.00/.test(body) && /OWED\s*\n?\s*\$200,000\.00/.test(body) && /TO INVOICE\s*\n?\s*\$400,000\.00/.test(body), body.match(/VALUE[\s\S]{0,200}/)?.[0]);
  const fin = await page.evaluate(() => JSON.parse(localStorage.getItem("kroft:finance") || "null"));
  check("the invoice is linked to the project and milestone", fin?.invoices?.[0]?.projectId && fin.invoices[0].milestoneId && fin.invoices[0].items[0].description === "Shop website — Design approved", JSON.stringify(fin?.invoices?.[0]?.items));

  // A project with no client can't invoice a milestone yet.
  await newProject(page, { name: "Side thing" });
  await page.getByText("Side thing").first().click();
  await addMilestone(page, { title: "Part one", amount: "5000" });
  await page.getByRole("button", { name: "Invoice milestone Part one" }).click();
  check("a project needs a client before invoicing", await page.getByText("Add who the project is for first (Edit the project).").isVisible());
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

async function android(browser) {
  console.log("\nAndroid app");
  const ctx = await newShellContext(browser, SHELLS["current APK (1.1.0)"]);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.goto(URL); await signUp(page);
  await openProjects(page);
  await newProject(page, { name: "Wedding shoot", client: "Bisi" });
  await page.getByText("Wedding shoot").first().click();
  await addMilestone(page, { title: "Deliver photos", due: inDays(4) });
  await page.waitForTimeout(2500);
  const scheduled = (await page.evaluate(() => window.__all || [])).filter(c => c.key === "LocalNotifications.schedule").flatMap(c => c.options.notifications || []);
  const ms = scheduled.filter(n => String(n.extra?.clientKey || "").startsWith("milestone:"));
  check("a phone reminder at 9am on the day the milestone is due", ms.length === 1 && ms[0].title === "Milestone due today: Deliver photos" && ms[0].body === "Wedding shoot" && new Date(ms[0].schedule.at).getHours() === 9, JSON.stringify(ms.map(n => [n.title, n.schedule?.at])));
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
