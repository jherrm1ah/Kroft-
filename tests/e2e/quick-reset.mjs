// End-to-end check of the Quick Reset countdown sounds: a tick every second (higher for the last
// three), a chime when it's over, silence when sound is turned off, and in the Android app a
// backup notification for the end time that is cancelled once the app finishes the countdown
// itself. Time is fast-forwarded with Playwright's clock and the speaker is a fake that records
// every note.
//
//   npm run test:e2e

import { chromium } from "playwright";
import { SHELLS, check, startServer, signUp, newShellContext, failureCount, URL } from "./harness.mjs";

// A stand-in for the Web Audio API that records the frequency of every note started.
const FAKE_AUDIO = `
  window.__notes = [];
  class FakeParam { setValueAtTime(v) { this.v = v; } exponentialRampToValueAtTime() {} }
  class FakeNode { connect(n) { return n; } }
  class FakeOsc extends FakeNode { constructor() { super(); this.frequency = new FakeParam(); } start() { window.__notes.push(this.frequency.v); } stop() {} }
  class FakeGain extends FakeNode { constructor() { super(); this.gain = new FakeParam(); } }
  window.AudioContext = class { constructor() { this.state = "running"; this.destination = new FakeNode(); } get currentTime() { return 0; }
    resume() { return Promise.resolve(); } createOscillator() { return new FakeOsc(); } createGain() { return new FakeGain(); } };
`;

async function openOneMinuteReset(page) {
  await page.locator('nav button[title="Wellness"]').click();
  const start = page.getByRole("button", { name: /1-min breathing/ });
  if (!(await start.isVisible())) await page.locator("[role=button]", { hasText: /^Quick Reset/ }).first().click();
  await start.click();
}

async function run(browser, label, shell) {
  console.log(`\n${label}`);
  const ctx = await newShellContext(browser, shell);
  await ctx.addInitScript(FAKE_AUDIO);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.clock.install();
  await page.goto(URL);
  await signUp(page);

  // With sound: 59 ticks (the last three higher), then the chime.
  await openOneMinuteReset(page);
  check("countdown shows with the sound switch on", await page.getByRole("button", { name: "Turn countdown sound off" }).isVisible());
  await page.clock.runFor(61000);
  const notes = await page.evaluate(() => window.__notes);
  const ticks = notes.filter(f => f === 990 || f === 1320);
  const chime = notes.filter(f => [1046.5, 1318.5, 1568].includes(f));
  check("a tick every second", ticks.length === 59, `ticks=${ticks.length}`);
  check("the last three ticks are higher", JSON.stringify(ticks.slice(-3)) === "[1320,1320,1320]" && ticks.slice(0, -3).every(f => f === 990));
  check("a chime when it's over", chime.length === 3 && notes.indexOf(1046.5) > notes.lastIndexOf(1320));
  check("countdown closes and is logged", !(await page.getByRole("button", { name: "End early" }).isVisible()) && await page.getByText(/1 session completed/).isVisible());

  if (shell) {
    const calls = await page.evaluate(() => window.__calls);
    const at = (await page.evaluate(() => window.__args))["LocalNotifications.schedule"]?.notifications?.[0]?.schedule?.at;
    check("app: backup notification scheduled for the end time, then cancelled", calls.includes("LocalNotifications.schedule") && calls.includes("LocalNotifications.cancel") && !!at, `at=${at}`);
  }

  // Sound off: silence, and the choice is remembered.
  await page.evaluate(() => { window.__notes = []; });
  await openOneMinuteReset(page);
  await page.getByRole("button", { name: "Turn countdown sound off" }).click();
  await page.clock.runFor(61000);
  check("sound off: no ticks or chime", (await page.evaluate(() => window.__notes)).length === 0);
  check("sound off is remembered", await page.evaluate(() => localStorage.getItem("kroft-reset-sound")) === "off");

  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

const server = await startServer();
const browser = await chromium.launch();
try {
  await run(browser, "website", null);
  await run(browser, "Android app (current APK)", SHELLS["current APK (1.1.0)"]);
} catch (err) {
  check("test run finished", false, err.message);
} finally {
  await browser.close();
  server.kill();
}
const failures = failureCount();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
