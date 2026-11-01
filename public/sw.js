// KROFT's service worker: push notifications, plus caching the app itself so it opens offline.
//
// What is cached, and how:
//   - Pages (navigations): network first, so an online visit always gets the newest version; the
//     cached copy is used only when the network fails.
//   - /assets/* (Vite's content-hashed scripts and styles): cache first. A hashed file never
//     changes, so a cached copy is always correct. The files the current page needs are fetched
//     at install, so the very first offline launch works.
//   - Other static files (icons, images, manifest, legal pages' CSS) and Google Fonts: served
//     from cache when present and refreshed in the background.
// Never cached: anything that isn't a GET, /api/*, Supabase or any other third-party call, and the
// dev server's own files. The person's data is not stored here; storageShim.js keeps that.

const VERSION = "v2";
const SHELL = `kroft-shell-${VERSION}`;
const ASSETS = "kroft-assets";
const FONTS = "kroft-fonts";
const MAX_ASSETS = 80;

// Lookups ignore Vary: servers mark responses "Vary: Origin", and module scripts are requested
// with an Origin header the install-time copies didn't have. Hashed files can't be stale anyway.
const STATIC_FILES = [
  "/manifest.webmanifest", "/favicon.svg", "/kroft-robot-badge.webp",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/badge-96.png", "/icons/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    // The page, then every script and stylesheet it references, so the app can start offline.
    const res = await fetch("/", { cache: "no-cache" });
    if (res.ok) {
      const html = await res.clone().text();
      await shell.put("/", res);
      const files = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]))];
      const assets = await caches.open(ASSETS);
      await Promise.all(files.map(f => assets.add(f).catch(() => {})));
    }
    await Promise.all(STATIC_FILES.map(f => shell.add(f).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith("kroft-shell-") && n !== SHELL).map(n => caches.delete(n)));
    await trim(ASSETS, MAX_ASSETS);
    await self.clients.claim();
  })());
});

// Keeps the hashed-asset cache from growing forever across deploys: oldest entries go first.
async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map(k => cache.delete(k)));
}

async function networkFirst(request) {
  const shell = await caches.open(SHELL);
  try {
    const res = await fetch(request);
    // Standalone pages (privacy.html, terms.html) are kept under their own URL; every other route is
    // the single-page app, kept as "/".
    if (res.ok) shell.put(/\.html?$/.test(new URL(request.url).pathname) ? request : "/", res.clone());
    return res;
  } catch {
    // Every app route is the same single page; other pages (privacy, terms) are cached by URL.
    return (await shell.match(request, { ignoreSearch: true, ignoreVary: true })) || (await shell.match("/", { ignoreVary: true })) || Response.error();
  }
}

async function cacheFirst(request, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(request, { ignoreVary: true });
  const refresh = fetch(request).then(res => {
    if (res.ok || res.type === "opaque") cache.put(request, res.clone());
    return res;
  }).catch(() => hit || Response.error());
  return hit || refresh;
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(request, FONTS));
    return;
  }
  if (url.origin !== self.location.origin) return;                    // Supabase and other services
  if (url.pathname.startsWith("/api/")) return;                        // always live
  if (/^\/(@|src\/|node_modules\/)/.test(url.pathname)) return;        // dev server internals

  if (request.mode === "navigate") { event.respondWith(networkFirst(request)); return; }
  if (url.pathname.startsWith("/assets/")) { event.respondWith(cacheFirst(request, ASSETS)); return; }
  if (/\.(png|webp|svg|ico|webmanifest|css|woff2?)$/.test(url.pathname)) { event.respondWith(staleWhileRevalidate(request, SHELL)); return; }
});

// ── Push notifications ──

// Receives Web Push messages and turns them into a real OS notification even while no tab of the
// app is open.
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* fall through to defaults below */ }
  const title = data.title || "KROFT";
  const body = data.body || "";
  const tag = data.tag || "kroft:notification";
  event.waitUntil(self.registration.showNotification(title, { body, tag, requireInteraction: true, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png" }));
});

// Tapping the notification brings an existing KROFT tab to the front rather than opening a
// duplicate one, only opening a new tab if none is already open.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientsList => {
      for (const client of clientsList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
