// Picks up a newly deployed version of KROFT in a copy that has been open for a long time.
//
// The website (and the Android app, which loads it) gets new versions on its next load, but a
// phone can keep the same copy of the app open for days. When someone comes back to KROFT after a
// while, this compares the running version with /version.json (written by vite.config.js on
// every build) and, if a newer one has been deployed, reloads straight away, before they start
// doing anything. Nothing is lost: unsynced changes are kept by storageShim.js across reloads.

import { WEB_BUILD } from "./native.js";

const AWAY_MS = 10 * 60 * 1000;          // only after being away this long
const CHECK_EVERY_MS = 30 * 60 * 1000;   // and at most this often
const RELOADED_KEY = "kroft-reloaded-for";

// Someone in the middle of typing keeps their page, whatever version it is.
const isTyping = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type !== "checkbox")) && !!el.value;
};

export async function latestBuild(fetchImpl = fetch) {
  const res = await fetchImpl(`/version.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return typeof data?.build === "string" ? data.build : null;
}

// Pure decision, exported for tests.
export function shouldReload({ running, latest, awayMs, typing, alreadyReloadedFor }) {
  if (!latest || !running || running === "dev" || running.startsWith("local-")) return false;
  if (latest === running || latest === alreadyReloadedFor) return false;
  return awayMs >= AWAY_MS && !typing;
}

export function watchForNewVersion() {
  if (typeof document === "undefined" || WEB_BUILD === "dev" || WEB_BUILD.startsWith("local-")) return;
  let hiddenAt = 0, lastCheck = 0;
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    const awayMs = hiddenAt ? Date.now() - hiddenAt : 0;
    if (awayMs < AWAY_MS || Date.now() - lastCheck < CHECK_EVERY_MS) return;
    lastCheck = Date.now();
    try {
      const latest = await latestBuild();
      let alreadyReloadedFor = null;
      try { alreadyReloadedFor = sessionStorage.getItem(RELOADED_KEY); } catch { /* no storage */ }
      if (!shouldReload({ running: WEB_BUILD, latest, awayMs, typing: isTyping(), alreadyReloadedFor })) return;
      // Remembered so a CDN still serving the old page can't cause a reload loop.
      try { sessionStorage.setItem(RELOADED_KEY, latest); } catch { /* no storage */ }
      window.location.reload();
    } catch { /* offline or blocked: try again next time */ }
  });
}
