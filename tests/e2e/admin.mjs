// End-to-end check of the owner's admin page (Profile › Admin): only the owner sees it, and it
// shows people, AI health and cost, feedback (which can be ticked off), errors, alerts and the
// last backup. The server's answer is stood in for here; api/_lib/ops.test.mjs tests the server.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const summary = {
  admin: true,
  people: { total: 14, new7: 5, new1: 2 }, active: { today: 4, week: 9 },
  ai: { last24: { requests: 12, failed: 12, lastError: "upstream_403 PERMISSION_DENIED API_KEY_INVALID" }, days: [{ day: "2026-11-02", requests: 12, failed: 12, cost: 0 }, { day: "2026-11-01", requests: 40, failed: 3, cost: 0.0123 }] },
  feedback: [{ id: 5, created_at: "2026-11-02T08:00:00Z", kind: "problem", message: "The invoice PDF came out blank", screen: "Invoices", email: "tester@example.com", done: false }],
  errors: [{ kind: "error", message: "Cannot read properties of undefined (reading 'amount')", source: "/assets/index.js:1:9", times: 7, people: 3, last_seen: "2026-11-02T09:00:00Z" }],
  alerts: [{ created_at: "2026-11-02T08:05:00Z", title: "KROFT's AI is failing", body: "12 of the last 12 AI requests failed.", delivered: 1 }],
  lastBackup: "2026-11-02",
};

const server = await startServer();
const browser = await chromium.launch();
try {
  console.log("\nsomeone else");
  const other = await newShellContext(browser, null);
  const o = await other.newPage();
  await o.goto(URL); await signUp(o);
  await o.locator('nav button[title="Profile"]').click();
  check("there's no Admin in Profile for anyone else", !(await o.getByText("Admin", { exact: true }).isVisible()));
  await other.close();

  console.log("\nthe owner");
  const ctx = await newShellContext(browser, null);
  await ctx.addInitScript(() => localStorage.setItem("kroft-e2e-admin", "1"));
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const posts = [];
  await page.route("**/api/admin**", async route => {
    if (route.request().method() === "POST") { posts.push(route.request().postDataJSON()); return route.fulfill({ status: 200, body: '{"ok":true}' }); }
    await route.fulfill({ status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(summary) });
  });
  await page.goto(URL); await signUp(page);
  await page.locator('nav button[title="Profile"]').click();
  await page.getByText("Admin", { exact: true }).click();
  const admin = page.getByRole("dialog", { name: "Admin" });
  await admin.getByText("Accounts").waitFor({ timeout: 8000 });
  const t = await admin.innerText();
  check("people: accounts, new this week, active today and this week", /Accounts\s*14/.test(t) && /New this week\s*5/.test(t) && /Active today\s*4/.test(t) && /Active this week\s*9/.test(t), t.slice(0, 200));
  check("AI health shows it failing, and why", t.includes("0 of 12 worked") && t.includes("12 failed: upstream_403 PERMISSION_DENIED API_KEY_INVALID") && t.includes("40 requests · 3 failed · $0.0123"), t.slice(t.indexOf("AI"), t.indexOf("AI") + 250));
  check("feedback, errors, alerts and backup are listed", t.includes("The invoice PDF came out blank") && t.includes("Invoices · tester@example.com") && t.includes("7× · 3 people") && t.includes("KROFT's AI is failing") && t.includes("sent to 1 device") && t.includes("Last backup copy: 2026-11-02"));
  await admin.getByRole("button", { name: "Done", exact: true }).click();
  check("feedback can be ticked off", posts[0]?.action === "feedbackDone" && posts[0].id === 5 && posts[0].done === true && await admin.getByRole("button", { name: "Reopen" }).waitFor({ timeout: 4000 }).then(() => true, () => false), JSON.stringify(posts));
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
