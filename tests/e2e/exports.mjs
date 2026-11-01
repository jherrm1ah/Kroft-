// End-to-end check that exports actually produce a file: the finance CSV (Finance › Export) and
// the full backup (Profile › History and data › Download backup), on a computer (a real download
// with the right contents), on a phone browser (the share sheet gets the file) and in the Android
// app (written to the phone, then the share sheet). Before this, phones showed "CSV downloaded"
// while the download had already been cancelled.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { SHELLS, check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const sse = action => `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: `Done.<action>${JSON.stringify(action)}</action>` } })}\n\ndata: [DONE]\n\n`;

// Records an income entry through KROFT's chat (with a faked AI reply), so there's something to export.
async function addIncome(page) {
  await page.route("**/api/chat", route => route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body: sse({ type: "add_income", label: "Logo design", amount: 50000, cat: "Freelance" }) }));
  await page.getByRole("button", { name: /Ask Kroft/i }).first().click();
  const box = page.locator("textarea").last();
  await box.fill("I got paid 50k for the logo");
  await box.press("Enter");
  await page.getByText(/Income added: Logo design/).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Close Ask Kroft" }).click();
}

async function exportCsv(page) {
  await page.locator('nav button[title="Home"]').click();
  await page.getByText(/^Finance$/).first().click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
}

async function exportBackup(page) {
  await page.locator('nav button[title="Profile"]').click();
  await page.locator("[role=button]", { hasText: /^History and data/ }).first().click();
  // The only row on that screen, so it opens already expanded.
  const download = page.getByRole("button", { name: "Download backup" });
  if (!(await download.isVisible())) await page.locator("[role=button]", { hasText: /^Backup & Restore/ }).first().click();
  await download.click();
}

const readDownload = async dl => { const chunks = []; for await (const c of await dl.createReadStream()) chunks.push(c); return Buffer.concat(chunks).toString("utf8"); };

async function computer(browser) {
  console.log("\ncomputer (website)");
  const ctx = await newShellContext(browser, null);
  const page = await ctx.newPage();
  await page.goto(URL); await signUp(page); await addIncome(page);
  const [csv] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), exportCsv(page)]);
  const csvText = await readDownload(csv);
  check("finance CSV downloads with its rows", /^kroft-finance-\d{4}-\d{2}-\d{2}\.csv$/.test(csv.suggestedFilename()) && csvText.startsWith("Date,Type,Description") && csvText.includes("Logo design"), `${csv.suggestedFilename()} ${csvText.slice(0, 60)}`);
  const [bk] = await Promise.all([page.waitForEvent("download", { timeout: 10000 }), exportBackup(page)]);
  const backup = JSON.parse(await readDownload(bk));
  check("backup downloads as KROFT JSON with the income in it", backup.app === "KROFT" && JSON.stringify(backup.data.finance).includes("Logo design"));
  await ctx.close();
}

async function phone(browser) {
  console.log("\nphone browser");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  // A phone's share sheet, recording what it was handed.
  await ctx.addInitScript(() => {
    window.__shared = [];
    navigator.canShare = d => !!d?.files?.length;
    navigator.share = async d => { const f = d.files[0]; window.__shared.push({ name: f.name, type: f.type, text: await f.text() }); };
  });
  const page = await ctx.newPage();
  let downloaded = false;
  page.on("download", () => { downloaded = true; });
  await page.goto(URL); await signUp(page); await addIncome(page);
  await exportCsv(page);
  await page.waitForFunction(() => window.__shared.length >= 1, null, { timeout: 5000 }).catch(() => {});
  await exportBackup(page);
  await page.waitForFunction(() => window.__shared.length >= 2, null, { timeout: 5000 }).catch(() => {});
  const shared = await page.evaluate(() => window.__shared);
  check("phone: CSV goes to the share sheet with its rows", shared[0]?.type === "text/csv" && shared[0]?.text.includes("Logo design"), JSON.stringify(shared[0])?.slice(0, 120));
  check("phone: backup goes to the share sheet", shared[1]?.type === "application/json" && shared[1]?.text.includes('"app": "KROFT"'), JSON.stringify(shared[1])?.slice(0, 120));
  check("phone: no false 'downloaded' message", !(await page.locator("body").innerText()).includes("downloaded") && !downloaded);
  await ctx.close();
}

async function androidApp(browser) {
  console.log("\nAndroid app (current APK)");
  const ctx = await newShellContext(browser, SHELLS["current APK (1.1.0)"]);
  const page = await ctx.newPage();
  await page.goto(URL); await signUp(page); await addIncome(page);
  await exportCsv(page);
  await page.waitForTimeout(1500);
  const w = (await page.evaluate(() => window.__args || {}))["Filesystem.writeFile"] || {};
  check("app: CSV written to the phone as text, then shared", /^exports\/kroft-finance-.*\.csv$/.test(w.path) && w.encoding === "utf8" && String(w.data).includes("Logo design") && (await page.evaluate(() => window.__calls)).includes("Share.share"), JSON.stringify({ path: w.path, enc: w.encoding }));
  await ctx.close();
}

const server = await startServer();
const browser = await chromium.launch();
try {
  await computer(browser);
  await phone(browser);
  await androidApp(browser);
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
const failures = failureCount();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
