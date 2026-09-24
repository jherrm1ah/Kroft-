// KROFT's service worker. Exists for exactly one purpose right now: receiving Web Push messages
// and turning them into a real OS notification even while no tab of the app is open. It doesn't
// do any caching or offline work — that's a different, unrelated use of service workers this
// project hasn't taken on, and adding one here isn't implied by adding push support.
self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* fall through to defaults below */ }
  const title = data.title || "KROFT";
  const body = data.body || "";
  const tag = data.tag || "kroft:notification";
  event.waitUntil(self.registration.showNotification(title, { body, tag, requireInteraction: true }));
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
