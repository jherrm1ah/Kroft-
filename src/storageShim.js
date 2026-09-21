// Kroft.jsx targets a sandbox host that injects a `window.storage` API
// (get/set, each returning a Promise) as its only persistence layer, and
// deliberately avoids localStorage/sessionStorage as a fallback (see the
// comment above the persistence effects in Kroft.jsx).
//
// When this app runs as a standalone build (no such host), window.storage
// is undefined and every save/load throws. This shim installs a drop-in
// implementation backed by localStorage, but only if a real window.storage
// isn't already present — so it's a no-op inside the original sandbox and
// never shadows the host's own implementation.
if (typeof window !== "undefined" && !window.storage) {
  // Kroft's own STORAGE_KEYS values are already namespaced (e.g. "kroft:profile"),
  // so this shim writes them to localStorage as-is rather than adding another prefix.
  window.storage = {
    async get(key) {
      try {
        const value = window.localStorage.getItem(key);
        return { value: value == null ? undefined : value };
      } catch {
        // Storage unavailable (private browsing, quota, disabled) — behave
        // like "nothing saved yet" rather than throwing.
        return { value: undefined };
      }
    },
    async set(key, value) {
      try {
        window.localStorage.setItem(key, value);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  };
}
