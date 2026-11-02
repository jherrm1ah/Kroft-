// End-to-end check of the error log: an unexpected error in the running app is sent to
// /api/log-error, cleaned of personal data, with the app's version; noise isn't sent; and a page
// closing sends what's waiting.
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
  const reports = [];
  await page.route("**/api/log-error", async route => { reports.push(route.request().postDataJSON()); await route.fulfill({ status: 200, body: "{}" }); });
  await page.clock.install();
  await page.goto(URL); await signUp(page);

  // What the browser fires for an uncaught error (Playwright's clock would swallow a real throw).
  await page.evaluate(() => {
    const fire = msg => { const error = new Error(msg); window.dispatchEvent(new ErrorEvent("error", { error, message: msg, filename: `${location.origin}/assets/index-x.js?v=1`, lineno: 1, colno: 9 })); };
    fire("Totals broke for ada@example.com, amount 250000");
    fire("Totals broke for ada@example.com, amount 250000");
    Promise.reject(new Error("Couldn't load 0803 123 4567"));
    fire("ResizeObserver loop limit exceeded");
  });
  await page.clock.runFor(11000);
  await page.waitForTimeout(500);
  const errors = reports.flatMap(r => r.errors);
  const totals = errors.find(e => e.message.startsWith("Totals broke"));
  check("an unexpected error is reported, once, with a count", !!totals && totals.count === 2 && totals.kind === "error", JSON.stringify(errors));
  check("personal data is cleaned out before it's sent", totals?.message === "Totals broke for [email], amount [number]" && errors.some(e => e.kind === "promise" && e.message === "Couldn't load [number]"), JSON.stringify(errors.map(e => e.message)));
  check("noise isn't sent", !errors.some(e => /ResizeObserver/.test(e.message)));
  check("where it happened, without the site's address or query", totals?.source === "/assets/index-x.js:1:9", totals?.source);
  check("the app's version comes with it", typeof reports[0]?.client === "string");

  // Waiting errors are sent when the page closes.
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent("error", { error: new Error("late one"), message: "late one" })));
  const beacon = page.waitForRequest("**/api/log-error", { timeout: 5000 }).catch(() => null);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const req = await beacon;
  check("on closing, what's waiting is sent", !!req && /late one/.test(req.postData() || ""));
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
