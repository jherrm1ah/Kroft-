// Health check of the live site, run by .github/workflows/production-check.yml right after
// every production deploy. Read-only: it signs nobody in and changes no data.
//
//   SITE=https://kroft-pied.vercel.app EXPECT_BUILD=<first 12 chars of the commit> node tests/smoke/production.mjs

import { chromium } from "playwright";

const SITE = (process.env.SITE || "https://kroft-pied.vercel.app").replace(/\/$/, "");
// Live builds are named after the first 12 characters of their commit (see vite.config.js).
const EXPECT = (process.env.EXPECT_BUILD || "").slice(0, 12);
const isExpected = b => !EXPECT || (typeof b === "string" && b.slice(0, 12) === EXPECT);
let failures = 0;
const check = (name, ok, detail = "") => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n     ${detail}` : ""}`); };
const get = (p, init) => fetch(`${SITE}${p}`, { cache: "no-store", ...init });

// 1. The new version is the one being served (Vercel can take a moment to switch over).
let build = null;
for (let i = 0; i < 30; i++) {
  try { build = (await (await get(`/version.json?t=${Date.now()}`)).json()).build; } catch { /* retry */ }
  if (isExpected(build)) break;
  await new Promise(r => setTimeout(r, 10000));
}
check(`live site serves the new version${EXPECT ? ` (${EXPECT})` : ""}`, isExpected(build), `serving ${build}`);

// 2. Pages and files the app and the Android shell depend on.
for (const p of ["/", "/terms.html", "/privacy.html", "/app-offline.html", "/sw.js", "/manifest.webmanifest"]) {
  const res = await get(p).catch(e => ({ ok: false, status: e.message }));
  check(`${p} loads`, res.ok, `status ${res.status}`);
}

// 3. The API is up and still refuses requests without a signed-in account.
const chat = await get("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(e => ({ status: e.message }));
check("AI endpoint is up and requires sign-in", chat.status === 401, `status ${chat.status}`);
const usage = await get("/api/usage").catch(e => ({ status: e.message }));
check("usage endpoint is up and requires sign-in", usage.status === 401, `status ${usage.status}`);

// 4. The app itself starts in a real browser, without errors.
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(`${SITE}/`, { waitUntil: "load" });
  // A fresh browser has no account on it, so the app always opens on the welcome screen.
  const started = await page.getByRole("button", { name: "Sign up with email" }).waitFor({ timeout: 20000 }).then(() => true, () => false);
  check("app starts and shows the sign-in screen", started);
  check("no page errors on start", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
