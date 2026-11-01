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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = process.env.E2E_DIST || "dist-e2e";
const PORT = Number(process.env.E2E_PORT || 4180);
const URL = `http://localhost:${PORT}/`;
const BRIDGE = path.join(ROOT, "node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js");

const ALL = ["App", "Browser", "LocalNotifications", "Share", "TextToSpeech", "SpeechRecognition", "Geolocation", "NativeBiometric", "Filesystem"];
const SHELLS = {
  // The first APK (#108): no location, fingerprint or file-saving plugins, no version number.
  "first APK (build 1)": { plugins: ["App", "Browser", "LocalNotifications", "Share", "TextToSpeech", "SpeechRecognition"], info: { version: "1.0", build: "1" } },
  "current APK (1.1.0)": { plugins: ALL, info: { version: "1.1.0", build: "10100" } },
};

const MOCK = `
  const m = (...n) => n.map(name => ({ name, rtype: 'promise' }));
  window.__HEADERS = [
    { name:'App', methods: m('minimizeApp','exitApp','getInfo','addListener','removeAllListeners') },
    { name:'Browser', methods: m('open','close','addListener','removeAllListeners') },
    { name:'LocalNotifications', methods: m('checkPermissions','requestPermissions','checkExactNotificationSetting','changeExactNotificationSetting','getPending','getDeliveredNotifications','schedule','cancel','addListener') },
    { name:'Share', methods: m('share','canShare') },
    { name:'TextToSpeech', methods: m('speak','stop','getSupportedVoices') },
    { name:'SpeechRecognition', methods: m('available','start','stop','checkPermissions','requestPermissions','addListener','removeAllListeners') },
    { name:'Geolocation', methods: m('checkPermissions','requestPermissions','getCurrentPosition','clearWatch').concat([{ name:'watchPosition', rtype:'callback' }]) },
    { name:'NativeBiometric', methods: m('isAvailable','verifyIdentity') },
    { name:'Filesystem', methods: m('writeFile') },
  ];
  window.__calls = [];
  const replies = {
    'SpeechRecognition.available': { available:false },
    'SpeechRecognition.checkPermissions': { speechRecognition:'prompt' },
    'SpeechRecognition.requestPermissions': { speechRecognition:'granted' },
    'Geolocation.checkPermissions': { location:'prompt', coarseLocation:'prompt' },
    'Geolocation.requestPermissions': { location:'granted', coarseLocation:'granted' },
    'Geolocation.getCurrentPosition': { coords:{ latitude:6.45, longitude:3.39, accuracy:30 }, timestamp:Date.now() },
    'LocalNotifications.checkPermissions': { display:'granted' },
    'LocalNotifications.checkExactNotificationSetting': { exact_alarm:'denied' },
    'LocalNotifications.getPending': { notifications:[] },
    'LocalNotifications.getDeliveredNotifications': { notifications:[] },
    'NativeBiometric.isAvailable': { isAvailable:true, biometryType:3 },
    'TextToSpeech.getSupportedVoices': { voices:[] },
    'App.getInfo': window.__INFO,
    'Filesystem.writeFile': { uri:'file:///cache/exports/x' },
  };
  window.androidBridge = { postMessage(raw) {
    const msg = JSON.parse(raw);
    const key = msg.pluginId + '.' + msg.methodName;
    window.__calls.push(key);
    if (msg.callbackId == null) return;
    setTimeout(() => window.Capacitor.fromNative({ callbackId:msg.callbackId, pluginId:msg.pluginId, methodName:msg.methodName, success:true, data: replies[key] || {} }), 30);
  } };
`;

let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n     ${detail}` : ""}`); };

async function startServer() {
  const server = spawn("npx", ["vite", "preview", "--outDir", DIST, "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(URL)).ok) return server; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  server.kill();
  throw new Error(`preview server didn't start on ${URL}`);
}

async function signUp(page) {
  await page.getByRole("button", { name: "Sign up with email" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "Sign up with email" }).click();
  await page.getByLabel("Full name").fill("Ada Obi");
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password", { exact: true }).fill("TestPass123!");
  await page.getByRole("button", { name: "Create account" }).click();
  for (const n of ["Skip for now", "Continue", "Skip for now", "Start using KROFT"]) {
    await page.getByRole("button", { name: n, exact: true }).click();
    await page.waitForTimeout(350);
  }
  await page.locator('nav button[title="Home"]').waitFor({ timeout: 15000 });
}

async function runShell(browser, label, shell) {
  console.log(`\n${label}`);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  if (shell) {
    await ctx.addInitScript(`window.__INFO = ${JSON.stringify(shell.info)}; window.__KEEP = ${JSON.stringify(shell.plugins)};`);
    await ctx.addInitScript(MOCK);
    await ctx.addInitScript({ path: BRIDGE });
    await ctx.addInitScript("window.Capacitor.PluginHeaders = window.__HEADERS.filter(h => window.__KEEP.includes(h.name));");
  }
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
  failures++;
  console.log(`FAIL test run stopped: ${err.message}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
