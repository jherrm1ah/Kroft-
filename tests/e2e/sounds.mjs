// End-to-end check of KROFT's sounds: the Sounds switch and its previews (Profile › Appearance),
// the payment sound when money comes in, silence when switched off, and in the Android app (1.2.0)
// the "KROFT alerts" channel with the signature sound, plus the quiet channel used while KROFT is
// open and plays the sound itself. The speaker is a fake that records every note.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { SHELLS, check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

const FAKE_AUDIO = `
  window.__notes = [];
  class FakeParam { setValueAtTime(v) { this.v = v; } exponentialRampToValueAtTime(v) { this.v = v; } }
  class FakeNode { connect(n) { return n; } }
  class FakeOsc extends FakeNode { constructor() { super(); this.frequency = new FakeParam(); } start() { window.__notes.push(Math.round(this.frequency.v)); } stop() {} }
  class FakeGain extends FakeNode { constructor() { super(); this.gain = new FakeParam(); } }
  window.AudioContext = class { constructor() { this.state = "running"; this.destination = new FakeNode(); } get currentTime() { return 0; }
    resume() { return Promise.resolve(); } createOscillator() { return new FakeOsc(); } createGain() { return new FakeGain(); } };
`;
// KROFT's notes (src/sounds/defs.js), rounded: the signature is G5 → D6 → B5.
const SIGNATURE = [784, 1175, 988];
const PAYMENT = [1175, 1568];
const notes = page => page.evaluate(() => window.__notes);
const clearNotes = page => page.evaluate(() => { window.__notes = []; });
const has = (list, wanted) => wanted.every(f => list.includes(f));

async function openSounds(page) {
  await page.locator('nav button[title="Profile"]').click();
  await page.locator("[role=button]", { hasText: /^Appearance/ }).first().click();
  const row = page.locator("[role=button]", { hasText: /^Sounds/ }).first();
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
}

async function recordPayment(page, client) {
  await page.locator('nav button[title="Home"]').click();
  await page.getByText(/^Finance$/).first().click();
  await page.getByRole("button", { name: /^Invoices/ }).click();
  await page.getByRole("button", { name: "New invoice" }).click();
  await page.locator("label", { hasText: "Client name" }).locator("input").fill(client);
  await page.getByLabel("Item 1 description").fill("Work");
  await page.getByLabel("Item 1 price").fill("1000");
  await page.getByRole("button", { name: "Save invoice" }).click();
  await page.getByRole("button", { name: "Record payment" }).click();
  await page.getByRole("button", { name: "Save payment" }).click();
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Back" }).click();
}

const server = await startServer();
const browser = await chromium.launch();
try {
  // Website
  console.log("\nwebsite");
  {
    const ctx = await newShellContext(browser, null);
    await ctx.addInitScript(FAKE_AUDIO);
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(URL); await signUp(page);

    await openSounds(page);
    check("Sounds switch in Appearance, on by default", await page.getByText("Tap to hear them.").isVisible());
    await clearNotes(page);
    await page.getByRole("button", { name: "Notification", exact: true }).click();
    check("preview plays the KROFT signature (G5 → D6 → B5)", has(await notes(page), SIGNATURE), JSON.stringify(await notes(page)));

    await clearNotes(page);
    await recordPayment(page, "Ada");
    check("recording a payment plays the payment sound", has(await notes(page), PAYMENT), JSON.stringify(await notes(page)));

    await openSounds(page);
    await page.locator("[role=button]", { hasText: /^Sounds/ }).first().locator("button").click();
    check("switching off is remembered", await page.evaluate(() => localStorage.getItem("kroft-sounds")) === "off" && await page.getByText("Turned off: KROFT stays silent.").isVisible());
    await clearNotes(page);
    await recordPayment(page, "Bisi");
    check("with sounds off, nothing plays", (await notes(page)).length === 0, JSON.stringify(await notes(page)));
    check("no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }

  // Android app 1.2.0: notification channels.
  for (const label of ["APK 1.2.0", "current APK (1.1.0)"]) {
    console.log(`\n${label}`);
    const ctx = await newShellContext(browser, SHELLS[label]);
    await ctx.addInitScript(FAKE_AUDIO);
    const page = await ctx.newPage();
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(URL); await signUp(page);
    const channels = (await page.evaluate(() => window.__all || [])).filter(c => c.key === "LocalNotifications.createChannel").map(c => c.options);
    await clearNotes(page);
    await page.locator('nav button[title="Profile"]').click();
    await page.locator("[role=button]", { hasText: /^Notifications/ }).first().click();
    const row = page.locator("[role=button]", { hasText: /^Notifications/ }).first();
    if ((await row.getAttribute("aria-expanded")) === "false") await row.click();
    await page.getByRole("button", { name: "Send a test" }).click();
    await page.waitForTimeout(800);
    const sent = (await page.evaluate(() => window.__all || [])).filter(c => c.key === "LocalNotifications.schedule").map(c => c.options.notifications[0]).pop();
    if (label === "APK 1.2.0") {
      const alerts = channels.find(c => c.id === "kroft_alerts"), quiet = channels.find(c => c.id === "kroft_quiet");
      check("KROFT alerts channel uses the signature sound file", alerts?.sound === "kroft_notify.wav" && alerts?.importance === 4, JSON.stringify(alerts));
      check("a quiet channel for while KROFT is open", !!quiet && !quiet.sound && quiet.importance === 2, JSON.stringify(quiet));
      check("open in the app: shown on the quiet channel and KROFT plays its signature", sent?.channelId === "kroft_quiet" && has(await notes(page), SIGNATURE), JSON.stringify({ ch: sent?.channelId, notes: await notes(page) }));
    } else {
      check("older APK: no channels (the file isn't in it), phone's own sound", channels.length === 0 && !sent?.channelId && (await notes(page)).length === 0, JSON.stringify({ channels, ch: sent?.channelId, notes: await notes(page) }));
    }
    check("no page errors", errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
const failures = failureCount();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
