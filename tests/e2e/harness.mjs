// Shared set-up for the end-to-end tests in this folder: a preview server for the built app, a
// fake Android app (Capacitor's real native bridge with fake plugins), and sign-up.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = process.env.E2E_DIST || "dist-e2e";
const PORT = Number(process.env.E2E_PORT || 4180);
export const URL = `http://localhost:${PORT}/`;
const BRIDGE = path.join(ROOT, "node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js");

export const ALL = ["App", "Browser", "LocalNotifications", "Share", "TextToSpeech", "SpeechRecognition", "Geolocation", "NativeBiometric", "Filesystem"];
export const SHELLS = {
  // The first APK (#108): no location, fingerprint or file-saving plugins, no version number.
  "first APK (build 1)": { plugins: ["App", "Browser", "LocalNotifications", "Share", "TextToSpeech", "SpeechRecognition"], info: { version: "1.0", build: "1" } },
  "current APK (1.1.0)": { plugins: ALL, info: { version: "1.1.0", build: "10100" } },
  // 1.2.0 adds KROFT's notification sound (res/raw/kroft_notify.wav) and its channels.
  "APK 1.2.0": { plugins: ALL, info: { version: "1.2.0", build: "10200" } },
};

export const MOCK = `
  const m = (...n) => n.map(name => ({ name, rtype: 'promise' }));
  window.__HEADERS = [
    { name:'App', methods: m('minimizeApp','exitApp','getInfo','addListener','removeAllListeners') },
    { name:'Browser', methods: m('open','close','addListener','removeAllListeners') },
    { name:'LocalNotifications', methods: m('checkPermissions','requestPermissions','checkExactNotificationSetting','changeExactNotificationSetting','getPending','getDeliveredNotifications','schedule','cancel','addListener','createChannel') },
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
    (window.__args = window.__args || {})[key] = msg.options;
    (window.__all = window.__all || []).push({ key, options: msg.options });
    if (msg.callbackId == null) return;
    setTimeout(() => window.Capacitor.fromNative({ callbackId:msg.callbackId, pluginId:msg.pluginId, methodName:msg.methodName, success:true, data: replies[key] || {} }), 30);
  } };
`;

export let failures = 0;
export const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n     ${detail}` : ""}`); };

export async function startServer() {
  const server = spawn("npx", ["vite", "preview", "--outDir", DIST, "--port", String(PORT), "--strictPort"], { cwd: ROOT, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(URL)).ok) return server; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  server.kill();
  throw new Error(`preview server didn't start on ${URL}`);
}

export async function signUp(page) {
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


// A browser context that behaves like the given copy of the Android app (or the website, when
// shell is null).
export async function newShellContext(browser, shell) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  if (shell) {
    await ctx.addInitScript(`window.__INFO = ${JSON.stringify(shell.info)}; window.__KEEP = ${JSON.stringify(shell.plugins)};`);
    await ctx.addInitScript(MOCK);
    await ctx.addInitScript({ path: BRIDGE });
    await ctx.addInitScript("window.Capacitor.PluginHeaders = window.__HEADERS.filter(h => window.__KEEP.includes(h.name));");
  }
  return ctx;
}

export const failureCount = () => failures;
