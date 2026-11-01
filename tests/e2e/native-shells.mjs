// End-to-end check of the real KROFT build as it runs inside different copies of the Android app,
// and as the plain website. Runs on every pull request (.github/workflows/ci.yml), so a change
// that breaks the app on an older APK is caught before it can be merged and go live.
//
// The page runs inside Chromium with Capacitor's real native bridge script (the same file the
// Android app injects) and fake plugins answering the native calls. Each "shell" lists which
// plugins its APK contains, matching APKs that are really out there.
//
//   npm run test:e2e        (builds a copy without Supabase, so no account or network is needed)

import { chromium } from "playwright";
import { SHELLS, check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

async function runShell(browser, label, shell) {
  console.log(`\n${label}`);
  const ctx = await newShellContext(browser, shell);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  const clientHeaders = new Set();
  page.on("request", r => { if (r.url().includes("/api/")) clientHeaders.add(r.headers()["x-kroft-client"]); });

  await page.goto(URL);
  await signUp(page);
  check("signs up and reaches the app", true);

  // Around Me: native location only when the APK has the plugin; the browser's own otherwise.
  const geoIsBrowser = await page.evaluate(() => navigator.geolocation instanceof Geolocation);
  await page.locator('nav button[title="Home"]').click();
  await page.getByText(/Around Me/).first().click();
  await page.getByRole("button", { name: "Enable location" }).click();
  await page.waitForTimeout(1200);
  if (shell) {
    const geoCalls = (await page.evaluate(() => window.__calls)).filter(c => c.startsWith("Geolocation"));
    if (shell.plugins.includes("Geolocation")) {
      check("location goes through Android's permission prompt", geoCalls.includes("Geolocation.requestPermissions") && geoCalls.includes("Geolocation.getCurrentPosition"), geoCalls.join(","));
    } else {
      check("APK without the location plugin keeps the browser's location", geoIsBrowser && geoCalls.length === 0, `browser=${geoIsBrowser} calls=${geoCalls.join(",")}`);
    }
  }

  // Profile > Security and login
  await page.locator('nav button[title="Profile"]').click();
  await page.locator("[role=button]", { hasText: /^Security and login/ }).first().click();
  if (shell) {
    await page.locator("[role=button]", { hasText: /^App permissions/ }).first().click();
    await page.waitForTimeout(700);
    const panel = await page.locator("[aria-expanded=true]").locator("xpath=..").innerText();
    check("App permissions panel lists every permission", ["Microphone", "Location", "Notifications", "Alarms & reminders"].every(t => panel.includes(t)), panel);
    await page.locator("[role=button]", { hasText: /^App permissions/ }).first().click();
    await page.locator("[role=button]", { hasText: /^Fingerprint or face unlock/ }).first().click();
    await page.locator("[aria-expanded=true]").locator("button").first().click();
    await page.waitForTimeout(800);
    const body = await page.locator("body").innerText();
    if (shell.plugins.includes("NativeBiometric")) check("fingerprint unlock turns on", /Biometric unlock is on/.test(body));
    else check("APK without the fingerprint plugin is told to update", /Update the KROFT app to use fingerprint/.test(body));
  } else {
    check("website shows Face ID setting, no app-only rows", await page.locator("[role=button]", { hasText: /^Face ID/ }).count() === 1 && await page.locator("[role=button]", { hasText: /^App permissions/ }).count() === 0);
  }

  // One AI request, to see how this copy identifies itself to the API.
  await page.getByRole("button", { name: /Ask Kroft/i }).first().click();
  const box = page.locator("textarea").last();
  await box.fill("hello");
  await box.press("Enter");
  await page.waitForTimeout(1500);
  const header = [...clientHeaders].find(Boolean) || "";
  if (shell) {
    check("API requests carry the app version and plugins",
      header.startsWith(`android;shell=${shell.info.version};build=${shell.info.build};web=`) && header.includes(shell.plugins.includes("Filesystem") ? "fs" : "sr"), header);
  } else {
    check("API requests identify the website", header.startsWith("web;web="), header);
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

const server = await startServer();
const browser = await chromium.launch();
try {
  await runShell(browser, "website (no app)", null);
  for (const [label, shell] of Object.entries(SHELLS)) await runShell(browser, label, shell);
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
const failures = failureCount();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
